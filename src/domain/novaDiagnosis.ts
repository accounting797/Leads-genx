/**
 * Nova's diagnosis brain: turns raw error signatures into plain-English
 * answers to the two questions every operator asks — "what broke?" and
 * "what do I do?". Every layer (engineer guidance, analyst reports,
 * failure headlines) speaks through this one map so the answer is always
 * consistent and always actionable.
 */

export type DiagnosisCategory =
  | 'auth_expired'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'service_down'
  | 'network_blip'
  | 'unknown';

export interface NovaDiagnosis {
  category: DiagnosisCategory;
  /** Who's at fault, in plain terms: 'Google API key', 'Apify balance', … */
  culprit: string;
  /** One sentence, simple words: what actually happened. */
  plainCause: string;
  /** The exact next step the operator should take. */
  action: string;
}

interface Signature {
  test: RegExp;
  build: () => NovaDiagnosis;
}

const SIGNATURES: Signature[] = [
  // --- Google Places / Maps Platform -------------------------------------
  {
    test: /REQUEST_DENIED|API key (is )?(not valid|invalid|expired)|key expired|not activated|referer restrictions/i,
    build: () => ({
      category: 'auth_expired',
      culprit: 'Google API key',
      plainCause: 'Your Google API key has expired or is no longer accepted by Google.',
      action: 'Open Settings → Google API Keys, paste a fresh key, and hit Test — Nova picks it up from there.',
    }),
  },
  {
    test: /OVER_QUERY_LIMIT|billing|BILLING|exceeded your.*quota|daily limit/i,
    build: () => ({
      category: 'quota_exhausted',
      culprit: 'Google API quota',
      plainCause: "Your Google API quota is exhausted — the key's billing or daily limit has run out.",
      action: 'Check billing in Google Cloud, or swap in a fresh key under Settings → Google API Keys.',
    }),
  },
  // --- Apify --------------------------------------------------------------
  {
    test: /apify.*(401|unauthori[sz]ed|authentication|invalid token)|token is not valid/i,
    build: () => ({
      category: 'auth_expired',
      culprit: 'Apify token',
      plainCause: 'Apify rejected the token — it has expired or been revoked.',
      action: 'Paste a fresh token in Settings → Apify (or the BYOD card) and Nova resumes paused runs automatically.',
    }),
  },
  {
    test: /apify.*(402|usage limit|quota|exceeded|insufficient)|memory limit|actor.*(out of (memory|credit))/i,
    build: () => ({
      category: 'quota_exhausted',
      culprit: 'Apify balance',
      plainCause: 'Your Apify balance is exhausted — the account is out of credits for this month.',
      action: 'Top up at apify.com or add another token in Settings → Apify; Nova rotates keys automatically.',
    }),
  },
  // --- Bright Data --------------------------------------------------------
  {
    test: /bright data.*(401|403|rejected|unauthori[sz]ed)/i,
    build: () => ({
      category: 'auth_expired',
      culprit: 'Bright Data key',
      plainCause: 'Bright Data rejected the API key — it is expired or mistyped.',
      action: 'Open Settings → Bright Data API Key, paste the fresh key, hit Test — done.',
    }),
  },
  {
    test: /bright data.*(402|insufficient|balance|credits? exhausted|payment)/i,
    build: () => ({
      category: 'quota_exhausted',
      culprit: 'Bright Data balance',
      plainCause: 'Your Bright Data balance is out of credits.',
      action: 'Top up at brightdata.com, then rerun — everything gathered so far is saved.',
    }),
  },
  // --- Docker bonus lane ---------------------------------------------------
  {
    test: /docker|local (maps )?scraper|ECONNREFUSED.*(3000|8080)/i,
    build: () => ({
      category: 'service_down',
      culprit: 'Docker bonus lane',
      plainCause: 'The local Docker bonus lane is asleep — the main lanes keep running without it.',
      action: 'Nothing is lost. Start Docker when convenient and Nova re-attaches the bonus lane on the next run.',
    }),
  },
  // --- Rate limits ---------------------------------------------------------
  {
    test: /429|rate.?limit|too many requests|throttl/i,
    build: () => ({
      category: 'rate_limited',
      culprit: 'provider rate limit',
      plainCause: 'A provider is rate-limiting us — we pushed faster than it allows.',
      action: 'No action needed: Nova already cooled the pace and retries automatically. More keys/proxies help long-term.',
    }),
  },
  // --- Network blips --------------------------------------------------------
  {
    test: /stalled|timed? ?out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|network/i,
    build: () => ({
      category: 'network_blip',
      culprit: 'network',
      plainCause: 'A network hiccup — a request stalled or the connection dropped.',
      action: 'No action needed: Nova retries this kind of blip on her own.',
    }),
  },
];

const FALLBACK: NovaDiagnosis = {
  category: 'unknown',
  culprit: 'provider',
  plainCause: 'Something unstable happened on the provider side.',
  action: 'Resume the run a little later — Nova keeps everything gathered so far safe.',
};

/** Diagnoses a raw error message. Never throws, never echoes secrets. */
export function diagnoseError(message: string | undefined | null): NovaDiagnosis {
  if (!message) return FALLBACK;
  for (const signature of SIGNATURES) {
    if (signature.test.test(message)) return signature.build();
  }
  return FALLBACK;
}

/** One warm sentence for panels and events: cause + action. */
export function novaSays(message: string | undefined | null): string {
  const diagnosis = diagnoseError(message);
  return `Nova's read: ${diagnosis.plainCause} ${diagnosis.action}`;
}
