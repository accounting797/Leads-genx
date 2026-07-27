# Admin Data Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Default every administrator dashboard session to personal runs and leads while providing an explicit, temporary All Users oversight scope.

**Architecture:** Add one validated `mine | all` scope contract to the existing runs and leads endpoints and derive all Prisma owner filters from it. Keep scope as in-memory browser state, pass it through the API client for every list/download operation, and render an admin-only global scope control plus owner attribution.

**Tech Stack:** TypeScript 6, Express 5, Prisma 5/SQLite, browser JavaScript, HTML/CSS, Vitest 3, Supertest

## Global Constraints

- Missing `scope` means `mine`.
- `scope=all` is honored only for an authenticated administrator.
- Normal users requesting `scope=all` still receive only their own records.
- Invalid scope values return HTTP 400.
- The browser scope is not stored in local storage, cookies, or the database.
- Every fresh page load and sign-in starts at `mine`.
- Direct administrator access to another user's run remains unchanged.
- Quotas, Nova learning, extension sessions, credentials, and ownership remain per-user and unchanged.
- All production code changes follow red-green-refactor TDD.

---

## File Structure

- `src/routes/api.ts` — validates the requested data scope, builds owner-scoped Prisma filters, and returns lead owner attribution.
- `tests/api/authApi.test.ts` — proves default admin isolation, explicit admin oversight, fail-closed normal-user behavior, invalid-scope validation, downloads, and unchanged direct admin access.
- `public/api.js` — serializes the selected scope on run, lead, email-copy, and download requests.
- `public/index.html` — contains the administrator-only My Data / All Users control and active-scope label.
- `public/app.js` — owns the non-persistent in-memory scope, refreshes all affected dashboard surfaces atomically, and keeps polling/download operations scoped.
- `public/ui.js` — renders lead ownership when the All Users view is active.
- `public/styles.css` — styles the scope control and its active/pending states.
- `tests/public/staticUi.test.ts` — verifies the static UI/API wiring, safe default, non-persistence, and owner rendering.

### Task 1: Enforce the server-side data scope contract

**Files:**
- Modify: `tests/api/authApi.test.ts`
- Modify: `src/routes/api.ts`

**Interfaces:**
- Produces: `type DataScope = 'mine' | 'all'`
- Produces: `parseDataScope(req: Request): DataScope`
- Produces: `runOwnerWhere(res: Response, scope: DataScope): { userId: number } | undefined`
- Produces: `leadScope(res: Response, scope: DataScope, runId?: number, leadSource?: LeadSource): Record<string, unknown> | undefined`
- Produces: lead-list property `ownerUsername: string`

- [ ] **Step 1: Replace the old administrator-all run isolation assertion with failing scope-contract tests**

In `tests/api/authApi.test.ts`, retain creation of Jane's and John's runs, create an administrator-owned run, and assert:

```ts
const admin = await prisma.user.findUniqueOrThrow({ where: { username: 'owner' } });
const adminRun = await prisma.run.create({
  data: {
    actorId: 'test',
    leadSource: 'google_maps',
    status: 'completed',
    maxResults: 10,
    userId: admin.id,
  },
});

const adminCookie = await login('owner', 'owner-password-1');
const mine = await request(app()).get('/api/runs').set('Cookie', adminCookie).expect(200);
expect(mine.body.data.map((run: { id: number }) => run.id)).toContain(adminRun.id);
expect(mine.body.data.map((run: { id: number }) => run.id)).not.toContain(janeRun.id);
expect(mine.body.data.map((run: { id: number }) => run.id)).not.toContain(johnRun.id);

const all = await request(app()).get('/api/runs?scope=all').set('Cookie', adminCookie).expect(200);
expect(all.body.data.map((run: { id: number }) => run.id)).toEqual(
  expect.arrayContaining([adminRun.id, janeRun.id, johnRun.id])
);
expect(all.body.data.find((run: { id: number }) => run.id === johnRun.id).user.username).toBe(
  'client.john'
);

const forcedMine = await request(app())
  .get('/api/runs?scope=all')
  .set('Cookie', johnCookie)
  .expect(200);
expect(forcedMine.body.data.map((run: { id: number }) => run.id)).toContain(johnRun.id);
expect(forcedMine.body.data.map((run: { id: number }) => run.id)).not.toContain(janeRun.id);

await request(app()).get('/api/runs?scope=team').set('Cookie', adminCookie).expect(400, {
  error: 'scope must be mine or all.',
});
```

- [ ] **Step 2: Add failing lead and download scope assertions**

Extend the lead-isolation test with an administrator-owned lead and these assertions:

```ts
const adminCookie = await login('owner', 'owner-password-1');
const admin = await prisma.user.findUniqueOrThrow({ where: { username: 'owner' } });
const adminRun = await prisma.run.create({
  data: {
    actorId: 'test',
    leadSource: 'google_maps',
    status: 'completed',
    maxResults: 10,
    userId: admin.id,
  },
});
await prisma.lead.create({
  data: {
    runId: adminRun.id,
    leadSource: 'google_maps',
    leadType: 'business',
    email: 'owner@example.com',
    normalizedEmail: 'owner@example.com',
  },
});

const adminMine = await request(app()).get('/api/leads').set('Cookie', adminCookie).expect(200);
expect(adminMine.body.data.map((lead: { email: string }) => lead.email)).toContain('owner@example.com');
expect(adminMine.body.data.map((lead: { email: string }) => lead.email)).not.toContain('john@example.com');

const adminAll = await request(app()).get('/api/leads?scope=all').set('Cookie', adminCookie).expect(200);
expect(adminAll.body.data.map((lead: { email: string }) => lead.email)).toEqual(
  expect.arrayContaining(['owner@example.com', 'jane@example.com', 'john@example.com'])
);
expect(
  adminAll.body.data.find((lead: { email: string }) => lead.email === 'john@example.com').ownerUsername
).toBe('client.john');

const adminMineDownload = await request(app())
  .get('/api/leads/download?format=emails')
  .set('Cookie', adminCookie)
  .expect(200);
expect(adminMineDownload.text).toContain('owner@example.com');
expect(adminMineDownload.text).not.toContain('john@example.com');

const adminAllDownload = await request(app())
  .get('/api/leads/download?format=emails&scope=all')
  .set('Cookie', adminCookie)
  .expect(200);
expect(adminAllDownload.text).toContain('owner@example.com');
expect(adminAllDownload.text).toContain('john@example.com');

const userCannotBroaden = await request(app())
  .get('/api/leads/download?format=emails&scope=all')
  .set('Cookie', johnCookie)
  .expect(200);
expect(userCannotBroaden.text).toContain('john@example.com');
expect(userCannotBroaden.text).not.toContain('jane@example.com');

await request(app()).get('/api/leads?scope=team').set('Cookie', adminCookie).expect(400, {
  error: 'scope must be mine or all.',
});
await request(app())
  .get('/api/leads/download?format=emails&scope=team')
  .set('Cookie', adminCookie)
  .expect(400, { error: 'scope must be mine or all.' });
```

- [ ] **Step 3: Run the API tests and verify the new assertions fail**

Run:

```powershell
npx vitest run tests/api/authApi.test.ts
```

Expected: FAIL because an administrator still receives every run/lead without `scope=all`, invalid scope is accepted, and lead results lack `ownerUsername`.

- [ ] **Step 4: Add scope parsing and a shared owner filter**

In `src/routes/api.ts`, add:

```ts
type DataScope = 'mine' | 'all';

function parseDataScope(req: Request): DataScope {
  const value = req.query.scope;
  if (value === undefined || value === 'mine') return 'mine';
  if (value === 'all') return 'all';
  throw new ValidationError('scope must be mine or all.');
}

function runOwnerWhere(res: Response, scope: DataScope): { userId: number } | undefined {
  const user = currentUser(res)!;
  return scope === 'all' && user.role === 'ADMIN' ? undefined : { userId: user.id };
}
```

Change `GET /runs` to consume its request and use the shared filter:

```ts
router.get(
  '/runs',
  asyncHandler(async (req, res) => {
    const scope = parseDataScope(req);
    const runs = prisma
      ? await prisma.run.findMany({
          where: runOwnerWhere(res, scope),
          orderBy: { createdAt: 'desc' },
          include: {
            _count: { select: { leads: true, batches: true } },
            user: { select: { username: true } },
          },
        })
      : [];
    res.json({ data: runs });
  })
);
```

- [ ] **Step 5: Apply the same scope to lead listing and downloads**

Change `leadScope` to accept `scope`, and always add a run owner constraint unless an administrator explicitly requests all:

```ts
function leadScope(
  res: Response,
  scope: DataScope,
  runId?: number,
  leadSource?: 'google_maps' | 'sales_navigator'
): Record<string, unknown> | undefined {
  if (!prisma) return undefined;
  const where: Record<string, unknown> = {};
  if (runId) where.runId = runId;
  if (leadSource) where.leadSource = leadSource;
  const ownerWhere = runOwnerWhere(res, scope);
  if (ownerWhere) where.run = ownerWhere;
  return Object.keys(where).length ? where : undefined;
}
```

At the beginning of both `/leads` and `/leads/download`, call:

```ts
const scope = parseDataScope(req);
```

Use:

```ts
where: leadScope(res, scope, runId, selectedLeadSource)
```

For `/leads`, include the owner relation:

```ts
include: {
  run: {
    select: {
      user: { select: { username: true } },
    },
  },
},
```

Before applying hiring-signal decoration, normalize each result:

```ts
const ownedLeads = leads.map(({ run, ...lead }) => ({
  ...lead,
  ownerUsername: run.user?.username || 'Legacy / unassigned',
}));
```

Use `ownedLeads` for the empty response, run ID collection, hiring-signal map, and final response.

- [ ] **Step 6: Run the focused API test and verify it passes**

Run:

```powershell
npx vitest run tests/api/authApi.test.ts
```

Expected: all tests in `tests/api/authApi.test.ts` PASS.

- [ ] **Step 7: Commit the server contract**

```powershell
git add src/routes/api.ts tests/api/authApi.test.ts
git commit -m "fix: scope admin data lists explicitly"
```

### Task 2: Pass scope through the browser API client

**Files:**
- Modify: `tests/public/staticUi.test.ts`
- Modify: `public/api.js`

**Interfaces:**
- Consumes: server query parameter `scope: 'mine' | 'all'`
- Produces: `listRuns(scope)`
- Produces: `listLeads(runId, leadSource, scope)`
- Produces: `getLeadEmailsTxt(runId, scope)`
- Produces: `downloadLeads(runId, format, leadSource, scope)`

- [ ] **Step 1: Write failing static API-client tests**

Add a `static dashboard data scope` describe block in `tests/public/staticUi.test.ts`:

```ts
describe('static dashboard data scope', () => {
  it('passes the selected scope through every runs and leads request', () => {
    const apiJs = readPublicFile('api.js');

    expect(apiJs).toContain('listRuns: (scope)');
    expect(apiJs).toContain("if (scope) params.set('scope', scope)");
    expect(apiJs).toContain('listLeads: (runId, leadSource, scope)');
    expect(apiJs).toContain('getLeadEmailsTxt: (runId, scope)');
    expect(apiJs).toContain('downloadLeads: (runId, format, leadSource, scope)');
  });
});
```

- [ ] **Step 2: Run the focused static test and verify it fails**

Run:

```powershell
npx vitest run tests/public/staticUi.test.ts
```

Expected: FAIL because the four API methods do not accept or serialize `scope`.

- [ ] **Step 3: Add one query-string helper and update all four API methods**

In `public/api.js`, add before `window.LeadsGenXApi`:

```js
function queryPath(path, values) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const query = params.toString();
  return path + (query ? '?' + query : '');
}
```

Replace the affected methods with:

```js
listRuns: (scope) => requestJson(queryPath('/runs', { scope })),
listLeads: (runId, leadSource, scope) =>
  requestJson(queryPath('/leads', { runId, leadSource, scope })),
getLeadEmailsTxt: (runId, scope) =>
  requestText(queryPath('/leads/download', { format: 'emails', runId, scope })),
downloadLeads: (runId, format, leadSource, scope) => {
  window.location.href =
    BASE + queryPath('/leads/download', { runId, format, leadSource, scope });
},
```

Adjust the static test to assert `queryPath` and the exact method signatures rather than requiring repeated `params.set` code:

```ts
expect(apiJs).toContain("function queryPath(path, values)");
expect(apiJs).toContain("if (value) params.set(key, value)");
```

- [ ] **Step 4: Run the focused static test and verify it passes**

Run:

```powershell
npx vitest run tests/public/staticUi.test.ts
```

Expected: all tests in `tests/public/staticUi.test.ts` PASS after updating any existing download string assertion to include the fourth `dataScope` argument.

- [ ] **Step 5: Commit the browser transport**

```powershell
git add public/api.js tests/public/staticUi.test.ts
git commit -m "feat: pass dashboard data scope to api"
```

### Task 3: Add the safe-default administrator scope control

**Files:**
- Modify: `tests/public/staticUi.test.ts`
- Modify: `public/index.html`
- Modify: `public/styles.css`
- Modify: `public/app.js`
- Modify: `public/ui.js`

**Interfaces:**
- Consumes: `listRuns(scope)`, `listLeads(runId, leadSource, scope)`, `getLeadEmailsTxt(runId, scope)`, and `downloadLeads(runId, format, leadSource, scope)`
- Produces: in-memory `let dataScope = 'mine'`
- Produces: `setDataScope(nextScope)`
- Produces: `renderRunsData(runs, preferredRunId)`
- Produces: `renderLeadsData(leads, runId)`
- Produces: `renderLeads(leads, showOwner)`

- [ ] **Step 1: Write failing UI structure and state tests**

Extend `tests/public/staticUi.test.ts`:

```ts
it('shows an admin-only My Data and All Users control', () => {
  const html = readPublicFile('index.html');

  expect(html).toContain('id="dataScopeControl"');
  expect(html).toContain('data-admin-only');
  expect(html).toContain('data-data-scope="mine"');
  expect(html).toContain('data-data-scope="all"');
  expect(html).toContain('id="dataScopeLabel"');
});

it('defaults scope in memory and never persists it', () => {
  const appJs = readPublicFile('app.js');

  expect(appJs).toContain("let dataScope = 'mine'");
  expect(appJs).toContain("dataScope = 'mine'");
  expect(appJs).not.toContain("localStorage.setItem('leadsgenx:data-scope'");
  expect(appJs).not.toContain("sessionStorage.setItem('leadsgenx:data-scope'");
});

it('uses one scope for runs, leads, downloads, and email copies', () => {
  const appJs = readPublicFile('app.js');

  expect(appJs).toContain('api.listRuns(dataScope)');
  expect(appJs).toContain('api.listLeads(runId, activeLeadLane, dataScope)');
  expect(appJs).toContain(
    "api.downloadLeads($('leadRunFilter').value, 'emails', activeLeadLane, dataScope)"
  );
  expect(appJs).toContain('api.getLeadEmailsTxt(runId, dataScope)');
});

it('renders lead ownership for the all-users view', () => {
  const uiJs = readPublicFile('ui.js');

  expect(uiJs).toContain('function renderLeads(leads, showOwner)');
  expect(uiJs).toContain("showOwner ? '<th>Owner</th>' : ''");
  expect(uiJs).toContain('lead.ownerUsername');
});
```

- [ ] **Step 2: Run the focused static test and verify it fails**

Run:

```powershell
npx vitest run tests/public/staticUi.test.ts
```

Expected: FAIL because the control, in-memory state, scoped calls, and lead owner column do not exist.

- [ ] **Step 3: Add the administrator-only control markup and styling**

In `public/index.html`, place this scope bar between the header metrics and the main dashboard content:

```html
<div id="dataScopeControl" class="data-scope-control" data-admin-only hidden>
  <span id="dataScopeLabel">Viewing my data</span>
  <div class="data-scope-toggle" role="group" aria-label="Dashboard data scope">
    <button type="button" class="active" data-data-scope="mine" aria-pressed="true">My Data</button>
    <button type="button" data-data-scope="all" aria-pressed="false">All Users</button>
  </div>
</div>
```

In `public/styles.css`, add:

```css
.data-scope-control {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.75rem;
  margin: 0.75rem 0;
  color: var(--muted);
}

.data-scope-control[hidden] {
  display: none;
}

.data-scope-toggle {
  display: inline-flex;
  gap: 0.25rem;
  padding: 0.25rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel);
}

.data-scope-toggle button {
  border: 0;
  border-radius: 999px;
  padding: 0.45rem 0.8rem;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.data-scope-toggle button.active {
  background: var(--blue);
  color: #fff;
}

.data-scope-toggle button:disabled {
  cursor: wait;
  opacity: 0.65;
}
```

- [ ] **Step 4: Split fetching from rendering so a scope change is atomic**

In `public/app.js`, add near other top-level state:

```js
let dataScope = 'mine';
```

Extract the current DOM-update body of `loadRuns` into:

```js
function renderRunsData(runs, preferredRunId) {
  latestRuns = runs;
  const selectedRunId =
    preferredRunId === undefined ? $('leadRunFilter').value : preferredRunId;
  const selectedHiringRunId = $('hiringRunFilter').value;
  $('runsTable').innerHTML = window.LeadsGenXUi.renderRuns(runs);
  $('metricRuns').textContent = runs.length;
  $('metricActive').textContent = runs.filter((run) =>
    ['queued', 'running', 'waiting_for_scraper', 'waiting_for_credentials', 'cooling_down'].includes(run.status)
  ).length;
  $('metricLeads').textContent = runs.reduce(
    (sum, run) => sum + (run._count ? run._count.leads : run.leadCount || 0),
    0
  );
  const laneRuns = runs.filter((run) => run.leadSource === activeLeadLane);
  $('leadRunFilter').innerHTML =
    '<option value="">All ' +
    (activeLeadLane === 'google_maps' ? 'Google Maps' : 'Sales Navigator') +
    ' runs</option>' +
    laneRuns
      .map(
        (run) =>
          '<option value="' + run.id + '">' + escapeHtml(runOptionLabel(run)) + '</option>'
      )
      .join('');
  if (selectedRunId && laneRuns.some((run) => String(run.id) === String(selectedRunId))) {
    $('leadRunFilter').value = selectedRunId;
  }
  const hiringRuns = runs.filter((run) =>
    ['completed', 'partially_completed'].includes(run.status)
  );
  $('hiringRunFilter').innerHTML =
    '<option value="">Choose a completed run</option>' +
    hiringRuns
      .map(
        (run) =>
          '<option value="' +
          run.id +
          '">' +
          escapeHtml(
            runOptionLabel(run) +
              ' · ' +
              (run.leadSource === 'google_maps' ? 'Google Maps' : 'Sales Navigator')
          ) +
          '</option>'
      )
      .join('');
  if (
    selectedHiringRunId &&
    hiringRuns.some((run) => String(run.id) === String(selectedHiringRunId))
  ) {
    $('hiringRunFilter').value = selectedHiringRunId;
  } else if (hiringRuns.length) {
    $('hiringRunFilter').value = String(hiringRuns[0].id);
  }
  if (!activeRunId) {
    const active = runs.find((run) =>
      ['queued', 'running', 'cooling_down', 'waiting_for_scraper', 'waiting_for_credentials'].includes(
        run.status
      )
    );
    if (active) startProgress(active.id);
  }
  return runs;
}
```

Add the option label helper immediately before `renderRunsData`:

```js
function runOptionLabel(run) {
  const base = 'Run #' + run.id;
  if (dataScope !== 'all') return base;
  const owner = run.user && run.user.username ? run.user.username : 'Legacy / unassigned';
  return base + ' · ' + owner;
}
```

Use `escapeHtml(runOptionLabel(run))` when building both lead and hiring run options.

Then reduce `loadRuns` to:

```js
async function loadRuns(preferredRunId) {
  const runsPayload = await api.listRuns(dataScope);
  const runs = Array.isArray(runsPayload) ? runsPayload : [];
  return renderRunsData(runs, preferredRunId);
}
```

Extract the current lead rendering body into:

```js
function renderLeadsData(leads, runId) {
  const laneLabel = activeLeadLane === 'google_maps' ? 'Google Maps' : 'Sales Navigator';
  const scopeLabel = dataScope === 'all' ? 'all users' : 'my data';
  $('leadSummary').textContent =
    laneLabel +
    ' · ' +
    scopeLabel +
    ' · ' +
    (runId ? 'selected run: ' : 'all runs: ') +
    leads.length +
    ' leads';
  $('leadsTable').innerHTML = window.LeadsGenXUi.renderLeads(leads, dataScope === 'all');
}

async function loadLeads() {
  const runId = $('leadRunFilter').value;
  const leadsPayload = await api.listLeads(runId, activeLeadLane, dataScope);
  const leads = Array.isArray(leadsPayload) ? leadsPayload : [];
  renderLeadsData(leads, runId);
}
```

- [ ] **Step 5: Implement safe scope switching and reset it during authentication**

Add:

```js
function applyDataScopeUI() {
  document.querySelectorAll('[data-data-scope]').forEach((button) => {
    const active = button.dataset.dataScope === dataScope;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  $('dataScopeLabel').textContent =
    dataScope === 'all' ? 'Viewing all users — oversight mode' : 'Viewing my data';
}

async function setDataScope(nextScope) {
  const requestedScope = nextScope === 'all' ? 'all' : 'mine';
  if (!isAdmin() || requestedScope === dataScope) return;
  const buttons = document.querySelectorAll('[data-data-scope]');
  buttons.forEach((button) => {
    button.disabled = true;
  });
  try {
    const [runsPayload, leadsPayload] = await Promise.all([
      api.listRuns(requestedScope),
      api.listLeads(undefined, activeLeadLane, requestedScope),
    ]);
    const runs = Array.isArray(runsPayload) ? runsPayload : [];
    const leads = Array.isArray(leadsPayload) ? leadsPayload : [];
    dataScope = requestedScope;
    applyDataScopeUI();
    renderRunsData(runs, '');
    renderLeadsData(leads, '');
  } catch (error) {
    window.LeadsGenXUi.toast(error.message);
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
}
```

At the beginning of `applyRoleUI(user)`, reset the page-session value:

```js
currentUser = user;
dataScope = 'mine';
applyDataScopeUI();
```

Register one delegated listener during boot:

```js
$('dataScopeControl').addEventListener('click', (event) => {
  const button = event.target.closest('[data-data-scope]');
  if (button) void setDataScope(button.dataset.dataScope);
});
```

- [ ] **Step 6: Keep polling, refreshes, downloads, and email copies in the active scope**

Replace every remaining unscoped run-list call in `public/app.js`:

```js
api.listRuns()
```

with:

```js
api.listRuns(dataScope)
```

Update lead download:

```js
api.downloadLeads($('leadRunFilter').value, 'emails', activeLeadLane, dataScope)
```

Update run email copying:

```js
const text = await api.getLeadEmailsTxt(runId, dataScope);
```

Confirm with:

```powershell
rg -n "api\.listRuns\(\)|api\.listLeads\([^,\n]+,\s*[^,\n]+\)|api\.getLeadEmailsTxt\([^,\n]+\)|api\.downloadLeads\([^,\n]+,\s*[^,\n]+,\s*[^,\n]+\)" public/app.js
```

Expected: no matches.

- [ ] **Step 7: Render owner attribution only in All Users lead tables**

In `public/ui.js`, change the signature and conditional table cells:

```js
function renderLeads(leads, showOwner) {
  if (!leads.length) return empty('No leads found.');
  const ownerHeader = showOwner ? '<th>Owner</th>' : '';
  return (
    '<div class="table-wrap"><table><thead><tr>' +
    ownerHeader +
    '<th>Type</th><th>Name</th><th>Title/Category</th><th>Company</th><th>Email</th><th>Phone</th><th>Website/Profile</th><th>Location/Address</th><th>Rating</th><th>Reviews</th></tr></thead><tbody>' +
    leads
      .map((lead) => {
        const isBusiness = lead.leadType === 'business';
        const name = isBusiness ? lead.companyName : lead.fullName;
        const title = isBusiness ? lead.categoryName : lead.jobTitle;
        const url = isBusiness ? lead.website || lead.placeUrl : lead.profileUrl;
        const location = isBusiness ? lead.address : lead.location;
        const signal = lead.hiringSignal;
        const signalBadge = signal
          ? '<a class="hiring-badge" href="' +
            escapeHtml(safeHttpsUrl(signal.evidenceUrl)) +
            '" target="_blank" rel="noreferrer" title="' +
            escapeHtml(signal.explanation) +
            '">Hiring ' +
            escapeHtml(signal.score) +
            '</a>'
          : '';
        const ownerCell = showOwner ? '<td>' + escapeHtml(lead.ownerUsername) + '</td>' : '';
        return (
          '<tr>' +
          ownerCell +
          '<td class="source">' +
          escapeHtml(lead.leadType) +
          '</td><td>' +
          escapeHtml(name) +
          '</td><td>' +
          escapeHtml(title) +
          '</td><td>' +
          escapeHtml(lead.companyName) +
          signalBadge +
          '</td><td>' +
          escapeHtml(lead.email) +
          '</td><td>' +
          escapeHtml(lead.phone) +
          '</td><td>' +
          (url ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer">Open</a>' : '') +
          '</td><td>' +
          escapeHtml(location) +
          '</td><td>' +
          escapeHtml(lead.rating) +
          '</td><td>' +
          escapeHtml(lead.reviewsCount) +
          '</td></tr>'
        );
      })
      .join('') +
    '</tbody></table></div>'
  );
}
```

The implementation must retain every existing lead cell and hiring-signal badge; only prepend `ownerHeader` and `ownerCell`.

- [ ] **Step 8: Run the focused UI tests and JavaScript syntax checks**

Run:

```powershell
npx vitest run tests/public/staticUi.test.ts
node --check public/api.js
node --check public/app.js
node --check public/ui.js
```

Expected: all static UI tests PASS and all three syntax checks exit 0.

- [ ] **Step 9: Commit the dashboard control**

```powershell
git add public/index.html public/styles.css public/app.js public/ui.js tests/public/staticUi.test.ts
git commit -m "feat: add admin data scope control"
```

### Task 4: Verify the integrated behavior

**Files:**
- Verify only; no planned production changes

**Interfaces:**
- Consumes: the complete server and browser data-scope implementation
- Produces: release-ready verification evidence

- [ ] **Step 1: Run the focused API and UI tests together**

```powershell
npx vitest run tests/api/authApi.test.ts tests/public/staticUi.test.ts
```

Expected: both test files PASS.

- [ ] **Step 2: Run the full automated suite**

```powershell
npm test
```

Expected: all tests PASS with zero failures.

- [ ] **Step 3: Build TypeScript**

```powershell
npm run build
```

Expected: `tsc` exits 0 with no type errors.

- [ ] **Step 4: Run final static and repository checks**

```powershell
node --check public/api.js
node --check public/app.js
node --check public/ui.js
git diff --check
git status --short
```

Expected: JavaScript checks and `git diff --check` exit 0; status contains only intentional plan/implementation commits and no uncommitted production changes.

- [ ] **Step 5: Review the final diff against the approved specification**

Run:

```powershell
git diff f14313f..HEAD -- src/routes/api.ts public/api.js public/index.html public/styles.css public/app.js public/ui.js tests/api/authApi.test.ts tests/public/staticUi.test.ts
```

Confirm:

- admin default queries are personal;
- only explicit admin `scope=all` broadens results;
- non-admin requests fail closed;
- invalid values return 400;
- metrics, lists, filters, downloads, and polling share one scope;
- owner attribution appears in oversight mode;
- scope is never persisted;
- direct run authorization, quota, Nova, extension, and credential code is untouched.

- [ ] **Step 6: Push the verified branch**

```powershell
git push origin fix/brightdata-no-apify:main
```

Expected: Git reports the verified commits pushed to `origin/main`.
