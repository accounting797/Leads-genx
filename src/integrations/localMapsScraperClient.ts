import { buildGoogleMapsSearchQueries } from '../domain/googleMapsQueryBuilder';
import { LocalDiscoveryBatch, LOCAL_DISCOVERY_COORDINATES } from '../domain/localDiscoveryBatch';
import { GoogleMapsFilters } from '../domain/types';
import type { ProxyRotator } from './proxyRotator';

export interface LocalMapsScraperEvent {
  type: 'unavailable' | 'started' | 'completed' | 'failed';
  message?: string;
  jobId?: string;
  itemCount?: number;
}

export interface LocalMapsScraperSearchInput {
  filters: GoogleMapsFilters;
  maxResults: number;
  proxyUrls?: string[];
  onEvent?: (event: LocalMapsScraperEvent) => Promise<void> | void;
}

export interface LocalMapsScraperClient {
  search(input: LocalMapsScraperSearchInput): Promise<unknown[]>;
}

export interface LocalBatchResult {
  batchKey: string;
  jobId: string;
  items: unknown[];
  rawBusinessCount: number;
}

export type LocalScraperErrorCode = 'unavailable' | 'unsupported_location' | 'create' | 'timeout' | 'failed' | 'download';

export class LocalScraperError extends Error {
  constructor(public readonly code: LocalScraperErrorCode, message: string) {
    super(message);
    this.name = 'LocalScraperError';
  }
}

export interface ResumableLocalMapsScraperClient extends LocalMapsScraperClient {
  health(): Promise<boolean>;
  searchBatch(input: { batch: LocalDiscoveryBatch; proxies?: string[] }): Promise<LocalBatchResult>;
}

interface LocalMapsScraperLocationPlan {
  filters: GoogleMapsFilters;
  coords: { lat: string; lon: string };
}

const DEFAULT_BASE_URL = 'http://localhost:8080';
const DEFAULT_COORDINATES = LOCAL_DISCOVERY_COORDINATES;

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
      proxyRotator?: ProxyRotator;
    } = {}
  ) {}

  private baseUrl(): string {
    return this.options.baseUrl ?? process.env.LOCAL_MAPS_SCRAPER_URL ?? DEFAULT_BASE_URL;
  }

  private containerProxies(proxies: string[]): string[] {
    return proxies.map((proxy) => {
      const url = new URL(proxy);
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') url.hostname = 'host.docker.internal';
      return url.toString();
    });
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl()}/api/v1/jobs`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async searchBatch({ batch, proxies = [] }: { batch: LocalDiscoveryBatch; proxies?: string[] }): Promise<LocalBatchResult> {
    if (!batch.lat || !batch.lon) throw new LocalScraperError('unsupported_location', 'Local scraper coordinates are unavailable for this location');
    const baseUrl = this.baseUrl();

    const effectiveProxies = proxies.length
      ? proxies
      : this.options.proxyRotator
        ? [await this.options.proxyRotator.getNextProxy() ?? '']
        : [];

    let usedProxy = effectiveProxies[0] || '';

    try {
      const response = await fetch(`${baseUrl}/api/v1/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `leads-genx-${batch.key.slice(0, 32)}`,
          keywords: [batch.query],
          lang: 'en',
          zoom: 15,
          lat: batch.lat,
          lon: batch.lon,
          fast_mode: false,
          radius: 10000,
          depth: batch.depth,
          email: false,
          max_time: this.options.maxTimeSeconds ?? 900,
          proxies: effectiveProxies.length && effectiveProxies[0]
            ? this.containerProxies(effectiveProxies)
            : undefined,
        }),
      }).catch(() => { throw new LocalScraperError('unavailable', 'Local Google Maps scraper-kit is unavailable'); });
      if (!response.ok) throw new LocalScraperError('create', `Local scraper job creation failed with status ${response.status}`);
      const created = await response.json() as { id?: string };
      if (!created.id) throw new LocalScraperError('create', 'Local scraper job creation returned no job id');

      const maxPolls = this.options.maxPolls ?? 120;
      let completed = false;
      for (let poll = 0; poll < maxPolls; poll += 1) {
        const statusResponse = await fetch(`${baseUrl}/api/v1/jobs/${created.id}`);
        const payload = statusResponse.ok ? await statusResponse.json() as { Status?: string; status?: string } : {};
        const status = (payload.Status ?? payload.status)?.toLowerCase();
        if (status === 'ok') {
          completed = true;
          break;
        }
        if (status === 'failed' || status === 'error') throw new LocalScraperError('failed', 'Local scraper job failed');
        await wait(this.options.pollIntervalMs ?? 8000);
      }
      if (!completed) throw new LocalScraperError('timeout', 'Local scraper job reached its polling limit');

      const download = await fetch(`${baseUrl}/api/v1/jobs/${created.id}/download`);
      if (!download.ok) throw new LocalScraperError('download', `Local scraper download failed with status ${download.status}`);
      const rows = parseCsv(await download.text());

      if (usedProxy && this.options.proxyRotator) this.options.proxyRotator.reportSuccess(usedProxy);

      return {
        batchKey: batch.key,
        jobId: created.id,
        items: toLeadRows(rows, batch.maxResults),
        rawBusinessCount: rows.length,
      };
    } catch (error) {
      if (usedProxy && this.options.proxyRotator) {
        this.options.proxyRotator.reportFailure(usedProxy, error instanceof Error ? error.message : undefined);
      }
      throw error;
    }
  }

  async search({ filters, maxResults, proxyUrls, onEvent }: LocalMapsScraperSearchInput): Promise<unknown[]> {
    const baseUrl = this.baseUrl();
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

      const effectiveProxies = proxyUrls?.length
        ? proxyUrls
        : this.options.proxyRotator
          ? [await this.options.proxyRotator.getNextProxy() ?? '']
          : [];

      const usedProxy = effectiveProxies[0] || '';

      try {
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
            email: false,
            max_time: this.options.maxTimeSeconds ?? 900,
            proxies: effectiveProxies.length && effectiveProxies[0]
              ? this.containerProxies(effectiveProxies)
              : undefined,
          }),
        });

        if (!createResponse.ok) {
          await onEvent?.({
            type: 'failed',
            message: `Local Google Maps scraper-kit create failed with status ${createResponse.status}`,
          });
          if (usedProxy && this.options.proxyRotator) {
            this.options.proxyRotator.reportFailure(usedProxy, `create failed ${createResponse.status}`);
          }
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
          if (usedProxy && this.options.proxyRotator) {
            this.options.proxyRotator.reportFailure(usedProxy, 'job polling limit reached');
          }
          continue;
        }

        const downloadResponse = await fetch(`${baseUrl}/api/v1/jobs/${jobId}/download`);
        if (!downloadResponse.ok) {
          await onEvent?.({
            type: 'failed',
            jobId,
            message: `Local Google Maps scraper-kit download failed with status ${downloadResponse.status}`,
          });
          if (usedProxy && this.options.proxyRotator) {
            this.options.proxyRotator.reportFailure(usedProxy, `download failed ${downloadResponse.status}`);
          }
          continue;
        }

        allItems.push(...toLeadRows(parseCsv(await downloadResponse.text()), maxResults - allItems.length));
        if (usedProxy && this.options.proxyRotator) this.options.proxyRotator.reportSuccess(usedProxy);
      } catch (error) {
        if (usedProxy && this.options.proxyRotator) {
          this.options.proxyRotator.reportFailure(usedProxy, error instanceof Error ? error.message : undefined);
        }
        await onEvent?.({
          type: 'failed',
          message: error instanceof Error ? error.message : 'Local scraper batch failed',
        });
      }
    }

    await onEvent?.({ type: 'completed', itemCount: allItems.length });
    return allItems;
  }
}

export const LocalMapsScraperClient = LocalMapsScraperKitClient;
