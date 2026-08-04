'use strict';

/* Leads-GenX content script: scrapes Sales Navigator lead-search results and
 * auto-paginates. LinkedIn/Sales Navigator markup changes often — every lookup
 * below uses the layered fallback selectors from SPEC ("first non-empty
 * selector wins"). If scraping breaks, the selector groups here are the first
 * place to check. */

(() => {
  // ---------------------------------------------------------------- selectors
  // Result-card containers, tried in order; first group that matches wins.
  // Name + profile URL anchors. SN lead URLs appear both as
  // "/sales/lead/<id>," (trailing comma form) and "/sales/lead/<id>/…".
  const NAME_LINK_SELECTORS = [
    'a[href*="/sales/lead/"]',
    '.artdeco-entity-lockup__title a[href*="/sales/lead"]',
  ];
  const TITLE_SEL = '.artdeco-entity-lockup__subtitle, [data-anonymize="job-title"]';
  const COMPANY_SELECTORS = [
    'a[href*="/sales/company"]',
    '.artdeco-entity-lockup__caption a',
  ];
  const LOCATION_SEL = '.artdeco-entity-lockup__caption, [data-anonymize="location"]';
  const DEGREE_SEL = '.artdeco-entity-lockup__metadata';
  // "Next" pagination button (aria-label first, class fallback).
  const NEXT_SELECTORS = [
    'button[aria-label="Next"]',
    '.artdeco-pagination__button--next',
  ];

  // ------------------------------------------------------------------- state
  const state = {
    running: false,
    stopped: false,
    stopReason: null,
    sessionId: null,
    runName: '',
    pagesDone: 0,
    captured: 0,
    seen: new Set(), // profileUrls seen this session (dedupe)
    badge: null,
    badgeCount: null,
  };

  const PAGE_CAP = 100;
  const PAGE_CHANGE_TIMEOUT_MS = 15000;
  const COOLING_EVERY = 10;
  const COOLING_MS = 20000;

  // ------------------------------------------------------------------ helpers
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const absUrl = (href) => {
    try {
      return new URL(href, location.origin).href;
    } catch (_) {
      return href || '';
    }
  };
  const sleep = (ms) =>
    // Interruptible sleep: resolves early if the user stops the session.
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      const iv = setInterval(() => {
        if (state.stopped) {
          clearTimeout(t);
          clearInterval(iv);
          resolve();
        }
      }, 100);
      setTimeout(() => clearInterval(iv), ms + 50);
    });
  const rand = (min, max) => min + Math.random() * (max - min);

  function currentPageNumber() {
    const m = location.href.match(/[?&]page=(\d+)/);
    return m ? parseInt(m[1], 10) : 1;
  }

  // First non-empty selector wins: returns the first selector (in order) whose
  // query yields at least one element with non-empty text.
  function firstNonEmpty(root, selectors) {
    for (const sel of selectors) {
      const els = root.querySelectorAll(sel);
      for (const el of els) {
        if (clean(el.textContent)) return el;
      }
    }
    return null;
  }

  function firstLeadHref() {
    const anchor = document.querySelector('a[href*="/sales/lead/"]');
    return anchor ? absUrl(anchor.getAttribute('href')) : '';
  }

  function leadCards() {
    const anchors = Array.from(document.querySelectorAll('a[href*="/sales/lead/"]'));
    const cards = [];
    const seenCards = new Set();
    for (const anchor of anchors) {
      const card = anchor.closest('li, [role="listitem"], .search-results__result-item, [data-x-search-result]');
      if (card && !seenCards.has(card)) {
        seenCards.add(card);
        cards.push(card);
      }
    }
    return cards;
  }

  async function waitForLeadCards() {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && !state.stopped) {
      if (leadCards().length > 0) return true;
      await sleep(250);
    }
    return false;
  }

  // Human label for the run, e.g. the SN search name from the tab title.
  function detectRunName() {
    const title = clean(document.title).replace(/\s*\|\s*LinkedIn.*$/, '');
    return title || 'Sales Navigator extension';
  }

  // ------------------------------------------------------------------- badge
  function showBadge() {
    if (state.badge) return;
    const badge = document.createElement('div');
    badge.style.cssText = [
      'position:fixed', 'bottom:16px', 'right:16px', 'z-index:2147483647',
      'background:#f4f5f7', 'color:#4a5560', 'border:1px solid #d3d7dc',
      'border-radius:6px', 'padding:8px 12px',
      'font:12px/1.4 -apple-system,"Segoe UI",Roboto,Arial,sans-serif',
      'box-shadow:0 1px 4px rgba(0,0,0,0.12)', 'opacity:0.92',
    ].join(';');
    const label = document.createElement('span');
    label.textContent = 'Leads-GenX · 0 captured';
    const stop = document.createElement('a');
    stop.textContent = 'Stop';
    stop.href = '#';
    stop.style.cssText = 'margin-left:10px;color:#4a6fa5;text-decoration:underline;cursor:pointer;';
    stop.addEventListener('click', (e) => {
      e.preventDefault();
      requestStop('stopped by user');
    });
    badge.appendChild(label);
    badge.appendChild(stop);
    document.body.appendChild(badge);
    state.badge = badge;
    state.badgeCount = label;
  }

  function updateBadge() {
    if (state.badgeCount) {
      state.badgeCount.textContent = `Leads-GenX · ${state.captured} captured`;
    }
  }

  function removeBadge() {
    if (state.badge) {
      state.badge.remove();
      state.badge = null;
      state.badgeCount = null;
    }
  }

  // ----------------------------------------------------------------- scraping
  function scrapeCards() {
    const leads = [];
    for (const card of leadCards()) {
      // Name + profile URL come from the layered lead-link selectors; a card
      // may contain several anchors (avatar + name) — first non-empty wins.
      let fullName = '';
      let profileUrl = '';
      for (const linkSel of NAME_LINK_SELECTORS) {
        for (const a of card.querySelectorAll(linkSel)) {
          const href = a.getAttribute('href') || '';
          const text = clean(
            a.textContent ||
            a.getAttribute('aria-label') ||
            a.getAttribute('title')
          );
          if (!fullName && text) fullName = text;
          if (!profileUrl && href.includes('/sales/lead')) profileUrl = absUrl(href);
          if (fullName && profileUrl) break;
        }
        if (fullName && profileUrl) break; // first non-empty selector wins
      }
      // Skip cards without a name or a /sales/lead href (ads, upsells…).
      if (!fullName || !profileUrl) continue;
      // Dedupe within the session by profileUrl.
      if (state.seen.has(profileUrl)) continue;
      state.seen.add(profileUrl);

      const nameParts = fullName.split(' ');
      const companyEl = firstNonEmpty(card, COMPANY_SELECTORS);

      leads.push({
        fullName,
        firstName: nameParts[0] || '',
        lastName: nameParts.slice(1).join(' '),
        title: clean(card.querySelector(TITLE_SEL)?.textContent),
        company: clean(companyEl?.textContent),
        companyUrl: companyEl && companyEl.tagName === 'A'
          ? absUrl(companyEl.getAttribute('href'))
          : '',
        profileUrl,
        location: clean(card.querySelector(LOCATION_SEL)?.textContent),
        connectionDegree: clean(card.querySelector(DEGREE_SEL)?.textContent),
      });
    }
    return leads;
  }

  async function send(msg) {
    try {
      await chrome.runtime.sendMessage(msg);
    } catch (_) {
      // Service worker unreachable (e.g. extension reloaded mid-run) — keep
      // scraping so the badge count stays honest; leads may be lost.
    }
  }

  // --------------------------------------------------------------- pagination
  function findNextButton() {
    for (const sel of NEXT_SELECTORS) {
      const btn = document.querySelector(sel);
      if (btn) return btn;
    }
    return null;
  }

  // Detects an actual page change after clicking Next: watches both the
  // `?page=` param in the URL and the first card's lead href, because Sales
  // Navigator sometimes paginates without updating the URL (and vice versa).
  async function waitForPageChange(urlBefore, hrefBefore) {
    const deadline = Date.now() + PAGE_CHANGE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (state.stopped) return 'stopped';
      if (location.href !== urlBefore) return 'changed';
      const nowHref = firstLeadHref();
      if (nowHref && hrefBefore && nowHref !== hrefBefore) return 'changed';
      await sleep(250);
    }
    return 'timeout';
  }

  async function finish(reason) {
    state.running = false;
    removeBadge();
    await send({ type: 'finish', sessionId: state.sessionId, reason });
  }

  function requestStop(reason) {
    state.stopped = true;
    state.stopReason = reason;
  }

  async function run() {
    showBadge();
    if (!(await waitForLeadCards())) {
      state.running = false;
      removeBadge();
      await send({
        type: 'diagnostic',
        status: 'No Sales Navigator lead cards detected — open a lead search results page, wait for results, then try again.',
      });
      return;
    }
    while (!state.stopped) {
      const page = currentPageNumber();
      const leads = scrapeCards();
      state.captured += leads.length;
      updateBadge();
      await send({
        type: 'leads',
        sessionId: state.sessionId,
        runName: state.runName,
        page,
        leads,
      });
      state.pagesDone += 1;

      if (state.stopped) break;
      if (state.pagesDone >= PAGE_CAP) {
        await finish('page cap reached');
        return;
      }

      // Cooling pause every 10 pages to look less like a bot.
      if (state.pagesDone % COOLING_EVERY === 0) {
        await sleep(COOLING_MS);
        if (state.stopped) break;
      }

      const nextBtn = findNextButton();
      if (!nextBtn || nextBtn.disabled || nextBtn.getAttribute('aria-disabled') === 'true') {
        await finish('no more pages');
        return;
      }

      const urlBefore = location.href;
      const hrefBefore = firstLeadHref();
      nextBtn.click();

      const result = await waitForPageChange(urlBefore, hrefBefore);
      if (result === 'stopped') break;
      if (result === 'timeout') {
        await finish('page did not change');
        return;
      }

      // Let the new results render, then wait a human-like random delay.
      await sleep(800);
      await sleep(rand(1500, 3500));
    }
    await finish(state.stopReason || 'stopped by user');
  }

  // ----------------------------------------------------------------- messages
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'start') {
      if (state.running) return; // ignore double-start
      state.running = true;
      state.stopped = false;
      state.stopReason = null;
      state.sessionId = crypto.randomUUID();
      state.runName = detectRunName();
      state.pagesDone = 0;
      state.captured = 0;
      state.seen = new Set();
      run();
    } else if (msg.type === 'stop') {
      if (state.running) requestStop('stopped by user');
    }
  });
})();
