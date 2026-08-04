import { describe, expect, it } from 'vitest';
import { planTargetedQueries } from '../../../src/domain/targeted/queryPlanner';

describe('planTargetedQueries', () => {
  it('generates ordered area-code-first queries and preview document variants', () => {
    const plan = planTargetedQueries({
      prompt: 'public Comcast contacts',
      mode: 'other',
      country: 'US',
      areaCodes: ['602'],
      states: ['AZ'],
      cities: ['Avondale'],
      postalCodes: ['85392'],
      visibleProviders: ['comcast'],
      infrastructureProviders: [],
      keywords: ['phone'],
      maxContactsPerCompany: 50,
    });
    expect(plan.map((unit) => unit.query)).toEqual(expect.arrayContaining([
      'phone 602 Avondale AZ 85392 "@comcast.net"',
      'phone 602 Avondale AZ 85392 "@comcast.net" filetype:pdf',
    ]));
    expect(plan.find((unit) => unit.documentType === 'pdf')?.connector).toBe('public_document');
    expect(new Set(plan.map((unit) => unit.workKey)).size).toBe(plan.length);
  });

  it('always emits the canonical area-code-first module with explicit intent', () => {
    const plan = planTargetedQueries({
      prompt: 'public logistics aviation and power contacts', mode: 'bank', country: 'US',
      keywords: ['logistics', 'aviation', 'power'], industries: ['logistics', 'aviation', 'power'],
      areaCodes: ['602'], cities: ['Phoenix'], states: ['AZ'], postalCodes: ['85001'],
      visibleProviders: ['comcast'],
    });
    expect(plan.find((unit) => unit.documentType === 'html')?.query)
      .toBe('phone 602 Phoenix AZ 85001 logistics aviation power "@comcast.net"');
    expect(plan.find((unit) => unit.documentType === 'xlsx')?.query)
      .toBe('phone 602 Phoenix AZ 85001 logistics aviation power "@comcast.net" filetype:xlsx');
    expect(plan[0].documentType).toBe('xlsx');
  });

  it('covers all seven formats for every one of 100 deterministic bank markets', () => {
    const first = planTargetedQueries({
      prompt: 'public business contacts', mode: 'office', country: 'US',
      areaCodes: Array.from({ length: 100 }, (_, index) => String(200 + index)),
      states: ['AZ'], cities: ['Phoenix'], postalCodes: ['85001'],
      visibleProviders: [], infrastructureProviders: ['microsoft_365'], keywords: ['phone'],
    });
    const second = planTargetedQueries({
      prompt: 'public business contacts', mode: 'office', country: 'US',
      areaCodes: Array.from({ length: 100 }, (_, index) => String(200 + index)),
      states: ['AZ'], cities: ['Phoenix'], postalCodes: ['85001'],
      visibleProviders: [], infrastructureProviders: ['microsoft_365'], keywords: ['phone'],
    });
    expect(first).toHaveLength(700);
    expect(first.map((unit) => unit.workKey)).toEqual(second.map((unit) => unit.workKey));
    expect(new Set(first.map((unit) => unit.geography.areaCode)).size).toBe(100);
  });
});
