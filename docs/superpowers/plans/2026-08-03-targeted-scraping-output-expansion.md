# Targeted Scraping Output Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Targeted Scraping pilot into a geography-safe, automatic bank-market workflow that executes public document extraction, accepts explicitly published business contacts on consumer mail providers, and adapts work toward high-Strict-yield sources.

**Architecture:** Keep the dedicated targeted campaign subsystem. Add focused market-resolution, geography-evidence, document-fetching/parsing, source-association, and adaptive-priority units; orchestrate them from `TargetedService` and persist their decisions through the existing Prisma store. Keep Docker Google Maps and Google Places as the business-discovery lane while a bounded public-document lane processes discovered links and administrator-provided/search-discovered URLs.

**Tech Stack:** Node.js 26, TypeScript 6, Express 5, Prisma 5/SQLite, Vitest 3, Docker Google Maps scraper, Google Places API, Node `fetch`/DNS, `pdfjs-dist`, `xlsx`, `mammoth`, and `csv-parse`.

## Global Constraints

- Public B2B and publicly presented professional contact data only.
- US and Canada are hard eligibility boundaries; missing geography can never be Strict.
- Default bank market limit is 25 and remains adjustable.
- Canonical order is `area code -> city -> state/province -> ZIP/postal code`.
- Consumer-provider email qualifies only when explicitly presented as the targeted business/professional contact.
- Only Strict contacts appear by default or enter exports.
- Domain MX is not represented as mailbox verification or guaranteed inbox placement.
- No new paid provider is required; connector limits and unavailable coverage are reported honestly.
- Every behavior change follows red-green-refactor and preserves restart-safe checkpoints.

---

## File Structure

- `src/domain/targeted/bankCatalog.ts`: stable bank identifiers, FDIC names/certificates, country, and Canadian locator metadata.
- `src/domain/targeted/fdicBankMarkets.ts`: fetch and rank US branch markets, deriving area codes from branch telephone numbers with a bundled fallback index.
- `src/domain/targeted/canadianBankMarkets.ts`: bounded Canadian public-locator adapter with provenance and explicit unavailable errors.
- `src/domain/targeted/geographyEvidence.ts`: normalize and hard-gate US/Canadian address, postal, telephone, and country evidence.
- `src/domain/targeted/promptIntent.ts`: convert the plain-language prompt into explicit deterministic intent terms.
- `src/domain/targeted/queryPlanner.ts`: emit executable area-code-first HTML/document work units without location-free country campaigns.
- `src/domain/targeted/publicContactAssociation.ts`: distinguish associated organization-domain and explicitly published consumer-provider contacts.
- `src/domain/targeted/artifactFetcher.ts`: SSRF-safe bounded public artifact retrieval.
- `src/domain/targeted/documentExtractor.ts`: dispatch HTML/PDF/XLS/XLSX/CSV/DOCX/TXT parsing and return provenance-linked text sections.
- `src/domain/targeted/adaptiveScheduler.ts`: transparent exploration/yield scoring for pending work units.
- `src/domain/targeted/service.ts`: orchestrate planning, discovery, artifact extraction, qualification, metrics, and checkpoints.
- `src/domain/targeted/store.ts`: persist resolved filters, artifact metadata, yield metrics, priorities, and default Strict queries.
- `prisma/schema.prisma` and a new migration: add priority/metrics/provenance fields without destroying current campaigns.
- `public/index.html`, `public/app.js`, `public/api.js`, `public/styles.css`: reduce the wizard and expose automatic progress/advanced audit controls.

---

### Task 1: Reproduce and close the foreign-geography failure

**Files:**
- Create: `src/domain/targeted/geographyEvidence.ts`
- Modify: `src/domain/targeted/relevance.ts`
- Modify: `src/domain/targeted/service.ts`
- Test: `tests/domain/targeted/geographyEvidence.test.ts`
- Test: `tests/domain/targeted/relevance.test.ts`
- Test: `tests/domain/targeted/service.test.ts`

**Interfaces:**
- Produces: `evaluateGeography(candidate, target): GeographyDecision` where status is `match | ambiguous | foreign` and evidence/reason are explicit.
- Consumes: `TargetedGeography` and structured candidate address/phone/country fields.

- [ ] **Step 1: Write failing tests for the observed Lagos result and missing geography**

```ts
it('never marks a Lagos address Strict for a US target', () => {
  const result = scoreTargetedCandidate({
    email: 'info@company.ng', companyName: 'Public Logistics Company',
    address: '12 Example Road, Lagos 100001, Lagos, Nigeria',
  }, { ...filters, country: 'US', areaCodes: [], states: [], cities: [], postalCodes: [] });
  expect(result.tier).toBe('rejected');
  expect(result.reason).toBe('target_mismatch');
});

it('does not allow ambiguous geography to become Strict', () => {
  const result = evaluateGeography({ address: '', phone: '' }, {
    country: 'US', areaCode: '', state: '', city: '', postalCode: '',
  });
  expect(result).toMatchObject({ status: 'ambiguous', strictEligible: false });
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm.cmd test -- tests/domain/targeted/geographyEvidence.test.ts tests/domain/targeted/relevance.test.ts`

Expected: FAIL because `evaluateGeography` does not exist and Lagos currently scores Strict.

- [ ] **Step 3: Implement normalized hard geography decisions**

Implement country-name, US ZIP/state, Canadian postal/province, target city, and telephone-area-code checks. Tokenize on address boundaries; never use arbitrary substring matching for short region tokens. Explicit `Nigeria`, `.ng` plus Nigerian address context, or any other foreign-country evidence returns `foreign`. Missing evidence returns `ambiguous`, which may be Review but never Strict.

- [ ] **Step 4: Pass geography decisions into relevance and persist reason codes**

`scoreTargetedCandidate` must reject `foreign`, cap `ambiguous` at Review, and award geography score only for `match`. `TargetedService.processLead` passes the work unit geography rather than the original unresolved filter arrays.

- [ ] **Step 5: Verify GREEN and regression coverage**

Run: `npm.cmd test -- tests/domain/targeted/geographyEvidence.test.ts tests/domain/targeted/relevance.test.ts tests/domain/targeted/service.test.ts`

Expected: PASS, including the Lagos regression.

---

### Task 2: Resolve and persist automatic bank markets

**Files:**
- Create: `src/domain/targeted/bankCatalog.ts`
- Create: `src/domain/targeted/canadianBankMarkets.ts`
- Modify: `src/domain/targeted/fdicBankMarkets.ts`
- Modify: `src/domain/targeted/types.ts`
- Modify: `src/domain/targeted/service.ts`
- Modify: `src/domain/targeted/store.ts`
- Test: `tests/domain/targeted/fdicBankMarkets.test.ts`
- Test: `tests/domain/targeted/service.test.ts`

**Interfaces:**
- Produces: `resolveBankMarkets(bankIds: string[], country: TargetedCountry, limit: number): Promise<ResolvedBankMarket[]>`.
- `ResolvedBankMarket` includes bankId, bankName, country, areaCodes, city, region, postalCodes, locationCount, sourceUrl, and retrievedAt.

- [ ] **Step 1: Write failing FDIC tests using actual response field shapes**

```ts
it('ranks FDIC markets and derives leading branch telephone area codes', () => {
  const markets = rankBankMarkets([
    { NAME: 'JPMORGAN CHASE BANK, NATIONAL ASSOCIATION', CITY: 'Phoenix', STALP: 'AZ', ZIP: '85001', TELEPHONE: '6025550100' },
    { NAME: 'JPMORGAN CHASE BANK, NATIONAL ASSOCIATION', CITY: 'Phoenix', STALP: 'AZ', ZIP: '85004', TELEPHONE: '6025550101' },
  ]);
  expect(markets[0]).toMatchObject({ city: 'Phoenix', state: 'AZ', areaCodes: ['602'], branchCount: 2 });
});
```

Also assert the FDIC request uses the catalog's exact institution identity and requests `TELEPHONE`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm.cmd test -- tests/domain/targeted/fdicBankMarkets.test.ts tests/domain/targeted/service.test.ts`

Expected: FAIL because telephone is not requested/parsed and empty market results still create generic work.

- [ ] **Step 3: Implement stable bank catalog and ranked market resolution**

Map Chase to its actual FDIC institution name/certificate and add the existing US bank list. Prefer certificate/ID filters over loose display names. Count area codes from valid branch telephone values; use the bundled city fallback only when the source lacks telephone data.

- [ ] **Step 4: Make market resolution fail closed and persist resolved filters**

When bank mode has no manual geography, resolve top-N markets before planning. If zero are returned, throw `TargetedValidationError` with `bankIds: 'No US/Canadian bank markets were resolved; no unrestricted search was created.'`. Persist the resolved arrays and provenance before replacing work units so execution/restarts score against the same scope.

- [ ] **Step 5: Add Canadian adapter behavior**

Return evidence-backed public locator results when configured; otherwise raise a visible `market_source_unavailable` error and require manual Canadian geography. Never fall back to worldwide discovery.

- [ ] **Step 6: Verify GREEN**

Run: `npm.cmd test -- tests/domain/targeted/fdicBankMarkets.test.ts tests/domain/targeted/service.test.ts tests/api/targetedApi.test.ts`

Expected: PASS; a Chase campaign has non-empty area-code/city/state/ZIP work units or planning fails visibly.

---

### Task 3: Enforce prompt intent and canonical query ordering

**Files:**
- Create: `src/domain/targeted/promptIntent.ts`
- Modify: `src/domain/targeted/queryPlanner.ts`
- Modify: `src/domain/targeted/service.ts`
- Test: `tests/domain/targeted/promptIntent.test.ts`
- Test: `tests/domain/targeted/queryPlanner.test.ts`

**Interfaces:**
- Produces: `derivePromptIntent(prompt: string): { keywords: string[]; industries: string[] }`.
- Consumes: persisted resolved campaign filters.

- [ ] **Step 1: Write failing tests for the user's logistics/aviation/power prompt**

```ts
expect(derivePromptIntent('public logistics, aviation and power industries')).toEqual({
  keywords: ['logistics', 'aviation', 'power'],
  industries: ['logistics', 'aviation', 'power'],
});
expect(plan[0].query).toMatch(/^phone 602 Phoenix AZ 85001 /i);
expect(plan[0].query).toContain('logistics aviation power');
```

- [ ] **Step 2: Run and verify RED**

Run: `npm.cmd test -- tests/domain/targeted/promptIntent.test.ts tests/domain/targeted/queryPlanner.test.ts`

Expected: FAIL because prompt text is not currently part of executed intent.

- [ ] **Step 3: Implement deterministic intent extraction and merge rules**

Normalize separators and remove discovery-only words (`public`, `contacts`, `email`, `phone`, `business`, `industries`). Preserve explicit UI filters and append unique prompt terms. Do not claim LLM understanding; show derived chips for operator review.

- [ ] **Step 4: Make every executable query location- and intent-specific**

Reject planning if a country-restricted geography has no city/region/postal evidence. Generate HTML/PDF/XLS/XLSX/CSV/DOCX/TXT variants in canonical field order and keep deterministic work keys.

- [ ] **Step 5: Verify GREEN**

Run: `npm.cmd test -- tests/domain/targeted/promptIntent.test.ts tests/domain/targeted/queryPlanner.test.ts`

Expected: PASS with exact query ordering.

---

### Task 4: Qualify ordinary public contact emails correctly

**Files:**
- Create: `src/domain/targeted/publicContactAssociation.ts`
- Modify: `src/domain/targeted/service.ts`
- Modify: `src/domain/targeted/relevance.ts`
- Test: `tests/domain/targeted/publicContactAssociation.test.ts`
- Test: `tests/domain/targeted/service.test.ts`

**Interfaces:**
- Produces: `associatePublicContact(candidate, source): ContactAssociationDecision` with `organization_domain | explicitly_published_consumer | unassociated`.

- [ ] **Step 1: Write failing association tests**

```ts
expect(associatePublicContact({ email: 'owner@gmail.com' }, {
  website: 'https://acme.example/contact', text: 'Email our owner: owner@gmail.com',
})).toMatchObject({ accepted: true, reason: 'explicitly_published_consumer' });

expect(associatePublicContact({ email: 'random@gmail.com' }, {
  website: 'https://acme.example', text: 'Developer example random@gmail.com',
})).toMatchObject({ accepted: false, reason: 'unassociated' });
```

- [ ] **Step 2: Run and verify RED**

Run: `npm.cmd test -- tests/domain/targeted/publicContactAssociation.test.ts tests/domain/targeted/service.test.ts`

Expected: FAIL because all consumer-domain contacts are currently treated as unassociated.

- [ ] **Step 3: Implement evidence-based association**

Organization domains match normalized registrable website hosts. Consumer domains require the exact email in a contact-labelled field, row, or bounded context containing business/contact role evidence. Reject examples, assets, scripts, unrelated author metadata, and cross-row leakage.

- [ ] **Step 4: Store association reason and source excerpt**

Persist the association decision in `TargetedEvidence.fieldsJson`; retain bounded context and artifact ID for audit.

- [ ] **Step 5: Verify GREEN**

Run: `npm.cmd test -- tests/domain/targeted/publicContactAssociation.test.ts tests/domain/targeted/service.test.ts`

Expected: PASS for both business-domain and explicitly published consumer contacts.

---

### Task 5: Execute safe public document parsing

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/domain/targeted/artifactFetcher.ts`
- Create: `src/domain/targeted/documentExtractor.ts`
- Test: `tests/domain/targeted/artifactFetcher.test.ts`
- Test: `tests/domain/targeted/documentExtractor.test.ts`
- Create: `tests/fixtures/targeted/contacts.csv`
- Create test-generated in-memory PDF/XLS/XLSX/DOCX/TXT fixtures where library APIs permit.

**Interfaces:**
- Produces: `fetchPublicArtifact(url, limits): Promise<FetchedArtifact>` and `extractDocumentSections(artifact): Promise<ExtractedSection[]>`.
- Each section includes text, page?, sheet?, row?, and mediaType.

- [ ] **Step 1: Install local parser libraries**

Run: `npm.cmd install pdfjs-dist xlsx mammoth csv-parse`

Expected: dependencies appear in the lockfile without requiring a new service subscription.

- [ ] **Step 2: Write failing parser and fetch-safety tests**

Cover HTML, PDF, XLS, XLSX, CSV/TSV, DOCX, and TXT extraction plus private IP/localhost rejection, redirect-to-private rejection, misleading content type, timeout, oversize, corrupt, encrypted, and image-only behavior.

- [ ] **Step 3: Run and verify RED**

Run: `npm.cmd test -- tests/domain/targeted/artifactFetcher.test.ts tests/domain/targeted/documentExtractor.test.ts`

Expected: FAIL because fetcher and extractors do not exist.

- [ ] **Step 4: Implement bounded SSRF-safe retrieval**

Allow only HTTP(S), resolve every hostname, reject loopback/private/link-local/reserved addresses, revalidate redirects, cap redirects at 5, timeout at 15 seconds, cap individual artifacts at 15 MB, stream to the byte cap, and validate signatures/content types before parsing.

- [ ] **Step 5: Implement parser dispatch**

Return bounded text sections with source coordinates. Parse spreadsheets with formulas disabled and never execute macros. Mark image-only PDFs `ocr_required`; do not silently return zero contacts as success.

- [ ] **Step 6: Verify GREEN**

Run: `npm.cmd test -- tests/domain/targeted/artifactFetcher.test.ts tests/domain/targeted/documentExtractor.test.ts`

Expected: PASS with no network access in unit tests.

---

### Task 6: Integrate document discovery and extraction into campaigns

**Files:**
- Modify: `src/domain/targeted/queryPlanner.ts`
- Modify: `src/domain/targeted/service.ts`
- Modify: `src/domain/targeted/store.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260803150000_targeted_output_expansion/migration.sql`
- Test: `tests/domain/targeted/service.test.ts`
- Test: `tests/domain/targeted/storeSchema.test.ts`

**Interfaces:**
- Work unit connectors become `business_maps | public_web | public_document`.
- Artifact states become `discovered | fetched | parsed | quarantined | failed` with reason and provenance metadata.

- [ ] **Step 1: Write a failing lifecycle test**

Create a campaign whose public business page links a CSV and PDF. Assert both artifacts execute, their public contacts retain sheet/page provenance, foreign rows are rejected, and duplicate emails collapse to one candidate with multiple evidence records.

- [ ] **Step 2: Run and verify RED**

Run: `npm.cmd test -- tests/domain/targeted/service.test.ts tests/domain/targeted/storeSchema.test.ts`

Expected: FAIL because document units are preview-only and parser provenance is not stored.

- [ ] **Step 3: Add non-destructive schema fields and migration**

Add work-unit `priority`, `attemptCount`, and `metricsJson`; artifact `mediaType`, `byteCount`, `parserStatus`, and `parserReason`. Use defaults so existing campaigns remain readable.

- [ ] **Step 4: Execute discovered public documents**

Process document links from targeted business sites and URLs returned by the configured public-web connector. If no general web connector is configured, report `waiting_for_web_search` for filetype queries while still processing documents linked by discovered sites. Never label preview-only work completed.

- [ ] **Step 5: Extract, associate, qualify, dedupe, and checkpoint**

Feed each section through the existing email extractor, new association logic, hard geography gate, MX classifier, and store. Checkpoint after each artifact so restarts do not redownload completed files.

- [ ] **Step 6: Verify GREEN and migration safety**

Run: `npm.cmd test -- tests/domain/targeted/service.test.ts tests/domain/targeted/store.test.ts tests/domain/targeted/storeSchema.test.ts`

Run: `npx.cmd prisma validate`

Expected: all PASS; schema validates and existing rows require no destructive rewrite.

---

### Task 7: Add adaptive yield scheduling

**Files:**
- Create: `src/domain/targeted/adaptiveScheduler.ts`
- Modify: `src/domain/targeted/service.ts`
- Modify: `src/domain/targeted/store.ts`
- Test: `tests/domain/targeted/adaptiveScheduler.test.ts`
- Test: `tests/domain/targeted/service.test.ts`

**Interfaces:**
- Produces: `rankPendingWork(units, metrics, options): RankedWorkUnit[]` and an auditable `priorityReason`.

- [ ] **Step 1: Write failing exploration/exploitation tests**

```ts
it('prioritizes unique Strict yield while preserving minimum exploration', () => {
  const ranked = rankPendingWork(units, metrics, { minimumExploration: 2 });
  expect(ranked[0].workKey).toBe('high-strict-yield');
  expect(ranked.some((unit) => unit.workKey === 'untried-market')).toBe(true);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm.cmd test -- tests/domain/targeted/adaptiveScheduler.test.ts`

Expected: FAIL because no scheduler exists.

- [ ] **Step 3: Implement transparent deterministic scoring**

Score unique Strict contacts positively and foreign, duplicate, permanent failure, byte, and elapsed-time costs negatively. Apply a bounded exploration bonus to unseen/undersampled combinations. Return the numerical inputs and human-readable reason with every priority.

- [ ] **Step 4: Re-rank only safe pending boundaries**

After each completed work unit, persist aggregate metrics and reorder pending units. Do not change completed/running work or broaden geography/intent. Add a store/API operation to reset learned metrics for a campaign.

- [ ] **Step 5: Verify GREEN**

Run: `npm.cmd test -- tests/domain/targeted/adaptiveScheduler.test.ts tests/domain/targeted/service.test.ts`

Expected: PASS with deterministic ordering.

---

### Task 8: Simplify the Targeted Scraping interface

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/api.js`
- Modify: `public/styles.css`
- Test: `tests/public/staticUi.test.ts`
- Test: `tests/api/targetedApi.test.ts`

**Interfaces:**
- Default view: target, bank/country, automatically derived intent/markets, summary, start.
- Advanced panel: providers, manual geography, limits, work units, Review/Rejected audit, learning reset.

- [ ] **Step 1: Write failing static/API tests for the simplified flow**

Assert the old seven-stage navigation and preview-only copy are absent; bank selection triggers top-25 market loading; rows render `area code, city, state/province, postal`; results request `tier=strict` by default; document and adaptive progress fields exist.

- [ ] **Step 2: Run and verify RED**

Run: `npm.cmd test -- tests/public/staticUi.test.ts tests/api/targetedApi.test.ts`

Expected: FAIL against the current seven-stage UI.

- [ ] **Step 3: Replace the seven-stage wizard with a compact guided form**

Keep mode, prompt, bank/country, market limit, summary, and start visible. Automatically load markets when a bank is chosen. Put providers, manual geography, limits, and raw work units in one collapsed Advanced section.

- [ ] **Step 4: Make results and reasons understandable**

Open on Strict, add tier tabs/counts, show country/geography/association/MX/document provenance and rejection reason, and retain the domain-MX limitation copy. Show extracted documents, rows/sections, and adaptive priority events in progress.

- [ ] **Step 5: Verify GREEN**

Run: `npm.cmd test -- tests/public/staticUi.test.ts tests/api/targetedApi.test.ts`

Expected: PASS with accessible labels and no preview-only document claim.

---

### Task 9: Full verification and bounded live pilot

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-03-targeted-scraping-output-expansion-design.md` only if implementation revealed an approved factual correction.

- [ ] **Step 1: Run formatting/static checks available in the repository**

Run: `git diff --check` when a Git worktree becomes available; otherwise inspect changed files for conflict markers and trailing whitespace with `rg`.

- [ ] **Step 2: Run the complete automated suite**

Run: `npm.cmd test`

Expected: every test file passes with no unhandled rejection.

- [ ] **Step 3: Build and validate the database**

Run: `npm.cmd run build`

Run: `npx.cmd prisma generate`

Run: `npx.cmd prisma validate`

Expected: all exit 0.

- [ ] **Step 4: Verify Docker and localhost health**

Run: `docker compose -f docker-compose.google-scraper.yml ps`

Run: `Invoke-WebRequest http://127.0.0.1:8080/health -UseBasicParsing`

Run: `Invoke-WebRequest http://127.0.0.1:4177 -UseBasicParsing`

Expected: scraper is healthy and dashboard returns HTTP 200.

- [ ] **Step 5: Run a bounded Chase pilot**

Use one to three resolved US markets and a small request budget. Audit every Strict result for US geography, requested industry intent, source association, MX result, and provenance. Confirm zero foreign Strict records before raising the market limit to 25.

- [ ] **Step 6: Document exact supported coverage and limits**

Update README with automatic market behavior, executable document types, current web-search connector availability, Strict/Review/Rejected definitions, MX limitation, learning reset, and the honest statement that public-source availability controls output volume.

