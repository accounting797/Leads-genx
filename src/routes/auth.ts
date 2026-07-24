import { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import {
  AuthValidationError,
  clearSessionCookie,
  createSession,
  currentUser,
  destroySession,
  hashPassword,
  parseSessionToken,
  requireAuth,
  setSessionCookie,
  toAuthUser,
  userCount,
  validatePassword,
  validateUsername,
  verifyPassword,
} from '../domain/auth';
import { asyncHandler } from '../utils/asyncHandler';
import {
  loadUserCredentials,
  saveUserCredentials,
  toSafeUserCredentials,
} from '../domain/userCredentials';
import { unquarantineCredential } from '../domain/operatorSettings';

type CredentialTester = {
  testApifyToken?: (token: string) => Promise<{ ok: boolean; detail: string }>;
  testGoogleKey?: (key: string) => Promise<{ ok: boolean; detail: string }>;
};

function splitLines(value: unknown): string[] {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function publicUser(user: { id: number; username: string; role: string; tier: string; status: string; createdAt?: Date }) {
  const auth = toAuthUser(user);
  return {
    id: auth.id,
    username: auth.username,
    role: auth.role,
    tier: auth.tier,
    status: auth.status,
  };
}

export function createAuthRouter({ prisma, credentialTester }: { prisma: PrismaClient; credentialTester?: CredentialTester }) {
  const router = Router();

  // Who am I? Also tells a fresh install that first-run setup is needed.
  router.get(
    '/me',
    asyncHandler(async (_req, res) => {
      const user = currentUser(res);
      if (!user) {
        const needsSetup = (await userCount(prisma)) === 0;
        res.status(401).json({ error: 'Not signed in.', needsSetup });
        return;
      }
      res.json({ data: { user: publicUser(user) } });
    })
  );

  // First-run bootstrap: creates the initial ADMIN. Only works while no
  // users exist — after that it locks forever.
  router.post(
    '/setup',
    asyncHandler(async (req, res) => {
      if ((await userCount(prisma)) > 0) {
        res.status(403).json({ error: 'Setup already completed. Sign in instead.' });
        return;
      }
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const username = validateUsername(body.username);
      const password = validatePassword(body.password);
      const user = await prisma.user.create({
        data: {
          username,
          passwordHash: await hashPassword(password),
          role: 'ADMIN',
          tier: 'HYBRID',
        },
      });
      const session = await createSession(prisma, user.id);
      setSessionCookie(res, session.token, session.expiresAt);
      res.status(201).json({ data: { user: publicUser(user) } });
    })
  );

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const username = String(body.username ?? '').trim();
      const password = String(body.password ?? '');
      const user = await prisma.user.findUnique({ where: { username } });
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        res.status(401).json({ error: 'Invalid username or password.' });
        return;
      }
      if (user.status !== 'ACTIVE') {
        res.status(403).json({ error: 'This account has been disabled. Contact your administrator.' });
        return;
      }
      const session = await createSession(prisma, user.id);
      setSessionCookie(res, session.token, session.expiresAt);
      res.json({ data: { user: publicUser(user) } });
    })
  );

  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      const token = parseSessionToken(req.headers.cookie);
      if (token) await destroySession(prisma, token);
      clearSessionCookie(res);
      res.json({ data: { ok: true } });
    })
  );

  // Change own password (any signed-in user).
  router.post(
    '/password',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = currentUser(res)!;
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const current = String(body.currentPassword ?? '');
      const next = validatePassword(body.newPassword, 'newPassword');
      const record = await prisma.user.findUnique({ where: { id: user.id } });
      if (!record || !(await verifyPassword(current, record.passwordHash))) {
        res.status(400).json({ error: 'Current password is incorrect.', fields: { currentPassword: 'Incorrect password.' } });
        return;
      }
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(next) },
      });
      res.json({ data: { ok: true } });
    })
  );

  // User asks the admin for a Hybrid upgrade.
  router.post(
    '/request-upgrade',
    requireAuth,
    asyncHandler(async (_req, res) => {
      const user = currentUser(res)!;
      if (user.tier === 'HYBRID' || user.role === 'ADMIN') {
        res.status(409).json({ error: 'Your account already has Hybrid access.' });
        return;
      }
      const pending = await prisma.upgradeRequest.findFirst({
        where: { userId: user.id, status: 'PENDING' },
      });
      if (pending) {
        res.status(409).json({ error: 'An upgrade request is already pending for your account.' });
        return;
      }
      const request = await prisma.upgradeRequest.create({ data: { userId: user.id } });
      res.status(201).json({ data: { id: request.id, status: request.status } });
    })
  );

  // ---------------- BYOD: per-user credentials ----------------

  router.get(
    '/credentials',
    requireAuth,
    asyncHandler(async (_req, res) => {
      const user = currentUser(res)!;
      const creds = await loadUserCredentials(prisma, user.id);
      res.json({ data: toSafeUserCredentials(creds) });
    })
  );

  router.post(
    '/credentials',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = currentUser(res)!;
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      await saveUserCredentials(prisma, user.id, {
        apifyToken: body.apifyToken !== undefined ? String(body.apifyToken) : undefined,
        googleApiKeys: body.googleApiKeys !== undefined ? splitLines(body.googleApiKeys) : undefined,
        proxyUrls: body.proxyUrls !== undefined ? splitLines(body.proxyUrls) : undefined,
      });
      const creds = await loadUserCredentials(prisma, user.id);
      res.json({ data: toSafeUserCredentials(creds) });
    })
  );

  router.post(
    '/credentials/test/apify',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = currentUser(res)!;
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const provided = String(body.token ?? '').trim();
      const creds = await loadUserCredentials(prisma, user.id);
      const token = provided || creds.apifyToken || '';
      if (!token) {
        res.status(400).json({ error: 'Save or paste an Apify token first.' });
        return;
      }
      if (!credentialTester?.testApifyToken) {
        res.status(503).json({ error: 'Credential testing unavailable.' });
        return;
      }
      const result = await credentialTester.testApifyToken(token);
      if (result.ok && (await unquarantineCredential(prisma, token))) {
        result.detail += ' — quarantine cleared, the engineer trusts this token again';
      }
      res.json({ data: result });
    })
  );

  router.post(
    '/credentials/test/google',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = currentUser(res)!;
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const provided = String(body.key ?? '').trim();
      const creds = await loadUserCredentials(prisma, user.id);
      const key = provided || creds.googleApiKeys[0] || '';
      if (!key) {
        res.status(400).json({ error: 'Save or paste a Google API key first.' });
        return;
      }
      if (!credentialTester?.testGoogleKey) {
        res.status(503).json({ error: 'Credential testing unavailable.' });
        return;
      }
      const result = await credentialTester.testGoogleKey(key);
      if (result.ok && (await unquarantineCredential(prisma, key))) {
        result.detail += ' — quarantine cleared, the engineer trusts this key again';
      }
      res.json({ data: result });
    })
  );

  router.use((error: unknown, _req: unknown, res: import('express').Response, next: import('express').NextFunction) => {
    if (error instanceof AuthValidationError) {
      res.status(400).json({ error: error.message, fields: error.fields });
      return;
    }
    next(error);
  });

  return router;
}
