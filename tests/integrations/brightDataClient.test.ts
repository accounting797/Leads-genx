import { describe, expect, it } from 'vitest';
import { BrightDataError, testBrightDataKey, triggerAndCollect } from '../../src/integrations/brightDataClient';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const noSleep = () => Promise.resolve();

describe('triggerAndCollect', () => {
  it('triggers, polls through building, and returns the records', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('/trigger')) return jsonResponse({ snapshot_id: 'snap-1' });
      if (calls.filter((call) => call.includes('/snapshot/')).length === 0) {
        return jsonResponse({ status: 'building' });
      }
      return jsonResponse([{ url: 'https://www.linkedin.com/in/jane/', email: 'jane@acme.com' }]);
    }) as unknown as typeof fetch;

    const progress: string[] = [];
    const records = await triggerAndCollect({
      apiKey: 'bd-key',
      datasetId: 'gd_test',
      inputs: [{ url: 'https://www.linkedin.com/in/jane/' }],
      fetchImpl,
      sleep: noSleep,
      pollMs: 1,
      onProgress: (message) => progress.push(message),
    });

    expect(records).toHaveLength(1);
    expect(records[0].email).toBe('jane@acme.com');
    expect(calls[0]).toContain('/datasets/v3/trigger');
    expect(calls[0]).toContain('dataset_id=gd_test');
    expect(progress.some((message) => message.includes('snap-1'))).toBe(true);
  });

  it('maps auth rejection to an actionable error', async () => {
    const fetchImpl = (async () => jsonResponse({}, 401)) as unknown as typeof fetch;
    await expect(
      triggerAndCollect({ apiKey: 'bad', datasetId: 'gd_test', inputs: [{ url: 'x' }], fetchImpl, sleep: noSleep })
    ).rejects.toMatchObject({ code: 'auth' });
  });

  it('survives polling blips and keeps going', async () => {
    let snapshotCalls = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/trigger')) return jsonResponse({ snapshot_id: 'snap-2' });
      snapshotCalls += 1;
      if (snapshotCalls < 3) throw new BrightDataError('transient', 'hiccup');
      return jsonResponse([{ url: 'https://www.linkedin.com/in/joe/' }]);
    }) as unknown as typeof fetch;

    const records = await triggerAndCollect({
      apiKey: 'bd-key',
      datasetId: 'gd_test',
      inputs: [{ url: 'x' }],
      fetchImpl,
      sleep: noSleep,
      pollMs: 1,
    });
    expect(records).toHaveLength(1);
    expect(snapshotCalls).toBe(3);
  });

  it('throws after six unanswered status checks', async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/trigger')) return jsonResponse({ snapshot_id: 'snap-3' });
      throw new BrightDataError('transient', 'silence');
    }) as unknown as typeof fetch;

    await expect(
      triggerAndCollect({ apiKey: 'bd-key', datasetId: 'gd_test', inputs: [{ url: 'x' }], fetchImpl, sleep: noSleep, pollMs: 1 })
    ).rejects.toMatchObject({ code: 'transient' });
  });

  it('treats a failed snapshot as terminal', async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/trigger')) return jsonResponse({ snapshot_id: 'snap-4' });
      return jsonResponse({ status: 'failed' });
    }) as unknown as typeof fetch;

    await expect(
      triggerAndCollect({ apiKey: 'bd-key', datasetId: 'gd_test', inputs: [{ url: 'x' }], fetchImpl, sleep: noSleep, pollMs: 1 })
    ).rejects.toMatchObject({ code: 'failed' });
  });
});

describe('testBrightDataKey', () => {
  it('reports ok when metadata is reachable', async () => {
    const fetchImpl = (async () => jsonResponse({ fields: [] })) as unknown as typeof fetch;
    const result = await testBrightDataKey('good-key', fetchImpl);
    expect(result.ok).toBe(true);
  });

  it('reports rejection clearly', async () => {
    const fetchImpl = (async () => jsonResponse({}, 403)) as unknown as typeof fetch;
    const result = await testBrightDataKey('bad-key', fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('rejected');
  });
});
