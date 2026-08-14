import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/domain/auth';
import type { ApiDeps } from '../../src/routes/api';

const tempDir = mkdtempSync(join(tmpdir(), 'leads-genx-bdenrich-'));
const databaseUrl = `file:${join(tempDir, 'test.db').replace(/\\/g, '/')}`;
let prisma: PrismaClient;

function app(overrides: ApiDeps = {}) {
  return createApp({
    prisma,
    runService: { async startRun() { return { id: 1 }; } } as never,
    ...overrides,
  });
}

function cookieOf(res: request.Response): string {
  const header = res.headers['set-cookie'];
  const raw = Array.isArray(header) ? header[0] : header;
  return String(raw).split(';')[0];
}

beforeAll(async () => {
  execFileSync(
    process.execPath,
    [join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--skip-generate'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe' }
  );
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.user.create({
    data: { username: 'bd.owner', passwordHash: await hashPassword('bd-password-1') },
  });
  await prisma.user.create({
    data: { username: 'bd.other', passwordHash: await hashPassword('bd-password-2') },
  });
  await prisma.user.create({
    data: { username: 'bd.admin', passwordHash: await hashPassword('bd-password-3'), role: 'ADMIN' },
  });
});

afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

async function login(username: string, password: string): Promise<string> {
  const res = await request(app()).post('/api/auth/login').send({ username, password });
  expect(res.status).toBe(200);
  return cookieOf(res);
}

async function seedLinkedInRun(username: string): Promise<number> {
  const user = await prisma.user.findUniqueOrThrow({ where: { username } });
  const run = await prisma.run.create({
    data: {
      userId: user.id,
      status: 'completed',
      leadSource: 'sales_navigator',
      actorId: 'sn_extension',
      filterJson: JSON.stringify({ extensionSessionId: 'sess-1' }),
    },
  });
  await prisma.lead.create({
    data: {
      runId: run.id,
      leadSource: 'sales_navigator',
      leadType: 'linkedin_profile',
      fullName: 'Jane Doe',
      profileUrl: 'https://www.linkedin.com/in/jane-doe/',
    },
  });
  return run.id;
}

describe('POST /api/runs/:id/enrich-linkedin', () => {
  it('rejects when no Bright Data key is configured anywhere', async () => {
    const runId = await seedLinkedInRun('bd.owner');
    const cookie = await login('bd.owner', 'bd-password-1');
    const res = await request(app()).post(`/api/runs/${runId}/enrich-linkedin`).set('Cookie', cookie);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Bright Data');
  });

  it("hides other users' runs", async () => {
    const runId = await seedLinkedInRun('bd.owner');
    const cookie = await login('bd.other', 'bd-password-2');
    const res = await request(app()).post(`/api/runs/${runId}/enrich-linkedin`).set('Cookie', cookie);
    expect(res.status).toBe(404);
  });

  it('reports zero pending when every LinkedIn lead already has contact data', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { username: 'bd.owner' } });
    const run = await prisma.run.create({
      data: { userId: user.id, status: 'completed', leadSource: 'sales_navigator', actorId: 'sn_extension' },
    });
    await prisma.lead.create({
      data: {
        runId: run.id,
        leadSource: 'sales_navigator',
        leadType: 'linkedin_profile',
        fullName: 'Has Email',
        profileUrl: 'https://www.linkedin.com/in/has-email/',
        email: 'has@acme.com',
        normalizedEmail: 'has@acme.com',
      },
    });
    // Give the owner a BYOD Bright Data key so we reach the pending check.
    const cookie = await login('bd.owner', 'bd-password-1');
    const save = await request(app())
      .post('/api/auth/credentials')
      .set('Cookie', cookie)
      .send({ brightDataApiKey: 'bd-test-key' });
    expect(save.status).toBe(200);
    expect(save.body.data.brightDataKeySet).toBe(true);

    const res = await request(app()).post(`/api/runs/${run.id}/enrich-linkedin`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ started: false, pending: 0 });
  });

  it("uses a standard caller's BYOD Bright Data key but never loads another user's key for an admin", async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: 'bd.owner' } });
    const admin = await prisma.user.findUniqueOrThrow({ where: { username: 'bd.admin' } });
    const run = await prisma.run.create({
      data: {
        userId: owner.id,
        status: 'waiting_for_credentials',
        leadSource: 'sales_navigator',
        actorId: 'brightdata_linkedin',
        filterJson: JSON.stringify({ salesNavigator: { titles: ['VP Sales'] } }),
      },
    });
    await prisma.appSetting.upsert({
      where: { key: `userCreds:${owner.id}` },
      create: { key: `userCreds:${owner.id}`, value: JSON.stringify({ brightDataApiKey: 'bd-owner-key', googleApiKeys: [], proxyUrls: [] }), secret: true },
      update: { value: JSON.stringify({ brightDataApiKey: 'bd-owner-key', googleApiKeys: [], proxyUrls: [] }) },
    });
    await prisma.appSetting.upsert({
      where: { key: `userCreds:${admin.id}` },
      create: { key: `userCreds:${admin.id}`, value: JSON.stringify({ brightDataApiKey: 'bd-admin-key', googleApiKeys: [], proxyUrls: [] }), secret: true },
      update: { value: JSON.stringify({ brightDataApiKey: 'bd-admin-key', googleApiKeys: [], proxyUrls: [] }) },
    });
    await prisma.appSetting.upsert({
      where: { key: 'brightDataApiKey' },
      create: { key: 'brightDataApiKey', value: 'bd-operator-key', secret: true },
      update: { value: 'bd-operator-key', secret: true },
    });

    let received: unknown;
    const application = app({
      runService: {
        async startRun() { return { id: 1 }; },
        async resumeRun(runId, credentials) {
          received = { runId, credentials };
          return { id: runId, status: 'queued' };
        },
      } as never,
    });
    const ownerCookie = await login('bd.owner', 'bd-password-1');

    const res = await request(application).post(`/api/runs/${run.id}/resume`).set('Cookie', ownerCookie);

    expect(res.status).toBe(202);
    expect(received).toMatchObject({
      runId: run.id,
      credentials: { brightDataApiKey: 'bd-owner-key' },
    });

    const adminRun = await prisma.run.create({
      data: {
        userId: owner.id,
        status: 'waiting_for_credentials',
        leadSource: 'sales_navigator',
        actorId: 'brightdata_linkedin',
      },
    });
    const adminCookie = await login('bd.admin', 'bd-password-3');
    const adminResume = await request(application).post(`/api/runs/${adminRun.id}/resume`).set('Cookie', adminCookie);
    expect(adminResume.status).toBe(202);
    expect(received).toMatchObject({
      runId: adminRun.id,
      credentials: { brightDataApiKey: 'bd-operator-key' },
    });
  });

  it('allows only one in-flight Bright Data enrichment job per run and unlocks after success', async () => {
    const runId = await seedLinkedInRun('bd.owner');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const enrich = vi.fn()
      .mockImplementationOnce(async () => {
        await blocked;
        return { attempted: 1, enriched: 1, skipped: 0 };
      })
      .mockResolvedValue({ attempted: 1, enriched: 1, skipped: 0 });
    const application = app({ linkedinEnricher: enrich });
    const cookie = await login('bd.owner', 'bd-password-1');

    const [first, concurrent] = await Promise.all([
      request(application).post(`/api/runs/${runId}/enrich-linkedin`).set('Cookie', cookie),
      request(application).post(`/api/runs/${runId}/enrich-linkedin`).set('Cookie', cookie),
    ]);

    expect([first.status, concurrent.status]).toEqual([202, 202]);
    const bodies = [first.body.data, concurrent.body.data];
    expect(bodies.filter((data) => data.started === true)).toHaveLength(1);
    expect(bodies.filter((data) => data.inProgress === true)).toHaveLength(1);
    expect(enrich).toHaveBeenCalledTimes(1);

    release();
    await new Promise((resolve) => setImmediate(resolve));
    const afterSuccess = await request(application).post(`/api/runs/${runId}/enrich-linkedin`).set('Cookie', cookie);
    expect(afterSuccess.status).toBe(202);
    expect(afterSuccess.body.data.started).toBe(true);
    expect(enrich).toHaveBeenCalledTimes(2);
  });

  it('unlocks Bright Data enrichment after a background failure', async () => {
    const runId = await seedLinkedInRun('bd.owner');
    const enrich = vi.fn()
      .mockRejectedValueOnce(new Error('synthetic Bright Data failure'))
      .mockResolvedValue({ attempted: 1, enriched: 1, skipped: 0 });
    const application = app({ linkedinEnricher: enrich });
    const cookie = await login('bd.owner', 'bd-password-1');

    const failed = await request(application).post(`/api/runs/${runId}/enrich-linkedin`).set('Cookie', cookie);
    expect(failed.status).toBe(202);
    await new Promise((resolve) => setImmediate(resolve));

    const retry = await request(application).post(`/api/runs/${runId}/enrich-linkedin`).set('Cookie', cookie);
    expect(retry.status).toBe(202);
    expect(retry.body.data.started).toBe(true);
    expect(enrich).toHaveBeenCalledTimes(2);
  });
});
