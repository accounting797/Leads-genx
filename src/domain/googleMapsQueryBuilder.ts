import { GoogleMapsFilters } from './types';
import { buildQueryPlan } from './queryPlan';

export function buildGoogleMapsSearchQueries(filters: GoogleMapsFilters): string[] {
  return buildQueryPlan(filters)
    .filter((item) => item.tier !== 'recovery')
    .map((item) => item.text);
}
