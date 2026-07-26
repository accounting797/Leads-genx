import { describe, expect, it } from 'vitest';
import {
  buildSearchFilter,
  mapSearchHit,
  resolveSearchFields,
  searchLinkedInPeople,
} from '../../src/domain/brightDataLinkedInSearch';
import {
  BrightDataError,
  LINKEDIN_PERSON_PROFILE_CONTACT_DATASET,
  LINKEDIN_PERSON_PROFILE_DATASET,
} from '../../src/integrations/brightDataClient';

const DATASET_FIELDS = [
  { name: 'name' },
  { name: 'position' },
  { name: 'current_company_name' },
  { name: 'industry' },
  { name: 'location' },
  { name: 'url' },
];

describe('resolveSearchFields', () => {
  it('maps SN filter groups to live dataset fields and skips what the dataset cannot answer', () => {
    const resolved = resolveSearchFields(
      { titles: ['VP Sales'], industries: ['Software'], seniorities: ['Director'], headcounts: ['51-200'] },
      DATASET_FIELDS
    );
    expect(resolved.mapping).toMatchObject({ titles: 'position', industries: 'industry' });
    expect(resolved.skipped).toEqual(['seniorities', 'headcounts']);
  });

  it('prefers the city field for city-targeted searches', () => {
    const resolved = resolveSearchFields(
      { geographies: ['Houston, TX'] },
      [{ name: 'location' }, { name: 'city' }, { name: 'country_code' }]
    );
    expect(resolved.mapping.geographies).toBe('city');
  });
});

describe('buildSearchFilter', () => {
  it('builds an AND of OR-groups at most 3 levels deep', () => {
    const filter = buildSearchFilter(
      { titles: ['CEO', 'Owner'], industries: ['Software'] },
      { mapping: { titles: 'position', industries: 'industry' }, skipped: [] }
    );
    expect(filter).toEqual({
      operator: 'and',
      filters: [
        {
          operator: 'or',
          filters: [
            { name: 'position', operator: 'includes', value: 'CEO' },
            { name: 'position', operator: 'includes', value: 'Owner' },
          ],
        },
        { name: 'industry', operator: 'includes', value: 'Software' },
      ],
    });
  });

  it('returns undefined when nothing can be filtered', () => {
    expect(buildSearchFilter({ titles: ['CEO'] }, { mapping: {}, skipped: ['titles'] })).toBeUndefined();
  });

  it('uses the exact city name when the UI supplies city and state', () => {
    expect(
      buildSearchFilter(
        { geographies: ['Houston, TX'] },
        { mapping: { geographies: 'city' }, skipped: [] }
      )
    ).toEqual({ name: 'city', operator: 'includes', value: 'Houston' });
  });
});

describe('mapSearchHit', () => {
  it('maps contact-enriched hits to person leads', () => {
    const lead = mapSearchHit({
      url: 'https://www.linkedin.com/in/jane-doe/',
      name: 'Jane Doe',
      position: 'VP Sales',
      current_company_name: 'Acme Inc',
      location: 'Austin, TX',
      email: 'Jane@Acme.com',
    });
    expect(lead).toMatchObject({
      fullName: 'Jane Doe',
      jobTitle: 'VP Sales',
      companyName: 'Acme Inc',
      profileUrl: 'https://www.linkedin.com/in/jane-doe/',
      email: 'jane@acme.com',
    });
  });

  it('drops hits without a profile URL or name', () => {
    expect(mapSearchHit({ position: 'VP' })).toBeUndefined();
  });
});

describe('searchLinkedInPeople', () => {
  it('falls back to the standard LinkedIn dataset when contact-enriched search is unavailable', async () => {
    const fieldDatasets: string[] = [];
    const searchDatasets: string[] = [];
    const events: string[] = [];

    const result = await searchLinkedInPeople({ titles: ['VP Sales'] }, 5, {
      apiKey: 'bd',
      listFields: async (_apiKey, datasetId) => {
        fieldDatasets.push(datasetId);
        if (datasetId === LINKEDIN_PERSON_PROFILE_CONTACT_DATASET) {
          throw new BrightDataError('failed', 'Bright Data request failed (HTTP 404).', 404);
        }
        return DATASET_FIELDS;
      },
      search: async ({ datasetId }) => {
        searchDatasets.push(datasetId);
        return {
          totalHits: 1,
          hits: [{ url: 'https://www.linkedin.com/in/jane/', name: 'Jane Person', position: 'VP Sales' }],
        };
      },
      onEvent: (type) => {
        events.push(type);
      },
    });

    expect(fieldDatasets).toEqual([
      LINKEDIN_PERSON_PROFILE_CONTACT_DATASET,
      LINKEDIN_PERSON_PROFILE_DATASET,
    ]);
    expect(searchDatasets).toEqual([LINKEDIN_PERSON_PROFILE_DATASET]);
    expect(result.leads).toHaveLength(1);
    expect(events).toContain('brightdata_search_dataset_fallback');
  });

  it('paginates with the search_after cursor, dedupes by profile, and narrates progress', async () => {
    const events: string[] = [];
    let calls = 0;
    const search = async (options: { searchAfter?: unknown[] }) => {
      calls += 1;
      if (!options.searchAfter) {
        return {
          totalHits: 3,
          searchAfter: ['cursor-1'],
          hits: [
            { url: 'https://www.linkedin.com/in/one/', name: 'One Person', email: 'one@acme.com' },
            { url: 'https://www.linkedin.com/in/one/', name: 'One Person' }, // duplicate
          ],
        };
      }
      return {
        totalHits: 3,
        hits: [
          { url: 'https://www.linkedin.com/in/two/', name: 'Two Person' },
          { url: 'https://www.linkedin.com/in/three/', name: 'Three Person', emails: ['three@acme.com'] },
        ],
      };
    };

    const result = await searchLinkedInPeople({ titles: ['VP Sales'] }, 10, {
      apiKey: 'bd',
      search: search as never,
      listFields: async () => DATASET_FIELDS,
      onEvent: (type) => {
        events.push(type);
      },
    });

    expect(calls).toBe(2);
    expect(result.leads.map((lead) => lead.fullName)).toEqual(['One Person', 'Two Person', 'Three Person']);
    expect(result.totalHits).toBe(3);
    expect(events.filter((type) => type === 'brightdata_search_progress')).toHaveLength(2);
  });

  it('honestly reports skipped filter groups', async () => {
    const events: string[] = [];
    await searchLinkedInPeople(
      { titles: ['CEO'], seniorities: ['Director'] },
      5,
      {
        apiKey: 'bd',
        search: async () => ({ totalHits: 1, hits: [{ url: 'https://www.linkedin.com/in/x/', name: 'X Person' }] }) as never,
        listFields: async () => DATASET_FIELDS,
        onEvent: (type) => {
          events.push(type);
        },
      }
    );
    expect(events).toContain('brightdata_search_fields_skipped');
  });

  it('refuses to search when no filter maps onto the dataset', async () => {
    await expect(
      searchLinkedInPeople(
        { seniorities: ['Director'] },
        5,
        { apiKey: 'bd', listFields: async () => DATASET_FIELDS, search: async () => ({ totalHits: 0, hits: [] }) as never }
      )
    ).rejects.toThrow(/can't filter by seniorities/);
  });
});
