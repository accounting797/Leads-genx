import { describe, expect, it } from 'vitest';
import { normalizeLead } from '../../src/domain/leadNormalizer';

describe('normalizeLead', () => {
  it('normalizes Google Maps business leads', () => {
    const lead = normalizeLead(
      {
        title: 'Austin Dental Co',
        categoryName: 'Dental clinic',
        address: '1 Main St, Austin, TX',
        website: 'https://example.com',
        phone: '(512) 555-0100',
        totalScore: 4.7,
        reviewsCount: 88,
        url: 'https://maps.google.com/?cid=1',
      },
      'google_maps'
    );

    expect(lead).toMatchObject({
      leadSource: 'google_maps',
      leadType: 'business',
      companyName: 'Austin Dental Co',
      categoryName: 'Dental clinic',
      address: '1 Main St, Austin, TX',
      website: 'https://example.com',
      phone: '(512) 555-0100',
      rating: 4.7,
      reviewsCount: 88,
      placeUrl: 'https://maps.google.com/?cid=1',
    });
  });

  it('normalizes Sales Navigator person leads', () => {
    const lead = normalizeLead(
      {
        fullName: 'Jane Doe',
        jobTitle: 'VP Sales',
        companyName: 'Example Inc',
        email: 'jane@example.com',
        linkedinUrl: 'https://linkedin.com/in/janedoe',
        location: 'Austin, TX',
      },
      'sales_navigator'
    );

    expect(lead).toMatchObject({
      leadSource: 'sales_navigator',
      leadType: 'person',
      fullName: 'Jane Doe',
      jobTitle: 'VP Sales',
      companyName: 'Example Inc',
      email: 'jane@example.com',
      profileUrl: 'https://linkedin.com/in/janedoe',
      location: 'Austin, TX',
    });
  });

  it('normalizes Google Places business leads', () => {
    const lead = normalizeLead(
      {
        displayName: { text: 'Gulf Coast Oilfield Services' },
        primaryTypeDisplayName: { text: 'Oil & Gas' },
        formattedAddress: '500 Energy Way, Houston, TX',
        websiteUri: 'https://oilfield.example.com',
        internationalPhoneNumber: '+1 713-555-0100',
        rating: 4.6,
        userRatingCount: 128,
        googleMapsUri: 'https://maps.google.com/?cid=google-places',
      },
      'google_maps'
    );

    expect(lead).toMatchObject({
      leadSource: 'google_maps',
      leadType: 'business',
      companyName: 'Gulf Coast Oilfield Services',
      categoryName: 'Oil & Gas',
      address: '500 Energy Way, Houston, TX',
      website: 'https://oilfield.example.com',
      phone: '+1 713-555-0100',
      rating: 4.6,
      reviewsCount: 128,
      placeUrl: 'https://maps.google.com/?cid=google-places',
    });
  });
});
