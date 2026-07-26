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

const tempDir = mkdtempSync(join(tmpdir(), 'leads-genx-hiring-api-'));
const databaseUrl = `file:${join(tempDir, 'test.db').replace(/\\/g, '/')}`;
let prisma: PrismaClient;
let ownerCookie: string;
let otherCookie: string;

const emptySignals = {
  scan: null,
  matches: { google_maps: [], sales_navigator: [] },
  opportunities: [],
};

const hiringSignalService = {
  async scheduleIfEligible() {
    return { scheduled: false, reason: 'test' };
  },
  async recoverInterruptedScans() {},
  async getRunSignals() {
    return emptySignals;
  },
  async refresh() {
    return { scheduled: true, scanId: 9 };
  },
  async updateOpportunity(id: number, patch: { saved?: boolean; dismissed?: boolean }) {
    return { id, ...patch };
  },
  async prepareSearch(_id: number, targetLane: 'google_maps' | 'sales_navigator') {
    return {
      targetLane,
      companyName: 'Acme',
      website: 'https://acme.test',
      industries: ['Software'],
      geographies: ['Austin, TX'],
    };
  },
};

const fakeRunService = {
  async startRun() {
    return { id: 99, status: 'queued', leadSource: 'google_maps' };
  },
};

function app() {
  return createApp({
    prisma,
    runService: fakeRunService as never,
    hiringSignalService: hiringSignalService as never,
  });
}

function cookieOf(res: request.Response): string {
  const value = res.headers['set-cookie'];
  return String(Array.isArray(value) ? value[0] : value).split(';')[0];
}

async function login(username: string, password: string): Promise<string> {
  const response = await request(app()).post('/api/auth/login').send({ username, password }).expect(200);
  return cookieOf(response);
}

beforeAll(async () => {
  execFileSync(
    process.execPath,
    [join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--skip-generate'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe' }
  );
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.user.createMany({
    data: [
      { username: `owner-${randomUUID()}`, passwordHash: await hashPassword('owner-password') },
      { username: `other-${randomUUID()}`, passwordHash: await hashPassword('other-password') },
    ],
  });
  const users = await prisma.user.findMany({ orderBy: { id: 'asc' } });
  ownerCookie = await login(users[0].username, 'owner-password');
  otherCookie = await login(users[1].username, 'other-password');
});

afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('hiring signal API', () => {
  it('keeps another user from reading or refreshing a run', async () => {
    const owner = await prisma.user.findFirstOrThrow({ orderBy: { id: 'asc' } });
    const run = await prisma.run.create({
      data: {
        userId: owner.id,
        status: 'completed',
        leadSource: 'google_maps',
        actorId: 'test',
        maxResults: 10,
      },
    });

    await request(app()).get(`/api/runs/${run.id}/hiring-signals`).set('Cookie', otherCookie).expect(404);
    await request(app()).post(`/api/runs/${run.id}/hiring-signals/refresh`).set('Cookie', otherCookie).expect(404);
    await request(app()).get(`/api/runs/${run.id}/hiring-signals`).set('Cookie', ownerCookie).expect(200);
  });

  it('checks opportunity ownership before updates and search preparation', async () => {
    const owner = await prisma.user.findFirstOrThrow({ orderBy: { id: 'asc' } });
    const run = await prisma.run.create({
      data: {
        userId: owner.id,
        status: 'completed',
        leadSource: 'google_maps',
        actorId: 'test',
        maxResults: 10,
      },
    });
    const scan = await prisma.hiringSignalScan.create({ data: { runId: run.id, status: 'completed' } });
    const opportunity = await prisma.hiringOpportunity.create({
      data: {
        scanId: scan.id,
        runId: run.id,
        companyKey: 'domain:acme.test',
        companyName: 'Acme',
        companyDomain: 'acme.test',
        originLane: 'hiring_opportunity',
        score: 90,
        scoreJson: '{"roles":27,"recency":25,"geography":20,"industry":5,"breadth":5}',
        jobsJson: '[]',
        evidenceUrl: 'https://boards.greenhouse.io/acme',
        evidenceFingerprint: 'acme',
        relationship: 'adjacent',
      },
    });

    await request(app())
      .patch(`/api/hiring-opportunities/${opportunity.id}`)
      .set('Cookie', otherCookie)
      .send({ saved: true })
      .expect(404);
    await request(app())
      .post(`/api/hiring-opportunities/${opportunity.id}/prepare-search`)
      .set('Cookie', ownerCookie)
      .send({ targetLane: 'google_maps' })
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toMatchObject({ targetLane: 'google_maps', companyName: 'Acme' });
      });
  });

  it('filters lead lanes and rejects an unknown source', async () => {
    const owner = await prisma.user.findFirstOrThrow({ orderBy: { id: 'asc' } });
    const run = await prisma.run.create({
      data: {
        userId: owner.id,
        status: 'completed',
        leadSource: 'google_maps',
        actorId: 'test',
        maxResults: 10,
      },
    });
    await prisma.lead.createMany({
      data: [
        {
          runId: run.id,
          leadSource: 'google_maps',
          leadType: 'business',
          companyName: 'Map Co',
          website: 'https://map.test',
        },
        { runId: run.id, leadSource: 'sales_navigator', leadType: 'linkedin_profile', companyName: 'Sales Co' },
      ],
    });
    const scan = await prisma.hiringSignalScan.create({ data: { runId: run.id, status: 'completed' } });
    await prisma.hiringOpportunity.create({
      data: {
        scanId: scan.id,
        runId: run.id,
        companyKey: 'domain:map.test',
        companyName: 'Map Co',
        companyDomain: 'map.test',
        originLane: 'google_maps',
        score: 82,
        scoreJson: '{"roles":27,"recency":25,"geography":20,"industry":5,"breadth":5}',
        jobsJson: '[]',
        explanation: 'A sales leadership role was updated recently.',
        evidenceUrl: 'https://boards.greenhouse.io/mapco',
        evidenceFingerprint: 'mapco',
        relationship: 'exact',
      },
    });

    const maps = await request(app())
      .get(`/api/leads?runId=${run.id}&leadSource=google_maps`)
      .set('Cookie', ownerCookie)
      .expect(200);
    expect(maps.body.data).toHaveLength(1);
    expect(maps.body.data[0].leadSource).toBe('google_maps');
    expect(maps.body.data[0].hiringSignal).toMatchObject({
      score: 82,
      components: {
        roles: 27,
        recency: 25,
        geography: 20,
        industry: 5,
        breadth: 5,
      },
    });
    await request(app()).get('/api/leads?leadSource=unknown').set('Cookie', ownerCookie).expect(400);
  });

  it('prioritizes an existing-company signal and adds at most one partial-scan note', async () => {
    const owner = await prisma.user.findFirstOrThrow({ orderBy: { id: 'asc' } });
    const run = await prisma.run.create({
      data: {
        userId: owner.id,
        status: 'completed',
        leadSource: 'google_maps',
        actorId: 'test',
        maxResults: 10,
        leadCount: 2,
        businessCount: 2,
      },
    });
    const scan = await prisma.hiringSignalScan.create({
      data: {
        runId: run.id,
        status: 'partially_completed',
        completedAt: new Date(),
        errorMessage: 'One public board could not be checked.',
      },
    });
    const baseOpportunity = {
      scanId: scan.id,
      runId: run.id,
      companyDomain: null,
      scoreJson: '{}',
      jobsJson: '[]',
      evidenceUrl: 'https://boards.greenhouse.io/acme',
      relationship: 'adjacent',
    };
    await prisma.hiringOpportunity.createMany({
      data: [
        {
          ...baseOpportunity,
          companyKey: 'name:adjacent',
          companyName: 'Adjacent Co',
          originLane: 'hiring_opportunity',
          score: 99,
          evidenceFingerprint: 'adjacent',
          explanation: 'An adjacent role was updated recently.',
        },
        {
          ...baseOpportunity,
          companyKey: 'name:existing',
          companyName: 'Existing Co',
          originLane: 'google_maps',
          score: 75,
          evidenceFingerprint: 'existing',
          explanation: 'An existing-company role was updated recently.',
          relationship: 'exact',
        },
      ],
    });

    const response = await request(app())
      .get(`/api/runs/${run.id}/analyst`)
      .set('Cookie', ownerCookie)
      .expect(200);
    const hiringLines = response.body.data.lines.filter((line: { text: string }) =>
      line.text.startsWith('Hiring ')
    );

    expect(response.body.data.verdict).toBe('perfect');
    expect(hiringLines).toHaveLength(2);
    expect(hiringLines[0].text).toContain('Existing Co');
    expect(hiringLines[1]).toMatchObject({ tone: 'info' });
    expect(hiringLines[1].text).toContain('Some public hiring boards');
  });
});
