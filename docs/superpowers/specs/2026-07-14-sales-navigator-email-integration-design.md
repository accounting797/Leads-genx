# Sales Navigator Email Integration Design

## Goal

Finish the Sales Navigator source so Leads-GenX can run an authorized LinkedIn Sales Navigator search through Apify and retain only leads that include an email address. This change must not modify the committed Google Maps providers, query expansion, local scraper integration, or Google Places behavior.

## Actor Contract

Use `harvestapi/linkedin-sales-navigator-lead-search-cookie` as the default Sales Navigator actor. Its input will use:

- `profileScraperMode: "Full + email search"`
- `cookie`: the operator's exported LinkedIn cookies as a JSON string
- `userAgent`: the browser user-agent string associated with the session
- `startPage: 1`
- `takePages`: `ceil(maxResults / 25)`, capped at 100 pages
- `salesNavUrl`: the supplied Sales Navigator people-search URL, when present
- `searchQuery`, `currentJobTitles`, and `locations`: structured-filter fallback when no URL is supplied

A single run is limited to 2,500 requested profiles because the actor accepts at most 100 pages and each page contains 25 profiles.

## Validation

Sales Navigator runs require an Apify token, exported cookie JSON, a browser user agent, and either a valid Sales Navigator people-search URL or at least one structured professional filter. Cookie JSON must parse to a non-empty array of objects containing non-empty `name` and `value` strings. Sales Navigator URLs must use HTTPS, a LinkedIn hostname, and the `/sales/search/people` path.

Validation errors remain field-specific and never echo cookie contents, user-agent contents, or API tokens.

## Secret Handling

Cookies and browser user agents are request-scoped actor credentials. They must not be written to `Run.filterJson`, events, errors, logs, API responses, or README examples containing real values. Run persistence keeps only non-sensitive Sales Navigator filters.

## Output Normalization

Normalize HarvestAPI profile rows from top-level fields such as `firstName`, `lastName`, `headline`, `linkedinUrl`, `location`, `email`, `workEmail`, and common email-array variants. Preserve the existing email-only save behavior, so actor profiles without an email are not counted as usable leads.

## UI

Keep the current Sales Navigator filter surface. Add explicit fields for exported LinkedIn cookie JSON and browser user agent. The frontend submits both fields only for Sales Navigator runs and limits the numeric result field to 2,500 while that source is active. Google Maps source switching restores its existing high-volume maximum behavior.

## Testing

Add focused tests for:

- HarvestAPI actor ID and exact input keys.
- URL mode and structured-filter mode.
- 100-page cap and 2,500-result validation.
- Missing or malformed cookies and missing user agent.
- Removal of secrets from persisted run filters.
- HarvestAPI profile and email normalization.
- Static UI fields and request wiring.

Run the focused tests first, then the complete Vitest suite, TypeScript build, local health check, and browser smoke checks at desktop and mobile widths.
