export interface GreenhouseJob {
  id: number;
  title: string;
  location: string;
  departments: string[];
  updatedAt: string;
  absoluteUrl: string;
}

export class GreenhouseError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'GreenhouseError';
  }
}

const BOARD_TOKEN_PATTERN = /^[a-z0-9_-]{1,120}$/;
const BOARD_PATTERNS = [
  /boards\.greenhouse\.io\/([a-z0-9_-]+)/gi,
  /job-boards\.greenhouse\.io\/([a-z0-9_-]+)/gi,
  /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/gi,
];
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function compactText(value: unknown, maxLength: number): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizedJob(raw: unknown): GreenhouseJob | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const id = Number(value.id);
  const title = compactText(value.title, 300);
  const updatedAt = compactText(value.updated_at, 80);
  const absoluteUrl = compactText(value.absolute_url, 2_000);
  if (!Number.isFinite(id) || !title || !updatedAt || !absoluteUrl) return undefined;

  const location =
    value.location && typeof value.location === 'object'
      ? compactText((value.location as Record<string, unknown>).name, 300)
      : '';
  const departments = Array.isArray(value.departments)
    ? value.departments
        .map((department) =>
          department && typeof department === 'object'
            ? compactText((department as Record<string, unknown>).name, 200)
            : ''
        )
        .filter(Boolean)
        .slice(0, 20)
    : [];

  return { id, title, location, departments, updatedAt, absoluteUrl };
}

export function extractGreenhouseBoardTokens(value: string): string[] {
  const found = new Set<string>();
  for (const pattern of BOARD_PATTERNS) {
    for (const match of value.matchAll(pattern)) {
      const token = match[1]?.toLowerCase();
      if (token && BOARD_TOKEN_PATTERN.test(token)) found.add(token);
    }
  }
  return [...found];
}

export interface GreenhouseClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class GreenhouseClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: GreenhouseClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }));
  }

  async listJobs(boardToken: string): Promise<GreenhouseJob[]> {
    const token = boardToken.trim().toLowerCase();
    if (!BOARD_TOKEN_PATTERN.test(token)) {
      throw new GreenhouseError('Greenhouse board token is invalid.', 'invalid_board_token', false);
    }

    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`;
    let lastError: GreenhouseError | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'Leads-GenX-Hiring-Signals/1.0',
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          const code = response.status === 404 ? 'board_not_found' : retryable ? 'greenhouse_transient' : 'greenhouse_rejected';
          throw new GreenhouseError(
            response.status === 404
              ? 'Greenhouse board was not found.'
              : `Greenhouse returned HTTP ${response.status}.`,
            code,
            retryable,
            response.status
          );
        }
        const declaredLength = Number(response.headers.get('content-length') ?? 0);
        if (declaredLength > MAX_RESPONSE_BYTES) {
          throw new GreenhouseError('Greenhouse response was too large.', 'response_too_large', false);
        }
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
          throw new GreenhouseError('Greenhouse response was too large.', 'response_too_large', false);
        }
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          throw new GreenhouseError('Greenhouse returned malformed JSON.', 'invalid_response', false);
        }
        const jobs =
          payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).jobs)
            ? ((payload as Record<string, unknown>).jobs as unknown[])
            : [];
        return jobs.map(normalizedJob).filter((job): job is GreenhouseJob => Boolean(job));
      } catch (error) {
        lastError =
          error instanceof GreenhouseError
            ? error
            : new GreenhouseError(
                error instanceof Error && error.name === 'TimeoutError'
                  ? 'Greenhouse request timed out.'
                  : 'Greenhouse request could not connect.',
                'greenhouse_transient',
                true
              );
        if (!lastError.retryable || attempt === 1) throw lastError;
        await this.sleep(250);
      }
    }
    throw lastError ?? new GreenhouseError('Greenhouse request failed.', 'greenhouse_transient', true);
  }
}
