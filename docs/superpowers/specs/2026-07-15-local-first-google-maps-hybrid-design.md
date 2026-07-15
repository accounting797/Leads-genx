# Local-First Google Maps Hybrid Design

**Status:** Approved in conversation on 2026-07-15

## Scope

Upgrade Leads-GenX so the locally built `gosom/google-maps-scraper` repository is the primary Google Maps discovery engine. Google Places API becomes a budget-controlled fallback for failed, empty, or exhausted local discovery rather than the default source for every search. The design preserves Apify as a later additive source for Hybrid Max Output.

This design supersedes the earlier `2026-07-13-google-only-scale-design.md` decision not to use browser-based Google Maps scraping. The official API remains supported, but the operator has explicitly selected the local-first model to maximize potential business and email output while limiting API usage.

The supplied scraper source is the clean upstream repository at commit `0ef302e`, described by Git as `v1.16.3-1-g0ef302e`. It includes the July 2026 Playwright 1.61 repair. The existing published Docker image and its driver-cache deletion workaround will not be used for the repaired runtime.

## Goals

- Make the Docker scraper repository/kit the primary discovery provider.
- Target up to 10,000 unique businesses per run without treating that target as a guaranteed yield.
- Preserve every valid result after each completed batch.
- Extract and retain every unique usable email found on discovered business websites.
- Use Google Places API only as a controlled fallback and enrichment source.
- Build from the supplied source so Chromium and the Playwright driver use compatible versions.
- Run the scraper as a healthy background Docker service without port or process conflicts.
- Support 9Proxy local port forwarding when paid proxy endpoints become active, while working conservatively without it.
- Keep Google keys and proxy credentials out of persistent storage, logs, events, responses, and exports.
- Keep the design compatible with the later Apify hybrid integration.

## Non-Goals

- The system does not manufacture residential IPs. FRP, Caddy, v2rayNG, Docker, and the scraper can route traffic but cannot create external exit nodes.
- Docker is not treated as an anonymity boundary; direct container traffic still exits through the host's public IP.
- No CAPTCHA solving or account automation is added.
- No claim is made that a 10,000-business run will finish quickly without active proxies. Direct browser scraping remains deliberately conservative.
- No full 10,000-business scrape is required as a development test because it can take hours and consume external resources.
- Proxy or Google API secrets will not survive a Leads-GenX process restart in this iteration. A paused run will require secure re-entry of the missing request-scoped credentials.

## Selected Approach

Use a hardened two-layer integration:

1. **Leads-GenX orchestration layer:** query expansion, deterministic batching, checkpoints, proxy health supervision, adaptive local concurrency, Google API budgeting, normalization, deduplication, progress, and fallback decisions.
2. **Locally built scraper layer:** Chromium-based Maps discovery and website email extraction, running in Docker from the supplied source with hardened per-job secret handling.

This approach is preferred over modifying Scrapemate's low-level rotator because small resumable batches let Leads-GenX change the healthy proxy set without creating a deep dependency fork or switching IPs inside a sticky browser task. It is preferred over always-on FRP/Caddy routing because those services add failure points without providing exit IPs when no remote nodes exist.

## Architecture and Process Boundaries

### Leads-GenX

- Runs on `localhost:4177` and remains the operator-facing application.
- Owns run lifecycle, source selection, API budgets, batching, checkpoints, normalization, deduplication, result storage, and progress events.
- Holds request-scoped Google API keys and proxy URLs in memory only.
- Talks to the scraper API at `http://127.0.0.1:8080`.

### Local Google Maps scraper

- Runs in Docker as `leads-genx-gmaps-scraper` on `127.0.0.1:8080` only.
- Uses a uniquely tagged local image built from the supplied source repository.
- Uses the upstream Playwright Go `v0.6100.0` driver and matching bundled Chromium artifacts.
- Stores job metadata and completed CSV output in the existing Docker volume, excluding credentials.
- Uses Docker health checks and `restart: unless-stopped`.

### Optional 9Proxy gateway

- The 9Proxy desktop application owns residential IP activation and local port forwarding.
- Candidate Windows endpoints are configurable, with `127.0.0.1:60000` through `127.0.0.1:60009` as the initial discovery range.
- Leads-GenX checks candidates through the Windows loopback address.
- Docker receives the corresponding reachable host form, normally `host.docker.internal:<port>`.
- A candidate is never sent to Docker until host and container reachability both pass.
- Offline ports remain dormant and cause no retries or conflicts.
- FRP and Caddy remain stopped unless a future remote gateway requirement makes them necessary.

### Google Places API

- Runs directly from Leads-GenX and never through the proxy pool.
- Receives only the field mask needed for normalization and website discovery.
- Is invoked only by the fallback policy and remains bounded by a per-run request budget.

### Future Apify path

- Apify remains an independent optional provider.
- The local scraper and Google fallback do not depend on an Apify token.
- A later Hybrid Max Output mode may run Apify alongside these sources and use the same normalized deduplication pipeline.

## Build and Runtime Integration

- A project script resolves the supplied scraper source path from `GOOGLE_MAPS_SCRAPER_SOURCE` and verifies the expected Git revision or an explicitly accepted replacement.
- The script builds a local image with a Leads-GenX-specific tag instead of overwriting or trusting `gosom/google-maps-scraper:latest`.
- Docker Compose references the local tag and does not delete `/opt/ms-playwright-go` at startup.
- The scraper data volume is retained across container replacement.
- Startup is idempotent: build only when the source revision or Dockerfile input changes, recreate only the scraper service, and leave unrelated containers untouched.
- The existing startup entry point is updated to start the local image, wait for health, and print actionable failures.
- Leads-GenX enables the local provider explicitly and waits for scraper readiness without occupying port `8080` itself.

## Local-First Data Flow

1. The operator selects Google Maps, enters search filters, target count, a request-scoped Google API key, and optionally active proxy endpoints.
2. Validation parses credentials without returning their values in validation errors.
3. The query builder expands terms, categories, company types, and locations into deterministic shards. Geographic grid cells are used where coordinates or bounded areas are available.
4. Each shard is split into a deterministic batch with a stable ID derived from its normalized search inputs.
5. The proxy supervisor checks configured candidates. If none are configured or usable, the direct browser baseline is used only because the operator approved direct conservative scraping.
6. Leads-GenX submits one local batch with the current healthy proxy set, or no proxies for direct mode.
7. The scraper completes the batch and exposes CSV output.
8. Leads-GenX downloads, normalizes, and deduplicates the batch immediately, then checkpoints the batch before scheduling more work.
9. Website/email results are split into one lead per unique email while retaining businesses that have not exposed an email.
10. Failed or zero-result local batches follow the recovery policy. Google fallback is used only after local recovery is exhausted or when all local shards finish below the requested target.
11. Discovery stops when the unique-business target is reached or every eligible shard and fallback path is exhausted.
12. The run completes with transparent counts rather than claiming that the target or a particular email yield was guaranteed.

## Workload and Capacity Baseline

- Direct browser mode starts at concurrency `1`.
- Concurrency `2` is enabled only after the controlled benchmark passes and recent batches show no elevated timeout, failure, or zero-result rate.
- Direct mode never exceeds concurrency `2`.
- Proxy mode may eventually scale to the number of healthy forwarded ports, but higher limits require a separate measured benchmark.
- Browser work uses small batches so failed work can cool down and recovered proxies can re-enter between batches.
- Page/browser sessions remain sticky for the duration of a work item; rotation happens between work items rather than on every asset request.
- The initial Google fallback budget is 25 HTTP requests per run. The operator can set a lower value, including zero. Raising the ceiling is an explicit advanced action, capped at 500 requests per run.
- An API request means one billable HTTP request/page, not one logical shard.
- Google fallback runs for local batches that fail after recovery, return zero results, or remain uncovered after all local shards finish below the target.
- Field masks are minimized to control billing and response size.

## Proxy Health Supervision

Each proxy candidate is represented by a redacted ID and one of these in-memory states:

- `unknown`: not tested yet;
- `healthy`: eligible for a new batch;
- `cooling_down`: temporarily excluded after failures;
- `retesting`: undergoing a bounded recovery check;
- `unavailable`: failed authentication, is not listening, or exceeded the run-level failure limit.

The supervisor verifies SOCKS5 connectivity, authentication, HTTPS reachability, exit IP, latency, and container reachability. Public IPs are used only as observed metadata; the actual configured endpoints are the 9Proxy local forwarded ports.

Two consecutive connection, authentication, or timeout failures move a candidate into cooldown. Cooldowns increase from 5 to 15 to 30 minutes. A successful retest returns the candidate to `healthy`. If every candidate is cooling or unavailable, proxy-mode work pauses and periodically retests; it does not silently switch to a different routing mode. Direct mode is a separate explicit mode selected for the current no-credit baseline.

## Credential and Secret Handling

The upstream web runner currently stores `JobData.Proxies` in SQLite and returns it from job APIs. The local build must not retain that behavior for Leads-GenX jobs.

- The scraper extracts proxy URLs into a per-job in-memory secret store before persistence.
- Persisted `JobData.Proxies` is empty.
- List and detail endpoints never return proxy URLs or credentials.
- The runner obtains the in-memory proxy set by job ID and destroys it when the job finishes, fails, is deleted, or the service shuts down.
- Log messages may report proxy count and redacted IDs only.
- Leads-GenX validation, run input persistence, events, errors, and API responses omit Google keys and complete proxy URLs.
- Dashboard credential controls are password-style or otherwise protected from accidental display, and are cleared after submission.
- Automated leakage tests inspect API payloads, logs, the Leads-GenX database, scraper SQLite data, and exports for sentinel secrets.

## Normalization and Deduplication

Local scraper and Google API records flow through one canonical normalizer. Deduplication uses the strongest available identity in this order:

1. Google place ID or CID;
2. normalized Maps URL;
3. normalized website hostname plus phone;
4. normalized phone;
5. normalized business name plus address.

Overlapping records merge source provenance, fill missing fields, and union normalized emails. They do not overwrite a populated value with an empty one. The run's target counter counts unique businesses, while email exports count unique valid email addresses.

## Error Handling and Recovery

- Completed deterministic batches are idempotent and are not resubmitted after restart.
- A failed local batch retries after increasing cooldown. Repeated failures keep its checkpoint pending.
- Repeated empty or failure-heavy batches reduce local concurrency to `1`.
- Scraper unavailability moves the run to `waiting_for_scraper`; Docker recovery is attempted without losing completed results.
- Google HTTP `429` responses trigger cooldown and consume no immediate retry loop.
- Invalid or restricted Google keys are disabled for the current run.
- Quota or billing failures stop API fallback but preserve local progress.
- The run is `completed` when all eligible work finishes, even if fewer than the target businesses or zero emails were found; progress must explain the shortfall.
- Cancelling stops new batches, preserves completed output, and clears request-scoped secrets.
- Supported operator-visible states include `running`, `cooling_down`, `waiting_for_scraper`, `waiting_for_proxy`, `api_budget_exhausted`, `completed`, `failed`, and `cancelled`.

## UI and Observability

The dashboard adds or exposes:

- local-first provider mode;
- requested unique-business target up to 10,000;
- per-run Google API request budget;
- secure proxy input, one endpoint per line;
- current route: `direct`, `9Proxy`, or `paused`;
- scraper readiness and current local concurrency;
- local batches completed, pending, cooling, and failed;
- local businesses, API businesses, duplicates removed, websites scanned, unique emails, and API requests used;
- redacted proxy health counts without host credentials;
- clear warnings when running directly without residential proxy rotation.

Events remain bounded and must not include raw HTML, CSV data, keys, usernames, passwords, or complete proxy URLs.

## Testing Strategy

### Leads-GenX automated tests

- Proxy parsing and redaction for SOCKS5/SOCKS5h and authenticated forms.
- Healthy, dead, and intermittent local SOCKS5 test doubles.
- State transitions, cooldown escalation, retesting, and zero-healthy behavior.
- Deterministic batching, idempotent checkpoints, cancellation, and resume.
- Local-first routing and budget-controlled Google fallback.
- Google `429`, invalid-key, quota, and budget exhaustion behavior.
- Cross-source normalization and deduplication.
- Live batch persistence and one-email-per-lead behavior.
- Static UI and API secret-leak regression tests.
- Existing TypeScript build and complete Vitest suite.

### Scraper automated tests

- Existing Go unit tests.
- API contract tests for job creation, status, completion, and download.
- Proxy credentials are available to the runner but absent from SQLite and API responses.
- Secret destruction on completion, failure, deletion, and shutdown.
- Redacted logging.

### Docker verification

- Build from the supplied source revision.
- Confirm the Playwright driver and bundled Chromium launch without downloads or version mismatch.
- Complete one normal scrape and one email-enabled scrape.
- Restart the container and confirm completed output remains available.
- Confirm health status and localhost-only port binding.
- Confirm no conflict with Leads-GenX on port `4177`.

### End-to-end verification

- Run a local-first job from the dashboard.
- Verify local results are committed before API fallback.
- Force a failed local batch and observe bounded API recovery.
- Verify cross-source deduplication and source metrics.
- Cancel and resume checkpointed work.
- Confirm the dashboard's counts match persisted output.
- Run a controlled performance benchmark before enabling concurrency `2`.

## Acceptance Criteria

- The local Docker image builds from the supplied source and starts healthy in the background.
- Playwright and Chromium work for normal and email-enabled jobs.
- The broken cache-deletion workaround is removed.
- Leads-GenX uses the local scraper as the primary discovery source.
- Google API use is limited to deterministic fallback and the configured request budget.
- Valid batch results survive later source, browser, container, or API failures.
- Unique businesses are deduplicated across local and API sources.
- Every discovered valid email is retained uniquely and remains downloadable one per line.
- Direct browser concurrency stays at or below `2` until active proxies are available and benchmarked.
- Offline 9Proxy ports do not block startup or cause conflicts.
- Active 9Proxy endpoints can enter rotation only after host and container health checks.
- Google keys and proxy credentials are absent from logs, events, databases, job responses, run history, and exports.
- Docker exposes only `127.0.0.1:8080`, and Leads-GenX remains available on `localhost:4177`.
- Existing Apify and Sales Navigator behavior remains intact.
- All applicable Go tests, Vitest tests, TypeScript build checks, Docker smoke tests, and end-to-end checks pass before completion is claimed.

## Operational Caveats

- Without paid 9Proxy credit, ports `60000` through `60009` are expected to be offline and direct mode will be slower.
- A 10,000-business target is an upper bound, not a promise. Actual yield depends on query coverage, Maps availability, blocking, business websites, and published email addresses.
- Google Places usage is pay-as-you-go and must remain visible to the operator through the request budget and usage counters.
- If request-scoped credentials are lost after an application restart, the run remains safely paused until the operator re-enters them.
