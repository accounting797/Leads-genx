import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { SHUFFLE_COMBOS } from '../../src/domain/shuffleCombos';

function appWithRuns(runs: Array<{ filterJson: string; leadCount: number }>) {
  const prismaStub = {
    appSetting: { async findMany() { return []; } },
    run: { async findMany() { return runs; } },
  };
  return createApp({
    authDisabled: true,
    prisma: prismaStub as never,
    runService: { async startRun() { return { id: 1 }; } } as never,
  });
}

describe('POST /api/shuffle/next', () => {
  it('returns a different Google Maps combination and exact filters', async () => {
    const first = SHUFFLE_COMBOS[0];
    const res = await request(appWithRuns([])).post('/api/shuffle/next').send({
      source: 'google_maps',
      recentComboIds: [first.id],
      recentCities: [first.city],
      currentComboId: first.id,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.combo.id).not.toBe(first.id);
    expect(res.body.data.combo.city).not.toBe(first.city);
    expect(res.body.data.filters).toEqual({
      searchTerms: [res.body.data.combo.googleMaps.searchTerm],
      categoryFilters: [res.body.data.combo.googleMaps.category],
      companyTypes: [res.body.data.combo.googleMaps.companyType],
      locations: [res.body.data.combo.city],
    });
  });

  it('returns exact Sales Navigator filters', async () => {
    const res = await request(appWithRuns([])).post('/api/shuffle/next').send({ source: 'sales_navigator' });
    expect(res.status).toBe(200);
    expect(res.body.data.filters).toEqual({
      titles: [res.body.data.combo.salesNavigator.title],
      industries: [res.body.data.combo.salesNavigator.industry],
      geographies: [res.body.data.combo.city],
      headcounts: [res.body.data.combo.salesNavigator.headcount],
    });
  });

  it('rejects invalid sources and safely ignores stale history', async () => {
    await request(appWithRuns([])).post('/api/shuffle/next').send({ source: 'wrong' }).expect(400);
    const res = await request(appWithRuns([])).post('/api/shuffle/next').send({
      source: 'google_maps',
      recentComboIds: ['removed-combo'],
      recentCities: ['Unknown'],
    });
    expect(res.status).toBe(200);
    expect(SHUFFLE_COMBOS.some((combo) => combo.id === res.body.data.combo.id)).toBe(true);
  });
});
