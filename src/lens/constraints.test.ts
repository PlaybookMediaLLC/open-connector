import type { ActionConstraint } from "./constraints.ts";

import { describe, expect, it } from "vitest";
import { evaluateConstraints, parseConstraints } from "./constraints.ts";

const maxRefund: ActionConstraint = {
  action: "stripe.create_refund",
  path: "/amount",
  rule: { kind: "max_number", value: 100 },
};

const internalRecipients: ActionConstraint = {
  action: "gmail.*",
  path: "/to",
  rule: { kind: "pattern", value: "@company\\.com$" },
};

describe("parseConstraints", () => {
  it("returns an empty list for unset or blank values", () => {
    expect(parseConstraints(undefined)).toEqual([]);
    expect(parseConstraints("  ")).toEqual([]);
  });

  it("parses a valid constraint list", () => {
    expect(parseConstraints(JSON.stringify([maxRefund]))).toEqual([maxRefund]);
  });

  it("throws on malformed JSON", () => {
    expect(() => parseConstraints("{not json")).toThrow(/JSON array/u);
  });

  it("throws on an unknown rule kind", () => {
    const raw = JSON.stringify([{ action: "a.b", path: "/x", rule: { kind: "min_number", value: 1 } }]);
    expect(() => parseConstraints(raw)).toThrow(/invalid/u);
  });

  it("throws on an invalid regular expression", () => {
    const raw = JSON.stringify([{ action: "a.b", path: "/x", rule: { kind: "pattern", value: "(" } }]);
    expect(() => parseConstraints(raw)).toThrow(/invalid/u);
  });

  it("throws on a path without a leading slash", () => {
    const raw = JSON.stringify([{ action: "a.b", path: "x", rule: { kind: "max_length", value: 1 } }]);
    expect(() => parseConstraints(raw)).toThrow(/invalid/u);
  });
});

describe("evaluateConstraints", () => {
  it("passes input inside the limit", () => {
    expect(evaluateConstraints([maxRefund], "stripe.create_refund", { amount: 100 })).toBeUndefined();
  });

  it("rejects input above a max_number limit", () => {
    const violation = evaluateConstraints([maxRefund], "stripe.create_refund", { amount: 101 });
    expect(violation).toMatchObject({ path: "/amount", kind: "max_number" });
  });

  it("fails closed when a max_number value is missing", () => {
    expect(evaluateConstraints([maxRefund], "stripe.create_refund", {})).toMatchObject({ kind: "max_number" });
  });

  it("ignores actions that do not match the pattern", () => {
    expect(evaluateConstraints([maxRefund], "stripe.create_charge", { amount: 9999 })).toBeUndefined();
  });

  it("matches service prefixes and rejects external recipients", () => {
    expect(evaluateConstraints([internalRecipients], "gmail.send_email", { to: "a@company.com" })).toBeUndefined();
    expect(evaluateConstraints([internalRecipients], "gmail.send_email", { to: "a@evil.com" })).toMatchObject({
      kind: "pattern",
    });
  });

  it("fails closed when a pattern value is missing", () => {
    expect(evaluateConstraints([internalRecipients], "gmail.send_email", {})).toMatchObject({ kind: "pattern" });
  });

  it("matches every action with the wildcard pattern", () => {
    const anywhere: ActionConstraint = { action: "*", path: "/env", rule: { kind: "one_of", values: ["staging"] } };
    expect(evaluateConstraints([anywhere], "vercel.deploy", { env: "production" })).toMatchObject({ kind: "one_of" });
    expect(evaluateConstraints([anywhere], "vercel.deploy", { env: "staging" })).toBeUndefined();
  });

  it("lets max_length pass when the value is absent", () => {
    const cap: ActionConstraint = { action: "x.y", path: "/items", rule: { kind: "max_length", value: 2 } };
    expect(evaluateConstraints([cap], "x.y", {})).toBeUndefined();
    expect(evaluateConstraints([cap], "x.y", { items: [1, 2] })).toBeUndefined();
    expect(evaluateConstraints([cap], "x.y", { items: [1, 2, 3] })).toMatchObject({ kind: "max_length" });
  });

  it("resolves nested paths, array indexes, and escaped segments", () => {
    const nested: ActionConstraint = {
      action: "x.y",
      path: "/message/recipients/0/email",
      rule: { kind: "pattern", value: "@company\\.com$" },
    };
    const escaped: ActionConstraint = {
      action: "x.y",
      path: "/fields/a~1b",
      rule: { kind: "max_number", value: 5 },
    };
    const input = {
      message: { recipients: [{ email: "a@company.com" }] },
      fields: { "a/b": 3 },
    };
    expect(evaluateConstraints([nested, escaped], "x.y", input)).toBeUndefined();
    expect(evaluateConstraints([nested], "x.y", { message: { recipients: [{ email: "a@evil.com" }] } })).toMatchObject({
      kind: "pattern",
    });
  });
});
