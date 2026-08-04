import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('targeted scraping persistence schema', () => {
  const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');

  it.each([
    'TargetedCampaign',
    'TargetedWorkUnit',
    'TargetedSourceArtifact',
    'TargetedCandidate',
    'TargetedEvidence',
    'TargetedVerification',
    'TargetedEvent',
  ])('defines the %s model', (model) => {
    expect(schema).toMatch(new RegExp(`model\\s+${model}\\s+\\{`));
  });

  it('relates campaigns to users and deduplicates candidates per campaign', () => {
    expect(schema).toContain('targetedCampaigns TargetedCampaign[]');
    expect(schema).toContain('@@unique([campaignId, normalizedEmail])');
  });
});
