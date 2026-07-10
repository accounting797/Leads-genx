import { ActorClient } from '../integrations/actorClient';
import { GooglePlacesClient } from '../integrations/googlePlacesClient';
import { EmailExtractor, keepEmailLeadsOnly } from './emailExtractor';
import { buildActorInput, buildActorInputsForApifyTokens } from './sourceInputBuilder';
import { safeErrorMessage } from './errorLogger';
import { normalizeLead } from './leadNormalizer';
import { LeadSource, NormalizedLead, ValidatedRunInput } from './types';

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
  emailExtractor?: EmailExtractor;
  emailLeadBatchSize?: number;
  emailExtractionConcurrency?: number;
}

export interface StartRunOptions {
  background?: boolean;
}

interface RunApifyShardsOptions {
  continueOnShardError?: boolean;
}

function serializeFilters(input: ValidatedRunInput): string {
  return JSON.stringify({
    googleMaps: input.googleMaps,
    salesNavigator: input.salesNavigator,
  });
}

function isGooglePlacesRun(input: ValidatedRunInput): boolean {
  return input.leadSource === 'google_maps' && input.googleMaps?.provider === 'google_places';
}

function isHybridRun(input: ValidatedRunInput): boolean {
  return input.leadSource === 'google_maps' && input.googleMaps?.provider === 'hybrid';
}

function websiteCount(leads: NormalizedLead[]): number {
  return leads.filter((lead) => Boolean(lead.website)).length;
}

export function createRunService({
  store,
  actorClient,
  googlePlacesClient,
  emailExtractor,
  emailLeadBatchSize = 100,
  emailExtractionConcurrency = 50,
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
    startingTotal = 0
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
      maxResults: input.maxResults,
    });
    const normalizedLeads = items.map((item) => normalizeLead(item, input.leadSource));
    await store.addEvent(
      run.id,
      'source_results',
      `Google Places returned ${normalizedLeads.length} businesses; ${websiteCount(
        normalizedLeads
      )} had websites to scan.`,
      { provider: 'google_places', itemCount: normalizedLeads.length, websiteCount: websiteCount(normalizedLeads) }
    );
    return saveEmailLeadsInBatches(run.id, normalizedLeads, seenEmails, startingTotal);
  }

  async function executeRun(run: RunRecord, input: ValidatedRunInput) {
    try {
      if (isHybridRun(input)) {
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
          leadCount = await runGooglePlaces(run, input, seenEmails, leadCount);
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

  async function startRun(input: ValidatedRunInput, options: StartRunOptions = {}) {
    const actorInput = isHybridRun(input)
      ? { actorId: 'hybrid' }
      : isGooglePlacesRun(input)
        ? { actorId: 'google_places' }
        : buildActorInput(input);
    const run = await store.createRun({
      status: 'queued',
      leadSource: input.leadSource,
      searchUrl: input.searchUrl,
      filterJson: serializeFilters(input),
      actorId: actorInput.actorId,
      maxResults: input.maxResults,
      leadCount: 0,
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
  };
}
