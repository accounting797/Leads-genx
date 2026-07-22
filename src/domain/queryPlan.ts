import { createHash } from 'node:crypto';
import { GoogleMapsFilters } from './types';

export type QueryTier = 'precision' | 'expansion' | 'recovery';
export type QueryProvider = 'docker' | 'google' | 'apify';

export interface PlannedQuery {
  id: string;
  tier: QueryTier;
  location: string;
  text: string;
  providerEligibility: QueryProvider[];
  qualityConfidence: 'high' | 'medium' | 'low';
}

const RECOVERY_MODIFIERS = ['supplier', 'distributor', 'retailer', 'service'];

function clean(values?: string[]): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function item(tier: QueryTier, location: string, text: string): PlannedQuery {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return {
    id: createHash('sha256').update(`${tier}\0${location}\0${normalized}`).digest('hex').slice(0, 20),
    tier,
    location,
    text: normalized,
    providerEligibility: ['docker', 'google', 'apify'],
    qualityConfidence: tier === 'precision' ? 'high' : tier === 'expansion' ? 'medium' : 'low',
  };
}

export function buildQueryPlan(filters: GoogleMapsFilters): PlannedQuery[] {
  const terms = clean(filters.searchTerms);
  const categories = clean(filters.categoryFilters);
  const companyTypes = clean(filters.companyTypes);
  const locations = filters.locationQuery?.trim()
    ? [filters.locationQuery.trim()]
    : clean(filters.locations);
  const effectiveLocations = locations.length ? locations : [''];
  const byLocation: PlannedQuery[][] = [];

  for (const location of effectiveLocations) {
    const locationPlan: PlannedQuery[] = [];
    const suffix = location ? ` ${location}` : '';
    const precision = [
      ...terms,
      ...categories,
      ...terms.flatMap((term) => categories.map((category) => `${term} ${category}`)),
    ];
    if (precision.length === 0) {
      locationPlan.push(item('precision', location, location));
    } else {
      for (const text of [...new Set(precision)]) {
        locationPlan.push(item('precision', location, `${text}${suffix}`));
      }
    }

    for (const text of [...terms, ...categories]) {
      for (const companyType of companyTypes) {
        locationPlan.push(item('expansion', location, `${text} ${companyType}${suffix}`));
      }
    }

    const recoveryRoots = [...new Set([...terms, ...categories, ...companyTypes])];
    for (const root of recoveryRoots) {
      for (const modifier of RECOVERY_MODIFIERS) {
        if (root.toLowerCase().includes(modifier)) continue;
        locationPlan.push(item('recovery', location, `${root} ${modifier}${suffix}`));
      }
    }
    byLocation.push(locationPlan);
  }

  const plan: PlannedQuery[] = [];
  for (const tier of ['precision', 'expansion', 'recovery'] as const) {
    const groups = byLocation.map((group) => group.filter((query) => query.tier === tier));
    const longest = Math.max(0, ...groups.map((group) => group.length));
    for (let index = 0; index < longest; index += 1) {
      for (const group of groups) {
        if (group[index]) plan.push(group[index]);
      }
    }
  }
  const seen = new Set<string>();
  return plan.filter((query) => !seen.has(query.text.toLowerCase()) && seen.add(query.text.toLowerCase()));
}

export function queriesForTier(plan: PlannedQuery[], tier: QueryTier): PlannedQuery[] {
  return plan.filter((item) => item.tier === tier);
}
