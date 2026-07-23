(function () {
  const api = window.LeadsGenXApi;
  const chips = {};
  const maxResultsBySource = {};
  let activeSource = 'google_maps';
  let activeRunId = null;
  let progressTimer = null;
  let progressStartedAt = null;

  function $(id) {
    return document.getElementById(id);
  }

  function numberValue(id) {
    const value = $(id).value.trim();
    return value ? Number(value) : undefined;
  }

  function normalizeCredentialBox(element) {
    const credentials = element.value
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    element.value = credentials.join('\n');
  }

  function setupCredentialBox(element) {
    element.addEventListener('blur', () => normalizeCredentialBox(element));
    element.addEventListener('paste', () => {
      setTimeout(() => normalizeCredentialBox(element), 0);
    });
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        setTimeout(() => normalizeCredentialBox(element), 0);
      }
    });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function updatePipelineSummary() {
    const hybrid = $('gmProvider').value === 'hybrid';
    $('pipelineSummary').textContent = hybrid
      ? 'Google and Docker start together, then Apify expands maximum-output coverage. Google and Apify keys are required.'
      : 'Google and Docker start together; Google stays inside your request budget.';
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
  }

  function buildBody() {
    const body = {
      apifyToken: $('apifyToken').value.trim(),
      googleApiKey: $('googleApiKey').value.trim() || undefined,
      proxyUrls: $('gmProxyUrls').value.trim() || undefined,
      leadSource: activeSource,
      actorId: $('actorId').value.trim() || undefined,
      maxResults: numberValue('maxResults') || 100,
    };

    if (activeSource === 'google_maps') {
      body.googleMaps = {
        provider: $('gmProvider').value,
        apiRequestBudget: numberValue('gmApiBudget') ?? 50,
        searchTerms: chips.gmSearchTerms.getValue(),
        categoryFilters: chips.gmCategories.getValue(),
        companyTypes: chips.gmCompanyTypes.getValue(),
        locations: chips.gmLocations.getValue(),
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
        titles: chips.snTitles.getValue(),
        industries: chips.snIndustries.getValue(),
        geographies: chips.snGeographies.getValue(),
        companies: chips.snCompanies.getValue(),
        seniorities: chips.snSeniorities.getValue(),
        functions: chips.snFunctions.getValue(),
        headcounts: chips.snHeadcounts.getValue(),
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
      $('apifyToken').value = '';
      $('googleApiKey').value = '';
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

  let activeSseSource = null;

  function connectSse(runId) {
    if (activeSseSource) {
      activeSseSource.close();
      activeSseSource = null;
    }
    $('sseBadge').textContent = 'SSE Connecting…';
    $('sseBadge').classList.remove('live');
    $('codexMetrics').style.display = '';
    try {
      const source = new EventSource('/api/runs/' + runId + '/events/stream');
      activeSseSource = source;
      source.onopen = function () {
        $('sseBadge').textContent = 'SSE Live';
        $('sseBadge').classList.add('live');
      };
      source.onmessage = function (event) {
        try {
          const data = JSON.parse(event.data);
          handleSseEvent(runId, data);
        } catch { /* ignore malformed */ }
      };
      source.onerror = function () {
        $('sseBadge').textContent = 'SSE Offline';
        $('sseBadge').classList.remove('live');
        source.close();
        activeSseSource = null;
      };
    } catch {
      $('sseBadge').textContent = 'SSE Offline';
      $('sseBadge').classList.remove('live');
    }
  }

  function handleSseEvent(runId, data) {
    if (String(runId) !== String(activeRunId)) return;
    const message = data.message || '';
    $('codexMetrics').style.display = '';
    $('sseBadge').textContent = 'SSE Live';
    $('sseBadge').classList.add('live');

    if (data.type === 'progress') {
      $('progressLabel').textContent = message;
      $('progressLatest').textContent = message;
      if (data.leadCount != null) $('metricLeads').textContent = data.leadCount;
      if (data.completedDatasets != null) $('progressCodexRuns').textContent = 'Codex ' + data.completedDatasets;
      if (data.target != null) $('progressCodexRuns').textContent = $('progressCodexRuns').textContent + '/' + data.target;
    } else if (data.type === 'run_started') {
      $('progressLabel').textContent = 'Running';
      $('progressFill').style.width = '12%';
      $('progressLatest').textContent = message;
      if (data.tokenCount) $('progressCodexTokens').textContent = 'Tokens ' + data.tokenCount;
    } else if (data.type === 'run_completed') {
      $('progressLabel').textContent = 'Completed';
      $('progressFill').style.width = '100%';
      $('progressLatest').textContent = message;
      if (data.leadCount != null) $('metricLeads').textContent = data.leadCount;
      if (data.verifiedCount != null) $('progressCodexVerified').textContent = 'MX Verified ' + data.verifiedCount;
      $('sseBadge').textContent = 'SSE Done';
      void loadRuns(String(runId));
      void loadLeads();
    } else if (data.type === 'run_failed') {
      $('progressLabel').textContent = 'Failed';
      $('progressFill').style.width = '100%';
      $('progressLatest').textContent = message;
      $('sseBadge').textContent = 'SSE Offline';
      void loadRuns(String(runId));
      void loadLogs();
    } else {
      $('progressLatest').textContent = message || $('progressLatest').textContent;
    }
  }

  function startProgress(runId) {
    activeRunId = runId;
    progressStartedAt = Date.now();
    $('progressRunId').textContent = '#' + runId;
    $('progressLabel').textContent = 'Queued';
    $('progressSubhead').textContent = 'Tracking run #' + runId;
    $('progressFill').style.width = '12%';
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = setInterval(checkProgress, 3000);
    void checkProgress();
    connectSse(runId);
  }

  function progressStage(events, status) {
    const types = events.map((event) => event.type);
    if (status === 'completed') return 'Completed';
    if (status === 'failed') return 'Failed — review the error below';
    if (status === 'waiting_for_scraper') return 'Docker unavailable — Google progress is preserved';
    if (status === 'waiting_for_credentials') return 'Google credentials required — Docker progress is preserved';
    if (types.includes('apify_shard_started')) return 'Apify is expanding Hybrid Max Output coverage';
    const googleActive = types.includes('google_places_started') &&
      !types.includes('google_places_completed') && !types.includes('google_places_failed');
    const dockerActive = types.includes('local_batch_started') && !types.includes('local_empty_circuit_opened');
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

  async function checkProgress() {
    if (!activeRunId) return;
    try {
      const run = await api.getRun(activeRunId);
      const events = await api.getRunEvents(activeRunId);
      const batches = run.batches || [];
      const completedBatches = batches.filter((batch) => batch.status === 'completed').length;
      const target = Math.max(1, run.maxResults || run.googleMapsMaxPlaces || 1);
      const resultCount = Math.max(run.businessCount || 0, run.leadCount || 0);
      const elapsed = Math.floor((Date.now() - progressStartedAt) / 1000);
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
        clearInterval(progressTimer);
        await loadRuns(String(run.id));
        await loadLeads();
      } else if (run.status === 'failed') {
        $('progressFill').style.width = '100%';
        clearInterval(progressTimer);
        await loadRuns(String(run.id));
        await loadLogs();
      } else if (['waiting_for_scraper', 'waiting_for_credentials'].includes(run.status)) {
        $('progressFill').style.width = Math.min(92, Math.max(12, Math.round((resultCount / target) * 100))) + '%';
        clearInterval(progressTimer);
        await refreshLiveProgressTables(run.id);
      } else {
        const batchProgress = batches.length ? completedBatches / batches.length : 0;
        const resultProgress = Math.min(1, resultCount / target);
        const width = Math.min(94, Math.max(12, Math.round(Math.max(batchProgress, resultProgress) * 100)));
        $('progressFill').style.width = width + '%';
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
    $('gmProvider').value = 'local_first';
    $('gmProvider').addEventListener('change', updatePipelineSummary);
    updatePipelineSummary();
    setupCredentialBox($('apifyToken'));
    setupCredentialBox($('googleApiKey'));
    normalizeCredentialBox($('apifyToken'));
    normalizeCredentialBox($('googleApiKey'));
    $('runForm').addEventListener('submit', submitRun);
    $('refreshRuns').addEventListener('click', loadRuns);
    $('refreshLogs').addEventListener('click', loadLogs);
    $('metricLeadsCard').addEventListener('click', openAllLeads);
    $('leadRunFilter').addEventListener('change', loadLeads);
    $('downloadCsv').addEventListener('click', () => api.downloadLeads($('leadRunFilter').value, 'csv'));
    $('downloadJson').addEventListener('click', () => api.downloadLeads($('leadRunFilter').value, 'json'));
    $('downloadEmails').addEventListener('click', () => api.downloadLeads($('leadRunFilter').value, 'emails'));
    $('runsTable').addEventListener('click', (event) => {
      const target = event.target;
      const viewRunId = target.dataset ? target.dataset.viewRun : undefined;
      const copyRunEmailsId = target.dataset ? target.dataset.copyRunEmails : undefined;
      const deleteRunId = target.dataset ? target.dataset.deleteRun : undefined;
      if (viewRunId) {
        $('leadRunFilter').value = viewRunId;
        setTab('leads');
      }
      if (copyRunEmailsId) void copyRunEmails(copyRunEmailsId);
      if (deleteRunId) void deleteRun(deleteRunId);
    });

    await loadRuns();
    await loadLeads();
    await loadLogs();
  }

  async function deleteRun(runId) {
    if (!window.confirm('Delete run #' + runId + ' and its email leads?')) return;
    await api.deleteRun(runId);
    if (String(activeRunId) === String(runId)) {
      activeRunId = null;
      if (progressTimer) clearInterval(progressTimer);
      $('progressLabel').textContent = 'Idle';
      $('progressSubhead').textContent = 'No active run.';
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

  void init().catch((error) => window.LeadsGenXUi.toast(error.message));
})();
