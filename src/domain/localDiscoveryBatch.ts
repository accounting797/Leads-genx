import { createHash } from 'node:crypto';
import { buildGoogleMapsSearchQueries } from './googleMapsQueryBuilder';
import { GoogleMapsFilters } from './types';

export interface LocalDiscoveryBatch {
  key: string;
  query: string;
  location?: string;
  lat?: string;
  lon?: string;
  depth: number;
  maxResults: number;
}

export const LOCAL_DISCOVERY_COORDINATES: Readonly<Record<string, { lat: string; lon: string }>> = {
  'austin, tx': { lat: '30.2672', lon: '-97.7431' },
  'phoenix, az': { lat: '33.4484', lon: '-112.0740' },
  'miami, fl': { lat: '25.7617', lon: '-80.1918' },
  'dallas, tx': { lat: '32.7767', lon: '-96.7970' },
  'los angeles, ca': { lat: '34.0522', lon: '-118.2437' },
  'new york, ny': { lat: '40.7128', lon: '-74.0060' },
  'atlanta, ga': { lat: '33.7490', lon: '-84.3880' },
  'chicago, il': { lat: '41.8781', lon: '-87.6298' },
  'houston, tx': { lat: '29.7604', lon: '-95.3698' },
  'san francisco, ca': { lat: '37.7749', lon: '-122.4194' },
  'san antonio, tx': { lat: '29.4241', lon: '-98.4936' },
  'san diego, ca': { lat: '32.7157', lon: '-117.1611' },
  'san jose, ca': { lat: '37.3382', lon: '-121.8863' },
  'jacksonville, fl': { lat: '30.3322', lon: '-81.6557' },
  'tampa, fl': { lat: '27.9506', lon: '-82.4572' },
  'orlando, fl': { lat: '28.5383', lon: '-81.3792' },
  'charlotte, nc': { lat: '35.2271', lon: '-80.8431' },
  'raleigh, nc': { lat: '35.7796', lon: '-78.6382' },
  'nashville, tn': { lat: '36.1627', lon: '-86.7816' },
  'denver, co': { lat: '39.7392', lon: '-104.9903' },
  'las vegas, nv': { lat: '36.1699', lon: '-115.1398' },
  'seattle, wa': { lat: '47.6062', lon: '-122.3321' },
  'portland, or': { lat: '45.5152', lon: '-122.6784' },
  'boston, ma': { lat: '42.3601', lon: '-71.0589' },
  'philadelphia, pa': { lat: '39.9526', lon: '-75.1652' },
  'washington, dc': { lat: '38.9072', lon: '-77.0369' },
  'minneapolis, mn': { lat: '44.9778', lon: '-93.2650' },
  'detroit, mi': { lat: '42.3314', lon: '-83.0458' },
  'columbus, oh': { lat: '39.9612', lon: '-82.9988' },
  'tulsa, ok': { lat: '36.1540', lon: '-95.9928' },
  'midland, tx': { lat: '31.9973', lon: '-102.0779' },
};

function cleanLocations(filters: GoogleMapsFilters): string[] {
  const values = filters.locations?.length ? filters.locations : filters.locationQuery ? [filters.locationQuery] : [];
  return [...new Map(values.map((value) => [value.trim().toLowerCase(), value.trim()])).values()].filter(Boolean);
}

function stableKey(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function buildLocalDiscoveryBatches(filters: GoogleMapsFilters, maxResults = 100): LocalDiscoveryBatch[] {
  const locations = cleanLocations(filters);
  const plans = locations.length ? locations : [undefined];
  const batches = new Map<string, LocalDiscoveryBatch>();

  for (const location of plans) {
    const scopedFilters: GoogleMapsFilters = {
      ...filters,
      locations: location ? [location] : undefined,
      locationQuery: undefined,
    };
    const coords = location ? LOCAL_DISCOVERY_COORDINATES[location.toLowerCase()] : undefined;
    for (const query of buildGoogleMapsSearchQueries(scopedFilters)) {
      const normalized = query.replace(/\s+/g, ' ').trim();
      const identity = { query: normalized.toLowerCase(), location: location?.toLowerCase() ?? '', depth: 10 };
      const key = stableKey(identity);
      if (!batches.has(key)) {
        batches.set(key, {
          key,
          query: normalized,
          location,
          lat: coords?.lat,
          lon: coords?.lon,
          depth: 10,
          maxResults: Math.max(1, maxResults),
        });
      }
    }
  }

  return [...batches.values()];
}
