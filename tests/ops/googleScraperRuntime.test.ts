import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('local Google Maps scraper runtime', () => {
  it('uses the pinned local image without deleting the Playwright driver', () => {
    const compose = read('docker-compose.google-scraper.yml');
    expect(compose).toContain('leads-genx/google-maps-scraper:1.16.3-local');
    expect(compose).toContain('127.0.0.1:8080:8080');
    expect(compose).toContain('healthcheck:');
    expect(compose).toContain('restart: unless-stopped');
    expect(compose).not.toContain('rm -rf /opt/ms-playwright-go');
  });

  it('builds from GOOGLE_MAPS_SCRAPER_SOURCE and labels the revision', () => {
    const script = read('scripts/build-google-scraper.ps1');
    expect(script).toContain('GOOGLE_MAPS_SCRAPER_SOURCE');
    expect(script).toContain('leads-genx.scraper.revision');
    expect(script).toContain('leads-genx/google-maps-scraper:1.16.3-local');
    expect(script).toContain('status --porcelain');
    expect(script).toContain('image ls --quiet');
    expect(script).toContain('{{json .Config.Labels}}');
  });

  it('starts idempotently and waits for the local health endpoint', () => {
    const script = read('scripts/start-google-scraper.ps1');
    expect(script).toContain('up -d --force-recreate');
    expect(script).toContain('container rm --force leads-genx-gmaps-scraper');
    expect(script).toContain('http://127.0.0.1:8080/api/v1/jobs');
    expect(script).toContain('90');
    expect(script).toContain('logs --tail');
  });
});
