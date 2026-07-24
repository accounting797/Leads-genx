import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  AuthValidationError,
  canAccessRun,
  createSession,
  hashPassword,
  parseSessionToken,
  resolveSession,
  SESSION_COOKIE,
  validatePassword,
  validateUsername,
  verifyPassword,
  type AuthUser,
} from '../../src/domain/auth';

describe('password hashing', () => {
  it('round-trips a password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt:')).toBe(true);
    expect(hash).not.toContain('correct horse');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });

  it('rejects malformed stored hashes', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
  });
});

describe('credential validation', () => {
  it('accepts valid usernames and rejects bad ones', () => {
    expect(validateUsername('client.jane-01')).toBe('client.jane-01');
    expect(() => validateUsername('ab')).toThrow(AuthValidationError);
    expect(() => validateUsername('has spaces')).toThrow(AuthValidationError);
    expect(() => validateUsername('')).toThrow(AuthValidationError);
  });

  it('enforces minimum password length', () => {
    expect(validatePassword('12345678')).toBe('12345678');
    expect(() => validatePassword('short')).toThrow(AuthValidationError);
  });
});

describe('session store', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'leads-genx-auth-'));
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

  it('creates and resolves a session for an active user', async () => {
    const user = await prisma.user.create({
      data: { username: 'session.user', passwordHash: 'x', role: 'USER', tier: 'STANDARD' },
    });
    const session = await createSession(prisma, user.id);
    expect(session.token).toHaveLength(64);
    const resolved = await resolveSession(prisma, session.token);
    expect(resolved).toMatchObject({ id: user.id, username: 'session.user', tier: 'STANDARD' });
  });

  it('rejects unknown, expired, and disabled-user sessions', async () => {
    expect(await resolveSession(prisma, 'does-not-exist')).toBeNull();
    expect(await resolveSession(prisma, undefined)).toBeNull();

    const user = await prisma.user.create({
      data: { username: 'expired.user', passwordHash: 'x' },
    });
    const session = await createSession(prisma, user.id);
    await prisma.session.update({
      where: { token: session.token },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await resolveSession(prisma, session.token)).toBeNull();

    const disabled = await prisma.user.create({
      data: { username: 'disabled.user', passwordHash: 'x', status: 'DISABLED' },
    });
    const disabledSession = await createSession(prisma, disabled.id);
    expect(await resolveSession(prisma, disabledSession.token)).toBeNull();
  });
});

describe('cookie parsing', () => {
  it('extracts the session token from a cookie header', () => {
    expect(parseSessionToken(`other=1; ${SESSION_COOKIE}=abc123; theme=dark`)).toBe('abc123');
    expect(parseSessionToken('other=1')).toBeUndefined();
    expect(parseSessionToken(undefined)).toBeUndefined();
  });
});

describe('run ownership', () => {
  const admin: AuthUser = { id: 1, username: 'admin', role: 'ADMIN', tier: 'HYBRID', status: 'ACTIVE' };
  const user: AuthUser = { id: 2, username: 'user', role: 'USER', tier: 'STANDARD', status: 'ACTIVE' };

  it('admins access everything, users only their own, null user (auth off) everything', () => {
    const mine = { userId: 2 };
    const theirs = { userId: 3 };
    const legacy = { userId: null };
    expect(canAccessRun(admin, theirs)).toBe(true);
    expect(canAccessRun(user, mine)).toBe(true);
    expect(canAccessRun(user, theirs)).toBe(false);
    expect(canAccessRun(user, legacy)).toBe(false);
    expect(canAccessRun(null, theirs)).toBe(true);
  });
});
