import { describe, expect, it } from 'vitest';
import { TargetedValidationError, validateTargetedDraft } from '../../../src/domain/targeted/validation';

describe('validateTargetedDraft', () => {
  it('parses one combined target and accepts the adjustable 50-contact ceiling', () => {
    expect(validateTargetedDraft({
      prompt: 'Comcast business contacts around Phoenix for an IT campaign',
      mode: 'other',
      country: 'US',
      areaCodes: ['602'],
      states: ['AZ'],
      cities: ['Phoenix'],
      postalCodes: ['85001'],
      maxContactsPerCompany: 50,
      visibleProviders: ['comcast'],
      infrastructureProviders: ['microsoft_365'],
    })).toMatchObject({
      mode: 'other',
      country: 'US',
      maxContactsPerCompany: 50,
      maxResults: 1_000,
    });
  });

  it('rejects consumer-bank targeting', () => {
    expect(() => validateTargetedDraft({
      prompt: 'Chase account holders', mode: 'bank', bankIds: ['chase'],
    })).toThrow(/public business contacts/i);
  });

  it('returns field errors for bounds and unsupported providers', () => {
    try {
      validateTargetedDraft({
        prompt: 'IT leads',
        mode: 'office',
        country: 'US',
        maxContactsPerCompany: 51,
        visibleProviders: ['made_up_mail'],
      });
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(TargetedValidationError);
      expect((error as TargetedValidationError).fields).toMatchObject({
        maxContactsPerCompany: expect.any(String),
        visibleProviders: expect.any(String),
      });
    }
  });

  it('accepts 100 aligned market substitutions and automatically describes bank mode', () => {
    const markets = Array.from({ length: 100 }, (_, index) => String(index));
    const input = validateTargetedDraft({
      prompt: '', mode: 'bank', country: 'US', bankIds: ['chase'],
      areaCodes: markets.map((value) => `2${value.padStart(2, '0')}`),
      cities: markets.map((value) => `City ${value}`), states: markets.map(() => 'TX'),
      postalCodes: markets.map((value) => `75${value.padStart(3, '0')}`),
    });
    expect(input.prompt).toMatch(/public business contacts/i);
    expect(input.cities).toHaveLength(100);
    expect(input.publicSearchRequestBudget).toBe(1200);
  });
});
