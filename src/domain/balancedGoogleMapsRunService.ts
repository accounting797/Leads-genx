import { GooglePlacesClient, GooglePlacesError } from '../integrations/googlePlacesClient';
import { LocalScraperError, ResumableLocalMapsScraperClient } from '../integrations/localMapsScraperClient';
import { businessIdentity } from './businessIdentity';
import { EmailExtractor, keepEmailLeadsOnly } from './emailExtractor';
import { safeErrorMessage } from './errorLogger';
import { buildLocalDiscoveryBatches, LocalDiscoveryBatch } from './localDiscoveryBatch';
import { normalizeLead } from './leadNormalizer';
import { applyLeadQualityFilters } from './leadQuality';
import { DiscoveredBusinessWrite, LocalFirstRunStore } from './prismaRunStore';
import type { RunRecord } from './runService';
import { SerialTaskQueue } from './serialTaskQueue';
import { NormalizedLead, ValidatedRunInput } from './types';

export interface BalancedGoogleMapsRunDeps {
  store: LocalFirstRunStore;
  localClient: ResumableLocalMapsScraperClient;
  googleClient?: GooglePlacesClient;
  emailExtractor?: EmailExtractor;
  emailConcurrency?: number;
  now?: () => Date;
}

export interface BalancedGoogleMapsExecutionOptions {
  finalize?: boolean;
}

export interface BalancedGoogleMapsRunOutcome {
  status: 'running' | 'completed' | 'waiting_for_scraper' | 'waiting_for_credentials';
  leadCount: number;
  businessCount: number;
  seenEmails: Set<string>;
}

type ProviderState = 'completed' | 'failed' | 'waiting_for_scraper' | 'waiting_for_credentials';
type Provider = 'local' | 'google';

const EMPTY_BATCH_CIRCUIT_THRESHOLD = 3;

function reconciliationIdentity(lead: NormalizedLead): string {
  if (lead.website || lead.phone) {
    return businessIdentity({ ...lead, rawJson: undefined, placeUrl: undefined });
  }
  return businessIdentity(lead);
}

function businessWrite(lead: NormalizedLead, provenance: Provider): DiscoveredBusinessWrite {
  return {
    identityKey: reconciliationIdentity(lead),
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

function websiteScanKey(lead: NormalizedLead): string {
  let website = lead.website ?? '';
  try {
    website = new URL(website).origin.toLowerCase();
  } catch {
    website = website.toLowerCase();
  }
  return `${reconciliationIdentity(lead)}:${website}:${lead.email?.toLowerCase() ?? ''}`;
}

export async function executeBalancedGoogleMapsRun(
  { store, localClient, googleClient, emailExtractor, emailConcurrency = 50, now = () => new Date() }: BalancedGoogleMapsRunDeps,
  run: RunRecord,
  input: ValidatedRunInput,
  options: BalancedGoogleMapsExecutionOptions = {}
): Promise<BalancedGoogleMapsRunOutcome> {
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
  const seenEmails = new Set(
    persistedBusinesses.flatMap((business) => business.emails ?? []).map((email) => email.toLowerCase())
  );
  const seenProviderRecords = new Set<string>();
  const seenWebsiteScans = new Set<string>();
  const persistenceQueue = new SerialTaskQueue();
  const emailQueue = new SerialTaskQueue();
  const emailTasks: Promise<void>[] = [];
  let leadCount = run.leadCount ?? seenEmails.size;
  let duplicateCount = run.duplicateCount ?? 0;
  let apiRequestsUsed = run.apiRequestsUsed ?? 0;
  let googleKeyAccepted = false;

  await store.updateRun(run.id, {
    status: 'running',
    actorId: input.googleMaps?.provider === 'hybrid' ? 'hybrid' : 'local_first',
    currentRoute: input.routeMode ?? 'direct',
    apiRequestBudget: filters.apiRequestBudget ?? 0,
    apiRequestsUsed,
    localConcurrency: 4,
  });
  await store.addEvent(run.id, 'run_started', 'Google and Docker discovery pipeline started.', {
    provider: input.googleMaps?.provider ?? 'local_first',
    routeMode: input.routeMode ?? 'direct',
    googleRequestBudget: filters.apiRequestBudget ?? 0,
  });

  async function ingestProviderItems(items: unknown[], provenance: Provider): Promise<void> {
    const normalized = applyLeadQualityFilters(
      items.map((item) => normalizeLead(item, 'google_maps')),
      filters
    );
    if (!normalized.length) return;

    await persistenceQueue.enqueue(async () => {
      const scanCandidates: NormalizedLead[] = [];
      let accepted = 0;
      for (const lead of normalized) {
        const identity = reconciliationIdentity(lead);
        const providerKey = `${provenance}:${identity}`;
        if (seenProviderRecords.has(providerKey)) continue;
        seenProviderRecords.add(providerKey);
        accepted += 1;
        const outcome = await store.upsertBusiness(run.id, businessWrite(lead, provenance));
        if (outcome === 'merged') duplicateCount += 1;
        const scanKey = websiteScanKey(lead);
        if ((lead.email || lead.website) && !seenWebsiteScans.has(scanKey)) {
          seenWebsiteScans.add(scanKey);
          scanCandidates.push(lead);
        }
      }

      persistedBusinesses = await store.listBusinesses(run.id);
      await store.updateRun(run.id, {
        ...metrics(persistedBusinesses),
        duplicateCount,
        leadCount,
        apiRequestsUsed,
      });
      await store.addEvent(
        run.id,
        'source_results',
        `${provenance === 'google' ? 'Google Places' : 'Docker'} returned ${accepted} new provider records.`,
        {
          provider: provenance === 'google' ? 'google_places' : 'local_maps_scraper',
          itemCount: accepted,
          websiteCount: scanCandidates.filter((lead) => Boolean(lead.website)).length,
        }
      );

      if (!scanCandidates.length) return;
      const emailTask = emailQueue.enqueue(async () => {
        await store.addEvent(run.id, 'email_scan_started', `Scanning ${scanCandidates.length} businesses for emails.`, {
          provider: provenance,
          websiteCount: scanCandidates.filter((lead) => Boolean(lead.website)).length,
          concurrency: emailConcurrency,
        });
        const candidates = await keepEmailLeadsOnly(scanCandidates, emailExtractor, emailConcurrency);
        await persistenceQueue.enqueue(async () => {
          const fresh = candidates.filter((lead) => {
            if (!lead.email) return false;
            const key = lead.email.toLowerCase();
            if (seenEmails.has(key)) return false;
            seenEmails.add(key);
            return true;
          });
          if (fresh.length) await store.addLeads(run.id, fresh);
          leadCount += fresh.length;
          await store.updateRun(run.id, { leadCount, apiRequestsUsed });
          await store.addEvent(run.id, 'email_scan_completed', `Saved ${leadCount} unique email leads.`, {
            provider: provenance,
            leadCount,
            newLeadCount: fresh.length,
            scannedBusinessCount: scanCandidates.length,
            concurrency: emailConcurrency,
          });
        });
      });
      emailTasks.push(emailTask);
    });
  }

  async function recordProviderFailure(provider: 'google_places' | 'local_maps_scraper', error: unknown): Promise<void> {
    const message = safeErrorMessage(error);
    await store.addErrorLog({
      runId: run.id,
      source: 'balancedGoogleMapsRunService',
      severity: 'warn',
      message,
      details: {
        provider,
        errorCode: error instanceof GooglePlacesError ? error.code : errorCode(error),
      },
    });
    await store.addEvent(
      run.id,
      provider === 'google_places' ? 'google_places_failed' : 'local_maps_scraper_failed',
      `${provider === 'google_places' ? 'Google Places' : 'Docker'} failed: ${message}`,
      { provider }
    );
  }

  async function runGoogleProvider(): Promise<ProviderState> {
    const budget = filters.apiRequestBudget ?? 0;
    if (budget <= 0) {
      await store.addEvent(run.id, 'google_places_skipped', 'Google Places skipped because the request budget is zero.');
      return 'completed';
    }
    if (!input.googleApiKey) return 'waiting_for_credentials';
    if (!googleClient) {
      await recordProviderFailure('google_places', new Error('Google Places client is not configured'));
      return 'failed';
    }

    await store.addEvent(run.id, 'google_places_started', 'Google Places discovery started.', {
      provider: 'google_places',
      requestBudget: budget,
    });
    try {
      const items = await googleClient.search({
        apiKey: input.googleApiKey,
        apiKeys: input.googleApiKeys,
        filters,
        maxResults: input.maxResults,
        requestBudget: budget,
        shouldStop: () => persistedBusinesses.length >= input.maxResults,
        onRequestEvent: async (event) => {
          if (event.type === 'attempted') {
            apiRequestsUsed = event.requestCount;
            await persistenceQueue.enqueue(async () => {
              await store.updateRun(run.id, { apiRequestsUsed });
              await store.addEvent(
                run.id,
                'google_request_attempted',
                `Google request ${apiRequestsUsed}/${event.budget} sent.`,
                { requestCount: apiRequestsUsed, requestBudget: event.budget }
              );
            });
          } else if (event.type === 'succeeded' && !googleKeyAccepted) {
            googleKeyAccepted = true;
            await store.addEvent(
              run.id,
              'google_key_accepted',
              'Google API key accepted by the first live request.'
            );
          }
        },
        onPage: async (event) => {
          await ingestProviderItems(event.items, 'google');
          await store.addEvent(
            run.id,
            'google_places_page_completed',
            `Google returned ${event.items.length} new businesses.`,
            {
              shard: event.shard,
              shardCount: event.shardCount,
              itemCount: event.items.length,
              totalItemCount: event.totalItemCount,
            }
          );
        },
        onShardEvent: async (event) => {
          if (event.type === 'started') {
            await store.addEvent(run.id, 'google_places_shard_started', `Google shard ${event.shard}/${event.shardCount} started.`, {
              shard: event.shard,
              shardCount: event.shardCount,
            });
          } else if (event.type === 'completed') {
            await store.addEvent(run.id, 'google_places_shard_completed', `Google shard ${event.shard}/${event.shardCount} completed.`, {
              shard: event.shard,
              shardCount: event.shardCount,
              itemCount: event.itemCount ?? 0,
            });
          }
        },
      });
      await ingestProviderItems(items, 'google');
      await store.addEvent(run.id, 'google_places_completed', 'Google Places discovery completed.', {
        apiRequestsUsed,
      });
      return 'completed';
    } catch (error) {
      await recordProviderFailure('google_places', error);
      return 'failed';
    }
  }

  async function runLocalProvider(): Promise<ProviderState> {
    const runnable = await store.listRunnableBatches(run.id, now());
    let consecutiveEmptyBatches = 0;
    let successfulBatchCount = (await store.listBatches(run.id)).filter((batch) => batch.status === 'completed').length;

    for (let batchIndex = 0; batchIndex < runnable.length; batchIndex += 1) {
      if (persistedBusinesses.length >= input.maxResults) break;
      const checkpoint = runnable[batchIndex];
      const batch: LocalDiscoveryBatch | undefined = plannedByKey.get(checkpoint.batchKey);
      if (!batch) continue;
      const attemptCount = (checkpoint.attemptCount ?? 0) + 1;
      await store.upsertBatch(run.id, { ...checkpoint, status: 'running', attemptCount });
      await store.addEvent(run.id, 'local_batch_started', 'Docker discovery batch started.', {
        batchKey: batch.key,
        attemptCount,
        route: input.routeMode ?? 'direct',
      });

      try {
        const result = await localClient.searchBatch({ batch, proxies: input.proxyUrls ?? [] });
        successfulBatchCount += 1;
        if (result.rawBusinessCount === 0) {
          consecutiveEmptyBatches += 1;
          await store.addEvent(run.id, 'local_batch_empty', 'Docker discovery batch returned no businesses.', {
            consecutiveEmptyBatches,
            threshold: EMPTY_BATCH_CIRCUIT_THRESHOLD,
          });
        } else {
          consecutiveEmptyBatches = 0;
        }

        await ingestProviderItems(result.items, 'local');
        await store.upsertBatch(run.id, {
          ...checkpoint,
          status: 'completed',
          attemptCount,
          resultCount: result.rawBusinessCount,
          errorCode: undefined,
        });
        await store.addEvent(run.id, 'local_batch_completed', 'Docker discovery batch completed.', {
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
            'Docker discovery paused after repeated empty batches; Google continues.',
            { threshold: EMPTY_BATCH_CIRCUIT_THRESHOLD, skippedBatchCount: remaining.length }
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
        await store.addEvent(
          run.id,
          terminal ? 'local_batch_failed' : 'local_batch_retry',
          'Docker discovery batch did not complete.',
          { batchKey: batch.key, attemptCount, errorCode: code }
        );
      }
    }

    const checkpoints = await store.listBatches(run.id);
    if (checkpoints.some((batch) => batch.status === 'retry' || batch.status === 'pending' || batch.status === 'running')) {
      return 'waiting_for_scraper';
    }
    if (successfulBatchCount === 0 && checkpoints.some((batch) => batch.status === 'failed')) return 'failed';
    return 'completed';
  }

  const googleTask = runGoogleProvider();
  const localTask = runLocalProvider();
  const [googleResult, localResult] = await Promise.allSettled([googleTask, localTask]);
  await emailQueue.drain();
  const emailResults = await Promise.allSettled(emailTasks);
  await persistenceQueue.drain();
  const failedEmailTask = emailResults.find((result) => result.status === 'rejected');
  if (failedEmailTask?.status === 'rejected') throw failedEmailTask.reason;

  const googleState: ProviderState = googleResult.status === 'fulfilled' ? googleResult.value : 'failed';
  const localState: ProviderState = localResult.status === 'fulfilled' ? localResult.value : 'failed';
  persistedBusinesses = await store.listBusinesses(run.id);
  const finalMetrics = metrics(persistedBusinesses);

  if (googleState === 'waiting_for_credentials') {
    await store.updateRun(run.id, {
      status: 'waiting_for_credentials',
      ...finalMetrics,
      duplicateCount,
      leadCount,
      apiRequestsUsed,
    });
    await store.addEvent(run.id, 'run_waiting_for_credentials', 'Google credentials must be re-entered.', { leadCount });
    return { status: 'waiting_for_credentials', leadCount, businessCount: persistedBusinesses.length, seenEmails };
  }

  if (localState === 'waiting_for_scraper') {
    if (googleState === 'completed' && persistedBusinesses.length > 0) {
      const checkpoints = await store.listBatches(run.id);
      for (const checkpoint of checkpoints.filter((batch) =>
        batch.status === 'retry' || batch.status === 'pending' || batch.status === 'running'
      )) {
        await store.upsertBatch(run.id, {
          ...checkpoint,
          status: 'skipped_provider_failure',
          errorCode: checkpoint.errorCode ?? 'local_provider_failed',
        });
      }
      await recordProviderFailure(
        'local_maps_scraper',
        new Error('Docker supplementation stopped after a failed batch; Google output was preserved')
      );
    } else {
      await store.updateRun(run.id, {
        status: 'waiting_for_scraper',
        ...finalMetrics,
        duplicateCount,
        leadCount,
        apiRequestsUsed,
      });
      await store.addEvent(run.id, 'run_waiting', 'Run checkpointed and waiting for the Docker scraper.', { leadCount });
      return { status: 'waiting_for_scraper', leadCount, businessCount: persistedBusinesses.length, seenEmails };
    }
  }

  if (googleState === 'failed' && localState === 'failed' && persistedBusinesses.length === 0) {
    throw new Error('Google Places and Docker discovery both failed before producing businesses.');
  }

  if (options.finalize === false) {
    await store.updateRun(run.id, {
      status: 'running',
      ...finalMetrics,
      duplicateCount,
      leadCount,
      apiRequestsUsed,
    });
    return { status: 'running', leadCount, businessCount: persistedBusinesses.length, seenEmails };
  }

  await store.updateRun(run.id, {
    status: 'completed',
    actorId: 'local_first',
    datasetId: 'balanced_google_docker',
    ...finalMetrics,
    duplicateCount,
    leadCount,
    apiRequestsUsed,
  });
  await store.addEvent(run.id, 'run_completed', 'Standard Google and Docker run completed.', {
    leadCount,
    businessCount: persistedBusinesses.length,
    target: input.maxResults,
    apiRequestsUsed,
  });
  return { status: 'completed', leadCount, businessCount: persistedBusinesses.length, seenEmails };
}
