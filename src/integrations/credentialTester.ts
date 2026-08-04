export interface CredentialTestResult {
  ok: boolean;
  detail: string;
  latencyMs: number;
  keyHint?: string;
}

export function maskKey(key: string): string {
  const clean = key.trim();
  if (clean.length <= 4) return '••••';
  return `••••${clean.slice(-4)}`;
}

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

const DEFAULT_TIMEOUT_MS = 8000;

async function timedFetch(fetchImpl: FetchLike, url: string, init: Record<string, unknown> = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function failure(latencyMs: number, detail: string): CredentialTestResult {
  return { ok: false, detail, latencyMs };
}

export async function testApifyToken(
  token: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<CredentialTestResult> {
  const started = Date.now();
  try {
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const res = await timedFetch(fetchImpl, 'https://api.apify.com/v2/users/me', auth);
    const latencyMs = Date.now() - started;
    if (res.status === 200) {
      const body = (await res.json()) as {
        data?: { username?: string; plan?: { id?: string; monthlyUsageCreditsUsd?: number } };
      };
      const [limitsResponse, usageResponse] = await Promise.all([
        timedFetch(fetchImpl, 'https://api.apify.com/v2/users/me/limits', auth),
        timedFetch(fetchImpl, 'https://api.apify.com/v2/users/me/usage/monthly', auth),
      ]);
      if (limitsResponse.status === 200 && usageResponse.status === 200) {
        const limits = (await limitsResponse.json()) as {
          data?: {
            monthlyUsageCycle?: { endAt?: string };
            limits?: { maxMonthlyUsageUsd?: number };
            current?: { monthlyUsageUsd?: number };
          };
        };
        const usage = (await usageResponse.json()) as {
          data?: { totalUsageCreditsUsdAfterVolumeDiscount?: number };
        };
        const included = Number(
          body.data?.plan?.monthlyUsageCreditsUsd ??
          limits.data?.limits?.maxMonthlyUsageUsd ??
          0
        );
        const used = Number(
          usage.data?.totalUsageCreditsUsdAfterVolumeDiscount ??
          limits.data?.current?.monthlyUsageUsd ??
          0
        );
        const remaining = Math.max(0, included - used);
        const resetAt = limits.data?.monthlyUsageCycle?.endAt;
        const reset = resetAt
          ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
              .format(new Date(resetAt))
          : 'unknown';
        const username = body.data?.username ? ` (${body.data.username})` : '';
        const state = remaining < 0.01 ? 'EXHAUSTED' : `$${remaining.toFixed(2)} remaining`;
        return {
          ok: true,
          detail: `Apify token is live${username} · ${body.data?.plan?.id ?? 'account'} · ${state} of $${included.toFixed(2)} · resets ${reset}`,
          latencyMs: Date.now() - started,
        };
      }
      const username = body.data?.username ? ` (${body.data.username})` : '';
      return { ok: true, detail: `Apify token is live${username} · usage unavailable`, latencyMs: Date.now() - started };
    }
    if (res.status === 401 || res.status === 403) {
      return failure(latencyMs, 'Apify rejected this token — check it and try again');
    }
    return failure(latencyMs, `Apify returned status ${res.status}`);
  } catch (error) {
    const detail =
      (error as Error).name === 'AbortError' ? 'Apify test timed out — check your connection' : 'Could not reach Apify';
    return failure(Date.now() - started, detail);
  }
}

export async function testGoogleApiKey(
  apiKey: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<CredentialTestResult> {
  const started = Date.now();
  const keyHint = maskKey(apiKey);
  try {
    const res = await timedFetch(fetchImpl, 'https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id',
      },
      body: JSON.stringify({ textQuery: 'coffee', pageSize: 1 }),
    });
    const latencyMs = Date.now() - started;
    if (res.status === 200) {
      return { ok: true, detail: 'Google key is live — Places search succeeded', latencyMs, keyHint };
    }
    if (res.status === 429) {
      return { ok: true, detail: 'Google key is valid but quota is exhausted', latencyMs, keyHint };
    }
    if (res.status === 400 || res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      const reason = body?.error?.message?.slice(0, 120);
      return {
        ok: false,
        detail: `Google rejected this key${reason ? ` — ${reason}` : ' — enable the Places API and billing'}`,
        latencyMs,
        keyHint,
      };
    }
    return { ...failure(latencyMs, `Google returned status ${res.status}`), keyHint };
  } catch (error) {
    const detail =
      (error as Error).name === 'AbortError' ? 'Google test timed out — check your connection' : 'Could not reach Google';
    return { ...failure(Date.now() - started, detail), keyHint };
  }
}
