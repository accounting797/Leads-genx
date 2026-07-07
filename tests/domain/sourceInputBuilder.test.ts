import { describe, expect, it } from 'vitest';
import {
  buildActorInput,
  buildGoogleMapsInput,
  buildSalesNavigatorUrl,
} from '../../src/domain/sourceInputBuilder';

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
});
