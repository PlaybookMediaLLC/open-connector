import { z } from "zod";

export type ConstraintRule =
  | { kind: "required" }
  | { kind: "forbidden" }
  | { kind: "max_number"; value: string }
  | { kind: "min_number"; value: string }
  | { kind: "pattern"; value: string }
  | { kind: "one_of"; values: string[] }
  | { kind: "max_length"; value: number };

/**
 * One restriction on the input of matching actions (rfc/0001).
 * A missing path fails closed unless `optional` is true.
 */
export interface ActionConstraint {
  action: string;
  path: string;
  optional?: boolean;
  rule: ConstraintRule;
}

/** Structured denial metadata. Never contains input values. */
export interface ConstraintViolation {
  path: string;
  ruleKind: ConstraintRule["kind"];
  message: string;
}

const numericString = z.string().refine((v) => Number.isFinite(Number(v)) && v.trim() !== "", {
  message: "must be a numeric string",
});

const ruleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("required") }),
  z.object({ kind: z.literal("forbidden") }),
  z.object({ kind: z.literal("max_number"), value: numericString }),
  z.object({ kind: z.literal("min_number"), value: numericString }),
  z.object({
    kind: z.literal("pattern"),
    value: z.string().refine(isValidRegExp, { message: "must be a valid regular expression" }),
  }),
  z.object({ kind: z.literal("one_of"), values: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("max_length"), value: z.number().int().positive() }),
]);

export const constraintListSchema: z.ZodType<ActionConstraint[]> = z.array(
  z.object({
    action: z.string().min(1),
    path: z.string().startsWith("/"),
    optional: z.boolean().optional(),
    rule: ruleSchema,
  }),
);

/** Same pattern semantics as the upstream action policy lists: "*", "service.*", or an exact id. */
export function matchesActionPattern(pattern: string, actionId: string): boolean {
  if (pattern === "*") {
    return true;
  }
  if (pattern.endsWith(".*")) {
    return actionId.startsWith(pattern.slice(0, -1));
  }
  return actionId === pattern;
}

/**
 * Evaluates every constraint whose action pattern matches the action id.
 * Returns the first violation, or undefined when the input passes.
 */
export function evaluateConstraints(
  constraints: ActionConstraint[],
  actionId: string,
  input: unknown,
): ConstraintViolation | undefined {
  for (const constraint of constraints) {
    if (!matchesActionPattern(constraint.action, actionId)) {
      continue;
    }
    const value = resolvePointer(input, constraint.path);
    const message = checkRule(constraint.rule, value, constraint.optional === true);
    if (message) {
      return { path: constraint.path, ruleKind: constraint.rule.kind, message };
    }
  }
  return undefined;
}

/**
 * Checks one rule against one resolved value.
 * Error messages reference policy bounds only, never input values.
 */
function checkRule(rule: ConstraintRule, value: unknown, optional: boolean): string | undefined {
  if (rule.kind === "forbidden") {
    return value === undefined ? undefined : "value is forbidden at this path";
  }
  if (value === undefined) {
    if (rule.kind === "required") {
      return "value is required at this path";
    }
    return optional ? undefined : "value is missing and the constraint is not optional";
  }
  switch (rule.kind) {
    case "required": {
      return undefined;
    }
    case "max_number": {
      if (typeof value !== "number" || Number.isNaN(value)) {
        return "value is not a number";
      }
      return value <= Number(rule.value) ? undefined : `value exceeds the maximum of ${rule.value}`;
    }
    case "min_number": {
      if (typeof value !== "number" || Number.isNaN(value)) {
        return "value is not a number";
      }
      return value >= Number(rule.value) ? undefined : `value is below the minimum of ${rule.value}`;
    }
    case "pattern": {
      if (typeof value !== "string") {
        return "value is not a string";
      }
      // ponytail: the regex compiles per check; cache compiled rules if constraint lists grow large.
      return new RegExp(rule.value, "u").test(value) ? undefined : "value does not match the required pattern";
    }
    case "one_of": {
      if (typeof value !== "string") {
        return "value is not a string";
      }
      return rule.values.includes(value) ? undefined : "value is not in the allowed list";
    }
    case "max_length": {
      const length = typeof value === "string" || Array.isArray(value) ? value.length : undefined;
      if (length === undefined) {
        return "value has no length";
      }
      return length <= rule.value ? undefined : `length exceeds the maximum of ${rule.value}`;
    }
  }
}

/** Resolves an RFC 6901 JSON pointer against the action input. */
export function resolvePointer(input: unknown, pointer: string): unknown {
  let current: unknown = input;
  for (const rawSegment of pointer.split("/").slice(1)) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      const index = /^\d+$/u.test(segment) ? Number(segment) : undefined;
      current = index === undefined ? undefined : current[index];
    } else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function isValidRegExp(value: string): boolean {
  try {
    new RegExp(value, "u");
    return true;
  } catch {
    return false;
  }
}
