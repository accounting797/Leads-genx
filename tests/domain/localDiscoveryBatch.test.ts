import { describe, expect, it } from 'vitest';
import { buildLocalDiscoveryBatches } from '../../src/domain/localDiscoveryBatch';

describe('buildLocalDiscoveryBatches', () => {
  it('produces stable deduplicated keys and location-specific coordinates', () => {
    const filters = {
      searchTerms: ['dentist', 'dentist'],
      locations: ['Austin, TX', 'Dallas, TX'],
    };

    const first = buildLocalDiscoveryBatches(filters, 250);
    const second = buildLocalDiscoveryBatches(filters, 250);

    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(new Set(first.map((batch) => batch.key)).size).toBe(first.length);
    expect(first).toContainEqual(expect.objectContaining({
      query: 'dentist Austin, TX',
      location: 'Austin, TX',
      lat: '30.2672',
      lon: '-97.7431',
      maxResults: 250,
    }));
  });

  it('keeps unsupported locations deterministic so fallback can account for them', () => {
    const [batch] = buildLocalDiscoveryBatches({ searchTerms: ['plumber'], locations: ['Reno, NV'] }, 100);
    expect(batch).toMatchObject({ query: 'plumber Reno, NV', location: 'Reno, NV' });
    expect(batch.lat).toBeUndefined();
    expect(batch.lon).toBeUndefined();
  });
});
