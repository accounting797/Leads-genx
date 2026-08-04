import { describe, expect, it } from 'vitest';
import { evaluateGeography } from '../../../src/domain/targeted/geographyEvidence';

describe('evaluateGeography', () => {
  it('rejects explicit Nigerian evidence for a US target', () => {
    expect(evaluateGeography({
      address: '12 Example Road, Lagos 100001, Lagos, Nigeria',
      email: 'info@company.ng',
    }, {
      country: 'US', areaCodes: [], states: [], cities: [], postalCodes: [],
    })).toMatchObject({ status: 'foreign', strictEligible: false, reason: 'foreign_country' });
  });

  it('keeps missing geography ambiguous and out of Strict', () => {
    expect(evaluateGeography({ address: '', email: 'info@example.com' }, {
      country: 'US', areaCodes: [], states: [], cities: [], postalCodes: [],
    })).toMatchObject({ status: 'ambiguous', strictEligible: false, reason: 'missing_geography' });
  });

  it('matches a structured US address against its target market', () => {
    expect(evaluateGeography({ address: 'Phoenix, AZ 85001', phone: '(602) 555-0100' }, {
      country: 'US', areaCodes: ['602'], states: ['AZ'], cities: ['Phoenix'], postalCodes: ['85001'],
    })).toMatchObject({ status: 'match', strictEligible: true });
  });

  it('does not match short state tokens inside unrelated words', () => {
    expect(evaluateGeography({ address: 'Lagos Business District, Nigeria' }, {
      country: 'US', areaCodes: [], states: ['IN'], cities: [], postalCodes: [],
    })).toMatchObject({ status: 'foreign', strictEligible: false });
  });
});
