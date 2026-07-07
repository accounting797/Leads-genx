# Sales Navigator Lead Scraper Design

## Scope

Build a new single-user operator application for extracting and managing LinkedIn Sales Navigator lead results through a configurable Apify actor integration.

The application is intended for commercial use as a local/operator tool. It will prioritize reliability, auditability, maintainability, and a polished workflow over SaaS features. It will not include multi-user authentication, billing, tenant isolation, CAPTCHA bypass, stealth browser automation, credential theft, or scraping of data the operator is not authorized to access.

## Goals

- Provide a clean Express + TypeScript backend with SQLite persistence.
- Provide a vanilla JavaScript dark-theme UI suitable for repeated lead generation work.
- Support Sales Navigator URLs and structured lead filters.
- Include multi-select chip filters with curated suggestions per category.
- Track scraping runs live from start to completion.
- Store leads, runs, run events, app settings, and error logs.
- Export leads to TXT by run or across all runs.
- Use test-first implementation for core behavior.
- Keep scraping execution behind an adapter so the selected Apify actor can be changed without rewriting the app.

## Non-Goals

- No multi-user SaaS account system in the first version.
- No browser extension in the first version.
- No raw LinkedIn page automation from the app.
- No CAPTCHA bypass, anti-detection code, or login/session harvesting.
- No automatic email verification or enrichment beyond fields returned by the configured actor.
- No CRM integrations in the first version.

## Architecture

The application will be a single Node.js service using Express and TypeScript. It will serve both JSON API routes and static frontend assets. SQLite will be managed through Prisma because it gives a stable schema, migrations, typed database access, and an upgrade path to Postgres later.

The scraping layer will be isolated behind an `ActorClient` interface. The first implementation will use the Apify SDK and a configurable LinkedIn/Sales Navigator actor. This keeps the backend commercial-grade without coupling core run management to one community actor's input or output shape.

The frontend will be plain HTML, CSS, and JavaScript. It will be split into static files rather than one large HTML file: `index.html`, `styles.css`, `api.js`, `state.js`, `chips.js`, `ui.js`, and `app.js`.

## Compliance Boundary

The app will only run with operator-provided authorized inputs:

- Apify API token.
- Sales Navigator search URL or structured search filters.
- Optional actor configuration supported by the selected actor.

The app will not collect LinkedIn credentials, attempt to bypass LinkedIn protections, automate login flows, or hide automation from target services. Any session cookie support must be explicit, optional, locally stored only if the operator chooses, and never logged. The UI will label sensitive inputs and the backend will redact secrets from logs and API responses.

## Backend Components

### Server

`src/server.ts` creates the Express app, configures JSON limits, request IDs, static files, API routes, error handling, and graceful shutdown.

### Database

`src/db/client.ts` exports a singleton Prisma client. Tests will use a disposable SQLite database.

### Validation

`src/domain/validation.ts` validates run creation input:

- Requires `apifyToken` unless a saved token exists in settings.
- Requires either `searchUrl` or at least one structured filter.
- Requires `maxResults` between 1 and 1000.
- Rejects invalid URLs unless they are empty and filters are present.
- Redacts sensitive values from validation errors.

### Filter Builder

`src/domain/filterBuilder.ts` converts structured filters into a Sales Navigator URL query. Multi-value fields are supported for titles, industries, seniority, functions, geography, company type, headcount, and years-in-role filters.

### Suggestions

`src/domain/suggestions.ts` contains curated suggestions for:

- Job titles.
- Industries.
- Seniority levels.
- Departments/functions.
- Company headcount.
- Company type.
- Geography.
- Years in current company.
- Years in current position.

Suggestions are returned by `GET /api/suggestions` and rendered as searchable multi-select chips.

### Runs

`src/domain/runService.ts` owns run lifecycle:

- Create a queued run.
- Start actor execution asynchronously.
- Record run events.
- Save normalized leads.
- Mark the run as completed or failed.
- Record detailed error logs while returning safe client-facing errors.

The frontend receives immediate confirmation after starting a run and then polls for progress.

### Actor Adapter

`src/integrations/apifyActorClient.ts` implements:

```ts
export interface ActorClient {
  startRun(input: ActorRunInput): Promise<ActorRunStarted>;
  getRun(runId: string): Promise<ActorRunStatus>;
  getDatasetItems(datasetId: string): Promise<unknown[]>;
}
```

The adapter maps app-level run input to actor input and maps actor output to normalized leads. Actor ID will be configurable through settings or `.env`.

### Logging

`src/domain/errorLogger.ts` writes structured error records to SQLite and to `logs/app.log`. Secrets are redacted before logging. Error logs include:

- Timestamp.
- Request ID.
- Run ID when available.
- Source component.
- Severity.
- Safe message.
- Stack trace or raw payload when safe.

### Export

`src/domain/exportFormatter.ts` formats leads as TXT:

```text
Name | Title | Company | Email | Profile URL | Location
Jane Doe | VP Sales | Example Inc | jane@example.com | https://... | Austin, TX
```

TXT download routes support all leads or a specific run.

## Database Schema

### Run

- `id`
- `status`: `queued`, `running`, `completed`, `failed`, `cancelled`
- `searchUrl`
- `filterJson`
- `actorId`
- `apifyRunId`
- `datasetId`
- `maxResults`
- `leadCount`
- `errorMessage`
- `startedAt`
- `completedAt`
- `createdAt`
- `updatedAt`

### Lead

- `id`
- `runId`
- `fullName`
- `firstName`
- `lastName`
- `jobTitle`
- `companyName`
- `email`
- `phone`
- `location`
- `profileUrl`
- `connectionDegree`
- `rawJson`
- `createdAt`

### RunEvent

- `id`
- `runId`
- `type`
- `message`
- `metadataJson`
- `createdAt`

### AppSetting

- `key`
- `value`
- `secret`
- `updatedAt`

Secret settings are stored locally and never returned through normal API responses.

### ErrorLog

- `id`
- `runId`
- `requestId`
- `source`
- `severity`
- `message`
- `detailsJson`
- `createdAt`

## API

### `GET /api/health`

Returns service status and version.

### `GET /api/suggestions`

Returns curated filter suggestions.

### `POST /api/runs`

Starts a run. Body:

```json
{
  "apifyToken": "optional when saved",
  "searchUrl": "https://www.linkedin.com/sales/search/people?...",
  "filters": {
    "keywords": "SaaS",
    "titles": ["VP Sales", "Head of Growth"],
    "industries": ["Software Development"],
    "geographies": ["United States"]
  },
  "maxResults": 100,
  "actorId": "harvestapi/linkedin-profile-search"
}
```

Returns:

```json
{
  "data": {
    "id": 1,
    "status": "queued"
  }
}
```

### `GET /api/runs`

Lists runs with lead counts and latest event summary.

### `GET /api/runs/:id`

Returns one run with leads.

### `GET /api/runs/:id/events`

Returns chronological run events for live progress.

### `GET /api/leads`

Lists leads, optionally filtered by `runId`.

### `GET /api/leads/download`

Downloads TXT for all leads or `?runId=1`.

### `GET /api/errors`

Lists recent error logs for the operator UI.

### `POST /api/settings`

Saves local settings such as default actor ID, max result default, and optional Apify token storage.

## Frontend UX

The first screen is the actual operating dashboard, not a marketing page.

### Layout

- Sticky top bar with app name, run count, lead count, active run count.
- Left/main panel for starting a run.
- Right/secondary panel for live progress and recent errors.
- Lower tabs for runs, leads, and logs.

### New Run Form

- Apify token input, with option to save locally.
- Sales Navigator URL input.
- Structured filter builder as an alternative to direct URL.
- Multi-select chip filters for titles, industries, functions, seniority, geographies, and company attributes.
- Numeric max results input.
- Actor ID advanced field.
- Start button disabled during invalid input.

### Live Progress

- Shows queued/running/completed/failed states.
- Polls run and event endpoints.
- Displays elapsed time, current status, lead count, actor run ID, and latest event.
- Failed runs show a safe error message and link to the logs tab.

### Runs

- Table with status badge, date, filter summary, lead count, and actions.
- Actions: view leads, download TXT, view errors.

### Leads

- Table with full name, title, company, email, location, profile URL.
- Filter by run.
- Download TXT button.

### Logs

- Error log table with timestamp, severity, source, message, and details drawer.
- Secrets are never rendered.

## Security And Secret Handling

- Secrets are redacted from logs, run events, API responses, and frontend error messages.
- `.env` is ignored by git.
- Optional saved token storage is local only.
- No sensitive values are stored in run events.
- Request body logging is not enabled.
- The app uses explicit JSON body size limits.

## Error Handling

Errors are split into:

- Validation errors: returned as 400 with field-level messages.
- Actor errors: logged with details, returned as safe run failure messages.
- Database errors: logged with stack, returned as generic server errors.
- Unknown errors: logged with request ID, returned as generic server errors.

Every failed run gets a terminal `failed` status and a `run_failed` event.

## Testing Strategy

Use Vitest and Supertest.

Required tests:

- Filter builder handles single and multi-value filters.
- Validation rejects missing inputs and invalid limits.
- TXT formatter produces stable output with empty fields.
- Run service records queued, running, completed, and failed lifecycle events.
- Apify adapter maps dataset items to normalized leads.
- API start-run route returns immediately and does not expose secrets.
- Error logger redacts tokens and session-like values.

The implementation will follow test-driven development for production logic. Static UI behavior will be verified manually in-browser after backend tests pass.

## Build And Run

Expected commands:

```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm test
npm run build
npm run dev
```

The development server will run at `http://localhost:4177` unless `PORT` is set. This avoids conflict with the existing lead generator project that commonly uses port `3000`.

## Future Upgrade Path

The first version is single-user. A SaaS version can be added later by:

- Moving SQLite to Postgres.
- Adding users and sessions.
- Scoping runs, leads, settings, and errors by `userId`.
- Encrypting per-user secrets.
- Adding quotas, audit logs, and billing hooks.
- Moving long-running actor polling to a worker queue.
