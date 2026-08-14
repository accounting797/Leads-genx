export type AnalystVerdict = 'perfect' | 'good' | 'bad' | 'needs_attention';

export interface AnalystLine {
  tone: 'ok' | 'info' | 'warn' | 'error' | 'engineer';
  text: string;
}

export interface AnalystReport {
  verdict: AnalystVerdict;
  verdictLabel: string;
  headline: string;
  lines: AnalystLine[];
  checkedAt: string;
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
  metadata?: { kind?: string };
}

export interface AnalystErrorLog {
  severity: string;
  message: string;
  createdAt: Date | string;
}

export interface AnalystHiringSignal {
  companyName: string;
  score: number;
  explanation: string;
  originLane?: 'google_maps' | 'sales_navigator' | 'hiring_opportunity';
}

export interface AnalystHiringScan {
  status: string;
  errorMessage?: string | null;
}

export interface AnalystInput {
  run: AnalystRunSnapshot;
  events: AnalystEvent[];
  providerStates: AnalystProviderState[];
  errorLogs: AnalystErrorLog[];
  hiringSignals?: AnalystHiringSignal[];
  hiringScan?: AnalystHiringScan | null;
  now?: Date;
}

const VERDICT_LABEL: Record<AnalystVerdict, string> = {
  perfect: 'Excellent',
  good: 'All good',
  bad: 'Needs a look',
  needs_attention: 'Needs your help',
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
export function analyzeRun({
  run,
  events,
  providerStates,
  errorLogs,
  hiringSignals = [],
  hiringScan,
  now = new Date(),
}: AnalystInput): AnalystReport {
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
        text: `${providerLabel(state.provider)} hit a problem${state.errorMessage ? `: ${state.errorMessage}` : '.'} I'm on it.`,
      });
    } else if (state.status === 'running') {
      const budget =
        state.provider === 'google' && state.budgetMax
          ? ` — budget ${state.budgetUsed ?? 0}/${state.budgetMax} requests`
          : '';
      lines.push({
        tone: stale ? 'warn' : 'ok',
        text: stale
          ? `${providerLabel(state.provider)} has gone quiet — no heartbeat for ${seconds(heartbeatAge!)} while "${state.operation}". I'm watching it closely.`
          : `${providerLabel(state.provider)} is hard at work — ${state.operation} (${state.yieldCount} results so far)${budget}.`,
      });
      if (stale && ['queued', 'running', 'cooling_down'].includes(run.status)) escalate('bad');
    } else if (state.status === 'completed') {
      lines.push({
        tone: 'ok',
        text: `${providerLabel(state.provider)} finished beautifully — ${state.yieldCount} results.`,
      });
    } else if (state.status === 'standby') {
      lines.push({ tone: 'info', text: `${providerLabel(state.provider)} is standing by — ${state.operation}.` });
    }
  }

  // --- The Run Engineer's live activity ------------------------------------
  const engineerEvents = events.filter((event) => event.type === 'engineer_action');
  const engineerTone = (kind: string | undefined): AnalystLine['tone'] => {
    switch (kind) {
      case 'retry_succeeded':
        return 'ok';
      case 'credential_quarantined':
      case 'credential_skipped':
      case 'guidance':
        return 'warn';
      default:
        return 'engineer';
    }
  };
  for (const event of engineerEvents.slice(-3)) {
    lines.push({ tone: engineerTone(event.metadata?.kind), text: event.message });
  }
  const engineerQuarantined = engineerEvents.some((event) => event.metadata?.kind === 'credential_quarantined');
  // A guidance event means Nova's self-healing is exhausted and she is
  // explicitly asking the operator for help — raise the flag high.
  const novaNeedsHelp = engineerEvents.some((event) => event.metadata?.kind === 'guidance');
  const engineerActive = engineerEvents.length > 0;
  if (engineerQuarantined) escalate('bad');
  if (novaNeedsHelp) escalate('needs_attention');

  // --- Output so far -----------------------------------------------------
  if (run.businessCount > 0 || run.leadCount > 0) {
    lines.push({
      tone: 'ok',
      text: `So far: ${run.businessCount} businesses discovered and ${run.leadCount} qualified emails saved${
        run.rawContactCount ? `, plus ${run.rawContactCount} raw contacts kept for review` : ''
      }.`,
    });
  }

  const hiringStatusLine =
    hiringScan?.status === 'partially_completed'
      ? 'Hiring check: Some public hiring boards did not answer, but the evidence Nova saved is still available.'
      : hiringScan?.status === 'failed'
        ? 'Hiring check: The optional public-board check could not finish; your lead run and saved output are unchanged.'
        : undefined;
  const prioritizedHiringSignals = [...hiringSignals].sort((left, right) => {
    const leftAdjacent = left.originLane === 'hiring_opportunity' ? 1 : 0;
    const rightAdjacent = right.originLane === 'hiring_opportunity' ? 1 : 0;
    return leftAdjacent - rightAdjacent || right.score - left.score || left.companyName.localeCompare(right.companyName);
  });
  const signalLimit = hiringStatusLine ? 1 : 2;
  for (const signal of prioritizedHiringSignals.slice(0, signalLimit)) {
    lines.push({
      tone: signal.score >= 90 ? 'ok' : 'info',
      text: `Hiring signal ${signal.score}/100 for ${signal.companyName}: ${signal.explanation}`,
    });
  }
  if (hiringStatusLine) {
    lines.push({ tone: 'info', text: hiringStatusLine });
  }

  // --- Errors --------------------------------------------------------------
  const recentErrors = errorLogs.slice(0, 3);
  if (errorLogs.length > 0) {
    escalate(errorLogs.some((log) => log.severity === 'error') ? 'needs_attention' : 'bad');
    for (const log of recentErrors) {
      lines.push({ tone: log.severity === 'error' ? 'error' : 'warn', text: `I logged a problem: ${log.message}` });
    }
    if (errorLogs.length > recentErrors.length) {
      lines.push({ tone: 'warn', text: `${errorLogs.length - recentErrors.length} more notes in the log when you have a moment.` });
    }
  }

  // --- Heartbeat -------------------------------------------------------------
  const lastEvent = events[events.length - 1];
  const eventAge = ageMs(now, lastEvent?.createdAt);
  if (['queued', 'running', 'cooling_down'].includes(run.status) && eventAge !== null && eventAge > STALE_HEARTBEAT_MS) {
    escalate('bad');
    lines.push({
      tone: 'warn',
      text: `It's been quiet for ${seconds(eventAge)} — providers may be waiting on the network or Docker. I'm keeping watch.`,
    });
  }

  // --- Terminal states ---------------------------------------------------------
  let headline: string;
  if (run.status === 'failed') {
    verdict = 'needs_attention';
    headline = "I'm sorry — this run failed. Everything we gathered is safe; the error below explains what happened.";
    if (run.errorMessage) lines.unshift({ tone: 'error', text: `What went wrong: ${run.errorMessage}` });
  } else if (run.status === 'waiting_for_scraper') {
    escalate('bad');
    headline = "I've paused things gently — the Docker scraper isn't answering. All progress is safely stored.";
    lines.push({ tone: 'info', text: 'Start the Docker scraper and resume the run, and I’ll pick up right where we stopped.' });
  } else if (run.status === 'waiting_for_credentials') {
    escalate('bad');
    headline = 'I need a fresh key from you — pop it into Settings and I’ll accept it and resume automatically. Promise.';
  } else if (run.status === 'cooling_down') {
    headline = 'Cooling the engines for a moment — a short breather keeps your accounts safe, then we surge again.';
  } else if (run.status === 'partially_completed') {
    escalate('bad');
    headline = 'Finished with a few bumps — every lead gathered before the trouble is saved.';
  } else if (run.status === 'completed') {
    if (verdict === 'good') verdict = 'perfect';
    headline =
      verdict === 'perfect'
        ? `What a session — ${run.leadCount} qualified emails from ${run.businessCount} businesses without a single error.`
        : `All done — ${run.leadCount} qualified emails saved. Do glance at the notes below when you have a moment.`;
  } else if (run.status === 'cancelled' || run.status === 'paused') {
    headline = 'Stopped as you asked — everything gathered so far is kept safe.';
  } else {
    headline =
      verdict === 'good'
        ? engineerActive
          ? "Everything's humming along nicely — I'm actively guarding this run."
          : "Everything's humming along nicely — all systems healthy."
        : novaNeedsHelp
        ? "I've retried, cooled down, and rerouted everything I can — now I need your help with what's below."
        : engineerActive
        ? "I'm actively fighting for this run — retries and cooling are underway — but a few things deserve your eye."
        : 'The run is moving, but a few things deserve your eye — see below.';
  }

  if (lines.length === 0) {
    lines.push({ tone: 'info', text: 'Warming up — waiting for the first provider heartbeat.' });
  }

  return {
    verdict,
    verdictLabel: VERDICT_LABEL[verdict],
    headline,
    lines: lines.slice(0, 8),
    checkedAt: now.toISOString(),
  };
}
