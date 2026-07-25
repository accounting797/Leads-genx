import { randomBytes } from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { asyncHandler } from '../utils/asyncHandler';
import { AuthUser, currentUser } from '../domain/auth';

const EXTENSION_LEAD_SOURCE = 'sales_navigator';
const EXTENSION_ACTOR_ID = 'sn_extension';
const EXTENSION_MAX_RESULTS = 10000;
const MAX_LEADS_PER_CALL = 100;

export interface ExtensionDeps {
  prisma: PrismaClient;
  /** Session guard (requireAuth when auth is enabled, pass-through otherwise). */
  guard: (req: Request, res: Response, next: NextFunction) => void;
}

interface ExtensionLeadInput {
  fullName?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  title?: unknown;
  company?: unknown;
  companyUrl?: unknown;
  profileUrl?: unknown;
  location?: unknown;
  connectionDegree?: unknown;
  snippet?: unknown;
}

function asTrimmedString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const str = String(value).trim();
  return str || undefined;
}

function newExtensionToken(): string {
  // 48 hex chars, generated on demand. Never logged.
  return randomBytes(24).toString('hex');
}

function parseSessionId(filterJson: string | null): string | undefined {
  if (!filterJson) return undefined;
  try {
    const parsed = JSON.parse(filterJson);
    return typeof parsed?.extensionSessionId === 'string' ? parsed.extensionSessionId : undefined;
  } catch {
    return undefined;
  }
}

export function createExtensionRouter({ prisma, guard }: ExtensionDeps) {
  const router = Router();

  /**
   * Bearer-token auth for extension calls: exact match against
   * User.extensionToken. If nobody has a token yet it simply won't match.
   */
  const extensionAuth = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    res.locals.extensionUser = null;
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
    if (token) {
      const user = await prisma.user.findFirst({ where: { extensionToken: token } });
      if (user) {
        res.locals.extensionUser = user;
      }
    }
    if (!res.locals.extensionUser) {
      res.status(401).json({ error: 'Invalid extension token' });
      return;
    }
    next();
  });

  function extensionUser(res: Response): { id: number; username: string } {
    return res.locals.extensionUser as { id: number; username: string };
  }

  async function findSessionRun(userId: number, sessionId: string) {
    const candidates = await prisma.run.findMany({
      where: { userId, actorId: EXTENSION_ACTOR_ID, leadSource: EXTENSION_LEAD_SOURCE },
    });
    return candidates.find((run) => parseSessionId(run.filterJson) === sessionId) ?? null;
  }

  router.get(
    '/ping',
    extensionAuth,
    asyncHandler(async (_req, res) => {
      const user = extensionUser(res);
      res.json({ data: { ok: true, username: user.username, server: 'leadsgenx' } });
    })
  );

  router.get(
    '/token',
    guard,
    asyncHandler(async (_req, res) => {
      const user: AuthUser | null = currentUser(res);
      if (!user) {
        res.status(401).json({ error: 'Sign in required.' });
        return;
      }
      const record = await prisma.user.findUnique({ where: { id: user.id } });
      if (!record) {
        res.status(401).json({ error: 'Sign in required.' });
        return;
      }
      if (record.extensionToken) {
        res.json({ data: { token: record.extensionToken } });
        return;
      }
      const token = newExtensionToken();
      await prisma.user.update({ where: { id: user.id }, data: { extensionToken: token } });
      res.json({ data: { token } });
    })
  );

  router.post(
    '/token/regenerate',
    guard,
    asyncHandler(async (_req, res) => {
      const user: AuthUser | null = currentUser(res);
      if (!user) {
        res.status(401).json({ error: 'Sign in required.' });
        return;
      }
      const token = newExtensionToken();
      await prisma.user.update({ where: { id: user.id }, data: { extensionToken: token } });
      res.json({ data: { token } });
    })
  );

  router.post(
    '/leads',
    extensionAuth,
    asyncHandler(async (req, res) => {
      const user = extensionUser(res);
      const body = (req.body ?? {}) as {
        sessionId?: unknown;
        runName?: unknown;
        page?: unknown;
        leads?: unknown;
      };

      const sessionId = asTrimmedString(body.sessionId);
      if (!sessionId) {
        res.status(400).json({ error: 'sessionId is required.' });
        return;
      }
      if (!Array.isArray(body.leads) || body.leads.length === 0) {
        res.status(400).json({ error: 'leads must be a non-empty array.' });
        return;
      }
      if (body.leads.length > MAX_LEADS_PER_CALL) {
        res.status(413).json({ error: `Too many leads in one batch (max ${MAX_LEADS_PER_CALL}).` });
        return;
      }

      const runName = asTrimmedString(body.runName);
      const page = typeof body.page === 'number' && Number.isFinite(body.page) ? Math.trunc(body.page) : 0;

      // Find-or-create ONE run per (user, sessionId). A finished run stays
      // finished if late leads arrive — we still ingest, never reopen.
      let run = await findSessionRun(user.id, sessionId);
      if (!run) {
        run = await prisma.run.create({
          data: {
            userId: user.id,
            status: 'running',
            leadSource: EXTENSION_LEAD_SOURCE,
            actorId: EXTENSION_ACTOR_ID,
            maxResults: EXTENSION_MAX_RESULTS,
            filterJson: JSON.stringify({ extensionSessionId: sessionId, runName }),
            searchUrl: runName || 'Sales Navigator extension',
          },
        });
      }

      // Dedupe within the run by profileUrl — fetch existing URLs once.
      const existing = await prisma.lead.findMany({
        where: { runId: run.id, profileUrl: { not: null } },
        select: { profileUrl: true },
      });
      const seen = new Set(existing.map((lead) => lead.profileUrl as string));

      let skipped = 0;
      let duplicates = 0;
      const rows = [] as Array<Record<string, unknown>>;
      for (const raw of body.leads as ExtensionLeadInput[]) {
        const fullName = asTrimmedString(raw?.fullName);
        const profileUrl = asTrimmedString(raw?.profileUrl);
        if (!fullName || !profileUrl) {
          skipped += 1;
          continue;
        }
        if (seen.has(profileUrl)) {
          duplicates += 1;
          continue;
        }
        seen.add(profileUrl);
        rows.push({
          runId: run.id,
          leadSource: EXTENSION_LEAD_SOURCE,
          leadType: 'linkedin_profile',
          fullName,
          firstName: asTrimmedString(raw.firstName) ?? null,
          lastName: asTrimmedString(raw.lastName) ?? null,
          jobTitle: asTrimmedString(raw.title) ?? null,
          companyName: asTrimmedString(raw.company) ?? null,
          profileUrl,
          location: asTrimmedString(raw.location) ?? null,
          connectionDegree: asTrimmedString(raw.connectionDegree) ?? null,
          contactQuality: 'qualified',
          qualityReason: 'Captured by the Leads-GenX extension',
          rawJson: JSON.stringify(raw),
        });
      }

      if (rows.length > 0) {
        await prisma.lead.createMany({ data: rows as never });
      }

      const totalLeads = await prisma.lead.count({ where: { runId: run.id } });
      await prisma.run.update({
        where: { id: run.id },
        data: {
          leadCount: totalLeads,
          lastHeartbeatAt: new Date(),
          completedUnitCount: Math.max(run.completedUnitCount, page),
        },
      });
      await prisma.runEvent.create({
        data: {
          runId: run.id,
          type: 'extension_leads_ingested',
          message: `Nova here — your extension just sent ${rows.length} new leads from page ${page} (${duplicates} duplicates skipped).`,
        },
      });

      res.json({
        data: { runId: run.id, inserted: rows.length, duplicates, skipped, totalLeads },
      });
    })
  );

  router.post(
    '/finish',
    extensionAuth,
    asyncHandler(async (req, res) => {
      const user = extensionUser(res);
      const sessionId = asTrimmedString((req.body as { sessionId?: unknown } | undefined)?.sessionId);
      if (!sessionId) {
        res.status(400).json({ error: 'sessionId is required.' });
        return;
      }
      const run = await findSessionRun(user.id, sessionId);
      if (!run) {
        res.status(404).json({ error: 'No run found for this session.' });
        return;
      }
      const totalLeads = await prisma.lead.count({ where: { runId: run.id } });
      await prisma.run.update({
        where: { id: run.id },
        data: { status: 'completed', completedAt: new Date(), leadCount: totalLeads },
      });
      await prisma.runEvent.create({
        data: {
          runId: run.id,
          type: 'extension_session_finished',
          message: `Scraping session complete — ${totalLeads} leads collected.`,
        },
      });
      res.json({ data: { runId: run.id, totalLeads } });
    })
  );

  return router;
}
