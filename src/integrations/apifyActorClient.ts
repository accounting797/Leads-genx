import { ApifyClient } from 'apify-client';
import { ActorClient, ActorRunStarted, ActorRunStatus } from './actorClient';
import { ActorRunInput } from '../domain/types';

function createClient(token: string) {
  return new ApifyClient({ token });
}

const DATASET_PAGE_SIZE = 1000;
const ACTOR_WAIT_SECONDS = 3600;

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

export class ApifyActorClient implements ActorClient {
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
