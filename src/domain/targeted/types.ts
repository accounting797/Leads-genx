export type TargetedCampaignStatus =
  | 'draft'
  | 'planned'
  | 'queued'
  | 'running'
  | 'waiting_for_scraper'
  | 'completed'
  | 'partially_completed'
  | 'cancelled'
  | 'failed';

export type TargetedQualityTier = 'strict' | 'review' | 'rejected';
export type VerificationDepth = 'syntax' | 'domain_mx' | 'mailbox';
export type TargetedMode = 'office' | 'google' | 'other' | 'bank';
export type TargetedCountry = 'US' | 'CA';

export interface TargetedFilters {
  mode: TargetedMode;
  country: TargetedCountry;
  keywords: string[];
  industries: string[];
  companyTypes: string[];
  roles: string[];
  seniorities: string[];
  visibleProviders: string[];
  infrastructureProviders: string[];
  bankIds: string[];
  areaCodes: string[];
  states: string[];
  cities: string[];
  postalCodes: string[];
  radiusMiles: number;
  maxContactsPerCompany: number;
  maxResults: number;
  googleRequestBudget: number;
  publicSearchRequestBudget?: number;
}

export interface TargetedDraftInput extends TargetedFilters {
  prompt: string;
}

export interface TargetedFunnel {
  discovered: number;
  aligned: number;
  strict: number;
  mailboxVerified: number;
  review: number;
  rejected: number;
  exported: number;
}

export interface TargetedCampaignRecord {
  id: number;
  userId: number;
  status: TargetedCampaignStatus;
  prompt: string;
  filters: TargetedFilters;
  funnel: TargetedFunnel;
  plannedUnitCount: number;
  completedUnitCount: number;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TargetedWorkUnitRecord {
  id: number;
  campaignId: number;
  workKey: string;
  connector: string;
  query: string;
  documentType: string;
  geography: TargetedGeography;
  status: string;
  resultCount: number;
  previousUseCount?: number;
  progress?: TargetedWorkUnitProgress;
}

export interface TargetedWorkUnitProgress {
  stage: string;
  processed: number;
  total?: number;
  succeeded: number;
  failed: number;
  currentSource?: string;
  heartbeatAt: string;
}

export interface TargetedGeography {
  country: TargetedCountry;
  areaCode: string;
  state: string;
  city: string;
  postalCode: string;
}

export interface TargetedCandidateRecord {
  id: number;
  campaignId: number;
  email: string;
  normalizedEmail: string;
  fullName?: string;
  jobTitle?: string;
  companyName?: string;
  website?: string;
  phone?: string;
  address?: string;
  visibleProvider?: string;
  infrastructureProviders: string[];
  relevanceScore: number;
  relevanceReason?: string;
  qualityTier: TargetedQualityTier;
  verificationDepth: VerificationDepth;
  complianceStatus: string;
}
