import { execFileSync } from 'child_process';
import { once } from 'events';
import { spawn } from 'child_process';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { afterEach, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const serverScript = path.join(repoRoot, 'scripts', 'start-dev.cjs');
const testPort = 4188;

let launchedPid: number | undefined;

async function waitForHealth(port: number, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/api/health`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.text();
      }
    } catch {
      // keep polling
    }
    await delay(250);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function stopLaunchedProcess() {
  if (!launchedPid) return;
  try {
    execFileSync('taskkill', ['/PID', String(launchedPid), '/T', '/F'], {
      stdio: 'ignore',
    });
  } catch {
    // best effort cleanup
  } finally {
    launchedPid = undefined;
  }
}

afterEach(async () => {
  await stopLaunchedProcess();
});

it('starts the compiled server in the background and returns immediately', async () => {
  const child = spawn(process.execPath, [serverScript], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(testPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const [exitCode] = await once(child, 'exit');
  expect(exitCode).toBe(0);
  expect(stderr).toBe('');
  expect(stdout).toContain('Leads-GenX is LIVE');
  expect(stdout).toContain(String(testPort));

  const pidMatch = stdout.match(/pid\s+(\d+)/i);
  expect(pidMatch).not.toBeNull();
  launchedPid = Number(pidMatch?.[1]);

  const health = await waitForHealth(testPort);
  expect(health).toContain('ok');
});
