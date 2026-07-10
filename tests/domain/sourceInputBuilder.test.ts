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
      searchStringsArray: ['dentist', 'orthodontist'],
      locationQuery: 'Austin, TX',
      maxCrawledPlacesPerSearch: 500,
      placeMinimumStars: '4',
      reviewsCountMin: 20,
      skipClosedPlaces: true,
      language: 'en',
    });
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

    expect(input).toMatchObject({
      searchStringsArray: [
        'dentist Austin, TX',
        'dentist Phoenix, AZ',
        'roofer Austin, TX',
        'roofer Phoenix, AZ',
        'Dental clinic Austin, TX',
        'Dental clinic Phoenix, AZ',
        'Public Company Austin, TX',
        'Public Company Phoenix, AZ',
      ],
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

    expect(input).toMatchObject({
      searchStringsArray: [
        'aviation maintenance Detroit, MI',
        'Aerospace & Defense Detroit, MI',
        'Manufacturing Detroit, MI',
        'Wholesaler Detroit, MI',
      ],
      maxCrawledPlacesPerSearch: 50000,
    });
    expect(input).not.toHaveProperty('categoryFilterWords');
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

  it('maps the expanded Sales Navigator filters into a generated query URL', () => {
    const result = buildActorInput({
      apifyToken: 'token',
      leadSource: 'sales_navigator',
      maxResults: 100,
      salesNavigator: {
        keywords: 'SaaS',
        titles: ['VP Sales'],
        industries: ['Software Development'],
        geographies: ['United States'],
        companies: ['Enterprise'],
        seniorities: ['Director'],
        functions: ['Sales'],
        headcounts: ['51-200'],
      },
    });

    expect(result.input).toMatchObject({ searchUrl: expect.any(String), maxResults: 100 });
  });
});

describe('buildActorInputsForApifyTokens', () => {
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
