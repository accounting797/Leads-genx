import { describe, expect, it } from 'vitest';
import {
  extractEmailsFromText,
  keepEmailLeadsOnly,
  WebsiteEmailExtractor,
} from '../../src/domain/emailExtractor';
import { NormalizedLead } from '../../src/domain/types';

describe('extractEmailsFromText', () => {
  it('extracts, normalizes, and dedupes direct and obfuscated emails', () => {
    const emails = extractEmailsFromText(
      'Email Sales@Example.com, sales@example.com, support [at] example [dot] com and logo@example.com.png'
    );

    expect(emails).toEqual(['sales@example.com', 'support@example.com']);
  });
});

describe('WebsiteEmailExtractor', () => {
  it('extracts decoded mailto emails from fetched pages', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response('<a href="mailto:Sales%40Example.com?subject=Lead">Email sales</a>')) as typeof fetch;

    try {
      const extractor = new WebsiteEmailExtractor({ maxPagesPerSite: 1 });
      await expect(extractor.extract('https://example.com')).resolves.toEqual(['sales@example.com']);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('follows contact-like internal links discovered on the home page', async () => {
    const originalFetch = global.fetch;
    const pages = new Map([
      [
        'https://example.com/',
        '<a href="/leadership">Leadership</a><a href="/contact-sales">Contact sales</a>',
      ],
      ['https://example.com/contact-sales', 'Reach our team at growth@example.com'],
    ]);
    global.fetch = (async (input) => {
      const html = pages.get(String(input));
      return new Response(html ?? '', { status: html ? 200 : 404 });
    }) as typeof fetch;

    try {
      const extractor = new WebsiteEmailExtractor({ maxPagesPerSite: 4 });
      await expect(extractor.extract('https://example.com')).resolves.toEqual(['growth@example.com']);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('keepEmailLeadsOnly', () => {
  const baseLead: NormalizedLead = {
    leadSource: 'google_maps',
    leadType: 'business',
    companyName: 'Gulf Coast Services',
    website: 'https://example.com',
  };

  it('drops leads without an email when no website email is found', async () => {
    const leads = await keepEmailLeadsOnly([
      { ...baseLead, website: undefined },
      { ...baseLead, companyName: 'No Email Co' },
    ]);

    expect(leads).toEqual([]);
  });

  it('expands website emails into one lead per unique email', async () => {
    const leads = await keepEmailLeadsOnly(
      [baseLead],
      {
        async extract() {
          return ['sales@example.com', 'ops@example.com', 'sales@example.com'];
        },
      },
      2
    );

    expect(leads.map((lead) => lead.email)).toEqual(['sales@example.com', 'ops@example.com']);
    expect(leads[0]).toMatchObject({ companyName: 'Gulf Coast Services' });
  });

  it('dedupes existing and extracted emails globally', async () => {
    const leads = await keepEmailLeadsOnly(
      [
        { ...baseLead, email: 'Sales@Example.com' },
        { ...baseLead, companyName: 'Duplicate Email Co', email: 'sales@example.com' },
      ],
      {
        async extract() {
          return ['sales@example.com'];
        },
      },
      2
    );

    expect(leads.map((lead) => lead.email)).toEqual(['sales@example.com']);
    expect(leads[0].companyName).toBe('Gulf Coast Services');
  });
});
