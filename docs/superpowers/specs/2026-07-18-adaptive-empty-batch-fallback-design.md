# Adaptive Empty-Batch Fallback Design

**Status:** Approved in conversation on 2026-07-18

## Problem

The Docker-first pipeline currently treats an empty scraper CSV as a successful batch and continues through every remaining local shard. During the observed run, direct Docker scraping returned useful businesses at first, then Google Maps began returning empty CSVs from the host IP. The pipeline processed 61 empty batches before reaching Google fallback. This wastes time, obscures likely blocking, and delays recovery.

This design is a focused correction to the fallback behavior already approved in `2026-07-15-local-first-google-maps-hybrid-design.md`. It does not reorder providers or change Apify behavior.

## Approaches Considered

1. **Adaptive Docker-first fallback (selected):** stop local discovery after three consecutive completed batches with zero raw businesses, preserve all prior local results, and proceed to the existing Google API fallback.
2. **Google-first:** use the official API before Docker. This is predictable but increases API consumption and conflicts with the approved Docker-first operating model.
3. **Docker-only cooldown:** pause and retry the direct IP without using Google. This limits API cost but can remain blocked indefinitely when no working proxies are available.

## Selected Behavior

- Docker remains the primary Google Maps discovery source.
- A local batch counts as empty only when the scraper job completes successfully and its downloaded CSV contains zero raw businesses.
- The run tracks consecutive empty local batches in memory during one execution.
- Any non-empty completed local batch resets the consecutive-empty counter to zero.
- Local scraper failures continue to use the existing retry/error policy and do not count as empty successes.
- After the third consecutive empty batch, the local loop stops scheduling more batches for that execution and marks the remaining local checkpoints `skipped_empty_circuit`.
- Completed output and batch checkpoints remain preserved.
- The run emits a redacted `local_empty_circuit_opened` event containing the threshold and remaining local-batch count, but no query text, credentials, or raw data.
- The pipeline immediately continues to the existing Google API fallback, bounded by the run's configured request budget.
- If a Google key is unavailable because it was intentionally not persisted across a restart, the run enters `waiting_for_credentials`; secure resume continues with Google fallback instead of resuming the blocked local batches.
- A zero Google API budget remains valid. In that case, the run finishes with preserved local output and an event explaining that fallback was skipped because the budget was zero.
- Apify remains available only through Hybrid Max Output and is unaffected by this circuit breaker.

## Checkpoint Semantics

Unprocessed local batches receive the terminal checkpoint status `skipped_empty_circuit` when the empty-batch circuit opens. The runnable-batch query excludes that status, so recovery does not automatically submit the blocked local work again. Secure resume is therefore a Google-fallback continuation, not a reset of the local circuit. A new run starts with a closed circuit and may attempt Docker normally.

This distinction prevents an application restart from repeating the same blocked local work while preserving deterministic batch history for diagnostics.

## Observability

Live progress must distinguish:

- ordinary non-empty Docker completion;
- an individual empty Docker batch, including the current consecutive count;
- the circuit opening after three consecutive empties;
- Google fallback starting, waiting for credentials, budget exhaustion, or completion.

The existing Businesses and Leads metrics retain their current meanings: Businesses are deduplicated prospects, while Leads are unique usable email contacts.

## Error Handling

- The circuit breaker is not triggered by a single narrow query with no matches.
- Three consecutive empty batches are treated as evidence of depleted or blocked local discovery, not as a fatal run error.
- Previously stored businesses and emails are never removed when the circuit opens.
- Google authentication, quota, billing, and rate-limit errors retain their current bounded handling.
- No automatic unlimited retry or silent request-budget increase is introduced.

## Testing

Automated tests will verify that:

- one or two consecutive empty local batches do not open the circuit;
- a non-empty batch resets the empty counter;
- three consecutive empty batches stop further local submissions;
- remaining local checkpoints are marked `skipped_empty_circuit` and are not runnable after restart;
- prior local businesses and emails remain persisted;
- Google fallback begins after the circuit opens when a key and budget are available;
- a missing request-scoped key produces `waiting_for_credentials`;
- a zero API budget performs no Google requests;
- the circuit event and progress metadata contain no secrets or raw query data;
- existing local-first, Hybrid Max Output, API error, and normalization tests continue to pass.

## Acceptance Criteria

- Docker remains first for Standard Google Maps runs.
- No more than three consecutive zero-result Docker batches are submitted before fallback.
- A later non-empty result resets the counter before the threshold is reached.
- Google requests never exceed the configured per-run budget.
- Restart recovery does not repeat locally short-circuited pending batches.
- The operator receives an accurate, actionable progress event when fallback activates.
- Existing results, credentials policy, Apify selection rules, and export behavior remain unchanged.
