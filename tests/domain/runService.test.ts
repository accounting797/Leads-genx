import { describe, expect, it } from 'vitest';
import { createRunService, RunStore } from '../../src/domain/runService';
import { ActorClient } from '../../src/integrations/actorClient';
import { NormalizedLead } from '../../src/domain/types';
import { GooglePlacesClient } from '../../src/integrations/googlePlacesClient';
import { EmailExtractor } from '../../src/domain/emailExtractor';

function createStore(): RunStore & {
  runs: Array<Record<string, any>>;
  events: Array<Record<string, any>>;
  leads: NormalizedLead[];
  errors: Array<Record<string, any>>;
} {
  return {
    runs: [],
    events: [],
    leads: [],
    errors: [],
    async createRun(data) {
      const run = { id: this.runs.length + 1, ...data };
      this.runs.push(run);
      return run;
    },
    async updateRun(id, data) {
      const run = this.runs.find((item) => item.id === id);
      Object.assign(run!, data);
      return run!;
    },
    async addEvent(runId, type, message, metadata) {
      this.events.push({ runId, type, message, metadata });
    },
    async addLeads(_runId, leads) {
      this.leads.push(...leads);
    },
    async addErrorLog(error) {
      this.errors.push(error);
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
      'actor_succeeded',
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
});
