import type { ActionConstraint } from "./constraints.ts";

import { describe, expect, it } from "vitest";
import { constraintListSchema, evaluateConstraints, resolvePointer } from "./constraints.ts";

function constraint(partial: Partial<ActionConstraint> & { rule: ActionConstraint["rule"] }): ActionConstraint {
  return { action: "svc.act", path: "/value", ...partial };
}

describe("constraintListSchema", () => {
  it("accepts every rule kind", () => {
    const list: unknown = [
      { action: "a.b", path: "/x", rule: { kind: "required" } },
      { action: "a.b", path: "/x", rule: { kind: "forbidden" } },
      { action: "a.b", path: "/x", rule: { kind: "max_number", value: "100" } },
      { action: "a.b", path: "/x", rule: { kind: "min_number", value: "1.5" } },
      { action: "a.b", path: "/x", optional: true, rule: { kind: "pattern", value: "^ok$" } },
      { action: "a.b", path: "/x", rule: { kind: "one_of", values: ["a"] } },
      { action: "a.b", path: "/x", rule: { kind: "max_length", value: 3 } },
    ];
    expect(constraintListSchema.parse(list)).toHaveLength(7);
  });

  it("rejects non-numeric bounds and invalid regexes", () => {
    expect(() =>
      constraintListSchema.parse([{ action: "a.b", path: "/x", rule: { kind: "max_number", value: "ten" } }]),
    ).toThrow();
    expect(() =>
      constraintListSchema.parse([{ action: "a.b", path: "/x", rule: { kind: "pattern", value: "(" } }]),
    ).toThrow();
  });
});

describe("evaluateConstraints", () => {
  it("fails closed on a missing path unless optional", () => {
    const strict = constraint({ rule: { kind: "max_number", value: "5" } });
    expect(evaluateConstraints([strict], "svc.act", {})).toMatchObject({ ruleKind: "max_number" });
    const lenient = constraint({ optional: true, rule: { kind: "max_number", value: "5" } });
    expect(evaluateConstraints([lenient], "svc.act", {})).toBeUndefined();
  });

  it("enforces required and forbidden", () => {
    const required = constraint({ rule: { kind: "required" } });
    expect(evaluateConstraints([required], "svc.act", {})).toMatchObject({ ruleKind: "required" });
    expect(evaluateConstraints([required], "svc.act", { value: 1 })).toBeUndefined();
    const forbidden = constraint({ rule: { kind: "forbidden" } });
    expect(evaluateConstraints([forbidden], "svc.act", { value: 1 })).toMatchObject({ ruleKind: "forbidden" });
    expect(evaluateConstraints([forbidden], "svc.act", {})).toBeUndefined();
  });

  it("enforces numeric bounds from string policy values", () => {
    const max = constraint({ rule: { kind: "max_number", value: "100" } });
    const min = constraint({ rule: { kind: "min_number", value: "10" } });
    expect(evaluateConstraints([max, min], "svc.act", { value: 50 })).toBeUndefined();
    expect(evaluateConstraints([max], "svc.act", { value: 101 })).toMatchObject({ ruleKind: "max_number" });
    expect(evaluateConstraints([min], "svc.act", { value: 9 })).toMatchObject({ ruleKind: "min_number" });
    expect(evaluateConstraints([max], "svc.act", { value: "100" })).toMatchObject({ ruleKind: "max_number" });
  });

  it("enforces pattern, one_of, and max_length", () => {
    const pattern = constraint({ path: "/to", rule: { kind: "pattern", value: "@company\\.com$" } });
    expect(evaluateConstraints([pattern], "svc.act", { to: "a@company.com" })).toBeUndefined();
    expect(evaluateConstraints([pattern], "svc.act", { to: "a@evil.com" })).toMatchObject({ ruleKind: "pattern" });
    const oneOf = constraint({ path: "/env", rule: { kind: "one_of", values: ["staging"] } });
    expect(evaluateConstraints([oneOf], "svc.act", { env: "production" })).toMatchObject({ ruleKind: "one_of" });
    const maxLength = constraint({ path: "/items", rule: { kind: "max_length", value: 2 } });
    expect(evaluateConstraints([maxLength], "svc.act", { items: [1, 2, 3] })).toMatchObject({
      ruleKind: "max_length",
    });
  });

  it("never leaks input values into violation messages", () => {
    const pattern = constraint({ path: "/to", rule: { kind: "pattern", value: "@company\\.com$" } });
    const violation = evaluateConstraints([pattern], "svc.act", { to: "secret@evil.com" });
    expect(violation?.message).not.toContain("secret@evil.com");
  });

  it("scopes constraints by action pattern", () => {
    const scoped = constraint({ action: "gmail.*", rule: { kind: "required" } });
    expect(evaluateConstraints([scoped], "stripe.refund", {})).toBeUndefined();
    expect(evaluateConstraints([scoped], "gmail.send", {})).toMatchObject({ ruleKind: "required" });
  });
});

describe("resolvePointer", () => {
  it("resolves nesting, array indexes, and escaped segments", () => {
    const input = { a: { b: [{ "x/y": 7 }] } };
    expect(resolvePointer(input, "/a/b/0/x~1y")).toBe(7);
    expect(resolvePointer(input, "/a/missing")).toBeUndefined();
    expect(resolvePointer(null, "/a")).toBeUndefined();
  });
});
