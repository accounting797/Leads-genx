import { describe, expect, it } from 'vitest';
import {
  buildActorInput,
  buildGoogleMapsInput,
  buildSalesNavigatorUrl,
} from '../../src/domain/sourceInputBuilder';
import { suggestions } from '../../src/domain/suggestions';

describe('suggestions', () => {
  it('exposes curated Google Maps suggestion groups', () => {
    expect(suggestions.googleMaps.businessCategories.length).toBeGreaterThanOrEqual(25);
    expect(suggestions.googleMaps.searchTemplates.length).toBeGreaterThanOrEqual(15);
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
      categoryFilterWords: ['Dental clinic'],
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
      ],
      categoryFilterWords: ['Dental clinic'],
      maxCrawledPlacesPerSearch: 5000,
    });
    expect(input).not.toHaveProperty('locationQuery');
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
