import type { ActionDefinition } from "../core/types.ts";
import type { ActionRunner, RunActionInput } from "../server/actions/action-runner.ts";
import type { ActionConstraint } from "./constraints.ts";

import { describe, expect, it } from "vitest";
import { ActionPolicySnapshot, emptyPolicyRules } from "../core/action-policy.ts";
import { createLensActionRunnerWrapper, withLensAuthorization } from "./lens-action-runner.ts";

const sendEmail = { id: "gmail.send_email", service: "gmail" } as ActionDefinition;

const internalOnly: ActionConstraint = {
  action: "gmail.*",
  path: "/to",
  rule: { kind: "pattern", value: "@company\\.com$" },
};

/** Captures the RunActionInput the wrapper forwards to the upstream runner. */
function captureRunner(): { actions: ActionRunner; seen: RunActionInput[] } {
  const seen: RunActionInput[] = [];
  const actions = {
    async run(input: RunActionInput) {
      seen.push(input);
      return undefined;
    },
  } as unknown as ActionRunner;
  return { actions, seen };
}

describe("createLensActionRunnerWrapper", () => {
  it("returns undefined when no constraints are configured", () => {
    expect(createLensActionRunnerWrapper(undefined)).toBeUndefined();
    expect(createLensActionRunnerWrapper("[]")).toBeUndefined();
  });

  it("returns a wrapper when constraints are configured", () => {
    expect(createLensActionRunnerWrapper(JSON.stringify([internalOnly]))).toBeTypeOf("function");
  });
});

describe("withLensAuthorization", () => {
  it("keeps allowed decisions and their checks", async () => {
    const { actions, seen } = captureRunner();
    const wrapped = withLensAuthorization(actions, [internalOnly]);
    await wrapped.run({ actionId: sendEmail.id, input: { to: "a@company.com" }, caller: "http" });
    const decision = seen[0]?.policy?.evaluate(sendEmail);
    expect(decision).toMatchObject({ allowed: true });
  });

  it("denies a violating input through the policy snapshot", async () => {
    const { actions, seen } = captureRunner();
    const wrapped = withLensAuthorization(actions, [internalOnly]);
    await wrapped.run({ actionId: sendEmail.id, input: { to: "a@evil.com" }, caller: "mcp" });
    const decision = seen[0]?.policy?.evaluate(sendEmail);
    expect(decision).toMatchObject({ allowed: false, code: "action_blocked" });
    expect(decision && !decision.allowed ? decision.message : "").toContain("/to");
  });

  it("keeps an existing policy denial unchanged", async () => {
    const { actions, seen } = captureRunner();
    const wrapped = withLensAuthorization(actions, [internalOnly]);
    const blocking = new ActionPolicySnapshot(
      { ...emptyPolicyRules(), blockedActions: ["gmail.send_email"] },
      emptyPolicyRules(),
    );
    await wrapped.run({ actionId: sendEmail.id, input: { to: "a@company.com" }, caller: "http", policy: blocking });
    const decision = seen[0]?.policy?.evaluate(sendEmail);
    expect(decision).toMatchObject({ allowed: false });
    expect(decision && !decision.allowed ? decision.checks[0]?.rule : "").toBe("gmail.send_email");
  });

  it("layers constraints on top of an allowing policy snapshot", async () => {
    const { actions, seen } = captureRunner();
    const wrapped = withLensAuthorization(actions, [internalOnly]);
    const allowing = new ActionPolicySnapshot(emptyPolicyRules(), emptyPolicyRules());
    await wrapped.run({ actionId: sendEmail.id, input: { to: "a@evil.com" }, caller: "http", policy: allowing });
    expect(seen[0]?.policy?.evaluate(sendEmail)).toMatchObject({ allowed: false });
  });

  it("delegates non-run members to the wrapped runner", () => {
    const { actions } = captureRunner();
    const wrapped = withLensAuthorization(actions, [internalOnly]);
    expect(Object.getPrototypeOf(wrapped)).toBe(actions);
  });
});
