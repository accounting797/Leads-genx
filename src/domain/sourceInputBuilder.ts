import {
  ActorRunInput,
  GoogleMapsFilters,
  SalesNavigatorFilters,
  ValidatedRunInput,
} from './types';
import { buildGoogleMapsSearchQueries } from './googleMapsQueryBuilder';

const DEFAULT_GOOGLE_MAPS_ACTOR_ID = 'compass/google-maps-extractor';
const DEFAULT_SALES_NAVIGATOR_ACTOR_ID = 'harvestapi/linkedin-profile-search';

function addRepeated(parts: string[], key: string, values?: string[]) {
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (trimmed) parts.push(`${key}:${trimmed}`);
  }
}

function buildGoogleMapsSearchStrings(filters: GoogleMapsFilters): string[] {
  return buildGoogleMapsSearchQueries({ ...filters, locationQuery: undefined });
}

function buildGoogleMapsShardSearchStrings(filters: GoogleMapsFilters): string[] {
  return buildGoogleMapsSearchQueries(filters);
}

function chunkSearchStrings(searchStrings: string[], chunkCount: number): string[][] {
  const size = Math.ceil(searchStrings.length / chunkCount);
  const chunks = Array.from({ length: chunkCount }, (_, index) =>
    searchStrings.slice(index * size, index * size + size)
  );
  return chunks.filter((chunk) => chunk.length);
}

function toApifyMinimumStars(value?: number): string | undefined {
  const allowed = new Map<number, string>([
    [2, 'two'],
    [2.5, 'twoAndHalf'],
    [3, 'three'],
    [3.5, 'threeAndHalf'],
    [4, 'four'],
    [4.5, 'fourAndHalf'],
  ]);
  return value ? allowed.get(value) : undefined;
}

export function buildSalesNavigatorUrl(filters: SalesNavigatorFilters): string {
  const parts: string[] = ['spellCorrectionEnabled:true'];

  if (filters.keywords?.trim()) parts.push(`keywords:${filters.keywords.trim()}`);
  addRepeated(parts, 'title', filters.titles);
  addRepeated(parts, 'industry', filters.industries);
  addRepeated(parts, 'geoUrn', filters.geographies);
  addRepeated(parts, 'currentCompany', filters.companies);
  addRepeated(parts, 'seniority', filters.seniorities);
  addRepeated(parts, 'function', filters.functions);
  addRepeated(parts, 'companyHeadcountRange', filters.headcounts);

  const query = encodeURIComponent(`(${parts.join(',')})`);
  return `https://www.linkedin.com/sales/search/people?query=${query}`;
}

export function buildGoogleMapsInput(filters: GoogleMapsFilters): Record<string, unknown> {
  const input: Record<string, unknown> = {
    language: 'en',
    skipClosedPlaces: filters.skipClosedPlaces ?? true,
  };

  if (filters.mapsUrl?.trim()) {
    input.startUrls = [{ url: filters.mapsUrl.trim() }];
  }
  const searchStrings = buildGoogleMapsSearchStrings(filters);
  if (searchStrings.length) {
    input.searchStringsArray = searchStrings;
  }
  if (filters.locationQuery?.trim()) input.locationQuery = filters.locationQuery.trim();
  if (filters.maxPlaces) input.maxCrawledPlacesPerSearch = filters.maxPlaces;
  const minimumStars = toApifyMinimumStars(filters.minimumStars);
  if (minimumStars) input.placeMinimumStars = minimumStars;
  if (filters.minimumReviews) input.reviewsCountMin = filters.minimumReviews;

  return input;
}

function buildGoogleMapsInputWithSearchStrings(
  filters: GoogleMapsFilters,
  searchStrings: string[]
): Record<string, unknown> {
  const input = buildGoogleMapsInput(filters);
  if (searchStrings.length) input.searchStringsArray = searchStrings;
  return input;
}

export function buildActorInput(input: ValidatedRunInput): ActorRunInput {
  if (!input.apifyToken) {
    throw new Error('Apify token is required to build actor input');
  }

  if (input.leadSource === 'google_maps') {
    return {
      token: input.apifyToken,
      leadSource: 'google_maps',
      actorId: input.actorId ?? process.env.DEFAULT_GOOGLE_MAPS_ACTOR_ID ?? DEFAULT_GOOGLE_MAPS_ACTOR_ID,
      input: buildGoogleMapsInput(input.googleMaps ?? {}),
      maxResults: input.maxResults,
    };
  }

  const searchUrl = input.searchUrl ?? buildSalesNavigatorUrl(input.salesNavigator ?? {});
  return {
    token: input.apifyToken,
    leadSource: 'sales_navigator',
    actorId:
      input.actorId ??
      process.env.DEFAULT_SALES_NAVIGATOR_ACTOR_ID ??
      DEFAULT_SALES_NAVIGATOR_ACTOR_ID,
    input: {
      searchUrl,
      maxResults: input.maxResults,
    },
    maxResults: input.maxResults,
  };
}

export function buildActorInputsForApifyTokens(input: ValidatedRunInput): ActorRunInput[] {
  const tokens = input.apifyTokens?.length ? input.apifyTokens : input.apifyToken ? [input.apifyToken] : [];
  if (!tokens.length) throw new Error('Apify token is required to build actor input');
  if (input.leadSource !== 'google_maps') return [buildActorInput({ ...input, apifyToken: tokens[0] })];

  const filters = input.googleMaps ?? {};
  const searchStrings = buildGoogleMapsShardSearchStrings(filters);
  if (!searchStrings.length || tokens.length === 1) {
    return [buildActorInput({ ...input, apifyToken: tokens[0] })];
  }

  const searchChunks = chunkSearchStrings(searchStrings, tokens.length);
  return tokens.map((token, index) => ({
    token,
    leadSource: 'google_maps',
    actorId: input.actorId ?? process.env.DEFAULT_GOOGLE_MAPS_ACTOR_ID ?? DEFAULT_GOOGLE_MAPS_ACTOR_ID,
    input: buildGoogleMapsInputWithSearchStrings(filters, searchChunks[index] ?? searchStrings),
    maxResults: input.maxResults,
  }));
}
