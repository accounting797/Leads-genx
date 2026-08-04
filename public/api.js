(function () {
  const BASE = '/api';

  async function requestJson(path, options) {
    const res = await fetch(BASE + path, options);
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
    const res = await fetch(BASE + path, options);
    const text = await res.text();
    if (!res.ok) throw new Error(text || 'Request failed');
    return text;
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
    listRuns: () => requestJson('/runs'),
    getRun: (id) => requestJson('/runs/' + id),
    deleteRun: (id) => requestJson('/runs/' + id, { method: 'DELETE' }),
    stopRun: (id) => requestJson('/runs/' + id + '/stop', { method: 'POST' }),
    getRunEvents: (id) => requestJson('/runs/' + id + '/events'),
    getRunAnalyst: (id) => requestJson('/runs/' + id + '/analyst'),
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
    getTargetedCatalog: () => requestJson('/targeted/catalog'),
    getTargetedBankMarkets: (body) =>
      requestJson('/targeted/markets/banks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }),
    resetTargetedLearning: () => requestJson('/targeted/learning/reset', { method: 'POST' }),
    auditTargetedGeography: () => requestJson('/targeted/geography/audit', { method: 'POST' }),
    createTargetedCampaign: (body) =>
      requestJson('/targeted/campaigns', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }),
    listTargetedCampaigns: () => requestJson('/targeted/campaigns'),
    planTargetedCampaign: (id) => requestJson('/targeted/campaigns/' + id + '/plan', { method: 'POST' }),
    editTargetedWorkUnit: (id, unitId, body) =>
      requestJson('/targeted/campaigns/' + id + '/work-units/' + unitId, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }),
    startTargetedCampaign: (id) => requestJson('/targeted/campaigns/' + id + '/start', { method: 'POST' }),
    stopTargetedCampaign: (id) => requestJson('/targeted/campaigns/' + id + '/stop', { method: 'POST' }),
    deleteTargetedCampaign: (id) => requestJson('/targeted/campaigns/' + id, { method: 'DELETE' }),
    getTargetedCampaign: (id) => requestJson('/targeted/campaigns/' + id),
    getTargetedCandidates: (id, tier) =>
      requestJson('/targeted/campaigns/' + id + '/candidates' + (tier ? '?tier=' + encodeURIComponent(tier) : '')),
    downloadTargetedStrict: (id) => {
      window.location.href = BASE + '/targeted/campaigns/' + id + '/export?quality=strict';
    },
    downloadAllTargetedStrict: () => {
      window.location.href = BASE + '/targeted/export?quality=strict';
    },
    downloadLeads: (runId, format) => {
      const params = new URLSearchParams();
      if (runId) params.set('runId', runId);
      if (format) params.set('format', format);
      const query = params.toString();
      window.location.href = BASE + '/leads/download' + (query ? '?' + query : '');
    },
  };
})();
