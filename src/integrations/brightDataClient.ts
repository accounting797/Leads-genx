/**
 * Bright Data Datasets API client.
 *
 * Follows the canonical trigger → poll → collect flow from Bright Data's
 * own MCP server and CLI:
 *   POST https://api.brightdata.com/datasets/v3/trigger?dataset_id=…  → { snapshot_id }
 *   GET  https://api.brightdata.com/datasets/v3/snapshot/{id}?format=json
 *        → { status: 'running' | 'building' | 'starting' } while working
 *        → [records] once the snapshot is ready
 *
 * Same anti-hang discipline as the rest of Leads-GenX: every request has a
 * hard ceiling, stalls map to retryable transient errors, and polling is
 * strike-tolerant instead of dying on the first network blip.
 */

export const LINKEDIN_PERSON_PROFILE_DATASET = 'gd_l1viktl72bvl7bjuj0';
// Contact-enriched variant: same people profiles plus email/phone fields
// when Bright Data has them — the money dataset for lead enrichment.
export const LINKEDIN_PERSON_PROFILE_CONTACT_DATASET = 'gd_me5ppxjr2ge6icjuh0';
export const LINKEDIN_COMPANY_PROFILE_DATASET = 'gd_l1vikfnt1wgvvqz95w';

const API_BASE = 'https://api.brightdata.com';
const REQUEST_TIMEOUT_MS = 45_000;
const DEFAULT_DEADLINE_MS = 20 * 60_000;
const DEFAULT_POLL_MS = 5_000;
const MAX_POLL_STRIKES = 6;

export type BrightDataErrorCode = 'auth' | 'transient' | 'failed';

export class BrightDataError extends Error {
  constructor(
    public readonly code: BrightDataErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'BrightDataError';
  }
}

export interface BrightDataCollectOptions {
  apiKey: string;
  datasetId: string;
  inputs: Array<Record<string, string>>;
  deadlineMs?: number;
  pollMs?: number;
  onProgress?: (message: string) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface BrightDataTestResult {
  ok: boolean;
  detail: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function asBrightDataError(error: unknown): BrightDataError {
  if (error instanceof BrightDataError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new BrightDataError('transient', 'Bright Data request stalled past the 45s ceiling — restarting it.');
  }
  return new BrightDataError('transient', `Bright Data request hiccuped: ${error instanceof Error ? error.message : String(error)}`);
}

async function request(fetchImpl: typeof fetch, url: string, apiKey: string, init: RequestInit = {}): Promise<unknown> {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    throw asBrightDataError(error);
  }
  if (response.status === 401 || response.status === 403) {
    throw new BrightDataError('auth', 'Bright Data rejected the API key — check it in Settings.', response.status);
  }
  if (response.status === 429 || response.status >= 500) {
    throw new BrightDataError('transient', `Bright Data is busy (HTTP ${response.status}) — retrying.`, response.status);
  }
  if (!response.ok) {
    throw new BrightDataError('failed', `Bright Data request failed (HTTP ${response.status}).`, response.status);
  }
  return response.json();
}

/**
 * Triggers a dataset collection and polls the snapshot until the records
 * are ready. Returns the records array (possibly empty).
 */
export async function triggerAndCollect(options: BrightDataCollectOptions): Promise<Array<Record<string, unknown>>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);

  const trigger = (await request(
    fetchImpl,
    `${API_BASE}/datasets/v3/trigger?dataset_id=${encodeURIComponent(options.datasetId)}&include_errors=true`,
    options.apiKey,
    { method: 'POST', body: JSON.stringify(options.inputs) }
  )) as { snapshot_id?: string };
  if (!trigger.snapshot_id) {
    throw new BrightDataError('failed', 'Bright Data did not return a snapshot id for the collection.');
  }
  const snapshotId = trigger.snapshot_id;
  options.onProgress?.(`collection started (snapshot ${snapshotId})`);

  let strikes = 0;
  for (;;) {
    if (Date.now() > deadline) {
      throw new BrightDataError(
        'transient',
        'Bright Data collection outlived its deadline — the snapshot may still finish; try enriching again.'
      );
    }
    let payload: unknown;
    try {
      payload = await request(
        fetchImpl,
        `${API_BASE}/datasets/v3/snapshot/${encodeURIComponent(snapshotId)}?format=json`,
        options.apiKey
      );
      strikes = 0;
    } catch (error) {
      const bdError = asBrightDataError(error);
      if (bdError.code === 'auth' || bdError.code === 'failed') throw bdError;
      strikes += 1;
      if (strikes >= MAX_POLL_STRIKES) {
        throw new BrightDataError(
          'transient',
          'Bright Data stopped answering status checks — the collection may still be running; try again shortly.'
        );
      }
      options.onProgress?.(`reconnecting (${strikes}/${MAX_POLL_STRIKES})`);
      await sleep(pollMs);
      continue;
    }

    // While the snapshot builds, the API answers an object with a status;
    // once ready it answers the records array itself.
    if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
    const status = (payload as { status?: string } | undefined)?.status;
    if (status === 'failed') {
      throw new BrightDataError('failed', 'Bright Data reported the collection as failed.');
    }
    options.onProgress?.(`collecting data (status: ${status ?? 'unknown'})`);
    await sleep(pollMs);
  }
}

/**
 * Lightweight key check: asks for dataset metadata — cheap, read-only, and
 * proves the token works without spending a single collection credit.
 */
export async function testBrightDataKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<BrightDataTestResult> {
  try {
    await request(fetchImpl, `${API_BASE}/datasets/${LINKEDIN_PERSON_PROFILE_DATASET}/metadata`, apiKey);
    return { ok: true, detail: 'Bright Data key works — datasets are reachable.' };
  } catch (error) {
    const bdError = asBrightDataError(error);
    if (bdError.code === 'auth') return { ok: false, detail: 'Bright Data rejected this key — double-check it and save again.' };
    return { ok: false, detail: bdError.message };
  }
}
