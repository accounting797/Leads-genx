import { describe, expect, it } from 'vitest';
import { derivePromptIntent } from '../../../src/domain/targeted/promptIntent';

describe('derivePromptIntent', () => {
  it('turns the requested industries into explicit query intent', () => {
    expect(derivePromptIntent('public logistics, aviation and power industries')).toEqual({
      keywords: ['logistics', 'aviation', 'power'],
      industries: ['logistics', 'aviation', 'power'],
    });
  });

  it('removes discovery, bank, and contact filler words', () => {
    const result = derivePromptIntent('Find public business email contacts near Chase bank branches for freight forwarding companies');
    expect(result.keywords).toContain('freight forwarding');
    expect(result.keywords).not.toEqual(expect.arrayContaining(['public', 'business', 'email', 'chase', 'bank', 'branches']));
  });
});
