import { describe, expect, it } from 'vitest';
import { pickNextCombo, SHUFFLE_COMBOS } from '../../src/domain/shuffleCombos';
import { suggestions } from '../../src/domain/suggestions';

describe('shuffle combo library', () => {
  it('uses canonical source-specific values', () => {
    const mapsTerms = new Set(suggestions.googleMaps.searchTemplates);
    const mapsCategories = new Set(suggestions.googleMaps.businessCategories);
    const mapsTypes = new Set(suggestions.googleMaps.companyTypes);
    const snTitles = new Set(suggestions.salesNavigator.titles);
    const snIndustries = new Set(suggestions.salesNavigator.industries);
    const snHeadcounts = new Set(suggestions.salesNavigator.headcounts);

    for (const combo of SHUFFLE_COMBOS) {
      expect(mapsTerms.has(combo.googleMaps.searchTerm), combo.id).toBe(true);
      expect(mapsCategories.has(combo.googleMaps.category), combo.id).toBe(true);
      expect(mapsTypes.has(combo.googleMaps.companyType), combo.id).toBe(true);
      expect(snTitles.has(combo.salesNavigator.title), combo.id).toBe(true);
      expect(snIndustries.has(combo.salesNavigator.industry), combo.id).toBe(true);
      expect(snHeadcounts.has(combo.salesNavigator.headcount), combo.id).toBe(true);
    }
  });

  it('keeps stable unique IDs and enough cities for a useful rotation', () => {
    expect(new Set(SHUFFLE_COMBOS.map((combo) => combo.id)).size).toBe(SHUFFLE_COMBOS.length);
    expect(new Set(SHUFFLE_COMBOS.map((combo) => combo.city)).size).toBeGreaterThan(10);
  });

  it('retains the curated Shuffle deck IDs exactly', () => {
    expect(SHUFFLE_COMBOS.map((combo) => combo.id)).toEqual([
      'owner-roofing-houston', 'owner-hvac-phoenix', 'ceo-construction-dallas', 'owner-dental-tampa',
      'manager-vet-denver', 'owner-trucking-atlanta', 'gm-autorepair-nashville', 'owner-landscaping-charlotte',
      'ceo-manufacturing-columbus', 'owner-realestate-sacramento', 'sales-oilgas-houston', 'purchasing-manufacturing-columbus',
      'owner-restaurants-austin', 'office-legal-raleigh', 'owner-plumbing-jacksonville', 'ceo-renewable-denver',
      'ops-warehousing-slc', 'owner-accounting-okc', 'marketing-medspa-tampa', 'owner-electrical-dallas',
      'hr-staffing-chicago', 'ceo-solar-phoenix', 'owner-insurance-nashville', 'finance-healthcare-atlanta',
    ]);
  });
});

describe('pickNextCombo', () => {
  it('does not repeat a combo or city during an active deck', () => {
    const first = SHUFFLE_COMBOS[0];
    const pick = pickNextCombo(
      {
        source: 'google_maps',
        recentComboIds: [first.id],
        recentCities: [first.city],
        currentComboId: first.id,
      },
      {},
      () => 0,
    );
    expect(pick.combo.id).not.toBe(first.id);
    expect(pick.combo.city).not.toBe(first.city);
  });

  it('visits every eligible city before resetting the city deck', () => {
    const cities = [...new Set(SHUFFLE_COMBOS.map((combo) => combo.city))];
    const current = SHUFFLE_COMBOS.find((combo) => combo.city === cities[0])!;
    const pick = pickNextCombo(
      {
        source: 'sales_navigator',
        recentComboIds: [current.id],
        recentCities: cities.slice(0, -1),
        currentComboId: current.id,
      },
      {},
      () => 0,
    );
    expect(pick.combo.city).toBe(cities.at(-1));
  });

  it('resets an exhausted deck without immediately repeating', () => {
    const current = SHUFFLE_COMBOS[0];
    const pick = pickNextCombo(
      {
        source: 'google_maps',
        recentComboIds: SHUFFLE_COMBOS.map((combo) => combo.id),
        recentCities: [...new Set(SHUFFLE_COMBOS.map((combo) => combo.city))],
        currentComboId: current.id,
      },
      {},
      () => 0,
    );
    expect(pick.combo.id).not.toBe(current.id);
    expect(pick.combo.city).not.toBe(current.city);
    expect(pick.updatedHistory.comboIds).toEqual([pick.combo.id]);
  });

  it('returns exactly the active source filters', () => {
    const maps = pickNextCombo({ source: 'google_maps' }, {}, () => 0);
    expect(maps.filters).toEqual({
      searchTerms: [maps.combo.googleMaps.searchTerm],
      categoryFilters: [maps.combo.googleMaps.category],
      companyTypes: [maps.combo.googleMaps.companyType],
      locations: [maps.combo.city],
    });

    const sales = pickNextCombo({ source: 'sales_navigator' }, {}, () => 0);
    expect(sales.filters).toEqual({
      titles: [sales.combo.salesNavigator.title],
      industries: [sales.combo.salesNavigator.industry],
      geographies: [sales.combo.city],
      headcounts: [sales.combo.salesNavigator.headcount],
    });
  });

  it('uses learned weights only after every combo has run', () => {
    const stats = Object.fromEntries(
      SHUFFLE_COMBOS.map((combo) => [combo.id, { runs: 1, leads: combo.id === SHUFFLE_COMBOS[7].id ? 90 : 0 }]),
    );
    const pick = pickNextCombo({ source: 'google_maps' }, stats, () => 0.5);
    expect(pick.freshTerritory).toBe(false);
    expect(pick.note.toLowerCase()).toContain('learned');
    expect(pick.combo.id).toBe(SHUFFLE_COMBOS[7].id);
  });

  it('ignores mixed recent history values and returns a current combo', () => {
    const pick = pickNextCombo(
      {
        source: 'google_maps',
        recentComboIds: ['removed-combo', 42, null, { id: SHUFFLE_COMBOS[0].id }] as never,
        recentCities: ['Unknown', 42, null, { city: SHUFFLE_COMBOS[0].city }] as never,
        currentComboId: '__proto__',
      },
      {},
      () => 0,
    );

    expect(SHUFFLE_COMBOS).toContainEqual(pick.combo);
  });
});
