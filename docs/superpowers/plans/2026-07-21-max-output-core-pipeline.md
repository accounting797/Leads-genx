# Leads-GenX Max-Output Core Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the durable max-output backend that plans tiered work, schedules Google breadth-first, runs Standard and Hybrid providers concurrently, persists businesses and classified contacts continuously, and exposes an accurate session report for the later Command Radar UI.

**Architecture:** Add a finite query-plan contract shared by Google, Docker, and Apify; persist run/provider/work metrics in SQLite; and route every provider result through one run-scoped ingestion coordinator backed by a bounded 50-task website pool. Keep the existing `executeBalancedGoogleMapsRun` entry point during migration, but move contact classification and provider reporting behind focused interfaces so the secure-settings/proxy and Command Radar projects can consume them without reopening the orchestration core.

**Tech Stack:** Node.js 26, TypeScript 6, Express 5, Prisma 5 with SQLite, Vitest 3, vanilla browser JavaScript, Docker Compose.

## Global Constraints

- Standard Output runs Docker and Google concurrently; Apify is off and consumes no budget.
- Hybrid Max Output runs Docker, Google, and Apify concurrently.
- Google request budget defaults to 50 attempts, is a hard maximum, and counts every HTTP attempt including failures and rotated-key retries.
- Google first-page work is spread across locations before any page-token depth.
- Docker uses concurrency `4`, one scraper service/browser pool, four pages per browser, and one application checkpoint batch at a time.
- Website scanning uses one real run-scoped concurrency pool capped at `50` tasks.
- Qualified contacts alone contribute to `leadCount`; raw contacts remain visible but do not increase that count.
- Businesses and contacts are persisted as each item/site completes, and all already-persisted output survives provider failures.
- Google traffic is always direct.
- Secrets, proxy credentials, exact queries, and raw credentials never appear in events, reports, logs, or browser payloads.
- The application remains loopback-only at `http://localhost:4177/`.

## Program Decomposition

This plan implements the first independently testable subsystem from `docs/superpowers/specs/2026-07-19-max-output-settings-command-radar-design.md`.

The following approved subsystems must be implemented in separate plans after this one passes:

1. Secure credential storage, credential lifecycle APIs, Bright Data account facts, and the optional proxy gateway.
2. Compact Command Radar, detailed Settings reports, stale-heartbeat animation rules, and visual verification at 1440, 1024, 768, and 390 pixels.

## File Structure

- Create `src/domain/queryPlan.ts`: finite precision/expansion/recovery work-plan builder.
- Create `src/domain/contactClassifier.ts`: normalized qualified/raw contact decisions and reason codes.
- Create `src/domain/boundedTaskPool.ts`: one run-scoped website task pool with a strict concurrency ceiling.
- Create `src/domain/runIngestionCoordinator.ts`: canonical business/contact persistence, deduplication, and metric updates shared by all providers.
- Create `src/domain/sessionReport.ts`: secret-free report DTO built from persisted run/provider records.
- Create `prisma/migrations/20260721090000_max_output_core/migration.sql`: run metrics, contact quality, provider state, and indexes.
- Modify `prisma/schema.prisma`: model the new durable fields and `RunProviderState` relation.
- Modify `src/domain/types.ts`: output-mode and planned-work contracts.
- Modify `src/domain/googleMapsQueryBuilder.ts`: delegate legacy query output to the new plan.
- Modify `src/integrations/googlePlacesClient.ts`: breadth-first scheduler and work-unit callbacks.
- Modify `src/domain/emailExtractor.ts`: preserve syntactically discovered candidates for classification.
- Modify `src/domain/prismaRunStore.ts`: atomic contact/provider-state persistence methods.
- Modify `src/domain/balancedGoogleMapsRunService.ts`: use the shared plan, ingestion coordinator, provider heartbeats, and Docker concurrency `4`.
- Modify `src/domain/runService.ts`: make Standard/Hybrid output modes explicit and start selected providers together.
- Modify `src/domain/validation.ts`: default Standard Google budget to `50` and accept explicit output mode.
- Modify `src/routes/api.ts`: add the secret-free session-report endpoint.
- Modify `docker-compose.google-scraper.yml`: set the safe four-page scraper baseline.
- Modify `README.md`: document output modes, exact counting semantics, and controlled smoke-test order.
- Create or modify the matching focused tests listed in each task.

---

### Task 1: Persist Output, Contact, Work, and Provider Metrics

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260721090000_max_output_core/migration.sql`
- Modify: `src/domain/types.ts`
- Modify: `src/domain/runService.ts`
- Modify: `src/domain/prismaRunStore.ts`
- Modify: `tests/domain/prismaRunStore.test.ts`

**Interfaces:**
- Produces: `OutputMode`, `ContactQuality`, `ProviderName`, `ProviderStatus`, `ProviderStateWrite`, `upsertProviderState()`, `upsertContact()`, and expanded `RunRecord` metrics.
- Consumes: existing `RunStore`, `NormalizedLead`, and `PrismaRunStore` contracts.

- [ ] **Step 1: Write a failing persistence test**

Append this case to `tests/domain/prismaRunStore.test.ts`:

```ts
it('persists provider heartbeats and deduplicates classified contacts', async () => {
  const run = await prisma.run.create({
    data: { actorId: 'local_first', leadSource: 'google_maps', status: 'running', maxResults: 100 },
  });
  const store = new PrismaRunStore(prisma);

  await store.upsertProviderState(run.id, {
    provider: 'google',
    status: 'running',
    operation: 'precision first pages',
    yieldCount: 12,
    budgetUsed: 3,
    budgetMax: 50,
    heartbeatAt: new Date('2026-07-21T16:00:00.000Z'),
  });
  await store.upsertProviderState(run.id, {
    provider: 'google',
    status: 'completed',
    operation: 'finished',
    yieldCount: 18,
    budgetUsed: 7,
    budgetMax: 50,
    heartbeatAt: new Date('2026-07-21T16:01:00.000Z'),
  });

  const lead = {
    leadSource: 'google_maps' as const,
    leadType: 'business' as const,
    companyName: 'Austin Dental',
    email: 'sales@austindental.example',
    normalizedEmail: 'sales@austindental.example',
    contactQuality: 'qualified' as const,
    qualityReason: 'business_domain_match',
    businessIdentityKey: 'site:austindental.example',
  };
  expect(await store.upsertContact(run.id, lead)).toBe('inserted');
  expect(await store.upsertContact(run.id, lead)).toBe('duplicate');

  expect(await prisma.runProviderState.findMany({ where: { runId: run.id } })).toEqual([
    expect.objectContaining({
      provider: 'google', status: 'completed', yieldCount: 18, budgetUsed: 7, budgetMax: 50,
    }),
  ]);
  expect(await prisma.lead.count({ where: { runId: run.id } })).toBe(1);
});
```

- [ ] **Step 2: Run the focused test and verify the missing-interface failure**

Run: `npm.cmd test -- tests/domain/prismaRunStore.test.ts`

Expected: FAIL because `upsertProviderState`, `upsertContact`, and the new Prisma fields do not exist.

- [ ] **Step 3: Add domain types and durable schema fields**

Add these contracts to `src/domain/types.ts` and fields to `NormalizedLead`:

```ts
export type OutputMode = 'standard' | 'hybrid_max';
export type ContactQuality = 'qualified' | 'raw';
export type ProviderName = 'docker' | 'google' | 'apify' | 'email';
export type ProviderStatus =
  | 'standby'
  | 'running'
  | 'waiting'
  | 'cooling_down'
  | 'paused'
  | 'completed'
  | 'failed';

export interface ProviderStateWrite {
  provider: ProviderName;
  status: ProviderStatus;
  operation: string;
  yieldCount: number;
  budgetUsed?: number;
  budgetMax?: number;
  heartbeatAt: Date;
  errorCode?: string;
  errorMessage?: string;
}
```

Add these optional properties to `NormalizedLead`:

```ts
normalizedEmail?: string;
contactQuality?: ContactQuality;
qualityReason?: string;
businessIdentityKey?: string;
```

Add this relation and fields to the Prisma `Run` model:

```prisma
  outputMode                        String     @default("standard")
  rawContactCount                   Int        @default(0)
  companiesWithQualifiedEmailCount Int        @default(0)
  plannedUnitCount                  Int        @default(0)
  completedUnitCount                Int        @default(0)
  extendedRun                       Boolean    @default(false)
  lastHeartbeatAt                   DateTime?
  providerStates                    RunProviderState[]
```

Add these fields and unique index to `Lead`:

```prisma
  normalizedEmail     String?
  contactQuality      String   @default("qualified")
  qualityReason       String?
  businessIdentityKey String?

  @@unique([runId, normalizedEmail])
  @@index([runId, contactQuality])
```

Add this model:

```prisma
model RunProviderState {
  id           Int      @id @default(autoincrement())
  runId        Int
  provider     String
  status       String
  operation    String
  yieldCount   Int      @default(0)
  budgetUsed   Int?
  budgetMax    Int?
  heartbeatAt  DateTime
  errorCode    String?
  errorMessage String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  run          Run      @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@unique([runId, provider])
  @@index([runId, heartbeatAt])
}
```

- [ ] **Step 4: Write the forward-only SQLite migration**

Create `prisma/migrations/20260721090000_max_output_core/migration.sql` with this forward-only SQL:

```sql
ALTER TABLE "Run" ADD COLUMN "outputMode" TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE "Run" ADD COLUMN "rawContactCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Run" ADD COLUMN "companiesWithQualifiedEmailCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Run" ADD COLUMN "plannedUnitCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Run" ADD COLUMN "completedUnitCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Run" ADD COLUMN "extendedRun" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Run" ADD COLUMN "lastHeartbeatAt" DATETIME;

ALTER TABLE "Lead" ADD COLUMN "normalizedEmail" TEXT;
ALTER TABLE "Lead" ADD COLUMN "contactQuality" TEXT NOT NULL DEFAULT 'qualified';
ALTER TABLE "Lead" ADD COLUMN "qualityReason" TEXT;
ALTER TABLE "Lead" ADD COLUMN "businessIdentityKey" TEXT;

CREATE TABLE "RunProviderState" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "runId" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "yieldCount" INTEGER NOT NULL DEFAULT 0,
  "budgetUsed" INTEGER,
  "budgetMax" INTEGER,
  "heartbeatAt" DATETIME NOT NULL,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "RunProviderState_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "Run" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Lead_runId_normalizedEmail_key" ON "Lead"("runId", "normalizedEmail");
CREATE INDEX "Lead_runId_contactQuality_idx" ON "Lead"("runId", "contactQuality");
CREATE UNIQUE INDEX "RunProviderState_runId_provider_key" ON "RunProviderState"("runId", "provider");
CREATE INDEX "RunProviderState_runId_heartbeatAt_idx" ON "RunProviderState"("runId", "heartbeatAt");
```

Use `ON DELETE CASCADE ON UPDATE CASCADE` for the provider-state foreign key. Do not delete or rewrite prior migrations.

- [ ] **Step 5: Implement store upserts and map every new run field**

Extend `LocalFirstRunStore`:

```ts
upsertProviderState(runId: number, state: ProviderStateWrite): Promise<void>;
upsertContact(runId: number, contact: NormalizedLead): Promise<'inserted' | 'duplicate'>;
```

Import `Prisma` beside `PrismaClient` from `@prisma/client`, then implement the two methods as follows:

```ts
async upsertProviderState(runId: number, state: ProviderStateWrite): Promise<void> {
  await this.prisma.runProviderState.upsert({
    where: { runId_provider: { runId, provider: state.provider } },
    create: { runId, ...state },
    update: state,
  });
}

async upsertContact(
  runId: number,
  contact: NormalizedLead
): Promise<'inserted' | 'duplicate'> {
  if (!contact.normalizedEmail) {
    throw new Error('Normalized email is required for contact persistence.');
  }
  try {
    await this.prisma.lead.create({
      data: {
        runId,
        leadSource: contact.leadSource,
        leadType: contact.leadType,
        companyName: contact.companyName,
        email: contact.email,
        normalizedEmail: contact.normalizedEmail,
        contactQuality: contact.contactQuality ?? 'qualified',
        qualityReason: contact.qualityReason,
        businessIdentityKey: contact.businessIdentityKey,
        website: contact.website,
        rawJson: contact.rawJson,
      },
    });
    return 'inserted';
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return 'duplicate';
    }
    throw error;
  }
}
```

Add the new `Run` fields to `RunRecord`, `toRunRecord()`, `createRun()`, and `updateRun()` mappings. Map all new contact fields in the existing lead creation code so Sales Navigator behavior remains compatible with `contactQuality: 'qualified'`.

- [ ] **Step 6: Generate the Prisma client and run the focused suite**

Run: `npm.cmd run prisma:generate`

Expected: Prisma client generation succeeds.

Run: `npm.cmd test -- tests/domain/prismaRunStore.test.ts`

Expected: PASS, including provider upsert and classified-contact deduplication.

- [ ] **Step 7: Commit the durable model**

```bash
git add prisma/schema.prisma prisma/migrations/20260721090000_max_output_core/migration.sql src/domain/types.ts src/domain/runService.ts src/domain/prismaRunStore.ts tests/domain/prismaRunStore.test.ts
git commit -m "feat: persist max-output session metrics"
```

---

### Task 2: Build a Finite Tiered Query Plan

**Files:**
- Create: `src/domain/queryPlan.ts`
- Modify: `src/domain/googleMapsQueryBuilder.ts`
- Create: `tests/domain/queryPlan.test.ts`
- Modify: `tests/domain/googleMapsQueryBuilder.test.ts`

**Interfaces:**
- Produces: `QueryTier`, `PlannedQuery`, `buildQueryPlan()`, `queriesForTier()`, and the compatibility wrapper `buildGoogleMapsSearchQueries()`.
- Consumes: `GoogleMapsFilters`.

- [ ] **Step 1: Write exact tier-ordering tests**

Create `tests/domain/queryPlan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildQueryPlan, queriesForTier } from '../../src/domain/queryPlan';

describe('buildQueryPlan', () => {
  it('orders precision and expansion by location and keeps recovery dormant', () => {
    const plan = buildQueryPlan({
      searchTerms: ['oilfield services'],
      categoryFilters: ['Oil & Gas'],
      companyTypes: ['Distributor'],
      locations: ['Houston, TX', 'Tulsa, OK'],
    });

    expect(queriesForTier(plan, 'precision').map((item) => item.text)).toEqual([
      'oilfield services Houston, TX',
      'oilfield services Tulsa, OK',
      'Oil & Gas Houston, TX',
      'Oil & Gas Tulsa, OK',
      'oilfield services Oil & Gas Houston, TX',
      'oilfield services Oil & Gas Tulsa, OK',
    ]);
    expect(queriesForTier(plan, 'expansion').map((item) => item.text)).toEqual([
      'oilfield services Distributor Houston, TX',
      'oilfield services Distributor Tulsa, OK',
      'Oil & Gas Distributor Houston, TX',
      'Oil & Gas Distributor Tulsa, OK',
    ]);
    expect(queriesForTier(plan, 'recovery').every((item) => item.qualityConfidence === 'low')).toBe(true);
    expect(new Set(plan.map((item) => item.id)).size).toBe(plan.length);
  });

  it('uses one location-only precision item when no business criterion exists', () => {
    expect(buildQueryPlan({ locationQuery: 'Austin, TX' })).toEqual([
      expect.objectContaining({ tier: 'precision', location: 'Austin, TX', text: 'Austin, TX' }),
    ]);
  });
});
```

- [ ] **Step 2: Verify the new module is missing**

Run: `npm.cmd test -- tests/domain/queryPlan.test.ts`

Expected: FAIL with module resolution error for `src/domain/queryPlan.ts`.

- [ ] **Step 3: Implement the plan contract**

Create `src/domain/queryPlan.ts` with these public contracts:

```ts
import { createHash } from 'node:crypto';
import { GoogleMapsFilters } from './types';

export type QueryTier = 'precision' | 'expansion' | 'recovery';
export type QueryProvider = 'docker' | 'google' | 'apify';

export interface PlannedQuery {
  id: string;
  tier: QueryTier;
  location: string;
  text: string;
  providerEligibility: QueryProvider[];
  qualityConfidence: 'high' | 'medium' | 'low';
}

const RECOVERY_MODIFIERS = ['supplier', 'distributor', 'retailer', 'service'];

function clean(values?: string[]): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function item(tier: QueryTier, location: string, text: string): PlannedQuery {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return {
    id: createHash('sha256').update(`${tier}\0${location}\0${normalized}`).digest('hex').slice(0, 20),
    tier,
    location,
    text: normalized,
    providerEligibility: ['docker', 'google', 'apify'],
    qualityConfidence: tier === 'precision' ? 'high' : tier === 'expansion' ? 'medium' : 'low',
  };
}

export function buildQueryPlan(filters: GoogleMapsFilters): PlannedQuery[] {
  const terms = clean(filters.searchTerms);
  const categories = clean(filters.categoryFilters);
  const companyTypes = clean(filters.companyTypes);
  const locations = filters.locationQuery?.trim()
    ? [filters.locationQuery.trim()]
    : clean(filters.locations);
  const effectiveLocations = locations.length ? locations : [''];
  const byLocation: PlannedQuery[][] = [];

  for (const location of effectiveLocations) {
    const locationPlan: PlannedQuery[] = [];
    const suffix = location ? ` ${location}` : '';
    const precision = [
      ...terms,
      ...categories,
      ...terms.flatMap((term) => categories.map((category) => `${term} ${category}`)),
    ];
    if (precision.length === 0) {
      locationPlan.push(item('precision', location, location));
    } else {
      for (const text of [...new Set(precision)]) {
        locationPlan.push(item('precision', location, `${text}${suffix}`));
      }
    }

    for (const text of [...terms, ...categories]) {
      for (const companyType of companyTypes) {
        locationPlan.push(item('expansion', location, `${text} ${companyType}${suffix}`));
      }
    }

    const recoveryRoots = [...new Set([...terms, ...categories, ...companyTypes])];
    for (const root of recoveryRoots) {
      for (const modifier of RECOVERY_MODIFIERS) {
        if (root.toLowerCase().includes(modifier)) continue;
        locationPlan.push(item('recovery', location, `${root} ${modifier}${suffix}`));
      }
    }
    byLocation.push(locationPlan);
  }

  const plan: PlannedQuery[] = [];
  for (const tier of ['precision', 'expansion', 'recovery'] as const) {
    const groups = byLocation.map((group) => group.filter((query) => query.tier === tier));
    const longest = Math.max(0, ...groups.map((group) => group.length));
    for (let index = 0; index < longest; index += 1) {
      for (const group of groups) {
        if (group[index]) plan.push(group[index]);
      }
    }
  }
  const seen = new Set<string>();
  return plan.filter((query) => !seen.has(query.text.toLowerCase()) && seen.add(query.text.toLowerCase()));
}

export function queriesForTier(plan: PlannedQuery[], tier: QueryTier): PlannedQuery[] {
  return plan.filter((item) => item.tier === tier);
}
```

- [ ] **Step 4: Preserve the legacy string-query API**

Replace `buildGoogleMapsSearchQueries()` internals with:

```ts
export function buildGoogleMapsSearchQueries(filters: GoogleMapsFilters): string[] {
  return buildQueryPlan(filters)
    .filter((item) => item.tier !== 'recovery')
    .map((item) => item.text);
}
```

Update the existing query-builder expectations to the new location-balanced order while retaining unique strings and targeted company-type modifiers.

- [ ] **Step 5: Run focused tests**

Run: `npm.cmd test -- tests/domain/queryPlan.test.ts tests/domain/googleMapsQueryBuilder.test.ts`

Expected: PASS with precision before expansion and dormant recovery represented in the plan.

- [ ] **Step 6: Commit the query planner**

```bash
git add src/domain/queryPlan.ts src/domain/googleMapsQueryBuilder.ts tests/domain/queryPlan.test.ts tests/domain/googleMapsQueryBuilder.test.ts
git commit -m "feat: plan tiered max-output queries"
```

---

### Task 3: Schedule Google Breadth-First With Exact Attempt Accounting

**Files:**
- Modify: `src/integrations/googlePlacesClient.ts`
- Modify: `tests/integrations/googlePlacesClient.test.ts`

**Interfaces:**
- Consumes: `buildQueryPlan()`, `PlannedQuery`, existing Google credentials and callbacks.
- Produces: `GooglePlacesWorkUnitEvent` and breadth-first first-page/page-token scheduling.

- [ ] **Step 1: Add failing breadth, recovery, and budget tests**

Add tests that record request bodies and assert this exact order for two locations whose first pages both return tokens:

```ts
expect(requestBodies).toEqual([
  { textQuery: 'dentist Austin, TX', pageSize: 20 },
  { textQuery: 'dentist Dallas, TX', pageSize: 20 },
  { textQuery: 'dentist Austin, TX', pageSize: 20, pageToken: 'a-2' },
  { textQuery: 'dentist Dallas, TX', pageSize: 20, pageToken: 'd-2' },
]);
```

Add a second test with `requestBudget: 2` and two failing keys; assert two `attempted` events and exactly two fetch calls. Add a third test with `shouldActivateRecovery: () => false`; assert no query containing `supplier`, `distributor`, `retailer`, or `service` is sent.

- [ ] **Step 2: Run the client suite and observe sequential-depth failure**

Run: `npm.cmd test -- tests/integrations/googlePlacesClient.test.ts`

Expected: FAIL because the current implementation requests page two before the next location's first page.

- [ ] **Step 3: Extend callbacks without exposing query text in persisted events**

Add:

```ts
export type GooglePlacesWorkUnitEvent =
  | { type: 'planned'; plannedUnitCount: number }
  | { type: 'extended'; additionalPlannedUnitCount: number }
  | {
      type: 'warning';
      warningCode: 'google_budget_below_location_coverage';
      requestBudget: number;
      locationCount: number;
    }
  | {
      type: 'started' | 'completed' | 'failed';
      workUnitId: string;
      tier: QueryTier;
      pageDepth: number;
      itemCount?: number;
      errorCode?: GooglePlacesErrorCode;
    };
```

Add to `GooglePlacesSearchInput`:

```ts
shouldActivateRecovery?: () => boolean;
onWorkUnitEvent?: (event: GooglePlacesWorkUnitEvent) => Promise<void> | void;
```

Keep `GooglePlacesShardEvent.query` for in-process compatibility, but never pass it into `RunEvent.metadataJson` in Task 7.

- [ ] **Step 4: Replace the nested query/page loop with tier queues**

Build `const plan = buildQueryPlan(filters)` and process `precision`, `expansion`, then conditional `recovery`. For each tier:

1. Send one first-page request for every planned query in location order.
2. Store successful page tokens as `{ query, token, depth: 2 }`.
3. After first-page breadth completes, shift one token at a time, request it, and append its successor token to the end of the same queue.
4. Stop before every request when `requestCount >= budget`, `places.length >= maxResults`, or `shouldStop?.()` is true.
5. Enter recovery only when `shouldActivateRecovery?.() ?? true` returns true.

Before scheduling, publish the non-recovery work-unit total. When recovery activates, publish one `extended` work-unit event before its first request and increase the planned denominator by the number of recovery first-page units. Publish one `completed` work-unit event after every successful first page or page-token request, including a zero-result response. This makes the persisted denominator and numerator reflect server work instead of UI timers.

If `requestBudget` is smaller than the number of distinct non-empty planned locations, call `onWorkUnitEvent` once with a redacted warning code `google_budget_below_location_coverage`; include only `requestBudget` and `locationCount`, never query text.

Use this request body builder so tests and page sizes stay deterministic:

```ts
function pageBody(textQuery: string, pageToken: string | undefined, remaining: number) {
  const body: Record<string, unknown> = { textQuery, pageSize: Math.min(20, remaining) };
  if (pageToken) body.pageToken = pageToken;
  return body;
}
```

Retain the existing `requestPage()` key rotation; it already increments before every HTTP attempt. Treat `invalid_key`, `forbidden`, and `quota` as terminal for the affected key, remove that key from the active pool, and stop immediately when the active pool is empty. Keep `rate_limited` and transient failures bounded to one pass through the remaining key pool.

- [ ] **Step 5: Run Google integration tests**

Run: `npm.cmd test -- tests/integrations/googlePlacesClient.test.ts`

Expected: PASS; first pages cover both locations before page tokens, every failed attempt consumes budget, and recovery remains dormant when the callback returns false.

- [ ] **Step 6: Commit the scheduler**

```bash
git add src/integrations/googlePlacesClient.ts tests/integrations/googlePlacesClient.test.ts
git commit -m "feat: schedule Google breadth before depth"
```

---

### Task 4: Configure the Safe Four-Page Docker Baseline

**Files:**
- Modify: `docker-compose.google-scraper.yml`
- Modify: `src/domain/balancedGoogleMapsRunService.ts`
- Modify: `tests/ops/googleScraperRuntime.test.ts`
- Modify: `tests/domain/balancedGoogleMapsRunService.test.ts`

**Interfaces:**
- Produces: durable `localConcurrency: 4` and scraper command concurrency `4`.
- Consumes: existing one-at-a-time application checkpoint loop.

- [ ] **Step 1: Tighten runtime assertions**

In `tests/ops/googleScraperRuntime.test.ts`, add:

```ts
expect(compose).toContain('command: ["-web", "-data-folder", "/gmapsdata", "-c", "4"]');
expect(compose.match(/google-maps-scraper:/g)).toHaveLength(1);
```

In the first balanced-run test, assert `expect(run.localConcurrency).toBe(4)`.

- [ ] **Step 2: Verify the baseline test fails on concurrency one**

Run: `npm.cmd test -- tests/ops/googleScraperRuntime.test.ts tests/domain/balancedGoogleMapsRunService.test.ts`

Expected: FAIL because Compose and run state still record concurrency `1`.

- [ ] **Step 3: Set concurrency four without parallel checkpoint submission**

Change Compose to:

```yaml
command: ["-web", "-data-folder", "/gmapsdata", "-c", "4"]
```

Change the initial balanced-run update to `localConcurrency: 4`. Keep the existing `for` loop in `runLocalProvider()` sequential; do not introduce parallel `searchBatch()` calls.

- [ ] **Step 4: Run focused tests**

Run: `npm.cmd test -- tests/ops/googleScraperRuntime.test.ts tests/domain/balancedGoogleMapsRunService.test.ts`

Expected: PASS and the test proving Google starts while the first Docker batch runs remains green.

- [ ] **Step 5: Commit the Docker baseline**

```bash
git add docker-compose.google-scraper.yml src/domain/balancedGoogleMapsRunService.ts tests/ops/googleScraperRuntime.test.ts tests/domain/balancedGoogleMapsRunService.test.ts
git commit -m "perf: use four-page Docker discovery"
```

---

### Task 5: Classify Qualified and Raw Contacts

**Files:**
- Create: `src/domain/contactClassifier.ts`
- Modify: `src/domain/emailExtractor.ts`
- Create: `tests/domain/contactClassifier.test.ts`
- Modify: `tests/domain/emailExtractor.test.ts`

**Interfaces:**
- Produces: `ContactDecision`, `classifyContact()`, `extractEmailCandidatesFromText()`, and `collectContactCandidates()`.
- Consumes: `NormalizedLead`, website URL, existing `EmailExtractor` output.

- [ ] **Step 1: Write the decision-table tests**

Create tests that assert:

```ts
expect(classifyContact('Sales@AcmeIndustrial.com', 'https://acmeindustrial.com')).toEqual({
  normalizedEmail: 'sales@acmeindustrial.com',
  quality: 'qualified',
  reason: 'business_domain_match',
});
expect(classifyContact('noreply@acmeindustrial.com', 'https://acmeindustrial.com')).toMatchObject({
  quality: 'raw', reason: 'automated_mailbox',
});
expect(classifyContact(
  'ef5d9bbac3354b759bfd7a23c3313b3f@o244637.ingest.us.sentry.io',
  'https://acmeindustrial.com'
)).toMatchObject({ quality: 'raw', reason: 'telemetry_address' });
expect(classifyContact('sales@unrelated.example', 'https://acmeindustrial.com')).toMatchObject({
  quality: 'raw', reason: 'unassociated_domain',
});
expect(classifyContact('logo@acmeindustrial.com.png', 'https://acmeindustrial.com')).toMatchObject({
  quality: 'raw', reason: 'asset_artifact',
});
```

Add an extractor test proving both `sales@example.com` and the Sentry address are returned by `extractEmailCandidatesFromText()`, while `extractEmailsFromText()` still returns only the qualified address for backward compatibility.

- [ ] **Step 2: Run tests and verify missing classifier failures**

Run: `npm.cmd test -- tests/domain/contactClassifier.test.ts tests/domain/emailExtractor.test.ts`

Expected: FAIL because the decision API does not exist and the current extractor discards raw candidates.

- [ ] **Step 3: Implement explicit reason codes**

Create:

```ts
export type ContactReason =
  | 'business_domain_match'
  | 'valid_without_business_domain'
  | 'malformed'
  | 'placeholder'
  | 'automated_mailbox'
  | 'telemetry_address'
  | 'asset_artifact'
  | 'unassociated_domain';

export interface ContactDecision {
  normalizedEmail: string;
  quality: 'qualified' | 'raw';
  reason: ContactReason;
}
```

Normalize case and trailing punctuation first. Classify `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, and `.svg` suffixes as `asset_artifact`; Sentry ingest hosts and Wix telemetry patterns as `telemetry_address`; `noreply`, `do-not-reply`, `mailer-daemon`, and `postmaster` as `automated_mailbox`; local parts `yourname`, `email`, and `user` plus domains ending in `.invalid` or `.local` as `placeholder`. When a website exists, accept only the same host or a parent/subdomain relationship; otherwise use `valid_without_business_domain` for a syntactically valid address.

- [ ] **Step 4: Preserve raw extraction and backward compatibility**

Add `extractEmailCandidatesFromText(text): string[]` that deobfuscates and returns unique case-normalized pattern matches before classification. Implement existing `extractEmailsFromText()` as:

```ts
export function extractEmailsFromText(text: string): string[] {
  return extractEmailCandidatesFromText(text)
    .map((email) => classifyContact(email))
    .filter((decision) => decision.quality === 'qualified')
    .map((decision) => decision.normalizedEmail);
}
```

Add:

```ts
export async function collectContactCandidates(
  lead: NormalizedLead,
  extractor?: EmailExtractor
): Promise<Array<NormalizedLead & {
  normalizedEmail: string;
  contactQuality: 'qualified' | 'raw';
  qualityReason: string;
}>>
```

Classify the existing email and every website-extracted candidate against `lead.website`, then deduplicate by normalized email. Keep `keepEmailLeadsOnly()` as a compatibility wrapper that calls this function and returns only qualified decisions.

- [ ] **Step 5: Run classifier and extractor tests**

Run: `npm.cmd test -- tests/domain/contactClassifier.test.ts tests/domain/emailExtractor.test.ts`

Expected: PASS; raw telemetry and unrelated domains are retained as raw decisions but excluded from `keepEmailLeadsOnly()`.

- [ ] **Step 6: Commit contact quality**

```bash
git add src/domain/contactClassifier.ts src/domain/emailExtractor.ts tests/domain/contactClassifier.test.ts tests/domain/emailExtractor.test.ts
git commit -m "feat: separate qualified and raw contacts"
```

---

### Task 6: Add One Global Website Task Pool and Continuous Persistence

**Files:**
- Create: `src/domain/boundedTaskPool.ts`
- Create: `src/domain/runIngestionCoordinator.ts`
- Create: `tests/domain/boundedTaskPool.test.ts`
- Create: `tests/domain/runIngestionCoordinator.test.ts`
- Modify: `src/domain/balancedGoogleMapsRunService.ts`
- Modify: `tests/domain/balancedGoogleMapsRunService.test.ts`

**Interfaces:**
- Produces: `BoundedTaskPool`, `RunIngestionCoordinator.ingest()`, `drain()`, and `snapshot()`.
- Consumes: `LocalFirstRunStore`, `EmailExtractor`, provider name, and normalized businesses.

- [ ] **Step 1: Write a strict concurrency test**

Submit 80 deferred jobs to `new BoundedTaskPool(50)`, record active and peak counts, resolve all jobs, and assert `peak === 50` and that every returned promise resolves. Add a constructor test asserting `new BoundedTaskPool(0)` throws `Concurrency must be at least 1.`

- [ ] **Step 2: Write a continuous-persistence coordinator test**

Use a fake store and two site scans, hold the second scan open, release the first, and assert the first contact was passed to `upsertContact()` before the second finishes. Assert:

```ts
expect(coordinator.snapshot()).toMatchObject({
  businessCount: 2,
  qualifiedContactCount: 1,
  rawContactCount: 0,
  companiesWithQualifiedEmailCount: 1,
});
```

- [ ] **Step 3: Verify both modules are missing**

Run: `npm.cmd test -- tests/domain/boundedTaskPool.test.ts tests/domain/runIngestionCoordinator.test.ts`

Expected: FAIL with module resolution errors.

- [ ] **Step 4: Implement the bounded pool**

Use a FIFO queue of `{ run, resolve, reject }`, increment `active` immediately before invoking a task, decrement it in `finally`, and call `pump()` after every completion. `drain()` resolves only when `active === 0 && queue.length === 0`. Do not create one pool per provider or per batch.

Public API:

```ts
export class BoundedTaskPool {
  constructor(readonly concurrency: number) {}
  submit<T>(task: () => Promise<T>): Promise<T>;
  drain(): Promise<void>;
}
```

- [ ] **Step 5: Implement the run-scoped ingestion coordinator**

Constructor:

```ts
constructor({
  runId,
  target,
  store,
  emailExtractor,
  websiteConcurrency = 50,
}: {
  runId: number;
  target: number;
  store: LocalFirstRunStore;
  emailExtractor?: EmailExtractor;
  websiteConcurrency?: number;
})
```

Public API:

```ts
ingest(items: unknown[], provider: 'docker' | 'google' | 'apify', filters: GoogleMapsFilters): Promise<void>;
drain(): Promise<void>;
snapshot(): {
  businessCount: number;
  qualifiedContactCount: number;
  rawContactCount: number;
  companiesWithQualifiedEmailCount: number;
  duplicateCount: number;
  websiteCount: number;
};
```

For each normalized business: apply business quality filters; upsert it; update run business/provider metrics; emit a redacted `business_persisted` event containing provider and counts but no query; then submit one website task. Each website task calls `collectContactCandidates()`, calls `upsertContact()` for every decision, updates qualified/raw/company counts after each inserted contact, and emits `contact_persisted` with quality and reason only. Use a `Set<string>` of business identity keys to count each company with a qualified email once.

- [ ] **Step 6: Replace the serial email queue in the balanced service**

Construct one coordinator at the start of `executeBalancedGoogleMapsRun()`. Replace `ingestProviderItems()` internals with `coordinator.ingest(items, provenance === 'local' ? 'docker' : 'google', filters)`. Remove `emailQueue`, `emailTasks`, and batch-level `keepEmailLeadsOnly()` calls. Call `await coordinator.drain()` after provider promises settle and before terminal status calculation. Map `snapshot().qualifiedContactCount` to `leadCount` and `snapshot().rawContactCount` to `rawContactCount`.

- [ ] **Step 7: Run focused concurrency and orchestration tests**

Run: `npm.cmd test -- tests/domain/boundedTaskPool.test.ts tests/domain/runIngestionCoordinator.test.ts tests/domain/balancedGoogleMapsRunService.test.ts`

Expected: PASS; peak website concurrency is exactly 50, the first completed site persists without waiting for the second, and provider failures preserve prior contacts.

- [ ] **Step 8: Commit continuous ingestion**

```bash
git add src/domain/boundedTaskPool.ts src/domain/runIngestionCoordinator.ts src/domain/balancedGoogleMapsRunService.ts tests/domain/boundedTaskPool.test.ts tests/domain/runIngestionCoordinator.test.ts tests/domain/balancedGoogleMapsRunService.test.ts
git commit -m "feat: persist website contacts continuously"
```

---

### Task 7: Coordinate Standard and Hybrid Providers Concurrently

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/domain/validation.ts`
- Modify: `src/domain/runService.ts`
- Modify: `src/domain/balancedGoogleMapsRunService.ts`
- Modify: `tests/domain/validation.test.ts`
- Modify: `tests/domain/runService.test.ts`
- Modify: `tests/domain/balancedGoogleMapsRunService.test.ts`

**Interfaces:**
- Produces: explicit `outputMode`, default Google budget `50`, provider-state heartbeats, and concurrent Hybrid Apify execution.
- Consumes: `RunIngestionCoordinator`, balanced provider outcome, and existing Apify shard runner.

- [ ] **Step 1: Add output-mode validation tests**

Assert an omitted mode for Google Maps validates to:

```ts
expect(result).toMatchObject({
  outputMode: 'standard',
  googleMaps: { provider: 'local_first', apiRequestBudget: 50 },
});
```

Assert `outputMode: 'hybrid_max'` requires an Apify token and maps to `googleMaps.provider: 'hybrid'`. Assert unknown mode returns field error `outputMode must be standard or hybrid_max.`

- [ ] **Step 2: Add a Hybrid concurrency test**

Use deferred Google/Docker and Apify fakes. Start the run, wait until all three have marked themselves started, and assert Apify started before either Google or Docker is released. After releasing all providers, assert the terminal event lists `['docker', 'google', 'apify', 'email']` and status is `completed` or `partially_completed` according to settled results.

- [ ] **Step 3: Run focused tests and observe sequential Apify behavior**

Run: `npm.cmd test -- tests/domain/validation.test.ts tests/domain/runService.test.ts tests/domain/balancedGoogleMapsRunService.test.ts`

Expected: FAIL because Hybrid currently starts Apify only after Docker and Google finish.

- [ ] **Step 4: Make output mode explicit and budget defaults deterministic**

Add `outputMode?: OutputMode` to `ValidatedRunInput`. In validation:

```ts
const outputMode: OutputMode = value.outputMode === undefined ? 'standard' : value.outputMode;
const provider = outputMode === 'hybrid_max' ? 'hybrid' : 'local_first';
const apiRequestBudget = parsedBudget === undefined ? 50 : parsedBudget;
```

Preserve explicit budget `0`. Serialize `outputMode` in safe filters. Store it on the run without storing credentials.

- [ ] **Step 5: Share one ingestion coordinator across selected providers**

Add an optional `ingestionCoordinator` dependency to `executeBalancedGoogleMapsRun()` so `runService` can construct one coordinator and pass it to Docker/Google and Apify. Change `runApifyShards()` to accept the same coordinator and call `coordinator.ingest(items, 'apify', filters)` instead of its independent email batch path for Google Maps sessions.

For Standard:

```ts
const selected = ['docker', 'google'] as const;
const results = await Promise.allSettled([
  runBalancedProviders({ finalize: false, ingestionCoordinator }),
]);
```

For Hybrid:

```ts
const selected = ['docker', 'google', 'apify'] as const;
const results = await Promise.allSettled([
  runBalancedProviders({ finalize: false, ingestionCoordinator }),
  runApifyShards(run, input, ingestionCoordinator, { continueOnShardError: true }),
]);
```

After all selected providers settle, drain the coordinator once. Mark `completed` when all selected providers complete, `partially_completed` when at least one provider fails after output was persisted, `failed` when every selected provider fails before output, and retain `waiting_for_credentials`, `waiting_for_scraper`, `paused`, or `cancelled` when those explicit stop states apply.

- [ ] **Step 6: Persist truthful provider state and redacted events**

At provider start, heartbeat, completion, and failure, call `upsertProviderState()`. Store Google `budgetUsed/budgetMax`, Apify run yield without token values, Docker yield with no paid budget, and email scanner active/completed counts. Event metadata may contain `workUnitId`, tier, counts, status, and error code; it must not contain query text, API keys, tokens, or proxy URLs.

At run start, set `plannedUnitCount` to the sum of non-recovery Google first-page units, Docker checkpoint batches, and Apify shards selected for the mode. Increment `completedUnitCount` exactly once for every terminal work-unit callback. When Google recovery emits `extended`, set `extendedRun: true` and add its recovery unit count to `plannedUnitCount`; never reduce the denominator after work begins.

- [ ] **Step 7: Run orchestration suites**

Run: `npm.cmd test -- tests/domain/validation.test.ts tests/domain/runService.test.ts tests/domain/balancedGoogleMapsRunService.test.ts`

Expected: PASS; Standard starts Docker and Google, Hybrid starts all three discovery providers before any finishes, and partial failures preserve output.

- [ ] **Step 8: Commit the session coordinator behavior**

```bash
git add src/domain/types.ts src/domain/validation.ts src/domain/runService.ts src/domain/balancedGoogleMapsRunService.ts tests/domain/validation.test.ts tests/domain/runService.test.ts tests/domain/balancedGoogleMapsRunService.test.ts
git commit -m "feat: coordinate max-output providers"
```

---

### Task 8: Expose a Secret-Free Persisted Session Report

**Files:**
- Create: `src/domain/sessionReport.ts`
- Create: `tests/domain/sessionReport.test.ts`
- Modify: `src/routes/api.ts`
- Modify: `tests/api/api.test.ts`

**Interfaces:**
- Produces: `SessionReport` and `GET /api/runs/:id/report` for the later Command Radar.
- Consumes: persisted `Run`, `RunProviderState`, and recent redacted `RunEvent` records.

- [ ] **Step 1: Write report DTO tests**

Assert this exact top-level shape:

```ts
expect(report).toEqual({
  runId: 12,
  outputMode: 'hybrid_max',
  status: 'running',
  metrics: {
    businesses: 42,
    qualifiedLeads: 15,
    companiesWithQualifiedEmail: 11,
    rawContacts: 7,
    websites: 30,
    duplicatesRemoved: 5,
  },
  progress: {
    plannedUnits: 20,
    completedUnits: 8,
    extendedRun: false,
  },
  providers: expect.arrayContaining([
    expect.objectContaining({ provider: 'google', status: 'running', budgetUsed: 4, budgetMax: 50 }),
  ]),
  heartbeatAt: '2026-07-21T16:01:00.000Z',
  warnings: [],
});
```

Seed sentinel credentials in unrelated fixture properties and assert `JSON.stringify(report)` contains none of them.

- [ ] **Step 2: Verify the module and route are absent**

Run: `npm.cmd test -- tests/domain/sessionReport.test.ts tests/api/api.test.ts`

Expected: FAIL because `sessionReport.ts` and `/runs/:id/report` do not exist.

- [ ] **Step 3: Implement a narrow DTO builder**

Define:

```ts
export interface SessionReport {
  runId: number;
  outputMode: 'standard' | 'hybrid_max';
  status: string;
  metrics: {
    businesses: number;
    qualifiedLeads: number;
    companiesWithQualifiedEmail: number;
    rawContacts: number;
    websites: number;
    duplicatesRemoved: number;
  };
  progress: { plannedUnits: number; completedUnits: number; extendedRun: boolean };
  providers: Array<{
    provider: 'docker' | 'google' | 'apify' | 'email';
    status: string;
    operation: string;
    yieldCount: number;
    budgetUsed?: number;
    budgetMax?: number;
    heartbeatAt: string;
    errorCode?: string;
    errorMessage?: string;
  }>;
  heartbeatAt?: string;
  warnings: Array<{ code: string; message: string; provider?: string }>;
}
```

Build only from explicit scalar fields. Do not spread Prisma objects. Derive warnings from provider states with `failed`, `cooling_down`, `paused`, or stale heartbeat status and from recent redacted error events. Do not include filter JSON, query text, AppSetting rows, raw error details, proxy URLs, or credentials.

- [ ] **Step 4: Add the report endpoint**

Implement `GET /runs/:id/report` by loading the run with provider states and at most 20 newest warning/error events, passing them to `buildSessionReport()`, returning 404 for a missing run, and returning `{ data: report }` for success.

- [ ] **Step 5: Run report and API tests**

Run: `npm.cmd test -- tests/domain/sessionReport.test.ts tests/api/api.test.ts`

Expected: PASS; the response contains persisted counts/provider states and no sentinel secret.

- [ ] **Step 6: Commit the report boundary**

```bash
git add src/domain/sessionReport.ts src/routes/api.ts tests/domain/sessionReport.test.ts tests/api/api.test.ts
git commit -m "feat: expose max-output session reports"
```

---

### Task 9: Integrate, Verify, and Document the Core Pipeline

**Files:**
- Modify: `README.md`
- Modify: `tests/api/api.test.ts`
- Modify: `tests/domain/runService.test.ts`
- Modify: `tests/public/staticUi.test.ts`

**Interfaces:**
- Consumes: all prior task interfaces.
- Produces: one tested backend baseline ready for secure-settings/proxy and Command Radar implementation.

- [ ] **Step 1: Add end-to-end fake-provider integration coverage**

Add a Standard case with fake Docker and Google providers where Google fails after Docker persists one business and its qualified contact. Assert terminal `partially_completed`, `leadCount: 1`, `businessCount: 1`, and preserved report metrics.

Add a Hybrid case where Docker, Google, and Apify each yield the same business/email in different shapes. Assert one canonical business, one qualified contact, provider yields for all three sources, and a duplicate count greater than zero.

Add a low-budget case with two locations and budget `1`; assert a warning event with code `google_budget_below_location_coverage` and no more than one Google fetch.

- [ ] **Step 2: Run the complete automated suite**

Run: `npm.cmd test`

Expected: all Vitest files and tests pass.

- [ ] **Step 3: Build from a clean TypeScript graph**

Run: `npm.cmd run build`

Expected: `tsc` exits zero with no diagnostics.

- [ ] **Step 4: Verify migration and repository hygiene**

Run: `npm.cmd run prisma:generate`

Expected: Prisma client generation succeeds.

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git status --short`

Expected: only the files intentionally changed by this plan are listed before the final commit.

- [ ] **Step 5: Document operator semantics and safe live verification**

Update `README.md` with:

- Standard = Docker + Google, default budget 50;
- Hybrid Max Output = Docker + Google + Apify;
- qualified contacts versus raw contacts and all dashboard metric definitions;
- Docker concurrency 4 and website concurrency 50;
- request attempts count failed HTTP calls and rotated-key retries;
- low-budget Standard smoke test precedes Hybrid;
- real credentials are entered only through the secure UI after the secure-settings plan lands;
- no maximum-output live run is performed until secure settings and provider-specific credential tests pass.

- [ ] **Step 6: Commit the integrated backend**

```bash
git add README.md tests/api/api.test.ts tests/domain/runService.test.ts tests/public/staticUi.test.ts
git commit -m "docs: verify max-output pipeline behavior"
```

- [ ] **Step 7: Record the verified handoff**

Run: `git log -9 --oneline --decorate`

Expected: one coherent commit per task group, ending with `docs: verify max-output pipeline behavior`.

Record the exact test-file count, test count, build result, migration name, and current commit hash in the implementation handoff. Do not claim controlled live verification; it remains gated on secure UI credential entry and the subsequent secure-settings/proxy plan.
