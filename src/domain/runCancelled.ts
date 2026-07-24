/** Thrown inside provider loops when the operator stops a run mid-flight. */
export class RunCancelledError extends Error {
  constructor() {
    super('Run cancelled by operator.');
    this.name = 'RunCancelledError';
  }
}

export type CancellationProbe = () => Promise<boolean>;

export async function throwIfCancelled(probe?: CancellationProbe): Promise<void> {
  if (probe && (await probe())) throw new RunCancelledError();
}
