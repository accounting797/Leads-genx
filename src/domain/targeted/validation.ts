import { providerCatalog } from './providerCatalog';
import {
  TargetedCountry,
  TargetedDraftInput,
  TargetedMode,
} from './types';

export class TargetedValidationError extends Error {
  constructor(public readonly fields: Record<string, string>) {
    super(Object.values(fields).join(' '));
    this.name = 'TargetedValidationError';
  }
}

const MODES = new Set<TargetedMode>(['office', 'google', 'other', 'bank']);
const COUNTRIES = new Set<TargetedCountry>(['US', 'CA']);
const CONSUMER_TARGETING = /\b(account\s*holders?|card\s*holders?|depositors?|borrowers?|bank\s*customers?|personal\s*customers?|consumer\s*customers?)\b/i;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean))];
}

function boundedInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) ? value as number : fallback;
}

export function validateTargetedDraft(value: unknown): TargetedDraftInput {
  const input = record(value);
  const fields: Record<string, string> = {};
  const mode = (typeof input.mode === 'string' ? input.mode : 'office') as TargetedMode;
  const country = (typeof input.country === 'string' ? input.country : 'US') as TargetedCountry;
  const bankIds = strings(input.bankIds);
  const suppliedPrompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  const prompt = suppliedPrompt || (mode === 'bank' && bankIds.length ? 'Public business contacts' : '');

  if (prompt.length < 3 || prompt.length > 2_000) fields.prompt = 'Prompt must contain 3 to 2000 characters.';
  if (CONSUMER_TARGETING.test(prompt)) {
    fields.prompt = 'Targeting is limited to public business contacts; consumer or bank-customer lists are prohibited.';
  }
  if (!MODES.has(mode)) fields.mode = 'Mode must be office, google, other, or bank.';
  if (!COUNTRIES.has(country)) fields.country = 'Country must be US or CA.';

  const areaCodes = strings(input.areaCodes);
  const states = strings(input.states);
  const cities = strings(input.cities);
  const postalCodes = strings(input.postalCodes);
  const locationCount = Math.max(areaCodes.length, states.length, cities.length, postalCodes.length);
  if (locationCount > 100) fields.locations = 'Select no more than 100 aligned market substitutions.';

  const maxContactsPerCompany = boundedInteger(input.maxContactsPerCompany, 10);
  const maxResults = boundedInteger(input.maxResults, 1_000);
  const googleRequestBudget = boundedInteger(input.googleRequestBudget, 50);
  const publicSearchRequestBudget = boundedInteger(input.publicSearchRequestBudget, 1_200);
  const radiusMiles = boundedInteger(input.radiusMiles, 25);
  const requestedWorkUnits = boundedInteger(input.requestedWorkUnits, 0);
  if (maxContactsPerCompany < 1 || maxContactsPerCompany > 50) {
    fields.maxContactsPerCompany = 'Contacts per company must be between 1 and 50.';
  }
  if (maxResults < 1 || maxResults > 100_000) fields.maxResults = 'Maximum results must be between 1 and 100000.';
  if (googleRequestBudget < 0 || googleRequestBudget > 10_000) {
    fields.googleRequestBudget = 'Google request budget must be between 0 and 10000.';
  }
  if (radiusMiles < 0 || radiusMiles > 500) fields.radiusMiles = 'Radius must be between 0 and 500 miles.';
  if (publicSearchRequestBudget < 0 || publicSearchRequestBudget > 5_000) {
    fields.publicSearchRequestBudget = 'Public search request budget must be between 0 and 5000.';
  }
  if (requestedWorkUnits > 5_000) fields.requestedWorkUnits = 'A targeted campaign can contain at most 5000 work units.';

  const visibleProviders = strings(input.visibleProviders);
  const infrastructureProviders = strings(input.infrastructureProviders);
  const allowedVisible = new Set(providerCatalog().filter((entry) => entry.matchType === 'visible_domain').map((entry) => entry.id));
  const allowedInfrastructure = new Set(providerCatalog().filter((entry) => entry.matchType !== 'visible_domain').map((entry) => entry.id));
  if (visibleProviders.some((id) => !allowedVisible.has(id))) fields.visibleProviders = 'One or more visible email providers are unsupported.';
  if (infrastructureProviders.some((id) => !allowedInfrastructure.has(id))) {
    fields.infrastructureProviders = 'One or more mail infrastructure providers are unsupported.';
  }

  if (Object.keys(fields).length) throw new TargetedValidationError(fields);

  return {
    prompt,
    mode,
    country,
    keywords: strings(input.keywords),
    industries: strings(input.industries),
    companyTypes: strings(input.companyTypes),
    roles: strings(input.roles),
    seniorities: strings(input.seniorities),
    visibleProviders,
    infrastructureProviders,
    bankIds,
    areaCodes,
    states,
    cities,
    postalCodes,
    radiusMiles,
    maxContactsPerCompany,
    maxResults,
    googleRequestBudget,
    publicSearchRequestBudget,
  };
}
