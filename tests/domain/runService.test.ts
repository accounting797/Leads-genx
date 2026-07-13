import { describe, expect, it } from 'vitest';
import { createRunService, RunStore } from '../../src/domain/runService';
import { ActorClient } from '../../src/integrations/actorClient';
import { NormalizedLead } from '../../src/domain/types';
import { GooglePlacesClient } from '../../src/integrations/googlePlacesClient';
import { EmailExtractor } from '../../src/domain/emailExtractor';
import { LocalMapsScraperClient } from '../../src/integrations/localMapsScraperClient';

function createStore(): RunStore & {
  runs: Array<Record<string, any>>;
  events: Array<Record<string, any>>;
  leads: NormalizedLead[];
  errors: Array<Record<string, any>>;
  operations: string[];
} {
  return {
    runs: [],
    events: [],
    leads: [],
    errors: [],
    operations: [],
    async createRun(data) {
      const run = { id: this.runs.length + 1, ...data };
      this.runs.push(run);
      this.operations.push('createRun');
      return run;
    },
    async updateRun(id, data) {
      const run = this.runs.find((item) => item.id === id);
      Object.assign(run!, data);
      this.operations.push(data.status ? `updateRun:${data.status}` : 'updateRun');
      return run!;
    },
    async addEvent(runId, type, message, metadata) {
      this.events.push({ runId, type, message, metadata });
      this.operations.push(`addEvent:${type}`);
    },
    async addLeads(_runId, leads) {
      this.leads.push(...leads);
      this.operations.push(`addLeads:${leads.length}`);
    },
    async addErrorLog(error) {
      this.errors.push(error);
      this.operations.push('addErrorLog');
    },
  };
}

describe('createRunService', () => {
  it('records a completed Google Maps run with email-only enriched leads', async () => {
    const store = createStore();
    let datasetToken: string | undefined;
    const actorClient: ActorClient = {
      async startRun() {
        return { runId: 'apify-run-1', status: 'SUCCEEDED', datasetId: 'dataset-1' };
      },
      async getRun() {
        return { runId: 'apify-run-1', status: 'SUCCEEDED', datasetId: 'dataset-1' };
      },
      async getDatasetItems(_datasetId, token) {
        datasetToken = token;
        return [
          {
            title: 'Austin Dental Co',
            categoryName: 'Dental clinic',
            phone: '(512) 555-0100',
            website: 'https://dental.example.com',
          },
          { title: 'South Austin Smiles', categoryName: 'Dentist', phone: '(512) 555-0101' },
        ];
      },
    };
    const emailExtractor: EmailExtractor = {
      async extract(url) {
        return url === 'https://dental.example.com'
          ? ['sales@dental.example.com', 'ops@dental.example.com']
          : [];
      },
    };

    const service = createRunService({ store, actorClient, emailExtractor });
    const run = await service.startRun(
      {
        apifyToken: 'token',
        leadSource: 'google_maps',
        maxResults: 100,
        googleMaps: { searchTerms: ['dentist'], locationQuery: 'Austin, TX' },
      },
      { background: false }
    );

    expect(run.status).toBe('queued');
    expect(store.runs[0]).toMatchObject({
      status: 'completed',
      leadSource: 'google_maps',
      apifyRunId: 'apify-run-1',
      datasetId: 'dataset-1',
      leadCount: 2,
    });
    expect(store.events.map((event) => event.type)).toEqual([
      'run_queued',
      'run_started',
      'apify_shard_started',
      'actor_succeeded',
      'source_results',
      'leads_saved',
      'run_completed',
    ]);
    expect(store.leads.map((lead) => lead.email)).toEqual([
      'sales@dental.example.com',
      'ops@dental.example.com',
    ]);
    expect(datasetToken).toBe('token');
  });

  it('records failed runs with redacted error logs', async () => {
    const store = createStore();
    const actorClient: ActorClient = {
      async startRun() {
        throw new Error('actor failed with Bearer super-secret-token-value');
      },
      async getRun() {
        throw new Error('not used');
      },
      async getDatasetItems() {
        return [];
      },
    };

    const service = createRunService({ store, actorClient });
    await service.startRun(
      {
        apifyToken: 'token',
        leadSource: 'google_maps',
        maxResults: 100,
        googleMaps: { searchTerms: ['dentist'], locationQuery: 'Austin, TX' },
      },
      { background: false }
    );

    expect(store.runs[0].status).toBe('failed');
    expect(store.runs[0].errorMessage).toBe('actor failed with [REDACTED]');
    expect(store.errors[0].message).toBe('actor failed with [REDACTED]');
    expect(JSON.stringify(store.errors[0])).not.toContain('super-secret-token-value');
    expect(store.events.at(-1)).toMatchObject({ type: 'run_failed' });
  });

  it('routes Google Places runs through the Google Places client without Apify', async () => {
    const store = createStore();
    let actorCalled = false;
    let placesApiKey: string | undefined;
    const actorClient: ActorClient = {
      async startRun() {
        actorCalled = true;
        throw new Error('Apify should not run for Google Places');
      },
      async getRun() {
        throw new Error('not used');
      },
      async getDatasetItems() {
        return [];
      },
    };
    const googlePlacesClient: GooglePlacesClient = {
      async search(input) {
        placesApiKey = input.apiKey;
        return [
          {
            displayName: { text: 'Permian Aviation Services' },
            primaryTypeDisplayName: { text: 'Aviation' },
            formattedAddress: '100 Airport Rd, Midland, TX',
            nationalPhoneNumber: '(432) 555-0100',
            websiteUri: 'https://example.com',
            rating: 4.8,
            userRatingCount: 42,
            googleMapsUri: 'https://maps.google.com/?cid=places',
          },
        ];
      },
    };
    const emailExtractor: EmailExtractor = {
      async extract() {
        return ['contact@permian.example.com'];
      },
    };

    const service = createRunService({ store, actorClient, googlePlacesClient, emailExtractor });
    await service.startRun(
      {
        googleApiKey: 'google-secret-key',
        leadSource: 'google_maps',
        maxResults: 40,
        googleMaps: {
          provider: 'google_places',
          searchTerms: ['aviation maintenance'],
          locations: ['Midland, TX'],
        },
      },
      { background: false }
    );

    expect(actorCalled).toBe(false);
    expect(placesApiKey).toBe('google-secret-key');
    expect(store.runs[0]).toMatchObject({
      status: 'completed',
      actorId: 'google_places',
      datasetId: 'google_places',
      leadCount: 1,
    });
    expect(store.leads[0]).toMatchObject({
      leadType: 'business',
      companyName: 'Permian Aviation Services',
      categoryName: 'Aviation',
      phone: '(432) 555-0100',
      email: 'contact@permian.example.com',
    });
  });

  it('persists email leads in batches before marking the run completed', async () => {
    const store = createStore();
    const actorClient: ActorClient = {
      async startRun() {
        return { runId: 'apify-run-2', status: 'SUCCEEDED', datasetId: 'dataset-2' };
      },
      async getRun() {
        return { runId: 'apify-run-2', status: 'SUCCEEDED', datasetId: 'dataset-2' };
      },
      async getDatasetItems() {
        return [
          { title: 'Alpha Energy', website: 'https://alpha.example.com' },
          { title: 'Beta Aviation', website: 'https://beta.example.com' },
        ];
      },
    };
    const emailExtractor: EmailExtractor = {
      async extract(url) {
        return url.includes('alpha') ? ['sales@alpha.example.com'] : ['ops@beta.example.com'];
      },
    };

    const service = createRunService({
      store,
      actorClient,
      emailExtractor,
      emailLeadBatchSize: 1,
    } as Parameters<typeof createRunService>[0] & { emailLeadBatchSize: number });

    await service.startRun(
      {
        apifyToken: 'token',
        leadSource: 'google_maps',
        maxResults: 2,
        googleMaps: { searchTerms: ['energy'], locationQuery: 'Houston, TX' },
      },
      { background: false }
    );

    expect(store.leads.map((lead) => lead.email)).toEqual([
      'sales@alpha.example.com',
      'ops@beta.example.com',
    ]);
    expect(store.operations).toContain('addLeads:1');
    expect(store.operations.filter((operation) => operation === 'addLeads:1')).toHaveLength(2);
    expect(store.operations.indexOf('addLeads:1')).toBeLessThan(
      store.operations.indexOf('updateRun:completed')
    );
    expect(store.runs[0].leadCount).toBe(2);
  });

  it('scans large website batches with higher bounded concurrency', async () => {
    const store = createStore();
    const sourceLeads = Array.from({ length: 80 }, (_, index) => ({
      title: `High Output ${index}`,
      website: `https://high-output-${index}.example.com`,
    }));
    const actorClient: ActorClient = {
      async startRun() {
        return { runId: 'apify-run-high-output', status: 'SUCCEEDED', datasetId: 'dataset-high-output' };
      },
      async getRun() {
        return { runId: 'apify-run-high-output', status: 'SUCCEEDED', datasetId: 'dataset-high-output' };
      },
      async getDatasetItems() {
        return sourceLeads;
      },
    };
    let active = 0;
    let maxActive = 0;
    const emailExtractor: EmailExtractor = {
      async extract(url) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        const id = url.match(/high-output-(\d+)/)?.[1] ?? '0';
        return [`lead-${id}@example.com`];
      },
    };

    const service = createRunService({
      store,
      actorClient,
      emailExtractor,
      emailLeadBatchSize: 100,
      emailExtractionConcurrency: 50,
    });
    await service.startRun(
      {
        apifyToken: 'token',
        leadSource: 'google_maps',
        maxResults: 5000,
        googleMaps: { searchTerms: ['industrial services'], locations: ['Houston, TX'] },
      },
      { background: false }
    );

    expect(maxActive).toBe(50);
    expect(store.runs[0]).toMatchObject({ status: 'completed', leadCount: 80 });
    expect(store.events).toContainEqual(
      expect.objectContaining({
        type: 'email_scan_started',
        metadata: expect.objectContaining({ batchSize: 80, concurrency: 50 }),
      })
    );
  });

  it('records source diagnostics when a Google Places run finds businesses but no emails', async () => {
    const store = createStore();
    const actorClient: ActorClient = {
      async startRun() {
        throw new Error('Apify should not run for Google Places');
      },
      async getRun() {
        throw new Error('not used');
      },
      async getDatasetItems() {
        return [];
      },
    };
    const googlePlacesClient: GooglePlacesClient = {
      async search() {
        return [
          { displayName: { text: 'No Website Energy' } },
          { displayName: { text: 'Quiet Aviation' }, websiteUri: 'https://quiet.example.com' },
        ];
      },
    };
    const emailExtractor: EmailExtractor = {
      async extract() {
        return [];
      },
    };

    const service = createRunService({ store, actorClient, googlePlacesClient, emailExtractor });
    await service.startRun(
      {
        googleApiKey: 'google-secret-key',
        leadSource: 'google_maps',
        maxResults: 10,
        googleMaps: {
          provider: 'google_places',
          searchTerms: ['oilfield services'],
          locations: ['Houston, TX'],
        },
      },
      { background: false }
    );

    expect(store.events).toContainEqual(
      expect.objectContaining({
        type: 'source_results',
        message: 'Google Places returned 2 businesses; 1 had websites to scan.',
        metadata: expect.objectContaining({ itemCount: 2, websiteCount: 1 }),
      })
    );
    expect(store.events).toContainEqual(
      expect.objectContaining({
        type: 'leads_saved',
        message: 'Saved 0 email leads.',
        metadata: { leadCount: 0 },
      })
    );
  });

  it('runs hybrid Google Maps sessions across Apify and Google credentials', async () => {
    const store = createStore();
    const apifyTokens: string[] = [];
    const actorClient: ActorClient = {
      async startRun(input) {
        apifyTokens.push(input.token);
        return {
          runId: `apify-run-${apifyTokens.length}`,
          status: 'SUCCEEDED',
          datasetId: `dataset-${apifyTokens.length}`,
        };
      },
      async getRun() {
        throw new Error('not used');
      },
      async getDatasetItems(datasetId) {
        return [
          {
            title: `Apify ${datasetId}`,
            website: `https://${datasetId}.example.com`,
          },
        ];
      },
    };
    let googleApiKeys: string[] | undefined;
    const googlePlacesClient: GooglePlacesClient = {
      async search(input) {
        googleApiKeys = input.apiKeys;
        return [
          {
            displayName: { text: 'Google Energy' },
            websiteUri: 'https://google.example.com',
          },
        ];
      },
    };
    const emailExtractor: EmailExtractor = {
      async extract(url) {
        if (url.includes('dataset-1')) return ['shared@example.com'];
        if (url.includes('dataset-2')) return ['apify-two@example.com'];
        return ['shared@example.com', 'google@example.com'];
      },
    };

    const service = createRunService({
      store,
      actorClient,
      googlePlacesClient,
      emailExtractor,
      emailLeadBatchSize: 1,
    });
    await service.startRun(
      {
        apifyToken: 'apify-one',
        apifyTokens: ['apify-one', 'apify-two'],
        googleApiKey: 'google-one',
        googleApiKeys: ['google-one', 'google-two'],
        leadSource: 'google_maps',
        maxResults: 1000,
        googleMaps: {
          provider: 'hybrid',
          searchTerms: ['oilfield services'],
          locations: ['Houston, TX', 'Tulsa, OK'],
        },
      },
      { background: false }
    );

    expect(apifyTokens).toEqual(['apify-one', 'apify-two']);
    expect(googleApiKeys).toEqual(['google-one', 'google-two']);
    expect(store.leads.map((lead) => lead.email)).toEqual([
      'shared@example.com',
      'apify-two@example.com',
      'google@example.com',
    ]);
    expect(store.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['apify_shard_started', 'google_places_started'])
    );
    expect(store.runs[0]).toMatchObject({ status: 'completed', leadCount: 3 });
  });

  it('continues hybrid runs when one Apify credential is invalid', async () => {
    const store = createStore();
    const apifyTokens: string[] = [];
    const actorClient: ActorClient = {
      async startRun(input) {
        apifyTokens.push(input.token);
        if (input.token === 'bad-apify') {
          throw new Error('User was not found or authentication token is not valid');
        }
        return {
          runId: 'apify-run-good',
          status: 'SUCCEEDED',
          datasetId: 'dataset-good',
        };
      },
      async getRun() {
        throw new Error('not used');
      },
      async getDatasetItems() {
        return [{ title: 'Good Apify Lead', website: 'https://apify-good.example.com' }];
      },
    };
    const googlePlacesClient: GooglePlacesClient = {
      async search() {
        return [{ displayName: { text: 'Good Google Lead' }, websiteUri: 'https://google-good.example.com' }];
      },
    };
    const emailExtractor: EmailExtractor = {
      async extract(url) {
        return url.includes('apify-good') ? ['apify-good@example.com'] : ['google-good@example.com'];
      },
    };

    const service = createRunService({ store, actorClient, googlePlacesClient, emailExtractor });
    await service.startRun(
      {
        apifyToken: 'bad-apify',
        apifyTokens: ['bad-apify', 'good-apify'],
        googleApiKey: 'google-one',
        googleApiKeys: ['google-one'],
        leadSource: 'google_maps',
        maxResults: 1000,
        googleMaps: {
          provider: 'hybrid',
          searchTerms: ['oilfield services'],
          locations: ['Houston, TX'],
        },
      },
      { background: false }
    );

    expect(apifyTokens).toEqual(['bad-apify', 'good-apify']);
    expect(store.runs[0]).toMatchObject({ status: 'completed', leadCount: 2 });
    expect(store.leads.map((lead) => lead.email)).toEqual([
      'apify-good@example.com',
      'google-good@example.com',
    ]);
    expect(store.events).toContainEqual(
      expect.objectContaining({
        type: 'apify_shard_failed',
        metadata: expect.objectContaining({ shard: 1, shardCount: 2 }),
      })
    );
    expect(JSON.stringify(store.events)).not.toContain('bad-apify');
  });

  it('completes hybrid runs with Apify email leads when Google Places fails', async () => {
    const store = createStore();
    const actorClient: ActorClient = {
      async startRun() {
        return {
          runId: 'apify-run-good',
          status: 'SUCCEEDED',
          datasetId: 'dataset-good',
        };
      },
      async getRun() {
        throw new Error('not used');
      },
      async getDatasetItems() {
        return [{ title: 'Reliable Apify Lead', website: 'https://reliable-apify.example.com' }];
      },
    };
    const googlePlacesClient: GooglePlacesClient = {
      async search() {
        throw new Error('fetch failed');
      },
    };
    const emailExtractor: EmailExtractor = {
      async extract() {
        return ['reliable@example.com'];
      },
    };

    const service = createRunService({ store, actorClient, googlePlacesClient, emailExtractor });
    await service.startRun(
      {
        apifyToken: 'apify-good',
        googleApiKey: 'google-one',
        leadSource: 'google_maps',
        maxResults: 1000,
        googleMaps: {
          provider: 'hybrid',
          searchTerms: ['oilfield services'],
          locations: ['Houston, TX'],
        },
      },
      { background: false }
    );

    expect(store.runs[0]).toMatchObject({ status: 'completed', leadCount: 1 });
    expect(store.leads.map((lead) => lead.email)).toEqual(['reliable@example.com']);
    expect(store.events).toContainEqual(
      expect.objectContaining({
        type: 'google_places_failed',
        message: 'Google Places failed: fetch failed',
      })
    );
    expect(store.errors).toContainEqual(
      expect.objectContaining({
        severity: 'warn',
        message: 'fetch failed',
      })
    );
  });

  it('records Google Places shard progress for Google-only runs', async () => {
    const store = createStore();
    const actorClient: ActorClient = {
      async startRun() {
        throw new Error('Apify should not run for Google Places');
      },
      async getRun() {
        throw new Error('not used');
      },
      async getDatasetItems() {
        return [];
      },
    };
    const googlePlacesClient: GooglePlacesClient = {
      async search(input) {
        await input.onShardEvent?.({
          type: 'started',
          shard: 1,
          shardCount: 2,
          query: 'oilfield services Houston, TX',
        });
        await input.onShardEvent?.({
          type: 'completed',
          shard: 1,
          shardCount: 2,
          query: 'oilfield services Houston, TX',
          itemCount: 2,
          totalItemCount: 2,
        });
        await input.onShardEvent?.({
          type: 'failed',
          shard: 2,
          shardCount: 2,
          query: 'Oil & Gas Houston, TX',
          errorMessage: 'Google Places request failed with status 429',
        });
        return [{ displayName: { text: 'Gulf Energy' }, websiteUri: 'https://gulf.example.com' }];
      },
    };
    const emailExtractor: EmailExtractor = {
      async extract() {
        return ['sales@gulf.example.com'];
      },
    };

    const service = createRunService({ store, actorClient, googlePlacesClient, emailExtractor });
    await service.startRun(
      {
        googleApiKey: 'google-one',
        leadSource: 'google_maps',
        maxResults: 1000,
        googleMaps: {
          provider: 'google_places',
          searchTerms: ['oilfield services'],
          locations: ['Houston, TX'],
        },
      },
      { background: false }
    );

    expect(store.events).toContainEqual(expect.objectContaining({ type: 'google_places_shard_started' }));
    expect(store.events).toContainEqual(expect.objectContaining({ type: 'google_places_shard_completed' }));
    expect(store.events).toContainEqual(expect.objectContaining({ type: 'google_places_shard_failed' }));
    expect(store.runs[0]).toMatchObject({ status: 'completed', leadCount: 1 });
  });

  it('supplements Google-only runs with local scraper-kit results when available', async () => {
    const store = createStore();
    const actorClient: ActorClient = {
      async startRun() {
        throw new Error('Apify should not run for Google Places');
      },
      async getRun() {
        throw new Error('not used');
      },
      async getDatasetItems() {
        return [];
      },
    };
    const googlePlacesClient: GooglePlacesClient = {
      async search() {
        return [{ displayName: { text: 'Google API Lead' }, websiteUri: 'https://google-api.example.com' }];
      },
    };
    const localMapsScraperClient: LocalMapsScraperClient = {
      async search(input) {
        await input.onEvent?.({ type: 'started', jobId: 'local-job-1' });
        await input.onEvent?.({ type: 'completed', jobId: 'local-job-1', itemCount: 1 });
        return [{ title: 'Local Scraper Lead', website: 'https://local-scraper.example.com', email: 'local@example.com' }];
      },
    };
    const emailExtractor: EmailExtractor = {
      async extract(url) {
        return url.includes('google-api') ? ['google@example.com'] : [];
      },
    };

    const service = createRunService({
      store,
      actorClient,
      googlePlacesClient,
      localMapsScraperClient,
      emailExtractor,
    });
    await service.startRun(
      {
        googleApiKey: 'google-one',
        leadSource: 'google_maps',
        maxResults: 1000,
        googleMaps: {
          provider: 'google_places',
          searchTerms: ['oilfield services'],
          locations: ['Houston, TX'],
        },
      },
      { background: false }
    );

    expect(store.leads.map((lead) => lead.email)).toEqual(['google@example.com', 'local@example.com']);
    expect(store.events).toContainEqual(expect.objectContaining({ type: 'local_maps_scraper_started' }));
    expect(store.events).toContainEqual(expect.objectContaining({ type: 'local_maps_scraper_completed' }));
    expect(store.runs[0]).toMatchObject({ status: 'completed', leadCount: 2 });
  });
});
