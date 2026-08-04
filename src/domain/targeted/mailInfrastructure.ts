import { resolveMx as nodeResolveMx } from 'node:dns/promises';
import { mxInfrastructureProvider } from './providerCatalog';
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

const DEFAULT_RESOLVER: MxResolver = { resolveMx: nodeResolveMx };
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
  resolver: MxResolver = DEFAULT_RESOLVER,
  timeoutMs = 5_000,
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

  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('MX resolver timeout'), { code: 'ETIMEOUT' })), timeoutMs);
    });
    const records = await Promise.race([resolver.resolveMx(domain), timeout]);
    const mxHosts = records.map((record) => record.exchange.trim().toLowerCase().replace(/\.+$/, '')).filter(Boolean);
    if (!mxHosts.length) return result(email, { ...base, tier: 'rejected', reason: 'no_mx_records' });
    const infrastructureProviders = mxInfrastructureProvider(mxHosts).map((provider) => provider.id);
    return result(email, {
      domain, depth: 'domain_mx', infrastructureProviders, mxHosts, mxValid: true,
      tier: 'strict', reason: 'mx_valid',
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEOUT') return result(email, { ...base, tier: 'review', reason: 'resolver_timeout' });
    if (['ENOTFOUND', 'ENODATA', 'ENONAME', 'NXDOMAIN'].includes(code ?? '')) {
      return result(email, { ...base, tier: 'rejected', reason: 'domain_has_no_mx' });
    }
    return result(email, { ...base, tier: 'review', reason: 'resolver_error' });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
