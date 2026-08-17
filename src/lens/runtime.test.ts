import type { ActionDefinition } from "../core/types.ts";
import type { ActionRunner, ActionRunResult, RunActionInput } from "../server/actions/action-runner.ts";
import type { IRuntimeTokenStore, RuntimeTokenRecord } from "../server/storage/runtime-token-service.ts";
import type { LensPolicy } from "./policy.ts";

import { describe, expect, it } from "vitest";
import { ActionPolicyService } from "../core/action-policy.ts";
import { PlainTextSecretCodec } from "../server/secrets/secret-codec-core.ts";
import { SqliteLensDb } from "./db-sqlite.ts";
import { bootstrapLensSchema } from "./db.ts";
import { emptyLensPolicy } from "./policy.ts";
import { LensRuntime } from "./runtime.ts";

interface Fixture {
  runtime: LensRuntime;
  wrapped: ActionRunner;
  db: SqliteLensDb;
  calls: RunActionInput[];
  policy: LensPolicy;
  setProviderOk: (ok: boolean) => void;
  tokenRecords: RuntimeTokenRecord[];
}

function fakeInnerRunner(calls: RunActionInput[], providerOk: { value: boolean }): ActionRunner {
  return {
    async run(input: RunActionInput): Promise<ActionRunResult> {
      calls.push(input);
      const decision = input.policy?.evaluate({ id: input.actionId } as ActionDefinition);
      if (decision && !decision.allowed) {
        return {
          executionId: crypto.randomUUID(),
          auditPersisted: true,
          result: { ok: false, error: { code: decision.code, message: decision.message } },
        };
      }
      return {
        executionId: crypto.randomUUID(),
        auditPersisted: true,
        result: providerOk.value
          ? { ok: true, output: { done: true } }
          : { ok: false, error: { code: "provider_error", message: "provider failed" } },
      };
    },
  } as unknown as ActionRunner;
}

function fakeTokenStore(records: RuntimeTokenRecord[]): IRuntimeTokenStore {
  return { list: async () => records } as unknown as IRuntimeTokenStore;
}

async function fixture(policy: Partial<LensPolicy> = {}): Promise<Fixture> {
  const db = new SqliteLensDb(":memory:");
  await bootstrapLensSchema(db);
  const effective = { ...emptyLensPolicy(), ...policy };
  const calls: RunActionInput[] = [];
  const providerOk = { value: true };
  const tokenRecords: RuntimeTokenRecord[] = [
    {
      id: "tok_a",
      name: "test",
      tokenHash: "x",
      allowedActions: [],
      blockedActions: [],
      allowedProxies: [],
      createdAt: new Date().toISOString(),
    },
  ];
  const runtime = new LensRuntime({
    db,
    secretCodec: new PlainTextSecretCodec(),
    deploymentPolicy: effective,
    upstream: {
      actionPolicy: new ActionPolicyService({}),
      tokenStore: fakeTokenStore(tokenRecords),
    },
  });
  const wrapped = runtime.wrap(fakeInnerRunner(calls, providerOk));
  return {
    runtime,
    wrapped,
    db,
    calls,
    policy: effective,
    setProviderOk: (ok) => {
      providerOk.value = ok;
    },
    tokenRecords,
  };
}

const baseRun: RunActionInput = { actionId: "github.merge", input: { repo: "a/b" }, caller: "http" };

describe("LensRuntime execution path", () => {
  it("passes through with an empty policy and writes evidence", async () => {
    const f = await fixture();
    const run = await f.wrapped.run({ ...baseRun, runtimeTokenId: "tok_a" });
    expect(run?.result.ok).toBe(true);
    expect(f.calls).toHaveLength(1);
    const decisions = await f.runtime.evidence.list({});
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ effect: "allow", principal_id: "tok_tok_a", action_id: "github.merge" });
    expect(decisions[0]?.run_id).toBe(run?.executionId);
  });

  it("denies constraint violations without calling the provider", async () => {
    const f = await fixture({
      constraints: [{ action: "github.*", path: "/repo", rule: { kind: "one_of", values: ["a/b"] } }],
    });
    const run = await f.wrapped.run({ ...baseRun, input: { repo: "evil/repo" } });
    expect(run?.result.ok).toBe(false);
    expect(run?.result.error?.code).toBe("input_constraint_violation");
    expect(f.calls).toHaveLength(0);
    const decisions = await f.runtime.evidence.list({});
    expect(decisions[0]).toMatchObject({ effect: "deny", error_code: "input_constraint_violation" });
  });

  it("enforces usage limits atomically and releases on provider failure", async () => {
    const f = await fixture({
      meters: [{ name: "merge_count", action: "github.*", kind: "count" }],
      usageLimits: [{ meter: "merge_count", limit: "1", windowSeconds: 3600 }],
    });
    expect((await f.wrapped.run(baseRun))?.result.ok).toBe(true);
    const limited = await f.wrapped.run(baseRun);
    expect(limited?.result.error?.code).toBe("rate_limited");
    expect((limited?.result.error?.details as { code: string }).code).toBe("usage_limit_exceeded");
    expect(f.calls).toHaveLength(1);
  });

  it("releases reservations when the provider fails", async () => {
    const f = await fixture({
      meters: [{ name: "merge_count", action: "github.*", kind: "count" }],
      usageLimits: [{ meter: "merge_count", limit: "1", windowSeconds: 3600 }],
    });
    f.setProviderOk(false);
    expect((await f.wrapped.run(baseRun))?.result.ok).toBe(false);
    f.setProviderOk(true);
    expect((await f.wrapped.run(baseRun))?.result.ok).toBe(true);
  });

  it("meters money amounts from the input and fails closed on bad amounts", async () => {
    const f = await fixture({
      meters: [{ name: "refund_value", action: "stripe.refund", kind: "number", path: "/amount" }],
      usageLimits: [{ meter: "refund_value", limit: "10000", windowSeconds: 86_400 }],
    });
    const ok = await f.wrapped.run({ actionId: "stripe.refund", input: { amount: 9000 }, caller: "http" });
    expect(ok?.result.ok).toBe(true);
    const over = await f.wrapped.run({ actionId: "stripe.refund", input: { amount: 2000 }, caller: "http" });
    expect(over?.result.error?.code).toBe("rate_limited");
    const bad = await f.wrapped.run({ actionId: "stripe.refund", input: { amount: "9000" }, caller: "http" });
    expect(bad?.result.error?.code).toBe("input_constraint_violation");
  });
});

describe("LensRuntime approval lifecycle", () => {
  const approvalPolicy: Partial<LensPolicy> = { approvalRequired: ["github.*"] };

  async function requestApproval(f: Fixture): Promise<string> {
    const callsBefore = f.calls.length;
    const pending = await f.wrapped.run({ ...baseRun, runtimeTokenId: "tok_a" });
    expect(pending?.result.error?.code).toBe("approval_required");
    const details = pending?.result.error?.details as { approvalId: string; status: string };
    expect(details.status).toBe("pending_approval");
    expect(f.calls).toHaveLength(callsBefore);
    return details.approvalId;
  }

  it("pauses, approves, revalidates, and executes the exact intent", async () => {
    const f = await fixture(approvalPolicy);
    const approvalId = await requestApproval(f);
    const result = await f.runtime.resolveApproval(approvalId, "console");
    expect(result).toMatchObject({ ok: true, state: "executed" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ actionId: "github.merge", input: { repo: "a/b" }, caller: "web" });
    const approval = await f.runtime.approvals.get(approvalId);
    expect(approval?.state).toBe("executed");
    expect(approval?.runId).toBe(result.runId);
  });

  it("denies without executing and rejects double resolution", async () => {
    const f = await fixture(approvalPolicy);
    const approvalId = await requestApproval(f);
    expect(await f.runtime.denyApproval(approvalId, "console", "no")).toMatchObject({ ok: true, state: "denied" });
    expect(f.calls).toHaveLength(0);
    const again = await f.runtime.resolveApproval(approvalId, "console");
    expect(again.errorCode).toBe("approval_conflict");
  });

  it("rejects a second approval of an executed request", async () => {
    const f = await fixture(approvalPolicy);
    const approvalId = await requestApproval(f);
    expect((await f.runtime.resolveApproval(approvalId, "console")).ok).toBe(true);
    const replay = await f.runtime.resolveApproval(approvalId, "console");
    expect(replay.ok).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  it("binds approval to the exact request digest", async () => {
    const f = await fixture(approvalPolicy);
    const approvalId = await requestApproval(f);
    await f.db.run("UPDATE lens_approvals SET input_ciphertext = ? WHERE id = ?", [
      JSON.stringify({ repo: "evil/repo" }),
      approvalId,
    ]);
    const result = await f.runtime.resolveApproval(approvalId, "console");
    expect(result).toMatchObject({ ok: false, errorCode: "execution_grant_invalid" });
    expect(f.calls).toHaveLength(0);
  });

  it("re-evaluates lens policy at execution time", async () => {
    const f = await fixture(approvalPolicy);
    const approvalId = await requestApproval(f);
    f.policy.constraints.push({ action: "github.*", path: "/repo", rule: { kind: "forbidden" } });
    const result = await f.runtime.resolveApproval(approvalId, "console");
    expect(result).toMatchObject({ ok: false, errorCode: "input_constraint_violation" });
    expect(f.calls).toHaveLength(0);
  });

  it("re-evaluates upstream token policy and revocation at execution time", async () => {
    const f = await fixture(approvalPolicy);
    const blockedId = await requestApproval(f);
    f.tokenRecords[0]!.blockedActions = ["github.merge"];
    const blocked = await f.runtime.resolveApproval(blockedId, "console");
    expect(blocked).toMatchObject({ ok: false, state: "execution_failed" });
    expect(f.calls).toHaveLength(1);

    f.tokenRecords[0]!.blockedActions = [];
    const revokedId = await requestApproval(f);
    f.tokenRecords.length = 0;
    const revoked = await f.runtime.resolveApproval(revokedId, "console");
    expect(revoked).toMatchObject({ ok: false, errorCode: "execution_grant_invalid" });
  });

  it("expires overdue approvals instead of executing them", async () => {
    const f = await fixture(approvalPolicy);
    const approvalId = await requestApproval(f);
    await f.db.run("UPDATE lens_approvals SET expires_at = ? WHERE id = ?", [
      new Date(Date.now() - 1000).toISOString(),
      approvalId,
    ]);
    const result = await f.runtime.resolveApproval(approvalId, "console");
    expect(result).toMatchObject({ ok: false, errorCode: "approval_expired" });
    expect(f.calls).toHaveLength(0);
  });
});

describe("LensRuntime simulation and identity", () => {
  it("simulates decisions without side effects", async () => {
    const f = await fixture({ approvalRequired: ["github.*"] });
    const result = await f.runtime.simulate("tok_a", "github.merge", { repo: "a/b" });
    expect(result.decision.effect).toBe("allow");
    expect(await f.runtime.approvals.list(undefined, new Date().toISOString())).toHaveLength(0);
    expect(await f.runtime.evidence.list({})).toHaveLength(0);
  });

  it("uses the mapped principal and token policy layer", async () => {
    const f = await fixture();
    const now = new Date().toISOString();
    await f.runtime.principals.put("tok_a", { principalId: "agt_invoicing", subjectId: "usr_alice" }, now);
    await f.runtime.tokenPolicies.put(
      "tok_a",
      {
        ...emptyLensPolicy(),
        constraints: [{ action: "*", path: "/repo", rule: { kind: "one_of", values: ["a/b"] } }],
      },
      now,
    );
    const denied = await f.wrapped.run({ ...baseRun, input: { repo: "evil/repo" }, runtimeTokenId: "tok_a" });
    expect(denied?.result.error?.code).toBe("input_constraint_violation");
    const decisions = await f.runtime.evidence.list({ principalId: "agt_invoicing" });
    expect(decisions[0]).toMatchObject({ principal_id: "agt_invoicing", subject_id: "usr_alice" });
  });

  it("fails closed when lens storage breaks mid-request", async () => {
    const f = await fixture();
    f.db.close();
    const run = await f.wrapped.run(baseRun);
    expect(run?.result.error?.code).toBe("authorization_failed");
    expect(f.calls).toHaveLength(0);
  });
});
