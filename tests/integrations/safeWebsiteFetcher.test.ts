import { describe, expect, it, vi } from 'vitest';
import {
  SafeWebsiteError,
  safeFetchWebsite,
} from '../../src/integrations/safeWebsiteFetcher';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 as const }];

describe('safe careers-page fetcher', () => {
  it.each([
    'http://example.com/careers',
    'https://127.0.0.1/careers',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/careers',
  ])('rejects unsafe website URL %s', async (url) => {
    await expect(safeFetchWebsite(url, { lookup: publicLookup })).rejects.toMatchObject({
      code: 'unsafe_website_url',
    } satisfies Partial<SafeWebsiteError>);
  });

  it('blocks a hostname that resolves to a private address', async () => {
    await expect(
      safeFetchWebsite('https://example.com/careers', {
        lookup: async () => [{ address: '10.0.0.7', family: 4 }],
      })
    ).rejects.toMatchObject({ code: 'unsafe_website_url' });
  });

  it('revalidates redirects and rejects private redirect targets', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/admin' } })
    );
    await expect(
      safeFetchWebsite('https://example.com/careers', { fetchImpl, lookup: publicLookup })
    ).rejects.toMatchObject({ code: 'unsafe_website_url' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('requires HTML, sends the bot identity, and uses a hard timeout', async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await expect(
      safeFetchWebsite('https://example.com/careers', { fetchImpl, lookup: publicLookup })
    ).rejects.toMatchObject({ code: 'unsupported_content_type' });
    expect(requests[0].headers).toMatchObject({
      'User-Agent': 'Leads-GenX-Hiring-Signals/1.0',
    });
    expect(requests[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('caps HTML bodies at one MiB', async () => {
    const oversized = 'x'.repeat(1_048_577);
    const fetchImpl = vi.fn(async () =>
      new Response(oversized, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    );
    await expect(
      safeFetchWebsite('https://example.com/careers', { fetchImpl, lookup: publicLookup })
    ).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('returns bounded HTML after a safe redirect', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: '/jobs' } })
      )
      .mockResolvedValueOnce(
        new Response('<a href="https://boards.greenhouse.io/acme">Jobs</a>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      );
    const result = await safeFetchWebsite('https://example.com/careers', {
      fetchImpl,
      lookup: publicLookup,
    });
    expect(result.finalUrl).toBe('https://example.com/jobs');
    expect(result.html).toContain('boards.greenhouse.io/acme');
  });
});
