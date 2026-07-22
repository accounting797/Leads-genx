import { describe, expect, it } from 'vitest';
import { buildQueryPlan, queriesForTier } from '../../src/domain/queryPlan';

describe('buildQueryPlan', () => {
  it('orders precision and expansion by location and keeps recovery dormant', () => {
    const plan = buildQueryPlan({
      searchTerms: ['oilfield services'],
      categoryFilters: ['Oil & Gas'],
      companyTypes: ['Distributor'],
      locations: ['Houston, TX', 'Tulsa, OK'],
    });

    expect(queriesForTier(plan, 'precision').map((item) => item.text)).toEqual([
      'oilfield services Houston, TX',
      'oilfield services Tulsa, OK',
      'Oil & Gas Houston, TX',
      'Oil & Gas Tulsa, OK',
      'oilfield services Oil & Gas Houston, TX',
      'oilfield services Oil & Gas Tulsa, OK',
    ]);
    expect(queriesForTier(plan, 'expansion').map((item) => item.text)).toEqual([
      'oilfield services Distributor Houston, TX',
      'oilfield services Distributor Tulsa, OK',
      'Oil & Gas Distributor Houston, TX',
      'Oil & Gas Distributor Tulsa, OK',
    ]);
    expect(queriesForTier(plan, 'recovery').every((item) => item.qualityConfidence === 'low')).toBe(true);
    expect(new Set(plan.map((item) => item.id)).size).toBe(plan.length);
  });

  it('uses one location-only precision item when no business criterion exists', () => {
    expect(buildQueryPlan({ locationQuery: 'Austin, TX' })).toEqual([
      expect.objectContaining({ tier: 'precision', location: 'Austin, TX', text: 'Austin, TX' }),
    ]);
  });

  it('uses company types as precision roots when terms and categories are absent', () => {
    const plan = buildQueryPlan({
      companyTypes: ['Distributor'],
      locations: ['Nashville, TN'],
    });

    expect(queriesForTier(plan, 'precision')).toEqual([
      expect.objectContaining({
        tier: 'precision',
        location: 'Nashville, TN',
        text: 'Distributor Nashville, TN',
      }),
    ]);
  });

  it('does not plan an empty query for a maps URL-only input', () => {
    expect(buildQueryPlan({
      mapsUrl: 'https://www.google.com/maps/search/oilfield+services',
    })).toEqual([]);
  });
});
