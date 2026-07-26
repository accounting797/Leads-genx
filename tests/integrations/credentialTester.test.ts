import { describe, expect, it } from 'vitest';
import { maskKey, testApifyToken, testGoogleApiKey } from '../../src/integrations/credentialTester';

function fakeFetch(status: number, body: unknown = {}) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    return { status, json: async () => body };
  };
  return { calls, fetchImpl };
}

describe('maskKey', () => {
  it('shows only the last four characters', () => {
    expect(maskKey('AIzaSyD4secretkey1234')).toBe('••••1234');
    expect(maskKey('abc')).toBe('••••');
  });
});

describe('testApifyToken', () => {
  it('reports the plan usage, remaining credit, and reset date without spending credit', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      if (url.endsWith('/users/me')) {
        return { status: 200, json: async () => ({ data: { username: 'operator', plan: { id: 'FREE', monthlyUsageCreditsUsd: 5 } } }) };
      }
      if (url.endsWith('/users/me/limits')) {
        return { status: 200, json: async () => ({ data: { monthlyUsageCycle: { endAt: '2026-08-13T23:59:59.999Z' }, limits: { maxMonthlyUsageUsd: 5 }, current: { monthlyUsageUsd: 4.25 } } }) };
      }
      return { status: 200, json: async () => ({ data: { totalUsageCreditsUsdAfterVolumeDiscount: 4.25 } }) };
    };
    const result = await testApifyToken('secret-token', fetchImpl as never);

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('operator');
    expect(result.detail).toContain('$0.75 remaining');
    expect(result.detail).toContain('resets Aug 13, 2026');
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(calls)).not.toContain('secret-token');
  });

  it('reports a valid but exhausted free account honestly', async () => {
    const fetchImpl = async (url: string) => {
      if (url.endsWith('/users/me')) {
        return { status: 200, json: async () => ({ data: { username: 'operator', plan: { id: 'FREE', monthlyUsageCreditsUsd: 5 } } }) };
      }
      if (url.endsWith('/users/me/limits')) {
        return { status: 200, json: async () => ({ data: { monthlyUsageCycle: { endAt: '2026-08-13T23:59:59.999Z' }, limits: { maxMonthlyUsageUsd: 5 }, current: { monthlyUsageUsd: 5 } } }) };
      }
      return { status: 200, json: async () => ({ data: { totalUsageCreditsUsdAfterVolumeDiscount: 5 } }) };
    };
    const result = await testApifyToken('secret-token', fetchImpl as never);
    expect(result).toMatchObject({ ok: true });
    expect(result.detail).toContain('EXHAUSTED');
  });

  it('reports rejected tokens without echoing the token', async () => {
    const { fetchImpl } = fakeFetch(401);
    const result = await testApifyToken('secret-token', fetchImpl as never);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });
});

describe('testGoogleApiKey', () => {
  it('reports a live key on a successful Places probe', async () => {
    const { fetchImpl } = fakeFetch(200, { places: [{ id: 'x' }] });
    const result = await testGoogleApiKey('AIzaSecretKey9999', fetchImpl as never);

    expect(result).toMatchObject({ ok: true, keyHint: '••••9999' });
  });

  it('treats quota exhaustion as a valid key', async () => {
    const { fetchImpl } = fakeFetch(429);
    const result = await testGoogleApiKey('AIzaSecretKey9999', fetchImpl as never);
    expect(result.ok).toBe(true);
  });

  it('reports rejected keys with the Google reason but never the raw key', async () => {
    const { fetchImpl } = fakeFetch(403, { error: { message: 'Requests from referer blocked' } });
    const result = await testGoogleApiKey('AIzaSecretKey9999', fetchImpl as never);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('referer blocked');
    expect(JSON.stringify(result)).not.toContain('AIzaSecretKey9999');
  });
});
