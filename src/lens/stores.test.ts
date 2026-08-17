import type { ApprovalRecord } from "./stores.ts";

import { describe, expect, it } from "vitest";
import { SqliteLensDb } from "./db-sqlite.ts";
import { bootstrapLensSchema } from "./db.ts";
import { ApprovalStore, ReservationStore } from "./stores.ts";

async function memoryDb(): Promise<SqliteLensDb> {
  const db = new SqliteLensDb(":memory:");
  await bootstrapLensSchema(db);
  return db;
}

function reserveInput(overrides: Partial<Parameters<ReservationStore["reserve"]>[0]> = {}) {
  return {
    id: `res_${crypto.randomUUID()}`,
    tokenId: "tok_a",
    principalId: "agt_a",
    meter: "refund_value",
    amount: 1,
    limits: [{ limit: 10, windowSeconds: 3600 }],
    now: new Date(),
    ttlSeconds: 900,
    ...overrides,
  };
}

describe("ReservationStore", () => {
  it("reserves within the limit and rejects past it", async () => {
    const store = new ReservationStore(await memoryDb());
    expect(await store.reserve(reserveInput({ amount: 9 }))).toBe(true);
    expect(await store.reserve(reserveInput({ amount: 1 }))).toBe(true);
    expect(await store.reserve(reserveInput({ amount: 1 }))).toBe(false);
  });

  it("lets exactly one of two competing reservations through at the boundary", async () => {
    const store = new ReservationStore(await memoryDb());
    expect(await store.reserve(reserveInput({ amount: 9 }))).toBe(true);
    const results = await Promise.all([
      store.reserve(reserveInput({ amount: 1 })),
      store.reserve(reserveInput({ amount: 1 })),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("applies every window limit on the meter", async () => {
    const store = new ReservationStore(await memoryDb());
    const limits = [
      { limit: 100, windowSeconds: 86_400 },
      { limit: 1, windowSeconds: 3600 },
    ];
    expect(await store.reserve(reserveInput({ limits, amount: 1 }))).toBe(true);
    expect(await store.reserve(reserveInput({ limits, amount: 1 }))).toBe(false);
  });

  it("frees capacity on release but not on commit", async () => {
    const store = new ReservationStore(await memoryDb());
    const first = reserveInput({ amount: 10 });
    expect(await store.reserve(first)).toBe(true);
    expect(await store.reserve(reserveInput({ amount: 1 }))).toBe(false);
    await store.release(first.id);
    const second = reserveInput({ amount: 10 });
    expect(await store.reserve(second)).toBe(true);
    expect(await store.commit(second.id, new Date().toISOString())).toBe(true);
    expect(await store.reserve(reserveInput({ amount: 1 }))).toBe(false);
  });

  it("stops counting lapsed reservations and fails reconfirm on them", async () => {
    const store = new ReservationStore(await memoryDb());
    const lapsed = reserveInput({ amount: 10, ttlSeconds: -1 });
    expect(await store.reserve(lapsed)).toBe(true);
    expect(await store.reconfirm(lapsed.id, new Date(), 900)).toBe(false);
    expect(await store.reserve(reserveInput({ amount: 10 }))).toBe(true);
  });
});

function approval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: `apr_${crypto.randomUUID()}`,
    principalId: "agt_a",
    tokenId: "tok_a",
    actionId: "github.merge",
    providerId: "github",
    connectionName: "",
    inputCiphertext: "{}",
    inputDigest: "digest",
    policySnapshotId: "snap",
    decisionId: "dec_1",
    state: "pending",
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    reservationIds: [],
    ...overrides,
  };
}

describe("ApprovalStore", () => {
  it("transitions atomically and rejects a stale from-state", async () => {
    const store = new ApprovalStore(await memoryDb());
    const record = approval();
    await store.add(record);
    expect(await store.transition(record.id, "pending", "approved", { grantExpiresAt: record.expiresAt })).toBe(true);
    expect(await store.transition(record.id, "pending", "denied")).toBe(false);
  });

  it("consumes an execution grant exactly once", async () => {
    const store = new ApprovalStore(await memoryDb());
    const record = approval();
    await store.add(record);
    const now = new Date().toISOString();
    await store.transition(record.id, "pending", "approved", {
      grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await store.consumeGrant(record.id, now)).toBe(true);
    expect(await store.consumeGrant(record.id, now)).toBe(false);
  });

  it("rejects grant consumption after grant expiry", async () => {
    const store = new ApprovalStore(await memoryDb());
    const record = approval();
    await store.add(record);
    await store.transition(record.id, "pending", "approved", {
      grantExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await store.consumeGrant(record.id, new Date().toISOString())).toBe(false);
  });

  it("lazily expires overdue pending approvals on list", async () => {
    const store = new ApprovalStore(await memoryDb());
    const record = approval({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    await store.add(record);
    const expired = await store.list("expired", new Date().toISOString());
    expect(expired.map((item) => item.id)).toContain(record.id);
  });
});
