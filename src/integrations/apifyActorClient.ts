import { ApifyClient } from 'apify-client';
import { ActorClient, ActorRunStarted, ActorRunStatus } from './actorClient';
import { ActorRunInput } from '../domain/types';

function createClient(token: string) {
  return new ApifyClient({ token });
}

const DATASET_PAGE_SIZE = 1000;
const ACTOR_WAIT_SECONDS = 3600;
const POLL_INTERVAL_MS = 30_000;
const MAX_POLL_ATTEMPTS = 120;
const MAX_HTTP_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1_000;

const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

export async function collectDatasetItems(
  listPage: (offset: number, limit: number) => Promise<unknown[]>,
  limit = DATASET_PAGE_SIZE
): Promise<unknown[]> {
  const items: unknown[] = [];

  for (let offset = 0; ; offset += limit) {
    const page = await listPage(offset, limit);
    items.push(...page);
    if (page.length < limit) return items;
  }
}

async function withRetry<T>(fn: () => Promise<T>, label: string, maxRetries = MAX_HTTP_RETRIES): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

export class ApifyActorClient implements ActorClient {
  async startRun(input: ActorRunInput): Promise<ActorRunStarted> {
    const client = createClient(input.token);
    const run = await withRetry(
      () => client.actor(input.actorId).start(input.input),
      `startRun:${input.actorId}`
    );
    const finished = await withRetry(
      () => client.run(run.id).waitForFinish({ waitSecs: ACTOR_WAIT_SECONDS }),
      `waitForFinish:${run.id}`
    );

    return {
      runId: run.id,
      status: finished.status ?? 'UNKNOWN',
      datasetId: finished.defaultDatasetId,
    };
  }

  async getRun(runId: string, token?: string): Promise<ActorRunStatus> {
    if (!token) {
      throw new Error('Apify token is required for run status polling');
    }
    const client = createClient(token);
    const run = await withRetry(
      () => client.run(runId).get(),
      `getRun:${runId}`
    );
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }
    return {
      runId: run.id,
      status: run.status ?? 'UNKNOWN',
      datasetId: run.defaultDatasetId,
    };
  }

  async pollUntilTerminal(runId: string, token: string, onStatus?: (status: string) => void): Promise<ActorRunStatus> {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      const status = await this.getRun(runId, token);
      onStatus?.(status.status);
      if (TERMINAL_STATUSES.has(status.status)) {
        return status;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(`Polling timed out for run ${runId} after ${MAX_POLL_ATTEMPTS} attempts`);
  }

  async startRunNonBlocking(input: ActorRunInput): Promise<ActorRunStarted> {
    const client = createClient(input.token);
    const run = await withRetry(
      () => client.actor(input.actorId).start(input.input),
      `startRunNonBlocking:${input.actorId}`
    );
    return {
      runId: run.id,
      status: run.status ?? 'RUNNING',
      datasetId: run.defaultDatasetId,
    };
  }

  async startParallelRuns(inputs: ActorRunInput[]): Promise<ActorRunStarted[]> {
    const results = await Promise.allSettled(
      inputs.map((input) => this.startRunNonBlocking(input))
    );
    return results.map((result, index) => {
      if (result.status === 'fulfilled') return result.value;
      throw new Error(`Failed to start run for shard ${index + 1}: ${result.reason}`);
    });
  }

  async getDatasetItems(datasetId: string, token: string): Promise<unknown[]> {
    const client = createClient(token);
    const dataset = client.dataset(datasetId);
    return collectDatasetItems(async (offset, limit) => {
      const { items } = await dataset.listItems({ offset, limit });
      return items;
    });
  }
}
