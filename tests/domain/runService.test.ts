import { describe, expect, it } from 'vitest';
import { createRunService, RunStore } from '../../src/domain/runService';
import { ActorClient } from '../../src/integrations/actorClient';
import { NormalizedLead } from '../../src/domain/types';

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
  it('records a completed Google Maps run with events and normalized leads', async () => {
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
          { title: 'Austin Dental Co', categoryName: 'Dental clinic', phone: '(512) 555-0100' },
          { title: 'South Austin Smiles', categoryName: 'Dentist', phone: '(512) 555-0101' },
        ];
      },
    };

    const service = createRunService({ store, actorClient });
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
    expect(store.leads[0]).toMatchObject({
      leadType: 'business',
      companyName: 'Austin Dental Co',
    });
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
});
