/* ============================================================================
   admin.js — the organisers' tool at /admin/
   Owned by: admin builder.

   One job per view (BRIEF §0): enter a score, tick a €50 team payment, count
   €12 ticket payments. Used one-handed on a phone next to a court, so every
   write is optimistic and every failure reverts and says so.

   Consumes: window.ChampBracket (resolve), window.ChampLive (post, mergedTeams),
   window.CHAMP_CONFIG. All three are guarded — a missing shared module must
   degrade, never white-screen the tool.

   Transport: every write is POST { action:'admin', password, op, … } through
   ChampLive.post (see backend/API.md). Response error 'unauthorized' anywhere
   drops back to the login view.

   ?state=demo is a screenshot hook (BRIEF §0 rule 8): it skips the login and
   feeds the views a fixture. Nothing in the UI advertises it and no write
   leaves the browser.
   ========================================================================= */
(function () {
  'use strict';

  var SESSION_KEY = 'champ.admin.pw';
  var TICKET_PRICE = 12;
  var DATA = '../data/';

  /* Dutch labels — data is already Dutch and is never re-translated. */
  var PHASE = {
    group: 'Groepswedstrijden',
    qf: 'Kwartfinales',
    sf: 'Halve finales',
    final: 'FINALE'
  };
  /* Same map as timetable.js: eight groups, winners only — no runners-up. */
  var KO = {
    QF1A: 'Winnaar Groep A', QF1B: 'Winnaar Groep B',
    QF2A: 'Winnaar Groep C', QF2B: 'Winnaar Groep D',
    QF3A: 'Winnaar Groep E', QF3B: 'Winnaar Groep F',
    QF4A: 'Winnaar Groep G', QF4B: 'Winnaar Groep H',
    SF1A: 'Winnaar Kwartfinale 1', SF1B: 'Winnaar Kwartfinale 2',
    SF2A: 'Winnaar Kwartfinale 3', SF2B: 'Winnaar Kwartfinale 4',
    FA: 'Winnaar Halve finale 1', FB: 'Winnaar Halve finale 2'
  };
  var OPEN = 'Vrije plaats';
  var MONTH = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

  /* ------------------------------------------------------------------ utils */

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }

  var PARTICLES = { van: 1, de: 1, den: 1, der: 1, vanden: 1, vander: 1, ter: 1, ten: 1, het: 1, "'t": 1, op: 1 };
  function surname(full) {
    var p = String(full || '').trim().split(/\s+/);
    if (p.length < 2) return p[0] || '';
    for (var i = 1; i < p.length - 1; i++) if (PARTICLES[p[i].toLowerCase()]) return p.slice(i).join(' ');
    return p[p.length - 1];
  }
  function pairShort(players) { return (players || []).map(surname).join(' & '); }
  function pairFull(players) { return (players || []).join(' & '); }
  function euro(n) { return '€' + Math.round(n); }
  function shortDate(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.getDate() + ' ' + MONTH[d.getMonth()];
  }
  function num(v) { var n = parseInt(String(v).replace(/[^0-9]/g, ''), 10); return isNaN(n) ? null : Math.min(99, n); }

  /* ------------------------------------------------- row input sanitising
     Same rules as the server's clean()/cleanEmail() (backend/API.md), so a row
     typed here is scrubbed to exactly what the server would have stored — and
     the organiser is told what is wrong before the round trip. */

  var RX_CTRL = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E]/g;
  var RX_BAD = /[^\p{L}\p{N} .,'’&@+()/-]/gu;
  var RX_LETTER = /\p{L}/u;
  var RX_EMAIL = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
  var RX_TEL = /^(?:\+|00)?\d{8,15}$/;
  var MAX_QTY = 8;

  function scrub(v, max) {
    return String(v == null ? '' : v)
      .replace(RX_CTRL, '').replace(RX_BAD, '').replace(/\s+/g, ' ').trim().slice(0, max);
  }
  function scrubEmail(v) {
    return String(v == null ? '' : v).replace(RX_CTRL, '').replace(/\s+/g, '').slice(0, 160);
  }

  /* --------------------------------------------------------------- elements */

  var E = {};
  ['topAct', 'loginForm', 'pw', 'loginError', 'loginBtn', 'loginNote', 'toast'].forEach(function (k) {
    E[k] = document.querySelector('[data-el="' + k + '"]');
  });
  function view(name) { return document.querySelector('[data-view="' + name + '"]'); }
  function panel(name) { return document.querySelector('[data-panel="' + name + '"]'); }

  /* ------------------------------------------------------------------ state */

  var S = {
    /* The demo fixture opens the tool WITHOUT the password, so it exists only
       on an unwired build — never where a backend (and real data) lives. */
    demo: !((window.CHAMP_CONFIG || {}).apiEndpoint) &&
          /(^|&)state=demo(&|$)/.test(location.search.slice(1)),
    pw: '',
    schedule: { slots: [], matches: [] },
    courtName: {},
    teamsBase: [],
    teams: [],
    teamMap: {},
    regByTeam: {},
    results: {},
    registrations: [],
    orders: [],
    teamPaid: {},
    teamPrice: 50,
    bracket: null,
    open: null,      /* matchId whose editor is open */
    draft: null,     /* { sets: [[a,b],…], winner: 'A'|'B'|null } */
    tab: 'matches',
    ask: null,       /* ref whose delete is waiting for Ja / Nee */
    form: null       /* { kind:'team'|'order', … typed values …, err } */
  };

  /* ------------------------------------------------------------------- toast */

  var toastTimer = null;
  function toast(msg, kind) {
    if (!E.toast) return;
    E.toast.textContent = msg;
    E.toast.className = 'ad-toast is-on' + (kind ? ' is-' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      E.toast.className = 'ad-toast' + (kind ? ' is-' + kind : '');
    }, 2800);
  }

  /* ----------------------------------------------------------------- backend */

  function post(payload, opts) {
    if (S.demo) return Promise.resolve({ ok: true });
    var live = window.ChampLive;
    if (!live || typeof live.post !== 'function') return Promise.resolve({ ok: false, error: 'server' });
    return live.post(payload, opts).then(function (r) { return r || { ok: false, error: 'server' }; },
      function () { return { ok: false, error: 'server' }; });
  }

  function admin(op, extra, opts) {
    var body = { action: 'admin', password: S.pw, op: op };
    if (extra) Object.keys(extra).forEach(function (k) { body[k] = extra[k]; });
    return post(body, opts);
  }

  /* One write, one revert. The UI is already updated when this runs.
     alsoOk names an error code that means the same thing as success — a delete
     answered 'not-found' has already happened, so reverting would resurrect a
     row that is gone. */
  function write(op, extra, revert, okMsg, alsoOk) {
    /* Same retries as the add-forms: Apps Script loses ~1 answer in 10, and
       every op here survives a replay (sets are idempotent; a delete answering
       not-found is exactly the alsoOk case below). */
    admin(op, extra, { retries: 2 }).then(function (r) {
      if (r && (r.ok || (alsoOk && r.error === alsoOk))) { toast(okMsg || 'Bewaard', 'ok'); return; }
      revert();
      if (r && r.error === 'unauthorized') { expire(); return; }
      toast('Niet bewaard, probeer opnieuw', 'bad');
    });
  }

  /* --------------------------------------------------------------- bracket */

  function recompute() {
    var B = window.ChampBracket;
    if (B && typeof B.resolve === 'function') {
      try {
        var r = B.resolve(S.schedule, S.teams, S.results);
        if (r && r.byMatch) { S.bracket = r; return; }
      } catch (e) { /* fall through to the local view below */ }
    }
    S.bracket = localBracket();
  }

  /* Fallback: group matches still resolve (their teamIds are in the schedule),
     knockout slots simply stay placeholders. */
  function localBracket() {
    var byMatch = {};
    (S.schedule.matches || []).forEach(function (m) {
      var rt = (m.teams || []).map(function (id) { return S.teamMap[id] ? id : null; });
      var res = S.results[m.id] || null;
      byMatch[m.id] = {
        result: res,
        resolvedTeams: rt,
        winnerTeamId: res && res.winner ? rt[res.winner === 'B' ? 1 : 0] : null
      };
    });
    return { standings: {}, slots: {}, byMatch: byMatch };
  }

  function sideOf(m, i) {
    var bm = (S.bracket && S.bracket.byMatch && S.bracket.byMatch[m.id]) || {};
    var ph = (m.teams || [])[i];
    var tid = (bm.resolvedTeams && bm.resolvedTeams[i]) || (S.teamMap[ph] ? ph : null);
    var t = tid && S.teamMap[tid];
    if (t && (t.players || []).length) {
      var label = (typeof t.name === 'string' && t.name.trim()) ? t.name.trim() : pairShort(t.players);
      return { tid: tid, name: label, full: label + ' (' + pairFull(t.players) + ')' };
    }
    if (t) return { tid: tid, name: t.label || OPEN, full: t.label || OPEN, dim: true };
    return { tid: null, name: KO[ph] || String(ph || ''), full: KO[ph] || String(ph || ''), dim: true };
  }

  function winnerIndex(sets) {
    var a = 0, b = 0;
    (sets || []).forEach(function (s) { if (s[0] > s[1]) a++; else if (s[1] > s[0]) b++; });
    return a === b ? null : (a > b ? 0 : 1);
  }
  function scoreText(res) {
    return (res.sets || []).map(function (s) { return s[0] + '-' + s[1]; }).join(' ');
  }

  /* ------------------------------------------------------------------ teams */

  function mergeTeams() {
    var state = {
      teams: S.registrations.filter(function (r) { return r.teamId; }).map(function (r) {
        return {
          teamId: r.teamId,
          name: String(r.teamName || ''),
          players: [r.player1, r.player2].filter(Boolean)
        };
      })
    };
    var live = window.ChampLive;
    var merged = null;
    if (live && typeof live.mergedTeams === 'function') {
      try { merged = live.mergedTeams(S.teamsBase, state); } catch (e) { merged = null; }
    }
    if (!merged || !merged.length) {
      merged = S.teamsBase.map(function (t) {
        var hit = state.teams.filter(function (x) { return x.teamId === t.id; })[0];
        if (!hit) return t;
        var c = {};
        Object.keys(t).forEach(function (k) { c[k] = t[k]; });
        c.players = hit.players;
        if (hit.name) c.name = hit.name;
        c.confirmed = true;
        return c;
      });
    }
    S.teams = merged;
    S.teamMap = {};
    merged.forEach(function (t) { S.teamMap[t.id] = t; });
    S.regByTeam = {};
    S.registrations.forEach(function (r) { if (r.teamId) S.regByTeam[r.teamId] = r; });
  }

  /* teamId for the 14 pre-entered slots, ref for a registration (API.md). */
  function payOf(t) {
    var reg = S.regByTeam[t.id];
    if (reg) return { key: reg.ref, paid: !!reg.paid, ref: reg.ref, reg: reg };
    return { key: t.id, paid: !!S.teamPaid[t.id], ref: null, reg: null };
  }

  /* ============================== RENDER: matches ======================== */

  function renderMatches() {
    var el = panel('matches');
    if (!el) return;
    recompute();

    var ms = S.schedule.matches || [];
    var done = ms.filter(function (m) { return S.results[m.id]; }).length;

    var out = ['<div class="ad-head"><span class="ad-tot"><span class="ad-tot__x u-tabular">' +
      done + '/' + ms.length + '</span> wedstrijden ingevuld</span>' +
      '<span class="ad-hint">Tik een wedstrijd om de score in te vullen.</span></div><div class="ad-list">'];

    var phase = null;
    ms.forEach(function (m) {
      var head = '';
      if (m.round !== phase) { phase = m.round; head = '<span class="ad-sub">' + esc(PHASE[m.round] || '') + '</span>'; }

      var A = sideOf(m, 0), B = sideOf(m, 1);
      var res = S.results[m.id];
      var bm = (S.bracket.byMatch && S.bracket.byMatch[m.id]) || {};
      var wi = res ? (bm.winnerTeamId && A.tid ? (bm.winnerTeamId === A.tid ? 0 : 1)
        : (res.winner === 'B' ? 1 : 0)) : null;

      var meta = m.start + ' · ' + (S.courtName[m.court] || m.court) +
        (m.round === 'group' && m.roundLabel ? ' · ' + m.roundLabel : '');
      var isOpen = S.open === m.id;

      function nm(s, i) {
        var cls = res ? (i === wi ? ' is-win' : ' is-lose') : (s.dim ? ' is-tbd' : '');
        return '<span class="ad-m__n' + cls + '">' + esc(s.name) + '</span>';
      }

      out.push('<div class="ad-item' + (head ? ' has-sub' : '') + (isOpen ? ' is-open' : '') + '">' + head +
        '<button type="button" class="ad-m" data-m="' + esc(m.id) + '" aria-expanded="' + isOpen + '"' +
        (isOpen ? ' aria-controls="ad-ed-' + esc(m.id) + '"' : '') + '>' +
        '<span class="ad-m__meta u-tabular">' + esc(meta) + '</span>' +
        '<span class="ad-m__tie">' + nm(A, 0) + nm(B, 1) + '</span>' +
        '<span class="ad-m__sc u-tabular' + (res ? '' : ' is-none') + '">' +
        (res ? esc(scoreText(res)) : '\u2013') + '</span>' +
        '</button>' + (isOpen ? editorHtml(m, A, B, !!res) : '') + '</div>');
    });

    out.push('</div>');
    el.innerHTML = out.join('');
  }

  function editorHtml(m, A, B, hasResult) {
    var d = S.draft || { sets: [], winner: null };
    var rows = '';
    for (var i = 0; i < 3; i++) {
      var s = d.sets[i] || [null, null];
      rows += '<span class="ad-ed__rl">Set ' + (i + 1) + '</span>' +
        cell(m.id, i, 0, s[0], A.name) + cell(m.id, i, 1, s[1], B.name);
    }
    var level = needsPick(d);
    return '<div class="glass glass--inset ad-ed" id="ad-ed-' + esc(m.id) + '">' +
      '<div class="ad-ed__grid">' +
      '<span></span><span class="ad-ed__hn">' + esc(A.name) + '</span><span class="ad-ed__hn">' + esc(B.name) + '</span>' +
      rows + '</div>' +
      '<div class="ad-win" data-el="win"' + (level ? '' : ' hidden') + '>' +
      '<span class="ad-win__l">Winnaar</span><div class="ad-win__o">' +
      '<button type="button" class="glass-btn glass-btn--sm" data-act="win" data-w="A" aria-pressed="' +
      (d.winner === 'A') + '"><span>' + esc(A.name) + '</span></button>' +
      '<button type="button" class="glass-btn glass-btn--sm" data-act="win" data-w="B" aria-pressed="' +
      (d.winner === 'B') + '"><span>' + esc(B.name) + '</span></button>' +
      '</div></div>' +
      '<p class="glass-error ad-err" data-el="edErr" role="status" aria-live="polite"></p>' +
      '<div class="ad-act">' +
      '<button type="button" class="glass-btn glass-btn--primary" data-act="save">Bewaren</button>' +
      (hasResult ? '<button type="button" class="glass-btn glass-btn--ghost" data-act="clear">Wissen</button>' : '') +
      '</div></div>';
  }

  function cell(mid, set, side, val, name) {
    return '<input class="glass-input u-tabular" type="text" inputmode="numeric" pattern="[0-9]*" ' +
      'maxlength="2" data-set="' + set + '" data-side="' + side + '" ' +
      'aria-label="Set ' + (set + 1) + ', games ' + esc(name) + '" value="' +
      (val == null ? '' : esc(val)) + '">';
  }

  /* A draft with an equal number of sets won on both sides needs a manual pick. */
  function needsPick(d) {
    var full = (d.sets || []).filter(function (s) { return s && s[0] != null && s[1] != null; });
    return full.length > 0 && winnerIndex(full) == null;
  }

  function readDraft(edEl) {
    var sets = [[null, null], [null, null], [null, null]];
    Array.prototype.forEach.call(edEl.querySelectorAll('input[data-set]'), function (i) {
      var v = i.value === '' ? null : num(i.value);
      sets[+i.dataset.set][+i.dataset.side] = v;
    });
    S.draft.sets = sets;
  }

  function syncWin(edEl) {
    var box = edEl.querySelector('[data-el="win"]');
    if (!box) return;
    var level = needsPick(S.draft);
    box.hidden = !level;
    if (!level) S.draft.winner = null;
    Array.prototype.forEach.call(edEl.querySelectorAll('[data-act="win"]'), function (b) {
      b.setAttribute('aria-pressed', String(S.draft.winner === b.dataset.w));
    });
  }

  function openMatch(id) {
    var res = S.results[id];
    S.open = id;
    S.draft = {
      sets: (res && res.sets ? res.sets.map(function (s) { return [s[0], s[1]]; }) : []),
      winner: res && needsPick({ sets: res.sets }) ? res.winner : null
    };
    renderMatches();
    var first = document.querySelector('#ad-ed-' + id + ' input[data-set]');
    if (first) first.focus();
  }

  function closeMatch(focusRow) {
    var id = S.open;
    S.open = null; S.draft = null;
    renderMatches();
    if (focusRow && id) {
      var b = document.querySelector('.ad-m[data-m="' + id + '"]');
      if (b) b.focus();
    }
  }

  function saveMatch(id) {
    var ed = document.getElementById('ad-ed-' + id);
    if (!ed) return;
    readDraft(ed);
    var err = ed.querySelector('[data-el="edErr"]');

    var sets = [];
    var bad = false;
    S.draft.sets.forEach(function (s) {
      if (s[0] == null && s[1] == null) return;
      if (s[0] == null || s[1] == null) { bad = true; return; }
      sets.push([s[0], s[1]]);
    });
    if (bad || !sets.length) {
      err.textContent = bad ? 'Vul beide scores van de set in.' : 'Vul minstens één set in.';
      return;
    }
    var wi = winnerIndex(sets);
    var winner = wi == null ? S.draft.winner : (wi === 0 ? 'A' : 'B');
    if (!winner) { err.textContent = 'Kies de winnaar.'; return; }

    var prev = S.results[id];
    S.results[id] = { sets: sets, winner: winner };
    closeMatch(true);
    write('setResult', { matchId: id, sets: sets, winner: winner }, function () {
      if (prev) S.results[id] = prev; else delete S.results[id];
      renderMatches();
    });
  }

  function clearMatch(id) {
    var prev = S.results[id];
    if (!prev) { closeMatch(true); return; }
    delete S.results[id];
    closeMatch(true);
    write('clearResult', { matchId: id }, function () {
      S.results[id] = prev;
      renderMatches();
    }, 'Gewist');
  }

  /* ======================= rows: delete + add (shared) ====================
     Registrations and ticket orders are spreadsheet rows, and the organisers
     edit them like rows: a quiet ✕ at the end, one inline "Verwijderen? Ja /
     Nee" (never a browser confirm), and one add form at the end of the list.
     Only ref-keyed rows can go — the 14 pre-entered teams are not ours. */

  function delBtn(kind, ref, label) {
    return '<button type="button" class="ad-x" data-act="del-ask" data-kind="' + kind +
      '" data-ref="' + esc(ref) + '" aria-label="' + esc(label) + '">✕</button>';
  }

  function askHtml(kind, ref) {
    return '<div class="ad-conf"><span class="ad-conf__q">Verwijderen?</span>' +
      '<button type="button" class="glass-btn glass-btn--sm glass-btn--primary" data-act="del-yes"' +
      ' data-kind="' + kind + '" data-ref="' + esc(ref) + '">Ja</button>' +
      '<button type="button" class="glass-btn glass-btn--sm glass-btn--ghost" data-act="del-no"' +
      ' data-kind="' + kind + '" data-ref="' + esc(ref) + '">Nee</button></div>';
  }

  function fieldHtml(id, label, key, value, type, max, extra) {
    return '<div class="glass-field"><label class="glass-label" for="ad-f-' + id + '">' +
      esc(label) + '</label><input class="glass-input" id="ad-f-' + id + '" data-f="' + key +
      '" type="' + type + '" maxlength="' + max + '" autocomplete="off" spellcheck="false"' +
      (type === 'text' ? '' : ' autocapitalize="off"') + (extra || '') +
      ' value="' + esc(value == null ? '' : value) + '"></div>';
  }

  function addBtnHtml(kind, label) {
    return '<div class="ad-item ad-item--add"><button type="button" class="ad-add" data-act="add-open"' +
      ' data-kind="' + kind + '">+ ' + esc(label) + '</button></div>';
  }

  function formActs(err) {
    return '<p class="glass-error ad-err" data-el="formErr" role="status" aria-live="polite">' +
      esc(err || '') + '</p><div class="ad-act">' +
      '<button type="button" class="glass-btn glass-btn--primary" data-act="add-save">Toevoegen</button>' +
      '<button type="button" class="glass-btn glass-btn--ghost" data-act="add-cancel">Annuleren</button>' +
      '</div>';
  }

  function checkHtml(key, on, label) {
    return '<label class="ad-fchk"><input type="checkbox" class="ad-t__i u-sr-only" data-f="' + key + '"' +
      (on ? ' checked' : '') + '><span class="ad-check" aria-hidden="true"></span>' +
      '<span class="ad-fchk__l">' + esc(label) + '</span></label>';
  }

  function blankForm(kind) {
    var tok = (window.ChampLive && window.ChampLive.token)
      ? window.ChampLive.token()
      : 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    return kind === 'team'
      ? { kind: 'team', clientRef: tok, teamName: '', player1: '', player2: '', email: '', phone: '', paid: false, err: '' }
      : { kind: 'order', clientRef: tok, name: '', email: '', quantity: '1', paidCount: '0', err: '' };
  }

  /* The form re-renders whenever its list does (a payment tick elsewhere, a
     failed write), so what was typed lives in S.form, not only in the DOM. */
  function readForm() {
    var f = S.form;
    if (!f) return null;
    var box = document.querySelector('.ad-form');
    if (!box) return f;
    Array.prototype.forEach.call(box.querySelectorAll('[data-f]'), function (el) {
      f[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return f;
  }

  function formError(msg) {
    S.form.err = msg;
    var box = document.querySelector('[data-el="formErr"]');
    if (box) box.textContent = msg;
  }

  function formBusy(on) {
    var b = document.querySelector('[data-act="add-save"]');
    if (b) b.disabled = on;
  }

  function rerender(kind) { if (kind === 'team') renderTeams(); else renderOrders(); }

  /* One confirmation at a time; tapping the same ✕ again takes it back. */
  function askDelete(kind, ref) {
    S.ask = S.ask === ref ? null : ref;
    rerender(kind);
    keepFocus(S.ask
      ? '[data-act="del-yes"][data-ref="' + ref + '"]'
      : '.ad-x[data-ref="' + ref + '"]');
  }

  function openForm(kind) {
    S.form = blankForm(kind);
    S.ask = null;
    if (kind === 'team') renderTeams(); else renderOrders();
    var first = document.querySelector('.ad-form input[data-f]');
    if (first) first.focus();
  }

  function closeForm() {
    var kind = S.form && S.form.kind;
    S.form = null;
    if (kind === 'team') renderTeams(); else renderOrders();
  }

  /* Server rules, said in Dutch. Anything that passes here passes there. */
  function teamError(f) {
    if (!f.teamName || f.teamName.length < 2) return 'Vul een teamnaam in (minstens 2 tekens).';
    if (!RX_LETTER.test(f.teamName)) return 'Deze teamnaam klopt niet.';
    if (!f.player1) return 'Vul de naam van speler 1 in.';
    if (!RX_LETTER.test(f.player1)) return 'De naam van speler 1 klopt niet.';
    if (!f.player2) return 'Vul de naam van speler 2 in.';
    if (!RX_LETTER.test(f.player2)) return 'De naam van speler 2 klopt niet.';
    if (!f.email) return 'Vul een e-mailadres in.';
    if (!RX_EMAIL.test(f.email)) return 'Dit e-mailadres klopt niet.';
    if (!f.phone) return 'Vul een gsm-nummer in.';
    if (!RX_TEL.test(f.phone.replace(/[\s.\-()/]/g, ''))) return 'Dit gsm-nummer klopt niet.';
    return '';
  }

  function orderError(f) {
    if (!f.name) return 'Vul een naam in.';
    if (!RX_LETTER.test(f.name)) return 'Deze naam klopt niet.';
    if (!f.email) return 'Vul een e-mailadres in.';
    if (!RX_EMAIL.test(f.email)) return 'Dit e-mailadres klopt niet.';
    if (!(f.quantity >= 1 && f.quantity <= MAX_QTY)) return 'Aantal tickets: 1 tot ' + MAX_QTY + '.';
    return '';
  }

  /* An add cannot be optimistic: the ref and the slot are the server's to give.
     The button locks, the answer draws the row. */
  function addTeam() {
    var raw = readForm();
    var f = {
      clientRef: String(raw.clientRef || ''),
      teamName: scrub(raw.teamName, 40),
      player1: scrub(raw.player1, 60), player2: scrub(raw.player2, 60),
      email: scrubEmail(raw.email), phone: scrub(raw.phone, 40), paid: !!raw.paid
    };
    var err = teamError(f);
    if (err) { formError(err); return; }
    formBusy(true);
    admin('addRegistration', f, { retries: 2 }).then(function (r) {
      formBusy(false);
      if (r && r.ok) {
        S.registrations.push({
          ref: r.reference, teamId: r.teamId, teamName: f.teamName,
          player1: f.player1, player2: f.player2,
          email: f.email, phone: f.phone, at: new Date().toISOString(), paid: f.paid
        });
        S.form = null;
        mergeTeams();
        renderTeams();
        renderMatches();
        toast('Team toegevoegd (' + r.reference + ')', 'ok');
        return;
      }
      if (r && r.error === 'unauthorized') { expire(); return; }
      formError(r && r.error === 'full' ? 'Alle plaatsen zijn bezet.'
        : r && r.error === 'bad-request' ? 'Controleer de gegevens.'
          : 'Niet bewaard, probeer opnieuw.');
    });
  }

  function addOrder() {
    var raw = readForm();
    var f = {
      clientRef: String(raw.clientRef || ''),
      name: scrub(raw.name, 60), email: scrubEmail(raw.email),
      quantity: num(raw.quantity), paidCount: num(raw.paidCount) || 0
    };
    var err = orderError(f);
    if (err) { formError(err); return; }
    f.paidCount = Math.max(0, Math.min(f.quantity, f.paidCount));
    formBusy(true);
    admin('addOrder', f, { retries: 2 }).then(function (r) {
      formBusy(false);
      if (r && r.ok) {
        S.orders.push({
          ref: r.reference, name: f.name, email: f.email, quantity: f.quantity,
          at: new Date().toISOString(), paidCount: f.paidCount
        });
        S.form = null;
        renderOrders();
        toast('Bestelling toegevoegd (' + r.reference + ')', 'ok');
        return;
      }
      if (r && r.error === 'unauthorized') { expire(); return; }
      formError(r && r.error === 'bad-request' ? 'Controleer de gegevens.'
        : 'Niet bewaard, probeer opnieuw.');
    });
  }

  function delTeam(ref) {
    var i = -1;
    S.registrations.forEach(function (r, n) { if (r.ref === ref) i = n; });
    if (i === -1) return;
    var row = S.registrations[i];
    S.registrations.splice(i, 1);
    S.ask = null;
    mergeTeams();
    renderTeams();
    renderMatches();
    write('deleteRegistration', { ref: ref }, function () {
      S.registrations.splice(i, 0, row);
      mergeTeams();
      renderTeams();
      renderMatches();
    }, 'Verwijderd', 'not-found');
  }

  function delOrder(ref) {
    var i = -1;
    S.orders.forEach(function (o, n) { if (o.ref === ref) i = n; });
    if (i === -1) return;
    var row = S.orders[i];
    S.orders.splice(i, 1);
    S.ask = null;
    renderOrders();
    write('deleteOrder', { ref: ref }, function () {
      S.orders.splice(i, 0, row);
      renderOrders();
    }, 'Verwijderd', 'not-found');
  }

  /* ============================== RENDER: teams ========================== */

  function renderTeams() {
    var el = panel('teams');
    if (!el) return;
    var paid = 0;
    var rows = S.teams.map(function (t) {
      var p = payOf(t);
      var has = (t.players || []).length > 0;
      if (p.paid) paid++;
      /* No group letter, no INS ref: the organiser thinks in names, and the
         bookkeeping ids live in the Sheet when they are ever needed. */
      var meta = [];
      /* The team name is the row; the players become its detail line. */
      var teamLabel = (typeof t.name === 'string' && t.name.trim()) ? t.name.trim() : '';
      if (has && teamLabel) meta.push(pairFull(t.players));
      else if (t.club) meta.push(t.club);
      if (!has) meta.push('nog geen inschrijving');
      var name = has ? (teamLabel || pairFull(t.players)) : (t.label || OPEN);
      return '<div class="ad-item"><div class="ad-r"><label class="ad-t">' +
        '<span class="ad-t__b"><span class="ad-t__n' + (has ? '' : ' is-open') + '">' +
        esc(name) + '</span>' +
        '<span class="ad-t__m">' + esc(meta.join(' · ')) + '</span></span>' +
        '<input type="checkbox" class="ad-t__i u-sr-only" data-act="paid" data-key="' + esc(p.key) + '"' +
        (p.paid ? ' checked' : '') + (has ? '' : ' disabled') +
        ' aria-label="Betaald: ' + esc(name) + '">' +
        '<span class="ad-check" aria-hidden="true"></span>' +
        '</label>' +
        /* Only a registration is ours to delete; t01–t16 are pre-entered. */
        (p.ref ? delBtn('team', p.ref, 'Inschrijving ' + name + ' verwijderen') : '') +
        '</div>' + (p.ref && S.ask === p.ref ? askHtml('team', p.ref) : '') + '</div>';
    }).join('');

    var free = S.teams.filter(function (t) { return !(t.players || []).length; }).length;
    var form = S.form && S.form.kind === 'team';
    var add = form
      ? '<div class="ad-item ad-item--add"><div class="glass glass--inset ad-form">' +
        fieldHtml('tn', 'Teamnaam', 'teamName', S.form.teamName, 'text', 40) +
        fieldHtml('p1', 'Speler 1', 'player1', S.form.player1, 'text', 60) +
        fieldHtml('p2', 'Speler 2', 'player2', S.form.player2, 'text', 60) +
        fieldHtml('em', 'E-mail', 'email', S.form.email, 'email', 160) +
        fieldHtml('tel', 'Gsm', 'phone', S.form.phone, 'tel', 40) +
        checkHtml('paid', S.form.paid, 'Betaald (' + euro(S.teamPrice) + ')') +
        formActs(S.form.err) + '</div></div>'
      : (free ? addBtnHtml('team', 'Team toevoegen') : '');

    el.innerHTML = '<div class="ad-head"><span class="ad-tot"><span class="ad-tot__x u-tabular">' +
      paid + '/' + S.teams.length + '</span> betaald · <span class="u-tabular">' +
      euro(paid * S.teamPrice) + '</span></span>' +
      '<span class="ad-hint">' + euro(S.teamPrice) + ' per team.</span></div>' +
      '<div class="ad-list">' + rows + add + '</div>';
  }

  function setTeamPaid(key, paid) {
    var reg = S.registrations.filter(function (r) { return r.ref === key; })[0];
    if (reg) reg.paid = paid; else S.teamPaid[key] = paid;
    renderTeams();
    keepFocus('[data-act="paid"][data-key="' + key + '"]');
    write('setTeamPaid', { key: key, paid: paid }, function () {
      if (reg) reg.paid = !paid; else S.teamPaid[key] = !paid;
      renderTeams();
    }, paid ? 'Betaald' : 'Niet betaald');
  }

  /* A re-render replaces the control that was just used, so hand focus back —
     otherwise a keyboard user loses their place on every tick. */
  function keepFocus(sel) {
    var el = document.querySelector(sel);
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }

  /* ============================== RENDER: orders ========================= */

  function renderOrders() {
    var el = panel('orders');
    if (!el) return;
    var tickets = 0, paid = 0;
    S.orders.forEach(function (o) {
      tickets += (+o.quantity || 0);
      paid += Math.max(0, Math.min(+o.quantity || 0, +o.paidCount || 0));
    });

    var rows = S.orders.map(function (o) {
      var q = +o.quantity || 0, pc = Math.max(0, Math.min(q, +o.paidCount || 0));
      var meta = [euro(q * TICKET_PRICE)];   /* the TKT ref stays in the Sheet */
      var d = shortDate(o.at);
      if (d) meta.push(d);
      return '<div class="ad-item"><div class="ad-r"><div class="ad-o">' +
        '<span class="ad-o__b"><span class="ad-o__n">' + esc(o.name || '\u2013') + '</span>' +
        '<span class="ad-o__m u-tabular">' + esc(meta.join(' · ')) + '</span></span>' +
        '<span class="ad-step" role="group" aria-label="Betaalde tickets: ' + esc(o.name || o.ref) + '">' +
        '<button type="button" class="ad-step__b" data-act="dec" data-ref="' + esc(o.ref) + '"' +
        (pc <= 0 ? ' disabled' : '') + ' aria-label="Eén ticket minder betaald">−</button>' +
        '<span class="ad-step__v u-tabular' + (pc === q && q ? ' is-full' : '') + '">' + pc + '/' + q + '</span>' +
        '<button type="button" class="ad-step__b" data-act="inc" data-ref="' + esc(o.ref) + '"' +
        (pc >= q ? ' disabled' : '') + ' aria-label="Eén ticket meer betaald">+</button>' +
        '</span></div>' +
        delBtn('order', o.ref, 'Bestelling ' + (o.name || o.ref) + ' verwijderen') +
        '</div>' + (S.ask === o.ref ? askHtml('order', o.ref) : '') + '</div>';
    }).join('');

    var form = S.form && S.form.kind === 'order';
    var add = form
      ? '<div class="ad-item ad-item--add"><div class="glass glass--inset ad-form">' +
        fieldHtml('nm', 'Naam', 'name', S.form.name, 'text', 60) +
        fieldHtml('oem', 'E-mail', 'email', S.form.email, 'email', 160) +
        '<div class="ad-fgrid">' +
        fieldHtml('qty', 'Aantal (1–' + MAX_QTY + ')', 'quantity', S.form.quantity, 'text', 1,
          ' inputmode="numeric" pattern="[0-9]*"') +
        fieldHtml('pc', 'Betaald', 'paidCount', S.form.paidCount, 'text', 1,
          ' inputmode="numeric" pattern="[0-9]*"') +
        '</div>' + formActs(S.form.err) + '</div></div>'
      : addBtnHtml('order', 'Bestelling toevoegen');

    el.innerHTML = '<div class="ad-head"><span class="ad-tot"><span class="ad-tot__x u-tabular">' +
      paid + ' van ' + tickets + '</span> tickets betaald · <span class="u-tabular">' +
      euro(paid * TICKET_PRICE) + '</span></span>' +
      '<span class="ad-hint">' + euro(TICKET_PRICE) + ' per ticket.</span></div>' +
      '<div class="ad-list">' +
      (rows || '<p class="ad-empty">Nog geen ticketbestellingen.</p>') + add + '</div>';
  }

  function stepOrder(ref, delta) {
    var o = S.orders.filter(function (x) { return x.ref === ref; })[0];
    if (!o) return;
    var q = +o.quantity || 0;
    var prev = Math.max(0, Math.min(q, +o.paidCount || 0));
    var next = Math.max(0, Math.min(q, prev + delta));
    if (next === prev) return;
    o.paidCount = next;
    renderOrders();
    var same = '[data-ref="' + ref + '"][data-act="' + (delta > 0 ? 'inc' : 'dec') + '"]';
    if (document.querySelector(same + ':not([disabled])')) keepFocus(same);
    else keepFocus('[data-ref="' + ref + '"]:not([disabled])');
    write('setOrderPaid', { ref: ref, paidCount: next }, function () {
      o.paidCount = prev;
      renderOrders();
    }, next + ' van ' + q + ' betaald');
  }

  /* ================================= views =============================== */

  function showLogin(msg) {
    view('login').hidden = false;
    view('app').hidden = true;
    E.topAct.hidden = true;
    E.loginError.textContent = msg || '';
    if (E.pw) { E.pw.value = ''; E.pw.focus(); }
  }

  function showApp() {
    view('login').hidden = true;
    view('app').hidden = false;
    E.topAct.hidden = false;
    setTab(S.tab);
  }

  function setTab(name) {
    if (S.tab !== name) window.scrollTo(0, 0);   /* a new tab starts at its top */
    S.tab = name;
    Array.prototype.forEach.call(document.querySelectorAll('.ad-tab'), function (t) {
      var on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
    ['matches', 'teams', 'orders'].forEach(function (n) {
      var p = panel(n);
      if (p) p.hidden = n !== name;
    });
  }

  function expire() {
    S.pw = '';
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* private mode */ }
    showLogin('Sessie verlopen. Meld je opnieuw aan.');
  }

  function apply(data) {
    S.ask = null;                /* the rows are being replaced under it */
    S.form = null;
    S.results = (data && data.results) || {};
    S.registrations = (data && data.registrations) || [];
    S.orders = (data && data.orders) || [];
    S.teamPaid = (data && data.teamPaid) || {};
    mergeTeams();
    renderMatches();
    renderTeams();
    renderOrders();
  }

  function pullOverview(then) {
    admin('overview').then(function (r) {
      if (r && r.ok) { apply(r); if (then) then(true); return; }
      if (r && r.error === 'unauthorized') { expire(); if (then) then(false); return; }
      toast('Geen verbinding met de server', 'bad');
      if (then) then(false);
    });
  }

  /* ================================ events =============================== */

  document.addEventListener('click', function (e) {
    var t = e.target;

    var tab = t.closest && t.closest('.ad-tab');
    if (tab) { setTab(tab.dataset.tab); return; }

    var act = t.closest && t.closest('[data-act]');
    if (!act) return;
    var a = act.dataset.act;

    if (a === 'logout') { S.pw = ''; try { sessionStorage.removeItem(SESSION_KEY); } catch (err) { } showLogin(''); return; }
    if (a === 'refresh') { pullOverview(function (ok) { if (ok) toast('Bijgewerkt', 'ok'); }); return; }
    if (a === 'save') { saveMatch(S.open); return; }
    if (a === 'clear') { clearMatch(S.open); return; }
    if (a === 'inc') { stepOrder(act.dataset.ref, 1); return; }
    if (a === 'dec') { stepOrder(act.dataset.ref, -1); return; }
    if (a === 'del-ask') { askDelete(act.dataset.kind, act.dataset.ref); return; }
    if (a === 'del-no') {
      S.ask = null;
      rerender(act.dataset.kind);
      keepFocus('.ad-x[data-ref="' + act.dataset.ref + '"]');
      return;
    }
    if (a === 'del-yes') {
      if (act.dataset.kind === 'team') delTeam(act.dataset.ref); else delOrder(act.dataset.ref);
      return;
    }
    if (a === 'add-open') { openForm(act.dataset.kind); return; }
    if (a === 'add-cancel') { closeForm(); return; }
    if (a === 'add-save') {
      if (S.form && S.form.kind === 'team') addTeam(); else if (S.form) addOrder();
      return;
    }
    if (a === 'win') {
      if (!S.draft) return;
      S.draft.winner = act.dataset.w;
      syncWin(act.closest('.ad-ed'));
      return;
    }
    if (a === 'paid') return;   /* handled on change */
  });

  /* The match row is a button; a click anywhere on it toggles its editor. */
  document.addEventListener('click', function (e) {
    var row = e.target.closest && e.target.closest('.ad-m');
    if (!row) return;
    if (S.open === row.dataset.m) closeMatch(true); else openMatch(row.dataset.m);
  });

  document.addEventListener('change', function (e) {
    var box = e.target;
    if (!box.dataset) return;
    if (box.dataset.f && S.form) {
      S.form[box.dataset.f] = box.type === 'checkbox' ? box.checked : box.value;
      return;
    }
    if (box.dataset.act !== 'paid') return;
    setTeamPaid(box.dataset.key, box.checked);
  });

  document.addEventListener('input', function (e) {
    var i = e.target;
    if (!i.dataset) return;

    /* An add form survives a re-render because what is typed lands in S.form. */
    if (i.dataset.f && S.form) {
      if (i.dataset.f === 'quantity' || i.dataset.f === 'paidCount') {
        var only = i.value.replace(/[^0-9]/g, '').slice(0, 1);
        if (only !== i.value) i.value = only;
      }
      S.form[i.dataset.f] = i.value;
      formError('');
      return;
    }

    if (i.dataset.set == null || !i.closest('.ad-ed')) return;
    var cleaned = i.value.replace(/[^0-9]/g, '').slice(0, 2);
    if (cleaned !== i.value) i.value = cleaned;
    var ed = i.closest('.ad-ed');
    readDraft(ed);
    syncWin(ed);
    var err = ed.querySelector('[data-el="edErr"]');
    if (err) err.textContent = '';
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && S.form) { closeForm(); return; }
    if (e.key === 'Escape' && S.ask) { S.ask = null; renderTeams(); renderOrders(); return; }
    if (e.key === 'Enter' && S.form && e.target.matches && e.target.matches('.ad-form input[data-f]')) {
      e.preventDefault();
      if (S.form.kind === 'team') addTeam(); else addOrder();
      return;
    }
    if (e.key === 'Escape' && S.open) { closeMatch(true); return; }
    if (e.key === 'Enter' && S.open && e.target.matches && e.target.matches('input[data-set]')) {
      e.preventDefault();
      saveMatch(S.open);
    }
  });

  E.loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var pw = E.pw.value;
    if (!pw) { E.loginError.textContent = 'Vul het wachtwoord in.'; return; }
    E.loginError.textContent = '';
    E.loginBtn.disabled = true;
    S.pw = pw;
    admin('login').then(function (r) {
      E.loginBtn.disabled = false;
      if (r && r.ok) {
        try { sessionStorage.setItem(SESSION_KEY, pw); } catch (err) { /* private mode */ }
        showApp();
        pullOverview();
        return;
      }
      S.pw = '';
      E.loginError.textContent = (r && r.error === 'unauthorized')
        ? 'Wachtwoord is niet juist.'
        : 'Geen verbinding met de server.';
      E.pw.focus();
    });
  });

  /* ================================== boot =============================== */

  function json(name) {
    return fetch(DATA + name + '.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  Promise.all([json('schedule'), json('teams'), json('courts'), json('event')]).then(function (d) {
    S.schedule = d[0] || S.schedule;
    S.teamsBase = d[1] || [];
    (d[2] || []).forEach(function (c) { S.courtName[c.id] = c.name || c.id; });
    if (d[3] && d[3].teamEntry && d[3].teamEntry.price) S.teamPrice = d[3].teamEntry.price;
    mergeTeams();

    if (S.demo) { S.pw = 'demo'; showApp(); apply(demoData()); return; }

    if (!window.CHAMP_CONFIG || !window.CHAMP_CONFIG.apiEndpoint) {
      E.loginNote.hidden = false;
      E.pw.disabled = true;
      E.loginBtn.disabled = true;
      showLogin('');
      return;
    }

    var saved = '';
    try { saved = sessionStorage.getItem(SESSION_KEY) || ''; } catch (e) { /* private mode */ }
    if (!saved) { showLogin(''); return; }
    S.pw = saved;
    showApp();
    pullOverview();
  });

  /* ------------------------------------------------------- screenshot fixture
     ?state=demo only. Never reachable from the UI, never posted anywhere. */

  /* Reads the schedule it has already loaded rather than listing match ids.
     A typed list went stale the moment the draw grew from 4 groups on 3 courts
     to 8 groups on 5 courts: every id past m24 changed meaning, and the fixture
     went on "working" while depicting a tournament that no longer existed.
     The story matches tools/fixtures/demo-full-state.json — every group match
     played, three quarter-finals in, the fourth still on court. */
  function demoData() {
    var SETS = [
      [[6, 3], [6, 4]], [[4, 6], [6, 2], [10, 8]], [[6, 1], [6, 4]],
      [[7, 5], [3, 6], [10, 6]], [[6, 2], [6, 2]], [[6, 4], [4, 6], [10, 7]],
      [[6, 0], [6, 3]], [[3, 6], [6, 4], [10, 5]], [[6, 4], [6, 4]],
      [[6, 3], [5, 7], [10, 8]], [[6, 2], [7, 5]], [[7, 6], [6, 4]]
    ];
    var ms = (S.schedule && S.schedule.matches) || [];
    var qfSeen = 0, results = {};
    ms.forEach(function (m, i) {
      if (m.round === 'group') {
        /* nothing */
      } else if (m.round === 'qf' && qfSeen < 3) {
        qfSeen++;
      } else {
        return;                      /* 4th QF on court, semis and finale to come */
      }
      var sets = SETS[i % SETS.length];
      results[m.id] = { sets: sets, winner: winnerIndex(sets) === 1 ? 'B' : 'A' };
    });

    /* Every other pre-entered team has paid, so the list opens with work in it.
       Derived from the teams actually in the draw — a typed id list outlived the
       slots it named. */
    var paid = {};
    (S.teams || []).filter(function (t) { return t.confirmed; })
      .forEach(function (t, i) { if (i % 2 === 0) paid[t.id] = true; });

    /* Against the FIRST unsold place, whichever that is. Pinning it to an id
       put a registration on a slot that had since been pre-entered. */
    var firstOpen = (S.teams || []).filter(function (t) {
      return !t.confirmed;
    })[0];

    return {
      results: results,
      teamPaid: paid,
      registrations: firstOpen ? [{
        ref: 'INS-01', teamId: firstOpen.id, player1: 'Anna Peeters', player2: 'Tom Claes',
        email: 'anna@example.be', phone: '0470 00 00 00', at: '2026-08-04T10:12:00Z', paid: false
      }] : [],
      orders: [
        { ref: 'TKT-01', name: 'Lien Vanhee', email: 'lien@example.be', quantity: 4, at: '2026-08-02T18:20:00Z', paidCount: 2 },
        { ref: 'TKT-02', name: 'Bram Dewulf', email: 'bram@example.be', quantity: 2, at: '2026-08-06T09:05:00Z', paidCount: 0 },
        { ref: 'TKT-03', name: 'Sofie Vermeersch', email: 'sofie@example.be', quantity: 1, at: '2026-08-11T20:41:00Z', paidCount: 1 }
      ]
    };
  }
})();
