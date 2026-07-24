import { GooglePlacesClient, GooglePlacesError } from '../integrations/googlePlacesClient';
import { LocalScraperError, ResumableLocalMapsScraperClient } from '../integrations/localMapsScraperClient';
import { EmailExtractor } from './emailExtractor';
import { safeErrorMessage } from './errorLogger';
import { buildLocalDiscoveryBatches, LocalDiscoveryBatch } from './localDiscoveryBatch';
import { LocalFirstRunStore } from './prismaRunStore';
import { RunIngestionCoordinator, IngestionSnapshot } from './runIngestionCoordinator';
import type { RunRecord } from './runService';
import { ValidatedRunInput } from './types';

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
  ingestionCoordinator?: RunIngestionCoordinator;
}

export interface BalancedGoogleMapsRunOutcome {
  status: 'running' | 'completed' | 'waiting_for_scraper' | 'waiting_for_credentials';
  leadCount: number;
  businessCount: number;
  seenEmails: Set<string>;
}

type ProviderState = 'completed' | 'failed' | 'waiting_for_scraper' | 'waiting_for_credentials';

const EMPTY_BATCH_CIRCUIT_THRESHOLD = 3;

function errorCode(error: unknown): string {
  return error instanceof LocalScraperError ? error.code : 'failed';
}

function seedFromRun(run: RunRecord): Partial<IngestionSnapshot> {
  return {
    qualifiedContactCount: run.leadCount ?? 0,
    rawContactCount: run.rawContactCount ?? 0,
    companiesWithQualifiedEmailCount: run.companiesWithQualifiedEmailCount ?? 0,
    duplicateCount: run.duplicateCount ?? 0,
  };
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

  const coordinator =
    options.ingestionCoordinator ??
    new RunIngestionCoordinator({
      runId: run.id,
      target: input.maxResults,
      store,
      emailExtractor,
      websiteConcurrency: emailConcurrency,
      seed: seedFromRun(run),
    });
  await coordinator.refreshBusinessMetrics();

  let apiRequestsUsed = run.apiRequestsUsed ?? 0;
  let googleKeyAccepted = false;

  const heartbeat = async (
    provider: 'docker' | 'google' | 'email',
    status: 'standby' | 'running' | 'completed' | 'failed',
    operation: string,
    yieldCount: number,
    extra: { budgetUsed?: number; budgetMax?: number; errorCode?: string; errorMessage?: string } = {}
  ) => {
    await store.upsertProviderState(run.id, {
      provider,
      status,
      operation,
      yieldCount,
      budgetUsed: extra.budgetUsed,
      budgetMax: extra.budgetMax,
      errorCode: extra.errorCode,
      errorMessage: extra.errorMessage,
      heartbeatAt: now(),
    });
  };

  const snapshotMetrics = async () => {
    const snap = coordinator.snapshot();
    return {
      businessCount: snap.businessCount,
      localBusinessCount: snap.localBusinessCount,
      googleBusinessCount: snap.googleBusinessCount,
      websiteCount: snap.websiteCount,
      duplicateCount: snap.duplicateCount,
      leadCount: snap.qualifiedContactCount,
      rawContactCount: snap.rawContactCount,
      companiesWithQualifiedEmailCount: snap.companiesWithQualifiedEmailCount,
      apiRequestsUsed,
    };
  };

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

  async function ingestProviderItems(items: unknown[], provenance: 'local' | 'google'): Promise<void> {
    await coordinator.ingest(items, provenance === 'local' ? 'docker' : 'google', filters);
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
      await heartbeat('google', 'standby', 'Skipped — request budget is zero', 0, { budgetUsed: 0, budgetMax: 0 });
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
    await heartbeat('google', 'running', 'Searching Google Places', 0, { budgetUsed: 0, budgetMax: budget });
    try {
      const items = await googleClient.search({
        apiKey: input.googleApiKey,
        apiKeys: input.googleApiKeys,
        filters,
        maxResults: input.maxResults,
        requestBudget: budget,
        shouldStop: () => coordinator.snapshot().businessCount >= input.maxResults,
        onRequestEvent: async (event) => {
          if (event.type === 'attempted') {
            apiRequestsUsed = event.requestCount;
            await store.updateRun(run.id, { apiRequestsUsed });
            await store.addEvent(
              run.id,
              'google_request_attempted',
              `Google request ${apiRequestsUsed}/${event.budget} sent.`,
              { requestCount: apiRequestsUsed, requestBudget: event.budget }
            );
            await heartbeat('google', 'running', 'Searching Google Places', coordinator.snapshot().businessCount, {
              budgetUsed: apiRequestsUsed,
              budgetMax: event.budget,
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
      await heartbeat('google', 'completed', 'Google Places discovery completed', coordinator.snapshot().businessCount, {
        budgetUsed: apiRequestsUsed,
        budgetMax: budget,
      });
      return 'completed';
    } catch (error) {
      await recordProviderFailure('google_places', error);
      await heartbeat('google', 'failed', 'Google Places failed', coordinator.snapshot().businessCount, {
        budgetUsed: apiRequestsUsed,
        budgetMax: budget,
        errorCode: error instanceof GooglePlacesError ? error.code : 'failed',
        errorMessage: safeErrorMessage(error),
      });
      return 'failed';
    }
  }

  async function runLocalProvider(): Promise<ProviderState> {
    const runnable = await store.listRunnableBatches(run.id, now());
    let consecutiveEmptyBatches = 0;
    let successfulBatchCount = (await store.listBatches(run.id)).filter((batch) => batch.status === 'completed').length;
    let dockerYield = 0;

    for (let batchIndex = 0; batchIndex < runnable.length; batchIndex += 1) {
      if (coordinator.snapshot().businessCount >= input.maxResults) break;
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
      await heartbeat('docker', 'running', `Discovery batch ${batchIndex + 1}/${runnable.length}`, dockerYield);

      try {
        const result = await localClient.searchBatch({ batch, proxies: input.proxyUrls ?? [] });
        successfulBatchCount += 1;
        dockerYield += result.rawBusinessCount;
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
        await heartbeat('docker', 'running', `Discovery batch ${batchIndex + 1}/${runnable.length}`, dockerYield);

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
        if (terminal) {
          await heartbeat('docker', 'failed', 'Docker discovery batch failed', dockerYield, {
            errorCode: code,
            errorMessage: safeErrorMessage(error),
          });
        }
      }
    }

    const checkpoints = await store.listBatches(run.id);
    if (checkpoints.some((batch) => batch.status === 'retry' || batch.status === 'pending' || batch.status === 'running')) {
      return 'waiting_for_scraper';
    }
    if (successfulBatchCount === 0 && checkpoints.some((batch) => batch.status === 'failed')) return 'failed';
    await heartbeat('docker', 'completed', 'Docker discovery completed', dockerYield);
    return 'completed';
  }

  const googleTask = runGoogleProvider();
  const localTask = runLocalProvider();
  const [googleResult, localResult] = await Promise.allSettled([googleTask, localTask]);
  if (!options.ingestionCoordinator) {
    // Internally owned coordinator: drain and report. A shared coordinator is
    // drained once by the caller after every provider settles.
    await coordinator.drain();
    const drained = coordinator.snapshot();
    await store.addEvent(run.id, 'email_scan_completed', `Saved ${drained.qualifiedContactCount} unique email leads.`, {
      provider: 'all',
      leadCount: drained.qualifiedContactCount,
      scannedBusinessCount: drained.scanCount,
      concurrency: coordinator.websiteConcurrency,
    });
    await heartbeat('email', 'completed', 'Website contact scan completed', drained.qualifiedContactCount);
  }
  const snap = coordinator.snapshot();

  const googleState: ProviderState = googleResult.status === 'fulfilled' ? googleResult.value : 'failed';
  const localState: ProviderState = localResult.status === 'fulfilled' ? localResult.value : 'failed';

  if (googleState === 'waiting_for_credentials') {
    await store.updateRun(run.id, {
      status: 'waiting_for_credentials',
      ...(await snapshotMetrics()),
    });
    await store.addEvent(run.id, 'run_waiting_for_credentials', 'Google credentials must be re-entered.', {
      leadCount: snap.qualifiedContactCount,
    });
    return {
      status: 'waiting_for_credentials',
      leadCount: snap.qualifiedContactCount,
      businessCount: snap.businessCount,
      seenEmails: coordinator.seenEmails,
    };
  }

  if (localState === 'waiting_for_scraper') {
    if (googleState === 'completed' && snap.businessCount > 0) {
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
        ...(await snapshotMetrics()),
      });
      await store.addEvent(run.id, 'run_waiting', 'Run checkpointed and waiting for the Docker scraper.', {
        leadCount: snap.qualifiedContactCount,
      });
      return {
        status: 'waiting_for_scraper',
        leadCount: snap.qualifiedContactCount,
        businessCount: snap.businessCount,
        seenEmails: coordinator.seenEmails,
      };
    }
  }

  if (googleState === 'failed' && localState === 'failed' && snap.businessCount === 0) {
    throw new Error('Google Places and Docker discovery both failed before producing businesses.');
  }

  if (options.finalize === false) {
    await store.updateRun(run.id, {
      status: 'running',
      ...(await snapshotMetrics()),
    });
    return {
      status: 'running',
      leadCount: snap.qualifiedContactCount,
      businessCount: snap.businessCount,
      seenEmails: coordinator.seenEmails,
    };
  }

  await store.updateRun(run.id, {
    status: 'completed',
    actorId: 'local_first',
    datasetId: 'balanced_google_docker',
    ...(await snapshotMetrics()),
  });
  await store.addEvent(run.id, 'run_completed', 'Standard Google and Docker run completed.', {
    leadCount: snap.qualifiedContactCount,
    businessCount: snap.businessCount,
    target: input.maxResults,
    apiRequestsUsed,
  });
  return {
    status: 'completed',
    leadCount: snap.qualifiedContactCount,
    businessCount: snap.businessCount,
    seenEmails: coordinator.seenEmails,
  };
}
