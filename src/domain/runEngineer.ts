import { GooglePlacesError } from '../integrations/googlePlacesClient';
import { LocalScraperError } from '../integrations/localMapsScraperClient';
import { safeErrorMessage } from './errorLogger';

export type EngineerProvider = 'apify' | 'google' | 'docker' | 'email';

export type FailureCategory =
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'transient'
  | 'network'
  | 'docker_down'
  | 'unsupported'
  | 'unknown';

export interface FailureDiagnosis {
  category: FailureCategory;
  retryable: boolean;
  summary: string;
  reasoning: string;
}

export type EngineerActionKind =
  | 'diagnosis'
  | 'retry'
  | 'retry_succeeded'
  | 'credential_quarantined'
  | 'credential_skipped'
  | 'reconnect'
  | 'guidance';

export interface EngineerAction {
  provider: EngineerProvider;
  kind: EngineerActionKind;
  message: string;
  reasoning: string;
}

export interface EngineerEventSink {
  addEvent(runId: number, type: string, message: string, metadata?: Record<string, unknown>): Promise<unknown>;
}

const NETWORK_PATTERN = /fetch failed|econnreset|econnrefused|etimedout|enotfound|socket hang up|network/i;
const AUTH_PATTERN = /not valid|unauthorized|unauthenticated|forbidden|authentication|invalid (api )?key|permission denied/i;
const RATE_PATTERN = /rate.?limit|too many requests/i;
const QUOTA_PATTERN = /quota|resource_exhausted/i;

function statusCodeOf(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const code = (error as { statusCode?: unknown }).statusCode;
    if (typeof code === 'number') return code;
  }
  return undefined;
}

/**
 * Classifies any provider failure into an actionable category with
 * human-readable reasoning. This is the engineer's diagnostic brain.
 */
export function diagnoseFailure(error: unknown, provider: EngineerProvider): FailureDiagnosis {
  const message = safeErrorMessage(error);
  const statusCode = statusCodeOf(error);

  if (error instanceof GooglePlacesError) {
    if (error.code === 'invalid_key' || error.code === 'forbidden') {
      return {
        category: 'auth',
        retryable: false,
        summary: message,
        reasoning: 'Google rejected the API key itself — retrying with the same key cannot succeed.',
      };
    }
    if (error.code === 'quota') {
      return {
        category: 'quota',
        retryable: false,
        summary: message,
        reasoning: 'The Google key is valid but its quota is exhausted; it resets outside this run.',
      };
    }
    if (error.code === 'rate_limited') {
      return {
        category: 'rate_limit',
        retryable: true,
        summary: message,
        reasoning: 'Google is throttling request speed — a short wait usually clears this.',
      };
    }
    return {
      category: 'transient',
      retryable: true,
      summary: message,
      reasoning: 'Google returned a temporary server-side error.',
    };
  }

  if (error instanceof LocalScraperError) {
    if (error.code === 'unsupported_location') {
      return {
        category: 'unsupported',
        retryable: false,
        summary: message,
        reasoning: 'Docker has no coordinates for this location; add the location in plain "City, ST" form.',
      };
    }
    return {
      category: 'docker_down',
      retryable: true,
      summary: message,
      reasoning: 'The Docker scraper is not answering — it may still be starting or the container stopped.',
    };
  }

  if (statusCode === 401 || statusCode === 403 || AUTH_PATTERN.test(message)) {
    return {
      category: 'auth',
      retryable: false,
      summary: message,
      reasoning: `${provider === 'apify' ? 'Apify' : 'The provider'} rejected the credential itself — retrying with the same credential cannot succeed.`,
    };
  }
  if (statusCode === 429 || RATE_PATTERN.test(message)) {
    return {
      category: 'rate_limit',
      retryable: true,
      summary: message,
      reasoning: 'The provider is throttling request speed — a short wait usually clears this.',
    };
  }
  if ((statusCode !== undefined && statusCode >= 500) || QUOTA_PATTERN.test(message)) {
    return {
      category: statusCode !== undefined && statusCode >= 500 ? 'transient' : 'quota',
      retryable: statusCode !== undefined && statusCode >= 500,
      summary: message,
      reasoning: 'The provider reported a temporary server-side condition.',
    };
  }
  if (NETWORK_PATTERN.test(message)) {
    return {
      category: 'network',
      retryable: true,
      summary: message,
      reasoning: 'The connection dropped before an answer arrived — this is usually transient.',
    };
  }
  return {
    category: 'unknown',
    retryable: false,
    summary: message,
    reasoning: 'The failure does not match a known pattern; a developer should inspect the log.',
  };
}

export interface RetryPlan {
  maxAttempts: number;
  backoffMs: number[];
}

export function retryPlanFor(diagnosis: FailureDiagnosis): RetryPlan {
  if (!diagnosis.retryable) return { maxAttempts: 1, backoffMs: [] };
  switch (diagnosis.category) {
    case 'rate_limit':
      return { maxAttempts: 3, backoffMs: [4_000, 10_000] };
    case 'docker_down':
      return { maxAttempts: 2, backoffMs: [3_000] };
    default:
      return { maxAttempts: 3, backoffMs: [1_500, 4_000] };
  }
}

export interface RunEngineerDeps {
  runId: number;
  store: EngineerEventSink;
  /** Injectable sleeper so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** Called when a credential is diagnosed as dead (auth failure). */
  quarantineCredential?: (provider: EngineerProvider, credential: string | undefined, reason: string) => Promise<void>;
  /** Health probe used before declaring a provider unrecoverable. */
  probe?: Partial<Record<EngineerProvider, () => Promise<boolean>>>;
}

const PROVIDER_LABEL: Record<EngineerProvider, string> = {
  apify: 'Apify',
  google: 'Google Places',
  docker: 'Docker scraper',
  email: 'Website scanner',
};

/**
 * The Run Engineer works every run: it diagnoses provider failures, retries
 * what is retryable, quarantines dead credentials, reconnects what can be
 * reconnected, and narrates every decision as an engineer_action event so the
 * operator (and the analyst) can see its reasoning live.
 */
export class RunEngineer {
  private readonly runId: number;
  private readonly store: EngineerEventSink;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly quarantine?: RunEngineerDeps['quarantineCredential'];
  private readonly probe: RunEngineerDeps['probe'];
  private readonly actions: EngineerAction[] = [];

  constructor({ runId, store, sleep, quarantineCredential, probe }: RunEngineerDeps) {
    this.runId = runId;
    this.store = store;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.quarantine = quarantineCredential;
    this.probe = probe;
  }

  get journal(): readonly EngineerAction[] {
    return this.actions;
  }

  private async record(provider: EngineerProvider, kind: EngineerActionKind, message: string, reasoning: string): Promise<void> {
    this.actions.push({ provider, kind, message, reasoning });
    await this.store.addEvent(this.runId, 'engineer_action', message, { provider, kind, reasoning });
  }

  /** Diagnoses a failure and, when the credential is dead, quarantines it. */
  async diagnose(provider: EngineerProvider, error: unknown, credential?: string): Promise<FailureDiagnosis> {
    const diagnosis = diagnoseFailure(error, provider);
    await this.record(
      provider,
      'diagnosis',
      `Engineer diagnosis (${PROVIDER_LABEL[provider]}): ${diagnosis.summary}`,
      diagnosis.reasoning
    );

    if (diagnosis.category === 'auth' && credential) {
      if (this.quarantine) await this.quarantine(provider, credential, diagnosis.summary);
      await this.record(
        provider,
        'credential_quarantined',
        `Engineer quarantined the dead ${PROVIDER_LABEL[provider]} credential — future runs will skip it. Update it in Settings.`,
        'A rejected credential never recovers on its own, so it is removed from rotation until replaced.'
      );
    }
    if (diagnosis.category === 'auth' && !credential) {
      await this.record(
        provider,
        'guidance',
        `Engineer guidance: the ${PROVIDER_LABEL[provider]} credential was rejected — replace it in Settings.`,
        diagnosis.reasoning
      );
    }
    return diagnosis;
  }

  /**
   * Runs an operation with the engineer's retry policy: diagnoses each
   * failure, retries what is retryable with backoff, and reports the outcome.
   */
  async attempt<T>(
    provider: EngineerProvider,
    operation: string,
    fn: () => Promise<T>,
    credential?: string
  ): Promise<T> {
    let lastError: unknown;
    let plan: RetryPlan = { maxAttempts: 1, backoffMs: [] };

    for (let attempt = 1; attempt <= plan.maxAttempts; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const diagnosis = await this.diagnose(provider, error, attempt === 1 ? credential : undefined);
        plan = retryPlanFor(diagnosis);
        if (!diagnosis.retryable || attempt >= plan.maxAttempts) break;
        const waitMs = plan.backoffMs[attempt - 1] ?? 2_000;
        await this.record(
          provider,
          'retry',
          `Engineer is retrying ${operation} (attempt ${attempt + 1}/${plan.maxAttempts}) after ${Math.round(waitMs / 1000)}s.`,
          diagnosis.reasoning
        );
        await this.sleep(waitMs);
      }
    }
    throw lastError;
  }

  /** Reports that a retry wave recovered the operation. */
  async recovered(provider: EngineerProvider, operation: string): Promise<void> {
    await this.record(
      provider,
      'retry_succeeded',
      `Engineer recovered ${operation} — the run continues without data loss.`,
      'The retry policy cleared a transient failure.'
    );
  }

  /** Notes that a previously quarantined credential was skipped at planning time. */
  async skippedDeadCredential(provider: EngineerProvider, count: number): Promise<void> {
    await this.record(
      provider,
      'credential_skipped',
      `Engineer skipped ${count} previously-quarantined ${PROVIDER_LABEL[provider]} credential${count === 1 ? '' : 's'}. Replace ${count === 1 ? 'it' : 'them'} in Settings.`,
      'These credentials were rejected before; using them again would only waste a shard.'
    );
  }

  /** Probes a provider that went dark; returns true when it answers again. */
  async reconnect(provider: EngineerProvider): Promise<boolean> {
    const probe = this.probe?.[provider];
    if (!probe) return false;
    await this.record(
      provider,
      'reconnect',
      `Engineer is checking whether the ${PROVIDER_LABEL[provider]} is back…`,
      'Before declaring the provider lost, verify it is truly unreachable.'
    );
    let healthy = false;
    try {
      healthy = await probe();
    } catch {
      healthy = false;
    }
    await this.record(
      provider,
      'reconnect',
      healthy
        ? `Engineer re-established contact with the ${PROVIDER_LABEL[provider]}.`
        : `Engineer confirms the ${PROVIDER_LABEL[provider]} is still unreachable — preserving output and checkpointing.`,
      healthy ? 'The health probe answered.' : 'The health probe did not answer.'
    );
    return healthy;
  }
}
