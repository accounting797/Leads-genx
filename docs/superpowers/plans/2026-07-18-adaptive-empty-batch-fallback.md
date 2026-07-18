# Adaptive Empty-Batch Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Docker-first discovery after three consecutive successful zero-result batches and continue through the existing budget-controlled Google API fallback.

**Architecture:** Keep the circuit state local to `executeLocalFirstRun`, reset it after every non-empty batch, and persist the open state by marking the remaining deterministic checkpoints `skipped_empty_circuit`. Existing checkpoint queries then exclude those shards after restart, while the existing Google fallback and secure credential-resume paths remain responsible for recovery.

**Tech Stack:** TypeScript, Vitest, Prisma/SQLite checkpoint records, Docker scraper HTTP client, Google Places client.

## Global Constraints

- Docker remains the primary provider for Standard Google Maps runs.
- The circuit threshold is exactly three consecutive successfully completed batches with zero raw businesses.
- Google API requests remain bounded by the existing per-run request budget.
- Google API keys, proxy URLs, query text, and raw scraper data must not appear in the new circuit events.
- Apify behavior remains unchanged and available only through Hybrid Max Output.
- No database schema migration or new dependency is introduced.

---

### Task 1: Add the adaptive local-empty circuit and regression coverage

**Files:**
- Modify: `tests/domain/localFirstRunService.test.ts`
- Modify: `src/domain/localFirstRunService.ts`

**Interfaces:**
- Consumes: `LocalFirstRunStore.upsertBatch(runId, batch)`, `LocalFirstRunStore.addEvent(runId, type, message, metadata)`, `ResumableLocalMapsScraperClient.searchBatch(...)`, and the existing Google fallback block in `executeLocalFirstRun(...)`.
- Produces: checkpoint status `skipped_empty_circuit`, error code `consecutive_empty_batches`, event `local_batch_empty`, and event `local_empty_circuit_opened`.

- [ ] **Step 1: Extend the fake store to capture event metadata**

In `tests/domain/localFirstRunService.test.ts`, add an event collection and return it from `fakeStore`:

```ts
const events: Array<{ type: string; metadata?: unknown }> = [];

async addEvent(_id, type, _message, metadata) {
  calls.push(`event:${type}`);
  events.push({ type, metadata });
},

return { store, calls, batches, businesses, leads, events };
```

- [ ] **Step 2: Write failing circuit-breaker tests**

Add these cases to `describe('executeLocalFirstRun', ...)`:

```ts
it('opens the local circuit after three empty batches and invokes Google fallback', async () => {
  const filters = {
    provider: 'local_first' as const,
    searchTerms: ['one', 'two', 'three', 'four', 'five'],
    locations: ['Austin, TX'],
    apiRequestBudget: 2,
  };
  const run: RunRecord = {
    id: 4, status: 'queued', leadSource: 'google_maps', actorId: 'local_first',
    maxResults: 100, leadCount: 0,
  };
  const state = fakeStore(run);
  let localCalls = 0;
  let googleCalls = 0;

  await executeLocalFirstRun({
    store: state.store,
    localClient: {
      async search() { return []; },
      async health() { return true; },
      async searchBatch({ batch }) {
        localCalls += 1;
        return { batchKey: batch.key, jobId: `empty-${localCalls}`, rawBusinessCount: 0, items: [] };
      },
    },
    googleClient: {
      async search() {
        googleCalls += 1;
        return [{ id: 'google-fallback', displayName: { text: 'Fallback Co' } }];
      },
    },
  }, run, {
    leadSource: 'google_maps', maxResults: 100, googleApiKey: 'request-scoped-secret', googleMaps: filters,
  });

  expect(localCalls).toBe(3);
  expect(googleCalls).toBe(1);
  expect(state.batches.filter((batch) => batch.status === 'skipped_empty_circuit')).toHaveLength(2);
  expect(state.events).toContainEqual({
    type: 'local_empty_circuit_opened',
    metadata: { threshold: 3, skippedBatchCount: 2 },
  });
  expect(JSON.stringify(state.events)).not.toContain('request-scoped-secret');
  expect(run).toMatchObject({ status: 'completed', businessCount: 1 });
});

it('resets the empty counter after a non-empty local batch', async () => {
  const filters = {
    provider: 'local_first' as const,
    searchTerms: ['one', 'two', 'three', 'four', 'five', 'six', 'seven'],
    locations: ['Austin, TX'],
    apiRequestBudget: 0,
  };
  const run: RunRecord = {
    id: 5, status: 'queued', leadSource: 'google_maps', actorId: 'local_first',
    maxResults: 100, leadCount: 0,
  };
  const state = fakeStore(run);
  const rawCounts = [0, 0, 1, 0, 0, 0];
  let localCalls = 0;

  await executeLocalFirstRun({
    store: state.store,
    localClient: {
      async search() { return []; },
      async health() { return true; },
      async searchBatch({ batch }) {
        const rawBusinessCount = rawCounts[localCalls] ?? 0;
        localCalls += 1;
        return {
          batchKey: batch.key,
          jobId: `local-${localCalls}`,
          rawBusinessCount,
          items: rawBusinessCount ? [{ title: 'Recovered Local Co' }] : [],
        };
      },
    },
  }, run, { leadSource: 'google_maps', maxResults: 100, googleMaps: filters });

  expect(localCalls).toBe(6);
  expect(state.businesses).toHaveLength(1);
  expect(state.batches.filter((batch) => batch.status === 'skipped_empty_circuit')).toHaveLength(1);
  expect(run.status).toBe('completed');
});

it('waits for secure Google credentials after opening the local circuit on recovery', async () => {
  const filters = {
    provider: 'local_first' as const,
    searchTerms: ['one', 'two', 'three', 'four'],
    locations: ['Austin, TX'],
    apiRequestBudget: 2,
  };
  const run: RunRecord = {
    id: 6, status: 'running', leadSource: 'google_maps', actorId: 'local_first',
    maxResults: 100, leadCount: 0,
  };
  const state = fakeStore(run);

  await executeLocalFirstRun({
    store: state.store,
    localClient: {
      async search() { return []; },
      async health() { return true; },
      async searchBatch({ batch }) {
        return { batchKey: batch.key, jobId: 'empty', rawBusinessCount: 0, items: [] };
      },
    },
  }, run, { leadSource: 'google_maps', maxResults: 100, googleMaps: filters });

  expect(run.status).toBe('waiting_for_credentials');
  expect(state.batches.filter((batch) => batch.status === 'skipped_empty_circuit')).toHaveLength(1);
});
```

- [ ] **Step 3: Run the focused tests and verify they fail**

Run:

```powershell
npm.cmd test -- tests/domain/localFirstRunService.test.ts
```

Expected: the three new cases fail because all local batches are currently submitted and no `local_empty_circuit_opened` event or `skipped_empty_circuit` checkpoint exists.

- [ ] **Step 4: Implement the three-empty-batch circuit**

In `src/domain/localFirstRunService.ts`, add the constant near the interfaces:

```ts
const EMPTY_BATCH_CIRCUIT_THRESHOLD = 3;
```

Replace the local `for...of` setup with indexed iteration and initialize the counter:

```ts
const runnable = await store.listRunnableBatches(run.id, now());
let consecutiveEmptyBatches = 0;
for (let batchIndex = 0; batchIndex < runnable.length; batchIndex += 1) {
  const checkpoint = runnable[batchIndex];
  const batch: LocalDiscoveryBatch | undefined = plannedByKey.get(checkpoint.batchKey);
  if (!batch) continue;
```

Immediately after `searchBatch` succeeds and before normalization, update the empty counter and emit the bounded event:

```ts
const result = await localClient.searchBatch({ batch, proxies: input.proxyUrls ?? [] });
if (result.rawBusinessCount === 0) {
  consecutiveEmptyBatches += 1;
  await store.addEvent(run.id, 'local_batch_empty', 'Local discovery batch returned no businesses.', {
    consecutiveEmptyBatches,
    threshold: EMPTY_BATCH_CIRCUIT_THRESHOLD,
  });
} else {
  consecutiveEmptyBatches = 0;
}
```

After the existing `local_batch_completed` event, open the circuit, persist the skipped checkpoints, and break:

```ts
if (consecutiveEmptyBatches >= EMPTY_BATCH_CIRCUIT_THRESHOLD) {
  const remaining = runnable.slice(batchIndex + 1);
  for (const pending of remaining) {
    await store.upsertBatch(run.id, {
      ...pending,
      status: 'skipped_empty_circuit',
      errorCode: 'consecutive_empty_batches',
    });
  }
  await store.addEvent(run.id, 'local_empty_circuit_opened', 'Docker discovery paused after repeated empty batches; continuing to Google fallback.', {
    threshold: EMPTY_BATCH_CIRCUIT_THRESHOLD,
    skippedBatchCount: remaining.length,
  });
  break;
}
```

At the beginning of the existing `catch` block, reset the counter so a failed batch interrupts an empty-success sequence:

```ts
} catch (error) {
  consecutiveEmptyBatches = 0;
  const code = errorCode(error);
```

- [ ] **Step 5: Run the focused regression tests**

Run:

```powershell
npm.cmd test -- tests/domain/localFirstRunService.test.ts
```

Expected: all six `executeLocalFirstRun` tests pass.

- [ ] **Step 6: Run related tests and the TypeScript build**

Run:

```powershell
npm.cmd test -- tests/domain/localFirstRunService.test.ts tests/domain/leadNormalizer.test.ts tests/domain/leadQuality.test.ts tests/integrations/googlePlacesClient.test.ts
npm.cmd run build
```

Expected: all selected tests pass and `tsc` exits with code 0.

- [ ] **Step 7: Run the complete test suite**

Run:

```powershell
npm.cmd test
```

Expected: every Vitest file passes with no regression in Standard, Hybrid Max Output, API error handling, persistence, or static UI tests.

- [ ] **Step 8: Commit the implementation**

Run:

```powershell
git add src/domain/localFirstRunService.ts tests/domain/localFirstRunService.test.ts
git commit -m "fix: fall back after repeated empty Docker batches"
```

Expected: one focused implementation commit following the design/spec commit.

- [ ] **Step 9: Restart and verify local services**

Rebuild/restart Leads-GenX without restarting the healthy Docker scraper, then verify:

```powershell
Invoke-RestMethod http://127.0.0.1:4177/api/health
Invoke-RestMethod http://127.0.0.1:8080/api/v1/jobs
```

Expected: Leads-GenX reports `status: ok`, the scraper job API responds successfully, and a controlled run with three empty test-double batches emits `local_empty_circuit_opened` before Google fallback. Do not launch a large live Google Maps scrape as part of automated verification.
