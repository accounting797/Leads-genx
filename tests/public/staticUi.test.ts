import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = path.join(__dirname, '..', '..');

function readPublicFile(fileName: string): string {
  return fs.readFileSync(path.join(projectRoot, 'public', fileName), 'utf8');
}

describe('static dashboard downloads', () => {
  it('exposes an email-only TXT download control', () => {
    const html = readPublicFile('index.html');

    expect(html).toContain('id="downloadEmails"');
    expect(html).not.toContain('id="downloadFullLeads"');
  });

  it('requests the email TXT download format from the UI', () => {
    const appJs = readPublicFile('app.js');

    expect(appJs).toContain("api.downloadLeads($('leadRunFilter').value, 'emails')");
    expect(appJs).not.toContain("api.downloadLeads($('leadRunFilter').value, 'full')");
  });
});

describe('static dashboard per-run copy emails', () => {
  it('renders a Copy Emails button for each run', () => {
    const uiJs = readPublicFile('ui.js');

    expect(uiJs).toContain('data-copy-run-emails');
    expect(uiJs).toContain('Copy Emails');
  });

  it('fetches and copies email TXT for a selected run', () => {
    const apiJs = readPublicFile('api.js');
    const appJs = readPublicFile('app.js');

    expect(apiJs).toContain('getLeadEmailsTxt');
    expect(appJs).toContain('navigator.clipboard.writeText');
    expect(appJs).toContain('api.getLeadEmailsTxt');
  });
});

describe('static dashboard run deletion', () => {
  it('renders delete buttons for runs', () => {
    const uiJs = readPublicFile('ui.js');

    expect(uiJs).toContain('data-delete-run');
  });

  it('calls the delete run API from the run table', () => {
    const apiJs = readPublicFile('api.js');
    const appJs = readPublicFile('app.js');

    expect(apiJs).toContain('deleteRun');
    expect(appJs).toContain('api.deleteRun');
  });
});

describe('static dashboard live progress', () => {
  it('refreshes runs and visible leads while active runs are polling', () => {
    const appJs = readPublicFile('app.js');

    expect(appJs).toContain('refreshLiveProgressTables');
    expect(appJs).toContain('await refreshLiveProgressTables(run.id)');
  });
});

describe('static dashboard Google Maps providers', () => {
  it('exposes Apify bulk and Google Places provider controls', () => {
    const html = readPublicFile('index.html');

    expect(html).toContain('id="gmProvider"');
    expect(html).toContain('value="apify"');
    expect(html).toContain('value="google_places"');
    expect(html).toContain('value="hybrid"');
    expect(html).toContain('id="googleApiKey"');
    expect(html).toContain('one per line');
  });

  it('submits the selected Google Maps provider and Google API key', () => {
    const appJs = readPublicFile('app.js');

    expect(appJs).toContain("provider: $('gmProvider').value");
    expect(appJs).toContain("googleApiKey: $('googleApiKey').value.trim()");
  });
});

describe('static dashboard credential entry', () => {
  it('uses multiline credential boxes for Apify and Google keys', () => {
    const html = readPublicFile('index.html');

    expect(html).toContain('<textarea id="apifyToken"');
    expect(html).toContain('<textarea id="googleApiKey"');
  });

  it('normalizes pasted credentials into one key per line', () => {
    const appJs = readPublicFile('app.js');

    expect(appJs).toContain('normalizeCredentialBox');
    expect(appJs).toContain("normalizeCredentialBox($('apifyToken'))");
    expect(appJs).toContain("normalizeCredentialBox($('googleApiKey'))");
  });
});
