import { describe, expect, it } from 'vitest';
import { businessIdentity, mergeBusinesses } from '../../src/domain/businessIdentity';
import { NormalizedLead } from '../../src/domain/types';

const base: NormalizedLead = {
  leadSource: 'google_maps',
  leadType: 'business',
  companyName: 'Austin Dental Co',
  address: '100 Main St, Austin, TX',
};

describe('business identity', () => {
  it('prefers a Google place id and otherwise uses normalized stable fields', () => {
    expect(businessIdentity({ ...base, rawJson: JSON.stringify({ id: 'places/abc123' }) })).toBe('place:places/abc123');
    expect(businessIdentity({ ...base, phone: '(512) 555-0100' })).toBe('phone:5125550100');
    expect(businessIdentity(base)).toBe('name_address:austin dental co|100 main st austin tx');
  });

  it('fills missing values and unions emails and provenance without erasing data', () => {
    const merged = mergeBusinesses(
      { ...base, website: 'https://example.com', email: 'one@example.com', emails: ['one@example.com'], provenance: ['local'] },
      { ...base, website: '', phone: '512-555-0100', email: 'two@example.com', emails: ['two@example.com'], provenance: ['google'] }
    );

    expect(merged.website).toBe('https://example.com');
    expect(merged.phone).toBe('512-555-0100');
    expect(merged.emails).toEqual(['one@example.com', 'two@example.com']);
    expect(merged.provenance).toEqual(['local', 'google']);
  });
});
