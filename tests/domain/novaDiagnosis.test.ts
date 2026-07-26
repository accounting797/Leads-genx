import { describe, expect, it } from 'vitest';
import { diagnoseError, novaSays } from '../../src/domain/novaDiagnosis';

describe('diagnoseError', () => {
  it('names an expired Google API key and the cure', () => {
    const d = diagnoseError('Google Places error (403): REQUEST_DENIED — The provided API key is expired.');
    expect(d.category).toBe('auth_expired');
    expect(d.culprit).toBe('Google API key');
    expect(d.action).toContain('Settings');
  });

  it('names an exhausted Google quota', () => {
    const d = diagnoseError('OVER_QUERY_LIMIT: You have exceeded your daily quota');
    expect(d.category).toBe('quota_exhausted');
    expect(d.culprit).toContain('Google');
  });

  it('names a dead Apify token', () => {
    const d = diagnoseError('Apify request failed (401): authentication token is not valid');
    expect(d.category).toBe('auth_expired');
    expect(d.culprit).toBe('Apify token');
  });

  it('names an exhausted Apify balance in plain terms', () => {
    const d = diagnoseError('Apify usage limit exceeded for this month');
    expect(d.category).toBe('quota_exhausted');
    expect(d.plainCause).toContain('balance');
    expect(d.action).toContain('Settings');
  });

  it('names Bright Data rejections and empty balances', () => {
    expect(diagnoseError('Bright Data rejected the API key — check it in Settings.').culprit).toBe('Bright Data key');
    expect(diagnoseError('Bright Data account 402: insufficient balance').category).toBe('quota_exhausted');
  });

  it('treats Docker sleep as non-fatal with clear guidance', () => {
    const d = diagnoseError('Local scraper stopped answering mid-job — docker unavailable');
    expect(d.category).toBe('service_down');
    expect(d.plainCause).toContain('bonus lane');
  });

  it('calls rate limits self-healing', () => {
    const d = diagnoseError('HTTP 429 too many requests');
    expect(d.category).toBe('rate_limited');
    expect(d.action).toContain('No action needed');
  });

  it('falls back gracefully on unknown errors and null', () => {
    expect(diagnoseError('weird bespoke explosion').category).toBe('unknown');
    expect(diagnoseError(null).category).toBe('unknown');
  });

  it('novaSays compresses cause + action into one sentence', () => {
    const line = novaSays('OVER_QUERY_LIMIT');
    expect(line).toContain("Nova's read:");
    expect(line).toContain('quota');
  });
});
