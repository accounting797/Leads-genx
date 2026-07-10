import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = path.join(__dirname, '..', '..');

function readPublicFile(fileName: string): string {
  return fs.readFileSync(path.join(projectRoot, 'public', fileName), 'utf8');
}

describe('static dashboard downloads', () => {
  it('exposes separate email-only and full TXT download controls', () => {
    const html = readPublicFile('index.html');

    expect(html).toContain('id="downloadEmails"');
    expect(html).toContain('id="downloadFullLeads"');
  });

  it('requests explicit download formats from the UI', () => {
    const appJs = readPublicFile('app.js');

    expect(appJs).toContain("api.downloadLeads($('leadRunFilter').value, 'emails')");
    expect(appJs).toContain("api.downloadLeads($('leadRunFilter').value, 'full')");
  });
});

describe('static dashboard Google Maps providers', () => {
  it('exposes Apify bulk and Google Places provider controls', () => {
    const html = readPublicFile('index.html');

    expect(html).toContain('id="gmProvider"');
    expect(html).toContain('value="apify"');
    expect(html).toContain('value="google_places"');
    expect(html).toContain('id="googleApiKey"');
  });

  it('submits the selected Google Maps provider and Google API key', () => {
    const appJs = readPublicFile('app.js');

    expect(appJs).toContain("provider: $('gmProvider').value");
    expect(appJs).toContain("googleApiKey: $('googleApiKey').value.trim()");
  });
});
