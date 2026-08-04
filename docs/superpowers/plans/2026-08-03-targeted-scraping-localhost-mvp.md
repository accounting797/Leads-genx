# Targeted Scraping Localhost MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an admin-only, end-to-end Targeted Scraping workflow that can be exercised on localhost with bank-market planning, editable queries, existing Docker/Google discovery, relevance gating, public evidence, MX classification, tiered quality, and strict export.

**Architecture:** Add a bounded targeted-campaign subsystem beside the existing `Run` subsystem rather than overloading Google Maps runs. A dedicated router, service, store, planners, classifiers, and UI tab communicate through typed interfaces; existing Google Places, Docker, email extraction, credentials, auth, and SQLite infrastructure are reused through adapters.

**Tech Stack:** Node.js 26, TypeScript 6, Express 5, Prisma 5, SQLite, Vitest 3, browser JavaScript/CSS, existing Google Places and local Docker scraper clients, Node `dns/promises`, FDIC BankFind public API.

## Global Constraints

- Targeted Scraping remains server-enforced ADMIN-only.
- Version one requires no new paid subscription and does not automatically call unconfigured paid services.
- Use only public B2B sources; private consumers and inferred bank relationships are prohibited.
- Do not bypass authentication, CAPTCHAs, paywalls, explicit blocking, `401`, `403`, or persistent `429` responses.
- Do not guarantee lead count, deliverability, inbox placement, or campaign performance.
- Visible-domain and MX/infrastructure matches are separate filters and separate evidence fields.
- US and Canada only; bank mode preselects the top 25 qualified markets.
- Default maximum is 50 retained contacts per company.
- Strict export excludes catch-all, unknown, invalid, disposable, suppressed, and unsupported contacts.
- A DNS/MX-qualified contact must never be labeled mailbox-verified.
- Secrets may be loaded only through existing credential storage and must not enter campaign JSON, work units, events, evidence, logs, or exports.
- The current project directory is not a Git checkout. Treat commit steps as suggested checkpoints; execute them only after Git metadata is restored.
- This plan delivers the localhost MVP. PDF/XLS/XLSX/DOCX extraction and broader authorized web-search connectors receive separate follow-up plans after the MVP quality funnel is validated.

---

## File structure

### Create

- `src/domain/targeted/types.ts` — canonical campaign, filter, market, work-unit, evidence, candidate, verification, and funnel types.
- `src/domain/targeted/validation.ts` — request parsing, bounds, country/provider rules, and exact validation errors.
- `src/domain/targeted/providerCatalog.ts` — initial visible-domain and MX signature catalog plus matching helpers.
- `src/domain/targeted/geography.ts` — US/Canada area-code hierarchy validation for the MVP-supported markets.
- `src/domain/targeted/fdicBankMarkets.ts` — FDIC locations client, grouping, ranking, and top-25 selection.
- `src/domain/targeted/queryPlanner.ts` — deterministic editable query work units.
- `src/domain/targeted/relevance.ts` — combined target-fit scoring and hard-rejection reasons.
- `src/domain/targeted/mailInfrastructure.ts` — DNS/MX resolution and verification-depth classification.
- `src/domain/targeted/store.ts` — Prisma persistence boundary for campaigns, work units, artifacts, candidates, evidence, checks, and events.
- `src/domain/targeted/service.ts` — campaign lifecycle, bounded execution, checkpoints, cancellation, funnel counts, and strict export.
- `src/routes/targeted.ts` — admin-only targeted APIs.
- `tests/domain/targeted/*.test.ts` — focused unit tests for every domain unit.
- `tests/api/targetedApi.test.ts` — authorization and API lifecycle tests.
- `prisma/migrations/20260803090000_targeted_scraping_mvp/migration.sql` — targeted subsystem tables and indexes.

### Modify

- `prisma/schema.prisma` — add targeted models and user relations.
- `src/app.ts` — construct the targeted service and inject it into the API router.
- `src/routes/api.ts` — mount `/targeted` behind `adminGuard` and expose the dependency interface.
- `public/index.html` — add the admin-only Targeted Scraping tab, wizard, preview, progress funnel, results, and export controls.
- `public/api.js` — add targeted API methods.
- `public/app.js` — add wizard state, rendering, validation, polling, cancellation, and export behavior.
- `public/styles.css` — add scoped targeted-wizard and funnel styles.
- `tests/public/staticUi.test.ts` — assert admin-only markup and client wiring.
- `tests/api/api.test.ts` — update dependency fixtures if the router signature changes.
- `README.md` — document the localhost targeted workflow and honest MVP limits.

---

### Task 1: Targeted persistence foundation

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260803090000_targeted_scraping_mvp/migration.sql`
- Create: `src/domain/targeted/types.ts`
- Test: `tests/domain/targeted/storeSchema.test.ts`

**Interfaces:**
- Produces: `TargetedCampaignStatus`, `TargetedQualityTier`, `VerificationDepth`, `TargetedFilters`, `TargetedCampaignRecord`, `TargetedWorkUnitRecord`, `TargetedCandidateRecord`, and `TargetedFunnel`.
- Consumes: existing `User` ownership and SQLite datasource.

- [ ] **Step 1: Write the failing schema test**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('targeted scraping schema', () => {
  const schema = readFileSync('prisma/schema.prisma', 'utf8');

  it('defines campaign-owned work, evidence, checks, and candidates', () => {
    for (const model of [
      'TargetedCampaign', 'TargetedWorkUnit', 'TargetedSourceArtifact',
      'TargetedCandidate', 'TargetedEvidence', 'TargetedVerification', 'TargetedEvent',
    ]) expect(schema).toContain(`model ${model} {`);
    expect(schema).toContain('targetedCampaigns TargetedCampaign[]');
    expect(schema).toContain('@@unique([campaignId, normalizedEmail])');
  });
});
```

- [ ] **Step 2: Run the schema test and verify red**

Run: `npx.cmd vitest run tests/domain/targeted/storeSchema.test.ts`

Expected: FAIL because the targeted models do not exist.

- [ ] **Step 3: Add the Prisma models and migration**

Add models with these required fields and relations:

```prisma
model TargetedCampaign {
  id                 Int      @id @default(autoincrement())
  userId             Int
  status             String   @default("draft")
  prompt             String
  filterJson         String
  policyJson         String
  plannedUnitCount   Int      @default(0)
  completedUnitCount Int      @default(0)
  discoveredCount    Int      @default(0)
  alignedCount       Int      @default(0)
  strictCount        Int      @default(0)
  mailboxVerifiedCount Int    @default(0)
  reviewCount        Int      @default(0)
  rejectedCount      Int      @default(0)
  errorMessage       String?
  startedAt          DateTime?
  completedAt        DateTime?
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
  user               User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  workUnits          TargetedWorkUnit[]
  artifacts          TargetedSourceArtifact[]
  candidates         TargetedCandidate[]
  events             TargetedEvent[]

  @@index([userId, createdAt])
  @@index([status, updatedAt])
}

model TargetedWorkUnit {
  id            Int      @id @default(autoincrement())
  campaignId    Int
  workKey       String
  connector     String
  query         String
  documentType  String   @default("html")
  geographyJson String
  status        String   @default("pending")
  attemptCount  Int      @default(0)
  resultCount   Int      @default(0)
  checkpointJson String?
  errorCode     String?
  errorMessage  String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  campaign      TargetedCampaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)

  @@unique([campaignId, workKey])
  @@index([campaignId, status])
}

model TargetedSourceArtifact {
  id             Int      @id @default(autoincrement())
  campaignId     Int
  canonicalUrl   String
  sourceType     String
  contentType    String?
  contentHash    String?
  retrievalStatus String
  httpStatus     Int?
  metadataJson   String?
  discoveredAt   DateTime @default(now())
  campaign       TargetedCampaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  evidence       TargetedEvidence[]

  @@unique([campaignId, canonicalUrl])
  @@index([campaignId, retrievalStatus])
}

model TargetedCandidate {
  id                    Int      @id @default(autoincrement())
  campaignId            Int
  normalizedEmail       String
  email                 String
  fullName              String?
  jobTitle              String?
  companyName           String?
  website               String?
  phone                 String?
  address               String?
  visibleProvider       String?
  infrastructureJson    String   @default("[]")
  relevanceScore        Int      @default(0)
  relevanceReason       String?
  qualityTier           String   @default("review")
  verificationDepth     String   @default("syntax")
  complianceStatus      String   @default("review")
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
  campaign              TargetedCampaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  evidence              TargetedEvidence[]
  verifications         TargetedVerification[]

  @@unique([campaignId, normalizedEmail])
  @@index([campaignId, qualityTier])
}

model TargetedEvidence {
  id           Int      @id @default(autoincrement())
  candidateId  Int
  artifactId   Int?
  evidenceType String
  excerpt      String?
  fieldsJson   String?
  createdAt    DateTime @default(now())
  candidate    TargetedCandidate @relation(fields: [candidateId], references: [id], onDelete: Cascade)
  artifact     TargetedSourceArtifact? @relation(fields: [artifactId], references: [id], onDelete: SetNull)

  @@index([candidateId, evidenceType])
  @@index([artifactId])
}

model TargetedVerification {
  id             Int      @id @default(autoincrement())
  candidateId    Int
  checkType      String
  status         String
  reason         String?
  depth          String
  providerVersion String?
  checkedAt      DateTime @default(now())
  expiresAt      DateTime?
  candidate      TargetedCandidate @relation(fields: [candidateId], references: [id], onDelete: Cascade)

  @@index([candidateId, checkType, checkedAt])
}

model TargetedEvent {
  id           Int      @id @default(autoincrement())
  campaignId   Int
  type         String
  message      String
  metadataJson String?
  createdAt    DateTime @default(now())
  campaign     TargetedCampaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)

  @@index([campaignId, createdAt])
}
```

Add `targetedCampaigns TargetedCampaign[]` to `User`. Generate the SQL migration from this schema rather than hand-writing table definitions.

- [ ] **Step 4: Define exact TypeScript status types**

```ts
export type TargetedCampaignStatus =
  | 'draft' | 'planned' | 'queued' | 'running' | 'waiting_for_scraper'
  | 'completed' | 'partially_completed' | 'cancelled' | 'failed';
export type TargetedQualityTier = 'strict' | 'review' | 'rejected';
export type VerificationDepth = 'syntax' | 'domain_mx' | 'mailbox';
export type TargetedMode = 'office' | 'google' | 'other' | 'bank';
export type TargetedCountry = 'US' | 'CA';

export interface TargetedFilters {
  mode: TargetedMode;
  country: TargetedCountry;
  keywords: string[];
  industries: string[];
  companyTypes: string[];
  roles: string[];
  seniorities: string[];
  visibleProviders: string[];
  infrastructureProviders: string[];
  bankIds: string[];
  areaCodes: string[];
  states: string[];
  cities: string[];
  postalCodes: string[];
  radiusMiles: number;
  maxContactsPerCompany: number;
  maxResults: number;
  googleRequestBudget: number;
}

export interface TargetedDraftInput extends TargetedFilters { prompt: string; }
export interface TargetedFunnel {
  discovered: number;
  aligned: number;
  strict: number;
  mailboxVerified: number;
  review: number;
  rejected: number;
  exported: number;
}
```

- [ ] **Step 5: Generate the migration and Prisma client**

Run: `npx.cmd prisma migrate dev --name targeted_scraping_mvp`

Expected: a migration is created and applied without deleting existing run or lead data.

Run: `npm.cmd run prisma:generate`

Expected: Prisma Client generation succeeds.

Run: `npx.cmd prisma validate`

Expected: `The schema ... is valid`.

- [ ] **Step 6: Run the focused test**

Run: `npx.cmd vitest run tests/domain/targeted/storeSchema.test.ts`

Expected: PASS.

- [ ] **Step 7: Suggested checkpoint commit**

`feat: add targeted scraping persistence models`

---

### Task 2: Target input validation and provider catalog

**Files:**
- Create: `src/domain/targeted/validation.ts`
- Create: `src/domain/targeted/providerCatalog.ts`
- Test: `tests/domain/targeted/validation.test.ts`
- Test: `tests/domain/targeted/providerCatalog.test.ts`

**Interfaces:**
- Produces: `validateTargetedDraft(value: unknown): TargetedDraftInput`, `visibleDomainProvider(email: string): ProviderMatch | undefined`, `mxInfrastructureProvider(hosts: string[]): ProviderMatch[]`, and `providerCatalog()`.
- Consumes: types from Task 1.

- [ ] **Step 1: Write failing validation tests**

```ts
it('parses one combined target and clamps contacts per company to 50', () => {
  expect(validateTargetedDraft({
    prompt: 'Comcast business contacts around Phoenix for an IT campaign',
    mode: 'other', country: 'US', areaCodes: ['602'], states: ['AZ'],
    cities: ['Phoenix'], postalCodes: ['85001'], maxContactsPerCompany: 50,
    visibleProviders: ['comcast'], infrastructureProviders: ['microsoft_365'],
  })).toMatchObject({ mode: 'other', maxContactsPerCompany: 50 });
});

it('rejects consumer-bank targeting', () => {
  expect(() => validateTargetedDraft({ prompt: 'Chase account holders', mode: 'bank', bankIds: ['chase'] }))
    .toThrow(/public business contacts/i);
});
```

- [ ] **Step 2: Write failing catalog tests**

```ts
expect(visibleDomainProvider('owner@comcast.net')).toMatchObject({ id: 'comcast', group: 'other' });
expect(mxInfrastructureProvider(['tenant.mail.protection.outlook.com']))
  .toContainEqual(expect.objectContaining({ id: 'microsoft_365' }));
expect(mxInfrastructureProvider(['mx1.barracudanetworks.com']))
  .toContainEqual(expect.objectContaining({ id: 'barracuda' }));
```

- [ ] **Step 3: Run focused tests and verify red**

Run: `npx.cmd vitest run tests/domain/targeted/validation.test.ts tests/domain/targeted/providerCatalog.test.ts`

Expected: FAIL because modules do not exist.

- [ ] **Step 4: Implement the versioned catalog**

Use immutable entries shaped as:

```ts
export interface ProviderMatch {
  id: string;
  label: string;
  group: 'office' | 'google' | 'other' | 'security';
  matchType: 'visible_domain' | 'mx_suffix' | 'mx_contains';
  pattern: string;
  catalogVersion: '2026-08-03';
}
```

Include the approved initial providers and aliases. Normalize hostnames to lowercase without a trailing dot. Exact visible-domain matching must not use substring matching.

- [ ] **Step 5: Implement validation with explicit bounds**

Enforce prompt length `3..2000`, country `US|CA`, maximum 100 selected locations, maximum 50 contacts per company, maximum 500 work units, allowed provider IDs, and the public-B2B prohibition phrases. Return field errors through `TargetedValidationError.fields`.

- [ ] **Step 6: Run focused tests**

Run: `npx.cmd vitest run tests/domain/targeted/validation.test.ts tests/domain/targeted/providerCatalog.test.ts`

Expected: PASS.

- [ ] **Step 7: Suggested checkpoint commit**

`feat: validate targeted campaigns and classify mail providers`

---

### Task 3: Geography, bank markets, and editable query planning

**Files:**
- Create: `src/domain/targeted/geography.ts`
- Create: `src/domain/targeted/fdicBankMarkets.ts`
- Create: `src/domain/targeted/queryPlanner.ts`
- Test: `tests/domain/targeted/geography.test.ts`
- Test: `tests/domain/targeted/fdicBankMarkets.test.ts`
- Test: `tests/domain/targeted/queryPlanner.test.ts`

**Interfaces:**
- Produces: `validateGeography(filters): GeographySelection`, `FdicBankMarketsClient.markets(bankName): Promise<BankMarket[]>`, `rankBankMarkets(rows, areaCodeIndex): BankMarket[]`, and `planTargetedQueries(input): PlannedTargetedQuery[]`.
- Consumes: validated draft and provider catalog from Task 2.

- [ ] **Step 1: Write failing geography and ranking tests**

```ts
expect(validateGeography({ country: 'US', areaCodes: ['602'], states: ['AZ'], cities: ['Phoenix'] }))
  .toMatchObject({ country: 'US', areaCodes: ['602'] });
expect(() => validateGeography({ country: 'US', areaCodes: ['602'], states: ['TX'], cities: ['Dallas'] }))
  .toThrow(/602.*Arizona/i);

const ranked = rankBankMarkets([
  { NAME: 'JPMorgan Chase Bank', CITY: 'Phoenix', STALP: 'AZ', ZIP: '85001' },
  { NAME: 'JPMorgan Chase Bank', CITY: 'Phoenix', STALP: 'AZ', ZIP: '85002' },
  { NAME: 'JPMorgan Chase Bank', CITY: 'Tucson', STALP: 'AZ', ZIP: '85701' },
], { 'phoenix|az': ['602'], 'tucson|az': ['520'] });
expect(ranked[0]).toMatchObject({ city: 'Phoenix', state: 'AZ', branchCount: 2, areaCodes: ['602'] });
```

- [ ] **Step 2: Write the failing query-plan test**

```ts
const plan = planTargetedQueries({
  prompt: 'public Comcast contacts', mode: 'other', country: 'US',
  areaCodes: ['602'], states: ['AZ'], cities: ['Avondale'], postalCodes: ['85392'],
  visibleProviders: ['comcast'], infrastructureProviders: [],
  keywords: ['phone'], maxContactsPerCompany: 50,
});
expect(plan.map((unit) => unit.query)).toEqual(expect.arrayContaining([
  'phone 602 Avondale AZ 85392 "@comcast.net"',
  'phone 602 Avondale AZ 85392 "@comcast.net" filetype:pdf',
]));
expect(new Set(plan.map((unit) => unit.workKey)).size).toBe(plan.length);
```

- [ ] **Step 3: Run tests and verify red**

Run: `npx.cmd vitest run tests/domain/targeted/geography.test.ts tests/domain/targeted/fdicBankMarkets.test.ts tests/domain/targeted/queryPlanner.test.ts`

Expected: FAIL because planners do not exist.

- [ ] **Step 4: Implement the FDIC connector**

Call `https://api.fdic.gov/banks/locations` with URL-encoded `filters=NAME:"<bank>"`, `fields=NAME,CITY,STALP,ZIP,OFFNAME`, `limit=10000`, and `format=json`. Use `AbortSignal.timeout(15000)`, a descriptive Lead Gen X user agent, and a 5 MB response ceiling. Treat `401`, `403`, `429`, and `5xx` as typed errors; do not retry authorization failures.

- [ ] **Step 5: Implement top-25 deterministic ranking**

Group current branches by normalized `city|state`, count branches, attach known area codes, sort by `branchCount DESC`, then state and city ascending. Return the first 25 by default while preserving all qualified markets for admin expansion.

- [ ] **Step 6: Implement deterministic work keys and query variants**

Use SHA-256 over normalized structured fields. Generate base, PDF, XLS, XLSX, CSV, DOCX, and TXT variants for preview, but mark non-MVP document connectors `preview_only` so the UI is honest. Generate one geography/provider combination per work unit and cap at 500.

- [ ] **Step 7: Run focused tests**

Run: `npx.cmd vitest run tests/domain/targeted/geography.test.ts tests/domain/targeted/fdicBankMarkets.test.ts tests/domain/targeted/queryPlanner.test.ts`

Expected: PASS.

- [ ] **Step 8: Suggested checkpoint commit**

`feat: plan area-code and bank-market targeted work`

---

### Task 4: Relevance and mail-infrastructure quality gates

**Files:**
- Create: `src/domain/targeted/relevance.ts`
- Create: `src/domain/targeted/mailInfrastructure.ts`
- Test: `tests/domain/targeted/relevance.test.ts`
- Test: `tests/domain/targeted/mailInfrastructure.test.ts`

**Interfaces:**
- Produces: `scoreTargetedCandidate(candidate, filters): RelevanceDecision` and `classifyMailInfrastructure(email, resolver): Promise<MailInfrastructureResult>`.
- Consumes: provider catalog and targeted types.

- [ ] **Step 1: Write failing relevance tests with matched and junk results**

```ts
expect(scoreTargetedCandidate({
  companyName: 'Phoenix Freight Systems', category: 'Freight forwarding service',
  address: 'Phoenix, AZ 85001', email: 'ops@phoenixfreight.example', sourceUrl: 'https://phoenixfreight.example/contact',
}, filters)).toMatchObject({ accepted: true, tier: 'strict' });

expect(scoreTargetedCandidate({
  companyName: 'Desert Fashion Outlet', category: 'Clothing store',
  address: 'Las Vegas, NV', email: 'sales@fashion.example', sourceUrl: 'https://fashion.example',
}, filters)).toMatchObject({ accepted: false, reason: 'target_mismatch' });
```

- [ ] **Step 2: Write failing MX tests with an injected resolver**

```ts
const resolver = { resolveMx: async () => [{ exchange: 'tenant.mail.protection.outlook.com', priority: 0 }] };
expect(await classifyMailInfrastructure('person@acme.example', resolver)).toMatchObject({
  depth: 'domain_mx', infrastructureProviders: ['microsoft_365'], mxValid: true,
});
```

- [ ] **Step 3: Run tests and verify red**

Run: `npx.cmd vitest run tests/domain/targeted/relevance.test.ts tests/domain/targeted/mailInfrastructure.test.ts`

Expected: FAIL because quality modules do not exist.

- [ ] **Step 4: Implement explainable relevance scoring**

Assign explicit weighted evidence: geography `35`, business/contact intent `35`, visible-domain match `15`, infrastructure match `15`. Hard-reject wrong country/state when geography is required. Accept at `>=70`, Review at `50..69`, Reject below `50`. Return every matched and missing rule; do not use an opaque LLM score.

- [ ] **Step 5: Implement DNS/MX classification**

Use `dns/promises.resolveMx` through an injected resolver, a 5-second timeout wrapper, normalized exchanges, and catalog matching. Syntax-valid + MX-valid yields `domain_mx`; mailbox depth is never produced by this function. NXDOMAIN, no MX, disposable, placeholder, and no-reply addresses are rejected. Resolver timeout yields Review/Risky, not Strict.

- [ ] **Step 6: Run focused tests**

Run: `npx.cmd vitest run tests/domain/targeted/relevance.test.ts tests/domain/targeted/mailInfrastructure.test.ts`

Expected: PASS.

- [ ] **Step 7: Suggested checkpoint commit**

`feat: enforce target relevance and MX quality gates`

---

### Task 5: Targeted store and execution service

**Files:**
- Create: `src/domain/targeted/store.ts`
- Create: `src/domain/targeted/service.ts`
- Test: `tests/domain/targeted/store.test.ts`
- Test: `tests/domain/targeted/service.test.ts`

**Interfaces:**
- Produces: `PrismaTargetedStore`, `TargetedService.createDraft`, `.plan`, `.start`, `.stop`, `.get`, `.listCandidates`, and `.strictEmails`.
- Consumes: existing `GooglePlacesClient`, `LocalMapsScraperClient`, `WebsiteEmailExtractor`, saved settings loader, Tasks 1–4.

- [ ] **Step 1: Write a failing service lifecycle test**

Create fake connectors returning one aligned freight company and one irrelevant clothing store. Assert the aligned company persists with evidence and the irrelevant result persists as Rejected with `target_mismatch`. Assert strict export returns only the aligned email.

```ts
const service = createTargetedService({ store, googleClient, localClient, emailExtractor, mxResolver });
const draft = await service.createDraft(1, input);
await service.plan(draft.id);
await service.start(draft.id, { googleApiKey: 'test-key', background: false });
expect((await service.get(draft.id)).status).toBe('completed');
expect(await service.strictEmails(draft.id)).toEqual(['ops@phoenixfreight.example']);
```

- [ ] **Step 2: Run the service tests and verify red**

Run: `npx.cmd vitest run tests/domain/targeted/store.test.ts tests/domain/targeted/service.test.ts`

Expected: FAIL because the store/service do not exist.

- [ ] **Step 3: Implement persistence operations**

Implement transactions for candidate + evidence + verification writes, unique email handling, incremental funnel counts, redacted events, work-unit checkpoints, `isCancelled`, and strict email listing. Store public evidence excerpts capped at 500 characters and artifact response metadata capped at 16 KB.

- [ ] **Step 4: Implement bounded execution**

Execution order:

1. Load and validate the campaign.
2. Load saved existing credentials without persisting them into campaign data.
3. Mark executable work units running.
4. Call Docker and Google Places through adapters with maximum concurrency 2 and the campaign budget.
5. Normalize business results with existing `normalizeLead`.
6. Apply relevance before website email extraction.
7. Use `collectContactCandidates` for accepted businesses only.
8. Enforce 50 contacts per company.
9. Resolve MX, classify provider, tier the contact, persist evidence/checks, and update funnel counts.
10. Mark units and campaign completed, partial, waiting, cancelled, or failed.

Do not execute preview-only filetype units in the MVP. Record them as `preview_only` with an explanatory event.

- [ ] **Step 5: Implement stop/resume boundaries**

Check cancellation between work units and before website scanning. Preserve completed output. If Docker is unavailable and Google is configured, continue Google and complete partial; if neither can execute, set `waiting_for_scraper` with no data loss.

- [ ] **Step 6: Run service tests**

Run: `npx.cmd vitest run tests/domain/targeted/store.test.ts tests/domain/targeted/service.test.ts`

Expected: PASS.

- [ ] **Step 7: Suggested checkpoint commit**

`feat: execute checkpointed targeted campaigns`

---

### Task 6: Admin-only targeted API

**Files:**
- Create: `src/routes/targeted.ts`
- Modify: `src/routes/api.ts`
- Modify: `src/app.ts`
- Test: `tests/api/targetedApi.test.ts`

**Interfaces:**
- Produces routes under `/api/targeted`.
- Consumes `TargetedService` from Task 5 and existing `requireAdmin`, settings, Prisma, and async error wrapper.

- [ ] **Step 1: Write failing authorization tests**

Assert unauthenticated requests return `401`, non-admin requests return `403`, and admin requests can access the catalog and create a draft. Test these endpoints:

```text
GET    /api/targeted/catalog
POST   /api/targeted/markets/banks
POST   /api/targeted/campaigns
POST   /api/targeted/campaigns/:id/plan
PATCH  /api/targeted/campaigns/:id/work-units/:unitId
POST   /api/targeted/campaigns/:id/start
POST   /api/targeted/campaigns/:id/stop
GET    /api/targeted/campaigns
GET    /api/targeted/campaigns/:id
GET    /api/targeted/campaigns/:id/candidates
GET    /api/targeted/campaigns/:id/export?quality=strict
```

- [ ] **Step 2: Run API tests and verify red**

Run: `npx.cmd vitest run tests/api/targetedApi.test.ts`

Expected: FAIL with `404` because routes do not exist.

- [ ] **Step 3: Mount a dedicated router behind `adminGuard`**

In `createApiRouter`, mount:

```ts
if (prisma && targetedService) {
  router.use('/targeted', adminGuard, createTargetedRouter({ prisma, targetedService }));
}
```

Require the authenticated admin user ID on campaign creation. Reject cross-owner campaign IDs with `404`. Return `202` for start/stop operations and `400` with `fields` for validation errors.

- [ ] **Step 4: Return strict export as UTF-8 text**

Use `Content-Type: text/plain; charset=utf-8` and `Content-Disposition: attachment; filename="leads-genx-targeted-<id>-strict.txt"`. One normalized unique email per line; no Review or Rejected contacts.

- [ ] **Step 5: Run API tests**

Run: `npx.cmd vitest run tests/api/targetedApi.test.ts`

Expected: PASS.

- [ ] **Step 6: Suggested checkpoint commit**

`feat: expose admin targeted scraping API`

---

### Task 7: Admin wizard and quality-funnel UI

**Files:**
- Modify: `public/index.html`
- Modify: `public/api.js`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Test: `tests/public/staticUi.test.ts`

**Interfaces:**
- Produces an admin-only `targeted` tab and browser client state.
- Consumes Task 6 API JSON.

- [ ] **Step 1: Write failing static UI tests**

```ts
expect(html).toContain('data-tab="targeted"');
expect(html).toContain('data-admin-only');
expect(html).toContain('id="targetedPrompt"');
expect(html).toContain('id="targetedQualityFunnel"');
expect(appJs).toContain('loadTargetedCatalog');
expect(appJs).toContain('startTargetedCampaign');
expect(apiJs).toContain('createTargetedCampaign');
```

- [ ] **Step 2: Run the UI test and verify red**

Run: `npx.cmd vitest run tests/public/staticUi.test.ts`

Expected: FAIL because targeted markup and methods do not exist.

- [ ] **Step 3: Add the seven-stage wizard**

Render these panels in one tab with Next/Back controls:

1. Combined prompt and structured chips.
2. Mode and visible/MX providers.
3. Country -> area code -> state/province -> city -> ZIP/postal -> radius.
4. Bank lookup and editable top-25 market list when mode is Bank.
5. Editable query/work-unit preview with preview-only labels.
6. Run limits, credentials status, and quality policy.
7. Confirmation and start.

The UI must never hide unsupported document execution: PDF/XLS/XLSX/DOCX variants display `Preview only in localhost MVP`.

- [ ] **Step 4: Add client API methods**

Implement each Task 6 endpoint in `public/api.js`. Export uses browser navigation only after the campaign completes or has preserved partial output.

- [ ] **Step 5: Add state and polling**

Poll active campaign detail every 3 seconds. Render funnel cards for Discovered, Aligned, Strict Export, Mailbox Verified, Review, and Rejected. Stop polling on terminal states. Show exact error/rejection messages and never display secret values.

- [ ] **Step 6: Add scoped responsive styles**

Use `.targeted-*` selectors. At widths below 800px, stack wizard columns and funnel cards. Preserve existing visual language and focus-visible behavior.

- [ ] **Step 7: Run UI tests**

Run: `npx.cmd vitest run tests/public/staticUi.test.ts`

Expected: PASS.

- [ ] **Step 8: Suggested checkpoint commit**

`feat: add admin targeted scraping wizard`

---

### Task 8: Full verification, regression checks, and localhost pilot

**Files:**
- Modify: `README.md`
- Modify tests only if verification exposes a confirmed regression.

**Interfaces:**
- Consumes all prior tasks.
- Produces a documented localhost test procedure and fresh verification evidence.

- [ ] **Step 1: Document exact localhost workflow**

Add commands:

```powershell
npm.cmd run prisma:generate
npx.cmd prisma db push
npm.cmd run scraper:up
npm.cmd run dev
```

Document that the dashboard opens at `http://127.0.0.1:4177`, Targeted Scraping is admin-only, filetype variants are preview-only in the MVP, and strict export describes its actual verification depth.

- [ ] **Step 2: Run targeted tests**

Run: `npx.cmd vitest run tests/domain/targeted tests/api/targetedApi.test.ts tests/public/staticUi.test.ts`

Expected: all targeted test files pass with zero failures.

- [ ] **Step 3: Run the complete suite**

Run: `npm.cmd test`

Expected: all tests pass. If the pre-existing settings-fixture isolation or 5-second startup timeout failures recur, document them separately and do not misattribute them to Targeted Scraping.

- [ ] **Step 4: Build production JavaScript**

Run: `npm.cmd run build`

Expected: TypeScript exits `0` with no diagnostics.

- [ ] **Step 5: Verify live dependencies**

Run:

```powershell
Invoke-RestMethod http://127.0.0.1:8080/api/v1/jobs
Invoke-RestMethod http://127.0.0.1:4177/api/health
Invoke-RestMethod http://127.0.0.1:4177/api/scraper/health
```

Expected: scraper returns HTTP 200, app health returns `status: ok`, and scraper health returns `ok: true`.

- [ ] **Step 6: Execute a bounded localhost pilot**

Use one US area code/city, one business intent, one provider rule, `maxResults=20`, `maxContactsPerCompany=5`, and Google request budget `3`. Audit every Strict result for target match, source evidence, verification depth, and tier reason before expanding scope.

- [ ] **Step 7: Record the funnel**

Record discovered, aligned, strict, mailbox-verified, review, rejected, and exported counts in the implementation handoff. Do not claim the 95% relevance target from fewer than 20 manually audited results.

- [ ] **Step 8: Suggested checkpoint commit**

`docs: document targeted scraping localhost pilot`

---

## Follow-up plans after MVP acceptance

1. Public document expansion: safe fetcher, HTML/PDF/XLS/XLSX/CSV/DOCX/TXT parsers, artifact limits, provenance, and parser quarantine.
2. Canadian bank-market expansion: authorized locator connectors or licensed/imported branch data with explicit rights metadata.
3. Mailbox-verification adapters: optional existing-provider adapters, verification expiry, batch reconciliation, and cost preview/approval.
4. Scale hardening: partitioned work queues, origin-level rate limits, artifact caching, resumable large imports, and benchmark dashboards.
5. Public release: role/tier policy, quotas, abuse controls, compliance review, and release-metric approval.
