import { describe, expect, it } from 'vitest';
import { RunIngestionCoordinator } from '../../src/domain/runIngestionCoordinator';
import type { DiscoveredBusinessRecord, DiscoveredBusinessWrite, LocalFirstRunStore } from '../../src/domain/prismaRunStore';
import type { NormalizedLead } from '../../src/domain/types';

function fakeStore() {
  const businesses: DiscoveredBusinessRecord[] = [];
  const contacts: NormalizedLead[] = [];
  const events: Array<{ type: string; metadata?: unknown }> = [];
  const run: Record<string, unknown> = {};
  const store: LocalFirstRunStore = {
    async createRun() { throw new Error('not used'); },
    async updateRun(_id, data) { Object.assign(run, data); return run as never; },
    async addEvent(_id, type, _message, metadata) { events.push({ type, metadata }); },
    async addLeads() { throw new Error('coordinator must use upsertContact'); },
    async addErrorLog() {},
    async upsertProviderState() {},
    async upsertContact(_id, contact) {
      if (contacts.some((existing) => existing.normalizedEmail === contact.normalizedEmail)) return 'duplicate';
      contacts.push(contact);
      return 'inserted';
    },
    async upsertBatch() { throw new Error('not used'); },
    async listBatches() { return []; },
    async listRunnableBatches() { return []; },
    async upsertBusiness(runId, business: DiscoveredBusinessWrite) {
      const existing = businesses.find((item) => item.identityKey === business.identityKey);
      if (existing) {
        const provenance = [...new Set([...(existing.provenance ?? []), ...(business.provenance ?? [])])];
        Object.assign(existing, business, { provenance });
        return 'merged';
      }
      businesses.push({ id: businesses.length + 1, runId, ...business });
      return 'inserted';
    },
    async listBusinesses() { return businesses; },
    async listRecoverableRuns() { return []; },
    async getRun() { return undefined; },
  };
  return { store, businesses, contacts, events, run };
}

describe('RunIngestionCoordinator', () => {
  it('persists the first finished website contact without waiting for slower scans', async () => {
    const state = fakeStore();
    const gates = new Map<string, () => void>();
    const coordinator = new RunIngestionCoordinator({
      runId: 1,
      target: 100,
      store: state.store,
      websiteConcurrency: 50,
      emailExtractor: {
        async extract(url) {
          await new Promise<void>((resolve) => gates.set(url, resolve));
          return [`sales@${new URL(url).hostname}`];
        },
      },
    });

    await coordinator.ingest(
      [
        { title: 'Fast Co', website: 'https://fast.example.com' },
        { title: 'Slow Co', website: 'https://slow.example.com' },
      ],
      'docker',
      {}
    );

    // Both scans are in flight; release only the fast one.
    while (gates.size < 2) await new Promise((resolve) => setTimeout(resolve, 0));
    gates.get('https://fast.example.com')!();
    while (state.contacts.length < 1) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.contacts.map((contact) => contact.normalizedEmail)).toEqual(['sales@fast.example.com']);
    expect(coordinator.snapshot()).toMatchObject({
      businessCount: 2,
      qualifiedContactCount: 1,
      rawContactCount: 0,
      companiesWithQualifiedEmailCount: 1,
    });

    gates.get('https://slow.example.com')!();
    await coordinator.drain();
    expect(coordinator.snapshot()).toMatchObject({
      businessCount: 2,
      qualifiedContactCount: 2,
      rawContactCount: 0,
      companiesWithQualifiedEmailCount: 2,
    });
    expect(state.events.some((event) => event.type === 'business_persisted')).toBe(true);
    expect(state.events.some((event) => event.type === 'contact_persisted')).toBe(true);
    // Redacted events never carry query text or website payloads.
    expect(JSON.stringify(state.events)).not.toContain('fast.example.com');
  });

  it('classifies junk emails as raw contacts and dedupes repeats', async () => {
    const state = fakeStore();
    const coordinator = new RunIngestionCoordinator({
      runId: 2,
      target: 100,
      store: state.store,
    });

    await coordinator.ingest(
      [
        { title: 'Junk Co', email: 'noreply@junk.example.com' },
        { title: 'Junk Co Duplicate', email: 'noreply@junk.example.com' },
        { title: 'Real Co', email: 'owner@realco.example.com' },
      ],
      'google',
      {}
    );
    await coordinator.drain();

    expect(coordinator.snapshot()).toMatchObject({
      qualifiedContactCount: 1,
      rawContactCount: 1,
    });
    expect(state.contacts).toHaveLength(2);
    expect(state.run.leadCount).toBe(1);
    expect(state.run.rawContactCount).toBe(1);
  });

  it('keeps provider ingestion deduplicated across repeated deliveries', async () => {
    const state = fakeStore();
    const coordinator = new RunIngestionCoordinator({ runId: 3, target: 10, store: state.store });
    const item = { title: 'Same Co', email: 'same@example.com' };

    await coordinator.ingest([item], 'docker', {});
    await coordinator.ingest([item], 'docker', {});
    await coordinator.drain();

    expect(state.businesses).toHaveLength(1);
    expect(state.contacts).toHaveLength(1);
  });
});
