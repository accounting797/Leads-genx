import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { formatEmailsTxt, formatLeadsTxt } from '../domain/exportFormatter';
import { suggestions } from '../domain/suggestions';
import { validateCreateRunInput, validateResumeCredentials, ValidationError } from '../domain/validation';
import { appendErrorLogToFile, safeErrorMessage } from '../domain/errorLogger';
import {
  loadOperatorSettings,
  saveOperatorSettings,
  toSafeOperatorSettings,
  SECRET_MASK,
} from '../domain/operatorSettings';
import { testProxies, ProxyTestResult } from '../integrations/proxyTester';
import { asyncHandler } from '../utils/asyncHandler';

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
}

export interface ApiDeps {
  prisma?: PrismaClient;
  runService?: ApiRunService;
  recoverOnStartup?: boolean;
  proxyTester?: (urls: string[]) => Promise<ProxyTestResult[]>;
}

const DEFAULT_GOOGLE_MAPS_ACTOR_ID =
  process.env.DEFAULT_GOOGLE_MAPS_ACTOR_ID || 'compass/google-maps-extractor';
const DEFAULT_SALES_NAVIGATOR_ACTOR_ID =
  process.env.DEFAULT_SALES_NAVIGATOR_ACTOR_ID || 'harvestapi/linkedin-profile-search';

function asListInput(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  return [...new Set(raw.split(/[\r\n,]+/).map((item) => item.trim()).filter(Boolean))];
}

function proxyListError(proxies: string[]): string | undefined {
  for (const proxy of proxies) {
    if (proxy.includes(SECRET_MASK)) continue;
    try {
      const url = new URL(proxy);
      if (!['socks5:', 'socks5h:', 'http:', 'https:'].includes(url.protocol) || !url.hostname || !url.port) {
        return 'Each proxy must be an HTTP(S) or SOCKS5 URL with a host and port.';
      }
    } catch {
      return 'Each proxy must be an HTTP(S) or SOCKS5 URL with a host and port.';
    }
  }
  return undefined;
}

export function createApiRouter({ prisma, runService, proxyTester }: ApiDeps = {}) {
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
      if (format !== 'full' && format !== 'emails') {
        res.status(400).json({ error: 'Unsupported download format.' });
        return;
      }
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
      const settings = await loadOperatorSettings(prisma);
      res.json({
        data: toSafeOperatorSettings(settings, {
          googleMapsActorId: DEFAULT_GOOGLE_MAPS_ACTOR_ID,
          salesNavigatorActorId: DEFAULT_SALES_NAVIGATOR_ACTOR_ID,
        }),
      });
    })
  );

  router.post(
    '/settings',
    asyncHandler(async (req, res) => {
      if (!prisma) {
        res.status(503).json({ error: 'Settings store unavailable' });
        return;
      }
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const proxyUrls = asListInput(body.proxyUrls);
      if (proxyUrls) {
        const error = proxyListError(proxyUrls);
        if (error) {
          res.status(400).json({ error, fields: { proxyUrls: error } });
          return;
        }
      }

      await saveOperatorSettings(prisma, {
        defaultGoogleMapsActorId: body.defaultGoogleMapsActorId as string | undefined,
        defaultSalesNavigatorActorId: body.defaultSalesNavigatorActorId as string | undefined,
        apifyToken: body.apifyToken as string | undefined,
        googleApiKeys: asListInput(body.googleApiKeys),
        proxyUrls,
      });

      const settings = await loadOperatorSettings(prisma);
      res.json({
        data: toSafeOperatorSettings(settings, {
          googleMapsActorId: DEFAULT_GOOGLE_MAPS_ACTOR_ID,
          salesNavigatorActorId: DEFAULT_SALES_NAVIGATOR_ACTOR_ID,
        }),
      });
    })
  );

  router.post(
    '/settings/proxies/test',
    asyncHandler(async (req, res) => {
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const provided = asListInput(body.proxyUrls);
      const targets = provided?.length
        ? provided
        : (await loadOperatorSettings(prisma)).proxyUrls;
      if (!targets.length) {
        res.status(400).json({ error: 'No proxies to test. Save or paste proxies first.' });
        return;
      }
      const tester = proxyTester ?? ((urls: string[]) => testProxies(urls));
      const results = await tester(targets);
      res.json({
        data: {
          results,
          okCount: results.filter((result) => result.ok).length,
          totalCount: results.length,
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
