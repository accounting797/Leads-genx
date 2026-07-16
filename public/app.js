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

  function applyProviderDefaults() {
    if ($('gmProvider').value === 'hybrid' && Number($('maxResults').value || 0) < 5000) {
      $('maxResults').value = '5000';
    }
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
        apiRequestBudget: numberValue('gmApiBudget') ?? 25,
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
    $('metricActive').textContent = runs.filter((run) => ['queued', 'running'].includes(run.status)).length;
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
  }

  async function checkProgress() {
    if (!activeRunId) return;
    try {
      const run = await api.getRun(activeRunId);
      const events = await api.getRunEvents(activeRunId);
      const elapsed = Math.floor((Date.now() - progressStartedAt) / 1000);
      $('progressElapsed').textContent = 'Elapsed ' + elapsed + 's';
      $('progressLabel').textContent = run.status;
      $('progressLatest').textContent = events.length ? events[events.length - 1].message : 'Waiting';
      $('miniLog').innerHTML = events
        .slice(-5)
        .reverse()
        .map((event) => '<div>' + event.type + ': ' + event.message + '</div>')
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
      } else {
        const width = Math.min(88, 12 + elapsed);
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
    $('gmProvider').addEventListener('change', applyProviderDefaults);
    setupCredentialBox($('apifyToken'));
    setupCredentialBox($('googleApiKey'));
    normalizeCredentialBox($('apifyToken'));
    normalizeCredentialBox($('googleApiKey'));
    applyProviderDefaults();
    $('runForm').addEventListener('submit', submitRun);
    $('refreshRuns').addEventListener('click', loadRuns);
    $('refreshLogs').addEventListener('click', loadLogs);
    $('metricLeadsCard').addEventListener('click', openAllLeads);
    $('leadRunFilter').addEventListener('change', loadLeads);
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
