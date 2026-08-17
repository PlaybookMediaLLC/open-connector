import { z } from "zod";

export type ConstraintRule =
  | { kind: "max_number"; value: number }
  | { kind: "pattern"; value: string }
  | { kind: "one_of"; values: string[] }
  | { kind: "max_length"; value: number };

/**
 * One deployment-level restriction on the input of matching actions.
 * See rfc/0001 (argument-level constraints) and rfc/0004 (configuration).
 */
export interface ActionConstraint {
  action: string;
  path: string;
  rule: ConstraintRule;
}

const constraintListSchema: z.ZodType<ActionConstraint[]> = z.array(
  z.object({
    action: z.string().min(1),
    path: z.string().startsWith("/"),
    rule: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("max_number"), value: z.number() }),
      z.object({
        kind: z.literal("pattern"),
        value: z.string().refine(isValidRegExp, { message: "must be a valid regular expression" }),
      }),
      z.object({ kind: z.literal("one_of"), values: z.array(z.string()).min(1) }),
      z.object({ kind: z.literal("max_length"), value: z.number().int().positive() }),
    ]),
  }),
);

export interface ConstraintViolation {
  action: string;
  path: string;
  kind: ConstraintRule["kind"];
  message: string;
}

/**
 * Parses the LENS_CONSTRAINTS JSON value. Returns an empty list when unset.
 * Throws on malformed configuration so a misconfigured deployment fails at startup.
 */
export function parseConstraints(raw: string | undefined): ActionConstraint[] {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("LENS_CONSTRAINTS must be a JSON array of constraints.");
  }
  const result = constraintListSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`LENS_CONSTRAINTS is invalid: ${result.error.issues[0]?.message ?? "unknown error"}`);
  }
  return result.data;
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
    const message = checkRule(constraint.rule, resolvePointer(input, constraint.path));
    if (message) {
      return { action: constraint.action, path: constraint.path, kind: constraint.rule.kind, message };
    }
  }
  return undefined;
}

/** Same pattern semantics as the action policy lists: "*", "service.*", or an exact id. */
function matchesActionPattern(pattern: string, actionId: string): boolean {
  if (pattern === "*") {
    return true;
  }
  if (pattern.endsWith(".*")) {
    return actionId.startsWith(pattern.slice(0, -1));
  }
  return actionId === pattern;
}

/**
 * Checks one rule against one resolved value.
 * Missing values fail closed for every rule except max_length.
 */
function checkRule(rule: ConstraintRule, value: unknown): string | undefined {
  switch (rule.kind) {
    case "max_number": {
      if (typeof value !== "number" || Number.isNaN(value)) {
        return "value is missing or is not a number";
      }
      return value <= rule.value ? undefined : `value ${value} exceeds the maximum of ${rule.value}`;
    }
    case "pattern": {
      if (typeof value !== "string") {
        return "value is missing or is not a string";
      }
      // ponytail: the regex compiles per check; cache compiled rules if constraint lists grow large.
      return new RegExp(rule.value, "u").test(value) ? undefined : `value does not match the pattern ${rule.value}`;
    }
    case "one_of": {
      if (typeof value !== "string") {
        return "value is missing or is not a string";
      }
      return rule.values.includes(value) ? undefined : "value is not in the allowed list";
    }
    case "max_length": {
      if (value === undefined || value === null) {
        return undefined;
      }
      const length = typeof value === "string" || Array.isArray(value) ? value.length : undefined;
      if (length === undefined) {
        return "value has no length";
      }
      return length <= rule.value ? undefined : `length ${length} exceeds the maximum of ${rule.value}`;
    }
  }
}

/** Resolves an RFC 6901 JSON pointer against the action input. */
function resolvePointer(input: unknown, pointer: string): unknown {
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
