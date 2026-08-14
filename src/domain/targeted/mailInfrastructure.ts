import { TargetedQualityTier, VerificationDepth } from './types';

export interface MxRecord {
  exchange: string;
  priority: number;
}

export interface MxResolver {
  resolveMx(domain: string): Promise<MxRecord[]>;
}

export interface MailInfrastructureResult {
  email: string;
  domain?: string;
  depth: VerificationDepth;
  infrastructureProviders: string[];
  mxHosts: string[];
  mxValid: boolean;
  tier: TargetedQualityTier;
  reason: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NO_REPLY = /^(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon)$/i;
const PLACEHOLDER_LOCAL = /^(?:test|testing|example|sample|fake)$/i;
const PLACEHOLDER_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'test.com', 'invalid.com']);
const DISPOSABLE_DOMAINS = new Set(['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'yopmail.com']);

function result(email: string, partial: Omit<MailInfrastructureResult, 'email'>): MailInfrastructureResult {
  return { email, ...partial };
}

export async function classifyMailInfrastructure(
  value: string,
  _resolver?: MxResolver,
  _timeoutMs?: number,
): Promise<MailInfrastructureResult> {
  const email = value.trim().toLowerCase();
  const [local = '', domain = ''] = email.split('@');
  const base = { domain: domain || undefined, depth: 'syntax' as const, infrastructureProviders: [], mxHosts: [], mxValid: false };
  if (!EMAIL.test(email)) return result(email, { ...base, tier: 'rejected', reason: 'invalid_syntax' });
  if (NO_REPLY.test(local)) return result(email, { ...base, tier: 'rejected', reason: 'no_reply_address' });
  if (PLACEHOLDER_LOCAL.test(local) || PLACEHOLDER_DOMAINS.has(domain)) {
    return result(email, { ...base, tier: 'rejected', reason: 'placeholder_address' });
  }
  if (DISPOSABLE_DOMAINS.has(domain)) return result(email, { ...base, tier: 'rejected', reason: 'disposable_domain' });
  return result(email, { ...base, tier: 'strict', reason: 'syntax_valid' });
}
