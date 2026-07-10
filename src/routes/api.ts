import { PrismaClient } from '@prisma/client';
import { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { formatEmailsTxt, formatLeadsTxt } from '../domain/exportFormatter';
import { suggestions } from '../domain/suggestions';
import { validateCreateRunInput, ValidationError } from '../domain/validation';
import { asyncHandler } from '../utils/asyncHandler';

export interface ApiRunService {
  startRun(input: ReturnType<typeof validateCreateRunInput>): Promise<{
    id: number;
    status: string;
    leadSource: string;
  }>;
}

export interface ApiDeps {
  prisma?: PrismaClient;
  runService?: ApiRunService;
}

const DEFAULT_GOOGLE_MAPS_ACTOR_ID =
  process.env.DEFAULT_GOOGLE_MAPS_ACTOR_ID || 'compass/google-maps-extractor';
const DEFAULT_SALES_NAVIGATOR_ACTOR_ID =
  process.env.DEFAULT_SALES_NAVIGATOR_ACTOR_ID || 'harvestapi/linkedin-profile-search';

export function createApiRouter({ prisma, runService }: ApiDeps = {}) {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      data: {
        name: 'Leads-GenX',
        status: 'ok',
        sources: ['google_maps', 'sales_navigator'],
      },
    });
  });

  router.get('/suggestions', (_req, res) => {
    res.json({ data: suggestions });
  });

  router.post(
    '/runs',
    asyncHandler(async (req, res) => {
      if (!runService) {
        res.status(503).json({ error: 'Run service unavailable' });
        return;
      }

      const input = validateCreateRunInput(req.body, false);
      const run = await runService.startRun(input);

      res.status(202).json({
        data: {
          id: run.id,
          status: run.status,
          leadSource: run.leadSource,
        },
      });
    })
  );

  router.get(
    '/runs',
    asyncHandler(async (_req, res) => {
      const runs = prisma
        ? await prisma.run.findMany({
            orderBy: { createdAt: 'desc' },
            include: { _count: { select: { leads: true } } },
          })
        : [];
      res.json({ data: runs });
    })
  );

  router.get(
    '/runs/:id',
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const run = prisma
        ? await prisma.run.findUnique({ where: { id }, include: { leads: true } })
        : null;
      if (!run) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }
      res.json({ data: run });
    })
  );

  router.get(
    '/runs/:id/events',
    asyncHandler(async (req, res) => {
      const runId = Number(req.params.id);
      const events = prisma
        ? await prisma.runEvent.findMany({ where: { runId }, orderBy: { createdAt: 'asc' } })
        : [];
      res.json({ data: events });
    })
  );

  router.get(
    '/leads',
    asyncHandler(async (req, res) => {
      const runId = req.query.runId ? Number(req.query.runId) : undefined;
      const leads = prisma
        ? await prisma.lead.findMany({
            where: runId ? { runId } : undefined,
            orderBy: { createdAt: 'desc' },
          })
        : [];
      res.json({ data: leads });
    })
  );

  router.get(
    '/leads/download',
    asyncHandler(async (req, res) => {
      const runId = req.query.runId ? Number(req.query.runId) : undefined;
      const leads = prisma
        ? await prisma.lead.findMany({
            where: runId ? { runId } : undefined,
            orderBy: { createdAt: 'desc' },
          })
        : [];
      const format = typeof req.query.format === 'string' ? req.query.format : 'full';
      if (format !== 'full' && format !== 'emails') {
        res.status(400).json({ error: 'Unsupported download format.' });
        return;
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="leads-genx-leads.txt"');
      if (format === 'emails') {
        res.send(formatEmailsTxt(leads));
      } else {
        res.send(formatLeadsTxt(leads));
      }
    })
  );

  router.get(
    '/errors',
    asyncHandler(async (_req, res) => {
      const errors = prisma
        ? await prisma.errorLog.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
        : [];
      res.json({ data: errors });
    })
  );

  router.get(
    '/settings',
    asyncHandler(async (_req, res) => {
      const settings = prisma
        ? await prisma.appSetting.findMany({
            where: {
              key: {
                in: ['defaultGoogleMapsActorId', 'defaultSalesNavigatorActorId', 'apifyToken'],
              },
            },
          })
        : [];
      const byKey = new Map(settings.map((setting) => [setting.key, setting]));

      res.json({
        data: {
          defaultGoogleMapsActorId:
            byKey.get('defaultGoogleMapsActorId')?.value || DEFAULT_GOOGLE_MAPS_ACTOR_ID,
          defaultSalesNavigatorActorId:
            byKey.get('defaultSalesNavigatorActorId')?.value || DEFAULT_SALES_NAVIGATOR_ACTOR_ID,
          hasSavedApifyToken: byKey.has('apifyToken'),
        },
      });
    })
  );

  router.post('/settings', (_req, res) => {
    res.status(204).send();
  });

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message, fields: error.fields });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  });

  return router;
}
