import { ActorClient } from '../integrations/actorClient';
import { GooglePlacesClient } from '../integrations/googlePlacesClient';
import { LocalMapsScraperClient } from '../integrations/localMapsScraperClient';
import { EmailExtractor, keepEmailLeadsOnly } from './emailExtractor';
import { buildActorInput, buildActorInputsForApifyTokens } from './sourceInputBuilder';
import { safeErrorMessage } from './errorLogger';
import { normalizeLead } from './leadNormalizer';
import { applyLeadQualityFilters } from './leadQuality';
import { executeBalancedGoogleMapsRun } from './balancedGoogleMapsRunService';
import { RunIngestionCoordinator } from './runIngestionCoordinator';
import type { LocalFirstRunStore } from './prismaRunStore';
import type { ResumableLocalMapsScraperClient } from '../integrations/localMapsScraperClient';
import { GoogleMapsFilters, LeadSource, NormalizedLead, OutputMode, RouteMode, ValidatedRunInput } from './types';
import { OperatorSettings, QuarantinedCredential, filterQuarantined, withSavedCredentials } from './operatorSettings';
import { RunEngineer } from './runEngineer';

export interface RunRecord {
  id: number;
  status: string;
  leadSource: LeadSource;
  searchUrl?: string;
  filterJson?: string;
  actorId: string;
  maxResults: number;
  apifyRunId?: string;
  datasetId?: string;
  leadCount?: number;
  businessCount?: number;
  localBusinessCount?: number;
  googleBusinessCount?: number;
  duplicateCount?: number;
  websiteCount?: number;
  apiRequestBudget?: number;
  apiRequestsUsed?: number;
  currentRoute?: string;
  localConcurrency?: number;
  outputMode?: OutputMode;
  rawContactCount?: number;
  companiesWithQualifiedEmailCount?: number;
  plannedUnitCount?: number;
  completedUnitCount?: number;
  extendedRun?: boolean;
  lastHeartbeatAt?: Date;
  errorMessage?: string;
}

export interface RunStore {
  createRun(data: Omit<RunRecord, 'id'>): Promise<RunRecord>;
  updateRun(id: number, data: Partial<RunRecord>): Promise<RunRecord>;
  addEvent(runId: number, type: string, message: string, metadata?: unknown): Promise<void>;
  addLeads(runId: number, leads: NormalizedLead[]): Promise<void>;
  addErrorLog(error: {
    runId?: number;
    requestId?: string;
    source: string;
    severity: 'error' | 'warn' | 'info';
    message: string;
    details?: unknown;
  }): Promise<void>;
}

export interface RunServiceDeps {
  store: RunStore;
  actorClient: ActorClient;
  googlePlacesClient?: GooglePlacesClient;
  localMapsScraperClient?: LocalMapsScraperClient;
  emailExtractor?: EmailExtractor;
  emailLeadBatchSize?: number;
  emailExtractionConcurrency?: number;
  enableLocalMapsScraper?: boolean;
  loadOperatorSettings?: () => Promise<OperatorSettings>;
  /** Run Engineer memory: persist and recall quarantined (dead) credentials. */
  quarantineCredential?: (provider: string, credential: string, reason: string) => Promise<void>;
  loadQuarantinedCredentials?: () => Promise<QuarantinedCredential[]>;
  /** Injectable sleeper for engineer backoff (tests). */
  engineerSleep?: (ms: number) => Promise<void>;
}

export interface StartRunOptions {
  background?: boolean;
}

interface RunApifyShardsOptions {
  continueOnShardError?: boolean;
  ingestionCoordinator?: RunIngestionCoordinator;
  engineer?: RunEngineer;
}

interface RunGooglePlacesOptions {
  maxResults?: number;
  supplementLocal?: boolean;
}

export function serializeSafeFilters(input: ValidatedRunInput): string {
  const { cookies: _cookies, userAgent: _userAgent, ...safeSalesNavigator } =
    input.salesNavigator ?? {};
  return JSON.stringify({
    googleMaps: input.googleMaps,
    salesNavigator: input.salesNavigator ? safeSalesNavigator : undefined,
    routeMode: input.routeMode ?? 'direct',
    outputMode: input.outputMode ?? (input.googleMaps?.provider === 'hybrid' ? 'hybrid_max' : 'standard'),
  });
}

export interface ResumeCredentials {
  googleApiKey?: string;
  googleApiKeys?: string[];
  proxyUrls?: string[];
}

function isGooglePlacesRun(input: ValidatedRunInput): boolean {
  return input.leadSource === 'google_maps' && input.googleMaps?.provider === 'google_places';
}

function isHybridRun(input: ValidatedRunInput): boolean {
  return input.leadSource === 'google_maps' && input.googleMaps?.provider === 'hybrid';
}

function isLocalFirstRun(input: ValidatedRunInput): boolean {
  return input.leadSource === 'google_maps' && input.googleMaps?.provider === 'local_first';
}

function websiteCount(leads: NormalizedLead[]): number {
  return leads.filter((lead) => Boolean(lead.website)).length;
}

export function createRunService({
  store,
  actorClient,
  googlePlacesClient,
  localMapsScraperClient,
  emailExtractor,
  emailLeadBatchSize = 100,
  emailExtractionConcurrency = 50,
  enableLocalMapsScraper = true,
  loadOperatorSettings,
  quarantineCredential,
  loadQuarantinedCredentials,
  engineerSleep,
}: RunServiceDeps) {
  async function saveEmailLeadsInBatches(
    runId: number,
    normalizedLeads: NormalizedLead[],
    seenEmails = new Set<string>(),
    startingTotal = 0
  ): Promise<number> {
    const batchSize = Math.max(1, emailLeadBatchSize);
    let total = startingTotal;

    for (let index = 0; index < normalizedLeads.length; index += batchSize) {
      const batch = normalizedLeads.slice(index, index + batchSize);
      if (batch.length > 25) {
        await store.addEvent(runId, 'email_scan_started', `Scanning ${batch.length} websites for emails.`, {
          batchSize: batch.length,
          concurrency: emailExtractionConcurrency,
          scannedBeforeBatch: index,
        });
      }
      const emailLeads = await keepEmailLeadsOnly(batch, emailExtractor, emailExtractionConcurrency);
      const newEmailLeads = emailLeads.filter((lead) => {
        if (!lead.email || seenEmails.has(lead.email)) return false;
        seenEmails.add(lead.email);
        return true;
      });

      if (!newEmailLeads.length) continue;

      await store.addLeads(runId, newEmailLeads);
      total += newEmailLeads.length;
      await store.updateRun(runId, { leadCount: total });
      await store.addEvent(runId, 'leads_saved', `Saved ${total} email leads.`, {
        leadCount: total,
        batchLeadCount: newEmailLeads.length,
      });
    }

    return total;
  }

  async function runApifyShards(
    run: RunRecord,
    input: ValidatedRunInput,
    seenEmails = new Set<string>(),
    startingTotal = 0,
    options: RunApifyShardsOptions = {}
  ): Promise<{ leadCount: number; datasetIds: string[]; apifyRunIds: string[]; failedShardCount: number }> {
    const actorInputs = buildActorInputsForApifyTokens(input);
    const datasetIds: string[] = [];
    const apifyRunIds: string[] = [];
    let leadCount = startingTotal;
    let failedShardCount = 0;

    const providerStore = store as Partial<LocalFirstRunStore>;
    const heartbeat = async (status: 'running' | 'completed' | 'failed', operation: string, yieldCount: number, errorCode?: string) => {
      if (typeof providerStore.upsertProviderState !== 'function') return;
      await providerStore.upsertProviderState(run.id, {
        provider: 'apify',
        status,
        operation,
        yieldCount,
        errorCode,
        heartbeatAt: new Date(),
      });
    };

    for (const [index, actorInput] of actorInputs.entries()) {
      await store.addEvent(run.id, 'apify_shard_started', `Apify shard ${index + 1}/${actorInputs.length} started.`, {
        shard: index + 1,
        shardCount: actorInputs.length,
        actorId: actorInput.actorId,
      });
      await heartbeat('running', `Apify shard ${index + 1}/${actorInputs.length}`, leadCount);

      try {
        const shardOperation = `Apify shard ${index + 1}/${actorInputs.length}`;
        const shardWork = async () => {
          const actorRun = await actorClient.startRun(actorInput);
          apifyRunIds.push(actorRun.runId);
          if (actorRun.datasetId) datasetIds.push(actorRun.datasetId);
          await store.updateRun(run.id, {
            apifyRunId: actorRun.runId,
            datasetId: actorRun.datasetId,
          });

          if (actorRun.status !== 'SUCCEEDED') {
            throw new Error(`Actor finished with status ${actorRun.status}`);
          }

          await store.addEvent(run.id, 'actor_succeeded', 'Actor run succeeded.', {
            apifyRunId: actorRun.runId,
            datasetId: actorRun.datasetId,
            shard: index + 1,
          });

          return actorRun.datasetId
            ? actorClient.getDatasetItems(actorRun.datasetId, actorInput.token)
            : [];
        };
        const items = options.engineer
          ? await options.engineer.attempt('apify', shardOperation, shardWork, actorInput.token)
          : await shardWork();

        if (options.ingestionCoordinator && input.leadSource === 'google_maps') {
          await options.ingestionCoordinator.ingest(items, 'apify', input.googleMaps ?? {});
          leadCount = options.ingestionCoordinator.snapshot().qualifiedContactCount;
        } else {
          const sourceLeads = items.map((item) => normalizeLead(item, input.leadSource));
          const normalizedLeads = input.leadSource === 'google_maps'
            ? applyLeadQualityFilters(sourceLeads, input.googleMaps)
            : sourceLeads;
          await store.addEvent(
            run.id,
            'source_results',
            `Apify shard ${index + 1} returned ${normalizedLeads.length} records; ${websiteCount(
              normalizedLeads
            )} had websites to scan.`,
            {
              provider: 'apify',
              shard: index + 1,
              itemCount: normalizedLeads.length,
              websiteCount: websiteCount(normalizedLeads),
            }
          );
          leadCount = await saveEmailLeadsInBatches(run.id, normalizedLeads, seenEmails, leadCount);
        }
        await store.addEvent(run.id, 'apify_shard_completed', `Apify shard ${index + 1}/${actorInputs.length} completed.`, {
          provider: 'apify',
          shard: index + 1,
          shardCount: actorInputs.length,
          itemCount: items.length,
          leadCount,
        });
        await heartbeat(index + 1 === actorInputs.length ? 'completed' : 'running', `Apify shard ${index + 1}/${actorInputs.length}`, leadCount);
      } catch (error) {
        if (!options.continueOnShardError) throw error;

        failedShardCount += 1;
        const message = safeErrorMessage(error);
        await store.addErrorLog({
          runId: run.id,
          source: 'runService',
          severity: 'warn',
          message,
          details: {
            provider: 'apify',
            shard: index + 1,
            shardCount: actorInputs.length,
          },
        });
        await store.addEvent(run.id, 'apify_shard_failed', `Apify shard ${index + 1} failed: ${message}`, {
          provider: 'apify',
          shard: index + 1,
          shardCount: actorInputs.length,
        });
        await heartbeat('failed', `Apify shard ${index + 1} failed`, leadCount, 'shard_failed');
      }
    }

    return { leadCount, datasetIds, apifyRunIds, failedShardCount };
  }

  async function runGooglePlaces(
    run: RunRecord,
    input: ValidatedRunInput,
    seenEmails = new Set<string>(),
    startingTotal = 0,
    options: RunGooglePlacesOptions = {}
  ): Promise<number> {
    if (!googlePlacesClient) throw new Error('Google Places client is not configured');
    if (!input.googleApiKey) throw new Error('Google API key is required for Google Places runs');
    const googleApiKeys = input.googleApiKeys?.length ? input.googleApiKeys : [input.googleApiKey];

    await store.addEvent(run.id, 'google_places_started', 'Google Places search started.', {
      leadSource: input.leadSource,
      provider: 'google_places',
      keyCount: googleApiKeys.length,
    });

    const items = await googlePlacesClient.search({
      apiKey: input.googleApiKey,
      apiKeys: googleApiKeys,
      filters: input.googleMaps ?? {},
      maxResults: options.maxResults ?? input.maxResults,
      requestBudget: input.googleMaps?.apiRequestBudget,
      onShardEvent: async (event) => {
        if (event.type === 'started') {
          await store.addEvent(
            run.id,
            'google_places_shard_started',
            `Google Places shard ${event.shard}/${event.shardCount} started.`,
            event
          );
          return;
        }

        if (event.type === 'completed') {
          await store.addEvent(
            run.id,
            'google_places_shard_completed',
            `Google Places shard ${event.shard}/${event.shardCount} returned ${event.itemCount ?? 0} businesses.`,
            event
          );
          return;
        }

        if (event.type === 'cancelled') {
          await store.addEvent(
            run.id,
            'google_places_shard_cancelled',
            `Google Places shard ${event.shard}/${event.shardCount} cancelled: ${
              event.stopReason ?? 'unknown reason'
            }.`,
            event
          );
          return;
        }

        await store.addErrorLog({
          runId: run.id,
          source: 'runService',
          severity: 'warn',
          message: event.errorMessage ?? 'Google Places shard failed',
          details: event,
        });
        await store.addEvent(
          run.id,
          'google_places_shard_failed',
          `Google Places shard ${event.shard}/${event.shardCount} failed: ${
            event.errorMessage ?? 'unknown error'
          }`,
          event
        );
      },
    });
    const googleLeads = applyLeadQualityFilters(
      items.map((item) => normalizeLead(item, input.leadSource)),
      input.googleMaps
    );
    await store.addEvent(
      run.id,
      'source_results',
      `Google Places returned ${googleLeads.length} businesses; ${websiteCount(
        googleLeads
      )} had websites to scan.`,
      { provider: 'google_places', itemCount: googleLeads.length, websiteCount: websiteCount(googleLeads) }
    );
    let leadCount = await saveEmailLeadsInBatches(run.id, googleLeads, seenEmails, startingTotal);

    if (options.supplementLocal === false) return leadCount;

    if (!enableLocalMapsScraper) {
      await store.addEvent(
        run.id,
        'local_maps_scraper_skipped',
        'Local Google Maps scraper-kit supplementation is disabled.',
        { provider: 'local_maps_scraper' }
      );
      return leadCount;
    }

    const localItems = localMapsScraperClient
      ? await localMapsScraperClient.search({
          filters: input.googleMaps ?? {},
          maxResults: Math.max(0, input.maxResults - googleLeads.length),
          onEvent: async (event) => {
            if (event.type === 'started') {
              await store.addEvent(run.id, 'local_maps_scraper_started', 'Local Google Maps scraper-kit job started.', event);
              return;
            }

            if (event.type === 'completed') {
              await store.addEvent(
                run.id,
                'local_maps_scraper_completed',
                `Local Google Maps scraper-kit returned ${event.itemCount ?? 0} records.`,
                event
              );
              return;
            }

            if (event.type === 'unavailable') {
              await store.addEvent(
                run.id,
                'local_maps_scraper_unavailable',
                event.message ?? 'Local Google Maps scraper-kit is not available.',
                event
              );
              return;
            }

            await store.addErrorLog({
              runId: run.id,
              source: 'runService',
              severity: 'warn',
              message: event.message ?? 'Local Google Maps scraper-kit failed',
              details: event,
            });
            await store.addEvent(
              run.id,
              'local_maps_scraper_failed',
              event.message ?? 'Local Google Maps scraper-kit failed.',
              event
            );
          },
        })
      : [];
    if (!localItems.length) return leadCount;

    const localLeads = applyLeadQualityFilters(
      localItems.map((item) => normalizeLead(item, input.leadSource)),
      input.googleMaps
    );
    await store.addEvent(
      run.id,
      'source_results',
      `Local Google Maps scraper-kit returned ${localLeads.length} businesses; ${websiteCount(
        localLeads
      )} had websites to scan.`,
      { provider: 'local_maps_scraper', itemCount: localLeads.length, websiteCount: websiteCount(localLeads) }
    );
    leadCount = await saveEmailLeadsInBatches(run.id, localLeads, seenEmails, leadCount);
    return leadCount;
  }

  async function recordGooglePlacesFailure(run: RunRecord, error: unknown): Promise<void> {
    const message = safeErrorMessage(error);
    await store.addErrorLog({
      runId: run.id,
      source: 'runService',
      severity: 'warn',
      message,
      details: {
        provider: 'google_places',
      },
    });
    await store.addEvent(run.id, 'google_places_failed', `Google Places failed: ${message}`, {
      provider: 'google_places',
    });
  }

  async function executeRun(run: RunRecord, input: ValidatedRunInput) {
    const engineer = new RunEngineer({
      runId: run.id,
      store,
      sleep: engineerSleep,
      quarantineCredential: quarantineCredential
        ? (provider, credential, reason) => quarantineCredential(provider, credential ?? '', reason)
        : undefined,
      probe: {
        docker:
          typeof (localMapsScraperClient as Partial<ResumableLocalMapsScraperClient>)?.health === 'function'
            ? () => (localMapsScraperClient as ResumableLocalMapsScraperClient).health()
            : undefined,
      },
    });
    try {
      if (isLocalFirstRun(input)) {
        if (!localMapsScraperClient) throw new Error('Local Google Maps scraper client is not configured');
        const checkpointStore = store as Partial<LocalFirstRunStore>;
        const resumableClient = localMapsScraperClient as Partial<ResumableLocalMapsScraperClient>;
        if (typeof checkpointStore.listBatches === 'function' && typeof resumableClient.searchBatch === 'function') {
          await executeBalancedGoogleMapsRun({
            store: store as LocalFirstRunStore,
            localClient: localMapsScraperClient as ResumableLocalMapsScraperClient,
            googleClient: googlePlacesClient,
            emailExtractor,
            emailConcurrency: emailExtractionConcurrency,
            engineer,
          }, run, input);
          return;
        }
        const seenEmails = new Set<string>();
        let leadCount = 0;

        await store.updateRun(run.id, { status: 'running', actorId: 'local_first' });
        await store.addEvent(run.id, 'run_started', 'Docker local-first Google Maps run started.', {
          provider: 'local_first',
          routeMode: input.routeMode ?? 'direct',
          googleRequestBudget: input.googleMaps?.apiRequestBudget ?? 0,
        });

        const localItems = await localMapsScraperClient.search({
          filters: input.googleMaps ?? {},
          maxResults: input.maxResults,
          proxyUrls: input.proxyUrls,
          onEvent: async (event) => {
            if (event.type === 'started') {
              await store.addEvent(run.id, 'local_maps_scraper_started', 'Local Google Maps scraper-kit job started.', event);
            } else if (event.type === 'completed') {
              await store.addEvent(run.id, 'local_maps_scraper_completed', `Local scraper returned ${event.itemCount ?? 0} records.`, event);
            } else {
              await store.addEvent(run.id, `local_maps_scraper_${event.type}`, event.message ?? `Local scraper ${event.type}.`, event);
            }
          },
        });
        const localLeads = applyLeadQualityFilters(
          localItems.map((item) => normalizeLead(item, input.leadSource)),
          input.googleMaps
        );
        await store.addEvent(run.id, 'source_results', `Local scraper returned ${localLeads.length} businesses; ${websiteCount(localLeads)} had websites to scan.`, {
          provider: 'local_maps_scraper', itemCount: localLeads.length, websiteCount: websiteCount(localLeads),
        });
        leadCount = await saveEmailLeadsInBatches(run.id, localLeads, seenEmails, leadCount);

        const remaining = Math.max(0, input.maxResults - localItems.length);
        if (remaining > 0 && input.googleApiKey && (input.googleMaps?.apiRequestBudget ?? 0) > 0) {
          try {
            leadCount = await runGooglePlaces(run, input, seenEmails, leadCount, {
              maxResults: remaining,
              supplementLocal: false,
            });
          } catch (error) {
            if (!localItems.length) throw error;
            await recordGooglePlacesFailure(run, error);
          }
        }

        if (leadCount === 0) await store.addEvent(run.id, 'leads_saved', 'Saved 0 email leads.', { leadCount: 0 });
        await store.updateRun(run.id, { status: 'completed', actorId: 'local_first', datasetId: 'local_first', leadCount });
        await store.addEvent(run.id, 'run_completed', 'Run completed.', { leadCount });
        return;
      }

      if (isHybridRun(input)) {
        const checkpointStore = store as Partial<LocalFirstRunStore>;
        const resumableClient = localMapsScraperClient as Partial<ResumableLocalMapsScraperClient> | undefined;
        if (
          localMapsScraperClient &&
          typeof checkpointStore.listBatches === 'function' &&
          typeof resumableClient?.searchBatch === 'function'
        ) {
          const localStore = store as LocalFirstRunStore;
          const coordinator = new RunIngestionCoordinator({
            runId: run.id,
            target: input.maxResults,
            store: localStore,
            emailExtractor,
            websiteConcurrency: emailExtractionConcurrency,
            seed: {
              qualifiedContactCount: run.leadCount ?? 0,
              rawContactCount: run.rawContactCount ?? 0,
              companiesWithQualifiedEmailCount: run.companiesWithQualifiedEmailCount ?? 0,
              duplicateCount: run.duplicateCount ?? 0,
            },
          });

          // Docker + Google and Apify run concurrently, sharing one coordinator.
          const balancedTask = executeBalancedGoogleMapsRun({
            store: localStore,
            localClient: localMapsScraperClient as ResumableLocalMapsScraperClient,
            googleClient: googlePlacesClient,
            emailExtractor,
            emailConcurrency: emailExtractionConcurrency,
            engineer,
          }, run, input, { finalize: false, ingestionCoordinator: coordinator })
            .then((outcome) => ({ ok: true as const, outcome }))
            .catch((error: unknown) => ({ ok: false as const, error }));
          const apifyTask = runApifyShards(run, input, undefined, undefined, {
            continueOnShardError: true,
            ingestionCoordinator: coordinator,
            engineer,
          })
            .then((result) => ({ ok: true as const, result }))
            .catch((error: unknown) => ({ ok: false as const, error }));

          const [balancedSettled, apifySettled] = await Promise.all([balancedTask, apifyTask]);
          await coordinator.drain();
          const snap = coordinator.snapshot();
          const sharedMetrics = {
            businessCount: snap.businessCount,
            localBusinessCount: snap.localBusinessCount,
            googleBusinessCount: snap.googleBusinessCount,
            websiteCount: snap.websiteCount,
            duplicateCount: snap.duplicateCount,
            leadCount: snap.qualifiedContactCount,
            rawContactCount: snap.rawContactCount,
            companiesWithQualifiedEmailCount: snap.companiesWithQualifiedEmailCount,
          };

          await store.addEvent(run.id, 'email_scan_completed', `Saved ${snap.qualifiedContactCount} unique email leads.`, {
            provider: 'all',
            leadCount: snap.qualifiedContactCount,
            scannedBusinessCount: snap.scanCount,
            concurrency: coordinator.websiteConcurrency,
          });

          if (balancedSettled.ok && balancedSettled.outcome.status === 'waiting_for_credentials') {
            await store.updateRun(run.id, { status: 'waiting_for_credentials', ...sharedMetrics });
            return;
          }
          if (balancedSettled.ok && balancedSettled.outcome.status === 'waiting_for_scraper') {
            await store.updateRun(run.id, { status: 'waiting_for_scraper', ...sharedMetrics });
            return;
          }

          const failedProviders: string[] = [];
          if (!balancedSettled.ok) {
            failedProviders.push('docker_google');
            await store.addErrorLog({
              runId: run.id,
              source: 'runService',
              severity: 'warn',
              message: safeErrorMessage(balancedSettled.error),
              details: { provider: 'balanced' },
            });
          }
          if (!apifySettled.ok) {
            failedProviders.push('apify');
            await store.addErrorLog({
              runId: run.id,
              source: 'runService',
              severity: 'warn',
              message: safeErrorMessage(apifySettled.error),
              details: { provider: 'apify' },
            });
          } else if (apifySettled.result.apifyRunIds.length === 0) {
            // No Apify run ever started — every shard failed or all tokens
            // were quarantined. The Hybrid report must say so.
            failedProviders.push('apify');
          }

          const hasOutput = snap.businessCount > 0 || snap.qualifiedContactCount > 0;
          if (failedProviders.length === 2 && !hasOutput) {
            throw new Error('Docker, Google, and Apify providers all failed before producing output.');
          }

          const partial = failedProviders.length > 0;
          if (snap.qualifiedContactCount === 0 && !hasOutput) {
            await store.addEvent(run.id, 'leads_saved', 'Saved 0 email leads.', { leadCount: 0 });
          }
          await store.updateRun(run.id, {
            status: partial ? 'partially_completed' : 'completed',
            actorId: 'hybrid',
            ...sharedMetrics,
          });
          await store.addEvent(
            run.id,
            partial ? 'run_partially_completed' : 'run_completed',
            partial
              ? 'Hybrid Max Output run completed with provider failures; persisted output was kept.'
              : 'Hybrid Max Output run completed.',
            {
              leadCount: snap.qualifiedContactCount,
              businessCount: snap.businessCount,
              providers: ['docker', 'google', 'apify', 'email'],
              failedProviders: failedProviders.length ? failedProviders : undefined,
            }
          );
          return;
        }

        const seenEmails = new Set<string>();
        let leadCount = 0;

        await store.updateRun(run.id, {
          status: 'running',
          actorId: 'hybrid',
        });
        await store.addEvent(run.id, 'run_started', 'Hybrid max output run started.', {
          leadSource: input.leadSource,
          provider: 'hybrid',
          apifyTokenCount: input.apifyTokens?.length ?? (input.apifyToken ? 1 : 0),
          googleKeyCount: input.googleApiKeys?.length ?? (input.googleApiKey ? 1 : 0),
        });

        if (input.apifyToken) {
          const result = await runApifyShards(run, input, seenEmails, leadCount, {
            continueOnShardError: Boolean(input.googleApiKey),
            engineer,
          });
          leadCount = result.leadCount;
        }
        if (input.googleApiKey) {
          try {
            leadCount = await runGooglePlaces(run, input, seenEmails, leadCount);
          } catch (error) {
            if (!input.apifyToken) throw error;
            await recordGooglePlacesFailure(run, error);
          }
        }
        if (leadCount === 0) {
          await store.addEvent(run.id, 'leads_saved', 'Saved 0 email leads.', { leadCount: 0 });
        }
        await store.updateRun(run.id, {
          status: 'completed',
          actorId: 'hybrid',
          leadCount,
        });
        await store.addEvent(run.id, 'run_completed', 'Run completed.', {
          leadCount,
        });
        return;
      }

      if (isGooglePlacesRun(input)) {
        await store.updateRun(run.id, {
          status: 'running',
          actorId: 'google_places',
        });
        const leadCount = await runGooglePlaces(run, input);
        if (leadCount === 0) {
          await store.addEvent(run.id, 'leads_saved', 'Saved 0 email leads.', { leadCount: 0 });
        }
        await store.updateRun(run.id, {
          status: 'completed',
          actorId: 'google_places',
          datasetId: 'google_places',
          leadCount,
        });
        await store.addEvent(run.id, 'run_completed', 'Run completed.', {
          leadCount,
        });
        return;
      }

      const actorInput = buildActorInput(input);
      await store.updateRun(run.id, {
        status: 'running',
        actorId: actorInput.actorId,
      });
      await store.addEvent(run.id, 'run_started', 'Actor run started.', {
        leadSource: input.leadSource,
        actorId: actorInput.actorId,
      });

      const { leadCount } = await runApifyShards(run, input, undefined, undefined, { engineer });
      if (leadCount === 0) {
        await store.addEvent(run.id, 'leads_saved', 'Saved 0 email leads.', { leadCount: 0 });
      }
      await store.updateRun(run.id, {
        status: 'completed',
        leadCount,
      });
      await store.addEvent(run.id, 'run_completed', 'Run completed.', {
        leadCount,
      });
    } catch (error) {
      const message = safeErrorMessage(error);
      await store.updateRun(run.id, {
        status: 'failed',
        errorMessage: message,
      });
      await store.addErrorLog({
        runId: run.id,
        source: 'runService',
        severity: 'error',
        message,
        details: { leadSource: input.leadSource },
      });
      await store.addEvent(run.id, 'run_failed', message);
    }
  }

  function recoveredInput(run: RunRecord, credentials: ResumeCredentials = {}): ValidatedRunInput {
    let persisted: { googleMaps?: GoogleMapsFilters; routeMode?: RouteMode; outputMode?: OutputMode } = {};
    try {
      persisted = JSON.parse(run.filterJson ?? '{}') as typeof persisted;
    } catch {
      persisted = {};
    }
    const googleApiKeys = credentials.googleApiKeys?.length
      ? credentials.googleApiKeys
      : credentials.googleApiKey
        ? [credentials.googleApiKey]
        : undefined;
    return {
      leadSource: run.leadSource,
      maxResults: run.maxResults,
      googleMaps: persisted.googleMaps,
      outputMode: persisted.outputMode,
      routeMode: credentials.proxyUrls?.length ? 'proxy' : persisted.routeMode ?? 'direct',
      proxyUrls: credentials.proxyUrls,
      googleApiKey: googleApiKeys?.[0],
      googleApiKeys,
    };
  }

  async function resumeRun(runId: number, credentials: ResumeCredentials = {}): Promise<{ id: number; status: string }> {
    const checkpointStore = store as Partial<LocalFirstRunStore>;
    if (!checkpointStore.getRun) throw new Error('Run recovery is not configured');
    const run = await checkpointStore.getRun(runId);
    if (!run) throw new Error('Run not found');
    if (!['waiting_for_scraper', 'waiting_for_credentials', 'cooling_down', 'failed'].includes(run.status)) {
      throw new Error('Run is not waiting for recovery');
    }
    const input = recoveredInput(run, credentials);
    if (input.routeMode === 'proxy' && !input.proxyUrls?.length) throw new Error('Proxy credentials must be re-entered');
    const queued = await store.updateRun(run.id, { status: 'queued', errorMessage: undefined });
    void executeRun(queued, input);
    return { id: run.id, status: 'queued' };
  }

  async function recoverInterruptedRuns(): Promise<void> {
    const checkpointStore = store as Partial<LocalFirstRunStore>;
    if (!checkpointStore.listRecoverableRuns || !checkpointStore.listBatches || !checkpointStore.upsertBatch) return;
    const runs = await checkpointStore.listRecoverableRuns();
    for (const run of runs) {
      const input = recoveredInput(run);
      if (input.routeMode === 'proxy') {
        await store.updateRun(run.id, { status: 'waiting_for_credentials' });
        await store.addEvent(run.id, 'run_waiting_for_credentials', 'Proxy credentials must be re-entered after restart.');
        continue;
      }
      const batches = await checkpointStore.listBatches(run.id);
      for (const batch of batches.filter((candidate) => candidate.status === 'running')) {
        await checkpointStore.upsertBatch(run.id, { ...batch, status: 'retry', errorCode: 'interrupted' });
      }
      void executeRun(run, input);
    }
  }

  async function scraperHealth(): Promise<{ ok: boolean; route: string; healthyProxyCount: number }> {
    const client = localMapsScraperClient as Partial<ResumableLocalMapsScraperClient> | undefined;
    return {
      ok: client?.health ? await client.health() : false,
      route: 'direct',
      healthyProxyCount: 0,
    };
  }

  async function startRun(rawInput: ValidatedRunInput, options: StartRunOptions = {}) {
    const merged = loadOperatorSettings
      ? withSavedCredentials(rawInput, await loadOperatorSettings())
      : rawInput;

    // The engineer's memory: credentials that previously failed authentication
    // are skipped before they can waste a provider shard again.
    let skippedDeadCredentials = 0;
    const input = { ...merged };
    if (loadQuarantinedCredentials) {
      const quarantined = await loadQuarantinedCredentials();
      if (quarantined.length) {
        if (input.apifyTokens?.length) {
          const { kept, skipped } = filterQuarantined(input.apifyTokens, quarantined);
          input.apifyTokens = kept.length ? kept : undefined;
          input.apifyToken = kept[0];
          skippedDeadCredentials += skipped;
        }
        if (input.googleApiKeys?.length) {
          const { kept, skipped } = filterQuarantined(input.googleApiKeys, quarantined);
          input.googleApiKeys = kept.length ? kept : undefined;
          input.googleApiKey = kept[0];
          skippedDeadCredentials += skipped;
        }
      }
    }
    const actorInput = isLocalFirstRun(input)
      ? { actorId: 'local_first' }
      : isHybridRun(input)
      ? { actorId: 'hybrid' }
      : isGooglePlacesRun(input)
        ? { actorId: 'google_places' }
        : buildActorInput(input);
    const run = await store.createRun({
      status: 'queued',
      leadSource: input.leadSource,
      searchUrl: input.searchUrl,
      filterJson: serializeSafeFilters(input),
      actorId: actorInput.actorId,
      maxResults: input.maxResults,
      leadCount: 0,
      apiRequestBudget: input.googleMaps?.apiRequestBudget ?? 0,
      currentRoute: input.routeMode ?? 'direct',
      localConcurrency: 1,
      outputMode: input.outputMode ?? (input.googleMaps?.provider === 'hybrid' ? 'hybrid_max' : 'standard'),
    });
    const queuedRun = { ...run };

    await store.addEvent(run.id, 'run_queued', 'Run queued.', {
      leadSource: input.leadSource,
    });

    if (skippedDeadCredentials > 0) {
      await store.addEvent(
        run.id,
        'engineer_action',
        `Engineer skipped ${skippedDeadCredentials} previously-quarantined credential${skippedDeadCredentials === 1 ? '' : 's'} — replace ${skippedDeadCredentials === 1 ? 'it' : 'them'} in Settings.`,
        {
          provider: 'all',
          kind: 'credential_skipped',
          reasoning: 'These credentials were rejected by their provider before; reusing them would only waste a shard.',
        }
      );
    }

    const runInBackground = options.background ?? true;
    if (runInBackground) {
      void executeRun(run, input);
    } else {
      await executeRun(run, input);
    }

    return queuedRun;
  }

  return {
    startRun,
    executeRun,
    resumeRun,
    recoverInterruptedRuns,
    scraperHealth,
  };
}
