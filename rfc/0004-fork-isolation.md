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
- Storage: lens self-bootstraps its own schema with idempotent DDL (`src/lens/db.ts`).
  Tables use the `lens_` prefix and never alter upstream tables. Node uses a lens-owned
  `lens.sqlite` beside the upstream database. Workers use the shared D1 binding lazily —
  the first real lens read or write bootstraps the schema, because upstream app creation
  must not touch D1. The `migrations/9NNN_lens_*.sql` namespace stays reserved in case
  migration files ever become necessary.
- New docs: `rfc/`.
- Do not edit upstream types, stores, or route handlers to add lens fields. Reference
  upstream rows by id from `lens_` tables instead.

### 2. Seams

A seam is a line in an upstream-owned file that mounts lens code. Keep seams rare, short,
and marked. Current registry:

| File                        | Seam                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/connect-app.ts` | `wrapActionRunner?` option; applied after `ActionRunner` construction                                                              |
| `src/server/index.ts`       | import + `installLens(...)` + `lens.registerRoutes(app)` in the static-routes callback + `wrapActionRunner: lens.wrapActionRunner` |
| `src/server/cloudflare.ts`  | import + `installLensWorker({ env, secretCodec })` + `wrapActionRunner` + `registerStaticRoutes: lens.registerRoutes`              |
| `AGENTS.md`                 | one trailing note that points agents to `CLAUDE.md` (marked `<!-- lens-seam -->`)                                                  |

Every seam line ends with `// lens-seam` (or a `lens-seam:` doc comment). To audit:
`grep -rn "lens-seam" src/`.

The `wrapActionRunner` hook is deliberately generic. It is a candidate to propose upstream;
if accepted, the `connect-app.ts` seam disappears.

### 3. Integration style

- Wrap, do not modify. `src/lens/runtime.ts` wraps the shared `ActionRunner`, which both
  HTTP and MCP callers use. Lens denials return synthetic results with rfc/0001 error
  codes and structured `details`; `ExecutionResult.error.code` is a plain string upstream,
  so no upstream types change. Lens evidence rows are the authoritative denial audit.
- Reuse existing wire vocabulary where HTTP semantics depend on it. Usage-limit denials
  reuse the upstream `rate_limited` code so clients receive HTTP 429; the rfc/0001 code
  travels in `details.code`.
- Lens routes mount under `/lens/*` through the upstream `registerStaticRoutes` callback —
  an existing upstream extension point, so no new option is needed for routing.
- Configuration enters through new `LENS_*` environment variables. Never repurpose
  `OOMOL_CONNECT_*` variables.

## Merge workflow

1. `git fetch upstream && git merge upstream/main`.
2. Conflicts can appear only in the three seam files, and each is a short resolution.
3. Run `npm run fix-check` and `npm test`. A dropped seam reference fails the typecheck;
   a behavioral regression fails the `src/lens` tests.
4. `grep -rn "lens-seam" src/` must list every registry entry above.

## Current lens surface

- `LENS_POLICY` (env, JSON object): the deployment policy layer — `constraints`,
  `meters`, `usageLimits`, and `approvalRequired` (rfc/0001). Example:

```json
{
  "constraints": [{ "action": "gmail.*", "path": "/to", "rule": { "kind": "pattern", "value": "@company\\.com$" } }],
  "meters": [{ "name": "refund_value", "action": "stripe.create_refund", "kind": "number", "path": "/amount" }],
  "usageLimits": [{ "meter": "refund_value", "limit": "10000", "windowSeconds": 86400 }],
  "approvalRequired": ["stripe.create_refund"]
}
```

- `LENS_DISABLED=1` (env): turns the lens control plane off entirely.
- `/lens/api/*`: approvals (list/approve/deny), policy simulation, effective policy,
  per-token lens policy, principal mapping, and decision evidence. Console-authenticated.
- `/lens/approvals`: a minimal self-contained approvals page.

Malformed configuration throws at startup. The runtime never starts with a policy it
cannot parse.

## Roadmap under this strategy

| RFC phase                  | Placement                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 0001 phases 1-4 (rfc/0001) | implemented in `src/lens/` — constraints, evidence, meters, approvals; see the status note at the end of rfc/0001                  |
| 0002 tenancy               | tenant context resolved in the wrapper + `lens_` scoping tables; one new seam only if auth context is unreachable from the wrapper |
| 0003 events                | `src/lens/events/`; poller reuses the wrapped runner, webhook routes mount through the same callback                               |

## Open Questions

- When lens routes (approvals, events) need auth, do we reuse the upstream console auth
  middleware by import, or carry a lens-owned copy to avoid coupling to an unexported API?
- Should we propose `wrapActionRunner` upstream now, to retire the largest seam early?
