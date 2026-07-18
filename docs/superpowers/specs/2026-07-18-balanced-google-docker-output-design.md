# Balanced Google + Docker Output Design

**Status:** Approved direction from the operator on 2026-07-18; awaiting review of this implementation contract

## Problem

The Standard Google Maps mode is labelled `Docker + Google`, but its resumable implementation is strictly Docker-first. It runs every eligible Docker batch, including the scraper's slow website-email crawl, before Google Places starts as a fallback. A slow or depleted Docker batch can therefore delay the productive API path for many minutes.

The observed high-output historical run used Google Places discovery first, returned roughly 953 businesses with about 800 websites, and then scanned those websites in the application at concurrency 50 to produce 495 email leads. The current run used a 25-request fallback budget and had not invoked Google at all while Docker was still working. It found businesses, but the Docker container spent substantial time on third-party website timeouts, `403` responses, DNS failures, and TLS failures. This explains the low current lead count without establishing that the direct Google Maps IP is blocked or that the API key is expired.

This design restores the proven discovery and email-extraction path while retaining Docker as a supplemental source. It supersedes the provider order in `2026-07-15-local-first-google-maps-hybrid-design.md` and the Docker-first assumption in `2026-07-18-adaptive-empty-batch-fallback-design.md`. Their checkpoint, redaction, proxy, deduplication, and adaptive empty-batch protections remain applicable.

## Goals

- Start useful Google Places discovery immediately in every Standard Google Maps run.
- Run Docker discovery alongside Google instead of making either provider wait for the other to finish.
- Use a default Google request budget of 50 HTTP requests for Standard and Hybrid Max Output, while respecting an explicitly lower operator value.
- Make every attempted Google request visible in the run's `apiRequestsUsed` counter, including failed attempts and key-rotation attempts.
- Disable Docker's internal website-email crawl for Leads-GenX jobs and scan all discovered websites in Leads-GenX at bounded concurrency 50.
- Improve lead relevance by preventing broad company types such as `Distributor`, `Retailer`, and `Corporation` from becoming standalone searches when an industry, category, or search term is available.
- Continue producing partial output if either Google or Docker fails.
- Keep Apify available only when the operator selects Hybrid Max Output.
- Preserve request-scoped handling and redaction of Google keys, Apify tokens, and proxy credentials.

## Non-Goals

- A target of 5,000 businesses or 500 email leads is not a guarantee. Yield depends on query coverage, Google results, website availability, and whether businesses publish usable emails.
- This change does not create residential proxy exits or activate offline 9Proxy ports.
- This change does not route Google Places API traffic through proxies.
- This change does not increase direct Docker concurrency above the existing conservative baseline.
- This change does not make credentials persistent across an application restart.
- This change does not merge Apify into Standard mode.

## Approaches Considered

1. **Balanced concurrent discovery (selected):** start Google Places and Docker discovery immediately, keep their work isolated, and serialize persistence and deduplication through the existing run store. Scan websites in the application as provider results arrive.
2. **Google-first sequential:** finish Google discovery and email scanning before Docker starts. This closely resembles the historical high-output run, but leaves Docker idle and lengthens total time.
3. **Keep Docker-first and add proxies:** proxies may increase sustained browser capacity later, but do not fix delayed Google scheduling, inaccurate API metrics, or third-party website failures.

## Selected Architecture

Standard mode remains the single dashboard choice `Standard — Docker + Google`; the operator does not select Docker separately. Its internal provider is still represented by `local_first` for database compatibility, but the execution behavior becomes balanced rather than local-first.

At run start, one orchestration service creates two provider tasks:

- **Google task:** begins Text Search immediately, bounded by the configured request budget.
- **Docker task:** executes resumable local discovery batches with Docker email extraction disabled.

Each provider builds and normalizes a provider-local result set. A small persistence queue serializes shared run-store operations so concurrent providers cannot race business merges, email deduplication, lead totals, or metrics. Provider network work remains concurrent; database writes remain deterministic.

Google exposes each completed page or shard to the orchestrator instead of holding every place until the entire search finishes. Docker continues to expose one completed checkpointed batch at a time. This lets both providers persist businesses and queue website scans incrementally while later discovery work is still in flight.

As normalized businesses become available, the orchestrator:

1. applies rating, review, closure, and other quality filters;
2. upserts businesses using the existing canonical business identity;
3. merges source provenance and counts duplicates;
4. sends website-bearing records to the shared application email scanner;
5. saves one lead per new qualified email;
6. refreshes business, website, source, duplicate, lead, and request metrics;
7. emits bounded provider-specific progress events.

The application website scanner remains bounded at concurrency 50 globally per run. It must not create one concurrency-50 pool per provider because that would unintentionally double the outbound website load. Existing site-level timeouts and error isolation remain in force: a failed website does not fail the provider or run.

## Provider Completion and Failure Semantics

Standard mode completes when both provider tasks are terminal and all queued website scans and persistence operations have drained.

- If Google fails authentication, billing, restriction, quota, rate-limit, or network checks, Docker continues and the error is shown as a Google provider warning.
- If Docker is unavailable, times out, fails, or opens the three-empty-batch circuit, Google continues and completed Docker results remain saved.
- If both providers fail before producing useful results, the run is `failed` with a redacted aggregate explanation.
- If at least one provider produces or validly completes work, the run status is `completed` with warning events and transparent counts, even when the requested target is not reached.
- No provider failure silently increases the Google request budget or retries indefinitely.
- Existing deterministic Docker checkpoints remain resumable. Request-scoped Google credentials still need to be re-entered after process restart.

Hybrid Max Output uses the same balanced Google + Docker stage, then runs Apify expansion using the existing normalized deduplication and email pipeline. Apify failures remain non-fatal when another source succeeded. Standard mode never requests an Apify token.

## Google Request Budget and Validation

- Standard and Hybrid Max Output default to 50 Google HTTP requests per run.
- The operator may explicitly choose any value from 1 through 500. A lower explicit value is never raised automatically.
- Each outbound Text Search HTTP attempt consumes one budget unit before the request is sent. A retry with another supplied key is another attempt and another unit.
- `apiRequestsUsed` is updated after every attempt through a request callback from the Google client, including non-2xx responses and key rotation.
- The first real Text Search request is also the secure key validation request; its successful results are reused. This avoids a separate wasteful or potentially billable probe.
- Google error responses are classified into actionable operator messages: invalid or restricted key, API disabled or billing unavailable, quota/rate limit, budget exhausted, and transient service/network failure.
- Authentication, key-restriction, API-disabled, and billing failures are terminal for the affected key and are not repeated across later queries. If every supplied key is terminal, the Google task stops immediately rather than consuming the remaining budget on identical failures.
- Rate-limit and quota responses stop or cool down the affected Google task without a tight retry loop. Transient failures receive only bounded retries while budget remains.
- API keys are passed only in the request header, never in URLs, request bodies, stored filter JSON, events, error details, responses, or exports.
- The dashboard may show `Google key accepted` only after the first real request succeeds. It must never echo the key or expose a fingerprint that would help reconstruct it.

## Query Quality Rules

The query builder keeps standalone search terms and standalone categories because they express the target industry. Company types describe an organization form or channel and are treated as modifiers.

When at least one search term or category exists, the builder produces:

- standalone search terms;
- standalone categories;
- search term + category combinations;
- search term + company type combinations;
- category + company type combinations.

It does **not** produce standalone company-type searches in that case. If the operator supplies only company types, standalone company types remain valid so the input is not discarded. Existing location expansion and stable deduplication remain unchanged.

This prevents a query such as `Distributor Washington, DC` from overwhelming the run with unrelated retail and chain-store results when a more specific industry term is present.

## Docker Discovery-Only Jobs

Both resumable `searchBatch` and legacy `search` job creation must explicitly send `email: false` for Leads-GenX discovery. Docker remains responsible for Google Maps discovery and CSV delivery, not for crawling every business website.

The downloaded rows still accept an `emails` column for compatibility with previously completed jobs or upstream output, but new jobs do not depend on it. Website URLs are passed to the shared application scanner. This removes the observed 30-second per-site Docker waits and makes website error behavior consistent across Google, Docker, and Apify records.

## Accurate Live Progress

The live panel must distinguish work by provider and stage. At minimum it exposes:

- Google state: starting, key accepted, searching, budget exhausted, completed, or failed;
- Docker state: health check, batch running, batch completed, empty circuit opened, waiting, or failed;
- email state: queued websites, scanned websites, website failures, and unique emails saved;
- counts: total businesses, Google businesses, Docker businesses, websites discovered/scanned, duplicates, leads, API budget, and API requests used;
- Hybrid-only Apify state and shard progress.

Events remain bounded and redacted. Query text may be shown to the local operator as progress only if it contains no credential material; raw provider responses, HTML, CSV contents, keys, proxy URLs, and tokens are never emitted.

The main phase text should describe real activity rather than infer it from old event names. Google activity must appear immediately even while Docker is running. A Docker warning must not make a healthy Google task look stalled, and vice versa.

## Data Integrity and Concurrency

- Business identity and cross-source provenance use the existing `upsertBusiness` behavior.
- Shared writes pass through one per-run serialized persistence queue.
- The queue owns `seenEmails`, lead totals, duplicate totals, and metric refreshes.
- Website work is deduplicated by canonical business identity and normalized website origin before scanning when practical.
- Every qualified unique email is saved once per run; one business may yield multiple lead rows when it exposes multiple distinct emails.
- A provider may reach the requested unique-business target, but already-started bounded work from the other provider is allowed to finish and merge. No new provider shards are scheduled after the target is reached.
- All provider promises are observed so a late rejection cannot become an unhandled process error.

## Security

- Google and Apify credentials remain request-scoped and memory-only.
- Proxy credentials remain memory-only and redacted according to the existing local scraper contract.
- Google request and error callbacks expose counts, status classes, and redacted messages only.
- The API and UI must not serialize submitted credential fields back to the browser after run creation.
- Sentinel-secret tests cover events, application logs, database fields, API responses, Docker job records, and exports.

## Testing Strategy

Automated tests will verify:

- Standard mode starts Google before Docker has completed and permits both provider tasks to be in flight;
- concurrent provider completion orders produce deterministic business, provenance, duplicate, lead, and metric totals;
- the per-run email scanner never exceeds total concurrency 50;
- Docker job payloads use `email: false` in resumable and legacy paths;
- Docker website timeouts no longer delay batch completion;
- every Google HTTP attempt increments `apiRequestsUsed`, including failed requests and rotated-key attempts;
- the Google request count never exceeds the configured budget;
- the first successful real request establishes key validity without a separate probe;
- invalid/restricted, billing/API-disabled, quota/rate-limit, budget, and transient Google errors are classified and redacted;
- default Standard and Hybrid budgets are 50, while explicit lower budgets are preserved;
- standalone company types are omitted when search terms or categories exist and retained when they are the only criteria;
- a Google failure leaves Docker operational and a Docker failure leaves Google operational;
- the three-empty-batch Docker circuit remains effective without delaying Google;
- Hybrid Max Output adds Apify and Standard mode does not;
- credentials do not appear in persisted or returned data;
- existing resume, export, normalization, and Sales Navigator behavior remains passing.

Verification also includes the TypeScript build, complete Vitest suite, local Docker client tests, a controlled live Google request with an operator-supplied key, and a small end-to-end Standard run. The live smoke test must use an explicit low target and budget to avoid uncontrolled external cost.

## Acceptance Criteria

- Selecting Standard automatically runs Google and Docker together; there is no separate Docker checkbox.
- Google sends its first real request without waiting for Docker batch completion.
- The default Google request budget is 50 and the visible used count matches actual outbound attempts.
- Docker jobs perform discovery only with `email: false`.
- All provider websites use the application scanner with a global per-run concurrency cap of 50.
- Company types do not create broad standalone searches when more specific criteria exist.
- A failure or empty circuit in one provider does not stop productive work in the other.
- Businesses and unique emails are saved incrementally and deduplicated across providers.
- Hybrid Max Output is the only mode that adds Apify.
- Keys, tokens, and proxy credentials remain absent from storage, logs, events, API responses, and exports.
- Live progress accurately identifies provider activity, request usage, website scanning, and actionable failures.
- All applicable automated tests and controlled smoke checks pass before the change is declared complete.

## Operational Notes

Residential proxies remain recommended for sustained Docker capacity once working ports are funded and available, but they are not a prerequisite for this restoration. They can improve Google Maps browser discovery resilience; they cannot guarantee that third-party business websites will accept requests. Google Places remains direct and budget-controlled.

The 50-request default is intended to restore the capacity class of the prior high-output run, not guarantee identical output. Google Text Search returns at most 20 records per page, and duplicate or empty coverage across queries lowers the number of unique businesses. The dashboard must therefore report actual businesses, websites, and email leads rather than imply that the request budget maps directly to a promised result count.
