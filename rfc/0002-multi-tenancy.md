# RFC 0002: Multi-Tenant Isolation and Connection Scoping

- **Status:** Accepted — implementation planned
- **Author:** Lens
- **Date:** 2026-08-17
- **Accepted:** 2026-08-22
- **Priority:** 2 of 3
- **Depends on:** RFC 0001 — Agent Authorization Control Plane

---

## Summary

Add **tenant isolation as a first-class security boundary** across the Lens runtime.

A single Lens deployment must be able to safely serve many independent customer workspaces while guaranteeing that:

> **A principal authenticated into tenant A cannot discover, authorize, execute against, approve, resume, or retrieve data belonging to tenant B.**

Tenancy applies to the complete authorization and execution lifecycle, not only connection rows.

Tenant scope propagates through:

1. principals and runtime tokens;
2. connections and credentials;
3. authorization requests and resources;
4. usage reservations and budgets;
5. approvals and execution grants;
6. run logs and authorization evidence;
7. OAuth flows;
8. asynchronous execution and retries;
9. tenant-sensitive caches;
10. operator access.

The design introduces a trusted `TenantContext` resolved once at authentication and carried through the request.

Runtime code does not manually append:

```sql
WHERE tenant_id = ?
```

at arbitrary call sites.

Instead, tenant-aware data access happens through a **tenant-scoped store capability** that makes ordinary cross-tenant queries structurally unavailable.

The architecture becomes:

```text
Verified Authentication
        │
        ↓
Tenant Resolution
        │
        ↓
TenantContext
        │
        ├── Principal
        ├── Runtime Token
        ├── Authorization
        ├── Connection Store
        ├── Approval Store
        ├── Usage Limits
        ├── Run Logs
        └── Evidence
        │
        ↓
Tenant-Scoped Execution
```

This RFC turns tenancy from a database convention into a runtime security invariant.

---

# Fork-isolation constraint

RFC 0004 governs this implementation.

Multi-tenancy is a Lens-owned overlay. It MUST NOT add tenant columns to upstream
tables, change upstream store or public API types, or spread tenant checks through
upstream route handlers. New code and schema live under `src/lens/` and use
`lens_`-prefixed tables.

The integration budget is:

1. keep the existing `wrapActionRunner` seam for action execution;
2. add one outer application wrapper seam in the Node and Cloudflare entrypoints;
3. move existing Lens route registration into that outer wrapper and remove the inner
   route-registration seams.

This keeps upstream merges limited to short, marked seam lines.

---

# Motivation

The runtime is currently effectively single-tenant.

Connections are deployment-global aliases.

A runtime token with access to an action may potentially reference any connection available to the runtime.

That is acceptable when one deployment belongs to one operator.

It is not acceptable when Lens powers a hosted product where:

```text
Customer A
    connects Gmail
    connects Stripe
    creates agents

Customer B
    connects Gmail
    connects GitHub
    creates agents
```

and both customers share:

```text
one API deployment
one database
one worker fleet
one MCP server
```

Without first-class tenant isolation, the system risks becoming a confused deputy:

> An agent authenticated for one customer can accidentally or intentionally cause Lens to act using another customer's authority.

The relevant security question is not:

> Which database row belongs to this tenant?

It is:

> **Which authority universe does this request belong to, and can anything in the execution path escape that universe?**

A secure hosted runtime needs the following invariant:

```text
principal tenant
    =
token tenant
    =
resource tenant
    =
connection tenant
    =
authorization tenant
    =
approval tenant
    =
execution tenant
    =
evidence tenant
```

Any mismatch fails before external side effects occur.

---

# Goals

RFC 0002 establishes:

- a canonical tenant identity;
- trusted tenant resolution;
- immutable tenant scope for a request;
- tenant-bound principals and runtime tokens;
- tenant-bound connections and credentials;
- tenant-bound authorization decisions;
- tenant-bound approvals and execution grants;
- tenant-bound usage reservations;
- tenant-bound run logs;
- safe OAuth state propagation;
- tenant-safe asynchronous execution;
- tenant-aware caching rules;
- a separate operator access path for cross-tenant administration;
- compatibility with existing single-tenant deployments.

The resulting runtime must support:

> thousands of customer workspaces on one Lens deployment without making tenant isolation dependent on every route author remembering to add the correct database predicate.

---

# Non-Goals

This RFC does **not** introduce:

- end-user signup;
- user management;
- invitations;
- organization membership;
- a hosted identity provider;
- billing;
- subscriptions;
- tenant-specific OAuth applications;
- cross-tenant data sharing;
- hierarchical tenants;
- parent/child organizations;
- tenant-to-tenant delegation;
- tenant data export or deletion workflows;
- tenant-specific encryption keys;
- regional data residency;
- tenant-specific databases.

A tenant is a **security boundary**, not a user-management system.

The product embedding Lens remains responsible for determining which tenant a user belongs to.

Lens only accepts tenant identity from trusted authentication mechanisms.

---

# Terminology

## Tenant

An isolated customer/workspace security boundary.

Example:

```text
acct_8f2k
```

A tenant may represent:

- one company;
- one workspace;
- one customer account;
- one product account.

It does not necessarily represent one human.

Multiple principals may operate inside one tenant.

---

## Tenant ID

An opaque externally assigned identifier.

Lens does not derive tenant IDs from:

- email addresses;
- company names;
- domains;
- connection aliases;
- request paths.

Example:

```text
acct_8f2k
```

Tenant IDs are case-sensitive and compared exactly.

No case folding or Unicode normalization is performed.

---

## Tenant context

The trusted runtime representation of tenant scope for one request.

```ts
interface TenantContext {
  tenantId: string;

  source: "runtime_token" | "tenant_user_jwt" | "legacy_default";
}
```

Once resolved, tenant context is immutable for the request.

---

## Data plane

Requests made by tenant-scoped agents or applications.

Data-plane requests may access exactly one tenant.

---

## Operator plane

Administrative access by Lens deployment operators.

Operator access may intentionally inspect multiple tenants.

It uses separate interfaces, separate authorization, and explicit audit evidence.

---

# Security invariants

The following are mandatory.

---

## 1. One data-plane request belongs to exactly one tenant

A request cannot:

- operate across multiple tenants;
- switch tenant halfway through execution;
- authorize under one tenant and execute under another.

---

## 2. Tenant identity comes only from verified authentication

Lens MUST NOT trust tenancy from:

```text
X-Tenant-ID
query parameters
request bodies
MCP tool arguments
connection aliases
```

Tenant identity originates only from trusted authentication state.

---

## 3. Authentication classes never combine

The requested route selects one permitted credential class. Lens never combines a
runtime token with tenant-user or operator JWT authority.

Persisted Lens bindings must also agree. For example:

```text
token tenant        acct_A
principal tenant    acct_B
```

Result:

```text
403 tenant_mismatch
```

No precedence rule silently chooses one, and no connection lookup occurs.

---

## 4. Resources cannot escape tenant scope

An action authorized for tenant A may only resolve resources belonging to tenant A.

A caller cannot escape scope by supplying:

- a connection ID;
- an approval ID;
- a run ID;
- an execution grant ID;
- a provider account ID;

belonging to another tenant.

---

## 5. Cross-tenant existence is not disclosed

If tenant A requests an object belonging to tenant B, the normal data plane returns:

```text
not_found
```

rather than:

```text
forbidden_because_it_belongs_to_tenant_B
```

Tenant boundaries must not become an enumeration oracle.

`tenant_mismatch` is reserved for contradictory trusted Lens bindings and is not used
to reveal foreign resources.

---

## 6. Tenant scope survives asynchronous execution

A request that becomes:

- pending approval;
- queued;
- retried;
- resumed;
- scheduled in the future;

retains its original tenant scope.

Workers never reconstruct tenancy from untrusted request input.

---

## 7. Default tenancy is compatibility mode, not a global tenant

The legacy tenant:

```text
""
```

exists only to preserve current single-tenant behavior.

It must never become a mechanism for resources intentionally shared across hosted tenants.

Shared/system resources require a future explicit abstraction.

---

## 8. Operator access is not data-plane impersonation

Operator access to multiple tenants must use a separate privileged interface.

The console must not gain cross-tenant access merely by appending:

```text
?tenantId=acct_B
```

to normal tenant APIs.

---

## 9. Every customer-derived persisted object carries tenant scope

If a persisted object can reveal customer data or authority, it must be tenant-bound.

---

## 10. Tenant-bound ciphertext cannot be silently moved between tenants

Lens-owned encrypted approval input MUST include and verify tenant, immutable
connection authority, and approval identity inside its encrypted envelope.
Authenticated encryption metadata adds defense in depth when the Lens codec supports
it.

---

# Authentication classes

Strict mode separates machine execution, tenant-human control, and cross-tenant
operation. These credential classes are not interchangeable.

Lens owns their verification under `src/lens/`. It may reuse the installed JWT
library and exported upstream token services, but it does not change the upstream
`RuntimeJwtVerifier`, upstream authentication middleware, or upstream token rows.

---

## 1. Bound runtime token

A stored upstream runtime token is the only credential accepted by:

```text
/lens/v1/actions/*
/lens/v1/proxy/*
/lens/mcp
```

Lens resolves the bearer through the existing `RuntimeTokenService`, obtains its
stable upstream token ID, and loads the token's tenant from:

```text
lens_token_tenants
```

Strict mode also requires a tenant-matching `lens_principals` row. An unbound,
revoked, or unmapped token is denied before connection lookup. This keeps every
strict action and upstream run attributable to one stored token.

Token creation is fail-closed. The Lens operator service creates the upstream token,
writes its tenant and principal bindings, and returns the plaintext token only after
both writes succeed. If a Lens write fails, it revokes the upstream token; even if
revocation also fails, the unbound orphan cannot enter the strict data plane.

---

## 2. Tenant-user JWT

A tenant-user JWT authenticates human control-plane requests such as connection
management, OAuth start, run inspection, and approval resolution. It is never accepted
as an action, proxy, or MCP execution credential.

Required claims:

```json
{
  "sub": "user_123",
  "tenant": "acct_8f2k",
  "scope": "lens.connections.read lens.connections.write",
  "exp": 1787439600
}
```

Lens trusts these claims only after signature, issuer, audience, and temporal claim
validation. `sub` and `tenant` are required non-empty strings. `exp` is a required
NumericDate. `scope` is an ASCII-space-delimited set checked per route.

---

## 3. Operator JWT

Operator routes require a JWT with the operator audience, a non-empty `sub`, a valid
`exp`, and `lens.operator` scope. An operator JWT does not contain or select a
data-plane tenant. The verified `sub` is the actor subject in control evidence. A
tenant-specific operator route takes its target tenant from the route parameter.

A tenant-user JWT is rejected on operator routes even when it carries a similarly
named scope. A deployment admin token used by the legacy upstream console is not an
operator credential in strict mode.

---

## Lens JWT configuration

Tenant-user and operator JWTs use Lens-owned configuration:

```text
LENS_JWKS_URI
LENS_JWT_ISSUER
LENS_TENANT_JWT_AUDIENCE
LENS_OPERATOR_JWT_AUDIENCE
```

The issuer and JWKS may be shared, but the configured audiences MUST differ. After
normal JWT verification, Lens requires `aud` to be one string equal to the selected
credential class's configured audience. An audience array, the other Lens audience,
or both audiences is rejected. One signed token therefore cannot satisfy both Lens JWT
classes. Both verifiers require `sub` and `exp`; the tenant verifier additionally
requires `tenant` and `scope`, and the operator verifier requires `scope` containing
`lens.operator`.

Lens does not repurpose upstream `OOMOL_CONNECT_*` authentication variables.

---

## One credential class per request

The Lens boundary selects one credential class from the route before authenticating.
It does not merge authority from cookies, headers, request bodies, or two credential
classes. The exact-audience check above is part of class selection. A credential valid
for another class returns `401 unauthorized`.

---

# Tenancy modes

Introduce:

```ts
type TenancyMode = "legacy" | "strict";
```

Configured by:

```text
LENS_TENANCY_MODE=legacy | strict
```

The default is `legacy` for compatibility. New hosted deployments set `strict`
explicitly. Any other non-empty value is a startup error.

---

## Legacy mode

Default during migration.

If no tenant is asserted:

```text
tenantId = ""
```

Existing deployments therefore behave as before.

---

## Strict mode

A tenant is mandatory.

Missing tenant identity returns:

```text
401 tenant_required
```

The empty default tenant cannot be used through the normal data plane.

Any deployment serving more than one tenant MUST run in strict mode.

---

# Tenant ID validation

Tenant IDs are opaque strings.

The runtime validates only structural safety:

- value must be a string;
- non-empty outside legacy mode;
- maximum length: 128 bytes;
- no NUL bytes;
- no leading/trailing whitespace.

Lens does not interpret tenant IDs semantically.

---

# Request context

Authentication resolves tenant exactly once.

Request context gains:

```ts
interface AuthenticatedTenantRequestContext {
  tenant: TenantContext;

  actor:
    | {
        kind: "runtime_token";
        principalId: string;
        tokenId: string;
      }
    | {
        kind: "tenant_user";
        principalId: string;
        scopes: ReadonlySet<string>;
      };

  tenantStore: LensTenantStore;
}
```

There are no mutable ambient tenant globals.

---

# Tenant-scoped stores

The original proposal required every store method to accept:

```ts
tenantId;
```

as its first argument.

That is better than ambient state but still allows bugs such as:

```ts
store.getConnection(wrongTenantId, id);
```

or accidentally calling a non-scoped method.

RFC 0002 instead introduces a capability-style store.

```ts
interface LensStore {
  forTenant(tenantId: string): LensTenantStore;
}
```

`LensTenantStore` exposes only tenant-scoped Lens operations and ownership
bindings:

```ts
interface LensTenantStore {
  connections: TenantConnectionBindingStore;
  tokens: TenantTokenBindingStore;
  oauth: TenantOAuthBindingStore;
  runs: TenantRunBindingStore;
  approvals: TenantApprovalStore;
  authorization: TenantAuthorizationStore;
  control: TenantControlEventStore;
  usage: TenantUsageStore;
  files: TenantTransitFileBindingStore;
}
```

Example:

```ts
const tenantStore = lensStore.forTenant(ctx.tenant.tenantId);

const connection = await tenantStore.connections.getByPublicName("gmail", "primary");
```

No caller supplies the tenant again.

The capability itself carries scope.

---

# Why scoped stores matter

This converts tenant isolation from:

> programmer discipline

into:

> API structure.

A route author can forget to call a tenant filter only if they deliberately escape the tenant-scoped interface.

Normal runtime code should not receive the unrestricted root store.

---

# Root-store access

The unrestricted store interface MUST NOT be available inside normal data-plane handlers.

Only infrastructure that creates:

```text
LensTenantStore
```

or explicit operator services may receive it.

---

# Operator store

Cross-tenant administration uses a separate interface:

```ts
interface LensOperatorStore {
  listTenants(...): Promise<...>;

  forTenant(
    tenantId: string,
    operatorContext: OperatorContext,
  ): LensTenantStore;
}
```

Operator access requires:

- operator authentication;
- explicit tenant selection;
- authorization under RFC 0001;
- audit evidence.

This prevents ordinary runtime code from casually becoming cross-tenant.

---

# Authorization integration

RFC 0001 introduces:

```ts
AuthorizationRequest;
```

RFC 0002 adds tenant context:

```ts
interface AuthorizationRequest {
  tenantId: string;

  principal: AuthorizationPrincipal;
  action: AuthorizationAction;
  resource: AuthorizationResource;
  input: unknown;
  context: AuthorizationContext;
}
```

The resolved tenant ID is supplied internally by authenticated request context.

It is not accepted from agent-controlled action input.

---

# Principal tenant binding

Every authenticated principal is evaluated inside exactly one tenant for a data-plane request.

Conceptually:

```text
Tenant
  └── Principal
        └── Token
```

The upstream token record remains unchanged. `lens_token_tenants` binds its stable
upstream token ID to one tenant. `lens_principals` and `lens_token_policies` use the
same tenant and token pair.

Legacy Lens records are backfilled to:

```text
""
```

---

# Resource tenant binding

RFC 0001 resources are extended:

```ts
interface AuthorizationResource {
  tenantId: string;

  providerId: string;
  connectionAuthority: { kind: "binding"; id: string } | { kind: "no_auth"; service: string };
  resourceId?: string;
  ownerId?: string;
  resourceType?: string;
}
```

Before policy evaluation:

```text
request.tenantId === resource.tenantId
```

must hold.

A resource tenant mismatch is treated as resource nonexistence for ordinary data-plane callers.

---

# Authorization invariant

Before an external action may execute:

```text
request tenant
      =
principal tenant
      =
token tenant
      =
connection tenant
      =
resource tenant
```

If any component cannot be resolved into the current tenant, execution stops.

---

# Data model

Tenant ownership is stored only in Lens tables. Upstream connections, connection
revisions, runtime tokens, run logs, and transit-file implementations remain
unchanged.

Lens adds versioned, idempotent migrations under `src/lens/`. The first migration
creates `lens_schema_migrations`; later migrations are applied in order and recorded
there. The same logical schema and migration tests run against SQLite, D1, and
PostgreSQL.

Each migration version is immutable. SQLite takes a write lock, PostgreSQL takes a
Lens-specific advisory lock, and D1 serializes migration writes through its database
API. A version is recorded only after schema verification succeeds. A concurrent
runner that observes an already-applied change re-verifies it instead of failing.

Strict routes do not serve until migration completes. A migration failure leaves the
previous version recorded, returns `503 lens_storage_unavailable`, and never falls back
to an unscoped store.

The RFC 0002 ownership tables are:

```text
lens_token_tenants
  tenant_id
  upstream_token_id
  created_at

lens_connection_bindings
  id
  tenant_id
  service
  public_name
  upstream_name
  upstream_connection_id  nullable until upstream creation succeeds
  state                  pending | active | deleted
  created_at
  updated_at
  deleted_at

lens_oauth_bindings
  state_hash
  tenant_id
  connection_binding_id
  initiated_by_subject
  created_at
  expires_at
  consumed_at

lens_transit_file_bindings
  id
  tenant_id
  upstream_file_id
  created_at
  expires_at

lens_run_bindings
  tenant_id
  upstream_run_id
  upstream_token_id
  decision_id
  created_at

lens_control_events
  id
  actor_kind             tenant_user | operator
  actor_subject
  target_scope           tenant | deployment
  tenant_id              nullable only for deployment scope
  operation
  resource_type
  resource_id
  outcome
  created_at
```

`lens_control_events` enforces exactly one target form: `target_scope = tenant`
requires a non-empty `tenant_id`, while `target_scope = deployment` requires
`tenant_id IS NULL`. Tenant-user evidence is always tenant-scoped. Operator evidence
uses tenant scope for tenant routes and deployment scope for global operator routes.
The empty tenant ID is never a global scope.

Existing Lens-owned customer records also gain `tenant_id` through those migrations:

- `lens_principals`;
- `lens_token_policies`;
- `lens_decisions`;
- `lens_approvals`;
- `lens_reservations`.

Approvals and decisions also store the immutable connection authority used by the
request: either a Lens connection-binding ID or the `no_auth:<service>` sentinel.
Decisions additionally store operation kind (`action` or `proxy`), execution ID,
outcome, and upstream audit-persistence status where applicable. No Lens row treats a
mutable public alias as durable authority.

Tenant-user and operator connection, OAuth, token, policy, and approval mutations
write `lens_control_events`. Global OAuth configuration and runtime-policy operations
write deployment-scoped events. Evidence is written for both successful and denied
attempts without storing credentials, JWTs, OAuth codes, or action input.

---

# Connection alias uniqueness

The upstream uniqueness rule remains unchanged:

```text
(service, alias)
```

Lens exposes tenant-local public names and maps each one to an opaque upstream name:

```text
(tenant_id, service, public_name) -> upstream_name
```

The internal name uses an unpredictable form such as:

```text
lc_<random-id>
```

The tenant never supplies or receives this internal name. Therefore both tenants may
safely have:

```text
service = gmail
public_name = primary
```

while upstream still sees two globally unique connection names.

---

# Composite tenant integrity

Tenant filtering alone is insufficient if a Lens child record can reference a Lens
parent record in another tenant.

The Lens schema MUST enforce tenant consistency in every supported database.

Credentialed bindings use:

```sql
UNIQUE (tenant_id, id),
UNIQUE (upstream_connection_id),
UNIQUE (upstream_name)
```

on `lens_connection_bindings`.

Public-name reuse after deletion is controlled by a partial unique index:

```sql
CREATE UNIQUE INDEX lens_connection_bindings_public_name
ON lens_connection_bindings (tenant_id, service, public_name)
WHERE state IN ('pending', 'active');
```

Credentialed child records then reference:

```text
(tenant_id, connection_binding_id)
```

rather than only:

```text
connection_binding_id
```

This prevents:

```text
tenant A approval
        ↓
tenant B connection binding
```

from existing even if application code is buggy.

Rows for credentialless providers store `no_auth:<service>` instead and have no
connection-binding foreign key. A schema check permits exactly one authority form.

The same principle applies to:

- principals and token policies → token-tenant bindings;
- approvals → authorization decisions;
- execution grants → approvals;
- runs → authorization decisions;
- usage reservations → principals/tokens where supported.

`lens_token_tenants.upstream_token_id` is unique. Principal, policy, decision,
approval, reservation, and run rows reference the same `(tenant_id,
upstream_token_id)` pair, so a token cannot acquire records in two tenants.

`lens_oauth_bindings.state_hash`, `lens_transit_file_bindings.upstream_file_id`, and
`lens_run_bindings.upstream_run_id` are each unique. One upstream OAuth state, file, or
run therefore cannot be bound into two tenant scopes.

`public_name` uses the existing upstream connection-name syntax and length limit even
though it is not sent upstream. This keeps REST, MCP, and CLI behavior stable.

---

# Indexes

Tenant-prefixed indexes are required for hot paths.

Examples:

```sql
CREATE INDEX lens_connection_bindings_lookup
ON lens_connection_bindings (tenant_id, service, public_name, state);

CREATE INDEX lens_run_bindings_created
ON lens_run_bindings (tenant_id, created_at);

CREATE INDEX lens_decisions_tenant_created
ON lens_decisions (tenant_id, created_at);

CREATE INDEX lens_approvals_tenant_state
ON lens_approvals (tenant_id, state, requested_at);
```

SQLite, D1, and PostgreSQL implementations must remain behaviorally equivalent.

---

# Credentials

Upstream still owns encrypted credentials. Lens owns the tenant-to-connection
binding that permits access to them.

Credential retrieval always happens through:

```text
LensTenantStore.connections
```

That store resolves an active binding and then calls the existing upstream store with
the binding's opaque internal name. Tenant-facing code MUST NOT call an upstream
credential lookup with a tenant-supplied name or ID.

Lens tenant routes MUST NOT expose a method equivalent to:

```ts
getCredential(connectionId);
```

without tenant context.

Credentialless `no_auth` providers do not create an upstream connection or Lens
binding. Lens exposes their catalog-derived virtual `default` connection inside every
tenant. Authorization resources use the tenant plus `no_auth:<service>` sentinel, and
approval digests persist that sentinel instead of a connection-binding ID.

---

# Encryption binding

This RFC does not modify upstream credential encryption. Tenant safety comes from the
Lens ownership binding and the strict outer gateway.

Every encrypted Lens approval stores an envelope containing:

```text
tenant_id
connection_authority
approval_id
input
```

After decryption, Lens MUST compare all three identifiers with the approval row before
reading `input`. A mismatch fails with `execution_grant_invalid`.

If the Lens codec supports authenticated additional data, it also uses:

```ts
encrypt(secret, {
  aad: `${tenantId}:${connectionAuthority}:${approvalId}`,
});
```

The verified envelope is mandatory. Cryptographic AAD is defense in depth and is not
the only protection against ciphertext reassignment.

---

# Connection lookup

All lookups occur inside the scoped store.

Example:

```ts
ctx.tenantStore.connections.getByPublicName("stripe", "billing");
```

This returns a Lens binding. Only the Lens execution service may extract its opaque
upstream name.

Even if a caller knows another tenant's Lens binding ID or upstream connection ID:

```text
binding_xyz / conn_xyz
```

the scoped lookup behaves as if it does not exist.

---

# OAuth flows

OAuth introduces a special risk:

```text
request starts in tenant A
       ↓
browser leaves Lens
       ↓
provider callback occurs later
```

The callback must retain the original authority boundary.

---

# OAuth state binding

`oauth-flow-service.ts` already creates a random, expiring, single-use state value and
stores it until callback completion. That upstream contract remains unchanged.

The Lens flow is:

1. create a `pending` `lens_connection_bindings` row with a tenant-local public
   name and an opaque upstream name;
2. call the existing upstream OAuth start service with the opaque upstream name;
3. hash the returned state with SHA-256;
4. store the state hash, tenant ID, initiating JWT subject, pending binding ID, and
   expiry in
   `lens_oauth_bindings`;
5. return the existing provider authorization URL to the caller.

The plaintext state remains in the upstream one-time state store. Lens does not copy
OAuth client secrets, PKCE verifiers, or credentials into its overlay.

---

# OAuth completion invariant

The callback MUST NOT choose tenancy from:

- current browser state;
- query parameters other than the verified one-time state;
- an arbitrary request header.

In strict mode, the outer Lens wrapper intercepts `/oauth/callback`. It hashes the
state, loads the matching pending Lens binding, and then delegates the same request to
the existing upstream callback. Only a successful upstream completion may move the
Lens binding from `pending` to `active`.

If Lens activation fails after upstream credential creation, the credential remains an
unreachable orphan under an opaque name. Cleanup may remove expired pending bindings
and their orphaned upstream connections. It must never expose them to another tenant.

---

# OAuth replay

OAuth state remains:

- high entropy;
- expiring;
- stored server-side;
- single-use.

A completed, unknown, or expired state cannot activate a connection. The Lens state
binding is consumed with an atomic `pending` to `active` transition.

---

# Shared OAuth clients

All tenants may use deployment-level OAuth application credentials.

This remains in scope:

```text
one Google OAuth app
many tenant connections
```

Tenant-specific OAuth client applications remain a non-goal.

---

# Authorization decisions

RFC 0001 Lens authorization evidence becomes tenant-bound.

Example:

```ts
interface AuthorizationEvidence {
  tenantId: string;

  decisionId: string;

  principalId: string;
  ...
}
```

A decision cannot later be resolved or executed under another tenant. The decision
stores its immutable connection-binding ID or no-auth sentinel in addition to the
display name used for operator evidence.

---

# Action approvals

`lens_approvals` gains:

```text
tenant_id
```

and are accessed only through:

```text
LensTenantStore.approvals
```

An approval ID from another tenant returns:

```text
not_found
```

---

# Execution grants

Lens execution grants gain:

```ts
tenantId: string;
```

The grant digest MUST include tenant identity and the immutable connection-binding ID
or no-auth sentinel. It hashes a canonical JSON tuple, not ambiguous string
concatenation and never a mutable public alias.

Conceptually:

```text
SHA-256(
  canonicalJson([
    tenantId,
    principalId,
    tokenId,
    actionId,
    connectionAuthority,
    resource,
    canonicalInput
  ])
)
```

A grant created under tenant A is unusable in tenant B. Changing the binding ID,
substituting a `no_auth:<service>` sentinel, or changing any other tuple member makes
the grant invalid.

Before consuming a credentialed grant, Lens reloads the stored connection binding by
tenant and binding ID and requires `state = active`. For a no-auth grant, it verifies
that the provider still declares `no_auth`. It never resolves the current value of a
mutable public name.

---

# Approval resolution

Operator or tenant-user approval must preserve the approval's stored tenant.

An approval endpoint never accepts a replacement tenant ID.

Conceptually:

```text
approval
   ↓
stored tenant A
   ↓
tenant A execution grant
   ↓
tenant A worker context
```

---

# Usage reservations and budgets

Usage reservations from RFC 0001 become tenant-bound in:

```text
lens_reservations.tenant_id
```

This prevents reservations or counters from colliding across tenants.

---

# Tenant-scoped safety limits

RFC 0002 extends future usage-limit scope to include:

```ts
type UsageLimitScope = "token" | "principal" | "connection" | "tenant" | "runtime";
```

This is **authorization safety**, not billing.

It enables rules such as:

```text
Tenant A:
maximum $100K payment authority/day
across every agent token.
```

Without tenant scope, a compromised system could evade a token-level limit by issuing multiple tokens.

Implementation of tenant-level usage limits MAY follow the core tenant isolation rollout if necessary, but the storage and policy model must support it.

---

# Run logs

The upstream `RunLog` type and table remain unchanged. Lens stores tenant ownership in:

```text
lens_run_bindings(tenant_id, upstream_run_id, upstream_token_id, decision_id, created_at)
```

Every run is therefore attributable to:

```text
tenant
principal
token
authorization decision
action
resource
```

Run logs are queried through `LensTenantStore.runs`. The store first finds allowed
upstream run IDs in Lens and then retrieves only those rows from the existing upstream
run-log service.

Lens writes the authorization decision before calling the provider. After the existing
`ActionRunner` returns, it links the execution ID and writes the run binding. If the
upstream run exists but the Lens binding write fails, the run stays hidden from tenant
queries. Lens may best-effort mark the decision `runBindingPersisted = false`, but
readiness MUST NOT attach an upstream run to a decision by token and time heuristics.
The current upstream run has no Lens decision correlation ID, so an operator must
investigate the orphan. Automatic repair requires a future explicit correlation seam
or RFC. If upstream audit persistence itself fails, the Lens decision records the
execution ID, outcome, and `auditPersisted = false` for operator investigation.

Provider proxy calls do not create upstream run logs. Lens writes tenant-scoped proxy
decision evidence with service, immutable connection authority, method, redacted
endpoint, outcome, and timestamp.

Normal APIs cannot request logs from another tenant.

---

# Authorization history

The authorization console can now answer:

> What actions did agents inside tenant A attempt?

without scanning or exposing tenant B.

Authorization history filters may include:

```text
principal
token
action
decision
connection
time
```

but tenant scope is supplied by the store capability rather than a data-plane query parameter.

---

# Asynchronous execution

Tenant isolation must survive beyond request lifetime.

This is critical for:

- approvals;
- delayed retries;
- queued executions;
- RFC 0003 triggers;
- future task systems.

Every durable execution object MUST persist:

```text
tenant_id
connection_authority = connection_binding_id | no_auth:<service>
```

Workers reconstruct trusted runtime scope from persisted execution metadata.

They MUST NOT accept a tenant supplied by an agent when resuming an existing run.

---

# Example

Agent requests under:

```text
tenant = acct_A
```

Action requires approval.

Stored:

```text
approval.tenant_id = acct_A
```

Three hours later:

```text
worker loads approval
```

Worker obtains:

```ts
lensStore.forTenant("acct_A");
```

and resumes execution inside that capability.

The originating HTTP request no longer exists, but tenant isolation remains intact.

---

# Retries

Retries inherit tenant scope from the original run.

A retry request cannot alter:

```text
tenantId
principalId
authorizationDecisionId
connectionAuthority
```

unless a new authorization request is created.

---

# MCP

No tenant argument is added to MCP tools.

That is deliberate.

This is invalid:

```json
{
  "tenant": "acct_B",
  "service": "gmail"
}
```

Tenant identity comes from authenticated runtime context.

---

# MCP behavior

Within tenant A:

```text
list_connections
```

returns tenant A connections allowed by the calling runtime token's upstream policy.
Credentialed connections return public names and Lens binding IDs. A credentialless
virtual `default` connection keeps the existing catalog-derived virtual ID and has no
Lens binding row. Upstream stored connection IDs and opaque names are never returned.

```text
execute_action
```

resolves aliases and IDs within tenant A only.

```text
list_my_pending_authorizations
```

returns tenant A approvals for the requesting principal only.

```text
run history
```

is limited to runs created by the calling runtime token.

The existing five MCP tools keep their wire shapes. RFC 0002 adds
`list_my_pending_authorizations` and `get_my_run`; both are self-only and additive.

---

# Strict execution assembly

`lens.wrapApp` creates an outer Hono application. It registers Lens tenant and
operator routes before mounting the upstream app as the final fallback. Therefore
strict Lens routes do not pass through upstream admin middleware.

Conceptually:

```ts
interface LensInstallation {
  wrapActionRunner?: (actions: ActionRunner) => ActionRunner;
  wrapApp(upstream: Hono): Hono;
  close(): Promise<void>;
}
```

The existing `wrapActionRunner` remains the RFC 0001 enforcement point for legacy raw
routes. Strict routes use a Lens execution service that accepts an immutable
`AuthenticatedTenantRequestContext` and assembles the existing exported upstream
services with tenant-scoped adapters:

```text
TenantConnectionStore adapter
        +
TenantTransitFileStore adapter
        ↓
existing ConnectionService
existing ActionRunner / ProxyRunner / createMcpServer
```

The adapter preserves the ID domain expected by those upstream services. The
upstream connection store and runtime-token records retain upstream connection IDs.
`TenantConnectionStore` presents the active Lens binding ID as `StoredConnection.id`
and the public name as its name, while mapping get, set, update, and delete operations
to the opaque upstream name and record internally. Existing `ConnectionService`, MCP,
`ActionRunner`, and `ProxyRunner` therefore see only Lens binding IDs on strict paths.

Before constructing the request `ActionPolicySnapshot`, the strict policy assembler
maps every upstream ID in the token record's `allowedConnections` back to an active
Lens binding in the same tenant. If a non-empty upstream allowlist contains any ID
that cannot be mapped, policy resolution fails closed before a runner or provider is
called. It MUST NOT become an empty list because the upstream policy model treats an
empty list as unrestricted. Operator policy writes map Lens IDs to upstream IDs and
reads map upstream IDs back to Lens IDs; neither direction exposes internal IDs.
Credentialless `no_auth` execution keeps its existing policy behavior and does not
invent a connection grant.

RFC 0001's current `LensRuntime.wrap` retains one inner runner. PR 7 refactors that
Lens-owned code so authorization receives the scoped runner as an explicit execution
argument. The legacy wrapper delegates with the global runner; strict requests and
approval resumes delegate with their reconstructed tenant runner. No mutable current
runner or ambient tenant is shared between requests.

The shared catalog, provider loader, runtime database, transit-file service, policy,
and codec are passed through the existing Node and Cloudflare Lens installation seam.
Provider executors remain lazy. Lens does not copy provider logic or upstream route
handlers.

The current inner `lens.registerRoutes(app)` seam is removed when `wrapApp` lands.
Node calls `lens.close()` during graceful shutdown. RFC 0004 owns the exact planned
seam registry.

In legacy mode, the outer app serves the existing RFC 0001 `/lens/*` routes with their
current console-admin behavior and passes raw upstream routes through. In strict mode,
the tenant-user and operator JWT rules in this RFC replace console-admin authority for
Lens state. `LENS_DISABLED=1` makes `wrapApp` an identity wrapper only in legacy mode.
Combining `LENS_DISABLED=1` with `LENS_TENANCY_MODE=strict` is a startup error.

---

# REST API

Tenant data-plane routes live only under the Lens namespace:

```text
/lens/v1/actions/*
/lens/v1/proxy/*
/lens/mcp
/lens/api/connections
/lens/api/oauth/authorizations
/lens/api/runs
/lens/api/approvals
/lens/api/decisions
/lens/api/files
```

These routes resolve one trusted `TenantContext`, use only the scoped Lens store, and
resolve public connection and file IDs to Lens binding IDs before delegation. The
scoped adapters translate to opaque upstream names and IDs only at their persistence
boundary.

Strict route authorization is fixed:

| Route                                 | Credential                       | Required scope                |
| ------------------------------------- | -------------------------------- | ----------------------------- |
| `/lens/v1/actions/*`                  | runtime token                    | upstream action policy        |
| `/lens/v1/proxy/*`                    | runtime token                    | upstream proxy policy         |
| `/lens/mcp`                           | runtime token                    | upstream action/proxy policy  |
| `GET /lens/api/connections*`          | tenant-user JWT                  | `lens.connections.read`       |
| write `/lens/api/connections*`        | tenant-user JWT                  | `lens.connections.write`      |
| `POST /lens/api/oauth/authorizations` | tenant-user JWT                  | `lens.connections.write`      |
| `GET /lens/api/runs*`                 | tenant-user JWT                  | `lens.audit.read`             |
| `GET /lens/api/decisions*`            | tenant-user JWT                  | `lens.audit.read`             |
| `GET /lens/api/approvals*`            | tenant-user JWT                  | `lens.approvals.read`         |
| resolve `/lens/api/approvals*`        | tenant-user JWT                  | `lens.approvals.resolve`      |
| `/lens/api/files*`                    | runtime token or tenant-user JWT | token binding or `lens.files` |

The file route accepts either listed class but authenticates exactly one. A runtime
token may access tenant files for action preparation. A tenant-user JWT requires the
`lens.files` scope.

The Node and Cloudflare entrypoints add one marked outer seam:

```ts
const servedApp = lens.wrapApp(app); // lens-seam
```

In `legacy` mode, the wrapper passes existing behavior through. In `strict` mode, raw
upstream access is a method-aware, fail-closed allowlist. The wrapper may dispatch
only these current routes upstream:

```text
GET /health
GET /v1/health
GET /v1/providers
GET /v1/actions
GET /v1/actions/search
GET /v1/actions/:actionId
GET /openapi.json
GET /docs
GET /api/providers
GET /api/providers/:service
GET /api/actions
GET /api/actions/search
GET /api/actions/:actionId
GET /api/actions/:actionId/agent.md
GET /api/auth/session
POST /api/auth/logout
```

The existing console shell and static assets may also pass only through the exact
method and path set owned by the existing static-route helpers. `/oauth/callback` is
handled by Lens only when it matches a pending Lens flow; it is never a raw upstream
fallback in strict mode. Every other upstream route is denied before dispatch,
including all `/mcp` routes, stateful `/v1` and `/api` routes, unknown future routes,
and method mismatches such as `POST /v1/actions/:actionId`. Matching uses the HTTP
method and canonical path. Encoded separators, duplicate slashes, case changes, and
trailing-slash variants are denied unless the exact allowlist helper explicitly owns
that canonical form.

The strict gateway is the security boundary. Raw upstream stateful endpoints are not
an alternate operator plane. Tenant and operator state goes through Lens routes.
Tenant selection is never accepted as a normal query parameter, header, body field,
or action input.

---

# Idempotency isolation

Lens reuses the upstream idempotency store but namespaces every strict action key
before calling it:

```text
SHA-256(
  canonicalJson([
    "lens:v1",
    tenant_id,
    upstream_token_id,
    connection_binding_id_or_no_auth_sentinel,
    caller_idempotency_key
  ])
)
```

The request hash also includes tenant ID, token ID, immutable connection authority,
action ID, and canonical input. The caller's plaintext key is never persisted. The
same key may be used independently by two tenants, while reuse with different input or
authority inside one tenant returns the existing upstream conflict response.

---

# Provider proxy boundary

Strict proxy requests require a bound runtime token, the token's upstream proxy
permission, and a verified tenant connection authority. Credentialed providers require
an active binding; credentialless providers require the catalog-derived
`no_auth:<service>` sentinel. Lens records tenant-scoped proxy decision evidence before
and after dispatch.

RFC 0001 meters and human approvals do not yet apply to arbitrary proxy requests, as
recorded in RFC 0001's implementation status. A deployment that needs those controls
MUST block the affected proxy service until a separate proxy-authorization design
lands. This limitation does not weaken tenant isolation.

---

# Transit files

Every strict-mode upload creates a `lens_transit_file_bindings` row. The tenant sees
the Lens binding ID as `fileId`; the upstream storage ID is private to the Lens file
service.

Reads, deletes, and action input resolution require a binding owned by the current
tenant. A file ID from another tenant returns `not_found`. Expiry and cleanup remove
the binding and its upstream object together where possible; an orphaned object is not
reachable without a live Lens binding.

The tenant-scoped transit adapter wraps the existing upstream service. `read` and
`delete` translate a Lens file ID only after tenant ownership checks. `create` writes
the upstream object, writes its Lens binding, and returns a Lens file ID plus a
`/lens/api/files/:id` download URL. Provider-generated files use the same adapter, so
action output never exposes an upstream file ID or raw `/api/files` URL.

If binding creation fails, Lens deletes the new upstream object and fails the request.
If cleanup also fails, the object is an unreachable orphan and the readiness cleanup
job retries deletion.

---

# Operator API

Cross-tenant administration is explicitly separated.

Namespace:

```text
/lens/operator/...
```

Required operator surface:

```text
GET /lens/operator/tenants
GET /lens/operator/tenants/:tenantId/readiness
GET /lens/operator/tenants/:tenantId/connections
GET /lens/operator/tenants/:tenantId/runs
GET /lens/operator/tenants/:tenantId/approvals
GET /lens/operator/tenants/:tenantId/decisions
GET /lens/operator/tenants/:tenantId/runtime-tokens
POST /lens/operator/tenants/:tenantId/runtime-tokens
PUT /lens/operator/tenants/:tenantId/runtime-tokens/:tokenId
DELETE /lens/operator/tenants/:tenantId/runtime-tokens/:tokenId
GET /lens/operator/oauth/configs
PUT /lens/operator/oauth/configs/:service
DELETE /lens/operator/oauth/configs/:service
GET /lens/operator/runtime-policy
PUT /lens/operator/runtime-policy
```

These endpoints:

- require operator-audience JWT authentication and the `lens.operator` scope;
- produce authorization evidence;
- explicitly identify either a route tenant or the fixed deployment scope.

`GET /lens/operator/tenants` derives tenant IDs from Lens-owned tables until a tenant
registry exists. It and the global OAuth-config and runtime-policy routes use
deployment scope. Routes under `/lens/operator/tenants/:tenantId` use tenant scope.
Operator token creation and policy updates accept Lens
connection-binding IDs, convert them to upstream connection IDs for the upstream token
policy, convert them back for reads, and never expose those internal IDs in a
response. A non-empty upstream connection allowlist that cannot be mapped completely
to active bindings in the target tenant fails closed.

---

# Console

The console remains primarily an operator tool.

Add a tenant selector/filter.

Selecting another tenant must cause the console to use:

```text
operator-plane APIs
```

rather than impersonating a data-plane tenant.

The UI should display the active tenant prominently when viewing:

- connections;
- runs;
- approvals;
- authorization decisions.

This reduces accidental operator actions against the wrong customer.

---

# Operator evidence

Operator reads and writes MUST write `lens_control_events` evidence containing:

```text
operator principal
target scope
target tenant when target scope is tenant
action
resource
timestamp
```

The operator principal is the verified JWT `sub`. Tenant routes write tenant scope.
Tenant enumeration and global OAuth-config and runtime-policy routes write deployment
scope with `tenant_id = NULL`. No event uses the empty tenant ID as global scope.

A future enterprise customer should be able to answer:

> Which Lens operator accessed our tenant and why?

RFC 0002 establishes the necessary boundary even if full customer-facing operator-audit export comes later.

---

# Cache isolation

Database scoping is not enough.

Caches are a common source of cross-tenant leaks.

Any cached value containing tenant-specific information MUST include:

```text
tenantId
```

in its key.

Bad:

```text
connection:gmail:primary
```

Good:

```text
tenant:acct_A:connection:gmail:primary
```

This applies to:

- connections;
- credentials;
- authorization decisions;
- policy snapshots where tenant-specific;
- approval lookups;
- run metadata;
- connection-resolution caches;
- negative lookup caches.

---

# Shared caches

Tenant-independent immutable/catalog data may remain shared.

Examples:

- provider catalog;
- action schemas;
- action manifests;
- static documentation.

The rule is:

> If the data contains customer authority or customer-derived state, partition it.

---

# Observability

Internal structured logs and traces SHOULD include:

```text
tenant_id
principal_id
run_id
authorization_decision_id
```

where useful for incident response.

Tenant IDs MUST NOT be forwarded to providers merely because they exist internally.

---

# Metrics cardinality

Tenant IDs SHOULD NOT become high-cardinality metric labels by default.

Prefer:

- aggregated platform metrics;
- logs/traces for tenant-level debugging;
- intentionally designed tenant usage tables.

This prevents observability infrastructure from becoming expensive or unstable as tenant count grows.

---

# Error semantics

Add:

```ts
type TenantErrorCode = "tenant_required" | "tenant_invalid" | "tenant_mismatch" | "unauthorized" | "insufficient_scope";
```

Examples:

### Missing tenant in strict mode

```text
401 tenant_required
```

### Invalid trusted tenant claim

```text
401 tenant_invalid
```

### Credential class is invalid for the route

```text
401 unauthorized
```

### Required tenant-user scope is missing

```text
403 insufficient_scope
```

### Trusted Lens bindings disagree

```text
403 tenant_mismatch
```

### Resource belongs to another tenant

Return ordinary resource-not-found semantics.

Do not reveal the other tenant.

---

# Data migration

Only existing Lens-owned rows are backfilled with:

```text
tenant_id = ''
```

Upstream rows are not rewritten. Existing connections and runtime tokens keep their
current behavior in legacy mode. Moving them into strict mode requires explicit Lens
bindings.

---

# Strict-mode migration

Moving an existing deployment from:

```text
legacy
```

to:

```text
strict
```

is an explicit operator action.

Lens MUST NOT guess which hosted tenant should inherit old default-tenant resources.

Before enabling strict mode, operators MUST:

- configure Lens JWKS, issuer, and distinct tenant/operator audiences;
- configure an encrypted injected secret codec for credentials, OAuth state, and Lens
  approval envelopes;
- create Lens bindings for connections that should belong to the first tenant;
- bind runtime tokens and principals to explicit tenants;
- verify no production workflow depends on the default tenant.

Strict hosted Node deployments MUST use all three existing shared storage boundaries:

```text
Lens state:             LENS_DATABASE_URL (PostgreSQL)
upstream runtime state: OOMOL_CONNECT_DATABASE_URL (PostgreSQL)
transit files:          OOMOL_CONNECT_TRANSIT_FILE_BACKEND=s3
```

Startup and readiness refuse local `lens.sqlite`, the upstream SQLite runtime store,
or local transit files in strict hosted Node mode. Workers use shared D1 plus the
configured KV or R2 transit binding. This avoids split tenant authority, token policy,
run, idempotency, and file state across replicas.

Strict startup also refuses an unencrypted secret codec. Legacy mode keeps the current
warning-only behavior for local development.

Strict readiness fails when active production resources remain unbound or when legacy
Lens rows are still required. It never silently reassigns them.

---

# No shared default tenant

Once strict multi-tenancy is enabled:

```text
tenant_id = ''
```

does not mean:

> visible to everyone.

It means:

> legacy data inaccessible through ordinary strict-mode tenant requests.

If Lens later requires deployment-global resources, introduce an explicit system-resource model rather than overloading the empty tenant.

---

# Storage interfaces

Conceptual structure:

```ts
interface LensStore {
  forTenant(tenantId: string): LensTenantStore;

  operator(): LensOperatorStore;
}
```

Implementations:

```text
src/lens/db-sqlite.ts
src/lens/db.ts                    D1 adapter
src/lens/db-postgres.ts
```

must provide equivalent tenant behavior and migration semantics. SQLite remains for
legacy local development. Strict hosted Node uses PostgreSQL through
`LENS_DATABASE_URL`, while its existing upstream runtime database and transit service
must also be shared as specified above. Strict Workers use D1 and KV or R2.

---

# Example tenant connection store

```ts
interface TenantConnectionBindingStore {
  create(input: ConnectionBindingCreateInput): Promise<ConnectionBinding>;

  getById(id: string): Promise<ConnectionBinding | null>;

  getByPublicName(service: string, name: string): Promise<ConnectionBinding | null>;

  list(input?: ConnectionBindingListInput): Promise<ConnectionBinding[]>;

  rename(id: string, publicName: string): Promise<ConnectionBinding | null>;

  markDeleted(id: string): Promise<boolean>;
}
```

Notice:

```text
tenantId
```

does not appear on individual methods.

It is already fixed by the store capability.

---

# Threat model

RFC 0002 explicitly defends against the following classes of failure.

---

## Threat: forged tenant header

Attacker sends:

```text
X-Tenant-ID: victim
```

Mitigation:

Headers are ignored.

---

## Threat: credential-class confusion

Tenant-user JWT calls:

```text
/lens/v1/actions/...
```

or a runtime token calls:

```text
/lens/api/approvals/.../approve
```

Mitigation:

The route chooses its credential class before authentication and fails with
`unauthorized`. Contradictory stored token/principal tenant bindings fail separately
with `tenant_mismatch`.

---

## Threat: connection-ID enumeration

Tenant A learns:

```text
binding_victim or conn_victim
```

and sends it directly.

Mitigation:

Tenant-scoped lookup returns not found.

---

## Threat: alias collision

Both tenants define:

```text
gmail / primary
```

Mitigation:

Lens public-name uniqueness includes `tenant_id`; upstream receives separate opaque
names.

---

## Threat: forgotten query filter

Developer adds a new route but forgets tenant filtering.

Mitigation:

Handler receives tenant-scoped store rather than unrestricted data store.

---

## Threat: raw upstream route bypass

Attacker calls `/v1`, `/mcp`, or a stateful `/api` route instead of the Lens tenant
route.

Mitigation:

The strict outer application wrapper dispatches only the exact method-aware safe
allowlist and denies every other request before upstream dispatch.

---

## Threat: approval ID reuse

Tenant A attempts to resolve tenant B approval.

Mitigation:

Approval lookup is tenant-scoped and returns not found.

---

## Threat: async tenant loss

Approved action resumes later in generic worker.

Mitigation:

Tenant ID and immutable connection authority are persisted on the approval/execution
object and used to construct the scoped store.

---

## Threat: OAuth tenant swap

Flow begins in tenant A but callback is completed while browser is authenticated as tenant B.

Mitigation:

Lens stores a server-side tenant and pending-connection binding keyed by the hash of
the upstream one-time state.

---

## Threat: cache collision

Connection alias cached without tenant dimension.

Mitigation:

Every tenant-derived cache key includes tenant ID.

---

## Threat: split authority or runtime state across replicas

Two strict Node replicas use different local Lens or upstream SQLite files, or local
transit-file directories.

Mitigation:

Strict hosted Node startup requires PostgreSQL for both Lens and upstream runtime
state and S3 for transit files. Workers use shared D1 and KV or R2.

---

## Threat: Lens ciphertext reassignment

Bug attaches tenant A approval ciphertext to tenant B approval.

Mitigation:

The decrypted envelope's tenant, connection authority, and approval ID must match the
row before input is read. AAD enforces the same binding when supported.

---

## Threat: operator accidental cross-tenant action

Operator has multiple customer tabs open.

Mitigation:

Separate operator plane, prominent tenant context, authorization evidence.

---

# Interaction with RFC 0001

RFC 0001 answers:

> Does this principal have authority to perform this action?

RFC 0002 first constrains the universe in which that question may be asked.

Conceptually:

```text
Tenant boundary
      ↓
Principal
      ↓
Action
      ↓
Resource
      ↓
Policy
      ↓
Obligations
      ↓
Execution
```

Tenant isolation is evaluated before normal action policy.

A token cannot receive a policy that grants authority outside its tenant because outside-tenant resources are not visible to the authorization engine in the first place.

This is intentionally defense in depth:

```text
tenant isolation
+
authorization policy
```

rather than using policy rules alone to simulate tenancy.

---

# Interaction with delegation

RFC 0001 preserves delegation metadata.

RFC 0002 adds the invariant:

> Delegation cannot cross tenant boundaries.

For any future child-agent delegation:

```text
tenant(child) = tenant(parent)
```

unless a future explicit cross-tenant delegation mechanism is designed.

There is no implicit cross-tenant delegation.

---

# Interaction with RFC 0003

Future triggers and events must capture tenant identity when created.

A trigger created under:

```text
tenant A
```

must execute future runs under:

```text
tenant A
```

regardless of which worker receives the event.

RFC 0002 therefore provides the tenant persistence model required by RFC 0003.

---

# Tenant-level abuse containment

Although billing remains out of scope, hosted deployments need protection from one customer exhausting shared infrastructure.

RFC 0002 MUST make tenant identity available to future controls for:

- concurrent run limits;
- connection count limits;
- API throughput;
- action-meter limits;
- queue fairness.

These are operational safety controls, not billing semantics.

Exact quotas may be implemented separately.

---

# Rollout

Implement as a sequence of small PRs. Each PR has one owner, one security boundary,
and a narrow file set. Do not combine an upstream synchronization with feature work.

---

## Preparation — RFC and upstream baseline

Use two non-feature PRs:

1. PR 0A lands only the RFC 0002 and RFC 0004 updates;
2. PR 0B uses `.github/workflows/sync-upstream.yml` to merge `upstream/main` through
   the long-lived fork `upstream` branch without feature work;
3. record the resulting seam audit and commit as the implementation baseline;
4. branch PR 1 from that synchronized fork `main`.

Acceptance:

- fork `main` contains the chosen upstream baseline;
- the sync workflow detects upstream-only commits with
  `git diff --quiet origin/main...upstream`, not a two-dot tree comparison that sees
  fork-only commits as upstream changes;
- `grep -rn "lens-seam" src/ AGENTS.md` matches RFC 0004;
- `npm run fix-check` and `npm test` pass.

---

## PR 1 — Lens migrations and shared storage

Scope is only `src/lens/` and its tests:

- add the versioned Lens migration runner and `lens_schema_migrations`;
- add tenant columns to existing `lens_` tables;
- add token, connection, OAuth, run, transit-file, and control-evidence tables;
- add SQLite, D1, and PostgreSQL migration serialization;
- keep SQLite and D1 behavior equivalent;
- add the PostgreSQL Lens adapter selected by `LENS_DATABASE_URL`;
- define the strict hosted Node storage prerequisite that refuses local Lens storage,
  upstream SQLite, or local transit files.

Acceptance:

- fresh install and upgrade-from-current-schema pass on SQLite, D1, and PostgreSQL;
- migrations are idempotent and fail closed;
- a concurrent migration race produces one verified schema version;
- concurrent inserts cannot create duplicate public aliases or duplicate upstream
  bindings;
- strict hosted Node storage validation requires `LENS_DATABASE_URL`,
  `OOMOL_CONNECT_DATABASE_URL`, and `OOMOL_CONNECT_TRANSIT_FILE_BACKEND=s3`;
- no upstream table or migration file changes.

---

## PR 2 — Tenant context and scoped Lens stores

Scope is only `src/lens/` and its tests:

- add immutable `TenantContext` and `LensStore.forTenant`;
- add scoped stores for token, principal, policy, connection, decision, approval,
  reservation, run, OAuth, and transit-file bindings;
- keep cross-tenant enumeration only on `LensOperatorStore`;
- make scoped lookups return `not_found` for foreign IDs.

Acceptance:

- the same public alias works in two tenants;
- every foreign ID test returns `not_found`;
- no tenant-scoped method accepts a replacement tenant ID;
- ordinary Lens runtime code has no unscoped customer-data store.

---

## PR 3 — Lens authentication and token binding

Scope is Lens-owned authentication code and Lens routes:

- verify tenant-user and operator JWTs with distinct audiences;
- enforce the fixed route scope vocabulary;
- resolve stored runtime-token bindings from `lens_token_tenants`;
- require tenant-matching principal mappings for strict runtime tokens;
- reject credential-class confusion before dispatch;
- implement `legacy` and `strict` modes;
- add fail-closed token creation and orphan handling.

Acceptance:

- headers, query strings, request bodies, MCP arguments, and action input cannot select
  a tenant;
- missing or empty `sub`, missing or expired `exp`, an audience array, the wrong
  audience, and a token containing both Lens audiences are rejected;
- control evidence uses the verified JWT `sub` as its actor subject;
- an unbound token fails in strict mode;
- tenant-user JWTs cannot execute and runtime tokens cannot resolve approvals;
- contradictory token, principal, or policy bindings fail before connection lookup;
- upstream `RuntimeJwtVerifier` and auth middleware remain unchanged.

---

## PR 4 — Strict application gateway

Scope:

- add `lens.wrapApp(app)` under `src/lens/`;
- move `/lens/*` registration into the outer app before upstream middleware;
- remove the inner `lens.registerRoutes(app)` entrypoint seams;
- pass the shared catalog, provider loader, database, transit service, policy, and codec
  through the existing installation seams;
- add the marked wrapper seam to Node and Cloudflare and graceful Lens close to Node;
- implement the exact method-aware raw-route allowlist in strict mode and deny every
  other current or future upstream route;
- pass existing behavior through in legacy mode;
- intercept the existing OAuth callback only for a pending Lens flow.

Acceptance:

- each documented safe `GET` route is allowed, while a state-changing method on the
  same path is denied;
- every known raw bypass, unknown future route, encoded-separator, duplicate-slash,
  case, and unowned trailing-slash variant is denied before upstream dispatch;
- Lens tenant and operator namespaces remain reachable with correct authentication;
- upstream admin middleware is never invoked for a strict Lens route;
- legacy regression tests remain unchanged;
- the seam registry and seam grep are updated in the same PR.

---

## PR 5 — Tenant connection lifecycle

Scope is Lens routes and services:

- create, list, read, rename, and delete tenant connection bindings;
- generate opaque upstream names with the existing cryptographic random utility;
- translate public names only inside the scoped Lens service;
- expose credentialless providers as tenant-local catalog-derived virtual connections;
- make deletion update the binding and upstream connection without exposing partial
  state.

Acceptance:

- two tenants can create `gmail/primary` concurrently;
- neither tenant can discover the other's binding, upstream name, ID, or credential;
- an upstream write followed by a Lens write failure produces an unreachable orphan;
- deleted public names may be reused without reactivating the tombstone;
- no upstream connection service or schema changes.

---

## PR 6 — Tenant OAuth lifecycle

Scope is the Lens OAuth service and strict callback handling:

- create the pending connection binding before authorization;
- store only the SHA-256 hash of upstream one-time state in Lens;
- bind callback completion to the pending tenant and binding;
- atomically activate once and expire or clean failed pending flows.

Acceptance:

- changing browser tenant or credentials before callback cannot move the connection;
- swapped, replayed, expired, and unknown states cannot activate a binding;
- an upstream completion followed by Lens failure stays unreachable;
- existing upstream OAuth tests and wire shape remain unchanged.

---

## PR 7 — Actions, MCP, and provider proxy

Scope reuses exported upstream execution services behind the strict Lens gateway:

- expose tenant action execution under `/lens/v1/actions/*`;
- expose tenant MCP under `/lens/mcp`;
- expose tenant provider proxy under `/lens/v1/proxy/*`;
- assemble existing `ConnectionService`, `ActionRunner`, `ProxyRunner`, and MCP with
  tenant-scoped connection and transit adapters;
- refactor Lens authorization to accept the scoped runner explicitly instead of
  retaining a mutable inner runner;
- namespace idempotency keys by tenant, token, and immutable connection authority;
- present Lens binding IDs through `TenantConnectionStore` while mapping upstream
  connection names and IDs internally;
- translate upstream token connection grants back to active same-tenant Lens binding
  IDs before policy construction;
- resolve or verify the connection authority before provider loading;
- persist tenant decision and run bindings around execution.

Acceptance:

- REST, MCP, and proxy paths enforce the same tenant and connection authority;
- foreign aliases and IDs cause no provider call;
- the same idempotency key is independent across tenants and conflicting within one;
- runtime-token MCP reads expose only that token's connections, approvals, and runs;
- operator policy writes map Lens IDs to upstream IDs and reads map them back without
  exposing internals;
- any unmapped member of a non-empty upstream connection allowlist fails policy
  resolution closed and never becomes an unrestricted empty list;
- concurrent tenants cannot swap runner, connection, transit, or authorization context;
- retries reuse stored tenant and binding authority;
- no new action-runner seam is added.

---

## PR 8 — Approvals, runs, evidence, and transit files

Scope is Lens-owned lifecycle services and routes:

- persist tenant and immutable connection authority on decisions, approvals,
  reservations, and run bindings;
- encrypt and verify the tenant-bound approval envelope;
- revalidate the active binding before approval execution and async resume;
- tenant-scope run and evidence reads through Lens-to-upstream run mappings;
- tenant-scope upload, read, delete, expiry, and action file resolution through transit
  bindings.

Acceptance:

- foreign approval, run, evidence, grant, reservation, and file IDs return `not_found`;
- delayed approval and retry execution cannot change tenant or connection authority;
- foreign files never reach an action executor;
- provider-generated files return only Lens IDs and Lens download URLs;
- a simulated run-binding write failure leaves the upstream run hidden and readiness
  never attaches it to a decision by token or time heuristics;
- cache keys include tenant ID for all customer-derived state.

---

## PR 9 — Operator plane and readiness tooling

Scope:

- add the required `/lens/operator/*` inspection, token, OAuth-config, and runtime-policy
  routes;
- require operator-audience JWT authentication and `lens.operator` scope;
- write tenant- or deployment-scoped operator evidence as required by the route;
- add strict-mode readiness checks for unbound tokens, connections, pending OAuth
  flows, local Lens or upstream runtime storage, local transit files, and legacy Lens
  rows;
- add the console tenant selector only after the operator API is complete.

Acceptance:

- tenant credentials cannot call operator routes;
- token creation writes upstream token, tenant binding, and principal mapping before
  returning the secret;
- every operator route has an explicit tenant or fixed deployment scope and is
  audited with the verified JWT `sub`;
- strict hosted Node readiness requires shared Lens PostgreSQL, upstream PostgreSQL,
  and S3 transit storage;
- readiness fails closed when strict-mode prerequisites are missing;
- the data plane cannot impersonate a selected tenant.

---

## Per-PR merge discipline

Before merging each code PR:

1. fetch `upstream/main` and compare it with fork `main`;
2. if upstream advanced, dispatch or wait for the sync workflow and land its sync-only
   PR on fork `main` first;
3. merge the refreshed fork `main` into the feature branch and resolve only marked
   seams if conflicts occur;
4. inspect `git diff --stat upstream/main...HEAD` for unexpected upstream-owned files;
5. run `npm run fix-check` and `npm test`;
6. run the targeted SQLite, D1, and PostgreSQL tenancy tests added by that PR;
7. run `grep -rn "lens-seam" src/ AGENTS.md` and compare it with RFC 0004.

If an implementation needs another upstream-file edit, stop and update RFC 0004 with
the reason and seam budget before writing the code.

---

## Deployment sequence

1. deploy the migrations while still in legacy mode and take a database backup;
2. configure shared Lens PostgreSQL, upstream PostgreSQL, S3 transit storage, and the
   tenant and operator JWT audiences;
3. bind one existing tenant's tokens, principals, connections, and Lens records;
4. require a clean operator readiness report for that tenant;
5. enable strict mode in staging and run the complete isolation and raw-bypass suite;
6. enable strict mode for one production tenant and monitor denials, orphan cleanup,
   callback failures, and database consistency;
7. admit a second production tenant only after the first tenant is clean;
8. after a second tenant is admitted, never roll back to legacy mode on that shared
   deployment. Roll back by stopping tenant traffic or restoring a strict-compatible
   build and database backup.

---

# Verification

Tenant isolation should be treated as a security property, not merely feature behavior.

---

## Store isolation test

Create:

```text
Tenant A
  gmail / primary

Tenant B
  gmail / primary
```

Verify each tenant sees exactly one connection.

Test all supported Lens stores:

- SQLite;
- D1;
- PostgreSQL.

---

## ID isolation test

Create connection:

```text
tenant B
conn_B
```

Query:

```text
tenant A
getById(conn_B)
```

Expected:

```text
null / not_found
```

---

## Alias isolation test

Same alias in multiple tenants must not conflict, including concurrent creation.

Each binding must receive a different opaque upstream name.

---

## No-auth provider test

Two tenants see the same credentialless provider as their own virtual `default`
connection without a Lens binding. Its decision and run evidence still carry the
calling tenant, and it cannot expose customer state.

---

## Credential-class isolation test

Verify all of the following fail before dispatch:

```text
tenant-user JWT → /lens/v1/actions/*
tenant-user JWT → /lens/mcp
runtime token → approval resolution
tenant-user JWT → /lens/operator/*
operator JWT → tenant data-plane route
```

For both Lens JWT classes, also reject missing or empty `sub`, missing or expired
`exp`, an `aud` array, the other audience, and a token containing both audiences.
Successful control evidence must use the verified `sub` as `actor_subject`.

---

## Binding mismatch test

Persist contradictory trusted rows:

```text
token tenant = A
principal tenant = B
```

Expected:

```text
403 tenant_mismatch
```

No connection lookup occurs.

---

## Scope test

A valid tenant-user JWT with `lens.connections.read` may list connections but may not
write connections, start OAuth, resolve approvals, or read audit history. Each added
scope enables only its documented route class.

---

## Strict-mode test

No tenant claim/token binding.

Expected:

```text
401 tenant_required
```

No Lens database binding, local `lens.sqlite`, upstream SQLite, local transit files on
strict hosted Node, missing JWT configuration, equal tenant/operator audiences, an
unencrypted secret codec, or `LENS_DISABLED=1`.

Expected:

```text
startup failure
```

---

## Raw gateway test

In strict mode, call every documented safe raw `GET` route and verify it dispatches.
Call a state-changing method on the same path, including POST
`/v1/actions/:actionId`, plus each raw upstream action, MCP, proxy, connection,
OAuth-start, run, and file path. Also test an unknown future `/v1` and `/api` route,
encoded separators, duplicate slashes, case changes, and trailing-slash variants.

Expected for every request outside the allowlist:

```text
denied before upstream dispatch
```

---

## Legacy regression

No tenant configuration.

Expected behavior remains compatible with current deployment:

```text
tenant_id = ""
```

Existing tests continue to pass.

---

## OAuth flow test

1. start OAuth under tenant A;
2. capture a second state under tenant B;
3. swap states, replay a state, and switch browser/session context before callback;
4. only the exact pending binding may activate once;
5. no failed flow can expose its upstream credential.

---

## Approval isolation test

1. tenant B creates approval;
2. tenant A attempts to load or resolve its ID;
3. result is `not_found`;
4. tenant B may resolve it normally.

---

## Execution grant test

Create grant under tenant A.

Attempt consumption under tenant B. Separately alter only the stored immutable
connection-binding ID, then replace it with the `no_auth:<service>` sentinel.

Expected:

```text
invalid / not_found
```

with no provider call.

---

## Run-log isolation test

Create runs for both tenants.

A tenant-user JWT for A with `lens.audit.read` returns only A. A runtime token's MCP
run lookup returns only runs created by that token.

Simulate a successful upstream run followed by a Lens run-binding write failure. The
run remains hidden, readiness reports an orphan candidate, and no repair attaches it
to a decision by token or timestamp.

---

## Authorization evidence isolation

Same as run logs.

---

## Usage reservation isolation

Identical meter names and token-like activity in two tenants must not interfere.

---

## Cache isolation test

Populate connection cache for:

```text
tenant A / gmail / primary
```

then query:

```text
tenant B / gmail / primary
```

Verify tenant B never receives A's connection.

Test positive and negative caching.

---

## Idempotency isolation test

Use the same caller idempotency key for different tenants, tokens, and connection
bindings. Different authority tuples execute independently. Reuse with changed input
inside one tuple returns a conflict, and replay with the same input returns only that
tuple's stored response.

---

## Async resume test

1. tenant A action enters pending approval;
2. request ends;
3. generic worker later resumes execution;
4. worker reconstructs tenant A scoped store from persisted execution state;
5. only tenant A connection may execute.

---

## Cross-path test

Verify tenant isolation across:

- REST action execution;
- MCP tools;
- provider proxy;
- approval resume;
- retries.

Use the same foreign binding ID on every path and assert that no provider call occurs.

---

## Transit-file isolation test

1. upload a file under tenant B;
2. try to read, delete, and use its Lens file ID in an action under tenant A;
3. each operation returns `not_found` and the action executor is not called;
4. tenant B can still read, delete, or use the file normally;
5. an action-generated file returns a Lens ID and `/lens/api/files` URL, never an
   upstream ID or raw URL.

---

## Migration parity test

For SQLite, D1, and PostgreSQL:

1. bootstrap a fresh Lens database;
2. upgrade a database with the current RFC 0001 tables and data;
3. run migrations twice;
4. race two migration runners;
5. verify one schema version, backfilled legacy tenant, constraints, and data
   preservation.

---

## Operator-plane test

Normal tenant authentication:

```text
GET /lens/operator/...
```

must fail.

Operator authentication may explicitly inspect tenant A and tenant B.

Each access produces tenant-scoped operator authorization evidence using the verified
JWT `sub`. Tenant enumeration and global OAuth-config and runtime-policy access each
produce deployment-scoped evidence with `tenant_id = NULL`.

Token creation failure at any Lens binding step revokes or leaves an unusable upstream
token and never returns its plaintext secret.

---

# Property-based isolation test

Add a higher-level invariant test.

Generate arbitrary:

```text
tenant A resources
tenant B resources
```

and arbitrary supported store operations.

Assert:

```text
∀ operation O:

O scoped to tenant A
cannot return or mutate
tenant B data.
```

This is especially valuable as new stores are added.

---

# Required commands

```text
npm run fix-check
npm test
```

All tenancy tests run against:

```text
SQLite
D1
PostgreSQL
```

---

# Alternatives considered

## Tenant ID argument on every store method

Example:

```ts
getConnection(tenantId, id);
```

Better than global state but rejected as the primary API.

It still allows:

- wrong tenant IDs;
- parameter swaps;
- accidentally exposing unrestricted methods.

Tenant-scoped store capabilities make the boundary harder to misuse.

---

## One database per tenant

Rejected for initial implementation.

Advantages:

- strong physical isolation.

Costs:

- D1 operational overhead;
- database lifecycle management;
- migrations multiplied by tenant count;
- expensive connection routing;
- more complicated local development.

Logical isolation with strong scoped-store boundaries is sufficient for the current product stage.

The architecture should not prevent enterprise database isolation later.

---

## Tenant in URL

Example:

```text
/t/:tenant/v1/actions
```

Rejected.

It leaks tenancy into:

- SDKs;
- MCP;
- CLIs;
- every request surface.

More importantly, URL tenancy is still caller-supplied and therefore cannot be the security authority by itself.

Verified authentication is the correct source.

---

## `X-Tenant-ID` header

Rejected.

It is easy to forge and creates a confused-deputy risk.

---

## Using principal ID as tenant ID

Rejected.

Principals and tenants represent different concepts.

A tenant may contain many:

- users;
- agents;
- tokens.

Identity must not collapse into tenancy.

---

## Exposed global aliases with tenant filtering afterward

Rejected.

Tenant must be part of public-name uniqueness and lookup semantics. Globally unique
upstream names remain an internal implementation detail behind the Lens binding.

---

## Operator query parameter on normal endpoints

Example:

```text
/lens/api/connections?tenantId=acct_B
```

Rejected.

It weakens the conceptual boundary between tenant data plane and operator control plane.

Cross-tenant access deserves explicit privileged APIs.

---

# Resolved decisions and deferred work

## 1. Should strict mode eventually become the default?

Decision:

Keep `legacy` as the default for existing and self-hosted single-tenant deployments.
New hosted deployments set `strict` explicitly, and any deployment with more than one
tenant must use it. Do not silently change existing installations.

---

## 2. Should tenant IDs eventually be registered before use?

Today, any tenant identifier asserted by a trusted issuer may be used.

A future tenant registry could enable:

- suspension;
- lifecycle status;
- plan/quota configuration;
- region;
- encryption-key assignment.

Decision:

Do not block RFC 0002 on a registry.

Design tenant ID as stable enough to become its foreign key later.

---

## 3. Should we support globally shared connections?

Not in RFC 0002.

Shared connections create much more complicated authority semantics.

If needed later, model them explicitly as system resources with policies defining which tenants may use them.

Do not overload:

```text
tenant_id = ""
```

to mean global.

---

## 4. Should tenant-level usage limits ship immediately?

Decision:

Tenant identity should be added to the Lens usage-reservation model now.

Actual tenant-wide authorization limits may ship after core isolation if schedule requires.

---

## 5. Should tenant-specific encryption keys be added?

Not required for RFC 0002.

The current shared encryption key can remain initially.

Future enterprise isolation may introduce:

```text
deployment master key
      ↓
tenant data-encryption key
```

without changing application-level tenant ownership.

---

## 6. What happens when a tenant is suspended?

Tenant lifecycle is out of scope because Lens does not yet maintain a tenant registry.

The future registry design must define:

```text
deny new execution
deny OAuth creation
allow authorized operator export/recovery
```

Suspension is not inferred from missing rows or JWT failure in RFC 0002.

---

# Future work

RFC 0002 establishes foundations for:

### Tenant registry

Lifecycle and configuration.

---

### Membership

Multiple human users and roles inside a tenant.

---

### Application-specific tenant roles

The fixed JWT scopes in this RFC remain the Lens authorization boundary. A future
membership system may map product roles onto those scopes without changing Lens route
semantics.

---

### Tenant quotas

Connection, execution, and usage limits.

---

### Per-tenant encryption keys

Cryptographic isolation.

---

### Enterprise data isolation

Dedicated:

- database;
- worker pool;
- region;
- encryption key;

while preserving the same application APIs.

---

### Cross-tenant delegation

If ever required, it should be explicit, narrow, auditable, and capability-based.

No implicit sharing.

---

### Tenant deletion and export

Complete lifecycle controls.

---

# Specification completion

The RFC 0002 design is accepted and implementation-ready. All required v1 identity,
route, storage, OAuth, connection, execution, file, operator, migration, test, merge,
and deployment decisions are defined above. Items under Future work are explicitly
non-blocking and require separate RFCs.

Runtime implementation is not claimed by this document. It is complete only after PR
1 through PR 9 satisfy their acceptance gates and the verification matrix passes on
SQLite, D1, and PostgreSQL.

---

# Implementation success criteria

The RFC 0002 runtime implementation is complete when it can safely support:

```text
Tenant A
  Agent A1
  Agent A2
  Gmail A
  Stripe A

Tenant B
  Agent B1
  GitHub B
  Gmail B
```

inside the same deployment while guaranteeing:

```text
A cannot discover B
A cannot authorize against B
A cannot execute against B
A cannot approve B
A cannot resume B
A cannot consume B grants
A cannot read B logs
A cannot read B evidence
A cannot consume B credentials
```

even if A knows the identifiers of B's resources.

The implementation should be strong enough that adding a new normal runtime route does not require the developer to remember:

> “Don't forget the tenant filter.”

The route receives a tenant-scoped capability and cannot access another tenant through ordinary APIs.

---

# Final principle

Multi-tenancy is not:

> **add `tenant_id` to every table.**

It is:

> **establish an authority boundary that follows the principal from authentication through authorization, resource resolution, execution, asynchronous continuation, and evidence.**

RFC 0001 answers:

> **Does this agent possess valid authority to perform this exact action?**

RFC 0002 adds the prior question:

> **Inside whose security boundary is that authority even meaningful?**

Only after both are answered may Lens execute.

The resulting invariant is simple:

> **Every action belongs to one tenant. Every resource belongs to one tenant. Every authority chain stays inside that tenant.**

That is the foundation required to safely turn Lens from a single-user connector runtime into shared infrastructure for agentic products.
