(function () {
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
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
      '<div class="table-wrap"><table><thead><tr><th>ID</th><th>Status</th><th>Source</th><th>Leads</th><th>Created</th><th>Error</th><th>Actions</th></tr></thead><tbody>' +
      runs
        .map((run) => {
          const count = run._count ? run._count.leads : run.leadCount || 0;
          return (
            '<tr><td>#' +
            run.id +
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
            '">View</button> <button class="ghost-btn" data-delete-run="' +
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
          return (
            '<tr><td class="source">' +
            escapeHtml(lead.leadType) +
            '</td><td>' +
            escapeHtml(name) +
            '</td><td>' +
            escapeHtml(title) +
            '</td><td>' +
            escapeHtml(lead.companyName) +
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

  window.LeadsGenXUi = { empty, renderRuns, renderLeads, renderLogs, toast };
})();
