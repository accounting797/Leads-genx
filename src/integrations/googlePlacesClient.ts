import { GoogleMapsFilters } from '../domain/types';
import { buildGoogleMapsSearchQueries } from '../domain/googleMapsQueryBuilder';

export interface GooglePlacesSearchInput {
  apiKey: string;
  apiKeys?: string[];
  filters: GoogleMapsFilters;
  maxResults: number;
  requestBudget?: number;
  onShardEvent?: (event: GooglePlacesShardEvent) => Promise<void> | void;
}

export interface GooglePlacesShardEvent {
  type: 'started' | 'completed' | 'failed';
  shard: number;
  shardCount: number;
  query: string;
  itemCount?: number;
  totalItemCount?: number;
  errorMessage?: string;
}

export interface GooglePlacesClient {
  search(input: GooglePlacesSearchInput): Promise<unknown[]>;
}

export class GooglePlacesApiClient implements GooglePlacesClient {
  async search({ apiKey, apiKeys, filters, maxResults, requestBudget, onShardEvent }: GooglePlacesSearchInput): Promise<unknown[]> {
    const queries = buildGoogleMapsSearchQueries(filters);
    const places: unknown[] = [];
    const seenPlaces = new Set<string>();
    const keyPool = apiKeys?.length ? apiKeys : [apiKey];
    const budget = requestBudget ?? Number.MAX_SAFE_INTEGER;
    let requestCount = 0;

    function placeKey(place: unknown): string {
      const item = place && typeof place === 'object' ? (place as Record<string, unknown>) : {};
      const displayName =
        item.displayName && typeof item.displayName === 'object'
          ? (item.displayName as Record<string, unknown>).text
          : undefined;
      const stableKey = [item.id, item.name, item.googleMapsUri, item.websiteUri]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
      if (stableKey) return stableKey.trim().toLowerCase();

      return [item.internationalPhoneNumber, item.nationalPhoneNumber, displayName, item.formattedAddress]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join('|')
        .toLowerCase();
    }

    function addUniquePlaces(items: unknown[]): number {
      let added = 0;
      for (const item of items) {
        const key = placeKey(item) || JSON.stringify(item);
        if (seenPlaces.has(key)) continue;
        seenPlaces.add(key);
        places.push(item);
        added += 1;
      }
      return added;
    }

    async function requestPage(
      body: Record<string, unknown>,
      startKeyIndex: number
    ): Promise<{ places?: unknown[]; nextPageToken?: string }> {
      let lastError: unknown;

      for (let attempt = 0; attempt < keyPool.length; attempt += 1) {
        if (requestCount >= budget) throw new Error('Google Places request budget exhausted');
        requestCount += 1;
        const queryApiKey = keyPool[(startKeyIndex + attempt) % keyPool.length];
        try {
          const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': queryApiKey,
              'X-Goog-FieldMask': [
                'places.id',
                'places.name',
                'places.displayName',
                'places.formattedAddress',
                'places.internationalPhoneNumber',
                'places.nationalPhoneNumber',
                'places.rating',
                'places.userRatingCount',
                'places.websiteUri',
                'places.googleMapsUri',
                'places.businessStatus',
                'places.primaryType',
                'places.primaryTypeDisplayName',
                'places.types',
                'nextPageToken',
              ].join(','),
            },
            body: JSON.stringify(body),
          });

          if (!response.ok) {
            throw new Error(`Google Places request failed with status ${response.status}`);
          }

          return (await response.json()) as { places?: unknown[]; nextPageToken?: string };
        } catch (error) {
          lastError = error;
          if (attempt === keyPool.length - 1) throw error;
        }
      }

      throw lastError instanceof Error ? lastError : new Error('Google Places request failed');
    }

    for (const [queryIndex, textQuery] of queries.entries()) {
      if (places.length >= maxResults) break;
      let pageToken: string | undefined;
      let shardItemCount = 0;

      await onShardEvent?.({
        type: 'started',
        shard: queryIndex + 1,
        shardCount: queries.length,
        query: textQuery,
      });

      try {
        do {
          const remaining = maxResults - places.length;
          const body: Record<string, unknown> = {
            textQuery,
            pageSize: Math.min(20, remaining),
          };
          if (pageToken) body.pageToken = pageToken;

          const data = await requestPage(body, queryIndex % keyPool.length);
          shardItemCount += addUniquePlaces(data.places ?? []);
          pageToken = data.nextPageToken;
        } while (pageToken && places.length < maxResults);

        await onShardEvent?.({
          type: 'completed',
          shard: queryIndex + 1,
          shardCount: queries.length,
          query: textQuery,
          itemCount: shardItemCount,
          totalItemCount: places.length,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await onShardEvent?.({
          type: 'failed',
          shard: queryIndex + 1,
          shardCount: queries.length,
          query: textQuery,
          errorMessage,
          totalItemCount: places.length,
        });
        if (!places.length && queryIndex === queries.length - 1) throw error;
      }
    }

    return places.slice(0, maxResults);
  }
}
