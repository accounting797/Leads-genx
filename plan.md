# Plan — LinkedIn Sales Navigator Extension + Bright Data lane

User goal: GrowMeOrganic-style SN scraping. A Chrome extension runs on the user's own
Sales Navigator session, scrapes lead lists, auto-paginates, and streams leads into
Leads-GenX. Bright Data API (user will supply key) for normal LinkedIn scraping;
HarvestAPI stays as the SN fallback lane.

Skill: vibecoding-general-swarm (coding orchestration).

## Stage 0 — Contract (Orchestrator)
Fix the extension↔server API contract and data model before parallel work:
- Per-user extension token (User.extensionToken, shown in Settings, regenerate button)
- POST /api/extension/leads {runName?, leads:[{fullName, firstName?, lastName?, title?, company?, companyUrl?, profileUrl, location?, connectionDegree?, snippet?}]}
  auth: Bearer extensionToken → resolves user → dedupe by profileUrl → store as leads
  under a Run with leadSource 'linkedin_sales_navigator' (auto-created/continued per session)
- GET /api/extension/ping → {ok, user, server} for the popup "connected" check
- Lead records get linkedinUrl + title/company; dedupe on profileUrl

## Stage 1 — Parallel builds
- A (backend): Prisma migration (extensionToken on User, linkedinUrl/title on Lead if missing),
  extension auth middleware, /extension/ping + /extension/leads endpoints, run auto-create
  per extension session (runToken from extension), Settings API to show/regenerate token. Tests.
- B (extension): MV3 Chrome extension in extension/ folder — content script for
  linkedin.com/sales/lead search pages: scrape cards, auto Next-page, polite delay,
  dedupe locally, batch POST to server; popup: server URL + token + status + start/stop;
  background SW: queue/retry sending. README with load-unpacked steps.
- C (frontend): Settings card "LinkedIn Extension" (token, regenerate, download link),
  new "LinkedIn" tab: instructions + live feed of extension-pushed runs/leads;
  Leads table shows LinkedIn source leads.

## Stage 2 — Integrate
Wire together, full build + test suite, zip the extension for one-click download,
commit + push. Bright Data scraping lane itself lands when the user supplies the key
(Settings slot included so the key can be saved now).
