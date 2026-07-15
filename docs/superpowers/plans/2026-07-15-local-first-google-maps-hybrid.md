# Local-First Google Maps Hybrid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the locally built Google Maps scraper the primary, restart-safe discovery engine, with secure optional proxy routing, a bounded Google Places fallback, continuous deduplication/email persistence, and a polished responsive dashboard.

**Architecture:** Leads-GenX owns deterministic batches, checkpoints, proxy health, source budgets, canonical businesses, email leads, and operator state. A hardened local build of `gosom/google-maps-scraper` owns browser execution and CSV generation while keeping proxy credentials memory-only. Google Places runs directly from Leads-GenX only after local recovery is exhausted or local discovery finishes below target.

**Tech Stack:** TypeScript 6, Node.js 24, Express 5, Prisma 5/SQLite, Vitest 3, vanilla HTML/CSS/JavaScript, Go 1.26.5, Playwright Go 0.6100.0, Docker Desktop/Compose, `socks-proxy-agent` 8.0.5.

## Global Constraints

- Main repository: `C:\Users\Lenovo\Desktop\salesnav-lead-scraper`.
- Scraper repository: `C:\Users\Lenovo\Downloads\New folder\google-maps-scraper`, starting from clean commit `0ef302e` (`v1.16.3-1-g0ef302e`).
- Preserve all pre-existing uncommitted Leads-GenX changes; stage only files named by each task.
- Build the scraper from source as `leads-genx/google-maps-scraper:1.16.3-local`; do not overwrite or trust `gosom/google-maps-scraper:latest`.
- Keep Leads-GenX on `localhost:4177` and bind the scraper only to `127.0.0.1:8080`.
- Never persist or return Google API keys, proxy usernames/passwords, complete proxy URLs, LinkedIn cookies, or authorization headers.
- Local browser discovery is primary; Google Places is a fallback with a default 25-request budget and a hard 500-request ceiling.
- Direct browser concurrency starts at 1 and never exceeds 2; concurrency 2 remains disabled until the benchmark task passes.
- Proxy rotation happens between browser work items, not within a sticky browser session.
- Offline 9Proxy ports must not block startup. Candidate ports default to `60000-60009` and remain dormant until healthy.
- Google API traffic never uses the proxy pool.
- Keep Apify and Sales Navigator behavior intact.
- Do not add a frontend framework, external font, icon CDN, or runtime UI dependency.
- Every implementation task follows red-green-refactor, runs its focused tests, and commits only its own files.

---

## File Structure

### Scraper repository

- `web/jobsecrets.go`: synchronized per-job in-memory proxy secret store.
- `web/jobsecrets_test.go`: lifecycle, cloning, and deletion tests.
- `web/proxycheck.go`: localhost-only proxy preflight handler and checker interface.
- `web/proxycheck_test.go`: handler redaction and status tests using a fake checker.
- `web/service.go`: strips proxies before SQLite persistence and exposes controlled secret access.
- `web/web.go`: registers proxy preflight and ensures job JSON never contains credentials.
- `web/sqlite/sqlite_test.go`: persistence regression proving `data` contains no proxy URL.
- `runner/webrunner/webrunner.go`: reads ephemeral proxies and clears them after terminal job states.
- `runner/webrunner/webrunner_test.go`: verifies runner access and cleanup.
- `Dockerfile`: retains the matching Playwright driver/browser and installs `curl` for the container health check.

### Leads-GenX repository

- `src/domain/localDiscoveryBatch.ts`: deterministic local batch planning and stable keys.
- `src/domain/proxyPool.ts`: proxy state machine, cooldowns, selection, and redacted summaries.
- `src/domain/businessIdentity.ts`: canonical identity keys and merge rules.
- `src/domain/localFirstRunService.ts`: local-first orchestration isolated from Apify/Sales Navigator flow.
- `src/domain/types.ts`: local-first inputs, metrics, route mode, and public proxy descriptors.
- `src/domain/validation.ts`: 10,000 ceiling, API budget, proxy URL parsing, and secret-safe errors.
- `src/domain/runService.ts`: dispatches local-first runs without growing browser orchestration inline.
- `src/domain/prismaRunStore.ts`: batch, business, metric, and checkpoint persistence.
- `src/integrations/proxyHealthClient.ts`: host-side SOCKS5 health probe with exit IP and latency.
- `src/integrations/localMapsScraperClient.ts`: scraper health, proxy preflight, one-batch jobs, polling, and CSV parsing.
- `src/integrations/googlePlacesClient.ts`: exact request accounting, typed HTTP errors, and request-budget stop.
- `src/routes/api.ts`: safe metrics, scraper health, cancel, and credential re-entry/resume endpoints.
- `prisma/schema.prisma`: `RunBatch`, `DiscoveredBusiness`, and explicit run metrics.
- `prisma/migrations/20260715_local_first_hybrid/migration.sql`: additive SQLite migration and indexes.
- `scripts/build-google-scraper.ps1`: revision-aware local image build.
- `scripts/start-google-scraper.ps1`: idempotent Compose start and health wait.
- `docker-compose.google-scraper.yml`: local image, safe command, localhost binding, health check, retained volume.
- `start-google-scraper.bat`: thin PowerShell launcher.
- `public/index.html`, `public/app.js`, `public/ui.js`, `public/styles.css`: local-first controls, safe credential clearing, live metrics, responsive visual refinement, and accessible states.
- `tests/**`: focused unit, contract, persistence, static UI, and runtime configuration coverage.

---

### Task 0: Protect and checkpoint the existing approved working tree

**Repository:** `C:\Users\Lenovo\Desktop\salesnav-lead-scraper`

**Files already modified before this plan:**
- `.env.example`
- `README.md`
- `public/app.js`
- `public/index.html`
- `src/domain/leadNormalizer.ts`
- `src/domain/runService.ts`
- `src/domain/sourceInputBuilder.ts`
- `src/domain/types.ts`
- `src/domain/validation.ts`
- `tests/domain/leadNormalizer.test.ts`
- `tests/domain/runService.test.ts`
- `tests/domain/sourceInputBuilder.test.ts`
- `tests/domain/validation.test.ts`
- `tests/public/staticUi.test.ts`

**Interfaces:**
- Produces a clean, reviewed baseline containing the previously implemented Sales Navigator credential/email work.
- Prevents later task commits from accidentally absorbing or overwriting pre-existing changes.

- [ ] **Step 1: Review the exact pre-existing diff and scan for real credentials**

Run:

```powershell
git diff -- .env.example README.md public/app.js public/index.html src/domain/leadNormalizer.ts src/domain/runService.ts src/domain/sourceInputBuilder.ts src/domain/types.ts src/domain/validation.ts tests/domain/leadNormalizer.test.ts tests/domain/runService.test.ts tests/domain/sourceInputBuilder.test.ts tests/domain/validation.test.ts tests/public/staticUi.test.ts
rg -n "AQED|Bearer [A-Za-z0-9]|AIza[0-9A-Za-z_-]{20,}|socks5h?://[^ ]+@" .env.example README.md public src tests
```

Expected: the diff contains only the previously approved Sales Navigator/email implementation and examples; the credential scan finds no real secret. If the diff contains unrelated user work or a real credential, stop and ask the user before staging.

- [ ] **Step 2: Re-run the baseline verification**

Run:

```powershell
npm.cmd test
npm.cmd run build
git diff --check
```

Expected: full Vitest suite PASS, TypeScript build PASS, diff check clean.

- [ ] **Step 3: Commit only the reviewed baseline files**

```powershell
git add .env.example README.md public/app.js public/index.html src/domain/leadNormalizer.ts src/domain/runService.ts src/domain/sourceInputBuilder.ts src/domain/types.ts src/domain/validation.ts tests/domain/leadNormalizer.test.ts tests/domain/runService.test.ts tests/domain/sourceInputBuilder.test.ts tests/domain/validation.test.ts tests/public/staticUi.test.ts
git commit -m "feat: complete sales navigator email integration"
```

- [ ] **Step 4: Verify the implementation workspace is clean**

Run: `git status --short`

Expected: no uncommitted files before Task 1 begins.

---

### Task 1: Harden scraper proxy secrets and add container-side proxy preflight

**Repository:** `C:\Users\Lenovo\Downloads\New folder\google-maps-scraper`

**Files:**
- Create: `web/jobsecrets.go`
- Create: `web/jobsecrets_test.go`
- Create: `web/proxycheck.go`
- Create: `web/proxycheck_test.go`
- Create: `web/sqlite/sqlite_test.go`
- Modify: `web/service.go`
- Modify: `web/web.go`
- Modify: `runner/webrunner/webrunner.go`
- Modify: `runner/webrunner/webrunner_test.go`
- Modify: `go.mod`
- Modify: `go.sum`

**Interfaces:**
- Produces: `JobSecretStore.Put(jobID string, proxies []string)`, `Get(jobID string) []string`, `Delete(jobID string)`.
- Produces: `Service.JobProxies(jobID string) []string` and `Service.ClearJobSecrets(jobID string)`.
- Produces: `POST /api/v1/proxy-health` request `{ "proxy": "socks5h://..." }` and response `{ "ok": true, "exit_ip": "...", "latency_ms": 123 }`.
- Security invariant: persisted `JobData.Proxies` and all job API responses are empty even while a runner can access the proxy set.

- [ ] **Step 1: Write failing secret-store and persistence tests**

```go
func TestServiceStoresJobProxiesOnlyInMemory(t *testing.T) {
	repo := &memoryJobRepo{}
	svc := NewService(repo, t.TempDir())
	job := validJob("job-1")
	job.Data.Proxies = []string{"socks5h://user:pass@127.0.0.1:60001"}

	if err := svc.Create(context.Background(), &job); err != nil {
		t.Fatal(err)
	}
	stored, _ := repo.Get(context.Background(), job.ID)
	if len(stored.Data.Proxies) != 0 {
		t.Fatalf("persisted proxies = %v", stored.Data.Proxies)
	}
	if got := svc.JobProxies(job.ID); len(got) != 1 {
		t.Fatalf("runtime proxy count = %d", len(got))
	}
	svc.ClearJobSecrets(job.ID)
	if got := svc.JobProxies(job.ID); len(got) != 0 {
		t.Fatalf("proxies survived cleanup")
	}
}
```

Add a SQLite test that creates a job with the sentinel `proxy-password-sentinel`, reads the raw `jobs.data` column, and asserts the sentinel and proxy host are absent.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```powershell
docker run --rm -v "${PWD}:/src" -w /src golang:1.26.5 go test ./web/... ./runner/webrunner/...
```

Expected: FAIL because `JobSecretStore`, `JobProxies`, and `ClearJobSecrets` do not exist and current SQLite data contains proxies.

- [ ] **Step 3: Implement the synchronized memory store and strip-before-persist rule**

```go
type JobSecretStore struct {
	mu      sync.RWMutex
	proxies map[string][]string
}

func NewJobSecretStore() *JobSecretStore {
	return &JobSecretStore{proxies: make(map[string][]string)}
}

func (s *JobSecretStore) Put(jobID string, proxies []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.proxies[jobID] = append([]string(nil), proxies...)
}

func (s *JobSecretStore) Get(jobID string) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]string(nil), s.proxies[jobID]...)
}

func (s *JobSecretStore) Delete(jobID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.proxies, jobID)
}
```

Initialize the store in `NewService`. In `Service.Create`, clone `job.Data.Proxies`, set `job.Data.Proxies = nil`, persist the sanitized job, and save the clone only after persistence succeeds. Update the web runner to prefer process-level proxies, otherwise call `svc.JobProxies(job.ID)`, and clear job secrets after success, failure, or deletion.

- [ ] **Step 4: Write and fail proxy preflight handler tests**

```go
func TestProxyHealthResponseNeverEchoesCredential(t *testing.T) {
	checker := fakeProxyChecker{result: ProxyHealth{OK: true, ExitIP: "203.0.113.7", LatencyMS: 41}}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/proxy-health",
		strings.NewReader(`{"proxy":"socks5h://user:password-sentinel@host.docker.internal:60001"}`))
	proxyHealthHandler(checker).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	if strings.Contains(recorder.Body.String(), "password-sentinel") {
		t.Fatalf("response leaked credential")
	}
}
```

Expected: FAIL because the handler and checker contract do not exist.

- [ ] **Step 5: Implement proxy preflight with bounded protocols and timeouts**

Define:

```go
type ProxyHealth struct {
	OK        bool   `json:"ok"`
	ExitIP    string `json:"exit_ip,omitempty"`
	LatencyMS int64  `json:"latency_ms"`
	ErrorCode string `json:"error_code,omitempty"`
}

type ProxyChecker interface {
	Check(ctx context.Context, proxyURL string) ProxyHealth
}
```

Use `golang.org/x/net/proxy` for `socks5`/`socks5h`, `http.Transport.Proxy` for `http`/`https`, a 12-second context, and `https://api.ipify.org?format=json`. Reject other schemes with `unsupported_scheme`. Register only `POST /api/v1/proxy-health`; never log the request body or return the input URL.

- [ ] **Step 6: Run scraper tests and commit**

Run:

```powershell
docker run --rm -v "${PWD}:/src" -w /src golang:1.26.5 go test ./web/... ./runner/webrunner/...
```

Expected: PASS.

Commit:

```powershell
git add web runner/webrunner go.mod go.sum
git commit -m "fix: keep scraper proxy credentials ephemeral"
```

---

### Task 2: Build and operate the repaired scraper image safely

**Repositories:** scraper repository and Leads-GenX repository

**Files:**
- Modify scraper: `Dockerfile`
- Create app: `scripts/build-google-scraper.ps1`
- Create app: `scripts/start-google-scraper.ps1`
- Create app: `tests/ops/googleScraperRuntime.test.ts`
- Modify app: `docker-compose.google-scraper.yml`
- Modify app: `start-google-scraper.bat`
- Modify app: `.env.example`
- Modify app: `package.json`

**Interfaces:**
- Produces image `leads-genx/google-maps-scraper:1.16.3-local` with label `leads-genx.scraper.revision=<git-sha>`.
- Produces `npm.cmd run scraper:build` and idempotent `npm.cmd run scraper:up`.
- Produces Docker health status based on `GET /api/v1/jobs`.

- [ ] **Step 1: Write failing runtime configuration tests**

```ts
it('uses the pinned local image without deleting the Playwright driver', () => {
  const compose = read('docker-compose.google-scraper.yml');
  expect(compose).toContain('leads-genx/google-maps-scraper:1.16.3-local');
  expect(compose).toContain('127.0.0.1:8080:8080');
  expect(compose).toContain('healthcheck:');
  expect(compose).not.toContain('rm -rf /opt/ms-playwright-go');
});

it('builds from GOOGLE_MAPS_SCRAPER_SOURCE and labels the revision', () => {
  const script = read('scripts/build-google-scraper.ps1');
  expect(script).toContain('GOOGLE_MAPS_SCRAPER_SOURCE');
  expect(script).toContain('leads-genx.scraper.revision');
  expect(script).toContain('leads-genx/google-maps-scraper:1.16.3-local');
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm.cmd test -- tests/ops/googleScraperRuntime.test.ts`

Expected: FAIL because the scripts and local-image Compose configuration do not exist.

- [ ] **Step 3: Implement the build and startup scripts**

`build-google-scraper.ps1` must resolve the source from the environment or the known user-relative default, verify `go.mod`, `Dockerfile`, and Git cleanliness, compute `git rev-parse HEAD`, skip only when the existing image label matches, and otherwise run:

```powershell
docker build --label "leads-genx.scraper.revision=$revision" --tag "leads-genx/google-maps-scraper:1.16.3-local" $source
```

`start-google-scraper.ps1` must call the build script, run `docker compose -f docker-compose.google-scraper.yml up -d --force-recreate`, then poll `http://127.0.0.1:8080/api/v1/jobs` for at most 90 seconds and exit nonzero with the last container logs when unhealthy.

Use this Compose service shape:

```yaml
services:
  google-maps-scraper:
    image: leads-genx/google-maps-scraper:1.16.3-local
    container_name: leads-genx-gmaps-scraper
    restart: unless-stopped
    command: ["-web", "-data-folder", "/gmapsdata", "-c", "1"]
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - leads_genx_gmaps_data:/gmapsdata
    healthcheck:
      test: ["CMD", "curl", "--fail", "--silent", "http://127.0.0.1:8080/api/v1/jobs"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 20s
```

Add `curl` to the final Docker image's apt package list. Do not alter the Playwright driver paths or delete bundled artifacts.

- [ ] **Step 4: Run tests, build the image, and verify health**

Run:

```powershell
npm.cmd test -- tests/ops/googleScraperRuntime.test.ts
npm.cmd run scraper:build
npm.cmd run scraper:up
docker inspect --format "{{.State.Health.Status}}" leads-genx-gmaps-scraper
```

Expected: test PASS, image build succeeds, and health becomes `healthy`.

- [ ] **Step 5: Commit each repository independently**

Scraper commit:

```powershell
git add Dockerfile
git commit -m "build: add scraper container health dependency"
```

Leads-GenX commit:

```powershell
git add scripts/build-google-scraper.ps1 scripts/start-google-scraper.ps1 tests/ops/googleScraperRuntime.test.ts docker-compose.google-scraper.yml start-google-scraper.bat .env.example package.json
git commit -m "build: run repaired local maps scraper image"
```

---

### Task 3: Add local-first inputs and secret-safe validation

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/domain/validation.ts`
- Modify: `src/domain/runService.ts`
- Modify: `tests/domain/validation.test.ts`
- Modify: `tests/domain/runService.test.ts`
- Modify: `tests/domain/sourceInputBuilder.test.ts`

**Interfaces:**
- Produces provider `'local_first'`.
- Produces `ValidatedRunInput.proxyUrls?: string[]`, `routeMode: 'direct' | 'proxy'`, and `googleMaps.apiRequestBudget: number`.
- Produces `serializeSafeFilters(input: ValidatedRunInput): string` for persistence and secret-leak tests.
- Validation defaults local-first budget to 25, enforces `0..500`, and caps Google Maps targets at 10,000.

- [ ] **Step 1: Write failing validation and persistence-safety tests**

```ts
it('accepts a direct local-first run with a bounded API fallback', () => {
  const input = validateCreateRunInput({
    leadSource: 'google_maps',
    maxResults: 10000,
    googleApiKey: 'google-secret',
    googleMaps: {
      provider: 'local_first',
      searchTerms: ['dentist'],
      locations: ['Austin, TX'],
      apiRequestBudget: 25,
    },
  }, false);
  expect(input.routeMode).toBe('direct');
  expect(input.googleMaps?.apiRequestBudget).toBe(25);
});

it('normalizes proxy URLs but never serializes them into filterJson', async () => {
  const input = validateCreateRunInput({
    leadSource: 'google_maps',
    maxResults: 100,
    proxyUrls: 'socks5h://user:password-sentinel@127.0.0.1:60001',
    googleMaps: { provider: 'local_first', searchTerms: ['dentist'], apiRequestBudget: 0 },
  }, false);
  expect(input.routeMode).toBe('proxy');
  expect(input.proxyUrls).toHaveLength(1);
  expect(serializeSafeFilters(input)).not.toContain('password-sentinel');
});
```

Also test rejection of unsupported schemes, missing ports, budget 501, Google target 10001, and budget greater than zero without a Google key.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm.cmd test -- tests/domain/validation.test.ts tests/domain/runService.test.ts`

Expected: FAIL because local-first fields and rules do not exist.

- [ ] **Step 3: Implement exact input contracts and sanitization**

```ts
export type GoogleMapsProvider = 'apify' | 'google_places' | 'local_first' | 'hybrid';
export type RouteMode = 'direct' | 'proxy';

export interface GoogleMapsFilters {
  provider?: GoogleMapsProvider;
  apiRequestBudget?: number;
  searchTerms?: string[];
  categoryFilters?: string[];
  companyTypes?: string[];
  locations?: string[];
  locationQuery?: string;
  mapsUrl?: string;
  maxPlaces?: number;
  minimumStars?: number;
  minimumReviews?: number;
  skipClosedPlaces?: boolean;
}

export interface ValidatedRunInput {
  apifyToken?: string;
  apifyTokens?: string[];
  googleApiKey?: string;
  googleApiKeys?: string[];
  proxyUrls?: string[];
  routeMode: RouteMode;
  leadSource: LeadSource;
  actorId?: string;
  searchUrl?: string;
  maxResults: number;
  salesNavigator?: SalesNavigatorFilters;
  googleMaps?: GoogleMapsFilters;
}
```

Parse proxy entries from newline/comma-separated input with `new URL`, allow only `socks5:`, `socks5h:`, `http:`, and `https:`, require hostname and numeric port, dedupe exact normalized URLs, and return generic field errors that never include the input value. Export `serializeSafeFilters`; it must destructure `proxyUrls`, API keys, and tokens away before JSON serialization, and `startRun` must use it for `filterJson`.

- [ ] **Step 4: Update existing typed fixtures, run regression tests, and commit**

Add `routeMode: 'direct'` to every existing hand-built `ValidatedRunInput` fixture in `runService.test.ts` and `sourceInputBuilder.test.ts`; proxy-specific fixtures must use `'proxy'`. Then run:

```powershell
npm.cmd test -- tests/domain/validation.test.ts tests/domain/runService.test.ts tests/domain/sourceInputBuilder.test.ts
npm.cmd test
npm.cmd run build
```

Expected: focused tests PASS, the complete suite PASS, and TypeScript build PASS.

Commit:

```powershell
git add src/domain/types.ts src/domain/validation.ts src/domain/runService.ts tests/domain/validation.test.ts tests/domain/runService.test.ts tests/domain/sourceInputBuilder.test.ts
git commit -m "feat: validate secure local-first run inputs"
```

---

### Task 4: Implement deterministic batches, proxy health states, and business identity

**Files:**
- Create: `src/domain/localDiscoveryBatch.ts`
- Create: `src/domain/proxyPool.ts`
- Create: `src/domain/businessIdentity.ts`
- Create: `src/integrations/proxyHealthClient.ts`
- Create: `tests/domain/localDiscoveryBatch.test.ts`
- Create: `tests/domain/proxyPool.test.ts`
- Create: `tests/domain/businessIdentity.test.ts`
- Create: `tests/integrations/proxyHealthClient.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces `buildLocalDiscoveryBatches(filters): LocalDiscoveryBatch[]` with stable SHA-256 keys.
- Produces `ProxyPool.refresh()`, `healthyProxyUrls()`, `recordFailure()`, and redacted `summary()`.
- Produces `toContainerProxyUrl(proxyUrl: string): string`, replacing only loopback hostnames with `host.docker.internal` while preserving scheme, port, and encoded authentication.
- Produces `businessIdentity(lead)` and `mergeBusinesses(current, incoming)`.

- [ ] **Step 1: Write failing deterministic batch tests**

```ts
it('produces stable deduplicated batch keys', () => {
  const filters = { searchTerms: ['dentist'], locations: ['Austin, TX', 'Dallas, TX'] };
  const first = buildLocalDiscoveryBatches(filters);
  const second = buildLocalDiscoveryBatches(filters);
  expect(first).toEqual(second);
  expect(first.map((batch) => batch.key)).toHaveLength(new Set(first.map((batch) => batch.key)).size);
});
```

Define:

```ts
export interface LocalDiscoveryBatch {
  key: string;
  query: string;
  location?: string;
  lat?: string;
  lon?: string;
  depth: number;
  maxResults: number;
}
```

- [ ] **Step 2: Write failing proxy state tests with an injected clock/checker**

```ts
it('cools after two failures and recovers after a successful retest', async () => {
  const clock = new FakeClock('2026-07-15T00:00:00Z');
  const checker = new SequenceChecker([{ ok: true }, { ok: false }, { ok: false }, { ok: true }]);
  const pool = new ProxyPool(['socks5h://user:pass@127.0.0.1:60001'], checker, clock);
  await pool.refresh();
  pool.recordFailure(0, 'timeout');
  pool.recordFailure(0, 'timeout');
  expect(pool.summary().coolingDown).toBe(1);
  clock.advanceMinutes(5);
  await pool.refresh();
  expect(pool.summary().healthy).toBe(1);
});
```

Implement cooldowns of 5, 15, and 30 minutes, two consecutive failures before cooldown, clone all returned arrays, and expose only `proxy-01` style IDs in summaries.

Add this Docker translation test and implementation contract:

```ts
it('maps Windows loopback to the Docker host without changing credentials', () => {
  expect(toContainerProxyUrl('socks5h://user:p%40ss@127.0.0.1:60001'))
    .toBe('socks5h://user:p%40ss@host.docker.internal:60001');
});
```

Do not translate non-loopback hosts.

- [ ] **Step 3: Write failing identity and merge tests**

Test priority: place/CID, Maps URL, website+phone, phone, then name+address. Test that merge fills missing fields, unions emails and provenance, and never replaces a populated value with an empty value.

- [ ] **Step 4: Implement host-side health checks**

Add direct dependency `socks-proxy-agent@8.0.5`. Define:

```ts
export interface ProxyHealthResult {
  ok: boolean;
  exitIp?: string;
  latencyMs: number;
  errorCode?: 'not_listening' | 'authentication' | 'timeout' | 'https' | 'container';
}

export interface ProxyHealthChecker {
  check(proxyUrl: string): Promise<ProxyHealthResult>;
}
```

Use `SocksProxyAgent`, `https.request`, a 12-second `AbortSignal.timeout`, and the IP echo endpoint. Map network failures to bounded error codes and never include `proxyUrl` in thrown messages.

- [ ] **Step 5: Run focused tests and commit**

Run:

```powershell
npm.cmd test -- tests/domain/localDiscoveryBatch.test.ts tests/domain/proxyPool.test.ts tests/domain/businessIdentity.test.ts tests/integrations/proxyHealthClient.test.ts
```

Expected: PASS.

Commit:

```powershell
git add package.json package-lock.json src/domain/localDiscoveryBatch.ts src/domain/proxyPool.ts src/domain/businessIdentity.ts src/integrations/proxyHealthClient.ts tests/domain/localDiscoveryBatch.test.ts tests/domain/proxyPool.test.ts tests/domain/businessIdentity.test.ts tests/integrations/proxyHealthClient.test.ts
git commit -m "feat: add local batch and proxy supervision primitives"
```

---

### Task 5: Persist batches, canonical businesses, and run metrics

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260715_local_first_hybrid/migration.sql`
- Modify: `src/domain/runService.ts`
- Modify: `src/domain/prismaRunStore.ts`
- Create: `tests/domain/prismaRunStore.test.ts`

**Interfaces:**
- Produces `LocalFirstRunStore extends RunStore` with `RunBatchRecord`, `DiscoveredBusinessRecord`, and `RunMetrics` methods, keeping existing `RunStore` test doubles source-compatible until Task 8.
- Produces unique `(runId, batchKey)` checkpoints and `(runId, identityKey)` canonical businesses.

- [ ] **Step 1: Write failing store contract tests**

```ts
it('upserts a batch checkpoint and canonical business without duplicates', async () => {
  const store = new PrismaRunStore(prisma);
  await store.upsertBatch(runId, { batchKey: 'abc', query: 'dentist Austin, TX', status: 'pending' });
  await store.upsertBatch(runId, { batchKey: 'abc', query: 'dentist Austin, TX', status: 'completed' });
  await store.upsertBusiness(runId, business('place:123'));
  await store.upsertBusiness(runId, { ...business('place:123'), phone: '555-0100' });
  expect(await prisma.runBatch.count({ where: { runId } })).toBe(1);
  expect(await prisma.discoveredBusiness.count({ where: { runId } })).toBe(1);
});
```

- [ ] **Step 2: Add the additive schema and migration**

Add these models and relations, plus explicit metric fields on `Run`:

```prisma
model RunBatch {
  id            Int      @id @default(autoincrement())
  runId         Int
  batchKey      String
  query         String
  status        String   @default("pending")
  attemptCount  Int      @default(0)
  resultCount   Int      @default(0)
  nextAttemptAt DateTime?
  errorCode     String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  run           Run      @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@unique([runId, batchKey])
  @@index([runId, status, nextAttemptAt])
}

model DiscoveredBusiness {
  id           Int      @id @default(autoincrement())
  runId        Int
  identityKey  String
  sourceJson   String
  companyName  String?
  categoryName String?
  address      String?
  website      String?
  phone        String?
  placeUrl     String?
  rating       Float?
  reviewsCount Int?
  emailsJson   String?
  rawJson      String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  run          Run      @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@unique([runId, identityKey])
  @@index([runId, website])
}
```

Add `businessCount`, `localBusinessCount`, `googleBusinessCount`, `duplicateCount`, `websiteCount`, `apiRequestBudget`, `apiRequestsUsed`, `currentRoute`, and `localConcurrency` to `Run` with safe defaults. Write explicit `ALTER TABLE`, `CREATE TABLE`, and `CREATE INDEX` SQL in the migration.

- [ ] **Step 3: Implement focused store methods**

Define the focused extension without changing the existing base interface:

```ts
export interface LocalFirstRunStore extends RunStore {
  upsertBatch(runId: number, batch: RunBatchWrite): Promise<RunBatchRecord>;
  listRunnableBatches(runId: number, now: Date): Promise<RunBatchRecord[]>;
  upsertBusiness(runId: number, business: DiscoveredBusinessWrite): Promise<'inserted' | 'merged'>;
  listBusinesses(runId: number): Promise<DiscoveredBusinessRecord[]>;
  listRecoverableRuns(): Promise<RunRecord[]>;
}
```

`listRecoverableRuns` returns only local-first runs in `queued`, `running`, `waiting_for_scraper`, or `cooling_down`. All JSON fields must pass through `redactSecrets`. Update `toRunRecord` for explicit metrics.

- [ ] **Step 4: Generate Prisma, run tests, and commit**

Run:

```powershell
npm.cmd run prisma:generate
npx.cmd prisma migrate deploy
npm.cmd test -- tests/domain/prismaRunStore.test.ts
```

Expected: generation and migration succeed; focused test PASS.

Commit:

```powershell
git add prisma src/domain/runService.ts src/domain/prismaRunStore.ts tests/domain/prismaRunStore.test.ts
git commit -m "feat: persist local discovery checkpoints"
```

---

### Task 6: Refactor the scraper client to one secure resumable batch

**Files:**
- Modify: `src/integrations/localMapsScraperClient.ts`
- Modify: `tests/integrations/localMapsScraperClient.test.ts`

**Interfaces:**
- Consumes: `LocalDiscoveryBatch`, healthy host proxy URLs, and container proxy URLs.
- Produces: `searchBatch(input): Promise<LocalBatchResult>` and `checkProxy(containerProxyUrl): Promise<ProxyHealthResult>`.
- Preserves the existing `search(input)` method as a compatibility wrapper until Task 8 switches `runService` to the new orchestrator, so every intermediate commit still builds.

- [ ] **Step 1: Replace multi-location expectations with failing one-batch contract tests**

```ts
it('submits one deterministic batch with only healthy container proxies', async () => {
  const result = await client.searchBatch({
    batch: { key: 'batch-1', query: 'dentist Austin, TX', lat: '30.2672', lon: '-97.7431', depth: 10, maxResults: 100 },
    proxies: ['socks5h://user:pass@host.docker.internal:60001'],
  });
  expect(postBody).toMatchObject({
    name: 'leads-genx-batch-1',
    keywords: ['dentist Austin, TX'],
    proxies: ['socks5h://user:pass@host.docker.internal:60001'],
    email: true,
    depth: 10,
  });
  expect(result.batchKey).toBe('batch-1');
});
```

Test lowercase and uppercase status payloads, polling timeout, failed status, CSV with multiple emails, zero rows, and proxy preflight responses that never echo the input secret.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm.cmd test -- tests/integrations/localMapsScraperClient.test.ts`

Expected: FAIL because `searchBatch` and `checkProxy` do not exist.

- [ ] **Step 3: Implement the one-batch client**

Define:

```ts
export interface LocalBatchResult {
  batchKey: string;
  jobId: string;
  items: unknown[];
  rawBusinessCount: number;
}

export interface LocalMapsScraperClient {
  health(): Promise<boolean>;
  checkProxy(containerProxyUrl: string): Promise<ProxyHealthResult>;
  searchBatch(input: { batch: LocalDiscoveryBatch; proxies: string[] }): Promise<LocalBatchResult>;
}
```

Keep CSV parsing private, accept both `Status` and `status`, bound polling by elapsed time, and throw typed errors with `unavailable`, `timeout`, `failed`, or `download` codes. Never put the POST body or proxy URL into error messages.

Retain `search(input: LocalMapsScraperSearchInput)` and implement it by planning batches, calling `searchBatch` sequentially, and concatenating items up to `maxResults`. Mark it `@deprecated` in a doc comment; remove no public method in this task.

- [ ] **Step 4: Run focused tests and commit**

Run: `npm.cmd test -- tests/integrations/localMapsScraperClient.test.ts`

Expected: PASS.

Commit:

```powershell
git add src/integrations/localMapsScraperClient.ts tests/integrations/localMapsScraperClient.test.ts
git commit -m "feat: run secure local scraper batches"
```

---

### Task 7: Enforce Google API request budgets and typed circuit breaking

**Files:**
- Modify: `src/integrations/googlePlacesClient.ts`
- Modify: `tests/integrations/googlePlacesClient.test.ts`
- Modify: `src/domain/runService.ts`
- Modify: `tests/domain/runService.test.ts`

**Interfaces:**
- Consumes fallback query list and request budget.
- Produces exact `requestsUsed`, partial places, typed `GooglePlacesHttpError.status`, and `GoogleApiBudgetExhaustedError`.

- [ ] **Step 1: Write failing exact-budget tests**

```ts
it('counts every key attempt and stops before request 26', async () => {
  const client = new GooglePlacesApiClient();
  const result = await client.search({
    apiKey: 'key-one',
    apiKeys: ['key-one', 'key-two'],
    filters: { searchTerms: ['dentist'], locations: ['Austin, TX'] },
    maxResults: 100,
    requestBudget: 25,
  });
  expect(result.requestsUsed).toBeLessThanOrEqual(25);
  expect(fetch).toHaveBeenCalledTimes(result.requestsUsed);
});
```

Add tests that a `429` emits a typed status, invalid `401/403` disables only that key, partial places survive budget exhaustion, and field masks remain minimal.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm.cmd test -- tests/integrations/googlePlacesClient.test.ts`

Expected: FAIL because search currently returns an array and has no request budget.

- [ ] **Step 3: Implement budgeted result contracts**

```ts
export interface GooglePlacesSearchResult {
  places: unknown[];
  requestsUsed: number;
  budgetExhausted: boolean;
  disabledKeyCount: number;
}

export class GooglePlacesHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Google Places request failed with status ${status}`);
  }
}
```

Increment the counter immediately before every `fetch`, check the budget before each attempt/page, retain partial places, stop retrying disabled keys, and expose request progress through the existing shard event callback without including key values.

Update the existing Google-primary and hybrid branches to read `result.places` and record `result.requestsUsed`; preserve their current source order and completion semantics.

- [ ] **Step 4: Run focused tests and commit**

Run: `npm.cmd test -- tests/integrations/googlePlacesClient.test.ts tests/domain/runService.test.ts`

Expected: PASS.

Commit:

```powershell
git add src/integrations/googlePlacesClient.ts tests/integrations/googlePlacesClient.test.ts src/domain/runService.ts tests/domain/runService.test.ts
git commit -m "feat: bound Google Places fallback usage"
```

---

### Task 8: Implement restart-safe local-first orchestration

**Files:**
- Create: `src/domain/localFirstRunService.ts`
- Create: `tests/domain/localFirstRunService.test.ts`
- Modify: `src/domain/runService.ts`
- Modify: `src/app.ts`
- Modify: `src/server.ts`
- Modify: `tests/domain/runService.test.ts`
- Modify: `tests/api/api.test.ts`

**Interfaces:**
- Consumes batch planner, store checkpoints, proxy pool, local client, Google client, normalizer, and email extractor.
- Produces `executeLocalFirstRun(run, input)`, `resumeLocalFirstRun(runId, credentials)`, and `recoverInterruptedRuns()`.

- [ ] **Step 1: Write failing orchestration tests**

Cover these exact scenarios:

```ts
it('persists local results before invoking Google fallback', async () => {
  await service.execute(run, input);
  expect(callOrder).toEqual([
    'batch:pending',
    'local:search',
    'business:upsert',
    'batch:completed',
    'email:save',
    'google:fallback',
  ]);
});

it('does not invoke Google when local reaches the business target', async () => {
  await service.execute(run, { ...input, maxResults: 2 });
  expect(googleClient.search).not.toHaveBeenCalled();
});

it('resumes only pending checkpoints after a process restart', async () => {
  store.seedBatches([{ key: 'done', status: 'completed' }, { key: 'left', status: 'pending' }]);
  await service.resume(run.id, {});
  expect(localClient.searchBatch).toHaveBeenCalledTimes(1);
  expect(localClient.searchBatch).toHaveBeenCalledWith(expect.objectContaining({ batch: expect.objectContaining({ key: 'left' }) }));
});

it('recovers direct runs automatically but waits for non-persisted proxy credentials', async () => {
  store.seedRecoverableRuns([directRun, proxyRun]);
  await service.recoverInterruptedRuns();
  expect(localClient.searchBatch).toHaveBeenCalledWith(expect.objectContaining({ runId: directRun.id }));
  expect(store.statusOf(proxyRun.id)).toBe('waiting_for_credentials');
});
```

Also test direct concurrency 1, two local failures before cooldown, zero results causing fallback, no API key causing `api_budget_exhausted`/waiting state rather than run loss, cancel preserving completed output, duplicate businesses not increasing the target count, and `createApp({ recoverOnStartup: true })` invoking recovery exactly once without blocking HTTP startup.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm.cmd test -- tests/domain/localFirstRunService.test.ts tests/domain/runService.test.ts`

Expected: FAIL because the local-first orchestrator does not exist and current flow runs Google first.

- [ ] **Step 3: Implement the isolated orchestration service**

Define dependencies explicitly:

```ts
export interface LocalFirstRunDeps {
  store: LocalFirstRunStore;
  localClient: LocalMapsScraperClient;
  googleClient?: GooglePlacesClient;
  proxyPoolFactory: (urls: string[]) => ProxyPool;
  emailExtractor?: EmailExtractor;
  now?: () => Date;
  maxDirectConcurrency?: 1 | 2;
}

export interface ResumeCredentials {
  googleApiKeys?: string[];
  proxyUrls?: string[];
}
```

Algorithm order must be: create missing deterministic checkpoints; refresh proxy pool; select direct or healthy proxy route; execute only runnable batches; normalize and upsert each business; mark the batch completed; update explicit metrics; scan/save new emails; retry/cool down failures; invoke budgeted Google fallback only for exhausted/failed coverage; complete with transparent shortfall metrics.

Do not reuse `runGooglePlaces` for primary flow. Keep Apify, Google-primary, hybrid, and Sales Navigator branches behaviorally unchanged.

For startup recovery, parse only the already-sanitized persisted filters. Resume direct local batches automatically. Because API keys and proxy URLs are deliberately not persisted, move a recovered run that requires either secret to `waiting_for_credentials`, retain all checkpoints/results, and emit a generic event without credential material. Add `recoverOnStartup?: boolean` to `ApiDeps`; `createApp` queues `runService.recoverInterruptedRuns()` only when enabled, and `server.ts` must call `createApp({ recoverOnStartup: true })`. Recovery errors are redacted and logged without preventing the HTTP server from starting.

- [ ] **Step 4: Run focused and regression tests**

Run:

```powershell
npm.cmd test -- tests/domain/localFirstRunService.test.ts tests/domain/runService.test.ts tests/api/api.test.ts
npm.cmd test
npm.cmd run build
```

Expected: focused tests PASS, full suite PASS, TypeScript build PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/domain/localFirstRunService.ts src/domain/runService.ts src/app.ts src/server.ts tests/domain/localFirstRunService.test.ts tests/domain/runService.test.ts tests/api/api.test.ts
git commit -m "feat: orchestrate local-first maps discovery"
```

---

### Task 9: Expose safe recovery, cancellation, health, and metrics APIs

**Files:**
- Modify: `src/routes/api.ts`
- Modify: `src/app.ts`
- Modify: `tests/api/api.test.ts`

**Interfaces:**
- Produces `GET /api/scraper/health`.
- Produces `POST /api/runs/:id/resume` accepting request-scoped `googleApiKey` and `proxyUrls` but never echoing them.
- Produces `POST /api/runs/:id/cancel`.
- Run list/detail responses include safe explicit metrics and batch counts, never raw batch queries with secrets.

- [ ] **Step 1: Write failing API safety tests**

```ts
it('resumes a paused run without echoing credentials', async () => {
  const response = await request(app)
    .post('/api/runs/12/resume')
    .send({ googleApiKey: 'google-sentinel', proxyUrls: 'socks5h://u:proxy-sentinel@127.0.0.1:60001' })
    .expect(202);
  expect(JSON.stringify(response.body)).not.toContain('google-sentinel');
  expect(JSON.stringify(response.body)).not.toContain('proxy-sentinel');
});
```

Add tests for health availability, cancel idempotence, missing run 404, resume invalid state 409, and list/detail payload leakage using sentinel values in database stubs.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm.cmd test -- tests/api/api.test.ts`

Expected: FAIL because recovery, cancel, and scraper health routes do not exist.

- [ ] **Step 3: Implement bounded safe endpoints**

Extend `ApiRunService`:

```ts
resumeRun(runId: number, credentials: ResumeCredentials): Promise<{ id: number; status: string }>;
cancelRun(runId: number): Promise<{ id: number; status: string }>;
scraperHealth(): Promise<{ ok: boolean; route: string; healthyProxyCount: number }>;
```

Validate resume credentials with the same secret-safe parsers as run creation. Return only IDs, state, safe metrics, batch counts, and redacted proxy counts.

- [ ] **Step 4: Run focused tests and commit**

Run: `npm.cmd test -- tests/api/api.test.ts`

Expected: PASS.

Commit:

```powershell
git add src/routes/api.ts src/app.ts tests/api/api.test.ts
git commit -m "feat: expose safe local run recovery APIs"
```

---

### Task 10: Build the polished local-first dashboard

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/api.js`
- Modify: `public/ui.js`
- Modify: `public/styles.css`
- Modify: `tests/public/staticUi.test.ts`

**Interfaces:**
- Consumes safe run metrics and recovery/cancel APIs.
- Produces local-first form payload, secure credential clearing, route/source summary, responsive live metric cards, and accessible state updates.

- [ ] **Step 1: Write failing static UI contract tests**

```ts
it('presents Docker primary with a bounded Google fallback', () => {
  const html = readPublicFile('index.html');
  expect(html).toContain('value="local_first"');
  expect(html).toContain('id="googleApiBudget"');
  expect(html).toContain('id="proxyUrls"');
  expect(html).toContain('Docker primary');
  expect(html).toContain('Google fallback');
});

it('clears request-scoped credentials after submission', () => {
  const app = readPublicFile('app.js');
  expect(app).toContain("$('googleApiKey').value = ''");
  expect(app).toContain("$('proxyUrls').value = ''");
});

it('includes accessible live state and reduced-motion styling', () => {
  expect(readPublicFile('index.html')).toContain('aria-live="polite"');
  expect(readPublicFile('styles.css')).toContain('@media (prefers-reduced-motion: reduce)');
});
```

Also assert source/route badges, six live metric IDs, cancel/resume controls, no external assets, sticky table headers, and 390px responsive rules.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm.cmd test -- tests/public/staticUi.test.ts`

Expected: FAIL because local-first and refined visual contracts do not exist.

- [ ] **Step 3: Implement form and behavior changes**

Add provider option `Docker Local-First`, API budget input default 25 with min 0/max 500, secure multiline proxy input inside Advanced, direct-routing warning, source summary, route/status badge, metric cards for businesses/emails/batches/API/duplicates/route, and cancel/resume controls.

The submitted body must be:

```js
{
  apifyToken: $('apifyToken').value.trim(),
  googleApiKey: $('googleApiKey').value.trim(),
  proxyUrls: $('proxyUrls').value.trim(),
  leadSource: activeSource,
  maxResults: Number($('maxResults').value),
  googleMaps: {
    provider: $('gmProvider').value,
    apiRequestBudget: Number($('googleApiBudget').value),
    searchTerms: chips.gmSearchTerms.values(),
    categoryFilters: chips.gmCategories.values(),
    companyTypes: chips.gmCompanyTypes.values(),
    locations: chips.gmLocations.values(),
  },
}
```

Clear Google keys and proxy URLs immediately after a successful `202` response. Never rehydrate them from run detail.

- [ ] **Step 4: Implement the visual system refinement**

Retain the current charcoal/green/cyan palette. Add CSS tokens for an 8px spacing scale, 10/14px radii, layered shadows, status colors, keyboard focus, metric cards, source summary, route badges, sticky headers, mobile stacking, and reduced motion. Use text plus color for every state. Keep all tables inside bounded `.table-wrap` overflow.

- [ ] **Step 5: Run focused tests and inspect required viewports**

Run: `npm.cmd test -- tests/public/staticUi.test.ts`

Expected: PASS.

Start the app and inspect at widths 1440, 1024, 768, and 390. Expected: no clipped controls, no page-level horizontal scroll, readable status text, visible focus, bounded tables, and no credential value remaining in the DOM after submit.

- [ ] **Step 6: Commit**

```powershell
git add public/index.html public/app.js public/api.js public/ui.js public/styles.css tests/public/staticUi.test.ts
git commit -m "feat: polish local-first operator dashboard"
```

---

### Task 11: Complete runtime, leakage, smoke, and performance verification

**Files:**
- Create: `tests/security/localFirstSecrets.test.ts`
- Create: `tests/integration/localFirstFlow.test.ts`
- Modify: `README.md`
- Modify: `.env.example`

**Interfaces:**
- Verifies the complete contract; produces no new runtime interface.

- [ ] **Step 1: Add a sentinel leakage regression**

Use `google-key-sentinel` and `proxy-password-sentinel` in a local-first request, then inspect serialized run inputs, API responses, run events, error logs, Leads-GenX SQLite rows, scraper SQLite rows, downloaded emails, and captured process logs. Assert neither sentinel appears in any inspected artifact.

- [ ] **Step 2: Add an end-to-end local-first integration test**

Use fake local scraper and Google servers to assert: local batch persists first; duplicate local/API businesses merge; API fallback obeys budget; emails save once; cancellation preserves completed batches; resume skips completed work.

- [ ] **Step 3: Run all automated gates**

Run:

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run prisma:generate
docker run --rm -v "C:\Users\Lenovo\Downloads\New folder\google-maps-scraper:/src" -w /src golang:1.26.5 go test ./...
```

Expected: all Vitest tests PASS, TypeScript build PASS, Prisma generation PASS, all Go tests PASS.

- [ ] **Step 4: Rebuild and run Docker smoke tests**

Run:

```powershell
npm.cmd run scraper:build
npm.cmd run scraper:up
docker inspect --format "{{.State.Health.Status}}" leads-genx-gmaps-scraper
```

Submit one normal low-impact query and one email-enabled low-impact query. Expected: both reach `ok`, CSV downloads successfully, and container logs contain no Playwright version/download error or sentinel credential.

- [ ] **Step 5: Verify restart persistence and port isolation**

Restart only `leads-genx-gmaps-scraper`, confirm the completed CSV remains downloadable, confirm the app still answers on 4177, and confirm Docker exposes only `127.0.0.1:8080`.

- [ ] **Step 6: Run the concurrency benchmark**

Run the same bounded query set once at concurrency 1 and once at concurrency 2. Record elapsed time, unique businesses, zero-result batches, failed batches, and error rate. Enable concurrency 2 only when it improves elapsed time without increasing failed/zero batches above 5%; otherwise retain 1.

- [ ] **Step 7: Update operator documentation**

Document source checkout path, local image build/start commands, direct-IP warning, Google budget, 9Proxy port forwarding, `host.docker.internal` mapping, secret lifetime, resume behavior, health commands, and rollback to concurrency 1.

- [ ] **Step 8: Commit verification and documentation**

```powershell
git add tests/security/localFirstSecrets.test.ts tests/integration/localFirstFlow.test.ts README.md .env.example
git commit -m "test: verify local-first maps runtime"
```

- [ ] **Step 9: Final review gate**

Run `git diff --check`, inspect both repository statuses, confirm no unrelated file is staged, and use the verification-before-completion skill before claiming the integration complete.
