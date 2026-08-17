import type { LensDb } from "./db.ts";

import { DatabaseSync } from "node:sqlite";

/**
 * Node adapter over node:sqlite, the same engine the upstream runtime uses.
 * Lens keeps its own database file so it never contends with the upstream
 * connection or its migration tracking (rfc/0004).
 */
export class SqliteLensDb implements LensDb {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const result = this.db.prepare(sql).run(...(params as Array<string | number | null>));
    return { changes: Number(result.changes) };
  }

  async all(sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
    return this.db.prepare(sql).all(...(params as Array<string | number | null>)) as Array<Record<string, unknown>>;
  }

  close(): void {
    this.db.close();
  }
}
