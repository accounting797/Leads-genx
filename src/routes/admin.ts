import { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import {
  AuthValidationError,
  currentUser,
  hashPassword,
  validatePassword,
  validateUsername,
} from '../domain/auth';
import { asyncHandler } from '../utils/asyncHandler';

function userView(user: {
  id: number;
  username: string;
  role: string;
  tier: string;
  status: string;
  createdAt: Date;
  _count?: { runs: number };
  upgradeRequests?: { id: number; status: string; createdAt: Date }[];
}) {
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
  };
}

export function createAdminRouter({ prisma }: { prisma: PrismaClient }) {
  const router = Router();

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
      res.json({ data: users.map(userView) });
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
      const existing = await prisma.user.findUnique({ where: { username } });
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
