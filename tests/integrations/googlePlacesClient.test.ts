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
      shouldActivateRecovery: () => false,
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
      shouldActivateRecovery: () => false,
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
          return new Response(JSON.stringify({ error: { message: 'temporary service failure' } }), { status: 503 });
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
      expect.objectContaining({ type: 'failed', errorMessage: 'Google Places is temporarily unavailable.' })
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
      shouldActivateRecovery: () => false,
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
    expect(queries).toHaveLength(10);
    expect(new Set(queries).size).toBe(queries.length);
  });

  it('never exceeds the configured HTTP request budget', async () => {
    const fetchMock = vi.fn(async () => Response.json({ places: [{ id: 'one' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new GooglePlacesApiClient();
    await client.search({
      apiKey: 'google-one',
      maxResults: 100,
      requestBudget: 1,
      filters: { searchTerms: ['dentist', 'plumber'], locations: ['Austin, TX'] },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports every attempted request and streams new page items', async () => {
    const requests: number[] = [];
    const pages: unknown[][] = [];
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ places: [{ id: 'one' }], nextPageToken: 'next' }))
      .mockResolvedValueOnce(Response.json({ places: [{ id: 'two' }] })));

    const items = await new GooglePlacesApiClient().search({
      apiKey: 'secret',
      filters: { searchTerms: ['dentist'] },
      maxResults: 10,
      requestBudget: 2,
      onRequestEvent(event) {
        if (event.type === 'attempted') requests.push(event.requestCount);
      },
      onPage(event) { pages.push(event.items); },
    });

    expect(requests).toEqual([1, 2]);
    expect(pages).toEqual([[{ id: 'one' }], [{ id: 'two' }]]);
    expect(items).toHaveLength(2);
  });

  it('counts rotated-key attempts and stops terminal authorization failures', async () => {
    const attempts: number[] = [];
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { status: 'PERMISSION_DENIED', message: 'API key is not authorized' },
    }), { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new GooglePlacesApiClient().search({
      apiKey: 'key-one',
      apiKeys: ['key-one', 'key-two'],
      filters: { searchTerms: ['one', 'two', 'three'] },
      maxResults: 100,
      requestBudget: 50,
      onRequestEvent(event) {
        if (event.type === 'attempted') attempts.push(event.requestCount);
      },
    })).rejects.toMatchObject({ code: 'forbidden' });

    expect(attempts).toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops scheduling shards when the orchestrator target is reached', async () => {
    let stop = false;
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ places: [{ id: 'one' }] }));
    vi.stubGlobal('fetch', fetchMock);

    await new GooglePlacesApiClient().search({
      apiKey: 'secret',
      filters: { searchTerms: ['one', 'two'] },
      maxResults: 100,
      requestBudget: 10,
      shouldStop: () => stop,
      onPage() { stop = true; },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requests every location first page before following page tokens', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        requestBodies.push(body);
        if (body.textQuery === 'dentist Austin, TX' && !body.pageToken) {
          return Response.json({ places: [], nextPageToken: 'a-2' });
        }
        if (body.textQuery === 'dentist Dallas, TX' && !body.pageToken) {
          return Response.json({ places: [], nextPageToken: 'd-2' });
        }
        return Response.json({ places: [] });
      })
    );

    await new GooglePlacesApiClient().search({
      apiKey: 'secret',
      filters: { searchTerms: ['dentist'], locations: ['Austin, TX', 'Dallas, TX'] },
      maxResults: 100,
      shouldActivateRecovery: () => false,
    });

    expect(requestBodies).toEqual([
      { textQuery: 'dentist Austin, TX', pageSize: 20 },
      { textQuery: 'dentist Dallas, TX', pageSize: 20 },
      { textQuery: 'dentist Austin, TX', pageSize: 20, pageToken: 'a-2' },
      { textQuery: 'dentist Dallas, TX', pageSize: 20, pageToken: 'd-2' },
    ]);
  });

  it('counts every failed key attempt against the request budget', async () => {
    const attempts: number[] = [];
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { status: 'UNAVAILABLE' } }), { status: 503 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await new GooglePlacesApiClient().search({
      apiKey: 'key-one',
      apiKeys: ['key-one', 'key-two'],
      filters: { searchTerms: ['dentist'], locations: ['Austin, TX', 'Dallas, TX'] },
      maxResults: 100,
      requestBudget: 2,
      shouldActivateRecovery: () => false,
      onRequestEvent(event) {
        if (event.type === 'attempted') attempts.push(event.requestCount);
      },
    });

    expect(attempts).toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps recovery queries dormant when recovery is not activated', async () => {
    const queries: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { textQuery: string };
        queries.push(body.textQuery);
        return Response.json({ places: [] });
      })
    );

    await new GooglePlacesApiClient().search({
      apiKey: 'secret',
      filters: { searchTerms: ['dentist'], locations: ['Austin, TX'] },
      maxResults: 100,
      shouldActivateRecovery: () => false,
    });

    expect(queries.some((query) => /\b(supplier|distributor|retailer|service)\b/i.test(query))).toBe(false);
  });

  it('reports planned and completed work units including empty pages without query text', async () => {
    const events: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { pageToken?: string };
        return body.pageToken
          ? Response.json({ places: [] })
          : Response.json({ places: [], nextPageToken: 'page-2' });
      })
    );

    await new GooglePlacesApiClient().search({
      apiKey: 'secret',
      filters: { searchTerms: ['dentist'], locations: ['Austin, TX'] },
      maxResults: 100,
      shouldActivateRecovery: () => false,
      onWorkUnitEvent: (event) => events.push(event),
    });

    expect(events[0]).toEqual({ type: 'planned', plannedUnitCount: 1 });
    expect(events.slice(1)).toEqual([
      expect.objectContaining({ type: 'started', tier: 'precision', pageDepth: 1 }),
      expect.objectContaining({ type: 'completed', tier: 'precision', pageDepth: 1, itemCount: 0 }),
      expect.objectContaining({ type: 'started', tier: 'precision', pageDepth: 2 }),
      expect.objectContaining({ type: 'completed', tier: 'precision', pageDepth: 2, itemCount: 0 }),
    ]);
    expect(events.every((event) => !Object.hasOwn(event, 'query'))).toBe(true);
    expect(events.slice(1).every((event) => typeof event.workUnitId === 'string')).toBe(true);
  });

  it('extends planned work exactly once before activated recovery starts', async () => {
    const events: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async () => Response.json({ places: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await new GooglePlacesApiClient().search({
      apiKey: 'secret',
      filters: { searchTerms: ['dentist'], locations: ['Austin, TX'] },
      maxResults: 100,
      onWorkUnitEvent: (event) => events.push(event),
    });

    expect(events[0]).toEqual({ type: 'planned', plannedUnitCount: 1 });
    expect(events.filter((event) => event.type === 'extended')).toEqual([
      { type: 'extended', additionalPlannedUnitCount: 4 },
    ]);
    expect(events.findIndex((event) => event.type === 'extended')).toBeLessThan(
      events.findIndex((event) => event.type === 'started' && event.tier === 'recovery')
    );
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('warns once when the budget cannot cover every planned location', async () => {
    const events: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ places: [] })));

    await new GooglePlacesApiClient().search({
      apiKey: 'secret',
      filters: { searchTerms: ['dentist'], locations: ['Austin, TX', 'Dallas, TX'] },
      maxResults: 100,
      requestBudget: 1,
      shouldActivateRecovery: () => false,
      onWorkUnitEvent: (event) => events.push(event),
    });

    expect(events.filter((event) => event.type === 'warning')).toEqual([
      {
        type: 'warning',
        warningCode: 'google_budget_below_location_coverage',
        requestBudget: 1,
        locationCount: 2,
      },
    ]);
    expect(events.every((event) => !Object.hasOwn(event, 'query'))).toBe(true);
  });

  it('reports a failed work unit without exposing query text', async () => {
    const events: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));

    await expect(new GooglePlacesApiClient().search({
      apiKey: 'secret',
      filters: { searchTerms: ['dentist'], locations: ['Austin, TX'] },
      maxResults: 100,
      shouldActivateRecovery: () => false,
      onWorkUnitEvent: (event) => events.push(event),
    })).rejects.toMatchObject({ code: 'transient' });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'failed',
      tier: 'precision',
      pageDepth: 1,
      errorCode: 'transient',
    }));
    expect(events.every((event) => !Object.hasOwn(event, 'query'))).toBe(true);
  });

  it('removes terminally rejected keys from later work units', async () => {
    const keys: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const key = (init.headers as Record<string, string>)['X-Goog-Api-Key'];
        keys.push(key);
        return key === 'key-one'
          ? new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }), { status: 403 })
          : Response.json({ places: [] });
      })
    );

    await new GooglePlacesApiClient().search({
      apiKey: 'key-one',
      apiKeys: ['key-one', 'key-two'],
      filters: {
        searchTerms: ['dentist'],
        locations: ['Austin, TX', 'Dallas, TX', 'Houston, TX'],
      },
      maxResults: 100,
      shouldActivateRecovery: () => false,
    });

    expect(keys).toEqual(['key-one', 'key-two', 'key-two', 'key-two']);
  });
});
