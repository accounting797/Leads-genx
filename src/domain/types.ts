export type LeadSource = 'google_maps' | 'sales_navigator';
export type LeadType = 'business' | 'person';
export type GoogleMapsProvider = 'apify' | 'google_places' | 'local_first' | 'hybrid';
export type RouteMode = 'direct' | 'proxy';
export type OutputMode = 'standard' | 'hybrid_max';
export type ContactQuality = 'qualified' | 'raw';
export type ProviderName = 'docker' | 'google' | 'apify' | 'email';
export type ProviderStatus =
  | 'standby'
  | 'running'
  | 'waiting'
  | 'cooling_down'
  | 'paused'
  | 'completed'
  | 'failed';

export interface ProviderStateWrite {
  provider: ProviderName;
  status: ProviderStatus;
  operation: string;
  yieldCount: number;
  budgetUsed?: number;
  budgetMax?: number;
  heartbeatAt: Date;
  errorCode?: string;
  errorMessage?: string;
}

export interface SalesNavigatorFilters {
  keywords?: string;
  titles?: string[];
  industries?: string[];
  geographies?: string[];
  companies?: string[];
  seniorities?: string[];
  functions?: string[];
  headcounts?: string[];
  cookies?: string;
  userAgent?: string;
}

export interface GoogleMapsFilters {
  provider?: GoogleMapsProvider;
  apiRequestBudget?: number;
  searchTerms?: string[];
  categoryFilters?: string[];
  companyTypes?: string[];
  locations?: string[];
  locationQuery?: string;
  mapsUrl?: string;
  maxPlaces?: number;
  minimumStars?: number;
  minimumReviews?: number;
  skipClosedPlaces?: boolean;
}

export interface ValidatedRunInput {
  apifyToken?: string;
  apifyTokens?: string[];
  googleApiKey?: string;
  googleApiKeys?: string[];
  proxyUrls?: string[];
  routeMode?: RouteMode;
  leadSource: LeadSource;
  actorId?: string;
  searchUrl?: string;
  maxResults: number;
  salesNavigator?: SalesNavigatorFilters;
  googleMaps?: GoogleMapsFilters;
}

export interface ActorRunInput {
  token: string;
  leadSource: LeadSource;
  actorId: string;
  input: Record<string, unknown>;
  maxResults: number;
}

export interface NormalizedLead {
  leadSource: LeadSource;
  leadType: LeadType;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  jobTitle?: string;
  companyName?: string;
  email?: string;
  normalizedEmail?: string;
  contactQuality?: ContactQuality;
  qualityReason?: string;
  businessIdentityKey?: string;
  phone?: string;
  location?: string;
  profileUrl?: string;
  connectionDegree?: string;
  categoryName?: string;
  address?: string;
  website?: string;
  rating?: number;
  reviewsCount?: number;
  placeUrl?: string;
  rawJson?: string;
}
