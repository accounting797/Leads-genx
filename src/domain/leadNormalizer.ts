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

function nestedText(value: unknown): string | undefined {
  const obj = record(value);
  return stringValue(obj.text);
}

function firstString(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  return stringValue(...value);
}

export function normalizeLead(item: unknown, leadSource: LeadSource): NormalizedLead {
  const obj = record(item);
  const rawJson = JSON.stringify(obj);

  if (leadSource === 'google_maps') {
    const companyName = stringValue(obj.title, obj.name, obj.companyName, nestedText(obj.displayName));
    const address = stringValue(obj.address, obj.location, obj.formattedAddress);
    return {
      leadSource,
      leadType: 'business',
      companyName,
      categoryName: stringValue(obj.categoryName, obj.category, nestedText(obj.primaryTypeDisplayName), obj.primaryType),
      address,
      location: address,
      email: stringValue(obj.email, obj.emails),
      website: stringValue(obj.website, obj.websiteUrl, obj.websiteUri),
      phone: stringValue(obj.phone, obj.phoneUnformatted, obj.internationalPhoneNumber, obj.nationalPhoneNumber),
      rating: numberValue(obj.totalScore, obj.rating, obj.stars),
      reviewsCount: numberValue(obj.reviewsCount, obj.reviewCount, obj.userRatingCount),
      placeUrl: stringValue(obj.url, obj.placeUrl, obj.googleMapsUrl, obj.googleMapsUri),
      rawJson,
    };
  }

  const snl = record(obj.salesNavLead);
  const currentPosition = record(obj.currentPosition);
  const profileData = record(obj.profileData);
  const profile = record(profileData.profile);
  const firstName = stringValue(snl.firstName, obj.firstName);
  const lastName = stringValue(snl.lastName, obj.lastName);
  const fullName = stringValue(obj.fullName, obj.name, firstName && lastName ? `${firstName} ${lastName}` : undefined);

  let positionTitle: string | undefined;
  let positionCompany: string | undefined;
  if (Array.isArray(snl.currentPositions) && snl.currentPositions.length > 0) {
    const firstPos = record(snl.currentPositions[0]);
    positionTitle = stringValue(firstPos.title);
    positionCompany = stringValue(firstPos.companyName);
  }

  return {
    leadSource,
    leadType: 'person',
    fullName,
    firstName,
    lastName,
    jobTitle: stringValue(
      obj.jobTitle,
      obj.title,
      currentPosition.position,
      currentPosition.title,
      positionTitle,
      obj.headline,
      snl.headline,
      profile.headline
    ),
    companyName: stringValue(
      obj.companyName,
      obj.company,
      obj.currentCompany,
      currentPosition.companyName,
      snl.companyName,
      positionCompany,
      profile.companyName
    ),
    email: stringValue(
      obj.email,
      obj.workEmail,
      obj.emailAddress,
      firstString(obj.emails),
      profile.email,
      profile.workEmail,
      firstString(profile.emails)
    ),
    phone: stringValue(obj.phone),
    profileUrl: stringValue(
      obj.profileUrl,
      obj.linkedinUrl,
      obj.url,
      obj.linkedInProfileUrl,
      profile.linkedinUrl
    ),
    location: stringValue(obj.location, snl.geoRegion, profile.location),
    connectionDegree: stringValue(obj.connectionDegree),
    rawJson,
  };
}
