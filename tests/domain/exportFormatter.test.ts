import { describe, expect, it } from 'vitest';
import { formatEmailsTxt, formatLeadsTxt } from '../../src/domain/exportFormatter';

describe('formatLeadsTxt', () => {
  it('formats business and person leads with stable empty fields', () => {
    const txt = formatLeadsTxt([
      {
        leadType: 'business',
        companyName: 'Austin Dental Co',
        categoryName: 'Dental clinic',
        address: '1 Main St, Austin, TX',
        website: 'https://example.com',
        phone: '(512) 555-0100',
        rating: 4.7,
        reviewsCount: 88,
        placeUrl: 'https://maps.google.com/?cid=1',
      },
      {
        leadType: 'person',
        fullName: 'Jane Doe',
        jobTitle: 'VP Sales',
        companyName: 'Example Inc',
        email: '',
        profileUrl: 'https://linkedin.com/in/janedoe',
        location: 'Austin, TX',
      },
    ]);

    expect(txt).toBe(
      [
        'Type | Name | Title/Category | Company | Email | Phone | Website/Profile | Location/Address | Rating | Reviews',
        'business | Austin Dental Co | Dental clinic | Austin Dental Co |  | (512) 555-0100 | https://example.com | 1 Main St, Austin, TX | 4.7 | 88',
        'person | Jane Doe | VP Sales | Example Inc |  |  | https://linkedin.com/in/janedoe | Austin, TX |  | ',
      ].join('\n')
    );
  });
});

describe('formatEmailsTxt', () => {
  it('exports one normalized unique email address per line', () => {
    const txt = formatEmailsTxt([
      { email: 'jane@example.com', fullName: 'Jane Doe' },
      { email: 'JANE@example.com', fullName: 'Duplicate Jane' },
      { email: '', fullName: 'No Email' },
      { companyName: 'No Email Co' },
      { email: 'ops@example.com', companyName: 'Ops Co' },
    ]);

    expect(txt).toBe(['jane@example.com', 'ops@example.com'].join('\n'));
  });
});
