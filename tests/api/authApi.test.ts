import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/domain/auth';

const tempDir = mkdtempSync(join(tmpdir(), 'leads-genx-authapi-'));
const databaseUrl = `file:${join(tempDir, 'test.db').replace(/\\/g, '/')}`;
let prisma: PrismaClient;

let lastStartOptions: { userId?: number } | undefined;
const fakeRunService = {
  async startRun(_input: unknown, options?: { userId?: number }) {
    lastStartOptions = options;
    return { id: 99, status: 'queued', leadSource: 'google_maps' };
  },
};

function app() {
  return createApp({ prisma, runService: fakeRunService as never });
}

function cookieOf(res: request.Response): string {
  const header = res.headers['set-cookie'];
  const raw = Array.isArray(header) ? header[0] : header;
  return String(raw).split(';')[0];
}

async function login(username: string, password: string): Promise<string> {
  const res = await request(app()).post('/api/auth/login').send({ username, password }).expect(200);
  return cookieOf(res);
}

beforeAll(async () => {
  execFileSync(
    process.execPath,
    [join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--skip-generate'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe' }
  );
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
});

afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('bootstrap and login', () => {
  it('reports needsSetup on a fresh install, then locks setup after admin creation', async () => {
    const unauth = await request(app()).get('/api/auth/me').expect(401);
    expect(unauth.body.needsSetup).toBe(true);

    const setup = await request(app())
      .post('/api/auth/setup')
      .send({ username: 'owner', password: 'owner-password-1' })
      .expect(201);
    expect(setup.body.data.user).toMatchObject({ username: 'owner', role: 'ADMIN', tier: 'HYBRID' });
    expect(cookieOf(setup)).toContain('lgx_session=');

    await request(app())
      .post('/api/auth/setup')
      .send({ username: 'intruder', password: 'intruder-password' })
      .expect(403);
  });

  it('rejects bad credentials and accepts good ones', async () => {
    await request(app()).post('/api/auth/login').send({ username: 'owner', password: 'wrong-password' }).expect(401);
    const cookie = await login('owner', 'owner-password-1');
    const me = await request(app()).get('/api/auth/me').set('Cookie', cookie).expect(200);
    expect(me.body.data.user.username).toBe('owner');
  });

  it('requires auth for protected routes and keeps health public', async () => {
    await request(app()).get('/api/runs').expect(401);
    await request(app()).get('/api/settings').expect(401);
    await request(app()).get('/api/health').expect(200);
  });
});

describe('user management (admin)', () => {
  it('creates a standard user who can sign in', async () => {
    const adminCookie = await login('owner', 'owner-password-1');
    const created = await request(app())
      .post('/api/admin/users')
      .set('Cookie', adminCookie)
      .send({ username: 'client.jane', password: 'jane-password-1', tier: 'STANDARD' })
      .expect(201);
    expect(created.body.data).toMatchObject({ username: 'client.jane', tier: 'STANDARD', role: 'USER' });

    const janeCookie = await login('client.jane', 'jane-password-1');
    const me = await request(app()).get('/api/auth/me').set('Cookie', janeCookie).expect(200);
    expect(me.body.data.user.tier).toBe('STANDARD');
  });

  it('forbids non-admin access to admin and settings routes', async () => {
    const janeCookie = await login('client.jane', 'jane-password-1');
    await request(app()).get('/api/admin/users').set('Cookie', janeCookie).expect(403);
    await request(app()).get('/api/settings').set('Cookie', janeCookie).expect(403);
    await request(app())
      .post('/api/admin/users')
      .set('Cookie', janeCookie)
      .send({ username: 'hacker', password: 'hacker-password' })
      .expect(403);
  });

  it('rejects duplicate usernames and self-harm actions', async () => {
    const adminCookie = await login('owner', 'owner-password-1');
    await request(app())
      .post('/api/admin/users')
      .set('Cookie', adminCookie)
      .send({ username: 'client.jane', password: 'another-password' })
      .expect(409);

    const users = await request(app()).get('/api/admin/users').set('Cookie', adminCookie).expect(200);
    const owner = users.body.data.find((u: { username: string }) => u.username === 'owner');
    await request(app()).delete(`/api/admin/users/${owner.id}`).set('Cookie', adminCookie).expect(400);
    await request(app())
      .patch(`/api/admin/users/${owner.id}`)
      .set('Cookie', adminCookie)
      .send({ status: 'DISABLED' })
      .expect(400);
  });
});

describe('tier gating and quotas', () => {
  it('blocks hybrid_max for standard users with an upgrade hint', async () => {
    const janeCookie = await login('client.jane', 'jane-password-1');
    const res = await request(app())
      .post('/api/runs')
      .set('Cookie', janeCookie)
      .send({ leadSource: 'google_maps', outputMode: 'hybrid_max', maxResults: 100, apifyToken: 'test-token', googleApiKey: 'test-google-key', googleMaps: { searchTerms: ['dentist'] } })
      .expect(403);
    expect(res.body.upgradeRequired).toBe(true);
    expect(res.body.error).toMatch(/Hybrid plan/);
  });

  it('enforces the results-per-run plan cap', async () => {
    const janeCookie = await login('client.jane', 'jane-password-1');
    const res = await request(app())
      .post('/api/runs')
      .set('Cookie', janeCookie)
      .send({ leadSource: 'google_maps', maxResults: 600, googleApiKey: 'test-google-key', googleMaps: { searchTerms: ['dentist'] } })
      .expect(400);
    expect(res.body.error).toMatch(/500/);
  });

  it('stamps runs with the owner and lets admins run hybrid', async () => {
    const janeCookie = await login('client.jane', 'jane-password-1');
    await request(app())
      .post('/api/runs')
      .set('Cookie', janeCookie)
      .send({ leadSource: 'google_maps', maxResults: 100, googleApiKey: 'test-google-key', googleMaps: { searchTerms: ['dentist'] } })
      .expect(202);
    const jane = await prisma.user.findUnique({ where: { username: 'client.jane' } });
    expect(lastStartOptions?.userId).toBe(jane!.id);

    const adminCookie = await login('owner', 'owner-password-1');
    await request(app())
      .post('/api/runs')
      .set('Cookie', adminCookie)
      .send({ leadSource: 'google_maps', outputMode: 'hybrid_max', maxResults: 100, apifyToken: 'test-token', googleApiKey: 'test-google-key', googleMaps: { searchTerms: ['dentist'] } })
      .expect(202);
  });

  it('enforces the daily run quota', async () => {
    const jane = await prisma.user.findUnique({ where: { username: 'client.jane' } });
    for (let i = 0; i < 5; i += 1) {
      await prisma.run.create({
        data: { actorId: 'test', leadSource: 'google_maps', status: 'completed', maxResults: 10, userId: jane!.id },
      });
    }
    const janeCookie = await login('client.jane', 'jane-password-1');
    const res = await request(app())
      .post('/api/runs')
      .set('Cookie', janeCookie)
      .send({ leadSource: 'google_maps', maxResults: 100, googleApiKey: 'test-google-key', googleMaps: { searchTerms: ['dentist'] } })
      .expect(429);
    expect(res.body.error).toMatch(/Daily run limit/);
  });
});

describe('run isolation', () => {
  it('users see only their own runs; admins see all', async () => {
    const jane = await prisma.user.findUnique({ where: { username: 'client.jane' } });
    await prisma.user.deleteMany({ where: { username: 'client.john' } });
    const john = await prisma.user.create({
      data: { username: 'client.john', passwordHash: await hashPassword('john-password-1'), tier: 'STANDARD' },
    });
    const janeRun = await prisma.run.create({
      data: { actorId: 'test', leadSource: 'google_maps', status: 'completed', maxResults: 10, userId: jane!.id },
    });
    const johnRun = await prisma.run.create({
      data: { actorId: 'test', leadSource: 'google_maps', status: 'completed', maxResults: 10, userId: john.id },
    });

    const johnCookie = await login('client.john', 'john-password-1');
    const johnsRuns = await request(app()).get('/api/runs').set('Cookie', johnCookie).expect(200);
    const ids = johnsRuns.body.data.map((run: { id: number }) => run.id);
    expect(ids).toContain(johnRun.id);
    expect(ids).not.toContain(janeRun.id);

    await request(app()).get(`/api/runs/${janeRun.id}`).set('Cookie', johnCookie).expect(404);
    await request(app()).get(`/api/runs/${janeRun.id}/events`).set('Cookie', johnCookie).expect(404);
    await request(app()).get(`/api/runs/${janeRun.id}/analyst`).set('Cookie', johnCookie).expect(404);
    await request(app()).post(`/api/runs/${janeRun.id}/stop`).set('Cookie', johnCookie).expect(404);

    const adminCookie = await login('owner', 'owner-password-1');
    const allRuns = await request(app()).get('/api/runs').set('Cookie', adminCookie).expect(200);
    const adminIds = allRuns.body.data.map((run: { id: number }) => run.id);
    expect(adminIds).toEqual(expect.arrayContaining([janeRun.id, johnRun.id]));
  });

  it('scopes leads to owned runs', async () => {
    const jane = await prisma.user.findUnique({ where: { username: 'client.jane' } });
    const john = await prisma.user.findUnique({ where: { username: 'client.john' } });
    const janeRun = await prisma.run.findFirst({ where: { userId: jane!.id } });
    const johnRun = await prisma.run.findFirst({ where: { userId: john!.id } });
    await prisma.lead.create({
      data: { runId: janeRun!.id, leadSource: 'google_maps', leadType: 'business', email: 'jane@example.com', normalizedEmail: 'jane@example.com' },
    });
    await prisma.lead.create({
      data: { runId: johnRun!.id, leadSource: 'google_maps', leadType: 'business', email: 'john@example.com', normalizedEmail: 'john@example.com' },
    });

    const johnCookie = await login('client.john', 'john-password-1');
    const leads = await request(app()).get('/api/leads').set('Cookie', johnCookie).expect(200);
    const emails = leads.body.data.map((lead: { email: string }) => lead.email);
    expect(emails).toContain('john@example.com');
    expect(emails).not.toContain('jane@example.com');
  });
});

describe('upgrade flow', () => {
  it('user requests, admin approves, hybrid unlocks', async () => {
    const johnCookie = await login('client.john', 'john-password-1');
    await request(app())
      .post('/api/runs')
      .set('Cookie', johnCookie)
      .send({ leadSource: 'google_maps', outputMode: 'hybrid_max', maxResults: 100, apifyToken: 'test-token', googleApiKey: 'test-google-key', googleMaps: { searchTerms: ['dentist'] } })
      .expect(403);

    await request(app()).post('/api/auth/request-upgrade').set('Cookie', johnCookie).expect(201);
    await request(app()).post('/api/auth/request-upgrade').set('Cookie', johnCookie).expect(409);

    const adminCookie = await login('owner', 'owner-password-1');
    const requests = await request(app()).get('/api/admin/upgrade-requests').set('Cookie', adminCookie).expect(200);
    const pending = requests.body.data.find((r: { user: { username: string } }) => r.user.username === 'client.john');
    expect(pending).toBeTruthy();

    await request(app())
      .post(`/api/admin/upgrade-requests/${pending.id}/approve`)
      .set('Cookie', adminCookie)
      .expect(200);

    const upgradedCookie = await login('client.john', 'john-password-1');
    const me = await request(app()).get('/api/auth/me').set('Cookie', upgradedCookie).expect(200);
    expect(me.body.data.user.tier).toBe('HYBRID');
    await request(app())
      .post('/api/runs')
      .set('Cookie', upgradedCookie)
      .send({ leadSource: 'google_maps', outputMode: 'hybrid_max', maxResults: 100, apifyToken: 'test-token', googleApiKey: 'test-google-key', googleMaps: { searchTerms: ['dentist'] } })
      .expect(202);
  });
});

describe('account security', () => {
  it('change-password rotates credentials', async () => {
    const johnCookie = await login('client.john', 'john-password-1');
    await request(app())
      .post('/api/auth/password')
      .set('Cookie', johnCookie)
      .send({ currentPassword: 'wrong', newPassword: 'john-new-password' })
      .expect(400);
    await request(app())
      .post('/api/auth/password')
      .set('Cookie', johnCookie)
      .send({ currentPassword: 'john-password-1', newPassword: 'john-new-password' })
      .expect(200);
    await request(app()).post('/api/auth/login').send({ username: 'client.john', password: 'john-password-1' }).expect(401);
    await login('client.john', 'john-new-password');
  });

  it('disabling a user kills sessions and blocks login', async () => {
    const adminCookie = await login('owner', 'owner-password-1');
    const john = await prisma.user.findUnique({ where: { username: 'client.john' } });
    const johnCookie = await login('client.john', 'john-new-password');

    await request(app())
      .patch(`/api/admin/users/${john!.id}`)
      .set('Cookie', adminCookie)
      .send({ status: 'DISABLED' })
      .expect(200);

    await request(app()).get('/api/auth/me').set('Cookie', johnCookie).expect(401);
    await request(app()).post('/api/auth/login').send({ username: 'client.john', password: 'john-new-password' }).expect(403);
  });

  it('logout invalidates the session', async () => {
    const adminCookie = await login('owner', 'owner-password-1');
    const john = await prisma.user.findUnique({ where: { username: 'client.john' } });
    await request(app())
      .patch(`/api/admin/users/${john!.id}`)
      .set('Cookie', adminCookie)
      .send({ status: 'ACTIVE' })
      .expect(200);
    const cookie = await login('client.john', 'john-new-password');
    await request(app()).post('/api/auth/logout').set('Cookie', cookie).expect(200);
    await request(app()).get('/api/auth/me').set('Cookie', cookie).expect(401);
  });
});
