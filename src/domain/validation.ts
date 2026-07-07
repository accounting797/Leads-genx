import { GoogleMapsFilters, LeadSource, SalesNavigatorFilters, ValidatedRunInput } from './types';

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly fields: Record<string, string> = {}
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  return values.length ? values : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function hasSalesNavigatorFilters(filters?: SalesNavigatorFilters): boolean {
  if (!filters) return false;
  return Boolean(
    filters.keywords ||
      filters.titles?.length ||
      filters.industries?.length ||
      filters.geographies?.length ||
      filters.companies?.length ||
      filters.seniorities?.length ||
      filters.functions?.length ||
      filters.headcounts?.length
  );
}

function hasGoogleMapsCriteria(filters?: GoogleMapsFilters): boolean {
  if (!filters) return false;
  return Boolean(filters.mapsUrl || filters.searchTerms?.length || filters.categoryFilters?.length);
}

function parseLeadSource(value: unknown): LeadSource | undefined {
  return value === 'google_maps' || value === 'sales_navigator' ? value : undefined;
}

function parseGoogleMaps(value: unknown): GoogleMapsFilters | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  return {
    searchTerms: asStringArray(obj.searchTerms),
    categoryFilters: asStringArray(obj.categoryFilters),
    locationQuery: asString(obj.locationQuery),
    mapsUrl: asString(obj.mapsUrl),
    maxPlaces: asNumber(obj.maxPlaces),
    minimumStars: asNumber(obj.minimumStars),
    minimumReviews: asNumber(obj.minimumReviews),
    skipClosedPlaces: typeof obj.skipClosedPlaces === 'boolean' ? obj.skipClosedPlaces : undefined,
  };
}

function parseSalesNavigator(value: unknown): SalesNavigatorFilters | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  return {
    keywords: asString(obj.keywords),
    titles: asStringArray(obj.titles),
    industries: asStringArray(obj.industries),
    geographies: asStringArray(obj.geographies),
    companies: asStringArray(obj.companies),
    seniorities: asStringArray(obj.seniorities),
    functions: asStringArray(obj.functions),
    headcounts: asStringArray(obj.headcounts),
  };
}

export function validateCreateRunInput(input: unknown, hasSavedToken: boolean): ValidatedRunInput {
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const fields: Record<string, string> = {};

  const apifyToken = asString(obj.apifyToken);
  if (!apifyToken && !hasSavedToken) {
    fields.apifyToken = 'Apify token is required.';
  }

  const leadSource = parseLeadSource(obj.leadSource);
  if (!leadSource) {
    fields.leadSource = 'Lead source must be google_maps or sales_navigator.';
  }

  const maxResults = asNumber(obj.maxResults) ?? 100;
  if (maxResults < 1 || maxResults > 1000) {
    fields.maxResults = 'maxResults must be between 1 and 1000.';
  }

  const searchUrl = asString(obj.searchUrl);
  if (searchUrl) {
    try {
      new URL(searchUrl);
    } catch {
      fields.searchUrl = 'Search URL must be a valid URL.';
    }
  }

  const googleMaps = parseGoogleMaps(obj.googleMaps);
  const salesNavigator = parseSalesNavigator(obj.salesNavigator ?? obj.filters);

  if (leadSource === 'google_maps' && !hasGoogleMapsCriteria(googleMaps)) {
    fields.googleMaps = 'Google Maps runs need at least one search term, category, or Maps URL.';
  }

  if (leadSource === 'sales_navigator' && !searchUrl && !hasSalesNavigatorFilters(salesNavigator)) {
    fields.salesNavigator = 'Sales Navigator runs need a search URL or professional filters.';
  }

  if (Object.keys(fields).length) {
    throw new ValidationError(Object.values(fields)[0], fields);
  }

  return {
    apifyToken,
    leadSource: leadSource ?? 'google_maps',
    actorId: asString(obj.actorId),
    searchUrl,
    maxResults,
    googleMaps,
    salesNavigator,
  };
}
