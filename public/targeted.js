(function () {
  const api = window.LeadsGenXApi;
  let catalog;
  let campaignId;
  let planned = false;
  let pollTimer;
  let marketRequest = 0;
  let targetedRefreshVersion = 0;
  const stoppableStatuses = ['queued', 'running', 'waiting_for_scraper'];

  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  const list = (id) => $(id).value.split(/[\r\n,]+/).map((value) => value.trim()).filter(Boolean);
  const checked = (id) => Array.from($(id).querySelectorAll('input:checked')).map((input) => input.value);
  const selectedBanks = () => Array.from($('targetedBank').selectedOptions);

  function setStatus(message, live) {
    $('targetedFormStatus').textContent = message;
    $('targetedLiveText').textContent = live ? 'RUN ACTIVE · LIVE SCAN' : 'SYSTEM READY';
    document.body.dataset.running = live ? 'true' : 'false';
  }

  function providerChecks(id, entries, recommended) {
    $(id).innerHTML = entries.map((entry) => '<label class="targeted-check"><input type="checkbox" value="' + escapeHtml(entry.id) + '" ' +
      (recommended.includes(entry.id) ? 'checked' : '') + '><span>' + escapeHtml(entry.label) + '</span></label>').join('');
  }

  function input() {
    const banks = selectedBanks();
    const bankMode = $('targetedMode').value === 'bank';
    return {
      prompt: $('targetedPrompt').value.trim() || (bankMode && banks.length ? 'Public business contacts' : ''),
      mode: $('targetedMode').value, country: $('targetedCountry').value,
      keywords: list('targetedKeywords'), industries: list('targetedIndustries'),
      companyTypes: list('targetedCompanyTypes'), roles: list('targetedRoles'), seniorities: [],
      visibleProviders: bankMode ? [] : checked('targetedVisibleProviders'),
      infrastructureProviders: [],
      bankIds: bankMode ? banks.map((option) => option.value) : [],
      areaCodes: list('targetedAreaCodes'), cities: list('targetedCities'), states: list('targetedStates'), postalCodes: list('targetedPostalCodes'),
      radiusMiles: Number($('targetedRadius').value || 25), maxContactsPerCompany: Number($('targetedContactsPerCompany').value || 10),
      maxResults: Number($('targetedMaxResults').value || 10000), googleRequestBudget: Number($('targetedGoogleBudget').value || 50),
      publicSearchRequestBudget: Number($('targetedPublicSearchBudget').value || 1200),
    };
  }

  function resetDraft() { campaignId = undefined; planned = false; $('targetedCampaignStatus').textContent = 'New campaign'; }

  async function loadMarkets() {
    const requestId = ++marketRequest;
    const banks = selectedBanks();
    resetDraft();
    if (!banks.length) { $('targetedBankHint').textContent = 'Select a bank to resolve its strongest markets automatically.'; return; }
    const countries = [...new Set(banks.map((option) => option.dataset.country))];
    if (countries.length !== 1) { $('targetedBankHint').textContent = 'Choose banks from one country per campaign.'; return; }
    const limit = Math.max(1, Math.min(100, Number($('targetedMarketLimit').value || 100)));
    $('targetedMode').value = 'bank'; $('targetedCountry').value = countries[0];
    $('targetedBankHint').textContent = 'Resolving public bank-location market data…';
    try {
      const responses = await Promise.all(banks.map((option) => api.getTargetedBankMarkets({ bankId: option.value, limit })));
      if (requestId !== marketRequest) return;
      const unique = new Map();
      responses.flat().forEach((market) => {
        const key = [market.city, market.state, market.postalCodes[0] || '', market.areaCodes[0] || ''].join('|').toLowerCase();
        const old = unique.get(key);
        if (!old || Number(market.branchCount) > Number(old.branchCount)) unique.set(key, market);
      });
      const markets = [...unique.values()].sort((a, b) => b.branchCount - a.branchCount).slice(0, limit);
      $('targetedAreaCodes').value = markets.map((market) => market.areaCodes[0] || '').join(', ');
      $('targetedCities').value = markets.map((market) => market.city).join(', ');
      $('targetedStates').value = markets.map((market) => market.state).join(', ');
      $('targetedPostalCodes').value = markets.map((market) => market.postalCodes[0] || '').join(', ');
      $('targetedMarkets').innerHTML = markets.map((market, index) => '<div class="targeted-market-chip" style="animation-delay:' + Math.min(index * 15, 500) + 'ms"><strong>' +
        escapeHtml((market.areaCodes[0] || '—') + ' · ' + market.city + ' · ' + market.state + ' · ' + (market.postalCodes[0] || '—')) +
        '</strong><small>' + Number(market.branchCount).toLocaleString() + ' bank locations</small></div>').join('');
      $('targetedBankHint').textContent = markets.length + ' fresh market substitutions ready · previously reserved markets were rotated out · ' + (markets.length * 7).toLocaleString() + ' work units.';
      renderConfirmation();
    } catch (error) { $('targetedBankHint').textContent = error.message; }
  }

  function renderConfirmation() {
    const value = input();
    $('targetedConfirmation').innerHTML = '<strong>' + value.cities.length + ' markets · up to ' + (value.cities.length * 7).toLocaleString() + ' format substitutions</strong><br>' +
      escapeHtml(value.prompt || 'Add targeting details') + ' · ' + value.publicSearchRequestBudget + ' public document searches.';
  }

  function renderFunnel(funnel) {
    const cards = [['Discovered', funnel.discovered], ['Aligned', funnel.aligned], ['Valid', funnel.strict], ['Mailbox verified', funnel.mailboxVerified], ['Review', funnel.review], ['Rejected', funnel.rejected]];
    $('targetedQualityFunnel').innerHTML = cards.map((card) => '<div><strong>' + Number(card[1] || 0).toLocaleString() + '</strong><span>' + card[0] + '</span></div>').join('');
  }

  function renderWorkUnits(units) {
    $('targetedWorkUnits').innerHTML = units.length ? '<p class="targeted-hint">' + units.length.toLocaleString() + ' work units planned. “Used before” identifies exact duplicate history.</p>' + units.slice(0, 100).map((unit) =>
      '<div class="targeted-unit"><span>' + escapeHtml(unit.documentType.toUpperCase()) + '</span><code>' + escapeHtml(unit.query) + '</code><small>' +
      (unit.previousUseCount ? 'USED BEFORE · ' + unit.previousUseCount + ' run(s)' : 'FRESH') + ' · ' + escapeHtml(unit.status) + '</small></div>').join('') : '';
  }

  function renderActiveSubstitution(units, status) {
    if (status === 'cancelled') {
      $('targetedActiveSubstitution').innerHTML = '<small>RUN ENDED</small><strong>CANCELLED</strong><span>No scraper or substitution is active.</span><em>Saved leads remain available for download.</em>';
      return;
    }
    if (['completed', 'partially_completed', 'failed'].includes(status)) {
      $('targetedActiveSubstitution').innerHTML = '<small>RUN ENDED</small><strong>' + escapeHtml(status.replace(/_/g, ' ').toUpperCase()) + '</strong><span>No scraper or substitution is active.</span>';
      return;
    }
    const unit = units.find((entry) => entry.status === 'running') || units.find((entry) => entry.status === 'pending');
    if (!unit) { $('targetedActiveSubstitution').innerHTML = '<small>CURRENT SUBSTITUTION</small><strong>No work unit available</strong>'; return; }
    const geo = unit.geography || {};
    $('targetedActiveSubstitution').innerHTML = '<small>' + (unit.status === 'running' ? 'RUNNING NOW' : 'NEXT SUBSTITUTION') + '</small><strong>' +
      escapeHtml((geo.areaCode || '—') + ' · ' + (geo.city || '—') + ' · ' + (geo.state || '—') + ' · ' + (geo.postalCode || '—')) +
      '</strong><span>' + escapeHtml(unit.documentType.toUpperCase() + ' · ' + unit.query) + '</span><em>' +
      (unit.previousUseCount ? 'Warning: used by ' + unit.previousUseCount + ' earlier run(s)' : 'Fresh search · no previous use') + '</em>';
  }

  async function renderCandidates() {
    if (!campaignId) return;
    const candidates = await api.getTargetedCandidates(campaignId, $('targetedTierFilter').value);
    const displayTier = (tier) => tier === 'strict' ? 'Valid' : tier;
    $('targetedCandidates').innerHTML = candidates.length ? '<table><thead><tr><th>Email</th><th>Company / Name</th><th>Location</th><th>Score</th><th>Tier</th></tr></thead><tbody>' +
      candidates.slice(0, 500).map((candidate) => '<tr><td>' + escapeHtml(candidate.email) + '</td><td>' + escapeHtml(candidate.companyName || candidate.fullName || '—') + '</td><td>' + escapeHtml(candidate.address || '—') + '</td><td>' + candidate.relevanceScore + '</td><td>' + escapeHtml(displayTier(candidate.qualityTier)) + '</td></tr>').join('') + '</tbody></table>' : '<p class="targeted-hint">No ' + escapeHtml(displayTier($('targetedTierFilter').value)) + ' leads yet.</p>';
  }

  function renderHistory(campaigns) {
    $('targetedRunHistory').innerHTML = campaigns.length ? campaigns.map((campaign) => {
      const f = campaign.funnel || {}; const active = stoppableStatuses.includes(campaign.status);
      return '<article class="targeted-run-card" data-active="' + active + '"><div class="targeted-run-title"><strong>Run #' + campaign.id + '</strong><span>' + escapeHtml(campaign.status.replace(/_/g, ' ')) + '</span></div>' +
        '<div class="targeted-run-counts"><div><strong>' + Number(f.discovered || 0).toLocaleString() + '</strong><small>Scraped</small></div><div><strong>' + Number(f.aligned || 0).toLocaleString() + '</strong><small>Aligned</small></div><div><strong>' + Number(f.strict || 0).toLocaleString() + '</strong><small>Valid</small></div><div><strong>' + Number(f.review || 0).toLocaleString() + '</strong><small>Review</small></div><div><strong>' + Number(f.rejected || 0).toLocaleString() + '</strong><small>Rejected</small></div><div><strong>' + Number(campaign.completedUnitCount || 0) + '/' + Number(campaign.plannedUnitCount || 0) + '</strong><small>Units</small></div></div>' +
      '<div class="targeted-run-actions"><button class="ghost-btn" data-view-run="' + campaign.id + '">View</button><button class="ghost-btn danger" data-stop-run="' + campaign.id + '" ' + (active ? '' : 'disabled') + '>Stop</button><button class="ghost-btn danger" data-delete-run="' + campaign.id + '">Delete</button><button class="ghost-btn" data-download-run="' + campaign.id + '" ' + (Number(f.strict || 0) ? '' : 'disabled') + '>Download Valid</button></div></article>';
    }).join('') : '<p class="targeted-hint">No targeted runs yet.</p>';
  }

  async function refreshHistory() { renderHistory(await api.listTargetedCampaigns()); }

  async function refresh() {
    if (!campaignId) { await refreshHistory(); return; }
    const refreshVersion = targetedRefreshVersion;
    try {
      const detail = await api.getTargetedCampaign(campaignId);
      if (refreshVersion !== targetedRefreshVersion) return;
      renderFunnel(detail.funnel || {}); renderWorkUnits(detail.workUnits || []); renderActiveSubstitution(detail.workUnits || [], detail.status);
      $('targetedCampaignStatus').textContent = 'Run #' + detail.id + ' · ' + detail.status.replace(/_/g, ' ');
      const active = stoppableStatuses.includes(detail.status);
      $('targetedStopBtn').disabled = !active; $('targetedExportBtn').disabled = !(detail.funnel && detail.funnel.strict);
      $('targetedProgressFill').style.width = (detail.plannedUnitCount ? Math.min(100, Math.round(detail.completedUnitCount / detail.plannedUnitCount * 100)) : 0) + '%';
      setStatus(active ? 'Run active. Counts refresh every 3 seconds.' : 'Run ' + detail.status.replace(/_/g, ' ') + '.', active);
      if (detail.status === 'cancelled') $('targetedLiveText').textContent = 'RUN ENDED Â· CANCELLED';
      await Promise.all([renderCandidates(), refreshHistory()]);
      if (!active && pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
    } catch (error) { setStatus(error.message, false); }
  }

  async function buildPlan() {
    renderConfirmation(); setStatus('Building every deterministic market substitution…', false);
    const draft = await api.createTargetedCampaign(input()); campaignId = draft.id;
    const campaign = await api.planTargetedCampaign(campaignId); planned = true;
    const detail = await api.getTargetedCampaign(campaign.id); renderWorkUnits(detail.workUnits || []);
    $('targetedCampaignStatus').textContent = 'Run #' + campaignId + ' · planned';
    setStatus((detail.workUnits || []).length.toLocaleString() + ' work units ready.', false); await refreshHistory();
  }

  async function start() {
    try {
      if (!planned || !campaignId) await buildPlan();
      await api.startTargetedCampaign(campaignId); setStatus('Targeted run launched.', true); await refresh();
      if (!pollTimer) pollTimer = setInterval(refresh, 3000);
    } catch (error) { setStatus(error.payload && error.payload.fields ? Object.values(error.payload.fields).join(' ') : error.message, false); }
  }

  async function stopCampaign(id) {
    const stoppedId = Number(id);
    targetedRefreshVersion += 1;
    $('targetedStopBtn').disabled = true;
    const stopButton = $('targetedStopBtn');
    stopButton.textContent = 'Stoppingâ€¦';
    setStatus('Stopping run #' + stoppedId + 'â€¦', false);
    try {
      await api.stopTargetedCampaign(stoppedId);
      if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
      if (stoppedId === campaignId) $('targetedCampaignStatus').textContent = 'Run #' + stoppedId + ' Â· cancelled';
      setStatus('Run #' + stoppedId + ' cancelled.', false);
      await refreshHistory();
      if (stoppedId === campaignId) await refresh();
    } catch (error) {
      setStatus('Could not stop run #' + stoppedId + ': ' + error.message, true);
      stopButton.disabled = false;
    } finally {
      stopButton.textContent = 'Stop run';
    }
  }

  async function init() {
    try {
      const me = await api.getMe();
      const user = me.user;
      if (!user || user.role !== 'ADMIN') { window.location.href = '/'; return; }
      catalog = await api.getTargetedCatalog();
      $('targetedBank').innerHTML = catalog.banks.map((bank) => '<option value="' + escapeHtml(bank.id) + '" data-country="' + escapeHtml(bank.country) + '">' + escapeHtml(bank.label + ' · ' + bank.country) + '</option>').join('');
      const visible = [...new Map(catalog.providers.filter((p) => p.matchType === 'visible_domain').map((p) => [p.id, p])).values()];
      providerChecks('targetedVisibleProviders', visible, []);
      $('targetedInfrastructureProviders').innerHTML = '<p class="targeted-hint">Infrastructure filters are unavailable: DNS/MX verification is external.</p>';
      const audit = await api.auditTargetedGeography();
      if (audit.quarantined) setStatus('Removed ' + audit.quarantined + ' legacy foreign leads from accepted tiers.', false);
      renderFunnel({}); await refreshHistory();
    } catch (error) { setStatus(error.message, false); }
  }

  $('targetedBank').addEventListener('change', loadMarkets); $('targetedMarketLimit').addEventListener('change', loadMarkets);
  $('targetedPlanBtn').addEventListener('click', () => buildPlan().catch((error) => setStatus(error.message, false)));
  $('targetedStartBtn').addEventListener('click', start); $('targetedRefreshBtn').addEventListener('click', refresh);
  $('targetedTierFilter').addEventListener('change', renderCandidates);
  $('targetedStopBtn').addEventListener('click', () => { if (campaignId) void stopCampaign(campaignId); });
  $('targetedExportBtn').addEventListener('click', () => { if (campaignId) api.downloadTargetedStrict(campaignId); });
  $('targetedDownloadAllBtn').addEventListener('click', api.downloadAllTargetedStrict);
  $('targetedResetLearningBtn').addEventListener('click', async () => { const result = await api.resetTargetedLearning(); setStatus('Reset priorities on ' + result.resetWorkUnits + ' work units. Results were kept.', false); });
  $('targetedRunHistory').addEventListener('click', async (event) => {
    const target = event.target; const view = target.dataset.viewRun; const stop = target.dataset.stopRun; const remove = target.dataset.deleteRun; const download = target.dataset.downloadRun;
    if (view) { campaignId = Number(view); planned = true; await refresh(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    if (stop) { target.disabled = true; target.textContent = 'Stoppingâ€¦'; await stopCampaign(Number(stop)); }
    if (remove) {
      if (!window.confirm('Delete targeted run #' + remove + '? Saved leads from this run will also be deleted.')) return;
      target.disabled = true;
      try { await api.deleteTargetedCampaign(Number(remove)); if (Number(remove) === campaignId) { campaignId = undefined; planned = false; } await refreshHistory(); if (!campaignId) setStatus('Targeted run deleted.', false); }
      catch (error) { target.disabled = false; setStatus(error.message, false); }
    }
    if (download) api.downloadTargetedStrict(Number(download));
  });
  window.addEventListener('lgx:unauthorized', () => { window.location.href = '/'; });
  init();
})();
