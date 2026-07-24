import { describe, expect, it } from 'vitest';
import { suggestions } from '../../src/domain/suggestions';
import { buildQueryPlan } from '../../src/domain/queryPlan';
import { buildLocalDiscoveryBatches } from '../../src/domain/localDiscoveryBatch';

function expectCleanList(list: string[], name: string) {
  expect(list.length, `${name} must not be empty`).toBeGreaterThan(0);
  const seen = new Set<string>();
  for (const entry of list) {
    expect(entry.trim(), `${name} entries must be pre-trimmed`).toBe(entry);
    expect(entry.length, `${name} entries must be non-empty`).toBeGreaterThan(0);
    const key = entry.toLowerCase();
    expect(seen.has(key), `${name} must not contain duplicate "${entry}"`).toBe(false);
    seen.add(key);
  }
}

describe('curated suggestions', () => {
  it('offers top-30 Google Maps lists with no duplicates or empty entries', () => {
    const { businessCategories, searchTemplates, companyTypes, locations } = suggestions.googleMaps;

    expect(searchTemplates).toHaveLength(30);
    expect(businessCategories).toHaveLength(30);
    expect(companyTypes).toHaveLength(30);
    expectCleanList(searchTemplates, 'searchTemplates');
    expectCleanList(businessCategories, 'businessCategories');
    expectCleanList(companyTypes, 'companyTypes');
    expectCleanList(locations, 'locations');
  });

  it('keeps company types Maps-query-safe (no registry names or parentheses)', () => {
    for (const companyType of suggestions.googleMaps.companyTypes) {
      expect(companyType).not.toMatch(/[()\/]/);
      expect(companyType.split(' ').length).toBeLessThanOrEqual(2);
    }
  });

  it('avoids company types that exactly collide with recovery query modifiers', () => {
    const recoveryModifiers = ['supplier', 'distributor', 'retailer', 'service'];
    for (const companyType of suggestions.googleMaps.companyTypes) {
      expect(recoveryModifiers).not.toContain(companyType.toLowerCase());
    }
  });

  it('produces conflict-free query plans and batch keys for combined suggestions', () => {
    const filters = {
      searchTerms: suggestions.googleMaps.searchTemplates.slice(0, 5),
      categoryFilters: suggestions.googleMaps.businessCategories.slice(0, 5),
      companyTypes: suggestions.googleMaps.companyTypes.slice(0, 5),
      locations: suggestions.googleMaps.locations.slice(0, 3),
    };

    const plan = buildQueryPlan(filters);
    const texts = plan.map((query) => query.text.toLowerCase());
    expect(new Set(texts).size).toBe(texts.length);

    const batches = buildLocalDiscoveryBatches(filters, 100);
    const keys = batches.map((batch) => batch.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(batches.length).toBeGreaterThan(0);
  });

  it('keeps Sales Navigator lists free of duplicates', () => {
    const sn = suggestions.salesNavigator;
    expectCleanList(sn.titles, 'titles');
    expectCleanList(sn.industries, 'industries');
    expectCleanList(sn.seniorities, 'seniorities');
    expectCleanList(sn.functions, 'functions');
    expectCleanList(sn.geographies, 'geographies');
    expectCleanList(sn.companies, 'companies');
    expectCleanList(sn.headcounts, 'headcounts');
    expect(sn.headcounts).toHaveLength(8);
  });
});
