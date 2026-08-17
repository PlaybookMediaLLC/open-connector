# RFC 0001: Agent Authorization Control Plane

- **Status:** Draft
- **Author:** Lens
- **Date:** 2026-08-17
- **Priority:** 1 of 3

---

## Summary

Extend the runtime from a connector gateway into an **authorization control plane for autonomous agents**.

The runtime must be able to answer, for every attempted external action:

> **Who is acting, on whose behalf, using which authority, against which resource, with what inputs, under which limits and policies, and can we prove why the action was allowed?**

This RFC introduces six foundational authorization primitives:

1. **Principal identity and delegation** — every action is attributable to a stable agent identity, credential, originating subject, and optional delegation chain.
2. **Resource-aware authorization** — policies may constrain not only an action ID, but the connection, account, credential owner, and resource being acted upon.
3. **Argument-level constraints** — policies may restrict individual action inputs such as recipients, amounts, repositories, environments, or IDs.
4. **Usage meters and budgets** — agents may receive bounded authority such as 20 emails/hour, 5 merges/day, or $10,000 of refunds/day.
5. **Human approval obligations** — high-risk actions may pause and require an immutable, single-use human authorization grant before execution.
6. **Authorization evidence** — every policy decision produces a durable record explaining what was requested, which policies applied, which obligations were satisfied, and what ultimately executed.

The central execution model becomes:

```text
Authorization Request
        │
        ├── Principal
        ├── Delegation
        ├── Action
        ├── Resource
        ├── Input
        └── Context
        │
        ↓
Policy Decision
        │
   ┌────┴────┐
   ↓         ↓
 DENY      ALLOW
             │
             ↓
        Obligations
       ┌─────┼─────┐
       ↓     ↓     ↓
    Budget Approval Evidence
       └─────┼─────┘
             ↓
          Execute
             ↓
           Result
             ↓
     Authorization Evidence
```

This RFC establishes the authorization boundary on which RFC 0002 multi-tenancy and RFC 0003 triggers/events can safely build.

---

# Motivation

Connectivity is becoming a commodity.

Providers increasingly expose APIs, MCP servers, SDKs, and agent-native integration surfaces directly.

The durable problem is not:

> Can the agent reach GitHub?

It is:

> Can this specific agent, acting on behalf of this specific human or service, use this specific GitHub connection to merge this specific pull request into production, under its current authority, without exceeding its limits, and can we later prove why it was allowed?

The current policy engine in:

```text
src/core/action-policy.ts
```

primarily answers:

> Is this action ID allowed?

That is insufficient once agents can:

- send external email;
- merge code;
- change production infrastructure;
- modify permissions;
- issue refunds;
- pay invoices;
- delete external data;
- move money;
- operate unattended.

The current system cannot robustly answer:

- May this agent email addresses outside the company domain?
- May this agent issue a $750 refund but not a $7,500 refund?
- May it act through `finance@company.com` but not the CEO's mailbox?
- May it use one Stripe connection but not another?
- Is the agent acting directly for a user or through delegated authority?
- How many destructive actions may it perform today?
- Has another concurrent request already consumed its remaining budget?
- Did a human authorize the exact action that ultimately executed?
- Did policy change after approval but before execution?
- Which policy version allowed the action?
- Can the operator reconstruct the complete authority chain afterward?

For agents touching money, production systems, customer communications, and irreversible external state, these questions determine whether organizations can safely deploy autonomous systems at all.

Lens should therefore become:

> **The policy enforcement and authorization evidence layer between autonomous agents and external systems.**

---

# Goals

RFC 0001 establishes a minimal but durable authorization architecture capable of supporting:

- stable agent identities;
- delegated authority;
- resource-specific authorization;
- argument-level restrictions;
- bounded quantitative authority;
- asynchronous human approval;
- policy explanations;
- policy-version attribution;
- atomic budget enforcement;
- exact approval-to-execution binding;
- consistent enforcement across every runtime execution path;
- durable authorization evidence.

The implementation should remain deliberately smaller than a general-purpose policy language.

We want strong primitives before expressive syntax.

---

# Non-Goals

This RFC does **not** introduce:

- multi-tenancy — see RFC 0002;
- triggers or event subscriptions — see RFC 0003;
- anomaly detection;
- behavioral ML risk scoring;
- generalized ABAC/RBAC administration;
- Cedar, Rego, CEL, or another full policy language;
- automatic approval by agents;
- multi-approver quorum workflows;
- cryptographically tamper-evident logs;
- policy recommendations generated by ML;
- organization-wide roles beyond what the existing console requires.

The schema should leave room for these without requiring a redesign.

---

# Security invariants

The implementation MUST preserve the following invariants.

## 1. Default deny

If Lens cannot confidently determine that an action is authorized, it does not execute.

---

## 2. Delegation only narrows authority

A delegated principal may receive the same or less authority than its parent.

Delegation must never increase authority.

Formally:

```text
effective(child) ⊆ effective(parent)
```

---

## 3. Lower policy layers cannot widen higher layers

Deployment, runtime, token, and future delegation policies compose monotonically.

A narrower scope cannot re-enable something denied above it.

---

## 4. Approval is not a policy bypass

Human approval satisfies an approval obligation.

It does not override:

- a current hard deny;
- revoked credentials;
- an expired grant;
- a depleted budget;
- a changed resource binding.

---

## 5. Approval authorizes an exact intent

If a human approves:

```json
{
  "invoiceId": "inv_123",
  "amount": 50000,
  "currency": "USD"
}
```

that approval cannot execute:

```json
{
  "invoiceId": "inv_123",
  "amount": 500000,
  "currency": "USD"
}
```

The approved request must be cryptographically bound to the exact canonicalized authorization request.

---

## 6. Budgets are enforced atomically

Concurrent requests must not collectively exceed configured limits.

Audit logs are not sufficient concurrency-control infrastructure.

---

## 7. A credential is not an identity

Runtime tokens authenticate requests.

They do not replace stable principal identity.

---

## 8. All execution paths share one enforcement boundary

MCP tools, REST calls, provider proxy calls, retries, resumed runs, approval execution, and future triggers must all pass through the same authorization path.

There must be no privileged bypass around authorization.

---

# Terminology

## Principal

The actor requesting authority.

Initially this is normally an agent.

Example:

```text
agt_invoicing
```

---

## Subject

The human or service on whose behalf the principal ultimately acts.

Example:

```text
usr_alice
```

---

## Runtime token

The credential used to authenticate the request.

Example:

```text
tok_abc
```

Tokens may be revoked or rotated without changing the principal's identity.

---

## Delegation

Authority passed from one principal to another.

Example:

```text
Alice
  ↓
finance-agent
  ↓
collections-agent
```

---

## Action

A named operation exposed by Lens.

Examples:

```text
gmail.send
stripe.refund
github.merge_pull_request
cadense.pay_invoice
```

---

## Resource

The external or internal object through which or against which the action occurs.

Examples:

```text
Gmail connection conn_123
Stripe account acct_123
GitHub repository org/repo
Cadense workspace ws_123
```

---

## Constraint

A deterministic restriction on request input or resource state.

---

## Meter

A measurable dimension of authority.

Examples:

```text
email_send_count
refund_value
production_deploy_count
payment_value
```

---

## Obligation

A condition that must be satisfied after policy allows the request but before execution can occur.

Examples:

```text
require human approval
reserve budget
require idempotency key
write high-detail evidence
```

---

## Authorization decision

The durable result produced by the policy engine.

---

## Execution grant

A short-lived, single-use object proving that all required authorization obligations have been satisfied for an exact request.

---

# Architecture

The current interface:

```ts
evaluate(actionId);
```

becomes:

```ts
authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>
```

The policy engine should reason over the complete authorization request.

---

# 1. Authorization request

```ts
interface AuthorizationRequest {
  requestId: string;

  principal: AuthorizationPrincipal;

  action: AuthorizationAction;

  resource: AuthorizationResource;

  input: unknown;

  context: AuthorizationContext;
}
```

## Principal

```ts
interface AuthorizationPrincipal {
  /** Stable identity of the acting agent. */
  principalId: string;

  /** Credential authenticating this request. */
  tokenId: string;

  /** Human or service ultimately responsible for this authority. */
  subjectId?: string;

  /** Immediate delegating principal, if any. */
  delegatedBy?: string;

  /** Full authority chain from originating principal to caller. */
  delegationChain?: string[];
}
```

`principalId` is security-relevant.

Human-readable labels are not.

A principal may separately contain:

```ts
displayLabel?: string;
```

for console rendering.

---

# 2. Action manifest

Each executable action SHOULD declare semantic security metadata.

```ts
interface ActionManifest {
  id: string;

  effects: ActionEffect[];

  riskClass: "read" | "write" | "high" | "critical";

  reversibility: "reversible" | "partially_reversible" | "irreversible";

  sensitiveInputPaths?: string[];

  metering?: MeterDefinition[];

  idempotency?: {
    required: boolean;
  };
}
```

Effects:

```ts
type ActionEffect =
  | "read_external_data"
  | "write_external_data"
  | "external_communication"
  | "delete_external_data"
  | "money_movement"
  | "credential_change"
  | "permission_change"
  | "code_execution"
  | "production_change";
```

This allows policies to eventually target semantic risk rather than enumerate every provider action.

For example:

> All money movement above $1,000 requires approval.

instead of maintaining separate rules for:

```text
stripe.refund
cadense.pay
wise.transfer
rain.send
```

Phase 1 MAY continue authoring policies primarily against action patterns while manifests are introduced incrementally.

---

# 3. Resource model

```ts
interface AuthorizationResource {
  providerId: string;

  /** Lens connection used to exercise authority. */
  connectionId: string;

  /** Provider account, repository, workspace, mailbox, etc. */
  resourceId?: string;

  /** Principal or subject that owns the underlying authority. */
  ownerId?: string;

  /** Provider-specific classification. */
  resourceType?: string;
}
```

This closes an important hole in action-only authorization.

The following are distinct authorization requests:

```text
gmail.send through finance@company.com
gmail.send through ceo@company.com
```

even though the action ID is identical.

---

# 4. Context

```ts
interface AuthorizationContext {
  now: string;

  runId: string;

  parentRunId?: string;

  /** User or workflow intent that originated the operation. */
  userIntentId?: string;

  /** Whether a user is actively present. */
  interactive: boolean;
}
```

`userIntentId` is not fully enforced in RFC 0001 but is persisted so future intent-scoped authorization can build on it without changing the request model.

---

# Authorization decisions

The engine returns a structured result rather than only `true` or `false`.

```ts
type AuthorizationDecision = AuthorizationDeniedDecision | AuthorizationAllowedDecision;
```

```ts
interface AuthorizationDeniedDecision {
  effect: "deny";

  decisionId: string;

  reasons: AuthorizationReason[];

  policySnapshotId: string;
}
```

```ts
interface AuthorizationAllowedDecision {
  effect: "allow";

  decisionId: string;

  obligations: AuthorizationObligation[];

  policySnapshotId: string;
}
```

Example obligations:

```ts
type AuthorizationObligation =
  | {
      kind: "reserve_meter";
      meter: string;
      amount: string;
    }
  | {
      kind: "require_approval";
      policyId: string;
    }
  | {
      kind: "require_idempotency_key";
    }
  | {
      kind: "evidence_level";
      level: "standard" | "high";
    };
```

The policy engine decides.

The runtime enforcement layer satisfies obligations and decides whether execution may proceed.

---

# Policy composition

Lens currently evaluates policy layers in this order:

1. deployment;
2. runtime;
3. token.

This ordering remains, but composition becomes explicitly monotonic.

Future delegation policy may add another narrower layer.

Conceptually:

```text
Deployment
    ∩
Runtime
    ∩
Token
    ∩
Delegation
    =
Effective Authority
```

Rules compose as follows.

## Allowed actions

Intersection.

An action must be permitted by every applicable restrictive layer.

---

## Denied actions

Union.

A deny at any layer denies execution.

---

## Constraints

All applicable constraints must pass.

---

## Approval requirements

Union.

If any applicable policy requires approval, approval is required.

---

## Usage limits

All applicable limits apply.

The effective authority is bounded by the most restrictive applicable limits.

---

# Argument-level constraints

Extend `TokenPolicy` and `PolicyRules` with:

```ts
interface ActionConstraint {
  /** Exact action, "service.*", or "*". */
  action: string;

  /** JSON Pointer into validated action input. */
  path: string;

  /**
   * Missing values fail unless optional=true.
   */
  optional?: boolean;

  rule: ConstraintRule;
}
```

Rules:

```ts
type ConstraintRule =
  | {
      kind: "required";
    }
  | {
      kind: "forbidden";
    }
  | {
      kind: "max_number";
      value: string;
    }
  | {
      kind: "min_number";
      value: string;
    }
  | {
      kind: "pattern";
      value: string;
    }
  | {
      kind: "one_of";
      values: string[];
    }
  | {
      kind: "max_length";
      value: number;
    };
```

Numeric policy values use strings so the policy layer does not force floating-point semantics.

Money-specific authorization should use meters rather than generic `max_number`.

---

# Missing-path semantics

The previous design gave different implicit behavior to different constraint types.

That is removed.

Default rule:

> A constraint targeting a missing path fails closed.

The policy author must explicitly declare:

```ts
optional: true;
```

if absence is acceptable.

This makes policy behavior consistent and reviewable.

---

# Constraint evaluation

Action input is schema-validated before policy evaluation.

Evaluation order:

```text
1. resolve principal
2. resolve resource
3. load effective policy
4. check action allow/deny
5. evaluate argument constraints
6. calculate applicable meters
7. determine approval obligations
8. emit AuthorizationDecision
```

A constraint failure returns:

```text
input_constraint_violation
```

with structured metadata:

```ts
interface ConstraintViolationReason {
  code: "input_constraint_violation";
  path: string;
  ruleKind: string;
  policyId: string;
}
```

Sensitive values MUST NOT appear in error text.

---

# Usage meters and budgets

The previous `TokenBudget` abstraction is generalized.

Not every bounded authority is financial.

Examples include:

- 20 emails/hour;
- 5 GitHub merges/day;
- 2 production deployments/day;
- $1,000 refunds/day;
- $25,000 vendor payments/week.

Use:

```ts
interface UsageLimit {
  meter: string;

  limit: string;

  windowSeconds: number;
}
```

Initially limits remain attached to runtime-token policy.

The model must leave room for future scopes such as:

```ts
type UsageLimitScope = "token" | "principal" | "connection" | "runtime";
```

RFC 0001 only requires token scope.

---

# Meter definitions

Action manifests declare how requests generate measurable usage.

Example:

```ts
interface MeterDefinition {
  name: string;

  kind: "count" | "money" | "numeric";

  path?: string;

  amountPath?: string;

  currencyPath?: string;

  amountEncoding?: "minor_units";
}
```

Example refund action:

```ts
{
  name: "refund_value",
  kind: "money",
  amountPath: "/amount",
  currencyPath: "/currency",
  amountEncoding: "minor_units"
}
```

A policy may then say:

```ts
{
  meter: "refund_value:USD",
  limit: "100000",
  windowSeconds: 86400
}
```

meaning:

> Maximum $1,000 USD in refunds per rolling 24 hours.

---

# Money semantics

Money authorization MUST NOT depend on JavaScript floating-point values.

Canonical money values use:

```text
integer minor units + currency
```

Examples:

```text
10000 USD minor units = $100.00
```

Currencies are not implicitly convertible.

A USD budget does not authorize EUR spend.

FX-aware aggregate budgets are deferred.

---

# Atomic budget enforcement

Budget enforcement MUST NOT be implemented by counting successful run-log records immediately before execution.

That design permits concurrency races.

Instead use:

```text
reserve → execute → commit/release
```

Flow:

```text
authorization request
        ↓
policy allow
        ↓
calculate meter usage
        ↓
atomic reservation
        ↓
approval required?
   ┌────┴────┐
  yes        no
   ↓          ↓
pending     execute
   ↓
approved
   ↓
revalidate
   ↓
execute
        ↓
provider result
        ↓
commit or release reservation
```

Example:

```text
Daily refund limit: $1,000

Request A reserves $600
Remaining capacity: $400

Request B requests $600
→ denied

Request A succeeds
→ reservation committed
```

---

# Usage reservation storage

Introduce an internal store abstraction:

```ts
interface IUsageReservationStore {
  reserve(input: UsageReservationInput): Promise<UsageReservationResult>;

  commit(reservationId: string): Promise<void>;

  release(reservationId: string): Promise<void>;

  expire(now: string): Promise<number>;
}
```

Implementation may use a dedicated table rather than run-log scans.

Suggested schema:

```sql
CREATE TABLE usage_reservations (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  meter TEXT NOT NULL,
  amount TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  committed_at TEXT
);
```

States:

```text
reserved
committed
released
expired
```

The implementation MUST make limit check + reservation atomic.

---

# Human approval

A policy may require human approval using action patterns initially:

```ts
approvalRequired: string[];
```

Example:

```json
["github.merge_*", "stripe.refund", "cadense.pay_*"]
```

Later this may target action effects or richer conditions.

---

# Approval does not immediately execute

When authorization returns:

```text
require_approval
```

the runtime stores the exact requested intent and returns:

```json
{
  "status": "pending_approval",
  "approvalId": "apr_...",
  "expiresAt": "..."
}
```

The original action is not executed.

---

# Approval records

Migration:

```text
migrations/0011_action_approvals.sql
```

Suggested schema:

```sql
CREATE TABLE action_approvals (
  id TEXT PRIMARY KEY,

  requesting_principal_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  subject_id TEXT,

  action_id TEXT NOT NULL,

  provider_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  resource_id TEXT,

  input_ciphertext TEXT NOT NULL,
  input_digest TEXT NOT NULL,

  policy_snapshot_id TEXT NOT NULL,
  authorization_decision_id TEXT NOT NULL,

  state TEXT NOT NULL,

  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,

  resolved_at TEXT,
  resolved_by_principal_id TEXT,
  resolution_reason TEXT,

  execution_grant_id TEXT,
  run_id TEXT
);
```

Stored input is encrypted at rest using the existing credential encryption mechanism.

---

# Approval input binding

Before approval storage, canonicalize the authorization-critical request and calculate:

```text
SHA-256(canonical authorization request)
```

Persist as:

```text
input_digest
```

The eventual execution grant is bound to that digest.

Changing:

- action;
- resource;
- connection;
- input;
- critical principal identity;

invalidates the grant.

---

# Approval state machine

Use:

```text
pending
    │
    ├── denied
    ├── expired
    ├── cancelled
    │
    ↓
approved
    ↓
executing
    │
    ├── execution_failed
    ↓
executed
```

State transitions MUST be atomic.

Only one execution may consume an approval.

---

# Approval endpoints

Console-authenticated:

```text
GET /api/approvals?state=pending
```

Returns approvals visible to the authenticated console principal.

```text
POST /api/approvals/:id/approve
```

Does **not** call the provider directly.

Instead it:

1. atomically transitions `pending → approved`;
2. records the human resolver;
3. creates a single-use execution grant;
4. enqueues or resumes execution.

```text
POST /api/approvals/:id/deny
```

Transitions:

```text
pending → denied
```

and requires an optional human-readable reason.

Future RFC 0002 roles may restrict who may resolve which approval.

---

# Execution grants

Approval creates:

```ts
interface ExecutionGrant {
  id: string;

  authorizationDecisionId: string;

  approvalId: string;

  requestDigest: string;

  principalId: string;

  actionId: string;

  expiresAt: string;

  consumedAt?: string;
}
```

Execution grants are:

- short-lived;
- single-use;
- non-transferable;
- bound to one authorization request.

---

# Reauthorization at execution time

Approval may take minutes or hours.

The environment can change before execution.

Therefore execution MUST revalidate hard security conditions.

Example:

```text
10:00 request
10:10 human approval
10:11 admin revokes Stripe access
10:12 worker resumes
```

The action must not execute.

Execution flow:

```text
verify grant
    ↓
verify exact request digest
    ↓
verify grant not expired
    ↓
verify grant not consumed
    ↓
re-evaluate current hard-deny policy
    ↓
verify resource/credential still authorized
    ↓
reconfirm or recreate usage reservation
    ↓
atomic grant consume
    ↓
execute
```

Approval satisfies:

```text
require_approval
```

It does not freeze the entire security state forever.

---

# Principal identity

`RunLog` currently receives token-derived metadata.

Introduce a stable principal identity.

At minimum:

```ts
interface AgentPrincipal {
  id: string;

  label?: string;
}
```

`RuntimeTokenRecord` gains:

```ts
principalId: string;
subjectId?: string;
```

A human-readable token label may remain.

Example:

```text
Principal:
agt_invoice_collector

Token:
tok_4Qx...

Label:
"prod-invoicing-agent"
```

The label is display metadata.

Policies and audit records reference the stable principal ID.

---

# Delegation metadata

RFC 0001 does not introduce agent-created delegation grants.

It does persist delegation metadata when supplied by trusted runtime paths.

Run context should support:

```ts
delegatedBy?: string;
delegationChain?: string[];
```

This avoids a future identity-model rewrite when sub-agents are introduced.

Future delegation rules MUST enforce:

```text
child authority ⊆ parent authority
```

---

# Authorization evidence

Run logs answer:

> What executed?

They are not sufficient to answer:

> Why was it authorized?

Introduce a first-class authorization decision record.

Suggested interface:

```ts
interface AuthorizationEvidence {
  decisionId: string;

  requestId: string;

  principalId: string;
  tokenId: string;
  subjectId?: string;
  delegatedBy?: string;

  actionId: string;

  providerId: string;
  connectionId: string;
  resourceId?: string;

  effect: "allow" | "deny";

  inputDigest: string;

  matchedPolicyIds: string[];
  policySnapshotId: string;

  reasons: AuthorizationReason[];

  obligations: AuthorizationObligation[];

  approvalId?: string;
  executionGrantId?: string;

  usageReservationIds?: string[];

  runId?: string;

  createdAt: string;
}
```

Sensitive input is not copied into authorization evidence.

Use digests and structured safe metadata.

---

# Policy snapshots

A decision should remain explainable even after policy changes.

Every authorization decision therefore references:

```text
policySnapshotId
```

A policy snapshot records the exact versions of applicable policies.

Example:

```json
{
  "deployment": "pol_dep_12:v4",
  "runtime": "pol_runtime_22:v7",
  "token": "pol_token_94:v3"
}
```

RFC 0001 does not require full historical policy restoration in the console, but storage must preserve enough version identity to reconstruct which rules were evaluated.

---

# Run-log identity

`RunLog` in:

```text
src/server/storage/runtime-store.ts
```

gains:

```ts
principalId?: string;
tokenId?: string;
subjectId?: string;
authorizationDecisionId?: string;
```

`agentLabel` may remain as display metadata if useful, but stable identity uses `principalId`.

Migration:

```text
0012_run_log_identity.sql
```

`RunLogListInput` gains:

```ts
principalId?: string;
tokenId?: string;
authorizationDecisionId?: string;
```

This lets the console pivot from:

> Show all calls.

to:

> Show every action this agent performed under this authority.

---

# Enforcement boundary

Create one internal execution path.

Conceptually:

```ts
executeAuthorizedAction(request);
```

All action invocation paths MUST converge here.

That includes:

- REST action execution;
- MCP tool calls;
- provider proxy calls;
- approval resumptions;
- retries;
- internal agent calls;
- future scheduled triggers.

The provider proxy is therefore explicitly **in scope** for authorization enforcement.

There must not be a proxy route capable of bypassing policy.

---

# Execution lifecycle

The canonical lifecycle becomes:

```text
authenticate
    ↓
resolve principal
    ↓
resolve action manifest
    ↓
resolve resource
    ↓
schema-validate input
    ↓
authorize
    ↓
write authorization decision
    ↓
DENY?
    │
    └── return
    ↓
reserve usage
    ↓
approval required?
    │
    ├── yes → store pending approval → return
    │
    └── no
    ↓
issue execution grant
    ↓
execute provider action
    ↓
commit / release usage
    ↓
write run result
    ↓
link run ↔ authorization decision
```

---

# Error codes

Add structured policy error codes:

```ts
type PolicyErrorCode =
  | "action_not_allowed"
  | "resource_not_allowed"
  | "input_constraint_violation"
  | "usage_limit_exceeded"
  | "approval_required"
  | "approval_expired"
  | "approval_denied"
  | "execution_grant_invalid"
  | "execution_grant_expired"
  | "execution_grant_consumed";
```

Use HTTP status according to transport semantics.

Examples:

```text
403 action_not_allowed
403 input_constraint_violation
429 usage_limit_exceeded
```

Approval-required requests are not errors at the business level and return an explicit pending state.

---

# API surface changes

Existing token policy endpoint:

```text
PUT /api/tokens/:id/policy
```

accepts additive fields:

```ts
interface TokenPolicyInput {
  allowedActions?: string[];
  blockedActions?: string[];

  constraints?: ActionConstraint[];

  usageLimits?: UsageLimit[];

  approvalRequired?: string[];
}
```

Unknown rule kinds MUST fail validation.

Validation lives in:

```text
src/server/api/policy-input.ts
```

Existing wire shapes remain backward-compatible.

Unset fields preserve current behavior.

---

# New policy inspection endpoints

RFC 0001 SHOULD add:

```text
POST /api/policies/simulate
```

Input:

```ts
interface PolicySimulationInput {
  tokenId: string;
  actionId: string;
  connectionId: string;
  resourceId?: string;
  input: unknown;
}
```

Returns the same decision structure as authorization, but performs no reservation, approval creation, or execution.

This becomes the foundation for:

- policy testing;
- console explainability;
- CI policy tests;
- future policy-diff tooling.

---

# Effective-policy inspection

Add:

```text
GET /api/tokens/:id/effective-policy
```

The endpoint returns the composed effective policy and source layers.

Its purpose is to answer:

> What can this token/principal actually do after every policy layer is applied?

Operators should not need to manually reason across multiple JSON documents.

---

# Explainability

Authorization failures should be structured enough for the console to render:

```text
DENIED

Action
✓ gmail.send allowed by deployment policy
✓ gmail.send allowed by runtime policy
✓ gmail.send allowed by token policy

Input constraints
✗ /to violates allowed domain pattern

Decision
input_constraint_violation
```

Do not expose sensitive values when explaining a denial.

---

# MCP integration

Approval resolution remains human-only.

Agents MUST NOT be able to approve their own requests.

MCP may expose a read-only status tool such as:

```text
list_my_pending_authorizations
```

rather than a global:

```text
list_pending_approvals
```

Results are scoped to the requesting principal/token and sanitized.

Where the runtime supports MCP Tasks, the internal approval lifecycle may be surfaced as an asynchronous task abstraction.

The internal authorization model must not depend on MCP Tasks being available.

---

# Console

Add an **Approvals** page.

Each item should display:

- requesting agent;
- originating subject where available;
- action;
- resource;
- human-readable risk summary;
- sanitized input;
- constraint/budget context;
- requesting time;
- expiration;
- applicable policy;
- approve;
- deny.

The console should clearly distinguish:

```text
requested
authorized
executed
```

These are different events.

---

# Authorization history

The console should also support:

```text
Agent → Authorization History
```

showing:

- allowed requests;
- denied requests;
- approvals;
- executions;
- execution failures;
- decision explanations.

This is the beginning of Lens becoming a control plane rather than a connector-management UI.

---

# Storage changes

Expected migrations:

```text
0011_action_approvals.sql
0012_run_log_identity.sql
0013_authorization_decisions.sql
0014_usage_reservations.sql
```

Exact migration numbering may change to match repository state.

---

# Security notes

## Fail closed

Any policy-evaluation exception denies authorization.

---

## Sensitive input

Approval input is encrypted at rest.

Authorization logs store:

- request digest;
- safe metadata;
- policy results;

rather than raw secrets.

---

## Runtime tokens cannot approve

Approval endpoints require console authentication.

Runtime-token credentials are never sufficient to resolve approvals.

---

## Unknown action manifests

If an action lacks optional manifest metadata, existing action-based policy may still operate.

If a policy depends on a meter/effect that the action does not define, authorization fails closed.

---

## Idempotency

Actions marked:

```ts
idempotency.required = true;
```

must receive or generate an idempotency key before execution.

Approved execution retries must reuse the original logical execution identity.

---

## Approval replay

Execution grants are single-use.

Atomic consumption occurs before provider invocation.

Retries after ambiguous provider failure use the run's idempotency semantics, not a second approval grant.

---

## Time

All authorization timestamps use UTC.

Budget and approval calculations use server-controlled time.

Caller-supplied timestamps are never trusted for enforcement.

---

# Rollout

Ship in four independently useful phases.

---

## Phase 1 — Authorization request model + constraints

Implement:

- stable `principalId`;
- resource model;
- `AuthorizationRequest`;
- `AuthorizationDecision`;
- deterministic policy composition;
- argument constraints;
- policy simulation;
- structured decision reasons.

Primary files:

```text
src/core/action-policy.ts
src/core/action-policy.test.ts
src/server/api/policy-input.ts
```

No current deployment changes behavior until new policy fields are configured.

---

## Phase 2 — Authorization evidence + run identity

Implement:

- authorization-decision storage;
- policy snapshot IDs;
- run-log identity;
- decision ↔ run linkage;
- console history filters.

Goal:

> Every action can be attributed to a stable principal and an explicit authorization decision.

---

## Phase 3 — Usage meters

Implement:

- action meter declarations;
- usage limits;
- atomic reservation store;
- reserve/commit/release lifecycle;
- HTTP 429 handling;
- provider-proxy enforcement.

Goal:

> Quantitative authority remains correct under concurrency.

---

## Phase 4 — Human approvals

Implement:

- approval store;
- encrypted immutable intent;
- input digest;
- approval state machine;
- execution grants;
- approve/deny APIs;
- execution revalidation;
- MCP status surface;
- Approvals console page.

Goal:

> High-risk actions can pause for human authorization without granting the agent approval authority.

---

# Verification

Testing must cover policy correctness, race conditions, state transitions, and bypass resistance.

---

## Unit tests

For each constraint type:

- valid value;
- invalid value;
- missing required path;
- missing optional path;
- malformed input;
- wildcard action match;
- layered-policy composition.

---

## Resource tests

Verify:

```text
same action + allowed connection → allowed
same action + denied connection → denied
```

---

## Principal tests

Verify:

- token resolves correct principal;
- token rotation preserves principal identity;
- revoked token fails;
- delegation metadata is recorded;
- child policy cannot widen parent authority when delegation enforcement lands.

---

## Budget tests

Test:

- exact window edge;
- reservation;
- commit;
- release;
- expiration;
- multiple currencies;
- concurrent attempts.

Required concurrency test:

```text
limit: 10
current committed: 9

two concurrent requests each reserve 1

exactly one succeeds
```

---

## Approval state tests

Test every valid and invalid transition:

```text
pending → approved
pending → denied
pending → expired
approved → executing
executing → executed
executing → execution_failed
```

Verify duplicate approval resolution cannot create duplicate executions.

---

## Approval binding test

Request:

```json
{
  "amount": 10000
}
```

Approve.

Attempt execution with:

```json
{
  "amount": 10001
}
```

Expected:

```text
execution_grant_invalid
```

---

## Policy-change-after-approval test

1. request authorized subject to approval;
2. human approves;
3. administrator adds a hard deny;
4. worker resumes;
5. execution must fail authorization.

---

## End-to-end test

Token policy:

```json
{
  "approvalRequired": ["github.*"]
}
```

Flow:

```text
request
→ authorized with approval obligation
→ pending approval
→ human approve
→ execution grant
→ policy revalidation
→ execution
→ run log
→ authorization evidence
```

Run against both:

- SQLite store;
- D1 store.

---

## Bypass test

Verify the same policy applies when the action is invoked through:

- normal REST execution;
- MCP;
- provider proxy;
- approval resume.

---

## Commands

Required:

```text
npm run fix-check
npm test
```

All new migrations must pass both SQLite and D1 test environments.

---

# Alternatives considered

## Full policy language now

Options considered:

- Cedar;
- CEL;
- JSON Logic;
- Rego/OPA.

Rejected for RFC 0001.

The immediate problem is not insufficient syntax.

It is missing authorization primitives:

- principal;
- resource;
- delegation;
- constraints;
- usage meters;
- obligations;
- evidence.

Introducing a broad expression language before these concepts stabilize increases attack surface and policy complexity.

The rule union remains extensible.

A later RFC may introduce an expression-backed condition model.

---

## Run logs as budget counters

Rejected.

Run logs are audit infrastructure.

They do not provide atomic reservations and are vulnerable to concurrent overspend.

---

## Approval endpoint executes provider call synchronously

Rejected.

Approval and execution are different trust boundaries.

Approval should mint authorization to execute.

A worker/runtime consumes that authorization.

---

## Approval long-poll

Rejected.

Approvals may take minutes or hours.

The system should expose durable asynchronous state.

---

## Token ID as agent identity

Rejected.

Tokens rotate.

Principals should remain stable.

---

## Action-only authorization

Rejected.

It cannot distinguish:

```text
same action
different connection
different account
different owner
different authority
```

Resource identity is required.

---

# Future work

RFC 0001 intentionally creates foundations for later capabilities.

Potential future RFCs include:

### Multi-tenancy

Tenant-level principal and resource boundaries.

---

### Delegation grants

Agents explicitly granting narrower authority to child agents.

---

### Intent-scoped authority

Binding actions to a user-approved goal.

Example:

> Pay invoice INV-184.

rather than:

> May use `payments.send`.

---

### Effect-based policies

Examples:

> All `money_movement` actions above $1,000 require approval.

---

### Multi-person approval

Examples:

```text
$10K–$50K → one approver
>$50K → two approvers
```

---

### Risk scoring

Use authorization evidence to detect:

- unusual action frequency;
- new recipient domains;
- abnormal payment destinations;
- novel action sequences.

ML remains advisory until deterministic policy semantics are preserved.

---

### Tamper-evident evidence

Authorization decisions may eventually be hash-chained or written to append-only storage so Lens can provide stronger proof that authority records were not modified after execution.

---

### Policy analysis

Future console tooling should answer:

- which rules are redundant;
- which policies conflict;
- whether a constraint can ever be satisfied;
- what permissions changed between versions;
- which active agents are affected.

---

# Open questions

## 1. Should usage limits initially scope to token or principal?

Implementation simplicity favors token scope.

Security semantics favor principal scope because token rotation must not reset meaningful authority.

Recommendation:

> Ship token scope in Phase 3, but design storage keys so principal scope can follow without migration of the policy model.

---

## 2. Should approved requests preserve their original budget reservation?

For short approvals, preserving the reservation gives stronger guarantees.

For approvals that remain pending for hours, reservations may unnecessarily lock capacity.

Recommendation:

> Give reservations their own expiry. If expired before approval, re-reserve during execution revalidation.

---

## 3. Which policy changes invalidate already approved actions?

Recommendation:

Hard denies, revoked credentials, resource-owner changes, and invalid grants always block execution.

Non-security policy changes may be evaluated according to future policy-version semantics.

RFC 0001 defaults to re-evaluating hard authorization conditions at execution.

---

## 4. Should action manifests be mandatory immediately?

Recommendation:

No.

Make manifests additive initially.

Require them for features that depend on semantic metadata, especially:

- money meters;
- effects;
- idempotency requirements.

Gradually move all actions to explicit manifests.

---

## 5. Should approval resolution require a dedicated role?

Yes eventually.

RFC 0002 should add tenant-scoped authorization such as:

```text
approval.viewer
approval.resolver
approval.admin
```

RFC 0001 continues using existing console authentication.

---

# Success criteria

RFC 0001 is successful when Lens can answer, for every protected action:

> **Who requested this?**

> **On whose behalf?**

> **Using which credential and resource?**

> **What exactly were they trying to do?**

> **Which policies applied?**

> **Which limits were consumed?**

> **Was human authorization required?**

> **Who approved the exact action?**

> **What executed?**

> **Can we prove why it was allowed?**

The resulting system should support a request as specific as:

> A delegated finance agent, acting on behalf of Controller Alice, may use Acme's payment connection to pay invoice `INV-184` for at most `$4,820 USD`, provided the agent remains within its `$25,000/day` payment authority and CFO Bob approves the exact transaction before execution.

That is the boundary between a connector gateway and an agent authorization control plane.

---

# Final principle

Lens should not merely control whether an agent can access a tool.

It should control the **authority under which autonomous software is allowed to affect the outside world**.

The product therefore moves from:

> **Can this agent call this action?**

to:

> **Does this agent possess valid, bounded, explainable authority to perform this exact action, against this exact resource, right now?**

And every execution should leave behind enough evidence to prove the answer.
