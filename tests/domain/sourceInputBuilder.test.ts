import { describe, expect, it } from 'vitest';
import {
  buildActorInput,
  buildActorInputsForApifyTokens,
  buildGoogleMapsInput,
  buildSalesNavigatorUrl,
} from '../../src/domain/sourceInputBuilder';
import { suggestions } from '../../src/domain/suggestions';

describe('suggestions', () => {
  it('exposes curated Google Maps suggestion groups', () => {
    expect(suggestions.googleMaps.searchTemplates).toHaveLength(20);
    expect(suggestions.googleMaps.businessCategories).toHaveLength(20);
    expect(suggestions.googleMaps.companyTypes).toHaveLength(20);
    expect(suggestions.googleMaps.searchTemplates).toEqual(
      expect.arrayContaining(['oilfield services', 'aviation maintenance', 'data center contractor'])
    );
    expect(suggestions.googleMaps.businessCategories).toEqual(
      expect.arrayContaining(['Oil & Gas', 'Mining', 'Aviation'])
    );
    expect(suggestions.googleMaps.companyTypes).toEqual(
      expect.arrayContaining(['Public Company', 'Partnership', 'Insurance Carrier'])
    );
    expect(suggestions.googleMaps.companyTypes).not.toEqual(
      expect.arrayContaining(['Private Practice', 'Medical Group', 'Dental Group'])
    );
    expect(suggestions.googleMaps.locations.length).toBeGreaterThanOrEqual(20);
  });

  it('exposes curated Sales Navigator suggestion groups', () => {
    expect(suggestions.salesNavigator.titles.length).toBeGreaterThanOrEqual(10);
    expect(suggestions.salesNavigator.industries.length).toBeGreaterThanOrEqual(10);
    expect(suggestions.salesNavigator.seniorities.length).toBeGreaterThanOrEqual(5);
    expect(suggestions.salesNavigator.functions.length).toBeGreaterThanOrEqual(5);
    expect(suggestions.salesNavigator.geographies.length).toBeGreaterThanOrEqual(10);
    expect(suggestions.salesNavigator.companies.length).toBeGreaterThanOrEqual(10);
    expect(suggestions.salesNavigator.headcounts.length).toBeGreaterThanOrEqual(10);
  });
});

describe('buildSalesNavigatorUrl', () => {
  it('builds a sales navigator URL from multi-value filters', () => {
    const url = buildSalesNavigatorUrl({
      keywords: 'SaaS',
      titles: ['VP Sales', 'Head of Growth'],
      industries: ['Software Development'],
      geographies: ['United States'],
    });

    const decoded = decodeURIComponent(url);
    expect(url).toContain('https://www.linkedin.com/sales/search/people');
    expect(decoded).toContain('keywords:SaaS');
    expect(decoded).toContain('title:VP Sales');
    expect(decoded).toContain('title:Head of Growth');
    expect(decoded).toContain('industry:Software Development');
    expect(decoded).toContain('geoUrn:United States');
  });
});

describe('buildGoogleMapsInput', () => {
  it('builds high-volume business search input for Google Maps', () => {
    const input = buildGoogleMapsInput({
      searchTerms: ['dentist', 'orthodontist'],
      categoryFilters: ['Dental clinic'],
      locationQuery: 'Austin, TX',
      maxPlaces: 500,
      minimumStars: 4,
      minimumReviews: 20,
      skipClosedPlaces: true,
    });

    expect(input).toMatchObject({
      searchStringsArray: [
        'dentist',
        'orthodontist',
        'Dental clinic',
        'dentist Dental clinic',
        'orthodontist Dental clinic',
      ],
      locationQuery: 'Austin, TX',
      maxCrawledPlacesPerSearch: 500,
      placeMinimumStars: 'four',
      reviewsCountMin: 20,
      skipClosedPlaces: true,
      language: 'en',
    });
  });

  it('maps numeric minimum ratings to the Apify Google Maps actor enum', () => {
    expect(buildGoogleMapsInput({ minimumStars: 2 }).placeMinimumStars).toBe('two');
    expect(buildGoogleMapsInput({ minimumStars: 2.5 }).placeMinimumStars).toBe('twoAndHalf');
    expect(buildGoogleMapsInput({ minimumStars: 3 }).placeMinimumStars).toBe('three');
    expect(buildGoogleMapsInput({ minimumStars: 3.5 }).placeMinimumStars).toBe('threeAndHalf');
    expect(buildGoogleMapsInput({ minimumStars: 4 }).placeMinimumStars).toBe('four');
    expect(buildGoogleMapsInput({ minimumStars: 4.5 }).placeMinimumStars).toBe('fourAndHalf');
  });

  it('generates Google Maps search strings from terms, categories, and locations', () => {
    const input = buildGoogleMapsInput({
      searchTerms: ['dentist', 'roofer'],
      categoryFilters: ['Dental clinic'],
      companyTypes: ['Public Company'],
      locations: ['Austin, TX', 'Phoenix, AZ'],
      maxPlaces: 5000,
      skipClosedPlaces: true,
    });

    expect(input.searchStringsArray).toEqual(
      expect.arrayContaining([
        'dentist Austin, TX',
        'dentist Phoenix, AZ',
        'roofer Austin, TX',
        'roofer Phoenix, AZ',
        'Dental clinic Austin, TX',
        'Dental clinic Phoenix, AZ',
        'Public Company Austin, TX',
        'Public Company Phoenix, AZ',
        'dentist Dental clinic Austin, TX',
        'Dental clinic Public Company Phoenix, AZ',
      ])
    );
    expect(input).toMatchObject({
      maxCrawledPlacesPerSearch: 5000,
    });
    expect(input).not.toHaveProperty('categoryFilterWords');
    expect(input).not.toHaveProperty('locationQuery');
  });

  it('uses broad industry categories as search strings instead of strict Apify category filters', () => {
    const input = buildGoogleMapsInput({
      searchTerms: ['aviation maintenance'],
      categoryFilters: ['Aerospace & Defense', 'Manufacturing'],
      companyTypes: ['Wholesaler'],
      locations: ['Detroit, MI'],
      maxPlaces: 50000,
      skipClosedPlaces: true,
    });

    expect(input.searchStringsArray).toEqual(
      expect.arrayContaining([
        'aviation maintenance Detroit, MI',
        'Aerospace & Defense Detroit, MI',
        'Manufacturing Detroit, MI',
        'Wholesaler Detroit, MI',
        'aviation maintenance Aerospace & Defense Detroit, MI',
        'Manufacturing Wholesaler Detroit, MI',
      ])
    );
    expect(input).toMatchObject({
      maxCrawledPlacesPerSearch: 50000,
    });
    expect(input).not.toHaveProperty('categoryFilterWords');
  });

  it('multiplies Google Maps terms, categories, company types, and locations for max-output searches', () => {
    const input = buildGoogleMapsInput({
      searchTerms: ['oilfield services'],
      categoryFilters: ['Oil & Gas'],
      companyTypes: ['Wholesaler'],
      locations: ['Houston, TX', 'Tulsa, OK'],
      maxPlaces: 5000,
      skipClosedPlaces: true,
    });

    expect(input.searchStringsArray).toEqual(
      expect.arrayContaining([
        'oilfield services Houston, TX',
        'Oil & Gas Wholesaler Houston, TX',
        'oilfield services Oil & Gas Houston, TX',
        'oilfield services Wholesaler Tulsa, OK',
      ])
    );
    expect(input.searchStringsArray).toHaveLength(12);
  });
});

describe('buildActorInput', () => {
  it('uses the Google Maps actor by default for google_maps runs', () => {
    const actorInput = buildActorInput({
      apifyToken: 'token',
      leadSource: 'google_maps',
      actorId: undefined,
      maxResults: 100,
      googleMaps: {
        searchTerms: ['roofer'],
        locationQuery: 'Phoenix, AZ',
        maxPlaces: 100,
        skipClosedPlaces: true,
      },
    });

    expect(actorInput.actorId).toBe('compass/google-maps-extractor');
    expect(actorInput.leadSource).toBe('google_maps');
    expect(actorInput.input).toMatchObject({
      searchStringsArray: ['roofer'],
      locationQuery: 'Phoenix, AZ',
    });
  });

  it('maps Sales Navigator filters into the HarvestAPI email-search contract', () => {
    const cookies = '[{"name":"li_at","value":"session-value"}]';
    const result = buildActorInput({
      apifyToken: 'token',
      leadSource: 'sales_navigator',
      maxResults: 2500,
      salesNavigator: {
        keywords: 'SaaS',
        titles: ['VP Sales'],
        industries: ['Software Development'],
        geographies: ['United States'],
        companies: ['Enterprise'],
        seniorities: ['Director'],
        functions: ['Sales'],
        headcounts: ['51-200'],
        cookies,
        userAgent: 'Mozilla/5.0 test-agent',
      },
    });

    expect(result.actorId).toBe('harvestapi/linkedin-sales-navigator-lead-search-cookie');
    expect(result.input).toEqual({
      profileScraperMode: 'Full + email search',
      cookie: cookies,
      userAgent: 'Mozilla/5.0 test-agent',
      startPage: 1,
      takePages: 100,
      searchQuery: 'SaaS Software Development Enterprise Director Sales 51-200',
      currentJobTitles: ['VP Sales'],
      locations: ['United States'],
    });
  });

  it('uses a supplied Sales Navigator URL instead of structured search fields', () => {
    const result = buildActorInput({
      apifyToken: 'token',
      leadSource: 'sales_navigator',
      searchUrl: 'https://www.linkedin.com/sales/search/people?query=test',
      maxResults: 26,
      salesNavigator: {
        keywords: 'ignored when URL is present',
        titles: ['VP Sales'],
        cookies: '[{"name":"li_at","value":"session-value"}]',
        userAgent: 'Mozilla/5.0 test-agent',
      },
    });

    expect(result.input).toEqual({
      profileScraperMode: 'Full + email search',
      cookie: '[{"name":"li_at","value":"session-value"}]',
      userAgent: 'Mozilla/5.0 test-agent',
      startPage: 1,
      takePages: 2,
      salesNavUrl: 'https://www.linkedin.com/sales/search/people?query=test',
    });
  });
});

describe('buildActorInputsForApifyTokens', () => {
  it('keeps every Apify token active even when there is only one search shard', () => {
    const inputs = buildActorInputsForApifyTokens({
      apifyToken: 'token-a',
      apifyTokens: ['token-a', 'token-b', 'token-c'],
      leadSource: 'google_maps',
      maxResults: 1000,
      googleMaps: {
        searchTerms: ['oilfield services'],
        locations: ['Houston, TX'],
        maxPlaces: 1000,
      },
    });

    expect(inputs).toHaveLength(3);
    expect(inputs.map((input) => input.token)).toEqual(['token-a', 'token-b', 'token-c']);
    expect(inputs.every((input) => Array.isArray(input.input.searchStringsArray))).toBe(true);
  });

  it('splits Google Maps search strings across Apify tokens', () => {
    const inputs = buildActorInputsForApifyTokens({
      apifyToken: 'token-a',
      apifyTokens: ['token-a', 'token-b'],
      leadSource: 'google_maps',
      maxResults: 1000,
      googleMaps: {
        searchTerms: ['oilfield services', 'aviation maintenance'],
        locations: ['Houston, TX', 'Tulsa, OK'],
        maxPlaces: 1000,
      },
    });

    expect(inputs).toHaveLength(2);
    expect(inputs.map((input) => input.token)).toEqual(['token-a', 'token-b']);
    expect(inputs[0].input).toMatchObject({
      searchStringsArray: ['oilfield services Houston, TX', 'aviation maintenance Houston, TX'],
    });
    expect(inputs[1].input).toMatchObject({
      searchStringsArray: ['oilfield services Tulsa, OK', 'aviation maintenance Tulsa, OK'],
    });
  });
});
