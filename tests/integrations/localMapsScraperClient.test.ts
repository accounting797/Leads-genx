import { describe, expect, it, vi, afterEach } from 'vitest';
import { LocalMapsScraperClient } from '../../src/integrations/localMapsScraperClient';

describe('LocalMapsScraperClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a scraper-kit job, polls it, downloads CSV, and expands email rows', async () => {
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({
          url,
          method: init?.method,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });

        if (url.endsWith('/api/v1/jobs') && !init?.method) {
          return Response.json([]);
        }
        if (url.endsWith('/api/v1/jobs') && init?.method === 'POST') {
          return Response.json({ id: 'job-1' }, { status: 201 });
        }
        if (url.endsWith('/api/v1/jobs/job-1')) {
          return Response.json({ Status: 'ok' });
        }
        if (url.endsWith('/api/v1/jobs/job-1/download')) {
          return new Response(
            [
              'title,phone,emails,website,category,address,review_rating,review_count',
              '"Gulf Energy","555-0100","sales@gulf.example.com,ops@gulf.example.com","https://gulf.example.com","Oil & Gas","Houston, TX","4.7","120"',
            ].join('\n')
          );
        }

        return new Response('not found', { status: 404 });
      })
    );

    const events: unknown[] = [];
    const client = new LocalMapsScraperClient({ pollIntervalMs: 1 });
    const items = await client.search({
      filters: {
        searchTerms: ['oilfield services'],
        locations: ['Houston, TX'],
      },
      maxResults: 100,
      onEvent: (event) => events.push(event),
    });

    expect(items).toHaveLength(2);
    expect(items.map((item) => (item as Record<string, unknown>).email)).toEqual([
      'sales@gulf.example.com',
      'ops@gulf.example.com',
    ]);
    expect(requests).toContainEqual(
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          email: true,
          keywords: expect.arrayContaining(['oilfield services Houston, TX']),
          lat: '29.7604',
          lon: '-95.3698',
          max_time: 900,
        }),
      })
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'started', jobId: 'job-1' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'completed', itemCount: 2 }));
  });

  it('returns no items when the scraper-kit API is not running', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      })
    );

    const events: unknown[] = [];
    const client = new LocalMapsScraperClient({ pollIntervalMs: 1 });
    const items = await client.search({
      filters: {
        searchTerms: ['dentist'],
        locations: ['Austin, TX'],
      },
      maxResults: 100,
      onEvent: (event) => events.push(event),
    });

    expect(items).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'unavailable',
        message: 'Local Google Maps scraper-kit is not reachable at http://localhost:8080',
      })
    );
  });
});
