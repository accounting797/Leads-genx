import { ActorClient } from '../integrations/actorClient';
import { GooglePlacesClient } from '../integrations/googlePlacesClient';
import { EmailExtractor, keepEmailLeadsOnly } from './emailExtractor';
import { buildActorInput } from './sourceInputBuilder';
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
}

export interface StartRunOptions {
  background?: boolean;
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

export function createRunService({
  store,
  actorClient,
  googlePlacesClient,
  emailExtractor,
}: RunServiceDeps) {
  async function executeRun(run: RunRecord, input: ValidatedRunInput) {
    try {
      if (isGooglePlacesRun(input)) {
        if (!googlePlacesClient) throw new Error('Google Places client is not configured');
        if (!input.googleApiKey) throw new Error('Google API key is required for Google Places runs');

        await store.updateRun(run.id, {
          status: 'running',
          actorId: 'google_places',
        });
        await store.addEvent(run.id, 'run_started', 'Google Places search started.', {
          leadSource: input.leadSource,
          provider: 'google_places',
        });

        const items = await googlePlacesClient.search({
          apiKey: input.googleApiKey,
          filters: input.googleMaps ?? {},
          maxResults: input.maxResults,
        });
        const leads = await keepEmailLeadsOnly(
          items.map((item) => normalizeLead(item, input.leadSource)),
          emailExtractor
        );

        await store.addLeads(run.id, leads);
        await store.addEvent(run.id, 'leads_saved', `Saved ${leads.length} email leads.`, {
          leadCount: leads.length,
        });
        await store.updateRun(run.id, {
          status: 'completed',
          actorId: 'google_places',
          datasetId: 'google_places',
          leadCount: leads.length,
        });
        await store.addEvent(run.id, 'run_completed', 'Run completed.', {
          leadCount: leads.length,
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

      const actorRun = await actorClient.startRun(actorInput);
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
      });

      const items = actorRun.datasetId
        ? await actorClient.getDatasetItems(actorRun.datasetId, actorInput.token)
        : [];
      const leads = await keepEmailLeadsOnly(
        items.map((item) => normalizeLead(item, input.leadSource)),
        emailExtractor
      );

      await store.addLeads(run.id, leads);
      await store.addEvent(run.id, 'leads_saved', `Saved ${leads.length} email leads.`, {
        leadCount: leads.length,
      });
      await store.updateRun(run.id, {
        status: 'completed',
        leadCount: leads.length,
      });
      await store.addEvent(run.id, 'run_completed', 'Run completed.', {
        leadCount: leads.length,
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
    const actorInput = isGooglePlacesRun(input)
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
