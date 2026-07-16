import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = path.join(__dirname, '..', '..');

function readPublicFile(fileName: string): string {
  return fs.readFileSync(path.join(projectRoot, 'public', fileName), 'utf8');
}

describe('static dashboard downloads', () => {
  it('makes the top leads metric open the all-runs leads view', () => {
    const html = readPublicFile('index.html');
    const appJs = readPublicFile('app.js');

    expect(html).toContain('id="metricLeadsCard"');
    expect(appJs).toContain("openAllLeads");
    expect(appJs).toContain("$('metricLeadsCard').addEventListener('click', openAllLeads)");
  });

  it('shows an all-runs email lead count in the leads tab', () => {
    const html = readPublicFile('index.html');
    const appJs = readPublicFile('app.js');

    expect(html).toContain('id="leadSummary"');
    expect(appJs).toContain("$('leadSummary').textContent");
  });

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
  it('locks Google Maps runs to the automatic Docker-primary pipeline', () => {
    const html = readPublicFile('index.html');

    expect(html).toContain('id="gmProvider"');
    expect(html).toContain('type="hidden" value="local_first"');
    expect(html).toContain('Docker scraper primary');
    expect(html).toContain('Google Places fallback');
    expect(html).not.toContain('<select id="gmProvider"');
    expect(html).toContain('id="googleApiKey"');
    expect(html).toContain('id="gmApiBudget"');
    expect(html).toContain('id="gmProxyUrls"');
    expect(html).toContain('one per line');
  });

  it('submits the selected Google Maps provider and Google API key', () => {
    const appJs = readPublicFile('app.js');

    expect(appJs).toContain("provider: $('gmProvider').value");
    expect(appJs).toContain("googleApiKey: $('googleApiKey').value.trim()");
    expect(appJs).toContain("proxyUrls: $('gmProxyUrls').value.trim()");
  });

  it('forces the local-first provider in every submitted Google Maps run', () => {
    const appJs = readPublicFile('app.js');

    expect(appJs).toContain("$('gmProvider').value = 'local_first'");
    expect(appJs).not.toContain("$('gmProvider').addEventListener('change'");
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

  it('clears request-scoped secrets immediately after a run is accepted', () => {
    const appJs = readPublicFile('app.js');
    expect(appJs).toContain("$('googleApiKey').value = ''");
    expect(appJs).toContain("$('gmProxyUrls').value = ''");
    expect(appJs).toContain("$('snCookies').value = ''");
    expect(appJs).toContain("$('snUserAgent').value = ''");
  });
});

describe('static dashboard Sales Navigator credentials', () => {
  it('collects exported cookies and the matching browser user agent', () => {
    const html = readPublicFile('index.html');
    const appJs = readPublicFile('app.js');

    expect(html).toContain('id="snCookies"');
    expect(html).toContain('id="snUserAgent"');
    expect(appJs).toContain("cookies: $('snCookies').value.trim()");
    expect(appJs).toContain("userAgent: $('snUserAgent').value.trim()");
  });

  it('applies the 2500 result ceiling only to Sales Navigator', () => {
    const appJs = readPublicFile('app.js');

    expect(appJs).toContain('applySourceLimits');
    expect(appJs).toContain("maxResults.max = '2500'");
    expect(appJs).toContain("maxResults.removeAttribute('max')");
  });

  it('restores the previous max result value when switching back to Google Maps', () => {
    const appJs = readPublicFile('app.js');

    expect(appJs).toContain('maxResultsBySource[activeSource] = maxResults.value');
    expect(appJs).toContain('maxResults.value = maxResultsBySource[source]');
  });
});
