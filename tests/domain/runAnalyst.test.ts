import { describe, expect, it } from 'vitest';
import { analyzeRun, AnalystInput } from '../../src/domain/runAnalyst';

const NOW = new Date('2026-07-24T12:00:00Z');

function baseInput(overrides: Partial<AnalystInput> = {}): AnalystInput {
  return {
    run: {
      status: 'running',
      leadCount: 12,
      businessCount: 40,
      maxResults: 250,
      apiRequestsUsed: 8,
      apiRequestBudget: 50,
      actorId: 'local_first',
      ...overrides.run,
    },
    events: overrides.events ?? [
      { type: 'business_persisted', message: 'Docker persisted 5 new businesses.', createdAt: new Date(NOW.getTime() - 5000) },
    ],
    providerStates: overrides.providerStates ?? [],
    errorLogs: overrides.errorLogs ?? [],
    hiringSignals: overrides.hiringSignals ?? [],
    hiringScan: overrides.hiringScan ?? null,
    now: NOW,
  };
}

describe('analyzeRun', () => {
  it('reports good health with plain-language provider lines while running', () => {
    const report = analyzeRun(
      baseInput({
        providerStates: [
          {
            provider: 'docker',
            status: 'running',
            operation: 'Discovery batch 2/6',
            yieldCount: 34,
            heartbeatAt: new Date(NOW.getTime() - 4000),
          },
          {
            provider: 'google',
            status: 'running',
            operation: 'Searching Google Places',
            yieldCount: 20,
            budgetUsed: 8,
            budgetMax: 50,
            heartbeatAt: new Date(NOW.getTime() - 3000),
          },
        ],
      })
    );

    expect(report.verdict).toBe('good');
    expect(report.verdictLabel).toBe('All good');
    expect(report.headline).toMatch(/humming along/i);
    expect(report.lines.some((line) => line.text.includes('Docker scraper is hard at work'))).toBe(true);
    expect(report.lines.some((line) => line.text.includes('budget 8/50'))).toBe(true);
    expect(report.lines.some((line) => line.text.includes('12 qualified emails'))).toBe(true);
  });

  it('flags a stale heartbeat as bad while the run is active', () => {
    const report = analyzeRun(
      baseInput({
        events: [
          { type: 'local_batch_started', message: 'started', createdAt: new Date(NOW.getTime() - 90_000) },
        ],
        providerStates: [
          {
            provider: 'docker',
            status: 'running',
            operation: 'Discovery batch 1/6',
            yieldCount: 0,
            heartbeatAt: new Date(NOW.getTime() - 90_000),
          },
        ],
      })
    );

    expect(report.verdict).toBe('bad');
    expect(report.lines.some((line) => line.text.includes('has gone quiet'))).toBe(true);
    expect(report.lines.some((line) => line.text.includes('been quiet'))).toBe(true);
  });

  it('marks a failed run as needing developer attention with the failure reason', () => {
    const report = analyzeRun(
      baseInput({
        run: {
          status: 'failed',
          leadCount: 0,
          businessCount: 0,
          maxResults: 100,
          apiRequestsUsed: 0,
          apiRequestBudget: 50,
          errorMessage: 'Docker engine is not running',
        },
        errorLogs: [{ severity: 'error', message: 'Docker engine is not running', createdAt: NOW }],
      })
    );

    expect(report.verdict).toBe('needs_attention');
    expect(report.verdictLabel).toBe('Needs your help');
    expect(report.headline).toMatch(/run failed/i);
    expect(report.lines[0].text).toContain('Docker engine is not running');
  });

  it('rates a clean completed run as perfect', () => {
    const report = analyzeRun(
      baseInput({
        run: {
          status: 'completed',
          leadCount: 140,
          businessCount: 300,
          maxResults: 300,
          apiRequestsUsed: 50,
          apiRequestBudget: 50,
        },
        providerStates: [
          { provider: 'docker', status: 'completed', operation: 'done', yieldCount: 180, heartbeatAt: NOW },
          { provider: 'email', status: 'completed', operation: 'done', yieldCount: 140, heartbeatAt: NOW },
        ],
      })
    );

    expect(report.verdict).toBe('perfect');
    expect(report.verdictLabel).toBe('Excellent');
    expect(report.headline).toContain('140 qualified emails');
  });

  it('does not celebrate a completed LinkedIn search that returned zero profiles', () => {
    const report = analyzeRun(
      baseInput({
        run: {
          status: 'completed',
          leadSource: 'sales_navigator',
          actorId: 'brightdata_linkedin',
          leadCount: 0,
          businessCount: 0,
          maxResults: 100,
          apiRequestsUsed: 0,
          apiRequestBudget: 50,
        },
        events: [],
      })
    );

    expect(report.verdict).toBe('bad');
    expect(report.headline).toMatch(/0 LinkedIn profiles/i);
    expect(report.headline).not.toMatch(/What a session|businesses|qualified emails/i);
    expect(report.lines.some((line) => /Warming up/i.test(line.text))).toBe(false);
    expect(report.lines.some((line) => /exact city|broader title/i.test(line.text))).toBe(true);
  });

  it('describes successful LinkedIn output as profiles instead of businesses', () => {
    const report = analyzeRun(
      baseInput({
        run: {
          status: 'completed',
          leadSource: 'sales_navigator',
          actorId: 'brightdata_linkedin',
          leadCount: 12,
          rawContactCount: 9,
          businessCount: 0,
          maxResults: 100,
          apiRequestsUsed: 0,
          apiRequestBudget: 50,
        },
      })
    );

    expect(report.headline).toMatch(/12 LinkedIn profiles/i);
    expect(report.headline).not.toMatch(/businesses/i);
  });

  it('adds at most two hiring notes without changing a healthy verdict', () => {
    const report = analyzeRun(
      baseInput({
        run: {
          status: 'completed',
          leadCount: 20,
          businessCount: 40,
          maxResults: 40,
          apiRequestsUsed: 0,
          apiRequestBudget: 0,
        },
        hiringSignals: [
          { companyName: 'Acme', score: 94, explanation: 'VP Sales updated recently in Austin.' },
          { companyName: 'Beta', score: 89, explanation: 'Operations Director updated recently.' },
          { companyName: 'Gamma', score: 85, explanation: 'Finance lead updated recently.' },
        ],
      })
    );

    expect(report.verdict).toBe('perfect');
    const hiringLines = report.lines.filter((line) => line.text.toLowerCase().includes('hiring signal'));
    expect(hiringLines).toHaveLength(2);
    expect(hiringLines[0].text).toContain('Acme');
    expect(hiringLines[1].text).toContain('Beta');
  });

  it('prioritizes existing-company signals and keeps one partial-scan note informational', () => {
    const report = analyzeRun(
      baseInput({
        run: {
          status: 'completed',
          leadCount: 20,
          businessCount: 40,
          maxResults: 40,
          apiRequestsUsed: 0,
          apiRequestBudget: 0,
        },
        hiringSignals: [
          {
            companyName: 'Adjacent Co',
            score: 99,
            explanation: 'An adjacent opening was updated recently.',
            originLane: 'hiring_opportunity',
          },
          {
            companyName: 'Existing Co',
            score: 75,
            explanation: 'A role on an existing company was updated recently.',
            originLane: 'google_maps',
          },
        ],
        hiringScan: {
          status: 'partially_completed',
          errorMessage: 'One public board could not be checked.',
        },
      })
    );

    expect(report.verdict).toBe('perfect');
    const hiringLines = report.lines.filter((line) => line.text.startsWith('Hiring '));
    expect(hiringLines).toHaveLength(2);
    expect(hiringLines[0].text).toContain('Existing Co');
    expect(hiringLines[1]).toMatchObject({ tone: 'info' });
    expect(hiringLines[1].text).toContain('Some public hiring boards');
    expect(hiringLines.some((line) => line.text.includes('Adjacent Co'))).toBe(false);
  });

  it('keeps a failed optional hiring scan to one informational line', () => {
    const report = analyzeRun(
      baseInput({
        run: {
          status: 'completed',
          leadCount: 20,
          businessCount: 40,
          maxResults: 40,
          apiRequestsUsed: 0,
          apiRequestBudget: 0,
        },
        hiringScan: {
          status: 'failed',
          errorMessage: 'Public board request failed.',
        },
      })
    );

    expect(report.verdict).toBe('perfect');
    expect(report.lines.filter((line) => line.text.startsWith('Hiring '))).toEqual([
      expect.objectContaining({ tone: 'info' }),
    ]);
  });

  it('keeps partial output visible when a provider fails after persisting leads', () => {
    const report = analyzeRun(
      baseInput({
        run: {
          status: 'partially_completed',
          leadCount: 55,
          businessCount: 120,
          maxResults: 300,
          apiRequestsUsed: 50,
          apiRequestBudget: 50,
        },
        providerStates: [
          {
            provider: 'apify',
            status: 'failed',
            operation: 'Apify shard 1 failed',
            yieldCount: 0,
            heartbeatAt: NOW,
            errorMessage: 'Actor finished with status FAILED',
          },
        ],
        errorLogs: [{ severity: 'warn', message: 'Apify shard 1 failed', createdAt: NOW }],
      })
    );

    expect(report.verdict).toBe('bad');
    expect(report.headline).toMatch(/few bumps/i);
    expect(report.lines.some((line) => line.text.includes('Apify hit a problem'))).toBe(true);
  });

  it('narrates engineer actions and escalates when a credential is quarantined', () => {
    const report = analyzeRun(
      baseInput({
        events: [
          {
            type: 'engineer_action',
            message: 'Engineer diagnosis (Apify): authentication token is not valid',
            createdAt: new Date(NOW.getTime() - 4000),
            metadata: { kind: 'diagnosis' },
          },
          {
            type: 'engineer_action',
            message: 'Engineer quarantined the dead Apify credential — future runs will skip it. Update it in Settings.',
            createdAt: new Date(NOW.getTime() - 3000),
            metadata: { kind: 'credential_quarantined' },
          },
          {
            type: 'business_persisted',
            message: 'Docker persisted 5 new businesses.',
            createdAt: new Date(NOW.getTime() - 2000),
          },
        ],
      })
    );

    expect(report.verdict).toBe('bad');
    expect(report.lines.some((line) => line.tone === 'engineer' && line.text.includes('Engineer diagnosis'))).toBe(true);
    expect(report.lines.some((line) => line.tone === 'warn' && line.text.includes('quarantined'))).toBe(true);
  });

  it('mentions the engineer is guarding a healthy run', () => {
    const report = analyzeRun(
      baseInput({
        events: [
          {
            type: 'engineer_action',
            message: 'Engineer is retrying Apify shard 1/2 (attempt 2/3) after 4s.',
            createdAt: new Date(NOW.getTime() - 2000),
            metadata: { kind: 'retry' },
          },
        ],
      })
    );

    expect(report.verdict).toBe('good');
    expect(report.headline).toMatch(/actively guarding/i);
  });

  it('raises Needs your help when Nova’s self-healing is exhausted', () => {
    const report = analyzeRun(
      baseInput({
        events: [
          {
            type: 'engineer_action',
            message: "Nova needs your help — I've retried, cooled the engines, and rerouted everything I can, but Apify shard 1/2 won't revive.",
            createdAt: new Date(NOW.getTime() - 2000),
            metadata: { kind: 'guidance' },
          },
        ],
      })
    );

    expect(report.verdict).toBe('needs_attention');
    expect(report.verdictLabel).toBe('Needs your help');
    expect(report.headline).toMatch(/need your help/i);
    expect(report.lines.some((line) => line.text.includes('Nova needs your help'))).toBe(true);
  });

  it('explains waiting_for_scraper as a safe pause, not a crash', () => {
    const report = analyzeRun(
      baseInput({
        run: {
          status: 'waiting_for_scraper',
          leadCount: 20,
          businessCount: 60,
          maxResults: 300,
          apiRequestsUsed: 10,
          apiRequestBudget: 50,
        },
      })
    );

    expect(report.verdict).toBe('bad');
    expect(report.headline).toMatch(/isn't answering/);
    expect(report.lines.some((line) => line.text.includes('resume'))).toBe(true);
  });

  it('stays All good during a long quiet task while provider heartbeats are fresh', () => {
    const report = analyzeRun(
      baseInput({
        events: [
          { type: 'google_completed', message: 'Google finished.', createdAt: new Date(NOW.getTime() - 6 * 60_000) },
        ],
        providerStates: [
          {
            provider: 'docker',
            status: 'running',
            operation: 'Discovery batch 1/4',
            yieldCount: 0,
            heartbeatAt: new Date(NOW.getTime() - 5000),
          },
        ],
      })
    );

    // The screenshot bug: this exact situation used to read "Needs a look".
    expect(report.verdict).toBe('good');
    expect(report.lines.some((line) => line.tone === 'info' && /heads-down on a long task/.test(line.text))).toBe(true);
    expect(report.lines.some((line) => /no provider heartbeat/.test(line.text))).toBe(false);
  });

  it('escalates when events are stale AND no provider shows signs of life', () => {
    const report = analyzeRun(
      baseInput({
        events: [
          { type: 'google_completed', message: 'Google finished.', createdAt: new Date(NOW.getTime() - 6 * 60_000) },
        ],
        providerStates: [],
      })
    );

    expect(report.verdict).toBe('bad');
    expect(report.lines.some((line) => /no provider heartbeat/.test(line.text))).toBe(true);
  });
});
