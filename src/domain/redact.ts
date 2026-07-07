const SECRET_KEY_PATTERN = /(token|cookie|authorization|password|secret|li_at)/i;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]{10,}/gi;
const LONG_SECRET_PATTERN = /\b[A-Za-z0-9_-]{24,}\b/g;

export function redactSecrets<T>(value: T): T | string {
  if (typeof value === 'string') {
    return value.replace(BEARER_PATTERN, '[REDACTED]').replace(LONG_SECRET_PATTERN, '[REDACTED]');
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item)) as T;
  }

  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redactSecrets(nested);
    }
    return output as T;
  }

  return value;
}
