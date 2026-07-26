# Greenhouse Hiring Signals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable, public Greenhouse hiring-signal lane that annotates existing companies, surfaces a bounded opportunity watchlist, and keeps Google Maps, Sales Navigator, and Hiring opportunities strictly separate.

**Architecture:** A focused Greenhouse HTTP adapter normalizes public boards; pure domain functions classify and score jobs; a Prisma-backed coordinator owns scan lifecycle, caching, matching, and recovery. Run completion only schedules this supplemental coordinator, while the API and vanilla-JS frontend expose source-separated lead views, evidence-backed opportunity cards, and safe search-prefill actions.

**Tech Stack:** Node.js, TypeScript strict mode, Express 5, Prisma/SQLite, Vitest, Supertest, vanilla JavaScript/CSS, Greenhouse public Job Board API.

## Global Constraints

- Automatic scans run only for `completed` or `partially_completed` runs with at least one company candidate.
- A hiring scan never delays, reopens, or changes the parent run's status or lead counts.
- `leadSource` is immutable; Google Maps, Sales Navigator, and Hiring opportunities are separate API/UI lanes.
- Greenhouse GET requests time out after 10 seconds; website requests time out after 8 seconds.
- Concurrency is three, website discovery is at most two pages per company, and each scan evaluates at most 25 boards.
- At most two hiring scans execute across the whole application at once.
- Successful board responses are cached for six hours; transient failures receive at most two attempts.
- Manual refresh bypasses the six-hour cache and fetches fresh board data.
- Existing companies highlight at score 70; adjacent companies require score 80 and are limited to five.
- Only qualifying jobs updated within 30 days affect the score.
- Nova says "updated recently," gives evidence, emits at most two analyst lines, and never claims `updated_at` is a first-published date.
- No paid search starts automatically. Preparing a Google Maps or Sales Navigator search only fills the form.
- Every new network request has an `AbortSignal.timeout`; no secret, raw HTML, or unbounded job description is persisted.
- Website discovery is HTTPS-only and SSRF-safe: DNS-resolved private/link-local
  addresses are blocked, redirects are revalidated and capped at three,
  responses must be HTML, bodies are capped near 1 MiB, and requests identify
  `Leads-GenX-Hiring-Signals/1.0`.

---

## File Structure

**Create**

- `src/integrations/greenhouseClient.ts` — public board URL extraction, bounded HTTP client, and job normalization.
- `src/integrations/safeWebsiteFetcher.ts` — SSRF-safe, size-bounded careers-page retrieval.
- `src/domain/greenhouseSignals.ts` — job classification, company identity, relevance scoring, and Nova explanation.
- `src/domain/greenhouseStarterBoards.ts` — small versioned public-board seed registry.
- `src/domain/hiringSignalService.ts` — Prisma persistence, scan queue, matching, caching, recovery, and refresh.
- `src/routes/hiringSignals.ts` — ownership-safe hiring-signal endpoints.
- `tests/integrations/greenhouseClient.test.ts`
- `tests/integrations/safeWebsiteFetcher.test.ts`
- `tests/domain/greenhouseSignals.test.ts`
- `tests/domain/hiringSignalService.test.ts`
- `tests/api/hiringSignalsApi.test.ts`

**Modify**

- `prisma/schema.prisma` — add `HiringSignalScan`, `GreenhouseBoard`, and `HiringOpportunity`.
- `src/app.ts` — create/inject the hiring service and recover scans on startup.
- `src/domain/runService.ts` — invoke an injected completion callback after background and resumed executions settle.
- `src/routes/api.ts` — mount hiring routes, filter leads by source, attach signal summaries, and enrich Nova input.
- `src/routes/extension.ts` — schedule an eligible scan after extension completion.
- `src/domain/runAnalyst.ts` — accept and narrate at most two hiring summaries without changing health verdict.
- `public/api.js` — add hiring and source-filter API methods.
- `public/index.html` — add source-separated lead controls and Hiring opportunities tab.
- `public/app.js` — load/render/refresh opportunities and prefill the chosen run form.
- `public/ui.js` — render hiring badges and opportunity evidence safely.
- `public/styles.css` — warm, low-saturation opportunity cards and lane controls.
- `tests/domain/runService.test.ts`
- `tests/domain/runAnalyst.test.ts`
- `tests/api/extensionApi.test.ts`
- `tests/public/staticUi.test.ts`
- `AGENTS.md`, `SPEC.md`, `docs/AGENT_LOG.md` — shared contracts, suite count, and Kimi handoff.

---

### Task 1: Persistence and Core Record Contracts

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `tests/domain/hiringSignalService.test.ts`

**Interfaces:**
- Produces Prisma models `HiringSignalScan`, `GreenhouseBoard`, and `HiringOpportunity`.
- `HiringOpportunity.originLane` is exactly `google_maps`, `sales_navigator`, or `hiring_opportunity`.
- `HiringOpportunity.companyKey` is a normalized non-secret identity used for dedupe.

- [ ] **Step 1: Write the failing persistence test**

```ts
it('stores hiring observations without creating leads or changing run counts', async () => {
  const run = await prisma.run.create({
    data: { status: 'completed', leadSource: 'google_maps', actorId: 'test', maxResults: 10, leadCount: 2 },
  });
  const scan = await prisma.hiringSignalScan.create({ data: { runId: run.id, status: 'queued' } });
  await prisma.hiringOpportunity.create({
    data: {
      scanId: scan.id,
      runId: run.id,
      companyKey: 'domain:acme.test',
      companyName: 'Acme',
      companyDomain: 'acme.test',
      originLane: 'google_maps',
      score: 82,
      scoreJson: '{"roles":35,"recency":25,"geography":15,"industry":5,"breadth":2}',
      jobsJson: '[]',
      evidenceUrl: 'https://boards.greenhouse.io/acme',
      evidenceFingerprint: 'acme-v1',
      relationship: 'exact',
    },
  });
  expect(await prisma.lead.count({ where: { runId: run.id } })).toBe(0);
  expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).leadCount).toBe(2);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- --run tests/domain/hiringSignalService.test.ts`  
Expected: FAIL because the generated Prisma client has no hiring-signal models.

- [ ] **Step 3: Add the minimal Prisma models**

```prisma
model HiringSignalScan {
  id               Int       @id @default(autoincrement())
  runId            Int
  status           String    @default("queued")
  candidateCount   Int       @default(0)
  inspectedCount   Int       @default(0)
  matchedCount     Int       @default(0)
  opportunityCount Int       @default(0)
  heartbeatAt      DateTime?
  startedAt        DateTime?
  completedAt      DateTime?
  errorMessage     String?
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt
  run              Run       @relation(fields: [runId], references: [id], onDelete: Cascade)
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
  id                  Int      @id @default(autoincrement())
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
  saved               Boolean  @default(false)
  dismissed           Boolean  @default(false)
  observedAt          DateTime @default(now())
  scan                HiringSignalScan @relation(fields: [scanId], references: [id], onDelete: Cascade)
  run                 Run      @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@unique([scanId, companyKey])
  @@index([runId, originLane, score])
}
```

Add `hiringSignalScans HiringSignalScan[]` and `hiringOpportunities HiringOpportunity[]` to `Run`.

- [ ] **Step 4: Generate the client, push an isolated DB, and verify GREEN**

Run: `npx prisma generate && npx prisma db push --skip-generate && npm test -- --run tests/domain/hiringSignalService.test.ts`  
Expected: PASS.

---

### Task 2: Greenhouse URL Extraction and Bounded Public Client

**Files:**
- Create: `src/integrations/greenhouseClient.ts`
- Create: `src/integrations/safeWebsiteFetcher.ts`
- Create: `src/domain/greenhouseStarterBoards.ts`
- Create: `tests/integrations/greenhouseClient.test.ts`
- Create: `tests/integrations/safeWebsiteFetcher.test.ts`

**Interfaces:**
- Produces `extractGreenhouseBoardTokens(htmlOrUrl: string): string[]`.
- Produces `GreenhouseClient.listJobs(boardToken: string): Promise<GreenhouseJob[]>`.
- Produces `safeFetchWebsite(url: string): Promise<{ finalUrl: string; html: string }>`.
- `GreenhouseJob` includes `id`, `title`, `location`, `departments`, `updatedAt`, and `absoluteUrl`.

- [ ] **Step 1: Write failing extraction and timeout tests**

```ts
it('extracts and deduplicates explicit Greenhouse board tokens', () => {
  expect(extractGreenhouseBoardTokens(`
    <a href="https://boards.greenhouse.io/acme/jobs/1">Jobs</a>
    <script src="https://boards-api.greenhouse.io/v1/boards/acme/jobs"></script>
  `)).toEqual(['acme']);
});

it('adds a hard timeout to the public jobs request', async () => {
  const requests: RequestInit[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    requests.push(init ?? {});
    return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
  }));
  await new GreenhouseClient().listJobs('acme');
  expect(requests[0].signal).toBeInstanceOf(AbortSignal);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- --run tests/integrations/greenhouseClient.test.ts`  
Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement strict token extraction and normalized jobs**

```ts
export interface GreenhouseJob {
  id: number;
  title: string;
  location: string;
  departments: string[];
  updatedAt: string;
  absoluteUrl: string;
}

const BOARD_PATTERNS = [
  /boards\.greenhouse\.io\/([a-z0-9_-]+)/gi,
  /job-boards\.greenhouse\.io\/([a-z0-9_-]+)/gi,
  /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/gi,
];

export function extractGreenhouseBoardTokens(value: string): string[] {
  const found = new Set<string>();
  for (const pattern of BOARD_PATTERNS) {
    for (const match of value.matchAll(pattern)) found.add(match[1].toLowerCase());
  }
  return [...found];
}
```

`listJobs` must encode the token, use `AbortSignal.timeout(10_000)`, retry only a transient error once, throw a typed `GreenhouseError` for non-OK responses, and truncate normalized text fields.

- [ ] **Step 4: Add the verified starter registry**

```ts
export interface StarterGreenhouseBoard {
  boardToken: string;
  companyName: string;
  companyDomain: string;
  industry: string;
  geographies: string[];
}

export const STARTER_GREENHOUSE_BOARDS: StarterGreenhouseBoard[] = [
  { boardToken: 'stripe', companyName: 'Stripe', companyDomain: 'stripe.com', industry: 'Financial Services', geographies: ['United States', 'Remote'] },
  { boardToken: 'figma', companyName: 'Figma', companyDomain: 'figma.com', industry: 'Software', geographies: ['United States', 'Remote'] },
  { boardToken: 'datadog', companyName: 'Datadog', companyDomain: 'datadoghq.com', industry: 'Software', geographies: ['United States', 'Remote'] },
  { boardToken: 'cloudflare', companyName: 'Cloudflare', companyDomain: 'cloudflare.com', industry: 'Technology', geographies: ['United States', 'Remote'] },
  { boardToken: 'plaid', companyName: 'Plaid', companyDomain: 'plaid.com', industry: 'Financial Services', geographies: ['United States', 'Remote'] },
];
```

Every seed is revalidated through the public API before it can surface.

- [ ] **Step 5: Write failing SSRF and response-bound tests**

```ts
it.each([
  'http://example.com/careers',
  'https://127.0.0.1/careers',
  'https://169.254.169.254/latest/meta-data',
])('rejects unsafe website URL %s', async (url) => {
  await expect(safeFetchWebsite(url)).rejects.toMatchObject({ code: 'unsafe_website_url' });
});

it('rejects non-HTML and responses larger than 1 MiB', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('x', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })));
  await expect(safeFetchWebsite('https://example.com/careers')).rejects.toMatchObject({
    code: 'unsupported_content_type',
  });
});
```

- [ ] **Step 6: Implement the guarded website fetcher**

Resolve every hostname with `dns.promises.lookup({ all: true })`; reject
loopback, RFC1918, carrier-grade NAT, link-local, multicast, unspecified, and
IPv6 local/private ranges. Use `redirect: 'manual'`, re-run URL and DNS checks
for every redirect, stop after three redirects, send
`User-Agent: Leads-GenX-Hiring-Signals/1.0`, require
`content-type: text/html`, stop reading after 1,048,576 bytes, and apply
`AbortSignal.timeout(8_000)` to each fetch.

- [ ] **Step 7: Verify GREEN**

Run: `npm test -- --run tests/integrations/greenhouseClient.test.ts tests/integrations/safeWebsiteFetcher.test.ts`  
Expected: PASS.

---

### Task 3: Pure Classification, Matching, and Transparent Scoring

**Files:**
- Create: `src/domain/greenhouseSignals.ts`
- Create: `tests/domain/greenhouseSignals.test.ts`

**Interfaces:**
- Produces `classifyHiringJob(job): HiringRoleGroup | undefined`.
- Produces `scoreHiringSignal(input): HiringSignalScore`.
- Produces `companyKey({ companyName, website }): string`.
- Produces `buildHiringExplanation(input): string`.

- [ ] **Step 1: Write failing score and cutoff tests**

```ts
it('scores a fresh exact-match multi-department signal transparently', () => {
  const result = scoreHiringSignal({
    jobs: [
      job('VP of Operations', '2026-07-24T00:00:00Z', 'Dallas, TX', 'Operations'),
      job('Regional Sales Director', '2026-07-22T00:00:00Z', 'Dallas, TX', 'Sales'),
    ],
    requestedGeographies: ['Dallas, TX'],
    industryRelationship: 'exact',
    now: new Date('2026-07-25T00:00:00Z'),
  });
  expect(result.total).toBeGreaterThanOrEqual(70);
  expect(result.components).toEqual(expect.objectContaining({
    roles: expect.any(Number),
    recency: expect.any(Number),
    geography: 20,
    industry: 15,
    breadth: 5,
  }));
});

it('ignores jobs older than 30 days', () => {
  const result = scoreHiringSignal({
    jobs: [job('Chief Revenue Officer', '2026-06-01T00:00:00Z', 'Dallas, TX', 'Sales')],
    requestedGeographies: ['Dallas, TX'],
    industryRelationship: 'exact',
    now: new Date('2026-07-25T00:00:00Z'),
  });
  expect(result.qualifyingJobs).toEqual([]);
  expect(result.total).toBe(0);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- --run tests/domain/greenhouseSignals.test.ts`  
Expected: FAIL because the scorer does not exist.

- [ ] **Step 3: Implement minimal pure domain logic**

```ts
export type HiringRoleGroup = 'sales' | 'operations' | 'finance' | 'marketing' | 'leadership';
export interface HiringSignalScore {
  total: number;
  components: { roles: number; recency: number; geography: number; industry: number; breadth: number };
  qualifyingJobs: ScoredHiringJob[];
}

const ROLE_PATTERNS: Array<[HiringRoleGroup, RegExp]> = [
  ['leadership', /\b(chief|president|vice president|vp|head of|general manager)\b/i],
  ['sales', /\b(sales|revenue|account executive|business development)\b/i],
  ['operations', /\b(operations|supply chain|logistics|procurement)\b/i],
  ['finance', /\b(finance|financial|accounting|controller|treasury)\b/i],
  ['marketing', /\b(marketing|growth|demand generation|brand)\b/i],
];
```

Use normalized exact-domain matching before normalized-name matching. Ambiguous
name-only matches return `hiring_opportunity`. Cap components at 35/25/20/15/5
and the total at 100. The explanation must mention roles, location relationship,
and Greenhouse update age.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- --run tests/domain/greenhouseSignals.test.ts`  
Expected: PASS.

---

### Task 4: Durable Hiring Scan Coordinator

**Files:**
- Create: `src/domain/hiringSignalService.ts`
- Modify: `tests/domain/hiringSignalService.test.ts`

**Interfaces:**
- Produces `createHiringSignalService({ prisma, greenhouseClient, fetchPage, now })`.
- Service methods: `scheduleIfEligible(runId)`, `refresh(runId)`, `recoverInterruptedScans()`, `getRunSignals(runId)`, `updateOpportunity(id, patch)`, and `prepareSearch(id, targetLane)`.

- [ ] **Step 1: Write failing eligibility, isolation, and partial-result tests**

```ts
it.each(['failed', 'cancelled', 'paused', 'waiting_for_credentials'])(
  'does not schedule a %s run',
  async (status) => {
    const run = await createRun({ status, leadSource: 'google_maps' });
    expect(await service.scheduleIfEligible(run.id)).toEqual({ scheduled: false, reason: 'ineligible_status' });
  }
);

it('keeps source matches separate and caps adjacent opportunities at five', async () => {
  const run = await createRunWithGoogleBusinessAndSalesLead();
  await service.refresh(run.id);
  await vi.waitFor(async () => {
    const scan = await prisma.hiringSignalScan.findFirst({ where: { runId: run.id }, orderBy: { id: 'desc' } });
    expect(scan?.status).toMatch(/completed|partially_completed/);
  });
  const result = await service.getRunSignals(run.id);
  expect(result.matches.google_maps.every((item) => item.originLane === 'google_maps')).toBe(true);
  expect(result.matches.sales_navigator.every((item) => item.originLane === 'sales_navigator')).toBe(true);
  expect(result.opportunities).toHaveLength(5);
  expect(result.opportunities.every((item) => item.originLane === 'hiring_opportunity')).toBe(true);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- --run tests/domain/hiringSignalService.test.ts`  
Expected: FAIL because the coordinator does not exist.

- [ ] **Step 3: Implement the queue and bounded scan**

```ts
export interface HiringSignalService {
  scheduleIfEligible(runId: number): Promise<{ scheduled: boolean; scanId?: number; reason?: string }>;
  refresh(runId: number): Promise<{ scheduled: boolean; scanId: number }>;
  recoverInterruptedScans(): Promise<void>;
  getRunSignals(runId: number): Promise<RunHiringSignals>;
  updateOpportunity(id: number, patch: { saved?: boolean; dismissed?: boolean }): Promise<SafeHiringOpportunity>;
  prepareSearch(id: number, targetLane: 'google_maps' | 'sales_navigator'): Promise<PreparedHiringSearch>;
}
```

Implement:

- one active `queued`/`running` scan per run;
- one application-level two-worker scan queue shared by all runs;
- a three-worker bounded pool;
- 15-second scan heartbeats;
- cache reuse while `fetchedAt >= now - 6h`;
- `refresh(runId)` marks the scan as manual and bypasses every cached board
  response, while automatic scans may reuse fresh cache entries;
- transient board errors as partial results;
- domain-first/name-second matching;
- score-70 existing annotations;
- score-80 adjacent selection with `slice(0, 5)`;
- evidence fingerprint dedupe and saved/dismissed carry-forward;
- terminal scan status in `finally`;
- no writes to `Run.status`, `Run.leadCount`, or `Lead`.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- --run tests/domain/hiringSignalService.test.ts`  
Expected: PASS.

---

### Task 5: Automatic Scheduling, Extension Completion, and Recovery

**Files:**
- Modify: `src/domain/runService.ts`
- Modify: `src/app.ts`
- Modify: `src/routes/api.ts`
- Modify: `src/routes/extension.ts`
- Modify: `tests/domain/runService.test.ts`
- Modify: `tests/api/extensionApi.test.ts`

**Interfaces:**
- `RunServiceDeps.onRunSettled?: (runId: number) => Promise<void>`.
- `ApiDeps.hiringSignalService?: HiringSignalService`.
- Extension deps accept `onRunSettled?: (runId: number) => Promise<void>`.

- [ ] **Step 1: Write failing callback tests**

```ts
it('notifies the supplemental coordinator after a background run settles', async () => {
  const settled: number[] = [];
  const service = createRunService({ ...deps, onRunSettled: async (runId) => { settled.push(runId); } });
  const run = await service.startRun(validInput, { background: false });
  expect(settled).toEqual([run.id]);
});

it('schedules hiring signals after an extension run is finished', async () => {
  await request(app).post('/api/extension/finish').set(auth).send({ sessionId: 's1' }).expect(200);
  expect(onRunSettled).toHaveBeenCalledWith(expect.any(Number));
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- --run tests/domain/runService.test.ts tests/api/extensionApi.test.ts`  
Expected: FAIL because no completion callback is wired.

- [ ] **Step 3: Add one safe execution wrapper**

```ts
async function executeAndNotify(run: RunRecord, input: ValidatedRunInput): Promise<void> {
  try {
    await executeRun(run, input);
  } finally {
    await onRunSettled?.(run.id).catch(() => {});
  }
}
```

Use this single wrapper for foreground/background starts, resumes, and
interrupted-run recovery; do not add per-provider or per-lane scheduling hooks.
After extension finish persists `completed`, invoke the same callback without
awaiting the scan itself because extension completion is outside `runService`.

In `createApp`, construct one hiring service, inject `scheduleIfEligible`, mount
its routes, and call both run recovery and hiring-scan recovery from the existing
startup `setImmediate`.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- --run tests/domain/runService.test.ts tests/api/extensionApi.test.ts tests/api/api.test.ts`  
Expected: PASS.

---

### Task 6: Ownership-Safe API and Nova Analyst Attention

**Files:**
- Create: `src/routes/hiringSignals.ts`
- Create: `tests/api/hiringSignalsApi.test.ts`
- Modify: `src/routes/api.ts`
- Modify: `src/domain/runAnalyst.ts`
- Modify: `tests/domain/runAnalyst.test.ts`

**Interfaces:**
- Routes match the approved design.
- `AnalystInput.hiringSignals?: AnalystHiringSignal[]`.

- [ ] **Step 1: Write failing route and analyst tests**

```ts
it('does not expose another user’s hiring signals', async () => {
  await request(app).get(`/api/runs/${otherRun.id}/hiring-signals`).set('Cookie', userCookie).expect(404);
});

it('adds no more than two hiring lines without changing a healthy verdict', () => {
  const report = analyzeRun({
    run: completedRun,
    events: [],
    providerStates: [],
    errorLogs: [],
    hiringSignals: [signal(91, 'Acme'), signal(88, 'Beta'), signal(85, 'Gamma')],
  });
  expect(report.verdict).toBe('perfect');
  expect(report.lines.filter((line) => line.text.includes('hiring')).length).toBeLessThanOrEqual(2);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- --run tests/api/hiringSignalsApi.test.ts tests/domain/runAnalyst.test.ts`  
Expected: FAIL because the routes and analyst input do not exist.

- [ ] **Step 3: Implement the router and analyst projection**

```ts
router.get('/runs/:id/hiring-signals', ownedRun, asyncHandler(async (req, res) => {
  res.json({ data: await service.getRunSignals(Number(req.params.id)) });
}));

router.post('/runs/:id/hiring-signals/refresh', ownedRun, asyncHandler(async (req, res) => {
  res.status(202).json({ data: await service.refresh(Number(req.params.id)) });
}));

router.post('/hiring-opportunities/:id/prepare-search', asyncHandler(async (req, res) => {
  const lane = req.body?.targetLane;
  if (lane !== 'google_maps' && lane !== 'sales_navigator') {
    res.status(400).json({ error: 'Choose Google Maps or Sales Navigator.' });
    return;
  }
  res.json({ data: await service.prepareSearch(Number(req.params.id), lane) });
}));
```

The opportunity endpoints must resolve the owning run before returning or
mutating data. The analyst route selects the two highest non-dismissed signals
and passes safe summaries into `analyzeRun`.

- [ ] **Step 4: Add source-filtered leads and annotations**

Accept `leadSource=google_maps|sales_navigator` on `GET /api/leads`. Reject other
values. Return a safe `hiringSignal` summary only for domain-confirmed or unique
name-confirmed matches; do not mutate the lead row.

- [ ] **Step 5: Verify GREEN**

Run: `npm test -- --run tests/api/hiringSignalsApi.test.ts tests/domain/runAnalyst.test.ts tests/api/authApi.test.ts`  
Expected: PASS.

---

### Task 7: Three Separate Frontend Lanes and Opportunity Actions

**Files:**
- Modify: `public/api.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/ui.js`
- Modify: `public/styles.css`
- Modify: `tests/public/staticUi.test.ts`

**Interfaces:**
- Lead lane state is `google_maps` or `sales_navigator`.
- Hiring view consumes `getHiringSignals(runId)`.
- Prepared search payload is `{ targetLane, companyName, website?, industries?, geographies? }`.

- [ ] **Step 1: Write failing static UI tests**

```ts
it('renders separate Google Maps, Sales Navigator, and Hiring opportunity controls', () => {
  const html = readPublicFile('index.html');
  expect(html).toContain('data-lead-lane="google_maps"');
  expect(html).toContain('data-lead-lane="sales_navigator"');
  expect(html).toContain('data-tab="hiring"');
});

it('never starts a run from a prepared hiring opportunity', () => {
  const app = readPublicFile('app.js');
  expect(app).toContain('prepareHiringSearch');
  expect(app).toContain('Review the prepared filters, then start when you’re ready');
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- --run tests/public/staticUi.test.ts`  
Expected: FAIL because the controls do not exist.

- [ ] **Step 3: Add API methods**

```js
listLeads: (runId, leadSource) => {
  const params = new URLSearchParams();
  if (runId) params.set('runId', runId);
  if (leadSource) params.set('leadSource', leadSource);
  return requestJson('/leads?' + params.toString());
},
getHiringSignals: (runId) => requestJson('/runs/' + runId + '/hiring-signals'),
refreshHiringSignals: (runId) => requestJson('/runs/' + runId + '/hiring-signals/refresh', { method: 'POST' }),
prepareHiringSearch: (id, targetLane) => requestJson('/hiring-opportunities/' + id + '/prepare-search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ targetLane }),
}),
updateHiringOpportunity: (id, body) => requestJson('/hiring-opportunities/' + id, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}),
```

- [ ] **Step 4: Add lane controls and opportunity cards**

Add two lead-lane buttons above the leads table and a separate Hiring
opportunities top-level tab. Render score, role titles, update dates, location,
relationship, explanation, and evidence links through `escapeHtml`.

`prepareHiringSearch` must:

```js
if (prepared.targetLane === 'google_maps') {
  setActiveSource('google_maps');
  chips.gmSearchTerms.setValues([prepared.companyName]);
  if (prepared.geographies?.length) chips.gmLocations.setValues(prepared.geographies.slice(0, 1));
} else {
  setActiveSource('sales_navigator');
  chips.snCompanies.setValues([prepared.companyName]);
  if (prepared.geographies?.length) chips.snGeographies.setValues(prepared.geographies.slice(0, 1));
}
window.scrollTo({ top: 0, behavior: 'smooth' });
window.LeadsGenXUi.toast('Review the prepared filters, then start when you’re ready.');
```

It must never call `api.createRun`.

- [ ] **Step 5: Verify GREEN and syntax**

Run: `npm test -- --run tests/public/staticUi.test.ts && node --check public/api.js && node --check public/app.js && node --check public/ui.js`  
Expected: PASS.

---

### Task 8: Shared Contracts, Full Verification, and Delivery

**Files:**
- Modify: `AGENTS.md`
- Modify: `SPEC.md`
- Modify: `docs/AGENT_LOG.md`

- [ ] **Step 1: Update shared documentation**

Add the Greenhouse lane to the architecture map, document the three-lane source
contract and supplemental-run rule in `SPEC.md`, update the exact suite count,
and add a Kimi entry describing models, APIs, UI controls, thresholds, and
follow-ups.

- [ ] **Step 2: Run full isolated verification**

```powershell
$verifyDb = Join-Path ([System.IO.Path]::GetTempPath()) ('leads-genx-greenhouse-' + [guid]::NewGuid().ToString('N') + '.db')
$env:DATABASE_URL = 'file:' + $verifyDb.Replace('\','/')
npx prisma db push --skip-generate
npm test
npm run build
node --check public/api.js
node --check public/app.js
node --check public/ui.js
npm audit --audit-level=high
git diff --check
```

Expected: all tests pass, TypeScript and JavaScript checks exit 0, npm reports no
high-severity vulnerabilities, and Git reports no whitespace errors.

- [ ] **Step 3: Commit, rebase, reverify if code changed, and push**

```bash
git add prisma/schema.prisma src public tests AGENTS.md SPEC.md docs
git commit -m "feat: add Greenhouse hiring-signal opportunities"
git pull --rebase origin main
git push origin HEAD:main
```

Expected: remote `main` points to the new commit and `git status --porcelain` is
empty.
