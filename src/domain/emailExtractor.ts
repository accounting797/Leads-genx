import { classifyContact } from './contactClassifier';
import { ContactQuality, NormalizedLead } from './types';

export interface EmailExtractor {
  extract(url: string): Promise<string[]>;
}

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const CONTACT_PATHS = [
  '/',
  '/contact',
  '/contact-us',
  '/contacts',
  '/request-quote',
  '/quote',
  '/get-a-quote',
  '/branches',
  '/branch-directory',
  '/about',
  '/about-us',
  '/team',
  '/staff',
  '/leadership',
  '/sales',
  '/support',
  '/locations',
  '/services',
  '/service-areas',
  '/directory',
  '/locations/contact',
];
const CONTACT_LINK_PATTERN = /\b(contact|about|team|staff|sales|support|location|locations|leadership|quote|request quote|get a quote|service|services|branch|branches|directory|office|offices)\b/i;
const HREF_PATTERN = /\bhref\s*=\s*["']([^"']+)["']/gi;

export function isQualifiedLeadEmail(email: string): boolean {
  return classifyContact(email).quality === 'qualified';
}

function normalizeCandidate(email: string): string | undefined {
  const cleaned = email.trim().toLowerCase().replace(/[),.;:]+$/, '');
  return cleaned.includes('@') ? cleaned : undefined;
}

function deobfuscate(text: string): string {
  return text
    .replace(/\s*(?:\[at\]|\(at\)|\bat\b)\s*/gi, '@')
    .replace(/\s*(?:\[dot\]|\(dot\)|\bdot\b)\s*/gi, '.');
}

export function extractEmailCandidatesFromText(text: string): string[] {
  const seen = new Set<string>();
  const source = deobfuscate(text);
  for (const match of source.matchAll(EMAIL_PATTERN)) {
    const candidate = normalizeCandidate(match[0]);
    if (candidate) seen.add(candidate);
  }
  return Array.from(seen);
}

export function extractEmailsFromText(text: string): string[] {
  return extractEmailCandidatesFromText(text)
    .map((email) => classifyContact(email))
    .filter((decision) => decision.quality === 'qualified')
    .map((decision) => decision.normalizedEmail);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&#64;|&commat;/gi, '@')
    .replace(/&#46;|&period;/gi, '.');
}

function extractMailtoEmails(text: string): string[] {
  const emails = new Set<string>();
  for (const match of text.matchAll(/\bmailto:([^"'<>\s?]+)/gi)) {
    const decoded = decodeURIComponent(decodeHtmlEntities(match[1]));
    for (const email of extractEmailsFromText(decoded)) emails.add(email);
  }
  return Array.from(emails);
}

function discoverInternalContactUrls(html: string, baseUrl: URL): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(HREF_PATTERN)) {
    const href = decodeHtmlEntities(match[1].trim());
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:')) continue;

    try {
      const url = new URL(href, baseUrl);
      if (url.origin !== baseUrl.origin) continue;
      const searchable = `${url.pathname} ${url.search}`.replace(/[-_]/g, ' ');
      if (CONTACT_LINK_PATTERN.test(searchable)) {
        url.hash = '';
        urls.add(url.toString());
      }
    } catch {
      // Ignore malformed links discovered on third-party sites.
    }
  }
  return Array.from(urls);
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

export type ClassifiedContactLead = NormalizedLead & {
  normalizedEmail: string;
  contactQuality: ContactQuality;
  qualityReason: string;
};

export async function collectContactCandidates(
  lead: NormalizedLead,
  extractor?: EmailExtractor
): Promise<ClassifiedContactLead[]> {
  const decisions = new Map<string, { normalizedEmail: string; quality: ContactQuality; reason: string }>();

  const addCandidate = (candidate?: string) => {
    if (!candidate) return;
    const decision = classifyContact(candidate, lead.website);
    if (!decisions.has(decision.normalizedEmail)) decisions.set(decision.normalizedEmail, decision);
  };

  addCandidate(lead.email);

  if (extractor && lead.website) {
    try {
      for (const email of await extractor.extract(lead.website)) addCandidate(email);
    } catch {
      // Site-level failures should not fail the whole lead run.
    }
  }

  return Array.from(decisions.values()).map((decision) => ({
    ...lead,
    email: decision.normalizedEmail,
    normalizedEmail: decision.normalizedEmail,
    contactQuality: decision.quality,
    qualityReason: decision.reason,
  }));
}

export async function keepEmailLeadsOnly(
  leads: NormalizedLead[],
  extractor?: EmailExtractor,
  concurrency = 25
): Promise<NormalizedLead[]> {
  const candidates = await mapWithConcurrency(leads, concurrency, (lead) =>
    collectContactCandidates(lead, extractor)
  );

  const byEmail = new Map<string, NormalizedLead>();
  for (const lead of candidates.flat()) {
    if (lead.contactQuality !== 'qualified') continue;
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
    const pageLimit = this.options.maxPagesPerSite ?? 12;
    const urls = Array.from(
      new Set(
        [target.pathname || '/', ...CONTACT_PATHS].map((path) =>
          new URL(path || '/', target.origin).toString()
        )
      )
    );
    const emails = new Set<string>();

    for (let index = 0; index < urls.length && index < pageLimit; index += 1) {
      const pageUrl = urls[index];
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
        const source = html.slice(0, 750_000);
        for (const email of extractEmailsFromText(source)) emails.add(email);
        for (const email of extractMailtoEmails(source)) emails.add(email);
        if (index === 0) {
          const discoveredUrls = discoverInternalContactUrls(source, new URL(pageUrl));
          for (const discoveredUrl of discoveredUrls) {
            const existingIndex = urls.indexOf(discoveredUrl);
            if (existingIndex !== -1) urls.splice(existingIndex, 1);
          }
          urls.splice(index + 1, 0, ...discoveredUrls);
        }
      } finally {
        clearTimeout(timer);
      }
    }

    return Array.from(emails);
  }
}
