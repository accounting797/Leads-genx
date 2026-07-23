import fs from 'node:fs';
import path from 'node:path';

export function resolveSqlitePath(databaseUrl?: string): string | undefined {
  if (!databaseUrl || !databaseUrl.startsWith('file:')) return undefined;
  const raw = databaseUrl.slice('file:'.length).split('?')[0];
  if (!raw || raw === ':memory:') return undefined;
  if (path.isAbsolute(raw)) return raw;
  // Prisma resolves relative SQLite paths against the schema directory (prisma/).
  const fromSchema = path.resolve('prisma', raw);
  if (fs.existsSync(fromSchema)) return fromSchema;
  return path.resolve(raw);
}

export function backupSqliteDatabase(
  databaseUrl?: string,
  backupDir = path.resolve('backups'),
  keep = 10
): string | undefined {
  const dbPath = resolveSqlitePath(databaseUrl);
  if (!dbPath || !fs.existsSync(dbPath)) return undefined;
  if (!fs.statSync(dbPath).size) return undefined;

  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.basename(dbPath, '.db');
  let target = path.join(backupDir, `${base}-${stamp}.db`);
  let counter = 1;
  while (fs.existsSync(target)) {
    target = path.join(backupDir, `${base}-${stamp}-${counter}.db`);
    counter += 1;
  }
  fs.copyFileSync(dbPath, target);

  const backups = fs
    .readdirSync(backupDir)
    .filter((file) => file.endsWith('.db'))
    .sort();
  while (backups.length > keep) {
    const oldest = backups.shift();
    if (oldest) fs.rmSync(path.join(backupDir, oldest), { force: true });
  }
  return target;
}
