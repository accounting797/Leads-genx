# Balanced Google + Docker Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Standard mode run Google Places and Docker discovery concurrently, scan all websites through one application-level concurrency-50 pipeline, report exact Google request usage, and reserve Apify for Hybrid Max Output.

**Architecture:** Keep the existing `local_first` provider value for API/database compatibility, but replace its sequential implementation with a balanced orchestrator. Google streams page results and request events while Docker streams checkpointed batches; per-run serial queues make database metrics and email deduplication deterministic without serializing provider network work.

**Tech Stack:** TypeScript 6, Node.js 26, Express 5, Prisma 5/SQLite, Vitest 3, vanilla HTML/CSS/JavaScript, Dockerized `gosom/google-maps-scraper`

## Global Constraints

- Standard automatically runs Google Places and Docker together; no separate Docker selection is added.
- Standard and Hybrid Max Output default to exactly 50 Google HTTP attempts per run, with an allowed explicit range of 1 through 500.
- Every outbound Google HTTP attempt consumes one budget unit and increments `apiRequestsUsed`, including failed and rotated-key attempts.
- Docker jobs created by Leads-GenX must send `email: false`.
- Website scanning has one global per-run concurrency cap of exactly 50 across all providers.
- Company types are modifiers whenever at least one search term or category exists; standalone company-type queries remain valid only when no more specific criterion exists.
- Google Places traffic remains direct and never uses the proxy pool.
- Apify remains exclusive to Hybrid Max Output.
- Google keys, Apify tokens, and proxy credentials remain request-scoped and absent from persisted filter JSON, logs, events, responses, Docker job records, and exports.
- Provider failures preserve partial results and do not silently increase budgets or create unlimited retries.
- Existing Docker checkpoint recovery and the three-consecutive-empty-batch circuit remain active.

---

## File Structure

- Create `src/domain/serialTaskQueue.ts`: generic per-run FIFO promise queue used to serialize persistence and website work.
- Create `tests/domain/serialTaskQueue.test.ts`: ordering, rejection isolation, and drain behavior.
- Create `tests/domain/googleMapsQueryBuilder.test.ts`: focused query-modifier behavior.
- Rename `src/domain/localFirstRunService.ts` to `src/domain/balancedGoogleMapsRunService.ts`: concurrent Google/Docker orchestration while retaining checkpoint behavior.
- Rename `tests/domain/localFirstRunService.test.ts` to `tests/domain/balancedGoogleMapsRunService.test.ts`: provider overlap, partial failure, target, circuit, resume, metrics, and global email concurrency.
- Modify `src/domain/googleMapsQueryBuilder.ts`: suppress broad standalone company types when specific criteria exist.
- Modify `src/domain/validation.ts`: 50-request defaults, 1–500 Standard/Hybrid bounds, and dedicated secure resume-credential parsing.
- Modify `src/routes/api.ts`: use the resume-credential parser instead of fabricating a zero-budget run.
- Modify `src/integrations/googlePlacesClient.ts`: request/page callbacks, error classification, terminal-key handling, bounded stopping, and exact attempt counts.
- Modify `src/integrations/localMapsScraperClient.ts`: discovery-only Docker payloads in resumable and legacy paths.
- Modify `src/domain/runService.ts`: call the balanced orchestrator and preserve Hybrid's subsequent Apify stage.
- Modify `public/index.html`: balanced-mode copy, 50-request default, and live metric placeholders.
- Modify `public/app.js`: 50-request submission default and source-aware simultaneous progress.
- Modify existing tests under `tests/integrations`, `tests/domain`, `tests/api`, and `tests/public` to lock the contracts above.

---

### Task 1: Targeted queries and secure 50-request defaults

**Files:**
- Create: `tests/domain/googleMapsQueryBuilder.test.ts`
- Modify: `src/domain/googleMapsQueryBuilder.ts:15-36`
- Modify: `tests/domain/validation.test.ts`
- Modify: `src/domain/validation.ts:170-260`
- Modify: `tests/api/api.test.ts`
- Modify: `src/routes/api.ts:122-143`

**Interfaces:**
- Consumes: `GoogleMapsFilters`, existing `ValidationError`, request bodies accepted by `POST /api/runs/:id/resume`.
- Produces: `buildGoogleMapsSearchQueries(filters: GoogleMapsFilters): string[]`; `validateResumeCredentials(input: unknown): ResumeCredentialsInput`; Standard/Hybrid inputs with `apiRequestBudget` defaulting to `50`.

- [ ] **Step 1: Write focused failing query-builder tests**

```ts
// tests/domain/googleMapsQueryBuilder.test.ts
import { describe, expect, it } from 'vitest';
import { buildGoogleMapsSearchQueries } from '../../src/domain/googleMapsQueryBuilder';

describe('buildGoogleMapsSearchQueries', () => {
  it('uses company types as modifiers when specific criteria exist', () => {
    expect(buildGoogleMapsSearchQueries({
      searchTerms: ['oilfield services'],
      categoryFilters: ['Oil & Gas'],
      companyTypes: ['Distributor', 'Corporation'],
      locations: ['Washington, DC'],
    })).toEqual([
      'oilfield services Washington, DC',
      'Oil & Gas Washington, DC',
      'oilfield services Oil & Gas Washington, DC',
      'oilfield services Distributor Washington, DC',
      'oilfield services Corporation Washington, DC',
      'Oil & Gas Distributor Washington, DC',
      'Oil & Gas Corporation Washington, DC',
    ]);
  });

  it('retains standalone company types when they are the only criteria', () => {
    expect(buildGoogleMapsSearchQueries({
      companyTypes: ['Distributor'],
      locations: ['Nashville, TN'],
    })).toEqual(['Distributor Nashville, TN']);
  });
});
```

- [ ] **Step 2: Run the query tests and verify the broad standalone queries fail**

Run: `npx vitest run tests/domain/googleMapsQueryBuilder.test.ts`

Expected: FAIL because the first result currently contains `Distributor Washington, DC` and `Corporation Washington, DC`.

- [ ] **Step 3: Implement modifier-only company types**

```ts
export function buildGoogleMapsSearchQueries(filters: GoogleMapsFilters): string[] {
  const searchTerms = cleanValues(filters.searchTerms);
  const categories = cleanValues(filters.categoryFilters);
  const companyTypes = cleanValues(filters.companyTypes);
  const locations = cleanValues(filters.locations);
  const hasSpecificCriteria = searchTerms.length > 0 || categories.length > 0;
  const baseSearches = uniqueValues([
    ...searchTerms,
    ...categories,
    ...(!hasSpecificCriteria ? companyTypes : []),
    ...combine(searchTerms, categories),
    ...combine(searchTerms, companyTypes),
    ...combine(categories, companyTypes),
  ]);

  if (filters.locationQuery?.trim()) {
    const location = filters.locationQuery.trim();
    return baseSearches.length ? baseSearches.map((search) => `${search} ${location}`) : [location];
  }

  if (!locations.length) return baseSearches;
  return uniqueValues(locations.flatMap((location) => baseSearches.map((search) => `${search} ${location}`)));
}
```

- [ ] **Step 4: Add failing validation and resume parsing tests**

```ts
// Extend the existing validation import with validateResumeCredentials, then append:

it('defaults Standard and Hybrid Max Output to 50 Google requests', () => {
  const standard = validateCreateRunInput({
    leadSource: 'google_maps',
    googleApiKey: 'google-key',
    maxResults: 100,
    googleMaps: { provider: 'local_first', searchTerms: ['dentist'] },
  }, false);
  const hybrid = validateCreateRunInput({
    leadSource: 'google_maps',
    googleApiKey: 'google-key',
    apifyToken: 'apify-token',
    maxResults: 100,
    googleMaps: { provider: 'hybrid', searchTerms: ['dentist'] },
  }, false);

  expect(standard.googleMaps?.apiRequestBudget).toBe(50);
  expect(hybrid.googleMaps?.apiRequestBudget).toBe(50);
});

it('rejects a zero request budget for balanced modes', () => {
  expect(() => validateCreateRunInput({
    leadSource: 'google_maps',
    googleApiKey: 'google-key',
    maxResults: 100,
    googleMaps: { provider: 'local_first', searchTerms: ['dentist'], apiRequestBudget: 0 },
  }, false)).toThrow(ValidationError);
});

it('parses optional resume credentials without creating a fake run', () => {
  expect(validateResumeCredentials({
    googleApiKey: 'key-one\nkey-two',
    proxyUrls: 'socks5h://user:pass@127.0.0.1:60001',
  })).toEqual({
    googleApiKey: 'key-one',
    googleApiKeys: ['key-one', 'key-two'],
    proxyUrls: ['socks5h://user:pass@127.0.0.1:60001'],
  });
});
```

- [ ] **Step 5: Run validation tests and verify the defaults fail**

Run: `npx vitest run tests/domain/validation.test.ts tests/api/api.test.ts`

Expected: FAIL because Standard/Hybrid currently default to 25, zero is accepted, and `validateResumeCredentials` does not exist.

- [ ] **Step 6: Implement the budget and resume contracts**

```ts
// src/domain/validation.ts
export interface ResumeCredentialsInput {
  googleApiKey?: string;
  googleApiKeys?: string[];
  proxyUrls?: string[];
}

export function validateResumeCredentials(input: unknown): ResumeCredentialsInput {
  const obj = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const fields: Record<string, string> = {};
  const googleApiKeys = asCredentialList(obj.googleApiKey);
  const proxyUrls = asProxyList(obj.proxyUrls, fields);
  if (Object.keys(fields).length) throw new ValidationError(Object.values(fields)[0], fields);
  return {
    googleApiKey: googleApiKeys[0],
    googleApiKeys: googleApiKeys.length ? googleApiKeys : undefined,
    proxyUrls: proxyUrls.length ? proxyUrls : undefined,
  };
}
```

Replace both balanced-mode default assignments with `googleMaps.apiRequestBudget = googleMaps.apiRequestBudget ?? 50`, and validate with:

```ts
if (googleMaps.apiRequestBudget < 1 || googleMaps.apiRequestBudget > 500) {
  fields.apiRequestBudget = 'Google API request budget must be between 1 and 500.';
}
```

Replace the resume route's fabricated run validation with:

```ts
const parsed = validateResumeCredentials(req.body);
const resumed = await runService.resumeRun(Number(req.params.id), parsed);
```

- [ ] **Step 7: Run focused tests and commit**

Run: `npx vitest run tests/domain/googleMapsQueryBuilder.test.ts tests/domain/validation.test.ts tests/api/api.test.ts`

Expected: PASS.

```powershell
git add src/domain/googleMapsQueryBuilder.ts src/domain/validation.ts src/routes/api.ts tests/domain/googleMapsQueryBuilder.test.ts tests/domain/validation.test.ts tests/api/api.test.ts
git commit -m "feat: target Google queries and default balanced budget"
```

---

### Task 2: Observable and bounded Google Places client

**Files:**
- Modify: `tests/integrations/googlePlacesClient.test.ts`
- Modify: `src/integrations/googlePlacesClient.ts`

**Interfaces:**
- Consumes: `buildGoogleMapsSearchQueries(filters)`, global `fetch`, supplied Google key pool.
- Produces: `GooglePlacesRequestEvent`, `GooglePlacesPageEvent`, `GooglePlacesError`, `onRequestEvent`, `onPage`, and `shouldStop` additions to `GooglePlacesSearchInput`.

- [ ] **Step 1: Add failing request-count, streaming, and terminal-key tests**

```ts
// append to tests/integrations/googlePlacesClient.test.ts
it('reports every attempted request and streams new page items', async () => {
  const requests: number[] = [];
  const pages: unknown[][] = [];
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      places: [{ id: 'one' }], nextPageToken: 'next',
    }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      places: [{ id: 'two' }],
    }), { status: 200 })));

  const items = await new GooglePlacesApiClient().search({
    apiKey: 'secret',
    filters: { searchTerms: ['dentist'] },
    maxResults: 10,
    requestBudget: 2,
    onRequestEvent(event) {
      if (event.type === 'attempted') requests.push(event.requestCount);
    },
    onPage(event) { pages.push(event.items); },
  });

  expect(requests).toEqual([1, 2]);
  expect(pages).toEqual([[{ id: 'one' }], [{ id: 'two' }]]);
  expect(items).toHaveLength(2);
});

it('counts rotated-key attempts and stops terminal authorization failures', async () => {
  const attempts: number[] = [];
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    error: { status: 'PERMISSION_DENIED', message: 'API key is not authorized' },
  }), { status: 403 }));
  vi.stubGlobal('fetch', fetchMock);

  await expect(new GooglePlacesApiClient().search({
    apiKey: 'key-one',
    apiKeys: ['key-one', 'key-two'],
    filters: { searchTerms: ['one', 'two', 'three'] },
    maxResults: 100,
    requestBudget: 50,
    onRequestEvent(event) {
      if (event.type === 'attempted') attempts.push(event.requestCount);
    },
  })).rejects.toMatchObject({ code: 'forbidden' });

  expect(attempts).toEqual([1, 2]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('stops scheduling shards when the orchestrator target is reached', async () => {
  let stop = false;
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ places: [{ id: 'one' }] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);

  await new GooglePlacesApiClient().search({
    apiKey: 'secret',
    filters: { searchTerms: ['one', 'two'] },
    maxResults: 100,
    requestBudget: 10,
    shouldStop: () => stop,
    onPage() { stop = true; },
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the Google client tests and verify the interfaces are missing**

Run: `npx vitest run tests/integrations/googlePlacesClient.test.ts`

Expected: FAIL with TypeScript errors for `onRequestEvent`, `onPage`, `shouldStop`, and `GooglePlacesError.code`.

- [ ] **Step 3: Add exact public event and error types**

```ts
export type GooglePlacesErrorCode =
  | 'invalid_key'
  | 'forbidden'
  | 'quota'
  | 'rate_limited'
  | 'budget_exhausted'
  | 'transient'
  | 'request_failed';

export class GooglePlacesError extends Error {
  constructor(
    public readonly code: GooglePlacesErrorCode,
    message: string,
    public readonly httpStatus?: number
  ) {
    super(message);
    this.name = 'GooglePlacesError';
  }
}

export interface GooglePlacesRequestEvent {
  type: 'attempted' | 'succeeded' | 'failed';
  requestCount: number;
  budget: number;
  httpStatus?: number;
  errorCode?: GooglePlacesErrorCode;
}

export interface GooglePlacesPageEvent {
  shard: number;
  shardCount: number;
  query: string;
  items: unknown[];
  totalItemCount: number;
}

export interface GooglePlacesSearchInput {
  apiKey: string;
  apiKeys?: string[];
  filters: GoogleMapsFilters;
  maxResults: number;
  requestBudget?: number;
  onShardEvent?: (event: GooglePlacesShardEvent) => Promise<void> | void;
  onRequestEvent?: (event: GooglePlacesRequestEvent) => Promise<void> | void;
  onPage?: (event: GooglePlacesPageEvent) => Promise<void> | void;
  shouldStop?: () => boolean;
}
```

- [ ] **Step 4: Implement redacted response classification**

```ts
async function responseError(response: Response): Promise<GooglePlacesError> {
  const payload = await response.json().catch(() => ({})) as {
    error?: { status?: string; message?: string };
  };
  const statusName = payload.error?.status;
  if (response.status === 401 || statusName === 'UNAUTHENTICATED') {
    return new GooglePlacesError('invalid_key', 'Google API key was rejected.', response.status);
  }
  if (response.status === 403 || statusName === 'PERMISSION_DENIED') {
    return new GooglePlacesError('forbidden', 'Google Places access is forbidden; check key restrictions, API enablement, and billing.', response.status);
  }
  if (statusName === 'RESOURCE_EXHAUSTED') {
    return new GooglePlacesError('quota', 'Google Places quota was reached.', response.status);
  }
  if (response.status === 429) {
    return new GooglePlacesError('rate_limited', 'Google Places rate limit was reached.', response.status);
  }
  if (response.status >= 500) {
    return new GooglePlacesError('transient', 'Google Places is temporarily unavailable.', response.status);
  }
  return new GooglePlacesError('request_failed', `Google Places request failed with status ${response.status}.`, response.status);
}

function asGoogleError(error: unknown): GooglePlacesError {
  if (error instanceof GooglePlacesError) return error;
  return new GooglePlacesError('transient', error instanceof Error ? error.message : 'Google Places network request failed.');
}
```

- [ ] **Step 5: Replace request execution with exact attempt callbacks and terminal key handling**

Within `search`, destructure `onRequestEvent`, `onPage`, and `shouldStop`. Replace `requestPage` with:

```ts
const fieldMask = [
  'places.id', 'places.name', 'places.displayName', 'places.formattedAddress',
  'places.internationalPhoneNumber', 'places.nationalPhoneNumber', 'places.rating',
  'places.userRatingCount', 'places.websiteUri', 'places.googleMapsUri',
  'places.businessStatus', 'places.primaryType', 'places.primaryTypeDisplayName',
  'places.types', 'nextPageToken',
].join(',');

async function requestPage(
  body: Record<string, unknown>,
  startKeyIndex: number
): Promise<{ places?: unknown[]; nextPageToken?: string }> {
  let lastError: GooglePlacesError | undefined;

  for (let attempt = 0; attempt < keyPool.length; attempt += 1) {
    if (requestCount >= budget) {
      throw new GooglePlacesError('budget_exhausted', 'Google Places request budget exhausted.');
    }
    requestCount += 1;
    await onRequestEvent?.({ type: 'attempted', requestCount, budget });
    const queryApiKey = keyPool[(startKeyIndex + attempt) % keyPool.length];
    try {
      const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': queryApiKey,
          'X-Goog-FieldMask': fieldMask,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw await responseError(response);
      await onRequestEvent?.({ type: 'succeeded', requestCount, budget, httpStatus: response.status });
      return await response.json() as { places?: unknown[]; nextPageToken?: string };
    } catch (error) {
      lastError = asGoogleError(error);
      await onRequestEvent?.({
        type: 'failed', requestCount, budget,
        httpStatus: lastError.httpStatus, errorCode: lastError.code,
      });
      if (attempt === keyPool.length - 1) throw lastError;
    }
  }

  throw lastError ?? new GooglePlacesError('request_failed', 'Google Places request failed.');
}
```

Change `addUniquePlaces` to return the added records:

```ts
function addUniquePlaces(items: unknown[]): unknown[] {
  const added: unknown[] = [];
  for (const item of items) {
    const key = placeKey(item) || JSON.stringify(item);
    if (seenPlaces.has(key)) continue;
    seenPlaces.add(key);
    places.push(item);
    added.push(item);
  }
  return added;
}
```

After each page request:

```ts
const addedItems = addUniquePlaces(data.places ?? []);
shardItemCount += addedItems.length;
if (addedItems.length) {
  await onPage?.({
    shard: queryIndex + 1,
    shardCount: queries.length,
    query: textQuery,
    items: addedItems,
    totalItemCount: places.length,
  });
}
```

Guard the outer loop and page loop with `if (shouldStop?.()) break;`. When `budget_exhausted` is caught, emit the failed shard event and break the outer labelled query loop while returning accumulated places. Re-throw `invalid_key`, `forbidden`, `quota`, and `rate_limited` after all keys have been attempted so they are not repeated on later shards.

- [ ] **Step 6: Run Google client tests and commit**

Run: `npx vitest run tests/integrations/googlePlacesClient.test.ts`

Expected: PASS, including existing pagination, field-mask, key-rotation, deduplication, shard, and budget tests.

```powershell
git add src/integrations/googlePlacesClient.ts tests/integrations/googlePlacesClient.test.ts
git commit -m "feat: stream Google Places results and count attempts"
```

---

### Task 3: Docker discovery-only jobs

**Files:**
- Modify: `tests/integrations/localMapsScraperClient.test.ts`
- Modify: `src/integrations/localMapsScraperClient.ts:189-208,263-279`

**Interfaces:**
- Consumes: existing scraper-kit `POST /api/v1/jobs` JSON contract.
- Produces: resumable and legacy job payloads with `email: false`; unchanged CSV compatibility and result types.

- [ ] **Step 1: Change both payload assertions to require discovery-only mode**

```ts
// In the legacy job assertion
expect(JSON.parse(String(requestInit?.body))).toMatchObject({
  keywords: ['dentist Austin, TX'],
  email: false,
});

// In the resumable searchBatch assertion
expect(JSON.parse(String(createInit?.body))).toMatchObject({
  keywords: [batch.query],
  email: false,
  depth: batch.depth,
});
```

Add a compatibility assertion to the completed CSV test:

```ts
expect(result.items).toContainEqual(expect.objectContaining({
  title: 'Existing CSV Email Co',
  email: 'sales@example.com',
}));
```

- [ ] **Step 2: Run the local client tests and verify both payloads fail**

Run: `npx vitest run tests/integrations/localMapsScraperClient.test.ts`

Expected: FAIL because both payloads currently contain `email: true`.

- [ ] **Step 3: Disable Docker email crawling without changing CSV parsing**

Replace both job payload fields in `LocalMapsScraperKitClient.searchBatch` and `LocalMapsScraperKitClient.search`:

```ts
email: false,
```

Leave `splitEmails`, `toLeadRows`, and the existing `emails` CSV column parsing unchanged so resumed or historical jobs retain any emails already present.

- [ ] **Step 4: Run local client tests and commit**

Run: `npx vitest run tests/integrations/localMapsScraperClient.test.ts`

Expected: PASS.

```powershell
git add src/integrations/localMapsScraperClient.ts tests/integrations/localMapsScraperClient.test.ts
git commit -m "perf: make Docker scraper jobs discovery only"
```

---

### Task 4: Deterministic per-run work queues

**Files:**
- Create: `tests/domain/serialTaskQueue.test.ts`
- Create: `src/domain/serialTaskQueue.ts`

**Interfaces:**
- Consumes: zero-argument async tasks.
- Produces: `SerialTaskQueue.enqueue<T>(task: () => Promise<T>): Promise<T>` and `SerialTaskQueue.drain(): Promise<void>`.

- [ ] **Step 1: Write queue ordering and rejection-isolation tests**

```ts
// tests/domain/serialTaskQueue.test.ts
import { describe, expect, it } from 'vitest';
import { SerialTaskQueue } from '../../src/domain/serialTaskQueue';

describe('SerialTaskQueue', () => {
  it('runs tasks in FIFO order and drains all accepted work', async () => {
    const queue = new SerialTaskQueue();
    const calls: string[] = [];
    const first = queue.enqueue(async () => { calls.push('first:start'); await Promise.resolve(); calls.push('first:end'); return 1; });
    const second = queue.enqueue(async () => { calls.push('second'); return 2; });
    await queue.drain();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(calls).toEqual(['first:start', 'first:end', 'second']);
  });

  it('continues after a rejected task while preserving that rejection', async () => {
    const queue = new SerialTaskQueue();
    const failed = queue.enqueue(async () => { throw new Error('one failed'); });
    const succeeded = queue.enqueue(async () => 'two passed');
    await expect(failed).rejects.toThrow('one failed');
    await expect(succeeded).resolves.toBe('two passed');
    await expect(queue.drain()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the queue test and verify the module is missing**

Run: `npx vitest run tests/domain/serialTaskQueue.test.ts`

Expected: FAIL because `src/domain/serialTaskQueue.ts` does not exist.

- [ ] **Step 3: Implement the FIFO queue**

```ts
// src/domain/serialTaskQueue.ts
export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}
```

- [ ] **Step 4: Run the queue tests and commit**

Run: `npx vitest run tests/domain/serialTaskQueue.test.ts`

Expected: PASS.

```powershell
git add src/domain/serialTaskQueue.ts tests/domain/serialTaskQueue.test.ts
git commit -m "feat: add serialized per-run work queue"
```

---

### Task 5: Balanced Google and Docker orchestration

**Files:**
- Rename: `src/domain/localFirstRunService.ts` to `src/domain/balancedGoogleMapsRunService.ts`
- Rename: `tests/domain/localFirstRunService.test.ts` to `tests/domain/balancedGoogleMapsRunService.test.ts`
- Modify: `src/domain/runService.ts:1-15,418-520`
- Modify: `tests/domain/runService.test.ts`

**Interfaces:**
- Consumes: `SerialTaskQueue`, `GooglePlacesClient` streaming callbacks, `ResumableLocalMapsScraperClient`, `LocalFirstRunStore`, `keepEmailLeadsOnly`.
- Produces: `executeBalancedGoogleMapsRun(deps, run, input, options): Promise<BalancedGoogleMapsRunOutcome>` with `status`, `leadCount`, `businessCount`, and `seenEmails` used by Standard and Hybrid paths.

- [ ] **Step 1: Rename the service and its tests before changing behavior**

Run:

```powershell
Move-Item -LiteralPath src/domain/localFirstRunService.ts -Destination src/domain/balancedGoogleMapsRunService.ts
Move-Item -LiteralPath tests/domain/localFirstRunService.test.ts -Destination tests/domain/balancedGoogleMapsRunService.test.ts
```

Change exported/imported names to `executeBalancedGoogleMapsRun`, `BalancedGoogleMapsRunDeps`, `BalancedGoogleMapsExecutionOptions`, and `BalancedGoogleMapsRunOutcome`. Update `src/domain/runService.ts` to import the new module and call the renamed function in Standard and Hybrid branches.

- [ ] **Step 2: Replace the old Docker-first assertion with a failing provider-overlap test**

```ts
it('starts Google immediately while the first Docker batch is still running', async () => {
  const run: RunRecord = { id: 1, status: 'queued', leadSource: 'google_maps', actorId: 'local_first', maxResults: 20, leadCount: 0 };
  const state = fakeStore(run);
  let releaseDocker!: () => void;
  const dockerGate = new Promise<void>((resolve) => { releaseDocker = resolve; });
  let googleStarted = false;
  let dockerFinished = false;

  const execution = executeBalancedGoogleMapsRun({
    store: state.store,
    localClient: {
      async search() { return []; },
      async health() { return true; },
      async searchBatch({ batch }) {
        await dockerGate;
        dockerFinished = true;
        return { batchKey: batch.key, jobId: 'docker-1', rawBusinessCount: 1, items: [{ title: 'Docker Co', website: 'https://docker.example.com' }] };
      },
    },
    googleClient: {
      async search(input) {
        googleStarted = true;
        expect(dockerFinished).toBe(false);
        await input.onRequestEvent?.({ type: 'attempted', requestCount: 1, budget: 50 });
        await input.onRequestEvent?.({ type: 'succeeded', requestCount: 1, budget: 50, httpStatus: 200 });
        await input.onPage?.({ shard: 1, shardCount: 1, query: 'dentist Austin, TX', items: [{ id: 'google-1', displayName: { text: 'Google Co' } }], totalItemCount: 1 });
        return [{ id: 'google-1', displayName: { text: 'Google Co' } }];
      },
    },
  }, run, {
    leadSource: 'google_maps', maxResults: 20, googleApiKey: 'secret',
    googleMaps: { provider: 'local_first', searchTerms: ['dentist'], locations: ['Austin, TX'], apiRequestBudget: 50 },
  });

  await Promise.resolve();
  expect(googleStarted).toBe(true);
  releaseDocker();
  await execution;
  expect(run).toMatchObject({ status: 'completed', googleBusinessCount: 1, localBusinessCount: 1, apiRequestsUsed: 1 });
});
```

- [ ] **Step 3: Add failing global email-queue and cross-source deduplication tests**

```ts
it('uses one email scanner queue and merges overlapping provider businesses', async () => {
  const run: RunRecord = { id: 2, status: 'queued', leadSource: 'google_maps', actorId: 'local_first', maxResults: 20, leadCount: 0 };
  const state = fakeStore(run);
  let active = 0;
  let peak = 0;
  const extractor = {
    async extract(url: string) {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return [url.includes('shared') ? 'sales@shared.example.com' : 'sales@unique.example.com'];
    },
  };

  await executeBalancedGoogleMapsRun({
    store: state.store,
    emailExtractor: extractor,
    emailConcurrency: 50,
    localClient: {
      async search() { return []; }, async health() { return true; },
      async searchBatch({ batch }) {
        return { batchKey: batch.key, jobId: 'local', rawBusinessCount: 1, items: [{ title: 'Shared Co', phone: '555-0100', website: 'https://shared.example.com' }] };
      },
    },
    googleClient: {
      async search(input) {
        const item = { id: 'shared', displayName: { text: 'Shared Co' }, nationalPhoneNumber: '555-0100', websiteUri: 'https://shared.example.com' };
        await input.onPage?.({ shard: 1, shardCount: 1, query: 'shared', items: [item], totalItemCount: 1 });
        return [item];
      },
    },
  }, run, {
    leadSource: 'google_maps', maxResults: 20, googleApiKey: 'secret',
    googleMaps: { provider: 'local_first', searchTerms: ['shared'], locations: ['Austin, TX'], apiRequestBudget: 50 },
  });

  expect(peak).toBeLessThanOrEqual(50);
  expect(state.businesses).toHaveLength(1);
  expect(state.leads).toHaveLength(1);
  expect(peak).toBe(1);
  expect(run.duplicateCount).toBeGreaterThanOrEqual(1);
});
```

Add this complete partial-provider failure matrix:

```ts
it.each([
  { name: 'Google fails and Docker succeeds', googleFails: true, localFails: false, expectedEvent: 'google_places_failed' },
  { name: 'Docker fails and Google succeeds', googleFails: false, localFails: true, expectedEvent: 'local_batch_failed' },
])('$name', async ({ googleFails, localFails, expectedEvent }) => {
  const run: RunRecord = { id: 3, status: 'queued', leadSource: 'google_maps', actorId: 'local_first', maxResults: 10, leadCount: 0 };
  const state = fakeStore(run);
  await executeBalancedGoogleMapsRun({
    store: state.store,
    localClient: {
      async search() { return []; }, async health() { return true; },
      async searchBatch({ batch }) {
        if (localFails) throw new LocalScraperError('failed', 'Docker failed');
        return { batchKey: batch.key, jobId: 'local-ok', rawBusinessCount: 1, items: [{ title: 'Docker Co' }] };
      },
    },
    googleClient: {
      async search(input) {
        if (googleFails) throw new GooglePlacesError('forbidden', 'Google forbidden', 403);
        const item = { id: 'google-ok', displayName: { text: 'Google Co' } };
        await input.onPage?.({ shard: 1, shardCount: 1, query: 'dentist', items: [item], totalItemCount: 1 });
        return [item];
      },
    },
  }, run, {
    leadSource: 'google_maps', maxResults: 10, googleApiKey: 'secret',
    googleMaps: { provider: 'local_first', searchTerms: ['dentist'], locations: ['Austin, TX'], apiRequestBudget: 50 },
  });

  expect(run.status).toBe('completed');
  expect(state.businesses).toHaveLength(1);
  expect(state.events.some((event) => event.type === expectedEvent)).toBe(true);
});

it('rejects when both providers fail before producing businesses', async () => {
  const run: RunRecord = { id: 4, status: 'queued', leadSource: 'google_maps', actorId: 'local_first', maxResults: 10, leadCount: 0 };
  const state = fakeStore(run);
  await expect(executeBalancedGoogleMapsRun({
    store: state.store,
    localClient: {
      async search() { return []; }, async health() { return true; },
      async searchBatch() { throw new LocalScraperError('failed', 'Docker failed'); },
    },
    googleClient: {
      async search() { throw new GooglePlacesError('forbidden', 'Google forbidden', 403); },
    },
  }, run, {
    leadSource: 'google_maps', maxResults: 10, googleApiKey: 'secret',
    googleMaps: { provider: 'local_first', searchTerms: ['dentist'], locations: ['Austin, TX'], apiRequestBudget: 50 },
  })).rejects.toThrow('both failed');
});
```

Update the fake store's existing-business branch so test behavior matches Prisma's source union:

```ts
if (existing) {
  existing.provenance = [...new Set([...(existing.provenance ?? []), ...(business.provenance ?? [])])];
  Object.assign(existing, { ...business, provenance: existing.provenance });
  return 'merged';
}
```

For the existing empty-circuit test, replace the old order assertion with:

```ts
expect(state.events.findIndex((event) => event.type === 'google_places_started'))
  .toBeLessThan(state.events.findIndex((event) => event.type === 'local_empty_circuit_opened'));
expect(localCalls).toBe(3);
```

- [ ] **Step 4: Run the renamed tests and verify sequential behavior fails**

Run: `npx vitest run tests/domain/balancedGoogleMapsRunService.test.ts tests/domain/runService.test.ts`

Expected: FAIL because Google currently starts only after all Docker checkpoints finish and the new queue/event contracts are not implemented.

- [ ] **Step 5: Build the balanced run state and serialized ingestion helpers**

In `executeBalancedGoogleMapsRun`, initialize:

```ts
const persistenceQueue = new SerialTaskQueue();
const emailQueue = new SerialTaskQueue();
const emailTasks: Promise<void>[] = [];
const seenEmails = new Set(persistedBusinesses.flatMap((business) => business.emails ?? []).map((email) => email.toLowerCase()));
const seenProviderRecords = new Set<string>();
const seenWebsiteScans = new Set<string>();
let leadCount = run.leadCount ?? seenEmails.size;
let duplicateCount = run.duplicateCount ?? 0;
let apiRequestsUsed = run.apiRequestsUsed ?? 0;
let googleKeyAccepted = false;
```

Add a provider ingestion function with this exact ownership split:

```ts
async function ingestProviderItems(items: unknown[], provenance: 'local' | 'google'): Promise<void> {
  const normalized = applyLeadQualityFilters(items.map((item) => normalizeLead(item, 'google_maps')), filters);
  await persistenceQueue.enqueue(async () => {
    const scanCandidates: NormalizedLead[] = [];
    for (const lead of normalized) {
      const providerKey = `${provenance}:${businessIdentity(lead)}`;
      if (seenProviderRecords.has(providerKey)) continue;
      seenProviderRecords.add(providerKey);
      const outcome = await store.upsertBusiness(run.id, businessWrite(lead, provenance));
      if (outcome === 'merged') duplicateCount += 1;
      const scanKey = `${businessIdentity(lead)}:${lead.website ?? ''}`;
      if ((lead.email || lead.website) && !seenWebsiteScans.has(scanKey)) {
        seenWebsiteScans.add(scanKey);
        scanCandidates.push(lead);
      }
    }

    const businesses = await store.listBusinesses(run.id);
    persistedBusinesses = businesses;
    await store.updateRun(run.id, { ...metrics(businesses), duplicateCount, leadCount, apiRequestsUsed });
    if (!scanCandidates.length) return;

    emailTasks.push(emailQueue.enqueue(async () => {
      await store.addEvent(run.id, 'email_scan_started', `Scanning ${scanCandidates.length} websites for emails.`, {
        provider: provenance, websiteCount: scanCandidates.filter((lead) => Boolean(lead.website)).length,
        concurrency: emailConcurrency,
      });
      const candidates = await keepEmailLeadsOnly(scanCandidates, emailExtractor, emailConcurrency);
      await persistenceQueue.enqueue(async () => {
        const fresh = candidates.filter((lead) => {
          if (!lead.email) return false;
          const key = lead.email.toLowerCase();
          if (seenEmails.has(key)) return false;
          seenEmails.add(key);
          return true;
        });
        if (fresh.length) await store.addLeads(run.id, fresh);
        leadCount += fresh.length;
        await store.updateRun(run.id, { leadCount, apiRequestsUsed });
        await store.addEvent(run.id, 'email_scan_completed', `Saved ${leadCount} unique email leads.`, {
          provider: provenance, leadCount, newLeadCount: fresh.length,
        });
      });
    }));
  });
}
```

Do not await `emailTasks` inside provider page/batch callbacks; this keeps provider discovery in flight. Await `emailQueue.drain()`, `Promise.allSettled(emailTasks)`, then `persistenceQueue.drain()` before final status.

- [ ] **Step 6: Implement concurrent provider tasks**

Start the Google task before awaiting either task:

```ts
type ProviderState = 'completed' | 'failed' | 'waiting_for_scraper' | 'waiting_for_credentials';

async function recordProviderFailure(provider: 'google_places' | 'local_maps_scraper', error: unknown): Promise<void> {
  const message = safeErrorMessage(error);
  await store.addErrorLog({
    runId: run.id,
    source: 'balancedGoogleMapsRunService',
    severity: 'warn',
    message,
    details: { provider },
  });
  await store.addEvent(run.id, `${provider}_failed`, `${provider === 'google_places' ? 'Google Places' : 'Docker'} failed: ${message}`, {
    provider,
  });
}

const googleTask = (async (): Promise<'completed' | 'failed' | 'waiting_for_credentials'> => {
  if (!input.googleApiKey) return 'waiting_for_credentials';
  await store.addEvent(run.id, 'google_places_started', 'Google Places discovery started.', {
    provider: 'google_places', requestBudget: filters.apiRequestBudget ?? 50,
  });
  try {
    await googleClient?.search({
      apiKey: input.googleApiKey,
      apiKeys: input.googleApiKeys,
      filters,
      maxResults: input.maxResults,
      requestBudget: filters.apiRequestBudget ?? 50,
      shouldStop: () => persistedBusinesses.length >= input.maxResults,
      onRequestEvent: async (event) => {
        if (event.type === 'attempted') {
          apiRequestsUsed = event.requestCount;
          await persistenceQueue.enqueue(async () => {
            await store.updateRun(run.id, { apiRequestsUsed });
            await store.addEvent(run.id, 'google_request_attempted', `Google request ${apiRequestsUsed}/${event.budget} sent.`, {
              requestCount: apiRequestsUsed, requestBudget: event.budget,
            });
          });
        } else if (event.type === 'succeeded' && !googleKeyAccepted) {
          googleKeyAccepted = true;
          await store.addEvent(run.id, 'google_key_accepted', 'Google API key accepted by the first live request.');
        }
      },
      onPage: async (event) => {
        await ingestProviderItems(event.items, 'google');
        await store.addEvent(run.id, 'google_places_page_completed', `Google returned ${event.items.length} new businesses.`, {
          shard: event.shard, shardCount: event.shardCount, itemCount: event.items.length,
          totalItemCount: event.totalItemCount,
        });
      },
    });
    await store.addEvent(run.id, 'google_places_completed', 'Google Places discovery completed.', { apiRequestsUsed });
    return 'completed';
  } catch (error) {
    await recordProviderFailure('google_places', error);
    return 'failed';
  }
})();

const localTask = runLocalDiscoveryBatches();
const [googleResult, localResult] = await Promise.allSettled([googleTask, localTask]);
```

Define `runLocalDiscoveryBatches` as `async function runLocalDiscoveryBatches(): Promise<ProviderState>`. Move the existing Docker batch/checkpoint loop into it; preserve retry, `skipped_empty_circuit`, resume, and target checks. Replace its direct normalization/upsert/email block with `await ingestProviderItems(result.items, 'local')`. Return `'completed'`, `'failed'`, or `'waiting_for_scraper'` rather than finalizing the run inside the provider task.

Track whether any local batch completed successfully. If every runnable batch terminates as failed and no previously persisted local business exists, return `'failed'`; a completed zero-result batch still counts as a valid local completion and continues to use the three-empty-batch circuit.

After queues drain, compute final metrics and apply:

```ts
const providerStates = [
  googleResult.status === 'fulfilled' ? googleResult.value : 'failed',
  localResult.status === 'fulfilled' ? localResult.value : 'failed',
];
const finalBusinesses = await store.listBusinesses(run.id);
if (providerStates.includes('waiting_for_credentials')) {
  await store.updateRun(run.id, { status: 'waiting_for_credentials', ...metrics(finalBusinesses), duplicateCount, leadCount, apiRequestsUsed });
  return { status: 'waiting_for_credentials', leadCount, businessCount: finalBusinesses.length, seenEmails };
}
if (providerStates.every((state) => state === 'failed') && finalBusinesses.length === 0) {
  throw new Error('Google Places and Docker discovery both failed before producing businesses.');
}
if (options.finalize === false) {
  await store.updateRun(run.id, { status: 'running', ...metrics(finalBusinesses), duplicateCount, leadCount, apiRequestsUsed });
  return { status: 'running', leadCount, businessCount: finalBusinesses.length, seenEmails };
}
await store.updateRun(run.id, { status: 'completed', actorId: 'local_first', datasetId: 'balanced_google_docker', ...metrics(finalBusinesses), duplicateCount, leadCount, apiRequestsUsed });
await store.addEvent(run.id, 'run_completed', 'Standard Google and Docker run completed.', {
  leadCount, businessCount: finalBusinesses.length, apiRequestsUsed,
});
return { status: 'completed', leadCount, businessCount: finalBusinesses.length, seenEmails };
```

- [ ] **Step 7: Keep Hybrid additive and Standard automatic in `runService`**

Use `executeBalancedGoogleMapsRun(..., { finalize: false })` for Hybrid, then pass `outcome.seenEmails` and `outcome.leadCount` into `runApifyShards`. Use the same function with default finalization for Standard. Do not add Apify calls to the Standard branch.

Update run-service tests with exact provider assertions:

```ts
expect(actorClient.startRun).not.toHaveBeenCalled(); // Standard
expect(events).toContainEqual(expect.objectContaining({ type: 'google_places_started' }));
expect(events).toContainEqual(expect.objectContaining({ type: 'local_batch_started' }));
expect(actorClient.startRun).toHaveBeenCalled(); // Hybrid only
```

- [ ] **Step 8: Run orchestration tests and commit**

Run: `npx vitest run tests/domain/balancedGoogleMapsRunService.test.ts tests/domain/runService.test.ts tests/domain/prismaRunStore.test.ts`

Expected: PASS with concurrent-provider, partial-failure, checkpoint, circuit, deduplication, email, request-count, Standard, and Hybrid coverage.

```powershell
git add src/domain/balancedGoogleMapsRunService.ts src/domain/runService.ts tests/domain/balancedGoogleMapsRunService.test.ts tests/domain/runService.test.ts
git add -u src/domain/localFirstRunService.ts tests/domain/localFirstRunService.test.ts
git commit -m "feat: run Google and Docker as a balanced pipeline"
```

---

### Task 6: Accurate balanced-mode dashboard progress

**Files:**
- Modify: `tests/public/staticUi.test.ts`
- Modify: `public/index.html:50-114,184-203`
- Modify: `public/app.js:87-110,215-285,320-340`
- Modify: `public/styles.css` only if the new compact metric row requires existing token-aligned layout rules.

**Interfaces:**
- Consumes: run detail fields `businessCount`, `localBusinessCount`, `googleBusinessCount`, `websiteCount`, `duplicateCount`, `leadCount`, `apiRequestBudget`, `apiRequestsUsed`, `batches`; provider events from Task 5.
- Produces: a 50-request default, accurate simultaneous provider phase copy, and redacted live counts.

- [ ] **Step 1: Add failing static UI contract tests**

```ts
// append to tests/public/staticUi.test.ts
it('describes Standard as concurrent Google and Docker discovery with a 50-request default', () => {
  const html = readPublicFile('index.html');
  const appJs = readPublicFile('app.js');
  expect(html).toContain('Google and Docker start together');
  expect(html).toContain('id="gmApiBudget" type="number" min="1" max="500" value="50"');
  expect(appJs).toContain("numberValue('gmApiBudget') ?? 50");
  expect(html).not.toContain('Docker runs first');
});

it('shows provider, website, duplicate, and API attempt counts in live progress', () => {
  const html = readPublicFile('index.html');
  const appJs = readPublicFile('app.js');
  for (const id of ['progressGoogle', 'progressDocker', 'progressWebsites', 'progressDuplicates', 'progressApi']) {
    expect(html).toContain(`id="${id}"`);
  }
  expect(appJs).toContain('run.googleBusinessCount');
  expect(appJs).toContain('run.localBusinessCount');
  expect(appJs).toContain('run.websiteCount');
  expect(appJs).toContain('run.duplicateCount');
  expect(appJs).toContain('run.apiRequestsUsed');
  expect(appJs).toContain('run.apiRequestBudget');
});

it('recognizes simultaneous provider and actionable Google states', () => {
  const appJs = readPublicFile('app.js');
  expect(appJs).toContain('google_places_started');
  expect(appJs).toContain('local_batch_started');
  expect(appJs).toContain('google_key_accepted');
  expect(appJs).toContain('google_places_failed');
  expect(appJs).toContain('local_empty_circuit_opened');
});
```

- [ ] **Step 2: Run the UI tests and verify old Docker-first copy fails**

Run: `npx vitest run tests/public/staticUi.test.ts`

Expected: FAIL because the UI still says Docker runs first, defaults to 25, and lacks provider/request metric elements.

- [ ] **Step 3: Update form copy and live metric markup**

Use:

```html
<small id="pipelineSummary" class="field-help">Google and Docker start together; Google stays inside your request budget.</small>
```

Replace the budget control with:

```html
<label>
  <span>Google Request Budget</span>
  <input id="gmApiBudget" type="number" min="1" max="500" value="50">
</label>
```

Add inside the progress panel after `.progress-shell`:

```html
<div class="progress-metrics" aria-live="polite">
  <span id="progressGoogle">Google 0</span>
  <span id="progressDocker">Docker 0</span>
  <span id="progressWebsites">Websites 0</span>
  <span id="progressDuplicates">Duplicates 0</span>
  <span id="progressApi">API 0/50</span>
</div>
```

- [ ] **Step 4: Make stage calculation reflect simultaneous providers**

Replace `progressStage` with:

```js
function progressStage(events, status) {
  const types = events.map((event) => event.type);
  if (status === 'completed') return 'Completed';
  if (status === 'failed') return 'Failed — review the error below';
  if (status === 'waiting_for_scraper') return 'Docker unavailable — Google progress is preserved';
  if (status === 'waiting_for_credentials') return 'Google credentials required — Docker progress is preserved';
  if (types.includes('apify_shard_started')) return 'Apify is expanding Hybrid Max Output coverage';
  const googleActive = types.includes('google_places_started') && !types.includes('google_places_completed') && !types.includes('google_places_failed');
  const dockerActive = types.includes('local_batch_started') && !types.includes('local_empty_circuit_opened');
  if (googleActive && dockerActive) return 'Google API and Docker are discovering businesses';
  if (googleActive) return types.includes('google_key_accepted') ? 'Google API is discovering businesses' : 'Google API is validating the first live request';
  if (dockerActive) return 'Docker is discovering supplemental businesses';
  if (types.includes('local_empty_circuit_opened')) return 'Docker paused after empty batches — Google continues';
  if (types.includes('google_places_failed')) return 'Google failed — Docker continues';
  return status === 'queued' ? 'Preparing Google and Docker' : status;
}
```

Change the submitted fallback to `numberValue('gmApiBudget') ?? 50`. In `checkProgress`, set:

```js
$('progressGoogle').textContent = 'Google ' + (run.googleBusinessCount || 0);
$('progressDocker').textContent = 'Docker ' + (run.localBusinessCount || 0);
$('progressWebsites').textContent = 'Websites ' + (run.websiteCount || 0);
$('progressDuplicates').textContent = 'Duplicates ' + (run.duplicateCount || 0);
$('progressApi').textContent = 'API ' + (run.apiRequestsUsed || 0) + '/' + (run.apiRequestBudget || 50);
```

Update `updatePipelineSummary` so Standard says `Google and Docker start together; Google stays inside your request budget.` and Hybrid says `Google and Docker start together, then Apify expands maximum-output coverage.`

- [ ] **Step 5: Add restrained metric layout only if existing styles do not cover it**

```css
.progress-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 8px;
  margin-top: 12px;
}

.progress-metrics span {
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-2);
  color: var(--muted);
  font-size: 0.78rem;
}
```

- [ ] **Step 6: Run UI tests and commit**

Run: `npx vitest run tests/public/staticUi.test.ts`

Expected: PASS.

```powershell
git add public/index.html public/app.js public/styles.css tests/public/staticUi.test.ts
git commit -m "feat: show balanced provider progress and API usage"
```

---

### Task 7: Integrated regression and controlled smoke verification

**Files:**
- Modify only if a failure reveals a regression in files already listed above.
- Record no API keys, tokens, proxy URLs, raw HTML, or CSV contents in test snapshots or committed artifacts.

**Interfaces:**
- Consumes: all Tasks 1–6.
- Produces: a passing build/test suite and evidence that local runtime services are healthy before any controlled external smoke request.

- [ ] **Step 1: Run the complete TypeScript and Vitest checks**

Run:

```powershell
npm run build
npm test
```

Expected: TypeScript exits `0`; every Vitest file passes with no unhandled rejection.

- [ ] **Step 2: Run repository whitespace and secret-name checks**

Run:

```powershell
git diff --check
rg -n "google-secret-key|request-scoped-secret|apify-token|socks5h://user:pass" src public prisma docs/superpowers/plans
```

Expected: `git diff --check` prints nothing. The sentinel search may match documentation/test examples only; it must not match runtime configuration, database files, logs, or generated exports.

- [ ] **Step 3: Verify local service health without external cost**

Run:

```powershell
Invoke-RestMethod http://127.0.0.1:4177/api/health
Invoke-RestMethod http://127.0.0.1:4177/api/scraper/health
docker inspect --format '{{json .State.Health.Status}}' leads-genx-gmaps-scraper
```

Expected: Leads-GenX reports `status: ok`; scraper health reports `ok: true`; Docker reports `"healthy"`.

- [ ] **Step 4: Perform the controlled Standard smoke run only with a freshly entered operator key**

Use the dashboard with:

```text
Mode: Standard — Docker + Google
Search term: dentist
Location: Austin, TX
Max Results: 20
Google Request Budget: 2
Minimum Rating: blank
Minimum Reviews: blank
```

Expected live evidence:

```text
google_places_started appears before any Docker completion requirement
local_batch_started appears while Google is active
apiRequestsUsed advances from 0 and never exceeds 2
google_key_accepted appears only after a successful real request
Docker job payload uses email=false
businesses are saved incrementally
website scanning reports concurrency=50
the run completes or completes with a provider warning without an internal server error
```

Do not place the entered key in a shell command, screenshot, log excerpt, plan update, or Git-tracked file.

- [ ] **Step 5: Inspect the run for count and redaction integrity**

Read the latest run ID from the local API, then inspect that exact run:

```powershell
$smokeRunId = (Invoke-RestMethod http://127.0.0.1:4177/api/runs).data[0].id
Invoke-RestMethod "http://127.0.0.1:4177/api/runs/$smokeRunId"
Invoke-RestMethod "http://127.0.0.1:4177/api/runs/$smokeRunId/events"
```

Expected: `apiRequestsUsed <= apiRequestBudget`; Google and Docker business counts sum consistently with cross-source deduplication; no credential value appears in either response; event messages identify the active provider and any actionable error.

- [ ] **Step 6: Commit any verified integration-only corrections, then confirm clean status**

If Steps 1–5 required corrections in already scoped files:

```powershell
git add src public tests
git commit -m "fix: close balanced pipeline integration gaps"
```

Then run:

```powershell
git status --short
git log -7 --oneline
```

Expected: no uncommitted implementation changes; recent commits show the query/budget, Google client, Docker discovery-only, queue, orchestrator, UI, and any integration correction commits.

---

## Completion Gate

The work is complete only when:

- Standard starts Google and Docker without waiting for either provider to finish first.
- A two-request smoke budget produces at most two actual Google HTTP attempts and the UI/database both report that exact number.
- Docker-created jobs visibly use `email: false`.
- Application website scanning is globally bounded at 50 for the run.
- Standalone company types are absent from mixed-criteria query plans.
- Google-only and Docker-only partial failures preserve useful output.
- Hybrid adds Apify after the balanced stage; Standard never calls Apify.
- The build and complete test suite pass.
- The controlled smoke run has no internal server error and no credential leakage.
