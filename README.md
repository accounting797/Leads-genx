# Leads-GenX

Leads-GenX is a local operator dashboard for high-volume business lead collection and targeted professional lead collection.

The app runs locally at `http://localhost:4177` and stores runs, leads, events, settings, and errors in SQLite.

## Lead Sources

### Google Maps / Google Business Profile

This is the recommended higher-volume source. Use business search terms, categories, and one or more locations to collect company-level leads such as business name, category, address, website, phone, rating, review count, and Google Maps URL. A pasted Google Maps URL is optional and only needed as an advanced override.

Google Maps runs automatically use Docker Local-First; there is no provider selection step. The pipeline submits deterministic, one-location browser batches to the locally built scraper on `127.0.0.1:8080`, checkpoints each batch in SQLite, merges duplicate businesses, and only uses Google Places for the remaining target. The Google fallback defaults to 25 HTTP requests and is capped at 500. Set its budget to `0` for browser-only discovery.

Local-first runs accept up to 10,000 target businesses. This is a target, not a guaranteed result count: Google availability, search coverage, websites, and published email addresses determine the actual output. Browser concurrency remains at 1 while direct-mode reliability is being established.

API keys and proxy URLs are request-scoped. They are never written to run filters, events, or scraper job records, and the dashboard clears them after an accepted request. Direct mode uses the host's public IP. If a run is interrupted, direct batches resume from their stored checkpoints; secret-dependent runs wait for credential re-entry.

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

Build and start the pinned local scraper image before a local-first run:

```powershell
npm.cmd run scraper:build
npm.cmd run scraper:up
```

The scraper source defaults to `C:\Users\Lenovo\Downloads\New folder\google-maps-scraper` and the image is pinned as `leads-genx/google-maps-scraper:1.16.3-local`. Its API is intentionally bound only to `127.0.0.1:8080`.

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
GOOGLE_MAPS_SCRAPER_SOURCE="C:\Users\Lenovo\Downloads\New folder\google-maps-scraper"
```

Runtime health checks:

```powershell
Invoke-RestMethod http://127.0.0.1:4177/api/health
Invoke-RestMethod http://127.0.0.1:4177/api/scraper/health
Invoke-RestMethod http://127.0.0.1:8080/api/v1/jobs
```

When the local SOCKS ports are online, enter full URLs such as `socks5h://user:password@127.0.0.1:60001` in the request-scoped proxy box. Leads-GenX translates loopback to `host.docker.internal` for the container. Leave the box empty while the ports are offline; proxy supervision and rotation remain dormant.

## Settings

The dashboard **Settings** tab stores operator defaults locally in SQLite: actor IDs, the Apify token, Google API keys, and a proxy pool. Saved secrets are never returned by the API — the dashboard shows only their status, and proxy passwords are masked (`••••••`). Saving a masked proxy entry unchanged keeps the stored credential.

Runs fall back to saved Google keys and the saved Apify token when the run form fields are left empty. Tick **Use proxies saved in Settings** on the run form to route Docker traffic through the saved proxy pool. **Test Proxies** probes each SOCKS5/HTTP proxy with a live connection and reports latency or a failure code.

## Export

Use the Leads tab to download TXT exports for all leads or a selected run.

## Verification

```bash
npm test
npm run build
```
