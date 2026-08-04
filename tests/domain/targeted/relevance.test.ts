import { describe, expect, it } from 'vitest';
import { scoreTargetedCandidate } from '../../../src/domain/targeted/relevance';
import { TargetedFilters } from '../../../src/domain/targeted/types';

const filters: TargetedFilters = {
  mode: 'office', country: 'US', keywords: ['freight'], industries: ['logistics'],
  companyTypes: [], roles: ['operations'], seniorities: [], visibleProviders: [],
  infrastructureProviders: [], bankIds: [], areaCodes: ['602'], states: ['AZ'],
  cities: ['Phoenix'], postalCodes: ['85001'], radiusMiles: 25,
  maxContactsPerCompany: 50, maxResults: 1_000, googleRequestBudget: 50,
};

describe('scoreTargetedCandidate', () => {
  it('strictly accepts an aligned public business contact', () => {
    expect(scoreTargetedCandidate({
      companyName: 'Phoenix Freight Systems', category: 'Freight forwarding service',
      jobTitle: 'Operations Director', address: 'Phoenix, AZ 85001',
      email: 'ops@phoenixfreight.example', sourceUrl: 'https://phoenixfreight.example/contact',
    }, filters)).toMatchObject({ accepted: true, tier: 'strict', score: 70 });
  });

  it('hard rejects wrong geography and unrelated intent', () => {
    expect(scoreTargetedCandidate({
      companyName: 'Desert Fashion Outlet', category: 'Clothing store',
      address: 'Las Vegas, NV', email: 'sales@fashion.example', sourceUrl: 'https://fashion.example',
    }, filters)).toMatchObject({ accepted: false, tier: 'rejected', reason: 'target_mismatch' });
  });

  it('never marks a Lagos business Strict for a US campaign with unresolved markets', () => {
    expect(scoreTargetedCandidate({
      companyName: 'Lagos Public Logistics Company', category: 'Logistics service',
      address: '12 Example Road, Lagos 100001, Lagos, Nigeria',
      email: 'info@company.ng', sourceUrl: 'https://company.ng/contact',
    }, { ...filters, areaCodes: [], states: [], cities: [], postalCodes: [] })).toMatchObject({
      accepted: false, tier: 'rejected', reason: 'target_mismatch',
    });
  });

  it('caps a candidate with missing geography at Review', () => {
    expect(scoreTargetedCandidate({
      companyName: 'Public Freight Logistics Company', category: 'Logistics service',
      address: '', email: 'info@freight.example', sourceUrl: 'https://freight.example/contact',
      visibleProvider: 'comcast', infrastructureProviders: ['microsoft_365'],
    }, {
      ...filters, areaCodes: [], states: [], cities: [], postalCodes: [],
      visibleProviders: ['comcast'], infrastructureProviders: ['microsoft_365'],
    })).toMatchObject({ accepted: true, tier: 'review', reason: 'needs_review' });
  });

  it('does not treat generic discovery tokens such as phone as business intent', () => {
    expect(scoreTargetedCandidate({
      companyName: 'AT&T Store', category: 'Cell phone store', address: 'Phoenix, AZ 85001',
      email: 'sales@att.example', sourceUrl: 'https://att.example/stores/arizona/phoenix',
    }, { ...filters, keywords: ['phone', 'freight forwarding'] })).toMatchObject({
      accepted: false, tier: 'rejected', reason: 'target_mismatch', score: 35,
    });
  });

  it('explains every matched and missing weighted rule', () => {
    const result = scoreTargetedCandidate({
      companyName: 'Phoenix Freight', category: 'Freight', address: 'Phoenix, AZ',
      email: 'team@phoenixfreight.example', sourceUrl: 'https://phoenixfreight.example/contact',
      visibleProvider: 'comcast', infrastructureProviders: [],
    }, { ...filters, visibleProviders: ['comcast'], infrastructureProviders: ['microsoft_365'] });
    expect(result).toMatchObject({ score: 85, tier: 'strict' });
    expect(result.matchedRules).toEqual(expect.arrayContaining(['geography', 'business_intent', 'visible_provider']));
    expect(result.missingRules).toContain('infrastructure_provider');
  });
});
