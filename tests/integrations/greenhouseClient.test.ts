import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractGreenhouseBoardTokens,
  GreenhouseClient,
  GreenhouseError,
} from '../../src/integrations/greenhouseClient';

describe('Greenhouse public board client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts and deduplicates explicit Greenhouse board tokens', () => {
    expect(
      extractGreenhouseBoardTokens(`
        <a href="https://boards.greenhouse.io/Acme/jobs/1">Jobs</a>
        <script src="https://boards-api.greenhouse.io/v1/boards/acme/jobs"></script>
        <iframe src="https://job-boards.greenhouse.io/beta"></iframe>
      `)
    ).toEqual(['acme', 'beta']);
  });

  it('normalizes public jobs and adds a hard timeout to every request', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          jobs: [
            {
              id: 17,
              title: '  VP of Operations  ',
              location: { name: 'Dallas, TX' },
              departments: [{ name: 'Operations' }],
              updated_at: '2026-07-24T00:00:00Z',
              absolute_url: 'https://boards.greenhouse.io/acme/jobs/17',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const jobs = await new GreenhouseClient({ fetchImpl }).listJobs('Acme');

    expect(jobs).toEqual([
      {
        id: 17,
        title: 'VP of Operations',
        location: 'Dallas, TX',
        departments: ['Operations'],
        updatedAt: '2026-07-24T00:00:00Z',
        absoluteUrl: 'https://boards.greenhouse.io/acme/jobs/17',
      },
    ]);
    expect(requests[0].url).toContain('/boards/acme/jobs?content=true');
    expect(requests[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries one transient response but never retries an invalid board', async () => {
    const transientFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('{"jobs":[]}', { status: 200 }));
    await new GreenhouseClient({ fetchImpl: transientFetch, sleep: async () => {} }).listJobs('acme');
    expect(transientFetch).toHaveBeenCalledTimes(2);

    const missingFetch = vi.fn(async () => new Response('missing', { status: 404 }));
    await expect(new GreenhouseClient({ fetchImpl: missingFetch }).listJobs('missing')).rejects.toMatchObject({
      code: 'board_not_found',
      retryable: false,
    } satisfies Partial<GreenhouseError>);
    expect(missingFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects unsafe board tokens before making a request', async () => {
    const fetchImpl = vi.fn();
    await expect(new GreenhouseClient({ fetchImpl }).listJobs('../private')).rejects.toMatchObject({
      code: 'invalid_board_token',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
