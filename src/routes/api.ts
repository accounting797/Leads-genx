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
  loadQuarantinedCredentials,
  pruneQuarantinedCredentials,
  saveOperatorSettings,
  toSafeOperatorSettings,
  normalizeProxyLine,
  unquarantineCredential,
  SECRET_MASK,
} from '../domain/operatorSettings';
import { testProxies, ProxyTestResult } from '../integrations/proxyTester';
import {
  testApifyToken,
  testGoogleApiKey,
  CredentialTestResult,
} from '../integrations/credentialTester';
import { asyncHandler } from '../utils/asyncHandler';
import { analyzeRun } from '../domain/runAnalyst';
import {
  attachUser,
  canAccessRun,
  currentUser,
  requireAdmin,
  requireAuth,
} from '../domain/auth';
import { limitsForUser, outputModeAllowed, startOfToday } from '../domain/tierLimits';
import { hasUserCredentials, loadUserCredentials } from '../domain/userCredentials';
import { createAuthRouter } from './auth';
import { createAdminRouter } from './admin';

function parseEventMetadata(metadataJson: string | null): { kind?: string } | undefined {
  if (!metadataJson) return undefined;
  try {
    const parsed = JSON.parse(metadataJson);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export interface ApiRunService {
  startRun(input: ReturnType<typeof validateCreateRunInput>, options?: { userId?: number }): Promise<{
    id: number;
    status: string;
    leadSource: string;
  }>;
  stopRun?(id: number): Promise<void>;
  resumeRun?(runId: number, credentials: {
    googleApiKey?: string;
    googleApiKeys?: string[];
    proxyUrls?: string[];
  }): Promise<{ id: number; status: string }>;
  scraperHealth?(): Promise<{ ok: boolean; route: string; healthyProxyCount: number }>;
  recoverInterruptedRuns?(): Promise<void>;
}

export interface CredentialTester {
  testApifyToken(token: string): Promise<CredentialTestResult>;
  testGoogleApiKey(apiKey: string): Promise<CredentialTestResult>;
}

export interface ApiDeps {
  prisma?: PrismaClient;
  runService?: ApiRunService;
  recoverOnStartup?: boolean;
  proxyTester?: (urls: string[]) => Promise<ProxyTestResult[]>;
  credentialTester?: CredentialTester;
  /** Explicitly disable auth enforcement (tests only — production never sets this). */
  authDisabled?: boolean;
  deployService?: import('../domain/deployService').DeployService;
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

const PROXY_URL_PATTERN = /^(https?|socks5h?):\/\/[^\s/]+:\d{1,5}\/?$/i;

function proxyListError(proxies: string[]): string | undefined {
  for (const proxy of proxies) {
    if (proxy.includes(SECRET_MASK)) continue;
    if (!PROXY_URL_PATTERN.test(proxy)) {
      return 'Each proxy must be an HTTP(S) or SOCKS5 URL with a host and port.';
    }
  }
  return undefined;
}

export function createApiRouter({ prisma, runService, proxyTester, credentialTester, authDisabled, deployService }: ApiDeps = {}) {
  const router = Router();

  // Auth is enforced whenever a real user/session store is present and not
  // explicitly disabled (tests pass stubs without user models or authDisabled).
  const authEnabled = !authDisabled && Boolean(prisma?.user && prisma?.session);
  const passThrough = (_req: Request, _res: Response, next: NextFunction) => next();
  const guard = authEnabled ? requireAuth : passThrough;
  const adminGuard = authEnabled ? requireAdmin : passThrough;

  router.use(attachUser(authEnabled ? prisma : undefined));

  router.get('/health', (_req, res) => {
    res.json({
      data: {
        name: 'Leads-GenX',
        status: 'ok',
        sources: ['google_maps', 'sales_navigator'],
      },
    });
  });

  if (authEnabled && prisma) {
    router.use('/auth', createAuthRouter({ prisma, credentialTester }));
  }

  // Everything below this line requires a signed-in user when auth is enabled.
  router.use(guard);

  if (authEnabled && prisma) {
    router.use('/admin', adminGuard, createAdminRouter({ prisma, deployService }));
  }

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

      // Saved Settings credentials count as provided: merge them into the raw
      // body before validation so Standard/Hybrid modes work without re-entry.
      // BYOD users run on their own saved credentials — per field, their value
      // wins over the admin's shared pool.
      const body: Record<string, unknown> = { ...(req.body as Record<string, unknown>) };
      const runUser = currentUser(res);
      let hasSavedToken = false;
      try {
        const savedSettings = await loadOperatorSettings(prisma);
        let effectiveApify = savedSettings.apifyToken;
        let effectiveGoogle = savedSettings.googleApiKeys;
        if (runUser && runUser.role !== 'ADMIN') {
          const byod = await loadUserCredentials(prisma, runUser.id);
          if (hasUserCredentials(byod)) {
            effectiveApify = byod.apifyToken ?? savedSettings.apifyToken;
            effectiveGoogle = byod.googleApiKeys.length ? byod.googleApiKeys : savedSettings.googleApiKeys;
          }
        }
        hasSavedToken = Boolean(effectiveApify);
        const bodyHasToken = typeof body.apifyToken === 'string' && Boolean(body.apifyToken.trim());
        const bodyHasGoogleKey = typeof body.googleApiKey === 'string' && Boolean(body.googleApiKey.trim());
        if (!bodyHasToken && effectiveApify) body.apifyToken = effectiveApify;
        if (!bodyHasGoogleKey && effectiveGoogle.length) {
          body.googleApiKey = effectiveGoogle.join('\n');
        }
      } catch {
        hasSavedToken = false;
      }
      const input = validateCreateRunInput(body, hasSavedToken);

      // Tier gate: Hybrid Max output is a Hybrid-plan feature, enforced
      // server-side so it cannot be bypassed from the browser.
      const user = currentUser(res);
      if (!outputModeAllowed(user, input.outputMode)) {
        res.status(403).json({
          error: 'Hybrid Max Output requires the Hybrid plan. Request an upgrade from the Account tab.',
          upgradeRequired: true,
        });
        return;
      }

      // Plan quotas: results-per-run cap and runs-per-day cap.
      const limits = limitsForUser(user);
      if (input.maxResults > limits.maxResultsPerRun) {
        res.status(400).json({
          error: `Your ${limits.label} plan allows up to ${limits.maxResultsPerRun} results per run.`,
          fields: { maxResults: `Plan limit: ${limits.maxResultsPerRun}` },
        });
        return;
      }
      if (user && prisma?.run) {
        const runsToday = await prisma.run.count({
          where: { userId: user.id, createdAt: { gte: startOfToday() } },
        });
        if (runsToday >= limits.runsPerDay) {
          res.status(429).json({
            error: `Daily run limit reached — your ${limits.label} plan allows ${limits.runsPerDay} runs per day. Try again tomorrow or request an upgrade.`,
          });
          return;
        }
      }

      const run = await runService.startRun(input, user ? { userId: user.id } : undefined);

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
      const user = currentUser(res);
      const scoped = user && user.role !== 'ADMIN' ? { userId: user.id } : undefined;
      const runs = prisma
        ? await prisma.run.findMany({
            where: scoped,
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
      if (!run || !canAccessRun(currentUser(res), run)) {
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
      const resumeUser = currentUser(res);
      if (resumeUser && prisma) {
        const owned = await prisma.run.findUnique({ where: { id: Number(req.params.id) } });
        if (!owned || !canAccessRun(resumeUser, owned)) {
          res.status(404).json({ error: 'Run not found' });
          return;
        }
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

  router.post(
    '/runs/:id/stop',
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      if (prisma) {
        const run = await prisma.run.findUnique({ where: { id } });
        if (!run || !canAccessRun(currentUser(res), run)) {
          res.status(404).json({ error: 'Run not found' });
          return;
        }
        if (['completed', 'failed', 'cancelled', 'partially_completed'].includes(run.status)) {
          res.status(409).json({ error: `Run already finished with status ${run.status.replace(/_/g, ' ')}.` });
          return;
        }
      }
      if (!runService?.stopRun) {
        res.status(503).json({ error: 'Stop unavailable' });
        return;
      }
      await runService.stopRun(id);
      res.json({ data: { id, status: 'cancelled' } });
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
      if (!run || !canAccessRun(currentUser(res), run)) {
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
      if (prisma) {
        const run = await prisma.run.findUnique({ where: { id: runId } });
        if (!run || !canAccessRun(currentUser(res), run)) {
          res.status(404).json({ error: 'Run not found' });
          return;
        }
      }
      const events = prisma
        ? await prisma.runEvent.findMany({ where: { runId }, orderBy: { createdAt: 'asc' } })
        : [];
      res.json({ data: events });
    })
  );

  router.get(
    '/runs/:id/analyst',
    asyncHandler(async (req, res) => {
      if (!prisma) {
        res.status(503).json({ error: 'Database unavailable' });
        return;
      }
      const runId = Number(req.params.id);
      const run = await prisma.run.findUnique({ where: { id: runId } });
      if (!run || !canAccessRun(currentUser(res), run)) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }
      const [events, providerStates, errorLogs] = await Promise.all([
        prisma.runEvent.findMany({ where: { runId }, orderBy: { createdAt: 'asc' }, take: 200 }),
        prisma.runProviderState.findMany({ where: { runId } }),
        prisma.errorLog.findMany({ where: { runId }, orderBy: { createdAt: 'desc' }, take: 20 }),
      ]);
      const report = analyzeRun({
        run: {
          status: run.status,
          leadCount: run.leadCount,
          rawContactCount: run.rawContactCount,
          businessCount: run.businessCount,
          maxResults: run.maxResults,
          apiRequestsUsed: run.apiRequestsUsed,
          apiRequestBudget: run.apiRequestBudget,
          actorId: run.actorId,
          errorMessage: run.errorMessage ?? undefined,
        },
        events: events.map((event) => ({
          type: event.type,
          message: event.message,
          createdAt: event.createdAt,
          metadata: parseEventMetadata(event.metadataJson),
        })),
        providerStates,
        errorLogs,
      });
      res.json({ data: report });
    })
  );

  function leadScope(res: Response, runId?: number): Record<string, unknown> | undefined {
    const user = currentUser(res);
    if (!prisma) return undefined;
    const where: Record<string, unknown> = {};
    if (runId) where.runId = runId;
    if (user && user.role !== 'ADMIN') where.run = { userId: user.id };
    return Object.keys(where).length ? where : undefined;
  }

  router.get(
    '/leads',
    asyncHandler(async (req, res) => {
      const runId = req.query.runId ? Number(req.query.runId) : undefined;
      const leads = prisma
        ? await prisma.lead.findMany({
            where: leadScope(res, runId),
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
            where: leadScope(res, runId),
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
    adminGuard,
    asyncHandler(async (_req, res) => {
      const errors = prisma
        ? await prisma.errorLog.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
        : [];
      res.json({ data: errors });
    })
  );

  router.get(
    '/settings',
    adminGuard,
    asyncHandler(async (_req, res) => {
      const settings = await loadOperatorSettings(prisma);
      const quarantined = await loadQuarantinedCredentials(prisma);
      res.json({
        data: {
          ...toSafeOperatorSettings(settings, {
            googleMapsActorId: DEFAULT_GOOGLE_MAPS_ACTOR_ID,
            salesNavigatorActorId: DEFAULT_SALES_NAVIGATOR_ACTOR_ID,
          }),
          quarantinedCredentials: quarantined.map((entry) => ({
            provider: entry.provider,
            reason: entry.reason,
            at: entry.at,
          })),
        },
      });
    })
  );

  router.post(
    '/settings',
    adminGuard,
    asyncHandler(async (req, res) => {
      if (!prisma) {
        res.status(503).json({ error: 'Settings store unavailable' });
        return;
      }
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const proxyUrls = asListInput(body.proxyUrls)?.map(normalizeProxyLine);
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
      // Replacing or removing a credential resets the engineer's memory for it.
      await pruneQuarantinedCredentials(
        prisma,
        [settings.apifyToken, ...settings.googleApiKeys].filter((value): value is string => Boolean(value))
      );
      const quarantined = await loadQuarantinedCredentials(prisma);
      res.json({
        data: {
          ...toSafeOperatorSettings(settings, {
            googleMapsActorId: DEFAULT_GOOGLE_MAPS_ACTOR_ID,
            salesNavigatorActorId: DEFAULT_SALES_NAVIGATOR_ACTOR_ID,
          }),
          quarantinedCredentials: quarantined.map((entry) => ({
            provider: entry.provider,
            reason: entry.reason,
            at: entry.at,
          })),
        },
      });
    })
  );

  router.post(
    '/settings/proxies/test',
    adminGuard,
    asyncHandler(async (req, res) => {
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const provided = asListInput(body.proxyUrls)?.map(normalizeProxyLine);
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

  router.post(
    '/settings/test/apify',
    adminGuard,
    asyncHandler(async (req, res) => {
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const provided = typeof body.apifyToken === 'string' ? body.apifyToken.trim() : '';
      const token = provided || (await loadOperatorSettings(prisma)).apifyToken;
      if (!token) {
        res.status(400).json({ error: 'No Apify token to test. Save or paste one first.' });
        return;
      }
      const tester = credentialTester ?? { testApifyToken, testGoogleApiKey };
      const result = await tester.testApifyToken(token);
      // A passing live test is proof of life: release the credential from
      // the engineer's quarantine so runs trust it again.
      if (result.ok) {
        try {
          if (prisma && (await unquarantineCredential(prisma, token))) {
            result.detail = `${result.detail} — quarantine cleared, the engineer trusts this token again`;
          }
        } catch {
          // Quarantine state must never break a credential test.
        }
      }
      res.json({ data: result });
    })
  );

  router.post(
    '/settings/test/google',
    adminGuard,
    asyncHandler(async (req, res) => {
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const provided = asListInput(body.googleApiKeys);
      const keys = provided?.length ? provided : (await loadOperatorSettings(prisma)).googleApiKeys;
      if (!keys.length) {
        res.status(400).json({ error: 'No Google API keys to test. Save or paste one first.' });
        return;
      }
      const tester = credentialTester ?? { testApifyToken, testGoogleApiKey };
      const results: CredentialTestResult[] = [];
      for (const key of keys) {
        const result = await tester.testGoogleApiKey(key);
        if (result.ok) {
          try {
            if (prisma && (await unquarantineCredential(prisma, key))) {
              result.detail = `${result.detail} — quarantine cleared, the engineer trusts this key again`;
            }
          } catch {
            // Quarantine state must never break a credential test.
          }
        }
        results.push(result);
      }
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
