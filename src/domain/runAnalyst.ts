export type AnalystVerdict = 'perfect' | 'good' | 'bad' | 'needs_attention';

export interface AnalystLine {
  tone: 'ok' | 'info' | 'warn' | 'error';
  text: string;
}

export interface AnalystReport {
  verdict: AnalystVerdict;
  verdictLabel: string;
  headline: string;
  lines: AnalystLine[];
}

export interface AnalystRunSnapshot {
  status: string;
  leadCount: number;
  rawContactCount?: number;
  businessCount: number;
  maxResults: number;
  apiRequestsUsed: number;
  apiRequestBudget: number;
  actorId?: string;
  errorMessage?: string;
}

export interface AnalystProviderState {
  provider: string;
  status: string;
  operation: string;
  yieldCount: number;
  budgetUsed?: number | null;
  budgetMax?: number | null;
  heartbeatAt: Date | string;
  errorMessage?: string | null;
}

export interface AnalystEvent {
  type: string;
  message: string;
  createdAt: Date | string;
}

export interface AnalystErrorLog {
  severity: string;
  message: string;
  createdAt: Date | string;
}

export interface AnalystInput {
  run: AnalystRunSnapshot;
  events: AnalystEvent[];
  providerStates: AnalystProviderState[];
  errorLogs: AnalystErrorLog[];
  now?: Date;
}

const VERDICT_LABEL: Record<AnalystVerdict, string> = {
  perfect: 'Perfect',
  good: 'Good',
  bad: 'Bad',
  needs_attention: 'Needs developer attention',
};

const STALE_HEARTBEAT_MS = 30_000;
const PROVIDER_STALE_MS = 60_000;

function ageMs(now: Date, value: Date | string | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  return now.getTime() - time;
}

function seconds(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function providerLabel(provider: string): string {
  switch (provider) {
    case 'docker':
      return 'Docker scraper';
    case 'google':
      return 'Google Places';
    case 'apify':
      return 'Apify';
    case 'email':
      return 'Website scanner';
    default:
      return provider;
  }
}

/**
 * Turns raw run telemetry into a plain-language operator report.
 * No secrets, no queries — events and provider states are already redacted.
 */
export function analyzeRun({ run, events, providerStates, errorLogs, now = new Date() }: AnalystInput): AnalystReport {
  const lines: AnalystLine[] = [];
  let verdict: AnalystVerdict = 'good';

  const escalate = (next: AnalystVerdict) => {
    const rank: AnalystVerdict[] = ['perfect', 'good', 'bad', 'needs_attention'];
    if (rank.indexOf(next) > rank.indexOf(verdict)) verdict = next;
  };

  // --- What is happening right now -------------------------------------
  for (const state of providerStates) {
    const heartbeatAge = ageMs(now, state.heartbeatAt);
    const stale = heartbeatAge !== null && heartbeatAge > PROVIDER_STALE_MS;
    if (state.status === 'failed') {
      escalate('bad');
      lines.push({
        tone: 'error',
        text: `${providerLabel(state.provider)} failed${state.errorMessage ? `: ${state.errorMessage}` : '.'}`,
      });
    } else if (state.status === 'running') {
      const budget =
        state.provider === 'google' && state.budgetMax
          ? ` — budget ${state.budgetUsed ?? 0}/${state.budgetMax} requests`
          : '';
      lines.push({
        tone: stale ? 'warn' : 'ok',
        text: stale
          ? `${providerLabel(state.provider)} looks stuck — no heartbeat for ${seconds(heartbeatAge!)} while "${state.operation}".`
          : `${providerLabel(state.provider)} is working — ${state.operation} (${state.yieldCount} results)${budget}.`,
      });
      if (stale && ['queued', 'running', 'cooling_down'].includes(run.status)) escalate('bad');
    } else if (state.status === 'completed') {
      lines.push({
        tone: 'ok',
        text: `${providerLabel(state.provider)} finished with ${state.yieldCount} results.`,
      });
    } else if (state.status === 'standby') {
      lines.push({ tone: 'info', text: `${providerLabel(state.provider)} is on standby — ${state.operation}.` });
    }
  }

  // --- Output so far -----------------------------------------------------
  if (run.businessCount > 0 || run.leadCount > 0) {
    lines.push({
      tone: 'ok',
      text: `${run.businessCount} businesses discovered, ${run.leadCount} qualified emails saved${
        run.rawContactCount ? `, ${run.rawContactCount} raw contacts kept for review` : ''
      }.`,
    });
  }

  // --- Errors --------------------------------------------------------------
  const recentErrors = errorLogs.slice(0, 3);
  if (errorLogs.length > 0) {
    escalate(errorLogs.some((log) => log.severity === 'error') ? 'needs_attention' : 'bad');
    for (const log of recentErrors) {
      lines.push({ tone: log.severity === 'error' ? 'error' : 'warn', text: `Error logged: ${log.message}` });
    }
    if (errorLogs.length > recentErrors.length) {
      lines.push({ tone: 'warn', text: `${errorLogs.length - recentErrors.length} more errors in the log.` });
    }
  }

  // --- Heartbeat -------------------------------------------------------------
  const lastEvent = events[events.length - 1];
  const eventAge = ageMs(now, lastEvent?.createdAt);
  if (['queued', 'running', 'cooling_down'].includes(run.status) && eventAge !== null && eventAge > STALE_HEARTBEAT_MS) {
    escalate('bad');
    lines.push({
      tone: 'warn',
      text: `No activity for ${seconds(eventAge)} — providers may be waiting on the network or Docker.`,
    });
  }

  // --- Terminal states ---------------------------------------------------------
  let headline: string;
  if (run.status === 'failed') {
    verdict = 'needs_attention';
    headline = 'The run failed — a developer should inspect the error log.';
    if (run.errorMessage) lines.unshift({ tone: 'error', text: `Failure reason: ${run.errorMessage}` });
  } else if (run.status === 'waiting_for_scraper') {
    escalate('bad');
    headline = 'Paused — the Docker scraper is not responding. Output so far is safely stored.';
    lines.push({ tone: 'info', text: 'Start the Docker scraper and resume the run to continue where it stopped.' });
  } else if (run.status === 'waiting_for_credentials') {
    escalate('bad');
    headline = 'Paused — credentials must be re-entered before the run can continue.';
  } else if (run.status === 'partially_completed') {
    escalate('bad');
    headline = 'Finished with provider failures — all leads gathered before the failure are saved.';
  } else if (run.status === 'completed') {
    if (verdict === 'good') verdict = 'perfect';
    headline =
      verdict === 'perfect'
        ? `Flawless session — ${run.leadCount} qualified emails from ${run.businessCount} businesses with zero errors.`
        : `Completed — ${run.leadCount} qualified emails saved, but check the warnings below.`;
  } else if (run.status === 'cancelled' || run.status === 'paused') {
    headline = 'The run was stopped by the operator.';
  } else {
    headline =
      verdict === 'good'
        ? 'Everything is running smoothly — all systems healthy.'
        : 'The run is active but needs attention — see the warnings below.';
  }

  if (lines.length === 0) {
    lines.push({ tone: 'info', text: 'Warming up — waiting for the first provider heartbeat.' });
  }

  return {
    verdict,
    verdictLabel: VERDICT_LABEL[verdict],
    headline,
    lines: lines.slice(0, 8),
  };
}
