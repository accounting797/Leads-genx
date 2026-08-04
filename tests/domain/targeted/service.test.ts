import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TargetedService } from '../../../src/domain/targeted/service';
import { PrismaTargetedStore } from '../../../src/domain/targeted/store';

describe('TargetedService lifecycle', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'leads-genx-targeted-service-'));
  const databaseUrl = `file:${join(tempDir, 'test.db').replace(/\\/g, '/')}`;
  let prisma: PrismaClient;
  let userId: number;

  beforeAll(async () => {
    execFileSync(process.execPath, [join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--skip-generate'], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe',
    });
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    userId = (await prisma.user.create({ data: { username: 'targeted-service', passwordHash: 'test', role: 'ADMIN' } })).id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists aligned and rejected results and exports only strict email', async () => {
    const businesses = [
      {
        title: 'Phoenix Freight Systems', categoryName: 'Freight forwarding service',
        address: 'Phoenix, AZ 85001', email: 'ops@phoenixfreight.example',
        website: 'https://phoenixfreight.example/contact', phone: '602-555-0100',
      },
      {
        title: 'Desert Fashion Outlet', categoryName: 'Clothing store',
        address: 'Las Vegas, NV', email: 'sales@fashion.example', website: 'https://fashion.example',
      },
    ];
    const service = new TargetedService({
      store: new PrismaTargetedStore(prisma),
      localClient: { search: async () => businesses },
      googleClient: { search: async () => [] },
      emailExtractor: { extract: async () => [] },
      mxResolver: { resolveMx: async () => [{ exchange: 'mx.acme.example', priority: 0 }] },
    });
    const draft = await service.createDraft(userId, {
      prompt: 'Public freight and logistics company contacts in Phoenix', mode: 'office', country: 'US',
      keywords: ['freight'], industries: ['logistics'], companyTypes: [], roles: [], seniorities: [],
      visibleProviders: [], infrastructureProviders: [], bankIds: [], areaCodes: ['602'], states: ['AZ'],
      cities: ['Phoenix'], postalCodes: ['85001'], radiusMiles: 25, maxContactsPerCompany: 50,
      maxResults: 20, googleRequestBudget: 3,
    });
    await service.plan(draft.id);
    await service.start(draft.id, { googleApiKey: 'test-key', background: false });
    expect((await service.get(draft.id))?.status).toBe('completed');
    expect(await service.strictEmails(draft.id)).toEqual(['ops@phoenixfreight.example']);
    expect(await service.listCandidates(draft.id, { tier: 'rejected' })).toEqual([
      expect.objectContaining({ email: 'sales@fashion.example', relevanceReason: 'target_mismatch' }),
    ]);
    expect((await service.get(draft.id))?.funnel).toMatchObject({ discovered: 2, strict: 1, rejected: 1 });
  });

  it('stops safely at a work-unit boundary', async () => {
    const service = new TargetedService({ store: new PrismaTargetedStore(prisma) });
    const draft = await service.createDraft(userId, {
      prompt: 'Public business contacts', mode: 'office', country: 'US',
      areaCodes: ['602'], states: ['AZ'], cities: ['Phoenix'], postalCodes: ['85001'],
    });
    await service.plan(draft.id);
    await service.stop(draft.id);
    expect((await service.get(draft.id))?.status).toBe('cancelled');
  });

  it('keeps an in-flight work unit cancelled when its connector finishes after stop', async () => {
    let releaseSearch!: (rows: unknown[]) => void;
    let announceSearch!: () => void;
    const searchStarted = new Promise<void>((resolve) => { announceSearch = resolve; });
    const service = new TargetedService({
      store: new PrismaTargetedStore(prisma),
      localClient: { search: async () => new Promise<unknown[]>((resolve) => {
        releaseSearch = resolve;
        announceSearch();
      }) },
    });
    const draft = await service.createDraft(userId, {
      prompt: 'Public aerospace contacts in Reno', mode: 'office', country: 'US', keywords: ['aerospace-stop-test'],
      areaCodes: ['775'], states: ['NV'], cities: ['Reno'], postalCodes: ['89501'], maxResults: 25,
    });
    await service.plan(draft.id);
    const execution = service.start(draft.id, { background: false });
    await searchStarted;
    await service.stop(draft.id);
    releaseSearch([]);
    await execution;

    expect((await service.get(draft.id))?.status).toBe('cancelled');
    expect((await service.workUnits(draft.id)).find((unit) => unit.documentType === 'html')?.status).toBe('cancelled');
  });

  it('scores bank results against the resolved work-unit market', async () => {
    const service = new TargetedService({
      store: new PrismaTargetedStore(prisma),
      bankMarketsClient: { markets: async () => [{
        bankName: 'JPMorgan Chase Bank', city: 'Tucson', state: 'AZ',
        postalCodes: ['85701'], areaCodes: ['520'], branchCount: 20,
      }] } as never,
      localClient: { search: async () => [{
        title: 'Las Vegas Freight Systems', categoryName: 'Freight forwarding service',
        address: 'Las Vegas, NV 89101', email: 'ops@vegasfreight.example',
        website: 'https://vegasfreight.example/contact', phone: '702-555-0100',
      }] },
      emailExtractor: { extract: async () => [] },
      mxResolver: { resolveMx: async () => [{ exchange: 'mx.example', priority: 0 }] },
    });
    const draft = await service.createDraft(userId, {
      prompt: 'Public freight contacts near Chase branches', mode: 'bank', country: 'US',
      bankIds: ['chase'], keywords: ['freight'], maxResults: 20,
    });
    await service.plan(draft.id);
    await service.start(draft.id, { background: false });
    expect(await service.strictEmails(draft.id)).toEqual([]);
    expect(await service.listCandidates(draft.id, { tier: 'rejected' })).toEqual([
      expect.objectContaining({ email: 'ops@vegasfreight.example', relevanceReason: 'target_mismatch' }),
    ]);
  });

  it('fails bank planning instead of creating an unrestricted worldwide query', async () => {
    const service = new TargetedService({
      store: new PrismaTargetedStore(prisma),
      bankMarketsClient: { markets: async () => [] } as never,
    });
    const draft = await service.createDraft(userId, {
      prompt: 'Public logistics contacts near Chase branches', mode: 'bank', country: 'US', bankIds: ['chase'],
    });
    await expect(service.plan(draft.id)).rejects.toThrow(/no.*bank markets.*resolved/i);
    expect(await service.workUnits(draft.id)).toEqual([]);
  });

  it('automatically resolves and persists Canadian bank markets', async () => {
    const service = new TargetedService({
      store: new PrismaTargetedStore(prisma),
      canadianBankMarketsClient: { markets: async () => [{
        bankName: 'RBC Royal Bank', city: 'Toronto', state: 'ON', postalCodes: ['M5H 2N2'],
        areaCodes: ['416', '647'], branchCount: 30,
      }] } as never,
    });
    const draft = await service.createDraft(userId, {
      prompt: 'Public aviation contacts near RBC branches', mode: 'bank', country: 'CA', bankIds: ['rbc_canada'],
    });
    const planned = await service.plan(draft.id);
    expect(planned.filters).toMatchObject({
      country: 'CA', cities: ['Toronto'], states: ['ON'], postalCodes: ['M5H 2N2'], areaCodes: ['416'],
    });
    expect((await service.workUnits(draft.id))[0].geography).toMatchObject({
      country: 'CA', city: 'Toronto', state: 'ON', postalCode: 'M5H 2N2', areaCode: '416',
    });
  });

  it('accepts a public Gmail address explicitly published in a targeted business listing', async () => {
    const service = new TargetedService({
      store: new PrismaTargetedStore(prisma),
      localClient: { search: async () => [{
        title: 'Phoenix Aviation Services', categoryName: 'Aviation service',
        address: 'Phoenix, AZ 85001', email: 'phoenixaviation@gmail.com',
        website: 'https://phoenixaviation.example', phone: '602-555-0100',
      }] },
      emailExtractor: { extract: async () => [] },
      mxResolver: { resolveMx: async () => [{ exchange: 'gmail-smtp-in.l.google.com', priority: 5 }] },
    });
    const draft = await service.createDraft(userId, {
      prompt: 'Public aviation contacts in Phoenix', mode: 'google', country: 'US',
      keywords: ['aviation'], areaCodes: ['602'], states: ['AZ'], cities: ['Phoenix'], postalCodes: ['85001'],
    });
    await service.plan(draft.id);
    await service.start(draft.id, { background: false });
    expect(await service.strictEmails(draft.id)).toEqual(['phoenixaviation@gmail.com']);
  });

  it('executes a document work unit and stores row-level public contact provenance', async () => {
    const csvRows = Array.from({ length: 25 }, (_, index) => `Phoenix Aviation bulkcsv Services,"Phoenix, AZ 85001",owner${index}@gmail.com`).join('\n');
    const service = new TargetedService({
      store: new PrismaTargetedStore(prisma),
      localClient: { search: async () => [] },
      webSearchClient: { search: async (query: string) => query.includes('filetype:csv') && query.includes('email contact directory') ? ['https://records.example/phoenix-aviation.csv'] : [] },
      artifactFetcher: async (url: string) => ({
        finalUrl: url, contentType: 'text/csv',
        body: Buffer.from(`Company,Location,Email\n${csvRows}\n`),
        byteCount: Buffer.byteLength(csvRows),
      }),
      mxResolver: { resolveMx: async () => [{ exchange: 'gmail-smtp-in.l.google.com', priority: 5 }] },
    });
    const draft = await service.createDraft(userId, {
      prompt: 'Public aviation bulkcsv contacts in Phoenix', mode: 'google', country: 'US',
      keywords: ['aviation', 'bulkcsv'],
      areaCodes: ['602'], states: ['AZ'], cities: ['Phoenix'], postalCodes: ['85001'],
      googleRequestBudget: 10,
    });
    await service.plan(draft.id);
    await service.start(draft.id, { background: false });
    expect(await service.strictEmails(draft.id)).toHaveLength(25);
    const candidate = await prisma.targetedCandidate.findFirstOrThrow({ where: { campaignId: draft.id, normalizedEmail: 'owner0@gmail.com' } });
    const evidence = await prisma.targetedEvidence.findFirstOrThrow({ where: { candidateId: candidate.id } });
    expect(JSON.parse(evidence.fieldsJson ?? '{}')).toMatchObject({ documentType: 'csv', row: 2 });
    const csvUnit = await prisma.targetedWorkUnit.findFirstOrThrow({ where: { campaignId: draft.id, documentType: 'csv' } });
    expect(JSON.parse(csvUnit.checkpointJson ?? '{}')).toMatchObject({ adaptiveMetric: { strict: 25, unique: 25 } });
  });

  it('extracts contacts from public documents linked by a targeted business website', async () => {
    const service = new TargetedService({
      store: new PrismaTargetedStore(prisma),
      localClient: { search: async () => [{
        title: 'Phoenix Aviation linkeddoc Directory', categoryName: 'Aviation service', address: 'Phoenix, AZ 85001',
        website: 'https://aviation.example', phone: '602-555-0100',
      }] },
      artifactFetcher: async (url: string) => url.endsWith('.csv') ? {
        finalUrl: url, contentType: 'text/csv', body: Buffer.from('Company,Location,Email\nPhoenix Aviation,"Phoenix, AZ 85001",dispatch@yahoo.com\n'), byteCount: 84,
      } : {
        finalUrl: url, contentType: 'text/html', body: Buffer.from('<a href="/public/contacts.csv">Public contacts</a>'), byteCount: 49,
      },
      emailExtractor: { extract: async () => [] },
      mxResolver: { resolveMx: async () => [{ exchange: 'mx1.mail.yahoo.com', priority: 1 }] },
    });
    const draft = await service.createDraft(userId, {
      prompt: 'Public aviation linkeddoc contacts in Phoenix', mode: 'other', country: 'US',
      keywords: ['aviation', 'linkeddoc'],
      areaCodes: ['602'], states: ['AZ'], cities: ['Phoenix'], postalCodes: ['85001'], googleRequestBudget: 0,
    });
    await service.plan(draft.id);
    await service.start(draft.id, { background: false });
    expect(await service.strictEmails(draft.id)).toEqual(['dispatch@yahoo.com']);
  });
});
