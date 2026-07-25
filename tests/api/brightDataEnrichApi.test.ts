import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/domain/auth';

const tempDir = mkdtempSync(join(tmpdir(), 'leads-genx-bdenrich-'));
const databaseUrl = `file:${join(tempDir, 'test.db').replace(/\\/g, '/')}`;
let prisma: PrismaClient;

function app() {
  return createApp({ prisma, runService: { async startRun() { return { id: 1 }; } } as never });
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
});
