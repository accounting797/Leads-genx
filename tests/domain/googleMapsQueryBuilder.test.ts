import { describe, expect, it } from 'vitest';
import { buildGoogleMapsSearchQueries } from '../../src/domain/googleMapsQueryBuilder';

describe('buildGoogleMapsSearchQueries', () => {
  it('uses company types as modifiers when specific criteria exist', () => {
    expect(buildGoogleMapsSearchQueries({
      searchTerms: ['oilfield services'],
      categoryFilters: ['Oil & Gas'],
      companyTypes: ['Distributor', 'Corporation'],
      locations: ['Washington, DC'],
    })).toEqual([
      'oilfield services Washington, DC',
      'Oil & Gas Washington, DC',
      'oilfield services Oil & Gas Washington, DC',
      'oilfield services Distributor Washington, DC',
      'oilfield services Corporation Washington, DC',
      'Oil & Gas Distributor Washington, DC',
      'Oil & Gas Corporation Washington, DC',
    ]);
  });

  it('retains standalone company types when they are the only criteria', () => {
    expect(buildGoogleMapsSearchQueries({
      companyTypes: ['Distributor'],
      locations: ['Nashville, TN'],
    })).toEqual(['Distributor Nashville, TN']);
  });
});
