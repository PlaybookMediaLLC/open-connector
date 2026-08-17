# RFC 0002: Multi-Tenant Isolation and Connection Scoping

* **Status:** Draft
* **Author:** Lens
* **Date:** 2026-08-17
* **Priority:** 2 of 3
* **Depends on:** RFC 0001 — Agent Authorization Control Plane

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

* a canonical tenant identity;
* trusted tenant resolution;
* immutable tenant scope for a request;
* tenant-bound principals and runtime tokens;
* tenant-bound connections and credentials;
* tenant-bound authorization decisions;
* tenant-bound approvals and execution grants;
* tenant-bound usage reservations;
* tenant-bound run logs;
* safe OAuth state propagation;
* tenant-safe asynchronous execution;
* tenant-aware caching rules;
* a separate operator access path for cross-tenant administration;
* compatibility with existing single-tenant deployments.

The resulting runtime must support:

> thousands of customer workspaces on one Lens deployment without making tenant isolation dependent on every route author remembering to add the correct database predicate.

---

# Non-Goals

This RFC does **not** introduce:

* end-user signup;
* user management;
* invitations;
* organization membership;
* a hosted identity provider;
* billing;
* subscriptions;
* tenant-specific OAuth applications;
* cross-tenant data sharing;
* hierarchical tenants;
* parent/child organizations;
* tenant-to-tenant delegation;
* tenant data export or deletion workflows;
* tenant-specific encryption keys;
* regional data residency;
* tenant-specific databases.

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

* one company;
* one workspace;
* one customer account;
* one product account.

It does not necessarily represent one human.

Multiple principals may eventually operate inside one tenant.

---

## Tenant ID

An opaque externally assigned identifier.

Lens does not derive tenant IDs from:

* email addresses;
* company names;
* domains;
* connection aliases;
* request paths.

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

  source:
    | "runtime_jwt"
    | "runtime_token"
    | "matched_auth_sources"
    | "legacy_default";
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

* operate across multiple tenants;
* switch tenant halfway through execution;
* authorize under one tenant and execute under another.

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

## 3. Conflicting tenant authorities fail closed

If two trusted authentication mechanisms assert tenant identity, they must agree.

Example:

```text
JWT tenant       acct_A
Runtime token    acct_B
```

Result:

```text
403 tenant_mismatch
```

No precedence rule silently chooses one.

---

## 4. Resources cannot escape tenant scope

An action authorized for tenant A may only resolve resources belonging to tenant A.

A caller cannot escape scope by supplying:

* a connection ID;
* an approval ID;
* a run ID;
* an execution grant ID;
* a provider account ID;

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

`tenant_mismatch` is reserved for contradictory trusted authentication sources.

---

## 6. Tenant scope survives asynchronous execution

A request that becomes:

* pending approval;
* queued;
* retried;
* resumed;
* scheduled in the future;

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

Where supported by the credential encryption implementation, encrypted tenant secrets SHOULD bind tenant identity into authenticated encryption metadata.

---

# Tenant resolution

Tenant identity is resolved during authentication.

Current runtime JWT verification:

```text
src/server/api/runtime-jwt.ts
```

is extended from returning a boolean to returning verified claims.

---

# Trusted tenant sources

RFC 0002 initially supports two trusted sources.

## 1. Runtime JWT

A verified runtime JWT may contain:

```json
{
  "tenant": "acct_8f2k"
}
```

The claim is trusted only after:

* signature validation;
* issuer validation;
* audience validation;
* temporal claim validation.

The tenant claim itself is not trusted independently of the JWT.

---

## 2. Runtime token

`RuntimeTokenRecord` gains:

```ts
tenantId?: string;
```

A tenant-bound runtime token may act only inside that tenant.

---

# Tenant resolution algorithm

```ts
function resolveTenant(
  jwtTenant?: string,
  tokenTenant?: string,
  mode?: TenancyMode,
): TenantContext
```

Rules:

### Both present and equal

```text
JWT        acct_A
Token      acct_A
```

Result:

```text
acct_A
source = matched_auth_sources
```

---

### Both present and different

```text
JWT        acct_A
Token      acct_B
```

Result:

```text
403 tenant_mismatch
```

---

### JWT only

Use JWT tenant.

---

### Token only

Use token tenant.

---

### Neither present

Behavior depends on tenancy mode.

---

# Tenancy modes

Introduce:

```ts
type TenancyMode = "legacy" | "strict";
```

Configured at deployment level.

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

Hosted Lens deployments SHOULD run in strict mode.

---

# Tenant ID validation

Tenant IDs are opaque strings.

The runtime validates only structural safety:

* value must be a string;
* non-empty outside legacy mode;
* maximum length: 128 bytes;
* no NUL bytes;
* no leading/trailing whitespace.

Lens does not interpret tenant IDs semantically.

---

# Request context

Authentication resolves tenant exactly once.

Request context gains:

```ts
interface AuthenticatedRequestContext {
  tenant: TenantContext;

  principal: AuthenticatedPrincipal;

  token?: RuntimeTokenRecord;

  tenantStore: ITenantRuntimeStore;
}
```

There are no mutable ambient tenant globals.

---

# Tenant-scoped stores

The original proposal required every store method to accept:

```ts
tenantId
```

as its first argument.

That is better than ambient state but still allows bugs such as:

```ts
store.getConnection(wrongTenantId, id);
```

or accidentally calling a non-scoped method.

RFC 0002 instead introduces a capability-style store.

```ts
interface IRuntimeStore {
  forTenant(tenantId: string): ITenantRuntimeStore;
}
```

`ITenantRuntimeStore` exposes only tenant-scoped operations:

```ts
interface ITenantRuntimeStore {
  connections: ITenantConnectionStore;
  tokens: ITenantTokenStore;
  runs: ITenantRunLogStore;
  approvals: ITenantApprovalStore;
  authorization: ITenantAuthorizationStore;
  usage: ITenantUsageStore;
}
```

Example:

```ts
const tenantStore = runtimeStore.forTenant(ctx.tenant.tenantId);

const connection =
  await tenantStore.connections.getByAlias("gmail", "primary");
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
TenantScopedStore
```

or explicit operator services may receive it.

---

# Operator store

Cross-tenant administration uses a separate interface:

```ts
interface IOperatorRuntimeStore {
  listTenants(...): Promise<...>;

  forTenant(
    tenantId: string,
    operatorContext: OperatorContext,
  ): ITenantRuntimeStore;
}
```

Operator access requires:

* operator authentication;
* explicit tenant selection;
* authorization under RFC 0001;
* audit evidence.

This prevents ordinary runtime code from casually becoming cross-tenant.

---

# Authorization integration

RFC 0001 introduces:

```ts
AuthorizationRequest
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

`RuntimeTokenRecord` gains:

```ts
tenantId: string;
```

in persisted representation.

Legacy records are backfilled to:

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
  connectionId: string;
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

After RFC 0001 migrations, add:

```text
0015_tenant_scope.sql
```

Exact numbering may be adjusted to repository state.

Add:

```sql
tenant_id TEXT NOT NULL DEFAULT ''
```

to all tenant-owned data.

At minimum:

* connections;
* connection identities;
* connection revisions;
* runtime tokens;
* run logs;
* authorization decisions;
* action approvals;
* execution grants;
* usage reservations.

Any additional persisted customer-specific tables discovered during implementation MUST also be scoped.

---

# Connection alias uniqueness

Current uniqueness:

```text
(service, alias)
```

becomes:

```text
(tenant_id, service, alias)
```

Therefore both tenants may safely have:

```text
service = gmail
alias   = primary
```

without collision.

---

# Composite tenant integrity

Tenant filtering alone is insufficient if child records can reference parent records in another tenant.

Where practical, database constraints SHOULD enforce tenant consistency.

Example:

```sql
UNIQUE (tenant_id, id)
```

on connections.

Child records then reference:

```text
(tenant_id, connection_id)
```

rather than only:

```text
connection_id
```

This prevents:

```text
tenant A revision
        ↓
tenant B connection
```

from existing even if application code is buggy.

The same principle applies to:

* approvals → authorization decisions;
* execution grants → approvals;
* runs → authorization decisions;
* usage reservations → principals/tokens where supported.

---

# Indexes

Tenant-prefixed indexes are required for hot paths.

Examples:

```sql
CREATE INDEX idx_connections_tenant
ON connections (tenant_id);

CREATE INDEX idx_connections_tenant_service_alias
ON connections (tenant_id, service, alias);

CREATE INDEX idx_runs_tenant_created
ON run_logs (tenant_id, created_at);

CREATE INDEX idx_authz_tenant_created
ON authorization_decisions (tenant_id, created_at);

CREATE INDEX idx_approvals_tenant_state
ON action_approvals (tenant_id, state, requested_at);
```

D1 and SQLite implementations must remain behaviorally equivalent.

---

# Credentials

Connection credentials inherit their connection's tenant scope.

Credential retrieval always happens through:

```text
TenantConnectionStore
```

The runtime MUST NOT expose a method equivalent to:

```ts
getCredential(connectionId)
```

without tenant context.

---

# Encryption binding

Where the existing encryption primitive supports authenticated additional data, encrypt connection secrets using context such as:

```text
tenant_id
connection_id
credential_type
```

Conceptually:

```ts
encrypt(secret, {
  aad: `${tenantId}:${connectionId}:${credentialType}`,
});
```

This provides defense in depth.

If ciphertext belonging to tenant A is accidentally attached to tenant B, authenticated decryption fails rather than silently returning valid credentials.

If the current encryption implementation cannot support AAD cleanly, this may ship as a follow-up security hardening task rather than blocking Phase 1.

---

# Connection lookup

All lookups occur inside the scoped store.

Example:

```ts
ctx.tenantStore.connections.getByAlias(
  "stripe",
  "billing",
);
```

Even if a caller knows another tenant's globally unique connection ID:

```text
conn_xyz
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

`oauth-flow-service.ts` already round-trips signed state.

Extend state to include:

```ts
interface OAuthStatePayload {
  tenantId: string;

  principalId?: string;

  connectionAlias?: string;

  nonce: string;

  issuedAt: string;

  expiresAt: string;
}
```

The tenant ID is therefore cryptographically bound to the OAuth flow that initiated authorization.

---

# OAuth completion invariant

The callback MUST NOT choose tenancy from:

* current browser state;
* query parameters other than verified signed state;
* an arbitrary request header.

It writes the resulting connection into:

```text
state.tenantId
```

after verifying the OAuth state.

---

# OAuth replay

OAuth state SHOULD remain:

* signed;
* expiring;
* nonce-bound;
* single-use where the current implementation supports it.

A completed or expired state cannot create a second connection.

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

RFC 0001 authorization evidence becomes tenant-bound.

Example:

```ts
interface AuthorizationEvidence {
  tenantId: string;

  decisionId: string;

  principalId: string;
  ...
}
```

A decision cannot later be resolved or executed under another tenant.

---

# Action approvals

Approval records gain:

```text
tenant_id
```

and are accessed only through:

```text
ITenantApprovalStore
```

An approval ID from another tenant returns:

```text
not_found
```

---

# Execution grants

Execution grants gain:

```ts
tenantId: string;
```

The grant digest SHOULD include tenant identity.

Conceptually:

```text
SHA-256(
  tenantId
  + principal
  + action
  + resource
  + canonical input
)
```

A grant created under tenant A is unusable in tenant B.

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

Usage reservations from RFC 0001 become tenant-bound.

Add:

```text
tenant_id
```

to usage reservations.

This prevents reservations or counters from colliding across tenants.

---

# Tenant-scoped safety limits

RFC 0002 extends future usage-limit scope to include:

```ts
type UsageLimitScope =
  | "token"
  | "principal"
  | "connection"
  | "tenant"
  | "runtime";
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

`RunLog` gains:

```ts
tenantId: string;
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

Run logs are queried through the tenant-scoped store.

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

* approvals;
* delayed retries;
* queued executions;
* RFC 0003 triggers;
* future task systems.

Every durable execution object MUST persist:

```text
tenant_id
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
runtimeStore.forTenant("acct_A")
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
connectionId
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

returns tenant A connections only.

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

is tenant-scoped.

Wire shapes remain stable.

---

# REST API

Existing runtime endpoints become tenant-scoped automatically.

Examples:

```text
/api/connections
/v1/actions/...
/v1/runs/...
```

Tenant selection is not added as a normal query parameter.

---

# Operator API

Cross-tenant administration is explicitly separated.

Example namespace:

```text
/api/operator/...
```

Potential endpoints:

```text
GET /api/operator/tenants
GET /api/operator/tenants/:tenantId/connections
GET /api/operator/tenants/:tenantId/runs
GET /api/operator/tenants/:tenantId/approvals
```

These endpoints:

* require operator authentication;
* require RFC 0001 authorization;
* produce authorization evidence;
* explicitly identify the target tenant.

The exact operator API surface may remain minimal in RFC 0002.

The separation itself is mandatory.

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

* connections;
* runs;
* approvals;
* authorization decisions.

This reduces accidental operator actions against the wrong customer.

---

# Operator evidence

Cross-tenant operator reads and writes should generate evidence containing:

```text
operator principal
target tenant
action
resource
timestamp
```

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

* connections;
* credentials;
* authorization decisions;
* policy snapshots where tenant-specific;
* approval lookups;
* run metadata;
* connection-resolution caches;
* negative lookup caches.

---

# Shared caches

Tenant-independent immutable/catalog data may remain shared.

Examples:

* provider catalog;
* action schemas;
* action manifests;
* static documentation.

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

* aggregated platform metrics;
* logs/traces for tenant-level debugging;
* intentionally designed tenant usage tables.

This prevents observability infrastructure from becoming expensive or unstable as tenant count grows.

---

# Error semantics

Add:

```ts
type TenantErrorCode =
  | "tenant_required"
  | "tenant_invalid"
  | "tenant_mismatch";
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

### JWT/token disagreement

```text
403 tenant_mismatch
```

### Resource belongs to another tenant

Return ordinary resource-not-found semantics.

Do not reveal the other tenant.

---

# Data migration

All existing rows are backfilled with:

```text
tenant_id = ''
```

This preserves compatibility.

No existing connection aliases change behavior in legacy mode.

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

Before enabling strict mode, operators should:

* migrate or recreate legacy connections;
* bind runtime tokens to explicit tenants;
* verify no production workflow depends on the default tenant.

Strict mode may warn when legacy rows remain.

It should not silently reassign them.

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
interface IRuntimeStore {
  forTenant(tenantId: string): ITenantRuntimeStore;

  operator(): IOperatorRuntimeStore;
}
```

Implementations:

```text
sqlite-runtime-store.ts
d1-runtime-store.ts
```

must provide equivalent tenant behavior.

---

# Example tenant connection store

```ts
interface ITenantConnectionStore {
  create(input: ConnectionCreateInput): Promise<Connection>;

  getById(id: string): Promise<Connection | null>;

  getByAlias(
    service: string,
    alias: string,
  ): Promise<Connection | null>;

  list(input?: ConnectionListInput): Promise<Connection[]>;

  update(
    id: string,
    input: ConnectionUpdateInput,
  ): Promise<Connection | null>;

  delete(id: string): Promise<boolean>;
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

## Threat: JWT/token confusion

JWT says:

```text
tenant A
```

token says:

```text
tenant B
```

Mitigation:

Fail closed with `tenant_mismatch`.

---

## Threat: connection-ID enumeration

Tenant A learns:

```text
conn_victim
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

Uniqueness includes `tenant_id`.

---

## Threat: forgotten query filter

Developer adds a new route but forgets tenant filtering.

Mitigation:

Handler receives tenant-scoped store rather than unrestricted data store.

---

## Threat: approval ID reuse

Tenant A attempts to resolve tenant B approval.

Mitigation:

Approval lookup is tenant-scoped and returns not found.

---

## Threat: async tenant loss

Approved action resumes later in generic worker.

Mitigation:

Tenant ID persisted on approval/execution object and used to construct scoped store.

---

## Threat: OAuth tenant swap

Flow begins in tenant A but callback is completed while browser is authenticated as tenant B.

Mitigation:

Tenant is cryptographically bound to OAuth state.

---

## Threat: cache collision

Connection alias cached without tenant dimension.

Mitigation:

Every tenant-derived cache key includes tenant ID.

---

## Threat: ciphertext reassignment

Bug attaches tenant A credential ciphertext to tenant B connection.

Mitigation:

Tenant-bound encryption AAD where supported.

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

RFC 0002 SHOULD make tenant identity available to future controls for:

* concurrent run limits;
* connection count limits;
* API throughput;
* action-meter limits;
* queue fairness.

These are operational safety controls, not billing semantics.

Exact quotas may be implemented separately.

---

# Rollout

Ship in four phases.

---

## Phase 1 — Storage isolation

Implement:

* `tenant_id` schema migration;
* composite uniqueness;
* tenant-prefixed indexes;
* tenant-scoped store interfaces;
* SQLite implementation;
* D1 implementation;
* legacy default tenant;
* store isolation tests.

No authentication behavior changes yet.

Goal:

> Tenant boundaries exist in persistence and cannot be accidentally omitted by normal store consumers.

---

## Phase 2 — Authentication and authorization plumbing

Implement:

* verified JWT claim return;
* tenant resolution;
* runtime-token tenant binding;
* `TenantContext`;
* strict/legacy modes;
* RFC 0001 authorization integration;
* tenant-aware error semantics.

Goal:

> Every data-plane request enters the runtime with one immutable tenant identity.

---

## Phase 3 — Lifecycle propagation

Implement tenant binding for:

* OAuth state;
* authorization decisions;
* approvals;
* execution grants;
* usage reservations;
* run logs;
* retries;
* asynchronous workers.

Audit tenant-sensitive caches.

Goal:

> Tenant scope survives every execution state transition.

---

## Phase 4 — Operator plane

Implement:

* separate operator tenant access;
* console tenant selector;
* operator authorization evidence;
* strict-mode readiness tooling.

Goal:

> Multi-tenant operations are possible without weakening the data-plane boundary.

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

Test both:

* SQLite;
* D1.

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

Same alias in multiple tenants must not conflict.

---

## Token mismatch test

JWT:

```text
tenant A
```

runtime token:

```text
tenant B
```

Expected:

```text
403 tenant_mismatch
```

No connection lookup occurs.

---

## Strict-mode test

No tenant claim/token binding.

Expected:

```text
401 tenant_required
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
2. complete provider callback;
3. switch browser/session context to tenant B before callback if possible;
4. connection must still be written under tenant A.

---

## Approval isolation test

1. tenant B creates approval;
2. tenant A attempts to load or resolve its ID;
3. result is `not_found`;
4. tenant B may resolve it normally.

---

## Execution grant test

Create grant under tenant A.

Attempt consumption under tenant B.

Expected:

```text
invalid / not_found
```

with no provider call.

---

## Run-log isolation test

Create runs for both tenants.

Tenant A list endpoint returns only A.

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

## Async resume test

1. tenant A action enters pending approval;
2. request ends;
3. generic worker later resumes execution;
4. worker reconstructs tenant A scoped store from persisted execution state;
5. only tenant A connection may execute.

---

## Cross-path test

Verify tenant isolation across:

* REST action execution;
* MCP tools;
* provider proxy;
* approval resume;
* retries.

---

## Operator-plane test

Normal tenant authentication:

```text
GET /api/operator/...
```

must fail.

Operator authentication may explicitly inspect tenant A and tenant B.

Each access produces operator authorization evidence.

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
```

---

# Alternatives considered

## Tenant ID argument on every store method

Example:

```ts
getConnection(tenantId, id)
```

Better than global state but rejected as the primary API.

It still allows:

* wrong tenant IDs;
* parameter swaps;
* accidentally exposing unrestricted methods.

Tenant-scoped store capabilities make the boundary harder to misuse.

---

## One database per tenant

Rejected for initial implementation.

Advantages:

* strong physical isolation.

Costs:

* D1 operational overhead;
* database lifecycle management;
* migrations multiplied by tenant count;
* expensive connection routing;
* more complicated local development.

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

* SDKs;
* MCP;
* CLIs;
* every request surface.

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

* users;
* agents;
* tokens.

Identity must not collapse into tenancy.

---

## Global aliases with tenant filtering afterward

Rejected.

Tenant must be part of alias uniqueness and lookup semantics.

---

## Operator query parameter on normal endpoints

Example:

```text
/api/connections?tenantId=acct_B
```

Rejected.

It weakens the conceptual boundary between tenant data plane and operator control plane.

Cross-tenant access deserves explicit privileged APIs.

---

# Open questions

## 1. Should strict mode eventually become the default?

Recommendation:

Yes for new hosted deployments.

Keep legacy mode for self-hosted/single-tenant compatibility.

Do not silently change existing installations.

---

## 2. Should tenant IDs eventually be registered before use?

Today, any tenant identifier asserted by a trusted issuer may be used.

A future tenant registry could enable:

* suspension;
* lifecycle status;
* plan/quota configuration;
* region;
* encryption-key assignment.

Recommendation:

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

Recommendation:

Tenant identity should be added to the usage-reservation model now.

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

Future behavior should likely be:

```text
deny new execution
deny OAuth creation
allow authorized operator export/recovery
```

but this requires a separate lifecycle design.

---

# Future work

RFC 0002 establishes foundations for:

### Tenant registry

Lifecycle and configuration.

---

### Membership

Multiple human users and roles inside a tenant.

---

### Tenant-scoped approval roles

Examples:

```text
approval.viewer
approval.resolver
approval.admin
```

---

### Tenant quotas

Connection, execution, and usage limits.

---

### Per-tenant encryption keys

Cryptographic isolation.

---

### Enterprise data isolation

Dedicated:

* database;
* worker pool;
* region;
* encryption key;

while preserving the same application APIs.

---

### Cross-tenant delegation

If ever required, it should be explicit, narrow, auditable, and capability-based.

No implicit sharing.

---

### Tenant deletion and export

Complete lifecycle controls.

---

# Success criteria

RFC 0002 is complete when the runtime can safely support:

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
