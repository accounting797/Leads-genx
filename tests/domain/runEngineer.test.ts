import { describe, expect, it } from 'vitest';
import { GooglePlacesError } from '../../src/integrations/googlePlacesClient';
import { LocalScraperError } from '../../src/integrations/localMapsScraperClient';
import { RunEngineer, diagnoseFailure } from '../../src/domain/runEngineer';

function apifyStatusError(statusCode: number, message: string): Error {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function fakeSink() {
  const events: Array<{ type: string; message: string; metadata?: Record<string, unknown> }> = [];
  return {
    events,
    async addEvent(_runId: number, type: string, message: string, metadata?: Record<string, unknown>) {
      events.push({ type, message, metadata });
    },
  };
}

const noSleep = async () => {};

describe('diagnoseFailure', () => {
  it('classifies provider failures into actionable categories', () => {
    expect(diagnoseFailure(apifyStatusError(401, 'User was not found or authentication token is not valid'), 'apify'))
      .toMatchObject({ category: 'auth', retryable: false });
    expect(diagnoseFailure(apifyStatusError(429, 'Rate limit exceeded'), 'apify'))
      .toMatchObject({ category: 'rate_limit', retryable: true });
    expect(diagnoseFailure(apifyStatusError(500, 'Internal error'), 'apify'))
      .toMatchObject({ category: 'transient', retryable: true });
    expect(diagnoseFailure(new Error('fetch failed'), 'apify'))
      .toMatchObject({ category: 'network', retryable: true });
    expect(diagnoseFailure(new GooglePlacesError('invalid_key', 'Google API key was rejected.'), 'google').category)
      .toBe('auth');
    expect(diagnoseFailure(new GooglePlacesError('quota', 'quota reached'), 'google').category).toBe('quota');
    expect(diagnoseFailure(new LocalScraperError('unavailable', 'scraper down'), 'docker'))
      .toMatchObject({ category: 'docker_down', retryable: true });
    expect(diagnoseFailure(new LocalScraperError('unsupported_location', 'no coords'), 'docker'))
      .toMatchObject({ category: 'unsupported', retryable: false });
    expect(diagnoseFailure(new Error('something odd happened'), 'apify'))
      .toMatchObject({ category: 'unknown', retryable: false });
  });
});

describe('RunEngineer', () => {
  it('retries transient failures and recovers the operation', async () => {
    const sink = fakeSink();
    const engineer = new RunEngineer({ runId: 1, store: sink, sleep: noSleep });
    let calls = 0;

    const result = await engineer.attempt('apify', 'Apify shard 1/1', async () => {
      calls += 1;
      if (calls === 1) throw apifyStatusError(500, 'Internal error');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(calls).toBe(2);
    expect(sink.events.some((event) => event.metadata?.kind === 'diagnosis')).toBe(true);
    expect(sink.events.some((event) => event.metadata?.kind === 'retry')).toBe(true);
  });

  it('never retries a dead credential and quarantines it instead', async () => {
    const sink = fakeSink();
    const quarantined: Array<{ provider: string; credential?: string; reason: string }> = [];
    const engineer = new RunEngineer({
      runId: 1,
      store: sink,
      sleep: noSleep,
      quarantineCredential: async (provider, credential, reason) => {
        quarantined.push({ provider, credential, reason });
      },
    });
    let calls = 0;

    await expect(
      engineer.attempt(
        'apify',
        'Apify shard 1/2',
        async () => {
          calls += 1;
          throw apifyStatusError(401, 'authentication token is not valid');
        },
        'dead-token-123'
      )
    ).rejects.toThrow('authentication token is not valid');

    expect(calls).toBe(1);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toMatchObject({ provider: 'apify', credential: 'dead-token-123' });
    expect(sink.events.some((event) => event.metadata?.kind === 'credential_quarantined')).toBe(true);
  });

  it('exhausts retries with backoff and then throws', async () => {
    const sink = fakeSink();
    const waits: number[] = [];
    const engineer = new RunEngineer({
      runId: 1,
      store: sink,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    let calls = 0;

    await expect(
      engineer.attempt('apify', 'Apify shard 1/1', async () => {
        calls += 1;
        throw apifyStatusError(500, 'Internal error');
      })
    ).rejects.toThrow('Internal error');

    expect(calls).toBe(3);
    expect(waits).toEqual([1500, 4000]);
  });

  it('reconnects only when the health probe answers', async () => {
    const sink = fakeSink();
    const engineer = new RunEngineer({
      runId: 1,
      store: sink,
      sleep: noSleep,
      probe: { docker: async () => true },
    });
    expect(await engineer.reconnect('docker')).toBe(true);

    const down = new RunEngineer({
      runId: 1,
      store: sink,
      sleep: noSleep,
      probe: { docker: async () => false },
    });
    expect(await down.reconnect('docker')).toBe(false);

    const blind = new RunEngineer({ runId: 1, store: sink, sleep: noSleep });
    expect(await blind.reconnect('docker')).toBe(false);
    expect(sink.events.filter((event) => event.metadata?.kind === 'reconnect').length).toBeGreaterThanOrEqual(4);
  });

  it('reports skipped dead credentials at planning time', async () => {
    const sink = fakeSink();
    const engineer = new RunEngineer({ runId: 1, store: sink, sleep: noSleep });
    await engineer.skippedDeadCredential('apify', 2);
    expect(sink.events[0].metadata?.kind).toBe('credential_skipped');
    expect(sink.events[0].message).toContain('2 previously-quarantined');
  });
});
