import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/client';

describe('hiring signal persistence', () => {
  beforeEach(async () => {
    await prisma.hiringOpportunity.deleteMany();
    await prisma.hiringSignalScan.deleteMany();
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
});
