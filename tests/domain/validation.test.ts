import { describe, expect, it } from 'vitest';
import { validateCreateRunInput, ValidationError } from '../../src/domain/validation';

describe('validateCreateRunInput', () => {
  it('rejects a missing Apify token when no saved token exists', () => {
    expect(() =>
      validateCreateRunInput({ leadSource: 'google_maps' }, false)
    ).toThrow(ValidationError);
  });

  it('rejects Google Maps runs without search terms or a maps URL', () => {
    expect(() =>
      validateCreateRunInput(
        {
          apifyToken: 'secret-token',
          leadSource: 'google_maps',
          googleMaps: { locationQuery: 'Austin, TX' },
        },
        false
      )
    ).toThrow(/search term/i);
  });

  it('rejects Sales Navigator runs without a URL or filters', () => {
    expect(() =>
      validateCreateRunInput(
        {
          apifyToken: 'secret-token',
          leadSource: 'sales_navigator',
          maxResults: 50,
        },
        false
      )
    ).toThrow(/Sales Navigator/i);
  });

  it('rejects max results below the allowed minimum', () => {
    expect(() =>
      validateCreateRunInput(
        {
          apifyToken: 'secret-token',
          leadSource: 'google_maps',
          maxResults: 0,
          googleMaps: { searchTerms: ['dentist'], locationQuery: 'Austin, TX' },
        },
        false
      )
    ).toThrow(/maxResults/i);
  });

  it('returns normalized Google Maps input without exposing the token in errors', () => {
    const input = validateCreateRunInput(
      {
        apifyToken: 'secret-token',
        leadSource: 'google_maps',
        maxResults: 250,
        googleMaps: {
          searchTerms: ['dentist', 'orthodontist'],
          locationQuery: 'Austin, TX',
          minimumStars: 4,
        },
      },
      false
    );

    expect(input).toMatchObject({
      apifyToken: 'secret-token',
      leadSource: 'google_maps',
      maxResults: 250,
      googleMaps: {
        searchTerms: ['dentist', 'orthodontist'],
        locationQuery: 'Austin, TX',
        minimumStars: 4,
      },
    });
  });

  it('accepts expanded Sales Navigator filters as run criteria', () => {
    const input = validateCreateRunInput(
      {
        apifyToken: 'secret-token',
        leadSource: 'sales_navigator',
        maxResults: 100,
        salesNavigator: {
          seniorities: ['Director'],
          functions: ['Sales'],
          headcounts: ['51-200'],
        },
      },
      false
    );

    expect(input).toMatchObject({
      leadSource: 'sales_navigator',
      salesNavigator: {
        seniorities: ['Director'],
        functions: ['Sales'],
        headcounts: ['51-200'],
      },
    });
  });

  it('accepts high-volume Google Maps max results above 1000', () => {
    const input = validateCreateRunInput(
      {
        apifyToken: 'secret-token',
        leadSource: 'google_maps',
        maxResults: 5000,
        googleMaps: {
          searchTerms: ['dentist'],
          locations: ['Austin, TX', 'Phoenix, AZ'],
        },
      },
      false
    );

    expect(input).toMatchObject({
      maxResults: 5000,
      googleMaps: {
        searchTerms: ['dentist'],
        locations: ['Austin, TX', 'Phoenix, AZ'],
      },
    });
  });

  it('accepts Google Maps company types as run criteria', () => {
    const input = validateCreateRunInput(
      {
        apifyToken: 'secret-token',
        leadSource: 'google_maps',
        googleMaps: {
          companyTypes: ['Public Company'],
          locations: ['Austin, TX'],
        },
      },
      false
    );

    expect(input).toMatchObject({
      leadSource: 'google_maps',
      googleMaps: {
        companyTypes: ['Public Company'],
        locations: ['Austin, TX'],
      },
    });
  });

  it('accepts Google Places runs with a Google API key and no Apify token', () => {
    const input = validateCreateRunInput(
      {
        googleApiKey: 'google-secret-key',
        leadSource: 'google_maps',
        maxResults: 40,
        googleMaps: {
          provider: 'google_places',
          searchTerms: ['oilfield services'],
          locations: ['Houston, TX'],
        },
      },
      false
    );

    expect(input).toMatchObject({
      googleApiKey: 'google-secret-key',
      leadSource: 'google_maps',
      maxResults: 40,
      googleMaps: {
        provider: 'google_places',
        searchTerms: ['oilfield services'],
        locations: ['Houston, TX'],
      },
    });
    expect(input.apifyToken).toBeUndefined();
  });

  it('rejects Google Places runs without a Google API key', () => {
    expect(() =>
      validateCreateRunInput(
        {
          leadSource: 'google_maps',
          googleMaps: {
            provider: 'google_places',
            searchTerms: ['aviation maintenance'],
            locations: ['Dallas, TX'],
          },
        },
        false
      )
    ).toThrow(/Google API key/i);
  });

  it('rejects Google Places runs with only a Maps URL', () => {
    expect(() =>
      validateCreateRunInput(
        {
          googleApiKey: 'google-secret-key',
          leadSource: 'google_maps',
          googleMaps: {
            provider: 'google_places',
            mapsUrl: 'https://www.google.com/maps/search/oilfield+services',
          },
        },
        false
      )
    ).toThrow(/search term/i);
  });
});
