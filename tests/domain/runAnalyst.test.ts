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
    expect(report.verdictLabel).toBe('Good');
    expect(report.headline).toMatch(/smoothly/i);
    expect(report.lines.some((line) => line.text.includes('Docker scraper is working'))).toBe(true);
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
    expect(report.lines.some((line) => line.text.includes('stuck'))).toBe(true);
    expect(report.lines.some((line) => line.text.includes('No activity'))).toBe(true);
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
    expect(report.verdictLabel).toBe('Needs developer attention');
    expect(report.headline).toMatch(/developer/i);
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
    expect(report.verdictLabel).toBe('Perfect');
    expect(report.headline).toContain('140 qualified emails');
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
    expect(report.headline).toMatch(/provider failures/i);
    expect(report.lines.some((line) => line.text.includes('Apify failed'))).toBe(true);
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
    expect(report.headline).toMatch(/engineer is actively guarding/i);
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
    expect(report.headline).toMatch(/Docker scraper is not responding/);
    expect(report.lines.some((line) => line.text.includes('resume'))).toBe(true);
  });
});
