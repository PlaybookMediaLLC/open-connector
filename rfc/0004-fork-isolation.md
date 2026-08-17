# RFC 0004: Fork Isolation Strategy

- Status: Draft
- Author: Lens
- Date: 2026-08-17
- Priority: process — governs the implementation of RFC 0001, 0002, and 0003

## Summary

This repository is a fork of `oomol-lab/open-connector`. Upstream lands provider and OAuth
changes weekly. We implement RFC 0001-0003 without blocking `git pull upstream main`.

The strategy has three rules:

1. All lens code lives in `src/lens/`. Upstream never touches that path, so it never conflicts.
2. Upstream files get only marked, minimal seam lines. Each seam carries a `lens-seam` comment.
3. The type checker guards the seams. If a merge drops one, `npm run typecheck` fails.

## Rules

### 1. Code placement

- New runtime code: `src/lens/*.ts`, with tests beside each module.
- New migrations: `migrations/9NNN_lens_*.sql`, starting at `9001`. Upstream numbers
  sequentially from `0001`; the `9NNN` range never collides. Lens tables use the `lens_`
  prefix and never alter upstream tables.
- New docs: `rfc/`.
- Do not edit upstream types, stores, or route handlers to add lens fields. Reference
  upstream rows by id from `lens_` tables instead.

### 2. Seams

A seam is a line in an upstream-owned file that mounts lens code. Keep seams rare, short,
and marked. Current registry:

| File                        | Seam                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `src/server/connect-app.ts` | `wrapActionRunner?` option; applied after `ActionRunner` construction                    |
| `src/server/index.ts`       | import + `wrapActionRunner: createLensActionRunnerWrapper(process.env.LENS_CONSTRAINTS)` |
| `src/server/cloudflare.ts`  | import + the same option from the Worker env                                             |

Every seam line ends with `// lens-seam` (or a `lens-seam:` doc comment). To audit:
`grep -rn "lens-seam" src/`.

The `wrapActionRunner` hook is deliberately generic. It is a candidate to propose upstream;
if accepted, the `connect-app.ts` seam disappears.

### 3. Integration style

- Wrap, do not modify. `src/lens/lens-action-runner.ts` wraps the shared `ActionRunner`,
  which both HTTP and MCP callers use. Denials flow through the existing policy-denial
  path, so run logging and wire shapes need no upstream changes.
- Reuse existing wire vocabulary. Constraint denials reuse the `action_blocked` error code
  with a lens-specific message, instead of widening the upstream `PolicyErrorCode` union.
- Configuration enters through new `LENS_*` environment variables. Never repurpose
  `OOMOL_CONNECT_*` variables.

## Merge workflow

1. `git fetch upstream && git merge upstream/main`.
2. Conflicts can appear only in the three seam files, and each is a one-line resolution.
3. Run `npm run fix-check` and `npm test`. A dropped `wrapActionRunner` reference fails the
   typecheck; a behavioral regression fails `src/lens` tests.
4. `grep -rn "lens-seam" src/` must list every registry entry above.

## Current lens surface

- `LENS_CONSTRAINTS` (env, JSON array): deployment-level argument constraints
  (RFC 0001 phase 1). Example:

```json
[
  { "action": "gmail.*", "path": "/to", "rule": { "kind": "pattern", "value": "@company\\.com$" } },
  { "action": "stripe.create_refund", "path": "/amount", "rule": { "kind": "max_number", "value": 100 } }
]
```

Malformed configuration throws at startup. The runtime never starts with a policy it
cannot parse.

## Roadmap under this strategy

| RFC phase                 | Placement                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 0001 phase 1: constraints | `src/lens/constraints.ts` + `lens-action-runner.ts` (done)                                                                         |
| 0001 phase 2: budgets     | `src/lens/` + `migrations/9001_lens_usage.sql`; same wrapper                                                                       |
| 0001 phase 3: approvals   | `src/lens/` + `migrations/9002_lens_approvals.sql`; approval routes mount as a Hono sub-app from the entry seams                   |
| 0002 tenancy              | tenant context resolved in the wrapper + `lens_` scoping tables; one new seam only if auth context is unreachable from the wrapper |
| 0003 events               | `src/lens/events/` + `migrations/9003_lens_events.sql`; poller reuses the wrapped runner, webhook routes mount as a sub-app        |

## Open Questions

- When lens routes (approvals, events) need auth, do we reuse the upstream console auth
  middleware by import, or carry a lens-owned copy to avoid coupling to an unexported API?
- Should we propose `wrapActionRunner` upstream now, to retire the largest seam early?
