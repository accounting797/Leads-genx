import { TargetedCountry } from './types';

export interface GeographyEvidenceCandidate {
  address?: string;
  phone?: string;
  email?: string;
  sourceUrl?: string;
}

export interface GeographyEvidenceTarget {
  country: TargetedCountry;
  areaCodes: string[];
  states: string[];
  cities: string[];
  postalCodes: string[];
}

export interface GeographyDecision {
  status: 'match' | 'ambiguous' | 'foreign';
  strictEligible: boolean;
  reason: 'target_geography' | 'missing_geography' | 'foreign_country' | 'outside_target_market';
  matched: string[];
}

const US_REGIONS = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

const CA_REGIONS = new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT']);

const FOREIGN_COUNTRIES = [
  'nigeria', 'ghana', 'kenya', 'uganda', 'tanzania', 'south africa', 'zimbabwe', 'zambia',
  'india', 'pakistan', 'bangladesh', 'sri lanka', 'nepal', 'china', 'japan', 'singapore',
  'united kingdom', 'england', 'scotland', 'wales', 'ireland', 'france', 'germany', 'italy',
  'spain', 'portugal', 'netherlands', 'belgium', 'sweden', 'norway', 'denmark', 'poland',
  'brazil', 'argentina', 'mexico', 'colombia', 'venezuela', 'australia', 'new zealand',
  'united arab emirates', 'saudi arabia', 'qatar', 'israel', 'turkey', 'russia', 'ukraine',
];

const FOREIGN_CCTLDS = new Set([
  'ng', 'gh', 'ke', 'ug', 'tz', 'za', 'zw', 'zm', 'pk', 'bd', 'lk', 'np', 'cn', 'jp', 'sg',
  'uk', 'ie', 'fr', 'de', 'it', 'es', 'pt', 'nl', 'be', 'se', 'no', 'dk', 'pl', 'br', 'ar',
  'mx', 'co', 've', 'au', 'nz', 'ae', 'sa', 'qa', 'il', 'tr', 'ru', 'ua',
]);

function normalize(value: string | undefined): string {
  return (value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasPhrase(text: string, value: string): boolean {
  const cleaned = normalize(value).trim();
  if (!cleaned) return false;
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegex(cleaned)}(?:$|[^a-z0-9])`, 'i').test(text);
}

function domainTld(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const host = value.includes('@')
      ? value.slice(value.lastIndexOf('@') + 1)
      : new URL(value).hostname;
    return host.toLowerCase().split('.').at(-1);
  } catch {
    return undefined;
  }
}

function addressRegions(address: string): string[] {
  return [...address.toUpperCase().matchAll(/(?:^|[^A-Z])([A-Z]{2})(?=$|[^A-Z])/g)]
    .map((match) => match[1]);
}

function phoneAreaCode(phone: string | undefined): string | undefined {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length === 10) return digits.slice(0, 3);
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1, 4);
  return undefined;
}

export function evaluateGeography(
  candidate: GeographyEvidenceCandidate,
  target: GeographyEvidenceTarget,
): GeographyDecision {
  const address = normalize(candidate.address);
  const combined = [address, normalize(candidate.sourceUrl)].filter(Boolean).join(' ');
  const tlds = [domainTld(candidate.email), domainTld(candidate.sourceUrl)].filter(Boolean) as string[];
  const explicitForeign = FOREIGN_COUNTRIES.some((country) => hasPhrase(combined, country));
  const foreignTld = tlds.some((tld) => FOREIGN_CCTLDS.has(tld));
  if (explicitForeign || foreignTld) {
    return { status: 'foreign', strictEligible: false, reason: 'foreign_country', matched: [] };
  }

  const regions = addressRegions(candidate.address ?? '');
  const usRegion = regions.find((region) => US_REGIONS.has(region));
  const caRegion = regions.find((region) => CA_REGIONS.has(region));
  const usCountry = hasPhrase(address, 'united states') || hasPhrase(address, 'usa') || Boolean(usRegion && /\b\d{5}(?:-\d{4})?\b/.test(address));
  const caCountry = hasPhrase(address, 'canada') || Boolean(caRegion && /\b[a-z]\d[a-z][ -]?\d[a-z]\d\b/i.test(address));
  if ((target.country === 'US' && caCountry) || (target.country === 'CA' && usCountry)) {
    return { status: 'foreign', strictEligible: false, reason: 'foreign_country', matched: [] };
  }

  const matched: string[] = [];
  const areaCode = phoneAreaCode(candidate.phone);
  if (areaCode && target.areaCodes.includes(areaCode)) matched.push('area_code');
  if (target.states.some((state) => regions.includes(state.toUpperCase()))) matched.push('state');
  if (target.cities.some((city) => hasPhrase(address, city))) matched.push('city');
  if (target.postalCodes.some((postal) => hasPhrase(address, postal))) matched.push('postal_code');

  const hasMarketTarget = target.areaCodes.length > 0 || target.states.length > 0
    || target.cities.length > 0 || target.postalCodes.length > 0;
  const sameCountryEvidence = target.country === 'US' ? usCountry : caCountry;

  if (hasMarketTarget && matched.length === 0 && (sameCountryEvidence || address.length > 0)) {
    return { status: 'foreign', strictEligible: false, reason: 'outside_target_market', matched: [] };
  }
  if (matched.length > 0 || (!hasMarketTarget && sameCountryEvidence)) {
    return { status: 'match', strictEligible: true, reason: 'target_geography', matched };
  }
  return { status: 'ambiguous', strictEligible: false, reason: 'missing_geography', matched: [] };
}
