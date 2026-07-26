import { describe, expect, it } from 'vitest';
import type { GreenhouseJob } from '../../src/integrations/greenhouseClient';
import {
  buildHiringExplanation,
  classifyHiringJob,
  companyIdentity,
  scoreHiringSignal,
} from '../../src/domain/greenhouseSignals';

function job(
  title: string,
  updatedAt: string,
  location = 'Dallas, TX',
  department = 'Operations',
  id = 1
): GreenhouseJob {
  return {
    id,
    title,
    location,
    departments: [department],
    updatedAt,
    absoluteUrl: `https://boards.greenhouse.io/acme/jobs/${id}`,
  };
}

describe('Greenhouse hiring-signal domain', () => {
  it.each([
    ['Chief Revenue Officer', 'leadership'],
    ['Regional Sales Director', 'sales'],
    ['VP of Operations', 'leadership'],
    ['Supply Chain Manager', 'operations'],
    ['Financial Controller', 'finance'],
    ['Demand Generation Manager', 'marketing'],
  ] as const)('classifies %s as %s', (title, expected) => {
    expect(classifyHiringJob(job(title, '2026-07-24T00:00:00Z'))).toBe(expected);
  });

  it('rejects unrelated roles', () => {
    expect(classifyHiringJob(job('Senior Software Engineer', '2026-07-24T00:00:00Z'))).toBeUndefined();
  });

  it('scores a fresh exact-match multi-department signal transparently', () => {
    const result = scoreHiringSignal({
      jobs: [
        job('VP of Operations', '2026-07-24T00:00:00Z', 'Dallas, TX', 'Operations', 1),
        job('Regional Sales Director', '2026-07-22T00:00:00Z', 'Dallas, TX', 'Sales', 2),
      ],
      requestedGeographies: ['Dallas, TX'],
      industryRelationship: 'exact',
      now: new Date('2026-07-25T00:00:00Z'),
    });

    expect(result.total).toBeGreaterThanOrEqual(70);
    expect(result.components).toEqual({
      roles: 27,
      recency: 25,
      geography: 20,
      industry: 15,
      breadth: 5,
    });
    expect(result.qualifyingJobs).toHaveLength(2);
  });

  it('ignores jobs older than 30 days and invalid dates', () => {
    const result = scoreHiringSignal({
      jobs: [
        job('Chief Revenue Officer', '2026-06-01T00:00:00Z'),
        job('VP of Sales', 'not-a-date', 'Dallas, TX', 'Sales', 2),
      ],
      requestedGeographies: ['Dallas, TX'],
      industryRelationship: 'exact',
      now: new Date('2026-07-25T00:00:00Z'),
    });

    expect(result.qualifyingJobs).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('normalizes domains before company names and strips common legal suffixes', () => {
    expect(companyIdentity({ companyName: 'Acme Holdings, LLC', website: 'https://www.acme.test/about' })).toEqual({
      companyKey: 'domain:acme.test',
      companyDomain: 'acme.test',
      normalizedName: 'acme holdings',
    });
    expect(companyIdentity({ companyName: 'Acme Holdings, LLC' })).toEqual({
      companyKey: 'name:acme holdings',
      normalizedName: 'acme holdings',
    });
  });

  it('explains the evidence as an update rather than inventing a posting date', () => {
    const score = scoreHiringSignal({
      jobs: [job('VP of Sales', '2026-07-23T00:00:00Z', 'Remote', 'Sales')],
      requestedGeographies: ['Dallas, TX'],
      industryRelationship: 'adjacent',
      now: new Date('2026-07-25T00:00:00Z'),
    });

    const explanation = buildHiringExplanation({
      companyName: 'Acme',
      score,
      relationship: 'adjacent',
      now: new Date('2026-07-25T00:00:00Z'),
    });
    expect(explanation).toContain('updated 2 days ago');
    expect(explanation).toContain('adjacent');
    expect(explanation).not.toContain('posted');
  });
});
