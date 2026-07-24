interface PendingTask {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/**
 * One run-scoped FIFO task pool with a strict concurrency ceiling.
 * Never create one pool per provider or per batch — the ceiling is global.
 */
export class BoundedTaskPool {
  private active = 0;
  private readonly queue: PendingTask[] = [];
  private drainWaiters: Array<() => void> = [];

  constructor(readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('Concurrency must be at least 1.');
    }
  }

  submit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        run: task as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.pump();
    });
  }

  /** Resolves only when every queued and running task has finished. */
  async drain(): Promise<void> {
    while (this.active > 0 || this.queue.length > 0) {
      await new Promise<void>((resolve) => {
        this.drainWaiters.push(resolve);
      });
    }
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const pending = this.queue.shift()!;
      this.active += 1;
      void (async () => {
        try {
          const value = await pending.run();
          pending.resolve(value);
        } catch (error) {
          pending.reject(error);
        } finally {
          this.active -= 1;
          this.pump();
          this.releaseDrainers();
        }
      })();
    }
  }

  private releaseDrainers(): void {
    if (this.active !== 0 || this.queue.length > 0) return;
    const waiters = this.drainWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}
