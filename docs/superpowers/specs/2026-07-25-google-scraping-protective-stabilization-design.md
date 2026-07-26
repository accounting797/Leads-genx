# Google Scraping Protective Stabilization Design

**Date:** 2026-07-25  
**Status:** User-approved design  
**Scope:** Google Maps discovery from Docker scraper through Google Places, Hybrid handoff, website scanning, persistence, and Nova supervision

## Purpose

Smooth and strengthen the existing Google scraping pipeline without changing the behavior that previous work deliberately established. This is a compatibility-first stabilization pass, not a provider redesign or output-tuning experiment.

The checkpointed balanced pipeline remains canonical. Standard runs continue to execute Docker and Google concurrently. Hybrid runs continue to add Apify while all providers share one ingestion coordinator. Partial businesses and contacts remain durable throughout discovery and website scanning.

## Current Baseline

The focused baseline is green:

- 12 balanced Google/Docker orchestration tests;
- 29 Google Places client tests;
- 7 local Docker scraper client tests.

The current implementation already provides important protections that this work must preserve:

- bounded HTTP calls and polling;
- Docker pre-flight checks;
- 15–20 second active-work heartbeats;
- Google request-attempt accounting;
- breadth-first Google query scheduling;
- isolated provider failure;
- local empty-batch circuit breaking;
- Docker bonus-lane early completion after Google succeeds;
- continuous business/contact persistence;
- shared cross-provider normalization and deduplication;
- resumable local checkpoints;
- role/function query exclusion from Docker;
- cancellation checks and partial-result preservation.

The audit also found a compatibility boundary that needs supervision: the production checkpointed path uses `searchBatch`, while an older fallback path still uses the broader `search` method. Both paths must uphold the same safety and status guarantees even though the canonical path remains unchanged.

## Goals

1. Preserve provider selection, provider ordering, request budgets, query planning, concurrency, and output semantics.
2. Make the canonical and fallback Docker paths follow equivalent bounded polling and status-normalization rules.
3. Make provider settlement, run settlement, resume, and partial-success behavior consistent and testable.
4. Improve Nova’s reporting so it identifies the affected lane, the recovery action, preserved output, and any required operator action.
5. Prevent a slow, failed, or unavailable supplemental lane from holding a productive run open indefinitely.
6. Keep every network operation bounded and every long-running phase visibly alive.
7. Produce a clear implementation and verification trail that Kimi can review from the repository.

## Non-Goals

- No provider replacement or scraper rewrite.
- No changes to Standard or Hybrid provider membership.
- No increase to Google, Apify, or Bright Data spending.
- No changes to the default Google request budget.
- No changes to Docker concurrency, browser pool, depth, radius, or scrape target.
- No new query-expansion rules or location coverage.
- No weakening of quality filtering, deduplication, or email validation.
- No live paid crawl as part of automated verification.
- No migration of Google Maps leads into Sales Navigator lead storage.

## Protected Behavioral Contract

### Provider Composition

- Standard Output starts Docker and Google concurrently.
- Hybrid Max Output starts Docker, Google, and Apify concurrently.
- Google traffic remains direct and does not use scraping proxies.
- Docker remains a bonus discovery lane and must not block useful Google output.
- Apify remains additive and Hybrid-only.

### Query and Budget Semantics

- Role/function searches remain Google-only.
- Docker receives deterministic business-type and category batches.
- Google retains breadth-first coverage before deeper page-token work.
- Every Google HTTP attempt counts against the configured hard budget.
- Key rotation, terminal-key removal, and stop conditions remain unchanged.
- A zero Google budget remains an explicit Google skip.

### Persistence and Identity

- Businesses are persisted as provider pages or batches arrive.
- Website scans are queued through one bounded run-scoped pool.
- Cross-provider reconciliation retains provenance and never replaces populated data with empty values.
- Qualified contacts, raw contacts, companies with qualified email, and duplicate counts remain separate.
- Google Maps leads remain separate from Sales Navigator leads.

### Completion and Recovery

- Completed local checkpoints are not resubmitted on resume.
- Provider failure preserves all previously persisted businesses and contacts.
- Three consecutive empty Docker batches continue to open the local circuit.
- Docker may close early only after Google has completed with output and the configured Docker quiet-grace condition is met.
- Runs may wait for credentials or the scraper only when no successful provider outcome justifies clean completion.
- Cancellation stops new work, drains no unauthorized new work, and preserves completed output.

## Proposed Architecture

### 1. Canonical Polling Contract

Extract or share the local scraper job-status interpretation used by `searchBatch` and the older `search` fallback. The contract will:

- accept the scraper’s supported status casing;
- distinguish success, terminal failure, and non-terminal work;
- tolerate isolated poll transport failures;
- stop after a fixed consecutive-poll-error threshold;
- keep the existing per-request timeout, poll interval, and maximum poll count;
- produce the existing public result shape.

The canonical `searchBatch` behavior will be characterized before refactoring. The fallback path will gain the same safeguards without changing query construction or returned leads.

### 2. Provider Settlement Reconciliation

Keep provider execution concurrent and centralize the final interpretation of provider states. Reconciliation will explicitly cover:

- Google success with Docker failure or unavailability;
- Docker success with Google failure;
- productive provider output with another provider waiting;
- both discovery providers failing before output;
- missing credentials after local circuit opening;
- Hybrid continuation when one provider fails;
- cancellation during discovery or email-queue draining.

The reconciliation layer will not redefine successful output. It will make the existing rules explicit, reusable, and regression-tested.

### 3. Resume and Idempotency Guardrails

Characterization tests will verify:

- completed batches remain skipped;
- retryable batches remain resumable;
- stale `running` checkpoints are handled according to store policy;
- duplicate provider records do not trigger duplicate persisted contacts;
- resumed metrics are rebuilt from durable business/contact state where required;
- terminal provider events are emitted once per logical settlement.

Any implementation change will be limited to confirmed gaps exposed by these tests.

### 4. Nova Supervision Contract

Nova messages and provider state will use concise, actionable facts:

- affected provider;
- current operation or terminal state;
- whether saved output was preserved;
- automatic recovery attempted or performed;
- exact operator action when one is required.

Nova must not:

- imply that a successful run failed because a bonus lane stopped;
- claim Docker output was lost when persisted records remain;
- report an active batch as stalled while fresh heartbeats exist;
- expose credentials, full proxy URLs, raw query text in error diagnostics, or provider response bodies;
- emit repeated alerts for one settled incident.

Provider status and event data remain the source of truth for UI motion and alerts.

### 5. Documentation Consistency

Reconcile stale Google/Docker descriptions in operator documentation with the protected behavior:

- Standard is concurrent Docker plus Google;
- the default Google request budget is 50 unless explicitly configured otherwise;
- Hybrid adds Apify;
- local-first/checkpoint behavior is retained;
- no supplemental lane can hold the run hostage;
- Sales Navigator output remains separate.

Historical approved designs will not be rewritten. Current operator-facing documentation and `docs/AGENT_LOG.md` will describe the active baseline.

## Error Handling

- All fetches keep hard abort timeouts.
- Polling remains finite and strike-tolerant.
- Error messages pass through the existing safe/redacted error handling.
- Provider-specific errors are stored as warnings when another provider has preserved useful output.
- The run fails only when the applicable discovery paths fail before producing usable businesses and no waiting state is more accurate.
- Email scan failures remain isolated to the affected site.
- Heartbeat write failures must not crash an otherwise healthy provider operation.
- No retry loop is unbounded.

## Testing Strategy

Implementation is test-first.

### Characterization and Unit Tests

- shared status parsing across uppercase and lowercase scraper payloads;
- isolated polling failures followed by recovery;
- consecutive polling failures reaching the bounded lane-down threshold;
- finite polling timeout;
- unchanged CSV normalization and max-result behavior;
- explicit provider-state reconciliation combinations;
- resume and completed-checkpoint idempotency;
- preserved output after supplemental-provider failure;
- Nova event content and duplicate-alert prevention;
- secret and query redaction.

### Integration Tests

- Standard continues to launch Google while Docker is active;
- Hybrid continues to share one ingestion coordinator across Docker, Google, and Apify;
- Google attempt counts never exceed budget;
- provider failure does not discard persisted businesses or contacts;
- website scans drain with live heartbeat updates;
- Sales Navigator and Google Maps records remain separated.

### Required Repository Verification

Before every commit:

1. run the complete isolated-database test suite;
2. run the TypeScript production build.

Before completion:

1. repeat the focused Google/Docker tests;
2. repeat the complete isolated-database test suite;
3. repeat the production build;
4. perform a read-only/local Docker health check;
5. perform a no-paid-provider local smoke test when the local scraper is available;
6. inspect the diff for credential leakage and unrelated changes.

No Google or Apify credits will be consumed without separate explicit authorization.

## Rollout and Recovery

- Work occurs on a dedicated feature branch.
- Changes are divided into small commits with `docs/AGENT_LOG.md` handoffs.
- Every behavioral commit must include its regression tests.
- If a proposed cleanup cannot demonstrate identical protected behavior, it is excluded from this pass.
- The current working implementation remains recoverable through ordinary Git history; destructive Git operations are not part of this work.

## Acceptance Criteria

The stabilization is complete when:

1. Standard and Hybrid provider composition is unchanged.
2. Google request scheduling and budgets are unchanged.
3. Docker query selection and performance settings are unchanged.
4. Canonical and fallback local scraper paths share bounded, casing-tolerant, strike-tolerant polling behavior.
5. Provider settlement combinations have explicit regression coverage.
6. Resume does not repeat completed local work or duplicate durable contacts.
7. Useful output survives every supplemental-provider failure covered by the design.
8. Nova reports accurate, actionable, non-repetitive lane state without secrets.
9. Operator documentation matches the active baseline.
10. Focused tests, the complete isolated-database suite, and the production build pass.
11. Any local smoke check is credit-free and preserves the current Docker configuration.
12. `docs/AGENT_LOG.md` gives Kimi the branch, commits, verification evidence, remaining caveats, and next action.
