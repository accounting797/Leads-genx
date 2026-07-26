'use strict';

/* Leads-GenX background service worker.
 *
 * Receives scraped lead batches from content.js, queues them in
 * chrome.storage.session (so a service-worker restart doesn't lose leads),
 * and POSTs them to the Leads-GenX server with Bearer auth. Relays progress
 * to the popup. Popup<->page messages are routed through here.
 */

const BATCH_SIZE = 25;
const BACKOFF_MS = [2000, 8000, 20000]; // retry 3x after the first failure

// Module-level drain lock; the queue itself lives in storage.session.
let draining = false;

// ------------------------------------------------------------------ storage
async function getSettings() {
  const { serverUrl, token } = await chrome.storage.local.get(['serverUrl', 'token']);
  return {
    serverUrl: (serverUrl || '').replace(/\/+$/, ''),
    token: token || '',
  };
}

async function getSessionState() {
  const s = await chrome.storage.session.get(['leadQueue', 'pendingFinish', 'stats']);
  return {
    queue: s.leadQueue || [],
    pendingFinish: s.pendingFinish || null,
    stats: s.stats || { sessionId: null, captured: 0, sent: 0, lastStatus: 'idle' },
  };
}

async function saveSessionState({ queue, pendingFinish, stats }) {
  await chrome.storage.session.set({
    leadQueue: queue,
    pendingFinish: pendingFinish || null,
    stats,
  });
}

// ----------------------------------------------------------------- progress
function relayProgress(stats) {
  // Popup may be closed — that's fine, progress is best-effort.
  chrome.runtime
    .sendMessage({
      type: 'progress',
      captured: stats.captured,
      sent: stats.sent,
      lastStatus: stats.lastStatus,
    })
    .catch(() => {});
}

// -------------------------------------------------------------------- http
async function postWithRetry(url, token, body) {
  let lastError = 'unknown error';
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return { ok: true, body: await res.json().catch(() => ({})) };
      const errBody = await res.json().catch(() => ({}));
      lastError = errBody.error || `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.message;
    }
  }
  return { ok: false, error: lastError };
}

// -------------------------------------------------------------------- drain
// Processes the queue head-first. On a hard failure the batch stays queued
// (nothing is dropped) and draining stops until the next message re-kicks it.
async function drain() {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const state = await getSessionState();
      const { queue, pendingFinish, stats } = state;

      if (queue.length === 0) {
        if (pendingFinish) {
          const { serverUrl, token } = await getSettings();
          if (serverUrl && token) {
            const res = await postWithRetry(
              `${serverUrl}/api/extension/finish`,
              token,
              { sessionId: pendingFinish.sessionId } // SPEC: body is { sessionId }
            );
            stats.lastStatus = res.ok ? 'finished' : `finish failed: ${res.error}`;
          } else {
            stats.lastStatus = 'finish failed: missing server/token';
          }
          await saveSessionState({ queue, pendingFinish: null, stats });
          relayProgress(stats);
        }
        break;
      }

      const { serverUrl, token } = await getSettings();
      if (!serverUrl || !token) {
        stats.lastStatus = 'send failed: missing server/token (saved in the popup?)';
        await saveSessionState({ queue, pendingFinish, stats });
        relayProgress(stats);
        break;
      }

      const batch = queue[0];
      const res = await postWithRetry(
        `${serverUrl}/api/extension/leads`,
        token,
        {
          sessionId: batch.sessionId,
          runName: batch.runName,
          page: batch.page,
          leads: batch.leads,
        }
      );

      if (!res.ok) {
        stats.lastStatus = `send failed (${res.error}) — ${queue.length} batch(es) queued`;
        await saveSessionState({ queue, pendingFinish, stats });
        relayProgress(stats);
        break; // keep the queue intact; next message re-kicks the drain
      }

      queue.shift();
      stats.sent += batch.leads.length;
      stats.lastStatus = `sent page ${batch.page} (${batch.leads.length} leads)`;
      await saveSessionState({ queue, pendingFinish, stats });
      relayProgress(stats);
    }
  } finally {
    draining = false;
  }
}

// ----------------------------------------------------------------- messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'start' || msg.type === 'stop') {
    // From the popup — forward to the Sales Navigator tab's content script.
    (async () => {
      if (msg.type === 'start') {
        const state = await getSessionState();
        await saveSessionState({
          queue: state.queue,
          pendingFinish: state.pendingFinish,
          stats: { sessionId: null, captured: 0, sent: 0, lastStatus: 'scraping…' },
        });
      }
      if (typeof msg.tabId === 'number') {
        await chrome.tabs.sendMessage(msg.tabId, { type: msg.type });
      }
    })()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async response
  }

  if (msg.type === 'leads') {
    (async () => {
      const state = await getSessionState();
      const { queue, pendingFinish, stats } = state;
      if (stats.sessionId !== msg.sessionId) {
        // New scraping session — reset counters.
        stats.sessionId = msg.sessionId;
        stats.captured = 0;
        stats.sent = 0;
      }
      const leads = Array.isArray(msg.leads) ? msg.leads : [];
      stats.captured += leads.length;
      // Split into batches of <= BATCH_SIZE before enqueueing.
      for (let i = 0; i < leads.length; i += BATCH_SIZE) {
        queue.push({
          sessionId: msg.sessionId,
          runName: msg.runName,
          page: msg.page,
          leads: leads.slice(i, i + BATCH_SIZE),
        });
      }
      if (leads.length === 0) {
        stats.lastStatus = `page ${msg.page}: 0 new leads`;
      }
      await saveSessionState({ queue, pendingFinish, stats });
      relayProgress(stats);
      drain();
    })();
    return;
  }

  if (msg.type === 'finish') {
    (async () => {
      const state = await getSessionState();
      // The finish call goes out only after the queue has fully drained.
      await saveSessionState({
        queue: state.queue,
        pendingFinish: { sessionId: msg.sessionId, reason: msg.reason },
        stats: { ...state.stats, lastStatus: 'finishing…' },
      });
      relayProgress({ ...state.stats, lastStatus: 'finishing…' });
      drain();
    })();
    return;
  }
});

// Service-worker restart recovery: if a queue survived in storage.session,
// resume draining immediately.
getSessionState().then((state) => {
  if (state.queue.length > 0 || state.pendingFinish) drain();
});
