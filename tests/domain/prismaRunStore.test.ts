import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaRunStore } from '../../src/domain/prismaRunStore';

describe('PrismaRunStore local-first checkpoints', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'leads-genx-prisma-'));
  const databaseUrl = `file:${join(tempDir, 'test.db').replace(/\\/g, '/')}`;
  let prisma: PrismaClient;

  beforeAll(async () => {
    execFileSync(process.execPath, [join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--skip-generate'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('upserts one batch and one canonical business while preserving merged fields', async () => {
    const run = await prisma.run.create({
      data: { actorId: 'local_first', leadSource: 'google_maps', status: 'running', maxResults: 100 },
    });
    const store = new PrismaRunStore(prisma);

    await store.upsertBatch(run.id, { batchKey: 'abc', query: 'dentist Austin, TX', status: 'pending' });
    await store.upsertBatch(run.id, { batchKey: 'abc', query: 'dentist Austin, TX', status: 'completed', resultCount: 2 });
    expect(await prisma.runBatch.count({ where: { runId: run.id } })).toBe(1);

    await store.upsertBusiness(run.id, {
      identityKey: 'place:123',
      companyName: 'Austin Dental',
      website: 'https://dental.example.com',
      provenance: ['local'],
    });
    await store.upsertBusiness(run.id, {
      identityKey: 'place:123',
      companyName: 'Austin Dental',
      phone: '512-555-0100',
      provenance: ['google'],
    });

    expect(await prisma.discoveredBusiness.count({ where: { runId: run.id } })).toBe(1);
    expect(await store.listBusinesses(run.id)).toContainEqual(expect.objectContaining({
      identityKey: 'place:123',
      website: 'https://dental.example.com',
      phone: '512-555-0100',
      provenance: ['local', 'google'],
    }));
  });
});
