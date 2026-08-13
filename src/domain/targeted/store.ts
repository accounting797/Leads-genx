import { Prisma, PrismaClient } from '@prisma/client';
import { redactSecrets } from '../redact';
import {
  TargetedCampaignRecord,
  TargetedCampaignStatus,
  TargetedCandidateRecord,
  TargetedDraftInput,
  TargetedFilters,
  TargetedQualityTier,
  TargetedWorkUnitRecord,
  VerificationDepth,
} from './types';
import { PlannedTargetedQuery } from './queryPlanner';
import { WorkPerformanceMetric } from './adaptiveScheduler';
import { evaluateGeography } from './geographyEvidence';

export interface CandidateWrite {
  email: string;
  fullName?: string;
  jobTitle?: string;
  companyName?: string;
  website?: string;
  phone?: string;
  address?: string;
  visibleProvider?: string;
  infrastructureProviders: string[];
  relevanceScore: number;
  relevanceReason?: string;
  qualityTier: TargetedQualityTier;
  verificationDepth: VerificationDepth;
  complianceStatus: string;
  artifactId?: number;
  evidence?: { evidenceType: string; excerpt?: string; fields?: unknown };
  verification?: { checkType: string; status: string; reason?: string; depth: VerificationDepth; providerVersion?: string };
}

export interface CampaignStatusWrite {
  status: TargetedCampaignStatus;
  errorMessage?: string | null;
  startedAt?: Date;
  completedAt?: Date;
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function campaignRecord(row: {
  id: number; userId: number; status: string; prompt: string; filterJson: string;
  plannedUnitCount: number; completedUnitCount: number; discoveredCount: number; alignedCount: number;
  strictCount: number; mailboxVerifiedCount: number; reviewCount: number; rejectedCount: number;
  errorMessage: string | null; createdAt: Date; updatedAt: Date;
}): TargetedCampaignRecord {
  return {
    id: row.id, userId: row.userId, status: row.status as TargetedCampaignStatus, prompt: row.prompt,
    filters: parseJson<TargetedFilters>(row.filterJson, {} as TargetedFilters),
    funnel: {
      discovered: row.discoveredCount, aligned: row.alignedCount, strict: row.strictCount,
      mailboxVerified: row.mailboxVerifiedCount, review: row.reviewCount,
      rejected: row.rejectedCount, exported: row.strictCount,
    },
    plannedUnitCount: row.plannedUnitCount, completedUnitCount: row.completedUnitCount,
    errorMessage: row.errorMessage ?? undefined, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

function candidateRecord(row: {
  id: number; campaignId: number; email: string; normalizedEmail: string; fullName: string | null;
  jobTitle: string | null; companyName: string | null; website: string | null; phone: string | null;
  address: string | null; visibleProvider: string | null; infrastructureJson: string; relevanceScore: number;
  relevanceReason: string | null; qualityTier: string; verificationDepth: string; complianceStatus: string;
}): TargetedCandidateRecord {
  return {
    id: row.id, campaignId: row.campaignId, email: row.email, normalizedEmail: row.normalizedEmail,
    fullName: row.fullName ?? undefined, jobTitle: row.jobTitle ?? undefined,
    companyName: row.companyName ?? undefined, website: row.website ?? undefined,
    phone: row.phone ?? undefined, address: row.address ?? undefined,
    visibleProvider: row.visibleProvider ?? undefined,
    infrastructureProviders: parseJson<string[]>(row.infrastructureJson, []),
    relevanceScore: row.relevanceScore, relevanceReason: row.relevanceReason ?? undefined,
    qualityTier: row.qualityTier as TargetedQualityTier,
    verificationDepth: row.verificationDepth as VerificationDepth,
    complianceStatus: row.complianceStatus,
  };
}

export class PrismaTargetedStore {
  constructor(private readonly prisma: PrismaClient) {}

  async createDraft(userId: number, input: TargetedDraftInput): Promise<TargetedCampaignRecord> {
    const row = await this.prisma.targetedCampaign.create({
      data: {
        userId, prompt: input.prompt, filterJson: JSON.stringify(input),
        policyJson: JSON.stringify({ publicBusinessContactsOnly: true, catalogVersion: '2026-08-03' }),
      },
    });
    return campaignRecord(row);
  }

  async get(id: number): Promise<TargetedCampaignRecord | undefined> {
    const row = await this.prisma.targetedCampaign.findUnique({ where: { id } });
    return row ? campaignRecord(row) : undefined;
  }

  async list(limit = 50, userId?: number): Promise<TargetedCampaignRecord[]> {
    return (await this.prisma.targetedCampaign.findMany({ where: userId ? { userId } : undefined, orderBy: { createdAt: 'desc' }, take: Math.min(100, limit) }))
      .map(campaignRecord);
  }

  async updateFilters(campaignId: number, filters: TargetedDraftInput): Promise<void> {
    await this.prisma.targetedCampaign.update({
      where: { id: campaignId }, data: { filterJson: JSON.stringify(filters) },
    });
  }

  async replaceWorkUnits(campaignId: number, units: PlannedTargetedQuery[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.targetedWorkUnit.deleteMany({ where: { campaignId } });
      for (const unit of units) {
        await tx.targetedWorkUnit.create({ data: {
          campaignId, workKey: unit.workKey, connector: unit.connector, query: unit.query,
          documentType: unit.documentType, geographyJson: JSON.stringify(unit.geography),
          status: 'pending',
        } });
      }
      await tx.targetedCampaign.update({
        where: { id: campaignId },
        data: { status: 'planned', plannedUnitCount: units.length, completedUnitCount: 0 },
      });
    });
  }

  async listWorkUnits(campaignId: number, executableOnly = false): Promise<TargetedWorkUnitRecord[]> {
    const rows = await this.prisma.targetedWorkUnit.findMany({
      where: { campaignId, ...(executableOnly ? { status: { notIn: ['skipped_unavailable', 'skipped_budget'] } } : {}) },
      orderBy: { id: 'asc' },
    });
    const campaign = await this.prisma.targetedCampaign.findUnique({ where: { id: campaignId }, select: { userId: true } });
    const prior = campaign && rows.length ? await this.prisma.targetedWorkUnit.groupBy({
      by: ['workKey'], where: { workKey: { in: rows.map((row) => row.workKey) }, campaignId: { not: campaignId }, campaign: { userId: campaign.userId } },
      _count: { _all: true },
    }) : [];
    const priorCounts = new Map(prior.map((entry) => [entry.workKey, entry._count._all]));
    return rows.map((row) => ({
      id: row.id, campaignId: row.campaignId, workKey: row.workKey, connector: row.connector,
      query: row.query, documentType: row.documentType, geography: parseJson(row.geographyJson, {
        country: 'US', areaCode: '', state: '', city: '', postalCode: '',
      }), status: row.status, resultCount: row.resultCount, previousUseCount: priorCounts.get(row.workKey) ?? 0,
    }));
  }

  async usedWorkKeys(userId: number, excludeCampaignId?: number): Promise<Set<string>> {
    const rows = await this.prisma.targetedWorkUnit.findMany({
      where: { campaign: { userId }, ...(excludeCampaignId ? { campaignId: { not: excludeCampaignId } } : {}) },
      select: { workKey: true },
    });
    return new Set(rows.map((row) => row.workKey));
  }

  async usedGeographyKeys(userId: number): Promise<Set<string>> {
    const rows = await this.prisma.targetedWorkUnit.findMany({ where: { campaign: { userId } }, select: { geographyJson: true } });
    return new Set(rows.map((row) => {
      const geography = parseJson<{ country?: string; areaCode?: string; city?: string; state?: string; postalCode?: string }>(row.geographyJson, {});
      return [geography.country, geography.areaCode, geography.city, geography.state, geography.postalCode]
        .map((value) => String(value ?? '').trim().toLowerCase()).join('|');
    }));
  }

  async updateWorkUnit(id: number, data: { status: string; resultCount?: number; errorCode?: string; errorMessage?: string }): Promise<void> {
    await this.prisma.targetedWorkUnit.update({
      where: { id }, data: {
        status: data.status, resultCount: data.resultCount, errorCode: data.errorCode,
        errorMessage: data.errorMessage?.slice(0, 1_000),
        attemptCount: data.status === 'running' ? { increment: 1 } : undefined,
      },
    });
    const unit = await this.prisma.targetedWorkUnit.findUnique({ where: { id }, select: { campaignId: true } });
    if (unit) {
      const completed = await this.prisma.targetedWorkUnit.count({
        where: { campaignId: unit.campaignId, status: { in: ['completed', 'failed', 'cancelled', 'skipped_unavailable', 'skipped_budget'] } },
      });
      await this.prisma.targetedCampaign.update({ where: { id: unit.campaignId }, data: { completedUnitCount: completed } });
    }
  }

  async recordWorkUnitMetric(id: number, metric: WorkPerformanceMetric): Promise<void> {
    await this.prisma.targetedWorkUnit.update({
      where: { id }, data: { checkpointJson: JSON.stringify({ adaptiveMetric: metric }) },
    });
  }

  async recentWorkMetrics(limit = 2_000): Promise<WorkPerformanceMetric[]> {
    const rows = await this.prisma.targetedWorkUnit.findMany({
      where: { checkpointJson: { not: null } }, select: { checkpointJson: true },
      orderBy: { updatedAt: 'desc' }, take: Math.min(5_000, Math.max(1, limit)),
    });
    return rows.flatMap((row) => {
      const value = parseJson<{ adaptiveMetric?: WorkPerformanceMetric }>(row.checkpointJson ?? '', {});
      return value.adaptiveMetric ? [value.adaptiveMetric] : [];
    });
  }

  async resetWorkMetrics(): Promise<number> {
    const result = await this.prisma.targetedWorkUnit.updateMany({
      where: { checkpointJson: { not: null } }, data: { checkpointJson: null },
    });
    return result.count;
  }

  async editWorkUnit(campaignId: number, unitId: number, query: string): Promise<TargetedWorkUnitRecord | undefined> {
    const existing = await this.prisma.targetedWorkUnit.findFirst({ where: { id: unitId, campaignId } });
    if (!existing) return undefined;
    const row = await this.prisma.targetedWorkUnit.update({
      where: { id: unitId }, data: { query: query.trim().slice(0, 2_000) },
    });
    return {
      id: row.id, campaignId: row.campaignId, workKey: row.workKey, connector: row.connector,
      query: row.query, documentType: row.documentType,
      geography: parseJson(row.geographyJson, { country: 'US', areaCode: '', state: '', city: '', postalCode: '' }),
      status: row.status, resultCount: row.resultCount,
    };
  }

  async updateStatus(id: number, write: CampaignStatusWrite): Promise<void> {
    await this.prisma.targetedCampaign.update({ where: { id }, data: {
      status: write.status, errorMessage: write.errorMessage,
      startedAt: write.startedAt, completedAt: write.completedAt,
    } });
  }

  async stop(id: number): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.targetedCampaign.update({ where: { id }, data: { status: 'cancelled', completedAt: new Date() } }),
      this.prisma.targetedWorkUnit.updateMany({ where: { campaignId: id, status: { in: ['pending', 'running'] } }, data: { status: 'cancelled' } }),
    ]);
  }

  async deleteCampaign(id: number): Promise<void> {
    await this.prisma.targetedCampaign.delete({ where: { id } });
  }

  async isCancelled(id: number): Promise<boolean> {
    return (await this.prisma.targetedCampaign.findUnique({ where: { id }, select: { status: true } }))?.status === 'cancelled';
  }

  async createArtifact(campaignId: number, input: { canonicalUrl: string; sourceType: string; retrievalStatus: string; contentType?: string; httpStatus?: number; metadata?: unknown }): Promise<number> {
    const metadataJson = input.metadata === undefined ? undefined : JSON.stringify(redactSecrets(input.metadata)).slice(0, 16_384);
    const artifact = await this.prisma.targetedSourceArtifact.upsert({
      where: { campaignId_canonicalUrl: { campaignId, canonicalUrl: input.canonicalUrl } },
      create: { campaignId, canonicalUrl: input.canonicalUrl, sourceType: input.sourceType, retrievalStatus: input.retrievalStatus, contentType: input.contentType, httpStatus: input.httpStatus, metadataJson },
      update: { retrievalStatus: input.retrievalStatus, contentType: input.contentType, httpStatus: input.httpStatus, metadataJson },
    });
    return artifact.id;
  }

  async upsertCandidate(campaignId: number, write: CandidateWrite): Promise<TargetedCandidateRecord> {
    const normalizedEmail = write.email.trim().toLowerCase();
    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.targetedCandidate.findUnique({
        where: { campaignId_normalizedEmail: { campaignId, normalizedEmail } },
      });
      const tierRank: Record<string, number> = { rejected: 0, review: 1, strict: 2 };
      const incomingWins = !existing || tierRank[write.qualityTier] > tierRank[existing.qualityTier]
        || (tierRank[write.qualityTier] === tierRank[existing.qualityTier] && write.relevanceScore > existing.relevanceScore);
      const relevanceScore = incomingWins ? write.relevanceScore : existing!.relevanceScore;
      const relevanceReason = incomingWins ? write.relevanceReason : existing!.relevanceReason;
      const qualityTier = incomingWins ? write.qualityTier : existing!.qualityTier;
      const verificationDepth = incomingWins ? write.verificationDepth : existing!.verificationDepth;
      const candidate = await tx.targetedCandidate.upsert({
        where: { campaignId_normalizedEmail: { campaignId, normalizedEmail } },
        create: {
          campaignId, normalizedEmail, email: normalizedEmail, fullName: write.fullName,
          jobTitle: write.jobTitle, companyName: write.companyName, website: write.website,
          phone: write.phone, address: write.address, visibleProvider: write.visibleProvider,
          infrastructureJson: JSON.stringify(write.infrastructureProviders), relevanceScore: write.relevanceScore,
          relevanceReason: write.relevanceReason, qualityTier: write.qualityTier,
          verificationDepth: write.verificationDepth, complianceStatus: write.complianceStatus,
        },
        update: {
          fullName: write.fullName, jobTitle: write.jobTitle, companyName: write.companyName,
          website: write.website, phone: write.phone, address: write.address,
          visibleProvider: write.visibleProvider, infrastructureJson: JSON.stringify(write.infrastructureProviders),
          relevanceScore, relevanceReason, qualityTier, verificationDepth,
          complianceStatus: write.complianceStatus,
        },
      });
      if (write.evidence) await tx.targetedEvidence.create({ data: {
        candidateId: candidate.id, artifactId: write.artifactId,
        evidenceType: write.evidence.evidenceType, excerpt: write.evidence.excerpt?.slice(0, 500),
        fieldsJson: write.evidence.fields === undefined ? undefined : JSON.stringify(redactSecrets(write.evidence.fields)).slice(0, 16_384),
      } });
      if (write.verification) await tx.targetedVerification.create({ data: {
        candidateId: candidate.id, checkType: write.verification.checkType,
        status: write.verification.status, reason: write.verification.reason,
        depth: write.verification.depth, providerVersion: write.verification.providerVersion,
      } });
      return candidate;
    });
    await this.refreshFunnel(campaignId);
    return candidateRecord(row);
  }

  async refreshFunnel(campaignId: number): Promise<void> {
    const [discovered, aligned, strict, mailboxVerified, review, rejected] = await Promise.all([
      this.prisma.targetedCandidate.count({ where: { campaignId } }),
      this.prisma.targetedCandidate.count({ where: { campaignId, relevanceScore: { gte: 50 } } }),
      this.prisma.targetedCandidate.count({ where: { campaignId, qualityTier: 'strict' } }),
      this.prisma.targetedCandidate.count({ where: { campaignId, verificationDepth: 'mailbox' } }),
      this.prisma.targetedCandidate.count({ where: { campaignId, qualityTier: 'review' } }),
      this.prisma.targetedCandidate.count({ where: { campaignId, qualityTier: 'rejected' } }),
    ]);
    await this.prisma.targetedCampaign.update({ where: { id: campaignId }, data: {
      discoveredCount: discovered, alignedCount: aligned, strictCount: strict,
      mailboxVerifiedCount: mailboxVerified, reviewCount: review, rejectedCount: rejected,
    } });
  }

  async listCandidates(campaignId: number, options: { tier?: TargetedQualityTier; limit?: number; offset?: number } = {}): Promise<TargetedCandidateRecord[]> {
    const rows = await this.prisma.targetedCandidate.findMany({
      where: { campaignId, ...(options.tier ? { qualityTier: options.tier } : {}) },
      orderBy: [{ qualityTier: 'asc' }, { relevanceScore: 'desc' }, { id: 'asc' }],
      take: Math.min(5_000, options.limit ?? 1_000), skip: options.offset ?? 0,
    });
    return rows.map(candidateRecord);
  }

  async strictEmails(campaignId: number): Promise<string[]> {
    return (await this.prisma.targetedCandidate.findMany({
      where: { campaignId, qualityTier: 'strict' }, select: { normalizedEmail: true }, orderBy: { normalizedEmail: 'asc' },
    })).map((row) => row.normalizedEmail);
  }

  async quarantineForeignCandidates(userId?: number, campaignId?: number): Promise<number> {
    const rows = await this.prisma.targetedCandidate.findMany({
      where: {
        ...(campaignId ? { campaignId } : {}),
        ...(userId ? { campaign: { userId } } : {}),
        qualityTier: { not: 'rejected' },
      },
      include: { campaign: { select: { filterJson: true } } },
    });
    const foreign = rows.filter((row) => {
      const filters = parseJson<TargetedFilters>(row.campaign.filterJson, {} as TargetedFilters);
      return evaluateGeography({ address: row.address ?? undefined, phone: row.phone ?? undefined, email: row.email, sourceUrl: row.website ?? undefined }, {
        country: filters.country ?? 'US', areaCodes: filters.areaCodes ?? [], states: filters.states ?? [],
        cities: filters.cities ?? [], postalCodes: filters.postalCodes ?? [],
      }).status === 'foreign';
    });
    if (!foreign.length) return 0;
    await this.prisma.targetedCandidate.updateMany({
      where: { id: { in: foreign.map((row) => row.id) } },
      data: { qualityTier: 'rejected', relevanceScore: 0, relevanceReason: 'target_mismatch', complianceStatus: 'foreign_rejected' },
    });
    for (const id of [...new Set(foreign.map((row) => row.campaignId))]) await this.refreshFunnel(id);
    return foreign.length;
  }

  async strictEmailsAll(userId: number): Promise<string[]> {
    const rows = await this.prisma.targetedCandidate.findMany({
      where: { qualityTier: 'strict', campaign: { userId } }, select: { normalizedEmail: true },
      orderBy: { normalizedEmail: 'asc' },
    });
    return [...new Set(rows.map((row) => row.normalizedEmail))];
  }

  async addEvent(campaignId: number, type: string, message: string, metadata?: unknown): Promise<void> {
    await this.prisma.targetedEvent.create({ data: {
      campaignId, type, message: String(redactSecrets(message)).slice(0, 1_000),
      metadataJson: metadata === undefined ? undefined : JSON.stringify(redactSecrets(metadata)).slice(0, 16_384),
    } });
  }
}
