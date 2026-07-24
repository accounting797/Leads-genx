import { describe, expect, it } from 'vitest';
import { createDeployService, DeployConflictError, DeployParams } from '../../src/domain/deployService';

function makeParams(overrides: Partial<DeployParams> = {}): DeployParams {
  return {
    host: '1.2.3.4',
    rootPassword: 'root-secret-pw',
    githubToken: 'ghp-secret-token',
    domain: 'leads.example.com',
    adminUsername: 'owner',
    adminPassword: 'admin-secret-pw',
    settings: { apifyToken: 'apify-secret', googleApiKeys: ['google-secret'] },
    ...overrides,
  };
}

function fastDeps(overrides: Record<string, unknown> = {}) {
  return {
    sleep: async () => {},
    dnsIntervalMs: 1,
    verifyTimeoutMs: 200,
    ...overrides,
  };
}

async function waitFor(condition: () => boolean, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition never became true');
}

describe('deployService happy path', () => {
  it('runs install → secure → DNS wait → HTTPS → verify → done, masking all secrets', async () => {
    const commands: string[] = [];
    let dnsCalls = 0;
    let httpsCalls = 0;
    const service = createDeployService(
      fastDeps({
        runRemote: async (_opts: unknown, command: string, onLog: (line: string) => void) => {
          commands.push(command);
          onLog('installer says token is ghp-secret-token and pw root-secret-pw');
          return 0;
        },
        resolve4: async () => {
          dnsCalls += 1;
          return dnsCalls < 2 ? [] : ['1.2.3.4'];
        },
        httpsOk: async () => {
          httpsCalls += 1;
          return httpsCalls > 1;
        },
      })
    );

    service.start(makeParams());
    await waitFor(() => service.getState().phase === 'done');

    const state = service.getState();
    expect(state.siteUrl).toBe('https://leads.example.com');
    expect(commands.some((cmd) => cmd.includes('install-vps.sh'))).toBe(true);
    expect(commands.some((cmd) => cmd.includes('/api/auth/setup'))).toBe(true);
    expect(commands.some((cmd) => cmd.includes('setup-https.sh'))).toBe(true);
    // The settings copy includes saved credentials.
    expect(commands.some((cmd) => cmd.includes('/api/settings'))).toBe(true);
    // Every logged line has secrets masked out.
    const fullLog = state.log.join('\n');
    expect(fullLog).toContain('••••••');
    expect(fullLog).not.toContain('ghp-secret-token');
    expect(fullLog).not.toContain('root-secret-pw');
    expect(fullLog).not.toContain('admin-secret-pw');
  });
});

describe('deployService failure handling', () => {
  it('lands on error when the installer exits non-zero', async () => {
    const service = createDeployService(
      fastDeps({
        runRemote: async (_opts: unknown, _cmd: string, onLog: (line: string) => void) => {
          onLog('something exploded');
          return 1;
        },
      })
    );
    service.start(makeParams());
    await waitFor(() => service.getState().phase === 'error');
    expect(service.getState().error).toMatch(/exit.*1/i);
  });

  it('lands on error when SSH fails, without leaking the password', async () => {
    const service = createDeployService(
      fastDeps({
        runRemote: async () => {
          throw new Error('connect ETIMEDOUT 1.2.3.4:22');
        },
      })
    );
    service.start(makeParams());
    await waitFor(() => service.getState().phase === 'error');
    const state = service.getState();
    expect(state.error).toMatch(/ETIMEDOUT/);
    expect(state.log.join('\n')).not.toContain('root-secret-pw');
  });

  it('lands on error when DNS never propagates', async () => {
    const service = createDeployService(
      fastDeps({
        dnsMaxWaitMs: 5,
        runRemote: async () => 0,
        resolve4: async () => ['9.9.9.9'],
      })
    );
    service.start(makeParams());
    await waitFor(() => service.getState().phase === 'error');
    expect(service.getState().error).toMatch(/DNS/);
  });

  it('refuses to start a second deployment while one is running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createDeployService(
      fastDeps({
        runRemote: async () => {
          await gate;
          return 0;
        },
        resolve4: async () => ['1.2.3.4'],
        httpsOk: async () => true,
      })
    );
    service.start(makeParams());
    expect(() => service.start(makeParams())).toThrow(DeployConflictError);
    release();
    await waitFor(() => service.getState().phase === 'done');
    // After finishing, a new deployment is allowed again.
    expect(() => service.start(makeParams())).not.toThrow();
  });
});
