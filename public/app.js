(function () {
  const api = window.LeadsGenXApi;
  const chips = {};
  const maxResultsBySource = {};
  let activeSource = 'google_maps';
  let activeRunId = null;
  let progressTimer = null;
  let progressStartedAt = null;
  let lastEventKey = null;
  let lastEventChangeAt = null;
  let knownBusinessCount = 0;

  const RING_CIRCUMFERENCE = 326.7;

  function $(id) {
    return document.getElementById(id);
  }

  function numberValue(id) {
    const value = $(id).value.trim();
    return value ? Number(value) : undefined;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  let selectedOutputMode = 'standard';
  let currentUser = null;

  function isAdmin() {
    return Boolean(currentUser && currentUser.role === 'ADMIN');
  }

  function hybridUnlocked() {
    return !currentUser || isAdmin() || currentUser.tier === 'HYBRID';
  }

  function updatePipelineSummary() {
    const hybrid = selectedOutputMode === 'hybrid_max';
    $('pipelineSummary').textContent = hybrid
      ? 'Docker, Google, and Apify all start at once and feed one ingestion pipeline — maximum emails per session. Saved Apify and Google keys are required.'
      : 'Google and Docker start together; Google stays inside your request budget.';
  }

  function setOutputMode(mode) {
    selectedOutputMode = mode === 'hybrid_max' ? 'hybrid_max' : 'standard';
    const select = $('outputModeSelect');
    select.dataset.selected = selectedOutputMode;
    select.querySelectorAll('.mode-card').forEach((card) => {
      const active = card.dataset.mode === selectedOutputMode;
      card.classList.toggle('active', active);
      card.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    updatePipelineSummary();
  }

  function rippleModeCard(card, event) {
    const rect = card.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 1.1;
    const ripple = document.createElement('span');
    ripple.className = 'mode-ripple';
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (event.clientX - rect.left) + 'px';
    ripple.style.top = (event.clientY - rect.top) + 'px';
    card.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
  }

  function applySourceLimits(source) {
    const maxResults = $('maxResults');
    if (source === 'sales_navigator') {
      maxResults.max = '2500';
      if (Number(maxResults.value || 0) > 2500) maxResults.value = '2500';
      return;
    }
    maxResults.removeAttribute('max');
  }

  function setSource(source) {
    const maxResults = $('maxResults');
    maxResultsBySource[activeSource] = maxResults.value;
    activeSource = source;
    if (maxResultsBySource[source]) maxResults.value = maxResultsBySource[source];
    applySourceLimits(source);
    document.querySelectorAll('.source-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.source === source);
    });
    $('googleMapsFields').classList.toggle('active', source === 'google_maps');
    $('salesNavigatorFields').classList.toggle('active', source === 'sales_navigator');
  }

  function setTab(tab) {
    document.querySelectorAll('.tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
    document.querySelectorAll('.tab-page').forEach((page) => page.classList.remove('active'));
    $(tab + 'Tab').classList.add('active');
    if (tab === 'runs') loadRuns();
    if (tab === 'leads') loadLeads();
    if (tab === 'logs') loadLogs();
    if (tab === 'settings') loadSettings();
    if (tab === 'account') loadAccount();
    if (tab === 'admin') loadAdminPanel();
  }

  function renderSavedProxies(proxies) {
    $('savedProxyList').innerHTML = proxies.length
      ? proxies
          .map((proxy) => '<div class="proxy-row"><span>' + escapeHtml(proxy) + '</span></div>')
          .join('')
      : '<div class="proxy-row muted">No saved proxies.</div>';
  }

  function applySettingsStatus(settings) {
    $('setGoogleActor').value = settings.defaultGoogleMapsActorId;
    $('setSalesNavActor').value = settings.defaultSalesNavigatorActorId;
    $('setApifyStatus').textContent = settings.hasSavedApifyToken ? '· saved' : '· not saved';
    $('setGoogleStatus').textContent = settings.hasSavedGoogleApiKeys
      ? '· ' + settings.googleApiKeyCount + ' key(s) saved'
      : '· not saved';
    $('setProxyStatus').textContent = settings.proxyCount ? '· ' + settings.proxyCount + ' saved' : '· none saved';
    renderSavedProxies(settings.proxies || []);
    renderQuarantineBanner(settings.quarantinedCredentials || []);
  }

  function renderQuarantineBanner(quarantined) {
    const banner = $('quarantineBanner');
    if (!quarantined.length) {
      banner.hidden = true;
      banner.innerHTML = '';
      return;
    }
    banner.hidden = false;
    banner.innerHTML =
      '<div class="nova-request-head">Nova needs a fresh key</div>' +
      quarantined
        .map(
          (entry) =>
            '<span class="quarantine-item">The ' +
            escapeHtml(entry.provider === 'apify' ? 'Apify token' : entry.provider === 'google' ? 'Google API key' : entry.provider) +
            ' was rejected (' +
            escapeHtml(entry.reason) +
            '). Paste a fresh one below and save — I’ll accept it right away and pick any paused run back up automatically.</span>'
        )
        .join(' ');
  }

  async function loadSettings() {
    try {
      applySettingsStatus(await api.getSettings());
    } catch (error) {
      $('settingsStatus').textContent = error.message;
    }
  }

  async function saveSettings(extraBody) {
    $('settingsStatus').textContent = 'Saving...';
    try {
      const body = extraBody || {
        defaultGoogleMapsActorId: $('setGoogleActor').value,
        defaultSalesNavigatorActorId: $('setSalesNavActor').value,
        apifyToken: $('setApifyToken').value.trim() || undefined,
        googleApiKeys: $('setGoogleKeys').value.trim() || undefined,
        proxyUrls: $('setProxyUrls').value.trim() || undefined,
      };
      const settings = await api.saveSettings(body);
      $('setApifyToken').value = '';
      $('setGoogleKeys').value = '';
      $('setProxyUrls').value = '';
      applySettingsStatus(settings);
      const resumed = (settings.resumedRuns || []).length;
      $('settingsStatus').textContent = resumed
        ? 'Settings saved — Nova accepted the fresh key and resumed ' + resumed + ' paused run' + (resumed === 1 ? '' : 's') + ". We're moving again."
        : 'Settings saved.';
      window.LeadsGenXUi.toast('Settings saved');
    } catch (error) {
      $('settingsStatus').textContent = error.message;
      window.LeadsGenXUi.toast(error.message);
    }
  }

  async function testApifyCredential() {
    $('testApifyBtn').disabled = true;
    $('apifyTestStatus').textContent = 'Testing...';
    try {
      const pasted = $('setApifyToken').value.trim();
      const result = await api.testApifyCredential(pasted ? { apifyToken: pasted } : {});
      $('apifyTestStatus').textContent = (result.ok ? '✓ ' : '✗ ') + result.detail + ' · ' + result.latencyMs + 'ms';
      $('apifyTestStatus').className = result.ok ? 'settings-hint test-ok' : 'settings-hint test-fail';
    } catch (error) {
      $('apifyTestStatus').textContent = error.message;
      $('apifyTestStatus').className = 'settings-hint test-fail';
    } finally {
      $('testApifyBtn').disabled = false;
    }
  }

  async function testGoogleCredentials() {
    $('testGoogleBtn').disabled = true;
    $('googleTestSummary').textContent = 'Testing...';
    $('googleTestResults').innerHTML = '';
    try {
      const pasted = $('setGoogleKeys').value.trim();
      const result = await api.testGoogleCredentials(pasted ? { googleApiKeys: pasted } : {});
      $('googleTestSummary').textContent = result.okCount + '/' + result.totalCount + ' live';
      $('googleTestResults').innerHTML = result.results
        .map((item) => {
          const detail = item.ok ? 'LIVE · ' + item.latencyMs + 'ms' : escapeHtml(item.detail);
          return (
            '<div class="proxy-row ' + (item.ok ? 'ok' : 'fail') + '"><span>' +
            escapeHtml(item.keyHint || 'key') +
            '</span><span class="proxy-result">' +
            detail +
            '</span></div>'
          );
        })
        .join('');
    } catch (error) {
      $('googleTestSummary').textContent = error.message;
    } finally {
      $('testGoogleBtn').disabled = false;
    }
  }

  let settingsSummary = '';
  async function refreshRunConfig() {
    try {
      const settings = await api.getSettings();
      const parts = [
        settings.hasSavedGoogleApiKeys ? 'Google: ' + settings.googleApiKeyCount + ' saved key(s)' : 'Google: no saved key',
        settings.hasSavedApifyToken ? 'Apify: saved' : 'Apify: none',
        settings.proxyCount ? 'Proxies: ' + settings.proxyCount + ' saved' : 'Proxies: none',
      ];
      settingsSummary = parts.join(' · ');
    } catch {
      settingsSummary = '';
    }
    $('runConfig').textContent = settingsSummary || 'Idle — manage keys and proxies in Settings.';
  }

  async function testSavedProxies() {
    $('testProxiesBtn').disabled = true;
    $('proxyTestSummary').textContent = 'Testing...';
    $('proxyTestResults').innerHTML = '';
    try {
      const pasted = $('setProxyUrls').value.trim();
      const result = await api.testProxies(pasted ? { proxyUrls: pasted } : {});
      $('proxyTestSummary').textContent = result.okCount + '/' + result.totalCount + ' healthy';
      $('proxyTestResults').innerHTML = result.results
        .map((item) => {
          const detail = item.ok
            ? 'OK · ' + item.latencyMs + 'ms'
            : 'FAIL · ' + escapeHtml(item.errorCode || 'error');
          return (
            '<div class="proxy-row ' + (item.ok ? 'ok' : 'fail') + '"><span>' +
            escapeHtml(item.proxy) +
            '</span><span class="proxy-result">' +
            detail +
            '</span></div>'
          );
        })
        .join('');
    } catch (error) {
      $('proxyTestSummary').textContent = error.message;
    } finally {
      $('testProxiesBtn').disabled = false;
    }
  }

  function buildBody() {
    const body = {
      proxyUrls: $('gmProxyUrls').value.trim() || undefined,
      routeMode: $('gmUseSavedProxies').checked ? 'proxy' : undefined,
      outputMode: selectedOutputMode,
      leadSource: activeSource,
      actorId: $('actorId').value.trim() || undefined,
      maxResults: numberValue('maxResults') || 100,
    };

    if (activeSource === 'google_maps') {
      body.googleMaps = {
        apiRequestBudget: numberValue('gmApiBudget') ?? 50,
        searchTerms: chips.gmSearchTerms.commitPending(),
        categoryFilters: chips.gmCategories.commitPending(),
        companyTypes: chips.gmCompanyTypes.commitPending(),
        locations: chips.gmLocations.commitPending(),
        mapsUrl: $('gmMapsUrl').value.trim() || undefined,
        maxPlaces: numberValue('maxResults') || 100,
        minimumStars: numberValue('gmMinStars'),
        minimumReviews: numberValue('gmMinReviews'),
        skipClosedPlaces: $('gmSkipClosed').checked,
      };
    } else {
      body.searchUrl = $('snUrl').value.trim() || undefined;
      body.salesNavigator = {
        keywords: $('snKeywords').value.trim() || undefined,
        titles: chips.snTitles.commitPending(),
        industries: chips.snIndustries.commitPending(),
        geographies: chips.snGeographies.commitPending(),
        companies: chips.snCompanies.commitPending(),
        seniorities: chips.snSeniorities.commitPending(),
        functions: chips.snFunctions.commitPending(),
        headcounts: chips.snHeadcounts.commitPending(),
        cookies: $('snCookies').value.trim() || undefined,
        userAgent: $('snUserAgent').value.trim() || undefined,
      };
    }

    return body;
  }

  async function submitRun(event) {
    event.preventDefault();
    $('startBtn').disabled = true;
    $('formStatus').textContent = 'Starting...';
    try {
      const run = await api.createRun(buildBody());
      $('gmProxyUrls').value = '';
      $('snCookies').value = '';
      $('snUserAgent').value = '';
      window.LeadsGenXUi.toast('Run #' + run.id + ' queued');
      $('formStatus').textContent = 'Run #' + run.id + ' queued';
      startProgress(run.id);
      await loadRuns(String(run.id));
      await loadLeads();
    } catch (error) {
      $('formStatus').textContent = error.message;
      window.LeadsGenXUi.toast(error.message);
    } finally {
      $('startBtn').disabled = false;
    }
  }

  async function loadRuns(preferredRunId) {
    const runs = await api.listRuns();
    const selectedRunId = preferredRunId || $('leadRunFilter').value;
    $('runsTable').innerHTML = window.LeadsGenXUi.renderRuns(runs);
    $('metricRuns').textContent = runs.length;
    $('metricActive').textContent = runs.filter((run) =>
      ['queued', 'running', 'waiting_for_scraper', 'waiting_for_credentials', 'cooling_down'].includes(run.status)
    ).length;
    const total = runs.reduce((sum, run) => sum + (run._count ? run._count.leads : run.leadCount || 0), 0);
    $('metricLeads').textContent = total;
    $('leadRunFilter').innerHTML =
      '<option value="">All runs</option>' +
      runs.map((run) => '<option value="' + run.id + '">Run #' + run.id + ' - ' + run.leadSource + '</option>').join('');
    if (selectedRunId && runs.some((run) => String(run.id) === String(selectedRunId))) {
      $('leadRunFilter').value = selectedRunId;
    }
    // Reattach live tracking to the newest active run after a page reload.
    if (!activeRunId) {
      const active = runs.find((run) =>
        ['queued', 'running', 'cooling_down', 'waiting_for_scraper', 'waiting_for_credentials'].includes(run.status)
      );
      if (active) startProgress(active.id);
    }
    return runs;
  }

  async function loadLeads() {
    const runId = $('leadRunFilter').value;
    const leads = await api.listLeads(runId);
    $('leadSummary').textContent = (runId ? 'Selected run: ' : 'All runs: ') + leads.length + ' email leads';
    $('leadsTable').innerHTML = window.LeadsGenXUi.renderLeads(leads);
  }

  async function openAllLeads() {
    $('leadRunFilter').value = '';
    setTab('leads');
    await loadLeads();
  }

  async function loadLogs() {
    const logs = await api.listErrors();
    $('logsTable').innerHTML = window.LeadsGenXUi.renderLogs(logs);
  }

  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }

  async function refreshLiveProgressTables(runId) {
    const currentRunId = $('leadRunFilter').value;
    await loadRuns(currentRunId || String(runId));
    if (!$('leadRunFilter').value && runId) $('leadRunFilter').value = String(runId);
    if (!$('leadRunFilter').value || $('leadRunFilter').value === String(runId)) {
      await loadLeads();
    }
  }

  function formatDuration(seconds) {
    if (seconds < 60) return Math.max(1, Math.round(seconds)) + 's';
    const minutes = seconds / 60;
    if (minutes < 60) return Math.round(minutes) + ' min';
    return Math.round((minutes / 60) * 10) / 10 + ' h';
  }

  function estimateEtaRange(done, target, elapsed) {
    if (!done || !elapsed || done >= target) return null;
    const remaining = (target - done) / (done / elapsed);
    return { low: remaining * 0.75, high: remaining * 1.4 };
  }

  function setOrbit(id, state) {
    const element = $(id);
    element.classList.remove('live', 'standby');
    if (state) element.classList.add(state);
  }

  function spawnBlips(newCount) {
    const layer = $('radarBlips');
    for (let index = 0; index < Math.min(newCount, 4); index += 1) {
      const seed = knownBusinessCount + index;
      const angle = ((seed * 137.5) % 360) * (Math.PI / 180);
      const radius = 22 + ((seed * 53) % 55);
      const blip = document.createElement('span');
      blip.className = 'radar-blip';
      blip.style.left = 'calc(50% + ' + Math.round(Math.cos(angle) * radius) + 'px - 3.5px)';
      blip.style.top = 'calc(50% + ' + Math.round(Math.sin(angle) * radius) + 'px - 3.5px)';
      blip.addEventListener('animationend', () => blip.remove());
      layer.appendChild(blip);
    }
    while (layer.children.length > 24) layer.firstChild.remove();
  }

  function updateRadar(run, events, fraction, elapsed) {
    const shell = $('radarShell');
    const newestEventAt = events.length ? new Date(events[events.length - 1].createdAt).getTime() : 0;
    if (newestEventAt && newestEventAt !== lastEventKey) {
      lastEventKey = newestEventAt;
      lastEventChangeAt = Date.now();
    }
    const heartbeatAge = lastEventChangeAt ? Date.now() - lastEventChangeAt : null;

    let state = 'idle';
    if (run.status === 'completed') state = 'completed';
    else if (run.status === 'failed') state = 'failed';
    else if (['waiting_for_scraper', 'waiting_for_credentials', 'paused', 'cancelled', 'partially_completed'].includes(run.status)) state = 'waiting';
    else if (['queued', 'running', 'cooling_down'].includes(run.status)) {
      state = heartbeatAge !== null && heartbeatAge > 15000 ? 'stale' : 'active';
    }
    shell.dataset.state = state;

    const heartbeatText = {
      idle: 'Standby',
      active: 'Live heartbeat',
      stale: 'Stale heartbeat — no events for ' + Math.round((heartbeatAge || 0) / 1000) + 's',
      waiting: 'Motion paused — run is not actively working',
      failed: 'Heartbeat stopped',
      completed: 'Session complete',
    };
    $('radarHeartbeat').textContent = heartbeatText[state];

    const businesses = run.businessCount || 0;
    if (businesses > knownBusinessCount) spawnBlips(businesses - knownBusinessCount);
    knownBusinessCount = Math.max(knownBusinessCount, businesses);

    const clamped = Math.min(1, Math.max(0, fraction));
    $('radarRingFill').style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - clamped));
    $('radarPercent').textContent = Math.round(clamped * 100) + '%';

    const eta = state === 'active' ? estimateEtaRange(businesses, Math.max(1, run.maxResults || 1), elapsed) : null;
    $('radarEta').textContent = eta
      ? 'ETA ' + formatDuration(eta.low) + '–' + formatDuration(eta.high) + ' · est.'
      : 'ETA —';

    $('radarMode').textContent = run.actorId === 'hybrid'
      ? 'Hybrid Max Output — Docker + Google + Apify'
      : 'Standard — Docker + Google';

    const types = events.map((event) => event.type);
    const engaged = state === 'active' || state === 'completed' || state === 'stale';
    setOrbit('orbitDocker', types.includes('local_batch_started') && engaged ? 'live' : null);
    setOrbit('orbitGoogle', types.includes('google_places_started') && engaged ? 'live' : null);
    setOrbit('orbitApify', run.actorId === 'hybrid'
      ? (types.includes('apify_shard_started') && engaged ? 'live' : 'standby')
      : 'standby');
    $('runConfig').textContent =
      (settingsSummary || 'Manage keys and proxies in Settings.') +
      (run.routeMode ? ' · Route: ' + run.routeMode : '');
  }

  function resetRadar() {
    lastEventKey = null;
    lastEventChangeAt = Date.now();
    knownBusinessCount = 0;
    $('radarBlips').innerHTML = '';
    $('radarShell').dataset.state = 'active';
    $('radarHeartbeat').textContent = 'Live heartbeat';
    $('radarRingFill').style.strokeDashoffset = String(RING_CIRCUMFERENCE);
    $('radarPercent').textContent = '0%';
    $('radarEta').textContent = 'ETA —';
    setOrbit('orbitDocker', null);
    setOrbit('orbitGoogle', null);
    setOrbit('orbitApify', null);
  }

  function startProgress(runId) {
    activeRunId = runId;
    progressStartedAt = Date.now();
    lastAnalystFingerprint = '';
    setAnalystLive(true);
    $('progressRunId').textContent = '#' + runId;
    $('progressLabel').textContent = 'Queued';
    $('progressSubhead').textContent = 'Tracking run #' + runId;
    $('progressFill').style.width = '12%';
    resetRadar();
    void refreshRunConfig();
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = setInterval(checkProgress, 3000);
    void checkProgress();
  }

  function progressStage(events, status) {
    const types = events.map((event) => event.type);
    if (status === 'completed') return 'Completed';
    if (status === 'partially_completed') return 'Partially completed — preserved output is available below';
    if (status === 'cancelled') return 'Cancelled — preserved output is available below';
    if (status === 'paused') return 'Paused — resume to continue discovery';
    if (status === 'cooling_down') return 'Nova is cooling the engines before the next burst';
    if (status === 'failed') return 'Failed — review the error below';
    if (status === 'waiting_for_scraper') return 'Docker unavailable — Google progress is preserved';
    if (status === 'waiting_for_credentials') return 'Nova is waiting for a fresh key — all progress is preserved';
    if (types.includes('apify_stream_started')) return 'Apify is streaming businesses in live — leads land as they arrive';
    if (types.includes('apify_shard_started')) return 'Apify is expanding Hybrid Max Output coverage';
    const googleActive = types.includes('google_places_started') &&
      !types.includes('google_places_completed') && !types.includes('google_places_failed');
    const dockerActive = types.includes('local_batch_started') && !types.includes('local_empty_circuit_opened');
    if (types.includes('local_lane_skipped') && googleActive) return 'Google is discovering businesses — Nova skipped the unavailable Docker lane';
    if (googleActive && dockerActive) return 'Google API and Docker are discovering businesses';
    if (googleActive) {
      return types.includes('google_key_accepted')
        ? 'Google API is discovering businesses'
        : 'Google API is validating the first live request';
    }
    if (dockerActive) return 'Docker is discovering supplemental businesses';
    if (types.includes('local_empty_circuit_opened')) return 'Docker paused after empty batches — Google continues';
    if (types.includes('google_places_failed')) return 'Google failed — Docker continues';
    return status === 'queued' ? 'Preparing Google and Docker' : status;
  }

  let lastAnalystFingerprint = '';
  let lastAnalystCheckedAt = null;
  let analystActive = false;

  function setAnalystLive(active) {
    analystActive = active;
    const chip = $('analystLive');
    chip.dataset.active = active ? 'true' : 'false';
    $('analystLiveText').textContent = active ? 'NOVA ONLINE' : 'NOVA STANDBY';
  }

  function renderAnalyst(report) {
    const panel = $('analystPanel');
    if (!panel) return;
    lastAnalystCheckedAt = report.checkedAt ? new Date(report.checkedAt) : new Date();

    // Steady state: leave the DOM untouched so the panel breathes instead of
    // flickering — the ticker keeps the sense of life between changes.
    const fingerprint = JSON.stringify([report.verdict, report.headline, report.lines]);
    if (fingerprint === lastAnalystFingerprint) return;
    lastAnalystFingerprint = fingerprint;

    panel.dataset.verdict = report.verdict;
    const pill = $('analystVerdict');
    pill.dataset.verdict = report.verdict;
    pill.textContent = report.verdictLabel;
    const headline = $('analystHeadline');
    headline.textContent = report.headline;
    headline.classList.remove('analyst-headline-in');
    void headline.offsetWidth;
    headline.classList.add('analyst-headline-in');
    $('analystLines').innerHTML = report.lines
      .map(
        (line, index) =>
          '<li data-tone="' + escapeHtml(line.tone) + '" style="animation-delay:' + index * 90 + 'ms">' +
          escapeHtml(line.text) +
          '</li>'
      )
      .join('');
  }

  // A run reached a terminal state: the countdown must return to zero —
  // unless another run is still active, in which case the countdown
  // automatically switches over and keeps tracking that one.
  function settleFinishedRun(finishedRunId, runs) {
    const next = (runs || []).find(
      (candidate) =>
        ['queued', 'running', 'cooling_down', 'waiting_for_scraper', 'waiting_for_credentials'].includes(
          candidate.status
        ) && String(candidate.id) !== String(finishedRunId)
    );
    if (next) {
      startProgress(next.id);
      return;
    }
    activeRunId = null;
    progressStartedAt = null;
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = null;
    $('progressElapsed').textContent = 'Elapsed 0s';
  }

  async function checkProgress() {
    if (!activeRunId) return;
    try {
      const run = await api.getRun(activeRunId);
      const events = await api.getRunEvents(activeRunId);
      setAnalystLive(
        ['queued', 'running', 'cooling_down', 'waiting_for_scraper', 'waiting_for_credentials'].includes(run.status)
      );
      try {
        renderAnalyst(await api.getRunAnalyst(activeRunId));
      } catch {
        // The analyst panel is advisory; never break progress polling on it.
      }
      const batches = run.batches || [];
      const completedBatches = batches.filter((batch) => batch.status === 'completed').length;
      const target = Math.max(1, run.maxResults || run.googleMapsMaxPlaces || 1);
      const resultCount = Math.max(run.businessCount || 0, run.leadCount || 0);
      const startedMs = run.createdAt ? Date.parse(run.createdAt) : progressStartedAt;
      const elapsed = Math.max(0, Math.floor((Date.now() - (startedMs || Date.now())) / 1000));
      const batchProgress = batches.length ? completedBatches / batches.length : 0;
      const resultProgress = Math.min(1, resultCount / target);
      const fraction = Math.max(batchProgress, resultProgress);
      $('progressElapsed').textContent = 'Elapsed ' + elapsed + 's';
      $('progressLabel').textContent = progressStage(events, run.status);
      $('progressSubhead').textContent = (run.businessCount || 0) + ' businesses · ' + (run.leadCount || 0) +
        ' emails · ' + completedBatches + '/' + batches.length + ' batches';
      $('progressGoogle').textContent = 'Google ' + (run.googleBusinessCount || 0);
      $('progressDocker').textContent = 'Docker ' + (run.localBusinessCount || 0);
      $('progressWebsites').textContent = 'Websites ' + (run.websiteCount || 0);
      $('progressDuplicates').textContent = 'Duplicates ' + (run.duplicateCount || 0);
      $('progressApi').textContent = 'API ' + (run.apiRequestsUsed || 0) + '/' + (run.apiRequestBudget || 50);
      $('progressLatest').textContent = run.status === 'failed' && run.errorMessage
        ? run.errorMessage
        : (events.length ? events[events.length - 1].message : 'Waiting for the first source event');
      $('miniLog').innerHTML = events
        .slice(-5)
        .reverse()
        .map((event) => '<div>' + escapeHtml(event.type) + ': ' + escapeHtml(event.message) + '</div>')
        .join('');

      if (run.status === 'completed') {
        $('progressFill').style.width = '100%';
        updateRadar(run, events, 1, elapsed);
        clearInterval(progressTimer);
        progressTimer = null;
        setAnalystLive(false);
        const runs = await loadRuns(String(run.id));
        await loadLeads();
        settleFinishedRun(run.id, runs);
      } else if (run.status === 'failed') {
        $('progressFill').style.width = '100%';
        updateRadar(run, events, fraction, elapsed);
        clearInterval(progressTimer);
        progressTimer = null;
        setAnalystLive(false);
        const runs = await loadRuns(String(run.id));
        await loadLogs();
        settleFinishedRun(run.id, runs);
      } else if (['partially_completed', 'cancelled', 'paused'].includes(run.status)) {
        $('progressFill').style.width = Math.min(94, Math.max(12, Math.round(fraction * 100))) + '%';
        updateRadar(run, events, fraction, elapsed);
        clearInterval(progressTimer);
        progressTimer = null;
        setAnalystLive(false);
        await refreshLiveProgressTables(run.id);
        settleFinishedRun(run.id, await api.listRuns());
      } else if (['waiting_for_scraper', 'waiting_for_credentials'].includes(run.status)) {
        // Keep watching: the engineer may reconnect or the operator may resume,
        // so the analyst must stay alive instead of freezing on a waiting run.
        $('progressFill').style.width = Math.min(92, Math.max(12, Math.round((resultCount / target) * 100))) + '%';
        updateRadar(run, events, fraction, elapsed);
        await refreshLiveProgressTables(run.id);
      } else {
        const width = Math.min(94, Math.max(12, Math.round(fraction * 100)));
        $('progressFill').style.width = width + '%';
        updateRadar(run, events, fraction, elapsed);
        await refreshLiveProgressTables(run.id);
      }
    } catch (error) {
      $('progressLatest').textContent = error.message;
    }
  }

  async function init() {
    const suggestions = await api.getSuggestions();
    chips.gmSearchTerms = window.LeadsGenXChips.createChipInput($('gmSearchTerms'), {
      suggestions: suggestions.googleMaps.searchTemplates,
    });
    chips.gmCategories = window.LeadsGenXChips.createChipInput($('gmCategories'), {
      suggestions: suggestions.googleMaps.businessCategories,
    });
    chips.gmCompanyTypes = window.LeadsGenXChips.createChipInput($('gmCompanyTypes'), {
      suggestions: suggestions.googleMaps.companyTypes,
    });
    chips.gmLocations = window.LeadsGenXChips.createChipInput($('gmLocations'), {
      suggestions: suggestions.googleMaps.locations,
    });
    chips.snTitles = window.LeadsGenXChips.createChipInput($('snTitles'), {
      suggestions: suggestions.salesNavigator.titles,
    });
    chips.snIndustries = window.LeadsGenXChips.createChipInput($('snIndustries'), {
      suggestions: suggestions.salesNavigator.industries,
    });
    chips.snGeographies = window.LeadsGenXChips.createChipInput($('snGeographies'), {
      suggestions: suggestions.salesNavigator.geographies,
    });
    chips.snCompanies = window.LeadsGenXChips.createChipInput($('snCompanies'), {
      suggestions: suggestions.salesNavigator.companies,
    });
    chips.snSeniorities = window.LeadsGenXChips.createChipInput($('snSeniorities'), {
      suggestions: suggestions.salesNavigator.seniorities,
    });
    chips.snFunctions = window.LeadsGenXChips.createChipInput($('snFunctions'), {
      suggestions: suggestions.salesNavigator.functions,
    });
    chips.snHeadcounts = window.LeadsGenXChips.createChipInput($('snHeadcounts'), {
      suggestions: suggestions.salesNavigator.headcounts,
    });

    document.querySelectorAll('.source-btn').forEach((btn) =>
      btn.addEventListener('click', () => setSource(btn.dataset.source))
    );
    document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => setTab(btn.dataset.tab)));
    document.querySelectorAll('#outputModeSelect .mode-card').forEach((card) =>
      card.addEventListener('click', (event) => {
        if (card.dataset.mode === 'hybrid_max' && !hybridUnlocked()) {
          $('hybridLockHint').hidden = false;
          window.LeadsGenXUi.toast('Hybrid Max Output requires the Hybrid plan — request an upgrade in the Account tab.');
          return;
        }
        rippleModeCard(card, event);
        setOutputMode(card.dataset.mode);
      })
    );
    setOutputMode('standard');

    // The analyst's heartbeat: updates the telemetry ticker every second so
    // the panel visibly stays alive between progress polls.
    setInterval(() => {
      const ticker = $('analystTicker');
      if (!ticker) return;
      if (!analystActive || !lastAnalystCheckedAt) {
        ticker.textContent = analystActive ? 'Telemetry link warming up…' : 'Telemetry link idle.';
        return;
      }
      const seconds = Math.max(0, Math.round((Date.now() - lastAnalystCheckedAt.getTime()) / 1000));
      ticker.textContent =
        'Live telemetry · last scan ' +
        (seconds < 2 ? 'just now' : seconds + 's ago') +
        ' · engineer watching this run';
    }, 1000);
    $('runForm').addEventListener('submit', submitRun);
    $('refreshRuns').addEventListener('click', loadRuns);
    $('refreshLogs').addEventListener('click', loadLogs);
    $('metricLeadsCard').addEventListener('click', openAllLeads);
    $('leadRunFilter').addEventListener('change', loadLeads);
    $('downloadEmails').addEventListener('click', () => api.downloadLeads($('leadRunFilter').value, 'emails'));
    $('saveSettingsBtn').addEventListener('click', () => saveSettings());
    $('clearApifyBtn').addEventListener('click', () => saveSettings({ apifyToken: '' }));
    $('clearGoogleBtn').addEventListener('click', () => saveSettings({ googleApiKeys: '' }));
    $('clearProxiesBtn').addEventListener('click', () => saveSettings({ proxyUrls: '' }));
    $('testProxiesBtn').addEventListener('click', testSavedProxies);
    $('testApifyBtn').addEventListener('click', testApifyCredential);
    $('testGoogleBtn').addEventListener('click', testGoogleCredentials);
    $('runsTable').addEventListener('click', (event) => {
      const target = event.target;
      const viewRunId = target.dataset ? target.dataset.viewRun : undefined;
      const copyRunEmailsId = target.dataset ? target.dataset.copyRunEmails : undefined;
      const deleteRunId = target.dataset ? target.dataset.deleteRun : undefined;
      const stopRunId = target.dataset ? target.dataset.stopRun : undefined;
      if (viewRunId) {
        $('leadRunFilter').value = viewRunId;
        setTab('leads');
      }
      if (copyRunEmailsId) void copyRunEmails(copyRunEmailsId);
      if (stopRunId) void stopRun(stopRunId);
      if (deleteRunId) void deleteRun(deleteRunId);
    });

    await loadRuns();
    await loadLeads();
    if (isAdmin()) await loadLogs();
  }

  async function stopRun(runId) {
    try {
      await api.stopRun(runId);
      window.LeadsGenXUi.toast('Run #' + runId + ' stopped — output kept');
      const runs = await loadRuns();
      await loadLeads();
      // Stopping the tracked run ends its countdown right away — back to
      // zero, or straight onto the next active run if one is still going.
      if (String(activeRunId) === String(runId)) settleFinishedRun(runId, runs);
    } catch (error) {
      window.LeadsGenXUi.toast(error.message);
    }
  }

  async function deleteRun(runId) {
    if (!window.confirm('Delete run #' + runId + ' and its email leads?')) return;
    await api.deleteRun(runId);
    if (String(activeRunId) === String(runId)) {
      activeRunId = null;
      if (progressTimer) clearInterval(progressTimer);
      $('progressLabel').textContent = 'Idle';
      $('progressSubhead').textContent = 'No active run.';
      resetRadar();
      $('radarShell').dataset.state = 'idle';
      $('radarHeartbeat').textContent = 'Standby';
    }
    if ($('leadRunFilter').value === String(runId)) $('leadRunFilter').value = '';
    window.LeadsGenXUi.toast('Run #' + runId + ' deleted');
    await loadRuns();
    await loadLeads();
  }

  async function copyRunEmails(runId) {
    const text = await api.getLeadEmailsTxt(runId);
    await copyText(text);
    const count = text.trim() ? text.trim().split('\n').length : 0;
    window.LeadsGenXUi.toast('Copied ' + count + ' emails from run #' + runId);
  }

  // ------------------------------------------------------------------
  // Auth gate, role UI, account tab, admin panel
  // ------------------------------------------------------------------

  function showAuthGate(state) {
    const gate = $('authGate');
    gate.hidden = false;
    gate.dataset.state = state;
    $('authLoading').hidden = state !== 'loading';
    $('loginForm').hidden = state !== 'login';
    $('setupForm').hidden = state !== 'setup';
  }

  function hideAuthGate() {
    $('authGate').hidden = true;
  }

  function applyRoleUI(user) {
    currentUser = user;
    document.querySelectorAll('[data-admin-only]').forEach((el) => {
      el.hidden = !isAdmin();
    });
    const chip = $('userChip');
    chip.hidden = false;
    $('userChipName').textContent = user.username;
    const badge = $('userPlanBadge');
    badge.dataset.tier = user.role === 'ADMIN' ? 'ADMIN' : user.tier;
    badge.textContent = user.role === 'ADMIN' ? 'Admin' : user.tier === 'HYBRID' ? 'Hybrid' : 'Standard';
    if (!hybridUnlocked()) {
      $('hybridLockHint').hidden = false;
      $('outputModeSelect').dataset.tierLocked = 'true';
      setOutputMode('standard');
    } else {
      $('hybridLockHint').hidden = true;
      delete $('outputModeSelect').dataset.tierLocked;
    }
  }

  async function enterApp(user) {
    applyRoleUI(user);
    hideAuthGate();
    await init();
  }

  async function boot() {
    showAuthGate('loading');
    $('logoutBtn').addEventListener('click', async () => {
      try {
        await api.logout();
      } finally {
        window.location.reload();
      }
    });
    $('loginForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      $('authError').textContent = '';
      $('authLoginBtn').disabled = true;
      try {
        const result = await api.login({
          username: $('authUsername').value.trim(),
          password: $('authPassword').value,
        });
        await enterApp(result.user);
      } catch (error) {
        $('authError').textContent = error.message;
      } finally {
        $('authLoginBtn').disabled = false;
      }
    });
    $('setupForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      $('setupError').textContent = '';
      if ($('setupPassword').value !== $('setupPasswordConfirm').value) {
        $('setupError').textContent = 'Passwords do not match.';
        return;
      }
      $('authSetupBtn').disabled = true;
      try {
        const result = await api.setupAdmin({
          username: $('setupUsername').value.trim(),
          password: $('setupPassword').value,
        });
        await enterApp(result.user);
      } catch (error) {
        $('setupError').textContent = error.message;
      } finally {
        $('authSetupBtn').disabled = false;
      }
    });
    $('hybridLockUpgrade').addEventListener('click', () => setTab('account'));
    $('upgradeBtn').addEventListener('click', requestUpgrade);
    $('acctPasswordBtn').addEventListener('click', changeOwnPassword);
    $('byodSaveBtn').addEventListener('click', saveByod);
    $('byodClearBtn').addEventListener('click', clearByod);
    $('byodTestApify').addEventListener('click', () => testByod('apify'));
    $('byodTestGoogle').addEventListener('click', () => testByod('google'));
    $('adminCreateBtn').addEventListener('click', adminCreateUser);
    $('refreshAdmin').addEventListener('click', loadAdminPanel);
    $('deployStartBtn').addEventListener('click', startDeployment);
    $('updateStartBtn').addEventListener('click', startServerUpdate);
    $('deployRecheckBtn').addEventListener('click', async () => {
      try {
        await api.recheckDeployDns();
        await refreshDeployStatus();
      } catch (error) {
        window.LeadsGenXUi.toast(error.message);
      }
    });
    $('adminUsersTable').addEventListener('click', onAdminUserAction);
    $('upgradeRequests').addEventListener('click', onUpgradeAction);
    window.addEventListener('lgx:unauthorized', () => window.location.reload());

    try {
      const me = await api.getMe();
      await enterApp(me.user);
    } catch (error) {
      showAuthGate(error.payload && error.payload.needsSetup ? 'setup' : 'login');
    }
  }

  // ---------------- Account tab ----------------

  function loadAccount() {
    if (!currentUser) return;
    const badge = $('accountPlanBadge');
    const hybrid = currentUser.role === 'ADMIN' || currentUser.tier === 'HYBRID';
    badge.dataset.tier = currentUser.role === 'ADMIN' ? 'ADMIN' : currentUser.tier;
    badge.textContent = currentUser.role === 'ADMIN' ? 'Admin' : hybrid ? 'Hybrid' : 'Standard';
    $('accountPlanDesc').textContent = hybrid
      ? 'Hybrid plan: Docker + Google + Apify output, up to 5,000 results per run, 25 runs per day.'
      : 'Standard plan: Docker + Google output, up to 500 results per run, 5 runs per day.';
    $('upgradeSection').style.display = hybrid ? 'none' : '';
    $('accountSummary').textContent = 'Signed in as ' + currentUser.username + '.';
    void loadByodStatus();
  }

  // ---------------- BYOD (Bring Your Own Details) ----------------

  async function loadByodStatus() {
    try {
      const status = await api.getMyCredentials();
      renderByodStatus(status);
    } catch {
      // Non-fatal — BYOD card just shows no status.
    }
  }

  function renderByodStatus(status) {
    $('byodStatus').textContent = status.hasCredentials
      ? 'Using your own details: ' +
        [
          status.apifyTokenSet ? 'Apify token ' + (status.apifyTokenPreview || 'saved') : null,
          status.googleApiKeyCount ? status.googleApiKeyCount + ' Google key' + (status.googleApiKeyCount > 1 ? 's' : '') : null,
          status.proxyCount ? status.proxyCount + ' prox' + (status.proxyCount > 1 ? 'ies' : 'y') : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : 'No personal details saved — your runs use the shared pool.';
  }

  async function saveByod() {
    $('byodFormStatus').textContent = '';
    const body = {};
    if ($('byodApifyToken').value.trim()) body.apifyToken = $('byodApifyToken').value.trim();
    if ($('byodGoogleKeys').value.trim()) body.googleApiKeys = $('byodGoogleKeys').value;
    if ($('byodProxyUrls').value.trim()) body.proxyUrls = $('byodProxyUrls').value;
    if (!Object.keys(body).length) {
      $('byodFormStatus').textContent = 'Nothing to save — type a value first, or use Clear All.';
      return;
    }
    try {
      const status = await api.saveMyCredentials(body);
      $('byodApifyToken').value = '';
      $('byodGoogleKeys').value = '';
      $('byodProxyUrls').value = '';
      renderByodStatus(status);
      $('byodFormStatus').textContent = 'Saved. Your next runs will use your own details.';
      window.LeadsGenXUi.toast('Your details are saved');
    } catch (error) {
      $('byodFormStatus').textContent = error.message;
    }
  }

  async function clearByod() {
    if (!window.confirm('Remove all your saved details? Your runs will return to the shared pool.')) return;
    try {
      const status = await api.saveMyCredentials({ apifyToken: '', googleApiKeys: '', proxyUrls: '' });
      renderByodStatus(status);
      window.LeadsGenXUi.toast('Personal details cleared');
    } catch (error) {
      $('byodFormStatus').textContent = error.message;
    }
  }

  async function testByod(which) {
    $('byodFormStatus').textContent = 'Testing…';
    try {
      const body =
        which === 'apify'
          ? $('byodApifyToken').value.trim()
            ? { token: $('byodApifyToken').value.trim() }
            : {}
          : $('byodGoogleKeys').value.trim()
            ? { key: $('byodGoogleKeys').value.split('\n')[0].trim() }
            : {};
      const result = which === 'apify' ? await api.testMyApify(body) : await api.testMyGoogle(body);
      $('byodFormStatus').textContent = (result.ok ? '✓ ' : '✗ ') + result.detail;
    } catch (error) {
      $('byodFormStatus').textContent = error.message;
    }
  }

  async function requestUpgrade() {
    $('upgradeBtn').disabled = true;
    try {
      await api.requestUpgrade();
      $('upgradeStatus').textContent = 'Upgrade requested — your administrator will review it.';
      window.LeadsGenXUi.toast('Upgrade request sent to your administrator');
    } catch (error) {
      $('upgradeStatus').textContent = error.message;
    } finally {
      $('upgradeBtn').disabled = false;
    }
  }

  async function changeOwnPassword() {
    $('acctPasswordStatus').textContent = '';
    try {
      await api.changePassword({
        currentPassword: $('acctCurrentPassword').value,
        newPassword: $('acctNewPassword').value,
      });
      $('acctCurrentPassword').value = '';
      $('acctNewPassword').value = '';
      $('acctPasswordStatus').textContent = 'Password updated.';
      window.LeadsGenXUi.toast('Password updated');
    } catch (error) {
      $('acctPasswordStatus').textContent = error.message;
    }
  }

  // ---------------- Admin panel ----------------

  async function loadAdminPanel() {
    if (!isAdmin()) return;
    const [users, requests] = await Promise.all([api.adminListUsers(), api.adminListUpgradeRequests()]);
    renderAdminUsers(users);
    renderUpgradeRequests(requests);
    await refreshDeployStatus();
  }

  // ---------------- Server deployment wizard ----------------

  let deployTimer = null;
  const DEPLOY_PHASE_LABELS = {
    idle: 'Idle',
    connecting: 'Connecting…',
    installing: 'Installing on server…',
    securing: 'Securing server…',
    awaiting_dns: 'Waiting for DNS…',
    setting_up_https: 'Setting up HTTPS…',
    updating: 'Updating server…',
    verifying: 'Verifying site…',
    done: 'Live',
    error: 'Failed',
  };

  function deployActive(phase) {
    return ['connecting', 'installing', 'securing', 'awaiting_dns', 'setting_up_https', 'updating', 'verifying'].includes(phase);
  }

  function renderDeployState(state) {
    const pill = $('deployPhase');
    pill.dataset.phase = state.phase;
    pill.textContent = DEPLOY_PHASE_LABELS[state.phase] || state.phase;

    const active = deployActive(state.phase);
    $('deployForm').style.opacity = active ? '0.55' : '';
    $('deployStartBtn').disabled = active;
    $('deployUpdateBlock').style.opacity = active ? '0.55' : '';
    $('updateStartBtn').disabled = active;

    // Pre-fill the quick-update IP from the remembered server (never secrets).
    if (state.savedTarget && state.savedTarget.host && !$('updateHost').value) {
      $('updateHost').value = state.savedTarget.host;
    }

    const consoleEl = $('deployConsole');
    const hasLog = state.log && state.log.length > 0;
    consoleEl.hidden = !hasLog && state.phase === 'idle';
    if (hasLog) {
      consoleEl.textContent = state.log.join('\n');
      consoleEl.scrollTop = consoleEl.scrollHeight;
    }

    $('deployDnsPanel').hidden = state.phase !== 'awaiting_dns';
    if (state.phase === 'awaiting_dns') $('deployDnsIp').textContent = state.serverIp || '—';

    $('deployDone').hidden = state.phase !== 'done';
    if (state.phase === 'done') {
      if (state.mode === 'update') {
        $('deployDoneTitle').textContent = "Server updated — everyone's on the latest version";
        $('deployDoneHint').textContent =
          'The server pulled the latest Leads-GenX, rebuilt, and restarted cleanly. Every user on your domain is updated automatically — nothing for them to install.';
      } else {
        $('deployDoneTitle').textContent = "Deployment complete — you're all set! 🎉";
        $('deployDoneHint').innerHTML =
          'Sign in there with your admin account (username <strong id="deployDoneUser">—</strong> and the password you chose above). Your saved credentials are already in place. You can close this local dashboard now — your work continues on the new domain.';
      }
      if (state.siteUrl) {
        $('deploySiteUrl').textContent = state.siteUrl;
        $('deploySiteUrl').href = state.siteUrl;
        if (currentUser) $('deployDoneUser').textContent = currentUser.username;
      }
    }

    $('deployError').hidden = state.phase !== 'error';
    if (state.phase === 'error') $('deployErrorText').textContent = state.error || 'Unknown error.';

    if (active) {
      if (!deployTimer) {
        deployTimer = setInterval(refreshDeployStatus, 2000);
      }
    } else if (deployTimer) {
      clearInterval(deployTimer);
      deployTimer = null;
    }
  }

  async function refreshDeployStatus() {
    try {
      const state = await api.getDeployStatus();
      renderDeployState(state);
    } catch {
      // Status polling should never break the admin panel.
    }
  }

  async function startDeployment() {
    $('deployFormStatus').textContent = '';
    try {
      await api.startDeploy({
        host: $('deployHost').value.trim(),
        rootPassword: $('deployPassword').value,
        domain: $('deployDomain').value.trim(),
        githubToken: $('deployToken').value,
        adminPassword: $('deployAdminPassword').value,
      });
      $('deployPassword').value = '';
      $('deployToken').value = '';
      $('deployAdminPassword').value = '';
      window.LeadsGenXUi.toast('Deployment started — keep this window open');
      await refreshDeployStatus();
    } catch (error) {
      $('deployFormStatus').textContent = error.message;
    }
  }

  async function startServerUpdate() {
    $('updateFormStatus').textContent = '';
    try {
      const body = {
        host: $('updateHost').value.trim(),
        rootPassword: $('updatePassword').value,
      };
      const token = $('updateToken').value.trim();
      if (token) body.githubToken = token;
      await api.updateDeployServer(body);
      $('updatePassword').value = '';
      $('updateToken').value = '';
      window.LeadsGenXUi.toast('Server update started — watch the console');
      await refreshDeployStatus();
    } catch (error) {
      $('updateFormStatus').textContent = error.message;
    }
  }

  function renderAdminUsers(users) {
    if (!users.length) {
      $('adminUsersTable').innerHTML = '<p class="settings-hint">No users yet.</p>';
      return;
    }
    $('adminUsersTable').innerHTML =
      '<table class="admin-table"><thead><tr>' +
      '<th>User</th><th>Role</th><th>Plan</th><th>Status</th><th>Runs</th><th>Actions</th>' +
      '</tr></thead><tbody>' +
      users
        .map(
          (user) =>
            '<tr>' +
            '<td><strong>' + escapeHtml(user.username) + '</strong>' +
            (user.hasOwnCredentials ? ' <span class="byod-badge">BYOD</span>' : '') +
            '</td>' +
            '<td>' + (user.role === 'ADMIN' ? 'Admin' : 'User') + '</td>' +
            '<td><span class="plan-badge" data-tier="' + user.tier + '">' +
            (user.tier === 'HYBRID' ? 'Hybrid' : 'Standard') + '</span></td>' +
            '<td>' + (user.status === 'ACTIVE' ? 'Active' : 'Disabled') + '</td>' +
            '<td>' + user.runCount + '</td>' +
            '<td class="admin-actions">' +
            (currentUser && user.id === currentUser.id
              ? '<span class="settings-hint">You</span>'
              : '<button class="ghost-btn" data-admin-tier="' + user.id + '" data-tier="' + user.tier + '">' +
                (user.tier === 'HYBRID' ? 'Set Standard' : 'Set Hybrid') + '</button> ' +
                '<button class="ghost-btn" data-admin-status="' + user.id + '" data-status="' + user.status + '">' +
                (user.status === 'ACTIVE' ? 'Disable' : 'Enable') + '</button> ' +
                '<button class="ghost-btn" data-admin-reset="' + user.id + '">Reset Password</button> ' +
                '<button class="ghost-btn danger" data-admin-delete="' + user.id + '">Delete</button>') +
            '</td>' +
            '</tr>'
        )
        .join('') +
      '</tbody></table>';
  }

  function renderUpgradeRequests(requests) {
    $('upgradeCount').textContent = requests.length ? requests.length + ' pending' : 'none pending';
    if (!requests.length) {
      $('upgradeRequests').innerHTML = '<p class="settings-hint">No pending upgrade requests.</p>';
      return;
    }
    $('upgradeRequests').innerHTML = requests
      .map(
        (request) =>
          '<div class="upgrade-request">' +
          '<div><strong>' + escapeHtml(request.user.username) + '</strong>' +
          '<span class="settings-hint"> requested Hybrid · ' + new Date(request.createdAt).toLocaleDateString() + '</span></div>' +
          '<div class="inline-actions">' +
          '<button class="ghost-btn" data-upgrade-approve="' + request.id + '">Approve</button>' +
          '<button class="ghost-btn danger" data-upgrade-deny="' + request.id + '">Deny</button>' +
          '</div></div>'
      )
      .join('');
  }

  async function adminCreateUser() {
    $('adminCreateStatus').textContent = '';
    try {
      await api.adminCreateUser({
        username: $('adminNewUsername').value.trim(),
        password: $('adminNewPassword').value,
        tier: $('adminNewTier').value,
      });
      $('adminNewUsername').value = '';
      $('adminNewPassword').value = '';
      $('adminCreateStatus').textContent = 'User created.';
      window.LeadsGenXUi.toast('User created');
      await loadAdminPanel();
    } catch (error) {
      $('adminCreateStatus').textContent = error.message;
    }
  }

  async function onAdminUserAction(event) {
    const target = event.target;
    if (!target.dataset) return;
    try {
      if (target.dataset.adminTier) {
        const next = target.dataset.tier === 'HYBRID' ? 'STANDARD' : 'HYBRID';
        await api.adminUpdateUser(target.dataset.adminTier, { tier: next });
        window.LeadsGenXUi.toast('Plan updated to ' + (next === 'HYBRID' ? 'Hybrid' : 'Standard'));
      } else if (target.dataset.adminStatus) {
        const next = target.dataset.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
        await api.adminUpdateUser(target.dataset.adminStatus, { status: next });
        window.LeadsGenXUi.toast(next === 'DISABLED' ? 'User disabled' : 'User enabled');
      } else if (target.dataset.adminReset) {
        const password = window.prompt('New password for this user (min 8 characters):');
        if (!password) return;
        await api.adminUpdateUser(target.dataset.adminReset, { password });
        window.LeadsGenXUi.toast('Password reset — user must sign in again');
      } else if (target.dataset.adminDelete) {
        if (!window.confirm('Delete this user? Their runs and leads are kept.')) return;
        await api.adminDeleteUser(target.dataset.adminDelete);
        window.LeadsGenXUi.toast('User deleted');
      } else {
        return;
      }
      await loadAdminPanel();
    } catch (error) {
      window.LeadsGenXUi.toast(error.message);
    }
  }

  async function onUpgradeAction(event) {
    const target = event.target;
    if (!target.dataset) return;
    try {
      if (target.dataset.upgradeApprove) {
        await api.adminApproveUpgrade(target.dataset.upgradeApprove);
        window.LeadsGenXUi.toast('Upgrade approved — user is now on Hybrid');
      } else if (target.dataset.upgradeDeny) {
        await api.adminDenyUpgrade(target.dataset.upgradeDeny);
        window.LeadsGenXUi.toast('Upgrade request denied');
      } else {
        return;
      }
      await loadAdminPanel();
    } catch (error) {
      window.LeadsGenXUi.toast(error.message);
    }
  }

  void boot().catch((error) => window.LeadsGenXUi.toast(error.message));
})();
