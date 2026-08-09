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
    var conf = cfg();
    if (base) {
      /* Static-first: the backend publishes state.json to GitHub on every
         mutation, and GitHub serves any crowd for free — the script's daily
         runtime quota is spent on writes only. The minute bucket defeats the
         CDN cache without a stampede; an empty or failed static read falls
         back to the script itself. */
      var staticUrl = String(conf.stateUrl || '').trim();
      var live = function () {
        return get(base + (base.indexOf('?') === -1 ? '?' : '&') + 'action=state');
      };
      if (!staticUrl) return live();
      var bucket = Math.floor(Date.now() / 60000);
      return get(staticUrl + (staticUrl.indexOf('?') === -1 ? '?' : '&') + 'b=' + bucket)
        .then(function (j) {
          return (j && j.ok && j.counts) ? j : live();
        });
    }
    /* No API configured: no live state at all. The site still renders — the
       draw, the bill and the grid are static data — but nothing can invent a
       result, a team or a count. */
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

     ?now=HH:MM overrides it. That is a VIEW hook and nothing else: it moves
     which match reads as live and which act reads as on stage, and it is the
     only way to see the event-day rendering before the event day. It cannot
     reach the backend, write anything, or make the page claim a result the
     published state does not carry. Nothing in the UI advertises it. */

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

  /* Apps Script's response redirect measurably loses ~1 answer in 10, and a
     lost answer used to hang the page on "Versturen" forever. So: a 25s
     timeout per attempt, and (for callers that ask) automatic retries. A retry
     is only SAFE because register/order/add* carry a clientRef the backend
     replays instead of re-executing — never a duplicate row or mail. */
  var POST_TIMEOUT = 25000;

  function attempt(base, body) {
    var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = ctl && setTimeout(function () { ctl.abort(); }, POST_TIMEOUT);
    return fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body,
      redirect: 'follow',
      cache: 'no-store',
      signal: ctl ? ctl.signal : undefined
    })
      .then(function (r) { return r.text(); })
      .then(function (t) {
        var j = JSON.parse(t);
        if (!j || typeof j !== 'object') throw new Error('shape');
        return j;
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  function post(payload, opts) {
    var base = endpoint();
    if (!base) return Promise.resolve({ ok: false, error: 'network' });

    var body;
    try { body = JSON.stringify(payload || {}); }
    catch (e) { return Promise.resolve({ ok: false, error: 'bad-request' }); }

    var retries = (opts && opts.retries) | 0;
    try {
      var go = function (left) {
        return attempt(base, body).catch(function () {
          if (left <= 0) return { ok: false, error: 'network' };
          return new Promise(function (done) { setTimeout(done, 1200); })
            .then(function () { return go(left - 1); });
        });
      };
      return go(retries);
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

  /* A fresh idempotency token for a submit session (see post()). */
  function token() {
    try {
      if (root.crypto && typeof root.crypto.randomUUID === 'function') {
        return root.crypto.randomUUID();
      }
    } catch (e) { /* fall through */ }
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }

  root.ChampLive = {
    state: state,
    refresh: refresh,
    nowMinutes: nowMinutes,
    post: post,
    token: token,
    mergedTeams: mergedTeams
  };
})(typeof window !== 'undefined' ? window : globalThis);
