import { describe, expect, it } from 'vitest';
import { BoundedTaskPool } from '../../src/domain/boundedTaskPool';

describe('BoundedTaskPool', () => {
  it('requires a concurrency of at least 1', () => {
    expect(() => new BoundedTaskPool(0)).toThrow('Concurrency must be at least 1.');
  });

  it('never exceeds its concurrency ceiling and resolves every submitted job', async () => {
    const pool = new BoundedTaskPool(50);
    let active = 0;
    let peak = 0;
    const gates: Array<() => void> = [];

    const promises = Array.from({ length: 80 }, (_, index) =>
      pool.submit(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => gates.push(resolve));
        active -= 1;
        return index;
      })
    );

    // All 80 jobs are queued; exactly 50 should be running.
    await Promise.resolve();
    expect(peak).toBe(50);
    expect(gates).toHaveLength(50);

    for (const release of gates.splice(0)) release();
    // The remaining 30 start once the first wave releases.
    while (gates.length < 30) await new Promise((resolve) => setTimeout(resolve, 0));
    for (const release of gates.splice(0)) release();

    const results = await Promise.all(promises);
    expect(results).toHaveLength(80);
    expect(results[0]).toBe(0);
    expect(results[79]).toBe(79);
    expect(peak).toBe(50);
    await pool.drain();
  });

  it('drain resolves immediately when idle and waits for running work', async () => {
    const pool = new BoundedTaskPool(2);
    await pool.drain();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    const task = pool.submit(async () => {
      await gate;
      finished = true;
    });
    const draining = pool.drain();
    await Promise.resolve();
    release();
    await draining;
    await task;
    expect(finished).toBe(true);
  });
});
