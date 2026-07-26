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

  it.each([
    {
      branch: 'redirect',
      response: () =>
        new Response('redirect body', {
          status: 302,
          headers: { location: 'https://127.0.0.1/admin' },
        }),
      expectedCode: 'unsafe_website_url',
    },
    {
      branch: 'non-OK response',
      response: () =>
        new Response('temporarily unavailable', {
          status: 503,
          headers: { 'content-type': 'text/html' },
        }),
      expectedCode: 'website_unavailable',
    },
    {
      branch: 'unsupported content type',
      response: () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      expectedCode: 'unsupported_content_type',
    },
  ])('cancels an abandoned $branch body', async ({ response: createResponse, expectedCode }) => {
    const response = createResponse();
    const body = response.body;
    expect(body).not.toBeNull();
    const cancel = vi.spyOn(body!, 'cancel').mockRejectedValue(new Error('cancel failed'));

    await expect(
      safeFetchWebsite('https://example.com/careers', {
        fetchImpl: async () => response,
        lookup: publicLookup,
      })
    ).rejects.toMatchObject({ code: expectedCode });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('pins each request to a validated address while preserving the hostname for TLS', async () => {
    const connections: Array<{ address: string; family: number; servername: string }> = [];
    const lookup = vi.fn(async (hostname: string) => [
      {
        address: hostname === 'example.com' ? '93.184.216.34' : '151.101.1.195',
        family: 4 as const,
      },
    ]);
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(
        async (
          _url: string | URL | Request,
          _init?: RequestInit,
          connection?: { address: string; family: number; servername: string }
        ) => {
          if (connection) connections.push(connection);
          return new Response(null, {
            status: 302,
            headers: { location: 'https://careers.example.net/jobs' },
          });
        }
      )
      .mockImplementationOnce(
        async (
          _url: string | URL | Request,
          _init?: RequestInit,
          connection?: { address: string; family: number; servername: string }
        ) => {
          if (connection) connections.push(connection);
          return new Response('<p>Jobs</p>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        }
      );

    await safeFetchWebsite('https://example.com/careers', { fetchImpl, lookup });

    expect(lookup).toHaveBeenNthCalledWith(1, 'example.com');
    expect(lookup).toHaveBeenNthCalledWith(2, 'careers.example.net');
    expect(connections).toEqual([
      { address: '93.184.216.34', family: 4, servername: 'example.com' },
      { address: '151.101.1.195', family: 4, servername: 'careers.example.net' },
    ]);
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
