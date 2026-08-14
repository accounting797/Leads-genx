# Leads-GenX Feature Contract Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the repository contracts for the Sales Navigator extension, Greenhouse hiring signals, and Nova Shuffle while keeping the targeted-scraping Valid-email work unchanged.

**Architecture:** Treat the existing feature services, routers, tests, and the last coherent Git revisions as the contract. Repair the persistence layer first, then restore dependency injection and route wiring, then reconcile Shuffle's curated deck with the public suggestion catalog. Each slice is independently tested and committed before the fresh-database full regression gate.

**Tech Stack:** Node.js 24, TypeScript 6, Express 5, Prisma 5 with SQLite, Vitest 3, Supertest.

## Global Constraints

- Restore and reconcile existing behavior only; do not design new product behavior.
- Preserve targeted scraping and the Valid-email definition: valid emails include qualifying personal and business emails.
- Retain Greenhouse hiring signals as a supplemental lane that never creates leads, changes parent-run counts, or holds/reopens a parent run.
- Retain extension bearer-token secrecy and per-user ownership checks.
- Retain Nova Shuffle as filter preparation only; it must not automatically launch paid work.
- Expose “Nova, arrange my filters” only inside the standard New Run Google Maps section; do not add it to Targeted Scraping.
- Do not add hand-written migrations; this repository synchronizes schema changes with `prisma db push`.
- Do not push to GitHub until the fresh full test suite and plain TypeScript build are green.

## File Map

- `prisma/schema.prisma` — authoritative persisted contract for extension tokens and hiring-signal records.
- `scripts/ensure-prisma-client.cjs` — schema fingerprint guard that regenerates stale Prisma clients.
- `package.json` — invokes that guard before tests and builds.
- `src/app.ts` — constructs the hiring service and connects run settlement/startup recovery while retaining targeted-service wiring.
- `src/domain/runService.ts` — invokes supplemental settlement callbacks without allowing them to alter the parent run outcome.
- `src/routes/api.ts` — mounts extension, hiring, targeted, and Shuffle endpoints with the correct authentication boundaries.
- `src/domain/runAnalyst.ts` — turns supplemental hiring evidence and partial-scan state into bounded Nova report lines.
- `src/domain/suggestions.ts` — public filter catalog; must contain every value emitted by the curated Shuffle deck.
- `public/index.html` — places the Arrange control inside the standard Google Maps source section, outside Targeted Scraping.
- `public/api.js` — exposes the authenticated Shuffle POST request to the standard run form.
- `public/app.js` — applies a Shuffle pick to Google Maps chips and carries its `comboId` into the next standard run.
- `docs/AGENT_LOG.md` — repository-required implementation and verification record.

---

### Task 1: Restore the Prisma schema and generated-client guard

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `scripts/ensure-prisma-client.cjs`
- Modify: `package.json`
- Test: `tests/ops/prismaClientGeneration.test.ts`
- Test: `tests/api/extensionApi.test.ts`
- Test: `tests/domain/hiringSignalService.test.ts`

**Interfaces:**
- Consumes: Prisma 5 CLI at `node_modules/prisma/build/index.js` and `prisma/schema.prisma`.
- Produces: `User.extensionToken: string | null`, `PrismaClient.hiringSignalScan`, `PrismaClient.greenhouseBoard`, and `PrismaClient.hiringOpportunity`; `npm test` and `npm run build` always validate the generated client fingerprint first.

- [ ] **Step 1: Run the existing guard test and capture the red state**

```powershell
npx vitest run tests/ops/prismaClientGeneration.test.ts --maxWorkers=1 --minWorkers=1
```

Expected: FAIL because `scripts.pretest` and `scripts.prebuild` are absent.

- [ ] **Step 2: Restore the missing schema fields, relations, models, indexes, and cascades**

Add the optional token field inside `model User`:

```prisma
  extensionToken String?
```

Add the relations inside `model Run`:

```prisma
  hiringSignalScans   HiringSignalScan[]
  hiringOpportunities HiringOpportunity[]
```

Add the exact retained models after the existing run-related models:

```prisma
model HiringSignalScan {
  id               Int                 @id @default(autoincrement())
  runId            Int
  activeRunKey     Int?                @unique
  status           String              @default("queued")
  manualRefresh    Boolean             @default(false)
  candidateCount   Int                 @default(0)
  inspectedCount   Int                 @default(0)
  cachedBoardCount Int                 @default(0)
  matchedCount     Int                 @default(0)
  opportunityCount Int                @default(0)
  heartbeatAt      DateTime?
  startedAt        DateTime?
  completedAt      DateTime?
  errorMessage     String?
  createdAt        DateTime            @default(now())
  updatedAt        DateTime            @updatedAt
  run              Run                 @relation(fields: [runId], references: [id], onDelete: Cascade)
  opportunities    HiringOpportunity[]

  @@index([runId, createdAt])
  @@index([status, heartbeatAt])
}

model GreenhouseBoard {
  id              Int       @id @default(autoincrement())
  boardToken      String    @unique
  companyKey      String
  companyName     String
  companyDomain   String?
  industry        String?
  geographiesJson String?
  evidenceUrl     String
  discoverySource String
  jobsJson        String?
  fetchedAt       DateTime?
  verifiedAt      DateTime?
  invalidAt       DateTime?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@index([companyKey])
}

model HiringOpportunity {
  id                  Int              @id @default(autoincrement())
  scanId              Int
  runId               Int
  companyKey          String
  companyName         String
  companyDomain       String?
  originLane          String
  score               Int
  scoreJson           String
  jobsJson            String
  evidenceUrl         String
  evidenceFingerprint String
  relationship        String
  explanation         String?
  saved               Boolean          @default(false)
  dismissed           Boolean          @default(false)
  observedAt          DateTime         @default(now())
  scan                HiringSignalScan @relation(fields: [scanId], references: [id], onDelete: Cascade)
  run                 Run              @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@unique([scanId, companyKey])
  @@index([runId, originLane, score])
}
```

- [ ] **Step 3: Restore the deterministic Prisma generation guard**

Create `scripts/ensure-prisma-client.cjs` with:

```javascript
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const root = join(__dirname, '..');
const sourceSchema = join(root, 'prisma', 'schema.prisma');
const generatedClient = join(root, 'node_modules', '.prisma', 'client', 'index.js');
const fingerprintFile = join(root, 'node_modules', '.prisma', 'client', 'leads-genx-schema.sha256');

function contents(path) {
  try {
    return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return undefined;
  }
}

const fingerprint = createHash('sha256').update(contents(sourceSchema) || '').digest('hex');
if (existsSync(generatedClient) && contents(fingerprintFile)?.trim() === fingerprint) process.exit(0);

const prismaCli = join(root, 'node_modules', 'prisma', 'build', 'index.js');
const result = spawnSync(process.execPath, [prismaCli, 'generate'], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
if (result.status === 0) writeFileSync(fingerprintFile, `${fingerprint}\n`, 'utf8');
process.exit(result.status == null ? 1 : result.status);
```

- [ ] **Step 4: Invoke the guard before both tests and builds**

Add these keys to `package.json`'s `scripts` object without changing the serialized Vitest worker limits:

```json
"prebuild": "node scripts/ensure-prisma-client.cjs",
"pretest": "node scripts/ensure-prisma-client.cjs",
"test": "vitest run --maxWorkers=1 --minWorkers=1"
```

- [ ] **Step 5: Generate the client and prove the persistence contract is green**

```powershell
node scripts/ensure-prisma-client.cjs
npx vitest run tests/ops/prismaClientGeneration.test.ts tests/domain/hiringSignalService.test.ts --maxWorkers=1 --minWorkers=1
```

Expected: Prisma generation succeeds; both test files pass. Extension API tests may still fail with HTTP 404 until Task 2.

- [ ] **Step 6: Commit the persistence repair**

```powershell
git add prisma/schema.prisma scripts/ensure-prisma-client.cjs package.json
git commit -m "fix: restore retained prisma feature contracts"
```

---

### Task 2: Restore the Sales Navigator extension route boundary

**Files:**
- Modify: `src/routes/api.ts`
- Test: `tests/api/extensionApi.test.ts`

**Interfaces:**
- Consumes: `createExtensionRouter({ prisma, guard, onRunSettled })` from `src/routes/extension.ts` and the restored `User.extensionToken` field.
- Produces: `/api/extension/ping`, `/api/extension/leads`, and `/api/extension/finish` with bearer authentication, plus session-authenticated `/api/extension/token` routes.

- [ ] **Step 1: Verify the existing extension contract is red for the missing route mount**

```powershell
npx vitest run tests/api/extensionApi.test.ts --maxWorkers=1 --minWorkers=1
```

Expected: FAIL with extension endpoint 404 responses.

- [ ] **Step 2: Import and mount the extension router before the blanket session guard**

Add the import in `src/routes/api.ts`:

```typescript
import { createExtensionRouter } from './extension';
```

Immediately after the `/auth` mount and before `router.use(guard)`, add:

```typescript
  // Bearer-auth ingestion and session-auth token management share this router,
  // so it must mount before the blanket session guard.
  if (prisma?.user) {
    router.use('/extension', createExtensionRouter({ prisma, guard }));
  }
```

Do not log bearer tokens or add token values to run events.

- [ ] **Step 3: Run the extension API contract**

```powershell
npx vitest run tests/api/extensionApi.test.ts --maxWorkers=1 --minWorkers=1
```

Expected: PASS, including token rotation, ownership, duplicate ingestion, finish, and authentication cases.

- [ ] **Step 4: Commit the extension mount**

```powershell
git add src/routes/api.ts
git commit -m "fix: restore extension api wiring"
```

---

### Task 3: Restore Greenhouse hiring-signal lifecycle and API integration

**Files:**
- Modify: `src/app.ts`
- Modify: `src/routes/api.ts`
- Modify: `src/domain/runAnalyst.ts`
- Modify: `src/domain/runService.ts`
- Test: `tests/domain/hiringSignalService.test.ts`
- Test: `tests/domain/runAnalyst.test.ts`
- Test: `tests/domain/runService.test.ts`
- Test: `tests/api/hiringSignalsApi.test.ts`

**Interfaces:**
- Consumes: `createHiringSignalService({ prisma, greenhouseClient })`, `GreenhouseClient`, and `createHiringSignalsRouter({ prisma, service })`.
- Produces: optional `ApiDeps.hiringSignalService?: HiringSignalService`; run settlement calls `scheduleIfEligible(runId)`; startup recovery calls `recoverInterruptedScans()`; extension finish also schedules eligible scans.

- [ ] **Step 1: Verify the API/lifecycle contract is red while the domain contract remains green**

```powershell
npx vitest run tests/domain/hiringSignalService.test.ts tests/api/hiringSignalsApi.test.ts --maxWorkers=1 --minWorkers=1
```

Expected: domain service tests pass after Task 1; API tests fail because `ApiDeps` and hiring routes are not wired.

- [ ] **Step 2: Add a failing settlement-callback contract to the run service**

Inside the existing `describe('createRunService', ...)` in `tests/domain/runService.test.ts`, add:

```typescript
  it('notifies the supplemental coordinator once after a foreground run settles', async () => {
    const store = createStore();
    const settled: number[] = [];
    const actorClient: ActorClient = {
      async startRun() {
        return { runId: 'settled-run', status: 'SUCCEEDED', datasetId: 'settled-dataset' };
      },
      async getRun() {
        throw new Error('not used');
      },
      async getDatasetItems() {
        return [];
      },
    };
    const service = createRunService({
      store,
      actorClient,
      onRunSettled: async (runId) => {
        settled.push(runId);
      },
    });

    const run = await service.startRun(
      {
        apifyToken: 'token',
        leadSource: 'google_maps',
        maxResults: 10,
        googleMaps: { provider: 'apify', searchTerms: ['dentist'], locationQuery: 'Austin, TX' },
      },
      { background: false },
    );

    expect(settled).toEqual([run.id]);
  });
```

Run:

```powershell
npx vitest run tests/domain/runService.test.ts --maxWorkers=1 --minWorkers=1
```

Expected: FAIL at compile time because `RunServiceDeps.onRunSettled` is absent.

- [ ] **Step 3: Restore the non-blocking settlement callback in every execution path**

Add to `RunServiceDeps` in `src/domain/runService.ts`:

```typescript
  /** Supplemental work scheduled only after the parent run has settled. */
  onRunSettled?: (runId: number) => Promise<void>;
```

Destructure `onRunSettled` in `createRunService`. Immediately after `executeRun`, add:

```typescript
  async function executeAndNotify(run: RunRecord, input: ValidatedRunInput): Promise<void> {
    try {
      await executeRun(run, input);
    } finally {
      try {
        await onRunSettled?.(run.id);
      } catch {
        // Supplemental discovery must never reopen, fail, or change the parent run.
      }
    }
  }
```

Replace all four orchestration calls—not the public `executeRun` method returned for tests—from:

```typescript
void executeRun(run, input);
await executeRun(run, input);
```

to their matching forms:

```typescript
void executeAndNotify(run, input);
await executeAndNotify(run, input);
```

This applies to resume, startup recovery, background start, and foreground start. It must not call the callback from inside `executeRun`, which could double-schedule direct test invocations.

- [ ] **Step 4: Extend `ApiDeps` and mount the authenticated hiring router**

Add imports to `src/routes/api.ts`:

```typescript
import type { HiringSignalService } from '../domain/hiringSignalService';
import { createHiringSignalsRouter } from './hiringSignals';
```

Add the dependency to `ApiDeps`:

```typescript
  hiringSignalService?: HiringSignalService;
```

Destructure `hiringSignalService` in `createApiRouter(...)`. After `router.use(guard)` and the admin mount, add:

```typescript
  if (prisma && hiringSignalService) {
    router.use(createHiringSignalsRouter({ prisma, service: hiringSignalService }));
  }
```

Update the Task 2 extension mount so extension completion schedules the same supplemental scan:

```typescript
  if (prisma?.user) {
    router.use(
      '/extension',
      createExtensionRouter({
        prisma,
        guard,
        onRunSettled: hiringSignalService
          ? async (runId) => {
              await hiringSignalService.scheduleIfEligible(runId);
            }
          : undefined,
      }),
    );
  }
```

- [ ] **Step 5: Construct the hiring service without disturbing targeted service construction**

Add imports to `src/app.ts`:

```typescript
import { createHiringSignalService } from './domain/hiringSignalService';
import { GreenhouseClient } from './integrations/greenhouseClient';
```

Immediately after `const runtimePrisma = deps.prisma ?? prisma;`, construct:

```typescript
  const hiringSignalService =
    deps.hiringSignalService ??
    createHiringSignalService({
      prisma: runtimePrisma,
      greenhouseClient: new GreenhouseClient(),
    });
```

Inside the existing default `createRunService({...})` options, add:

```typescript
      onRunSettled: async (runId) => {
        await hiringSignalService.scheduleIfEligible(runId);
      },
```

Keep the existing `TargetedService` constructor, settings loader, and targeted recovery unchanged.

- [ ] **Step 6: Add hiring recovery and pass the service to the API router**

Inside the existing `if (deps.recoverOnStartup)` recovery block, add an independent non-blocking call:

```typescript
    setImmediate(() => {
      void hiringSignalService.recoverInterruptedScans().catch((error) => {
        console.error(`Hiring-signal recovery failed: ${safeErrorMessage(error)}`);
      });
    });
```

Add the dependency to the `createApiRouter` call:

```typescript
      hiringSignalService,
```

- [ ] **Step 7: Restore the bounded hiring input contract in the analyst**

In `src/domain/runAnalyst.ts`, add these types before `AnalystInput`:

```typescript
export interface AnalystHiringSignal {
  companyName: string;
  score: number;
  explanation: string;
  originLane?: 'google_maps' | 'sales_navigator' | 'hiring_opportunity';
}

export interface AnalystHiringScan {
  status: string;
  errorMessage?: string | null;
}
```

Extend `AnalystInput`:

```typescript
  hiringSignals?: AnalystHiringSignal[];
  hiringScan?: AnalystHiringScan | null;
```

Extend the `analyzeRun` destructuring without changing existing defaults:

```typescript
export function analyzeRun({
  run,
  events,
  providerStates,
  errorLogs,
  hiringSignals = [],
  hiringScan,
  now = new Date(),
}: AnalystInput): AnalystReport {
```

Immediately after the existing “Output so far” block and before error-log processing, add:

```typescript
  const hiringStatusLine =
    hiringScan?.status === 'partially_completed'
      ? 'Hiring check: Some public hiring boards did not answer, but the evidence Nova saved is still available.'
      : hiringScan?.status === 'failed'
        ? 'Hiring check: The optional public-board check could not finish; your lead run and saved output are unchanged.'
        : undefined;
  const prioritizedHiringSignals = [...hiringSignals].sort((left, right) => {
    const leftAdjacent = left.originLane === 'hiring_opportunity' ? 1 : 0;
    const rightAdjacent = right.originLane === 'hiring_opportunity' ? 1 : 0;
    return leftAdjacent - rightAdjacent || right.score - left.score || left.companyName.localeCompare(right.companyName);
  });
  const signalLimit = hiringStatusLine ? 1 : 2;
  for (const signal of prioritizedHiringSignals.slice(0, signalLimit)) {
    lines.push({
      tone: signal.score >= 90 ? 'ok' : 'info',
      text: `Hiring signal ${signal.score}/100 for ${signal.companyName}: ${signal.explanation}`,
    });
  }
  if (hiringStatusLine) {
    lines.push({ tone: 'info', text: hiringStatusLine });
  }
```

- [ ] **Step 8: Restore exact hiring annotations in analyst and lead API responses**

Add the existing score imports and parser to `src/routes/api.ts`:

```typescript
import { companyIdentity, HiringScoreComponents } from '../domain/greenhouseSignals';

function parseHiringComponents(scoreJson: string): HiringScoreComponents {
  const empty = { roles: 0, recency: 0, geography: 0, industry: 0, breadth: 0 };
  try {
    const value = JSON.parse(scoreJson) as Partial<Record<keyof HiringScoreComponents, unknown>>;
    return Object.fromEntries(
      Object.keys(empty).map((key) => {
        const item = value[key as keyof HiringScoreComponents];
        return [key, typeof item === 'number' && Number.isFinite(item) ? item : 0];
      }),
    ) as unknown as HiringScoreComponents;
  } catch {
    return empty;
  }
}
```

Also add the URL sanitizer used by hiring evidence links:

```typescript
function safeHttpsUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}
```

Replace the current `/runs/:id/analyst` handler's three-query section and `analyzeRun` call with the retained query shape:

```typescript
      const latestHiringScan = await prisma.hiringSignalScan.findFirst({
        where: { runId },
        orderBy: { id: 'desc' },
        select: { id: true, status: true, errorMessage: true },
      });
      const [events, providerStates, errorLogs, hiringSignals] = await Promise.all([
        prisma.runEvent.findMany({ where: { runId }, orderBy: { createdAt: 'asc' }, take: 200 }),
        prisma.runProviderState.findMany({ where: { runId } }),
        prisma.errorLog.findMany({ where: { runId }, orderBy: { createdAt: 'desc' }, take: 20 }),
        latestHiringScan
          ? prisma.hiringOpportunity.findMany({
              where: { scanId: latestHiringScan.id, dismissed: false },
              orderBy: [{ score: 'desc' }, { companyName: 'asc' }],
              take: 10,
              select: { companyName: true, score: true, explanation: true, originLane: true },
            })
          : Promise.resolve([]),
      ]);
      const report = analyzeRun({
        run: {
          status: run.status,
          leadCount: run.leadCount,
          rawContactCount: run.rawContactCount,
          businessCount: run.businessCount,
          maxResults: run.maxResults,
          apiRequestsUsed: run.apiRequestsUsed,
          apiRequestBudget: run.apiRequestBudget,
          actorId: run.actorId,
          errorMessage: run.errorMessage ?? undefined,
        },
        events: events.map((event) => ({
          type: event.type,
          message: event.message,
          createdAt: event.createdAt,
          metadata: parseEventMetadata(event.metadataJson),
        })),
        providerStates,
        errorLogs,
        hiringSignals: hiringSignals.map((signal) => ({
          companyName: signal.companyName,
          score: signal.score,
          explanation: signal.explanation ?? '',
          originLane: signal.originLane as 'google_maps' | 'sales_navigator' | 'hiring_opportunity',
        })),
        hiringScan: latestHiringScan
          ? { status: latestHiringScan.status, errorMessage: latestHiringScan.errorMessage }
          : null,
      });
```

Replace `leadScope` with the source-aware signature:

```typescript
  function leadScope(
    res: Response,
    runId?: number,
    leadSource?: 'google_maps' | 'sales_navigator',
  ): Record<string, unknown> | undefined {
    const user = currentUser(res);
    if (!prisma) return undefined;
    const where: Record<string, unknown> = {};
    if (runId) where.runId = runId;
    if (leadSource) where.leadSource = leadSource;
    if (user && user.role !== 'ADMIN') where.run = { userId: user.id };
    return Object.keys(where).length ? where : undefined;
  }
```

Replace the current `/leads` handler with:

```typescript
  router.get(
    '/leads',
    asyncHandler(async (req, res) => {
      const runId = req.query.runId ? Number(req.query.runId) : undefined;
      const leadSource = typeof req.query.leadSource === 'string' ? req.query.leadSource : undefined;
      if (leadSource && leadSource !== 'google_maps' && leadSource !== 'sales_navigator') {
        res.status(400).json({ error: 'Choose Google Maps or Sales Navigator.' });
        return;
      }
      const selectedLeadSource =
        leadSource === 'google_maps' || leadSource === 'sales_navigator' ? leadSource : undefined;
      const leads = prisma
        ? await prisma.lead.findMany({
            where: leadScope(res, runId, selectedLeadSource),
            orderBy: { createdAt: 'desc' },
          })
        : [];
      if (!prisma || !leads.length) {
        res.json({ data: leads });
        return;
      }
      const runIds = [...new Set(leads.map((lead) => lead.runId))];
      const scans = await prisma.hiringSignalScan.findMany({
        where: { runId: { in: runIds } },
        orderBy: { id: 'desc' },
        select: { id: true, runId: true },
      });
      const latestScanIds = new Map<number, number>();
      for (const scan of scans) {
        if (!latestScanIds.has(scan.runId)) latestScanIds.set(scan.runId, scan.id);
      }
      const signals = latestScanIds.size
        ? await prisma.hiringOpportunity.findMany({
            where: {
              scanId: { in: [...latestScanIds.values()] },
              dismissed: false,
              relationship: 'exact',
            },
            orderBy: { score: 'desc' },
          })
        : [];
      const signalByIdentity = new Map(
        signals.map((signal) => [
          `${signal.runId}:${signal.companyKey}`,
          {
            id: signal.id,
            score: signal.score,
            components: parseHiringComponents(signal.scoreJson),
            explanation: signal.explanation ?? '',
            evidenceUrl: safeHttpsUrl(signal.evidenceUrl),
            observedAt: signal.observedAt.toISOString(),
          },
        ]),
      );
      res.json({
        data: leads.map((lead) => {
          const identity = companyIdentity({ companyName: lead.companyName, website: lead.website });
          const hiringSignal = signalByIdentity.get(`${lead.runId}:${identity.companyKey}`);
          return hiringSignal ? { ...lead, hiringSignal } : lead;
        }),
      });
    }),
  );
```

Update `/leads/download` to apply the same `leadSource` validation and call `leadScope(res, runId, selectedLeadSource)` so visible results and exports cannot disagree.

- [ ] **Step 9: Run the hiring and neighboring route regressions**

```powershell
npx vitest run tests/domain/runService.test.ts tests/domain/hiringSignalService.test.ts tests/domain/runAnalyst.test.ts tests/api/hiringSignalsApi.test.ts tests/api/extensionApi.test.ts tests/api/targetedApi.test.ts --maxWorkers=1 --minWorkers=1
```

Expected: all four files pass. Parent run counts/status assertions in the hiring domain suite remain unchanged.

- [ ] **Step 10: Commit the hiring integration**

```powershell
git add src/app.ts src/routes/api.ts src/domain/runAnalyst.ts src/domain/runService.ts tests/domain/runService.test.ts
git commit -m "fix: restore hiring signal lifecycle"
```

---

### Task 4: Restore Nova Shuffle's POST API and catalog contract

**Files:**
- Modify: `src/routes/api.ts`
- Modify: `src/domain/suggestions.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/domain/validation.ts`
- Modify: `src/domain/runService.ts`
- Modify: `public/index.html`
- Modify: `public/api.js`
- Modify: `public/app.js`
- Test: `tests/api/shuffleApi.test.ts`
- Test: `tests/domain/shuffleCombos.test.ts`
- Test: `tests/domain/validation.test.ts`
- Test: `tests/domain/runService.test.ts`
- Test: `tests/public/staticUi.test.ts`

**Interfaces:**
- Consumes: `pickNextCombo(request: ShuffleRequest, stats: Record<string, ComboStat>, random?: () => number): ShufflePick` and run `filterJson.comboId` history.
- Produces: authenticated `POST /api/shuffle/next`; Google Maps filters use `searchTerms/categoryFilters/companyTypes/locations`; Sales Navigator filters use `titles/industries/geographies/headcounts`.

- [ ] **Step 1: Verify both existing Shuffle contracts are red**

```powershell
npx vitest run tests/domain/shuffleCombos.test.ts tests/api/shuffleApi.test.ts --maxWorkers=1 --minWorkers=1
```

Expected: domain test fails on values missing from `suggestions`; API test fails with HTTP 404; there is no Arrange control in the standard Google Maps form.

- [ ] **Step 2: Add every curated Shuffle value to the canonical suggestion catalog**

In `suggestions.googleMaps.searchTemplates`, add:

```typescript
      'Practice Manager',
      'Office Manager',
```

In `suggestions.googleMaps.businessCategories`, add:

```typescript
      'Dental Clinics',
      'Veterinary Services',
      'Auto Repair',
      'Landscaping & Lawn Care',
      'Real Estate Agencies',
      'Restaurants & Food Service',
      'Warehousing & Distribution',
      'Accounting Firms',
      'Medical Spas & Aesthetics',
      'Electrical Contractors',
      'Staffing & Recruiting',
      'Insurance Agencies',
```

In `suggestions.salesNavigator.titles`, add:

```typescript
      'Practice Manager',
```

Do not change `SHUFFLE_COMBOS`; it is the retained curated deck.

- [ ] **Step 3: Add failing tests for the selected combo learning signal**

Add this test to `tests/domain/validation.test.ts`:

```typescript
  it('keeps a Nova Shuffle combo id as a run learning signal', () => {
    const input = validateCreateRunInput(
      {
        leadSource: 'google_maps',
        maxResults: 100,
        googleApiKey: 'google-key',
        comboId: 'owner-roofing-houston',
        googleMaps: { provider: 'google_places', searchTerms: ['Owner'], locations: ['Houston, TX'] },
      },
      false,
    );

    expect(input.comboId).toBe('owner-roofing-houston');
  });
```

Extend the existing `serializeSafeFilters` test in `tests/domain/runService.test.ts` by supplying:

```typescript
comboId: 'owner-roofing-houston',
```

and asserting:

```typescript
expect(JSON.parse(serialized).comboId).toBe('owner-roofing-houston');
```

Run:

```powershell
npx vitest run tests/domain/validation.test.ts tests/domain/runService.test.ts --maxWorkers=1 --minWorkers=1
```

Expected: FAIL because `ValidatedRunInput` and the serialized safe filters do not contain `comboId`.

- [ ] **Step 4: Preserve the selected combo as a secret-safe learning signal**

Add to `ValidatedRunInput` in `src/domain/types.ts`:

```typescript
  /** Nova Shuffle combo this run was arranged from (learning signal). */
  comboId?: string;
```

In the success return from `validateCreateRunInput` in `src/domain/validation.ts`, add:

```typescript
    comboId: asString(obj.comboId),
```

In the object serialized by `serializeSafeFilters` in `src/domain/runService.ts`, add:

```typescript
    comboId: input.comboId,
```

Run:

```powershell
npx vitest run tests/domain/validation.test.ts tests/domain/runService.test.ts --maxWorkers=1 --minWorkers=1
```

Expected: PASS; the combo ID survives validation and safe persistence without introducing credentials into `filterJson`.

- [ ] **Step 5: Add the source-aware POST endpoint**

Add the imports to `src/routes/api.ts`:

```typescript
import { ComboStat, pickNextCombo, ShuffleRequest } from '../domain/shuffleCombos';
```

Mount this after `/suggestions` and below the blanket auth guard:

```typescript
  router.post(
    '/shuffle/next',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Partial<ShuffleRequest>;
      if (body.source !== 'google_maps' && body.source !== 'sales_navigator') {
        res.status(400).json({ error: 'Choose Google Maps or Sales Navigator.' });
        return;
      }
      if (!prisma?.run) {
        res.status(503).json({ error: 'Database unavailable' });
        return;
      }

      const user = currentUser(res);
      const runs = await prisma.run.findMany({
        where: user ? { userId: user.id } : {},
        select: { filterJson: true, leadCount: true },
      });
      const stats: Record<string, ComboStat> = {};
      for (const run of runs) {
        try {
          const parsed = JSON.parse(run.filterJson ?? '{}') as { comboId?: string };
          if (!parsed.comboId) continue;
          const stat = (stats[parsed.comboId] = stats[parsed.comboId] ?? { runs: 0, leads: 0 });
          stat.runs += 1;
          stat.leads += run.leadCount ?? 0;
        } catch {
          // Invalid historical JSON cannot block a new Shuffle choice.
        }
      }

      res.json({
        data: pickNextCombo(
          {
            source: body.source,
            recentComboIds: Array.isArray(body.recentComboIds) ? body.recentComboIds : undefined,
            recentCities: Array.isArray(body.recentCities) ? body.recentCities : undefined,
            currentComboId: typeof body.currentComboId === 'string' ? body.currentComboId : undefined,
          },
          stats,
        ),
      });
    }),
  );
```

This endpoint returns filters only. Do not call `runService.startRun`.

- [ ] **Step 6: Add a failing static placement test for the Google Maps form**

Append this test to `tests/public/staticUi.test.ts`:

```typescript
  it('keeps Nova Arrange in standard Google Maps scraping and out of Targeted Scraping', () => {
    const html = readPublicFile('index.html');
    const appJs = readPublicFile('app.js');
    const googleStart = html.indexOf('<section id="googleMapsFields"');
    const googleEnd = html.indexOf('<section id="salesNavigatorFields"');
    const targetedStart = html.indexOf('<div id="targetedTab"');

    expect(googleStart).toBeGreaterThan(-1);
    expect(googleEnd).toBeGreaterThan(googleStart);
    expect(targetedStart).toBeGreaterThan(googleEnd);
    expect(html.slice(googleStart, googleEnd)).toContain('id="shuffleFiltersBtn"');
    expect(html.slice(targetedStart)).not.toContain('id="shuffleFiltersBtn"');
    expect(appJs).toContain("source: 'google_maps'");
    expect(appJs).toContain('chips.gmSearchTerms.setValues(pick.filters.searchTerms)');
    expect(appJs).not.toContain('targetedShuffle');
  });
```

Run:

```powershell
npx vitest run tests/public/staticUi.test.ts --maxWorkers=1 --minWorkers=1
```

Expected: FAIL because `shuffleFiltersBtn` is absent from the Google Maps section.

- [ ] **Step 7: Restore the Arrange control inside Google Maps only**

Inside `<section id="googleMapsFields" ...>` in `public/index.html`, before the output-mode field, add:

```html
            <div class="inline-actions" style="margin-bottom: 0.75rem;">
              <button id="shuffleFiltersBtn" type="button" class="primary-btn">✨ Nova, arrange my filters</button>
              <span id="shuffleStatus" class="settings-hint"></span>
            </div>
```

Do not add this control, a clone, or a targeted-prefixed equivalent anywhere under `#targetedTab`.

Add this method beside `getSuggestions` in `public/api.js`:

```javascript
    shuffleNext: (body) =>
      requestJson('/shuffle/next', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
```

- [ ] **Step 8: Wire Arrange to Google Maps chips and standard-run history only**

Near the top of `public/app.js`, add:

```javascript
  let lastShuffleComboId;
```

Add `comboId: lastShuffleComboId` to the top-level object returned by `buildBody()` so the learning history is recorded only when the operator later starts the normal run.

Add these functions before `init()`:

```javascript
  function loadGoogleShuffleHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem('leadsgenx:nova-shuffle:google_maps') || '{}');
      return {
        comboIds: Array.isArray(parsed.comboIds) ? parsed.comboIds.filter((value) => typeof value === 'string') : [],
        cities: Array.isArray(parsed.cities) ? parsed.cities.filter((value) => typeof value === 'string') : [],
        currentComboId: typeof parsed.currentComboId === 'string' ? parsed.currentComboId : undefined,
      };
    } catch {
      return { comboIds: [], cities: [], currentComboId: undefined };
    }
  }

  async function shuffleGoogleMapsFilters() {
    const history = loadGoogleShuffleHistory();
    $('shuffleFiltersBtn').disabled = true;
    $('shuffleStatus').textContent = 'Nova is arranging…';
    try {
      const pick = await api.shuffleNext({
        source: 'google_maps',
        recentComboIds: history.comboIds,
        recentCities: history.cities,
        currentComboId: history.currentComboId,
      });
      const combo = pick.combo;
      if (!combo || !pick.updatedHistory || !pick.filters) {
        throw new Error('Nova returned an incomplete filter set.');
      }
      chips.gmSearchTerms.setValues(pick.filters.searchTerms);
      chips.gmCategories.setValues(pick.filters.categoryFilters);
      chips.gmCompanyTypes.setValues(pick.filters.companyTypes);
      chips.gmLocations.setValues(pick.filters.locations);
      lastShuffleComboId = combo.id;
      localStorage.setItem('leadsgenx:nova-shuffle:google_maps', JSON.stringify(pick.updatedHistory));
      $('shuffleStatus').textContent = combo.label + ' · ' + (pick.freshTerritory ? 'fresh slice' : 'learned performer');
      window.LeadsGenXUi.toast('Nova arranged: ' + combo.label + '. ' + pick.note + ' ' + combo.rationale);
    } catch (error) {
      $('shuffleStatus').textContent = '';
      window.LeadsGenXUi.toast(error.message);
    } finally {
      $('shuffleFiltersBtn').disabled = false;
    }
  }
```

In `init()`, after Google Maps chip creation and before the first awaited data load, register:

```javascript
  $('shuffleFiltersBtn').addEventListener('click', shuffleGoogleMapsFilters);
```

Do not read or write any `targeted*` input from this function and do not call a `/targeted/...` endpoint.

- [ ] **Step 9: Run the Shuffle contracts, placement test, and a run-start guard regression**

```powershell
npx vitest run tests/domain/shuffleCombos.test.ts tests/domain/validation.test.ts tests/domain/runService.test.ts tests/api/shuffleApi.test.ts tests/public/staticUi.test.ts tests/api/api.test.ts --maxWorkers=1 --minWorkers=1
```

Expected: all selected files pass; the button occurs only inside the standard Google Maps source section; invalid sources return 400; stale history is ignored; no Shuffle request starts a run.

- [ ] **Step 10: Commit the Shuffle repair**

```powershell
git add src/routes/api.ts src/domain/suggestions.ts src/domain/types.ts src/domain/validation.ts src/domain/runService.ts public/index.html public/api.js public/app.js tests/domain/validation.test.ts tests/domain/runService.test.ts tests/public/staticUi.test.ts
git commit -m "fix: restore nova shuffle contracts"
```

---

### Task 5: Close the legacy dashboard Valid-email wording gap

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Test: `tests/public/staticUi.test.ts`

**Interfaces:**
- Consumes: the approved internal compatibility value `qualityTier: 'strict'`.
- Produces: both the standalone Targeted workspace and the legacy embedded dashboard display that tier as “Valid,” defined as qualifying public personal or business email addresses.

- [ ] **Step 1: Add a failing regression for the duplicate dashboard surface**

Inside `tests/public/staticUi.test.ts`, add:

```typescript
  it('uses Valid-email wording on the embedded targeted dashboard', () => {
    const html = readPublicFile('index.html');
    const appJs = readPublicFile('app.js');

    expect(html).toContain('Public contacts only. Valid means publicly published, target-aligned personal or business addresses');
    expect(html).toContain('Export Valid emails');
    expect(html).toContain('<option value="strict" selected>Valid only</option>');
    expect(html).not.toContain('Strict means');
    expect(html).not.toContain('Export Strict');
    expect(html).not.toContain('out of Strict');
    expect(appJs).toContain("['Valid', funnel.strict]");
    expect(appJs).toContain("tier === 'strict' ? 'Valid' : tier");
    expect(appJs).not.toContain("['Strict Export', funnel.strict]");
  });
```

Run:

```powershell
npx vitest run tests/public/staticUi.test.ts --maxWorkers=1 --minWorkers=1
```

Expected: FAIL on the old embedded `Strict` labels.

- [ ] **Step 2: Replace only user-facing legacy labels while keeping internal values stable**

In `public/index.html`, make these exact copy changes:

```html
Public contacts only. Valid means publicly published, target-aligned personal or business addresses with a valid domain/MX; it does not mean mailbox verified or guarantee inbox delivery.
```

```html
<button id="targetedExportBtn" type="button" class="ghost-btn" disabled>Export Valid emails</button>
```

```html
<li>Catch-all, unknown, timeout, and unverified outcomes stay out of Valid.</li>
```

```html
<option value="strict" selected>Valid only</option>
```

The option value remains `strict` for API/storage compatibility.

In `public/app.js`, change the funnel label to:

```javascript
['Discovered', funnel.discovered], ['Aligned', funnel.aligned], ['Valid', funnel.strict],
```

Add this helper beside the targeted rendering functions:

```javascript
  function displayTargetedTier(tier) {
    return tier === 'strict' ? 'Valid' : tier;
  }
```

Use it only for visible candidate text:

```javascript
escapeHtml(displayTargetedTier(candidate.qualityTier))
```

Keep `data-tier`, request query values, `funnel.strict`, and existing API method names unchanged.

- [ ] **Step 3: Run both targeted UI and targeted domain regressions**

```powershell
npx vitest run tests/public/staticUi.test.ts tests/domain/targeted tests/api/targetedApi.test.ts --maxWorkers=1 --minWorkers=1
node --check public/app.js
node --check public/targeted.js
```

Expected: all tests and syntax checks pass; the internal `strict` contract remains compatible while every visible label says Valid.

- [ ] **Step 4: Commit the wording closure**

```powershell
git add public/index.html public/app.js tests/public/staticUi.test.ts
git commit -m "fix: close valid email wording gaps"
```

---

### Task 6: Run the fresh-database regression gate and record the repair

**Files:**
- Modify: `docs/AGENT_LOG.md`
- Verify: `prisma/schema.prisma`
- Verify: `src/app.ts`
- Verify: `src/routes/api.ts`
- Verify: `src/domain/suggestions.ts`
- Verify: targeted Valid-email files changed by commit `058acfb`

**Interfaces:**
- Consumes: all repaired contracts from Tasks 1–4.
- Produces: evidence that a freshly generated client, fresh SQLite schema, complete test suite, TypeScript build, and browser JavaScript syntax checks agree.

- [ ] **Step 1: Validate formatting and regenerate from the authoritative schema**

```powershell
npx prisma format
node scripts/ensure-prisma-client.cjs
git diff --check
```

Expected: all commands exit 0 and Prisma reports successful client generation or an up-to-date fingerprint.

- [ ] **Step 2: Run the repository's full fresh-database test ritual**

Use a new explicit database file under the repository's writable `.tmp` directory, synchronize it without generating, then execute the serialized suite:

```powershell
New-Item -ItemType Directory -Force .tmp | Out-Null
$repairDbName = "feature-contract-repair-$([guid]::NewGuid().ToString('N')).db"
$repairDbPath = (Join-Path (Resolve-Path .tmp).Path $repairDbName).Replace('\', '/')
$env:DATABASE_URL = "file:$repairDbPath"
npx prisma db push --skip-generate
npm test
```

Expected: database push succeeds and the entire Vitest suite passes with zero failed files/tests.

- [ ] **Step 3: Run the targeted Valid-email regression slice explicitly**

```powershell
npx vitest run tests/domain/targeted tests/api/targetedApi.test.ts --maxWorkers=1 --minWorkers=1
```

Expected: PASS; personal and business qualifying public emails remain represented as Valid in the targeted tier/UI/export contracts.

- [ ] **Step 4: Run the plain production build and frontend syntax checks**

```powershell
npm run build
node --check public/app.js
node --check public/targeted.js
```

Expected: TypeScript compilation and both JavaScript syntax checks exit 0.

- [ ] **Step 5: Review scope and retained contracts**

```powershell
git status --short
git diff --stat e561779..HEAD
git diff --check e561779..HEAD
rg -n "Strict means|Export Strict|Strict only|Strict Export|out of Strict" public
rg -n "extensionToken|HiringSignalScan|GreenhouseBoard|HiringOpportunity|shuffle/next|hiringSignalService" prisma scripts src tests
```

Expected: no accidental generated database/build artifacts are staged; the user-facing Strict phrase search returns no matches; retained feature contracts are present. Internal compatibility identifiers such as `strict` remain where already approved.

- [ ] **Step 6: Append the repository log entry**

Append a dated entry to `docs/AGENT_LOG.md` recording:

```markdown
## 2026-08-14 — Retained feature contract repair

- Restored Prisma contracts and automatic generated-client freshness checks for extension tokens and Greenhouse hiring signals.
- Restored extension, hiring lifecycle/API, and source-aware Nova Shuffle wiring; Nova Arrange is visible only in the standard Google Maps form, never Targeted Scraping.
- Reconciled the Shuffle deck with the public suggestion catalog.
- Closed duplicate dashboard wording so qualifying public personal and business email addresses are consistently shown as Valid.
- Verification: fresh `prisma db push`, full serialized `npm test`, targeted Valid-email regression suite, `npm run build`, frontend `node --check`, and `git diff --check` all passed.
```

- [ ] **Step 7: Commit the verification record**

```powershell
git add docs/AGENT_LOG.md
git commit -m "docs: record feature contract repair verification"
```

- [ ] **Step 8: Confirm the branch is ready but do not push**

```powershell
git status --short
git log --oneline -7
```

Expected: clean worktree and the repair commits are visible locally. Stop before `git push` and report the exact test/build results to the user.
