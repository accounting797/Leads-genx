# Google-Only Scale Upgrade Design

## Scope

Upgrade Leads-GenX so Google Maps / Google Business runs can produce much larger email-only output without requiring Apify. The primary provider will remain the official Google Places API, using the operator's paid Google API key. Apify remains optional and additive for hybrid runs when extra Apify credentials are available.

This design does not add browser automation against Google Maps pages. The app will avoid brittle page scraping and focus on stable Google Places API calls plus deeper business-website email discovery.

## Goals

- Make Google-only runs strong enough to target thousands of email leads per session when enough matching businesses expose emails on their websites.
- Use official Google Places Text Search as the source of business records.
- Expand one operator request into many controlled search shards across industries, terms, company types, and locations.
- Rotate multiple Google API keys when provided and retry failed requests on the next key.
- Save email leads live as they are discovered.
- Keep output email-only: downloadable TXT remains one email per line.
- Keep Apify optional; Google-only should not depend on an Apify token.
- Preserve current architecture, tests, UI style, and database schema unless a schema change is clearly necessary.

## Non-Goals

- No browser-based Google Maps scraping.
- No CAPTCHA bypass, stealth automation, or account/session automation.
- No guarantee that every business produces an email. The system can maximize source businesses and website scans, but email yield depends on whether target websites publish usable addresses.
- No paid third-party email enrichment service in this iteration.
- No CRM integration or email verification in this iteration.

## Recommended Approach

Use a `GooglePlacesScaleClient` behavior inside the existing Google Places integration instead of importing a separate scraper stack. The local `email-leads-generator` repo contains useful operational ideas such as segmentation, retries, progress, and key rotation, but its scraper code is LinkedIn/Harvest-oriented and is not a direct Google Maps provider.

The implementation will strengthen the current code in three layers:

1. Source expansion: generate more high-intent Google Places queries from the selected search terms, categories, company types, and locations.
2. Source collection: page through Google Places results per query, rotate keys, dedupe places globally, and continue on per-query failures.
3. Email discovery: crawl each business website more deeply and save unique email leads in batches while the run is still active.

## Data Flow

1. The operator starts a Google Maps run with provider `google_places` or `hybrid`.
2. Validation accepts Google-only runs with a Google API key and no Apify token.
3. The query builder expands filters into a shard list:
   - direct search terms by location,
   - category by location,
   - company type by location,
   - term plus category by location,
   - term plus company type by location,
   - category plus company type by location.
4. The Google client executes shards until either `maxResults` unique businesses are collected or shards are exhausted.
5. Each API request uses the current Google key. On request failure, the same page is retried with the next key before the shard is considered failed.
6. Returned businesses are normalized and deduped by place id, Maps URL, website, phone, or name/address fallback.
7. Website email discovery scans home, contact, about, team, locations, staff, leadership, sales, support, quote, service-area, and discovered internal contact-like pages.
8. Email leads are saved live in batches and run events show source businesses, websites scanned, emails found, shard progress, and failures.
9. TXT download and per-run copy continue to return emails only, one per line.

## Google Places Scaling Rules

The current Google Places Text Search API page size is limited, so scale must come from many precise searches rather than one giant request. The app will:

- keep `maxResults` as the total source-business target for the run,
- preserve the existing query expansion,
- add shard-level progress events such as `google_places_shard_started`, `google_places_shard_completed`, and `google_places_shard_failed`,
- continue after individual shard failures,
- dedupe businesses across all shards before website crawling,
- stop once the run reaches the requested source-business target or all shards are complete.

If the user selects a very high target, the system should be transparent: the live progress must show how many Google businesses were found, how many had websites, and how many unique emails were saved.

## Website Email Discovery Upgrade

The email extractor will remain HTTP-based and site-level failures will not fail the whole run. It will be upgraded to:

- scan more useful contact-oriented paths,
- follow discovered internal links with contact, sales, quote, team, staff, leadership, location, directory, or branch keywords,
- normalize and dedupe emails globally,
- ignore asset and placeholder emails,
- preserve current timeout behavior so slow sites do not block the entire run,
- keep bounded concurrency to avoid exhausting the local machine.

The default concurrency can be higher for large Google runs, but it must stay configurable from `createRunService` so tests and future UI controls can tune it.

## Error Handling

Google-only runs should fail only when the Google source itself cannot produce usable results due to invalid credentials, exhausted keys, or repeated API failures before any source data is collected. Per-query failures should be warnings.

Hybrid runs should continue to preserve whichever provider succeeds:

- Apify shard failures are warnings when Google is also available.
- Google shard failures are warnings when Apify has already produced source businesses or can continue.
- Terminal run status should be `completed` when at least one provider path completed and the run lifecycle reached the end, even if email count is zero.

All credentials remain redacted in events, errors, and API responses.

## UI Impact

The existing UI can support this without a major redesign. The Google Maps provider selection remains:

- Apify
- Google Places
- Hybrid max output

For this upgrade, Google Places and Hybrid runs should show richer live progress through existing run events. A later UI pass can add advanced controls for shard limits, website page depth, and email scan concurrency, but the first implementation should choose strong defaults.

## Testing Strategy

Use test-first changes around existing modules:

- `googlePlacesClient.test.ts`: verifies shard continuation, dedupe behavior, key fallback, and max-result stopping.
- `runService.test.ts`: verifies Google-only high-output runs save live email leads, record Google shard diagnostics, and complete without Apify.
- `emailExtractor.test.ts`: verifies deeper internal contact page discovery and email filtering.
- `validation.test.ts`: verifies Google-only runs do not require Apify.
- Full suite and TypeScript build must pass before completion.

## Acceptance Criteria

- A Google Places run can start with only a Google API key and no Apify token.
- Multiple Google API keys can be pasted and rotated.
- Google source collection uses expanded query shards and continues past individual shard failures.
- Duplicate businesses from overlapping shards are removed before email crawling.
- Email leads are saved live during the run.
- Downloads and copy actions remain email-only, one per line.
- Existing Apify and hybrid functionality still passes tests.
- `npm.cmd test` and `npm.cmd run build` pass.
