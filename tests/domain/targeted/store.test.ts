import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaTargetedStore } from '../../../src/domain/targeted/store';
import { TargetedDraftInput } from '../../../src/domain/targeted/types';
import { planTargetedQueries } from '../../../src/domain/targeted/queryPlanner';

describe('PrismaTargetedStore', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'leads-genx-targeted-store-'));
  const databaseUrl = `file:${join(tempDir, 'test.db').replace(/\\/g, '/')}`;
  let prisma: PrismaClient;
  let userId: number;

  beforeAll(async () => {
    execFileSync(process.execPath, [join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--skip-generate'], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe',
    });
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    userId = (await prisma.user.create({ data: { username: 'targeted-store', passwordHash: 'test', role: 'ADMIN' } })).id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes a candidate, capped evidence, verification, and deduplicates email', async () => {
    const store = new PrismaTargetedStore(prisma);
    const filters = { prompt: 'public freight contacts', mode: 'office', country: 'US' } as TargetedDraftInput;
    const campaign = await store.createDraft(userId, filters);
    const storedCampaign = await prisma.targetedCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(JSON.parse(storedCampaign.policyJson)).toMatchObject({ eligiblePublicAddressTypes: ['personal', 'business'] });
    expect(JSON.parse(storedCampaign.policyJson)).not.toHaveProperty('publicBusinessContactsOnly');
    await store.upsertCandidate(campaign.id, {
      email: 'Ops@Freight.example', companyName: 'Freight Co', relevanceScore: 70,
      relevanceReason: 'target_aligned', qualityTier: 'strict', verificationDepth: 'domain_mx',
      complianceStatus: 'public_b2b', infrastructureProviders: [],
      evidence: { evidenceType: 'public_page', excerpt: 'x'.repeat(600), fields: { public: true } },
      verification: { checkType: 'mx', status: 'valid', depth: 'domain_mx', reason: 'mx_valid' },
    });
    await store.upsertCandidate(campaign.id, {
      email: 'ops@freight.example', companyName: 'Freight Co', relevanceScore: 70,
      relevanceReason: 'target_aligned', qualityTier: 'strict', verificationDepth: 'domain_mx',
      complianceStatus: 'public_b2b', infrastructureProviders: [],
    });
    expect(await prisma.targetedCandidate.count({ where: { campaignId: campaign.id } })).toBe(1);
    expect((await prisma.targetedEvidence.findFirst())?.excerpt).toHaveLength(500);
    expect(await store.strictEmails(campaign.id)).toEqual(['ops@freight.example']);
  });

  it('never downgrades an existing Strict candidate when weaker duplicate evidence arrives', async () => {
    const store = new PrismaTargetedStore(prisma);
    const campaign = await store.createDraft(userId, { prompt: 'public freight contacts', mode: 'office', country: 'US' } as TargetedDraftInput);
    await store.upsertCandidate(campaign.id, {
      email: 'owner@example.com', relevanceScore: 91, relevanceReason: 'strong_match', qualityTier: 'strict',
      verificationDepth: 'domain_mx', complianceStatus: 'public_b2b', infrastructureProviders: ['microsoft_365'],
    });
    await store.upsertCandidate(campaign.id, {
      email: 'OWNER@example.com', relevanceScore: 10, relevanceReason: 'weak_duplicate', qualityTier: 'rejected',
      verificationDepth: 'none', complianceStatus: 'public_b2b', infrastructureProviders: [],
      evidence: { evidenceType: 'public_document', excerpt: 'additional public evidence' },
    });
    const candidate = await prisma.targetedCandidate.findFirstOrThrow({ where: { campaignId: campaign.id } });
    expect(candidate).toMatchObject({ qualityTier: 'strict', relevanceScore: 91, relevanceReason: 'strong_match', verificationDepth: 'domain_mx' });
    expect(await prisma.targetedEvidence.count({ where: { candidateId: candidate.id } })).toBe(1);
  });

  it('quarantines legacy foreign Strict candidates and removes them from exports', async () => {
    const store = new PrismaTargetedStore(prisma);
    const campaign = await store.createDraft(userId, {
      prompt: 'public contacts', mode: 'bank', country: 'US', areaCodes: ['713'], cities: ['Houston'], states: ['TX'], postalCodes: ['77055'],
    } as TargetedDraftInput);
    await store.upsertCandidate(campaign.id, {
      email: 'info@foreign.example', address: '12 Marina Road, Lagos, Nigeria', relevanceScore: 90,
      relevanceReason: 'target_aligned', qualityTier: 'strict', verificationDepth: 'domain_mx',
      complianceStatus: 'public_b2b', infrastructureProviders: [],
    });
    expect(await store.quarantineForeignCandidates(userId)).toBe(1);
    expect(await store.strictEmails(campaign.id)).toEqual([]);
    expect(await prisma.targetedCandidate.findFirstOrThrow({ where: { campaignId: campaign.id } }))
      .toMatchObject({ qualityTier: 'rejected', relevanceReason: 'target_mismatch', complianceStatus: 'foreign_rejected' });
  });

  it('marks a repeated substitution as used and exposes its geography reservation', async () => {
    const store = new PrismaTargetedStore(prisma);
    const filters = {
      prompt: 'public freight contacts', mode: 'office', country: 'US', keywords: ['freight'],
      areaCodes: ['602'], cities: ['Phoenix'], states: ['AZ'], postalCodes: ['85004'],
    } as TargetedDraftInput;
    const first = await store.createDraft(userId, filters);
    const units = planTargetedQueries(filters);
    await store.replaceWorkUnits(first.id, units.slice(0, 1));
    const second = await store.createDraft(userId, filters);
    await store.replaceWorkUnits(second.id, units.slice(0, 1));

    expect((await store.listWorkUnits(second.id))[0].previousUseCount).toBe(1);
    expect((await store.usedWorkKeys(userId, second.id)).has(units[0].workKey)).toBe(true);
    expect((await store.usedGeographyKeys(userId)).has('us|602|phoenix|az|85004')).toBe(true);
  });

  it('persists progress without replacing adaptive learning and resets only interrupted units', async () => {
    const store = new PrismaTargetedStore(prisma);
    const filters = {
      prompt: 'public freight contacts', mode: 'office', country: 'US', keywords: ['freight'],
      areaCodes: ['602'], cities: ['Phoenix'], states: ['AZ'], postalCodes: ['85004'],
    } as TargetedDraftInput;
    const campaign = await store.createDraft(userId, filters);
    await store.replaceWorkUnits(campaign.id, planTargetedQueries(filters).slice(0, 3));
    const [running, completed, failed] = await store.listWorkUnits(campaign.id);
    await store.updateWorkUnit(running.id, { status: 'running' });
    await store.updateWorkUnit(completed.id, { status: 'completed' });
    await store.updateWorkUnit(failed.id, { status: 'failed' });
    await store.recordWorkUnitMetric(running.id, {
      connector: running.connector, documentType: running.documentType, processed: 25,
      unique: 25, strict: 24, rejected: 1, failures: 1, elapsedMs: 100,
    });

    await store.updateWorkUnitProgress(running.id, {
      stage: 'extracting_document', processed: 25, total: 100, succeeded: 24, failed: 1,
      currentSource: 'https://records.example/a.xlsx', heartbeatAt: new Date().toISOString(),
    });

    expect((await store.listWorkUnits(campaign.id))[0]).toMatchObject({
      progress: { stage: 'extracting_document', processed: 25, total: 100, succeeded: 24, failed: 1 },
    });
    expect(JSON.parse((await prisma.targetedWorkUnit.findUniqueOrThrow({ where: { id: running.id } })).checkpointJson ?? '{}'))
      .toMatchObject({ adaptiveMetric: { strict: 24, unique: 25 } });

    await store.resetInterruptedWorkUnits(campaign.id);
    expect((await store.listWorkUnits(campaign.id)).map((unit) => unit.status)).toEqual(['pending', 'completed', 'failed']);
  });

  it('redacts credentials and URL secrets from persisted current sources', async () => {
    const store = new PrismaTargetedStore(prisma);
    const filters = { prompt: 'public freight contacts', mode: 'office', country: 'US', cities: ['Phoenix'], states: ['AZ'] } as TargetedDraftInput;
    const campaign = await store.createDraft(userId, filters);
    await store.replaceWorkUnits(campaign.id, planTargetedQueries(filters).slice(0, 1));
    const unit = (await store.listWorkUnits(campaign.id))[0];

    await store.updateWorkUnitProgress(unit.id, {
      stage: 'processing_sources', processed: 1, succeeded: 1, failed: 0,
      currentSource: 'https://user:password@records.example/report.csv?token=secret#fragment', heartbeatAt: new Date().toISOString(),
    });

    expect((await store.listWorkUnits(campaign.id))[0].progress?.currentSource).toBe('https://records.example/report.csv');
    expect((await prisma.targetedWorkUnit.findUniqueOrThrow({ where: { id: unit.id } })).checkpointJson).not.toContain('secret');
  });

  it('resets adaptive learning without deleting work-unit progress', async () => {
    const store = new PrismaTargetedStore(prisma);
    const filters = { prompt: 'public freight contacts', mode: 'office', country: 'US', cities: ['Phoenix'], states: ['AZ'] } as TargetedDraftInput;
    const campaign = await store.createDraft(userId, filters);
    await store.replaceWorkUnits(campaign.id, planTargetedQueries(filters).slice(0, 1));
    const unit = (await store.listWorkUnits(campaign.id))[0];
    await store.recordWorkUnitMetric(unit.id, {
      connector: unit.connector, documentType: unit.documentType, processed: 1, unique: 1, strict: 1, rejected: 0, failures: 0, elapsedMs: 1,
    });
    await store.updateWorkUnitProgress(unit.id, {
      stage: 'processing_sources', processed: 1, succeeded: 1, failed: 0, heartbeatAt: new Date().toISOString(),
    });

    await store.resetWorkMetrics();

    expect((await store.listWorkUnits(campaign.id))[0].progress).toMatchObject({ stage: 'processing_sources', processed: 1 });
    expect(JSON.parse((await prisma.targetedWorkUnit.findUniqueOrThrow({ where: { id: unit.id } })).checkpointJson ?? '{}')).not.toHaveProperty('adaptiveMetric');
  });

  it('treats a null checkpoint JSON value as an empty checkpoint', async () => {
    const store = new PrismaTargetedStore(prisma);
    const filters = { prompt: 'public freight contacts', mode: 'office', country: 'US', cities: ['Phoenix'], states: ['AZ'] } as TargetedDraftInput;
    const campaign = await store.createDraft(userId, filters);
    await store.replaceWorkUnits(campaign.id, planTargetedQueries(filters).slice(0, 1));
    const unit = (await store.listWorkUnits(campaign.id))[0];
    await prisma.targetedWorkUnit.update({ where: { id: unit.id }, data: { checkpointJson: 'null' } });

    await expect(store.listWorkUnits(campaign.id)).resolves.toMatchObject([{ id: unit.id }]);
  });

  it('ignores null and non-object checkpoints when reading recent work metrics', async () => {
    const store = new PrismaTargetedStore(prisma);
    const filters = { prompt: 'public freight contacts', mode: 'office', country: 'US', cities: ['Phoenix'], states: ['AZ'] } as TargetedDraftInput;
    const campaign = await store.createDraft(userId, filters);
    await store.replaceWorkUnits(campaign.id, planTargetedQueries(filters).slice(0, 2));
    const [first, second] = await store.listWorkUnits(campaign.id);
    await prisma.targetedWorkUnit.update({ where: { id: first.id }, data: { checkpointJson: 'null' } });
    await prisma.targetedWorkUnit.update({ where: { id: second.id }, data: { checkpointJson: '[]' } });

    await expect(store.recentWorkMetrics()).resolves.toEqual([]);
  });
});
