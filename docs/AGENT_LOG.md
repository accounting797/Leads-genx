# Agent Log — Codex ↔ Kimi change channel

Every agent (Codex, Kimi) appends a short entry here for EACH commit it makes,
BEFORE pushing. Every agent reads this file (plus `git log`) after pulling.
Newest entries on top. Format:

```
## YYYY-MM-DD — agent-name — commit-prefix
- What changed (lanes/files)
- Anything the other agent must know (contracts, follow-ups)
```

---

## 2026-07-26 — kimi — note (no code, welcome message)
- Welcome aboard, Codex. The project founder says you're supervising — great to
  have you. Orientation in 30 seconds:
  1. AGENTS.md is the law: Nova's voice, anti-hang discipline, the test ritual
     (386+ tests, all green before every push), secrets never echoed.
  2. This log is our conversation — append an entry per commit, read mine on
     every pull. I'll review your entries the same way.
  3. Active lanes: Google Maps (Docker/Places/Apify/Hybrid), Sales Navigator
     (HarvestAPI + extension + new Bright Data people-search), enrichment.
     The Bright Data contract (brightDataApiKey everywhere) is the freshest
     change — settings, validation, and run-start merge all speak it.
  4. If you change a shared contract, update AGENTS.md + SPEC.md in the same
     commit and flag it here so I can adapt.
- Kimi out — looking forward to your first entry.

## 2026-07-26 — kimi — fix (pending push)
- Fixed "Bright Data key not seen at run start": static html/js/css now served
  `Cache-Control: no-cache` (stale cached UI silently dropped new fields);
  BYOD credential merge now applies to ADMIN users too.
- Added tests/api/brightDataRunStart.test.ts — regression for the exact report.
- Codex: pull before any frontend/settings work; the settings contract now
  includes brightDataApiKey everywhere (operator + BYOD + validation).

## 2026-07-26 — kimi — feat 857bfde
- Bright Data LinkedIn people-search lane (SN-mirror filters, no SN account):
  src/domain/brightDataLinkedInSearch.ts, searchDataset/listDatasetFields in
  brightDataClient, validation gate (filters need BD key OR cookies+Apify),
  runService lane + recovery wiring.
- AGENTS.md created — read it first, always.

## 2026-07-26 — kimi — feat 79c9f24
- Bright Data contact enrichment: key management (admin Settings + BYOD),
  contact-enriched dataset client, POST /runs/:id/enrich-linkedin, Enrich
  button on the LinkedIn tab.
