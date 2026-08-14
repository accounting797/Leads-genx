import { visibleDomainProvider } from './providerCatalog';
import { evaluateGeography } from './geographyEvidence';
import { TargetedFilters, TargetedQualityTier } from './types';

export interface RelevanceCandidate {
  companyName?: string;
  category?: string;
  jobTitle?: string;
  address?: string;
  email: string;
  sourceUrl?: string;
  phone?: string;
  visibleProvider?: string;
  infrastructureProviders?: string[];
  explicitPublicContact?: boolean;
}

export interface RelevanceDecision {
  accepted: boolean;
  tier: TargetedQualityTier;
  score: number;
  reason: 'target_aligned' | 'needs_review' | 'target_mismatch';
  matchedRules: string[];
  missingRules: string[];
}

function includesAny(text: string, values: string[]): boolean {
  return values.some((value) => value.trim() && text.includes(value.trim().toLowerCase()));
}

const DISCOVERY_ONLY_TERMS = new Set([
  'phone', 'email', 'emails', 'contact', 'contacts', 'public', 'business', 'lead', 'leads',
]);

export function scoreTargetedCandidate(candidate: RelevanceCandidate, filters: TargetedFilters): RelevanceDecision {
  const matchedRules: string[] = [];
  const missingRules: string[] = [];
  const geography = evaluateGeography({
    address: candidate.address, phone: candidate.phone, email: candidate.email, sourceUrl: candidate.sourceUrl,
  }, {
    country: filters.country, areaCodes: filters.areaCodes, states: filters.states,
    cities: filters.cities, postalCodes: filters.postalCodes,
  });

  let score = 0;
  if (geography.status === 'match') {
    score += 35;
    matchedRules.push('geography');
  } else {
    missingRules.push('geography');
  }

  const text = [candidate.companyName, candidate.category, candidate.jobTitle, candidate.sourceUrl]
    .filter(Boolean).join(' ').toLowerCase();
  const intentTerms = [...filters.keywords, ...filters.industries, ...filters.companyTypes, ...filters.roles, ...filters.seniorities]
    .filter((term) => !DISCOVERY_ONLY_TERMS.has(term.trim().toLowerCase()));
  const publicContactMatch = candidate.explicitPublicContact === true && geography.status === 'match';
  const intentMatch = publicContactMatch || intentTerms.length === 0 || includesAny(text, intentTerms);
  if (intentMatch) {
    score += 35;
    matchedRules.push(publicContactMatch ? 'public_contact' : 'business_intent');
  } else {
    missingRules.push('business_intent');
  }

  const candidateVisible = candidate.visibleProvider ?? visibleDomainProvider(candidate.email)?.id;
  if (filters.visibleProviders.length && candidateVisible && filters.visibleProviders.includes(candidateVisible)) {
    score += 15;
    matchedRules.push('visible_provider');
  } else {
    missingRules.push('visible_provider');
  }

  const infrastructureMatch = filters.infrastructureProviders.length > 0
    && candidate.infrastructureProviders?.some((id) => filters.infrastructureProviders.includes(id));
  if (infrastructureMatch) {
    score += 15;
    matchedRules.push('infrastructure_provider');
  } else {
    missingRules.push('infrastructure_provider');
  }

  if (geography.status === 'foreign' || score < 50) {
    return { accepted: false, tier: 'rejected', score, reason: 'target_mismatch', matchedRules, missingRules };
  }
  if (!geography.strictEligible || score < 70) {
    return { accepted: true, tier: 'review', score, reason: 'needs_review', matchedRules, missingRules };
  }
  return { accepted: true, tier: 'strict', score, reason: 'target_aligned', matchedRules, missingRules };
}
