import type { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { canAccessRun, currentUser } from '../domain/auth';
import type { HiringSignalService } from '../domain/hiringSignalService';
import { asyncHandler } from '../utils/asyncHandler';

export function createHiringSignalsRouter({
  prisma,
  service,
}: {
  prisma: PrismaClient;
  service: HiringSignalService;
}) {
  const router = Router();

  async function ownedRun(runId: number, res: Parameters<typeof currentUser>[0]) {
    if (!Number.isInteger(runId) || runId < 1) return null;
    const run = await prisma.run.findUnique({ where: { id: runId }, select: { id: true, userId: true } });
    return run && canAccessRun(currentUser(res), run) ? run : null;
  }

  async function ownedOpportunity(id: number, res: Parameters<typeof currentUser>[0]) {
    if (!Number.isInteger(id) || id < 1) return null;
    const opportunity = await prisma.hiringOpportunity.findUnique({
      where: { id },
      include: { run: { select: { userId: true } } },
    });
    return opportunity && canAccessRun(currentUser(res), opportunity.run) ? opportunity : null;
  }

  router.get(
    '/runs/:id/hiring-signals',
    asyncHandler(async (req, res) => {
      const runId = Number(req.params.id);
      if (!(await ownedRun(runId, res))) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }
      res.json({ data: await service.getRunSignals(runId) });
    })
  );

  router.post(
    '/runs/:id/hiring-signals/refresh',
    asyncHandler(async (req, res) => {
      const runId = Number(req.params.id);
      if (!(await ownedRun(runId, res))) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }
      res.status(202).json({ data: await service.refresh(runId) });
    })
  );

  router.patch(
    '/hiring-opportunities/:id',
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      if (!(await ownedOpportunity(id, res))) {
        res.status(404).json({ error: 'Hiring opportunity not found' });
        return;
      }
      const body = (req.body ?? {}) as { saved?: unknown; dismissed?: unknown };
      const patch = {
        ...(typeof body.saved === 'boolean' ? { saved: body.saved } : {}),
        ...(typeof body.dismissed === 'boolean' ? { dismissed: body.dismissed } : {}),
      };
      if (!Object.keys(patch).length) {
        res.status(400).json({ error: 'Choose saved or dismissed.' });
        return;
      }
      res.json({ data: await service.updateOpportunity(id, patch) });
    })
  );

  router.post(
    '/hiring-opportunities/:id/prepare-search',
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      if (!(await ownedOpportunity(id, res))) {
        res.status(404).json({ error: 'Hiring opportunity not found' });
        return;
      }
      const targetLane = (req.body as { targetLane?: unknown } | undefined)?.targetLane;
      if (targetLane !== 'google_maps' && targetLane !== 'sales_navigator') {
        res.status(400).json({ error: 'Choose Google Maps or Sales Navigator.' });
        return;
      }
      res.json({ data: await service.prepareSearch(id, targetLane) });
    })
  );

  return router;
}
