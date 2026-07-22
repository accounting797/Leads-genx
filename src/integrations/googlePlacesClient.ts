import { GoogleMapsFilters } from '../domain/types';
import { buildQueryPlan, PlannedQuery, QueryTier } from '../domain/queryPlan';

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

export type GooglePlacesWorkUnitEvent =
  | { type: 'planned'; plannedUnitCount: number }
  | { type: 'extended'; additionalPlannedUnitCount: number }
  | {
      type: 'warning';
      warningCode: 'google_budget_below_location_coverage';
      requestBudget: number;
      locationCount: number;
    }
  | {
      type: 'started' | 'completed' | 'failed';
      workUnitId: string;
      tier: QueryTier;
      pageDepth: number;
      itemCount?: number;
      errorCode?: GooglePlacesErrorCode;
    };

export interface GooglePlacesSearchInput {
  apiKey: string;
  apiKeys?: string[];
  filters: GoogleMapsFilters;
  maxResults: number;
  requestBudget?: number;
  onShardEvent?: (event: GooglePlacesShardEvent) => Promise<void> | void;
  onRequestEvent?: (event: GooglePlacesRequestEvent) => Promise<void> | void;
  onPage?: (event: GooglePlacesPageEvent) => Promise<void> | void;
  shouldActivateRecovery?: () => boolean;
  onWorkUnitEvent?: (event: GooglePlacesWorkUnitEvent) => Promise<void> | void;
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

interface PendingPage {
  query: PlannedQuery;
  token: string;
  depth: number;
  shard: number;
}

class SchedulingStopped extends Error {}

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
  return ['invalid_key', 'forbidden', 'quota'].includes(error.code);
}

function pageBody(textQuery: string, pageToken: string | undefined, remaining: number) {
  const body: Record<string, unknown> = { textQuery, pageSize: Math.min(20, remaining) };
  if (pageToken) body.pageToken = pageToken;
  return body;
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
    shouldActivateRecovery,
    onWorkUnitEvent,
    shouldStop,
  }: GooglePlacesSearchInput): Promise<unknown[]> {
    const plan = buildQueryPlan(filters);
    const nonRecoveryPlan = plan.filter((query) => query.tier !== 'recovery');
    const recoveryPlan = plan.filter((query) => query.tier === 'recovery');
    const places: unknown[] = [];
    const seenPlaces = new Set<string>();
    const activeKeys = [...new Set(apiKeys?.length ? apiKeys : [apiKey])];
    const budget = requestBudget ?? Number.MAX_SAFE_INTEGER;
    let requestCount = 0;
    let lastError: GooglePlacesError | undefined;
    let lastProcessedUnitFailed = false;
    const shardItems = new Map<string, number>();
    const finishedShards = new Set<string>();
    const shardNumbers = new Map(plan.map((query, index) => [query.id, index + 1]));

    await onWorkUnitEvent?.({ type: 'planned', plannedUnitCount: nonRecoveryPlan.length });
    const locationCount = new Set(
      nonRecoveryPlan.map((query) => query.location.trim()).filter(Boolean)
    ).size;
    if (budget < locationCount) {
      await onWorkUnitEvent?.({
        type: 'warning',
        warningCode: 'google_budget_below_location_coverage',
        requestBudget: budget,
        locationCount,
      });
    }

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

    function canRequest(): boolean {
      return requestCount < budget && places.length < maxResults && !shouldStop?.();
    }

    async function requestPage(body: Record<string, unknown>, startKeyIndex: number): Promise<GooglePlacesResponse> {
      let requestError: GooglePlacesError | undefined;
      const orderedKeys = activeKeys.map(
        (_, offset) => activeKeys[(startKeyIndex + offset) % activeKeys.length]
      );

      for (const queryApiKey of orderedKeys) {
        if (requestCount >= budget) {
          throw new GooglePlacesError('budget_exhausted', 'Google Places request budget exhausted.');
        }
        if (shouldStop?.()) throw new SchedulingStopped();
        if (!activeKeys.includes(queryApiKey)) continue;
        requestCount += 1;
        await onRequestEvent?.({ type: 'attempted', requestCount, budget });
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
          requestError = asGoogleError(error);
          await onRequestEvent?.({
            type: 'failed',
            requestCount,
            budget,
            httpStatus: requestError.httpStatus,
            errorCode: requestError.code,
          });
          if (isTerminalGoogleError(requestError)) {
            const keyIndex = activeKeys.indexOf(queryApiKey);
            if (keyIndex >= 0) activeKeys.splice(keyIndex, 1);
            if (activeKeys.length === 0) throw requestError;
          }
        }
      }

      throw requestError ?? new GooglePlacesError('request_failed', 'Google Places request failed.');
    }

    function shardCountFor(query: PlannedQuery): number {
      return query.tier === 'recovery' ? plan.length : nonRecoveryPlan.length;
    }

    async function completeShard(query: PlannedQuery, shard: number): Promise<void> {
      if (finishedShards.has(query.id)) return;
      finishedShards.add(query.id);
      await onShardEvent?.({
        type: 'completed',
        shard,
        shardCount: shardCountFor(query),
        query: query.text,
        itemCount: shardItems.get(query.id) ?? 0,
        totalItemCount: places.length,
      });
    }

    async function failShard(query: PlannedQuery, shard: number, error: GooglePlacesError): Promise<void> {
      if (finishedShards.has(query.id)) return;
      finishedShards.add(query.id);
      await onShardEvent?.({
        type: 'failed',
        shard,
        shardCount: shardCountFor(query),
        query: query.text,
        errorMessage: error.message,
        errorCode: error.code,
        totalItemCount: places.length,
      });
    }

    type PageResult =
      | { type: 'success'; nextPageToken?: string }
      | { type: 'failed'; error: GooglePlacesError }
      | { type: 'stopped' };

    async function runPage(
      query: PlannedQuery,
      pageToken: string | undefined,
      pageDepth: number,
      shard: number
    ): Promise<PageResult> {
      if (!canRequest()) return { type: 'stopped' };
      const workUnitId = `${query.id}:${pageDepth}`;
      await onWorkUnitEvent?.({ type: 'started', workUnitId, tier: query.tier, pageDepth });
      try {
        const data = await requestPage(
          pageBody(query.text, pageToken, maxResults - places.length),
          shard - 1
        );
        const addedItems = addUniquePlaces(data.places ?? []);
        shardItems.set(query.id, (shardItems.get(query.id) ?? 0) + addedItems.length);
        if (addedItems.length) {
          await onPage?.({
            shard,
            shardCount: shardCountFor(query),
            query: query.text,
            items: addedItems,
            totalItemCount: places.length,
          });
        }
        await onWorkUnitEvent?.({
          type: 'completed',
          workUnitId,
          tier: query.tier,
          pageDepth,
          itemCount: addedItems.length,
        });
        lastProcessedUnitFailed = false;
        return { type: 'success', nextPageToken: data.nextPageToken };
      } catch (error) {
        if (error instanceof SchedulingStopped) return { type: 'stopped' };
        const googleError = asGoogleError(error);
        lastError = googleError;
        lastProcessedUnitFailed = true;
        await onWorkUnitEvent?.({
          type: 'failed',
          workUnitId,
          tier: query.tier,
          pageDepth,
          errorCode: googleError.code,
        });
        await failShard(query, shard, googleError);
        if (isTerminalGoogleError(googleError) && activeKeys.length === 0) throw googleError;
        return { type: 'failed', error: googleError };
      }
    }

    async function processTier(tierQueries: PlannedQuery[]): Promise<boolean> {
      const pendingPages: PendingPage[] = [];

      for (const query of tierQueries) {
        if (!canRequest()) return false;
        const shard = shardNumbers.get(query.id) ?? 1;
        shardItems.set(query.id, 0);
        await onShardEvent?.({
          type: 'started',
          shard,
          shardCount: shardCountFor(query),
          query: query.text,
        });
        const result = await runPage(query, undefined, 1, shard);
        if (result.type === 'stopped') return false;
        if (result.type === 'failed') {
          if (result.error.code === 'budget_exhausted') return false;
          continue;
        }
        if (result.nextPageToken) {
          pendingPages.push({ query, token: result.nextPageToken, depth: 2, shard });
        } else {
          await completeShard(query, shard);
        }
      }

      while (pendingPages.length > 0) {
        if (!canRequest()) return false;
        const page = pendingPages.shift()!;
        const result = await runPage(page.query, page.token, page.depth, page.shard);
        if (result.type === 'stopped') return false;
        if (result.type === 'failed') {
          if (result.error.code === 'budget_exhausted') return false;
          continue;
        }
        if (result.nextPageToken) {
          pendingPages.push({
            query: page.query,
            token: result.nextPageToken,
            depth: page.depth + 1,
            shard: page.shard,
          });
        } else {
          await completeShard(page.query, page.shard);
        }
      }

      return true;
    }

    const precisionCompleted = await processTier(
      nonRecoveryPlan.filter((query) => query.tier === 'precision')
    );
    if (precisionCompleted) {
      await processTier(nonRecoveryPlan.filter((query) => query.tier === 'expansion'));
    }

    if (canRequest() && recoveryPlan.length > 0 && (shouldActivateRecovery?.() ?? true)) {
      await onWorkUnitEvent?.({
        type: 'extended',
        additionalPlannedUnitCount: recoveryPlan.length,
      });
      await processTier(recoveryPlan);
    }

    if (!places.length && requestCount < budget && lastProcessedUnitFailed && lastError) throw lastError;
    return places.slice(0, maxResults);
  }
}
