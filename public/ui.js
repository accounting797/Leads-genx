(function () {
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function safeHttpsUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' ? url.toString() : '#';
    } catch {
      return '#';
    }
  }

  function statusBadge(status) {
    return '<span class="badge ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>';
  }

  function empty(message) {
    return '<div class="empty">' + escapeHtml(message) + '</div>';
  }

  function renderRuns(runs) {
    if (!runs.length) return empty('No runs yet.');
    return (
      '<div class="table-wrap"><table><thead><tr><th>ID</th><th>Owner</th><th>Status</th><th>Source</th><th>Leads</th><th>Created</th><th>Error</th><th>Actions</th></tr></thead><tbody>' +
      runs
        .map((run) => {
          const count = run._count ? run._count.leads : run.leadCount || 0;
          const active = ['queued', 'running', 'cooling_down', 'waiting_for_scraper', 'waiting_for_credentials'].includes(
            run.status
          );
          return (
            '<tr><td>#' +
            run.id +
            '</td><td>' +
            escapeHtml(run.user && run.user.username ? run.user.username : 'Legacy / unassigned') +
            '</td><td>' +
            statusBadge(run.status) +
            '</td><td class="source">' +
            escapeHtml(run.leadSource) +
            '</td><td>' +
            count +
            '</td><td>' +
            escapeHtml(new Date(run.createdAt).toLocaleString()) +
            '</td><td class="muted">' +
            escapeHtml(run.errorMessage || '') +
            '</td><td><button class="ghost-btn" data-view-run="' +
            run.id +
            '">View</button> <button class="ghost-btn" data-copy-run-emails="' +
            run.id +
            '">Copy Emails</button> ' +
            (active ? '<button class="ghost-btn danger" data-stop-run="' + run.id + '">Stop</button> ' : '') +
            '<button class="ghost-btn" data-delete-run="' +
            run.id +
            '">Delete</button></td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div>'
    );
  }

  function renderLeads(leads) {
    if (!leads.length) return empty('No leads found.');
    return (
      '<div class="table-wrap"><table><thead><tr><th>Type</th><th>Name</th><th>Title/Category</th><th>Company</th><th>Email</th><th>Phone</th><th>Website/Profile</th><th>Location/Address</th><th>Rating</th><th>Reviews</th></tr></thead><tbody>' +
      leads
        .map((lead) => {
          const isBusiness = lead.leadType === 'business';
          const name = isBusiness ? lead.companyName : lead.fullName;
          const title = isBusiness ? lead.categoryName : lead.jobTitle;
          const url = isBusiness ? lead.website || lead.placeUrl : lead.profileUrl;
          const location = isBusiness ? lead.address : lead.location;
          const signal = lead.hiringSignal;
          const signalBadge = signal
            ? '<a class="hiring-badge" href="' +
              escapeHtml(safeHttpsUrl(signal.evidenceUrl)) +
              '" target="_blank" rel="noreferrer" title="' +
              escapeHtml(signal.explanation) +
              '">Hiring ' +
              escapeHtml(signal.score) +
              '</a>'
            : '';
          return (
            '<tr><td class="source">' +
            escapeHtml(lead.leadType) +
            '</td><td>' +
            escapeHtml(name) +
            '</td><td>' +
            escapeHtml(title) +
            '</td><td>' +
            escapeHtml(lead.companyName) +
            signalBadge +
            '</td><td>' +
            escapeHtml(lead.email) +
            '</td><td>' +
            escapeHtml(lead.phone) +
            '</td><td>' +
            (url ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer">Open</a>' : '') +
            '</td><td>' +
            escapeHtml(location) +
            '</td><td>' +
            escapeHtml(lead.rating) +
            '</td><td>' +
            escapeHtml(lead.reviewsCount) +
            '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div>'
    );
  }

  function renderHiringSignals(result) {
    const matches = []
      .concat((result.matches && result.matches.google_maps) || [])
      .concat((result.matches && result.matches.sales_navigator) || []);
    const opportunities = result.opportunities || [];

    function card(item, adjacent) {
      const components = item.components || {};
      const componentScores = [
        ['Roles', components.roles],
        ['Recency', components.recency],
        ['Geography', components.geography],
        ['Industry', components.industry],
        ['Breadth', components.breadth],
      ]
        .map(
          (component) =>
            '<span><b>' +
            escapeHtml(component[0]) +
            '</b> ' +
            escapeHtml(component[1] ?? 0) +
            '</span>'
        )
        .join('');
      const observed = item.observedAt
        ? '<p class="hiring-observed">Observed ' +
          escapeHtml(new Date(item.observedAt).toLocaleString()) +
          '</p>'
        : '';
      const jobs = (item.jobs || [])
        .slice(0, 3)
        .map(
          (job) =>
            '<li><strong>' +
            escapeHtml(job.title) +
            '</strong><span>' +
            escapeHtml(job.location || 'Location not listed') +
            ' · updated ' +
            escapeHtml(new Date(job.updatedAt).toLocaleDateString()) +
            '</span></li>'
        )
        .join('');
      return (
        '<article class="hiring-card" data-opportunity-id="' +
        escapeHtml(item.id) +
        '"><div class="hiring-card-head"><div><span class="hiring-lane">' +
        escapeHtml(adjacent ? 'Hiring opportunity' : item.originLane === 'google_maps' ? 'Google Maps match' : 'Sales Navigator match') +
        '</span><h3>' +
        escapeHtml(item.companyName) +
        '</h3></div><strong class="hiring-score">' +
        escapeHtml(item.score) +
        '</strong></div><p>' +
        escapeHtml(item.explanation) +
        '</p><div class="hiring-components" aria-label="Score components">' +
        componentScores +
        '</div>' +
        observed +
        '<ul class="hiring-jobs">' +
        jobs +
        '</ul><div class="hiring-actions"><a class="ghost-btn" href="' +
        escapeHtml(safeHttpsUrl(item.evidenceUrl)) +
        '" target="_blank" rel="noreferrer">View evidence</a>' +
        (adjacent
          ? '<button class="ghost-btn" type="button" data-prepare-hiring="' +
            escapeHtml(item.id) +
            '" data-target-lane="google_maps">Prepare Maps</button><button class="ghost-btn" type="button" data-prepare-hiring="' +
            escapeHtml(item.id) +
            '" data-target-lane="sales_navigator">Prepare Sales Nav</button><button class="ghost-btn" type="button" data-save-hiring="' +
            escapeHtml(item.id) +
            '">' +
            (item.saved ? 'Unsave' : 'Save') +
            '</button><button class="ghost-btn danger" type="button" data-dismiss-hiring="' +
            escapeHtml(item.id) +
            '">Dismiss</button>'
          : '') +
        '</div></article>'
      );
    }

    return {
      matches: matches.length
        ? '<div class="hiring-section-head"><h3>Signals on companies you already found</h3><span>' +
          matches.length +
          '</span></div><div class="hiring-grid">' +
          matches.map((item) => card(item, false)).join('') +
          '</div>'
        : empty('No score-70 hiring matches on this run yet.'),
      opportunities: opportunities.length
        ? '<div class="hiring-section-head"><h3>Adjacent opportunities</h3><span>' +
          opportunities.length +
          ' of 5 max</span></div><div class="hiring-grid">' +
          opportunities.map((item) => card(item, true)).join('') +
          '</div>'
        : empty('No score-80 adjacent opportunities surfaced yet.'),
    };
  }

  function renderLogs(logs) {
    if (!logs.length) return empty('No errors logged.');
    return (
      '<div class="table-wrap"><table><thead><tr><th>Time</th><th>Severity</th><th>Source</th><th>Message</th></tr></thead><tbody>' +
      logs
        .map(
          (log) =>
            '<tr><td>' +
            escapeHtml(new Date(log.createdAt).toLocaleString()) +
            '</td><td>' +
            escapeHtml(log.severity) +
            '</td><td>' +
            escapeHtml(log.source) +
            '</td><td>' +
            escapeHtml(log.message) +
            '</td></tr>'
        )
        .join('') +
      '</tbody></table></div>'
    );
  }

  function toast(message) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3500);
  }

  window.LeadsGenXUi = { empty, renderRuns, renderLeads, renderHiringSignals, renderLogs, toast };
})();
