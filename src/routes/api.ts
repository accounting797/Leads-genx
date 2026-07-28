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
import { testBrightDataKey } from '../integrations/brightDataClient';
import { enrichRunLinkedInLeads } from '../domain/linkedinEnrichment';
import { pickNextCombo, ComboStat } from '../domain/shuffleCombos';
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
import { createExtensionRouter } from './extension';
import type { HiringSignalService } from '../domain/hiringSignalService';
import { createHiringSignalsRouter } from './hiringSignals';
import { companyIdentity, HiringScoreComponents } from '../domain/greenhouseSignals';

function parseEventMetadata(metadataJson: string | null): { kind?: string } | undefined {
  if (!metadataJson) return undefined;
  try {
    const parsed = JSON.parse(metadataJson);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseHiringComponents(scoreJson: string): HiringScoreComponents {
  const empty = { roles: 0, recency: 0, geography: 0, industry: 0, breadth: 0 };
  try {
    const value = JSON.parse(scoreJson) as Partial<Record<keyof HiringScoreComponents, unknown>>;
    return Object.fromEntries(
      Object.keys(empty).map((key) => {
        const valueAtKey = value[key as keyof HiringScoreComponents];
        return [key, typeof valueAtKey === 'number' && Number.isFinite(valueAtKey) ? valueAtKey : 0];
      })
    ) as unknown as HiringScoreComponents;
  } catch {
    return empty;
  }
}

function safeHttpsUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

type DataScope = 'mine' | 'all';

function parseDataScope(req: Request): DataScope {
  const value = req.query.scope;
  if (value === undefined || value === 'mine') return 'mine';
  if (value === 'all') return 'all';
  throw new ValidationError('scope must be mine or all.');
}

function runOwnerWhere(res: Response, scope: DataScope): { userId: number } | undefined {
  const user = currentUser(res);
  if (!user) return undefined;
  return scope === 'all' && user.role === 'ADMIN' ? undefined : { userId: user.id };
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
    apifyToken?: string;
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
  hiringSignalService?: HiringSignalService;
}

const DEFAULT_GOOGLE_MAPS_ACTOR_ID =
  process.env.DEFAULT_GOOGLE_MAPS_ACTOR_ID || 'compass/google-maps-extractor';
const DEFAULT_SALES_NAVIGATOR_ACTOR_ID =
  process.env.DEFAULT_SALES_NAVIGATOR_ACTOR_ID === 'harvestapi/linkedin-profile-search'
    ? 'harvestapi/linkedin-sales-navigator-lead-search-cookie'
    : process.env.DEFAULT_SALES_NAVIGATOR_ACTOR_ID || 'harvestapi/linkedin-sales-navigator-lead-search-cookie';

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

export function createApiRouter({
  prisma,
  runService,
  proxyTester,
  credentialTester,
  authDisabled,
  deployService,
  hiringSignalService,
}: ApiDeps = {}) {
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

  // Extension endpoints mix Bearer-token auth (ping/leads/finish, resolved
  // inside the router) with session auth (token routes via the guard), so the
  // router mounts before the blanket session guard.
  if (prisma?.user) {
    router.use(
      '/extension',
      createExtensionRouter({
        prisma,
        guard,
        onRunSettled: hiringSignalService
          ? async (runId) => {
              await hiringSignalService.scheduleIfEligible(runId);
            }
          : undefined,
      })
    );
  }

  // Everything below this line requires a signed-in user when auth is enabled.
  router.use(guard);

  if (authEnabled && prisma) {
    router.use('/admin', adminGuard, createAdminRouter({ prisma, deployService }));
  }

  if (prisma && hiringSignalService) {
    router.use(createHiringSignalsRouter({ prisma, service: hiringSignalService }));
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
        let effectiveBrightData = savedSettings.brightDataApiKey;
        if (runUser) {
          const byod = await loadUserCredentials(prisma, runUser.id);
          if (hasUserCredentials(byod)) {
            effectiveApify = byod.apifyToken ?? savedSettings.apifyToken;
            effectiveGoogle = byod.googleApiKeys.length ? byod.googleApiKeys : savedSettings.googleApiKeys;
            effectiveBrightData = byod.brightDataApiKey ?? savedSettings.brightDataApiKey;
          }
        }
        hasSavedToken = Boolean(effectiveApify);
        const bodyHasToken = typeof body.apifyToken === 'string' && Boolean(body.apifyToken.trim());
        const bodyHasGoogleKey = typeof body.googleApiKey === 'string' && Boolean(body.googleApiKey.trim());
        const bodyHasBrightData = typeof body.brightDataApiKey === 'string' && Boolean(body.brightDataApiKey.trim());
        if (!bodyHasToken && effectiveApify) body.apifyToken = effectiveApify;
        if (!bodyHasGoogleKey && effectiveGoogle.length) {
          body.googleApiKey = effectiveGoogle.join('\n');
        }
        if (!bodyHasBrightData && effectiveBrightData) body.brightDataApiKey = effectiveBrightData;
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
    asyncHandler(async (req, res) => {
      const scope = parseDataScope(req);
      const runs = prisma
        ? await prisma.run.findMany({
            where: runOwnerWhere(res, scope),
            orderBy: { createdAt: 'desc' },
            include: {
              _count: { select: { leads: true, batches: true } },
              user: { select: { username: true } },
            },
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

  // Bright Data enrichment: fill in emails/phones for a run's LinkedIn
  // leads (extension-captured or otherwise) using the contact-enriched
  // people dataset. BYOD key wins; falls back to the operator's key.
  router.post(
    '/runs/:id/enrich-linkedin',
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      if (!prisma) {
        res.status(503).json({ error: 'Database unavailable' });
        return;
      }
      const run = await prisma.run.findUnique({ where: { id } });
      if (!run || !canAccessRun(currentUser(res), run)) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }
      const user = currentUser(res);
      const byod = user ? await loadUserCredentials(prisma, user.id) : undefined;
      const apiKey = byod?.brightDataApiKey || (await loadOperatorSettings(prisma)).brightDataApiKey;
      if (!apiKey) {
        res.status(400).json({
          error: 'No Bright Data key yet — add one in Settings and Nova will handle the rest.',
        });
        return;
      }
      const pending = await prisma.lead.count({
        where: { runId: id, profileUrl: { not: null }, OR: [{ email: null }, { email: '' }] },
      });
      if (pending === 0) {
        res.json({ data: { started: false, pending: 0, message: 'Every LinkedIn lead already has contact data.' } });
        return;
      }
      // Fire and forget — progress lands in the run's event feed as
      // brightdata_enrichment_* events (Nova narrates every batch).
      void enrichRunLinkedInLeads(prisma, id, { apiKey }).catch(() => {});
      res.status(202).json({
        data: {
          started: true,
          pending,
          message: `Nova is enriching ${pending} LinkedIn profiles with Bright Data — watch the run feed.`,
        },
      });
    })
  );

  // Nova Shuffle: one-click precision filters. One option per filter group,
  // rotating through the curated library — unseen slices first, then the
  // user's own best performers (learning from run outcomes).
  router.post(
    '/shuffle/next',
    asyncHandler(async (req, res) => {
      if (!prisma) {
        res.status(503).json({ error: 'Database unavailable' });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const source = body.source;
      if (source !== 'google_maps' && source !== 'sales_navigator') {
        res.status(400).json({ error: 'source must be google_maps or sales_navigator.' });
        return;
      }
      const stringList = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
      const user = currentUser(res);
      const runs = await prisma.run.findMany({
        where: user ? { userId: user.id } : {},
        select: { filterJson: true, leadCount: true },
      });
      const stats: Record<string, ComboStat> = {};
      for (const run of runs) {
        try {
          const parsed = JSON.parse(run.filterJson ?? '{}') as { comboId?: string };
          if (!parsed.comboId) continue;
          const stat = (stats[parsed.comboId] = stats[parsed.comboId] ?? { runs: 0, leads: 0 });
          stat.runs += 1;
          stat.leads += run.leadCount ?? 0;
        } catch {
          // Unparseable filterJson never blocks a shuffle.
        }
      }
      res.json({
        data: pickNextCombo(
          {
            source,
            recentComboIds: stringList(body.recentComboIds),
            recentCities: stringList(body.recentCities),
            currentComboId: typeof body.currentComboId === 'string' ? body.currentComboId : undefined,
          },
          stats,
        ),
      });
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
      const latestHiringScan = await prisma.hiringSignalScan.findFirst({
        where: { runId },
        orderBy: { id: 'desc' },
        select: { id: true, status: true, errorMessage: true },
      });
      const [events, providerStates, errorLogs, hiringSignals] = await Promise.all([
        prisma.runEvent.findMany({ where: { runId }, orderBy: { createdAt: 'asc' }, take: 200 }),
        prisma.runProviderState.findMany({ where: { runId } }),
        prisma.errorLog.findMany({ where: { runId }, orderBy: { createdAt: 'desc' }, take: 20 }),
        latestHiringScan
          ? prisma.hiringOpportunity.findMany({
              where: { scanId: latestHiringScan.id, dismissed: false },
              orderBy: [{ score: 'desc' }, { companyName: 'asc' }],
              take: 10,
              select: { companyName: true, score: true, explanation: true, originLane: true },
            })
          : Promise.resolve([]),
      ]);
      const report = analyzeRun({
        run: {
          status: run.status,
          leadSource: run.leadSource as 'google_maps' | 'sales_navigator',
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
        hiringSignals: hiringSignals.map((signal) => ({
          companyName: signal.companyName,
          score: signal.score,
          explanation: signal.explanation ?? '',
          originLane: signal.originLane as 'google_maps' | 'sales_navigator' | 'hiring_opportunity',
        })),
        hiringScan: latestHiringScan
          ? {
              status: latestHiringScan.status,
              errorMessage: latestHiringScan.errorMessage,
            }
          : null,
      });
      res.json({ data: report });
    })
  );

  function leadScope(
    res: Response,
    scope: DataScope,
    runId?: number,
    leadSource?: 'google_maps' | 'sales_navigator',
    createdAfter?: Date
  ): Record<string, unknown> | undefined {
    if (!prisma) return undefined;
    const where: Record<string, unknown> = {};
    if (runId) where.runId = runId;
    if (leadSource) where.leadSource = leadSource;
    const ownerWhere = runOwnerWhere(res, scope);
    if (ownerWhere || createdAfter) {
      where.run = {
        ...(ownerWhere || {}),
        ...(createdAfter ? { createdAt: { gt: createdAfter } } : {}),
      };
    }
    return Object.keys(where).length ? where : undefined;
  }

  router.get(
    '/leads',
    asyncHandler(async (req, res) => {
      const scope = parseDataScope(req);
      const runId = req.query.runId ? Number(req.query.runId) : undefined;
      const leadSource = typeof req.query.leadSource === 'string' ? req.query.leadSource : undefined;
      const createdAfter = typeof req.query.createdAfter === 'string' ? new Date(req.query.createdAfter) : undefined;
      if (createdAfter && Number.isNaN(createdAfter.getTime())) {
        res.status(400).json({ error: 'createdAfter must be a valid ISO date.' });
        return;
      }
      if (leadSource && leadSource !== 'google_maps' && leadSource !== 'sales_navigator') {
        res.status(400).json({ error: 'Choose Google Maps or Sales Navigator.' });
        return;
      }
      const selectedLeadSource =
        leadSource === 'google_maps' || leadSource === 'sales_navigator' ? leadSource : undefined;
      const leads = prisma
        ? await prisma.lead.findMany({
            where: leadScope(res, scope, runId, selectedLeadSource, createdAfter),
            orderBy: { createdAt: 'desc' },
            include: {
              run: {
                select: {
                  id: true,
                  createdAt: true,
                  leadSource: true,
                  user: { select: { username: true } },
                },
              },
            },
          })
        : [];
      const leadsWithOwners = leads.map(({ run, ...lead }) => ({
        ...lead,
        ownerUsername: run.user?.username || 'Legacy / unassigned',
        runId: run.id ?? lead.runId,
        runCreatedAt: run.createdAt?.toISOString?.() || '',
        runLeadSource: run.leadSource || lead.leadSource,
      }));
      if (!prisma || !leadsWithOwners.length) {
        res.json({ data: leadsWithOwners });
        return;
      }
      const runIds = [...new Set(leadsWithOwners.map((lead) => lead.runId))];
      const scans = await prisma.hiringSignalScan.findMany({
        where: { runId: { in: runIds } },
        orderBy: { id: 'desc' },
        select: { id: true, runId: true },
      });
      const latestScanIds = new Map<number, number>();
      for (const scan of scans) {
        if (!latestScanIds.has(scan.runId)) latestScanIds.set(scan.runId, scan.id);
      }
      const signals = latestScanIds.size
        ? await prisma.hiringOpportunity.findMany({
            where: {
              scanId: { in: [...latestScanIds.values()] },
              dismissed: false,
              relationship: 'exact',
            },
            orderBy: { score: 'desc' },
          })
        : [];
      const signalByIdentity = new Map(
        signals.map((signal) => [
          `${signal.runId}:${signal.companyKey}`,
          {
            id: signal.id,
            score: signal.score,
            components: parseHiringComponents(signal.scoreJson),
            explanation: signal.explanation ?? '',
            evidenceUrl: safeHttpsUrl(signal.evidenceUrl),
            observedAt: signal.observedAt.toISOString(),
          },
        ])
      );
      res.json({
        data: leadsWithOwners.map((lead) => {
          const identity = companyIdentity({ companyName: lead.companyName, website: lead.website });
          const hiringSignal = signalByIdentity.get(`${lead.runId}:${identity.companyKey}`);
          return hiringSignal ? { ...lead, hiringSignal } : lead;
        }),
      });
    })
  );

  router.get(
    '/leads/download',
    asyncHandler(async (req, res) => {
      const scope = parseDataScope(req);
      const runId = req.query.runId ? Number(req.query.runId) : undefined;
      const leadSource = typeof req.query.leadSource === 'string' ? req.query.leadSource : undefined;
      const createdAfter = typeof req.query.createdAfter === 'string' ? new Date(req.query.createdAfter) : undefined;
      if (createdAfter && Number.isNaN(createdAfter.getTime())) {
        res.status(400).json({ error: 'createdAfter must be a valid ISO date.' });
        return;
      }
      if (leadSource && leadSource !== 'google_maps' && leadSource !== 'sales_navigator') {
        res.status(400).json({ error: 'Choose Google Maps or Sales Navigator.' });
        return;
      }
      const selectedLeadSource =
        leadSource === 'google_maps' || leadSource === 'sales_navigator' ? leadSource : undefined;
      const leads = prisma
        ? await prisma.lead.findMany({
            where: leadScope(res, scope, runId, selectedLeadSource, createdAfter),
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
        brightDataApiKey: body.brightDataApiKey as string | undefined,
        googleApiKeys: asListInput(body.googleApiKeys),
        proxyUrls,
      });

      const settings = await loadOperatorSettings(prisma);
      // Replacing or removing a credential resets the engineer's memory for it.
      await pruneQuarantinedCredentials(
        prisma,
        [settings.apifyToken, settings.brightDataApiKey, ...settings.googleApiKeys].filter((value): value is string => Boolean(value))
      );

      // Nova's promise: the moment fresh credentials land, any run that was
      // paused waiting for them picks itself back up — no manual resume.
      const resumedRuns: number[] = [];
      if (runService?.resumeRun && prisma?.run && (settings.apifyToken || settings.googleApiKeys.length)) {
        const operator = currentUser(res);
        const waiting = await prisma.run.findMany({
          where: {
            status: 'waiting_for_credentials',
            OR: [{ userId: operator?.id ?? -1 }, { userId: null }],
          },
          select: { id: true },
        });
        for (const waitingRun of waiting) {
          try {
            await runService.resumeRun(waitingRun.id, {
              googleApiKeys: settings.googleApiKeys,
              apifyToken: settings.apifyToken,
              proxyUrls: settings.proxyUrls,
            });
            resumedRuns.push(waitingRun.id);
          } catch {
            // A run that can't resume yet (e.g. proxy mode without proxies)
            // simply keeps waiting for its moment.
          }
        }
      }

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
          resumedRuns,
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

  router.post(
    '/settings/test/brightdata',
    adminGuard,
    asyncHandler(async (req, res) => {
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const provided = typeof body.brightDataApiKey === 'string' ? body.brightDataApiKey.trim() : '';
      const key = provided || (await loadOperatorSettings(prisma)).brightDataApiKey;
      if (!key) {
        res.status(400).json({ error: 'No Bright Data key to test. Save or paste one first.' });
        return;
      }
      const result = await testBrightDataKey(key);
      if (result.ok) {
        try {
          if (prisma && (await unquarantineCredential(prisma, key))) {
            result.detail = `${result.detail} — quarantine cleared, the engineer trusts this key again`;
          }
        } catch {
          // Quarantine state must never break a credential test.
        }
      }
      res.json({ data: result });
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
