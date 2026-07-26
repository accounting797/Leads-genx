import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/domain/auth';

const tempDir = mkdtempSync(join(tmpdir(), 'leads-genx-extapi-'));
const databaseUrl = `file:${join(tempDir, 'test.db').replace(/\\/g, '/')}`;
let prisma: PrismaClient;

const fakeRunService = {
  async startRun() {
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

function lead(overrides: Record<string, unknown> = {}) {
  return {
    fullName: 'Jane Doe',
    firstName: 'Jane',
    lastName: 'Doe',
    title: 'VP Sales',
    company: 'Acme Inc',
    profileUrl: `https://www.linkedin.com/in/jane-doe-${Math.random().toString(36).slice(2, 10)}/`,
    location: 'Austin, TX',
    connectionDegree: '2nd',
    ...overrides,
  };
}

beforeAll(async () => {
  execFileSync(
    process.execPath,
    [join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--skip-generate'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe' }
  );
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.user.create({
    data: { username: 'ext.owner', passwordHash: await hashPassword('ext-password-1') },
  });
});

afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

async function login(): Promise<string> {
  const res = await request(app())
    .post('/api/auth/login')
    .send({ username: 'ext.owner', password: 'ext-password-1' })
    .expect(200);
  return cookieOf(res);
}

async function freshToken(): Promise<string> {
  const cookie = await login();
  const res = await request(app()).post('/api/extension/token/regenerate').set('Cookie', cookie).expect(200);
  return res.body.data.token as string;
}

describe('extension ping', () => {
  it('answers ok for a valid Bearer token and 401s otherwise', async () => {
    const token = await freshToken();

    const ok = await request(app())
      .get('/api/extension/ping')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(ok.body).toEqual({ data: { ok: true, username: 'ext.owner', server: 'leadsgenx' } });

    const bad = await request(app())
      .get('/api/extension/ping')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
    expect(bad.body).toEqual({ error: 'Invalid extension token' });

    await request(app()).get('/api/extension/ping').expect(401);
  });
});

describe('extension token management', () => {
  it('creates the token on demand, then keeps returning it', async () => {
    const cookie = await login();
    const first = await request(app()).get('/api/extension/token').set('Cookie', cookie).expect(200);
    expect(first.body.data.token).toMatch(/^[0-9a-f]{48}$/);

    const second = await request(app()).get('/api/extension/token').set('Cookie', cookie).expect(200);
    expect(second.body.data.token).toBe(first.body.data.token);
  });

  it('regenerates the token and the old one dies instantly', async () => {
    const cookie = await login();
    const old = await request(app()).get('/api/extension/token').set('Cookie', cookie).expect(200);

    const regenerated = await request(app())
      .post('/api/extension/token/regenerate')
      .set('Cookie', cookie)
      .expect(200);
    expect(regenerated.body.data.token).toMatch(/^[0-9a-f]{48}$/);
    expect(regenerated.body.data.token).not.toBe(old.body.data.token);

    await request(app())
      .get('/api/extension/ping')
      .set('Authorization', `Bearer ${old.body.data.token}`)
      .expect(401);
    await request(app())
      .get('/api/extension/ping')
      .set('Authorization', `Bearer ${regenerated.body.data.token}`)
      .expect(200);
  });

  it('requires a signed-in user for token routes', async () => {
    await request(app()).get('/api/extension/token').expect(401);
    await request(app()).post('/api/extension/token/regenerate').expect(401);
  });
});

describe('extension leads ingestion', () => {
  it('creates the run, inserts leads, and reports counts', async () => {
    const token = await freshToken();
    const sessionId = randomUUID();

    const res = await request(app())
      .post('/api/extension/leads')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sessionId,
        runName: 'VPs in Austin',
        page: 3,
        leads: [
          lead({ profileUrl: 'https://www.linkedin.com/in/alpha/' }),
          lead({ fullName: 'John Roe', profileUrl: 'https://www.linkedin.com/in/beta/' }),
          { fullName: 'No URL' }, // invalid — skipped
        ],
      })
      .expect(200);

    expect(res.body.data).toMatchObject({ inserted: 2, duplicates: 0, skipped: 1, totalLeads: 2 });
    const runId = res.body.data.runId as number;

    const run = await prisma.run.findUnique({ where: { id: runId } });
    expect(run).toMatchObject({
      leadSource: 'sales_navigator',
      actorId: 'sn_extension',
      status: 'running',
      maxResults: 10000,
      searchUrl: 'VPs in Austin',
      leadCount: 2,
      completedUnitCount: 3,
    });
    expect(JSON.parse(run!.filterJson!)).toEqual({ extensionSessionId: sessionId, runName: 'VPs in Austin' });
    expect(run!.lastHeartbeatAt).toBeTruthy();

    const leads = await prisma.lead.findMany({ where: { runId }, orderBy: { id: 'asc' } });
    expect(leads).toHaveLength(2);
    expect(leads[0]).toMatchObject({
      leadSource: 'sales_navigator',
      leadType: 'linkedin_profile',
      fullName: 'Jane Doe',
      jobTitle: 'VP Sales',
      companyName: 'Acme Inc',
      profileUrl: 'https://www.linkedin.com/in/alpha/',
      location: 'Austin, TX',
      connectionDegree: '2nd',
      contactQuality: 'qualified',
      qualityReason: 'Captured by the Leads-GenX extension',
      normalizedEmail: null,
    });
    expect(JSON.parse(leads[0].rawJson!)).toMatchObject({ fullName: 'Jane Doe', company: 'Acme Inc' });

    const events = await prisma.runEvent.findMany({ where: { runId } });
    expect(events.map((event) => event.type)).toContain('extension_leads_ingested');
    expect(events[0].message).toBe(
      'Nova here — your extension just sent 2 new leads from page 3 (0 duplicates skipped).'
    );
  });

  it('reuses the same run for a second batch with the same sessionId', async () => {
    const token = await freshToken();
    const sessionId = randomUUID();

    const first = await request(app())
      .post('/api/extension/leads')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionId, page: 1, leads: [lead({ profileUrl: 'https://www.linkedin.com/in/one/' })] })
      .expect(200);

    const second = await request(app())
      .post('/api/extension/leads')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionId, page: 2, leads: [lead({ profileUrl: 'https://www.linkedin.com/in/two/' })] })
      .expect(200);

    expect(second.body.data.runId).toBe(first.body.data.runId);
    expect(second.body.data).toMatchObject({ inserted: 1, totalLeads: 2 });

    const run = await prisma.run.findUnique({ where: { id: first.body.data.runId } });
    expect(run!.leadCount).toBe(2);
    expect(run!.completedUnitCount).toBe(2);
  });

  it('counts profileUrl duplicates within the run and within the batch', async () => {
    const token = await freshToken();
    const sessionId = randomUUID();

    await request(app())
      .post('/api/extension/leads')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionId, page: 1, leads: [lead({ profileUrl: 'https://www.linkedin.com/in/dup/' })] })
      .expect(200);

    const res = await request(app())
      .post('/api/extension/leads')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sessionId,
        page: 2,
        leads: [
          lead({ profileUrl: 'https://www.linkedin.com/in/dup/' }), // already in the run
          lead({ fullName: 'New Person', profileUrl: 'https://www.linkedin.com/in/fresh/' }),
          lead({ fullName: 'Twin', profileUrl: 'https://www.linkedin.com/in/fresh/' }), // same batch
        ],
      })
      .expect(200);

    expect(res.body.data).toMatchObject({ inserted: 1, duplicates: 2, skipped: 0, totalLeads: 2 });
  });

  it('rejects batches over 100 leads with 413', async () => {
    const token = await freshToken();
    const leads = Array.from({ length: 101 }, (_value, index) =>
      lead({ profileUrl: `https://www.linkedin.com/in/bulk-${index}/` })
    );
    const res = await request(app())
      .post('/api/extension/leads')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionId: randomUUID(), page: 1, leads })
      .expect(413);
    expect(res.body.error).toBeTruthy();
  });

  it('rejects empty lead batches and missing sessionId', async () => {
    const token = await freshToken();
    await request(app())
      .post('/api/extension/leads')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionId: randomUUID(), page: 1, leads: [] })
      .expect(400);
    await request(app())
      .post('/api/extension/leads')
      .set('Authorization', `Bearer ${token}`)
      .send({ page: 1, leads: [lead()] })
      .expect(400);
  });
});

describe('extension finish', () => {
  it('schedules supplemental hiring signals after completion', async () => {
    const token = await freshToken();
    const sessionId = randomUUID();
    const settled: number[] = [];
    const hiringSignalService = {
      async scheduleIfEligible(runId: number) {
        settled.push(runId);
        return { scheduled: true, scanId: 1 };
      },
    };
    const testApp = createApp({
      prisma,
      runService: fakeRunService as never,
      hiringSignalService: hiringSignalService as never,
    });

    const ingest = await request(testApp)
      .post('/api/extension/leads')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionId, page: 1, leads: [lead()] })
      .expect(200);

    await request(testApp)
      .post('/api/extension/finish')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionId })
      .expect(200);

    expect(settled).toEqual([ingest.body.data.runId]);
  });

  it('completes the run and keeps ingesting late leads without reopening it', async () => {
    const token = await freshToken();
    const sessionId = randomUUID();

    const ingest = await request(app())
      .post('/api/extension/leads')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionId, page: 1, leads: [lead({ profileUrl: 'https://www.linkedin.com/in/fin/' })] })
      .expect(200);
    const runId = ingest.body.data.runId as number;

    const finished = await request(app())
      .post('/api/extension/finish')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionId })
      .expect(200);
    expect(finished.body.data).toEqual({ runId, totalLeads: 1 });

    const run = await prisma.run.findUnique({ where: { id: runId } });
    expect(run!.status).toBe('completed');
    expect(run!.completedAt).toBeTruthy();

    const events = await prisma.runEvent.findMany({ where: { runId } });
    expect(events.map((event) => event.type)).toContain('extension_session_finished');
    expect(events.find((event) => event.type === 'extension_session_finished')!.message).toBe(
      'Scraping session complete — 1 leads collected.'
    );

    // Late leads are still ingested; the run stays completed.
    const late = await request(app())
      .post('/api/extension/leads')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionId, page: 2, leads: [lead({ profileUrl: 'https://www.linkedin.com/in/late/' })] })
      .expect(200);
    expect(late.body.data).toMatchObject({ inserted: 1, totalLeads: 2 });
    const after = await prisma.run.findUnique({ where: { id: runId } });
    expect(after!.status).toBe('completed');
    expect(after!.leadCount).toBe(2);
  });

  it('404s for an unknown sessionId', async () => {
    const token = await freshToken();
    await request(app())
      .post('/api/extension/finish')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionId: randomUUID() })
      .expect(404);
  });

  it('requires a valid Bearer token', async () => {
    await request(app())
      .post('/api/extension/finish')
      .set('Authorization', 'Bearer wrong')
      .send({ sessionId: randomUUID() })
      .expect(401);
    await request(app())
      .post('/api/extension/leads')
      .set('Authorization', 'Bearer wrong')
      .send({ sessionId: randomUUID(), page: 1, leads: [lead()] })
      .expect(401);
  });
});
