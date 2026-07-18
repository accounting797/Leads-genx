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
          cookies: '[{"name":"li_at","value":"dummy"}]',
          userAgent: 'Mozilla/5.0 test-agent',
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
        cookies: '[{"name":"li_at","value":"dummy"}]',
        userAgent: 'Mozilla/5.0 test-agent',
      },
    });
  });

  it('rejects Sales Navigator runs with malformed cookie JSON', () => {
    expect(() =>
      validateCreateRunInput(
        {
          apifyToken: 'secret-token',
          leadSource: 'sales_navigator',
          searchUrl: 'https://www.linkedin.com/sales/search/people?query=test',
          salesNavigator: {
            cookies: '{not-json}',
            userAgent: 'Mozilla/5.0 test-agent',
          },
        },
        false
      )
    ).toThrow(/cookie JSON/i);
  });

  it('rejects Sales Navigator runs without a browser user agent', () => {
    expect(() =>
      validateCreateRunInput(
        {
          apifyToken: 'secret-token',
          leadSource: 'sales_navigator',
          searchUrl: 'https://www.linkedin.com/sales/search/people?query=test',
          salesNavigator: {
            cookies: '[{"name":"li_at","value":"dummy"}]',
          },
        },
        false
      )
    ).toThrow(/user agent/i);
  });

  it('rejects non-Sales-Navigator URLs for Sales Navigator runs', () => {
    expect(() =>
      validateCreateRunInput(
        {
          apifyToken: 'secret-token',
          leadSource: 'sales_navigator',
          searchUrl: 'https://example.com/search',
          salesNavigator: {
            cookies: '[{"name":"li_at","value":"dummy"}]',
            userAgent: 'Mozilla/5.0 test-agent',
          },
        },
        false
      )
    ).toThrow(/Sales Navigator people-search URL/i);
  });

  it('rejects Sales Navigator result requests above 2500 profiles', () => {
    expect(() =>
      validateCreateRunInput(
        {
          apifyToken: 'secret-token',
          leadSource: 'sales_navigator',
          maxResults: 2501,
          searchUrl: 'https://www.linkedin.com/sales/search/people?query=test',
          salesNavigator: {
            cookies: '[{"name":"li_at","value":"dummy"}]',
            userAgent: 'Mozilla/5.0 test-agent',
          },
        },
        false
      )
    ).toThrow(/2500/i);
  });

  it('parses comma-separated Apify tokens and Google API keys', () => {
    const input = validateCreateRunInput(
      {
        apifyToken: 'apify-one, apify-two ,, apify-three',
        googleApiKey: 'google-one, google-two',
        leadSource: 'google_maps',
        maxResults: 1000,
        googleMaps: {
          provider: 'hybrid',
          searchTerms: ['oilfield services'],
          locations: ['Houston, TX'],
        },
      },
      false
    );

    expect(input.apifyTokens).toEqual(['apify-one', 'apify-two', 'apify-three']);
    expect(input.googleApiKeys).toEqual(['google-one', 'google-two']);
    expect(input.apifyToken).toBe('apify-one');
    expect(input.googleApiKey).toBe('google-one');
  });

  it('parses newline-separated Apify tokens and Google API keys', () => {
    const input = validateCreateRunInput(
      {
        apifyToken: 'apify-one\napify-two\napify-three',
        googleApiKey: 'google-one\ngoogle-two',
        leadSource: 'google_maps',
        maxResults: 1000,
        googleMaps: {
          provider: 'hybrid',
          searchTerms: ['logistics company'],
          locations: ['Washington, DC'],
        },
      },
      false
    );

    expect(input.apifyTokens).toEqual(['apify-one', 'apify-two', 'apify-three']);
    expect(input.googleApiKeys).toEqual(['google-one', 'google-two']);
  });

  it('requires both provider credentials for Hybrid Max Output runs', () => {
    expect(() =>
      validateCreateRunInput(
        {
          leadSource: 'google_maps',
          googleMaps: {
            provider: 'hybrid',
            searchTerms: ['mining contractor'],
            locations: ['Reno, NV'],
          },
        },
        false
      )
    ).toThrow(/Apify token/i);

    expect(() => validateCreateRunInput({
      apifyToken: 'apify-one',
      leadSource: 'google_maps',
      googleMaps: { provider: 'hybrid', searchTerms: ['mining contractor'], locations: ['Reno, NV'] },
    }, false)).toThrow(/Google API key/i);

    expect(() => validateCreateRunInput({
      googleApiKey: 'google-one',
      leadSource: 'google_maps',
      googleMaps: { provider: 'hybrid', searchTerms: ['mining contractor'], locations: ['Reno, NV'] },
    }, false)).toThrow(/Apify token/i);
  });

  it('defaults Hybrid Max Output to a bounded Google fallback budget', () => {
    const input = validateCreateRunInput({
      apifyToken: 'apify-one',
      googleApiKey: 'google-one',
      leadSource: 'google_maps',
      googleMaps: { provider: 'hybrid', searchTerms: ['dentist'], locations: ['Austin, TX'] },
    }, false);

    expect(input.googleMaps?.apiRequestBudget).toBe(25);
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

  it('accepts a secure local-first run with bounded Google fallback and proxies', () => {
    const input = validateCreateRunInput(
      {
        googleApiKey: 'google-secret',
        proxyUrls: 'socks5h://user:password@127.0.0.1:60001',
        leadSource: 'google_maps',
        maxResults: 10000,
        googleMaps: {
          provider: 'local_first',
          searchTerms: ['dentist'],
          locations: ['Austin, TX'],
          apiRequestBudget: 25,
        },
      },
      false
    );

    expect(input.routeMode).toBe('proxy');
    expect(input.proxyUrls).toEqual(['socks5h://user:password@127.0.0.1:60001']);
    expect(input.googleMaps?.apiRequestBudget).toBe(25);
  });

  it('rejects local-first budgets above 500 and targets above 10000', () => {
    expect(() => validateCreateRunInput({
      leadSource: 'google_maps',
      maxResults: 10001,
      googleMaps: { provider: 'local_first', searchTerms: ['dentist'], apiRequestBudget: 501 },
    }, false)).toThrow();
  });
});
