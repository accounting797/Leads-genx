# Greenhouse Hiring Signals and Nova Opportunity Watchlist

**Date:** 2026-07-25  
**Status:** User-approved design  
**Application:** Leads-GenX

## Purpose

Add a public Greenhouse hiring-signal lane that helps Nova identify companies
with timely buying intent. The lane enriches companies already found in a run
and discovers a small number of closely related companies without mixing Google
Maps businesses with Sales Navigator people.

Greenhouse is supplemental evidence, not a lead source that silently creates
contacts. A company remains a hiring opportunity until the user explicitly
chooses a Google Maps company search or a Sales Navigator decision-maker search.

## Goals

1. Automatically inspect relevant Greenhouse job boards after a run completes.
2. Highlight recent hiring in sales, operations, finance, marketing, and
   leadership.
3. Add hiring evidence to existing companies without duplicating them.
4. Surface up to five strong adjacent companies outside the original result set.
5. Give Nova enough freedom to notice nearby opportunities while requiring a
   plain-English explanation and evidence for every recommendation.
6. Keep the hiring scan non-blocking, restart-safe, bounded, and manually
   refreshable.
7. Preserve strict separation between Google Maps leads, Sales Navigator leads,
   and unpromoted hiring opportunities.

## Non-goals

- Greenhouse does not produce named contacts or verified emails.
- The lane does not change a lead's `leadSource`.
- The lane does not insert contact-less rows into `Lead` or inflate lead counts.
- Nova does not automatically start Google, Apify, Bright Data, or Sales
  Navigator searches from a hiring signal.
- The first release does not require a Bright Data SERP or Web Unlocker product.
- The scanner does not guess arbitrary Greenhouse board tokens or enumerate
  Greenhouse accounts.
- A hiring-signal failure never reopens, downgrades, or delays the parent run.

## Source Contract

Greenhouse's public Job Board API exposes unauthenticated GET endpoints for a
known board token:

`GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true`

The response provides published jobs, titles, locations, departments, job URLs,
and `updated_at`. Greenhouse does not document a global board directory or a
universal first-published timestamp. Nova therefore describes freshness as
"updated recently," never invents a posting date, and treats `updated_at` as
the bounded recency signal.

Board tokens come from three honest sources:

1. Greenhouse links found on the websites or careers pages of companies already
   present in the run.
2. A small, versioned starter registry of manually verified public boards.
3. Public boards learned from previous scans and revalidated before reuse.

The provider boundary permits a future opt-in discovery adapter, such as Bright
Data web search, but the initial lane works without new credentials or paid
requests.

References:

- https://developers.greenhouse.io/job-board.html
- https://support.greenhouse.io/hc/en-us/articles/5888210160155-Find-your-job-board-URL

## Three-Lane Separation Contract

The product presents and stores three distinct views:

1. **Google Maps leads:** businesses and contacts originating from a Google Maps
   run.
2. **Sales Navigator leads:** people originating from HarvestAPI, Bright Data
   people search, or the Sales Navigator extension.
3. **Hiring opportunities:** company-level Greenhouse signals that have not been
   promoted into a source-specific search.

Greenhouse enrichment preserves the original lane:

- A matched Google Maps company remains in Google Maps and receives a
  `Hiring now` annotation.
- A matched Sales Navigator company remains in Sales Navigator and receives the
  same annotation.
- A company already matched to either lane is not duplicated in Hiring
  opportunities.
- An adjacent Greenhouse company stays only in Hiring opportunities until the
  user selects a source-specific next action.

The UI and API always carry an explicit `originLane` of `google_maps`,
`sales_navigator`, or `hiring_opportunity`. No inference from display position
or missing contact fields is allowed.

## Architecture

### Hiring Signal Coordinator

A durable `HiringSignalScan` is queued only after the parent run reaches
`completed` or `partially_completed` with at least one company candidate.
Failed, cancelled, paused, or waiting runs do not trigger an automatic scan.
The scan has its own status, timestamps, heartbeat, retry state, and summary
counts. It never participates in the parent run's completion promise.

The coordinator:

1. Captures the parent run's industry, role keywords, and geography.
2. Builds a bounded company candidate set.
3. Resolves and validates Greenhouse boards.
4. Fetches cached or fresh job data.
5. Scores matches and adjacent opportunities.
6. Persists evidence and emits a concise Nova event.

On application startup, queued scans and stale running scans are recovered.
Only one active scan is allowed per run. A manual refresh reuses the existing
scan record when one is active and creates a new observation only after the
previous scan is terminal.

### Candidate Collection

Candidates are ordered as follows:

1. Companies already represented by leads in the parent run.
2. `DiscoveredBusiness` rows that did not produce a qualified contact.
3. Registry companies matching the run's geography and industry.
4. Adjacent registry companies with a strong role and geography relationship.

Website discovery is deliberately shallow: the company homepage and at most one
careers-like link may be fetched. The scanner extracts only explicit
`boards.greenhouse.io`, `job-boards.greenhouse.io`, or Greenhouse embed/API
references. It does not brute-force tokens.

A scan evaluates at most 25 boards. Existing-run companies take precedence.
No more than five unmatched adjacent companies may be surfaced.

### Greenhouse Client

The Greenhouse client is an isolated integration with:

- a 10-second timeout per Job Board API request;
- an 8-second timeout per company website page;
- concurrency of three;
- at most two website pages per company;
- a six-hour successful-response cache;
- two attempts for transient network or 5xx failures;
- no retry for confirmed 404 or invalid-board responses.

Long scans emit a heartbeat every 15 seconds. Cache entries include the board
token, retrieval time, response status, and normalized jobs. Raw HTML and
unbounded job descriptions are not persisted.

### Persistence

The data model adds three focused records:

- `HiringSignalScan`: run ownership, lifecycle, heartbeat, candidate counts,
  matched counts, and safe error summary.
- `GreenhouseBoard`: public company identity, verified board token, evidence
  URL, discovery source, last verification time, and cache metadata.
- `HiringOpportunity`: scan ownership, company identity, explicit origin lane,
  score, matching-job summary, evidence JSON, and observation time.

`HiringOpportunity` holds company-level evidence only. Matching uses normalized
website domain first and normalized company name second. Ambiguous name-only
matches remain unlinked and appear as opportunities rather than annotating the
wrong lead.

All records remain scoped through the owning run and user when returned by the
API. Public board metadata may be reused internally, but one user's run,
filters, matches, scores, and dismissals are never exposed to another user.

## Relevance and Scoring

Only jobs in these buying-intent groups qualify:

- sales and revenue;
- operations and supply chain;
- finance and accounting;
- marketing and growth;
- executive or functional leadership.

Title matching uses a curated, tested vocabulary with exclusions for misleading
matches. Department data supplements title matching but does not override an
unrelated title.

The score is transparent and capped at 100:

- **Relevant roles — 35 points:** strength and count of qualifying openings.
- **Recency — 25 points:** strongest when updated within seven days, decreasing
  through day 30; jobs older than 30 days add no score.
- **Geography — 20 points:** exact requested geography, then nearby or remote
  compatibility.
- **Industry relationship — 15 points:** exact industry first, then a curated
  adjacent-industry relationship.
- **Breadth — 5 points:** qualifying openings across multiple departments.

Existing companies with scores of 70 or more receive an automatic highlight.
Adjacent companies require a score of at least 80 and are limited to the five
highest scores. Deterministic tie-breaking uses relevant-job count, newest
update, then company name.

Every score response includes a component breakdown. Nova never shows a score
without the job titles, Greenhouse URLs, locations, freshness, and a concise
reason it relates to the user's search.

## Nova Behavior

Nova remains attentive without becoming noisy:

- After a scan, she adds at most two hiring-signal lines to the analyst panel.
- She prioritizes a strong existing-company match over an adjacent discovery.
- She says "updated recently" and shows the date Greenhouse supplied.
- She labels adjacent-industry or nearby-location reasoning explicitly.
- A successful hiring signal does not change the operational health verdict.
- A failed or partial hiring scan produces an informational note, not
  `Needs a look` or `Needs your help`, unless the user explicitly requested a
  refresh and the lane cannot inspect any candidate.
- Repeated unchanged scans do not repeat notifications.

Example:

> Acme Logistics is hiring a VP of Operations and three regional sales roles.
> Those jobs were updated six days ago around Dallas, which closely matches your
> logistics search.

## User Experience

### Existing Lead Views

Google Maps and Sales Navigator remain separate views. A matched company receives
a compact `Hiring now` badge. Expanding it shows:

- signal score and component breakdown;
- relevant job titles;
- Greenhouse update dates and locations;
- evidence links;
- Nova's explanation.

The badge does not alter lead ordering unless the user chooses the
`Hiring signal` sort.

### Hiring Opportunities View

The third view is a company watchlist, not a contact list. Each card contains:

- company name and website;
- signal score;
- relevant opening count;
- job titles, locations, and update dates;
- exact or adjacent relationship;
- Greenhouse evidence links;
- `Find business on Google Maps`;
- `Find decision-makers with Sales Navigator`;
- `Save for later`;
- `Dismiss`.

The two search actions prefill the appropriate run form and switch to that lane.
They do not start a run or spend paid API budget without the user's normal
submission action.

Saved and dismissed state is per user. Dismissed opportunities stay hidden until
their evidence materially changes or the user restores them.

### Manual Refresh

The Hiring opportunities view includes `Ask Nova to check again`. While a scan
is active, the button reports live status rather than starting a duplicate.
The UI displays the last successful observation time and whether cached data was
used.

## API Contract

- `GET /api/runs/:id/hiring-signals` returns scan status, lane-separated matched
  annotations, adjacent opportunities, evidence, and safe Nova summaries.
- `POST /api/runs/:id/hiring-signals/refresh` queues or returns the active scan.
- `POST /api/hiring-opportunities/:id/prepare-search` returns safe form values
  for either `google_maps` or `sales_navigator`; it never starts a run.
- `PATCH /api/hiring-opportunities/:id` updates `saved` or `dismissed` state.

All endpoints enforce the existing run ownership and admin visibility rules.
Responses never include raw HTML, credentials, internal stack traces, or another
user's observations.

## Failure and Recovery Behavior

- A missing Greenhouse board is a normal skip.
- An inaccessible careers page does not prove the company lacks a board.
- A malformed job is skipped while valid jobs from the same board continue.
- A board timeout or 5xx is retried twice, then recorded as a partial scan.
- A 404 invalidates the cached board association until it is rediscovered.
- Restart recovery resumes bounded work from persisted scan state.
- Cancellation stops new requests and retains already persisted observations.
- The parent lead run remains terminal under every hiring-lane outcome.

Nova reports what was checked, what was skipped, and whether existing evidence
was preserved.

## Testing Strategy

### Unit Tests

- Greenhouse URL and board-token extraction.
- Job normalization and title classification.
- Thirty-day freshness cutoff.
- Score components, thresholds, caps, and deterministic tie-breaking.
- Exact, adjacent, ambiguous, and rejected company matches.
- Strict origin-lane preservation.
- Candidate and adjacent-company limits.
- Cache freshness and invalidation.

### Integration Tests

- Hard timeouts and bounded retry behavior.
- Maximum concurrency of three.
- Partial results when one board fails.
- Durable scan recovery after a simulated restart.
- Automatic scan scheduling only after eligible completed or partially
  completed runs with company candidates.
- Manual refresh idempotency.
- No mutation of the parent run's status or lead counts.

### API and UI Tests

- Ownership isolation and safe response shapes.
- Separate Google Maps, Sales Navigator, and Hiring opportunities views.
- Hiring annotations do not duplicate existing companies.
- Search preparation fills only the selected source form and never starts it.
- Nova shows evidence-backed explanations and suppresses unchanged notices.
- JavaScript syntax checks for every edited public file.

## Acceptance Criteria

The feature is complete when:

1. A completed run can schedule and recover a bounded hiring scan.
2. Existing Google Maps and Sales Navigator companies receive source-preserving
   hiring annotations.
3. Up to five score-80 adjacent companies appear only in Hiring opportunities.
4. Scores use qualifying jobs updated within 30 days and expose their breakdown.
5. Users can prepare—but not automatically launch—a source-specific follow-up
   search.
6. Greenhouse failures cannot delay or alter the parent run.
7. Nova explains strong signals with dates, roles, locations, and evidence.
8. The full isolated test suite and production build pass.
