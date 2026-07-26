import { ActorClient, StreamingActorClient } from '../integrations/actorClient';
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
import { GoogleMapsFilters, LeadSource, NormalizedLead, OutputMode, RouteMode, SalesNavigatorFilters, ValidatedRunInput } from './types';
import { searchLinkedInPeople } from './brightDataLinkedInSearch';
import { BrightDataError } from '../integrations/brightDataClient';
import { OperatorSettings, QuarantinedCredential, filterQuarantined, withSavedCredentials } from './operatorSettings';
import { RunCancelledError, throwIfCancelled } from './runCancelled';
import { RunEngineer } from './runEngineer';

export interface RunRecord {
  id: number;
  userId?: number | null;
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
  /** Supplemental work scheduled only after the parent run has settled. */
  onRunSettled?: (runId: number) => Promise<void>;
}

export interface StartRunOptions {
  background?: boolean;
  /** Owner of the run in multi-user mode (null = legacy single-operator). */
  userId?: number;
}

interface RunApifyShardsOptions {
  continueOnShardError?: boolean;
  ingestionCoordinator?: RunIngestionCoordinator;
  engineer?: RunEngineer;
  isCancelled?: () => Promise<boolean>;
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
    comboId: input.comboId,
  });
}

export interface ResumeCredentials {
  googleApiKey?: string;
  googleApiKeys?: string[];
  apifyToken?: string;
  brightDataApiKey?: string;
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
  onRunSettled,
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
    // Shared, race-safe lead counter: parallel shards add their own deltas
    // synchronously, so concurrent ingestion can never lose an increment.
    const counter = { count: startingTotal };
    let failedShardCount = 0;
    let fatal: unknown;

    const saveCounted = async (normalizedLeads: NormalizedLead[]): Promise<void> => {
      const before = counter.count;
      const after = await saveEmailLeadsInBatches(run.id, normalizedLeads, seenEmails, before);
      counter.count += after - before;
    };

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

    // One ingestion path for both streaming waves and legacy whole-dataset
    // delivery — leads land the moment Apify produces them.
    const ingestItems = async (items: unknown[], shardNumber: number): Promise<void> => {
      if (!items.length) return;
      if (options.ingestionCoordinator && input.leadSource === 'google_maps') {
        await options.ingestionCoordinator.ingest(items, 'apify', input.googleMaps ?? {});
        counter.count = options.ingestionCoordinator.snapshot().qualifiedContactCount;
        return;
      }
      const sourceLeads = items.map((item) => normalizeLead(item, input.leadSource));
      const normalizedLeads = input.leadSource === 'google_maps'
        ? applyLeadQualityFilters(sourceLeads, input.googleMaps)
        : sourceLeads;
      await store.addEvent(
        run.id,
        'source_results',
        `Apify shard ${shardNumber} returned ${normalizedLeads.length} records; ${websiteCount(
          normalizedLeads
        )} had websites to scan.`,
        {
          provider: 'apify',
          shard: shardNumber,
          itemCount: normalizedLeads.length,
          websiteCount: websiteCount(normalizedLeads),
        }
      );
      await saveCounted(normalizedLeads);
    };

    const processShard = async (index: number, actorInput: (typeof actorInputs)[number]): Promise<void> => {
      await throwIfCancelled(options.isCancelled);
      const shardOperation = `Apify shard ${index + 1}/${actorInputs.length}`;
      await store.addEvent(run.id, 'apify_shard_started', `${shardOperation} started.`, {
        shard: index + 1,
        shardCount: actorInputs.length,
        actorId: actorInput.actorId,
      });
      await heartbeat('running', shardOperation, counter.count);

      try {
        let streamedCount = 0;
        const shardWork = async (): Promise<unknown[]> => {
          const streamClient = actorClient as Partial<StreamingActorClient>;

          // Streaming path (the default): results flow in waves while the
          // actor works — heartbeats every poll, leads within the first
          // minute, nothing lost if the actor dies mid-run.
          if (typeof streamClient.runAndStream === 'function') {
            const actorRun = await streamClient.runAndStream(actorInput, {
              onItems: async (wave) => {
                const firstWave = streamedCount === 0;
                streamedCount += wave.length;
                if (firstWave) {
                  await store.addEvent(
                    run.id,
                    'apify_stream_started',
                    `${shardOperation} is live — the first records are already flowing in.`,
                    { provider: 'apify', shard: index + 1 }
                  );
                }
                // Email-enriching a wave can take minutes — keep beating so
                // honest work never reads as a freeze.
                const ingestBeat = setInterval(() => {
                  void heartbeat('running', `${shardOperation} — enriching ${streamedCount} records (still working)`, counter.count).catch(
                    () => {}
                  );
                }, 15_000);
                ingestBeat.unref?.();
                try {
                  await ingestItems(wave, index + 1);
                } finally {
                  clearInterval(ingestBeat);
                }
                await heartbeat('running', `${shardOperation} — ${streamedCount} records flowing`, counter.count);
              },
              onProgress: async ({ status }) => {
                await heartbeat('running', `${shardOperation} (${status.toLowerCase()})`, counter.count);
              },
            });
            apifyRunIds.push(actorRun.runId);
            if (actorRun.datasetId) datasetIds.push(actorRun.datasetId);
            await store.updateRun(run.id, {
              apifyRunId: actorRun.runId,
              datasetId: actorRun.datasetId,
            });
            await store.addEvent(run.id, 'actor_succeeded', 'Actor run succeeded.', {
              apifyRunId: actorRun.runId,
              datasetId: actorRun.datasetId,
              shard: index + 1,
            });
            return []; // everything already ingested incrementally
          }

          // Legacy fallback for clients that cannot stream: wait for the
          // actor to finish, then fetch the whole dataset at once.
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

        if (items.length) await ingestItems(items, index + 1);
        await store.addEvent(run.id, 'apify_shard_completed', `${shardOperation} completed.`, {
          provider: 'apify',
          shard: index + 1,
          shardCount: actorInputs.length,
          itemCount: streamedCount || items.length,
          leadCount: counter.count,
        });
        await heartbeat('running', shardOperation, counter.count);
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
        await heartbeat('failed', `Apify shard ${index + 1} failed`, counter.count, 'shard_failed');
      }
    };

    // Shards run in parallel (one actor per Apify token), so a second token
    // no longer waits for the first actor to finish. Bounded at 3 so a big
    // token pool cannot stampede Apify or the database.
    const concurrency = Math.min(3, actorInputs.length);
    let nextIndex = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (nextIndex < actorInputs.length && !fatal) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          await processShard(index, actorInputs[index]);
        } catch (error) {
          fatal = fatal ?? error;
          return;
        }
      }
    });
    await Promise.all(workers);
    if (fatal) throw fatal;
    // Honour a stop requested while parallel shards were in flight — the
    // run still ends cancelled, with everything persisted kept.
    await throwIfCancelled(options.isCancelled);

    await heartbeat('completed', 'Apify shards completed', counter.count);
    return { leadCount: counter.count, datasetIds, apifyRunIds, failedShardCount };
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

  const cancelledRunIds = new Set<number>();

  /**
   * Bright Data LinkedIn people-search lane: SN-style filters in, deduped
   * person leads out — emails included when the contact-enriched dataset
   * has them. Saves profile leads even without emails (the Enrich button
   * can backfill later), deduping by profileUrl then normalizedEmail.
   */
  async function runBrightDataLinkedInSearch(
    run: RunRecord,
    input: ValidatedRunInput,
    apiKey: string,
    isCancelled: () => Promise<boolean>
  ): Promise<void> {
    await store.updateRun(run.id, { status: 'running', actorId: 'brightdata_linkedin' });
    await store.addEvent(
      run.id,
      'run_started',
      "Nova here — running your Sales Navigator filters through Bright Data's LinkedIn dataset. No SN account needed, and emails ride along when Bright Data has them.",
      { provider: 'brightdata' }
    );
    try {
      await throwIfCancelled(isCancelled);
      const { leads, totalHits } = await searchLinkedInPeople(input.salesNavigator ?? {}, input.maxResults, {
        apiKey,
        onEvent: (type, message, metadata) => store.addEvent(run.id, type, message, metadata),
      });
      await throwIfCancelled(isCancelled);

      const seenProfiles = new Set<string>();
      const seenEmails = new Set<string>();
      let leadCount = 0;
      for (let index = 0; index < leads.length; index += 25) {
        const batch = leads
          .slice(index, index + 25)
          .filter((lead) => {
            const key = (lead.profileUrl ?? '').toLowerCase();
            if (!key || seenProfiles.has(key)) return false;
            if (lead.email && seenEmails.has(lead.email)) return false;
            seenProfiles.add(key);
            if (lead.email) seenEmails.add(lead.email);
            return true;
          })
          .map((lead): NormalizedLead => ({
            leadSource: 'sales_navigator',
            leadType: 'person',
            fullName: lead.fullName,
            firstName: lead.firstName,
            lastName: lead.lastName,
            jobTitle: lead.jobTitle,
            companyName: lead.companyName,
            email: lead.email,
            normalizedEmail: lead.email,
            phone: lead.phone,
            location: lead.location,
            profileUrl: lead.profileUrl,
            contactQuality: lead.email ? 'qualified' : 'raw',
            qualityReason: lead.email
              ? 'Found via Bright Data LinkedIn search (contact-enriched)'
              : 'Found via Bright Data LinkedIn search — enrich for contact data',
            rawJson: lead.rawJson,
          }));
        if (!batch.length) continue;
        await store.addLeads(run.id, batch);
        leadCount += batch.length;
        await store.updateRun(run.id, { leadCount });
      }

      const withEmail = leads.filter((lead) => lead.email).length;
      await store.updateRun(run.id, { status: 'completed', leadCount });
      await store.addEvent(
        run.id,
        'run_completed',
        `Nova here — search complete: ${leadCount} LinkedIn leads saved (${withEmail} already have emails, ${totalHits} total matches in the dataset). The Enrich button can backfill the rest.`,
        { provider: 'brightdata', leadCount, withEmail, totalHits }
      );
    } catch (error) {
      if (error instanceof RunCancelledError) throw error;
      const message =
        error instanceof BrightDataError && error.code === 'auth'
          ? 'Bright Data rejected the API key — update it in Settings and run again.'
          : safeErrorMessage(error);
      await store.updateRun(run.id, { status: 'failed', errorMessage: message });
      await store.addEvent(run.id, 'run_failed', `Nova hit a wall with the Bright Data search: ${message}`, {
        provider: 'brightdata',
      });
    }
  }

  async function executeRun(run: RunRecord, input: ValidatedRunInput) {
    const statusReader = store as Partial<LocalFirstRunStore>;
    const isCancelled = async (): Promise<boolean> =>
      cancelledRunIds.has(run.id) ||
      (typeof statusReader.getRun === 'function' &&
        (await statusReader.getRun(run.id))?.status === 'cancelled');
    const engineer = new RunEngineer({
      runId: run.id,
      store,
      sleep: engineerSleep,
      setRunStatus: async (status) => {
        await store.updateRun(run.id, { status });
      },
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
      // Bright Data lane: Sales Navigator-style filter searches answered
      // straight from Bright Data's LinkedIn dataset — no SN account, no
      // Apify. URL/cookie-driven SN runs still ride HarvestAPI below.
      const brightDataKey =
        input.brightDataApiKey || (loadOperatorSettings ? (await loadOperatorSettings()).brightDataApiKey : undefined);
      if (input.leadSource === 'sales_navigator' && !input.searchUrl && input.salesNavigator && brightDataKey) {
        await runBrightDataLinkedInSearch(run, input, brightDataKey, isCancelled);
        return;
      }
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
            isCancelled,
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
            isCancelled,
          }, run, input, { finalize: false, ingestionCoordinator: coordinator })
            .then((outcome) => ({ ok: true as const, outcome }))
            .catch((error: unknown) => ({ ok: false as const, error }));
          const apifyTask = runApifyShards(run, input, undefined, undefined, {
            continueOnShardError: true,
            ingestionCoordinator: coordinator,
            engineer,
            isCancelled,
          })
            .then((result) => ({ ok: true as const, result }))
            .catch((error: unknown) => ({ ok: false as const, error }));

          const [balancedSettled, apifySettled] = await Promise.all([balancedTask, apifyTask]);
          // Draining the email-scan queue can take minutes — keep beating so
          // the finish line never reads as a freeze.
          const drainBeat = setInterval(() => {
            const snapNow = coordinator.snapshot();
            void localStore
              .upsertProviderState(run.id, {
                provider: 'email',
                status: 'running',
                operation: `Website contact scan finishing — ${snapNow.qualifiedContactCount} emails so far`,
                yieldCount: snapNow.qualifiedContactCount,
                heartbeatAt: new Date(),
              })
              .catch(() => {});
          }, 15_000);
          drainBeat.unref?.();
          try {
            await coordinator.drain();
          } finally {
            clearInterval(drainBeat);
          }
          await throwIfCancelled(isCancelled);
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
            isCancelled,
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

      const { leadCount } = await runApifyShards(run, input, undefined, undefined, { engineer, isCancelled });
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
      if (error instanceof RunCancelledError) {
        // The run row already says 'cancelled' — confirm the engine stopped
        // cleanly and leave the persisted output untouched.
        await store.addEvent(
          run.id,
          'run_cancelled_ack',
          'Engineer stopped the run cleanly — all output gathered so far is kept.'
        );
        return;
      }
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

  async function executeAndNotify(run: RunRecord, input: ValidatedRunInput): Promise<void> {
    try {
      await executeRun(run, input);
    } finally {
      try {
        await onRunSettled?.(run.id);
      } catch {
        // Supplemental discovery must never reopen, fail, or delay the parent
        // run beyond the small scheduling write.
      }
    }
  }

  async function stopRun(id: number) {
    cancelledRunIds.add(id);
    await store.updateRun(id, { status: 'cancelled', errorMessage: 'Stopped by operator.' });
    await store.addEvent(id, 'run_cancelled', 'Operator stopped the run — output gathered so far is kept.');
  }

  function recoveredInput(run: RunRecord, credentials: ResumeCredentials = {}): ValidatedRunInput {
    let persisted: {
      googleMaps?: GoogleMapsFilters;
      salesNavigator?: SalesNavigatorFilters;
      routeMode?: RouteMode;
      outputMode?: OutputMode;
    } = {};
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
      apifyToken: credentials.apifyToken,
      apifyTokens: credentials.apifyToken ? [credentials.apifyToken] : undefined,
      brightDataApiKey: credentials.brightDataApiKey,
      salesNavigator: persisted.salesNavigator,
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
    void executeAndNotify(queued, input);
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
      void executeAndNotify(run, input);
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
    const skippedDeadCredentials = { apify: 0, google: 0 };
    const input = { ...merged };
    if (loadQuarantinedCredentials) {
      const quarantined = await loadQuarantinedCredentials();
      if (quarantined.length) {
        if (input.apifyTokens?.length) {
          const { kept, skipped } = filterQuarantined(input.apifyTokens, quarantined);
          input.apifyTokens = kept.length ? kept : undefined;
          input.apifyToken = kept[0];
          skippedDeadCredentials.apify += skipped;
        }
        if (input.googleApiKeys?.length) {
          const { kept, skipped } = filterQuarantined(input.googleApiKeys, quarantined);
          input.googleApiKeys = kept.length ? kept : undefined;
          input.googleApiKey = kept[0];
          skippedDeadCredentials.google += skipped;
        }
      }
    }
    const actorInput =
      input.leadSource === 'sales_navigator' &&
      !input.searchUrl &&
      input.salesNavigator &&
      input.brightDataApiKey
        ? { actorId: 'brightdata_linkedin' }
        : isLocalFirstRun(input)
          ? { actorId: 'local_first' }
          : isHybridRun(input)
            ? { actorId: 'hybrid' }
            : isGooglePlacesRun(input)
              ? { actorId: 'google_places' }
              : buildActorInput(input);
    const run = await store.createRun({
      userId: options.userId ?? null,
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

    for (const [provider, count] of Object.entries(skippedDeadCredentials) as Array<
      ['apify' | 'google', number]
    >) {
      if (count === 0) continue;
      const credentialName = provider === 'apify' ? 'Apify API token' : 'Google Places API key';
      await store.addEvent(
        run.id,
        'engineer_action',
        `Nova skipped ${count} previously rejected ${credentialName}${count === 1 ? '' : 's'}. Replace ${count === 1 ? 'it' : 'them'} in Settings when you have a moment.`,
        {
          provider,
          kind: 'credential_skipped',
          reasoning: 'These credentials were rejected by their provider before; reusing them would only waste a shard.',
        }
      );
    }

    const runInBackground = options.background ?? true;
    if (runInBackground) {
      void executeAndNotify(run, input);
    } else {
      await executeAndNotify(run, input);
    }

    return queuedRun;
  }

  return {
    startRun,
    stopRun,
    executeRun: executeAndNotify,
    resumeRun,
    recoverInterruptedRuns,
    scraperHealth,
  };
}
