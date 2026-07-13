import { buildGoogleMapsSearchQueries } from '../domain/googleMapsQueryBuilder';
import { GoogleMapsFilters } from '../domain/types';

export interface LocalMapsScraperEvent {
  type: 'unavailable' | 'started' | 'completed' | 'failed';
  message?: string;
  jobId?: string;
  itemCount?: number;
}

export interface LocalMapsScraperSearchInput {
  filters: GoogleMapsFilters;
  maxResults: number;
  onEvent?: (event: LocalMapsScraperEvent) => Promise<void> | void;
}

export interface LocalMapsScraperClient {
  search(input: LocalMapsScraperSearchInput): Promise<unknown[]>;
}

interface LocalMapsScraperLocationPlan {
  filters: GoogleMapsFilters;
  coords: { lat: string; lon: string };
}

const DEFAULT_BASE_URL = 'http://localhost:8080';
const DEFAULT_COORDINATES: Record<string, { lat: string; lon: string }> = {
  'austin, tx': { lat: '30.2672', lon: '-97.7431' },
  'phoenix, az': { lat: '33.4484', lon: '-112.0740' },
  'miami, fl': { lat: '25.7617', lon: '-80.1918' },
  'dallas, tx': { lat: '32.7767', lon: '-96.7970' },
  'los angeles, ca': { lat: '34.0522', lon: '-118.2437' },
  'new york, ny': { lat: '40.7128', lon: '-74.0060' },
  'atlanta, ga': { lat: '33.7490', lon: '-84.3880' },
  'chicago, il': { lat: '41.8781', lon: '-87.6298' },
  'houston, tx': { lat: '29.7604', lon: '-95.3698' },
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanCell(value = ''): string {
  return value.trim();
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cleanCell(cell));
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cleanCell(cell));
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  row.push(cleanCell(cell));
  if (row.some(Boolean)) rows.push(row);
  const [headers = [], ...dataRows] = rows;
  return dataRows.map((dataRow) => Object.fromEntries(headers.map((header, index) => [header, dataRow[index] ?? ''])));
}

function splitEmails(value?: string): string[] {
  return (value ?? '')
    .split(/[,;\s]+/)
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.includes('@'));
}

function firstLocation(filters: GoogleMapsFilters): string | undefined {
  return filters.locations?.[0] ?? filters.locationQuery;
}

function coordinatesFor(filters: GoogleMapsFilters): { lat: string; lon: string } | undefined {
  const location = firstLocation(filters);
  return location ? DEFAULT_COORDINATES[location.trim().toLowerCase()] : undefined;
}

function locationPlans(filters: GoogleMapsFilters): LocalMapsScraperLocationPlan[] {
  const locations = filters.locations?.length ? filters.locations : filters.locationQuery ? [filters.locationQuery] : [];
  const plans: LocalMapsScraperLocationPlan[] = [];
  for (const location of locations) {
    const coords = DEFAULT_COORDINATES[location.trim().toLowerCase()];
    if (!coords) continue;
    plans.push({
      filters: { ...filters, locations: [location], locationQuery: undefined },
      coords,
    });
  }

  if (plans.length) return plans;
  const coords = coordinatesFor(filters);
  return coords ? [{ filters, coords }] : [];
}

function toLeadRows(rows: Record<string, string>[], maxResults: number): unknown[] {
  const leads: unknown[] = [];
  for (const row of rows) {
    if (leads.length >= maxResults) break;
    const emails = splitEmails(row.emails);
    const base = {
      title: row.title,
      phone: row.phone,
      website: row.website,
      category: row.category,
      address: row.address,
      review_rating: row.review_rating,
      review_count: row.review_count,
      placeUrl: row.link,
    };

    if (!emails.length) {
      leads.push(base);
      continue;
    }

    for (const email of emails) {
      if (leads.length >= maxResults) break;
      leads.push({ ...base, email });
    }
  }
  return leads;
}

export class LocalMapsScraperKitClient implements LocalMapsScraperClient {
  constructor(
    private readonly options: {
      baseUrl?: string;
      pollIntervalMs?: number;
      maxPolls?: number;
      maxTimeSeconds?: number;
      depth?: number;
    } = {}
  ) {}

  async search({ filters, maxResults, onEvent }: LocalMapsScraperSearchInput): Promise<unknown[]> {
    const baseUrl = this.options.baseUrl ?? process.env.LOCAL_MAPS_SCRAPER_URL ?? DEFAULT_BASE_URL;
    const plans = locationPlans(filters);
    if (!plans.length) return [];

    try {
      const health = await fetch(`${baseUrl}/api/v1/jobs`);
      if (!health.ok) throw new Error(`health returned ${health.status}`);
    } catch {
      await onEvent?.({
        type: 'unavailable',
        message: `Local Google Maps scraper-kit is not reachable at ${baseUrl}`,
      });
      return [];
    }

    const allItems: unknown[] = [];

    for (const plan of plans) {
      if (allItems.length >= maxResults) break;
      const keywords = buildGoogleMapsSearchQueries(plan.filters).slice(0, 100);
      if (!keywords.length) continue;

      const createResponse = await fetch(`${baseUrl}/api/v1/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'leads-genx-local-google',
          keywords,
          lang: 'en',
          zoom: 15,
          lat: plan.coords.lat,
          lon: plan.coords.lon,
          fast_mode: false,
          radius: 10000,
          depth: this.options.depth ?? 10,
          email: true,
          max_time: this.options.maxTimeSeconds ?? 900,
        }),
      });

      if (!createResponse.ok) {
        await onEvent?.({
          type: 'failed',
          message: `Local Google Maps scraper-kit create failed with status ${createResponse.status}`,
        });
        continue;
      }

      const createData = (await createResponse.json()) as { id?: string };
      const jobId = createData.id;
      if (!jobId) continue;
      await onEvent?.({ type: 'started', jobId });

      const maxPolls = this.options.maxPolls ?? 120;
      let completed = false;
      for (let poll = 0; poll < maxPolls; poll += 1) {
        const statusResponse = await fetch(`${baseUrl}/api/v1/jobs/${jobId}`);
        const statusData = statusResponse.ok ? ((await statusResponse.json()) as { Status?: string }) : {};
        const status = statusData.Status?.toLowerCase();
        if (status === 'failed' || status === 'error') {
          await onEvent?.({ type: 'failed', jobId, message: 'Local Google Maps scraper-kit job failed' });
          completed = false;
          break;
        }
        if (status === 'ok') {
          completed = true;
          break;
        }
        await wait(this.options.pollIntervalMs ?? 8000);
      }

      if (!completed) {
        await onEvent?.({
          type: 'failed',
          jobId,
          message: 'Local Google Maps scraper-kit job did not finish before the polling limit',
        });
        continue;
      }

      const downloadResponse = await fetch(`${baseUrl}/api/v1/jobs/${jobId}/download`);
      if (!downloadResponse.ok) {
        await onEvent?.({
          type: 'failed',
          jobId,
          message: `Local Google Maps scraper-kit download failed with status ${downloadResponse.status}`,
        });
        continue;
      }

      allItems.push(...toLeadRows(parseCsv(await downloadResponse.text()), maxResults - allItems.length));
    }

    await onEvent?.({ type: 'completed', itemCount: allItems.length });
    return allItems;
  }
}

export const LocalMapsScraperClient = LocalMapsScraperKitClient;
