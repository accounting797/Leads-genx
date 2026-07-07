export type LeadSource = 'google_maps' | 'sales_navigator';
export type LeadType = 'business' | 'person';

export interface SalesNavigatorFilters {
  keywords?: string;
  titles?: string[];
  industries?: string[];
  geographies?: string[];
  companies?: string[];
  seniorities?: string[];
  functions?: string[];
  headcounts?: string[];
}

export interface GoogleMapsFilters {
  searchTerms?: string[];
  categoryFilters?: string[];
  locationQuery?: string;
  mapsUrl?: string;
  maxPlaces?: number;
  minimumStars?: number;
  minimumReviews?: number;
  skipClosedPlaces?: boolean;
}

export interface ValidatedRunInput {
  apifyToken?: string;
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
