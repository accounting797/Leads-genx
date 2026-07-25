import { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import {
  AuthValidationError,
  currentUser,
  findUserByUsername,
  hashPassword,
  validatePassword,
  validateUsername,
} from '../domain/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { DeployConflictError, DeployService } from '../domain/deployService';
import { loadOperatorSettings } from '../domain/operatorSettings';
import { listByodUserIds } from '../domain/userCredentials';

function userView(
  user: {
    id: number;
    username: string;
    role: string;
    tier: string;
    status: string;
    createdAt: Date;
    _count?: { runs: number };
    upgradeRequests?: { id: number; status: string; createdAt: Date }[];
  },
  byodIds?: Set<number>
) {
  const pending = user.upgradeRequests?.find((request) => request.status === 'PENDING');
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    tier: user.tier,
    status: user.status,
    createdAt: user.createdAt,
    runCount: user._count?.runs ?? 0,
    pendingUpgradeRequestId: pending?.id ?? null,
    hasOwnCredentials: byodIds?.has(user.id) ?? false,
  };
}

export function createAdminRouter({ prisma, deployService }: { prisma: PrismaClient; deployService?: DeployService }) {
  const router = Router();

  // ---------------- Server deployment wizard ----------------

  // Remember where the server lives (never any secrets) so updates are a
  // one-password affair next time.
  const DEPLOY_TARGET_KEY = 'deployTarget';
  async function saveDeployTarget(host: string, domain?: string): Promise<void> {
    try {
      const value = JSON.stringify({ host, domain: domain || undefined });
      await prisma.appSetting.upsert({
        where: { key: DEPLOY_TARGET_KEY },
        create: { key: DEPLOY_TARGET_KEY, value, secret: false },
        update: { value },
      });
    } catch {
      // Pre-filling the form next time is a nicety, never a blocker.
    }
  }
  async function loadDeployTarget(): Promise<{ host?: string; domain?: string } | undefined> {
    try {
      const rows = await prisma.appSetting.findMany({ where: { key: DEPLOY_TARGET_KEY } });
      if (!rows.length) return undefined;
      const parsed = JSON.parse(rows[0].value);
      return parsed && typeof parsed === 'object' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  router.post(
    '/deploy',
    asyncHandler(async (req, res) => {
      if (!deployService) {
        res.status(503).json({ error: 'Deployment service unavailable.' });
        return;
      }
      const admin = currentUser(res)!;
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const host = String(body.host ?? '').trim();
      const rootPassword = String(body.rootPassword ?? '');
      const githubToken = String(body.githubToken ?? '').trim();
      const domain = String(body.domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      const adminPassword = String(body.adminPassword ?? '');
      const fieldErrors: Record<string, string> = {};
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) fieldErrors.host = 'Enter the server IP (e.g. 203.0.113.10).';
      if (!rootPassword) fieldErrors.rootPassword = 'Root password is required.';
      if (!githubToken) fieldErrors.githubToken = 'GitHub token is required to download the code on the server.';
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) fieldErrors.domain = 'Enter a domain like leadsgenx.com.';
      if (adminPassword.length < 8) fieldErrors.adminPassword = 'Admin password must be at least 8 characters.';
      if (Object.keys(fieldErrors).length) {
        res.status(400).json({ error: 'Check the highlighted fields.', fields: fieldErrors });
        return;
      }

      // Copy the operator's saved credentials so the new server is ready to work.
      let settings: Record<string, unknown> | undefined;
      try {
        const saved = await loadOperatorSettings(prisma);
        settings = {
          apifyToken: saved.apifyToken,
          googleApiKeys: saved.googleApiKeys,
          proxyUrls: saved.proxyUrls,
          defaultGoogleMapsActorId: saved.defaultGoogleMapsActorId,
          defaultSalesNavigatorActorId: saved.defaultSalesNavigatorActorId,
        };
      } catch {
        settings = undefined;
      }

      try {
        const state = deployService.start({
          host,
          rootPassword,
          githubToken,
          domain,
          adminUsername: admin.username,
          adminPassword,
          settings: settings as never,
        });
        void saveDeployTarget(host, domain);
        res.status(202).json({ data: { phase: state.phase } });
      } catch (error) {
        if (error instanceof DeployConflictError) {
          res.status(409).json({ error: error.message });
          return;
        }
        throw error;
      }
    })
  );

  // One-click server update: pull latest code on the server, rebuild, restart,
  // verify. No domain, token, or DNS wait — the server already has everything.
  router.post(
    '/deploy/update',
    asyncHandler(async (req, res) => {
      if (!deployService?.startUpdate) {
        res.status(503).json({ error: 'Update service unavailable.' });
        return;
      }
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const host = String(body.host ?? '').trim();
      const rootPassword = String(body.rootPassword ?? '');
      const saved = await loadDeployTarget();
      const domain =
        String(body.domain ?? '')
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//, '')
          .replace(/\/.*$/, '') || saved?.domain;
      const githubToken = String(body.githubToken ?? '').trim() || undefined;
      const fieldErrors: Record<string, string> = {};
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) fieldErrors.host = 'Enter the server IP (e.g. 203.0.113.10).';
      if (!rootPassword) fieldErrors.rootPassword = 'Root password is required.';
      if (githubToken && githubToken.length < 20) fieldErrors.githubToken = 'That token looks too short — paste the full GitHub token.';
      if (Object.keys(fieldErrors).length) {
        res.status(400).json({ error: 'Check the highlighted fields.', fields: fieldErrors });
        return;
      }

      try {
        const state = deployService.startUpdate({
          host,
          rootPassword,
          ...(domain ? { domain } : {}),
          ...(githubToken ? { githubToken } : {}),
        });
        void saveDeployTarget(host, domain);
        res.status(202).json({ data: { phase: state.phase } });
      } catch (error) {
        if (error instanceof DeployConflictError) {
          res.status(409).json({ error: error.message });
          return;
        }
        throw error;
      }
    })
  );

  router.get(
    '/deploy',
    asyncHandler(async (_req, res) => {
      if (!deployService) {
        res.status(503).json({ error: 'Deployment service unavailable.' });
        return;
      }
      const savedTarget = await loadDeployTarget();
      res.json({ data: { ...deployService.getState(), savedTarget } });
    })
  );

  router.post(
    '/deploy/recheck',
    asyncHandler(async (_req, res) => {
      if (!deployService) {
        res.status(503).json({ error: 'Deployment service unavailable.' });
        return;
      }
      deployService.recheckNow();
      res.json({ data: { ok: true } });
    })
  );

  router.get(
    '/users',
    asyncHandler(async (_req, res) => {
      const users = await prisma.user.findMany({
        orderBy: { createdAt: 'asc' },
        include: {
          _count: { select: { runs: true } },
          upgradeRequests: { where: { status: 'PENDING' }, select: { id: true, status: true, createdAt: true } },
        },
      });
      const byodIds = await listByodUserIds(prisma);
      res.json({ data: users.map((user) => userView(user, byodIds)) });
    })
  );

  router.post(
    '/users',
    asyncHandler(async (req, res) => {
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const username = validateUsername(body.username);
      const password = validatePassword(body.password);
      const tier = body.tier === 'HYBRID' ? 'HYBRID' : 'STANDARD';
      const role = body.role === 'ADMIN' ? 'ADMIN' : 'USER';
      const existing = await findUserByUsername(prisma, username);
      if (existing) {
        res.status(409).json({ error: 'That username is already taken.', fields: { username: 'Already taken.' } });
        return;
      }
      const user = await prisma.user.create({
        data: {
          username,
          passwordHash: await hashPassword(password),
          tier,
          role,
        },
        include: { _count: { select: { runs: true } } },
      });
      res.status(201).json({ data: userView(user) });
    })
  );

  router.patch(
    '/users/:id',
    asyncHandler(async (req, res) => {
      const admin = currentUser(res)!;
      const id = Number(req.params.id);
      const target = await prisma.user.findUnique({ where: { id } });
      if (!target) {
        res.status(404).json({ error: 'User not found.' });
        return;
      }
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const data: Record<string, unknown> = {};

      if (body.tier !== undefined) {
        if (body.tier !== 'STANDARD' && body.tier !== 'HYBRID') {
          res.status(400).json({ error: 'Tier must be STANDARD or HYBRID.' });
          return;
        }
        if (id === admin.id && body.tier !== 'HYBRID' && target.role === 'ADMIN') {
          res.status(400).json({ error: 'You cannot change your own admin tier.' });
          return;
        }
        data.tier = body.tier;
      }
      if (body.status !== undefined) {
        if (body.status !== 'ACTIVE' && body.status !== 'DISABLED') {
          res.status(400).json({ error: 'Status must be ACTIVE or DISABLED.' });
          return;
        }
        if (id === admin.id) {
          res.status(400).json({ error: 'You cannot disable your own account.' });
          return;
        }
        data.status = body.status;
        // Disabling kills every live session immediately.
        if (body.status === 'DISABLED') {
          await prisma.session.deleteMany({ where: { userId: id } });
        }
      }
      if (body.password !== undefined && body.password !== null && String(body.password) !== '') {
        data.passwordHash = await hashPassword(validatePassword(body.password));
        await prisma.session.deleteMany({ where: { userId: id } });
      }

      const updated = await prisma.user.update({
        where: { id },
        data,
        include: { _count: { select: { runs: true } } },
      });
      res.json({ data: userView(updated) });
    })
  );

  router.delete(
    '/users/:id',
    asyncHandler(async (req, res) => {
      const admin = currentUser(res)!;
      const id = Number(req.params.id);
      if (id === admin.id) {
        res.status(400).json({ error: 'You cannot delete your own account.' });
        return;
      }
      const target = await prisma.user.findUnique({ where: { id } });
      if (!target) {
        res.status(404).json({ error: 'User not found.' });
        return;
      }
      await prisma.user.delete({ where: { id } });
      res.status(204).send();
    })
  );

  router.get(
    '/upgrade-requests',
    asyncHandler(async (_req, res) => {
      const requests = await prisma.upgradeRequest.findMany({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        include: { user: { select: { id: true, username: true, tier: true } } },
      });
      res.json({
        data: requests.map((request) => ({
          id: request.id,
          status: request.status,
          createdAt: request.createdAt,
          user: request.user,
        })),
      });
    })
  );

  router.post(
    '/upgrade-requests/:id/approve',
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const request = await prisma.upgradeRequest.findUnique({ where: { id } });
      if (!request || request.status !== 'PENDING') {
        res.status(404).json({ error: 'Pending upgrade request not found.' });
        return;
      }
      await prisma.$transaction([
        prisma.upgradeRequest.update({
          where: { id },
          data: { status: 'APPROVED', resolvedAt: new Date() },
        }),
        prisma.user.update({ where: { id: request.userId }, data: { tier: 'HYBRID' } }),
      ]);
      res.json({ data: { id, status: 'APPROVED' } });
    })
  );

  router.post(
    '/upgrade-requests/:id/deny',
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const request = await prisma.upgradeRequest.findUnique({ where: { id } });
      if (!request || request.status !== 'PENDING') {
        res.status(404).json({ error: 'Pending upgrade request not found.' });
        return;
      }
      await prisma.upgradeRequest.update({
        where: { id },
        data: { status: 'DENIED', resolvedAt: new Date() },
      });
      res.json({ data: { id, status: 'DENIED' } });
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
