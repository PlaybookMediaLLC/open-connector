import type { ActionPolicyService } from "../core/action-policy.ts";
import type { RuntimeLogger } from "../core/types.ts";
import type { ActionRunner, ActionRunResult, RunActionInput } from "../server/actions/action-runner.ts";
import type { ISecretCodec } from "../server/secrets/secret-codec-core.ts";
import type { IRuntimePolicyStore } from "../server/storage/runtime-policy-store.ts";
import type { IRuntimeTokenStore } from "../server/storage/runtime-token-service.ts";
import type { LensDecision } from "./authorize.ts";
import type { LensDb } from "./db.ts";
import type { LensPolicy } from "./policy.ts";
import type { ApprovalRecord, LensPrincipal } from "./stores.ts";

import { authorizeLens } from "./authorize.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { composeLensPolicies, policySnapshotId } from "./policy.ts";
import { ApprovalStore, EvidenceStore, PrincipalStore, ReservationStore, TokenPolicyStore } from "./stores.ts";

export interface LensRuntimeOptions {
  db: LensDb;
  secretCodec: ISecretCodec;
  deploymentPolicy: LensPolicy;
  upstream?: {
    actionPolicy?: ActionPolicyService;
    tokenStore?: IRuntimeTokenStore;
    policyStore?: IRuntimePolicyStore;
  };
  approvalTtlSeconds?: number;
  reservationTtlSeconds?: number;
  grantTtlSeconds?: number;
  logger?: RuntimeLogger;
}

export interface ResolvedAuthority {
  principal: LensPrincipal;
  tokenId: string;
  policy: LensPolicy;
  snapshotId: string;
}

export interface ApprovalResolutionResult {
  ok: boolean;
  state: string;
  errorCode?: string;
  runId?: string;
}

/**
 * The lens authorization control plane (rfc/0001), assembled fork-side.
 * Wraps the shared upstream ActionRunner so HTTP and MCP callers pass one
 * enforcement boundary: constraints, meters, approvals, and evidence.
 */
export class LensRuntime {
  readonly principals: PrincipalStore;
  readonly tokenPolicies: TokenPolicyStore;
  readonly evidence: EvidenceStore;
  readonly approvals: ApprovalStore;
  readonly reservations: ReservationStore;

  private readonly options: LensRuntimeOptions;
  private inner?: ActionRunner;

  constructor(options: LensRuntimeOptions) {
    this.options = options;
    this.principals = new PrincipalStore(options.db);
    this.tokenPolicies = new TokenPolicyStore(options.db);
    this.evidence = new EvidenceStore(options.db);
    this.approvals = new ApprovalStore(options.db);
    this.reservations = new ReservationStore(options.db);
  }

  wrap(actions: ActionRunner): ActionRunner {
    this.inner = actions;
    const wrapped = Object.create(actions) as ActionRunner;
    wrapped.run = (input: RunActionInput) => this.handleRun(actions, input);
    return wrapped;
  }

  /** Fail-closed entry point: any lens evaluation error denies the request. */
  private async handleRun(inner: ActionRunner, input: RunActionInput): Promise<ActionRunResult | undefined> {
    try {
      return await this.authorizeAndRun(inner, input);
    } catch (error) {
      this.options.logger?.error?.(
        { actionId: input.actionId, error: error instanceof Error ? error.message : String(error) },
        "lens authorization error; denying (fail closed)",
      );
      return syntheticResult("authorization_failed", "Lens authorization failed; the request is denied.");
    }
  }

  private async authorizeAndRun(inner: ActionRunner, input: RunActionInput): Promise<ActionRunResult | undefined> {
    const tokenId = input.runtimeTokenId ?? "";
    const resolved = await this.resolve(tokenId);
    const now = new Date();
    const requestId = crypto.randomUUID();
    const decisionId = `dec_${crypto.randomUUID()}`;
    const inputDigest = await requestDigest(input.actionId, input.connectionName ?? "", tokenId, input.input);
    const decision = authorizeLens(resolved.policy, input.actionId, input.input);
    const base = {
      id: decisionId,
      requestId,
      principalId: resolved.principal.principalId,
      tokenId,
      subjectId: resolved.principal.subjectId,
      actionId: input.actionId,
      providerId: input.actionId.split(".")[0] ?? "",
      connectionName: input.connectionName ?? "",
      inputDigest,
      policySnapshotId: resolved.snapshotId,
      createdAt: now.toISOString(),
    };

    if (decision.effect === "deny") {
      await this.evidence.add({
        ...base,
        effect: "deny",
        errorCode: decision.errorCode,
        reasons: decision.reasons,
        obligations: [],
      });
      return syntheticResult(decision.errorCode, denialMessage(input.actionId, decision), {
        decisionId,
        reasons: decision.reasons,
      });
    }

    const reservationIds: string[] = [];
    for (const obligation of decision.obligations) {
      if (obligation.kind !== "reserve_meter") {
        continue;
      }
      const reservationId = `res_${crypto.randomUUID()}`;
      const reserved = await this.reservations.reserve({
        id: reservationId,
        tokenId,
        principalId: resolved.principal.principalId,
        meter: obligation.meter,
        amount: obligation.amount,
        limits: resolved.policy.usageLimits
          .filter((limit) => limit.meter === obligation.meter)
          .map((limit) => ({ limit: Number(limit.limit), windowSeconds: limit.windowSeconds })),
        now,
        ttlSeconds: this.options.reservationTtlSeconds ?? 900,
      });
      if (!reserved) {
        await Promise.all(reservationIds.map((id) => this.reservations.release(id)));
        await this.evidence.add({
          ...base,
          effect: "deny",
          errorCode: "usage_limit_exceeded",
          reasons: [{ code: "usage_limit_exceeded", message: `usage limit reached for meter ${obligation.meter}` }],
          obligations: decision.obligations,
        });
        // ponytail: reuses the upstream "rate_limited" wire code so clients get HTTP 429;
        // details carry the rfc/0001 code until the upstream status map can learn it.
        return syntheticResult("rate_limited", `Usage limit reached for meter ${obligation.meter}.`, {
          code: "usage_limit_exceeded",
          meter: obligation.meter,
          decisionId,
        });
      }
      reservationIds.push(reservationId);
    }

    if (decision.obligations.some((obligation) => obligation.kind === "require_approval")) {
      const approvalId = `apr_${crypto.randomUUID()}`;
      const expiresAt = new Date(now.getTime() + (this.options.approvalTtlSeconds ?? 86_400) * 1000).toISOString();
      await this.approvals.add({
        id: approvalId,
        principalId: resolved.principal.principalId,
        tokenId,
        subjectId: resolved.principal.subjectId,
        actionId: input.actionId,
        providerId: base.providerId,
        connectionName: base.connectionName,
        inputCiphertext: await this.options.secretCodec.encode(JSON.stringify(input.input ?? null)),
        inputDigest,
        policySnapshotId: resolved.snapshotId,
        decisionId,
        state: "pending",
        requestedAt: now.toISOString(),
        expiresAt,
        reservationIds,
      });
      await this.evidence.add({
        ...base,
        effect: "allow",
        errorCode: "approval_required",
        reasons: decision.reasons,
        obligations: decision.obligations,
        approvalId,
        reservationIds,
      });
      return syntheticResult("approval_required", `${input.actionId} requires human approval before execution.`, {
        status: "pending_approval",
        approvalId,
        expiresAt,
        decisionId,
      });
    }

    await this.evidence.add({
      ...base,
      effect: "allow",
      reasons: decision.reasons,
      obligations: decision.obligations,
      reservationIds,
    });
    const run = await inner.run(input);
    await this.settle(decisionId, reservationIds, run);
    return run;
  }

  /** Approves and executes one pending approval through full revalidation (rfc/0001). */
  async resolveApproval(id: string, resolvedBy: string, reason?: string): Promise<ApprovalResolutionResult> {
    const now = new Date();
    const nowIso = now.toISOString();
    const approval = await this.approvals.get(id);
    if (!approval) {
      return { ok: false, state: "not_found", errorCode: "approval_not_found" };
    }
    if (approval.state === "pending" && approval.expiresAt <= nowIso) {
      await this.approvals.transition(id, "pending", "expired");
      return { ok: false, state: "expired", errorCode: "approval_expired" };
    }
    if (approval.state === "pending") {
      const grantExpiresAt = new Date(now.getTime() + (this.options.grantTtlSeconds ?? 600) * 1000).toISOString();
      const approved = await this.approvals.transition(id, "pending", "approved", {
        resolvedAt: nowIso,
        resolvedBy,
        resolutionReason: reason,
        grantExpiresAt,
      });
      if (!approved) {
        const current = await this.approvals.get(id);
        return { ok: false, state: current?.state ?? "unknown", errorCode: "approval_conflict" };
      }
    } else if (approval.state !== "approved") {
      return { ok: false, state: approval.state, errorCode: "approval_conflict" };
    }
    if (!(await this.approvals.consumeGrant(id, nowIso))) {
      return { ok: false, state: "approved", errorCode: "execution_grant_invalid" };
    }
    return this.executeApproved(id, now);
  }

  async denyApproval(id: string, resolvedBy: string, reason?: string): Promise<ApprovalResolutionResult> {
    const nowIso = new Date().toISOString();
    const denied = await this.approvals.transition(id, "pending", "denied", {
      resolvedAt: nowIso,
      resolvedBy,
      resolutionReason: reason,
    });
    if (!denied) {
      const current = await this.approvals.get(id);
      return { ok: false, state: current?.state ?? "not_found", errorCode: "approval_conflict" };
    }
    const approval = await this.approvals.get(id);
    await Promise.all((approval?.reservationIds ?? []).map((rid) => this.reservations.release(rid)));
    return { ok: true, state: "denied" };
  }

  /** Runs the exact approved intent after digest, policy, token, and meter revalidation. */
  private async executeApproved(id: string, now: Date): Promise<ApprovalResolutionResult> {
    const fail = async (errorCode: string): Promise<ApprovalResolutionResult> => {
      await this.approvals.transition(id, "executing", "execution_failed", { resolutionReason: errorCode });
      const approval = await this.approvals.get(id);
      await Promise.all((approval?.reservationIds ?? []).map((rid) => this.reservations.release(rid)));
      return { ok: false, state: "execution_failed", errorCode };
    };

    const approval = await this.approvals.get(id);
    if (!approval || !this.inner) {
      return fail("execution_grant_invalid");
    }
    let input: unknown;
    try {
      input = JSON.parse(await this.options.secretCodec.decode(approval.inputCiphertext));
    } catch {
      return fail("execution_grant_invalid");
    }
    const digest = await requestDigest(approval.actionId, approval.connectionName, approval.tokenId, input);
    if (digest !== approval.inputDigest) {
      return fail("execution_grant_invalid");
    }

    const resolved = await this.resolve(approval.tokenId);
    const decision = authorizeLens(resolved.policy, approval.actionId, input);
    if (decision.effect === "deny") {
      return fail(decision.errorCode);
    }

    const upstreamPolicy = await this.upstreamSnapshotFor(approval);
    if (!upstreamPolicy.ok) {
      return fail(upstreamPolicy.errorCode);
    }

    for (const reservationId of approval.reservationIds) {
      if (await this.reservations.reconfirm(reservationId, now, this.options.reservationTtlSeconds ?? 900)) {
        continue;
      }
      const stale = await this.reservations.get(reservationId);
      const meter = stale ? String(stale.meter) : "";
      const reserved = await this.reservations.reserve({
        id: `${reservationId}_r`,
        tokenId: approval.tokenId,
        principalId: approval.principalId,
        meter,
        amount: stale ? Number(stale.amount) : 0,
        limits: resolved.policy.usageLimits
          .filter((limit) => limit.meter === meter)
          .map((limit) => ({ limit: Number(limit.limit), windowSeconds: limit.windowSeconds })),
        now,
        ttlSeconds: this.options.reservationTtlSeconds ?? 900,
      });
      if (!reserved) {
        return fail("usage_limit_exceeded");
      }
    }

    const run = await this.inner.run({
      actionId: approval.actionId,
      input,
      caller: "web",
      connectionName: approval.connectionName || undefined,
      policy: upstreamPolicy.snapshot,
      runtimeTokenId: approval.tokenId || undefined,
    });
    const succeeded = run?.result.ok === true;
    if (run) {
      await this.approvals.linkRun(id, run.executionId);
      await this.evidence.linkRun(approval.decisionId, run.executionId);
    }
    await Promise.all(
      approval.reservationIds.map((rid) =>
        succeeded ? this.reservations.commit(rid, now.toISOString()) : this.reservations.release(rid),
      ),
    );
    await this.approvals.transition(id, "executing", succeeded ? "executed" : "execution_failed", {
      resolutionReason: succeeded ? undefined : (run?.result.error?.code ?? "execution_failed"),
    });
    return { ok: succeeded, state: succeeded ? "executed" : "execution_failed", runId: run?.executionId };
  }

  /** Simulation: full decision, no reservations, approvals, or execution (rfc/0001). */
  async simulate(
    tokenId: string,
    actionId: string,
    input: unknown,
  ): Promise<{
    decision: LensDecision;
    snapshotId: string;
    principalId: string;
  }> {
    const resolved = await this.resolve(tokenId);
    return {
      decision: authorizeLens(resolved.policy, actionId, input),
      snapshotId: resolved.snapshotId,
      principalId: resolved.principal.principalId,
    };
  }

  async resolve(tokenId: string): Promise<ResolvedAuthority> {
    const principal = (tokenId ? await this.principals.get(tokenId) : undefined) ?? {
      principalId: tokenId ? `tok_${tokenId}` : "anonymous",
    };
    const tokenRecord = tokenId ? await this.tokenPolicies.get(tokenId) : undefined;
    const policy = composeLensPolicies([this.options.deploymentPolicy, tokenRecord?.policy]);
    const snapshotId = `${await policySnapshotId(this.options.deploymentPolicy, tokenRecord?.policy)}:tok_v${
      tokenRecord?.version ?? 0
    }`;
    return { principal, tokenId, policy, snapshotId };
  }

  /** Revalidates upstream token existence and rebuilds its policy snapshot. */
  private async upstreamSnapshotFor(
    approval: ApprovalRecord,
  ): Promise<{ ok: true; snapshot: RunActionInput["policy"] } | { ok: false; errorCode: string }> {
    const upstream = this.options.upstream;
    if (!approval.tokenId || !upstream?.tokenStore || !upstream.actionPolicy) {
      return { ok: true, snapshot: undefined };
    }
    // ponytail: token lookup scans list(); switch to a get-by-id store method if token counts grow.
    const record = (await upstream.tokenStore.list()).find((token) => token.id === approval.tokenId);
    if (!record) {
      return { ok: false, errorCode: "execution_grant_invalid" };
    }
    const runtimeRules = (await upstream.policyStore?.get())?.rules;
    return {
      ok: true,
      snapshot: upstream.actionPolicy.createSnapshot(runtimeRules, {
        allowedActions: record.allowedActions,
        blockedActions: record.blockedActions,
        allowedProxies: record.allowedProxies,
        allowedConnections: record.allowedConnections,
      }),
    };
  }

  private async settle(decisionId: string, reservationIds: string[], run: ActionRunResult | undefined): Promise<void> {
    if (run) {
      await this.evidence.linkRun(decisionId, run.executionId);
    }
    const succeeded = run?.result.ok === true;
    const nowIso = new Date().toISOString();
    await Promise.all(
      reservationIds.map((id) => (succeeded ? this.reservations.commit(id, nowIso) : this.reservations.release(id))),
    );
  }
}

function denialMessage(actionId: string, decision: LensDecision & { effect: "deny" }): string {
  const reason = decision.reasons[0];
  const location = reason?.path ? ` at ${reason.path}` : "";
  return `${actionId} is denied by the lens policy${location}: ${reason?.message ?? decision.errorCode}`;
}

function syntheticResult(code: string, message: string, details?: unknown): ActionRunResult {
  return {
    executionId: crypto.randomUUID(),
    auditPersisted: false,
    result: { ok: false, error: { code, message, details } },
  };
}

async function requestDigest(
  actionId: string,
  connectionName: string,
  tokenId: string,
  input: unknown,
): Promise<string> {
  return sha256Hex(canonicalJson({ actionId, connectionName, tokenId, input: input ?? null }));
}
