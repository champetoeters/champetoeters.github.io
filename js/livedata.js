/* ============================================================================
   livedata.js — CHAMPETOETERS & FRIENDS

   The one place the site talks to the backend (backend/API.md) and the one
   place "now" is decided. Every call resolves — a dead backend must leave the
   static site standing, never throw into a renderer.

   ChampLive.state() / .refresh() / .nowMinutes() / .post() / .mergedTeams()

   Owns: js/livedata.js
   Consumes: window.CHAMP_CONFIG (read-only)
   ========================================================================= */
(function (root) {
  'use strict';

  var EVENT_DAY = '2026-09-05';
  var DAY_AFTER = '2026-09-06';

  function cfg() { return root.CHAMP_CONFIG || {}; }
  function endpoint() { return String(cfg().apiEndpoint || '').trim(); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* Resolved against this script's own URL so the same file works from /,
     /admin/ and /preview/ without knowing where it was loaded from. */
  function dataUrl(file) {
    try {
      var s = document.querySelector('script[src*="livedata.js"]');
      if (s && s.src) return new URL('../data/' + file, s.src).href;
    } catch (e) { /* fall through */ }
    var here = (root.location && root.location.pathname) || '';
    return (/\/(preview|admin)\//.test(here) ? '../data/' : 'data/') + file;
  }

  function get(url) {
    try {
      return fetch(url, { cache: 'no-store', redirect: 'follow' })
        .then(function (r) { return r.ok ? r.json() : {}; })
        .then(function (j) { return (j && typeof j === 'object') ? j : {}; })
        .catch(function () { return {}; });
    } catch (e) {
      return Promise.resolve({});
    }
  }

  /* --------------------------------------------------------------- state */

  function pull() {
    var base = endpoint();
    if (base) return get(base + (base.indexOf('?') === -1 ? '?' : '&') + 'action=state');
    /* No API. The fabricated demo story may only show while the demo clock is
       on — demoNow is the ONE seam that switches the whole demo off. */
    var cfg = window.CHAMP_CONFIG || {};
    if (cfg.demoNow) return get(dataUrl('demo-state.json'));
    return Promise.resolve({});
  }

  var cached = null;

  function state() {
    if (!cached) cached = pull();
    return cached;
  }

  function refresh() {
    cached = pull();
    return cached;
  }

  /* ------------------------------------------------------------ the clock
     Event clock: 14:00 → 26:00, so anything before 08:00 is "tomorrow".
     ?now= is a screenshot hook only and nothing in the UI advertises it. */

  function toMin(hhmm) {
    var p = String(hhmm).split(':');
    var m = (+p[0]) * 60 + (+p[1] || 0);
    return m < 8 * 60 ? m + 24 * 60 : m;
  }

  function forced(value) {
    return (typeof value === 'string' && /^\d{1,2}:\d{2}$/.test(value.trim()))
      ? toMin(value.trim()) : null;
  }

  function nowMinutes() {
    var q = null;
    try { q = new URLSearchParams(root.location.search).get('now'); } catch (e) { q = null; }
    var hit = forced(q);
    if (hit !== null) return hit;

    hit = forced(cfg().demoNow);
    if (hit !== null) return hit;

    var d = new Date();
    var iso = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    var m = d.getHours() * 60 + d.getMinutes();
    if (iso === EVENT_DAY) return m;
    if (iso === DAY_AFTER && m <= 2 * 60) return m + 24 * 60;   /* 02:00 = lights out, still live */
    return null;
  }

  /* ---------------------------------------------------------------- post
     text/plain keeps it a simple request: Apps Script cannot answer a CORS
     preflight, so no other header may ever be added here. */

  function post(payload) {
    var base = endpoint();
    if (!base) return Promise.resolve({ ok: false, error: 'network' });

    var body;
    try { body = JSON.stringify(payload || {}); }
    catch (e) { return Promise.resolve({ ok: false, error: 'bad-request' }); }

    try {
      return fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: body,
        redirect: 'follow',
        cache: 'no-store'
      })
        .then(function (r) { return r.text(); })
        .then(function (t) {
          var j = JSON.parse(t);
          if (!j || typeof j !== 'object') throw new Error('shape');
          return j;
        })
        .catch(function () { return { ok: false, error: 'network' }; });
    } catch (e) {
      return Promise.resolve({ ok: false, error: 'network' });
    }
  }

  /* ---------------------------------------------------------- mergedTeams
     Registrations only ever land on a slot that is still open, so a slot
     already carrying names is left exactly as teams.json has it. */

  function mergedTeams(teams, live) {
    var list = Array.isArray(teams) ? teams : [];
    var fill = {};

    var entries = (live && Array.isArray(live.teams)) ? live.teams : [];
    entries.forEach(function (e) {
      if (!e || typeof e.teamId !== 'string' || !Array.isArray(e.players)) return;
      var names = e.players.filter(function (p) { return typeof p === 'string' && p.trim(); })
        .map(function (p) { return p.trim(); });
      if (names.length) {
        fill[e.teamId] = {
          players: names,
          name: (typeof e.name === 'string' && e.name.trim()) ? e.name.trim() : ''
        };
      }
    });

    return list.map(function (t) {
      if (!t || typeof t !== 'object') return t;
      var got = fill[t.id];
      if (!got || t.confirmed === true) return t;

      var out = {};
      Object.keys(t).forEach(function (k) { out[k] = t[k]; });
      out.players = got.players.slice();
      if (got.name) out.name = got.name;
      out.confirmed = true;
      delete out.label;            /* no stale "Vrije plaats" on a filled slot */
      return out;
    });
  }

  root.ChampLive = {
    state: state,
    refresh: refresh,
    nowMinutes: nowMinutes,
    post: post,
    mergedTeams: mergedTeams
  };
})(typeof window !== 'undefined' ? window : globalThis);
