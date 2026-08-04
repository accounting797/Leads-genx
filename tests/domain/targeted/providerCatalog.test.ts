import { describe, expect, it } from 'vitest';
import {
  mxInfrastructureProvider,
  providerCatalog,
  visibleDomainProvider,
} from '../../../src/domain/targeted/providerCatalog';

describe('targeted provider catalog', () => {
  it('matches visible domains exactly and recognizes common aliases', () => {
    expect(visibleDomainProvider('owner@comcast.net')).toMatchObject({ id: 'comcast', group: 'other' });
    expect(visibleDomainProvider('owner@gmail.com')).toMatchObject({ id: 'gmail', group: 'google' });
    expect(visibleDomainProvider('owner@notcomcast.net')).toBeUndefined();
  });

  it('classifies MX infrastructure independently of the visible domain', () => {
    expect(mxInfrastructureProvider(['tenant.mail.protection.outlook.com.']))
      .toContainEqual(expect.objectContaining({ id: 'microsoft_365' }));
    expect(mxInfrastructureProvider(['mx1.barracudanetworks.com']))
      .toContainEqual(expect.objectContaining({ id: 'barracuda' }));
    expect(mxInfrastructureProvider(['aspmx.l.google.com']))
      .toContainEqual(expect.objectContaining({ id: 'google_workspace' }));
  });

  it('exposes a versioned catalog containing the full approved provider families', () => {
    const ids = new Set(providerCatalog().map((entry) => entry.id));
    for (const id of [
      'microsoft_365', 'google_workspace', 'zoho', 'godaddy', 'fastmail',
      'proton_business', 'rackspace', 'mimecast', 'proofpoint', 'cisco_ironport',
      'barracuda', 'spamtitan', 'gmail', 'outlook', 'yahoo', 'aol', 'comcast',
      'att', 'verizon', 'cox', 'spectrum', 'icloud', 'gmx', 'mail_com',
    ]) expect(ids.has(id), id).toBe(true);
    expect(providerCatalog().every((entry) => entry.catalogVersion === '2026-08-03')).toBe(true);
  });
});
