import { describe, expect, it } from 'vitest';
import { associatePublicContact } from '../../../src/domain/targeted/publicContactAssociation';

describe('associatePublicContact', () => {
  it('accepts a consumer-provider address explicitly published as a business contact', () => {
    expect(associatePublicContact({ email: 'owner@gmail.com' }, {
      website: 'https://acme.example/contact', text: 'Email our owner: owner@gmail.com',
      contactSource: 'business_website', exactEmailPublished: true,
    })).toMatchObject({ accepted: true, reason: 'explicitly_published_consumer' });
  });

  it('rejects an unrelated example consumer address', () => {
    expect(associatePublicContact({ email: 'random@gmail.com' }, {
      website: 'https://acme.example', text: 'Developer example: random@gmail.com',
      contactSource: 'business_website', exactEmailPublished: true,
    })).toMatchObject({ accepted: false, reason: 'unassociated' });
  });

  it('continues accepting an associated organization-domain address', () => {
    expect(associatePublicContact({ email: 'sales@acme.example' }, {
      website: 'https://acme.example/contact', contactSource: 'listing_email_field', exactEmailPublished: true,
    })).toMatchObject({ accepted: true, reason: 'organization_domain' });
  });
});
