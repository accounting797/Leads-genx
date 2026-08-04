import { classifyContact } from '../contactClassifier';
import { visibleDomainProvider } from './providerCatalog';

export type PublicContactSource = 'listing_email_field' | 'business_website' | 'public_document';

export interface PublicContactCandidate {
  email: string;
}

export interface PublicContactEvidence {
  website?: string;
  text?: string;
  contactSource?: PublicContactSource;
  exactEmailPublished?: boolean;
}

export interface ContactAssociationDecision {
  accepted: boolean;
  reason: 'organization_domain' | 'explicitly_published_consumer' | 'unassociated' | 'invalid_contact';
}

const INVALID_REASONS = new Set(['malformed', 'placeholder', 'automated_mailbox', 'telemetry_address', 'asset_artifact']);
const NEGATIVE_CONTEXT = /\b(?:developer|example|sample|test|placeholder|demo|dummy)\b/i;
const CONTACT_CONTEXT = /\b(?:contact|email|e-mail|owner|sales|support|office|manager|director|reach|enquir|inquir|phone)\b/i;

function emailContext(text: string, email: string): string {
  const normalized = text.toLowerCase();
  const index = normalized.indexOf(email.toLowerCase());
  if (index < 0) return '';
  return text.slice(Math.max(0, index - 120), Math.min(text.length, index + email.length + 120));
}

export function associatePublicContact(
  candidate: PublicContactCandidate,
  evidence: PublicContactEvidence,
): ContactAssociationDecision {
  const classified = classifyContact(candidate.email, evidence.website);
  if (INVALID_REASONS.has(classified.reason)) return { accepted: false, reason: 'invalid_contact' };
  if (classified.quality === 'qualified' && classified.reason === 'business_domain_match') {
    return { accepted: true, reason: 'organization_domain' };
  }

  const consumerProvider = visibleDomainProvider(candidate.email);
  if (!consumerProvider || !evidence.exactEmailPublished || !evidence.contactSource) {
    return { accepted: false, reason: 'unassociated' };
  }

  if (evidence.text) {
    const context = emailContext(evidence.text, classified.normalizedEmail);
    if (!context || NEGATIVE_CONTEXT.test(context) || !CONTACT_CONTEXT.test(context)) {
      return { accepted: false, reason: 'unassociated' };
    }
  }
  return { accepted: true, reason: 'explicitly_published_consumer' };
}
