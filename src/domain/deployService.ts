import { Client } from 'ssh2';
import { promises as dns } from 'dns';

export type DeployPhase =
  | 'idle'
  | 'connecting'
  | 'installing'
  | 'securing'
  | 'awaiting_dns'
  | 'setting_up_https'
  | 'verifying'
  | 'done'
  | 'error';

export interface DeployState {
  phase: DeployPhase;
  log: string[];
  serverIp?: string;
  domain?: string;
  siteUrl?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface DeployParams {
  host: string;
  rootPassword: string;
  githubToken: string;
  domain: string;
  /** Admin account to create on the NEW server (username copied from the operator). */
  adminUsername: string;
  adminPassword: string;
  /** Saved operator settings to copy onto the new server (may be empty). */
  settings?: {
    apifyToken?: string;
    googleApiKeys?: string[];
    proxyUrls?: string[];
    defaultGoogleMapsActorId?: string;
    defaultSalesNavigatorActorId?: string;
  };
}

export type RemoteRunner = (
  opts: { host: string; password: string },
  command: string,
  onLog: (line: string) => void
) => Promise<number>;

export interface DeployDeps {
  runRemote?: RemoteRunner;
  resolve4?: (domain: string) => Promise<string[]>;
  httpsOk?: (url: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  dnsIntervalMs?: number;
  dnsMaxWaitMs?: number;
  verifyTimeoutMs?: number;
  maxLogLines?: number;
}

const REPO_HTTPS = 'github.com/accounting797/Leads-genx.git';

/** Real SSH runner: connects as root and streams combined output line by line. */
function sshRunRemote(
  opts: { host: string; password: string },
  command: string,
  onLog: (line: string) => void
): Promise<number> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => {
        onLog('SSH connection established.');
        conn.exec(command, (execError, stream) => {
          if (execError) {
            conn.end();
            reject(execError);
            return;
          }
          let buffer = '';
          const feed = (chunk: string) => {
            buffer += chunk;
            let index = buffer.indexOf('\n');
            while (index >= 0) {
              const line = buffer.slice(0, index).replace(/\r$/, '');
              buffer = buffer.slice(index + 1);
              if (line.trim()) onLog(line);
              index = buffer.indexOf('\n');
            }
          };
          stream.on('data', (data: Buffer) => feed(data.toString('utf8')));
          stream.stderr.on('data', (data: Buffer) => feed(data.toString('utf8')));
          stream.on('close', (code: number | null) => {
            if (buffer.trim()) onLog(buffer);
            conn.end();
            resolve(code ?? 0);
          });
        });
      })
      .on('error', (connError: Error) => {
        reject(connError);
      })
      .connect({
        host: opts.host,
        port: 22,
        username: 'root',
        password: opts.password,
        readyTimeout: 25000,
      });
  });
}

async function defaultHttpsOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return res.ok || res.status === 401; // 401 = app answering behind auth
  } catch {
    return false;
  }
}

export class DeployConflictError extends Error {}

export function createDeployService(deps: DeployDeps = {}) {
  const runRemote = deps.runRemote ?? sshRunRemote;
  // DNS checks go to public resolvers directly — a stale ISP/router cache on
  // the operator's machine must never hold a deployment hostage.
  const publicResolver = new dns.Resolver();
  publicResolver.setServers(['8.8.8.8', '1.1.1.1']);
  const resolve4 =
    deps.resolve4 ??
    (async (domain: string) => {
      try {
        return await publicResolver.resolve4(domain);
      } catch {
        return dns.resolve4(domain);
      }
    });
  const httpsOk = deps.httpsOk ?? defaultHttpsOk;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const dnsIntervalMs = deps.dnsIntervalMs ?? 30000;
  const dnsMaxWaitMs = deps.dnsMaxWaitMs ?? 12 * 60 * 60 * 1000; // 12h safety net
  const verifyTimeoutMs = deps.verifyTimeoutMs ?? 4 * 60 * 1000;
  const maxLogLines = deps.maxLogLines ?? 600;

  let state: DeployState = { phase: 'idle', log: [] };
  let secrets: string[] = [];
  let dnsRecheckRequested = false;

  function mask(line: string): string {
    let out = line;
    for (const secret of secrets) {
      if (secret && secret.length >= 4) out = out.split(secret).join('••••••');
    }
    return out;
  }

  function log(line: string): void {
    state.log.push(mask(line));
    if (state.log.length > maxLogLines) state.log.splice(0, state.log.length - maxLogLines);
  }

  function setPhase(phase: DeployPhase): void {
    state.phase = phase;
  }

  async function interruptibleSleep(ms: number): Promise<void> {
    const step = Math.min(ms, 1000);
    let waited = 0;
    while (waited < ms && !dnsRecheckRequested) {
      await sleep(step);
      waited += step;
    }
  }

  function shellQuote(value: string): string {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
  }

  function buildInstallCommand(params: DeployParams): string {
    const clone = `git clone --depth 1 https://x-access-token:${params.githubToken}@${REPO_HTTPS} /opt/Leads-genx 2>/dev/null || git -C /opt/Leads-genx pull --ff-only`;
    return `${clone} && SKIP_PUBLIC_APP_PORT=1 bash /opt/Leads-genx/scripts/install-vps.sh ${shellQuote(params.githubToken)}`;
  }

  function buildSecureCommand(params: DeployParams): string {
    const setupPayload = JSON.stringify({ username: params.adminUsername, password: params.adminPassword });
    // Idempotent: a re-run after a partial deployment must not fail when the
    // admin was already claimed (setup answers 403 once users exist).
    const lines: string[] = [
      'cd /tmp',
      "cat > lgx-admin.json << 'LGXEOF'",
      setupPayload,
      'LGXEOF',
      'HTTP_CODE=$(curl -s -o /dev/null -w \'%{http_code}\' -c lgx.jar -X POST http://127.0.0.1:4177/api/auth/setup -H \'Content-Type: application/json\' -d @lgx-admin.json)',
      'if [ "$HTTP_CODE" = "403" ]; then',
      "  echo 'Admin account already claimed — skipping.'",
      'elif [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "201" ]; then',
      '  echo "Admin claim failed (HTTP $HTTP_CODE)"',
      '  rm -f lgx-admin.json lgx-settings.json lgx.jar',
      '  exit 1',
      'fi',
    ];
    const settings = params.settings;
    const hasSettings = Boolean(
      settings &&
        (settings.apifyToken ||
          (settings.googleApiKeys && settings.googleApiKeys.length) ||
          (settings.proxyUrls && settings.proxyUrls.length) ||
          settings.defaultGoogleMapsActorId ||
          settings.defaultSalesNavigatorActorId)
    );
    if (settings && hasSettings) {
      const settingsPayload = JSON.stringify({
        apifyToken: settings.apifyToken,
        googleApiKeys: (settings.googleApiKeys ?? []).join('\n'),
        proxyUrls: (settings.proxyUrls ?? []).join('\n'),
        defaultGoogleMapsActorId: settings.defaultGoogleMapsActorId,
        defaultSalesNavigatorActorId: settings.defaultSalesNavigatorActorId,
      });
      lines.push(
        // Only copy settings when this run created the session (a 403 means
        // the admin was claimed earlier and we hold no valid cookie).
        'if [ "$HTTP_CODE" != "403" ]; then',
        "  cat > lgx-settings.json << 'LGXEOF'",
        settingsPayload,
        'LGXEOF',
        "  curl -fsS -b lgx.jar -X POST http://127.0.0.1:4177/api/settings -H 'Content-Type: application/json' -d @lgx-settings.json > /dev/null",
        'fi'
      );
    }
    lines.push('rm -f lgx-admin.json lgx-settings.json lgx.jar', "echo 'Server secured: admin account ready, settings in place.'");
    return lines.join('\n');
  }

  async function run(params: DeployParams): Promise<void> {
    const remote = { host: params.host, password: params.rootPassword };
    try {
      setPhase('connecting');
      log(`Connecting to root@${params.host} over SSH…`);

      setPhase('installing');
      log('Running the Leads-GenX installer on the server (this takes ~10-15 minutes)…');
      const installCode = await runRemote(remote, buildInstallCommand(params), log);
      if (installCode !== 0) throw new Error(`Installer exited with code ${installCode}.`);
      log('Installer finished — Leads-GenX is running on the server.');

      setPhase('securing');
      log('Claiming the admin account and copying your saved credentials…');
      const secureCode = await runRemote(remote, buildSecureCommand(params), log);
      if (secureCode !== 0) throw new Error(`Server securing step exited with code ${secureCode}.`);

      setPhase('awaiting_dns');
      log(`Waiting for DNS: point an A record for ${params.domain} at ${params.host}.`);
      const dnsDeadline = Date.now() + dnsMaxWaitMs;
      let matched = false;
      while (!matched && Date.now() < dnsDeadline) {
        dnsRecheckRequested = false;
        let addresses: string[] = [];
        try {
          addresses = await resolve4(params.domain);
        } catch {
          addresses = [];
        }
        if (addresses.includes(params.host)) {
          matched = true;
          break;
        }
        log(
          addresses.length
            ? `${params.domain} currently resolves to ${addresses.join(', ')} — waiting for it to become ${params.host}…`
            : `${params.domain} does not resolve yet — waiting for the A record…`
        );
        await interruptibleSleep(dnsIntervalMs);
      }
      if (!matched) throw new Error('DNS never pointed at the server within the waiting window.');

      setPhase('setting_up_https');
      log('DNS is live — setting up HTTPS…');
      const httpsCode = await runRemote(
        remote,
        `bash /opt/Leads-genx/scripts/setup-https.sh ${shellQuote(params.domain)}`,
        log
      );
      if (httpsCode !== 0) throw new Error(`HTTPS setup exited with code ${httpsCode}.`);

      setPhase('verifying');
      log('Verifying the site answers over HTTPS…');
      const verifyDeadline = Date.now() + verifyTimeoutMs;
      let live = false;
      while (!live && Date.now() < verifyDeadline) {
        live = await httpsOk(`https://${params.domain}/api/health`);
        if (!live) await sleep(5000);
      }
      if (!live) throw new Error('The site did not answer over HTTPS in time — check Caddy logs on the server.');

      setPhase('done');
      state.siteUrl = `https://${params.domain}`;
      state.finishedAt = new Date().toISOString();
      log(`Deployment complete — ${state.siteUrl} is live.`);
    } catch (error) {
      setPhase('error');
      state.error = error instanceof Error ? error.message : String(error);
      state.finishedAt = new Date().toISOString();
      log(`Deployment failed: ${state.error}`);
    }
  }

  return {
    start(params: DeployParams): DeployState {
      const active = !['idle', 'done', 'error'].includes(state.phase);
      if (active) throw new DeployConflictError('A deployment is already in progress.');
      secrets = [params.githubToken, params.rootPassword, params.adminPassword].filter((value) => Boolean(value));
      state = {
        phase: 'idle',
        log: [],
        serverIp: params.host,
        domain: params.domain,
        startedAt: new Date().toISOString(),
      };
      void run(params);
      return state;
    },
    getState(): DeployState {
      return {
        ...state,
        log: [...state.log],
      };
    },
    /** Ask the DNS wait loop to re-check immediately instead of sleeping. */
    recheckNow(): void {
      dnsRecheckRequested = true;
    },
  };
}

export type DeployService = ReturnType<typeof createDeployService>;
