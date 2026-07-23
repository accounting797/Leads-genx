import { describe, expect, it } from 'vitest';
import { classifyContact } from '../../src/domain/contactClassifier';

describe('classifyContact', () => {
  it('qualifies normalized business-domain matches', () => {
    expect(classifyContact('Sales@AcmeIndustrial.com', 'https://acmeindustrial.com')).toEqual({
      normalizedEmail: 'sales@acmeindustrial.com',
      quality: 'qualified',
      reason: 'business_domain_match',
    });
  });

  it('marks automated mailboxes raw even on the business domain', () => {
    expect(classifyContact('noreply@acmeindustrial.com', 'https://acmeindustrial.com')).toMatchObject({
      quality: 'raw',
      reason: 'automated_mailbox',
    });
  });

  it('marks telemetry addresses raw', () => {
    expect(
      classifyContact(
        'ef5d9bbac3354b759bfd7a23c3313b3f@o244637.ingest.us.sentry.io',
        'https://acmeindustrial.com'
      )
    ).toMatchObject({ quality: 'raw', reason: 'telemetry_address' });
  });

  it('marks unrelated domains raw when a website exists', () => {
    expect(classifyContact('sales@unrelated.example', 'https://acmeindustrial.com')).toMatchObject({
      quality: 'raw',
      reason: 'unassociated_domain',
    });
  });

  it('marks asset artifacts raw', () => {
    expect(classifyContact('logo@acmeindustrial.com.png', 'https://acmeindustrial.com')).toMatchObject({
      quality: 'raw',
      reason: 'asset_artifact',
    });
  });

  it('accepts parent and subdomain host relationships', () => {
    expect(classifyContact('sales@acmeindustrial.com', 'https://www.acmeindustrial.com')).toMatchObject({
      quality: 'qualified',
      reason: 'business_domain_match',
    });
    expect(classifyContact('sales@mail.acmeindustrial.com', 'https://acmeindustrial.com')).toMatchObject({
      quality: 'qualified',
      reason: 'business_domain_match',
    });
    expect(classifyContact('local@example.com', 'https://local.example.com')).toMatchObject({
      quality: 'qualified',
      reason: 'business_domain_match',
    });
  });

  it('qualifies syntactically valid addresses without a website', () => {
    expect(classifyContact('Sales@Example.com.')).toEqual({
      normalizedEmail: 'sales@example.com',
      quality: 'qualified',
      reason: 'valid_without_business_domain',
    });
  });

  it('marks placeholder addresses raw', () => {
    expect(classifyContact('yourname@acmeindustrial.com', 'https://acmeindustrial.com')).toMatchObject({
      quality: 'raw',
      reason: 'placeholder',
    });
    expect(classifyContact('user@company.invalid')).toMatchObject({
      quality: 'raw',
      reason: 'placeholder',
    });
  });

  it('marks malformed addresses raw', () => {
    expect(classifyContact('not-an-email')).toMatchObject({
      quality: 'raw',
      reason: 'malformed',
    });
  });
});
