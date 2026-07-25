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

export interface ActorStreamProgress {
  status: string;
  totalItems: number;
}

export interface ActorStreamCallbacks {
  /** Called with each new wave of dataset items as the actor produces them. */
  onItems?: (items: unknown[]) => Promise<void>;
  /** Called on every status poll so the operator sees a live heartbeat. */
  onProgress?: (progress: ActorStreamProgress) => Promise<void>;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

export interface ActorClient {
  startRun(input: ActorRunInput): Promise<ActorRunStarted>;
  getRun(runId: string): Promise<ActorRunStatus>;
  getDatasetItems(datasetId: string, token: string): Promise<unknown[]>;
}

/**
 * Streaming variant: instead of waiting for the actor to finish and only
 * then fetching everything, results flow in waves while the actor works —
 * leads land within the first minute instead of at the very end.
 */
export interface StreamingActorClient extends ActorClient {
  runAndStream(input: ActorRunInput, callbacks?: ActorStreamCallbacks): Promise<ActorRunStarted>;
}
