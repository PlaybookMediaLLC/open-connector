import type { ActionRunner, RunActionInput } from "../server/actions/action-runner.ts";
import type { ActionConstraint } from "./constraints.ts";

import { ActionPolicySnapshot, emptyPolicyRules } from "../core/action-policy.ts";
import { evaluateConstraints, parseConstraints } from "./constraints.ts";

/**
 * Builds the ActionRunner wrapper for the lens-seam in connect-app.ts.
 * Returns undefined when no constraints are configured, which keeps the
 * upstream runner completely untouched.
 * Throws at startup when the configuration is malformed.
 */
export function createLensActionRunnerWrapper(
  rawConstraints: string | undefined,
): ((actions: ActionRunner) => ActionRunner) | undefined {
  const constraints = parseConstraints(rawConstraints);
  if (constraints.length === 0) {
    return undefined;
  }
  return (actions) => withLensAuthorization(actions, constraints);
}

/**
 * Wraps the shared ActionRunner so every caller (HTTP, MCP, future triggers)
 * passes argument-level constraints before execution.
 *
 * A violation is surfaced through the run's policy snapshot, so the denial
 * uses the upstream deny path unchanged: the run is logged, and the wire
 * shape stays identical to an action-policy block.
 */
export function withLensAuthorization(actions: ActionRunner, constraints: ActionConstraint[]): ActionRunner {
  const wrapped = Object.create(actions) as ActionRunner;
  wrapped.run = (input: RunActionInput) => actions.run(withConstrainedPolicy(input, constraints));
  return wrapped;
}

function withConstrainedPolicy(input: RunActionInput, constraints: ActionConstraint[]): RunActionInput {
  const base = input.policy ?? new ActionPolicySnapshot(emptyPolicyRules(), emptyPolicyRules());
  const policy = Object.create(base) as ActionPolicySnapshot;
  policy.evaluate = (action) => {
    const decision = base.evaluate(action);
    if (!decision.allowed) {
      return decision;
    }
    const violation = evaluateConstraints(constraints, action.id, input.input);
    if (!violation) {
      return decision;
    }
    return {
      allowed: false,
      // ponytail: reuses the existing "action_blocked" wire code; introduce a
      // dedicated input_constraint_violation code when PolicyErrorCode can be
      // extended upstream.
      code: "action_blocked",
      message: `${action.id} input violates the lens constraint at ${violation.path}: ${violation.message}`,
      checks: [...decision.checks, { source: "deployment", outcome: "block_match", rule: `lens:${violation.path}` }],
    };
  };
  return { ...input, policy };
}
