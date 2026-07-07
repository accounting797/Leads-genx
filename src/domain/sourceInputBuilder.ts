import {
  ActorRunInput,
  GoogleMapsFilters,
  SalesNavigatorFilters,
  ValidatedRunInput,
} from './types';

const DEFAULT_GOOGLE_MAPS_ACTOR_ID = 'compass/google-maps-extractor';
const DEFAULT_SALES_NAVIGATOR_ACTOR_ID = 'harvestapi/linkedin-profile-search';

function addRepeated(parts: string[], key: string, values?: string[]) {
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (trimmed) parts.push(`${key}:${trimmed}`);
  }
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
  if (filters.searchTerms?.length) {
    input.searchStringsArray = filters.searchTerms.map((term) => term.trim()).filter(Boolean);
  }
  if (filters.categoryFilters?.length) {
    input.categoryFilterWords = filters.categoryFilters
      .map((category) => category.trim())
      .filter(Boolean);
  }
  if (filters.locationQuery?.trim()) input.locationQuery = filters.locationQuery.trim();
  if (filters.maxPlaces) input.maxCrawledPlacesPerSearch = filters.maxPlaces;
  if (filters.minimumStars) input.placeMinimumStars = String(filters.minimumStars);
  if (filters.minimumReviews) input.reviewsCountMin = filters.minimumReviews;

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
