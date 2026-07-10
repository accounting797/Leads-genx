import { describe, expect, it } from 'vitest';
import { extractEmailsFromText, keepEmailLeadsOnly } from '../../src/domain/emailExtractor';
import { NormalizedLead } from '../../src/domain/types';

describe('extractEmailsFromText', () => {
  it('extracts, normalizes, and dedupes direct and obfuscated emails', () => {
    const emails = extractEmailsFromText(
      'Email Sales@Example.com, sales@example.com, support [at] example [dot] com and logo@example.com.png'
    );

    expect(emails).toEqual(['sales@example.com', 'support@example.com']);
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
