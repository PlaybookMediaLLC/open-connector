import type { ActionConstraint } from "./constraints.ts";

import { z } from "zod";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { constraintListSchema, matchesActionPattern, resolvePointer } from "./constraints.ts";

/**
 * Declares how an action accrues usage on a meter (rfc/0001).
 * "count" adds 1 per run. "number" reads an integer amount from the input path.
 */
export interface MeterDefinition {
  name: string;
  action: string;
  kind: "count" | "number";
  path?: string;
}

/** A bound on accrued meter usage inside a rolling window. */
export interface UsageLimit {
  meter: string;
  limit: string;
  windowSeconds: number;
}

/** One lens policy layer. Layers compose monotonically: they only narrow. */
export interface LensPolicy {
  constraints: ActionConstraint[];
  usageLimits: UsageLimit[];
  approvalRequired: string[];
  meters: MeterDefinition[];
}

const policySchema: z.ZodType<LensPolicy> = z.object({
  constraints: constraintListSchema.default([]),
  usageLimits: z
    .array(
      z.object({
        meter: z.string().min(1),
        limit: z.string().refine((v) => /^\d+$/u.test(v), { message: "limit must be a non-negative integer string" }),
        windowSeconds: z.number().int().positive(),
      }),
    )
    .default([]),
  approvalRequired: z.array(z.string().min(1)).default([]),
  meters: z
    .array(
      z.object({
        name: z.string().min(1),
        action: z.string().min(1),
        kind: z.enum(["count", "number"]),
        path: z.string().startsWith("/").optional(),
      }),
    )
    .default([]),
}) as z.ZodType<LensPolicy>;

export function emptyLensPolicy(): LensPolicy {
  return { constraints: [], usageLimits: [], approvalRequired: [], meters: [] };
}

/** Parses one policy document. Throws with a clear message on invalid input. */
export function parseLensPolicy(value: unknown, source: string): LensPolicy {
  const result = policySchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`${source} is invalid: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "unknown error"}`);
  }
  return result.data;
}

/** Parses the LENS_POLICY environment value. Unset means an empty policy. */
export function parseLensPolicyEnv(raw: string | undefined): LensPolicy {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return emptyLensPolicy();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("LENS_POLICY must be a JSON object.");
  }
  return parseLensPolicy(parsed, "LENS_POLICY");
}

/**
 * Composes policy layers monotonically (rfc/0001 policy composition):
 * constraints and limits all apply; approval requirements union.
 */
export function composeLensPolicies(layers: Array<LensPolicy | undefined>): LensPolicy {
  const effective = emptyLensPolicy();
  for (const layer of layers) {
    if (!layer) {
      continue;
    }
    effective.constraints.push(...layer.constraints);
    effective.usageLimits.push(...layer.usageLimits);
    effective.approvalRequired.push(...layer.approvalRequired);
    effective.meters.push(...layer.meters);
  }
  return effective;
}

export interface MeterAmount {
  meter: string;
  amount: number;
}

export type MeterAmountsResult = { ok: true; amounts: MeterAmount[] } | { ok: false; meter: string; message: string };

/**
 * Calculates how a request accrues each limited meter.
 * A "number" meter with a missing or non-integer amount fails closed.
 */
export function calculateMeterAmounts(policy: LensPolicy, actionId: string, input: unknown): MeterAmountsResult {
  const limitedMeters = new Set(policy.usageLimits.map((limit) => limit.meter));
  const amounts = new Map<string, number>();
  for (const meter of policy.meters) {
    if (!limitedMeters.has(meter.name) || !matchesActionPattern(meter.action, actionId)) {
      continue;
    }
    if (meter.kind === "count") {
      amounts.set(meter.name, (amounts.get(meter.name) ?? 0) + 1);
      continue;
    }
    const value = meter.path === undefined ? undefined : resolvePointer(input, meter.path);
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      return { ok: false, meter: meter.name, message: "meter amount is missing or is not a non-negative integer" };
    }
    amounts.set(meter.name, (amounts.get(meter.name) ?? 0) + value);
  }
  return { ok: true, amounts: [...amounts.entries()].map(([meter, amount]) => ({ meter, amount })) };
}

/** Stable identifier for the policy content that produced a decision. */
export async function policySnapshotId(deployment: LensPolicy, token: LensPolicy | undefined): Promise<string> {
  const digest = await sha256Hex(canonicalJson({ deployment, token: token ?? null }));
  return `lens:${digest.slice(0, 16)}`;
}
