import { resolveMx } from 'dns';
import { promisify } from 'util';

const resolveMxAsync = promisify(resolveMx);

export interface MxRecord {
  exchange: string;
  priority: number;
}

export interface EmailVerificationResult {
  email: string;
  hasMx: boolean;
  mxRecords: MxRecord[];
  mxError?: string;
}

export interface EmailVerifier {
  verifyEmail(email: string): Promise<EmailVerificationResult>;
  verifyEmails(emails: string[], concurrency?: number): Promise<EmailVerificationResult[]>;
}

function extractDomain(email: string): string | null {
  const match = email.match(/@([^\s@]+)$/);
  return match ? match[1].toLowerCase() : null;
}

function deduplicateMxByPriority(records: MxRecord[]): MxRecord[] {
  return records.sort((a, b) => a.priority - b.priority);
}

export function createEmailVerifier(): EmailVerifier {
  const cache = new Map<string, { result: EmailVerificationResult; timestamp: number }>();
  const CACHE_TTL = 5 * 60 * 1000;

  async function verifyDomainMx(domain: string): Promise<EmailVerificationResult> {
    const cached = cache.get(domain);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return { ...cached.result };
    }

    try {
      const records = await resolveMxAsync(domain);
      const mxRecords = deduplicateMxByPriority(
        records.map((r) => ({ exchange: r.exchange, priority: r.priority }))
      );

      const result: EmailVerificationResult = {
        email: '',
        hasMx: mxRecords.length > 0,
        mxRecords,
      };

      cache.set(domain, { result, timestamp: Date.now() });
      return { ...result };
    } catch (error: any) {
      const result: EmailVerificationResult = {
        email: '',
        hasMx: false,
        mxRecords: [],
        mxError: error?.code === 'ENODATA' || error?.code === 'ENOTFOUND'
          ? `No MX records for ${domain}`
          : `DNS lookup failed: ${error?.message ?? error?.code ?? 'unknown'}`,
      };

      cache.set(domain, { result, timestamp: Date.now() });
      return { ...result };
    }
  }

  async function verifyOne(email: string): Promise<EmailVerificationResult> {
    const domain = extractDomain(email);
    if (!domain) {
      return {
        email,
        hasMx: false,
        mxRecords: [],
        mxError: 'Invalid email format — no domain found',
      };
    }

    const result = await verifyDomainMx(domain);
    return { ...result, email };
  }

  return {
    async verifyEmail(email: string): Promise<EmailVerificationResult> {
      return verifyOne(email);
    },

    async verifyEmails(emails: string[], concurrency: number = 20): Promise<EmailVerificationResult[]> {
      const uniqueDomains = new Map<string, string[]>();
      for (const email of emails) {
        const domain = extractDomain(email);
        if (!domain) continue;
        if (!uniqueDomains.has(domain)) uniqueDomains.set(domain, []);
        uniqueDomains.get(domain)!.push(email);
      }

      const results: EmailVerificationResult[] = [];
      const domainEntries = Array.from(uniqueDomains.entries());

      for (let i = 0; i < domainEntries.length; i += concurrency) {
        const chunk = domainEntries.slice(i, i + concurrency);
        const mxResults = await Promise.all(
          chunk.map(async ([domain]) => ({
            domain,
            mx: await verifyDomainMx(domain),
          }))
        );

        for (const { domain, mx } of mxResults) {
          const domainEmails = uniqueDomains.get(domain) ?? [];
          for (const email of domainEmails) {
            results.push({ ...mx, email });
          }
        }
      }

      return results;
    },
  };
}
