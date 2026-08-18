import type { LensDb } from "./db.ts";
import type { LensPolicy } from "./policy.ts";

import { parseLensPolicy } from "./policy.ts";

export interface LensPrincipal {
  principalId: string;
  subjectId?: string;
  label?: string;
}

export class PrincipalStore {
  private readonly db: LensDb;

  constructor(db: LensDb) {
    this.db = db;
  }

  async get(tokenId: string): Promise<LensPrincipal | undefined> {
    const rows = await this.db.all("SELECT principal_id, subject_id, label FROM lens_principals WHERE token_id = ?", [
      tokenId,
    ]);
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return {
      principalId: String(row.principal_id),
      subjectId: row.subject_id === null ? undefined : String(row.subject_id),
      label: row.label === null ? undefined : String(row.label),
    };
  }

  async put(tokenId: string, principal: LensPrincipal, now: string): Promise<void> {
    await this.db.run(
      `INSERT INTO lens_principals (token_id, principal_id, subject_id, label, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(token_id) DO UPDATE SET principal_id = ?, subject_id = ?, label = ?, updated_at = ?`,
      [
        tokenId,
        principal.principalId,
        principal.subjectId ?? null,
        principal.label ?? null,
        now,
        principal.principalId,
        principal.subjectId ?? null,
        principal.label ?? null,
        now,
      ],
    );
  }
}

export interface TokenPolicyRecord {
  policy: LensPolicy;
  version: number;
}

export class TokenPolicyStore {
  private readonly db: LensDb;

  constructor(db: LensDb) {
    this.db = db;
  }

  async get(tokenId: string): Promise<TokenPolicyRecord | undefined> {
    const rows = await this.db.all("SELECT policy_json, version FROM lens_token_policies WHERE token_id = ?", [
      tokenId,
    ]);
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return {
      policy: parseLensPolicy(JSON.parse(String(row.policy_json)), `stored policy for token ${tokenId}`),
      version: Number(row.version),
    };
  }

  async put(tokenId: string, policy: LensPolicy, now: string): Promise<TokenPolicyRecord> {
    await this.db.run(
      `INSERT INTO lens_token_policies (token_id, policy_json, version, updated_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(token_id) DO UPDATE SET policy_json = ?, version = version + 1, updated_at = ?`,
      [tokenId, JSON.stringify(policy), now, JSON.stringify(policy), now],
    );
    const record = await this.get(tokenId);
    if (!record) {
      throw new Error("token policy write failed");
    }
    return record;
  }
}

export interface DecisionRecord {
  id: string;
  requestId: string;
  principalId: string;
  tokenId: string;
  subjectId?: string;
  actionId: string;
  providerId: string;
  connectionName: string;
  effect: "allow" | "deny";
  errorCode?: string;
  inputDigest: string;
  policySnapshotId: string;
  reasons: unknown[];
  obligations: unknown[];
  approvalId?: string;
  reservationIds?: string[];
  runId?: string;
  createdAt: string;
}

export class EvidenceStore {
  private readonly db: LensDb;

  constructor(db: LensDb) {
    this.db = db;
  }

  async add(record: DecisionRecord): Promise<void> {
    await this.db.run(
      `INSERT INTO lens_decisions (
        id, request_id, principal_id, token_id, subject_id, action_id, provider_id, connection_name,
        effect, error_code, input_digest, policy_snapshot_id, reasons_json, obligations_json,
        approval_id, reservation_ids_json, run_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.requestId,
        record.principalId,
        record.tokenId,
        record.subjectId ?? null,
        record.actionId,
        record.providerId,
        record.connectionName,
        record.effect,
        record.errorCode ?? null,
        record.inputDigest,
        record.policySnapshotId,
        JSON.stringify(record.reasons),
        JSON.stringify(record.obligations),
        record.approvalId ?? null,
        record.reservationIds ? JSON.stringify(record.reservationIds) : null,
        record.runId ?? null,
        record.createdAt,
      ],
    );
  }

  async linkRun(decisionId: string, runId: string): Promise<void> {
    await this.db.run("UPDATE lens_decisions SET run_id = ? WHERE id = ?", [runId, decisionId]);
  }

  async list(filter: { principalId?: string; limit?: number }): Promise<Array<Record<string, unknown>>> {
    const limit = Math.min(filter.limit ?? 50, 200);
    if (filter.principalId) {
      return this.db.all("SELECT * FROM lens_decisions WHERE principal_id = ? ORDER BY created_at DESC LIMIT ?", [
        filter.principalId,
        limit,
      ]);
    }
    return this.db.all("SELECT * FROM lens_decisions ORDER BY created_at DESC LIMIT ?", [limit]);
  }
}

export interface ReserveInput {
  id: string;
  tokenId: string;
  principalId: string;
  meter: string;
  amount: number;
  limits: Array<{ limit: number; windowSeconds: number }>;
  now: Date;
  ttlSeconds: number;
}

export class ReservationStore {
  private readonly db: LensDb;

  constructor(db: LensDb) {
    this.db = db;
  }

  /**
   * Atomic limit check + reservation in one conditional INSERT (rfc/0001).
   * Every limit on the meter contributes one window-sum condition, so
   * concurrent requests can never jointly exceed any window. The sums count
   * committed usage plus live reservations; expired reservations stop
   * counting without a background job.
   */
  async reserve(input: ReserveInput): Promise<boolean> {
    const nowIso = input.now.toISOString();
    const expiresAt = new Date(input.now.getTime() + input.ttlSeconds * 1000).toISOString();
    const conditions: string[] = [];
    const conditionParams: unknown[] = [];
    for (const { limit, windowSeconds } of input.limits) {
      conditions.push(
        `(
          SELECT COALESCE(SUM(amount), 0) FROM lens_reservations
          WHERE token_id = ? AND meter = ? AND created_at > ?
            AND (state = 'committed' OR (state = 'reserved' AND expires_at > ?))
        ) + ? <= ?`,
      );
      const windowStart = new Date(input.now.getTime() - windowSeconds * 1000).toISOString();
      conditionParams.push(input.tokenId, input.meter, windowStart, nowIso, input.amount, limit);
    }
    const result = await this.db.run(
      `INSERT INTO lens_reservations (id, token_id, principal_id, meter, amount, state, created_at, expires_at)
       SELECT ?, ?, ?, ?, ?, 'reserved', ?, ?
       WHERE ${conditions.length > 0 ? conditions.join(" AND ") : "1 = 1"}`,
      [input.id, input.tokenId, input.principalId, input.meter, input.amount, nowIso, expiresAt, ...conditionParams],
    );
    return result.changes === 1;
  }

  async commit(id: string, now: string): Promise<boolean> {
    const result = await this.db.run(
      "UPDATE lens_reservations SET state = 'committed', committed_at = ? WHERE id = ? AND state = 'reserved'",
      [now, id],
    );
    return result.changes === 1;
  }

  async release(id: string): Promise<void> {
    await this.db.run("UPDATE lens_reservations SET state = 'released' WHERE id = ? AND state = 'reserved'", [id]);
  }

  /** Extends a still-live reservation. Returns false when it lapsed. */
  async reconfirm(id: string, now: Date, ttlSeconds: number): Promise<boolean> {
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    const result = await this.db.run(
      "UPDATE lens_reservations SET expires_at = ? WHERE id = ? AND state = 'reserved' AND expires_at > ?",
      [expiresAt, id, now.toISOString()],
    );
    return result.changes === 1;
  }

  async get(id: string): Promise<Record<string, unknown> | undefined> {
    const rows = await this.db.all("SELECT * FROM lens_reservations WHERE id = ?", [id]);
    return rows[0];
  }
}

export type ApprovalState =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled"
  | "executing"
  | "executed"
  | "execution_failed";

export interface ApprovalRecord {
  id: string;
  principalId: string;
  tokenId: string;
  subjectId?: string;
  actionId: string;
  providerId: string;
  connectionName: string;
  inputCiphertext: string;
  inputDigest: string;
  policySnapshotId: string;
  decisionId: string;
  state: ApprovalState;
  requestedAt: string;
  expiresAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionReason?: string;
  grantExpiresAt?: string;
  grantConsumedAt?: string;
  runId?: string;
  reservationIds: string[];
}

export class ApprovalStore {
  private readonly db: LensDb;

  constructor(db: LensDb) {
    this.db = db;
  }

  async add(record: ApprovalRecord): Promise<void> {
    await this.db.run(
      `INSERT INTO lens_approvals (
        id, principal_id, token_id, subject_id, action_id, provider_id, connection_name,
        input_ciphertext, input_digest, policy_snapshot_id, decision_id, state,
        requested_at, expires_at, reservation_ids_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.principalId,
        record.tokenId,
        record.subjectId ?? null,
        record.actionId,
        record.providerId,
        record.connectionName,
        record.inputCiphertext,
        record.inputDigest,
        record.policySnapshotId,
        record.decisionId,
        record.state,
        record.requestedAt,
        record.expiresAt,
        JSON.stringify(record.reservationIds),
      ],
    );
  }

  async get(id: string): Promise<ApprovalRecord | undefined> {
    const rows = await this.db.all("SELECT * FROM lens_approvals WHERE id = ?", [id]);
    const row = rows[0];
    return row ? approvalFromRow(row) : undefined;
  }

  /** Lazily expires overdue pending approvals, then lists by state. */
  async list(state: ApprovalState | undefined, now: string): Promise<ApprovalRecord[]> {
    await this.db.run("UPDATE lens_approvals SET state = 'expired' WHERE state = 'pending' AND expires_at <= ?", [now]);
    const rows = state
      ? await this.db.all("SELECT * FROM lens_approvals WHERE state = ? ORDER BY requested_at DESC LIMIT 100", [state])
      : await this.db.all("SELECT * FROM lens_approvals ORDER BY requested_at DESC LIMIT 100");
    return rows.map(approvalFromRow);
  }

  /** Atomic state transition. Returns false when the from-state no longer holds. */
  async transition(
    id: string,
    from: ApprovalState,
    to: ApprovalState,
    updates: { resolvedAt?: string; resolvedBy?: string; resolutionReason?: string; grantExpiresAt?: string } = {},
  ): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE lens_approvals SET state = ?,
        resolved_at = COALESCE(?, resolved_at),
        resolved_by = COALESCE(?, resolved_by),
        resolution_reason = COALESCE(?, resolution_reason),
        grant_expires_at = COALESCE(?, grant_expires_at)
       WHERE id = ? AND state = ?`,
      [
        to,
        updates.resolvedAt ?? null,
        updates.resolvedBy ?? null,
        updates.resolutionReason ?? null,
        updates.grantExpiresAt ?? null,
        id,
        from,
      ],
    );
    return result.changes === 1;
  }

  /** Single-use grant consumption: approved → executing, only before grant expiry. */
  async consumeGrant(id: string, now: string): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE lens_approvals SET state = 'executing', grant_consumed_at = ?
       WHERE id = ? AND state = 'approved' AND grant_expires_at > ?`,
      [now, id, now],
    );
    return result.changes === 1;
  }

  async linkRun(id: string, runId: string): Promise<void> {
    await this.db.run("UPDATE lens_approvals SET run_id = ? WHERE id = ?", [runId, id]);
  }
}

function approvalFromRow(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: String(row.id),
    principalId: String(row.principal_id),
    tokenId: String(row.token_id),
    subjectId: row.subject_id === null ? undefined : String(row.subject_id),
    actionId: String(row.action_id),
    providerId: String(row.provider_id),
    connectionName: String(row.connection_name),
    inputCiphertext: String(row.input_ciphertext),
    inputDigest: String(row.input_digest),
    policySnapshotId: String(row.policy_snapshot_id),
    decisionId: String(row.decision_id),
    state: String(row.state) as ApprovalState,
    requestedAt: String(row.requested_at),
    expiresAt: String(row.expires_at),
    resolvedAt: row.resolved_at === null ? undefined : String(row.resolved_at),
    resolvedBy: row.resolved_by === null ? undefined : String(row.resolved_by),
    resolutionReason: row.resolution_reason === null ? undefined : String(row.resolution_reason),
    grantExpiresAt: row.grant_expires_at === null ? undefined : String(row.grant_expires_at),
    grantConsumedAt: row.grant_consumed_at === null ? undefined : String(row.grant_consumed_at),
    runId: row.run_id === null ? undefined : String(row.run_id),
    reservationIds: JSON.parse(String(row.reservation_ids_json ?? "[]")) as string[],
  };
}
