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
});
