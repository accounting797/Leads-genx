# Leads-GenX Max-Output Pipeline, Secure Settings, and Command Radar

**Date:** 2026-07-19  
**Status:** User-approved design  
**Application:** Leads-GenX at `http://localhost:4177/`

## Purpose

Improve the existing Google Maps lead-generation module so it produces substantially more relevant businesses and legitimate email contacts without hiding provider failures, wasting paid API budget, or inflating the lead count with low-quality contacts.

The design combines:

- Docker Google Maps scraping for high-volume, low-cost discovery;
- Google Places API for reliable coverage and recovery;
- Apify only in Hybrid Max Output mode;
- optional Bright Data routing for Docker traffic;
- secure local management of Google, Apify, and Bright Data credentials;
- a compact, animated Command Radar backed by real session events.

## Goals

1. Maximize relevant, legitimate email contacts while keeping questionable candidates available separately.
2. Make Standard mode run Docker and Google together automatically.
3. Make Hybrid Max Output add Apify to Docker and Google.
4. Increase Docker throughput from the current single-page bottleneck without overwhelming the machine.
5. Use Google request budgets across locations before spending them on deep pagination of one location.
6. Persist businesses and contacts continuously so partial results survive failures.
7. Provide secure local settings and clear provider, proxy, usage, and error reporting.
8. Show accurate, understandable live progress in a compact part of the existing localhost UI.

## Non-goals

- The application will not supply free residential or datacenter IP addresses.
- Bright Data API credentials will not be treated as proxy credentials unless the account and zone actually provide usable proxy routing details.
- The first implementation will not change Bright Data account configuration through destructive APIs.
- The scraper will not retry indefinitely or conceal exhausted budgets, blocks, or stalled providers.
- Raw or suspicious contacts will not inflate the qualified lead count.

## Output Modes

### Standard Output

- Docker scraper and Google Places API run concurrently.
- The user does not select Docker separately.
- Docker and Google are both represented as active in live progress.
- Apify remains off and consumes no budget.
- Google request budget defaults to 50 attempts unless the user changes it.

### Hybrid Max Output

- Docker, Google Places API, and Apify run together.
- Apify activates only after this mode is selected.
- Live progress identifies all three providers as active and records each provider's yield and budget independently.

The UI will warn when a selected Google budget is too small to cover the planned location shards. A budget is a hard maximum, not a target that must be spent.

## Architecture

### Session Coordinator

The session coordinator owns the run lifecycle and exposes one event contract to the UI. It starts the selected providers, preserves partial results, applies stop conditions, and marks the terminal state as completed, partially completed, cancelled, or failed.

Provider failures are isolated. For example, a Google authentication failure does not discard Docker results, and a Docker block does not prevent already-discovered websites from being scanned for emails.

### Query Planner

The planner builds an ordered, finite plan with three tiers:

1. **Precision:** exact industry and buyer-intent combinations for the requested locations.
2. **Targeted expansion:** closely related terms and adjacent buyer categories.
3. **Broad recovery:** broader distributor, supplier, retailer, or service terms only when qualified output remains below the run target.

Each planned item records its tier, location, provider eligibility, and quality expectations. Broad-recovery results are retained but start with lower relevance confidence.

### Google Scheduler

The Google scheduler uses breadth-first, round-robin coverage:

1. Request the first page for precision queries across different locations.
2. Continue first-page coverage across remaining shards.
3. Spend additional budget on page tokens only after breadth is established.
4. Move to targeted expansion, then broad recovery when justified.

Every HTTP attempt increments the recorded budget counter, including attempts that fail. Page-token requests cannot monopolize a small budget. Google traffic remains direct and does not use the scraping proxy pool.

Google result normalization uses `displayName` for the company name and never exposes the resource identifier such as `places/ChIJ...` as the business name.

### Docker Scraper Adapter

The safe initial performance baseline is:

- concurrency: 4;
- browser pool: 1;
- pages per browser: 4;
- one application checkpoint batch at a time;
- existing depth behavior retained unless controlled performance tests justify a change.

The adapter emits heartbeats, batch progress, output counts, empty-batch signals, block indicators, and errors. Concurrency remains configurable in Settings, with 4 as the default for the measured 12-logical-processor, 7.44-GiB Docker environment.

### Website and Email Scanner

Website scanning uses one real global concurrency pool of 50 tasks rather than creating separate pools per batch. Each website result is normalized, classified, deduplicated, and persisted immediately when that site finishes.

The scanner does not wait for an entire provider or batch to finish before showing contacts. A site failure is recorded without blocking other sites.

### Lead Quality Classifier

Contacts are separated into two visible tiers:

- **Qualified contacts:** plausible, normalized, unique business email contacts that count toward `leadCount`.
- **Raw contacts:** lower-confidence candidates retained for review but excluded from the main lead count.

The classifier rejects or downgrades:

- placeholder addresses;
- malformed addresses;
- tracking and telemetry addresses such as Sentry/Wix artifacts;
- file, asset, or non-mail host artifacts;
- duplicates after normalized comparison;
- contacts whose source or domain cannot reasonably be associated with the business.

The dashboard separately reports:

- unique businesses;
- qualified unique email contacts;
- companies with at least one qualified email;
- raw contacts;
- websites found;
- duplicates removed.

This prevents an email-heavy company from being confused with many independently qualified companies.

### Event and Report Store

SQLite remains the durable source for session reporting. The event subsystem records at least:

- session and provider identifiers;
- output mode;
- stage and operation;
- status and heartbeat time;
- planned, active, completed, failed, and cooling work units;
- provider yield;
- request attempts and budget ceiling;
- persisted business, website, qualified-contact, raw-contact, and duplicate counts;
- redacted error code and actionable message;
- proxy route, latency, rotation, cooldown, traffic, and block signals when applicable.

Secrets and full proxy credentials are never stored in these events.

## End-to-End Data Flow

1. The user chooses Standard or Hybrid Max Output and starts a session.
2. The query planner creates the precision, expansion, and possible recovery work plan.
3. Docker and Google begin concurrently; Apify also begins or joins in Hybrid Max Output.
4. Google distributes its first-page attempts across locations before deep pagination.
5. Docker processes checkpoint batches with four concurrent pages.
6. Provider results are normalized and deduplicated as they arrive.
7. Businesses are persisted immediately and their websites enter the global website queue.
8. Website results and email contacts are persisted individually as tasks finish.
9. The quality classifier separates qualified and raw contacts.
10. If output is below target after precise work, targeted expansion runs. Broad recovery runs only when still necessary.
11. The coordinator stops when the user cancels, the requested target is reached, eligible work is exhausted, or all active providers reach a terminal state.
12. Partial results remain accessible for every non-destructive terminal state.

## Secure General Settings

General Settings is part of Leads-GenX at `http://localhost:4177/`. The application remains bound to loopback so it is not exposed to other machines by default.

### Credential Cards

Settings provides cards for:

- Google Places API;
- Apify;
- Bright Data.

Each card shows only:

- a masked fingerprint;
- connection state;
- last verified time;
- **Test**, **Replace**, and **Delete** actions.

There is no reveal-full-secret action. Saved credentials are defaults; authorized per-run overrides may still be used without overwriting the saved default.

Google credential testing clearly warns when the chosen verification call consumes one Google request. Apify and Bright Data tests do not start scraping jobs.

### Secret Storage

- Secrets are encrypted with Windows user-level protection.
- Encrypted secret material is stored outside Git and outside normal SQLite application data.
- Existing plaintext saved tokens are migrated and removed.
- Server logs, UI payloads, exceptions, reports, and audit events never contain full secret values.
- Mutating settings endpoints require same-origin protection.
- The server never returns a stored token to the browser after saving it.
- Audit records capture Test, Replace, and Delete actions without capturing the values.

### Bright Data Status Semantics

The UI distinguishes four separate facts:

1. **Token validity:** valid, invalid/expired, permission denied, or unreachable.
2. **Zone status:** active, disabled, unavailable, or misconfigured.
3. **Proxy readiness:** a real routed request produced a verified exit IP.
4. **Usage:** current-period bandwidth and cost reported by Bright Data.

The API token itself is not a consumable balance. Proxy allowance or account credits are what get used. Remaining credits are displayed only if Bright Data returns an authoritative value for the account. Otherwise the UI states that remaining credits are not reported rather than inventing an estimate.

Initial Bright Data account calls are read-only. They may list zones and retrieve cost or bandwidth information. If the API token can manage the account but cannot authenticate native proxy traffic, Settings requests the required zone username/password securely instead of claiming that routing is ready.

## Proxy Gateway

Bright Data Proxy Manager can run as an optional Docker Compose sidecar:

- image pinned to the locally verified `luminati/luminati-proxy@sha256:48d7193ab45860b7e1df9968c1712f9a7b39c1489cf8075c3c040453dba08db4` digest;
- admin UI bound to `127.0.0.1:22999`;
- persistent named volume;
- private Compose network shared with the scraper;
- no proxy routing until a real exit-IP test succeeds;
- optional profile so the main application does not depend on an unconfigured gateway.

When the nine external local SOCKS5 upstreams are used, the gateway exposes managed internal ports `24001` through `24009`, with one upstream per port, so Leads-GenX can score, cool down, and rotate them independently. Docker connects to host-local upstreams through `host.docker.internal`, not container-local `127.0.0.1`.

The Proxy Gateway Settings panel shows the manager state, selected Bright Data zone, active route, and counts for healthy, active, cooling, and failed routes. It provides Start, Stop, Test, and Refresh controls plus settings for Docker concurrency, rotation, cooldown, and all-proxies-failed behavior. Start does not mark the gateway ready; only Test can do so after verifying a real routed exit IP.

### Rotation Policy

- A healthy IP remains sticky for one Docker checkpoint batch.
- Rotation occurs between batches, not between every request.
- Failures, timeouts, blocks, HTTP 403/429 responses, CAPTCHA indicators, or repeated suspicious empty output lower a route's health score.
- Unhealthy routes enter exponential cooldown with a maximum bound.
- Routes must pass a real exit-IP test before returning to service.
- When every proxy is unavailable, the user-selected policy either continues Docker directly or pauses Docker safely.
- Google Places API traffic remains direct.

No proxy package or manager is presented as a source of free IPs.

## Compact Command Radar

Command Radar occupies one compact section of the existing localhost dashboard.

### Visual Behavior

- The outer radar sweep animates only while recent server heartbeats show real work.
- Radar blips correspond to newly persisted businesses, not decorative random events.
- A smaller inner completion ring shows session completion and completed planned units.
- The ring uses known server-side work units. If broad recovery expands the plan, the UI marks an **extended run** and recalculates the denominator rather than preserving a misleading percentage.
- Waiting, cooldown, pause, and failure states stop or alter the motion and display the exact state.
- ETA is labeled as a range with a confidence level; it is never presented as an exact fact.

### A/D/G Provider Orbits

The radar retains futuristic neon provider orbits:

- **D:** Docker, neon cyan;
- **G:** Google, neon green;
- **A:** Apify, neon magenta.

In Standard mode, D and G glow while A is dim and labeled standby. In Hybrid Max Output, D, G, and A glow. The selected output mode is written beside the radar so the letters are never the only explanation.

### Compact Reporting

The widget shows four top-level metrics:

- businesses;
- qualified leads;
- companies with a qualified email;
- raw contacts.

One consolidated **Live Provider Report** replaces overlapping provider and event-ledger panels. Each row shows:

- named source;
- current status;
- current operation;
- provider yield;
- used and maximum budget, or `Free` when no paid request budget applies.

The sources are Docker, Google, Apify, and email scanning. A compact Bright Data line shows connection, healthy exits, session traffic, and blocks, with a link to the full Settings report.

Coverage and queue panels are intentionally omitted from the compact widget. Warnings and errors use one unobtrusive row when healthy and expand into provider, affected work, retry, cooldown, preserved-result, and suggested-action details only when needed.

### Reporting Accuracy

- Counts come from persisted normalized records.
- Provider states come from recent heartbeats.
- Request budgets come from recorded attempts.
- Proxy health comes from verified route tests and live traffic events.
- Motion stops when heartbeats become stale.
- The UI never substitutes animation timers for backend progress.

## Detailed Settings Reports

Settings provides the full historical and account-level view that would overcrowd Command Radar:

- Bright Data zone status, bandwidth, cost, and authoritative remaining credits when available;
- Google request attempts by run;
- Apify usage by run;
- Docker success, empty-batch, block, and throughput trends;
- proxy exit health, latency, rotations, failures, and cooldown history;
- provider yield and duration;
- qualified contacts, raw contacts, and companies with qualified emails.

Account-level data is cached briefly and fetched with timeouts. Bright Data or Proxy Manager unavailability does not make the main application unavailable.

## Error Handling

- Provider results already persisted are preserved after any later provider error.
- Authentication, quota, budget, network, block, proxy, and parsing errors have distinct redacted codes and actionable messages.
- Retries are bounded and use backoff.
- A failed proxy manager does not terminate direct Google API work.
- A failed settings/report request does not terminate an active scraping run.
- Stale heartbeats cause a visible stalled state instead of an endlessly spinning animation.
- Credential errors provide a Replace action without echoing the rejected credential.

## Testing Strategy

Implementation follows test-driven development.

### Unit Tests

- query tier ordering and recovery activation;
- Google round-robin breadth before page-token depth;
- exact request-attempt budgeting;
- Google `displayName` normalization;
- Docker concurrency and batch checkpoint behavior;
- global website concurrency;
- continuous per-site persistence;
- email quality classification and deduplication;
- qualified versus raw lead counts;
- progress calculation and extended-run recalculation;
- stale-heartbeat animation state;
- proxy scoring, stickiness, rotation, cooldown, and fallback;
- redaction and secret-store behavior.

### Integration Tests

- fake Google, Docker, Apify, Bright Data, and Proxy Manager adapters;
- partial provider failure with preserved results;
- invalid, expired, and permission-limited tokens;
- Settings Test, Replace, and Delete flows;
- no secret values in browser payloads, SQLite, logs, snapshots, or audit records;
- Standard mode activates Docker and Google only;
- Hybrid Max Output activates Docker, Google, and Apify;
- Command Radar metrics match persisted session records.

### Controlled Live Verification

After the user enters credentials through the secure UI:

1. verify each credential separately;
2. verify Bright Data zone visibility and, separately, a real proxy exit IP;
3. run a low-budget Standard smoke test;
4. confirm Docker concurrency, Google breadth, live heartbeats, continuous contacts, and partial-result persistence;
5. run Hybrid Max Output only after Standard is healthy;
6. compare provider yield, qualified contacts, companies with email, duration, blocks, and spend with the previous baseline.

Real credentials are never placed in shell commands, committed files, test fixtures, or screenshots.

## Acceptance Criteria

The feature is ready when:

1. Leads-GenX remains available at `http://localhost:4177/` and is loopback-only by default.
2. Standard mode automatically runs Docker and Google together.
3. Hybrid Max Output additionally activates Apify.
4. Docker uses the safe four-page baseline and exposes truthful batch progress.
5. Google request attempts are exact and spread across locations before deep pagination.
6. Businesses and contacts appear continuously during the run.
7. Qualified lead count excludes raw, malformed, tracking, and placeholder contacts.
8. Saved credentials are masked, encrypted, replaceable, deletable, and absent from logs and SQLite.
9. Bright Data token validity, zone status, proxy readiness, and usage are displayed as separate facts.
10. Proxy traffic is enabled only after a verified exit-IP test.
11. Command Radar fits within one dashboard section, uses the approved compact anime-style A/D/G design, and stops animating when work stops.
12. Its provider report, budgets, yields, errors, and progress match persisted backend events.
13. Partial results survive provider and proxy failures.
14. Automated tests and controlled live smoke tests pass before a maximum-output run.
