# Leads-GenX

Leads-GenX is a local operator dashboard for high-volume business lead collection and targeted professional lead collection.

The app runs locally at `http://localhost:4177` and stores runs, leads, events, settings, and errors in SQLite.

## Lead Sources

### Google Maps / Google Business Profile

This is the recommended higher-volume source. Use business search terms, categories, and one or more locations to collect company-level leads such as business name, category, address, website, phone, rating, review count, and Google Maps URL. A pasted Google Maps URL is optional and only needed as an advanced override.

Default actor: `compass/google-maps-extractor`

### LinkedIn Sales Navigator

This is useful for targeted person-level prospecting, but it is the riskier source. LinkedIn restricts unauthorized automated access and may limit or restrict accounts for misuse. Leads-GenX does not include stealth browser automation, CAPTCHA bypass, credential harvesting, or login automation.

Default actor: `harvestapi/linkedin-sales-navigator-lead-search-cookie`

Sales Navigator runs use the actor's `Full + email search` mode and require an active Sales Navigator session. Enter exported LinkedIn cookie JSON and the matching browser user-agent string in the run form. These request-scoped values are sent to the actor but are not stored in run history, events, or logs.

One Sales Navigator run can request at most 2,500 profiles (100 pages of 25). The number of email leads can be lower because profiles without a discovered email are excluded from Leads-GenX.

## Setup

```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

Open:

```text
http://localhost:4177
```

If PowerShell blocks `npm`, use `npm.cmd`:

```bash
npm.cmd run dev
```

`npm run dev` now builds first and then runs the compiled server from `dist/server.js`.
Use `npm run dev:watch` only if you want the older `nodemon` + `ts-node` workflow.

## Configuration

The app defaults to:

```text
PORT=4177
```

Optional `.env` overrides:

```text
PORT=4177
DEFAULT_GOOGLE_MAPS_ACTOR_ID="compass/google-maps-extractor"
DEFAULT_SALES_NAVIGATOR_ACTOR_ID="harvestapi/linkedin-sales-navigator-lead-search-cookie"
```

## Export

Use the Leads tab to download TXT exports for all leads or a selected run.

## Verification

```bash
npm test
npm run build
```
