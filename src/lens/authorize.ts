import type { LensPolicy, MeterAmount } from "./policy.ts";

import { evaluateConstraints, matchesActionPattern } from "./constraints.ts";
import { calculateMeterAmounts } from "./policy.ts";

/** Structured, sensitive-value-free explanation of a decision (rfc/0001). */
export interface AuthorizationReason {
  code: string;
  message: string;
  path?: string;
  ruleKind?: string;
}

export type AuthorizationObligation =
  | { kind: "reserve_meter"; meter: string; amount: number }
  | {
      kind: "require_approval";
    };

export type LensDecision =
  | { effect: "deny"; errorCode: string; reasons: AuthorizationReason[] }
  | { effect: "allow"; obligations: AuthorizationObligation[]; reasons: AuthorizationReason[] };

/**
 * Pure policy evaluation over the effective lens policy. No I/O.
 * Obligations (meter reservation, approval) are satisfied by the runtime layer.
 * Any evaluation exception in callers must fail closed.
 */
export function authorizeLens(policy: LensPolicy, actionId: string, input: unknown): LensDecision {
  const violation = evaluateConstraints(policy.constraints, actionId, input);
  if (violation) {
    return {
      effect: "deny",
      errorCode: "input_constraint_violation",
      reasons: [
        {
          code: "input_constraint_violation",
          message: violation.message,
          path: violation.path,
          ruleKind: violation.ruleKind,
        },
      ],
    };
  }

  const meterResult = calculateMeterAmounts(policy, actionId, input);
  if (!meterResult.ok) {
    return {
      effect: "deny",
      errorCode: "input_constraint_violation",
      reasons: [{ code: "meter_input_invalid", message: meterResult.message, path: meterResult.meter }],
    };
  }

  const obligations: AuthorizationObligation[] = meterResult.amounts
    .filter((entry: MeterAmount) => entry.amount > 0)
    .map((entry: MeterAmount) => ({ kind: "reserve_meter", meter: entry.meter, amount: entry.amount }));

  if (policy.approvalRequired.some((pattern) => matchesActionPattern(pattern, actionId))) {
    obligations.push({ kind: "require_approval" });
  }

  return {
    effect: "allow",
    obligations,
    reasons: [{ code: "allowed", message: "request satisfies every applicable lens policy layer" }],
  };
}
