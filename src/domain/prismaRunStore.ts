import { PrismaClient } from '@prisma/client';
import { RunRecord, RunStore } from './runService';
import { NormalizedLead } from './types';
import { redactSecrets } from './redact';

const LEAD_INSERT_BATCH_SIZE = 1000;

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
  };
}

export class PrismaRunStore implements RunStore {
  constructor(private readonly prisma: PrismaClient) {}

  async createRun(data: Omit<RunRecord, 'id'>): Promise<RunRecord> {
    const run = await this.prisma.run.create({ data });
    return toRunRecord(run);
  }

  async updateRun(id: number, data: Partial<RunRecord>): Promise<RunRecord> {
    const run = await this.prisma.run.update({ where: { id }, data });
    return toRunRecord(run);
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
}
