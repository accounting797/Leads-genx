# Targeted Syntax-Valid Qualification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Targeted Valid qualification deterministic and independent of MX/DNS while retaining obvious bad-address, public-association, relevance, and geography checks.

**Architecture:** Preserve `classifyMailInfrastructure` and internal `strict` compatibility shapes, but make the classifier syntax-only and network-free. Targeted service persists syntax verification explicitly, while existing association and relevance stages remain authoritative. Update both dashboard copies so users are not promised DNS or mailbox verification.

**Tech Stack:** TypeScript, Vitest, Prisma/SQLite, vanilla HTML/JavaScript.

## Global Constraints

- Both qualifying public personal and business addresses are eligible for Valid.
- Reject malformed, placeholder, disposable, automated/no-reply, telemetry, and asset addresses.
- Do not perform MX/DNS or SMTP/mailbox verification in Targeted.
- Preserve internal `strict` API/database/export identifiers.
- Preserve the existing 20,000 candidates-per-artifact and 500 candidates-per-section limits.
- Do not change document discovery or scraper connectors.

---

### Task 1: Syntax-only Targeted qualification

**Files:**
- Modify: `tests/domain/targeted/mailInfrastructure.test.ts`
- Modify: `tests/domain/targeted/service.test.ts`
- Modify: `src/domain/targeted/mailInfrastructure.ts`
- Modify: `src/domain/targeted/service.ts`
- Modify: `public/index.html`
- Modify: `public/targeted.html`
- Modify: `tests/public/staticUi.test.ts`
- Modify: `SPEC.md`
- Modify: `AGENTS.md`
- Modify: `docs/AGENT_LOG.md`

**Interfaces:**
- Consumes: `classifyMailInfrastructure(value: string, resolver?: MxResolver, timeoutMs?: number): Promise<MailInfrastructureResult>`.
- Produces: the same signature and result shape for compatibility; plausible addresses return `depth: 'syntax'`, `mxValid: false`, `tier: 'strict'`, `reason: 'syntax_valid'` without calling `resolver.resolveMx`.
- Produces: Targeted verification rows with `checkType: 'syntax'`, `depth: 'syntax'`, and `reason: 'syntax_valid'` for qualifying addresses.

- [ ] **Step 1: Write failing classifier tests**

Replace the MX-success/timeout expectations with a resolver spy that throws if invoked. Assert business and consumer addresses return syntax-only `strict`, and separately assert malformed, placeholder, disposable, and no-reply inputs remain rejected.

```ts
const resolver = { resolveMx: async () => { throw new Error('resolver must not run'); } };
await expect(classifyMailInfrastructure('person@acme.com', resolver)).resolves.toMatchObject({
  depth: 'syntax', mxValid: false, tier: 'strict', reason: 'syntax_valid',
});
await expect(classifyMailInfrastructure('owner@gmail.com', resolver)).resolves.toMatchObject({
  depth: 'syntax', mxValid: false, tier: 'strict', reason: 'syntax_valid',
});
```

- [ ] **Step 2: Write a failing Targeted service regression**

Change the aligned business/personal service fixtures so `mxResolver.resolveMx` throws if called. Assert exported emails remain in `strict`, the stored candidate uses `verificationDepth: 'syntax'`, and its verification row contains `{ checkType: 'syntax', status: 'strict', depth: 'syntax', reason: 'syntax_valid' }`.

- [ ] **Step 3: Run RED tests**

Run:

```powershell
npx.cmd vitest run tests/domain/targeted/mailInfrastructure.test.ts tests/domain/targeted/service.test.ts
```

Expected: FAIL because the resolver is invoked and current results depend on MX.

- [ ] **Step 4: Implement deterministic classification**

Keep the existing early rejection checks. Remove the DNS race/timer block and return:

```ts
return result(email, {
  ...base,
  tier: 'strict',
  reason: 'syntax_valid',
});
```

Retain optional resolver/timeout parameters only for source compatibility and mark them intentionally unused.

- [ ] **Step 5: Persist honest syntax verification**

At both Targeted service candidate-write sites, replace the MX verification shape with:

```ts
verification: {
  checkType: 'syntax',
  status: qualityTier,
  depth: 'syntax',
  reason: mail.reason,
  providerVersion: 'syntax-2026-08-14',
},
```

- [ ] **Step 6: Run GREEN domain tests**

Run the RED command again. Expected: both files pass and resolver spies are not called.

- [ ] **Step 7: Update product copy and contracts**

Change both dashboard descriptions to say Valid means publicly published, target-aligned personal or business addresses that pass deterministic bad-address screening; explicitly state DNS/MX and mailbox verification are external. Update `SPEC.md`, `AGENTS.md`, and `docs/AGENT_LOG.md` with the temporary Targeted qualification contract.

- [ ] **Step 8: Add and run static copy regression**

In `tests/public/staticUi.test.ts`, assert both HTML surfaces mention personal/business eligibility and do not describe Valid as MX- or deliverability-checked.

Run:

```powershell
npx.cmd vitest run tests/public/staticUi.test.ts tests/domain/targeted/mailInfrastructure.test.ts tests/domain/targeted/service.test.ts
node --check public/app.js
node --check public/api.js
node --check public/ui.js
npm.cmd run build
```

Expected: all selected tests, syntax checks, and build pass.

- [ ] **Step 9: Run the complete fresh-database gate**

Create a fresh GUID SQLite database, run `npx.cmd prisma db push --skip-generate`, then `npm.cmd test`. Expected: zero failed tests. Run `git diff --check`.

- [ ] **Step 10: Commit**

```powershell
git add AGENTS.md SPEC.md docs/AGENT_LOG.md public/index.html public/targeted.html src/domain/targeted/mailInfrastructure.ts src/domain/targeted/service.ts tests/domain/targeted/mailInfrastructure.test.ts tests/domain/targeted/service.test.ts tests/public/staticUi.test.ts
git commit -m "fix: make targeted valid qualification DNS-independent"
```
