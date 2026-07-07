import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../src/domain/redact';

describe('redactSecrets', () => {
  it('redacts token and cookie shaped fields recursively', () => {
    const redacted = redactSecrets({
      apifyToken: 'apify_api_secret',
      nested: {
        cookie: 'li_at=abc123',
        authorization: 'Bearer super-secret-token-value',
      },
      safe: 'visible',
    });

    expect(redacted).toEqual({
      apifyToken: '[REDACTED]',
      nested: {
        cookie: '[REDACTED]',
        authorization: '[REDACTED]',
      },
      safe: 'visible',
    });
  });

  it('redacts secret-looking values inside strings', () => {
    expect(redactSecrets('failed with Bearer super-secret-token-value')).toBe(
      'failed with [REDACTED]'
    );
  });
});
