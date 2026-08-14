import { describe, expect, it } from 'vitest';
import { classifyMailInfrastructure } from '../../../src/domain/targeted/mailInfrastructure';

describe('classifyMailInfrastructure', () => {
  const resolver = { resolveMx: async () => { throw new Error('resolver must not run'); } };

  it('classifies qualifying business and consumer addresses as syntax-valid without DNS', async () => {
    await expect(classifyMailInfrastructure('person@acme.com', resolver)).resolves.toMatchObject({
      depth: 'syntax', mxValid: false, tier: 'strict', reason: 'syntax_valid',
    });
    await expect(classifyMailInfrastructure('owner@gmail.com', resolver)).resolves.toMatchObject({
      depth: 'syntax', mxValid: false, tier: 'strict', reason: 'syntax_valid',
    });
  });

  it('rejects malformed, placeholder, disposable, and no-reply contacts before DNS', async () => {
    await expect(classifyMailInfrastructure('not-an-email', resolver)).resolves.toMatchObject({ tier: 'rejected', reason: 'invalid_syntax' });
    await expect(classifyMailInfrastructure('test@acme.com', resolver)).resolves.toMatchObject({ tier: 'rejected', reason: 'placeholder_address' });
    expect(await classifyMailInfrastructure('no-reply@acme.com', resolver)).toMatchObject({ tier: 'rejected', reason: 'no_reply_address' });
    expect(await classifyMailInfrastructure('person@mailinator.com', resolver)).toMatchObject({ tier: 'rejected', reason: 'disposable_domain' });
  });
});
