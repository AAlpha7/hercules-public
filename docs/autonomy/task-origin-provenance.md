# Task-origin provenance

## Status

Design proposal. This document defines provider-neutral creation provenance for
Hercules tasks. It does not change task authority, execution, review, merge, or
deployment policy.

## Problem

A task currently records useful execution facts such as its adapter and agent
session, while the control-repository commit may identify only a generic
authenticated operator. That cannot reliably answer who requested and created
the task, why it was created, what authorized it, which conversation or
automation caused it, or whether the origin can still be contacted.

Guardian B-016 exposed the gap: Hercules retained the Grok executor but not the
originating Codex conversation that may have requested creation.

## Goals

1. Preserve a small, immutable, auditable explanation of task creation.
2. Support humans, agents, automations, API clients, and future providers.
3. Let a later operator trace or contact an origin when supported.
4. Preserve enough context when the origin is unavailable.
5. Avoid full transcripts, credentials, personal content, and raw provider
   payloads in the control repository.
6. Keep the task body authoritative; provenance explains why the task exists
   but never expands its permissions.

## Separate roles

Hercules must model these roles independently:

- **requester**: the human, policy, task, or event that wanted the work;
- **creator**: the authenticated principal or process that submitted creation;
- **origin**: the conversation, run, workflow, parent task, or triggering event;
- **executor**: the agent session that performs the work;
- **reviewer** and **approver**: the actors that evaluate and authorize;
- **merger/deployer**: the actor and mechanism that changes repository or
  production state.

One actor may hold multiple roles, but Hercules must never infer that creator,
requester, and executor are the same.

## Immutable origin envelope

Every new task should contain a versioned `origin` envelope. Creation writes it
once in the same atomic control-repository commit as the task. Later
availability observations are append-only audit events and do not rewrite the
original claim.

```yaml
origin:
  schema_version: 1
  created_at: RFC3339 timestamp
  creator:
    kind: human | agent | automation | api_client | system
    principal: authenticated Hercules principal
    display_name: optional readable label
    provider: optional provider namespace
    client: codex | grok | claude | scheduler | api | ui | other
  requester:
    kind: human | agent | automation | policy | task | external_event
    display_name: optional readable label
    ref: optional provider-neutral reference
  rationale:
    summary: required concise reason the task exists
    problem: optional problem or decision
    expected_outcome: optional outcome without widening scope
  authorization:
    kind: owner_instruction | approved_plan | parent_task | policy | manual
    ref: optional durable reference
    summary: optional concise authorization statement
  source:
    kind: conversation | agent_run | automation_run | process | task | event | ui
    title: optional readable title
    provider: optional provider namespace
    refs:
      conversation: optional opaque reference
      run: optional opaque reference
      process: optional opaque reference
      parent_task: optional Hercules task id
      trigger_event: optional opaque reference
    capabilities:
      inspect: true | false | unknown
      contact: true | false | unknown
      resume: true | false | unknown
    availability: available | unavailable | expired | redacted | unknown
  extensions:
    provider.namespace: {}
```

Exact field names may change during implementation, but the semantics and role
separation are normative.

## References and provider neutrality

References are opaque values interpreted by provider adapters. Hercules stores
a stable reference and optional readable label, but does not parse meaning from
a provider identifier. A reference may identify a Codex thread, Grok session,
CI run, scheduler process, Hercules parent task, or webhook event.

Provider adapters may expose inspect, contact, or resume operations. The
presence of a reference never promises that an operation is supported or still
available. Provider-specific data belongs under a bounded, namespaced extension
object. The common schema must remain sufficient if a provider is unknown or
removed.

## Why and authorization

The rationale is required and creator-supplied. It answers why the task exists
in one or two sentences; it is not a transcript or second specification.

Authorization is separate. It records the owner decision, policy, approved plan,
or parent task that permitted creation. Missing authorization must be
represented honestly. The task body remains the work contract. Origin metadata
cannot grant network, credentials, protected-path changes, external writes,
merge, deployment, or production authority.

## Contact and graceful degradation

Hercules should calculate actions through provider adapters:

- **Inspect origin** loads a bounded provider summary when authorized.
- **Contact origin** sends a follow-up only when supported and permitted.
- **Resume origin** appears only with a safe provider guarantee.
- **Use handoff** shows preserved rationale and terminal summary when live
  contact is impossible.

Failures append an availability observation such as unavailable or expired;
they do not erase the original reference. The UI must distinguish unsupported,
temporarily unreachable, expired, redacted, and deleted origins.

## Privacy and security

- Never store secrets, tokens, full transcripts, raw prompts, personal message
  bodies, credentials, or arbitrary provider response blobs.
- Treat titles, rationales, and references as potentially sensitive.
- Validate size, encoding, nesting depth, namespace, and identifier syntax.
- Escape displayed fields and never execute provider extension contents.
- Authorize inspect, contact, and resume independently of task read access.
- Redaction preserves role, time, and audit existence while replacing sensitive
  display values with an explicit marker.
- Creation fails closed when required provenance is missing. Legacy import is
  the only explicit `origin: unknown` path.
- Idempotent task creation binds exact origin bytes to the request token; a
  retry with different task or origin bytes is a conflict.

## Data, API, UI, and audit

### Domain and persistence

Add a pure, versioned domain type with validation and normalization. Persist the
origin envelope in task front matter or a losslessly linked control artifact.
The task and origin are created atomically; Git history remains authoritative.
Availability changes are append-only observations with actor, time, prior and
new state, and evidence source.

### API

All creation paths—UI, REST, pipeline, automation, migration, and internal
generation—must submit a normalized origin envelope. Authentication supplies
the creator principal; clients cannot override it. Reject missing rationale,
unsupported versions, malformed or oversized references, creator/auth
mismatches, unknown capability values, and conflicting idempotent retries.

### UI

Task detail should show requested by, created by, creation time, short rationale,
authorization, source title/provider, parent trigger chain, availability, and
only supported actions. The list may show an origin-kind badge. Exact opaque
identifiers belong in an expandable audit view rather than primary phone UI.

### Events and packets

Creation, contact attempts, availability changes, redactions, and migrations are
audit events. Review packets include a concise origin and parent-chain summary,
but verdicts remain based on the task contract and evidence.

## Migration

1. Add schema and parsing in read-compatible mode.
2. Render legacy tasks as origin unknown — predates provenance; never infer
   creator from Operator or executor fields.
3. Require origin in advisory mode and measure every caller.
4. Update all creation paths and add parity tests.
5. Switch to fail-closed after callers are proven.
6. Backfill only facts supported by audit evidence; mark inferred or
   user-supplied history explicitly.
7. Add provider contact adapters separately. Storage must not depend on one
   provider.

## Verification requirements

Implementation must include domain validation and hostile-input tests; atomic
create and idempotency tests; authentication/creator tests; parity tests for all
creation paths; legacy and migration tests; render tests for role separation,
parent chains, availability, and actions; authorization/redaction tests;
provider-contract tests for Codex, Grok, automation, and unknown providers;
restart/history tests proving immutability; and the full Hercules gates and
held-out invariants.

## Recommended implementation task

After this design is merged, create `task-origin-provenance-v1`. Scope it to the
versioned domain schema, atomic persistence, every create API, legacy
compatibility, audit events, task-detail UI, provider-neutral capability
interfaces, and tests. Keep concrete provider contact integrations behind the
interface unless separately proven and authorized.

Acceptance requires:

1. every non-legacy creation atomically records authenticated creator,
   requester, rationale, authorization/source references, and capability state;
2. a B-016-like record distinguishes the Codex origin from the Grok executor;
3. a new conversation can resolve an available origin and request contact
   without receiving raw transcripts;
4. unavailable origins retain an honest handoff and status;
5. origin never expands authority or leaks secrets; and
6. full L1, UI-visible L2, independent review, and Merge Selected pass.

## Non-goals

This design does not centralize provider transcripts, recover deleted threads,
permit ungoverned agent messaging, turn rationale into authorization, or allow
automatic merge or deployment.
