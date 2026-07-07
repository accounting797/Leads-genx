# Leads-GenX

Leads-GenX is a local operator dashboard for high-volume business lead collection and targeted professional lead collection.

The app runs locally at `http://localhost:4177` and stores runs, leads, events, settings, and errors in SQLite.

## Lead Sources

### Google Maps / Google Business Profile

This is the recommended higher-volume source. Use business search terms, categories, and one or more locations to collect company-level leads such as business name, category, address, website, phone, rating, review count, and Google Maps URL. A pasted Google Maps URL is optional and only needed as an advanced override.

Default actor: `compass/google-maps-extractor`

### LinkedIn Sales Navigator

This is useful for targeted person-level prospecting, but it is the riskier source. LinkedIn restricts unauthorized automated access and may limit or restrict accounts for misuse. Leads-GenX does not include stealth browser automation, CAPTCHA bypass, credential harvesting, or login automation.

Default actor: `harvestapi/linkedin-profile-search`

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
DEFAULT_SALES_NAVIGATOR_ACTOR_ID="harvestapi/linkedin-profile-search"
```

## Export

Use the Leads tab to download TXT exports for all leads or a selected run.

## Verification

```bash
npm test
npm run build
```
