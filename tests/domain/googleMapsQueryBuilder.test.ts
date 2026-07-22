import { describe, expect, it } from 'vitest';
import { buildGoogleMapsSearchQueries } from '../../src/domain/googleMapsQueryBuilder';

describe('buildGoogleMapsSearchQueries', () => {
  it('uses company types as modifiers when specific criteria exist', () => {
    expect(buildGoogleMapsSearchQueries({
      searchTerms: ['oilfield services'],
      categoryFilters: ['Oil & Gas'],
      companyTypes: ['Distributor', 'Corporation'],
      locations: ['Washington, DC', 'Austin, TX'],
    })).toEqual([
      'oilfield services Washington, DC',
      'oilfield services Austin, TX',
      'Oil & Gas Washington, DC',
      'Oil & Gas Austin, TX',
      'oilfield services Oil & Gas Washington, DC',
      'oilfield services Oil & Gas Austin, TX',
      'oilfield services Distributor Washington, DC',
      'oilfield services Distributor Austin, TX',
      'oilfield services Corporation Washington, DC',
      'oilfield services Corporation Austin, TX',
      'Oil & Gas Distributor Washington, DC',
      'Oil & Gas Distributor Austin, TX',
      'Oil & Gas Corporation Washington, DC',
      'Oil & Gas Corporation Austin, TX',
    ]);
  });

  it('falls back to the location when company types are the only criteria', () => {
    expect(buildGoogleMapsSearchQueries({
      companyTypes: ['Distributor'],
      locations: ['Nashville, TN'],
    })).toEqual(['Nashville, TN']);
  });
});
