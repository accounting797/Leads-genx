const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const root = join(__dirname, '..');
const sourceSchema = join(root, 'prisma', 'schema.prisma');
const generatedClient = join(root, 'node_modules', '.prisma', 'client', 'index.js');
const fingerprintFile = join(root, 'node_modules', '.prisma', 'client', 'leads-genx-schema.sha256');

function contents(path) {
  try {
    return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return undefined;
  }
}

const fingerprint = createHash('sha256').update(contents(sourceSchema) || '').digest('hex');
if (existsSync(generatedClient) && contents(fingerprintFile)?.trim() === fingerprint) process.exit(0);

const prismaCli = join(root, 'node_modules', 'prisma', 'build', 'index.js');
const result = spawnSync(process.execPath, [prismaCli, 'generate'], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
if (result.status === 0) writeFileSync(fingerprintFile, `${fingerprint}\n`, 'utf8');
process.exit(result.status == null ? 1 : result.status);
