import { describe, expect, it } from 'vitest';
import { SerialTaskQueue } from '../../src/domain/serialTaskQueue';

describe('SerialTaskQueue', () => {
  it('runs tasks in FIFO order and drains all accepted work', async () => {
    const queue = new SerialTaskQueue();
    const calls: string[] = [];
    const first = queue.enqueue(async () => {
      calls.push('first:start');
      await Promise.resolve();
      calls.push('first:end');
      return 1;
    });
    const second = queue.enqueue(async () => {
      calls.push('second');
      return 2;
    });

    await queue.drain();

    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(calls).toEqual(['first:start', 'first:end', 'second']);
  });

  it('continues after a rejected task while preserving that rejection', async () => {
    const queue = new SerialTaskQueue();
    const failed = queue.enqueue(async () => { throw new Error('one failed'); });
    const succeeded = queue.enqueue(async () => 'two passed');

    await expect(failed).rejects.toThrow('one failed');
    await expect(succeeded).resolves.toBe('two passed');
    await expect(queue.drain()).resolves.toBeUndefined();
  });
});
