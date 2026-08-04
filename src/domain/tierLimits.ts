import type { AuthUser, UserTier } from './auth';
import type { OutputMode } from './types';

export interface TierLimits {
  label: string;
  runsPerDay: number;
  maxResultsPerRun: number;
  hybridAllowed: boolean;
}

export const TIER_LIMITS: Record<UserTier, TierLimits> = {
  STANDARD: {
    label: 'Standard',
    runsPerDay: 5,
    maxResultsPerRun: 1000,
    hybridAllowed: false,
  },
  HYBRID: {
    label: 'Hybrid',
    runsPerDay: 25,
    maxResultsPerRun: 5000,
    hybridAllowed: true,
  },
};

export const ADMIN_LIMITS: TierLimits = {
  label: 'Admin',
  runsPerDay: Number.MAX_SAFE_INTEGER,
  maxResultsPerRun: Number.MAX_SAFE_INTEGER,
  hybridAllowed: true,
};

export function limitsForUser(user: AuthUser | null | undefined): TierLimits {
  if (!user) return TIER_LIMITS.HYBRID; // auth disabled (tests/legacy single-operator)
  if (user.role === 'ADMIN') return ADMIN_LIMITS;
  return TIER_LIMITS[user.tier] ?? TIER_LIMITS.STANDARD;
}

export function outputModeAllowed(user: AuthUser | null | undefined, mode: OutputMode | undefined): boolean {
  if (mode !== 'hybrid_max') return true;
  return limitsForUser(user).hybridAllowed;
}

export function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}
