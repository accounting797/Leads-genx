import { describe, expect, it } from 'vitest';
import { rankPendingWork, WorkPerformanceMetric } from '../../../src/domain/targeted/adaptiveScheduler';
import { TargetedWorkUnitRecord } from '../../../src/domain/targeted/types';

function unit(workKey: string, documentType: string, city = 'Phoenix'): TargetedWorkUnitRecord {
  return {
    id: Math.floor(Math.random() * 10_000), campaignId: 1, workKey, connector: documentType === 'html' ? 'public_web' : 'public_document',
    query: `phone 602 ${city} AZ 85001 aviation filetype:${documentType}`, documentType,
    geography: { country: 'US', areaCode: '602', state: 'AZ', city, postalCode: '85001' },
    status: 'pending', resultCount: 0,
  };
}

describe('rankPendingWork', () => {
  it('prioritizes combinations with high unique Strict yield', () => {
    const metrics: WorkPerformanceMetric[] = [
      { workKey: 'old-csv', connector: 'public_document', documentType: 'csv', country: 'US', region: 'AZ', city: 'Phoenix', processed: 100, unique: 80, strict: 70, rejected: 10, foreign: 0, duplicates: 20, failures: 0, elapsedMs: 1000 },
      { workKey: 'old-pdf', connector: 'public_document', documentType: 'pdf', country: 'US', region: 'AZ', city: 'Phoenix', processed: 100, unique: 20, strict: 5, rejected: 80, foreign: 20, duplicates: 80, failures: 0, elapsedMs: 3000 },
    ];
    const ranked = rankPendingWork([unit('next-pdf', 'pdf'), unit('next-csv', 'csv')], metrics);
    expect(ranked[0]).toMatchObject({ workKey: 'next-csv' });
    expect(ranked[0].priorityReason).toMatch(/Valid yield/i);
  });

  it('preserves an exploration bonus for unseen combinations', () => {
    const ranked = rankPendingWork([unit('known', 'csv'), unit('unseen', 'docx', 'Tucson')], [{
      workKey: 'old-csv', connector: 'public_document', documentType: 'csv', country: 'US', region: 'AZ', city: 'Phoenix',
      processed: 10, unique: 5, strict: 2, rejected: 5, foreign: 0, duplicates: 5, failures: 0, elapsedMs: 100,
    }]);
    expect(ranked.find((entry) => entry.workKey === 'unseen')?.priorityReason).toMatch(/exploration/i);
  });

  it('explores unseen public documents before another unseen maps search', () => {
    const ranked = rankPendingWork([unit('html', 'html'), unit('xlsx', 'xlsx'), unit('pdf', 'pdf')], []);
    expect(ranked.slice(0, 2).map((entry) => entry.documentType)).toEqual(['xlsx', 'pdf']);
  });
});
