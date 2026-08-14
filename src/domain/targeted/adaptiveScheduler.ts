import { TargetedWorkUnitRecord } from './types';

export interface WorkPerformanceMetric {
  workKey: string;
  connector: string;
  documentType: string;
  country: 'US' | 'CA';
  region: string;
  city: string;
  processed: number;
  unique: number;
  strict: number;
  rejected: number;
  foreign: number;
  duplicates: number;
  failures: number;
  elapsedMs: number;
}

export type RankedWorkUnit = TargetedWorkUnitRecord & { priority: number; priorityReason: string };

function related(unit: TargetedWorkUnitRecord, metric: WorkPerformanceMetric): boolean {
  return unit.connector === metric.connector
    && unit.documentType === metric.documentType
    && unit.geography.country === metric.country;
}

export function rankPendingWork(
  units: TargetedWorkUnitRecord[],
  metrics: WorkPerformanceMetric[],
): RankedWorkUnit[] {
  return units.map((unit, originalIndex) => {
    const history = metrics.filter((metric) => related(unit, metric));
    if (!history.length) {
      const explorationPriority = unit.connector === 'public_document' ? 120 : 15;
      return { ...unit, priority: explorationPriority, priorityReason: 'Exploration bonus for an unseen source and document combination.', originalIndex };
    }
    const totals = history.reduce((sum, metric) => ({
      processed: sum.processed + metric.processed, unique: sum.unique + metric.unique,
      strict: sum.strict + metric.strict, rejected: sum.rejected + metric.rejected,
      foreign: sum.foreign + metric.foreign, duplicates: sum.duplicates + metric.duplicates,
      failures: sum.failures + metric.failures, elapsedMs: sum.elapsedMs + metric.elapsedMs,
    }), { processed: 0, unique: 0, strict: 0, rejected: 0, foreign: 0, duplicates: 0, failures: 0, elapsedMs: 0 });
    const denominator = Math.max(1, totals.processed);
    const strictRate = totals.strict / denominator;
    const uniqueRate = totals.unique / denominator;
    const rejectedRate = totals.rejected / denominator;
    const foreignRate = totals.foreign / denominator;
    const duplicateRate = totals.duplicates / denominator;
    const priority = strictRate * 100 + uniqueRate * 25 - rejectedRate * 35
      - foreignRate * 100 - duplicateRate * 15 - totals.failures * 30
      - (totals.elapsedMs / Math.max(1, history.length)) / 10_000;
    return {
      ...unit, priority, originalIndex,
      priorityReason: `Historical Valid yield ${(strictRate * 100).toFixed(1)}%, unique ${(uniqueRate * 100).toFixed(1)}%, rejected ${(rejectedRate * 100).toFixed(1)}%.`,
    };
  }).sort((a, b) => b.priority - a.priority || a.originalIndex - b.originalIndex)
    .map(({ originalIndex: _originalIndex, ...unit }) => unit);
}

export function metricForWorkUnit(
  unit: TargetedWorkUnitRecord,
  counts: { processed: number; unique: number; strict: number; rejected: number; foreign?: number; failures?: number; elapsedMs: number },
): WorkPerformanceMetric {
  return {
    workKey: unit.workKey, connector: unit.connector, documentType: unit.documentType,
    country: unit.geography.country, region: unit.geography.state, city: unit.geography.city,
    processed: counts.processed, unique: counts.unique, strict: counts.strict,
    rejected: counts.rejected, foreign: counts.foreign ?? 0,
    duplicates: Math.max(0, counts.processed - counts.unique), failures: counts.failures ?? 0,
    elapsedMs: Math.max(0, counts.elapsedMs),
  };
}
