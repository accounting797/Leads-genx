# Sales Navigator Email Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete a secret-safe HarvestAPI Sales Navigator integration that requests email enrichment and saves email leads without changing Google Maps behavior.

**Architecture:** Extend the existing Sales Navigator filter type with request-scoped actor credentials, validate the HarvestAPI contract at the API boundary, and build actor-specific input in `sourceInputBuilder`. Keep persistence secret-free in `runService`, normalize HarvestAPI output in `leadNormalizer`, and expose only the required fields in the existing vanilla-JS dashboard.

**Tech Stack:** TypeScript, Express, Vitest, vanilla JavaScript, Apify Client, SQLite/Prisma.

## Global Constraints

- Do not change Google Maps, Google Places, Hybrid, or local Maps scraper behavior.
- Default Sales Navigator actor: `harvestapi/linkedin-sales-navigator-lead-search-cookie`.
- Sales Navigator profile mode: `Full + email search`.
- A Sales Navigator run requests at most 2,500 profiles or 100 pages.
- Cookies and user agent must never be persisted or logged.
- Production behavior changes follow a failing-test-first cycle.

---

### Task 1: Actor Input And Validation

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/domain/validation.ts`
- Modify: `src/domain/sourceInputBuilder.ts`
- Test: `tests/domain/validation.test.ts`
- Test: `tests/domain/sourceInputBuilder.test.ts`

**Interfaces:**
- Consumes: `ValidatedRunInput`, `SalesNavigatorFilters`.
- Produces: HarvestAPI actor input with `profileScraperMode`, `cookie`, `userAgent`, `startPage`, `takePages`, and URL-or-filter search fields.

- [ ] **Step 1: Write failing actor-contract tests**

Add assertions that the default actor is `harvestapi/linkedin-sales-navigator-lead-search-cookie`, credentials stay strings, URL mode uses `salesNavUrl`, filter mode uses `searchQuery`, `currentJobTitles`, and `locations`, and 2,500 results maps to 100 pages.

- [ ] **Step 2: Run actor-contract tests and confirm expected failures**

Run: `npm.cmd test -- tests/domain/sourceInputBuilder.test.ts tests/domain/validation.test.ts`

Expected: failures reference the old actor ID, missing user agent, wrong cookie key, or missing limit validation.

- [ ] **Step 3: Implement minimal types, validation, and actor mapping**

Add `userAgent?: string`, validate cookie JSON as a non-empty cookie array, validate Sales Navigator people-search URLs, require the user agent, reject Sales Navigator `maxResults > 2500`, and build the documented HarvestAPI input.

- [ ] **Step 4: Run focused tests**

Run: `npm.cmd test -- tests/domain/sourceInputBuilder.test.ts tests/domain/validation.test.ts`

Expected: all focused tests pass.

### Task 2: Secret-Safe Persistence And Output Normalization

**Files:**
- Modify: `src/domain/runService.ts`
- Modify: `src/domain/leadNormalizer.ts`
- Test: `tests/domain/runService.test.ts`
- Test: `tests/domain/leadNormalizer.test.ts`

**Interfaces:**
- Consumes: validated Sales Navigator input and HarvestAPI dataset items.
- Produces: secret-free `filterJson` and normalized person leads containing email addresses.

- [ ] **Step 1: Write failing persistence and normalization tests**

Assert `filterJson` excludes cookie and user-agent marker strings. Assert top-level HarvestAPI profile fields and email-array variants normalize to the existing `NormalizedLead` interface.

- [ ] **Step 2: Run focused tests and confirm expected failures**

Run: `npm.cmd test -- tests/domain/runService.test.ts tests/domain/leadNormalizer.test.ts`

Expected: the persistence test finds credentials and the new output-shape test lacks one or more normalized fields.

- [ ] **Step 3: Implement minimal sanitization and normalization**

Construct a new persisted Sales Navigator filter object without `cookies` or `userAgent`. Add safe nested/string-array helpers for common HarvestAPI output fields.

- [ ] **Step 4: Run focused tests**

Run: `npm.cmd test -- tests/domain/runService.test.ts tests/domain/leadNormalizer.test.ts`

Expected: all focused tests pass.

### Task 3: Dashboard Contract

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Test: `tests/public/staticUi.test.ts`

**Interfaces:**
- Consumes: existing Sales Navigator form and source switch.
- Produces: `salesNavigator.cookies`, `salesNavigator.userAgent`, and a source-specific 2,500-result ceiling.

- [ ] **Step 1: Write failing static UI tests**

Assert the cookie and user-agent controls exist, both are submitted only under `salesNavigator`, and source switching applies/removes the 2,500 ceiling without changing Google provider defaults.

- [ ] **Step 2: Run the UI test and confirm expected failure**

Run: `npm.cmd test -- tests/public/staticUi.test.ts`

Expected: failure for the missing user-agent field or source-specific limit behavior.

- [ ] **Step 3: Implement the UI contract**

Add `snUserAgent`, wire it into `buildBody`, and update `setSource` to use `max=2500` for Sales Navigator while restoring a high Google Maps ceiling.

- [ ] **Step 4: Run the UI test**

Run: `npm.cmd test -- tests/public/staticUi.test.ts`

Expected: all UI tests pass.

### Task 4: Documentation And Verification

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Produces: accurate actor configuration and local operation notes without real secrets.

- [ ] **Step 1: Update configuration documentation**

Set `DEFAULT_SALES_NAVIGATOR_ACTOR_ID` to `harvestapi/linkedin-sales-navigator-lead-search-cookie` and document the request-scoped cookie/user-agent requirement and 2,500-profile per-query limit.

- [ ] **Step 2: Run complete verification**

Run: `npm.cmd test`

Expected: zero failed tests.

Run: `npm.cmd run build`

Expected: TypeScript exits successfully.

Run: `Invoke-WebRequest http://localhost:4177/api/health -UseBasicParsing`

Expected: HTTP 200 with `status: "ok"`.

- [ ] **Step 3: Inspect scope and secret leakage**

Run: `git diff --check` and inspect `git diff --name-only 52b2ee1..HEAD` plus the working-tree diff. Confirm no Google source file is changed by this implementation and no literal cookie values exist in tracked documentation.

- [ ] **Step 4: Commit the completed integration**

Stage only the Sales Navigator files and commit with `feat: complete sales navigator email integration`.
