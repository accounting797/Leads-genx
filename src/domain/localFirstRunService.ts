import { EmailExtractor, keepEmailLeadsOnly } from './emailExtractor';
import { businessIdentity } from './businessIdentity';
import { buildLocalDiscoveryBatches, LocalDiscoveryBatch } from './localDiscoveryBatch';
import { DiscoveredBusinessWrite, LocalFirstRunStore } from './prismaRunStore';
import { normalizeLead } from './leadNormalizer';
import { applyLeadQualityFilters } from './leadQuality';
import type { RunRecord } from './runService';
import { NormalizedLead, ValidatedRunInput } from './types';
import { GooglePlacesClient } from '../integrations/googlePlacesClient';
import { LocalScraperError, ResumableLocalMapsScraperClient } from '../integrations/localMapsScraperClient';

export interface LocalFirstRunDeps {
  store: LocalFirstRunStore;
  localClient: ResumableLocalMapsScraperClient;
  googleClient?: GooglePlacesClient;
  emailExtractor?: EmailExtractor;
  emailConcurrency?: number;
  now?: () => Date;
}

export interface LocalFirstExecutionOptions {
  finalize?: boolean;
}

export interface LocalFirstRunOutcome {
  status: 'running' | 'completed' | 'waiting_for_scraper' | 'waiting_for_credentials';
  leadCount: number;
  businessCount: number;
  seenEmails: Set<string>;
}

const EMPTY_BATCH_CIRCUIT_THRESHOLD = 3;

function businessWrite(lead: NormalizedLead, provenance: 'local' | 'google'): DiscoveredBusinessWrite {
  return {
    identityKey: businessIdentity(lead),
    provenance: [provenance],
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

function errorCode(error: unknown): string {
  return error instanceof LocalScraperError ? error.code : 'failed';
}

function metrics(businesses: Awaited<ReturnType<LocalFirstRunStore['listBusinesses']>>) {
  return {
    businessCount: businesses.length,
    localBusinessCount: businesses.filter((business) => business.provenance?.includes('local')).length,
    googleBusinessCount: businesses.filter((business) => business.provenance?.includes('google')).length,
    websiteCount: businesses.filter((business) => Boolean(business.website)).length,
  };
}

export async function executeLocalFirstRun(
  { store, localClient, googleClient, emailExtractor, emailConcurrency = 20, now = () => new Date() }: LocalFirstRunDeps,
  run: RunRecord,
  input: ValidatedRunInput,
  options: LocalFirstExecutionOptions = {}
): Promise<LocalFirstRunOutcome> {
  const filters = input.googleMaps ?? {};
  const plannedBatches = buildLocalDiscoveryBatches(filters, input.maxResults);
  const plannedByKey = new Map(plannedBatches.map((batch) => [batch.key, batch]));
  const existingBatches = await store.listBatches(run.id);
  const existingKeys = new Set(existingBatches.map((batch) => batch.batchKey));
  for (const batch of plannedBatches) {
    if (existingKeys.has(batch.key)) continue;
    await store.upsertBatch(run.id, { batchKey: batch.key, query: batch.query, status: 'pending' });
  }

  let persistedBusinesses = await store.listBusinesses(run.id);
  const seenEmails = new Set(persistedBusinesses.flatMap((business) => business.emails ?? []).map((email) => email.toLowerCase()));
  let leadCount = run.leadCount ?? seenEmails.size;
  let duplicateCount = run.duplicateCount ?? 0;

  async function saveEmails(leads: NormalizedLead[]): Promise<void> {
    const emailLeads = await keepEmailLeadsOnly(leads, emailExtractor, emailConcurrency);
    const fresh = emailLeads.filter((lead) => {
      if (!lead.email) return false;
      const key = lead.email.toLowerCase();
      if (seenEmails.has(key)) return false;
      seenEmails.add(key);
      return true;
    });
    if (!fresh.length) return;
    await store.addLeads(run.id, fresh);
    leadCount += fresh.length;
    await store.updateRun(run.id, { leadCount });
  }

  await store.updateRun(run.id, {
    status: 'running',
    actorId: 'local_first',
    currentRoute: input.routeMode ?? 'direct',
    apiRequestBudget: filters.apiRequestBudget ?? 0,
    localConcurrency: 1,
  });
  await store.addEvent(run.id, 'run_started', 'Docker and Google pipeline started.', {
    provider: input.googleMaps?.provider ?? 'local_first',
    routeMode: input.routeMode ?? 'direct',
    googleRequestBudget: filters.apiRequestBudget ?? 0,
  });

  const runnable = await store.listRunnableBatches(run.id, now());
  let consecutiveEmptyBatches = 0;
  for (let batchIndex = 0; batchIndex < runnable.length; batchIndex += 1) {
    const checkpoint = runnable[batchIndex];
    const batch: LocalDiscoveryBatch | undefined = plannedByKey.get(checkpoint.batchKey);
    if (!batch) continue;
    const attemptCount = (checkpoint.attemptCount ?? 0) + 1;
    await store.upsertBatch(run.id, { ...checkpoint, status: 'running', attemptCount });
    await store.addEvent(run.id, 'local_batch_started', 'Local discovery batch started.', {
      batchKey: batch.key,
      attemptCount,
      route: input.routeMode ?? 'direct',
    });

    try {
      const result = await localClient.searchBatch({ batch, proxies: input.proxyUrls ?? [] });
      if (result.rawBusinessCount === 0) {
        consecutiveEmptyBatches += 1;
        await store.addEvent(run.id, 'local_batch_empty', 'Local discovery batch returned no businesses.', {
          consecutiveEmptyBatches,
          threshold: EMPTY_BATCH_CIRCUIT_THRESHOLD,
        });
      } else {
        consecutiveEmptyBatches = 0;
      }
      const normalized = applyLeadQualityFilters(
        result.items.map((item) => normalizeLead(item, 'google_maps')),
        filters
      );
      for (const lead of normalized) {
        const outcome = await store.upsertBusiness(run.id, businessWrite(lead, 'local'));
        if (outcome === 'merged') duplicateCount += 1;
      }
      await store.upsertBatch(run.id, {
        ...checkpoint,
        status: 'completed',
        attemptCount,
        resultCount: result.rawBusinessCount,
        errorCode: undefined,
      });
      await saveEmails(normalized);
      await store.addEvent(run.id, 'local_batch_completed', 'Local discovery batch completed.', {
        batchKey: batch.key,
        resultCount: result.rawBusinessCount,
      });

      if (consecutiveEmptyBatches >= EMPTY_BATCH_CIRCUIT_THRESHOLD) {
        const remaining = runnable.slice(batchIndex + 1);
        for (const pending of remaining) {
          await store.upsertBatch(run.id, {
            ...pending,
            status: 'skipped_empty_circuit',
            errorCode: 'consecutive_empty_batches',
          });
        }
        await store.addEvent(
          run.id,
          'local_empty_circuit_opened',
          'Docker discovery paused after repeated empty batches; continuing to Google fallback.',
          {
            threshold: EMPTY_BATCH_CIRCUIT_THRESHOLD,
            skippedBatchCount: remaining.length,
          }
        );
        break;
      }
    } catch (error) {
      consecutiveEmptyBatches = 0;
      const code = errorCode(error);
      const terminal = code === 'unsupported_location' || attemptCount >= 2;
      await store.upsertBatch(run.id, {
        ...checkpoint,
        status: terminal ? 'failed' : 'retry',
        attemptCount,
        resultCount: 0,
        errorCode: code,
      });
      await store.addEvent(run.id, terminal ? 'local_batch_failed' : 'local_batch_retry', 'Local discovery batch did not complete.', {
        batchKey: batch.key,
        attemptCount,
        errorCode: code,
      });
    }

    persistedBusinesses = await store.listBusinesses(run.id);
    await store.updateRun(run.id, { ...metrics(persistedBusinesses), duplicateCount, leadCount });
    if (persistedBusinesses.length >= input.maxResults) break;
  }

  const checkpoints = await store.listBatches(run.id);
  if (checkpoints.some((batch) => batch.status === 'retry' || batch.status === 'pending' || batch.status === 'running')) {
    await store.updateRun(run.id, { status: 'waiting_for_scraper', leadCount });
    await store.addEvent(run.id, 'run_waiting', 'Run checkpointed and waiting for the local scraper.', { leadCount });
    return { status: 'waiting_for_scraper', leadCount, businessCount: persistedBusinesses.length, seenEmails };
  }

  persistedBusinesses = await store.listBusinesses(run.id);
  const remaining = Math.max(0, input.maxResults - persistedBusinesses.length);
  const budget = filters.apiRequestBudget ?? 0;
  if (remaining > 0 && budget > 0 && !input.googleApiKey) {
    await store.updateRun(run.id, { status: 'waiting_for_credentials', leadCount });
    await store.addEvent(run.id, 'run_waiting_for_credentials', 'Google fallback credentials must be re-entered.', { leadCount });
    return { status: 'waiting_for_credentials', leadCount, businessCount: persistedBusinesses.length, seenEmails };
  }

  if (remaining > 0 && budget > 0 && input.googleApiKey && googleClient) {
    await store.addEvent(run.id, 'google_fallback_started', 'Google API fallback started.', {
      remainingTarget: remaining,
      requestBudget: budget,
    });
    const items = await googleClient.search({
      apiKey: input.googleApiKey,
      apiKeys: input.googleApiKeys,
      filters,
      maxResults: remaining,
      requestBudget: budget,
    });
    const normalized = applyLeadQualityFilters(
      items.map((item) => normalizeLead(item, 'google_maps')),
      filters
    );
    for (const lead of normalized) {
      const outcome = await store.upsertBusiness(run.id, businessWrite(lead, 'google'));
      if (outcome === 'merged') duplicateCount += 1;
    }
    await saveEmails(normalized);
    await store.addEvent(run.id, 'google_fallback_completed', 'Google API fallback completed.', {
      resultCount: normalized.length,
      requestBudget: budget,
    });
  }

  persistedBusinesses = await store.listBusinesses(run.id);
  const finalMetrics = metrics(persistedBusinesses);
  if (options.finalize === false) {
    await store.updateRun(run.id, {
      status: 'running',
      ...finalMetrics,
      duplicateCount,
      leadCount,
    });
    return { status: 'running', leadCount, businessCount: persistedBusinesses.length, seenEmails };
  }
  await store.updateRun(run.id, {
    status: 'completed',
    actorId: 'local_first',
    datasetId: 'local_first',
    ...finalMetrics,
    duplicateCount,
    leadCount,
  });
  await store.addEvent(run.id, 'run_completed', 'Run completed.', {
    leadCount,
    businessCount: persistedBusinesses.length,
    target: input.maxResults,
  });
  return { status: 'completed', leadCount, businessCount: persistedBusinesses.length, seenEmails };
}
