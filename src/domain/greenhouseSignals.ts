import type { GreenhouseJob } from '../integrations/greenhouseClient';

export type HiringRoleGroup = 'sales' | 'operations' | 'finance' | 'marketing' | 'leadership';
export type IndustryRelationship = 'exact' | 'adjacent' | 'none';
export type HiringRelationship = 'exact' | 'adjacent';

export interface ScoredHiringJob extends GreenhouseJob {
  roleGroup: HiringRoleGroup;
  ageDays: number;
}

export interface HiringScoreComponents {
  roles: number;
  recency: number;
  geography: number;
  industry: number;
  breadth: number;
}

export interface HiringSignalScore {
  total: number;
  components: HiringScoreComponents;
  qualifyingJobs: ScoredHiringJob[];
}

export interface ScoreHiringSignalInput {
  jobs: GreenhouseJob[];
  requestedGeographies?: string[];
  industryRelationship: IndustryRelationship;
  now?: Date;
}

const ROLE_PATTERNS: Array<[HiringRoleGroup, RegExp]> = [
  ['leadership', /\b(chief|president|vice president|vp|head of|general manager)\b/i],
  ['sales', /\b(sales|revenue|account executive|business development)\b/i],
  ['operations', /\b(operations|supply chain|logistics|procurement)\b/i],
  ['finance', /\b(finance|financial|accounting|controller|treasury)\b/i],
  ['marketing', /\b(marketing|growth|demand generation|brand)\b/i],
];

const LEGAL_SUFFIXES = /\b(incorporated|inc|limited|ltd|llc|pllc|corp|corporation|company|co)\b/g;

function normalizedWords(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function classifyHiringJob(job: Pick<GreenhouseJob, 'title'>): HiringRoleGroup | undefined {
  for (const [group, pattern] of ROLE_PATTERNS) {
    if (pattern.test(job.title)) return group;
  }
  return undefined;
}

function geographyPoints(jobs: ScoredHiringJob[], requested: string[]): number {
  const requestedNormalized = requested.map(normalizedWords).filter(Boolean);
  if (!requestedNormalized.length) return 0;
  const locations = jobs.map((job) => normalizedWords(job.location));
  const exact = locations.some((location) =>
    requestedNormalized.some((target) => location === target || location.includes(target) || target.includes(location))
  );
  if (exact) return 20;
  if (locations.some((location) => /\bremote\b/.test(location))) return 12;
  return 0;
}

function recencyPoints(newestAgeDays: number): number {
  if (newestAgeDays <= 7) return 25;
  if (newestAgeDays <= 14) return 20;
  if (newestAgeDays <= 21) return 12;
  return 6;
}

export function scoreHiringSignal({
  jobs,
  requestedGeographies = [],
  industryRelationship,
  now = new Date(),
}: ScoreHiringSignalInput): HiringSignalScore {
  const qualifyingJobs = jobs
    .map((candidate): ScoredHiringJob | undefined => {
      const roleGroup = classifyHiringJob(candidate);
      const updatedAt = new Date(candidate.updatedAt);
      if (!roleGroup || Number.isNaN(updatedAt.getTime())) return undefined;
      const ageDays = Math.floor((now.getTime() - updatedAt.getTime()) / 86_400_000);
      if (ageDays < 0 || ageDays > 30) return undefined;
      return { ...candidate, roleGroup, ageDays };
    })
    .filter((candidate): candidate is ScoredHiringJob => Boolean(candidate))
    .sort((left, right) => left.ageDays - right.ageDays || left.title.localeCompare(right.title));

  if (!qualifyingJobs.length) {
    return {
      total: 0,
      components: { roles: 0, recency: 0, geography: 0, industry: 0, breadth: 0 },
      qualifyingJobs: [],
    };
  }

  const roleCount = qualifyingJobs.length;
  const distinctGroups = new Set(qualifyingJobs.map((job) => job.roleGroup));
  const distinctDepartments = new Set(
    qualifyingJobs.flatMap((job) => job.departments.map(normalizedWords)).filter(Boolean)
  );
  const components: HiringScoreComponents = {
    roles: roleCount >= 3 ? 35 : roleCount === 2 ? 27 : 18,
    recency: recencyPoints(qualifyingJobs[0].ageDays),
    geography: geographyPoints(qualifyingJobs, requestedGeographies),
    industry: industryRelationship === 'exact' ? 15 : industryRelationship === 'adjacent' ? 8 : 0,
    breadth: distinctGroups.size >= 2 || distinctDepartments.size >= 2 ? 5 : 0,
  };
  const total = Math.min(100, Object.values(components).reduce((sum, value) => sum + value, 0));
  return { total, components, qualifyingJobs };
}

export interface CompanyIdentityInput {
  companyName?: string | null;
  website?: string | null;
}

export interface CompanyIdentity {
  companyKey: string;
  companyDomain?: string;
  normalizedName: string;
}

function normalizeDomain(value: string | null | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const domain = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    return domain && domain.includes('.') ? domain : undefined;
  } catch {
    return undefined;
  }
}

export function companyIdentity(input: CompanyIdentityInput): CompanyIdentity {
  const normalizedName = normalizedWords(input.companyName ?? '')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const companyDomain = normalizeDomain(input.website);
  const companyKey = companyDomain
    ? `domain:${companyDomain}`
    : `name:${normalizedName || 'unknown'}`;
  return { companyKey, ...(companyDomain ? { companyDomain } : {}), normalizedName };
}

export function buildHiringExplanation({
  companyName,
  score,
  relationship,
  now = new Date(),
}: {
  companyName: string;
  score: HiringSignalScore;
  relationship: HiringRelationship;
  now?: Date;
}): string {
  const jobs = score.qualifyingJobs.slice(0, 2);
  if (!jobs.length) return `${companyName} has no recent qualifying hiring signal.`;
  const titles = jobs.map((job) => job.title);
  const roleText =
    titles.length === 1 ? titles[0] : `${titles[0]} and ${titles[1]}`;
  const newest = jobs[0];
  const age = Math.max(0, Math.floor((now.getTime() - new Date(newest.updatedAt).getTime()) / 86_400_000));
  const freshness = age === 0 ? 'updated today' : `updated ${age} day${age === 1 ? '' : 's'} ago`;
  const location = newest.location ? ` in ${newest.location}` : '';
  const relation =
    relationship === 'adjacent'
      ? ' It is an adjacent opportunity, so I kept it separate for your review.'
      : ' It closely matches your search.';
  return `${companyName} is hiring for ${roleText}${location}, ${freshness}.${relation}`;
}
