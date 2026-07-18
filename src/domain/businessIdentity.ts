import { NormalizedLead } from './types';

export type BusinessProvenance = 'local' | 'google' | 'apify' | string;

export interface CanonicalBusiness extends NormalizedLead {
  emails?: string[];
  provenance?: BusinessProvenance[];
}

function clean(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function token(value?: string): string | undefined {
  return clean(value)?.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function phoneToken(value?: string): string | undefined {
  const digits = value?.replace(/\D/g, '');
  return digits || undefined;
}

function websiteToken(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return `${url.hostname.replace(/^www\./, '').toLowerCase()}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return token(value);
  }
}

function rawRecord(lead: NormalizedLead): Record<string, unknown> {
  try {
    const parsed = JSON.parse(lead.rawJson ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function rawString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'string' && String(record[key]).trim()) return String(record[key]).trim();
  }
  return undefined;
}

export function businessIdentity(lead: NormalizedLead): string {
  const raw = rawRecord(lead);
  const placeId = rawString(raw, 'id', 'placeId', 'place_id', 'cid');
  if (placeId) return `place:${placeId.toLowerCase()}`;

  const mapsUrl = clean(lead.placeUrl);
  if (mapsUrl) return `maps:${mapsUrl.toLowerCase()}`;

  const website = websiteToken(lead.website);
  const phone = phoneToken(lead.phone);
  if (website && phone) return `website_phone:${website}|${phone}`;
  if (phone) return `phone:${phone}`;

  const name = token(lead.companyName);
  const address = token(lead.address ?? lead.location);
  if (name && address) return `name_address:${name}|${address}`;
  if (website) return `website:${website}`;
  return `raw:${token(lead.rawJson) ?? name ?? address ?? 'unknown'}`;
}

function union(values: Array<string | undefined>): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const cleaned = clean(value);
    if (!cleaned || seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    output.push(cleaned);
  }
  return output;
}

export function mergeBusinesses(current: CanonicalBusiness, incoming: CanonicalBusiness): CanonicalBusiness {
  const merged = { ...current } as CanonicalBusiness;
  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'emails' || key === 'provenance') continue;
    const existing = merged[key as keyof CanonicalBusiness];
    if ((existing === undefined || existing === null || existing === '') && value !== undefined && value !== null && value !== '') {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  merged.emails = union([...(current.emails ?? []), current.email, ...(incoming.emails ?? []), incoming.email]);
  merged.provenance = union([...(current.provenance ?? []), ...(incoming.provenance ?? [])]);
  return merged;
}
