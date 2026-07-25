import { ApifyClient } from 'apify-client';
import { ActorClient, ActorRunStarted, ActorRunStatus, ActorStreamCallbacks, StreamingActorClient } from './actorClient';
import { ActorRunInput } from '../domain/types';

function createClient(token: string) {
  return new ApifyClient({ token });
}

const DATASET_PAGE_SIZE = 1000;
const ACTOR_WAIT_SECONDS = 3600;
const STREAM_POLL_INTERVAL_MS = 15_000;
const STREAM_MAX_WAIT_MS = 60 * 60 * 1000;
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

export class ApifyActorClient implements StreamingActorClient {
  async startRun(input: ActorRunInput): Promise<ActorRunStarted> {
    const client = createClient(input.token);
    const run = await client.actor(input.actorId).start(input.input);
    const finished = await client.run(run.id).waitForFinish({ waitSecs: ACTOR_WAIT_SECONDS });

    return {
      runId: run.id,
      status: finished.status ?? 'UNKNOWN',
      datasetId: finished.defaultDatasetId,
    };
  }

  /**
   * Starts the actor and streams results as they land: every poll cycle
   * drains newly produced dataset items and reports a live heartbeat, so a
   * 30-minute actor run produces leads from minute one instead of looking
   * frozen until the very end.
   */
  async runAndStream(input: ActorRunInput, callbacks: ActorStreamCallbacks = {}): Promise<ActorRunStarted> {
    const client = createClient(input.token);
    const run = await client.actor(input.actorId).start(input.input);
    const datasetId = run.defaultDatasetId;
    const pollIntervalMs = callbacks.pollIntervalMs ?? STREAM_POLL_INTERVAL_MS;
    const deadline = Date.now() + (callbacks.maxWaitMs ?? STREAM_MAX_WAIT_MS);
    let offset = 0;

    const drainNewItems = async (): Promise<void> => {
      if (!datasetId || !callbacks.onItems) return;
      const dataset = client.dataset(datasetId);
      for (;;) {
        const { items } = await dataset.listItems({ offset, limit: DATASET_PAGE_SIZE });
        if (!items.length) return;
        offset += items.length;
        await callbacks.onItems(items);
        if (items.length < DATASET_PAGE_SIZE) return;
      }
    };

    for (;;) {
      if (Date.now() > deadline) {
        throw new Error('Actor run exceeded the 60-minute watch window.');
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const info = await client.run(run.id).get();
      const status = info?.status ?? 'UNKNOWN';
      await drainNewItems();
      if (callbacks.onProgress) await callbacks.onProgress({ status, totalItems: offset });
      if (TERMINAL_STATUSES.has(status)) {
        if (status !== 'SUCCEEDED') {
          throw new Error(`Actor finished with status ${status}`);
        }
        await drainNewItems(); // final sweep — nothing produced gets left behind
        return { runId: run.id, status, datasetId };
      }
    }
  }

  async getRun(runId: string): Promise<ActorRunStatus> {
    throw new Error(`Run status polling is not implemented for ${runId}`);
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
