import { describe, expect, it } from 'vitest';
import { collectDatasetItems } from '../../src/integrations/apifyActorClient';

describe('collectDatasetItems', () => {
  it('reads every dataset page until the final short page', async () => {
    const calls: Array<{ offset: number; limit: number }> = [];

    const items = await collectDatasetItems(async (offset, limit) => {
      calls.push({ offset, limit });
      if (offset === 0) return [{ id: 1 }, { id: 2 }, { id: 3 }];
      if (offset === 3) return [{ id: 4 }];
      return [];
    }, 3);

    expect(items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
    expect(calls).toEqual([
      { offset: 0, limit: 3 },
      { offset: 3, limit: 3 },
    ]);
  });
});
