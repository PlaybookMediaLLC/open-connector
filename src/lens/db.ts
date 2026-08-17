/** Minimal async database surface shared by the SQLite and D1 adapters. */
export interface LensDb {
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  all(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
}

/** Structural view of a Cloudflare D1 binding. Avoids a workers-types dependency. */
export interface D1LikeDatabase {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta: { changes: number } }>;
      all(): Promise<{ results: Array<Record<string, unknown>> }>;
    };
  };
  exec(sql: string): Promise<unknown>;
}

export class D1LensDb implements LensDb {
  private readonly db: D1LikeDatabase;

  constructor(db: D1LikeDatabase) {
    this.db = db;
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const result = await this.db
      .prepare(sql)
      .bind(...params)
      .run();
    return { changes: result.meta.changes };
  }

  async all(sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
    const result = await this.db
      .prepare(sql)
      .bind(...params)
      .all();
    return result.results;
  }
}

/**
 * Defers every database touch until first real use, then bootstraps the
 * lens_ schema once. The Workers entry needs this: upstream app creation
 * must not touch D1, and its tests enforce that.
 */
export class LazyLensDb implements LensDb {
  private readonly inner: LensDb;
  private ready?: Promise<void>;

  constructor(inner: LensDb) {
    this.inner = inner;
  }

  private ensureSchema(): Promise<void> {
    this.ready ??= bootstrapLensSchema(this.inner);
    return this.ready;
  }

  async run(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    await this.ensureSchema();
    return this.inner.run(sql, params);
  }

  async all(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>> {
    await this.ensureSchema();
    return this.inner.all(sql, params);
  }
}

/**
 * Lens-owned schema. Idempotent by design: lens bootstraps its own tables at
 * startup instead of adding files to the upstream migrations directory
 * (rfc/0004). All tables use the lens_ prefix and never alter upstream tables.
 */
export const LENS_SCHEMA = `
CREATE TABLE IF NOT EXISTS lens_principals (
  token_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  subject_id TEXT,
  label TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lens_token_policies (
  token_id TEXT PRIMARY KEY,
  policy_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lens_decisions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  subject_id TEXT,
  action_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  connection_name TEXT NOT NULL,
  effect TEXT NOT NULL,
  error_code TEXT,
  input_digest TEXT NOT NULL,
  policy_snapshot_id TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  obligations_json TEXT NOT NULL,
  approval_id TEXT,
  reservation_ids_json TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lens_decisions_principal ON lens_decisions (principal_id, created_at);
CREATE TABLE IF NOT EXISTS lens_approvals (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  subject_id TEXT,
  action_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  connection_name TEXT NOT NULL,
  input_ciphertext TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  policy_snapshot_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  state TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_reason TEXT,
  grant_expires_at TEXT,
  grant_consumed_at TEXT,
  run_id TEXT,
  reservation_ids_json TEXT
);
CREATE INDEX IF NOT EXISTS lens_approvals_state ON lens_approvals (state, requested_at);
CREATE TABLE IF NOT EXISTS lens_reservations (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  meter TEXT NOT NULL,
  amount INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  committed_at TEXT
);
CREATE INDEX IF NOT EXISTS lens_reservations_meter ON lens_reservations (token_id, meter, state, created_at);
`;

export async function bootstrapLensSchema(db: LensDb): Promise<void> {
  for (const statement of LENS_SCHEMA.split(";")) {
    const compact = statement.replaceAll("\n", " ").trim();
    if (compact) {
      await db.run(compact);
    }
  }
}
