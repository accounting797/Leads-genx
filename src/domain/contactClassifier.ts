export type ContactReason =
  | 'business_domain_match'
  | 'valid_without_business_domain'
  | 'malformed'
  | 'placeholder'
  | 'automated_mailbox'
  | 'telemetry_address'
  | 'asset_artifact'
  | 'unassociated_domain';

export interface ContactDecision {
  normalizedEmail: string;
  quality: 'qualified' | 'raw';
  reason: ContactReason;
}

const EMAIL_EXACT_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const ASSET_SUFFIXES = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
const AUTOMATED_LOCAL_PART = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster)$/i;
const TELEMETRY_DOMAIN =
  /(?:^|\.)(?:ingest(?:\.[a-z0-9-]+)*\.sentry\.io|sentry\.io|sentry\.wixpress\.com)$/i;
const PLACEHOLDER_LOCAL_PARTS = new Set(['yourname', 'email', 'user']);

function websiteHostname(website?: string): string | undefined {
  if (!website) return undefined;
  try {
    return new URL(website).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

export function classifyContact(email: string, website?: string): ContactDecision {
  const normalizedEmail = email.trim().toLowerCase().replace(/[),.;:]+$/, '');

  if (ASSET_SUFFIXES.some((suffix) => normalizedEmail.endsWith(suffix))) {
    return { normalizedEmail, quality: 'raw', reason: 'asset_artifact' };
  }

  const [localPart, domain] = normalizedEmail.split('@');
  if (
    !EMAIL_EXACT_PATTERN.test(normalizedEmail) ||
    !localPart ||
    !domain ||
    localPart.length > 64 ||
    domain.length > 253
  ) {
    return { normalizedEmail, quality: 'raw', reason: 'malformed' };
  }

  if (TELEMETRY_DOMAIN.test(domain)) {
    return { normalizedEmail, quality: 'raw', reason: 'telemetry_address' };
  }

  if (AUTOMATED_LOCAL_PART.test(localPart)) {
    return { normalizedEmail, quality: 'raw', reason: 'automated_mailbox' };
  }

  if (
    PLACEHOLDER_LOCAL_PARTS.has(localPart) ||
    domain.endsWith('.invalid') ||
    domain.endsWith('.local')
  ) {
    return { normalizedEmail, quality: 'raw', reason: 'placeholder' };
  }

  const host = websiteHostname(website);
  if (host) {
    const associated =
      domain === host || domain.endsWith(`.${host}`) || host.endsWith(`.${domain}`);
    return associated
      ? { normalizedEmail, quality: 'qualified', reason: 'business_domain_match' }
      : { normalizedEmail, quality: 'raw', reason: 'unassociated_domain' };
  }

  return { normalizedEmail, quality: 'qualified', reason: 'valid_without_business_domain' };
}
