(function () {
  const BASE = '/api';
  const REQUEST_TIMEOUT_MS = 45_000;

  function withTimeout(options, timeoutMs = REQUEST_TIMEOUT_MS) {
    return {
      ...(options || {}),
      signal: options && options.signal ? options.signal : AbortSignal.timeout(timeoutMs),
    };
  }

  async function requestJson(path, options) {
    const res = await fetch(BASE + path, withTimeout(options));
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new CustomEvent('lgx:unauthorized', { detail: data }));
    }
    if (!res.ok) {
      const error = new Error(data.error || 'Request failed');
      error.status = res.status;
      error.payload = data;
      throw error;
    }
    return data.data;
  }

  async function requestText(path, options) {
    const res = await fetch(BASE + path, withTimeout(options, 120_000));
    const text = await res.text();
    if (!res.ok) throw new Error(text || 'Request failed');
    return text;
  }

  function queryPath(path, values) {
    const params = new URLSearchParams();
    Object.entries(values).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    const query = params.toString();
    return path + (query ? '?' + query : '');
  }

  window.LeadsGenXApi = {
    getHealth: () => requestJson('/health'),
    getMe: () => requestJson('/auth/me'),
    login: (body) =>
      requestJson('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    logout: () => requestJson('/auth/logout', { method: 'POST' }),
    setupAdmin: (body) =>
      requestJson('/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    changePassword: (body) =>
      requestJson('/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    requestUpgrade: () => requestJson('/auth/request-upgrade', { method: 'POST' }),
    getMyCredentials: () => requestJson('/auth/credentials'),
    saveMyCredentials: (body) =>
      requestJson('/auth/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    testMyApify: (body) =>
      requestJson('/auth/credentials/test/apify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }),
    testMyGoogle: (body) =>
      requestJson('/auth/credentials/test/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }),
    testMyBrightData: (body) =>
      requestJson('/auth/credentials/test/brightdata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }),
    adminListUsers: () => requestJson('/admin/users'),
    adminCreateUser: (body) =>
      requestJson('/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    adminUpdateUser: (id, body) =>
      requestJson('/admin/users/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    adminDeleteUser: (id) => requestJson('/admin/users/' + id, { method: 'DELETE' }),
    adminListUpgradeRequests: () => requestJson('/admin/upgrade-requests'),
    adminApproveUpgrade: (id) => requestJson('/admin/upgrade-requests/' + id + '/approve', { method: 'POST' }),
    adminDenyUpgrade: (id) => requestJson('/admin/upgrade-requests/' + id + '/deny', { method: 'POST' }),
    startDeploy: (body) =>
      requestJson('/admin/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    getDeployStatus: () => requestJson('/admin/deploy'),
    updateDeployServer: (body) =>
      requestJson('/admin/deploy/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    recheckDeployDns: () => requestJson('/admin/deploy/recheck', { method: 'POST' }),
    getSuggestions: () => requestJson('/suggestions'),
    createRun: (body) =>
      requestJson('/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    listRuns: (scope) => requestJson(queryPath('/runs', { scope })),
    getRun: (id) => requestJson('/runs/' + id),
    deleteRun: (id) => requestJson('/runs/' + id, { method: 'DELETE' }),
    clearPreviousRuns: (leadSource, scope) =>
      requestJson(queryPath('/runs/clear-previous', { leadSource, scope }), { method: 'DELETE' }),
    stopRun: (id) => requestJson('/runs/' + id + '/stop', { method: 'POST' }),
    getRunEvents: (id) => requestJson('/runs/' + id + '/events'),
    getRunAnalyst: (id) => requestJson('/runs/' + id + '/analyst'),
    listLeads: (runId, leadSource, scope) =>
      requestJson(queryPath('/leads', { runId, leadSource, scope })),
    getHiringSignals: (runId) => requestJson('/runs/' + runId + '/hiring-signals'),
    refreshHiringSignals: (runId) =>
      requestJson('/runs/' + runId + '/hiring-signals/refresh', { method: 'POST' }),
    updateHiringOpportunity: (id, body) =>
      requestJson('/hiring-opportunities/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    prepareHiringSearch: (id, targetLane) =>
      requestJson('/hiring-opportunities/' + id + '/prepare-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetLane }),
      }),
    getLeadEmailsTxt: (runId, scope) =>
      requestText(queryPath('/leads/download', { format: 'emails', runId, scope })),
    listErrors: () => requestJson('/errors'),
    getExtensionToken: () => requestJson('/extension/token'),
    regenerateExtensionToken: () => requestJson('/extension/token/regenerate', { method: 'POST' }),
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
    testBrightDataCredential: (body) =>
      requestJson('/settings/test/brightdata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }),
    enrichLinkedIn: (runId) => requestJson('/runs/' + runId + '/enrich-linkedin', { method: 'POST' }),
    shuffleNext: (body) =>
      requestJson('/shuffle/next', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    downloadLeads: async (runId, format, leadSource, scope, createdAfter) => {
      const res = await fetch(
        BASE + queryPath('/leads/download', { runId, format, leadSource, scope, createdAfter }),
        withTimeout({}, 120_000)
      );
      if (!res.ok) throw new Error((await res.text()) || 'Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const disposition = res.headers.get('content-disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/i);
      link.href = url;
      link.download = match ? match[1] : 'leads-genx-export.txt';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
})();
