import { createHash } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import {
  buildHiringExplanation,
  companyIdentity,
  HiringRelationship,
  HiringSignalScore,
  IndustryRelationship,
  scoreHiringSignal,
} from './greenhouseSignals';
import {
  STARTER_GREENHOUSE_BOARDS,
  StarterGreenhouseBoard,
} from './greenhouseStarterBoards';
import {
  extractGreenhouseBoardTokens,
  GreenhouseError,
  GreenhouseJob,
} from '../integrations/greenhouseClient';
import { safeFetchWebsite } from '../integrations/safeWebsiteFetcher';

type OriginLane = 'google_maps' | 'sales_navigator' | 'hiring_opportunity';

interface GreenhouseJobsClient {
  listJobs(boardToken: string): Promise<GreenhouseJob[]>;
}

interface CandidateCompany {
  companyKey: string;
  companyName: string;
  normalizedName: string;
  companyDomain?: string;
  website?: string;
  industry?: string;
  location?: string;
  originLane: Exclude<OriginLane, 'hiring_opportunity'>;
}

interface RunFilters {
  industries: string[];
  geographies: string[];
}

interface PendingObservation {
  companyKey: string;
  companyName: string;
  companyDomain?: string;
  originLane: OriginLane;
  score: HiringSignalScore;
  evidenceUrl: string;
  evidenceFingerprint: string;
  relationship: HiringRelationship;
  explanation: string;
  jobs: GreenhouseJob[];
  industry?: string;
}

export interface SafeHiringOpportunity {
  id: number;
  runId: number;
  companyKey: string;
  companyName: string;
  companyDomain?: string;
  originLane: OriginLane;
  score: number;
  components: HiringSignalScore['components'];
  jobs: GreenhouseJob[];
  evidenceUrl: string;
  evidenceFingerprint: string;
  relationship: string;
  explanation: string;
  saved: boolean;
  dismissed: boolean;
  observedAt: string;
}

export interface RunHiringSignals {
  scan: {
    id: number;
    status: string;
    manualRefresh: boolean;
    candidateCount: number;
    inspectedCount: number;
    matchedCount: number;
    opportunityCount: number;
    heartbeatAt?: string;
    completedAt?: string;
    errorMessage?: string;
  } | null;
  matches: {
    google_maps: SafeHiringOpportunity[];
    sales_navigator: SafeHiringOpportunity[];
  };
  opportunities: SafeHiringOpportunity[];
}

export interface PreparedHiringSearch {
  targetLane: 'google_maps' | 'sales_navigator';
  companyName: string;
  website?: string;
  industries: string[];
  geographies: string[];
}

export interface HiringSignalService {
  scheduleIfEligible(runId: number): Promise<{ scheduled: boolean; scanId?: number; reason?: string }>;
  refresh(runId: number): Promise<{ scheduled: boolean; scanId: number }>;
  recoverInterruptedScans(): Promise<void>;
  getRunSignals(runId: number): Promise<RunHiringSignals>;
  updateOpportunity(
    id: number,
    patch: { saved?: boolean; dismissed?: boolean }
  ): Promise<SafeHiringOpportunity>;
  prepareSearch(
    id: number,
    targetLane: 'google_maps' | 'sales_navigator'
  ): Promise<PreparedHiringSearch>;
}

export interface HiringSignalServiceOptions {
  prisma: PrismaClient;
  greenhouseClient: GreenhouseJobsClient;
  fetchPage?: typeof safeFetchWebsite;
  starterBoards?: StarterGreenhouseBoard[];
  now?: () => Date;
  maxConcurrentScans?: number;
}

const ELIGIBLE_RUN_STATUSES = new Set(['completed', 'partially_completed']);
const ACTIVE_SCAN_STATUSES = ['queued', 'running'];
const CACHE_MS = 6 * 60 * 60 * 1_000;
const MAX_BOARDS_PER_SCAN = 25;
const MAX_ADJACENT = 5;

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizedPhrase(value: string | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function safeError(error: unknown): string {
  if (error instanceof GreenhouseError) return error.message;
  if (error instanceof Error) return error.message.slice(0, 500);
  return 'Hiring signal scan could not finish.';
}

function candidateFrom(
  value: {
    companyName?: string | null;
    website?: string | null;
    categoryName?: string | null;
    location?: string | null;
    address?: string | null;
  },
  originLane: Exclude<OriginLane, 'hiring_opportunity'>
): CandidateCompany | undefined {
  const identity = companyIdentity(value);
  if (!value.companyName?.trim() || identity.companyKey === 'name:unknown') return undefined;
  return {
    ...identity,
    companyName: value.companyName.trim().slice(0, 300),
    website: value.website?.trim() || undefined,
    industry: value.categoryName?.trim() || undefined,
    location: value.location?.trim() || value.address?.trim() || undefined,
    originLane,
  };
}

function extractRunFilters(filterJson: string | null): RunFilters {
  const parsed = parseJson<{
    googleMaps?: { categoryFilters?: string[]; locations?: string[] };
    salesNavigator?: { industries?: string[]; geographies?: string[] };
  }>(filterJson, {});
  return {
    industries: uniqueStrings([
      ...(parsed.googleMaps?.categoryFilters ?? []),
      ...(parsed.salesNavigator?.industries ?? []),
    ]),
    geographies: uniqueStrings([
      ...(parsed.googleMaps?.locations ?? []),
      ...(parsed.salesNavigator?.geographies ?? []),
    ]),
  };
}

function boardIndustryRelationship(boardIndustry: string | null, filters: RunFilters): IndustryRelationship {
  if (!filters.industries.length) return 'adjacent';
  const board = normalizedPhrase(boardIndustry ?? '');
  const exact = filters.industries
    .map(normalizedPhrase)
    .some((industry) => industry && board && (industry.includes(board) || board.includes(industry)));
  return exact ? 'exact' : 'adjacent';
}

function boardRelatedToFilters(
  board: { industry: string | null; geographiesJson: string | null },
  filters: RunFilters
): boolean {
  if (!filters.industries.length && !filters.geographies.length) return false;
  const industry = boardIndustryRelationship(board.industry, filters);
  if (industry === 'exact') return true;
  const boardGeographies = parseJson<string[]>(board.geographiesJson, []).map(normalizedPhrase);
  return filters.geographies
    .map(normalizedPhrase)
    .some((wanted) =>
      boardGeographies.some((known) => wanted && known && (wanted.includes(known) || known.includes(wanted)))
    );
}

function explicitCareerLink(html: string, baseUrl: string): string | undefined {
  const hrefPattern = /href\s*=\s*["']([^"'#]+)["']/gi;
  for (const match of html.matchAll(hrefPattern)) {
    const href = match[1];
    if (!/(career|jobs|join-us|join-our-team|work-with-us)/i.test(href)) continue;
    try {
      const url = new URL(href, baseUrl);
      if (url.protocol === 'https:') return url.toString();
    } catch {
      // Ignore malformed links and continue looking for an explicit careers URL.
    }
  }
  return undefined;
}

function httpsWebsite(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    url.protocol = 'https:';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function observationFingerprint(boardToken: string, jobs: GreenhouseJob[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        boardToken,
        jobs: jobs.map((job) => [job.id, job.updatedAt]),
      })
    )
    .digest('hex');
}

function safeOpportunity(record: {
  id: number;
  runId: number;
  companyKey: string;
  companyName: string;
  companyDomain: string | null;
  originLane: string;
  score: number;
  scoreJson: string;
  jobsJson: string;
  evidenceUrl: string;
  evidenceFingerprint: string;
  relationship: string;
  explanation: string | null;
  saved: boolean;
  dismissed: boolean;
  observedAt: Date;
}): SafeHiringOpportunity {
  return {
    id: record.id,
    runId: record.runId,
    companyKey: record.companyKey,
    companyName: record.companyName,
    ...(record.companyDomain ? { companyDomain: record.companyDomain } : {}),
    originLane: record.originLane as OriginLane,
    score: record.score,
    components: parseJson(record.scoreJson, {
      roles: 0,
      recency: 0,
      geography: 0,
      industry: 0,
      breadth: 0,
    }),
    jobs: parseJson(record.jobsJson, []),
    evidenceUrl: record.evidenceUrl,
    evidenceFingerprint: record.evidenceFingerprint,
    relationship: record.relationship,
    explanation: record.explanation ?? '',
    saved: record.saved,
    dismissed: record.dismissed,
    observedAt: record.observedAt.toISOString(),
  };
}

export function createHiringSignalService({
  prisma,
  greenhouseClient,
  fetchPage = safeFetchWebsite,
  starterBoards = STARTER_GREENHOUSE_BOARDS,
  now = () => new Date(),
  maxConcurrentScans = 2,
}: HiringSignalServiceOptions): HiringSignalService {
  const pendingScanIds: number[] = [];
  const queuedScanIds = new Set<number>();
  const schedulingRunIds = new Set<number>();
  let activeScans = 0;

  async function candidatesForRun(runId: number): Promise<{
    run: { id: number; status: string; leadSource: string; filterJson: string | null };
    candidates: CandidateCompany[];
  } | null> {
    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: {
        id: true,
        status: true,
        leadSource: true,
        filterJson: true,
        leads: {
          select: {
            companyName: true,
            website: true,
            categoryName: true,
            location: true,
            address: true,
          },
        },
        businesses: {
          select: {
            companyName: true,
            website: true,
            categoryName: true,
            address: true,
          },
        },
      },
    });
    if (!run) return null;
    const lane: Exclude<OriginLane, 'hiring_opportunity'> =
      run.leadSource === 'sales_navigator' ? 'sales_navigator' : 'google_maps';
    const collected = [
      ...run.leads.map((lead) => candidateFrom(lead, lane)),
      ...run.businesses.map((business) => candidateFrom(business, lane)),
    ].filter((candidate): candidate is CandidateCompany => Boolean(candidate));
    const byKey = new Map<string, CandidateCompany>();
    for (const candidate of collected) {
      const existing = byKey.get(candidate.companyKey);
      byKey.set(candidate.companyKey, existing ? { ...candidate, ...existing } : candidate);
    }
    return {
      run: {
        id: run.id,
        status: run.status,
        leadSource: run.leadSource,
        filterJson: run.filterJson,
      },
      candidates: [...byKey.values()],
    };
  }

  function matchingCandidate(
    board: { companyKey: string; companyName: string; companyDomain: string | null },
    candidates: CandidateCompany[]
  ): CandidateCompany | undefined {
    const domainMatch = board.companyDomain
      ? candidates.find((candidate) => candidate.companyDomain === board.companyDomain)
      : undefined;
    if (domainMatch) return domainMatch;
    const boardName = companyIdentity({ companyName: board.companyName }).normalizedName;
    const nameMatches = candidates.filter((candidate) => candidate.normalizedName === boardName);
    return nameMatches.length === 1 ? nameMatches[0] : undefined;
  }

  async function discoverBoards(candidates: CandidateCompany[]): Promise<void> {
    const known = await prisma.greenhouseBoard.findMany({
      where: { companyKey: { in: candidates.map((candidate) => candidate.companyKey) } },
      select: { companyKey: true },
    });
    const knownKeys = new Set(known.map((board) => board.companyKey));
    for (const candidate of candidates.slice(0, 20)) {
      if (knownKeys.has(candidate.companyKey)) continue;
      const homepage = httpsWebsite(candidate.website);
      if (!homepage) continue;
      try {
        const first = await fetchPage(homepage);
        let tokens = extractGreenhouseBoardTokens(first.html);
        let evidenceUrl = first.finalUrl;
        if (!tokens.length) {
          const careerUrl = explicitCareerLink(first.html, first.finalUrl);
          if (careerUrl) {
            const careerPage = await fetchPage(careerUrl);
            tokens = extractGreenhouseBoardTokens(careerPage.html);
            evidenceUrl = careerPage.finalUrl;
          }
        }
        for (const token of tokens.slice(0, 2)) {
          await prisma.greenhouseBoard.upsert({
            where: { boardToken: token },
            create: {
              boardToken: token,
              companyKey: candidate.companyKey,
              companyName: candidate.companyName,
              companyDomain: candidate.companyDomain,
              industry: candidate.industry,
              geographiesJson: JSON.stringify(uniqueStrings([candidate.location])),
              evidenceUrl,
              discoverySource: 'company_website',
            },
            update: {
              companyKey: candidate.companyKey,
              companyName: candidate.companyName,
              companyDomain: candidate.companyDomain,
              industry: candidate.industry,
              geographiesJson: JSON.stringify(uniqueStrings([candidate.location])),
              evidenceUrl,
              discoverySource: 'company_website',
              invalidAt: null,
            },
          });
        }
      } catch {
        // Missing/inaccessible careers pages are normal skips.
      }
    }
  }

  async function seedRegistry(): Promise<void> {
    for (const board of starterBoards) {
      const identity = companyIdentity({
        companyName: board.companyName,
        website: `https://${board.companyDomain}`,
      });
      await prisma.greenhouseBoard.upsert({
        where: { boardToken: board.boardToken.toLowerCase() },
        create: {
          boardToken: board.boardToken.toLowerCase(),
          companyKey: identity.companyKey,
          companyName: board.companyName,
          companyDomain: identity.companyDomain,
          industry: board.industry,
          geographiesJson: JSON.stringify(board.geographies),
          evidenceUrl: `https://job-boards.greenhouse.io/${board.boardToken.toLowerCase()}`,
          discoverySource: 'starter_registry',
        },
        update: {
          companyKey: identity.companyKey,
          companyName: board.companyName,
          companyDomain: identity.companyDomain,
          industry: board.industry,
          geographiesJson: JSON.stringify(board.geographies),
          evidenceUrl: `https://job-boards.greenhouse.io/${board.boardToken.toLowerCase()}`,
        },
      });
    }
  }

  async function jobsForBoard(
    board: {
      id: number;
      boardToken: string;
      jobsJson: string | null;
      fetchedAt: Date | null;
    },
    bypassCache: boolean
  ): Promise<GreenhouseJob[]> {
    const cacheFresh =
      !bypassCache &&
      board.jobsJson &&
      board.fetchedAt &&
      now().getTime() - board.fetchedAt.getTime() <= CACHE_MS;
    if (cacheFresh) return parseJson(board.jobsJson, []);
    try {
      const jobs = await greenhouseClient.listJobs(board.boardToken);
      await prisma.greenhouseBoard.update({
        where: { id: board.id },
        data: {
          jobsJson: JSON.stringify(jobs),
          fetchedAt: now(),
          verifiedAt: now(),
          invalidAt: null,
        },
      });
      return jobs;
    } catch (error) {
      if (error instanceof GreenhouseError && error.code === 'board_not_found') {
        await prisma.greenhouseBoard.update({
          where: { id: board.id },
          data: { invalidAt: now() },
        });
      }
      throw error;
    }
  }

  async function persistObservation(scanId: number, runId: number, observation: PendingObservation): Promise<void> {
    const previous = await prisma.hiringOpportunity.findFirst({
      where: {
        runId,
        companyKey: observation.companyKey,
        scanId: { not: scanId },
      },
      orderBy: { observedAt: 'desc' },
      select: { saved: true, dismissed: true, evidenceFingerprint: true },
    });
    const evidenceChanged =
      previous && previous.evidenceFingerprint !== observation.evidenceFingerprint;
    await prisma.hiringOpportunity.upsert({
      where: { scanId_companyKey: { scanId, companyKey: observation.companyKey } },
      create: {
        scanId,
        runId,
        companyKey: observation.companyKey,
        companyName: observation.companyName,
        companyDomain: observation.companyDomain,
        originLane: observation.originLane,
        score: observation.score.total,
        scoreJson: JSON.stringify(observation.score.components),
        jobsJson: JSON.stringify(observation.jobs.slice(0, 10)),
        evidenceUrl: observation.evidenceUrl,
        evidenceFingerprint: observation.evidenceFingerprint,
        relationship: observation.relationship,
        explanation: observation.explanation,
        saved: previous?.saved ?? false,
        dismissed: evidenceChanged ? false : previous?.dismissed ?? false,
        observedAt: now(),
      },
      update: {
        score: observation.score.total,
        scoreJson: JSON.stringify(observation.score.components),
        jobsJson: JSON.stringify(observation.jobs.slice(0, 10)),
        evidenceUrl: observation.evidenceUrl,
        evidenceFingerprint: observation.evidenceFingerprint,
        explanation: observation.explanation,
        saved: previous?.saved ?? false,
        dismissed: evidenceChanged ? false : previous?.dismissed ?? false,
        observedAt: now(),
      },
    });
  }

  async function runScan(scanId: number): Promise<void> {
    const scan = await prisma.hiringSignalScan.findUnique({ where: { id: scanId } });
    if (!scan) return;
    const context = await candidatesForRun(scan.runId);
    if (!context) return;
    const filters = extractRunFilters(context.run.filterJson);
    await prisma.hiringSignalScan.update({
      where: { id: scanId },
      data: {
        status: 'running',
        candidateCount: context.candidates.length,
        startedAt: now(),
        heartbeatAt: now(),
        errorMessage: null,
      },
    });
    await prisma.runEvent.create({
      data: {
        runId: scan.runId,
        type: 'hiring_signal_scan_started',
        message: 'Nova is checking public hiring signals — your completed run stays safely finished.',
      },
    });
    const heartbeat = setInterval(() => {
      void prisma.hiringSignalScan
        .update({ where: { id: scanId }, data: { heartbeatAt: now() } })
        .catch(() => {});
    }, 15_000);
    heartbeat.unref?.();

    let inspectedCount = 0;
    let errorCount = 0;
    try {
      await seedRegistry();
      await discoverBoards(context.candidates);
      const allBoards = await prisma.greenhouseBoard.findMany({
        where: { invalidAt: null },
        orderBy: { id: 'asc' },
      });
      const selectedBoards = allBoards
        .filter(
          (board) =>
            Boolean(matchingCandidate(board, context.candidates)) ||
            boardRelatedToFilters(board, filters)
        )
        .slice(0, MAX_BOARDS_PER_SCAN);

      const observations: PendingObservation[] = [];
      for (const board of selectedBoards) {
        try {
          const jobs = await jobsForBoard(board, scan.manualRefresh);
          inspectedCount += 1;
          const candidate = matchingCandidate(board, context.candidates);
          const relationship: HiringRelationship = candidate ? 'exact' : 'adjacent';
          const score = scoreHiringSignal({
            jobs,
            requestedGeographies: filters.geographies,
            industryRelationship: candidate
              ? 'exact'
              : boardIndustryRelationship(board.industry, filters),
            now: now(),
          });
          const threshold = candidate ? 70 : 80;
          if (score.total < threshold) continue;
          const companyName = candidate?.companyName ?? board.companyName;
          const companyKey = candidate?.companyKey ?? board.companyKey;
          observations.push({
            companyKey,
            companyName,
            companyDomain: candidate?.companyDomain ?? board.companyDomain ?? undefined,
            originLane: candidate?.originLane ?? 'hiring_opportunity',
            score,
            evidenceUrl: board.evidenceUrl,
            evidenceFingerprint: observationFingerprint(board.boardToken, score.qualifyingJobs),
            relationship,
            explanation: buildHiringExplanation({
              companyName,
              score,
              relationship,
              now: now(),
            }),
            jobs: score.qualifyingJobs,
            industry: board.industry ?? undefined,
          });
        } catch {
          errorCount += 1;
        } finally {
          await prisma.hiringSignalScan.update({
            where: { id: scanId },
            data: { inspectedCount, heartbeatAt: now() },
          });
        }
      }

      const existing = observations.filter((item) => item.originLane !== 'hiring_opportunity');
      const adjacent = observations
        .filter((item) => item.originLane === 'hiring_opportunity')
        .sort((left, right) => {
          const leftNewest = left.jobs[0]?.updatedAt ?? '';
          const rightNewest = right.jobs[0]?.updatedAt ?? '';
          return (
            right.score.total - left.score.total ||
            right.jobs.length - left.jobs.length ||
            rightNewest.localeCompare(leftNewest) ||
            left.companyName.localeCompare(right.companyName)
          );
        })
        .slice(0, MAX_ADJACENT);
      for (const observation of [...existing, ...adjacent]) {
        await persistObservation(scanId, scan.runId, observation);
      }

      const status = errorCount > 0 ? 'partially_completed' : 'completed';
      const errorMessage =
        errorCount > 0
          ? `${errorCount} public board${errorCount === 1 ? '' : 's'} could not be checked; saved signals are available.`
          : null;
      await prisma.hiringSignalScan.update({
        where: { id: scanId },
        data: {
          status,
          inspectedCount,
          matchedCount: existing.length,
          opportunityCount: adjacent.length,
          heartbeatAt: now(),
          completedAt: now(),
          errorMessage,
        },
      });
      await prisma.runEvent.create({
        data: {
          runId: scan.runId,
          type: 'hiring_signal_scan_completed',
          message:
            existing.length || adjacent.length
              ? `Nova found ${existing.length} hiring signal${existing.length === 1 ? '' : 's'} on your companies and ${adjacent.length} nearby opportunit${adjacent.length === 1 ? 'y' : 'ies'}.`
              : 'Nova checked public hiring signals; nothing strong enough to interrupt you this time.',
          metadataJson: JSON.stringify({
            matchedCount: existing.length,
            opportunityCount: adjacent.length,
            inspectedCount,
            partial: errorCount > 0,
          }),
        },
      });
    } catch (error) {
      const message = safeError(error);
      await prisma.hiringSignalScan
        .update({
          where: { id: scanId },
          data: {
            status: 'failed',
            heartbeatAt: now(),
            completedAt: now(),
            errorMessage: message,
          },
        })
        .catch(() => {});
      await prisma.runEvent
        .create({
          data: {
            runId: scan.runId,
            type: 'hiring_signal_scan_failed',
            message: `Nova couldn't finish the optional hiring check: ${message} Your lead run and saved output are unchanged.`,
          },
        })
        .catch(() => {});
    } finally {
      clearInterval(heartbeat);
    }
  }

  function drainQueue(): void {
    while (activeScans < Math.max(1, Math.min(2, maxConcurrentScans)) && pendingScanIds.length) {
      const scanId = pendingScanIds.shift()!;
      queuedScanIds.delete(scanId);
      activeScans += 1;
      void runScan(scanId).finally(() => {
        activeScans -= 1;
        drainQueue();
      });
    }
  }

  function enqueue(scanId: number): void {
    if (queuedScanIds.has(scanId)) return;
    queuedScanIds.add(scanId);
    pendingScanIds.push(scanId);
    drainQueue();
  }

  async function createQueuedScan(
    runId: number,
    manualRefresh: boolean
  ): Promise<{ scheduled: boolean; scanId?: number; reason?: string }> {
    if (schedulingRunIds.has(runId)) return { scheduled: false, reason: 'already_active' };
    schedulingRunIds.add(runId);
    try {
      const context = await candidatesForRun(runId);
      if (!context) return { scheduled: false, reason: 'run_not_found' };
      if (!ELIGIBLE_RUN_STATUSES.has(context.run.status)) {
        return { scheduled: false, reason: 'ineligible_status' };
      }
      if (!context.candidates.length) return { scheduled: false, reason: 'no_company_candidates' };
      const active = await prisma.hiringSignalScan.findFirst({
        where: { runId, status: { in: ACTIVE_SCAN_STATUSES } },
        orderBy: { id: 'desc' },
      });
      if (active) {
        enqueue(active.id);
        return { scheduled: false, scanId: active.id, reason: 'already_active' };
      }
      if (!manualRefresh) {
        const completed = await prisma.hiringSignalScan.findFirst({
          where: { runId, status: { in: ['completed', 'partially_completed'] } },
        });
        if (completed) return { scheduled: false, scanId: completed.id, reason: 'already_scanned' };
      }
      const scan = await prisma.hiringSignalScan.create({
        data: { runId, status: 'queued', manualRefresh, heartbeatAt: now() },
      });
      enqueue(scan.id);
      return { scheduled: true, scanId: scan.id };
    } finally {
      schedulingRunIds.delete(runId);
    }
  }

  async function scheduleIfEligible(runId: number) {
    return createQueuedScan(runId, false);
  }

  async function refresh(runId: number): Promise<{ scheduled: boolean; scanId: number }> {
    const result = await createQueuedScan(runId, true);
    if (!result.scanId) {
      throw new Error(
        result.reason === 'run_not_found'
          ? 'Run not found.'
          : 'Hiring signals need a completed run with at least one company.'
      );
    }
    return { scheduled: result.scheduled, scanId: result.scanId };
  }

  async function recoverInterruptedScans(): Promise<void> {
    const interrupted = await prisma.hiringSignalScan.findMany({
      where: { status: { in: ACTIVE_SCAN_STATUSES } },
      orderBy: { id: 'asc' },
    });
    for (const scan of interrupted) {
      await prisma.hiringSignalScan.update({
        where: { id: scan.id },
        data: { status: 'queued', heartbeatAt: now() },
      });
      enqueue(scan.id);
    }
  }

  async function getRunSignals(runId: number): Promise<RunHiringSignals> {
    const scan = await prisma.hiringSignalScan.findFirst({
      where: { runId },
      orderBy: { id: 'desc' },
    });
    if (!scan) {
      return {
        scan: null,
        matches: { google_maps: [], sales_navigator: [] },
        opportunities: [],
      };
    }
    const records = await prisma.hiringOpportunity.findMany({
      where: { scanId: scan.id, dismissed: false },
      orderBy: [{ score: 'desc' }, { companyName: 'asc' }],
    });
    const safe = records.map(safeOpportunity);
    return {
      scan: {
        id: scan.id,
        status: scan.status,
        manualRefresh: scan.manualRefresh,
        candidateCount: scan.candidateCount,
        inspectedCount: scan.inspectedCount,
        matchedCount: scan.matchedCount,
        opportunityCount: scan.opportunityCount,
        ...(scan.heartbeatAt ? { heartbeatAt: scan.heartbeatAt.toISOString() } : {}),
        ...(scan.completedAt ? { completedAt: scan.completedAt.toISOString() } : {}),
        ...(scan.errorMessage ? { errorMessage: scan.errorMessage } : {}),
      },
      matches: {
        google_maps: safe.filter((item) => item.originLane === 'google_maps'),
        sales_navigator: safe.filter((item) => item.originLane === 'sales_navigator'),
      },
      opportunities: safe.filter((item) => item.originLane === 'hiring_opportunity').slice(0, MAX_ADJACENT),
    };
  }

  async function updateOpportunity(
    id: number,
    patch: { saved?: boolean; dismissed?: boolean }
  ): Promise<SafeHiringOpportunity> {
    const record = await prisma.hiringOpportunity.update({
      where: { id },
      data: {
        ...(typeof patch.saved === 'boolean' ? { saved: patch.saved } : {}),
        ...(typeof patch.dismissed === 'boolean' ? { dismissed: patch.dismissed } : {}),
      },
    });
    return safeOpportunity(record);
  }

  async function prepareSearch(
    id: number,
    targetLane: 'google_maps' | 'sales_navigator'
  ): Promise<PreparedHiringSearch> {
    const record = await prisma.hiringOpportunity.findUnique({
      where: { id },
      include: { run: { select: { filterJson: true } } },
    });
    if (!record) throw new Error('Hiring opportunity not found.');
    const filters = extractRunFilters(record.run.filterJson);
    const jobs = parseJson<GreenhouseJob[]>(record.jobsJson, []);
    return {
      targetLane,
      companyName: record.companyName,
      ...(record.companyDomain ? { website: `https://${record.companyDomain}` } : {}),
      industries: filters.industries.slice(0, 3),
      geographies: uniqueStrings(jobs.map((job) => job.location)).slice(0, 3),
    };
  }

  return {
    scheduleIfEligible,
    refresh,
    recoverInterruptedScans,
    getRunSignals,
    updateOpportunity,
    prepareSearch,
  };
}
