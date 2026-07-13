# Google-Only Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Google Places runs collect larger deduped business sets and extract more email-only leads without requiring Apify.

**Architecture:** Keep the current Express, Prisma, and vanilla JS structure. Upgrade the existing Google Places integration with shard progress, key fallback, per-shard continuation, and business dedupe; upgrade the website email extractor with deeper contact discovery. Run lifecycle remains owned by `createRunService`.

**Tech Stack:** TypeScript, Express, Prisma SQLite, Vitest, Supertest, official Google Places Text Search API, HTTP website crawling through `fetch`.

## Global Constraints

- Google-only runs use official Google Places API plus business website crawling.
- No browser-based Google Maps scraping.
- No CAPTCHA bypass, stealth automation, or account/session automation.
- Apify remains optional and additive.
- Output remains email-only TXT, one email per line.
- Secrets must remain redacted in logs, events, API responses, and tests.
- Run `npm.cmd test` and `npm.cmd run build` before completion.

---

### Task 1: Google Places Shard Progress And Dedupe

**Files:**
- Modify: `src/integrations/googlePlacesClient.ts`
- Test: `tests/integrations/googlePlacesClient.test.ts`

**Interfaces:**
- Consumes: `buildGoogleMapsSearchQueries(filters: GoogleMapsFilters): string[]`
- Produces: `GooglePlacesSearchInput.onShardEvent?: (event: GooglePlacesShardEvent) => Promise<void> | void`
- Produces: `GooglePlacesShardEvent = { type: 'started' | 'completed' | 'failed'; shard: number; shardCount: number; query: string; itemCount?: number; totalItemCount?: number; errorMessage?: string }`

- [ ] **Step 1: Write failing tests**

Add these tests to `tests/integrations/googlePlacesClient.test.ts`:

```ts
  it('dedupes Google Places results across overlapping shards', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return Response.json({
          places: [
            {
              id: 'same-place',
              displayName: { text: `Shared ${body.textQuery}` },
              websiteUri: 'https://shared.example.com',
            },
          ],
        });
      })
    );

    const client = new GooglePlacesApiClient();
    const places = await client.search({
      apiKey: 'google-one',
      maxResults: 100,
      filters: {
        searchTerms: ['oilfield services'],
        categoryFilters: ['Oil & Gas'],
        locations: ['Houston, TX'],
      },
    });

    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ id: 'same-place' });
  });

  it('reports shard progress and continues after one shard fails', async () => {
    const events: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (body.textQuery.includes('Oil & Gas')) {
          return new Response(JSON.stringify({ error: { message: 'temporary quota' } }), { status: 429 });
        }
        return Response.json({
          places: [{ id: body.textQuery, websiteUri: `https://${encodeURIComponent(body.textQuery)}.example.com` }],
        });
      })
    );

    const client = new GooglePlacesApiClient();
    const places = await client.search({
      apiKey: 'google-one',
      maxResults: 100,
      filters: {
        searchTerms: ['oilfield services'],
        categoryFilters: ['Oil & Gas'],
        locations: ['Houston, TX'],
      },
      onShardEvent: (event) => events.push(event),
    });

    expect(places.length).toBeGreaterThan(0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'started', shard: 1 }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'failed', errorMessage: 'Google Places request failed with status 429' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'completed', itemCount: 1 }));
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm.cmd test -- tests/integrations/googlePlacesClient.test.ts`

Expected: new tests fail because `onShardEvent` and dedupe are not implemented.

- [ ] **Step 3: Implement minimal Google Places progress and dedupe**

Update `src/integrations/googlePlacesClient.ts`:

```ts
export interface GooglePlacesShardEvent {
  type: 'started' | 'completed' | 'failed';
  shard: number;
  shardCount: number;
  query: string;
  itemCount?: number;
  totalItemCount?: number;
  errorMessage?: string;
}

export interface GooglePlacesSearchInput {
  apiKey: string;
  apiKeys?: string[];
  filters: GoogleMapsFilters;
  maxResults: number;
  onShardEvent?: (event: GooglePlacesShardEvent) => Promise<void> | void;
}
```

Inside `search`, add helpers:

```ts
function placeKey(place: unknown): string {
  const item = place && typeof place === 'object' ? (place as Record<string, unknown>) : {};
  const displayName = item.displayName && typeof item.displayName === 'object'
    ? (item.displayName as Record<string, unknown>).text
    : undefined;
  return [
    item.id,
    item.name,
    item.googleMapsUri,
    item.websiteUri,
    item.internationalPhoneNumber,
    item.nationalPhoneNumber,
    displayName,
    item.formattedAddress,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('|')
    .toLowerCase();
}
```

Use a `seenPlaces` set. Emit shard events before and after each query. Catch query-level errors, emit a failed event, and continue to the next query unless no places have been collected and this is the final shard.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm.cmd test -- tests/integrations/googlePlacesClient.test.ts`

Expected: all Google Places integration tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/googlePlacesClient.ts tests/integrations/googlePlacesClient.test.ts
git commit -m "feat: scale google places source collection"
```

### Task 2: Run Service Google Progress Events

**Files:**
- Modify: `src/domain/runService.ts`
- Test: `tests/domain/runService.test.ts`

**Interfaces:**
- Consumes: `GooglePlacesSearchInput.onShardEvent`
- Produces run events: `google_places_shard_started`, `google_places_shard_completed`, `google_places_shard_failed`

- [ ] **Step 1: Write failing test**

Add this test to `tests/domain/runService.test.ts`:

```ts
  it('records Google Places shard progress for Google-only runs', async () => {
    const store = createStore();
    const actorClient: ActorClient = {
      async startRun() {
        throw new Error('Apify should not run for Google Places');
      },
      async getRun() {
        throw new Error('not used');
      },
      async getDatasetItems() {
        return [];
      },
    };
    const googlePlacesClient: GooglePlacesClient = {
      async search(input) {
        await input.onShardEvent?.({
          type: 'started',
          shard: 1,
          shardCount: 2,
          query: 'oilfield services Houston, TX',
        });
        await input.onShardEvent?.({
          type: 'completed',
          shard: 1,
          shardCount: 2,
          query: 'oilfield services Houston, TX',
          itemCount: 2,
          totalItemCount: 2,
        });
        await input.onShardEvent?.({
          type: 'failed',
          shard: 2,
          shardCount: 2,
          query: 'Oil & Gas Houston, TX',
          errorMessage: 'Google Places request failed with status 429',
        });
        return [{ displayName: { text: 'Gulf Energy' }, websiteUri: 'https://gulf.example.com' }];
      },
    };
    const emailExtractor: EmailExtractor = {
      async extract() {
        return ['sales@gulf.example.com'];
      },
    };

    const service = createRunService({ store, actorClient, googlePlacesClient, emailExtractor });
    await service.startRun(
      {
        googleApiKey: 'google-one',
        leadSource: 'google_maps',
        maxResults: 1000,
        googleMaps: {
          provider: 'google_places',
          searchTerms: ['oilfield services'],
          locations: ['Houston, TX'],
        },
      },
      { background: false }
    );

    expect(store.events).toContainEqual(expect.objectContaining({ type: 'google_places_shard_started' }));
    expect(store.events).toContainEqual(expect.objectContaining({ type: 'google_places_shard_completed' }));
    expect(store.events).toContainEqual(expect.objectContaining({ type: 'google_places_shard_failed' }));
    expect(store.runs[0]).toMatchObject({ status: 'completed', leadCount: 1 });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd test -- tests/domain/runService.test.ts`

Expected: TypeScript/test failure because `onShardEvent` is not passed through or event types are missing.

- [ ] **Step 3: Implement run event mapping**

In `runGooglePlaces`, pass `onShardEvent` to `googlePlacesClient.search`:

```ts
      onShardEvent: async (event) => {
        if (event.type === 'started') {
          await store.addEvent(run.id, 'google_places_shard_started', `Google Places shard ${event.shard}/${event.shardCount} started.`, event);
        } else if (event.type === 'completed') {
          await store.addEvent(run.id, 'google_places_shard_completed', `Google Places shard ${event.shard}/${event.shardCount} returned ${event.itemCount ?? 0} businesses.`, event);
        } else {
          await store.addErrorLog({
            runId: run.id,
            source: 'runService',
            severity: 'warn',
            message: event.errorMessage ?? 'Google Places shard failed',
            details: event,
          });
          await store.addEvent(run.id, 'google_places_shard_failed', `Google Places shard ${event.shard}/${event.shardCount} failed: ${event.errorMessage ?? 'unknown error'}`, event);
        }
      },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm.cmd test -- tests/domain/runService.test.ts`

Expected: all run service tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/domain/runService.ts tests/domain/runService.test.ts
git commit -m "feat: show google places shard progress"
```

### Task 3: Deeper Website Email Discovery

**Files:**
- Modify: `src/domain/emailExtractor.ts`
- Test: `tests/domain/emailExtractor.test.ts`

**Interfaces:**
- Consumes: `WebsiteEmailExtractor.extract(url: string): Promise<string[]>`
- Produces: deeper path list and stronger internal contact-link discovery without changing the public method signature.

- [ ] **Step 1: Write failing test**

Add this test to `tests/domain/emailExtractor.test.ts`:

```ts
  it('discovers sales, quote, branch, and directory pages from internal links', async () => {
    const originalFetch = global.fetch;
    const pages = new Map([
      [
        'https://example.com/',
        '<a href="/request-quote">Quote</a><a href="/branch-directory">Branches</a><a href="/privacy">Privacy</a>',
      ],
      ['https://example.com/request-quote', 'Quotes: quote@example.com'],
      ['https://example.com/branch-directory', 'Branches: branches@example.com'],
      ['https://example.com/privacy', 'Privacy: privacy@example.com'],
    ]);
    global.fetch = (async (input) => {
      const html = pages.get(String(input));
      return new Response(html ?? '', { status: html ? 200 : 404 });
    }) as typeof fetch;

    try {
      const extractor = new WebsiteEmailExtractor({ maxPagesPerSite: 5 });
      await expect(extractor.extract('https://example.com')).resolves.toEqual([
        'quote@example.com',
        'branches@example.com',
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd test -- tests/domain/emailExtractor.test.ts`

Expected: the new test fails because quote and branch directory links are not discovered.

- [ ] **Step 3: Implement deeper contact discovery**

Update `CONTACT_PATHS` with:

```ts
  '/request-quote',
  '/quote',
  '/get-a-quote',
  '/services',
  '/service-areas',
  '/branches',
  '/branch-directory',
  '/directory',
  '/locations/contact',
```

Update `CONTACT_LINK_PATTERN` to:

```ts
const CONTACT_LINK_PATTERN = /\b(contact|about|team|staff|sales|support|location|locations|leadership|quote|request quote|get a quote|service|services|branch|branches|directory|office|offices)\b/i;
```

Keep privacy/legal pages excluded by not adding those words.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm.cmd test -- tests/domain/emailExtractor.test.ts`

Expected: all email extractor tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/domain/emailExtractor.ts tests/domain/emailExtractor.test.ts
git commit -m "feat: deepen website email discovery"
```

### Task 4: Full Verification And Localhost Check

**Files:**
- Verify: all changed files

**Interfaces:**
- Consumes: all previous task outputs.
- Produces: verified local app on `http://localhost:4177`.

- [ ] **Step 1: Run full tests**

Run: `npm.cmd test`

Expected: all tests pass.

- [ ] **Step 2: Run TypeScript build**

Run: `npm.cmd run build`

Expected: `tsc` exits with code 0.

- [ ] **Step 3: Start local server**

Run: `npm.cmd run dev`

Expected: server responds at `http://localhost:4177/api/health`.

- [ ] **Step 4: Check git status**

Run: `git status --short`

Expected: only intended implementation files are modified if commits were skipped, or clean if all task commits succeeded.
