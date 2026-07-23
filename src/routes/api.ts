import { EventEmitter } from 'events';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { formatEmailsTxt, formatLeadsTxt, formatLeadsCsv, formatCodexCsv, formatLeadsJson } from '../domain/exportFormatter';
import { suggestions } from '../domain/suggestions';
import { validateCreateRunInput, validateResumeCredentials, ValidationError } from '../domain/validation';
import { appendErrorLogToFile, safeErrorMessage } from '../domain/errorLogger';
import { asyncHandler } from '../utils/asyncHandler';
import type { RunSseEvent } from '../domain/types';

export interface ApiRunService {
  startRun(input: ReturnType<typeof validateCreateRunInput>): Promise<{
    id: number;
    status: string;
    leadSource: string;
  }>;
  resumeRun?(runId: number, credentials: {
    googleApiKey?: string;
    googleApiKeys?: string[];
    proxyUrls?: string[];
  }): Promise<{ id: number; status: string }>;
  scraperHealth?(): Promise<{ ok: boolean; route: string; healthyProxyCount: number }>;
  recoverInterruptedRuns?(): Promise<void>;
  runCodexParallel?(
    tokens: string[],
    searchStrings: string[],
    maxCrawledPlaces: number,
    regionGroup: string,
    target: number,
    actorId?: string
  ): Promise<{ leadCount: number; completedDatasets: number }>;
  eventBus?: EventEmitter;
}

export interface ApiDeps {
  prisma?: PrismaClient;
  runService?: ApiRunService;
  recoverOnStartup?: boolean;
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

  router.get(
    '/scraper/health',
    asyncHandler(async (_req, res) => {
      if (!runService?.scraperHealth) {
        res.status(503).json({ error: 'Scraper health unavailable' });
        return;
      }
      res.json({ data: await runService.scraperHealth() });
    })
  );

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
            include: { _count: { select: { leads: true, batches: true } } },
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
        ? await prisma.run.findUnique({
            where: { id },
            include: {
              leads: true,
              batches: {
                select: { id: true, status: true, attemptCount: true, resultCount: true, errorCode: true },
              },
            },
          })
        : null;
      if (!run) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }
      res.json({ data: run });
    })
  );

  router.post(
    '/runs/:id/resume',
    asyncHandler(async (req, res) => {
      if (!runService?.resumeRun) {
        res.status(503).json({ error: 'Run recovery unavailable' });
        return;
      }
      const parsed = validateResumeCredentials(req.body);
      const resumed = await runService.resumeRun(Number(req.params.id), {
        googleApiKey: parsed.googleApiKey,
        googleApiKeys: parsed.googleApiKeys,
        proxyUrls: parsed.proxyUrls,
      });
      res.status(202).json({ data: { id: resumed.id, status: resumed.status } });
    })
  );

  router.delete(
    '/runs/:id',
    asyncHandler(async (req, res) => {
      if (!prisma) {
        res.status(503).json({ error: 'Database unavailable' });
        return;
      }

      const id = Number(req.params.id);
      const run = await prisma.run.findUnique({ where: { id } });
      if (!run) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }

      await prisma.run.delete({ where: { id } });
      res.status(204).send();
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
      const format = typeof req.query.format === 'string' ? req.query.format : 'emails';
      if (format !== 'full' && format !== 'emails' && format !== 'csv' && format !== 'json' && format !== 'codex') {
        res.status(400).json({ error: 'Unsupported download format.' });
        return;
      }
      
      if (format === 'codex') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="leads-genx-codex.csv"');
        res.send(formatCodexCsv(leads));
      } else if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="leads-genx.csv"');
        res.send(formatLeadsCsv(leads));
      } else if (format === 'json') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="leads-genx.json"');
        res.send(formatLeadsJson(leads));
      } else {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${format === 'emails' ? 'leads-genx-emails.txt' : 'leads-genx-leads.txt'}"`
        );
        if (format === 'emails') {
          res.send(formatEmailsTxt(leads));
        } else {
          res.send(formatLeadsTxt(leads));
        }
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

  router.get(
    '/runs/:id/events/stream',
    asyncHandler(async (req, res) => {
      const runId = Number(req.params.id);
      const bus = runService?.eventBus;
      if (!bus) {
        res.status(503).json({ error: 'SSE unavailable' });
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      res.write(`data: ${JSON.stringify({ type: 'connected', message: `Listening for run ${runId} events.`, runId })}\n\n`);

      let alive = true;
      const heartbeat = setInterval(() => {
        if (alive) res.write(': heartbeat\n\n');
      }, 15_000);

      const onEvent = (event: RunSseEvent) => {
        if (!alive) return;
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
          if (['run_completed', 'run_failed'].includes(event.type)) {
            alive = false;
            clearInterval(heartbeat);
            res.end();
          }
        } catch {
          alive = false;
          clearInterval(heartbeat);
        }
      };

      bus.on(`run:${runId}`, onEvent);

      req.on('close', () => {
        alive = false;
        clearInterval(heartbeat);
        bus.removeListener(`run:${runId}`, onEvent);
      });
    })
  );

  router.post(
    '/codex/run',
    asyncHandler(async (req, res) => {
      if (!runService?.runCodexParallel) {
        res.status(503).json({ error: 'Codex parallel service unavailable' });
        return;
      }

      const {
        tokens,
        searchStrings,
        maxCrawledPlaces = 200,
        regionGroup = 'US',
        target = 100000,
        actorId,
      } = req.body as Record<string, unknown>;

      if (!Array.isArray(tokens) || tokens.length === 0) {
        res.status(400).json({ error: 'At least one token is required.' });
        return;
      }
      if (!Array.isArray(searchStrings) || searchStrings.length === 0) {
        res.status(400).json({ error: 'At least one search string is required.' });
        return;
      }

      const result = await runService.runCodexParallel(
        tokens,
        searchStrings,
        Number(maxCrawledPlaces),
        String(regionGroup),
        Number(target),
        actorId ? String(actorId) : undefined
      );

      res.status(202).json({
        data: {
          leadCount: result.leadCount,
          completedDatasets: result.completedDatasets,
          target,
        },
      });
    })
  );

  router.use(async (error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message, fields: error.fields });
      return;
    }

    const requestId = randomUUID();
    const message = safeErrorMessage(error);
    const details = { method: req.method, path: req.path };
    try {
      await prisma?.errorLog.create({
        data: {
          requestId,
          source: 'api',
          severity: 'error',
          message,
          detailsJson: JSON.stringify(details),
        },
      });
    } catch {
      appendErrorLogToFile({ requestId, source: 'api', severity: 'error', message, details });
    }

    const prefix = req.method === 'POST' && req.path === '/runs' ? 'Unable to start run' : 'Request failed';
    res.status(500).json({ error: `${prefix}: ${message}`, requestId });
  });

  return router;
}
