import { afterEach, describe, expect, it, vi } from 'vitest';
import { GooglePlacesApiClient } from '../../src/integrations/googlePlacesClient';

describe('GooglePlacesApiClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requests paged Text Search results up to the max result limit', async () => {
    const calls: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        calls.push(body);
        if (!body.pageToken) {
          return Response.json({
            places: [{ id: 'place-1' }],
            nextPageToken: 'page-2',
          });
        }
        return Response.json({
          places: [{ id: 'place-2' }],
        });
      })
    );

    const client = new GooglePlacesApiClient();
    const places = await client.search({
      apiKey: 'google-secret-key',
      maxResults: 2,
      filters: {
        searchTerms: ['oilfield services'],
        locations: ['Houston, TX'],
      },
    });

    expect(places).toEqual([{ id: 'place-1' }, { id: 'place-2' }]);
    expect(calls).toEqual([
      { textQuery: 'oilfield services Houston, TX', pageSize: 2 },
      { textQuery: 'oilfield services Houston, TX', pageSize: 1, pageToken: 'page-2' },
    ]);
  });

  it('sends Google Places field masks and never includes the API key in the body', async () => {
    let requestInit: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        requestInit = init;
        return Response.json({ places: [] });
      })
    );

    const client = new GooglePlacesApiClient();
    await client.search({
      apiKey: 'google-secret-key',
      maxResults: 5,
      filters: { searchTerms: ['aviation maintenance'], locations: ['Dallas, TX'] },
    });

    expect(requestInit?.headers).toMatchObject({
      'X-Goog-Api-Key': 'google-secret-key',
    });
    expect(String((requestInit?.headers as Record<string, string>)['X-Goog-FieldMask'])).toContain(
      'places.websiteUri'
    );
    expect(String(requestInit?.body)).not.toContain('google-secret-key');
  });

  it('rotates Google API keys across text search queries', async () => {
    const keys: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        keys.push((init.headers as Record<string, string>)['X-Goog-Api-Key']);
        return Response.json({ places: [{ id: keys.length }] });
      })
    );

    const client = new GooglePlacesApiClient();
    await client.search({
      apiKey: 'google-one',
      apiKeys: ['google-one', 'google-two'],
      maxResults: 10,
      filters: {
        searchTerms: ['oilfield services', 'aviation maintenance'],
        locations: ['Houston, TX', 'Tulsa, OK'],
      },
    });

    expect(keys).toEqual(['google-one', 'google-two', 'google-one', 'google-two']);
  });

  it('tries the next Google API key when one request fails', async () => {
    const keys: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const key = (init.headers as Record<string, string>)['X-Goog-Api-Key'];
        keys.push(key);
        if (key === 'google-one') {
          return new Response(JSON.stringify({ error: { message: 'quota exhausted' } }), { status: 429 });
        }
        return Response.json({ places: [{ id: 'place-1' }] });
      })
    );

    const client = new GooglePlacesApiClient();
    const places = await client.search({
      apiKey: 'google-one',
      apiKeys: ['google-one', 'google-two'],
      maxResults: 5,
      filters: {
        searchTerms: ['oilfield services'],
        locations: ['Houston, TX'],
      },
    });

    expect(places).toEqual([{ id: 'place-1' }]);
    expect(keys).toEqual(['google-one', 'google-two']);
  });

  it('dedupes Google Places results across overlapping shards', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return Response.json({
          places: [
            {
              id: 'same-place',
              displayName: { text: `Shared ${body.textQuery}` },
              websiteUri: 'https://shared.example.com',
            },
          ],
        });
      })
    );

    const client = new GooglePlacesApiClient();
    const places = await client.search({
      apiKey: 'google-one',
      maxResults: 100,
      filters: {
        searchTerms: ['oilfield services'],
        categoryFilters: ['Oil & Gas'],
        locations: ['Houston, TX'],
      },
    });

    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ id: 'same-place' });
  });

  it('reports shard progress and continues after one shard fails', async () => {
    const events: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (body.textQuery.includes('Oil & Gas')) {
          return new Response(JSON.stringify({ error: { message: 'temporary quota' } }), { status: 429 });
        }
        return Response.json({
          places: [{ id: body.textQuery, websiteUri: `https://${encodeURIComponent(body.textQuery)}.example.com` }],
        });
      })
    );

    const client = new GooglePlacesApiClient();
    const places = await client.search({
      apiKey: 'google-one',
      maxResults: 100,
      filters: {
        searchTerms: ['oilfield services'],
        categoryFilters: ['Oil & Gas'],
        locations: ['Houston, TX'],
      },
      onShardEvent: (event) => events.push(event),
    });

    expect(places.length).toBeGreaterThan(0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'started', shard: 1 }));
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'failed', errorMessage: 'Google Places request failed with status 429' })
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'completed', itemCount: 1 }));
  });

  it('expands Google Places queries across terms, categories, company types, and locations', async () => {
    const queries: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        queries.push(body.textQuery);
        return Response.json({ places: [] });
      })
    );

    const client = new GooglePlacesApiClient();
    await client.search({
      apiKey: 'google-one',
      maxResults: 1000,
      filters: {
        searchTerms: ['oilfield services'],
        categoryFilters: ['Oil & Gas'],
        companyTypes: ['Wholesaler'],
        locations: ['Houston, TX', 'Tulsa, OK'],
      },
    });

    expect(queries).toEqual(
      expect.arrayContaining([
        'oilfield services Houston, TX',
        'Oil & Gas Wholesaler Houston, TX',
        'oilfield services Oil & Gas Houston, TX',
        'oilfield services Wholesaler Tulsa, OK',
      ])
    );
    expect(queries).toHaveLength(12);
    expect(new Set(queries).size).toBe(queries.length);
  });
});
