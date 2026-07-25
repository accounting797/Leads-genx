import { describe, expect, it } from 'vitest';
import { enrichRunLinkedInLeads, extractEmail, extractPhone } from '../../src/domain/linkedinEnrichment';

interface FakeLead {
  id: number;
  runId: number;
  profileUrl: string | null;
  email: string | null;
  normalizedEmail: string | null;
  phone: string | null;
  qualityReason?: string | null;
}

function fakePrisma(leads: FakeLead[]) {
  const events: Array<{ type: string; message: string }> = [];
  const prisma = {
    lead: {
      async findMany(args: { where: Record<string, unknown>; select?: unknown }) {
        const where = args.where as { profileUrl?: { not: null }; normalizedEmail?: { not: null }; OR?: unknown };
        return leads.filter((lead) => {
          if (where.profileUrl && !lead.profileUrl) return false;
          if (where.normalizedEmail) return Boolean(lead.normalizedEmail);
          if (where.OR) return !lead.email;
          return true;
        });
      },
      async update(args: { where: { id: number }; data: Partial<FakeLead> }) {
        const lead = leads.find((item) => item.id === args.where.id)!;
        Object.assign(lead, args.data);
        return lead;
      },
      async count(args: { where: { normalizedEmail?: { not: null } } }) {
        return leads.filter((lead) => lead.normalizedEmail).length;
      },
    },
    run: {
      async update() {
        return { leadCount: leads.length };
      },
    },
    runEvent: {
      async create(args: { data: { type: string; message: string } }) {
        events.push(args.data);
        return args.data;
      },
    },
  };
  return { prisma: prisma as never, events, leads };
}

function lead(id: number, overrides: Partial<FakeLead> = {}): FakeLead {
  return {
    id,
    runId: 1,
    profileUrl: `https://www.linkedin.com/in/person-${id}/`,
    email: null,
    normalizedEmail: null,
    phone: null,
    ...overrides,
  };
}

describe('extractEmail / extractPhone', () => {
  it('pulls the first usable email and phone from varied record shapes', () => {
    expect(extractEmail({ email: 'Jane@Acme.com' })).toBe('jane@acme.com');
    expect(extractEmail({ emails: [{ email: 'jane@work.com' }] })).toBe('jane@work.com');
    expect(extractEmail({ personal_email: 'jane@home.com' })).toBe('jane@home.com');
    expect(extractEmail({})).toBeUndefined();
    expect(extractPhone({ phone_numbers: ['+1 555 0100'] })).toBe('+1 555 0100');
    expect(extractPhone({ mobile_number: '+1 555 0101' })).toBe('+1 555 0101');
  });
});

describe('enrichRunLinkedInLeads', () => {
  it('enriches leads with emails and phones and narrates the run', async () => {
    const state = fakePrisma([lead(1), lead(2)]);
    const collect = async () => [
      { url: 'https://www.linkedin.com/in/person-1/', email: 'one@acme.com', phone: '+1 555 0001' },
      { url: 'https://www.linkedin.com/in/person-2/', emails: ['two@acme.com'] },
    ];

    const result = await enrichRunLinkedInLeads(state.prisma, 1, { apiKey: 'bd', collect: collect as never });

    expect(result).toMatchObject({ attempted: 2, enriched: 2, skipped: 0 });
    expect(state.leads[0]).toMatchObject({ email: 'one@acme.com', normalizedEmail: 'one@acme.com', phone: '+1 555 0001' });
    expect(state.leads[1]).toMatchObject({ email: 'two@acme.com' });
    expect(state.events.some((event) => event.type === 'brightdata_enrichment_started')).toBe(true);
    expect(state.events.some((event) => event.type === 'brightdata_enrichment_completed')).toBe(true);
  });

  it('skips profiles Bright Data has no contact data for', async () => {
    const state = fakePrisma([lead(1), lead(2)]);
    const collect = async () => [{ url: 'https://www.linkedin.com/in/person-1/', email: 'one@acme.com' }];

    const result = await enrichRunLinkedInLeads(state.prisma, 1, { apiKey: 'bd', collect: collect as never });

    expect(result).toMatchObject({ attempted: 2, enriched: 1, skipped: 1 });
    expect(state.leads[1].email).toBeNull();
  });

  it('never creates a normalizedEmail collision inside the run', async () => {
    const state = fakePrisma([lead(1, { email: 'taken@acme.com', normalizedEmail: 'taken@acme.com' }), lead(2)]);
    const collect = async () => [{ url: 'https://www.linkedin.com/in/person-2/', email: 'taken@acme.com' }];

    const result = await enrichRunLinkedInLeads(state.prisma, 1, { apiKey: 'bd', collect: collect as never });

    expect(result.enriched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(state.leads[1].normalizedEmail).toBeNull();
  });

  it('reports gracefully when there is nothing to enrich', async () => {
    const state = fakePrisma([lead(1, { email: 'have@acme.com', normalizedEmail: 'have@acme.com' })]);
    const collect = async () => {
      throw new Error('must not be called');
    };

    const result = await enrichRunLinkedInLeads(state.prisma, 1, { apiKey: 'bd', collect: collect as never });

    expect(result).toMatchObject({ attempted: 0, enriched: 0 });
    expect(state.events.some((event) => event.type === 'brightdata_enrichment_skipped')).toBe(true);
  });

  it('narrates failure and stops without losing earlier progress', async () => {
    const state = fakePrisma([lead(1)]);
    const collect = async () => {
      throw new Error('Bright Data exploded');
    };

    await expect(
      enrichRunLinkedInLeads(state.prisma, 1, { apiKey: 'bd', collect: collect as never })
    ).rejects.toThrow('Bright Data exploded');
    expect(state.events.some((event) => event.type === 'brightdata_enrichment_failed')).toBe(true);
  });
});
