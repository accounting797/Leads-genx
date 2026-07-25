# SPEC — LinkedIn Sales Navigator Extension Ingestion

Three modules, one contract. Implement faithfully; no unilateral changes.

## Shared contract

### Auth
- New `User.extensionToken String?` (Prisma). Random 48-hex, generated on demand.
- Extension calls send header `Authorization: Bearer <extensionToken>`.
- Server resolves user by exact token match; 401 JSON `{ error: 'Invalid extension token' }` otherwise.

### Endpoints (all under /api, added in src/routes/api.ts or a router it mounts)

1. `GET /api/extension/ping` (Bearer) →
   `{ data: { ok: true, username: string, server: 'leadsgenx' } }`

2. `GET /api/extension/token` (session auth, any logged-in user) →
   `{ data: { token } }` — creates the token if missing.

3. `POST /api/extension/token/regenerate` (session auth) →
   `{ data: { token } }` — replaces the token (old one dies instantly).

4. `POST /api/extension/leads` (Bearer) — body:
```json
{
  "sessionId": "string, stable per scraping session (uuid from extension)",
  "runName": "optional human label, e.g. the SN search name",
  "page": 3,
  "leads": [
    {
      "fullName": "Jane Doe (required)",
      "firstName": "Jane", "lastName": "Doe",
      "title": "VP Sales",
      "company": "Acme Inc",
      "companyUrl": "https://www.linkedin.com/company/acme/",
      "profileUrl": "https://www.linkedin.com/in/jane-doe/ (required)",
      "location": "Austin, TX",
      "connectionDegree": "2nd",
      "snippet": "optional text"
    }
  ]
}
```
Behavior:
- Find-or-create ONE Run per (user, sessionId): `leadSource: 'sales_navigator'`,
  `actorId: 'sn_extension'`, `status: 'running'`, `maxResults: 10000`,
  `filterJson: {"extensionSessionId": sessionId, "runName": runName}`,
  `searchUrl: runName || 'Sales Navigator extension'`. On reuse, status stays as-is unless finished.
- Validate: leads must be a non-empty array (max 100 per call, 413 above); each lead needs
  fullName + profileUrl (skip invalid ones, count them as `skipped`).
- Dedupe WITHIN the run by profileUrl (fetch existing profileUrls once per request).
- Insert Lead rows: `leadSource 'sales_navigator'`, `leadType 'linkedin_profile'`,
  `jobTitle = title`, `companyName = company`, `profileUrl`, `location`,
  `connectionDegree`, `contactQuality 'qualified'`, `qualityReason 'Captured by the Leads-GenX extension'`,
  `rawJson = JSON.stringify(original lead)`. `normalizedEmail` stays null (SQLite allows many NULLs).
- Update run: `leadCount` = total leads in run, `lastHeartbeatAt` = now,
  `completedUnitCount` = max(page seen).
- Add RunEvent `extension_leads_ingested`, Nova-warm message:
  `Nova here — your extension just sent N new leads from page X (Y duplicates skipped).`
- Respond `{ data: { runId, inserted, duplicates, skipped, totalLeads } }`.

5. `POST /api/extension/finish` (Bearer) — body `{ sessionId }`:
   Sets that run `status 'completed'`, `completedAt: now`, adds RunEvent
   `extension_session_finished` ("Scraping session complete — N leads collected.").
   Respond `{ data: { runId, totalLeads } }`. 404 if no such run.

### Frontend contract (public/)
- New tab "LinkedIn" (id `linkedin`, ALL users, placed before Settings).
  Contents: 3-step setup guide (1. Download extension zip → chrome://extensions →
  Developer mode → Load unpacked; 2. paste server URL + key below into the extension popup;
  3. open a Sales Navigator lead search and press Start in the popup).
  - Extension key card: masked token, buttons Copy / Reveal / Regenerate
    (uses GET /extension/token + POST /extension/token/regenerate).
  - Download button → GET `/downloads/leadsgenx-sn-extension.zip` (static file).
  - "Extension runs" table: reuse existing GET /api/runs, filter `actorId === 'sn_extension'`,
    show run id, label (searchUrl), leadCount, status, createdAt; refresh button.
  - api.js additions: `getExtensionToken`, `regenerateExtensionToken`.
  - Leads table already links `lead.profileUrl` for non-business leads — verify LinkedIn
    leads render sanely (name, title, company, clickable profile link); patch renderLeads
    only if broken.
- Copy tone: Nova-warm, plain English, no jargon.

### Chrome extension (extension/, Manifest V3, no build step)
- `manifest.json`: name "Leads-GenX — Sales Navigator Scout", version 1.0.0,
  permissions: ["storage"], host_permissions: ["https://www.linkedin.com/*", "https://*/*", "http://*/*"],
  background service_worker `background.js`, action popup `popup.html`,
  content_scripts: matches `https://www.linkedin.com/sales/*`, js `content.js`, run_at `document_idle`.
- `popup.html/popup.js`: server URL (default https://leadsgenx.top), token input (password),
  Save + Test connection (GET /extension/ping → show "Connected as <username>" or error),
  Start / Stop scraping buttons (enabled only on a linkedin.com/sales tab + connected),
  live counter (leads captured this session, last send status).
- `content.js`:
  - Responds to messages {type:'start'} / {type:'stop'} from popup.
  - Scrapes SN lead-search result cards with layered fallback selectors:
    container: `li.artdeco-list__item`, `.search-results__result-item`, `[data-x-search-result]`;
    name+profileUrl: `a[href*="/sales/lead,"]`, `a[href*="/sales/lead/"]`, `.artdeco-entity-lockup__title a`;
    title: `.artdeco-entity-lockup__subtitle`; company: `a[href*="/sales/company"]`,
    `.artdeco-entity-lockup__caption a`; location/degree: `.artdeco-entity-lockup__caption`,
    `.artdeco-entity-lockup__metadata`. First non-empty selector wins; strip whitespace;
    skip cards with no name or no /sales/lead href; absolute-ize relative hrefs.
  - sessionId: crypto.randomUUID() at each start; dedupe within session via Set of profileUrls.
  - After each page: send {type:'leads', page, leads:[...]} to background; then auto-paginate:
    click Next (`button[aria-label="Next"]`, `.artdeco-pagination__button--next`), wait for the
    results list to change (poll `?page=` in URL or first card href change, timeout 15s → stop with reason).
  - Politeness: random 1.5–3.5s between pages; every 10 pages pause 20s ("cooling");
    hard cap 100 pages/session. Stop conditions: no next button, stop message, cap, page-change timeout.
  - Floating badge (fixed, bottom-right, small, low-saturation): "Leads-GenX · N captured" + Stop link.
- `background.js` (service worker): holds {serverUrl, token} from chrome.storage; queue of
  unsent lead batches; POST /api/extension/leads in batches ≤25 with Bearer auth; retry 3× with
  backoff (2s/8s/20s); on {type:'finish'} → POST /api/extension/finish; relays progress
  {type:'progress', captured, sent, lastStatus} to popup; survives popup close (state in SW + storage).
- `README.md`: load-unpacked install steps, connect, scrape, where leads appear in Leads-GenX.
- Icons: skip binary icons; omit `icons` from manifest.

## Ownership
- Backend agent: prisma/schema.prisma, src/routes/api.ts (+ new src/routes/extension.ts if cleaner),
  src/domain/auth.ts only if needed, tests/api/extensionApi.test.ts. Test ritual:
  `export DATABASE_URL="file:/tmp/t-ext.db" && rm -f /tmp/t-ext.db && npx prisma db push --skip-generate && npm test`
- Extension agent: extension/ only.
- Frontend agent: public/ only (index.html, app.js, api.js, ui.js, styles.css as needed).

## Integration (orchestrator)
Merge branches → zip extension/ to public/downloads/leadsgenx-sn-extension.zip →
full build + suite → push.
