(function () {
  const BASE = '/api';

  async function requestJson(path, options) {
    const res = await fetch(BASE + path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data.data;
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
    getRunEvents: (id) => requestJson('/runs/' + id + '/events'),
    listLeads: (runId) => requestJson('/leads' + (runId ? '?runId=' + runId : '')),
    listErrors: () => requestJson('/errors'),
    downloadLeads: (runId) => {
      window.location.href = BASE + '/leads/download' + (runId ? '?runId=' + runId : '');
    },
  };
})();
