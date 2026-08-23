# RFC 0004: Fork Isolation Strategy

- Status: Active
- Author: Lens
- Date: 2026-08-17
- Accepted: 2026-08-22
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
- Storage: Lens owns its schema and migration code under `src/lens/`. Tables use the
  `lens_` prefix and never alter upstream tables. Current legacy Node mode uses a
  Lens-owned `lens.sqlite`; RFC 0002 strict hosted Node mode uses PostgreSQL through
  `LENS_DATABASE_URL` and also requires the existing upstream PostgreSQL and S3
  transit backends through `OOMOL_CONNECT_DATABASE_URL` and
  `OOMOL_CONNECT_TRANSIT_FILE_BACKEND=s3`. Workers use the shared D1 and KV or R2
  bindings lazily. The first real Lens
  read or write bootstraps the current RFC 0001 schema because upstream app creation
  must not touch D1. RFC 0002 replaces that bootstrap with versioned migrations
  recorded in `lens_schema_migrations`. Node closes Lens storage during graceful
  shutdown. Do not add Lens files to the upstream migrations directory.
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
`grep -rn "lens-seam" src/ AGENTS.md`.

The `wrapActionRunner` hook is deliberately generic. It is a candidate to propose upstream;
if accepted, the `connect-app.ts` seam disappears.

RFC 0002 changes seams only in the existing entrypoint seam files. Planned registry:

| File                        | RFC 0002 change                                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/server/connect-app.ts` | keep `wrapActionRunner`; no new seam                                                                                          |
| `src/server/index.ts`       | pass shared runtime dependencies to `installLens`; remove inner Lens route registration; wrap the app; close Lens at shutdown |
| `src/server/cloudflare.ts`  | pass shared runtime dependencies to `installLensWorker`; remove inner Lens route registration; return the wrapped app         |

The outer seam is:

```ts
const servedApp = lens.wrapApp(app); // lens-seam
```

The wrapper is the strict hosted gateway that owns `/lens/*` before the upstream
authentication middleware and uses RFC 0002's exact method-aware allowlist for raw
upstream routes. Unknown routes and method mismatches fail closed. The current
`lens.registerRoutes(app)` seams are removed in the same PR, so route ownership has one
Lens entrypoint. Node also calls `lens.close()` on graceful shutdown. No new seam file
is required. Replace the current registry with this registry when implemented.

### 3. Integration style

- Wrap, do not modify. `src/lens/runtime.ts` wraps the shared `ActionRunner`, which both
  HTTP and MCP callers use. Lens denials return synthetic results with rfc/0001 error
  codes and structured `details`; `ExecutionResult.error.code` is a plain string upstream,
  so no upstream types change. Lens evidence rows are the authoritative denial audit.
- Reuse existing wire vocabulary where HTTP semantics depend on it. Usage-limit denials
  reuse the upstream `rate_limited` code so clients receive HTTP 429; the rfc/0001 code
  travels in `details.code`.
- Current RFC 0001 routes mount under `/lens/*` through the upstream
  `registerStaticRoutes` callback. RFC 0002 moves them into the outer Lens app so strict
  tenant routes bypass upstream admin middleware without changing that middleware.
- RFC 0002 tenant ownership remains a Lens overlay: tenant-local connection names map
  to opaque upstream connection names in `lens_` tables. Do not add `tenant_id` to
  upstream connections, tokens, OAuth state, run logs, or transit-file stores.
- Lens configuration enters through new `LENS_*` environment variables. Never
  repurpose `OOMOL_CONNECT_*` variables; strict mode only validates the existing
  upstream database and transit-backend settings required by RFC 0002.

## Merge workflow

1. The nightly `.github/workflows/sync-upstream.yml` fetches `upstream/main`, merges it
   into the long-lived fork `upstream` branch, and opens or updates a PR into `main`.
   It tests for upstream-only commits with `git diff --quiet
origin/main...upstream`; a two-dot comparison is forbidden because fork-only Lens
   commits would create a false upstream delta.
2. Do not add Lens feature work to that synchronization PR. For a manual sync, use the
   same branch and merge workflow.
3. `assets/star-history/*` conflicts keep the fork copy. Generated registry conflicts
   are resolved by regeneration. Runtime conflicts should be limited to the three seam
   files above; a conflict elsewhere requires an ownership review.
4. Run `npm run fix-check` and `npm test`. A dropped seam reference fails the typecheck;
   a behavioral regression fails the `src/lens` tests.
5. `grep -rn "lens-seam" src/ AGENTS.md` must match the registry. Inspect the diff for any
   unmarked change in an upstream-owned file.
6. PRs opened by the workflow's default `GITHUB_TOKEN` do not trigger CI. Push to or
   reopen the PR to start checks, or configure the documented PAT path. Do not merge a
   sync PR without observed checks.

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

- `LENS_DISABLED=1` (env): turns the Lens control plane off in legacy mode.
- `/lens/api/*`: approvals (list/approve/deny), policy simulation, effective policy,
  per-token lens policy, principal mapping, and decision evidence. Console-authenticated.
- `/lens/approvals`: a minimal self-contained approvals page.

Malformed configuration throws at startup. The runtime never starts with a policy it
cannot parse.

RFC 0002 keeps `LENS_DISABLED` only for legacy mode. Strict mode combined with
`LENS_DISABLED=1` fails startup so tenancy cannot be disabled accidentally.

## Roadmap under this strategy

| RFC phase                  | Placement                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 0001 phases 1-4 (rfc/0001) | implemented in `src/lens/` — constraints, evidence, meters, approvals; see the status note at the end of rfc/0001              |
| 0002 tenancy               | Lens-owned auth, scoped stores, opaque upstream-ID bindings, and strict outer app wrapper; no upstream schema or route changes |
| 0003 events                | `src/lens/events/`; poller reuses the tenant execution service, webhook routes mount in the outer Lens app                     |

## Completion state

RFC 0004 is the active fork policy. Code ownership, current seams, RFC 0002 planned
seams, automated upstream synchronization, conflict handling, checks, and the deferred
upstream-proposal decision are resolved. Synchronization compares the upstream side of
the merge base so fork-only commits do not create false delta PRs. A future RFC
implementation updates the current seam registry in the same PR that changes a seam.

## Resolved decision

Keep `wrapActionRunner` fork-side through RFC 0002. Propose it upstream only after the
strict execution path is stable and the generic hook has a demonstrated non-Lens use.
An upstream proposal is not a prerequisite for RFC 0002.
