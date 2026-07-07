import { ApifyClient } from 'apify-client';
import { ActorClient, ActorRunStarted, ActorRunStatus } from './actorClient';
import { ActorRunInput } from '../domain/types';

function createClient(token: string) {
  return new ApifyClient({ token });
}

export class ApifyActorClient implements ActorClient {
  async startRun(input: ActorRunInput): Promise<ActorRunStarted> {
    const client = createClient(input.token);
    const run = await client.actor(input.actorId).start(input.input);
    const finished = await client.run(run.id).waitForFinish({ waitSecs: 300 });

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
    const { items } = await client.dataset(datasetId).listItems();
    return items;
  }
}
