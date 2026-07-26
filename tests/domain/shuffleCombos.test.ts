import { describe, expect, it } from 'vitest';
import { pickNextCombo, SHUFFLE_COMBOS } from '../../src/domain/shuffleCombos';
import { suggestions } from '../../src/domain/suggestions';

describe('shuffle combo library', () => {
  it('every combo value comes from the real suggestion lists', () => {
    const terms = new Set(suggestions.googleMaps.searchTemplates);
    const categories = new Set(suggestions.googleMaps.businessCategories);
    const companyTypes = new Set(suggestions.googleMaps.companyTypes);
    const headcounts = new Set(suggestions.salesNavigator.headcounts);
    for (const combo of SHUFFLE_COMBOS) {
      expect(terms.has(combo.searchTerm), `term ${combo.searchTerm}`).toBe(true);
      expect(categories.has(combo.category), `category ${combo.category}`).toBe(true);
      expect(companyTypes.has(combo.companyType), `type ${combo.companyType}`).toBe(true);
      expect(headcounts.has(combo.headcount), `headcount ${combo.headcount}`).toBe(true);
    }
  });

  it('uses exactly ONE option per filter — the precision contract', () => {
    for (const combo of SHUFFLE_COMBOS) {
      expect(combo.searchTerm).toBeTruthy();
      expect(combo.category).toBeTruthy();
      expect(combo.location).toBeTruthy();
      expect(combo.id).toMatch(/^[a-z0-9-]+$/);
      expect(combo.rationale.length).toBeGreaterThan(20);
    }
    expect(new Set(SHUFFLE_COMBOS.map((combo) => combo.id)).size).toBe(SHUFFLE_COMBOS.length);
  });
});

describe('pickNextCombo', () => {
  it('serves unseen combos first, in library order', () => {
    const first = pickNextCombo({});
    expect(first.combo.id).toBe(SHUFFLE_COMBOS[0].id);
    expect(first.freshTerritory).toBe(true);

    const second = pickNextCombo({ [SHUFFLE_COMBOS[0].id]: { runs: 1, leads: 10 } });
    expect(second.combo.id).toBe(SHUFFLE_COMBOS[1].id);
    expect(second.combosTried).toBe(1);
  });

  it('learns: after a full rotation it runs back the best performer', () => {
    const stats: Record<string, { runs: number; leads: number }> = {};
    for (const combo of SHUFFLE_COMBOS) stats[combo.id] = { runs: 1, leads: 5 };
    stats[SHUFFLE_COMBOS[7].id] = { runs: 2, leads: 90 }; // 45/run — the winner

    const pick = pickNextCombo(stats);
    expect(pick.combo.id).toBe(SHUFFLE_COMBOS[7].id);
    expect(pick.freshTerritory).toBe(false);
    expect(pick.note).toContain('best performer');
  });

  it('counts tried combos accurately for the progress note', () => {
    const pick = pickNextCombo({
      [SHUFFLE_COMBOS[0].id]: { runs: 2, leads: 40 },
      [SHUFFLE_COMBOS[1].id]: { runs: 1, leads: 12 },
    });
    expect(pick.combosTried).toBe(2);
    expect(pick.combosTotal).toBe(SHUFFLE_COMBOS.length);
    expect(pick.note).toContain(`slice 3 of ${SHUFFLE_COMBOS.length}`);
  });
});
