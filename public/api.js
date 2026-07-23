(function () {
  const BASE = '/api';

  async function requestJson(path, options) {
    const res = await fetch(BASE + path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data.data;
  }

  async function requestText(path, options) {
    const res = await fetch(BASE + path, options);
    const text = await res.text();
    if (!res.ok) throw new Error(text || 'Request failed');
    return text;
  }

  window.LeadsGenXApi = {
    getHealth: () => requestJson('/health'),
    getSuggestions: () => requestJson('/suggestions'),
    createRun: (body) =>
      requestJson('/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    listRuns: () => requestJson('/runs'),
    getRun: (id) => requestJson('/runs/' + id),
    deleteRun: (id) => requestJson('/runs/' + id, { method: 'DELETE' }),
    getRunEvents: (id) => requestJson('/runs/' + id + '/events'),
    listLeads: (runId) => requestJson('/leads' + (runId ? '?runId=' + runId : '')),
    getLeadEmailsTxt: (runId) =>
      requestText('/leads/download?format=emails' + (runId ? '&runId=' + runId : '')),
    listErrors: () => requestJson('/errors'),
    getSettings: () => requestJson('/settings'),
    saveSettings: (body) =>
      requestJson('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    testProxies: (body) =>
      requestJson('/settings/proxies/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }),
    testApifyCredential: (body) =>
      requestJson('/settings/test/apify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }),
    testGoogleCredentials: (body) =>
      requestJson('/settings/test/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }),
    downloadLeads: (runId, format) => {
      const params = new URLSearchParams();
      if (runId) params.set('runId', runId);
      if (format) params.set('format', format);
      const query = params.toString();
      window.location.href = BASE + '/leads/download' + (query ? '?' + query : '');
    },
  };
})();
