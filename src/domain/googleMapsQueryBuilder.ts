import { GoogleMapsFilters } from './types';

function cleanValues(values?: string[]): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values));
}

function combine(left: string[], right: string[]): string[] {
  return left.flatMap((leftValue) => right.map((rightValue) => `${leftValue} ${rightValue}`));
}

export function buildGoogleMapsSearchQueries(filters: GoogleMapsFilters): string[] {
  const searchTerms = cleanValues(filters.searchTerms);
  const categories = cleanValues(filters.categoryFilters);
  const companyTypes = cleanValues(filters.companyTypes);
  const locations = cleanValues(filters.locations);
  const baseSearches = uniqueValues([
    ...searchTerms,
    ...categories,
    ...companyTypes,
    ...combine(searchTerms, categories),
    ...combine(searchTerms, companyTypes),
    ...combine(categories, companyTypes),
  ]);

  if (filters.locationQuery?.trim()) {
    const location = filters.locationQuery.trim();
    return baseSearches.length ? baseSearches.map((search) => `${search} ${location}`) : [location];
  }

  if (!locations.length) return baseSearches;
  return uniqueValues(locations.flatMap((location) => baseSearches.map((search) => `${search} ${location}`)));
}
