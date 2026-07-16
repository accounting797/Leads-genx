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
      proxyUrls: ['socks5h://user:password@host.docker.internal:60001'],
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
          proxies: ['socks5h://user:password@host.docker.internal:60001'],
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

  it('creates one scraper-kit job per supported location with location-specific coordinates', async () => {
    const requests: Array<{ url: string; method?: string; body?: Record<string, unknown> }> = [];
    let nextJobId = 1;
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
          return Response.json({ id: `job-${nextJobId++}` }, { status: 201 });
        }
        if (url.includes('/api/v1/jobs/job-') && !url.endsWith('/download')) {
          return Response.json({ Status: 'ok' });
        }
        if (url.endsWith('/download')) {
          return new Response('title,phone,emails,website,category,address,review_rating,review_count\n');
        }

        return new Response('not found', { status: 404 });
      })
    );

    const client = new LocalMapsScraperClient({ pollIntervalMs: 1 });
    await client.search({
      filters: {
        searchTerms: ['commercial real estate'],
        locations: ['Houston, TX', 'Dallas, TX'],
      },
      maxResults: 100,
    });

    const postBodies = requests
      .filter((request) => request.method === 'POST')
      .map((request) => request.body);
    expect(postBodies).toHaveLength(2);
    expect(postBodies[0]).toMatchObject({
      keywords: ['commercial real estate Houston, TX'],
      lat: '29.7604',
      lon: '-95.3698',
    });
    expect(postBodies[1]).toMatchObject({
      keywords: ['commercial real estate Dallas, TX'],
      lat: '32.7767',
      lon: '-96.7970',
    });
  });

  it('emits a failed event when a scraper-kit job never finishes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/v1/jobs') && !init?.method) {
          return Response.json([]);
        }
        if (url.endsWith('/api/v1/jobs') && init?.method === 'POST') {
          return Response.json({ id: 'job-stuck' }, { status: 201 });
        }
        if (url.endsWith('/api/v1/jobs/job-stuck')) {
          return Response.json({ Status: 'working' });
        }
        return new Response('not found', { status: 404 });
      })
    );

    const events: unknown[] = [];
    const client = new LocalMapsScraperClient({ pollIntervalMs: 1, maxPolls: 2 });
    const items = await client.search({
      filters: {
        searchTerms: ['commercial real estate'],
        locations: ['Houston, TX'],
      },
      maxResults: 100,
      onEvent: (event) => events.push(event),
    });

    expect(items).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'failed',
        jobId: 'job-stuck',
        message: 'Local Google Maps scraper-kit job did not finish before the polling limit',
      })
    );
  });

  it('runs one deterministic resumable batch and accepts lowercase status payloads', async () => {
    let postBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/jobs') && init?.method === 'POST') {
        postBody = JSON.parse(String(init.body));
        return Response.json({ id: 'batch-job' }, { status: 201 });
      }
      if (url.endsWith('/api/v1/jobs/batch-job')) return Response.json({ status: 'ok' });
      if (url.endsWith('/api/v1/jobs/batch-job/download')) {
        return new Response('title,emails,website\n"Batch Lead","hello@example.com","https://example.com"');
      }
      return Response.json([]);
    }));

    const client = new LocalMapsScraperClient({ pollIntervalMs: 1 });
    const result = await client.searchBatch({
      batch: {
        key: 'batch-key-1',
        query: 'dentist Austin, TX',
        location: 'Austin, TX',
        lat: '30.2672',
        lon: '-97.7431',
        depth: 10,
        maxResults: 100,
      },
      proxies: [],
    });

    expect(postBody).toMatchObject({
      name: 'leads-genx-batch-key-1',
      keywords: ['dentist Austin, TX'],
      lat: '30.2672',
      lon: '-97.7431',
      depth: 10,
      email: true,
    });
    expect(result).toMatchObject({ batchKey: 'batch-key-1', jobId: 'batch-job', rawBusinessCount: 1 });
    expect(result.items).toHaveLength(1);
  });
});
