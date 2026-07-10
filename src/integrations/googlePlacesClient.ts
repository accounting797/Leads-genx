import { GoogleMapsFilters } from '../domain/types';

export interface GooglePlacesSearchInput {
  apiKey: string;
  apiKeys?: string[];
  filters: GoogleMapsFilters;
  maxResults: number;
}

export interface GooglePlacesClient {
  search(input: GooglePlacesSearchInput): Promise<unknown[]>;
}

function cleanValues(values?: string[]): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function buildQueries(filters: GoogleMapsFilters): string[] {
  const terms = cleanValues(filters.searchTerms);
  const categories = cleanValues(filters.categoryFilters);
  const companyTypes = cleanValues(filters.companyTypes);
  const locations = cleanValues(filters.locations);
  const base = [...terms, ...categories, ...companyTypes];

  if (filters.locationQuery?.trim()) {
    return base.length
      ? base.map((query) => `${query} ${filters.locationQuery}`)
      : [filters.locationQuery.trim()];
  }

  if (!locations.length) return base;
  return base.flatMap((query) => locations.map((location) => `${query} ${location}`));
}

export class GooglePlacesApiClient implements GooglePlacesClient {
  async search({ apiKey, apiKeys, filters, maxResults }: GooglePlacesSearchInput): Promise<unknown[]> {
    const queries = buildQueries(filters);
    const places: unknown[] = [];
    const keyPool = apiKeys?.length ? apiKeys : [apiKey];

    for (const [queryIndex, textQuery] of queries.entries()) {
      if (places.length >= maxResults) break;
      const queryApiKey = keyPool[queryIndex % keyPool.length];
      let pageToken: string | undefined;

      do {
        const remaining = maxResults - places.length;
        const body: Record<string, unknown> = {
          textQuery,
          pageSize: Math.min(20, remaining),
        };
        if (pageToken) body.pageToken = pageToken;

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

        const data = (await response.json()) as { places?: unknown[]; nextPageToken?: string };
        places.push(...(data.places ?? []));
        pageToken = data.nextPageToken;
      } while (pageToken && places.length < maxResults);
    }

    return places.slice(0, maxResults);
  }
}
