# Valid Email Classification and Terminology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make targeted scraping’s user-facing “Strict” tier read as “Valid” and allow qualifying personal as well as business email addresses when the address is publicly published, geographically aligned, syntactically valid, and MX-deliverable.

**Architecture:** Keep the persisted `strict` quality tier, funnel fields, and export API unchanged for compatibility. Add a narrowly-scoped relevance escape hatch for document contacts that have explicit public-contact evidence, so personal-provider addresses are not required to carry a business keyword while geography and mail-infrastructure checks remain mandatory. Update only targeted-scraping UI and Nova copy.

**Tech Stack:** TypeScript, Prisma/SQLite, Vitest, vanilla JavaScript.

## Global Constraints

- Preserve internal `strict` names and `quality=strict` API compatibility.
- Never accept a foreign, ambiguous-geography, malformed, placeholder, no-reply, or disposable address as Valid.
- Personal-provider addresses require exact public publication and contact context; business-domain association remains unchanged.
- Run focused tests, the full test ritual, plain build, and JavaScript syntax checks before committing.

---

### Task 1: Qualify explicitly published personal document contacts

**Files:**
- Modify: `src/domain/targeted/relevance.ts`
- Modify: `src/domain/targeted/service.ts`
- Test: `tests/domain/targeted/service.test.ts`

- [x] **Step 1: Write a failing regression test** for a public document row containing a personal-provider address, target geography, and no business keyword; assert it is exported as a Valid/`strict` email.
- [x] **Step 2: Run** `npx.cmd vitest run tests/domain/targeted/service.test.ts --maxWorkers=1 --minWorkers=1` and confirm the new test fails because relevance currently rejects the row for missing business intent.
- [x] **Step 3: Implement the minimal change** by passing an explicit-public-contact signal into relevance and allowing only geography-matched, explicit-public-contact candidates to meet the Valid threshold without business intent; leave all other relevance rules unchanged.
- [x] **Step 4: Re-run** the focused service and relevance tests and confirm all pass.

### Task 2: Finish targeted UI and Nova terminology

**Files:**
- Modify: `public/targeted.html`
- Modify: `public/targeted.js`
- Modify: `src/domain/targeted/service.ts`
- Test: `tests/public/staticUi.test.ts`

- [x] **Step 1: Add failing static assertions** that targeted filters, funnel cards, run actions, and export buttons say “Valid” / “Valid emails” rather than “Strict”.
- [x] **Step 2: Run** `npx.cmd vitest run tests/public/staticUi.test.ts --maxWorkers=1 --minWorkers=1` and confirm the assertions fail against the remaining copy.
- [x] **Step 3: Update user-facing strings** while retaining internal API method names and tier values; use “Valid emails” for exports and explain that Valid includes personal and business addresses.
- [x] **Step 4: Re-run static UI tests and `node --check public/targeted.js`.

### Task 3: Full verification and commit

- [x] **Step 1: Run** `npm.cmd test -- --reporter=dot` with a fresh database; targeted coverage is green (127/127), while the checkout-wide run exposes pre-existing hiring/extension schema drift (43 unrelated failures).
- [x] **Step 2: Run** `npm.cmd run build` and JavaScript syntax checks; syntax is clean, while TypeScript remains blocked by the same pre-existing generated-client/schema drift.
- [x] **Step 3: Inspect** `git diff --check` and the staged file list for only the Valid-email changes and this plan/log.
- [x] **Step 4: Append `docs/AGENT_LOG.md` before committing.**
- [ ] **Step 5: Commit** with `fix: rename targeted strict tier to valid emails` after the user reviews the baseline verification blocker.
