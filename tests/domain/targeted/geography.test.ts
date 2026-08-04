import { describe, expect, it } from 'vitest';
import { validateGeography } from '../../../src/domain/targeted/geography';

describe('validateGeography', () => {
  it('accepts matching US area-code-first geography', () => {
    expect(validateGeography({ country: 'US', areaCodes: ['602'], states: ['AZ'], cities: ['Phoenix'] }))
      .toMatchObject({ country: 'US', areaCodes: ['602'] });
  });

  it('rejects an area code assigned to another state', () => {
    expect(() => validateGeography({ country: 'US', areaCodes: ['602'], states: ['TX'], cities: ['Dallas'] }))
      .toThrow(/602.*Arizona/i);
  });
});
