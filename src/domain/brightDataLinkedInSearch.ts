/**
 * Bright Data LinkedIn people-search lane.
 *
 * Sales Navigator's filter panel — keywords, current title, function,
 * seniority, industry, company headcount, geography, company — answered
 * WITHOUT a Sales Navigator account: the filters map onto Bright Data's
 * Elasticsearch-backed LinkedIn people dataset (contact-enriched variant,
 * so emails ride along when Bright Data has them).
 *
 * Dataset fields evolve, so the filter mapping is resolved from live
 * dataset metadata: every SN filter group names candidate fields, the
 * first active match wins, and groups the dataset can't answer are
 * skipped with an honest Nova note instead of a silent wrong search.
 */

import type { SalesNavigatorFilters } from './types';
import {
  BrightDataDatasetField,
  BrightDataSearchHit,
  LINKEDIN_PERSON_PROFILE_CONTACT_DATASET,
  listDatasetFields,
  searchDataset,
} from '../integrations/brightDataClient';
import { extractEmail, extractPhone } from './linkedinEnrichment';

/** Candidate dataset fields per Sales Navigator filter group, best first. */
const FIELD_CANDIDATES: Record<string, string[]> = {
  titles: ['position', 'title', 'job_title'],
  companies: ['current_company_name', 'company_name', 'company'],
  industries: ['industry', 'company_industry'],
  geographies: ['location', 'city', 'country', 'country_code'],
  seniorities: ['seniority', 'seniority_level'],
  functions: ['function', 'job_function'],
  headcounts: ['company_headcount', 'company_size', 'employees', 'company_employee_count'],
};

export interface ResolvedSearchFields {
  /** SN filter group → dataset field name. */
  mapping: Partial<Record<keyof SalesNavigatorFilters, string>>;
  /** Groups the dataset cannot answer (honestly narrated, never silently dropped). */
  skipped: string[];
}

export function resolveSearchFields(
  filters: SalesNavigatorFilters,
  fields: BrightDataDatasetField[]
): ResolvedSearchFields {
  const available = new Set(fields.map((field) => field.name.toLowerCase()));
  const mapping: ResolvedSearchFields['mapping'] = {};
  const skipped: string[] = [];
  for (const [group, candidates] of Object.entries(FIELD_CANDIDATES)) {
    const values = filters[group as keyof SalesNavigatorFilters];
    if (!Array.isArray(values) || values.length === 0) continue;
    const match = candidates.find((candidate) => available.has(candidate));
    if (match) mapping[group as keyof SalesNavigatorFilters] = match;
    else skipped.push(group);
  }
  return { mapping, skipped };
}

function leaf(name: string, operator: string, value: string | string[]): Record<string, unknown> {
  return { name, operator, value };
}

/** SN filters → Bright Data filter tree (depth ≤ 3): AND of OR-groups. */
export function buildSearchFilter(
  filters: SalesNavigatorFilters,
  resolved: ResolvedSearchFields
): Record<string, unknown> | undefined {
  const groups: Array<Record<string, unknown>> = [];
  const addGroup = (values: string[] | undefined, field?: string) => {
    if (!values?.length || !field) return;
    const clean = values.map((value) => value.trim()).filter(Boolean);
    if (!clean.length) return;
    groups.push(
      clean.length === 1
        ? leaf(field, 'includes', clean[0])
        : { operator: 'or', filters: clean.map((value) => leaf(field, 'includes', value)) }
    );
  };
  addGroup(filters.titles, resolved.mapping.titles);
  addGroup(filters.companies, resolved.mapping.companies);
  addGroup(filters.industries, resolved.mapping.industries);
  addGroup(filters.geographies, resolved.mapping.geographies);
  addGroup(filters.seniorities, resolved.mapping.seniorities);
  addGroup(filters.functions, resolved.mapping.functions);
  addGroup(filters.headcounts, resolved.mapping.headcounts);
  if (!groups.length) return undefined;
  return groups.length === 1 ? groups[0] : { operator: 'and', filters: groups };
}

export interface BrightDataPersonLead {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  jobTitle?: string;
  companyName?: string;
  profileUrl?: string;
  location?: string;
  email?: string;
  phone?: string;
  rawJson: string;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** Defensive hit → lead mapping; dataset field names vary by snapshot vintage. */
export function mapSearchHit(hit: BrightDataSearchHit): BrightDataPersonLead | undefined {
  const profileUrl = firstString(hit.url, hit.profile_url, hit.linkedin_url, hit.id);
  const fullName = firstString(hit.name, hit.full_name);
  if (!profileUrl || !fullName) return undefined;
  return {
    fullName,
    firstName: firstString(hit.first_name),
    lastName: firstString(hit.last_name),
    jobTitle: firstString(hit.position, hit.title, hit.job_title),
    companyName: firstString(hit.current_company_name, hit.company_name, hit.company),
    profileUrl,
    location: firstString(hit.location, hit.city, hit.country),
    email: extractEmail(hit),
    phone: extractPhone(hit),
    rawJson: JSON.stringify(hit),
  };
}

export interface BrightDataLinkedInSearchDeps {
  apiKey: string;
  datasetId?: string;
  search?: typeof searchDataset;
  listFields?: typeof listDatasetFields;
  pageSize?: number;
  maxPages?: number;
  onEvent?: (type: string, message: string, metadata?: Record<string, unknown>) => Promise<void> | void;
}

/**
 * Searches the contact-enriched LinkedIn people dataset page by page,
 * returning deduped person leads (by profileUrl) up to maxResults.
 */
export async function searchLinkedInPeople(
  filters: SalesNavigatorFilters,
  maxResults: number,
  deps: BrightDataLinkedInSearchDeps
): Promise<{ leads: BrightDataPersonLead[]; totalHits: number; skippedGroups: string[] }> {
  const datasetId = deps.datasetId ?? LINKEDIN_PERSON_PROFILE_CONTACT_DATASET;
  const search = deps.search ?? searchDataset;
  const listFields = deps.listFields ?? listDatasetFields;
  const pageSize = deps.pageSize ?? 100;
  const maxPages = deps.maxPages ?? 50;
  const emit = deps.onEvent ?? (() => {});

  const fields = await listFields(deps.apiKey, datasetId);
  const resolved = resolveSearchFields(filters, fields);
  const filter = buildSearchFilter(filters, resolved);
  if (!filter) {
    throw new Error(
      resolved.skipped.length
        ? `Bright Data's LinkedIn dataset can't filter by ${resolved.skipped.join(', ')} — try titles, industries, or locations.`
        : 'Add at least one Sales Navigator filter to search Bright Data.'
    );
  }
  if (resolved.skipped.length) {
    await emit(
      'brightdata_search_fields_skipped',
      `Nova note — Bright Data's dataset can't filter by ${resolved.skipped.join(
        ', '
      )}, so I'm searching on the rest. Your other filters all apply.`,
      { skipped: resolved.skipped }
    );
  }

  const leads: BrightDataPersonLead[] = [];
  const seenProfiles = new Set<string>();
  let searchAfter: unknown[] | undefined;
  let totalHits = 0;
  for (let page = 0; page < maxPages && leads.length < maxResults; page += 1) {
    const result = await search({
      apiKey: deps.apiKey,
      datasetId,
      filter,
      size: pageSize,
      searchAfter,
    });
    totalHits = result.totalHits;
    let added = 0;
    for (const hit of result.hits) {
      const lead = mapSearchHit(hit);
      if (!lead || seenProfiles.has(lead.profileUrl!.toLowerCase())) continue;
      seenProfiles.add(lead.profileUrl!.toLowerCase());
      leads.push(lead);
      added += 1;
      if (leads.length >= maxResults) break;
    }
    await emit(
      'brightdata_search_progress',
      `Bright Data search — ${leads.length} leads gathered (${totalHits} matches in the dataset).`,
      { gathered: leads.length, totalHits, page: page + 1 }
    );
    if (!result.searchAfter || result.hits.length === 0 || added === 0) break;
    searchAfter = result.searchAfter;
  }
  return { leads, totalHits, skippedGroups: resolved.skipped };
}
