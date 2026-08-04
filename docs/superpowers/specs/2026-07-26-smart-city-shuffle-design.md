# Smart City Shuffle Design

**Date:** 2026-07-26  
**Status:** Approved for planning

## Goal

Make `Nova, arrange my filters` produce a different, commercially sensible,
city-specific search on every click. The feature must work for both Google Maps
and Sales Navigator, preserve one-city precision, and avoid predictable
top-to-bottom rotation.

## User Experience

The Nova Shuffle control is available for both lead sources.

Each click:

1. chooses one city that is different from the currently arranged city;
2. chooses a curated role-and-industry pairing appropriate for that city;
3. replaces the active source's generated filters instead of accumulating
   broader filters;
4. shows the chosen segment and whether it is fresh territory or a learned
   performer.

Google Maps receives exactly one search term, business category, company type,
and city.

Sales Navigator receives exactly one decision-maker title, one canonical
LinkedIn industry, one city, and one company-headcount band. Nova does not fill
extra Sales Navigator filters merely to appear sophisticated; unnecessary
filters can over-constrain the result set.

Changing the active lead source changes which fields Nova fills. It never
modifies the hidden source's fields.

## Selection Model

Nova uses a curated shuffled city deck rather than a fixed list or arbitrary
cross-product.

- A browser keeps separate Google Maps and Sales Navigator histories of recently
  arranged combo IDs and cities in local storage.
- The client sends the active source and recent history with each request.
- The server validates that history against the curated library.
- While unvisited cities remain, the server excludes every city already seen in
  the current city cycle.
- When every curated city has appeared, the city history resets and a new
  shuffled cycle begins.
- The immediately previous city and combo remain excluded during the reset, so
  two consecutive clicks cannot repeat.
- Before every curated combination has at least one completed run, Nova chooses
  uniformly among the eligible combinations, which keeps discovery unbiased.
- After every combination has at least one completed run, Nova uses
  `1 + leads-per-run` as its random selection weight. Strong performers become
  more likely without becoming guaranteed. Weighting never overrides the
  no-immediate-repeat and city-coverage rules.
- Randomness changes order; it does not create unreviewed filter combinations.

The endpoint remains user-scoped for performance statistics. The recent deck is
browser-scoped so the interaction survives refresh without requiring a database
migration. A different device can have its own deck, while completed-run
learning remains shared through the user's server account.

## Curated Combo Contract

Each combo has shared market identity plus source-specific fields:

- stable combo ID;
- city and display label;
- rationale;
- Google Maps search term, category, and company type;
- Sales Navigator exact title, canonical LinkedIn industry, and headcount.

Every source-specific value must be present in the corresponding suggestion
library. City values must use the application's canonical `City, ST` format.
The library must contain enough distinct cities to make a rotation useful.

This explicit mapping prevents weak combinations such as treating a Maps
category as a LinkedIn industry or using a broad function name where Sales
Navigator expects a decision-maker title.

## API and UI Flow

`POST /api/shuffle/next` accepts:

- `source`: `google_maps` or `sales_navigator`;
- recent combo IDs;
- recent cities;
- the current combo ID.

The response returns:

- the selected shared combo;
- source-specific filter values;
- fresh-territory and learning metadata;
- updated recent combo and city history;
- a concise Nova explanation.

`freshTerritory` means the selected combo has no completed run in the current
user's run history. Changing from the old read-only request to `POST` reflects
that the client submits source-scoped deck state in the request body.

The browser stores only combo identifiers and city names—no credentials,
cookies, search URLs, or personal data.

The UI places the same Nova Shuffle action where it is reachable in either
source. On success it applies only the response fields for `activeSource`,
updates local history, and displays the selected city and segment. While a
request is active the button remains disabled to prevent double-click races.

## Failure Handling

- Invalid source values return a clear validation error.
- Unknown or stale history entries are ignored safely.
- If history excludes all combinations, Nova starts a new cycle while still
  excluding the immediately previous city and combo.
- If fewer than two distinct cities are configured, the domain selector fails
  a validation test rather than pretending it can guarantee rotation.
- A failed request leaves the currently displayed filters and stored deck
  unchanged.

## Compatibility and Scope

- Existing run creation, Bright Data routing, Apify routing, extension scraping,
  and lead ingestion remain unchanged.
- Existing `comboId` persistence continues to connect completed runs with
  leads-per-run learning.
- This feature does not generate or launch a search automatically; it only
  prepares precise filters.
- No database migration is required.

## Test Strategy

Domain tests prove:

- every combo uses valid Google Maps and Sales Navigator suggestion values;
- one city and one precise value per required filter are returned;
- consecutive selections cannot repeat the combo or city;
- every eligible city is visited before a city cycle resets;
- injected randomness changes order without allowing invalid combinations;
- learned weighting influences eligible choices without breaking rotation;
- stale history is ignored and exhausted history resets safely.

API tests prove:

- both sources receive the correct source-specific response;
- user-scoped run statistics still drive learning;
- invalid sources receive a clear error.

Static UI tests prove:

- the Nova control is available from both source views;
- Google Maps fields and Sales Navigator fields are applied separately;
- recent history is stored without secrets;
- failed requests do not clear existing filters.

The final release gate is a fresh Prisma database, the full test suite, a clean
TypeScript build, and JavaScript syntax checks for changed browser files.
