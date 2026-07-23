import * as fs from 'fs';
import * as path from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { RunRecord, RunStore } from './runService';
import { ApifyRunCheckpoint, NormalizedLead, ProviderStateWrite } from './types';
import { redactSecrets } from './redact';

const LEAD_INSERT_BATCH_SIZE = 1000;

function parseStringArray(value?: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function safeRawJson(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    return JSON.stringify(redactSecrets(JSON.parse(value)));
  } catch {
    return undefined;
  }
}

export interface RunBatchWrite {
  batchKey: string;
  query: string;
  status: string;
  attemptCount?: number;
  resultCount?: number;
  nextAttemptAt?: Date;
  errorCode?: string;
}

export interface RunBatchRecord extends RunBatchWrite {
  id: number;
  runId: number;
}

export interface DiscoveredBusinessWrite {
  identityKey: string;
  provenance?: string[];
  companyName?: string;
  categoryName?: string;
  address?: string;
  website?: string;
  phone?: string;
  placeUrl?: string;
  rating?: number;
  reviewsCount?: number;
  emails?: string[];
  rawJson?: string;
}

export interface DiscoveredBusinessRecord extends DiscoveredBusinessWrite {
  id: number;
  runId: number;
}

export interface LocalFirstRunStore extends RunStore {
  upsertProviderState(runId: number, state: ProviderStateWrite): Promise<void>;
  upsertContact(runId: number, contact: NormalizedLead): Promise<'inserted' | 'duplicate'>;
  upsertBatch(runId: number, batch: RunBatchWrite): Promise<RunBatchRecord>;
  listBatches(runId: number): Promise<RunBatchRecord[]>;
  listRunnableBatches(runId: number, now: Date): Promise<RunBatchRecord[]>;
  upsertBusiness(runId: number, business: DiscoveredBusinessWrite): Promise<'inserted' | 'merged'>;
  listBusinesses(runId: number): Promise<DiscoveredBusinessRecord[]>;
  listRecoverableRuns(): Promise<RunRecord[]>;
  getRun(runId: number): Promise<RunRecord | undefined>;
}

function toRunRecord(run: {
  id: number;
  status: string;
  leadSource: string;
  searchUrl: string | null;
  filterJson: string | null;
  actorId: string;
  maxResults: number;
  apifyRunId: string | null;
  datasetId: string | null;
  leadCount: number;
  errorMessage: string | null;
  businessCount: number;
  localBusinessCount: number;
  googleBusinessCount: number;
  duplicateCount: number;
  websiteCount: number;
  apiRequestBudget: number;
  apiRequestsUsed: number;
  currentRoute: string;
  localConcurrency: number;
  outputMode: string;
  rawContactCount: number;
  companiesWithQualifiedEmailCount: number;
  plannedUnitCount: number;
  completedUnitCount: number;
  extendedRun: boolean;
  lastHeartbeatAt: Date | null;
}): RunRecord {
  return {
    id: run.id,
    status: run.status,
    leadSource: run.leadSource as RunRecord['leadSource'],
    searchUrl: run.searchUrl ?? undefined,
    filterJson: run.filterJson ?? undefined,
    actorId: run.actorId,
    maxResults: run.maxResults,
    apifyRunId: run.apifyRunId ?? undefined,
    datasetId: run.datasetId ?? undefined,
    leadCount: run.leadCount,
    errorMessage: run.errorMessage ?? undefined,
    businessCount: run.businessCount,
    localBusinessCount: run.localBusinessCount,
    googleBusinessCount: run.googleBusinessCount,
    duplicateCount: run.duplicateCount,
    websiteCount: run.websiteCount,
    apiRequestBudget: run.apiRequestBudget,
    apiRequestsUsed: run.apiRequestsUsed,
    currentRoute: run.currentRoute,
    localConcurrency: run.localConcurrency,
    outputMode: run.outputMode as RunRecord['outputMode'],
    rawContactCount: run.rawContactCount,
    companiesWithQualifiedEmailCount: run.companiesWithQualifiedEmailCount,
    plannedUnitCount: run.plannedUnitCount,
    completedUnitCount: run.completedUnitCount,
    extendedRun: run.extendedRun,
    lastHeartbeatAt: run.lastHeartbeatAt ?? undefined,
  };
}

export class PrismaRunStore implements LocalFirstRunStore {
  constructor(private readonly prisma: PrismaClient) {}

  async createRun(data: Omit<RunRecord, 'id'>): Promise<RunRecord> {
    const run = await this.prisma.run.create({
      data: {
        ...data,
        outputMode: data.outputMode,
        rawContactCount: data.rawContactCount,
        companiesWithQualifiedEmailCount: data.companiesWithQualifiedEmailCount,
        plannedUnitCount: data.plannedUnitCount,
        completedUnitCount: data.completedUnitCount,
        extendedRun: data.extendedRun,
        lastHeartbeatAt: data.lastHeartbeatAt,
      },
    });
    return toRunRecord(run);
  }

  async updateRun(id: number, data: Partial<RunRecord>): Promise<RunRecord> {
    const run = await this.prisma.run.update({
      where: { id },
      data: {
        ...data,
        outputMode: data.outputMode,
        rawContactCount: data.rawContactCount,
        companiesWithQualifiedEmailCount: data.companiesWithQualifiedEmailCount,
        plannedUnitCount: data.plannedUnitCount,
        completedUnitCount: data.completedUnitCount,
        extendedRun: data.extendedRun,
        lastHeartbeatAt: data.lastHeartbeatAt,
      },
    });
    return toRunRecord(run);
  }

  async upsertProviderState(runId: number, state: ProviderStateWrite): Promise<void> {
    await this.prisma.runProviderState.upsert({
      where: { runId_provider: { runId, provider: state.provider } },
      create: { runId, ...state },
      update: state,
    });
  }

  async upsertContact(
    runId: number,
    contact: NormalizedLead
  ): Promise<'inserted' | 'duplicate'> {
    if (!contact.normalizedEmail) {
      throw new Error('Normalized email is required for contact persistence.');
    }
    try {
      await this.prisma.lead.create({
        data: {
          runId,
          leadSource: contact.leadSource,
          leadType: contact.leadType,
          companyName: contact.companyName,
          email: contact.email,
          normalizedEmail: contact.normalizedEmail,
          contactQuality: contact.contactQuality ?? 'qualified',
          qualityReason: contact.qualityReason,
          businessIdentityKey: contact.businessIdentityKey,
          website: contact.website,
          rawJson: contact.rawJson,
        },
      });
      return 'inserted';
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return 'duplicate';
      }
      throw error;
    }
  }

  async addEvent(runId: number, type: string, message: string, metadata?: unknown): Promise<void> {
    await this.prisma.runEvent.create({
      data: {
        runId,
        type,
        message,
        metadataJson: metadata ? JSON.stringify(redactSecrets(metadata)) : undefined,
      },
    });
  }

  async addLeads(runId: number, leads: NormalizedLead[]): Promise<void> {
    if (!leads.length) return;
    for (let index = 0; index < leads.length; index += LEAD_INSERT_BATCH_SIZE) {
      const batch = leads.slice(index, index + LEAD_INSERT_BATCH_SIZE);
      await this.prisma.lead.createMany({
        data: batch.map((lead) => ({
          runId,
          leadSource: lead.leadSource,
          leadType: lead.leadType,
          fullName: lead.fullName,
          firstName: lead.firstName,
          lastName: lead.lastName,
          jobTitle: lead.jobTitle,
          companyName: lead.companyName,
          email: lead.email,
          normalizedEmail: lead.normalizedEmail,
          contactQuality: lead.contactQuality ?? 'qualified',
          qualityReason: lead.qualityReason,
          businessIdentityKey: lead.businessIdentityKey,
          phone: lead.phone,
          location: lead.location,
          profileUrl: lead.profileUrl,
          connectionDegree: lead.connectionDegree,
          categoryName: lead.categoryName,
          address: lead.address,
          website: lead.website,
          rating: lead.rating,
          reviewsCount: lead.reviewsCount,
          placeUrl: lead.placeUrl,
          rawJson: lead.rawJson,
        })),
      });
    }
  }

  async addErrorLog(error: {
    runId?: number;
    requestId?: string;
    source: string;
    severity: 'error' | 'warn' | 'info';
    message: string;
    details?: unknown;
  }): Promise<void> {
    await this.prisma.errorLog.create({
      data: {
        runId: error.runId,
        requestId: error.requestId,
        source: error.source,
        severity: error.severity,
        message: error.message,
        detailsJson: error.details ? JSON.stringify(redactSecrets(error.details)) : undefined,
      },
    });
  }

  async upsertBatch(runId: number, batch: RunBatchWrite): Promise<RunBatchRecord> {
    const saved = await this.prisma.runBatch.upsert({
      where: { runId_batchKey: { runId, batchKey: batch.batchKey } },
      create: { runId, ...batch },
      update: {
        query: batch.query,
        status: batch.status,
        attemptCount: batch.attemptCount,
        resultCount: batch.resultCount,
        nextAttemptAt: batch.nextAttemptAt,
        errorCode: batch.errorCode,
      },
    });
    return { ...saved, nextAttemptAt: saved.nextAttemptAt ?? undefined, errorCode: saved.errorCode ?? undefined };
  }

  async listRunnableBatches(runId: number, now: Date): Promise<RunBatchRecord[]> {
    const batches = await this.prisma.runBatch.findMany({
      where: {
        runId,
        status: { in: ['pending', 'retry'] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { id: 'asc' },
    });
    return batches.map((batch) => ({ ...batch, nextAttemptAt: batch.nextAttemptAt ?? undefined, errorCode: batch.errorCode ?? undefined }));
  }

  async listBatches(runId: number): Promise<RunBatchRecord[]> {
    const batches = await this.prisma.runBatch.findMany({ where: { runId }, orderBy: { id: 'asc' } });
    return batches.map((batch) => ({ ...batch, nextAttemptAt: batch.nextAttemptAt ?? undefined, errorCode: batch.errorCode ?? undefined }));
  }

  async upsertBusiness(runId: number, business: DiscoveredBusinessWrite): Promise<'inserted' | 'merged'> {
    const existing = await this.prisma.discoveredBusiness.findUnique({
      where: { runId_identityKey: { runId, identityKey: business.identityKey } },
    });
    const existingSources = parseStringArray(existing?.sourceJson);
    const existingEmails = parseStringArray(existing?.emailsJson);
    const provenance = [...new Set([...existingSources, ...(business.provenance ?? [])])];
    const emails = [...new Set([...existingEmails, ...(business.emails ?? [])])];
    const safeRaw = safeRawJson(business.rawJson);
    const data = {
      sourceJson: JSON.stringify(provenance),
      companyName: business.companyName || existing?.companyName,
      categoryName: business.categoryName || existing?.categoryName,
      address: business.address || existing?.address,
      website: business.website || existing?.website,
      phone: business.phone || existing?.phone,
      placeUrl: business.placeUrl || existing?.placeUrl,
      rating: business.rating ?? existing?.rating,
      reviewsCount: business.reviewsCount ?? existing?.reviewsCount,
      emailsJson: emails.length ? JSON.stringify(emails) : existing?.emailsJson,
      rawJson: safeRaw || existing?.rawJson,
    };

    if (existing) {
      await this.prisma.discoveredBusiness.update({ where: { id: existing.id }, data });
      return 'merged';
    }
    await this.prisma.discoveredBusiness.create({ data: { runId, identityKey: business.identityKey, ...data } });
    return 'inserted';
  }

  async listBusinesses(runId: number): Promise<DiscoveredBusinessRecord[]> {
    const businesses = await this.prisma.discoveredBusiness.findMany({ where: { runId }, orderBy: { id: 'asc' } });
    return businesses.map((business) => ({
      id: business.id,
      runId: business.runId,
      identityKey: business.identityKey,
      provenance: parseStringArray(business.sourceJson),
      companyName: business.companyName ?? undefined,
      categoryName: business.categoryName ?? undefined,
      address: business.address ?? undefined,
      website: business.website ?? undefined,
      phone: business.phone ?? undefined,
      placeUrl: business.placeUrl ?? undefined,
      rating: business.rating ?? undefined,
      reviewsCount: business.reviewsCount ?? undefined,
      emails: parseStringArray(business.emailsJson),
      rawJson: business.rawJson ?? undefined,
    }));
  }

  async listRecoverableRuns(): Promise<RunRecord[]> {
    const runs = await this.prisma.run.findMany({
      where: {
        actorId: 'local_first',
        status: { in: ['queued', 'running', 'waiting_for_scraper', 'cooling_down'] },
      },
      orderBy: { id: 'asc' },
    });
    return runs.map(toRunRecord);
  }

  async getRun(runId: number): Promise<RunRecord | undefined> {
    const run = await this.prisma.run.findUnique({ where: { id: runId } });
    return run ? toRunRecord(run) : undefined;
  }
}

export interface ApifyCheckpointStore {
  load(): Promise<ApifyRunCheckpoint>;
  save(checkpoint: ApifyRunCheckpoint): Promise<void>;
}

export class FileApifyCheckpointStore implements ApifyCheckpointStore {
  private readonly filePath: string;

  constructor(dataDir: string, filename = 'apify_checkpoint.json') {
    this.filePath = path.join(dataDir, filename);
  }

  async load(): Promise<ApifyRunCheckpoint> {
    if (!fs.existsSync(this.filePath)) {
      return {
        target: 100_000,
        runs: [],
        completedDatasets: [],
        queuedIndex: 0,
        uniqueCount: 0,
      };
    }
    const raw = fs.readFileSync(this.filePath, 'utf-8');
    return JSON.parse(raw) as ApifyRunCheckpoint;
  }

  async save(checkpoint: ApifyRunCheckpoint): Promise<void> {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(checkpoint, null, 2), 'utf-8');
  }
}
