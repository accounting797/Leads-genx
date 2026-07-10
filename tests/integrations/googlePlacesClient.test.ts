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
});
