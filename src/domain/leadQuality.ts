import { GoogleMapsFilters, NormalizedLead } from './types';

function rawRecord(lead: NormalizedLead): Record<string, unknown> {
  if (!lead.rawJson) return {};
  try {
    const value = JSON.parse(lead.rawJson);
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function explicitlyClosed(lead: NormalizedLead): boolean {
  const raw = rawRecord(lead);
  const status = typeof raw.businessStatus === 'string'
    ? raw.businessStatus.toUpperCase()
    : typeof raw.business_status === 'string'
      ? raw.business_status.toUpperCase()
      : undefined;
  return status === 'CLOSED_PERMANENTLY' || status === 'CLOSED_TEMPORARILY' ||
    raw.permanentlyClosed === true || raw.temporarilyClosed === true || raw.isClosed === true;
}

export function meetsGoogleMapsQualityFilters(
  lead: NormalizedLead,
  filters: GoogleMapsFilters = {}
): boolean {
  if (filters.minimumStars !== undefined && (lead.rating === undefined || lead.rating < filters.minimumStars)) {
    return false;
  }
  if (filters.minimumReviews !== undefined &&
      (lead.reviewsCount === undefined || lead.reviewsCount < filters.minimumReviews)) {
    return false;
  }
  if ((filters.skipClosedPlaces ?? true) && explicitlyClosed(lead)) return false;
  return true;
}

export function applyLeadQualityFilters(
  leads: NormalizedLead[],
  filters: GoogleMapsFilters = {}
): NormalizedLead[] {
  return leads.filter((lead) => meetsGoogleMapsQualityFilters(lead, filters));
}
