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
import { SHUFFLE_COMBOS } from '../../src/domain/shuffleCombos';

function appWithRuns(runs: Array<{ filterJson: string; leadCount: number }>) {
  let startRunCalls = 0;
  const prismaStub = {
    appSetting: { async findMany() { return []; } },
    run: { async findMany() { return runs; } },
  };
  return {
    app: createApp({
      authDisabled: true,
      prisma: prismaStub as never,
      runService: { async startRun() { startRunCalls += 1; throw new Error('Shuffle must not start a run'); } } as never,
    }),
    startRunCalls: () => startRunCalls,
  };
}

const tempDir = mkdtempSync(join(tmpdir(), 'leads-genx-shuffle-api-'));
const databaseUrl = `file:${join(tempDir, 'test.db').replace(/\\/g, '/')}`;
let prisma: PrismaClient;
let ownerCookie: string;
let otherCookie: string;
let ownerId: number;
let otherId: number;

function authApp() {
  return createApp({
    prisma,
    runService: { async startRun() { throw new Error('Shuffle must not start a run'); } } as never,
  });
}

function cookieOf(res: request.Response): string {
  const header = res.headers['set-cookie'];
  return String(Array.isArray(header) ? header[0] : header).split(';')[0];
}

beforeAll(async () => {
  execFileSync(
    process.execPath,
    [join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--skip-generate'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe' },
  );
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const owner = await prisma.user.create({ data: { username: `shuffle-owner-${randomUUID()}`, passwordHash: await hashPassword('owner-password') } });
  const other = await prisma.user.create({ data: { username: `shuffle-other-${randomUUID()}`, passwordHash: await hashPassword('other-password') } });
  ownerId = owner.id;
  otherId = other.id;
  ownerCookie = cookieOf(await request(authApp()).post('/api/auth/login').send({ username: owner.username, password: 'owner-password' }).expect(200));
  otherCookie = cookieOf(await request(authApp()).post('/api/auth/login').send({ username: other.username, password: 'other-password' }).expect(200));
});

afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('POST /api/shuffle/next', () => {
  it('returns a different Google Maps combination and exact filters', async () => {
    const first = SHUFFLE_COMBOS[0];
    const fixture = appWithRuns([]);
    const res = await request(fixture.app).post('/api/shuffle/next').send({
      source: 'google_maps',
      recentComboIds: [first.id],
      recentCities: [first.city],
      currentComboId: first.id,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.combo.id).not.toBe(first.id);
    expect(res.body.data.combo.city).not.toBe(first.city);
    expect(res.body.data.filters).toEqual({
      searchTerms: [res.body.data.combo.googleMaps.searchTerm],
      categoryFilters: [res.body.data.combo.googleMaps.category],
      companyTypes: [res.body.data.combo.googleMaps.companyType],
      locations: [res.body.data.combo.city],
    });
    expect(fixture.startRunCalls()).toBe(0);
  });

  it('returns exact Sales Navigator filters', async () => {
    const fixture = appWithRuns([]);
    const res = await request(fixture.app).post('/api/shuffle/next').send({ source: 'sales_navigator' });
    expect(res.status).toBe(200);
    expect(res.body.data.filters).toEqual({
      titles: [res.body.data.combo.salesNavigator.title],
      industries: [res.body.data.combo.salesNavigator.industry],
      geographies: [res.body.data.combo.city],
      headcounts: [res.body.data.combo.salesNavigator.headcount],
    });
    expect(fixture.startRunCalls()).toBe(0);
  });

  it('rejects invalid sources and safely ignores stale history', async () => {
    const fixture = appWithRuns([]);
    await request(fixture.app).post('/api/shuffle/next').send({ source: 'wrong' }).expect(400);
    const res = await request(fixture.app).post('/api/shuffle/next').send({
      source: 'google_maps',
      recentComboIds: ['removed-combo'],
      recentCities: ['Unknown'],
    });
    expect(res.status).toBe(200);
    expect(SHUFFLE_COMBOS.some((combo) => combo.id === res.body.data.combo.id)).toBe(true);
    expect(fixture.startRunCalls()).toBe(0);
  });

  it('safely ignores prototype, stale, malformed, and non-object persisted history', async () => {
    const fixture = appWithRuns([
      { filterJson: '{"comboId":"__proto__"}', leadCount: 10 },
      { filterJson: '{"comboId":"removed-combo"}', leadCount: 10 },
      { filterJson: '{not json', leadCount: 10 },
      { filterJson: 'null', leadCount: 10 },
      { filterJson: '[]', leadCount: 10 },
    ]);
    try {
      const res = await request(fixture.app).post('/api/shuffle/next').send({
        source: 'google_maps',
        recentComboIds: ['removed-combo', 42, null, {}],
        recentCities: ['Unknown', 42, null, {}],
        currentComboId: '__proto__',
      });

      expect(res.status).toBe(200);
      expect(SHUFFLE_COMBOS.some((combo) => combo.id === res.body.data.combo.id)).toBe(true);
      expect(Object.prototype).not.toHaveProperty('runs');
      expect(fixture.startRunCalls()).toBe(0);
    } finally {
      delete (Object.prototype as { runs?: unknown }).runs;
      delete (Object.prototype as { leads?: unknown }).leads;
    }
  });

  it('requires authentication and learns only from the requesters run history', async () => {
    await prisma.run.createMany({
      data: SHUFFLE_COMBOS.map((combo) => ({ userId: otherId, status: 'completed', leadSource: 'google_maps', actorId: 'test', maxResults: 10, filterJson: JSON.stringify({ comboId: combo.id }), leadCount: 100 })),
    });

    await request(authApp()).post('/api/shuffle/next').send({ source: 'google_maps' }).expect(401);
    const res = await request(authApp()).post('/api/shuffle/next').set('Cookie', ownerCookie).send({ source: 'google_maps' }).expect(200);

    expect(res.body.data.freshTerritory).toBe(true);
    const other = await request(authApp()).post('/api/shuffle/next').set('Cookie', otherCookie).send({ source: 'google_maps' }).expect(200);
    expect(other.body.data.freshTerritory).toBe(false);
  });
});
