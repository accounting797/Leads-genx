import { describe, expect, it } from 'vitest';
import { limitsForUser, outputModeAllowed, TIER_LIMITS, ADMIN_LIMITS } from '../../src/domain/tierLimits';
import type { AuthUser } from '../../src/domain/auth';

const standardUser: AuthUser = { id: 2, username: 'std', role: 'USER', tier: 'STANDARD', status: 'ACTIVE' };
const hybridUser: AuthUser = { id: 3, username: 'hyb', role: 'USER', tier: 'HYBRID', status: 'ACTIVE' };
const adminUser: AuthUser = { id: 1, username: 'adm', role: 'ADMIN', tier: 'STANDARD', status: 'ACTIVE' };

describe('limitsForUser', () => {
  it('gives standard users the standard caps', () => {
    expect(limitsForUser(standardUser)).toEqual(TIER_LIMITS.STANDARD);
    expect(TIER_LIMITS.STANDARD.hybridAllowed).toBe(false);
  });

  it('gives hybrid users the hybrid caps', () => {
    expect(limitsForUser(hybridUser)).toEqual(TIER_LIMITS.HYBRID);
    expect(TIER_LIMITS.HYBRID.hybridAllowed).toBe(true);
  });

  it('admins are effectively unlimited regardless of stored tier', () => {
    expect(limitsForUser(adminUser)).toEqual(ADMIN_LIMITS);
    expect(ADMIN_LIMITS.runsPerDay).toBeGreaterThan(1000000);
  });

  it('null user (auth disabled) behaves like full access legacy mode', () => {
    expect(limitsForUser(null)).toEqual(TIER_LIMITS.HYBRID);
  });
});

describe('outputModeAllowed', () => {
  it('blocks hybrid_max for standard users and allows everything else', () => {
    expect(outputModeAllowed(standardUser, 'hybrid_max')).toBe(false);
    expect(outputModeAllowed(standardUser, 'standard')).toBe(true);
    expect(outputModeAllowed(standardUser, undefined)).toBe(true);
    expect(outputModeAllowed(hybridUser, 'hybrid_max')).toBe(true);
    expect(outputModeAllowed(adminUser, 'hybrid_max')).toBe(true);
    expect(outputModeAllowed(null, 'hybrid_max')).toBe(true);
  });
});
