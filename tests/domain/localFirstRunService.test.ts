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
  const store: LocalFirstRunStore = {
    async createRun() { throw new Error('not used'); },
    async updateRun(_id, data) { Object.assign(run, data); calls.push(`run:${data.status ?? 'metrics'}`); return run; },
    async addEvent(_id, type) { calls.push(`event:${type}`); },
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
  return { store, calls, batches, businesses, leads };
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
});
