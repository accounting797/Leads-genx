import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { promisify } from 'util';
import type { PrismaClient } from '@prisma/client';

const scrypt = promisify(scryptCallback);

export type UserRole = 'ADMIN' | 'USER';
export type UserTier = 'STANDARD' | 'HYBRID';
export type UserStatus = 'ACTIVE' | 'DISABLED';

export interface AuthUser {
  id: number;
  username: string;
  role: UserRole;
  tier: UserTier;
  status: UserStatus;
}

export const SESSION_COOKIE = 'lgx_session';
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

const SCRYPT_KEY_LENGTH = 64;
const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 8;

export function validateUsername(username: unknown): string {
  const value = String(username ?? '').trim();
  if (!USERNAME_PATTERN.test(value)) {
    throw new AuthValidationError('Username must be 3-32 characters: letters, numbers, dot, dash, underscore.', 'username');
  }
  return value;
}

export function validatePassword(password: unknown, field = 'password'): string {
  const value = String(password ?? '');
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new AuthValidationError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, field);
  }
  return value;
}

export class AuthValidationError extends Error {
  fields: Record<string, string>;

  constructor(message: string, field: string) {
    super(message);
    this.fields = { [field]: message };
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, SCRYPT_KEY_LENGTH)) as Buffer;
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = String(stored).split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const derived = (await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length)) as Buffer;
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

export function toAuthUser(record: {
  id: number;
  username: string;
  role: string;
  tier: string;
  status: string;
}): AuthUser {
  return {
    id: record.id,
    username: record.username,
    role: record.role === 'ADMIN' ? 'ADMIN' : 'USER',
    tier: record.tier === 'HYBRID' ? 'HYBRID' : 'STANDARD',
    status: record.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
  };
}

type SessionStore = Pick<PrismaClient, 'session' | 'user'>;

export async function createSession(prisma: SessionStore, userId: number): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({ data: { token, userId, expiresAt } });
  return { token, expiresAt };
}

export async function destroySession(prisma: SessionStore, token: string): Promise<void> {
  try {
    await prisma.session.delete({ where: { token } });
  } catch {
    // Already gone — logout stays idempotent.
  }
}

export async function resolveSession(prisma: SessionStore, token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { token },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    await destroySession(prisma, token);
    return null;
  }
  if (session.user.status !== 'ACTIVE') return null;
  return toAuthUser(session.user);
}

export async function userCount(prisma: Pick<PrismaClient, 'user'>): Promise<number> {
  return prisma.user.count();
}

export function parseSessionToken(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) {
      const value = rest.join('=').trim();
      return value || undefined;
    }
  }
  return undefined;
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (process.env.LGX_SECURE_COOKIES === 'true') parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
}

/**
 * Attaches the authenticated user to res.locals.user when a valid session
 * cookie is present. Never rejects — enforcement lives in requireAuth.
 */
export function attachUser(prisma: SessionStore | undefined) {
  return async (req: Request, res: Response, next: NextFunction) => {
    res.locals.user = null;
    if (!prisma?.session) {
      next();
      return;
    }
    try {
      res.locals.user = await resolveSession(prisma, parseSessionToken(req.headers.cookie));
    } catch {
      res.locals.user = null;
    }
    next();
  };
}

export function currentUser(res: Response): AuthUser | null {
  return (res.locals.user as AuthUser | null) ?? null;
}

export function requireAuth(_req: Request, res: Response, next: NextFunction): void {
  if (!currentUser(res)) {
    res.status(401).json({ error: 'Sign in required.' });
    return;
  }
  next();
}

export function requireAdmin(_req: Request, res: Response, next: NextFunction): void {
  const user = currentUser(res);
  if (!user) {
    res.status(401).json({ error: 'Sign in required.' });
    return;
  }
  if (user.role !== 'ADMIN') {
    res.status(403).json({ error: 'Admin access required.' });
    return;
  }
  next();
}

/** run ownership: admins see everything, users only their own runs. */
export function canAccessRun(user: AuthUser | null, run: { userId: number | null }): boolean {
  if (!user) return true; // auth disabled (tests/legacy)
  if (user.role === 'ADMIN') return true;
  return run.userId === user.id;
}
