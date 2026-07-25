'use strict';

/* Leads-GenX popup: settings, connection test, and scrape controls.
 * Talks to the background service worker; never touches the page directly. */

const DEFAULT_SERVER = 'https://leadsgenx.top';

const els = {
  serverUrl: document.getElementById('server-url'),
  token: document.getElementById('token'),
  saveBtn: document.getElementById('save-btn'),
  testBtn: document.getElementById('test-btn'),
  connStatus: document.getElementById('conn-status'),
  startBtn: document.getElementById('start-btn'),
  stopBtn: document.getElementById('stop-btn'),
  hint: document.getElementById('scrape-hint'),
  captured: document.getElementById('captured'),
  sent: document.getElementById('sent'),
  lastStatus: document.getElementById('last-status'),
};

let activeTab = null;
let scraping = false;

function normalizeServer(url) {
  return (url || '').trim().replace(/\/+$/, '');
}

function isSalesNavUrl(url) {
  // Start is only offered on Sales Navigator pages.
  return typeof url === 'string' && /^https:\/\/(www\.)?linkedin\.com\/sales\//.test(url);
}

function setConnStatus(text, kind) {
  els.connStatus.textContent = text || '';
  els.connStatus.className = kind || '';
}

function refreshButtons() {
  const hasSettings = Boolean(normalizeServer(els.serverUrl.value) && els.token.value.trim());
  const onSalesNav = activeTab && isSalesNavUrl(activeTab.url);
  // Start only on a linkedin.com/sales tab with a saved server + token.
  els.startBtn.disabled = scraping || !(hasSettings && onSalesNav);
  els.stopBtn.disabled = !scraping;
  if (!onSalesNav) {
    els.hint.textContent = 'Open a Sales Navigator lead search to start scraping.';
  } else if (!hasSettings) {
    els.hint.textContent = 'Save a server URL and extension key first.';
  } else {
    els.hint.textContent = '';
  }
}

async function loadState() {
  const stored = await chrome.storage.local.get(['serverUrl', 'token']);
  els.serverUrl.value = stored.serverUrl || DEFAULT_SERVER;
  els.token.value = stored.token || '';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  refreshButtons();
}

els.saveBtn.addEventListener('click', async () => {
  const serverUrl = normalizeServer(els.serverUrl.value) || DEFAULT_SERVER;
  const token = els.token.value.trim();
  await chrome.storage.local.set({ serverUrl, token });
  els.serverUrl.value = serverUrl;
  setConnStatus('Saved.', 'ok');
  refreshButtons();
});

els.testBtn.addEventListener('click', async () => {
  const serverUrl = normalizeServer(els.serverUrl.value);
  const token = els.token.value.trim();
  if (!serverUrl || !token) {
    setConnStatus('Enter a server URL and extension key first.', 'err');
    return;
  }
  setConnStatus('Testing…');
  els.testBtn.disabled = true;
  try {
    const res = await fetch(`${serverUrl}/api/extension/ping`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Server answers 401 as { error: 'Invalid extension token' }.
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    // Ping shape: { data: { ok, username, server } }
    const username = body.data && body.data.username;
    setConnStatus(`Connected as ${username || 'unknown user'}`, 'ok');
  } catch (err) {
    setConnStatus(`Connection failed: ${err.message}`, 'err');
  } finally {
    els.testBtn.disabled = false;
  }
});

els.startBtn.addEventListener('click', async () => {
  if (!activeTab) return;
  // Persist whatever is in the fields so the SW uses the latest values.
  await chrome.storage.local.set({
    serverUrl: normalizeServer(els.serverUrl.value) || DEFAULT_SERVER,
    token: els.token.value.trim(),
  });
  try {
    await chrome.runtime.sendMessage({ type: 'start', tabId: activeTab.id });
    scraping = true;
    els.lastStatus.textContent = 'scraping…';
  } catch (err) {
    setConnStatus(`Could not start: ${err.message}`, 'err');
  }
  refreshButtons();
});

els.stopBtn.addEventListener('click', async () => {
  if (!activeTab) return;
  try {
    await chrome.runtime.sendMessage({ type: 'stop', tabId: activeTab.id });
  } catch (_) { /* SW may be asleep; the badge Stop link still works */ }
  scraping = false;
  els.lastStatus.textContent = 'stopping…';
  refreshButtons();
});

// Live counter area, fed by the background service worker.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'progress') return;
  els.captured.textContent = String(msg.captured ?? 0);
  els.sent.textContent = String(msg.sent ?? 0);
  if (msg.lastStatus) els.lastStatus.textContent = msg.lastStatus;
  if (msg.lastStatus === 'finished') {
    scraping = false;
    refreshButtons();
  }
});

loadState();
