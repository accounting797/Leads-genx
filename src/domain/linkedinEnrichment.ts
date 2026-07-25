/**
 * LinkedIn lead enrichment via Bright Data.
 *
 * The Sales Navigator extension captures WHO the leads are (name, title,
 * company, profile URL) — Bright Data's contact-enriched people dataset
 * tells us HOW to reach them (email, phone when available). This service
 * takes a run's LinkedIn leads that still lack an email, collects their
 * profiles in batches, and writes the contact data back onto the leads.
 */

import type { PrismaClient } from '@prisma/client';
import {
  BrightDataError,
  LINKEDIN_PERSON_PROFILE_CONTACT_DATASET,
  triggerAndCollect,
} from '../integrations/brightDataClient';

const BATCH_SIZE = 20;

export interface LinkedInEnrichmentDeps {
  apiKey: string;
  collect?: typeof triggerAndCollect;
  now?: () => Date;
}

export interface LinkedInEnrichmentResult {
  attempted: number;
  enriched: number;
  skipped: number;
}

type EnrichmentPrisma = Pick<PrismaClient, 'lead' | 'run' | 'runEvent'>;

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** Bright Data records vary a little by dataset — pull the first usable email. */
export function extractEmail(record: Record<string, unknown>): string | undefined {
  const direct = firstString(record.email, record.personal_email, record.work_email, record.business_email);
  if (direct && direct.includes('@')) return direct.toLowerCase();
  for (const key of ['emails', 'email_addresses']) {
    const list = record[key];
    if (Array.isArray(list)) {
      for (const entry of list) {
        const candidate = typeof entry === 'string' ? entry : firstString((entry as Record<string, unknown>)?.email);
        if (candidate && candidate.includes('@')) return candidate.trim().toLowerCase();
      }
    }
  }
  return undefined;
}

export function extractPhone(record: Record<string, unknown>): string | undefined {
  const direct = firstString(record.phone, record.phone_number, record.mobile, record.mobile_number);
  if (direct) return direct;
  const list = record.phone_numbers;
  if (Array.isArray(list)) {
    for (const entry of list) {
      const candidate = typeof entry === 'string' ? entry : firstString((entry as Record<string, unknown>)?.number);
      if (candidate) return candidate.trim();
    }
  }
  return undefined;
}

function recordProfileUrl(record: Record<string, unknown>): string | undefined {
  return firstString(record.url, record.profile_url, record.linkedin_url, record.input_url, record.id);
}

export async function enrichRunLinkedInLeads(
  prisma: EnrichmentPrisma,
  runId: number,
  deps: LinkedInEnrichmentDeps
): Promise<LinkedInEnrichmentResult> {
  const collect = deps.collect ?? triggerAndCollect;
  const now = deps.now ?? (() => new Date());

  const targets = await prisma.lead.findMany({
    where: { runId, profileUrl: { not: null }, OR: [{ email: null }, { email: '' }] },
    select: { id: true, profileUrl: true },
  });
  const result: LinkedInEnrichmentResult = { attempted: 0, enriched: 0, skipped: 0 };
  if (targets.length === 0) {
    await prisma.runEvent.create({
      data: {
        runId,
        type: 'brightdata_enrichment_skipped',
        message: 'Nova here — every LinkedIn lead in this run already has contact data. Nothing to enrich.',
      },
    });
    return result;
  }

  await prisma.runEvent.create({
    data: {
      runId,
      type: 'brightdata_enrichment_started',
      message: `Nova here — sending ${targets.length} LinkedIn profiles to Bright Data for contact enrichment. I'll report as emails land.`,
    },
  });

  // Emails already present in the run — never create normalizedEmail collisions.
  const existing = await prisma.lead.findMany({
    where: { runId, normalizedEmail: { not: null } },
    select: { normalizedEmail: true },
  });
  const takenEmails = new Set(existing.map((lead) => lead.normalizedEmail as string));

  for (let start = 0; start < targets.length; start += BATCH_SIZE) {
    const batch = targets.slice(start, start + BATCH_SIZE);
    result.attempted += batch.length;
    let records: Array<Record<string, unknown>>;
    try {
      records = await collect({
        apiKey: deps.apiKey,
        datasetId: LINKEDIN_PERSON_PROFILE_CONTACT_DATASET,
        inputs: batch.map((lead) => ({ url: lead.profileUrl as string })),
        onProgress: (message) => {
          void prisma.runEvent
            .create({
              data: {
                runId,
                type: 'brightdata_enrichment_progress',
                message: `Bright Data is working — batch ${Math.floor(start / BATCH_SIZE) + 1}/${Math.ceil(
                  targets.length / BATCH_SIZE
                )} (${message}).`,
              },
            })
            .catch(() => {});
        },
      });
    } catch (error) {
      const bdError = error instanceof BrightDataError ? error : undefined;
      await prisma.runEvent.create({
        data: {
          runId,
          type: 'brightdata_enrichment_failed',
          message: bdError
            ? `Nova hit a snag with Bright Data: ${bdError.message}`
            : 'Nova hit a snag with Bright Data — enrichment stopped early. Everything collected so far is saved.',
        },
      });
      throw error;
    }

    const byUrl = new Map<string, Record<string, unknown>>();
    for (const record of records) {
      const url = recordProfileUrl(record);
      if (url) byUrl.set(url.toLowerCase(), record);
    }

    for (const lead of batch) {
      const record = byUrl.get((lead.profileUrl as string).toLowerCase());
      if (!record) {
        result.skipped += 1;
        continue;
      }
      const email = extractEmail(record);
      const phone = extractPhone(record);
      if (!email && !phone) {
        result.skipped += 1;
        continue;
      }
      if (email && takenEmails.has(email)) {
        result.skipped += 1;
        continue;
      }
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          ...(email ? { email, normalizedEmail: email } : {}),
          ...(phone ? { phone } : {}),
          qualityReason: 'Contact data enriched by Bright Data',
        },
      });
      if (email) takenEmails.add(email);
      result.enriched += 1;
    }

    await prisma.runEvent.create({
      data: {
        runId,
        type: 'brightdata_enrichment_progress',
        message: `Bright Data delivered — ${result.enriched} leads enriched so far (${Math.min(
          start + BATCH_SIZE,
          targets.length
        )}/${targets.length} profiles checked).`,
      },
    });
  }

  const run = await prisma.run.update({
    where: { id: runId },
    data: { lastHeartbeatAt: now() },
  });
  const emailCount = await prisma.lead.count({ where: { runId, normalizedEmail: { not: null } } });
  await prisma.run.update({ where: { id: runId }, data: { leadCount: Math.max(run.leadCount ?? 0, emailCount) } });

  await prisma.runEvent.create({
    data: {
      runId,
      type: 'brightdata_enrichment_completed',
      message: `Nova here — enrichment complete: ${result.enriched} leads now have contact data${
        result.skipped ? ` (${result.skipped} profiles had none available)` : ''
      }. All saved.`,
    },
  });
  return result;
}
