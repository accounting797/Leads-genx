import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Prisma client generation baseline', () => {
  it('regenerates schema delegates before tests and production builds', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.pretest).toBe('node scripts/ensure-prisma-client.cjs');
    expect(pkg.scripts?.prebuild).toBe('node scripts/ensure-prisma-client.cjs');
  });
});
