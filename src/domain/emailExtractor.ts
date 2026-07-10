import { NormalizedLead } from './types';

export interface EmailExtractor {
  extract(url: string): Promise<string[]>;
}

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const BAD_SUFFIXES = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];

function normalizeEmail(email: string): string | undefined {
  const cleaned = email.trim().toLowerCase().replace(/[),.;:]+$/, '');
  if (!cleaned.includes('@')) return undefined;
  if (BAD_SUFFIXES.some((suffix) => cleaned.endsWith(suffix))) return undefined;
  return cleaned;
}

function deobfuscate(text: string): string {
  return text
    .replace(/\s*(?:\[at\]|\(at\)|\bat\b)\s*/gi, '@')
    .replace(/\s*(?:\[dot\]|\(dot\)|\bdot\b)\s*/gi, '.');
}

export function extractEmailsFromText(text: string): string[] {
  const seen = new Set<string>();
  const source = deobfuscate(text);
  for (const match of source.matchAll(EMAIL_PATTERN)) {
    const email = normalizeEmail(match[0]);
    if (email) seen.add(email);
  }
  return Array.from(seen);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function runWorker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, runWorker);
  await Promise.all(workers);
  return results;
}

function cloneWithEmail(lead: NormalizedLead, email: string): NormalizedLead {
  return {
    ...lead,
    email,
  };
}

export async function keepEmailLeadsOnly(
  leads: NormalizedLead[],
  extractor?: EmailExtractor,
  concurrency = 25
): Promise<NormalizedLead[]> {
  const candidates = await mapWithConcurrency(leads, concurrency, async (lead) => {
    const emails = new Set<string>();
    const existing = lead.email ? normalizeEmail(lead.email) : undefined;
    if (existing) emails.add(existing);

    if (extractor && lead.website) {
      try {
        for (const email of await extractor.extract(lead.website)) {
          const normalized = normalizeEmail(email);
          if (normalized) emails.add(normalized);
        }
      } catch {
        // Site-level failures should not fail the whole lead run.
      }
    }

    return Array.from(emails).map((email) => cloneWithEmail(lead, email));
  });

  const byEmail = new Map<string, NormalizedLead>();
  for (const lead of candidates.flat()) {
    if (lead.email && !byEmail.has(lead.email)) byEmail.set(lead.email, lead);
  }
  return Array.from(byEmail.values());
}

export class WebsiteEmailExtractor implements EmailExtractor {
  constructor(
    private readonly options: {
      maxPagesPerSite?: number;
      timeoutMs?: number;
    } = {}
  ) {}

  async extract(url: string): Promise<string[]> {
    const target = new URL(url);
    const paths = [target.pathname, '/contact', '/contact-us', '/about', '/about-us'];
    const urls = Array.from(
      new Set(
        paths
          .slice(0, this.options.maxPagesPerSite ?? 5)
          .map((path) => new URL(path || '/', target.origin).toString())
      )
    );
    const emails = new Set<string>();

    for (const pageUrl of urls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 8000);
      try {
        const response = await fetch(pageUrl, {
          redirect: 'follow',
          signal: controller.signal,
          headers: { 'user-agent': 'Leads-GenX/1.0 email discovery' },
        });
        if (!response.ok) continue;
        const html = await response.text();
        for (const email of extractEmailsFromText(html.slice(0, 750_000))) emails.add(email);
      } finally {
        clearTimeout(timer);
      }
    }

    return Array.from(emails);
  }
}
