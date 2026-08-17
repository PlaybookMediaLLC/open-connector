# RFC 0003: Durable Triggers and Event Delivery

* **Status:** Draft
* **Author:** Lens
* **Date:** 2026-08-17
* **Priority:** 3 of 3
* **Depends on:** RFC 0001 — Agent Authorization Control Plane
* **Depends on:** RFC 0002 — Multi-Tenant Isolation and Connection Scoping

---

## Summary

Extend Lens from an execute-only runtime into an **event-driven agent runtime**.

Agents should be able to react when the outside world changes without Lens becoming a workflow engine or calling arbitrary agent URLs.

RFC 0003 introduces two event-source primitives:

1. **Inbound webhooks** — external providers push verified events into Lens.
2. **Polling sources** — Lens periodically executes a read-only provider action and converts newly observed or changed items into events.

Both source types produce the same durable event envelope.

Agents consume events through a pull-based queue using:

> **claim → process → execute → acknowledge**

rather than:

> list → hope nobody else processes it → acknowledge.

The core architecture becomes:

```text
External systems
      │
      ├──────── Webhooks
      │
      └──────── Polling
                   │
                   ↓
             Event Sources
                   │
                   ↓
              INGESTION
          verify / poll / dedupe
                   │
                   ↓
          Immutable Event Log
                   │
                   ↓
          Per-Principal Delivery
             lease / retry / ack
                   │
                   ↓
                 Agent
                   │
                   ↓
         RFC 0001 Authorization
                   │
                   ↓
            External Action
                   │
                   ↓
             Run Evidence
                   │
                   └── causation_event_id
```

The runtime remains deliberately **pull-based**.

Lens does not:

* invoke agent processes;
* host arbitrary workflow graphs;
* evaluate user-authored event-to-action code;
* deliver events to callback URLs.

Its job is narrower:

> **Turn external change into durable, tenant-isolated, authenticated, replay-safe facts that authorized agents can consume.**

---

# Motivation

Lens currently answers:

> What may this agent do?

RFC 0001 adds bounded authority.

RFC 0002 establishes whose security boundary that authority belongs to.

But the runtime still lacks an answer to:

> **When should the agent wake up and consider doing something?**

Many valuable agent workflows begin with an external event:

```text
when an invoice becomes overdue

when a payment fails

when an email arrives

when a customer replies

when a GitHub issue opens

when a pull request receives review

when a Slack mention appears

when an account balance changes

when a vendor updates payment details
```

Without triggers, every product integrating Lens must separately build:

* schedulers;
* webhook infrastructure;
* polling loops;
* deduplication;
* cursor management;
* queues;
* retry behavior;
* tenant propagation;
* event retention.

That duplicates infrastructure immediately above the runtime.

Lens should provide the minimum primitive required to make agents reactive:

> **durable external events.**

It should not determine what the agent does with those events.

That remains an agent decision subject to RFC 0001 authorization.

---

# Goals

RFC 0003 establishes:

* durable event sources;
* inbound webhook verification;
* webhook replay protection;
* webhook deduplication;
* polling sources;
* distributed-safe polling leases;
* poll checkpoints;
* immutable event storage;
* event deduplication;
* tenant propagation;
* principal attribution;
* per-principal delivery state;
* visibility leases;
* at-least-once delivery;
* acknowledgment;
* event-to-action causality;
* source-specific safety limits;
* source health;
* provider-independent event envelopes;
* identical SQLite and D1 semantics.

The implementation should work on:

```text
Node / Docker
Fly.io
Cloudflare Workers
```

without changing the event model.

---

# Non-Goals

RFC 0003 does **not** introduce:

* a workflow engine;
* DAGs;
* event-to-action mappings;
* arbitrary event filters;
* event transformation scripts;
* push delivery to consumer URLs;
* arbitrary outbound webhooks;
* exactly-once processing;
* distributed transactions between Lens and providers;
* a general-purpose message broker;
* Kafka compatibility;
* consumer-defined dead-letter queues;
* cross-tenant event sharing;
* cron-expression workflows;
* complex event joins;
* event aggregation;
* event-sourced reconstruction of provider state.

Agents consume events and decide what to do.

Lens stores and delivers them safely.

---

# Core invariants

The event system MUST preserve the following invariants.

---

## 1. Events are immutable facts

Once created, an event payload does not change.

Consumer state never mutates the event itself.

This means:

```text
event
```

and:

```text
delivery / acknowledgment
```

are separate concepts.

---

## 2. Delivery state belongs to the consumer

An event being acknowledged by Agent A must not hide it from Agent B.

Therefore this design does **not** place:

```text
ack_state
acked_by
```

directly on the `events` row.

Each consuming principal receives independent delivery state.

---

## 3. At-least-once means duplicates are possible

An agent may receive the same event more than once.

Consumers must treat event processing as idempotent where side effects matter.

Lens reduces unnecessary duplicate delivery through leases and deduplication but does not claim exactly-once execution.

---

## 4. External event data grants no authority

An event saying:

> "Transfer $10,000."

does not authorize a transfer.

Event payloads are untrusted external data.

Any resulting action still passes independently through RFC 0001.

---

## 5. Tenant scope follows the event for its entire lifetime

The following always agree:

```text
source tenant
    =
event tenant
    =
delivery tenant
    =
consumer tenant
    =
caused run tenant
```

No event crosses RFC 0002 boundaries.

---

## 6. Polling does not create an authorization bypass

A poll source invokes provider actions through RFC 0001.

A scheduled source has no special permission merely because it is scheduled.

---

## 7. Polling actions are read-only

RFC 0003 polling sources MUST NOT schedule actions whose Action Manifest includes mutating effects such as:

```text
write_external_data
external_communication
delete_external_data
money_movement
credential_change
permission_change
code_execution
production_change
```

A poller observes external state.

It does not change it.

---

## 8. Event source IDs are not webhook authentication

Internal resource identity and public webhook routing authority are different concepts.

Webhook ingress uses a separate high-entropy handle that can be rotated independently.

---

## 9. Source configuration and source runtime state are separate

Static configuration does not accumulate:

* cursors;
* seen IDs;
* scheduler leases;
* failure counters.

Mutable execution state lives separately.

---

## 10. Every event-driven action preserves causality

When an event causes an agent action, Lens should be able to reconstruct:

```text
source
  ↓
event
  ↓
delivery
  ↓
agent
  ↓
authorization decision
  ↓
run
```

This is essential for auditability.

---

# Terminology

## Event source

A configured mechanism that produces events.

Kinds:

```text
webhook
poll
```

---

## Event

An immutable record that something externally observable occurred.

---

## Producer

The mechanism responsible for creating an event.

Examples:

```text
verified Stripe webhook

GitHub polling source

future native provider event adapter
```

---

## Consumer

The principal consuming events.

RFC 0003 uses the stable RFC 0001:

```text
principalId
```

as the initial consumer identity.

Token rotation therefore does not replay the entire event stream.

---

## Delivery

Per-consumer state describing:

* whether the event was claimed;
* which lease currently owns it;
* how many times it was delivered;
* whether it was acknowledged.

---

## Lease

A temporary claim giving one worker operating as a principal time to process an event.

If the worker crashes, the lease expires and the event becomes claimable again.

---

## Dedupe key

A stable source-specific identifier used to prevent the same external event from being inserted repeatedly.

---

## Causation event

The event that motivated an agent to perform an action.

Stored as:

```text
causationEventId
```

on authorization/run context.

---

# Architecture

The event runtime consists of five pieces:

```text
1. Event Source Control Plane
2. Ingestion
3. Event Store
4. Delivery Store
5. Scheduler
```

---

# 1. Event source control plane

An event source is tenant-owned configuration.

Conceptually:

```ts
interface EventSource {
  id: string;

  tenantId: string;

  kind: "webhook" | "poll";

  service: string;

  state:
    | "active"
    | "paused"
    | "error"
    | "disabled";

  createdByPrincipalId: string;

  /**
   * Required for poll sources.
   */
  executionPrincipalId?: string;

  configVersion: number;

  createdAt: string;
  updatedAt: string;
}
```

Source configuration is typed by kind.

---

# 2. Event envelope

All source types produce one canonical envelope.

```ts
interface EventEnvelope {
  id: string;

  tenantId: string;
  sourceId: string;

  service: string;

  /**
   * Provider or Lens-defined event type.
   */
  type: string;

  /**
   * Provider-defined event identifier where available.
   */
  externalEventId?: string;

  /**
   * Stable key used for idempotent ingestion.
   */
  dedupeKey: string;

  /**
   * When the external event occurred, if known.
   */
  occurredAt?: string;

  /**
   * When Lens accepted the event.
   */
  receivedAt: string;

  /**
   * Digest of original provider data before normalized storage.
   */
  payloadDigest: string;

  payload: unknown;

  provenance: EventProvenance;
}
```

```ts
type EventProvenance =
  | {
      kind: "webhook";
      verification:
        | "verified"
        | "unverified";
    }
  | {
      kind: "poll";
      principalId: string;
      runId: string;
    };
```

Consumers should receive an explicit trust marker:

```text
external_untrusted
```

for webhook/provider-derived data.

---

# Data model

Expected migration:

```text
0016_events.sql
```

Exact numbering may change to match repository state.

Use four logical tables:

```text
event_sources
event_source_state
events
event_deliveries
```

---

# Event sources table

```sql
CREATE TABLE event_sources (
  id TEXT PRIMARY KEY,

  tenant_id TEXT NOT NULL,

  kind TEXT NOT NULL,
  service TEXT NOT NULL,

  state TEXT NOT NULL,

  created_by_principal_id TEXT NOT NULL,
  execution_principal_id TEXT,

  config_json TEXT NOT NULL,
  config_version INTEGER NOT NULL DEFAULT 1,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`config_json` contains non-secret configuration.

Secrets such as webhook verification keys are stored through the existing encrypted-secret mechanism rather than embedded in plaintext config.

---

# Event source runtime state

Mutable scheduler state belongs separately:

```sql
CREATE TABLE event_source_state (
  tenant_id TEXT NOT NULL,
  source_id TEXT NOT NULL,

  next_run_at TEXT,

  lease_id TEXT,
  lease_expires_at TEXT,

  cursor_json TEXT,

  consecutive_failures INTEGER NOT NULL DEFAULT 0,

  last_attempt_at TEXT,
  last_success_at TEXT,
  last_event_at TEXT,

  last_error_code TEXT,

  updated_at TEXT NOT NULL,

  PRIMARY KEY (tenant_id, source_id)
);
```

This state can change frequently without mutating source configuration.

---

# Events table

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,

  tenant_id TEXT NOT NULL,
  source_id TEXT NOT NULL,

  service TEXT NOT NULL,
  event_type TEXT NOT NULL,

  external_event_id TEXT,

  dedupe_key TEXT NOT NULL,

  occurred_at TEXT,
  received_at TEXT NOT NULL,

  payload_ciphertext TEXT NOT NULL,
  payload_digest TEXT NOT NULL,

  provenance_json TEXT NOT NULL,

  expires_at TEXT NOT NULL,

  UNIQUE (tenant_id, source_id, dedupe_key)
);
```

Important:

> Event payloads are operational customer data, not logs.

They should therefore be encrypted at rest rather than simply run through run-log redaction.

Run logs may record:

* event ID;
* event type;
* digest;

but not duplicate complete event payloads.

---

# Event delivery table

```sql
CREATE TABLE event_deliveries (
  tenant_id TEXT NOT NULL,

  event_id TEXT NOT NULL,

  consumer_principal_id TEXT NOT NULL,

  lease_id TEXT,
  leased_at TEXT,
  leased_until TEXT,

  attempt_count INTEGER NOT NULL DEFAULT 0,

  acked_at TEXT,
  acked_by_token_id TEXT,

  last_released_at TEXT,

  PRIMARY KEY (
    tenant_id,
    event_id,
    consumer_principal_id
  )
);
```

This is why:

```text
Agent A acknowledges event X
```

does not affect:

```text
Agent B
```

---

# Indexes

Expected hot-path indexes:

```sql
CREATE INDEX idx_events_tenant_received
ON events (
  tenant_id,
  received_at
);

CREATE INDEX idx_events_tenant_source_received
ON events (
  tenant_id,
  source_id,
  received_at
);

CREATE INDEX idx_event_deliveries_consumer_ack
ON event_deliveries (
  tenant_id,
  consumer_principal_id,
  acked_at
);

CREATE INDEX idx_event_sources_due
ON event_source_state (
  next_run_at
);
```

SQLite and D1 implementations must have equivalent semantics.

---

# Source management API

RFC 0003 explicitly defines source lifecycle operations.

Authenticated data-plane endpoints:

```text
POST /v1/event-sources
GET  /v1/event-sources
GET  /v1/event-sources/:id
PATCH /v1/event-sources/:id

POST /v1/event-sources/:id/pause
POST /v1/event-sources/:id/resume
DELETE /v1/event-sources/:id
```

Deletion SHOULD initially be soft:

```text
state = disabled
```

Existing events remain available according to retention policy.

---

# Source authorization

Source operations are Lens actions under RFC 0001.

Examples:

```text
events.sources.create
events.sources.read
events.sources.update
events.sources.pause
events.sources.resume
events.sources.delete
```

The resource is:

```text
event_source
```

inside the RFC 0002 tenant.

Agents do not automatically gain trigger creation authority simply because they may execute provider actions.

---

# Webhook sources

A webhook source converts verified inbound provider requests into events.

---

# Public endpoint

Use:

```text
POST /hooks/:hookHandle
```

Do **not** expose:

```text
sourceId
```

as the public ingress credential.

`hookHandle` is:

* high entropy;
* generated by Lens;
* separate from source identity;
* rotatable;
* stored hashed where practical.

Example:

```text
source id:
src_123

public webhook handle:
whk_Nj9X...
```

Rotating the webhook URL does not change the source ID or historical events.

---

# Why source ID and webhook handle differ

The source ID is an internal resource identifier.

The webhook handle is an ingress capability.

Conflating them makes:

* rotation harder;
* accidental disclosure more dangerous;
* authorization semantics ambiguous.

---

# Webhook verification

Webhook verification operates over the **bounded raw request bytes before parsing**.

Verification should be adapter-based.

```ts
interface WebhookVerifier {
  verify(
    request: WebhookVerificationRequest,
    config: WebhookVerificationConfig,
  ): Promise<WebhookVerificationResult>;
}
```

Initial verification kinds may include:

```ts
type WebhookVerificationConfig =
  | {
      kind: "hmac_sha256";
      signatureHeader: string;
      secretRef: string;
      timestampHeader?: string;
      toleranceSeconds?: number;
    }
  | {
      kind: "bearer";
      header: string;
      secretRef: string;
    }
  | {
      kind: "provider";
      provider: string;
      secretRef: string;
    }
  | {
      kind: "none";
    };
```

Provider-specific adapters can later implement schemes such as:

* signed timestamps;
* versioned signatures;
* multiple active signing secrets;
* provider-specific canonicalization.

Unknown verifier kinds fail closed.

---

# Unsigned webhooks

`verification: "none"` is dangerous.

It MAY remain available for providers incapable of authentication, but:

* it must be explicitly configured;
* the console labels it prominently as **UNVERIFIED**;
* the deployment may disable unsigned webhooks entirely;
* strict hosted deployments SHOULD disable them by default;
* a high-entropy `hookHandle` remains required;
* tighter rate limits apply.

The webhook URL itself is not treated as equivalent to a cryptographic provider signature.

---

# Webhook request lifecycle

```text
request arrives
      ↓
resolve hook handle
      ↓
load tenant-bound source
      ↓
enforce body-size cap
      ↓
read bounded raw bytes
      ↓
verify signature/authentication
      ↓
reject?
   ┌──┴───┐
  yes     no
   ↓       ↓
 401     hash raw payload
           ↓
        parse payload
           ↓
       derive metadata
           ↓
       compute dedupe key
           ↓
      insert idempotently
           ↓
       return success
```

Invalid verification writes no event.

---

# Webhook payload limits

Webhook bodies are untrusted.

The endpoint MUST enforce:

* body size cap;
* request timeout;
* per-source rate limit;
* content-type validation where appropriate.

The cap must apply while reading the request rather than after buffering an unbounded body.

---

# Webhook deduplication

Most mature webhook providers retry delivery.

Lens should treat duplicate ingress as normal.

A webhook source MAY define how to identify the external event.

Example:

```ts
type WebhookDedupeConfig =
  | {
      kind: "header";
      header: string;
    }
  | {
      kind: "json_pointer";
      path: string;
    }
  | {
      kind: "provider";
    }
  | {
      kind: "none";
    };
```

If a stable provider event ID exists:

```text
dedupeKey = provider event id
```

Otherwise the source does not falsely claim provider-level deduplication.

Lens still stores:

```text
payloadDigest
```

for evidence.

Do not blindly dedupe all identical payload hashes because two legitimate external events may contain identical bodies.

---

# Duplicate webhook behavior

If the same:

```text
tenant
source
dedupeKey
```

already exists:

* do not insert another event;
* return successful provider acknowledgment;
* do not expose whether the event had already been consumed.

Webhook retries should not become queue duplicates where a stable provider event ID exists.

---

# Webhook replay protection

Where the verifier provides a signed timestamp:

* validate within configured tolerance;
* reject stale signatures;
* compare in constant time where applicable.

Provider event-ID deduplication then protects against valid repeated delivery inside the allowed timestamp window.

---

# Poll sources

Polling is the fallback for providers that cannot push useful events.

A poll source periodically executes an existing provider **read action** and converts selected response items into events.

---

# Poll source configuration

Example:

```json
{
  "action": "github.list_issues",
  "connectionId": "conn_123",

  "input": {
    "repo": "acme/site",
    "state": "open"
  },

  "intervalSeconds": 300,

  "itemsPath": "/items",
  "itemIdPath": "/id",

  "changeDetection": "new_items",

  "eventType": "github.issue.discovered"
}
```

RFC 0003 stores the immutable:

```text
connectionId
```

rather than only a mutable alias.

The original alias may be retained as display metadata.

---

# Why poll sources bind to connection IDs

Suppose a source is configured against:

```text
gmail / default
```

and six months later the alias is changed to another mailbox.

A scheduled source should not silently begin observing a completely different account.

At source creation:

```text
alias
  ↓
resolve tenant connection
  ↓
store connectionId
```

Updating the connection requires an explicit source update and reauthorization.

---

# Poll actions must be safe reads

At source creation, Lens loads the RFC 0001 Action Manifest.

Polling is allowed only if the action contains no mutating effects.

For example:

```text
github.list_issues
```

allowed.

```text
github.merge_pull_request
```

rejected.

```text
gmail.send
```

rejected.

```text
stripe.refund
```

rejected.

A scheduler is not a workflow engine.

---

# Poll principal

Every poll source is bound to a stable:

```text
executionPrincipalId
```

inside its tenant.

The scheduler does not gain deployment-wide provider authority.

Each poll executes as that principal.

---

# Trusted scheduled caller

RFC 0003 requires one narrow additive change to RFC 0001:

authorization must support trusted internal callers such as:

```text
runtime_token
event_source
```

A poll worker should not need an externally usable bearer token.

Conceptually:

```ts
interface AuthorizationCaller {
  kind:
    | "runtime_token"
    | "event_source";

  principalId: string;

  tokenId?: string;
  eventSourceId?: string;
}
```

An `event_source` caller is created only from trusted persisted source state.

An agent cannot assert:

```text
callerKind = event_source
```

through a public API.

---

# Poll authorization

Every poll run executes:

```text
resolve source
      ↓
resolve tenant
      ↓
resolve execution principal
      ↓
resolve connection
      ↓
validate action input
      ↓
RFC 0001 authorize
      ↓
execute provider read
      ↓
write run log
      ↓
derive events
```

If policy later removes the principal's ability to read that resource:

> the poll stops working.

Scheduling does not freeze authorization forever.

---

# Poll causality

Generated events contain poll provenance:

```json
{
  "kind": "poll",
  "principalId": "agt_123",
  "runId": "run_456"
}
```

This allows Lens to reconstruct:

```text
scheduler
   ↓
authorized provider read
   ↓
run
   ↓
events derived from response
```

---

# Poll scheduling

Do not create one unmanaged process-local `setInterval()` per source.

That breaks under:

* multiple replicas;
* restarts;
* rolling deploys;
* Workers;
* failover.

Instead, both Node and Workers use the same **database-backed due-source scheduler**.

---

# Scheduler model

Each source stores:

```text
next_run_at
lease_id
lease_expires_at
```

A scheduler tick:

1. finds due active sources;
2. atomically claims a source lease;
3. executes the poll;
4. updates source state;
5. computes `next_run_at`;
6. releases the lease.

Only one worker may hold the source lease at once.

---

# Node / Fly deployment

`connect-server` starts a lightweight scheduler tick:

```text
every N seconds
    ↓
claim due sources
    ↓
execute
```

The loop does not assume it is the only runtime replica.

Database leases provide exclusivity.

---

# Cloudflare Workers

A `scheduled()` handler calls the same scheduler service.

It:

```text
scans due sources
    ↓
claims leases
    ↓
executes bounded batch
```

No Cloudflare-specific event semantics leak into the storage model.

---

# Scheduler leases

Leases need an expiry because workers can crash.

Example:

```text
source due
   ↓
worker A leases until 10:05
   ↓
worker A crashes
   ↓
10:05 passes
   ↓
worker B may claim source
```

Poll output deduplication prevents duplicated provider observations from producing duplicate events.

---

# Schedule jitter

To avoid thousands of sources polling simultaneously:

```text
next_run_at
```

SHOULD include bounded jitter.

Example:

```text
300-second interval
± 15-second jitter
```

Exact execution timing is not guaranteed.

This is observation infrastructure, not an exact cron scheduler.

---

# Minimum poll interval

The runtime MUST enforce a deployment-configurable minimum interval.

Recommended default:

```text
60 seconds
```

This protects:

* provider rate limits;
* D1/SQLite load;
* worker CPU;
* accidental runaway sources.

---

# Poll failure behavior

Source state tracks:

```text
consecutive_failures
last_error_code
last_attempt_at
last_success_at
```

Failures use bounded exponential backoff.

Example:

```text
normal        5 min
failure 1     5 min
failure 2    10 min
failure 3    20 min
...
```

After a configured threshold, a source may enter:

```text
error
```

and require manual resume/reconfiguration.

A single transient provider error should not permanently disable a source.

---

# Poll state must not live in config

Do not append:

```text
seenIds
cursor
lastRun
```

into `config_json`.

That causes:

* constant configuration rewrites;
* race conditions;
* unbounded document growth;
* poor audit semantics.

Runtime state belongs in:

```text
event_source_state
```

---

# Poll event extraction

A poll response is first schema-validated through the normal provider execution path.

Then the source resolves:

```text
itemsPath
```

to a list.

For each item:

```text
itemIdPath
```

must resolve to a stable identifier.

Missing or malformed IDs fail that poll extraction rather than generating anonymous unstable events.

---

# Change detection

Support two initial modes.

## New items

```json
{
  "changeDetection": "new_items"
}
```

Dedupe key:

```text
item ID
```

One event is emitted per item identity.

---

## Content changes

```json
{
  "changeDetection": "content_hash"
}
```

Dedupe key:

```text
item ID
+
canonical item digest
```

A new event is emitted when the observed representation changes.

This supports polling for:

* new issues;
* status changes;
* changed records;

without storing a giant seen-ID array.

---

# Version paths

Where a provider exposes a stable revision or update ID, a future/additive config may use:

```text
itemVersionPath
```

and derive:

```text
itemId:itemVersion
```

instead of hashing the full item.

---

# Cursor state

Providers that support cursors may persist cursor state in:

```text
event_source_state.cursor_json
```

Cursor state is provider/action-specific.

RFC 0003 does not require a universal pagination protocol.

Reference providers may add cursor adapters where useful.

---

# Event insertion is the dedupe store

Do not maintain a second:

```text
recentSeenIds[]
```

cache merely for event correctness.

The unique constraint:

```text
(tenant_id, source_id, dedupe_key)
```

is the durable source of truth.

Insertion becomes:

```text
insert if new
otherwise ignore
```

This makes polling replay-safe across:

* worker restarts;
* overlapping pages;
* scheduler duplicates;
* delayed retries.

---

# Poll explosion limits

Each source must have server-side safety caps:

```text
max items inspected per poll
max events emitted per poll
maximum response size
minimum interval
maximum concurrent execution = 1
```

A malformed provider response must not create millions of events in one scheduler tick.

---

# Source-specific budgets

RFC 0001 budgets should gain:

```text
event_source
```

as an additional usage scope.

This allows limits such as:

```text
source may execute at most 24 polls/hour

source may consume at most 10,000 provider reads/day
```

Source limits are separate from billing.

They are runaway-execution protection.

Both:

```text
principal limits
```

and:

```text
source limits
```

apply.

The most restrictive result wins.

---

# Event consumption

The original:

```text
GET /v1/events
```

model is insufficient for concurrent agent workers because listing does not claim ownership.

RFC 0003 instead uses **visibility leases**.

Canonical loop:

```text
claim
   ↓
process
   ↓
act
   ↓
ack
```

---

# Claim endpoint

```text
POST /v1/events/claim
```

Example:

```json
{
  "limit": 25,
  "leaseSeconds": 60,
  "sourceIds": [
    "src_123"
  ]
}
```

`sourceIds` is optional.

If omitted, Lens considers sources the principal is authorized to consume.

Response:

```json
{
  "events": [
    {
      "event": {
        "id": "evt_123",
        "sourceId": "src_123",
        "service": "github",
        "type": "github.issue.discovered",
        "occurredAt": "2026-08-17T10:00:00Z",
        "receivedAt": "2026-08-17T10:00:01Z",
        "payload": {
          "...": "..."
        }
      },
      "delivery": {
        "leaseId": "els_123",
        "leasedUntil": "2026-08-17T10:01:01Z",
        "attempt": 1
      }
    }
  ]
}
```

---

# Claim semantics

Claim is atomic.

Two workers acting under the same consumer principal must not simultaneously receive the same active lease.

If the lease expires before acknowledgment:

> the event becomes claimable again.

That is the at-least-once mechanism.

---

# Consumer identity

RFC 0003 uses:

```text
principalId
```

as consumer identity.

This has an important property:

```text
token rotates
```

but:

```text
consumer progress remains
```

because the principal did not change.

A future RFC may add named consumer groups under one principal if needed.

---

# Why acknowledgment is not stored on events

Suppose:

```text
finance-agent
security-agent
```

both need to observe:

```text
vendor.bank_account_changed
```

Finance acknowledging it must not make the event disappear for security.

Therefore:

```text
event = immutable fact

delivery = consumer-specific state
```

---

# Acknowledge endpoint

```text
POST /v1/events/ack
```

Example:

```json
{
  "deliveries": [
    {
      "eventId": "evt_123",
      "leaseId": "els_123"
    }
  ]
}
```

The runtime binds acknowledgment to:

```text
tenant
consumer principal
event
latest lease
```

A principal cannot acknowledge another principal's delivery.

---

# Ack idempotency

Acknowledging an already acknowledged delivery by the same consumer SHOULD succeed idempotently.

A stale lease that has been replaced by another lease may not acknowledge the newer delivery.

---

# Release endpoint

Optionally expose:

```text
POST /v1/events/release
```

for agents that know immediately they cannot process an event.

This clears the current lease and makes the event available for another attempt without waiting for timeout.

It is not a dead-letter operation.

---

# Poison events

RFC 0003 does not implement consumer dead-letter queues.

If an event cannot be handled, the consumer may:

* retry;
* release;
* log the failure and acknowledge it intentionally.

Future consumer policies may add maximum delivery attempts.

---

# Event authorization

Do **not** introduce a second bespoke authorization system such as:

```text
allowedEventSources
```

on tokens.

RFC 0001 already exists.

Use it.

Event operations are authorization actions such as:

```text
events.claim
events.ack
events.release
events.read
```

with:

```text
event_source
```

as the resource.

Example:

> collections-agent may consume source `src_ar_inbox` but not `src_security_alerts`.

That belongs in the same control plane as every other capability.

---

# Multi-source claims

If a principal requests events without explicit source IDs, Lens returns events only from sources the principal is authorized to consume.

Unauthorized sources behave as nonexistent.

RFC 0002 tenant scope is applied before RFC 0001 source authorization.

---

# Event payloads do not bypass policy

Consider:

```json
{
  "type": "invoice.payment_requested",
  "amount": 500000,
  "destination": "..."
}
```

An agent consuming that event still must independently call:

```text
execute_action
```

Any payment action then evaluates:

* principal;
* tenant;
* resource;
* input;
* budget;
* approval;
* current policy;

through RFC 0001.

The event itself grants nothing.

---

# Event-to-action causality

RFC 0003 adds optional causality metadata to RFC 0001 execution context:

```ts
interface AuthorizationContext {
  ...

  causationEventId?: string;
}
```

`RunLog` gains:

```ts
causationEventId?: string;
```

When an agent acts because of an event:

```text
evt_123
```

it should execute with:

```json
{
  "causationEventId": "evt_123"
}
```

Lens verifies that the event belongs to:

* the same tenant;
* a source accessible to the acting principal.

Causation does not increase authority.

It only records why the action happened.

---

# Causal evidence

Lens can then reconstruct:

```text
Event Source
src_123
    ↓

Event
evt_456
    ↓

Delivered to
agt_collections
    ↓

Authorization
dec_789
    ↓

Action
gmail.send
    ↓

Run
run_012
```

This is enormously important for enterprise audit.

Instead of:

> Why did the agent send this email?

Lens can answer:

> It consumed provider event `evt_456`, evaluated policy `pv_7`, received authorization decision `dec_789`, and executed run `run_012`.

---

# Idempotency for event-driven side effects

At-least-once event delivery creates an important failure case:

```text
agent receives event
      ↓
agent executes external action
      ↓
external action succeeds
      ↓
agent crashes before ack
      ↓
event redelivered
```

Therefore event-driven actions SHOULD use deterministic idempotency.

For example:

```text
event ID
+
logical action step
```

might produce:

```text
evt_123:send_customer_reply
```

as the execution idempotency key.

RFC 0001 action manifests already support declaring when idempotency is required.

The runtime should make:

```text
causationEventId
```

easy to incorporate into that mechanism.

Exactly-once event delivery is not required to achieve effectively-once provider side effects where the provider/action supports idempotency.

---

# Webhook events and prompt injection

Webhook payloads may contain attacker-controlled natural language.

Examples:

```text
email body
GitHub issue
Slack message
support ticket
```

Lens stores these as:

```text
external_untrusted
```

data.

It never:

* interprets them as Lens policy;
* templates them automatically into provider calls;
* executes instructions contained inside them.

Agent applications remain responsible for treating event content as untrusted input.

---

# Payload storage

Do not reuse run-log redaction as the primary event storage strategy.

Event data is functional data.

If Lens strips arbitrary fields from:

```text
email.received
```

the agent may be unable to do its job.

Instead:

1. cap payload size;
2. remove known secrets where provider adapters identify them;
3. encrypt operational payload at rest;
4. authorize access;
5. prevent payload duplication into ordinary logs.

The API decrypts payload only for an authorized consumer.

---

# Event retention

Event retention is independent of delivery acknowledgment.

Because multiple consumers may exist, there is no meaningful global:

```text
acked
```

state.

Each event has:

```text
expires_at
```

based on deployment retention configuration.

Retention may reuse the infrastructure/pattern established for run-log retention.

---

# Retention behavior

Recommended semantics:

```text
events
→ retained for configured window
→ deleted after expires_at
```

Delivery rows may be removed when their parent event expires.

Acknowledgment does not guarantee immediate deletion.

This allows multiple principals to consume the same event independently.

---

# Lag semantics

A principal that does not consume an event before retention expiry loses that event.

Lens does not promise infinite backlog storage.

Future enterprise retention tiers may increase the window.

---

# Webhook source health

Track operational state such as:

```text
last webhook received
last verified webhook
verification failures
rate-limit drops
duplicate deliveries
events emitted
```

Do not store complete invalid webhook payloads merely for debugging.

---

# Poll source health

Track:

```text
last attempt
last success
next run
consecutive failures
last error
last event emitted
events emitted
average poll duration
```

This becomes visible in the console.

---

# Event source state

Suggested source states:

```text
active
paused
error
disabled
```

Semantics:

### active

Eligible for ingestion/polling.

### paused

Configuration retained, scheduled polling suspended.

Webhook behavior while paused should reject or acknowledge-without-ingestion according to implementation policy; recommendation: return a non-success status that encourages provider retry only when pause is short-lived. Otherwise disable explicitly.

### error

Runtime detected repeated source failure requiring attention.

### disabled

Source intentionally retired.

No new events accepted or generated.

Historical events remain until retention expiry.

---

# Source configuration updates

Changing security- or identity-sensitive fields requires explicit authorization.

Examples:

```text
connectionId
executionPrincipalId
verification mode
verification secret
poll action
poll input
interval
```

Updates increment:

```text
configVersion
```

Existing generated events remain tied to the source ID.

---

# Verification secret rotation

Webhook verification credentials must be rotatable independently from source identity.

Support a transition where two secrets may temporarily verify:

```text
current
previous
```

for providers that rotate signing secrets with overlap.

After the grace period:

```text
previous
```

is removed.

Secrets are never returned by read APIs after creation.

---

# Webhook handle rotation

Provide:

```text
POST /v1/event-sources/:id/rotate-hook
```

for webhook sources.

Rotation:

1. creates a new ingress handle;
2. invalidates the old handle after configured cutover behavior;
3. does not change source ID;
4. does not alter existing events.

---

# Poll source checkpoints

Polling should support a provider cursor where available.

Checkpoint updates occur only after successful event derivation/insertion.

Do not advance the cursor before durable event creation.

Conceptually:

```text
provider response
      ↓
derive events
      ↓
persist events
      ↓
persist next cursor
```

This avoids losing observations after crashes.

---

# Atomicity

Where storage permits, event insertion and checkpoint advancement SHOULD occur transactionally.

If complete transactionality is unavailable across operations, ordering must prefer duplicate work over lost events.

Correct failure mode:

> poll repeats and deduplication suppresses duplicates.

Incorrect failure mode:

> cursor advances and events disappear forever.

---

# Scheduler concurrency

Multiple Lens replicas may run scheduler ticks simultaneously.

Therefore source acquisition must behave like:

```text
claim source lease atomically
      ↓
execute once per lease
```

not:

```text
SELECT due sources
      ↓
all replicas execute all sources
```

Even though event dedupe protects correctness, duplicate provider calls:

* waste budgets;
* hit provider limits;
* create unnecessary load.

---

# Scheduler fairness

A tenant with thousands of due sources must not permanently starve other tenants.

Initial scheduler implementation SHOULD:

* cap sources processed per tick;
* avoid one tenant consuming the entire batch;
* order approximately by `next_run_at`.

Sophisticated fair queuing is future work.

---

# API surface

## Source management

```text
POST   /v1/event-sources
GET    /v1/event-sources
GET    /v1/event-sources/:id
PATCH  /v1/event-sources/:id
DELETE /v1/event-sources/:id

POST /v1/event-sources/:id/pause
POST /v1/event-sources/:id/resume

POST /v1/event-sources/:id/rotate-hook
```

All require runtime authentication and RFC 0001 authorization.

Tenant scope comes from RFC 0002.

---

## Provider ingress

```text
POST /hooks/:hookHandle
```

No runtime-token authentication.

Trust comes from:

```text
hook routing capability
+
configured provider verification
```

The endpoint exposes no:

* catalog;
* connection data;
* action execution;
* tenant selection.

---

## Consumption

```text
POST /v1/events/claim
POST /v1/events/ack
POST /v1/events/release
```

Optional read-only inspection:

```text
GET /v1/events/:id
```

All consumption endpoints use runtime-token authentication, tenant isolation, and RFC 0001 authorization.

---

# MCP

MCP gains thin wrappers:

```text
claim_events
ack_events
release_events
```

Optionally:

```text
get_event
```

Do not expose tenant arguments.

Do not expose global event queues.

The agent loop becomes:

```text
claim_events
      ↓
inspect event
      ↓
decide
      ↓
execute_action(
  causationEventId = event.id
)
      ↓
ack_events
```

---

# No automatic event-to-action execution

RFC 0003 deliberately does not add:

```text
when X → execute Y
```

inside Lens.

Why?

Because that is the beginning of a workflow engine.

Instead:

```text
event
  ↓
agent
  ↓
decision
  ↓
RFC 0001
  ↓
action
```

This preserves the architecture:

> Lens governs authority and infrastructure.

> Agents provide reasoning.

---

# Tenant isolation

RFC 0002 applies to every new record:

```text
event_sources
event_source_state
events
event_deliveries
```

Webhook ingestion does not accept tenant ID from the provider.

Instead:

```text
hookHandle
    ↓
source
    ↓
tenantId
```

Tenant is derived from trusted persisted source configuration.

---

# Cross-tenant webhook isolation

Knowing another tenant's internal:

```text
sourceId
```

does not provide ingress ability.

Knowing another tenant's event ID does not provide read ability.

The public webhook handle contains sufficient entropy to resist enumeration and remains separate from internal resource IDs.

---

# Async tenant propagation

Poll workers reconstruct their scoped store through:

```ts
runtimeStore.forTenant(source.tenantId)
```

No scheduler execution occurs in a tenant-neutral store context after source resolution.

---

# Event-source policy boundaries

A poll source has four independent security controls:

```text
1. Tenant boundary
2. Execution principal
3. RFC 0001 provider-action policy
4. Source-specific safety limits
```

Scheduling never overrides any of them.

---

# Observability

Internal traces/logs SHOULD include:

```text
tenant_id
source_id
event_id
principal_id
run_id
causation_event_id
```

where applicable.

Do not put full event payloads into ordinary application logs.

---

# Metrics

Useful aggregate metrics:

```text
events_ingested_total
webhook_verification_failures_total
webhook_duplicates_total

poll_runs_total
poll_failures_total
poll_duration

event_claims_total
event_redeliveries_total
event_acks_total

event_lag
source_error_count
```

Avoid unbounded tenant/source IDs as default metric labels.

Use structured logs/traces for high-cardinality investigation.

---

# Backpressure

The runtime MUST protect itself from unbounded event growth.

At minimum:

* source ingress rate caps;
* payload byte caps;
* poll response caps;
* events-per-poll caps;
* per-claim batch limits;
* retention;
* scheduler batch limits.

Future tenant quotas may add:

```text
maximum retained events
maximum event bytes
maximum webhook requests/day
```

but billing remains out of scope.

---

# Error codes

Add event-specific error codes:

```ts
type EventErrorCode =
  | "event_source_not_found"
  | "event_source_paused"
  | "event_source_disabled"
  | "event_source_invalid"
  | "webhook_verification_failed"
  | "webhook_payload_too_large"
  | "poll_action_not_read_only"
  | "poll_execution_denied"
  | "poll_extraction_failed"
  | "event_not_found"
  | "event_lease_conflict"
  | "event_lease_invalid";
```

Cross-tenant object access continues using RFC 0002 not-found semantics.

---

# Webhook HTTP behavior

Recommended responses:

### Valid new event

```text
202 Accepted
```

### Valid duplicate

```text
200 / 202
```

No new event inserted.

### Invalid verification

```text
401 Unauthorized
```

### Unknown/rotated hook handle

```text
404 Not Found
```

### Oversized payload

```text
413 Payload Too Large
```

### Internal persistence failure

```text
5xx
```

so retry-capable providers may retry.

---

# Ordering

RFC 0003 does not guarantee global event order.

Within a source, events are delivered approximately oldest-first using:

```text
received_at
id
```

but:

* provider retries;
* webhook network delay;
* polling;
* redelivery;

can produce out-of-order observations.

Consumers requiring provider-specific ordering must use provider sequence metadata when available.

---

# Delivery ordering

One unacknowledged event does not block all later events for the consumer.

RFC 0003 is not a strict FIFO queue.

This prevents one poison event from freezing an entire agent.

---

# Security notes

## Webhook input is hostile

Assume payloads can contain:

* malicious text;
* invalid Unicode;
* oversized arrays;
* deep nesting;
* prompt injection;
* fake IDs;
* duplicate events.

All parsing must be bounded.

---

## Signature checks fail closed

Any verifier exception means:

```text
verification failure
```

not:

```text
accept anyway
```

---

## Poll actions are reauthorized every time

Source creation does not permanently grant provider access.

---

## Connection revocation

If a poll source's connection is deleted or revoked:

```text
poll execution stops
source records error
```

It must never fall back to another connection alias automatically.

---

## Principal revocation

If the execution principal loses authority:

```text
poll fails closed
```

---

## Event payloads do not enter provider calls automatically

Lens never converts:

```text
event payload
```

directly into:

```text
execute_action input
```

without an agent explicitly choosing the action.

---

## Acknowledgment is not execution evidence

`acked` means:

> the consumer says it is finished with this event.

It does not mean:

> every attempted action succeeded.

Run/authorization evidence remains separate.

---

# Console

Add an **Events** section with two views.

---

## Sources

Display:

* source name/ID;
* tenant;
* service;
* kind;
* state;
* verification status;
* execution principal;
* connection;
* interval;
* last success;
* next poll;
* last event;
* failure count.

Actions:

```text
pause
resume
rotate webhook handle
edit
disable
```

---

## Event inspector

Display:

* event ID;
* source;
* service;
* type;
* received time;
* occurred time;
* verification/provenance;
* payload;
* payload digest;
* deliveries;
* caused runs.

This creates an important audit path:

```text
event
  ↓
agent actions caused by event
```

---

# Rollout

Ship in four phases.

---

## Phase 1 — Event core + polling

Implement:

* event source schema;
* source runtime state;
* immutable events;
* delivery schema;
* claim/ack/release APIs;
* MCP consumption tools;
* poll source creation;
* read-only Action Manifest enforcement;
* Node scheduler;
* source leases;
* poll deduplication;
* tenant isolation;
* RFC 0001 authorization;
* causation event linkage.

Goal:

> A scheduled provider read can reliably become a durable event consumed by an authorized agent.

---

## Phase 2 — Webhook ingress

Implement:

* public hook handles;
* handle rotation;
* HMAC verification;
* provider verifier registry;
* replay windows;
* webhook deduplication;
* payload caps;
* encrypted event payload storage;
* one reference webhook provider.

Goal:

> Verified provider callbacks produce replay-safe durable events.

---

## Phase 3 — Distributed scheduling

Implement:

* Cloudflare `scheduled()` integration;
* shared scheduler service;
* distributed source leases;
* bounded scheduler batches;
* backoff;
* source health;
* cursor support for reference provider.

Goal:

> Polling behaves identically across Node, Fly replicas, and Workers.

---

## Phase 4 — Console and operational hardening

Implement:

* source management UI;
* event inspector;
* source health;
* caused-run navigation;
* strict unsigned-webhook warnings;
* event retention jobs;
* operational dashboards.

Goal:

> Operators can understand not just that an agent acted, but what external event caused it to act.

---

# Verification

Testing must cover ingestion, deduplication, concurrency, authorization, tenant isolation, leases, and causal evidence.

---

## Poll deduplication test

Fake provider returns:

```text
poll 1:
A B C

poll 2:
B C D
```

`new_items` mode produces exactly:

```text
A
B
C
D
```

once each.

---

# Poll change-detection test

Provider returns:

```text
poll 1:
{id: A, state: open}

poll 2:
{id: A, state: closed}
```

In:

```text
content_hash
```

mode, two events are created.

In:

```text
new_items
```

mode, one event is created.

---

# Scheduler concurrency test

Two runtime workers scan the same due source simultaneously.

Exactly one obtains the active source lease.

The provider action executes once.

---

# Scheduler crash test

1. worker A claims source;
2. worker A crashes;
3. lease expires;
4. worker B claims source;
5. source resumes.

No permanent lock.

---

# Cursor safety test

Simulate:

```text
provider read succeeds
events inserted
process crashes before cursor update
```

Next poll may repeat provider data.

Unique dedupe keys prevent duplicate events.

No events are lost.

---

# Mutation rejection test

Attempt to configure polling source with:

```text
stripe.refund
```

Expected:

```text
poll_action_not_read_only
```

Source is not created.

---

# Policy revocation test

1. poll source created while principal may call `github.list_issues`;
2. policy changed to deny that action;
3. next scheduler run occurs.

Expected:

```text
no provider execution
source records authorization failure
```

---

# Connection substitution test

1. source created against `conn_A`;
2. alias `default` is later changed to `conn_B`;
3. source polls.

Expected:

```text
conn_A
```

continues to be used.

No silent authority migration.

---

# Webhook verification test

Valid signature:

```text
event stored
```

Invalid signature:

```text
401
no event
```

---

# Webhook duplicate test

Same provider event ID delivered three times.

Exactly one event row exists.

All valid deliveries receive successful provider responses.

---

# Webhook replay test

Correct signature with signed timestamp outside tolerance.

Expected:

```text
401
no event
```

---

# Payload-size test

Body exceeding configured maximum:

```text
413
```

without fully buffering payload into memory.

---

# Multi-consumer test

One event exists.

```text
Agent A claims → acknowledges
Agent B claims → still receives event
```

Correct.

---

# Same-consumer concurrency test

Two workers acting as the same principal claim simultaneously.

Only one receives an active lease for a particular event.

---

# Lease expiry test

1. Agent A claims event.
2. Does not ack.
3. Lease expires.
4. Agent A claims again.

Attempt count increments.

---

# Stale acknowledgment test

1. lease `L1` created;
2. expires;
3. event re-leased as `L2`;
4. acknowledgment arrives using `L1`.

Expected:

```text
event_lease_invalid
```

`L2` remains active.

---

# Tenant isolation test

Tenant A and tenant B each have sources and events.

A cannot:

* claim B events;
* read B events;
* ack B deliveries;
* access B sources.

Use both SQLite and D1 stores.

---

# Causality test

1. Agent claims `evt_123`.
2. Agent executes action with:

```text
causationEventId = evt_123
```

3. Run completes.

Verify:

```text
event
→ authorization decision
→ run
```

is queryable.

---

# Cross-tenant causality test

Tenant A attempts:

```text
causationEventId = event from tenant B
```

Expected:

```text
not_found / authorization failure
```

No action executes.

---

# At-least-once side-effect test

Simulate:

```text
provider action succeeds
agent crashes before event ack
```

Event is redelivered.

Action configured with the same idempotency key does not create duplicate external side effects.

---

# Retention test

Expired events are removed according to retention policy.

Associated delivery state is cleaned safely.

Active newer events remain.

---

# Required commands

```text
npm run fix-check
npm test
```

All storage behavior runs against:

```text
SQLite
D1
```

---

# Alternatives considered

## Ack state directly on event row

Rejected.

It makes acknowledgment global.

The first consumer to acknowledge an event would hide it from every other consumer.

Events and delivery state must be separate.

---

## List + ack without visibility leases

Rejected as the canonical queue API.

Two workers can repeatedly process the same pending event concurrently.

Visibility leases provide much better at-least-once behavior for only modest additional complexity.

---

## Push delivery to consumer callbacks

Deferred.

Push requires:

* outbound callback authentication;
* retries;
* retry scheduling;
* callback secret management;
* SSRF protection;
* DNS-rebinding protections;
* delivery dead letters;
* consumer endpoint health.

Pull is enough for agent loops and layers cleanly on the durable event model.

Push can be added later as another consumer transport.

---

## Cloudflare Queues or external broker

Rejected for initial implementation.

A durable database model provides:

* SQLite parity;
* D1 parity;
* local development;
* simple operations.

The canonical event envelope and delivery abstractions should remain independent enough that high-volume deployments can later move delivery to a broker.

---

## Seen IDs stored in source config

Rejected.

It mixes mutable runtime state with configuration, grows indefinitely, and creates race conditions.

Durable dedupe keys plus unique constraints solve the problem more cleanly.

---

## One process-local interval per source

Rejected.

It fails under multiple replicas and restart/failover.

Database-backed due times and leases work across deployment environments.

---

## Polling by connection alias at runtime

Rejected.

Alias retargeting could silently move a scheduled source to another provider account.

Resolve the alias once and store immutable connection identity.

---

## Poll actions may mutate external state

Rejected.

A trigger is an observation primitive.

Automatically repeated mutations belong to a workflow/scheduler system, not RFC 0003.

---

## `allowedEventSources` inside token policy

Rejected.

RFC 0001 already provides resource-aware authorization.

Event consumption should not introduce a parallel policy language.

---

## Treat webhook source ID as authentication

Rejected.

Internal IDs and public ingress capabilities have different security lifecycles.

Use a separate rotatable high-entropy hook handle.

---

## Store event payloads using run-log redaction

Rejected as the primary model.

Event payloads are operational data required by consumers.

They require:

* encryption;
* access control;
* secret sanitization;

not indiscriminate log redaction.

---

# Open questions

## 1. Should claim support long-polling?

Potential API:

```json
{
  "waitSeconds": 20
}
```

Recommendation:

Defer initially.

Visibility leases solve correctness.

Long-polling is an efficiency optimization and can be added without changing storage semantics.

Node deployments may benefit significantly; Workers execution limits should be evaluated separately.

---

## 2. Should poll sources have source-specific budgets?

Yes.

Recommendation:

Add `event_source` as an RFC 0001 usage-limit scope.

A runaway scheduler should be containable independently from the principal's other activity.

---

## 3. Should named consumer groups exist in RFC 0003?

Recommendation:

No initially.

Use:

```text
principalId
```

as durable consumer identity.

If one principal later needs multiple independent processing streams, introduce explicit named consumer groups without changing event rows.

---

## 4. Should webhook payloads preserve the exact raw bytes?

Recommendation:

Store:

```text
payload digest
+
normalized encrypted payload
```

initially.

Exact encrypted raw-body preservation may be useful for certain providers or audit requirements, but it increases storage and sensitive-data retention.

Add it only where required.

---

## 5. Should event source configuration be revisioned?

Recommendation:

Persist at least:

```text
configVersion
updatedBy
updatedAt
```

now.

Full historical configuration snapshots can follow if enterprise audit requirements demand them.

---

## 6. Should an error source retry automatically?

Recommendation:

Transient failures use exponential backoff.

After a configurable consecutive-failure threshold, move the source to:

```text
error
```

and require explicit operator or authorized-agent intervention.

This prevents permanently broken pollers from running forever.

---

## 7. Should polling support provider webhooks and polling simultaneously for the same logical event?

Yes, but deduplication across different sources is intentionally not solved in RFC 0003.

Deduplication is source-local.

Cross-source semantic reconciliation belongs at the application/agent layer or a future normalized-event layer.

---

# Future work

RFC 0003 intentionally creates foundations for later capabilities.

---

## Push consumers

Durable event delivery to customer callbacks.

---

## Named consumer groups

Multiple independent processing streams under one principal.

---

## Event filters

Server-side filtering by trusted declarative predicates.

Not arbitrary executable code.

---

## Normalized provider events

Provider adapters mapping raw events into canonical types such as:

```text
payment.failed
invoice.paid
message.received
issue.created
```

---

## Native provider subscriptions

Automatically register/remove provider webhooks as source lifecycle changes.

---

## Event replay

Authorized consumers intentionally replay historical events.

---

## Dead-letter policies

Consumer-specific delivery-attempt limits and failure inspection.

---

## Broker-backed delivery

Use:

* Cloudflare Queues;
* Kafka;
* another durable broker;

behind the existing event/delivery abstractions for higher scale.

---

## Event-triggered tasks

If future Lens architecture includes durable task objects, an event may create a task while preserving:

```text
event → task → authorization → execution
```

causality.

---

## Event-based risk policy

RFC 0001 may later use historical event/run data to detect unusual execution patterns.

Deterministic policy remains the hard authorization boundary.

---

# Success criteria

RFC 0003 is successful when Lens can safely support:

```text
External change
      ↓
Durable event
      ↓
Correct tenant
      ↓
Authorized agent
      ↓
At-least-once delivery
      ↓
Agent decision
      ↓
RFC 0001 authorization
      ↓
External action
      ↓
Auditable causal chain
```

without:

* calling arbitrary agent URLs;
* introducing a workflow engine;
* relying on process-local schedulers;
* using global event acknowledgment;
* bypassing authorization;
* losing tenant scope;
* silently changing provider accounts;
* losing events during cursor advancement;
* treating external event contents as trusted instructions.

The runtime should be able to answer:

> **What happened?**

> **How did Lens learn about it?**

> **Was the producer verified?**

> **Which tenant owns the event?**

> **Which agent consumed it?**

> **Was it delivered more than once?**

> **What action did the agent take because of it?**

> **Was that action separately authorized?**

> **Can we reconstruct the complete chain afterward?**

---

# Final principle

RFC 0001 answers:

> **May this agent act?**

RFC 0002 answers:

> **Inside whose authority boundary may it act?**

RFC 0003 answers:

> **What external change caused the agent to consider acting in the first place?**

Together they create the foundation:

```text
EVENT
  ↓
IDENTITY
  ↓
TENANT
  ↓
DECISION
  ↓
AUTHORITY
  ↓
EXECUTION
  ↓
EVIDENCE
```

Lens should not become a workflow engine.

It should become the trusted runtime underneath workflow engines and autonomous agents:

> **External systems produce facts. Agents interpret those facts. Lens controls whether the resulting actions are allowed and preserves evidence connecting cause to effect.**
