import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/db/client';
import { createHiringSignalService } from '../../src/domain/hiringSignalService';
import type { StarterGreenhouseBoard } from '../../src/domain/greenhouseStarterBoards';
import type { GreenhouseJob } from '../../src/integrations/greenhouseClient';

const recentJobs: GreenhouseJob[] = [
  {
    id: 1,
    title: 'VP of Operations',
    location: 'Dallas, TX',
    departments: ['Operations'],
    updatedAt: '2026-07-24T00:00:00Z',
    absoluteUrl: 'https://boards.greenhouse.io/example/jobs/1',
  },
  {
    id: 2,
    title: 'Regional Sales Director',
    location: 'Dallas, TX',
    departments: ['Sales'],
    updatedAt: '2026-07-23T00:00:00Z',
    absoluteUrl: 'https://boards.greenhouse.io/example/jobs/2',
  },
  {
    id: 3,
    title: 'Financial Controller',
    location: 'Dallas, TX',
    departments: ['Finance'],
    updatedAt: '2026-07-22T00:00:00Z',
    absoluteUrl: 'https://boards.greenhouse.io/example/jobs/3',
  },
];

function starter(index: number): StarterGreenhouseBoard {
  return {
    boardToken: `starter-${index}`,
    companyName: `Starter ${index}`,
    companyDomain: `starter${index}.test`,
    industry: 'Logistics',
    geographies: ['Dallas, TX'],
  };
}

async function companyRun(status = 'completed') {
  const run = await prisma.run.create({
    data: {
      status,
      leadSource: 'google_maps',
      actorId: 'test',
      maxResults: 10,
      leadCount: 2,
      businessCount: 1,
      filterJson: JSON.stringify({
        googleMaps: {
          categoryFilters: ['Logistics'],
          locations: ['Dallas, TX'],
          searchTerms: ['Operations'],
        },
      }),
    },
  });
  await prisma.discoveredBusiness.create({
    data: {
      runId: run.id,
      identityKey: 'domain:acme.test',
      companyName: 'Acme Logistics',
      categoryName: 'Logistics',
      website: 'https://acme.test',
      address: 'Dallas, TX',
    },
  });
  return run;
}

async function waitForTerminalScan(runId: number) {
  await vi.waitFor(
    async () => {
      const scan = await prisma.hiringSignalScan.findFirst({
        where: { runId },
        orderBy: { id: 'desc' },
      });
      expect(scan?.status).toMatch(/completed|partially_completed|failed/);
    },
    { timeout: 5_000 }
  );
}

describe('hiring signal persistence', () => {
  beforeEach(async () => {
    await prisma.hiringOpportunity.deleteMany();
    await prisma.hiringSignalScan.deleteMany();
    await prisma.greenhouseBoard.deleteMany();
    await prisma.discoveredBusiness.deleteMany();
    await prisma.lead.deleteMany();
    await prisma.run.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('stores hiring observations without creating leads or changing run counts', async () => {
    const run = await prisma.run.create({
      data: {
        status: 'completed',
        leadSource: 'google_maps',
        actorId: 'test',
        maxResults: 10,
        leadCount: 2,
      },
    });
    const scan = await prisma.hiringSignalScan.create({
      data: { runId: run.id, status: 'queued' },
    });

    await prisma.hiringOpportunity.create({
      data: {
        scanId: scan.id,
        runId: run.id,
        companyKey: 'domain:acme.test',
        companyName: 'Acme',
        companyDomain: 'acme.test',
        originLane: 'google_maps',
        score: 82,
        scoreJson: '{"roles":35,"recency":25,"geography":15,"industry":5,"breadth":2}',
        jobsJson: '[]',
        evidenceUrl: 'https://boards.greenhouse.io/acme',
        evidenceFingerprint: 'acme-v1',
        relationship: 'exact',
      },
    });

    expect(await prisma.lead.count({ where: { runId: run.id } })).toBe(0);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).leadCount).toBe(2);
  });

  it('deduplicates normalized company identities within one scan', async () => {
    const run = await prisma.run.create({
      data: { status: 'completed', leadSource: 'google_maps', actorId: 'test', maxResults: 10 },
    });
    const scan = await prisma.hiringSignalScan.create({
      data: { runId: run.id, status: 'queued' },
    });
    const data = {
      scanId: scan.id,
      runId: run.id,
      companyKey: 'domain:acme.test',
      companyName: 'Acme',
      companyDomain: 'acme.test',
      originLane: 'hiring_opportunity',
      score: 88,
      scoreJson: '{}',
      jobsJson: '[]',
      evidenceUrl: 'https://boards.greenhouse.io/acme',
      evidenceFingerprint: 'v1',
      relationship: 'adjacent',
    };

    await prisma.hiringOpportunity.create({ data });
    await expect(prisma.hiringOpportunity.create({ data })).rejects.toThrow();
  });

  it.each(['failed', 'cancelled', 'paused', 'waiting_for_credentials'])(
    'does not schedule an automatic scan for a %s run',
    async (status) => {
      const run = await companyRun(status);
      const service = createHiringSignalService({
        prisma,
        greenhouseClient: { listJobs: vi.fn(async () => recentJobs) },
        starterBoards: [],
        now: () => new Date('2026-07-25T00:00:00Z'),
      });

      await expect(service.scheduleIfEligible(run.id)).resolves.toEqual({
        scheduled: false,
        reason: 'ineligible_status',
      });
      expect(await prisma.hiringSignalScan.count({ where: { runId: run.id } })).toBe(0);
    }
  );

  it('keeps exact Google matches separate and caps adjacent opportunities at five', async () => {
    const run = await companyRun();
    await prisma.greenhouseBoard.create({
      data: {
        boardToken: 'acme',
        companyKey: 'domain:acme.test',
        companyName: 'Acme Logistics',
        companyDomain: 'acme.test',
        industry: 'Logistics',
        geographiesJson: '["Dallas, TX"]',
        evidenceUrl: 'https://boards.greenhouse.io/acme',
        discoverySource: 'website',
      },
    });
    const listJobs = vi.fn(async () => recentJobs);
    const service = createHiringSignalService({
      prisma,
      greenhouseClient: { listJobs },
      starterBoards: Array.from({ length: 7 }, (_, index) => starter(index + 1)),
      now: () => new Date('2026-07-25T00:00:00Z'),
    });

    const scheduled = await service.scheduleIfEligible(run.id);
    expect(scheduled.scheduled).toBe(true);
    await waitForTerminalScan(run.id);
    const result = await service.getRunSignals(run.id);

    expect(result.matches.google_maps).toHaveLength(1);
    expect(result.matches.google_maps[0]).toMatchObject({
      companyName: 'Acme Logistics',
      originLane: 'google_maps',
    });
    expect(result.matches.sales_navigator).toEqual([]);
    expect(result.opportunities).toHaveLength(5);
    expect(result.opportunities.every((item) => item.originLane === 'hiring_opportunity')).toBe(true);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).leadCount).toBe(2);
  });

  it('uses a fresh six-hour cache automatically but bypasses it for manual refresh', async () => {
    const run = await companyRun();
    await prisma.greenhouseBoard.create({
      data: {
        boardToken: 'acme',
        companyKey: 'domain:acme.test',
        companyName: 'Acme Logistics',
        companyDomain: 'acme.test',
        industry: 'Logistics',
        geographiesJson: '["Dallas, TX"]',
        evidenceUrl: 'https://boards.greenhouse.io/acme',
        discoverySource: 'website',
        jobsJson: JSON.stringify(recentJobs),
        fetchedAt: new Date('2026-07-25T00:00:00Z'),
        verifiedAt: new Date('2026-07-25T00:00:00Z'),
      },
    });
    const listJobs = vi.fn(async () => recentJobs);
    const service = createHiringSignalService({
      prisma,
      greenhouseClient: { listJobs },
      starterBoards: [],
      now: () => new Date('2026-07-25T01:00:00Z'),
    });

    await service.scheduleIfEligible(run.id);
    await waitForTerminalScan(run.id);
    expect(listJobs).not.toHaveBeenCalled();

    await service.refresh(run.id);
    await vi.waitFor(() => expect(listJobs).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    await waitForTerminalScan(run.id);
  });

  it('runs at most two scans across the application', async () => {
    const runs = await Promise.all([companyRun(), companyRun(), companyRun()]);
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const listJobs = vi.fn(
      () =>
        new Promise<GreenhouseJob[]>((resolve) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          releases.push(() => {
            active -= 1;
            resolve(recentJobs);
          });
        })
    );
    const service = createHiringSignalService({
      prisma,
      greenhouseClient: { listJobs },
      starterBoards: [starter(1)],
      now: () => new Date('2026-07-25T00:00:00Z'),
      maxConcurrentScans: 2,
    });

    await Promise.all(runs.map((run) => service.refresh(run.id)));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(listJobs).toHaveBeenCalledTimes(3), { timeout: 5_000 });
    releases.splice(0).forEach((release) => release());
    await Promise.all(runs.map((run) => waitForTerminalScan(run.id)));

    expect(maximumActive).toBe(2);
  });

  it('recovers queued and interrupted scans after restart', async () => {
    const first = await companyRun();
    const second = await companyRun();
    await prisma.hiringSignalScan.createMany({
      data: [
        { runId: first.id, status: 'queued' },
        { runId: second.id, status: 'running', heartbeatAt: new Date('2026-07-24T00:00:00Z') },
      ],
    });
    const service = createHiringSignalService({
      prisma,
      greenhouseClient: { listJobs: vi.fn(async () => recentJobs) },
      starterBoards: [starter(1)],
      now: () => new Date('2026-07-25T00:00:00Z'),
    });

    await service.recoverInterruptedScans();
    await Promise.all([waitForTerminalScan(first.id), waitForTerminalScan(second.id)]);
    expect(
      await prisma.hiringSignalScan.count({
        where: { status: { in: ['queued', 'running'] } },
      })
    ).toBe(0);
  });
});
