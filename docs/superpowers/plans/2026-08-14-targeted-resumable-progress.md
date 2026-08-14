# Targeted Resumable Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the current Leads Gen X data while making Targeted work-unit progress observable, resumable, and terminal, and serving Nova Arrange from the updated Google Maps dashboard.

**Architecture:** Reuse `TargetedWorkUnit.checkpointJson` for a typed, secret-free progress snapshot and expose it through the existing campaign detail API. Make recovery reset interrupted units before resuming, isolate individual document failures, and render the snapshot in both Targeted dashboard surfaces. Finally cut port 4177 over to the authoritative build while pointing it at the existing SQLite database.

**Tech Stack:** TypeScript 6, Node.js, Express, Prisma/SQLite, vanilla browser JavaScript, Vitest.

## Global Constraints

- Preserve every existing campaign, candidate, credential, and history row.
- Keep Nova Arrange exclusive to standard Google Maps scraping.
- Preserve 20,000 candidates per artifact and 500 candidates per section/page/sheet.
- Do not restore DNS, MX, SMTP, or mailbox checks to Targeted.
- A non-cancelled work unit must not remain `running` after its operation settles.
- Progress payloads must not contain credentials or raw provider responses.
- The authoritative project is `C:\Users\Lenovo\Desktop\Leads-genx-remote`; the preserved database is `C:\Users\Lenovo\Desktop\Leads-genx\prisma\dev.db`.

---

### Task 1: Durable work-unit progress and recovery

**Files:**
- Modify: `src/domain/targeted/types.ts`
- Modify: `src/domain/targeted/store.ts`
- Modify: `src/domain/targeted/service.ts`
- Test: `tests/domain/targeted/store.test.ts`
- Test: `tests/domain/targeted/service.test.ts`

**Interfaces:**
- Produces: `TargetedWorkUnitProgress` with `stage`, `processed`, optional `total`, `succeeded`, `failed`, optional `currentSource`, and `heartbeatAt`.
- Produces: `PrismaTargetedStore.updateWorkUnitProgress(id, progress)` and `PrismaTargetedStore.resetInterruptedWorkUnits(campaignId)`.
- Changes: `TargetedWorkUnitRecord.progress?: TargetedWorkUnitProgress`; `listWorkUnits()` parses progress while preserving `adaptiveMetric` in the same checkpoint JSON.

- [ ] **Step 1: Write failing store tests**

Add tests that persist a progress snapshot, read it through `listWorkUnits()`, preserve an existing `adaptiveMetric`, and reset only `running` units to `pending`:

```ts
await store.updateWorkUnitProgress(unit.id, {
  stage: 'extracting_document', processed: 25, total: 100,
  succeeded: 24, failed: 1, currentSource: 'https://records.example/a.xlsx',
  heartbeatAt: new Date().toISOString(),
});
expect((await store.listWorkUnits(campaign.id))[0].progress).toMatchObject({
  stage: 'extracting_document', processed: 25, total: 100, succeeded: 24, failed: 1,
});
await store.resetInterruptedWorkUnits(campaign.id);
expect((await store.listWorkUnits(campaign.id))[0].status).toBe('pending');
```

- [ ] **Step 2: Verify the store tests fail for the missing API**

Run: `npx.cmd vitest run tests/domain/targeted/store.test.ts`

Expected: FAIL because `updateWorkUnitProgress`, `resetInterruptedWorkUnits`, and `progress` do not exist.

- [ ] **Step 3: Implement the typed checkpoint store API**

Define the progress interface in `types.ts`. In `store.ts`, parse `checkpointJson` defensively, merge `{ progress }` without deleting `{ adaptiveMetric }`, and reset `running` rows with:

```ts
await this.prisma.targetedWorkUnit.updateMany({
  where: { campaignId, status: 'running' },
  data: { status: 'pending', errorCode: null, errorMessage: null },
});
```

- [ ] **Step 4: Verify store tests pass**

Run: `npx.cmd vitest run tests/domain/targeted/store.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing service tests**

Add lifecycle tests proving that recovery resets an interrupted unit before retry, a document unit exposes progress before completion, and a rejected document URL does not prevent a later URL and later work unit from reaching terminal states. Assert:

```ts
expect(unit.progress).toMatchObject({ stage: 'processing_sources', processed: 1, total: 2 });
expect(units.every((entry) => entry.status !== 'running')).toBe(true);
expect((await service.get(draft.id))?.status).toBe('partially_completed');
```

- [ ] **Step 6: Verify service tests fail for missing progress and recovery**

Run: `npx.cmd vitest run tests/domain/targeted/service.test.ts`

Expected: FAIL because interrupted units are not reset and per-source progress is not persisted.

- [ ] **Step 7: Implement minimal progress, isolation, and terminalization**

Before resuming an interrupted campaign, call `resetInterruptedWorkUnits(campaignId)`. Update progress at unit start, after search discovery, after each source, and every 25 extracted candidates. Wrap each document URL in its own `try/catch`, increment its failure count, and continue. Keep connector-level `try/catch` responsible for setting `completed` or `failed`; cancellation remains the only path that may return early after the store has marked remaining units `cancelled`.

- [ ] **Step 8: Run the Targeted domain gate and commit**

Run: `npx.cmd vitest run tests/domain/targeted/store.test.ts tests/domain/targeted/service.test.ts tests/domain/targeted/mailInfrastructure.test.ts`

Expected: PASS with no failed tests.

Commit:

```powershell
git add src/domain/targeted/types.ts src/domain/targeted/store.ts src/domain/targeted/service.ts tests/domain/targeted/store.test.ts tests/domain/targeted/service.test.ts
git commit -m "fix: make targeted work progress resumable"
```

---

### Task 2: Targeted progress UI and Nova placement contract

**Files:**
- Modify: `public/targeted.js`
- Modify: `public/app.js`
- Modify: `public/targeted.html`
- Modify: `public/index.html`
- Modify: `public/targeted.css`
- Modify: `public/styles.css`
- Test: `tests/public/staticUi.test.ts`
- Test: `tests/api/targetedApi.test.ts`

**Interfaces:**
- Consumes: `TargetedWorkUnitRecord.progress` from Task 1.
- Produces: progress summaries in `targetedUnitProgress` on both Targeted surfaces.
- Retains: `shuffleFiltersBtn` inside `googleMapsFields` and outside both Targeted surfaces.

- [ ] **Step 1: Write failing API and static UI tests**

Require campaign detail to return a parsed safe progress object, and require both dashboards to contain the unit summary fields and render the active checkpoint. Retain the existing Nova placement assertion:

```ts
expect(detail.workUnits[0].progress).toMatchObject({ stage: 'processing_sources', processed: 3 });
for (const label of ['Completed', 'Failed', 'Skipped', 'Running', 'Pending']) {
  expect(targetedHtml).toContain(label);
}
expect(targetedJs).toContain('unit.progress');
```

- [ ] **Step 2: Verify UI/API tests fail**

Run: `npx.cmd vitest run tests/api/targetedApi.test.ts tests/public/staticUi.test.ts`

Expected: FAIL because checkpoint progress and the status summary are not rendered.

- [ ] **Step 3: Implement the compact progress presentation**

Add a five-state unit summary and active-unit detail to both dashboards. Render `processed/total` when total is known, otherwise render `processed`, plus stage and heartbeat. Escape all checkpoint strings through the existing `escapeHtml()` helper. Do not add Nova controls to Targeted.

- [ ] **Step 4: Verify UI, syntax, and build**

Run:

```powershell
npx.cmd vitest run tests/api/targetedApi.test.ts tests/public/staticUi.test.ts
node --check public/app.js
node --check public/targeted.js
npm.cmd run build
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```powershell
git add public/targeted.js public/app.js public/targeted.html public/index.html public/targeted.css public/styles.css tests/public/staticUi.test.ts tests/api/targetedApi.test.ts
git commit -m "feat: show live targeted unit progress"
```

---

### Task 3: Verify and cut over the preserved live runtime

**Files:**
- Modify only if required by verification: `docs/AGENT_LOG.md`
- Runtime data retained: `C:\Users\Lenovo\Desktop\Leads-genx\prisma\dev.db`

**Interfaces:**
- Consumes: the built `dist/server.js`, absolute `DATABASE_URL`, and existing port 4177.
- Produces: the authoritative app on port 4177 with run 23 recovered and visible progress.

- [ ] **Step 1: Run the complete affected gate**

Run:

```powershell
npx.cmd vitest run tests/domain/targeted/store.test.ts tests/domain/targeted/service.test.ts tests/domain/targeted/mailInfrastructure.test.ts tests/api/targetedApi.test.ts tests/public/staticUi.test.ts
npm.cmd run build
git diff --check
```

Expected: all tests and checks pass.

- [ ] **Step 2: Back up and verify the preserved database**

Create a timestamped copy under `C:\Users\Lenovo\Desktop\Leads-genx\backups` using the project's SQLite backup helper or a transaction-safe SQLite copy. Verify the copy exists and has non-zero length. Do not modify campaign rows manually.

- [ ] **Step 3: Stop only the verified legacy server**

Identify the process listening on port 4177, verify its PID, start time, and executable, then stop that exact process. Do not stop unrelated Node processes.

- [ ] **Step 4: Start the authoritative build with preserved data**

Set:

```powershell
$env:DATABASE_URL='file:C:/Users/Lenovo/Desktop/Leads-genx/prisma/dev.db'
$env:PORT='4177'
```

Start `node dist/server.js` from `C:\Users\Lenovo\Desktop\Leads-genx-remote` in a hidden background process. The server startup recovery must reset run 23's interrupted unit and resume it through the syntax-only pipeline.

- [ ] **Step 5: Verify the live cutover**

Confirm port 4177 serves HTML containing `shuffleFiltersBtn`. Authenticate through the existing session flow without exposing credentials, fetch campaign 23, and verify that its unit progress heartbeat or completed-unit count changes across two polls. Confirm its valid count can increase without an MX resolver.

- [ ] **Step 6: Commit operational notes and push**

Record the test totals, build result, backup filename, new server PID, and run 23 recovery result in `docs/AGENT_LOG.md`, then commit and push `main`:

```powershell
git add docs/AGENT_LOG.md
git commit -m "docs: record targeted progress cutover"
git push origin main
```

