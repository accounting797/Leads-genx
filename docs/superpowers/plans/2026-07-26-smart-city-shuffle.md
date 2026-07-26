# Smart City Shuffle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Nova Arrange click deal a fresh, city-specific Google Maps or Sales Navigator filter combination without repeating a complete combination until the curated deck is exhausted.

**Architecture:** Replace the run-history-only selector with a source-aware domain selector that accepts browser deck history and injected randomness. A POST endpoint combines that browser history with user-scoped run performance, while the browser persists separate non-secret decks for Google Maps and Sales Navigator and applies only the active source's fields.

**Tech Stack:** TypeScript, Express, Prisma, Vitest, Supertest, vanilla browser JavaScript, localStorage.

## Global Constraints

- Google Maps receives exactly one search term, category, company type, and city.
- Sales Navigator receives exactly one title, canonical LinkedIn industry, city, and headcount.
- Complete combo IDs do not repeat until the combo deck is exhausted.
- Cities do not repeat until the city deck is exhausted; consecutive clicks never repeat a city or combo.
- Browser history is source-scoped and stores only combo IDs and city names.
- Existing run creation, provider routing, ingestion, and `comboId` persistence remain unchanged.
- A failed shuffle request leaves displayed filters and stored history unchanged.

---

### Task 1: Define Source-Aware Curated Combinations

**Files:**
- Modify: `src/domain/shuffleCombos.ts`
- Modify: `tests/domain/shuffleCombos.test.ts`

**Interfaces:**
- Produces: `ShuffleSource`, source-specific `ShuffleCombo` fields, `ShuffleRequest`, and `pickNextCombo(request, stats, random)`.
- Consumes: the existing Google Maps and Sales Navigator values in `src/domain/suggestions.ts`.

- [ ] **Step 1: Write failing contract tests**

Add tests that require every combo to expose valid values for both sources:

```ts
const mapsTerms = new Set(suggestions.googleMaps.searchTemplates);
const mapsCategories = new Set(suggestions.googleMaps.businessCategories);
const mapsTypes = new Set(suggestions.googleMaps.companyTypes);
const snTitles = new Set(suggestions.salesNavigator.titles);
const snIndustries = new Set(suggestions.salesNavigator.industries);
const snHeadcounts = new Set(suggestions.salesNavigator.headcounts);

for (const combo of SHUFFLE_COMBOS) {
  expect(mapsTerms.has(combo.googleMaps.searchTerm)).toBe(true);
  expect(mapsCategories.has(combo.googleMaps.category)).toBe(true);
  expect(mapsTypes.has(combo.googleMaps.companyType)).toBe(true);
  expect(snTitles.has(combo.salesNavigator.title)).toBe(true);
  expect(snIndustries.has(combo.salesNavigator.industry)).toBe(true);
  expect(snHeadcounts.has(combo.salesNavigator.headcount)).toBe(true);
}
```

Add selection tests with deterministic injected values:

```ts
it('does not repeat a combo or city during an active deck', () => {
  const first = SHUFFLE_COMBOS[0];
  const pick = pickNextCombo(
    {
      source: 'google_maps',
      recentComboIds: [first.id],
      recentCities: [first.city],
      currentComboId: first.id,
    },
    {},
    () => 0,
  );
  expect(pick.combo.id).not.toBe(first.id);
  expect(pick.combo.city).not.toBe(first.city);
});

it('visits every eligible city before resetting the city deck', () => {
  const cities = [...new Set(SHUFFLE_COMBOS.map((combo) => combo.city))];
  const current = SHUFFLE_COMBOS.find((combo) => combo.city === cities[0])!;
  const pick = pickNextCombo(
    {
      source: 'sales_navigator',
      recentComboIds: [current.id],
      recentCities: cities.slice(0, -1),
      currentComboId: current.id,
    },
    {},
    () => 0,
  );
  expect(pick.combo.city).toBe(cities.at(-1));
});

it('resets an exhausted deck without immediately repeating', () => {
  const current = SHUFFLE_COMBOS[0];
  const pick = pickNextCombo(
    {
      source: 'google_maps',
      recentComboIds: SHUFFLE_COMBOS.map((combo) => combo.id),
      recentCities: [...new Set(SHUFFLE_COMBOS.map((combo) => combo.city))],
      currentComboId: current.id,
    },
    {},
    () => 0,
  );
  expect(pick.combo.id).not.toBe(current.id);
  expect(pick.combo.city).not.toBe(current.city);
  expect(pick.updatedHistory.comboIds).toEqual([pick.combo.id]);
});
```

- [ ] **Step 2: Run the domain tests and verify RED**

Run:

```powershell
npm.cmd test -- tests/domain/shuffleCombos.test.ts
```

Expected: FAIL because the current combo shape is Google-only and the selector has no source, history, or randomness input.

- [ ] **Step 3: Implement the source-aware combo contract**

Use these public types:

```ts
export type ShuffleSource = 'google_maps' | 'sales_navigator';

export interface ShuffleCombo {
  id: string;
  label: string;
  city: string;
  rationale: string;
  googleMaps: { searchTerm: string; category: string; companyType: string };
  salesNavigator: { title: string; industry: string; headcount: string };
}

export interface ShuffleRequest {
  source: ShuffleSource;
  recentComboIds?: string[];
  recentCities?: string[];
  currentComboId?: string;
}
```

Keep the existing 24 market segments, but map each to canonical source values. Examples:

```ts
{
  id: 'owner-roofing-houston',
  label: 'Roofing owners — Houston',
  city: 'Houston, TX',
  googleMaps: { searchTerm: 'Owner', category: 'Roofing', companyType: 'Contractors' },
  salesNavigator: { title: 'Owner', industry: 'Construction', headcount: '1-10' },
  rationale: 'Owner-led roofers answer their own phone and email — the highest reply odds in local trades.',
}
```

Implement `pickNextCombo(request, stats, random = Math.random)` with this order:

1. Remove unknown combo IDs and cities from submitted history.
2. Exclude every combo already in the active combo deck.
3. Exclude every city already in the active city deck.
4. If no candidate remains because the city deck is exhausted, reset only the city deck while retaining the combo deck.
5. If the combo deck is exhausted, reset both decks.
6. Always exclude the current combo and its city from the immediate next pick.
7. Before all combos have completed runs, select uniformly from eligible combos.
8. Once all combos have completed runs, select with weight `1 + leads / max(1, runs)`.
9. Return source-specific filters and `updatedHistory`.

- [ ] **Step 4: Run the domain tests and verify GREEN**

Run:

```powershell
npm.cmd test -- tests/domain/shuffleCombos.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the domain selector**

```powershell
git add src/domain/shuffleCombos.ts tests/domain/shuffleCombos.test.ts
git commit -m "feat: add source-aware non-repeating Nova deck"
```

### Task 2: Accept Source and Deck History in the Shuffle API

**Files:**
- Modify: `src/routes/api.ts`
- Modify: `tests/api/shuffleApi.test.ts`

**Interfaces:**
- Consumes: `pickNextCombo(request, stats)` from Task 1.
- Produces: `POST /api/shuffle/next` returning `combo`, `filters`, learning metadata, and updated history.

- [ ] **Step 1: Write failing API tests**

Replace GET-only expectations with:

```ts
const res = await request(appWithRuns([]))
  .post('/api/shuffle/next')
  .send({
    source: 'google_maps',
    recentComboIds: [SHUFFLE_COMBOS[0].id],
    recentCities: [SHUFFLE_COMBOS[0].city],
    currentComboId: SHUFFLE_COMBOS[0].id,
  });

expect(res.status).toBe(200);
expect(res.body.data.combo.id).not.toBe(SHUFFLE_COMBOS[0].id);
expect(res.body.data.filters).toEqual({
  searchTerms: [res.body.data.combo.googleMaps.searchTerm],
  categoryFilters: [res.body.data.combo.googleMaps.category],
  companyTypes: [res.body.data.combo.googleMaps.companyType],
  locations: [res.body.data.combo.city],
});
```

Add a Sales Navigator case:

```ts
const res = await request(appWithRuns([]))
  .post('/api/shuffle/next')
  .send({ source: 'sales_navigator' });

expect(res.body.data.filters).toEqual({
  titles: [res.body.data.combo.salesNavigator.title],
  industries: [res.body.data.combo.salesNavigator.industry],
  geographies: [res.body.data.combo.city],
  headcounts: [res.body.data.combo.salesNavigator.headcount],
});
```

Add `400` coverage for an invalid source and prove unknown history values are ignored.

- [ ] **Step 2: Run the API tests and verify RED**

Run:

```powershell
npm.cmd test -- tests/api/shuffleApi.test.ts
```

Expected: FAIL because only `GET /api/shuffle/next` exists and it accepts no source or history.

- [ ] **Step 3: Implement the POST endpoint**

Change the route to POST, validate `req.body.source`, normalize array fields to strings, preserve the current user-scoped run-stat query, and call:

```ts
const pick = pickNextCombo(
  {
    source,
    recentComboIds: stringList(req.body.recentComboIds),
    recentCities: stringList(req.body.recentCities),
    currentComboId: typeof req.body.currentComboId === 'string' ? req.body.currentComboId : undefined,
  },
  stats,
);
```

Return `400` with `source must be google_maps or sales_navigator.` for any other value.

- [ ] **Step 4: Run the API tests and verify GREEN**

Run:

```powershell
npm.cmd test -- tests/api/shuffleApi.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the API change**

```powershell
git add src/routes/api.ts tests/api/shuffleApi.test.ts
git commit -m "feat: make Nova shuffle source and history aware"
```

### Task 3: Persist Separate Browser Decks and Apply the Active Source

**Files:**
- Modify: `public/api.js`
- Modify: `public/app.js`
- Modify: `tests/public/staticUi.test.ts`

**Interfaces:**
- Consumes: the Task 2 POST response.
- Produces: source-scoped `leadsgenx:nova-shuffle:<source>` localStorage records.

- [ ] **Step 1: Write failing browser contract tests**

Add static assertions:

```ts
expect(apiJs).toContain("requestJson('/shuffle/next', {");
expect(apiJs).toContain("method: 'POST'");
expect(appJs).toContain("'leadsgenx:nova-shuffle:' + activeSource");
expect(appJs).toContain('chips.snTitles.setValues');
expect(appJs).toContain('chips.snIndustries.setValues');
expect(appJs).toContain('chips.snGeographies.setValues');
expect(appJs).toContain('chips.snHeadcounts.setValues');
expect(appJs).toContain('localStorage.setItem');
```

Also assert the button is not restricted to the Google Maps panel and that the code writes history only after a successful API response.

- [ ] **Step 2: Run the static UI tests and verify RED**

Run:

```powershell
npm.cmd test -- tests/public/staticUi.test.ts
```

Expected: FAIL because the client sends GET, stores no deck, and only fills Google Maps chips.

- [ ] **Step 3: Implement source-scoped browser history**

Change the API wrapper to:

```js
shuffleNext: (body) =>
  requestJson('/shuffle/next', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
```

In `public/app.js`, add safe helpers:

```js
function shuffleStorageKey(source) {
  return 'leadsgenx:nova-shuffle:' + source;
}

function loadShuffleHistory(source) {
  try {
    const parsed = JSON.parse(localStorage.getItem(shuffleStorageKey(source)) || '{}');
    return {
      comboIds: Array.isArray(parsed.comboIds) ? parsed.comboIds.filter((value) => typeof value === 'string') : [],
      cities: Array.isArray(parsed.cities) ? parsed.cities.filter((value) => typeof value === 'string') : [],
      currentComboId: typeof parsed.currentComboId === 'string' ? parsed.currentComboId : undefined,
    };
  } catch {
    return { comboIds: [], cities: [], currentComboId: undefined };
  }
}
```

`shuffleFilters()` must capture `const source = activeSource` before awaiting, submit that source's history, apply Google fields only when `source === 'google_maps'`, apply Sales Navigator fields only when `source === 'sales_navigator'`, and write returned history only after all response validation succeeds. Keep the button disabled for the whole request.

- [ ] **Step 4: Run the static UI tests and verify GREEN**

Run:

```powershell
npm.cmd test -- tests/public/staticUi.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the browser integration**

```powershell
git add public/api.js public/app.js tests/public/staticUi.test.ts
git commit -m "feat: deal a fresh Nova filter set on every click"
```

### Task 4: Verify the Complete Change

**Files:**
- Modify only if verification exposes a defect in the files above.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: fresh verification evidence for the release.

- [ ] **Step 1: Run focused shuffle coverage**

```powershell
npm.cmd test -- tests/domain/shuffleCombos.test.ts tests/api/shuffleApi.test.ts tests/public/staticUi.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run the complete automated suite**

```powershell
npm.cmd test
```

Expected: all tests pass with zero failures.

- [ ] **Step 3: Build TypeScript**

```powershell
npm.cmd run build
```

Expected: exit code `0`.

- [ ] **Step 4: Check browser JavaScript syntax**

```powershell
node --check public/app.js
node --check public/api.js
```

Expected: both commands exit `0`.

- [ ] **Step 5: Review the final diff and commit any verification correction**

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors and only intended Nova Shuffle files changed.
