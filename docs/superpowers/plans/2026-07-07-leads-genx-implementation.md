# Leads-GenX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Leads-GenX, a production-grade local operator app for lead generation with Express, TypeScript, SQLite, Apify-backed Sales Navigator extraction, polished vanilla JS dark UI, live progress, error logging, and TXT export.

**Architecture:** A single Express service serves JSON APIs and static frontend assets on port `4177`. Prisma manages SQLite persistence. Scraping execution is isolated behind an Apify actor adapter so Sales Navigator is the first source and Google Maps can be added later without changing the core run, lead, log, or export flow.

**Tech Stack:** Node.js, Express, TypeScript, Prisma, SQLite, Vitest, Supertest, vanilla HTML/CSS/JavaScript, Apify SDK.

## Global Constraints

- Product name and UI brand must be `Leads-GenX`.
- Default development URL must be `http://localhost:4177`; do not use port `3000`.
- First version is single-user/operator only; do not add SaaS auth, billing, or tenant isolation.
- Do not implement CAPTCHA bypass, stealth automation, raw LinkedIn browser automation, credential theft, or login/session harvesting.
- Secrets must be redacted from logs, run events, API responses, and frontend error messages.
- Sales Navigator is the initial lead source; design service boundaries so `google_maps` can be added later.
- Use TDD for production TypeScript logic: write failing tests before implementation.
- Keep UI vanilla JS and visually polished for repeated commercial use.

---

## File Structure

- Create `package.json`: scripts, dependencies, and app metadata.
- Create `tsconfig.json`: TypeScript build settings.
- Create `.gitignore`: ignore dependencies, build output, env files, SQLite files, and logs.
- Create `.env.example`: documented local configuration.
- Create `prisma/schema.prisma`: SQLite schema for runs, leads, events, settings, and logs.
- Create `src/server.ts`: app startup on port `4177`.
- Create `src/app.ts`: Express app factory for tests and runtime.
- Create `src/db/client.ts`: Prisma singleton.
- Create `src/domain/types.ts`: shared domain types.
- Create `src/domain/redact.ts`: secret redaction helper.
- Create `src/domain/suggestions.ts`: curated filter data.
- Create `src/domain/filterBuilder.ts`: Sales Navigator URL builder.
- Create `src/domain/validation.ts`: run input validation.
- Create `src/domain/exportFormatter.ts`: TXT formatter.
- Create `src/domain/errorLogger.ts`: database and file logging.
- Create `src/domain/leadNormalizer.ts`: actor output normalization.
- Create `src/domain/runService.ts`: run lifecycle orchestration.
- Create `src/integrations/actorClient.ts`: actor client interface.
- Create `src/integrations/apifyActorClient.ts`: Apify SDK implementation.
- Create `src/routes/api.ts`: API routes.
- Create `src/utils/asyncHandler.ts`: Express async helper.
- Create `public/index.html`: Leads-GenX dashboard shell.
- Create `public/styles.css`: polished dark UI.
- Create `public/api.js`: frontend API wrapper.
- Create `public/chips.js`: multi-select chip component.
- Create `public/ui.js`: rendering helpers.
- Create `public/app.js`: frontend app wiring.
- Create `tests/domain/*.test.ts`: unit tests for domain logic.
- Create `tests/api/*.test.ts`: API tests.

---

### Task 1: Project Scaffold And Tooling

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`

**Interfaces:**
- Produces: npm scripts `dev`, `build`, `start`, `test`, `prisma:generate`, `prisma:migrate`.
- Produces: default port contract `PORT=4177`.

- [ ] **Step 1: Create package metadata and scripts**

Create `package.json` with:

```json
{
  "name": "leads-genx",
  "version": "1.0.0",
  "description": "Production-grade local lead generation operator app.",
  "main": "dist/server.js",
  "type": "commonjs",
  "scripts": {
    "dev": "nodemon --exec ts-node src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate dev --name init"
  },
  "dependencies": {
    "@prisma/client": "^5.22.0",
    "apify-client": "^2.23.4",
    "express": "^5.2.1"
  },
  "devDependencies": {
    "@types/express": "^5.0.6",
    "@types/node": "^26.1.0",
    "nodemon": "^3.1.14",
    "prisma": "^5.22.0",
    "supertest": "^7.1.4",
    "@types/supertest": "^6.0.3",
    "ts-node": "^10.9.2",
    "typescript": "^6.0.3",
    "vitest": "^3.2.4"
  }
}
```

- [ ] **Step 2: Add TypeScript config**

Create `tsconfig.json` with `rootDir` as `src`, `outDir` as `dist`, CommonJS output, strict mode, and Node module resolution.

- [ ] **Step 3: Add local config examples**

Create `.env.example`:

```text
DATABASE_URL="file:./dev.db"
PORT=4177
DEFAULT_ACTOR_ID="harvestapi/linkedin-profile-search"
```

Create `.gitignore`:

```text
node_modules/
dist/
.env
*.db
*.db-journal
logs/
coverage/
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`

Expected: `package-lock.json` is created and install exits successfully.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore .env.example
git commit -m "chore: scaffold Leads-GenX project"
```

---

### Task 2: Database Schema

**Files:**
- Create: `prisma/schema.prisma`
- Create: `src/db/client.ts`

**Interfaces:**
- Produces Prisma models: `Run`, `Lead`, `RunEvent`, `AppSetting`, `ErrorLog`.
- Produces `prisma` singleton from `src/db/client.ts`.

- [ ] **Step 1: Add Prisma schema**

Create `prisma/schema.prisma` with SQLite datasource and models matching the approved spec. Include `leadSource String @default("sales_navigator")` on `Run`.

- [ ] **Step 2: Add database client**

Create `src/db/client.ts`:

```ts
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
```

- [ ] **Step 3: Generate and migrate**

Run:

```bash
npm run prisma:generate
npm run prisma:migrate
```

Expected: Prisma client generated and initial SQLite migration created.

- [ ] **Step 4: Commit**

```bash
git add prisma src/db
git commit -m "feat: add sqlite schema"
```

---

### Task 3: Domain Utilities With TDD

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/domain/redact.ts`
- Create: `src/domain/suggestions.ts`
- Create: `src/domain/filterBuilder.ts`
- Create: `src/domain/validation.ts`
- Create: `src/domain/exportFormatter.ts`
- Create: `src/domain/leadNormalizer.ts`
- Test: `tests/domain/filterBuilder.test.ts`
- Test: `tests/domain/validation.test.ts`
- Test: `tests/domain/exportFormatter.test.ts`
- Test: `tests/domain/redact.test.ts`
- Test: `tests/domain/leadNormalizer.test.ts`

**Interfaces:**
- Produces `buildSalesNavigatorUrl(filters: LeadFilters): string`.
- Produces `validateCreateRunInput(input: unknown, hasSavedToken: boolean): ValidatedRunInput`.
- Produces `formatLeadsTxt(leads: ExportLead[]): string`.
- Produces `redactSecrets(value: unknown): unknown`.
- Produces `normalizeLead(item: unknown): NormalizedLead`.

- [ ] **Step 1: Write failing filter builder test**

Test multi-value titles and industries:

```ts
import { describe, expect, it } from 'vitest';
import { buildSalesNavigatorUrl } from '../../src/domain/filterBuilder';

describe('buildSalesNavigatorUrl', () => {
  it('builds a sales navigator URL from multi-value filters', () => {
    const url = buildSalesNavigatorUrl({
      keywords: 'SaaS',
      titles: ['VP Sales', 'Head of Growth'],
      industries: ['Software Development'],
      geographies: ['United States']
    });

    expect(url).toContain('https://www.linkedin.com/sales/search/people');
    expect(decodeURIComponent(url)).toContain('keywords:SaaS');
    expect(decodeURIComponent(url)).toContain('title:VP Sales');
    expect(decodeURIComponent(url)).toContain('title:Head of Growth');
    expect(decodeURIComponent(url)).toContain('industry:Software Development');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/domain/filterBuilder.test.ts`

Expected: FAIL because `filterBuilder` does not exist.

- [ ] **Step 3: Implement domain types and filter builder**

Implement `LeadFilters` with optional strings and string arrays. Implement `buildSalesNavigatorUrl` using `URLSearchParams` and a stable encoded `query` value.

- [ ] **Step 4: Run filter builder test to verify it passes**

Run: `npm test -- tests/domain/filterBuilder.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing validation tests**

Cover missing token, missing search criteria, invalid URL, and max result bounds.

- [ ] **Step 6: Implement validation**

Implement field-level errors with safe messages only. Do not echo token or cookie-like values.

- [ ] **Step 7: Write failing export formatter test**

Assert exact TXT output with empty optional fields converted to empty strings.

- [ ] **Step 8: Implement export formatter**

Implement stable pipe-delimited output with header.

- [ ] **Step 9: Write failing redaction test**

Assert `apifyToken`, `token`, `cookie`, `li_at`, and long bearer-like values are redacted.

- [ ] **Step 10: Implement redaction helper**

Implement recursive object and string redaction.

- [ ] **Step 11: Write failing lead normalizer test**

Cover common actor field aliases: `fullName`, `name`, `jobTitle`, `title`, `companyName`, `company`, `profileUrl`, `linkedinUrl`.

- [ ] **Step 12: Implement lead normalizer**

Return normalized fields and `rawJson`.

- [ ] **Step 13: Run all domain tests**

Run: `npm test -- tests/domain`

Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add src/domain tests/domain
git commit -m "feat: add tested domain utilities"
```

---

### Task 4: Run Service And Actor Adapter

**Files:**
- Create: `src/integrations/actorClient.ts`
- Create: `src/integrations/apifyActorClient.ts`
- Create: `src/domain/errorLogger.ts`
- Create: `src/domain/runService.ts`
- Test: `tests/domain/runService.test.ts`

**Interfaces:**
- Produces `ActorClient`.
- Produces `createRunService(deps)`.
- Produces run lifecycle states `queued`, `running`, `completed`, `failed`.

- [ ] **Step 1: Write failing run service success test**

Use an in-memory fake actor client that returns a started run, completed status, dataset ID, and two lead items. Assert run status becomes `completed`, events are recorded, and normalized leads are saved.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/domain/runService.test.ts`

Expected: FAIL because `runService` does not exist.

- [ ] **Step 3: Implement actor interface**

Create `ActorClient`, `ActorRunInput`, `ActorRunStarted`, and `ActorRunStatus` types.

- [ ] **Step 4: Implement error logger**

Write error logs to SQLite and append JSON lines to `logs/app.log`. Redact details before persistence.

- [ ] **Step 5: Implement run service**

Create queued run, mark running, call actor, poll or wait through adapter, save leads, record events, and mark completed.

- [ ] **Step 6: Verify success test passes**

Run: `npm test -- tests/domain/runService.test.ts`

Expected: PASS for success path.

- [ ] **Step 7: Write failing run service failure test**

Fake actor throws `new Error('token secret_123 failed')`. Assert run is `failed`, error log exists, and saved client message does not include the token-like value.

- [ ] **Step 8: Implement failure path**

Catch actor errors, redact messages, write `run_failed` event, set terminal failed status.

- [ ] **Step 9: Implement Apify actor client**

Use `ApifyClient` from `apify-client`. Start actor with supplied `actorId`, wait for finish, and list dataset items when the run succeeds.

- [ ] **Step 10: Run tests**

Run: `npm test -- tests/domain/runService.test.ts`

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/integrations src/domain/errorLogger.ts src/domain/runService.ts tests/domain/runService.test.ts
git commit -m "feat: add run lifecycle service"
```

---

### Task 5: Express API

**Files:**
- Create: `src/app.ts`
- Create: `src/server.ts`
- Create: `src/routes/api.ts`
- Create: `src/utils/asyncHandler.ts`
- Test: `tests/api/api.test.ts`

**Interfaces:**
- Produces API routes from the approved spec.
- Produces runtime server at `http://localhost:4177`.

- [ ] **Step 1: Write failing API health test**

Assert `GET /api/health` returns `{ data: { name: 'Leads-GenX', status: 'ok' } }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/api/api.test.ts`

Expected: FAIL because app routes do not exist.

- [ ] **Step 3: Implement app factory and health route**

Create `createApp()` and mount API router.

- [ ] **Step 4: Verify health test passes**

Run: `npm test -- tests/api/api.test.ts`

Expected: PASS for health route.

- [ ] **Step 5: Write failing run-start API test**

Mock or inject run service. Assert `POST /api/runs` returns 202, `queued`, and does not echo `apifyToken`.

- [ ] **Step 6: Implement API routes**

Implement `/api/suggestions`, `/api/runs`, `/api/runs/:id`, `/api/runs/:id/events`, `/api/leads`, `/api/leads/download`, `/api/errors`, and `/api/settings`.

- [ ] **Step 7: Add server startup**

`src/server.ts` must use `Number(process.env.PORT || 4177)`.

- [ ] **Step 8: Run API tests**

Run: `npm test -- tests/api`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/app.ts src/server.ts src/routes src/utils tests/api
git commit -m "feat: add express api"
```

---

### Task 6: Frontend Dashboard

**Files:**
- Create: `public/index.html`
- Create: `public/styles.css`
- Create: `public/api.js`
- Create: `public/chips.js`
- Create: `public/ui.js`
- Create: `public/app.js`

**Interfaces:**
- Consumes API routes from Task 5.
- Produces a polished Leads-GenX dashboard with multi-select filters, live progress, run table, lead table, logs, and TXT download.

- [ ] **Step 1: Create HTML shell**

Use the app name `Leads-GenX`, first-screen dashboard layout, form panel, progress panel, and tabs for Runs, Leads, Logs.

- [ ] **Step 2: Create dark visual system**

Use a restrained commercial dark theme with strong contrast, 8px card radii or less, stable table layouts, status badges, responsive grids, and no marketing hero.

- [ ] **Step 3: Implement frontend API wrapper**

Create functions: `getHealth`, `getSuggestions`, `createRun`, `listRuns`, `getRun`, `getRunEvents`, `listLeads`, `listErrors`, `downloadLeads`.

- [ ] **Step 4: Implement chip controls**

Build searchable multi-select chips with keyboard-friendly input, removable chips, selected state, and single-select mode where needed.

- [ ] **Step 5: Implement UI renderers**

Render stats, run rows, lead rows, error rows, progress state, and safe empty states.

- [ ] **Step 6: Wire app behavior**

Load suggestions, initialize chips, validate the form client-side, submit runs, poll active runs every 3 seconds, refresh tables, and trigger TXT downloads.

- [ ] **Step 7: Commit**

```bash
git add public
git commit -m "feat: add Leads-GenX dashboard"
```

---

### Task 7: Verification And Local Run

**Files:**
- Modify: `README.md`

**Interfaces:**
- Produces documented setup and local run instructions.
- Confirms build, tests, and local server behavior.

- [ ] **Step 1: Add README**

Document:

- Product name: Leads-GenX.
- Default URL: `http://localhost:4177`.
- Setup commands.
- Apify token handling.
- Sales Navigator risk note.
- Google Maps future-source note.
- TXT export behavior.

- [ ] **Step 2: Run all tests**

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 3: Build**

Run: `npm run build`

Expected: TypeScript build succeeds.

- [ ] **Step 4: Start dev server**

Run: `npm run dev`

Expected: server starts on `http://localhost:4177`.

- [ ] **Step 5: Browser verification**

Open `http://localhost:4177` and verify:

- Leads-GenX brand is visible.
- New run form renders.
- Chip filters open and select values.
- Tabs switch without layout breakage.
- Download button points to `/api/leads/download`.
- Text does not overlap on desktop or mobile widths.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: add setup and verification guide"
```

---

## Self-Review Notes

- Spec coverage: all approved requirements map to tasks: clean app, port `4177`, Leads-GenX name, Express, TypeScript, SQLite, vanilla JS UI, chip filters, suggestions, progress, logs, TXT export, Apify adapter, and TDD.
- Placeholder scan: no `TBD`, `TODO`, or unspecified implementation tasks remain.
- Type consistency: `LeadFilters`, `ValidatedRunInput`, `ActorClient`, and run statuses are named consistently across tasks.
