import { GoogleMapsFilters } from '../domain/types';
import { buildGoogleMapsSearchQueries } from '../domain/googleMapsQueryBuilder';

export type GooglePlacesErrorCode =
  | 'invalid_key'
  | 'forbidden'
  | 'quota'
  | 'rate_limited'
  | 'budget_exhausted'
  | 'transient'
  | 'request_failed';

export class GooglePlacesError extends Error {
  constructor(
    public readonly code: GooglePlacesErrorCode,
    message: string,
    public readonly httpStatus?: number
  ) {
    super(message);
    this.name = 'GooglePlacesError';
  }
}

export interface GooglePlacesRequestEvent {
  type: 'attempted' | 'succeeded' | 'failed';
  requestCount: number;
  budget: number;
  httpStatus?: number;
  errorCode?: GooglePlacesErrorCode;
}

export interface GooglePlacesPageEvent {
  shard: number;
  shardCount: number;
  query: string;
  items: unknown[];
  totalItemCount: number;
}

export interface GooglePlacesSearchInput {
  apiKey: string;
  apiKeys?: string[];
  filters: GoogleMapsFilters;
  maxResults: number;
  requestBudget?: number;
  onShardEvent?: (event: GooglePlacesShardEvent) => Promise<void> | void;
  onRequestEvent?: (event: GooglePlacesRequestEvent) => Promise<void> | void;
  onPage?: (event: GooglePlacesPageEvent) => Promise<void> | void;
  shouldStop?: () => boolean;
}

export interface GooglePlacesShardEvent {
  type: 'started' | 'completed' | 'failed';
  shard: number;
  shardCount: number;
  query: string;
  itemCount?: number;
  totalItemCount?: number;
  errorMessage?: string;
  errorCode?: GooglePlacesErrorCode;
}

export interface GooglePlacesClient {
  search(input: GooglePlacesSearchInput): Promise<unknown[]>;
}

interface GooglePlacesResponse {
  places?: unknown[];
  nextPageToken?: string;
}

const FIELD_MASK = [
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
].join(',');

async function responseError(response: Response): Promise<GooglePlacesError> {
  const payload = await response.json().catch(() => ({})) as {
    error?: { status?: string };
  };
  const statusName = payload.error?.status;
  if (response.status === 401 || statusName === 'UNAUTHENTICATED') {
    return new GooglePlacesError('invalid_key', 'Google API key was rejected.', response.status);
  }
  if (response.status === 403 || statusName === 'PERMISSION_DENIED') {
    return new GooglePlacesError(
      'forbidden',
      'Google Places access is forbidden; check key restrictions, API enablement, and billing.',
      response.status
    );
  }
  if (statusName === 'RESOURCE_EXHAUSTED') {
    return new GooglePlacesError('quota', 'Google Places quota was reached.', response.status);
  }
  if (response.status === 429) {
    return new GooglePlacesError('rate_limited', 'Google Places rate limit was reached.', response.status);
  }
  if (response.status >= 500) {
    return new GooglePlacesError('transient', 'Google Places is temporarily unavailable.', response.status);
  }
  return new GooglePlacesError(
    'request_failed',
    `Google Places request failed with status ${response.status}.`,
    response.status
  );
}

function asGoogleError(error: unknown): GooglePlacesError {
  if (error instanceof GooglePlacesError) return error;
  return new GooglePlacesError('transient', 'Google Places network request failed.');
}

function isTerminalGoogleError(error: GooglePlacesError): boolean {
  return ['invalid_key', 'forbidden', 'quota', 'rate_limited'].includes(error.code);
}

export class GooglePlacesApiClient implements GooglePlacesClient {
  async search({
    apiKey,
    apiKeys,
    filters,
    maxResults,
    requestBudget,
    onShardEvent,
    onRequestEvent,
    onPage,
    shouldStop,
  }: GooglePlacesSearchInput): Promise<unknown[]> {
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

    function addUniquePlaces(items: unknown[]): unknown[] {
      const added: unknown[] = [];
      for (const item of items) {
        const key = placeKey(item) || JSON.stringify(item);
        if (seenPlaces.has(key)) continue;
        seenPlaces.add(key);
        places.push(item);
        added.push(item);
      }
      return added;
    }

    async function requestPage(body: Record<string, unknown>, startKeyIndex: number): Promise<GooglePlacesResponse> {
      let lastError: GooglePlacesError | undefined;

      for (let attempt = 0; attempt < keyPool.length; attempt += 1) {
        if (requestCount >= budget) {
          throw new GooglePlacesError('budget_exhausted', 'Google Places request budget exhausted.');
        }
        requestCount += 1;
        await onRequestEvent?.({ type: 'attempted', requestCount, budget });
        const queryApiKey = keyPool[(startKeyIndex + attempt) % keyPool.length];
        try {
          const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': queryApiKey,
              'X-Goog-FieldMask': FIELD_MASK,
            },
            body: JSON.stringify(body),
          });
          if (!response.ok) throw await responseError(response);
          await onRequestEvent?.({ type: 'succeeded', requestCount, budget, httpStatus: response.status });
          return await response.json() as GooglePlacesResponse;
        } catch (error) {
          lastError = asGoogleError(error);
          await onRequestEvent?.({
            type: 'failed',
            requestCount,
            budget,
            httpStatus: lastError.httpStatus,
            errorCode: lastError.code,
          });
          if (attempt === keyPool.length - 1) throw lastError;
        }
      }

      throw lastError ?? new GooglePlacesError('request_failed', 'Google Places request failed.');
    }

    queryLoop: for (const [queryIndex, textQuery] of queries.entries()) {
      if (places.length >= maxResults || shouldStop?.()) break;
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
          if (shouldStop?.()) break;
          const remaining = maxResults - places.length;
          const body: Record<string, unknown> = {
            textQuery,
            pageSize: Math.min(20, remaining),
          };
          if (pageToken) body.pageToken = pageToken;

          const data = await requestPage(body, queryIndex % keyPool.length);
          const addedItems = addUniquePlaces(data.places ?? []);
          shardItemCount += addedItems.length;
          pageToken = data.nextPageToken;
          if (addedItems.length) {
            await onPage?.({
              shard: queryIndex + 1,
              shardCount: queries.length,
              query: textQuery,
              items: addedItems,
              totalItemCount: places.length,
            });
          }
        } while (pageToken && places.length < maxResults && !shouldStop?.());

        await onShardEvent?.({
          type: 'completed',
          shard: queryIndex + 1,
          shardCount: queries.length,
          query: textQuery,
          itemCount: shardItemCount,
          totalItemCount: places.length,
        });
      } catch (error) {
        const googleError = asGoogleError(error);
        await onShardEvent?.({
          type: 'failed',
          shard: queryIndex + 1,
          shardCount: queries.length,
          query: textQuery,
          errorMessage: googleError.message,
          errorCode: googleError.code,
          totalItemCount: places.length,
        });
        if (googleError.code === 'budget_exhausted') break queryLoop;
        if (isTerminalGoogleError(googleError)) throw googleError;
        if (!places.length && queryIndex === queries.length - 1) throw googleError;
      }
    }

    return places.slice(0, maxResults);
  }
}
