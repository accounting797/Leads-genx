const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const serverEntry = path.join(repoRoot, 'dist', 'server.js');
const port = process.env.PORT || '4177';
const logsDir = path.join(repoRoot, 'logs');
const serverLog = path.join(logsDir, 'server.log');

fs.mkdirSync(logsDir, { recursive: true });
const out = fs.openSync(serverLog, 'a');

const child = spawn(process.execPath, [serverEntry], {
  cwd: repoRoot,
  detached: true,
  env: process.env,
  stdio: ['ignore', out, out],
  windowsHide: true,
});

child.unref();

function healthCheck(attemptsLeft) {
  const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
    res.resume();
    if (res.statusCode === 200) {
      console.log(`Leads-GenX is LIVE on http://localhost:${port} (pid ${child.pid})`);
      console.log('Open that address in your browser. Server output: logs/server.log');
      process.exit(0);
    }
    retry(attemptsLeft);
  });
  req.on('error', () => retry(attemptsLeft));
  req.setTimeout(1500, () => req.destroy());
}

function retry(attemptsLeft) {
  if (attemptsLeft <= 0) {
    console.error('Server did not come up. Last lines of logs/server.log:');
    try {
      const lines = fs.readFileSync(serverLog, 'utf8').trim().split('\n');
      lines.slice(-8).forEach((line) => console.error('  ' + line));
    } catch {
      console.error('  (log file unavailable)');
    }
    process.exit(1);
  }
  setTimeout(() => healthCheck(attemptsLeft - 1), 1000);
}

console.log('Starting Leads-GenX...');
setTimeout(() => healthCheck(8), 1500);
