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

describe('admin targeted scraping wizard', () => {
  it('opens a dedicated animated targeted workspace with run controls and complete exports', () => {
    const html = readPublicFile('targeted.html');
    const js = readPublicFile('targeted.js');
    const css = readPublicFile('targeted.css');
    expect(html).toContain('id="targetedCommandCenter"');
    expect(html).toContain('id="targetedRunHistory"');
    expect(html).toContain('id="targetedDownloadAllBtn"');
    expect(html).toContain('id="targetedQualityFunnel"');
    expect(js).toContain('listTargetedCampaigns');
    expect(js).toContain('stopTargetedCampaign');
    expect(js).toContain('downloadTargetedStrict');
    expect(js).toContain('downloadAllTargetedStrict');
    expect(js).toContain('deleteTargetedCampaign');
    expect(js).toContain('data-delete-run');
    expect(css).toContain('@keyframes targetedPulse');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(html).toContain('/targeted.js?v=20260803-stop5');
    expect(html).toContain('/targeted.css?v=20260803-stop4');
  });

  it('acknowledges targeted cancellation immediately instead of waiting for a full refresh', () => {
    const js = readPublicFile('targeted.js');
    const appJs = readPublicFile('app.js');
    const css = readPublicFile('targeted.css');
    expect(js).toContain('async function stopCampaign');
    expect(js).toContain('Stopping run #');
    expect(js).toContain("$('targetedStopBtn').disabled = true");
    expect(js).toContain("['queued', 'running', 'waiting_for_scraper']");
    expect(js).toContain('refreshVersion !== targetedRefreshVersion');
    expect(appJs).toContain('async function stopTargetedCampaignImmediate');
    expect(appJs).toContain('Targeted campaign cancelled.');
    expect(js).toContain("renderActiveSubstitution(detail.workUnits || [], detail.status)");
    expect(js).toContain('RUN ENDED Â· CANCELLED');
    expect(css).toContain('body[data-running="false"] .targeted-signal i');
  });

  it('renders a compact automatic workflow with advanced controls collapsed', () => {
    const html = readPublicFile('index.html');
    expect(html).toContain('data-tab="targeted"');
    expect(html).toContain('data-admin-only');
    expect(html).toContain('id="targetedPrompt"');
    expect(html).toContain('id="targetedQualityFunnel"');
    expect(html).toContain('id="targetedMarketLimit"');
    expect(html).toContain('id="targetedMarketLimit" type="number" min="1" max="100" value="100"');
    expect(html).toContain('id="targetedPublicSearchBudget"');
    expect(html).toContain('id="targetedAdvanced"');
    expect(html).toContain('id="targetedTierFilter"');
    expect(html).toContain('Automatically resolve');
    expect(html).not.toContain('Preview only in localhost MVP');
    expect(html).not.toContain('data-targeted-stage=');
  });

  it('loads the catalog, starts campaigns, and polls active results', () => {
    const appJs = readPublicFile('app.js');
    const apiJs = readPublicFile('api.js');
    expect(appJs).toContain('loadTargetedCatalog');
    expect(appJs).toContain('startTargetedCampaign');
    expect(appJs).toContain('renderTargetedFunnel');
    expect(appJs).toContain("api.getTargetedCandidates(campaignId, $('targetedTierFilter').value)");
    expect(appJs).toContain("$('targetedBank').addEventListener('change', loadTargetedBankMarkets)");
    expect(appJs).toContain('3000');
    expect(apiJs).toContain('createTargetedCampaign');
    expect(apiJs).toContain('getTargetedCampaign');
    expect(apiJs).toContain("'/targeted/campaigns/' + id + '/export?quality=strict'");
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

describe('static dashboard command radar', () => {
  it('renders the radar with sweep, blips, completion ring, orbits, and heartbeat legend', () => {
    const html = readPublicFile('index.html');

    for (const id of [
      'radarShell',
      'radarSweep',
      'radarBlips',
      'radarRingFill',
      'radarPercent',
      'radarEta',
      'orbitDocker',
      'orbitGoogle',
      'orbitApify',
      'radarMode',
      'radarHeartbeat',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('animates the sweep only from real heartbeat state and pauses motion otherwise', () => {
    const css = readPublicFile('styles.css');
    const appJs = readPublicFile('app.js');

    expect(css).toContain('@keyframes radar-sweep-rotate');
    expect(css).toContain(".radar-shell[data-state='active'] .radar-sweep");
    expect(css).toContain(".radar-shell[data-state='stale'] .radar-sweep");
    expect(css).toContain(".radar-shell[data-state='waiting'] .radar-sweep");
    expect(css).toContain('animation-play-state: paused');
    expect(css).toContain('prefers-reduced-motion');
    expect(appJs).toContain('shell.dataset.state = state');
    expect(appJs).toContain("'stale'");
    expect(appJs).toContain('Stale heartbeat');
  });

  it('marks newly persisted businesses as blips and labels ETA as a range estimate', () => {
    const appJs = readPublicFile('app.js');

    expect(appJs).toContain('spawnBlips(businesses - knownBusinessCount)');
    expect(appJs).toContain('estimateEtaRange');
    expect(appJs).toContain('· est.');
  });

  it('glows provider orbits from provider events and output mode', () => {
    const appJs = readPublicFile('app.js');

    expect(appJs).toContain("setOrbit('orbitDocker'");
    expect(appJs).toContain("setOrbit('orbitGoogle'");
    expect(appJs).toContain("setOrbit('orbitApify'");
    expect(appJs).toContain("run.actorId === 'hybrid'");
    expect(appJs).toContain("types.includes('local_batch_started')");
    expect(appJs).toContain("types.includes('google_places_started')");
  });

  it('stops polling on every terminal state with labeled stages', () => {
    const appJs = readPublicFile('app.js');

    expect(appJs).toContain("['partially_completed', 'cancelled', 'paused'].includes(run.status)");
    expect(appJs).toContain('Partially completed');
    expect(appJs).toContain('Cancelled');
    expect(appJs).toContain('cooling_down');
  });
});

describe('static dashboard settings page', () => {
  it('exposes a Settings tab with credential and proxy management controls', () => {
    const html = readPublicFile('index.html');

    expect(html).toContain('data-tab="settings"');
    expect(html).toContain('id="settingsTab"');
    for (const id of [
      'setGoogleActor',
      'setSalesNavActor',
      'setApifyToken',
      'setGoogleKeys',
      'setProxyUrls',
      'savedProxyList',
      'testProxiesBtn',
      'saveSettingsBtn',
      'settingsStatus',
      'quarantineBanner',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('surfaces engineer-quarantined credentials in Settings', () => {
    const appJs = readPublicFile('app.js');
    const css = readPublicFile('styles.css');

    expect(appJs).toContain('renderQuarantineBanner');
    expect(appJs).toContain('quarantinedCredentials');
    expect(appJs).toContain('Nova needs a fresh key');
    expect(css).toContain('.quarantine-banner');
    expect(css).toContain('.nova-request-head');
  });

  it('announces auto-resumed runs and the cooling system in Nova’s voice', () => {
    const appJs = readPublicFile('app.js');

    expect(appJs).toContain('resumedRuns');
    expect(appJs).toContain('Nova accepted the fresh key and resumed');
    expect(appJs).toContain('Nova is cooling the engines before the next burst');
    expect(appJs).toContain('Nova is waiting for a fresh key');
  });

  it('offers a one-click server update alongside the full deployment wizard', () => {
    const html = readPublicFile('index.html');
    const appJs = readPublicFile('app.js');
    const apiJs = readPublicFile('api.js');

    expect(html).toContain('id="deployUpdateBlock"');
    expect(html).toContain('id="updateHost"');
    expect(html).toContain('id="updatePassword"');
    expect(html).toContain('id="updateStartBtn"');
    expect(html).toContain('id="updateToken"');
    expect(appJs).toContain('githubToken');
    expect(apiJs).toContain("'/admin/deploy/update'");
    expect(appJs).toContain('startServerUpdate');
    expect(appJs).toContain('savedTarget');
    expect(appJs).toContain("updating: 'Updating server…'");
  });

  it('loads, saves, and clears settings without redisplaying secrets', () => {
    const apiJs = readPublicFile('api.js');
    const appJs = readPublicFile('app.js');

    expect(apiJs).toContain("requestJson('/settings')");
    expect(apiJs).toContain("'/settings/proxies/test'");
    expect(appJs).toContain("$('setApifyToken').value = ''");
    expect(appJs).toContain("$('setGoogleKeys').value = ''");
    expect(appJs).toContain("$('setProxyUrls').value = ''");
    expect(appJs).toContain("saveSettings({ apifyToken: '' })");
    expect(appJs).toContain("saveSettings({ proxyUrls: '' })");
  });

  it('lets runs opt into the saved Settings proxy pool', () => {
    const html = readPublicFile('index.html');
    const appJs = readPublicFile('app.js');

    expect(html).toContain('id="gmUseSavedProxies"');
    expect(appJs).toContain("routeMode: $('gmUseSavedProxies').checked ? 'proxy' : undefined");
  });

  it('live-tests Apify and Google credentials from the Settings page', () => {
    const html = readPublicFile('index.html');
    const apiJs = readPublicFile('api.js');
    const appJs = readPublicFile('app.js');

    expect(html).toContain('id="testApifyBtn"');
    expect(html).toContain('id="testGoogleBtn"');
    expect(apiJs).toContain("'/settings/test/apify'");
    expect(apiJs).toContain("'/settings/test/google'");
    expect(appJs).toContain('testApifyCredential');
    expect(appJs).toContain('testGoogleCredentials');
  });

  it('shows the active run configuration beside the live progress radar', () => {
    const html = readPublicFile('index.html');
    const appJs = readPublicFile('app.js');

    expect(html).toContain('id="runConfig"');
    expect(appJs).toContain('refreshRunConfig');
    expect(appJs).toContain("' · Route: ' + run.routeMode");
  });
});

describe('static dashboard chip inputs', () => {
  it('commits free-text entries without requiring the Enter key', () => {
    const chipsJs = readPublicFile('chips.js');
    const appJs = readPublicFile('app.js');

    expect(chipsJs).toContain("input.value.includes(',')");
    expect(chipsJs).toContain("input.addEventListener('blur'");
    expect(chipsJs).toContain('commitPending()');
    expect(appJs).toContain('chips.gmSearchTerms.commitPending()');
    expect(appJs).toContain('chips.gmLocations.commitPending()');
  });
});

describe('static dashboard Google Maps providers', () => {
  it('offers an official console-style Standard and Hybrid Max Output mode selector', () => {
    const html = readPublicFile('index.html');
    const css = readPublicFile('styles.css');

    expect(html).toContain('id="outputModeSelect"');
    expect(html).toContain('data-mode="standard"');
    expect(html).toContain('data-mode="hybrid_max"');
    expect(html).toContain('Docker + Google');
    expect(html).toContain('Hybrid Max Output');
    expect(html).toContain('class="mode-glider"');
    expect(html).toContain('class="mode-conduit"');
    expect(html).toContain('class="mode-led"');
    expect(html).toContain('ENGAGED');
    expect(html).toContain('2 engines');
    expect(html).toContain('3 engines');
    expect(html).not.toContain('value="apify"');
    expect(html).not.toContain('value="google_places"');
    expect(html).toContain('id="gmApiBudget"');
    expect(html).toContain('id="gmProxyUrls"');
    expect(css).toContain('.mode-card.active');
    expect(css).toContain(".mode-select[data-selected='hybrid_max'] .mode-glider");
    expect(css).toContain('@keyframes engine-ignite');
    expect(css).toContain('@keyframes conduit-flow');
    expect(css).toContain('@keyframes mode-ripple');
    expect(css).toContain('@keyframes mode-led-breathe');
  });

  it('keeps credentials out of the run form and points operators to Settings', () => {
    const html = readPublicFile('index.html');
    const appJs = readPublicFile('app.js');

    expect(html).not.toContain('id="apifyToken"');
    expect(html).not.toContain('id="googleApiKey"');
    expect(html).toContain('Settings');
    expect(appJs).not.toContain("$('apifyToken')");
    expect(appJs).not.toContain("$('googleApiKey')");
  });

  it('submits the selected output mode and proxy route', () => {
    const appJs = readPublicFile('app.js');

    expect(appJs).toContain('outputMode: selectedOutputMode');
    expect(appJs).toContain("proxyUrls: $('gmProxyUrls').value.trim()");
    expect(appJs).toContain("routeMode: $('gmUseSavedProxies').checked ? 'proxy' : undefined");
  });

  it('submits Standard by default and switches to Hybrid only when selected', () => {
    const appJs = readPublicFile('app.js');

    expect(appJs).toContain("selectedOutputMode = 'standard'");
    expect(appJs).toContain("selectedOutputMode === 'hybrid_max'");
    expect(appJs).toContain("setOutputMode(card.dataset.mode)");
  });

  it('renders an AI Analyst live report panel under Live Progress', () => {
    const html = readPublicFile('index.html');
    const appJs = readPublicFile('app.js');
    const apiJs = readPublicFile('api.js');
    const css = readPublicFile('styles.css');

    expect(html).toContain('id="analystPanel"');
    expect(html).toContain('Nova — AI Assistant');
    expect(html).toContain('id="analystVerdict"');
    expect(html).toContain('id="analystHeadline"');
    expect(html).toContain('id="analystLines"');
    expect(apiJs).toContain("'/runs/' + id + '/analyst'");
    expect(appJs).toContain('renderAnalyst');
    expect(css).toContain(".analyst-verdict[data-verdict='needs_attention']");
    expect(css).toContain(".analyst-verdict[data-verdict='perfect']");
    expect(css).toContain('.analyst-orb-sweep');
  });

  it('keeps the analyst visibly alive with a live chip, ticker, and entrance motion', () => {
    const html = readPublicFile('index.html');
    const appJs = readPublicFile('app.js');
    const css = readPublicFile('styles.css');

    expect(html).toContain('id="analystLive"');
    expect(html).toContain('id="analystTicker"');
    expect(appJs).toContain('NOVA ONLINE');
    expect(appJs).toContain('setAnalystLive');
    expect(appJs).toContain('lastAnalystFingerprint');
    expect(appJs).toContain('Live telemetry · last scan');
    expect(css).toContain('@keyframes analyst-live-pulse');
    expect(css).toContain('@keyframes analyst-line-in');
    expect(css).toContain('@keyframes analyst-ticker-scan');
  });

  it('lets the operator stop an active run from the run history', () => {
    const uiJs = readPublicFile('ui.js');
    const appJs = readPublicFile('app.js');
    const apiJs = readPublicFile('api.js');
    const css = readPublicFile('styles.css');

    expect(uiJs).toContain('data-stop-run');
    expect(apiJs).toContain("'/runs/' + id + '/stop'");
    expect(appJs).toContain('async function stopRun');
    expect(appJs).toContain('api.stopRun(runId)');
    expect(css).toContain('.ghost-btn.danger');
  });
});

describe('static dashboard source-aware progress', () => {
  it('shows business, email, batch, waiting, Google, and Apify progress states', () => {
    const appJs = readPublicFile('app.js');
    expect(appJs).toContain('run.businessCount');
    expect(appJs).toContain('run.leadCount');
    expect(appJs).toContain('run.batches');
    expect(appJs).toContain('waiting_for_scraper');
    expect(appJs).toContain('waiting_for_credentials');
    expect(appJs).toContain('google_places_started');
    expect(appJs).toContain('apify_shard_started');
  });
});

describe('static dashboard credential entry', () => {
  it('clears request-scoped secrets immediately after a run is accepted', () => {
    const appJs = readPublicFile('app.js');
    expect(appJs).toContain("$('gmProxyUrls').value = ''");
    expect(appJs).toContain("$('snCookies').value = ''");
    expect(appJs).toContain("$('snUserAgent').value = ''");
  });
});

describe('static dashboard balanced Google and Docker progress', () => {
  it('describes concurrent discovery with a 50-request default', () => {
    const html = readPublicFile('index.html');
    const appJs = readPublicFile('app.js');
    expect(html).toContain('Google and Docker start together');
    expect(html).toContain('id="gmApiBudget" type="number" min="1" max="500" value="50"');
    expect(appJs).toContain("numberValue('gmApiBudget') ?? 50");
    expect(html).not.toContain('Docker runs first');
  });

  it('shows provider, website, duplicate, and API attempt counts', () => {
    const html = readPublicFile('index.html');
    const appJs = readPublicFile('app.js');
    for (const id of ['progressGoogle', 'progressDocker', 'progressWebsites', 'progressDuplicates', 'progressApi']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(appJs).toContain('run.googleBusinessCount');
    expect(appJs).toContain('run.localBusinessCount');
    expect(appJs).toContain('run.websiteCount');
    expect(appJs).toContain('run.duplicateCount');
    expect(appJs).toContain('run.apiRequestsUsed');
    expect(appJs).toContain('run.apiRequestBudget');
  });

  it('recognizes simultaneous provider and actionable failure states', () => {
    const appJs = readPublicFile('app.js');
    expect(appJs).toContain('google_places_started');
    expect(appJs).toContain('local_batch_started');
    expect(appJs).toContain('google_key_accepted');
    expect(appJs).toContain('google_places_failed');
    expect(appJs).toContain('local_empty_circuit_opened');
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

describe('static dashboard accounts and access control', () => {
  it('ships an auth gate with login and first-run setup forms', () => {
    const html = readPublicFile('index.html');
    const appJs = readPublicFile('app.js');
    const apiJs = readPublicFile('api.js');

    expect(html).toContain('id="authGate"');
    expect(html).toContain('id="loginForm"');
    expect(html).toContain('id="setupForm"');
    expect(html).toContain('id="authUsername"');
    expect(html).toContain('id="setupPasswordConfirm"');
    expect(appJs).toContain('showAuthGate');
    expect(appJs).toContain('api.getMe()');
    expect(appJs).toContain('needsSetup');
    expect(apiJs).toContain("'/auth/login'");
    expect(apiJs).toContain("'/auth/setup'");
    expect(apiJs).toContain("'/auth/logout'");
  });

  it('marks admin-only surfaces and hides them for non-admins', () => {
    const html = readPublicFile('index.html');
    const appJs = readPublicFile('app.js');

    expect(html).toContain('data-admin-only');
    expect(html).toContain('id="adminTabBtn"');
    expect(appJs).toContain("[data-admin-only]");
    expect(appJs).toContain('isAdmin()');
  });

  it('locks the Hybrid Max card for standard-tier users', () => {
    const html = readPublicFile('index.html');
    const appJs = readPublicFile('app.js');
    const css = readPublicFile('styles.css');

    expect(html).toContain('id="hybridLockHint"');
    expect(html).toContain('id="hybridLockUpgrade"');
    expect(appJs).toContain('hybridUnlocked()');
    expect(appJs).toContain("tierLocked");
    expect(css).toContain('[data-tier-locked="true"]');
  });

  it('ships an admin panel for user management and upgrade approvals', () => {
    const html = readPublicFile('index.html');
    const appJs = readPublicFile('app.js');
    const apiJs = readPublicFile('api.js');

    expect(html).toContain('id="adminTab"');
    expect(html).toContain('id="adminNewUsername"');
    expect(html).toContain('id="adminNewTier"');
    expect(html).toContain('id="adminUsersTable"');
    expect(html).toContain('id="upgradeRequests"');
    expect(appJs).toContain('adminCreateUser');
    expect(appJs).toContain('data-upgrade-approve');
    expect(appJs).toContain('data-admin-delete');
    expect(apiJs).toContain("'/admin/users'");
    expect(apiJs).toContain("'/admin/upgrade-requests'");
  });

  it('ships an account tab with plan info, upgrade request, and password change', () => {
    const html = readPublicFile('index.html');
    const appJs = readPublicFile('app.js');
    const apiJs = readPublicFile('api.js');

    expect(html).toContain('id="accountTab"');
    expect(html).toContain('id="upgradeBtn"');
    expect(html).toContain('id="acctNewPassword"');
    expect(appJs).toContain('requestUpgrade');
    expect(appJs).toContain('changeOwnPassword');
    expect(apiJs).toContain("'/auth/request-upgrade'");
    expect(apiJs).toContain("'/auth/password'");
  });

  it('shows the signed-in user chip with a plan badge and sign-out', () => {
    const html = readPublicFile('index.html');
    const css = readPublicFile('styles.css');

    expect(html).toContain('id="userChip"');
    expect(html).toContain('id="userPlanBadge"');
    expect(html).toContain('id="logoutBtn"');
    expect(css).toContain('.plan-badge');
    expect(css).toContain('.auth-gate');
  });
});

describe('static dashboard server deployment wizard', () => {
  it('ships a deploy card in the admin panel with all required fields', () => {
    const html = readPublicFile('index.html');

    expect(html).toContain('id="deployCard"');
    expect(html).toContain('id="deployHost"');
    expect(html).toContain('id="deployPassword"');
    expect(html).toContain('id="deployDomain"');
    expect(html).toContain('id="deployToken"');
    expect(html).toContain('id="deployAdminPassword"');
    expect(html).toContain('id="deployStartBtn"');
    expect(html).toContain('id="deployPhase"');
    expect(html).toContain('id="deployConsole"');
  });

  it('shows a DNS waiting panel with A-record instructions and a check-now action', () => {
    const html = readPublicFile('index.html');
    const appJs = readPublicFile('app.js');
    const css = readPublicFile('styles.css');

    expect(html).toContain('id="deployDnsPanel"');
    expect(html).toContain('id="deployDnsIp"');
    expect(html).toContain('id="deployRecheckBtn"');
    expect(html).toContain('dns-record');
    expect(appJs).toContain('recheckDeployDns');
    expect(appJs).toContain("state.phase !== 'awaiting_dns'");
    expect(css).toContain('.dns-panel');
  });

  it('wires the deployment lifecycle: start, live console polling, done and error panels', () => {
    const html = readPublicFile('index.html');
    const appJs = readPublicFile('app.js');
    const apiJs = readPublicFile('api.js');
    const css = readPublicFile('styles.css');

    expect(html).toContain('id="deployDone"');
    expect(html).toContain('id="deploySiteUrl"');
    expect(html).toContain('id="deployError"');
    expect(apiJs).toContain("'/admin/deploy'");
    expect(appJs).toContain('startDeployment');
    expect(appJs).toContain('renderDeployState');
    expect(appJs).toContain('deployTimer');
    expect(css).toContain('.deploy-console');
    expect(css).toContain('.deploy-done');
    expect(css).toContain('.deploy-error');
  });
});

describe('static dashboard BYOD (bring your own details)', () => {
  it('ships a BYOD card in the account tab with save, test, and clear actions', () => {
    const html = readPublicFile('index.html');
    const appJs = readPublicFile('app.js');
    const apiJs = readPublicFile('api.js');

    expect(html).toContain('Bring Your Own Details');
    expect(html).toContain('id="byodApifyToken"');
    expect(html).toContain('id="byodGoogleKeys"');
    expect(html).toContain('id="byodProxyUrls"');
    expect(html).toContain('id="byodSaveBtn"');
    expect(html).toContain('id="byodClearBtn"');
    expect(html).toContain('id="byodTestApify"');
    expect(html).toContain('id="byodStatus"');
    expect(appJs).toContain('saveByod');
    expect(appJs).toContain('loadByodStatus');
    expect(apiJs).toContain("'/auth/credentials'");
    expect(apiJs).toContain("'/auth/credentials/test/apify'");
  });

  it('shows a BYOD badge next to users with their own credentials in the admin table', () => {
    const appJs = readPublicFile('app.js');
    const css = readPublicFile('styles.css');

    expect(appJs).toContain('hasOwnCredentials');
    expect(appJs).toContain('byod-badge');
    expect(css).toContain('.byod-badge');
  });
});
