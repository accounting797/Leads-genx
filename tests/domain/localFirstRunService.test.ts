import { describe, expect, it } from 'vitest';
import { executeLocalFirstRun } from '../../src/domain/localFirstRunService';
import { buildLocalDiscoveryBatches } from '../../src/domain/localDiscoveryBatch';
import { DiscoveredBusinessRecord, DiscoveredBusinessWrite, LocalFirstRunStore, RunBatchRecord, RunBatchWrite } from '../../src/domain/prismaRunStore';
import { RunRecord } from '../../src/domain/runService';

function fakeStore(run: RunRecord, seeded: { batches?: RunBatchRecord[]; businesses?: DiscoveredBusinessRecord[] } = {}) {
  const calls: string[] = [];
  const batches = [...(seeded.batches ?? [])];
  const businesses = [...(seeded.businesses ?? [])];
  const leads: unknown[] = [];
  const events: Array<{ type: string; metadata?: unknown }> = [];
  const store: LocalFirstRunStore = {
    async createRun() { throw new Error('not used'); },
    async updateRun(_id, data) { Object.assign(run, data); calls.push(`run:${data.status ?? 'metrics'}`); return run; },
    async addEvent(_id, type, _message, metadata) {
      calls.push(`event:${type}`);
      events.push({ type, metadata });
    },
    async addLeads(_id, incoming) { leads.push(...incoming); calls.push('email:save'); },
    async addErrorLog() {},
    async upsertBatch(runId, batch: RunBatchWrite) {
      calls.push(`batch:${batch.status}`);
      const existing = batches.find((item) => item.batchKey === batch.batchKey);
      if (existing) Object.assign(existing, batch);
      else batches.push({ id: batches.length + 1, runId, attemptCount: 0, resultCount: 0, ...batch });
      return batches.find((item) => item.batchKey === batch.batchKey)!;
    },
    async listBatches() { return batches; },
    async listRunnableBatches() { return batches.filter((batch) => ['pending', 'retry'].includes(batch.status)); },
    async upsertBusiness(runId, business: DiscoveredBusinessWrite) {
      calls.push('business:upsert');
      const existing = businesses.find((item) => item.identityKey === business.identityKey);
      if (existing) { Object.assign(existing, business); return 'merged'; }
      businesses.push({ id: businesses.length + 1, runId, ...business });
      return 'inserted';
    },
    async listBusinesses() { return businesses; },
    async listRecoverableRuns() { return []; },
    async getRun() { return run; },
  };
  return { store, calls, batches, businesses, leads, events };
}

describe('executeLocalFirstRun', () => {
  it('checkpoints local businesses and emails before invoking bounded Google fallback', async () => {
    const run: RunRecord = { id: 1, status: 'queued', leadSource: 'google_maps', actorId: 'local_first', maxResults: 2, leadCount: 0 };
    const state = fakeStore(run);
    const localClient = {
      async search() { return []; },
      async health() { return true; },
      async searchBatch() {
        state.calls.push('local:search');
        return { batchKey: 'one', jobId: 'job-1', rawBusinessCount: 1, items: [{ title: 'Local Co', email: 'local@example.com', website: 'https://local.example.com' }] };
      },
    };
    const googleClient = {
      async search(input: { maxResults: number; requestBudget?: number }) {
        state.calls.push('google:fallback');
        expect(input.maxResults).toBe(1);
        expect(input.requestBudget).toBe(3);
        return [{ id: 'google-1', displayName: { text: 'Google Co' }, email: 'google@example.com' }];
      },
    };

    await executeLocalFirstRun({ store: state.store, localClient, googleClient }, run, {
      leadSource: 'google_maps', maxResults: 2, googleApiKey: 'secret',
      googleMaps: { provider: 'local_first', searchTerms: ['dentist'], locations: ['Austin, TX'], apiRequestBudget: 3 },
    });

    expect(state.calls.indexOf('local:search')).toBeLessThan(state.calls.indexOf('business:upsert'));
    expect(state.calls.indexOf('batch:completed')).toBeLessThan(state.calls.indexOf('google:fallback'));
    expect(state.calls.indexOf('email:save')).toBeLessThan(state.calls.indexOf('google:fallback'));
    expect(run).toMatchObject({ status: 'completed', businessCount: 2, leadCount: 2 });
  });

  it('skips completed checkpoints when execution resumes', async () => {
    const filters = { provider: 'local_first' as const, searchTerms: ['dentist'], locations: ['Austin, TX'], apiRequestBudget: 0 };
    const [planned] = buildLocalDiscoveryBatches(filters, 1);
    const run: RunRecord = { id: 2, status: 'running', leadSource: 'google_maps', actorId: 'local_first', maxResults: 1, leadCount: 0 };
    const state = fakeStore(run, {
      batches: [{ id: 1, runId: 2, batchKey: planned.key, query: planned.query, status: 'completed', attemptCount: 1, resultCount: 1 }],
      businesses: [{ id: 1, runId: 2, identityKey: 'place:done', companyName: 'Done Co', provenance: ['local'] }],
    });
    let localCalls = 0;

    await executeLocalFirstRun({
      store: state.store,
      localClient: { async search() { return []; }, async health() { return true; }, async searchBatch() { localCalls += 1; throw new Error('must not run'); } },
    }, run, { leadSource: 'google_maps', maxResults: 1, googleMaps: filters });

    expect(localCalls).toBe(0);
    expect(run.status).toBe('completed');
  });

  it('hands Docker and Google results to a following Hybrid stage without finalizing early', async () => {
    const run: RunRecord = { id: 3, status: 'queued', leadSource: 'google_maps', actorId: 'hybrid', maxResults: 1, leadCount: 0 };
    const state = fakeStore(run);
    const outcome = await executeLocalFirstRun({
      store: state.store,
      localClient: {
        async search() { return []; }, async health() { return true; },
        async searchBatch() { return { batchKey: 'one', jobId: 'job-3', rawBusinessCount: 1, items: [{ title: 'Local Co', email: 'local@example.com' }] }; },
      },
    }, run, {
      apifyToken: 'secret', googleApiKey: 'google', leadSource: 'google_maps', maxResults: 1,
      googleMaps: { provider: 'hybrid', searchTerms: ['dentist'], locations: ['Austin, TX'], apiRequestBudget: 1 },
    }, { finalize: false });

    expect(outcome).toMatchObject({ status: 'running', leadCount: 1, businessCount: 1 });
    expect(outcome.seenEmails.has('local@example.com')).toBe(true);
    expect(state.calls).not.toContain('event:run_completed');
  });

  it('opens the local circuit after three empty batches and invokes Google fallback', async () => {
    const filters = {
      provider: 'local_first' as const,
      searchTerms: ['one', 'two', 'three', 'four', 'five'],
      locations: ['Austin, TX'],
      apiRequestBudget: 2,
    };
    const run: RunRecord = {
      id: 4, status: 'queued', leadSource: 'google_maps', actorId: 'local_first',
      maxResults: 100, leadCount: 0,
    };
    const state = fakeStore(run);
    let localCalls = 0;
    let googleCalls = 0;

    await executeLocalFirstRun({
      store: state.store,
      localClient: {
        async search() { return []; },
        async health() { return true; },
        async searchBatch({ batch }) {
          localCalls += 1;
          return { batchKey: batch.key, jobId: `empty-${localCalls}`, rawBusinessCount: 0, items: [] };
        },
      },
      googleClient: {
        async search() {
          googleCalls += 1;
          return [{ id: 'google-fallback', displayName: { text: 'Fallback Co' } }];
        },
      },
    }, run, {
      leadSource: 'google_maps', maxResults: 100, googleApiKey: 'request-scoped-secret', googleMaps: filters,
    });

    expect(localCalls).toBe(3);
    expect(googleCalls).toBe(1);
    expect(state.batches.filter((batch) => batch.status === 'skipped_empty_circuit')).toHaveLength(2);
    expect(state.events).toContainEqual({
      type: 'local_empty_circuit_opened',
      metadata: { threshold: 3, skippedBatchCount: 2 },
    });
    expect(JSON.stringify(state.events)).not.toContain('request-scoped-secret');
    expect(run).toMatchObject({ status: 'completed', businessCount: 1 });
  });

  it('resets the empty counter after a non-empty local batch', async () => {
    const filters = {
      provider: 'local_first' as const,
      searchTerms: ['one', 'two', 'three', 'four', 'five', 'six', 'seven'],
      locations: ['Austin, TX'],
      apiRequestBudget: 0,
    };
    const run: RunRecord = {
      id: 5, status: 'queued', leadSource: 'google_maps', actorId: 'local_first',
      maxResults: 100, leadCount: 0,
    };
    const state = fakeStore(run);
    const rawCounts = [0, 0, 1, 0, 0, 0];
    let localCalls = 0;

    await executeLocalFirstRun({
      store: state.store,
      localClient: {
        async search() { return []; },
        async health() { return true; },
        async searchBatch({ batch }) {
          const rawBusinessCount = rawCounts[localCalls] ?? 0;
          localCalls += 1;
          return {
            batchKey: batch.key,
            jobId: `local-${localCalls}`,
            rawBusinessCount,
            items: rawBusinessCount ? [{ title: 'Recovered Local Co' }] : [],
          };
        },
      },
    }, run, { leadSource: 'google_maps', maxResults: 100, googleMaps: filters });

    expect(localCalls).toBe(6);
    expect(state.businesses).toHaveLength(1);
    expect(state.batches.filter((batch) => batch.status === 'skipped_empty_circuit')).toHaveLength(1);
    expect(run.status).toBe('completed');
  });

  it('waits for secure Google credentials after opening the local circuit on recovery', async () => {
    const filters = {
      provider: 'local_first' as const,
      searchTerms: ['one', 'two', 'three', 'four'],
      locations: ['Austin, TX'],
      apiRequestBudget: 2,
    };
    const run: RunRecord = {
      id: 6, status: 'running', leadSource: 'google_maps', actorId: 'local_first',
      maxResults: 100, leadCount: 0,
    };
    const state = fakeStore(run);

    await executeLocalFirstRun({
      store: state.store,
      localClient: {
        async search() { return []; },
        async health() { return true; },
        async searchBatch({ batch }) {
          return { batchKey: batch.key, jobId: 'empty', rawBusinessCount: 0, items: [] };
        },
      },
    }, run, { leadSource: 'google_maps', maxResults: 100, googleMaps: filters });

    expect(run.status).toBe('waiting_for_credentials');
    expect(state.batches.filter((batch) => batch.status === 'skipped_empty_circuit')).toHaveLength(1);
  });
});
