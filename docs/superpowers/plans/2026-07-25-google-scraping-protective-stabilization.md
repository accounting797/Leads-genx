# Google Scraping Protective Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strengthen Google Maps scraping lifecycle reliability and Nova supervision while preserving provider composition, budgets, queries, concurrency, and output semantics.

**Architecture:** Keep `executeBalancedGoogleMapsRun` as the canonical concurrent Docker/Google orchestrator and `RunIngestionCoordinator` as the shared persistence boundary. Consolidate local scraper polling inside `LocalMapsScraperKitClient`, then make the existing provider-settlement rules explicit at the orchestration boundary. Characterization tests lock protected behavior before each minimal implementation change.

**Tech Stack:** TypeScript 5, Node.js fetch/AbortSignal, Express service layer, Vitest, Prisma SQLite, vanilla browser UI.

## Global Constraints

- Standard Output remains concurrent Docker plus Google.
- Hybrid Max Output remains concurrent Docker plus Google plus Apify.
- Google traffic remains direct and every HTTP attempt counts against the configured hard budget.
- Default Google request budget remains 50 and the cap remains 500.
- Docker concurrency remains 4; browser pool, depth, radius, and scrape target remain unchanged.
- Role/function searches remain Google-only.
- Google Maps leads remain separate from Sales Navigator leads.
- Every network operation has a hard timeout and no retry loop is unbounded.
- Provider failure preserves all already-persisted businesses and contacts.
- No Google or Apify credits are consumed during verification.
- Before every commit, run the complete isolated-database suite and the plain TypeScript build.

---

## File Map

- `src/integrations/localMapsScraperClient.ts`: one shared, bounded local-job polling contract used by canonical and fallback paths.
- `tests/integrations/localMapsScraperClient.test.ts`: regression coverage for casing, transient failures, persistent HTTP failures, and finite polling.
- `src/domain/balancedGoogleMapsRunService.ts`: Google credential standby reporting and productive-local-result settlement.
- `tests/domain/balancedGoogleMapsRunService.test.ts`: provider settlement and preserved-output regression coverage.
- `README.md`: current operator-facing Standard/Hybrid/budget baseline.
- `docs/AGENT_LOG.md`: Kimi handoff, commit references, verification, and caveats.

### Task 1: Unify bounded local scraper polling

**Files:**
- Modify: `src/integrations/localMapsScraperClient.ts`
- Modify: `tests/integrations/localMapsScraperClient.test.ts`

**Interfaces:**
- Consumes: scraper job payloads shaped as `{ Status?: string; status?: string }`.
- Produces: private `pollJob(baseUrl: string, jobId: string): Promise<void>` on `LocalMapsScraperKitClient`; success resolves, failure throws `LocalScraperError`.
- Preserves: `searchBatch(...): Promise<LocalBatchResult>` and `search(...): Promise<unknown[]>`.

- [ ] **Step 1: Add a failing fallback lowercase-status test**

Add a test beside the existing fallback `search` tests. Return `{ status: 'ok' }` from `/api/v1/jobs/fallback-lowercase`, return a one-row CSV from its download endpoint, and assert that `search()` returns one item and emits `completed`.

```ts
it('accepts lowercase status payloads in the compatibility search path', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/v1/jobs') && !init?.method) return Response.json([]);
    if (url.endsWith('/api/v1/jobs') && init?.method === 'POST') {
      return Response.json({ id: 'fallback-lowercase' }, { status: 201 });
    }
    if (url.endsWith('/api/v1/jobs/fallback-lowercase')) return Response.json({ status: 'ok' });
    if (url.endsWith('/api/v1/jobs/fallback-lowercase/download')) {
      return new Response('title,website\n"Lowercase Co","https://lowercase.example.com"');
    }
    return new Response('not found', { status: 404 });
  }));

  const events: unknown[] = [];
  const items = await new LocalMapsScraperClient({ pollIntervalMs: 1 }).search({
    filters: { searchTerms: ['dentist'], locations: ['Austin, TX'] },
    maxResults: 10,
    onEvent: (event) => events.push(event),
  });

  expect(items).toHaveLength(1);
  expect(events).toContainEqual(expect.objectContaining({ type: 'completed', itemCount: 1 }));
});
```

- [ ] **Step 2: Run the new test and verify red**

Run:

```powershell
npm.cmd test -- --run tests/integrations/localMapsScraperClient.test.ts
```

Expected: FAIL because the fallback path reads only `Status`, reaches the polling limit, and returns no items.

- [ ] **Step 3: Add a failing persistent HTTP-status test**

Add a canonical-path test where job creation succeeds and each status poll returns HTTP 503. Assert exactly three status calls and an `unavailable` error.

```ts
it('declares the lane down after three unsuccessful HTTP status polls', async () => {
  let statusCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/v1/jobs') && init?.method === 'POST') {
      return Response.json({ id: 'http-down' }, { status: 201 });
    }
    if (url.endsWith('/api/v1/jobs/http-down')) {
      statusCalls += 1;
      return new Response('busy', { status: 503 });
    }
    return Response.json([]);
  }));

  const client = new LocalMapsScraperClient({ pollIntervalMs: 1 });
  await expect(client.searchBatch({
    batch: {
      key: 'http-down-key',
      query: 'dentist Austin, TX',
      location: 'Austin, TX',
      lat: '30.2672',
      lon: '-97.7431',
      depth: 10,
      maxResults: 10,
    },
  })).rejects.toMatchObject({ code: 'unavailable' });
  expect(statusCalls).toBe(3);
});
```

- [ ] **Step 4: Run the focused test and verify red**

Run:

```powershell
npm.cmd test -- --run tests/integrations/localMapsScraperClient.test.ts
```

Expected: the new HTTP 503 test FAILS because non-OK responses currently reset the strike counter and poll to the maximum.

- [ ] **Step 5: Implement one private polling method**

Inside `LocalMapsScraperKitClient`, add a private method and use it from both `searchBatch` and `search`:

```ts
private async pollJob(baseUrl: string, jobId: string): Promise<void> {
  const maxPolls = this.options.maxPolls ?? 120;
  let consecutivePollErrors = 0;

  for (let poll = 0; poll < maxPolls; poll += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/jobs/${jobId}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`status returned ${response.status}`);
      const payload = await response.json() as { Status?: string; status?: string };
      const status = (payload.Status ?? payload.status)?.toLowerCase();
      consecutivePollErrors = 0;
      if (status === 'ok') return;
      if (status === 'failed' || status === 'error') {
        throw new LocalScraperError('failed', 'Local scraper job failed');
      }
    } catch (error) {
      if (error instanceof LocalScraperError) throw error;
      consecutivePollErrors += 1;
      if (consecutivePollErrors >= 3) {
        throw new LocalScraperError('unavailable', 'Local scraper stopped answering mid-job');
      }
    }
    await wait(this.options.pollIntervalMs ?? 8000);
  }

  throw new LocalScraperError('timeout', 'Local scraper job reached its polling limit');
}
```

Replace both duplicated polling loops with `await this.pollJob(baseUrl, jobId)`. In fallback `search`, catch the typed error, emit one `failed` event using the existing operator wording, then continue to the next location plan. Do not change job payloads, query construction, CSV parsing, or download behavior.

- [ ] **Step 6: Run focused polling tests**

Run:

```powershell
npm.cmd test -- --run tests/integrations/localMapsScraperClient.test.ts
```

Expected: all local scraper tests PASS, including lowercase fallback, two transient failures followed by success, three transport failures, three HTTP 503 failures, and finite timeout.

- [ ] **Step 7: Run required verification**

Create a fresh SQLite file under `$env:TEMP`, set `DATABASE_URL` to its `file:` URL, run:

```powershell
npx.cmd prisma db push --skip-generate
npm.cmd test
npm.cmd run build
```

Expected: all test files pass and `tsc` exits 0.

- [ ] **Step 8: Commit the polling stabilization**

```powershell
git add -- src/integrations/localMapsScraperClient.ts tests/integrations/localMapsScraperClient.test.ts
git commit -m "fix: unify local scraper polling safeguards"
```

### Task 2: Reconcile resume, heartbeat, and productive-provider settlement

**Files:**
- Modify: `src/domain/balancedGoogleMapsRunService.ts`
- Modify: `tests/domain/balancedGoogleMapsRunService.test.ts`

**Interfaces:**
- Consumes: existing provider states `completed | failed | waiting_for_scraper | waiting_for_credentials`.
- Produces: unchanged `BalancedGoogleMapsRunOutcome`.
- Preserves: Google request budget, concurrent provider startup, early-close behavior, and run metrics.

- [ ] **Step 1: Add a failing interrupted-checkpoint resume test**

Seed the deterministic batch with status `running`, representing a process interruption after the checkpoint was claimed but before it settled. Assert that the batch runs once, its attempt count advances, and the run completes.

```ts
it('retries an interrupted running checkpoint once during resume', async () => {
  const filters = {
    provider: 'local_first' as const,
    searchTerms: ['dentist'],
    locations: ['Austin, TX'],
    apiRequestBudget: 0,
  };
  const [planned] = buildLocalDiscoveryBatches(filters, 1);
  const run: RunRecord = {
    id: 23,
    status: 'running',
    leadSource: 'google_maps',
    actorId: 'local_first',
    maxResults: 1,
    leadCount: 0,
  };
  const state = fakeStore(run, {
    batches: [{
      id: 1,
      runId: run.id,
      batchKey: planned.key,
      query: planned.query,
      status: 'running',
      attemptCount: 1,
      resultCount: 0,
    }],
  });
  let calls = 0;

  await executeBalancedGoogleMapsRun({
    store: state.store,
    localClient: {
      async search() { return []; },
      async health() { return true; },
      async searchBatch({ batch }) {
        calls += 1;
        return {
          batchKey: batch.key,
          jobId: 'resumed-job',
          rawBusinessCount: 1,
          items: [{ title: 'Resumed Co' }],
        };
      },
    },
  }, run, { leadSource: 'google_maps', maxResults: 1, googleMaps: filters });

  expect(calls).toBe(1);
  expect(state.batches[0]).toMatchObject({ status: 'completed', attemptCount: 2 });
  expect(run.status).toBe('completed');
});
```

- [ ] **Step 2: Run the resume test and verify red**

Run:

```powershell
npm.cmd test -- --run tests/domain/balancedGoogleMapsRunService.test.ts
```

Expected: FAIL because `running` checkpoints are currently neither completed nor runnable after process recovery.

- [ ] **Step 3: Requeue only interrupted checkpoints at execution startup**

After reading existing batches and before creating missing planned batches, convert persisted `running` checkpoints to `retry` with an interruption code:

```ts
for (const checkpoint of existingBatches.filter((batch) => batch.status === 'running')) {
  await store.upsertBatch(run.id, {
    ...checkpoint,
    status: 'retry',
    errorCode: 'interrupted_before_settlement',
  });
}
```

This runs before any new batch is claimed in the current invocation. Completed checkpoints remain untouched, and the existing runnable-batch query continues to select only `pending` and `retry`.

- [ ] **Step 4: Add a failing productive-Docker settlement test**

Create a run with Google budget 50 and no Google key. Make Docker return one business. Assert completed status, one persisted business, zero API attempts, and one `google_places_waiting_for_credentials` event.

```ts
it('completes with preserved Docker output when Google credentials are unavailable', async () => {
  const run: RunRecord = {
    id: 24,
    status: 'queued',
    leadSource: 'google_maps',
    actorId: 'local_first',
    maxResults: 20,
    leadCount: 0,
  };
  const state = fakeStore(run);

  await executeBalancedGoogleMapsRun({
    store: state.store,
    localClient: {
      async search() { return []; },
      async health() { return true; },
      async searchBatch({ batch }) {
        return {
          batchKey: batch.key,
          jobId: 'docker-only',
          rawBusinessCount: 1,
          items: [{ title: 'Docker Co', website: 'https://docker.example.com' }],
        };
      },
    },
  }, run, {
    leadSource: 'google_maps',
    maxResults: 20,
    googleMaps: {
      provider: 'local_first',
      searchTerms: ['dentist'],
      locations: ['Austin, TX'],
      apiRequestBudget: 50,
    },
  });

  expect(run).toMatchObject({ status: 'completed', businessCount: 1, apiRequestsUsed: 0 });
  expect(state.events.filter((event) => event.type === 'google_places_waiting_for_credentials')).toHaveLength(1);
});
```

- [ ] **Step 5: Run the balanced service test and verify the settlement case is red**

Run:

```powershell
npm.cmd test -- --run tests/domain/balancedGoogleMapsRunService.test.ts
```

Expected: FAIL because the run currently settles as `waiting_for_credentials` even after Docker completes with useful output.

- [ ] **Step 6: Report Google credential standby once**

In `runGoogleProvider`, replace the bare missing-key return with:

```ts
if (!input.googleApiKey) {
  await store.addEvent(
    run.id,
    'google_places_waiting_for_credentials',
    'Google Places needs credentials; Docker continues and all saved output will be preserved.',
    { provider: 'google_places', requestBudget: budget }
  );
  await heartbeat('google', 'standby', 'Waiting for Google credentials', 0, {
    budgetUsed: apiRequestsUsed,
    budgetMax: budget,
  });
  return 'waiting_for_credentials';
}
```

This creates one factual provider event and keeps Docker running.

- [ ] **Step 7: Settle completed Docker output as success**

Gate the existing waiting branch on the absence of a completed productive local lane:

```ts
const localCompletedWithOutput = localState === 'completed' && snap.businessCount > 0;

if (googleState === 'waiting_for_credentials' && !localCompletedWithOutput) {
  await store.updateRun(run.id, {
    status: 'waiting_for_credentials',
    ...(await snapshotMetrics()),
  });
  await store.addEvent(run.id, 'run_waiting_for_credentials', 'Google credentials must be re-entered.', {
    leadCount: snap.qualifiedContactCount,
  });
  return {
    status: 'waiting_for_credentials',
    leadCount: snap.qualifiedContactCount,
    businessCount: snap.businessCount,
    seenEmails: coordinator.seenEmails,
  };
}
```

Do not change the existing waiting behavior when Docker produced no businesses or has not completed.

- [ ] **Step 8: Add heartbeat-write resilience coverage**

Add a test whose `upsertProviderState` always throws while Docker returns one business with Google budget zero. Assert that the outcome still completes and persists the business:

```ts
it('does not fail provider work when a heartbeat write is unavailable', async () => {
  const run: RunRecord = {
    id: 25,
    status: 'queued',
    leadSource: 'google_maps',
    actorId: 'local_first',
    maxResults: 1,
    leadCount: 0,
  };
  const state = fakeStore(run);
  state.store.upsertProviderState = async () => {
    throw new Error('provider state table busy');
  };

  const outcome = await executeBalancedGoogleMapsRun({
    store: state.store,
    localClient: {
      async search() { return []; },
      async health() { return true; },
      async searchBatch({ batch }) {
        return {
          batchKey: batch.key,
          jobId: 'heartbeat-safe',
          rawBusinessCount: 1,
          items: [{ title: 'Heartbeat Safe Co' }],
        };
      },
    },
  }, run, {
    leadSource: 'google_maps',
    maxResults: 1,
    googleMaps: {
      provider: 'local_first',
      searchTerms: ['dentist'],
      locations: ['Austin, TX'],
      apiRequestBudget: 0,
    },
  });

  expect(outcome).toMatchObject({ status: 'completed', businessCount: 1 });
});
```

Run the focused test and expect it to fail at the first awaited heartbeat.

- [ ] **Step 9: Make heartbeat persistence non-fatal and observable**

Wrap the body of the existing `heartbeat` helper:

```ts
try {
  await store.upsertProviderState(run.id, {
    provider,
    status,
    operation,
    yieldCount,
    budgetUsed: extra.budgetUsed,
    budgetMax: extra.budgetMax,
    errorCode: extra.errorCode,
    errorMessage: extra.errorMessage,
    heartbeatAt: now(),
  });
} catch {
  await store.addErrorLog({
    runId: run.id,
    source: 'balancedGoogleMapsRunService',
    severity: 'warn',
    message: 'Provider heartbeat could not be persisted.',
    details: { provider, errorCode: 'heartbeat_write_failed' },
  }).catch(() => {});
}
```

Do not retry heartbeat writes inside this helper and do not include the store exception text.

- [ ] **Step 10: Run focused orchestration tests**

Run:

```powershell
npm.cmd test -- --run tests/domain/balancedGoogleMapsRunService.test.ts tests/domain/runService.test.ts
```

Expected: all tests PASS, including the new productive-Docker settlement case and the existing empty-circuit credential-wait case.

- [ ] **Step 11: Run required verification**

Create a new isolated SQLite database and run:

```powershell
npx.cmd prisma db push --skip-generate
npm.cmd test
npm.cmd run build
```

Expected: the complete suite passes and `tsc` exits 0.

- [ ] **Step 12: Commit provider settlement**

```powershell
git add -- src/domain/balancedGoogleMapsRunService.ts tests/domain/balancedGoogleMapsRunService.test.ts
git commit -m "fix: preserve productive Docker-only Google runs"
```

### Task 3: Align operator documentation and Kimi handoff

**Files:**
- Modify: `README.md`
- Modify: `docs/AGENT_LOG.md`

**Interfaces:**
- Consumes: verified behavior and commit hashes from Tasks 1–2.
- Produces: current operator baseline and Kimi-readable review path.

- [ ] **Step 1: Correct the active README baseline**

Replace the stale sequential fallback paragraph with:

```md
Google Maps Standard runs automatically start Docker and Google Places together; there is no provider-selection step. Docker submits deterministic, one-location browser batches to the locally built scraper on `127.0.0.1:8080`, while Google spreads its request budget across locations before deeper pagination. Both lanes persist through the same SQLite-backed ingestion coordinator, merge duplicate businesses, and preserve partial output if one lane fails. The Google request budget defaults to 50 HTTP attempts and is capped at 500; set it to `0` for Docker-only discovery. Hybrid Max Output adds Apify without mixing these records into Sales Navigator leads.
```

Update the following concurrency sentence to state that the application baseline is four scraper pages with one checkpoint batch at a time. Do not claim that a paid proxy is active.

- [ ] **Step 2: Add the Kimi handoff**

Prepend a dated section to `docs/AGENT_LOG.md` containing:

- branch `codex/google-scraping-stabilization`;
- specification and plan paths;
- each implementation commit hash and summary;
- focused and full test counts;
- build result;
- local Docker health/smoke result;
- explicit statement that no paid provider request was made;
- protected behaviors reviewed;
- any caveat that remains;
- requested review action for Kimi.

- [ ] **Step 3: Run documentation consistency checks**

Run:

```powershell
rg -n "defaults to 25|concurrency remains at 1|only uses Google Places for the remaining target" README.md
git diff --check
```

Expected: `rg` finds no stale active README statements and `git diff --check` exits 0.

- [ ] **Step 4: Run local credit-free health checks**

Run read-only checks:

```powershell
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
Invoke-WebRequest -UseBasicParsing -Uri http://127.0.0.1:8080/api/v1/jobs -TimeoutSec 5
```

If the local scraper is healthy, exercise only its local health/API contract without submitting a Google or Apify request. If Docker is unavailable, record that fact as an unverified environmental caveat, not a code failure.

- [ ] **Step 5: Run final focused and complete verification**

Run:

```powershell
npm.cmd test -- --run tests/integrations/localMapsScraperClient.test.ts tests/integrations/googlePlacesClient.test.ts tests/domain/balancedGoogleMapsRunService.test.ts tests/domain/runService.test.ts
```

Then create a fresh isolated SQLite database and run:

```powershell
npx.cmd prisma db push --skip-generate
npm.cmd test
npm.cmd run build
```

Expected: focused tests pass, all repository tests pass, and `tsc` exits 0.

- [ ] **Step 6: Commit the handoff**

```powershell
git add -- README.md docs/AGENT_LOG.md
git commit -m "docs: hand off stabilized Google scraping lane"
```

- [ ] **Step 7: Push for Kimi review**

Push the feature branch without rewriting history:

```powershell
git push -u origin codex/google-scraping-stabilization
```

Report the exact remote branch, final commit hash, specification path, plan path, verification totals, and any local-only caveat.
