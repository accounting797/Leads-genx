import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupSqliteDatabase, resolveSqlitePath } from '../../src/db/backup';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leads-backup-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('resolveSqlitePath', () => {
  it('resolves absolute file URLs directly', () => {
    const dir = makeTempDir();
    const db = path.join(dir, 'dev.db');
    fs.writeFileSync(db, 'data');
    expect(resolveSqlitePath(`file:${db}`)).toBe(db);
  });

  it('ignores non-sqlite and in-memory URLs', () => {
    expect(resolveSqlitePath('file::memory:')).toBeUndefined();
    expect(resolveSqlitePath('postgresql://localhost/db')).toBeUndefined();
    expect(resolveSqlitePath(undefined)).toBeUndefined();
  });
});

describe('backupSqliteDatabase', () => {
  it('copies the database into the backup dir and prunes to the keep limit', () => {
    const dir = makeTempDir();
    const db = path.join(dir, 'dev.db');
    fs.writeFileSync(db, 'sqlite-bytes');
    const backupDir = path.join(dir, 'backups');

    const first = backupSqliteDatabase(`file:${db}`, backupDir, 3);
    expect(first).toBeDefined();
    expect(fs.existsSync(first!)).toBe(true);
    expect(fs.readFileSync(first!, 'utf8')).toBe('sqlite-bytes');

    for (let index = 0; index < 5; index += 1) {
      backupSqliteDatabase(`file:${db}`, backupDir, 3);
    }
    expect(fs.readdirSync(backupDir).filter((file) => file.endsWith('.db')).length).toBe(3);
  });

  it('skips missing or empty databases', () => {
    const dir = makeTempDir();
    expect(backupSqliteDatabase(`file:${path.join(dir, 'missing.db')}`, path.join(dir, 'b'))).toBeUndefined();
    const empty = path.join(dir, 'empty.db');
    fs.writeFileSync(empty, '');
    expect(backupSqliteDatabase(`file:${empty}`, path.join(dir, 'b'))).toBeUndefined();
  });
});
