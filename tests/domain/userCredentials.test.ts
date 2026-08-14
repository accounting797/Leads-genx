import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  hasUserCredentials,
  listByodUserIds,
  loadUserCredentials,
  saveUserCredentials,
  toSafeUserCredentials,
} from '../../src/domain/userCredentials';

const tempDir = mkdtempSync(join(tmpdir(), 'leads-genx-byod-'));
const databaseUrl = `file:${join(tempDir, 'test.db').replace(/\\/g, '/')}`;
let prisma: PrismaClient;

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

describe('user credentials (BYOD)', () => {
  it('saves and loads a full credential set per user', async () => {
    await saveUserCredentials(prisma, 7, {
      apifyToken: 'user-token-7',
      googleApiKeys: ['key-a', 'key-b'],
      proxyUrls: ['http://user:pass@proxy.example:8080'],
    });
    const creds = await loadUserCredentials(prisma, 7);
    expect(creds.apifyToken).toBe('user-token-7');
    expect(creds.googleApiKeys).toEqual(['key-a', 'key-b']);
    expect(creds.proxyUrls).toEqual(['http://user:pass@proxy.example:8080']);
    expect(hasUserCredentials(creds)).toBe(true);
  });

  it('keeps untouched fields when saving partial updates and clears on blank', async () => {
    await saveUserCredentials(prisma, 7, { apifyToken: 'new-token' });
    let creds = await loadUserCredentials(prisma, 7);
    expect(creds.apifyToken).toBe('new-token');
    expect(creds.googleApiKeys).toEqual(['key-a', 'key-b']);

    await saveUserCredentials(prisma, 7, { apifyToken: '', googleApiKeys: [], proxyUrls: [] });
    creds = await loadUserCredentials(prisma, 7);
    expect(hasUserCredentials(creds)).toBe(false);
    const row = await prisma.appSetting.findUnique({ where: { key: 'userCreds:7' } });
    expect(row).toBeNull();
  });

  it('masks secrets in the safe view and never returns raw values', async () => {
    await saveUserCredentials(prisma, 9, {
      apifyToken: 'super-secret-token-1234',
      brightDataApiKey: 'brightdata-secret-5678',
      proxyUrls: ['http://user:pass@proxy.example:8080'],
    });
    const safe = toSafeUserCredentials(await loadUserCredentials(prisma, 9));
    const serialized = JSON.stringify(safe);
    expect(safe.hasCredentials).toBe(true);
    expect(safe.apifyTokenSet).toBe(true);
    expect(safe.brightDataKeySet).toBe(true);
    expect(safe.brightDataKeyPreview).toBe('••••5678');
    expect(serialized).not.toContain('super-secret-token-1234');
    expect(serialized).not.toContain('brightdata-secret-5678');
    expect(serialized).not.toContain('user:pass@');
  });

  it('lists only users who actually have BYOD credentials', async () => {
    await saveUserCredentials(prisma, 11, { apifyToken: 'token-11' });
    const ids = await listByodUserIds(prisma);
    expect(ids.has(11)).toBe(true);
    expect(ids.has(9)).toBe(true);
    expect(ids.has(12345)).toBe(false);
  });
});
