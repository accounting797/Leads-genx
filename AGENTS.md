# AGENTS.md — Working on Leads-GenX

This file is the shared brain for every agent that touches this repo (Codex, Kimi, and friends).
Read it fully before changing anything. Honor it exactly.

## What this is

Leads-GenX — multi-user lead-generation SaaS. Node.js + TypeScript + Express 5 + Prisma (SQLite),
vanilla JS SPA frontend (`public/`, no build step). Deployed at `leadsgenx.top` via a one-click
deploy/update wizard in the admin panel. Production lives at `/opt/Leads-genx` on the VPS;
updates run `update-server.sh` (git pull → npm install → build → prisma db push → restart).

## The voice: Nova

The product's AI assistant is **Nova** — warm, plain-English, never robotic. Verdicts are
`Excellent` / `All good` / `Needs a look` / `Needs your help` — never "good/bad".
Every user-facing run message, event, and error keeps this tone. When a system must cool down,
rest, or skip something, Nova says so honestly and says what was saved. Copy examples live in
`src/domain/balancedGoogleMapsRunService.ts`, `src/domain/runEngineer.ts`, `src/domain/runAnalyst.ts`.

## Architecture map (know your lane)

Lead sources & engines:

| Lane | Code | Notes |
|---|---|---|
| Google Maps local-first (Docker scraper + Google Places) | `src/domain/balancedGoogleMapsRunService.ts` | Docker is a **bonus lane, never a blocker**. Role/function keywords are Google-lane only (`src/domain/localDiscoveryBatch.ts`). Docker lane closes early once Google delivered + lane quiet past grace window. |
| Google Maps via Apify / Google Places / Hybrid | `src/domain/runService.ts` (`runApifyShards`, `runGooglePlaces`) | Streaming Apify ingestion, parallel shards (≤3), race-safe counter. |
| Sales Navigator via HarvestAPI (SN URL or filters + cookies) | `src/domain/runService.ts` → Apify actor | Needs Apify token + LinkedIn cookies + userAgent. |
| **Sales Navigator-style filters via Bright Data** | `src/domain/brightDataLinkedInSearch.ts` | No SN account needed. Metadata-driven filter mapping onto the contact-enriched people dataset (`gd_me5ppxjr2ge6icjuh0`); unfilterable groups are skipped with an honest Nova note. Emails ride along when available. |
| **Greenhouse hiring signals** | `src/domain/hiringSignalService.ts` + `src/routes/hiringSignals.ts` | Supplemental public-data lane. It annotates exact companies in their original Maps/Sales Nav lane and keeps adjacent opportunities in `hiring_opportunity`; it never creates leads, changes parent counts/status, or starts a paid search. |
| SN Chrome extension (GrowMeOrganic-style) | `extension/` + `src/routes/extension.ts` | MV3, scrapes SN lead searches on the user's own session, auto-paginates politely, streams batches to `POST /api/extension/leads` (Bearer = per-user `User.extensionToken`). Packaged zip: `public/downloads/leadsgenx-sn-extension.zip` — **regenerate it whenever `extension/` changes**. |
| Bright Data contact enrichment | `src/domain/linkedinEnrichment.ts` + `POST /api/runs/:id/enrich-linkedin` | Fills emails/phones for LinkedIn leads. BYOD key wins over operator key. |

Cross-cutting:
- **Anti-hang discipline (sacred):** every network call has a hard timeout; stalls map to
  retryable transient errors; polls are strike-tolerant (Docker 3, Apify 6, Bright Data 6);
  long operations emit heartbeat events every 15–20s so the UI always shows proof of life.
  NEVER add an unbounded `fetch`/await.
- **Run Engineer** (`src/domain/runEngineer.ts`): retries, cooling cycles (heat ≥3 → 45s),
  quarantines dead credentials, escalates "Nova needs your help" when spent.
- **Credentials:** operator pool in `AppSetting` via `src/domain/operatorSettings.ts`;
  per-user BYOD via `src/domain/userCredentials.ts` (BYOD wins per field). Secrets are never
  echoed — safe shapes only (`toSafe*`), masking with `SECRET_MASK`.
- **Validation:** `src/domain/validation.ts` is the single gate for run inputs. SN filter
  searches run on Bright Data (key only) OR HarvestAPI (cookies + Apify); URL searches need
  Apify + cookies + userAgent.
- **Auth:** sessions via cookie; extension via Bearer token. Usernames are case-insensitive
  (`findUserByUsername`).
- **Source separation:** `google_maps`, `sales_navigator`, and `hiring_opportunity`
  are separate API/UI lanes. Hiring scans begin only after eligible parent runs settle,
  run at most two globally, and may never hold or reopen the parent run.

## The test ritual (run before EVERY commit)

```bash
export DATABASE_URL="file:/tmp/t.db" && rm -f /tmp/t.db \
  && npx prisma db push --skip-generate && npm test
npm run build   # plain — never pipe tsc; a masked exit code once nearly shipped a broken build
```

Current suite: 453 tests, all must pass. Add tests for every behavioral change
(harness examples: `tests/api/extensionApi.test.ts`, `tests/domain/brightDataLinkedInSearch.test.ts`).

## Conventions

- TypeScript strict. No `any` leaks in new code. Errors: typed error classes per integration
  (`BrightDataError`, `LocalScraperError`, `GooglePlacesError`) with `code` + actionable message.
- Events are the UI's lifeline: emit Nova-warm `store.addEvent` for starts, progress, skips,
  completions, failures. Frontend polls runs + events; countdown resets to zero at terminal
  states and auto-switches to another active run.
- Schema changes: edit `prisma/schema.prisma`, no migration files (db push handles it).
- Frontend: vanilla JS in `public/` — `app.js` (logic), `api.js` (API client), `ui.js`
  (renderers), `index.html`, `styles.css`. `node --check` them after edits.
- Low-saturation UI, warm tones, no blue-purple gradients.

## Do NOT

- Do not let a supplement lane (Docker, enrichment) hold a run hostage — runs must always
  reach a terminal state.
- Do not require Docker, a Sales Navigator account, or any single vendor for the product to work.
- Do not log or echo secrets (API keys, tokens, cookies, passwords). Never commit `.env`.
- Do not feed role/function keywords to the Maps crawler.
- Do not break the anti-hang rules (see above) — silent hangs are this project's mortal enemy.

## Multi-agent protocol (Codex ↔ Kimi)

- Work on `main` is fine for small, tested changes; for anything larger use a `feat/*` branch.
- Always pull before starting (`git pull --rebase origin main`) and push when green.
- **Stay in touch via `docs/AGENT_LOG.md`:** append a short entry for every commit BEFORE
  pushing; read the log + `git log` after every pull. That file is how we review each
  other's work — treat it as mandatory, not optional.
- Commit messages: `feat:` / `fix:` / `chore:` + one-line summary; mention the lane touched.
- If a change touches a shared contract (run input shape, extension API, credential shapes),
  update this file and `SPEC.md` in the same commit.
- `/tmp` wipes between sessions on some machines — always re-clone rather than assuming state.
- GitHub TLS hiccups happen; retry pushes/clones a few times before concluding failure.
