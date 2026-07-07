import { ActorRunInput } from '../domain/types';

export interface ActorRunStarted {
  runId: string;
  status: string;
  datasetId?: string;
}

export interface ActorRunStatus {
  runId: string;
  status: string;
  datasetId?: string;
}

export interface ActorClient {
  startRun(input: ActorRunInput): Promise<ActorRunStarted>;
  getRun(runId: string): Promise<ActorRunStatus>;
  getDatasetItems(datasetId: string, token: string): Promise<unknown[]>;
}
