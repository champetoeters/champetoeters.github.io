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
  var KO = {
    QF1A: 'Winnaar Groep A', QF1B: 'Tweede Groep B',
    QF2A: 'Winnaar Groep B', QF2B: 'Tweede Groep A',
    QF3A: 'Winnaar Groep C', QF3B: 'Tweede Groep D',
    QF4A: 'Winnaar Groep D', QF4B: 'Tweede Groep C',
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

  /* --------------------------------------------------------------- elements */

  var E = {};
  ['topAct', 'loginForm', 'pw', 'loginError', 'loginBtn', 'loginNote', 'toast'].forEach(function (k) {
    E[k] = document.querySelector('[data-el="' + k + '"]');
  });
  function view(name) { return document.querySelector('[data-view="' + name + '"]'); }
  function panel(name) { return document.querySelector('[data-panel="' + name + '"]'); }

  /* ------------------------------------------------------------------ state */

  var S = {
    demo: /(^|&)state=demo(&|$)/.test(location.search.slice(1)),
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
    tab: 'matches'
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

  function post(payload) {
    if (S.demo) return Promise.resolve({ ok: true });
    var live = window.ChampLive;
    if (!live || typeof live.post !== 'function') return Promise.resolve({ ok: false, error: 'server' });
    return live.post(payload).then(function (r) { return r || { ok: false, error: 'server' }; },
      function () { return { ok: false, error: 'server' }; });
  }

  function admin(op, extra) {
    var body = { action: 'admin', password: S.pw, op: op };
    if (extra) Object.keys(extra).forEach(function (k) { body[k] = extra[k]; });
    return post(body);
  }

  /* One write, one revert. The UI is already updated when this runs. */
  function write(op, extra, revert, okMsg) {
    admin(op, extra).then(function (r) {
      if (r && r.ok) { toast(okMsg || 'Bewaard', 'ok'); return; }
      revert();
      if (r && r.error === 'unauthorized') { expire(); return; }
      toast('Niet bewaard — probeer opnieuw', 'bad');
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
    if (t && (t.players || []).length) return { tid: tid, name: pairShort(t.players), full: pairFull(t.players) };
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
        return { teamId: r.teamId, players: [r.player1, r.player2].filter(Boolean) };
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
        (res ? esc(scoreText(res)) : '—') + '</span>' +
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

  /* ============================== RENDER: teams ========================== */

  function renderTeams() {
    var el = panel('teams');
    if (!el) return;
    var paid = 0;
    var rows = S.teams.map(function (t) {
      var p = payOf(t);
      var has = (t.players || []).length > 0;
      if (p.paid) paid++;
      var meta = ['Groep ' + (t.group || '?')];
      if (p.ref) meta.push(p.ref);
      if (t.club) meta.push(t.club);
      if (!has) meta.push('nog geen inschrijving');
      return '<div class="ad-item"><label class="ad-t">' +
        '<span class="ad-t__b"><span class="ad-t__n' + (has ? '' : ' is-open') + '">' +
        esc(has ? pairFull(t.players) : (t.label || OPEN)) + '</span>' +
        '<span class="ad-t__m">' + esc(meta.join(' · ')) + '</span></span>' +
        '<input type="checkbox" class="ad-t__i u-sr-only" data-act="paid" data-key="' + esc(p.key) + '"' +
        (p.paid ? ' checked' : '') + (has ? '' : ' disabled') +
        ' aria-label="Betaald — ' + esc(has ? pairFull(t.players) : (t.label || OPEN)) + '">' +
        '<span class="ad-check" aria-hidden="true"></span>' +
        '</label></div>';
    }).join('');

    el.innerHTML = '<div class="ad-head"><span class="ad-tot"><span class="ad-tot__x u-tabular">' +
      paid + '/' + S.teams.length + '</span> betaald · <span class="u-tabular">' +
      euro(paid * S.teamPrice) + '</span></span>' +
      '<span class="ad-hint">' + euro(S.teamPrice) + ' per team.</span></div>' +
      '<div class="ad-list">' + rows + '</div>';
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
      var meta = [o.ref, euro(q * TICKET_PRICE)];
      var d = shortDate(o.at);
      if (d) meta.push(d);
      return '<div class="ad-item"><div class="ad-o">' +
        '<span class="ad-o__b"><span class="ad-o__n">' + esc(o.name || '—') + '</span>' +
        '<span class="ad-o__m u-tabular">' + esc(meta.join(' · ')) + '</span></span>' +
        '<span class="ad-step" role="group" aria-label="Betaalde tickets — ' + esc(o.name || o.ref) + '">' +
        '<button type="button" class="ad-step__b" data-act="dec" data-ref="' + esc(o.ref) + '"' +
        (pc <= 0 ? ' disabled' : '') + ' aria-label="Eén ticket minder betaald">−</button>' +
        '<span class="ad-step__v u-tabular' + (pc === q && q ? ' is-full' : '') + '">' + pc + '/' + q + '</span>' +
        '<button type="button" class="ad-step__b" data-act="inc" data-ref="' + esc(o.ref) + '"' +
        (pc >= q ? ' disabled' : '') + ' aria-label="Eén ticket meer betaald">+</button>' +
        '</span></div></div>';
    }).join('');

    el.innerHTML = '<div class="ad-head"><span class="ad-tot"><span class="ad-tot__x u-tabular">' +
      paid + ' van ' + tickets + '</span> tickets betaald · <span class="u-tabular">' +
      euro(paid * TICKET_PRICE) + '</span></span>' +
      '<span class="ad-hint">' + euro(TICKET_PRICE) + ' per ticket.</span></div>' +
      '<div class="ad-list">' + (rows || '<p class="ad-empty">Nog geen ticketbestellingen.</p>') + '</div>';
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
    showLogin('Sessie verlopen — meld je opnieuw aan.');
  }

  function apply(data) {
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
    if (!box.dataset || box.dataset.act !== 'paid') return;
    setTeamPaid(box.dataset.key, box.checked);
  });

  document.addEventListener('input', function (e) {
    var i = e.target;
    if (!i.dataset || i.dataset.set == null || !i.closest('.ad-ed')) return;
    var cleaned = i.value.replace(/[^0-9]/g, '').slice(0, 2);
    if (cleaned !== i.value) i.value = cleaned;
    var ed = i.closest('.ad-ed');
    readDraft(ed);
    syncWin(ed);
    var err = ed.querySelector('[data-el="edErr"]');
    if (err) err.textContent = '';
  });

  document.addEventListener('keydown', function (e) {
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

  function demoData() {
    var scores = [
      'm01 6-3 6-4', 'm02 4-6 6-2 10-8', 'm03 6-1 6-4', 'm04 7-5 3-6 10-6',
      'm05 6-2 6-2', 'm06 6-4 4-6 10-7', 'm07 6-0 6-3', 'm08 3-6 6-4 10-5',
      'm09 6-4 6-4', 'm10 6-3 5-7 10-8', 'm11 6-2 7-5', 'm12 6-4 6-1',
      'm13 4-6 6-3 10-4', 'm14 6-2 6-3', 'm15 6-4 6-2', 'm16 7-6 6-4',
      'm17 6-1 6-2', 'm18 4-6 6-4 10-6', 'm19 6-3 6-3', 'm20 6-2 4-6 10-3',
      'm21 6-4 7-5', 'm22 6-3 6-2', 'm23 5-7 6-3 10-7', 'm24 6-2 6-4',
      'm25 6-4 3-6 10-8', 'm26 6-2 6-3', 'm27 7-5 6-4'
    ];
    var results = {};
    scores.forEach(function (line) {
      var p = line.split(' ');
      var sets = p.slice(1).map(function (s) {
        var g = s.split('-');
        return [+g[0], +g[1]];
      });
      var wi = winnerIndex(sets);
      results[p[0]] = { sets: sets, winner: wi === 1 ? 'B' : 'A' };
    });

    var paid = {};
    ['t01', 't02', 't03', 't05', 't06', 't08', 't09', 't11', 't13'].forEach(function (k) { paid[k] = true; });

    return {
      results: results,
      teamPaid: paid,
      registrations: [{
        ref: 'INS-01', teamId: 't15', player1: 'Anna Peeters', player2: 'Tom Claes',
        email: 'anna@example.be', phone: '0470 00 00 00', at: '2026-08-04T10:12:00Z', paid: false
      }],
      orders: [
        { ref: 'TKT-01', name: 'Lien Vanhee', email: 'lien@example.be', quantity: 4, at: '2026-08-02T18:20:00Z', paidCount: 2 },
        { ref: 'TKT-02', name: 'Bram Dewulf', email: 'bram@example.be', quantity: 2, at: '2026-08-06T09:05:00Z', paidCount: 0 },
        { ref: 'TKT-03', name: 'Sofie Vermeersch', email: 'sofie@example.be', quantity: 1, at: '2026-08-11T20:41:00Z', paidCount: 1 }
      ]
    };
  }
})();
