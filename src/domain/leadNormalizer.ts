import { LeadSource, NormalizedLead } from './types';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

export function normalizeLead(item: unknown, leadSource: LeadSource): NormalizedLead {
  const obj = record(item);
  const rawJson = JSON.stringify(obj);

  if (leadSource === 'google_maps') {
    const companyName = stringValue(obj.title, obj.name, obj.companyName);
    const address = stringValue(obj.address, obj.location);
    return {
      leadSource,
      leadType: 'business',
      companyName,
      categoryName: stringValue(obj.categoryName, obj.category),
      address,
      location: address,
      website: stringValue(obj.website, obj.websiteUrl),
      phone: stringValue(obj.phone, obj.phoneUnformatted),
      rating: numberValue(obj.totalScore, obj.rating, obj.stars),
      reviewsCount: numberValue(obj.reviewsCount, obj.reviewCount),
      placeUrl: stringValue(obj.url, obj.placeUrl, obj.googleMapsUrl),
      rawJson,
    };
  }

  const fullName = stringValue(obj.fullName, obj.name);
  return {
    leadSource,
    leadType: 'person',
    fullName,
    jobTitle: stringValue(obj.jobTitle, obj.title, obj.headline),
    companyName: stringValue(obj.companyName, obj.company, obj.currentCompany),
    email: stringValue(obj.email, obj.workEmail),
    phone: stringValue(obj.phone),
    profileUrl: stringValue(obj.profileUrl, obj.linkedinUrl, obj.url),
    location: stringValue(obj.location),
    connectionDegree: stringValue(obj.connectionDegree),
    rawJson,
  };
}
