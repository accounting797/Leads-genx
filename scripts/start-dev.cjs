const { spawn } = require('child_process');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const serverEntry = path.join(repoRoot, 'dist', 'server.js');
const port = process.env.PORT || '4177';

const child = spawn(process.execPath, [serverEntry], {
  cwd: repoRoot,
  detached: true,
  env: process.env,
  stdio: 'ignore',
  windowsHide: true,
});

child.unref();

console.log(`Leads-GenX background server started on http://localhost:${port} pid ${child.pid}`);
