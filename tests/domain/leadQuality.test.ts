import { describe, expect, it } from 'vitest';
import { meetsGoogleMapsQualityFilters } from '../../src/domain/leadQuality';
import { NormalizedLead } from '../../src/domain/types';

function business(overrides: Partial<NormalizedLead> = {}): NormalizedLead {
  return {
    leadSource: 'google_maps',
    leadType: 'business',
    companyName: 'Qualified Co',
    rating: 4.7,
    reviewsCount: 120,
    rawJson: JSON.stringify({ businessStatus: 'OPERATIONAL' }),
    ...overrides,
  };
}

describe('meetsGoogleMapsQualityFilters', () => {
  it('enforces minimum rating and review count', () => {
    const filters = { minimumStars: 4.5, minimumReviews: 50 };
    expect(meetsGoogleMapsQualityFilters(business(), filters)).toBe(true);
    expect(meetsGoogleMapsQualityFilters(business({ rating: 4.2 }), filters)).toBe(false);
    expect(meetsGoogleMapsQualityFilters(business({ reviewsCount: 10 }), filters)).toBe(false);
    expect(meetsGoogleMapsQualityFilters(business({ rating: undefined }), filters)).toBe(false);
  });

  it('rejects explicitly closed businesses while retaining unknown status', () => {
    expect(meetsGoogleMapsQualityFilters(business({ rawJson: JSON.stringify({ businessStatus: 'CLOSED_PERMANENTLY' }) }), { skipClosedPlaces: true })).toBe(false);
    expect(meetsGoogleMapsQualityFilters(business({ rawJson: JSON.stringify({ temporarilyClosed: true }) }), { skipClosedPlaces: true })).toBe(false);
    expect(meetsGoogleMapsQualityFilters(business({ rawJson: '{}' }), { skipClosedPlaces: true })).toBe(true);
  });
});
