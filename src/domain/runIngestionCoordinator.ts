import { businessIdentity } from './businessIdentity';
import { BoundedTaskPool } from './boundedTaskPool';
import { collectContactCandidates, EmailExtractor } from './emailExtractor';
import { safeErrorMessage } from './errorLogger';
import { normalizeLead } from './leadNormalizer';
import { applyLeadQualityFilters } from './leadQuality';
import type { DiscoveredBusinessWrite, LocalFirstRunStore } from './prismaRunStore';
import type { GoogleMapsFilters, NormalizedLead } from './types';

export type IngestionProvider = 'docker' | 'google' | 'apify';

export interface IngestionSnapshot {
  businessCount: number;
  localBusinessCount: number;
  googleBusinessCount: number;
  qualifiedContactCount: number;
  rawContactCount: number;
  companiesWithQualifiedEmailCount: number;
  duplicateCount: number;
  websiteCount: number;
  scanCount: number;
}

interface CoordinatorDeps {
  runId: number;
  target: number;
  store: LocalFirstRunStore;
  emailExtractor?: EmailExtractor;
  websiteConcurrency?: number;
  seed?: Partial<IngestionSnapshot>;
}

function reconciliationIdentity(lead: NormalizedLead): string {
  if (lead.website || lead.phone) {
    return businessIdentity({ ...lead, rawJson: undefined, placeUrl: undefined });
  }
  return businessIdentity(lead);
}

function businessWrite(lead: NormalizedLead, provider: IngestionProvider): DiscoveredBusinessWrite {
  return {
    identityKey: reconciliationIdentity(lead),
    provenance: [provider === 'docker' ? 'local' : provider],
    companyName: lead.companyName,
    categoryName: lead.categoryName,
    address: lead.address,
    website: lead.website,
    phone: lead.phone,
    placeUrl: lead.placeUrl,
    rating: lead.rating,
    reviewsCount: lead.reviewsCount,
    emails: lead.email ? [lead.email] : undefined,
    rawJson: lead.rawJson,
  };
}

function websiteScanKey(lead: NormalizedLead): string {
  let website = lead.website ?? '';
  try {
    website = new URL(website).origin.toLowerCase();
  } catch {
    website = website.toLowerCase();
  }
  return `${reconciliationIdentity(lead)}:${website}:${lead.email?.toLowerCase() ?? ''}`;
}

const PROVIDER_LABEL: Record<IngestionProvider, string> = {
  docker: 'Docker',
  google: 'Google Places',
  apify: 'Apify',
};

/**
 * One run-scoped ingestion coordinator shared by every discovery provider.
 * Businesses are persisted as they arrive and each accepted business
 * immediately queues a website contact scan on the bounded pool, so leads
 * flow into SQLite continuously instead of waiting for provider batches.
 */
export class RunIngestionCoordinator {
  private readonly runId: number;
  private readonly target: number;
  private readonly store: LocalFirstRunStore;
  private readonly emailExtractor?: EmailExtractor;
  private readonly pool: BoundedTaskPool;
  private readonly seenProviderRecords = new Set<string>();
  private readonly seenWebsiteScans = new Set<string>();
  private readonly companiesWithQualifiedEmail = new Set<string>();
  readonly seenEmails = new Set<string>();
  private readonly counts: IngestionSnapshot;

  constructor({ runId, target, store, emailExtractor, websiteConcurrency = 50, seed }: CoordinatorDeps) {
    this.runId = runId;
    this.target = target;
    this.store = store;
    this.emailExtractor = emailExtractor;
    this.pool = new BoundedTaskPool(websiteConcurrency);
    this.counts = {
      businessCount: seed?.businessCount ?? 0,
      localBusinessCount: seed?.localBusinessCount ?? 0,
      googleBusinessCount: seed?.googleBusinessCount ?? 0,
      qualifiedContactCount: seed?.qualifiedContactCount ?? 0,
      rawContactCount: seed?.rawContactCount ?? 0,
      companiesWithQualifiedEmailCount: seed?.companiesWithQualifiedEmailCount ?? 0,
      duplicateCount: seed?.duplicateCount ?? 0,
      websiteCount: seed?.websiteCount ?? 0,
      scanCount: seed?.scanCount ?? 0,
    };
  }

  get websiteConcurrency(): number {
    return this.pool.concurrency;
  }

  async ingest(items: unknown[], provider: IngestionProvider, filters: GoogleMapsFilters): Promise<void> {
    const normalized = applyLeadQualityFilters(
      items.map((item) => normalizeLead(item, 'google_maps')),
      filters
    );
    if (!normalized.length) return;

    const scanCandidates: NormalizedLead[] = [];
    let accepted = 0;
    for (const lead of normalized) {
      const identity = reconciliationIdentity(lead);
      const providerKey = `${provider}:${identity}`;
      if (this.seenProviderRecords.has(providerKey)) continue;
      this.seenProviderRecords.add(providerKey);
      accepted += 1;
      const outcome = await this.store.upsertBusiness(this.runId, businessWrite(lead, provider));
      if (outcome === 'merged') this.counts.duplicateCount += 1;
      const scanKey = websiteScanKey(lead);
      if ((lead.email || lead.website) && !this.seenWebsiteScans.has(scanKey)) {
        this.seenWebsiteScans.add(scanKey);
        scanCandidates.push(lead);
      }
    }

    await this.refreshBusinessMetrics();
    await this.persistMetrics();
    await this.store.addEvent(
      this.runId,
      'business_persisted',
      `${PROVIDER_LABEL[provider]} persisted ${accepted} new businesses.`,
      {
        provider,
        itemCount: accepted,
        businessCount: this.counts.businessCount,
        websiteCount: this.counts.websiteCount,
      }
    );

    if (!scanCandidates.length) return;
    this.counts.scanCount += scanCandidates.length;
    await this.store.addEvent(
      this.runId,
      'email_scan_started',
      `Scanning ${scanCandidates.length} businesses for emails.`,
      {
        provider,
        websiteCount: scanCandidates.filter((lead) => Boolean(lead.website)).length,
        concurrency: this.pool.concurrency,
      }
    );
    for (const lead of scanCandidates) {
      void this.pool
        .submit(() => this.scanWebsite(lead, provider))
        .catch(async (error) => {
          await this.store.addErrorLog({
            runId: this.runId,
            source: 'runIngestionCoordinator',
            severity: 'warn',
            message: safeErrorMessage(error),
            details: { provider },
          });
        });
    }
  }

  /** Resolves when every queued website scan has finished. */
  async drain(): Promise<void> {
    await this.pool.drain();
  }

  /** Re-reads persisted business counts (used after construction on resumed runs). */
  async refreshBusinessMetrics(): Promise<void> {
    const businesses = await this.store.listBusinesses(this.runId);
    this.counts.businessCount = businesses.length;
    this.counts.websiteCount = businesses.filter((business) => Boolean(business.website)).length;
    this.counts.localBusinessCount = businesses.filter((business) => business.provenance?.includes('local')).length;
    this.counts.googleBusinessCount = businesses.filter((business) => business.provenance?.includes('google')).length;
  }

  snapshot(): IngestionSnapshot {
    return { ...this.counts };
  }

  private async scanWebsite(lead: NormalizedLead, provider: IngestionProvider): Promise<void> {
    const candidates = await collectContactCandidates(lead, this.emailExtractor);
    for (const candidate of candidates) {
      const emailKey = candidate.normalizedEmail.toLowerCase();
      if (this.seenEmails.has(emailKey)) continue;
      const result = await this.store.upsertContact(this.runId, {
        ...candidate,
        businessIdentityKey: reconciliationIdentity(lead),
      });
      if (result === 'duplicate') continue;
      this.seenEmails.add(emailKey);
      if (candidate.contactQuality === 'qualified') {
        this.counts.qualifiedContactCount += 1;
        this.companiesWithQualifiedEmail.add(reconciliationIdentity(lead));
        this.counts.companiesWithQualifiedEmailCount = Math.max(
          this.counts.companiesWithQualifiedEmailCount,
          this.companiesWithQualifiedEmail.size
        );
      } else {
        this.counts.rawContactCount += 1;
      }
      await this.store.updateRun(this.runId, {
        leadCount: this.counts.qualifiedContactCount,
        rawContactCount: this.counts.rawContactCount,
        companiesWithQualifiedEmailCount: this.counts.companiesWithQualifiedEmailCount,
      });
      await this.store.addEvent(
        this.runId,
        'contact_persisted',
        candidate.contactQuality === 'qualified'
          ? 'Qualified contact saved.'
          : 'Raw contact saved for review.',
        {
          provider,
          quality: candidate.contactQuality,
          reason: candidate.qualityReason,
        }
      );
    }
  }

  private async persistMetrics(): Promise<void> {
    await this.store.updateRun(this.runId, {
      businessCount: this.counts.businessCount,
      localBusinessCount: this.counts.localBusinessCount,
      googleBusinessCount: this.counts.googleBusinessCount,
      websiteCount: this.counts.websiteCount,
      duplicateCount: this.counts.duplicateCount,
      leadCount: this.counts.qualifiedContactCount,
      rawContactCount: this.counts.rawContactCount,
      companiesWithQualifiedEmailCount: this.counts.companiesWithQualifiedEmailCount,
    });
  }
}
