import { ActorClient } from '../integrations/actorClient';
import { GooglePlacesClient } from '../integrations/googlePlacesClient';
import { LocalMapsScraperClient } from '../integrations/localMapsScraperClient';
import { EmailExtractor, keepEmailLeadsOnly } from './emailExtractor';
import { buildActorInput, buildActorInputsForApifyTokens } from './sourceInputBuilder';
import { safeErrorMessage } from './errorLogger';
import { normalizeLead } from './leadNormalizer';
import { executeLocalFirstRun } from './localFirstRunService';
import type { LocalFirstRunStore } from './prismaRunStore';
import type { ResumableLocalMapsScraperClient } from '../integrations/localMapsScraperClient';
import { GoogleMapsFilters, LeadSource, NormalizedLead, RouteMode, ValidatedRunInput } from './types';

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
}

export interface StartRunOptions {
  background?: boolean;
}

interface RunApifyShardsOptions {
  continueOnShardError?: boolean;
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

    for (const [index, actorInput] of actorInputs.entries()) {
      await store.addEvent(run.id, 'apify_shard_started', `Apify shard ${index + 1}/${actorInputs.length} started.`, {
        shard: index + 1,
        shardCount: actorInputs.length,
        actorId: actorInput.actorId,
      });

      try {
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

        const items = actorRun.datasetId
          ? await actorClient.getDatasetItems(actorRun.datasetId, actorInput.token)
          : [];
        const normalizedLeads = items.map((item) => normalizeLead(item, input.leadSource));
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
        await store.addEvent(run.id, 'apify_shard_completed', `Apify shard ${index + 1}/${actorInputs.length} completed.`, {
          provider: 'apify',
          shard: index + 1,
          shardCount: actorInputs.length,
          itemCount: normalizedLeads.length,
          leadCount,
        });
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
    const googleLeads = items.map((item) => normalizeLead(item, input.leadSource));
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

    const localLeads = localItems.map((item) => normalizeLead(item, input.leadSource));
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
    try {
      if (isLocalFirstRun(input)) {
        if (!localMapsScraperClient) throw new Error('Local Google Maps scraper client is not configured');
        const checkpointStore = store as Partial<LocalFirstRunStore>;
        const resumableClient = localMapsScraperClient as Partial<ResumableLocalMapsScraperClient>;
        if (typeof checkpointStore.listBatches === 'function' && typeof resumableClient.searchBatch === 'function') {
          await executeLocalFirstRun({
            store: store as LocalFirstRunStore,
            localClient: localMapsScraperClient as ResumableLocalMapsScraperClient,
            googleClient: googlePlacesClient,
            emailExtractor,
            emailConcurrency: emailExtractionConcurrency,
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
        const localLeads = localItems.map((item) => normalizeLead(item, input.leadSource));
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
          const localOutcome = await executeLocalFirstRun({
            store: store as LocalFirstRunStore,
            localClient: localMapsScraperClient as ResumableLocalMapsScraperClient,
            googleClient: googlePlacesClient,
            emailExtractor,
            emailConcurrency: emailExtractionConcurrency,
          }, run, input, { finalize: false });
          if (localOutcome.status !== 'running') return;

          await store.addEvent(run.id, 'hybrid_apify_started', 'Docker and Google stages complete; Apify expansion started.', {
            businessCount: localOutcome.businessCount,
            leadCount: localOutcome.leadCount,
          });
          const result = await runApifyShards(run, input, localOutcome.seenEmails, localOutcome.leadCount, {
            continueOnShardError: true,
          });
          if (result.leadCount === 0) {
            await store.addEvent(run.id, 'leads_saved', 'Saved 0 email leads.', { leadCount: 0 });
          }
          await store.updateRun(run.id, { status: 'completed', actorId: 'hybrid', leadCount: result.leadCount });
          await store.addEvent(run.id, 'run_completed', 'Hybrid Max Output run completed.', {
            leadCount: result.leadCount,
            businessCount: localOutcome.businessCount,
            providers: ['docker', 'google_places', 'apify'],
          });
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

      const { leadCount } = await runApifyShards(run, input);
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
    let persisted: { googleMaps?: GoogleMapsFilters; routeMode?: RouteMode } = {};
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

  async function startRun(input: ValidatedRunInput, options: StartRunOptions = {}) {
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
    });
    const queuedRun = { ...run };

    await store.addEvent(run.id, 'run_queued', 'Run queued.', {
      leadSource: input.leadSource,
    });

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
