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
  it('reports a live token with the account username', async () => {
    const { calls, fetchImpl } = fakeFetch(200, { data: { username: 'operator' } });
    const result = await testApifyToken('secret-token', fetchImpl as never);

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('operator');
    expect(calls[0]).toContain('token=secret-token');
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
