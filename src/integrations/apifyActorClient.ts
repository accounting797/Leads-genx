import { ApifyClient } from 'apify-client';

export interface ActorRunOptions {
  actorId: string;
  input: Record<string, unknown>;
  timeoutSecs?: number;
  maxPolls?: number;
  pollIntervalMs?: number;
}

export interface ActorRunResult {
  datasetItems: unknown[];
  runId: string;
  status: string;
}

export class ApifyActorClient {
  private client: ApifyClient;

  constructor(token?: string) {
    const apiToken = token || process.env.APIFY_TOKEN || '';
    if (!apiToken) {
      console.warn('[ApifyActorClient] No APIFY_TOKEN provided. Actor runs will fail.');
    }

    // ApifyClient v2 constructor only accepts { token }
    this.client = new ApifyClient({ token: apiToken });
  }

  async runActor(options: ActorRunOptions): Promise<ActorRunResult> {
    const {
      actorId,
      input,
      timeoutSecs = 300,
      maxPolls = 120,
      pollIntervalMs = 5000,
    } = options;

    if (!this.client) {
      throw new Error('Apify client not initialized. Check APIFY_TOKEN.');
    }

    try {
      const run = await this.client.actor(actorId).call(input, {
        waitForFinish: 0,
      });

      const runId = run.id;
      let status = run.status;
      let polls = 0;

      while (
        status !== 'SUCCEEDED' && 
        status !== 'FAILED' && 
        status !== 'TIMED-OUT' && 
        status !== 'ABORTED' &&
        polls < maxPolls
      ) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

        const runInfo = await this.client.run(runId).get();
        if (!runInfo) break;

        status = runInfo.status;
        polls++;

        const elapsedMs = polls * pollIntervalMs;
        if (elapsedMs > timeoutSecs * 1000) {
          console.warn(`[ApifyActorClient] Run ${runId} exceeded timeout (${timeoutSecs}s)`);
          break;
        }
      }

      if (status !== 'SUCCEEDED') {
        throw new Error(`Actor run ${runId} finished with status: ${status}`);
      }

      const dataset = await this.client.run(runId).dataset().listItems();

      return {
        datasetItems: dataset.items || [],
        runId,
        status,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ApifyActorClient] Run failed: ${message}`);
      throw new Error(`Apify actor run failed: ${message}`);
    }
  }

  async getDatasetItems(runId: string): Promise<unknown[]> {
    try {
      const dataset = await this.client.run(runId).dataset().listItems();
      return dataset.items || [];
    } catch (error) {
      console.error(`[ApifyActorClient] Failed to fetch dataset: ${error}`);
      return [];
    }
  }
}
