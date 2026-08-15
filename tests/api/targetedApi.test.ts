import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/domain/auth';

describe('admin targeted scraping API', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'leads-genx-targeted-api-'));
  const databaseUrl = `file:${join(tempDir, 'test.db').replace(/\\/g, '/')}`;
  let prisma: PrismaClient;
  let adminCookie: string;
  let userCookie: string;

  const app = () => createApp({ prisma, runService: { startRun: async () => ({ id: 1, status: 'queued', leadSource: 'google_maps' }) } });
  const cookieOf = (response: request.Response) => String(Array.isArray(response.headers['set-cookie'])
    ? response.headers['set-cookie'][0] : response.headers['set-cookie']).split(';')[0];

  beforeAll(async () => {
    execFileSync(process.execPath, [join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--skip-generate'], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe',
    });
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const setup = await request(app()).post('/api/auth/setup').send({ username: 'target-admin', password: 'target-password' }).expect(201);
    adminCookie = cookieOf(setup);
    await prisma.user.create({ data: { username: 'target-user', passwordHash: await hashPassword('target-password'), role: 'USER' } });
    userCookie = cookieOf(await request(app()).post('/api/auth/login').send({ username: 'target-user', password: 'target-password' }).expect(200));
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('requires an authenticated administrator', async () => {
    await request(app()).get('/api/targeted/catalog').expect(401);
    await request(app()).get('/api/targeted/catalog').set('Cookie', userCookie).expect(403);
  });

  it('returns the full catalog and creates an owned draft', async () => {
    const catalog = await request(app()).get('/api/targeted/catalog').set('Cookie', adminCookie).expect(200);
    expect(catalog.body.data.providers).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'microsoft_365' })]));
    expect(catalog.body.data.banks.length).toBeGreaterThan(10);
    expect(catalog.body.data.policy).toMatchObject({
      eligiblePublicAddressTypes: ['personal', 'business'], mailboxVerificationIncluded: false,
    });
    expect(catalog.body.data.policy).not.toHaveProperty('publicBusinessContactsOnly');

    const created = await request(app()).post('/api/targeted/campaigns').set('Cookie', adminCookie).send({
      prompt: 'Public freight contacts in Phoenix', mode: 'office', country: 'US',
      keywords: ['freight'], areaCodes: ['602'], states: ['AZ'], cities: ['Phoenix'], postalCodes: ['85001'],
    }).expect(201);
    expect(created.body.data).toMatchObject({ status: 'draft', prompt: 'Public freight contacts in Phoenix' });
    const id = created.body.data.id;
    await request(app()).post(`/api/targeted/campaigns/${id}/plan`).set('Cookie', adminCookie).expect(200);
    const detail = await request(app()).get(`/api/targeted/campaigns/${id}`).set('Cookie', adminCookie).expect(200);
    expect(detail.body.data.workUnits.length).toBeGreaterThan(0);
  });

  it('returns a parsed safe progress checkpoint on campaign detail', async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: 'target-admin' } });
    const campaign = await prisma.targetedCampaign.create({ data: {
      userId: owner.id, prompt: 'Public business contacts', filterJson: '{}', policyJson: '{}', status: 'running',
    } });
    const unit = await prisma.targetedWorkUnit.create({ data: {
      campaignId: campaign.id, workKey: `progress-${campaign.id}`, connector: 'public_document',
      query: 'public contacts Phoenix', documentType: 'pdf', geographyJson: '{}', status: 'running',
      checkpointJson: JSON.stringify({ progress: {
        stage: 'extracting <script>alert(1)</script>', processed: 12, total: 40, succeeded: 10, failed: 2,
        currentSource: 'https://user:secret@example.com/path?token=hidden#fragment', heartbeatAt: '2026-08-14T12:00:00.000Z',
      }, credentials: 'must not be returned' }),
    } });

    const detail = await request(app()).get(`/api/targeted/campaigns/${campaign.id}`).set('Cookie', adminCookie).expect(200);
    expect(detail.body.data.workUnits).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: unit.id, progress: {
        stage: 'extracting <script>alert(1)</script>', processed: 12, total: 40, succeeded: 10, failed: 2,
        currentSource: 'https://example.com/path', heartbeatAt: '2026-08-14T12:00:00.000Z',
      } }),
    ]));
    expect(JSON.stringify(detail.body.data)).not.toContain('must not be returned');
    expect(JSON.stringify(detail.body.data)).not.toContain('secret');
  });

  it('returns validation fields and strict export headers', async () => {
    const invalid = await request(app()).post('/api/targeted/campaigns').set('Cookie', adminCookie)
      .send({ prompt: 'Chase account holders', mode: 'bank', bankIds: ['chase'] }).expect(400);
    expect(invalid.body.fields.prompt).toMatch(/public business contacts/i);

    const owner = await prisma.user.findUniqueOrThrow({ where: { username: 'target-admin' } });
    const campaign = await prisma.targetedCampaign.create({ data: {
      userId: owner.id, prompt: 'Public business contacts', filterJson: '{}', policyJson: '{}', status: 'completed',
    } });
    await prisma.targetedCandidate.create({ data: {
      campaignId: campaign.id, email: 'strict@example.biz', normalizedEmail: 'strict@example.biz', qualityTier: 'strict',
    } });
    await prisma.targetedCandidate.create({ data: {
      campaignId: campaign.id, email: 'review@example.biz', normalizedEmail: 'review@example.biz', qualityTier: 'review',
    } });
    const exported = await request(app()).get(`/api/targeted/campaigns/${campaign.id}/export?quality=strict`)
      .set('Cookie', adminCookie).expect(200);
    expect(exported.headers['content-type']).toMatch(/text\/plain/);
    expect(exported.headers['content-disposition']).toContain(`leads-genx-targeted-${campaign.id}-strict.txt`);
    expect(exported.text.trim()).toBe('strict@example.biz');
  });

  it('lets an administrator reset adaptive work-unit learning', async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: 'target-admin' } });
    const campaign = await prisma.targetedCampaign.create({ data: {
      userId: owner.id, prompt: 'Public business contacts', filterJson: '{}', policyJson: '{}', status: 'planned',
    } });
    await prisma.targetedWorkUnit.create({ data: {
      campaignId: campaign.id, workKey: `reset-${campaign.id}`, connector: 'public_web', query: 'public contacts Phoenix',
      documentType: 'html', geographyJson: '{}', checkpointJson: JSON.stringify({ adaptiveMetric: { strict: 2 } }),
    } });
    const response = await request(app()).post('/api/targeted/learning/reset').set('Cookie', adminCookie).expect(200);
    expect(response.body.data.resetWorkUnits).toBeGreaterThanOrEqual(1);
    const checkpoints = await prisma.targetedWorkUnit.findMany({ where: { checkpointJson: { not: null } }, select: { checkpointJson: true } });
    expect(checkpoints.every((row) => !row.checkpointJson || !('adaptiveMetric' in JSON.parse(row.checkpointJson)))).toBe(true);
  });

  it('downloads deduplicated Strict leads across all targeted runs', async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: 'target-admin' } });
    for (const suffix of ['all-a', 'all-b']) {
      const campaign = await prisma.targetedCampaign.create({ data: {
        userId: owner.id, prompt: 'Public business contacts', filterJson: '{}', policyJson: '{}', status: 'completed',
      } });
      await prisma.targetedCandidate.create({ data: {
        campaignId: campaign.id, email: `${suffix}@example.com`, normalizedEmail: `${suffix}@example.com`, qualityTier: 'strict',
      } });
    }
    const exported = await request(app()).get('/api/targeted/export?quality=strict').set('Cookie', adminCookie).expect(200);
    expect(exported.text).toContain('all-a@example.com');
    expect(exported.text).toContain('all-b@example.com');
    expect(exported.headers['content-disposition']).toContain('leads-genx-targeted-all-strict.txt');
  });

  it('lets an administrator delete an owned targeted run', async () => {
    const created = await request(app()).post('/api/targeted/campaigns').set('Cookie', adminCookie).send({
      prompt: 'Public logistics contacts in Austin', mode: 'office', country: 'US',
      keywords: ['logistics'], areaCodes: ['512'], states: ['TX'], cities: ['Austin'], postalCodes: ['78701'],
    }).expect(201);
    const id = created.body.data.id;
    await request(app()).delete(`/api/targeted/campaigns/${id}`).set('Cookie', adminCookie).expect(204);
    await request(app()).get(`/api/targeted/campaigns/${id}`).set('Cookie', adminCookie).expect(404);
  });
});
