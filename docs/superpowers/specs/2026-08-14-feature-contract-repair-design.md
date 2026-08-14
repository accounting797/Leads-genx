# Leads-GenX Feature Contract Repair Design

## Goal

Restore the repository contracts needed by Greenhouse hiring signals, the Sales Navigator extension, and Nova Shuffle so the current source tree, Prisma schema, generated client, route graph, tests, and production build agree again. Preserve the targeted-scraping Valid-email work unchanged.

## Root Cause

Commit `b0247b3` synchronized targeted-scraping work but removed 72 lines from `prisma/schema.prisma`, including `User.extensionToken`, `HiringSignalScan`, `GreenhouseBoard`, and `HiringOpportunity`. The related TypeScript services, routes, UI, and tests remained. The repository also lacks the expected Prisma-client generation guard and some feature route wiring. A stale generated Prisma client allowed one local runtime copy to compile temporarily, while a fresh dependency install exposed the missing contracts.

## Chosen Approach

Restore and reconcile the last coherent contracts rather than deleting features or rebuilding them from scratch.

The repair will use Git history and the existing tested implementations as authoritative references. It will restore only fields, models, scripts, imports, dependency injection, and route mounts required by the retained features. New product behavior is out of scope.

## Components

### Prisma contract

- Restore `User.extensionToken` with the previous uniqueness/nullability behavior.
- Restore the hiring-signal models, relations, uniqueness constraints, indexes, and cascades from the last coherent schema.
- Restore the corresponding `User` and `Run` relation fields.
- Regenerate `@prisma/client` from the repaired schema.
- Restore `scripts/ensure-prisma-client.cjs` and the `pretest`/`prebuild` hooks expected by the repository tests, so stale generated clients cannot mask schema drift again.

No hand-written migration will be added; this repository uses `prisma db push` for schema synchronization.

### Sales Navigator extension

- Preserve the existing extension API contract and per-user bearer token behavior.
- Restore the extension router mount and dependencies if absent.
- Keep token values secret: API responses may return the signed-in user’s own token only through the existing authenticated endpoint, and logs/events must not expose it.

### Greenhouse hiring signals

- Restore the existing service construction, startup recovery, run-settlement scheduling, and authenticated router mount from the last coherent implementation.
- Preserve the supplemental-lane contract: hiring scans never create leads, change parent-run counts, or hold/reopen a parent run.
- Preserve existing bounded fetch, concurrency, cache, ownership, and SSRF protections.

### Nova Shuffle

- Restore the existing `/api/shuffle/next` route and its source-specific mapping without changing the curated combinations or learning behavior.
- Reconcile curated values with the current suggestions catalog only where the existing tests prove a broken contract.
- Shuffle prepares filters; it does not automatically launch paid work.

## Error Handling

- Prisma generation must fail loudly when the schema and generated client cannot be reconciled.
- Optional hiring work remains non-blocking to primary runs and records Nova-safe failure information.
- Extension authentication failures remain ownership-safe and reveal no token details.
- Invalid Shuffle sources return the existing validation response instead of falling through to HTTP 404.

## Testing

Repair will proceed in test-first slices:

1. Prisma schema/client generation contract.
2. Extension API and ownership behavior.
3. Hiring persistence, API, scheduling, and recovery behavior.
4. Shuffle domain and API behavior.
5. Targeted-scraping regression suite to prove the Valid-email work remains intact.
6. Fresh-database full suite, plain TypeScript build, frontend syntax checks, and `git diff --check`.

## Non-Goals

- No deletion of Greenhouse, extension, or Shuffle functionality.
- No redesign of targeted scraping or email-quality tiers.
- No new vendors, credentials, scraping evasion, schema migration framework, or automatic paid searches.
- No push to GitHub until the fresh full suite and plain build are green.
