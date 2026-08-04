import { describe, expect, it } from 'vitest';
import { classifyMailInfrastructure } from '../../../src/domain/targeted/mailInfrastructure';

describe('classifyMailInfrastructure', () => {
  it('classifies valid MX without claiming mailbox verification', async () => {
    const resolver = { resolveMx: async () => [{ exchange: 'tenant.mail.protection.outlook.com', priority: 0 }] };
    expect(await classifyMailInfrastructure('person@acme.example', resolver)).toMatchObject({
      depth: 'domain_mx', infrastructureProviders: ['microsoft_365'], mxValid: true, tier: 'strict',
    });
  });

  it('rejects no-reply and disposable contacts before DNS', async () => {
    const resolver = { resolveMx: async () => [{ exchange: 'mx.example', priority: 0 }] };
    expect(await classifyMailInfrastructure('no-reply@acme.com', resolver)).toMatchObject({ tier: 'rejected', reason: 'no_reply_address' });
    expect(await classifyMailInfrastructure('person@mailinator.com', resolver)).toMatchObject({ tier: 'rejected', reason: 'disposable_domain' });
  });

  it('places resolver timeouts in review rather than strict', async () => {
    const resolver = { resolveMx: async () => new Promise<never>(() => undefined) };
    expect(await classifyMailInfrastructure('person@acme.example', resolver, 5)).toMatchObject({
      depth: 'syntax', mxValid: false, tier: 'review', reason: 'resolver_timeout',
    });
  });
});
