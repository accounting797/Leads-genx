import { createHash } from 'node:crypto';
import { providerCatalog } from './providerCatalog';
import { TargetedCountry, TargetedGeography, TargetedMode } from './types';

export interface TargetedQueryInput {
  prompt: string;
  mode: TargetedMode;
  country: TargetedCountry;
  keywords?: string[];
  industries?: string[];
  companyTypes?: string[];
  roles?: string[];
  seniorities?: string[];
  visibleProviders?: string[];
  infrastructureProviders?: string[];
  bankIds?: string[];
  areaCodes?: string[];
  states?: string[];
  cities?: string[];
  postalCodes?: string[];
  maxContactsPerCompany?: number;
}

export interface PlannedTargetedQuery {
  workKey: string;
  connector: 'public_web' | 'public_document';
  query: string;
  documentType: 'html' | 'pdf' | 'xls' | 'xlsx' | 'csv' | 'docx' | 'txt';
  geography: TargetedGeography;
  visibleProvider?: string;
  infrastructureProviders: string[];
}

const DOCUMENT_TYPES: PlannedTargetedQuery['documentType'][] = ['xlsx', 'csv', 'xls', 'pdf', 'docx', 'txt', 'html'];

function at<T>(values: T[] | undefined, index: number, fallback: T): T {
  if (!values?.length) return fallback;
  return values[Math.min(index, values.length - 1)];
}

function geographies(input: TargetedQueryInput): TargetedGeography[] {
  const count = Math.max(input.areaCodes?.length ?? 0, input.states?.length ?? 0, input.cities?.length ?? 0, input.postalCodes?.length ?? 0, 1);
  return Array.from({ length: count }, (_, index) => ({
    country: input.country,
    areaCode: at(input.areaCodes, index, ''),
    state: at(input.states, index, ''),
    city: at(input.cities, index, ''),
    postalCode: at(input.postalCodes, index, ''),
  }));
}

function keyFor(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const DISCOVERY_TERMS = new Set(['phone', 'email', 'emails', 'contact', 'contacts', 'public', 'business', 'lead', 'leads']);

function intentFor(input: TargetedQueryInput): string {
  return [...new Set([
    ...(input.keywords ?? []), ...(input.industries ?? []), ...(input.companyTypes ?? []),
    ...(input.roles ?? []), ...(input.seniorities ?? []),
  ].map((value) => value.trim()).filter((value) => value && !DISCOVERY_TERMS.has(value.toLowerCase())))]
    .join(' ');
}

export function planTargetedQueries(input: TargetedQueryInput): PlannedTargetedQuery[] {
  const visibleProviderIds = input.visibleProviders?.length ? input.visibleProviders : [undefined];
  const intent = intentFor(input);
  const results: PlannedTargetedQuery[] = [];

  for (const geography of geographies(input)) {
    if (!geography.areaCode && !geography.city && !geography.state && !geography.postalCode) {
      throw new Error('US/Canadian targeted work requires a resolved area code, city, state/province, or postal code.');
    }
    for (const visibleProvider of visibleProviderIds) {
      const domains = visibleProvider
        ? providerCatalog().filter((entry) => entry.id === visibleProvider && entry.matchType === 'visible_domain').map((entry) => entry.pattern)
        : [undefined];
      for (const domain of domains.length ? domains : [undefined]) {
        for (const documentType of DOCUMENT_TYPES) {
          const structured = ['phone', geography.areaCode, geography.city, geography.state, geography.postalCode, intent, domain ? `"@${domain}"` : '']
            .filter(Boolean).join(' ');
          const query = documentType === 'html' ? structured : `${structured} filetype:${documentType}`;
          const identity = { query: query.toLowerCase(), documentType, geography, visibleProvider, infrastructureProviders: input.infrastructureProviders ?? [] };
          results.push({
            workKey: keyFor(identity),
            connector: documentType === 'html' ? 'public_web' : 'public_document',
            query,
            documentType,
            geography,
            visibleProvider,
            infrastructureProviders: input.infrastructureProviders ?? [],
          });
          if (results.length === 5_000) return results;
        }
      }
    }
  }
  return results;
}
