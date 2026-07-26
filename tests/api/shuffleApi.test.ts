import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { SHUFFLE_COMBOS } from '../../src/domain/shuffleCombos';

function appWithRuns(runs: Array<{ filterJson: string; leadCount: number }>) {
  const prismaStub = {
    appSetting: { async findMany() { return []; } },
    run: {
      async findMany() {
        return runs;
      },
    },
  };
  return createApp({
    authDisabled: true,
    prisma: prismaStub as never,
    runService: { async startRun() { return { id: 1 }; } } as never,
  });
}

describe('GET /api/shuffle/next', () => {
  it('deals the first combo to a brand-new user', async () => {
    const res = await request(appWithRuns([])).get('/api/shuffle/next');
    expect(res.status).toBe(200);
    expect(res.body.data.combo.id).toBe(SHUFFLE_COMBOS[0].id);
    expect(res.body.data.freshTerritory).toBe(true);
    expect(res.body.data.combosTried).toBe(0);
  });

  it('skips combos the user already ran and counts their leads', async () => {
    const res = await request(
      appWithRuns([
        { filterJson: JSON.stringify({ comboId: SHUFFLE_COMBOS[0].id }), leadCount: 44 },
        { filterJson: JSON.stringify({ comboId: SHUFFLE_COMBOS[0].id }), leadCount: 21 },
        { filterJson: JSON.stringify({ googleMaps: {} }), leadCount: 5 }, // no combo — ignored
        { filterJson: 'not-json', leadCount: 5 }, // unparseable — ignored
      ])
    ).get('/api/shuffle/next');

    expect(res.status).toBe(200);
    expect(res.body.data.combo.id).toBe(SHUFFLE_COMBOS[1].id);
    expect(res.body.data.combosTried).toBe(1);
  });

  it('after a full rotation, replays the best-yield combo', async () => {
    const runs = SHUFFLE_COMBOS.map((combo) => ({
      filterJson: JSON.stringify({ comboId: combo.id }),
      leadCount: 3,
    }));
    runs[3].leadCount = 150;
    const res = await request(appWithRuns(runs)).get('/api/shuffle/next');
    expect(res.body.data.combo.id).toBe(SHUFFLE_COMBOS[3].id);
    expect(res.body.data.freshTerritory).toBe(false);
  });
});
