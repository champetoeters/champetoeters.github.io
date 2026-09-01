/* ============================================================================
   timetable.js — CHAMPETOETERS & FRIENDS

   One job (BRIEF §0): let someone find out WHEN and WHERE they play. A row is
   time · baan · type · names and nothing else; the sheet is padel only,
   12:30 → 19:00, broken by nothing but the four phase headings. Exactly one
   control exists, and only on mobile: the court switcher, because five columns
   do not fit 390px.

   All visible copy is Dutch and is written here or in the fragment. The data
   is read-only to this section, so anything English in it is translated on the
   way out rather than re-saved.

   The live layer (final round) adds nothing to operate: a played match prints
   its set scores, the winning pair stays lit and the losing pair steps back,
   and a knockout placeholder turns into two real names the moment the bracket
   can resolve it. It is content, not chrome — no badges, no new panels.

   It also keeps itself current: once a minute the clock is re-read and, when
   an apiEndpoint is configured, the state is re-pulled and the overlay
   re-applied — so a score entered at the court appears here without anyone
   reloading. The tick does nothing while the tab is hidden.

   That whole live layer hangs off ONE switch: CHAMP_CONFIG.showDraw. While it
   is false the sheet renders exactly as teams.json has it — every seat "Vrije
   plaats", no scores, no resolved knock-out names, no backend traffic — so the
   poules can stay private until the organisers publish them.

   Owns: sections/timetable.html, css/timetable.css, js/timetable.js
   Consumes: window.Courts3D, window.ChampBracket, window.ChampLive — every one
   optional and every call guarded, so the sheet renders identically if the
   live layer is absent or the network is down.
   ========================================================================= */
window.Sections = window.Sections || {};

(function () {
  'use strict';

  /* ---------------------------------------------------------------- utils */

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }

  function toMin(t) { var p = String(t).split(':'); return (+p[0]) * 60 + (+p[1] || 0); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* Flemish surnames: keep the tussenvoegsel ("Van Acker", "De Smet"). */
  var PARTICLES = { van: 1, de: 1, den: 1, der: 1, vanden: 1, vander: 1, ter: 1, ten: 1, het: 1, "'t": 1, op: 1 };
  function surname(full) {
    var parts = String(full || '').trim().split(/\s+/);
    if (parts.length < 2) return parts[0] || '';
    for (var i = 1; i < parts.length - 1; i++) {
      if (PARTICLES[parts[i].toLowerCase()]) return parts.slice(i).join(' ');
    }
    return parts[parts.length - 1];
  }

  /* courts.json is Dutch ("Baan 1"). Printed as-is — never re-translated. */
  function courtLabel(c) { return (c && (c.name || c.id)) || ''; }

  /* An unsold place in the draw. teams.json carries the Dutch label. */
  var OPEN = 'Vrije plaats';

  /* …and what a seat reads while the draw is still private (showDraw false).
     Not "Vrije plaats": nothing is for sale there yet, the pairing simply is
     not decided. Every seat on the sheet reads this until the draw is
     published. */
  var SOON = 'Nog te bepalen';

  /* Knockout ids never resolve to a team. Spelled out so a placeholder reads as
     a real, understandable entry rather than a code. */
  /* Must agree with GROUP_SLOT in bracket.js — vier herenpoules, and every
     team goes through: de beste twee naar de GROTE finales (QF…), de laatste
     twee naar de KLEINE finales (LQF…). A seat named here that the bracket
     never fills would sit unresolved all evening; tools/bracket.test.mjs
     checks the two agree. */
  var KO = {
    QF1A:  'Winnaar Poule 1',  QF1B:  'Tweede Poule 4',
    QF2A:  'Winnaar Poule 2',  QF2B:  'Tweede Poule 3',
    QF3A:  'Winnaar Poule 4',  QF3B:  'Tweede Poule 1',
    QF4A:  'Winnaar Poule 3',  QF4B:  'Tweede Poule 2',
    LQF1A: 'Derde Poule 1',    LQF1B: 'Vierde Poule 4',
    LQF2A: 'Derde Poule 2',    LQF2B: 'Vierde Poule 3',
    LQF3A: 'Derde Poule 4',    LQF3B: 'Vierde Poule 1',
    LQF4A: 'Derde Poule 3',    LQF4B: 'Vierde Poule 2',
    SF1A:  'Winnaar kwartfinale 1', SF1B: 'Winnaar kwartfinale 2',
    SF2A:  'Winnaar kwartfinale 3', SF2B: 'Winnaar kwartfinale 4',
    LSF1A: 'Winnaar kleine kwartfinale 1', LSF1B: 'Winnaar kleine kwartfinale 2',
    LSF2A: 'Winnaar kleine kwartfinale 3', LSF2B: 'Winnaar kleine kwartfinale 4',
    FA:  'Winnaar halve finale 1',        FB:  'Winnaar halve finale 2',
    LFA: 'Winnaar kleine halve finale 1', LFB: 'Winnaar kleine halve finale 2'
  };

  /* One heading per phase, keyed on a RANK per round — NOT on m.roundLabel,
     and not on "the round changed" either. The afternoon interleaves: the
     dames play their slotronde on the freed banen while the heren knock-out
     runs next to it, and the kleine kwartfinale 4 still plays at 17:00 while
     the halve finales start. So a heading marks where a phase BEGINS — the
     first slot whose deepest match reaches a new rank — and the rows simply
     run on under it; the kind label on every match says what each row is. */
  var PHASE_RANK = { group: 0, qf: 1, lqf: 1, sf: 2, lsf: 2, final: 3, lfinal: 3 };
  var PHASE_NAME = ['Poules', 'Kwartfinales', 'Halve finales', 'Finales'];
  function phaseRank(m) {
    var r = PHASE_RANK[m.round];
    return r == null ? -1 : r;
  }
  /* An unknown phase prints nothing and the run of times simply continues. */
  function phaseName(m) { return PHASE_NAME[phaseRank(m)] || ''; }

  /* ------------------------------------------------------------ 3D bridge */

  function call(name) {
    var a = window.Courts3D;
    if (!a || typeof a[name] !== 'function') return;
    try { return a[name].apply(a, Array.prototype.slice.call(arguments, 1)); }
    catch (e) { /* the schedule never depends on the 3D succeeding */ }
  }
  /* The shipped stub is `mount(){}` (arity 0); a real build takes (canvas, opts). */
  function has3D() {
    var a = window.Courts3D;
    return !!(a && typeof a.mount === 'function' && a.mount.length >= 1);
  }

  /* ---------------------------------------------------------- live bridge
     window.ChampLive / window.ChampBracket are optional: index.html loads
     them, and a static build with no backend simply has no results to show.
     Nothing here may throw or block when they are missing. */

  /* Event-clock minutes. ChampLive owns the precedence (?now= → real clock on
     5/6 sept 2026); the branch below only exists for a page that does not load
     livedata.js, and keeps that precedence identical. */
  function liveNow(sched) {
    var L = window.ChampLive;
    if (L && typeof L.nowMinutes === 'function') {
      try { return L.nowMinutes(); } catch (e) { /* fall through */ }
    }
    var q = null;
    try { q = new URLSearchParams(location.search).get('now'); } catch (e) { /* */ }
    if (q && /^\d{1,2}:\d{2}$/.test(q)) return toMin(q);
    var d = new Date();
    var iso = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    if (sched && iso === sched.date) return d.getHours() * 60 + d.getMinutes();
    return null;
  }

  /* A result is printed only when it is well formed: 1–3 sets of two integer
     game counts. Anything else is ignored rather than shown half-parsed.
     `win` is the side index (0 = the team listed first), derived from the sets
     when the backend did not say. */
  function readResult(r) {
    if (!r || !r.sets || !r.sets.length) return null;
    var sets = [], i, s, a, b;
    for (i = 0; i < r.sets.length && sets.length < 3; i++) {
      s = r.sets[i];
      if (!s || s.length < 2) continue;
      a = +s[0]; b = +s[1];
      if (!isFinite(a) || !isFinite(b) || a < 0 || b < 0 || a > 99 || b > 99) continue;
      sets.push([Math.round(a), Math.round(b)]);
    }
    if (!sets.length) return null;
    var win = r.winner === 'A' ? 0 : r.winner === 'B' ? 1 : null;
    if (win === null) {
      var d = 0;
      sets.forEach(function (x) { d += x[0] > x[1] ? 1 : x[0] < x[1] ? -1 : 0; });
      win = d === 0 ? null : (d > 0 ? 0 : 1);
    }
    return {
      win: win,
      /* En space between sets: a normal word space is too narrow to separate
         "6-3" from "6-4" once the figures are tabular. */
      text: sets.map(function (x) { return x[0] + '-' + x[1]; }).join('\u2002'),
      spoken: sets.map(function (x) { return x[0] + '-' + x[1]; }).join(', ')
    };
  }

  function dataUrl(file) {
    var s = document.querySelector('script[src*="timetable.js"]');
    try { if (s && s.src) return new URL('../data/' + file, s.src).href; } catch (e) { /* */ }
    return 'data/' + file;
  }

  /* ------------------------------------------------------------ site plan
     Flat plan drawn from venue.json — sits behind the canvas and keeps the
     hover feedback meaningful if the 3D never arrives. */

  /* The plan is drawn in venue metres, y flipped so north is up, and the
     viewBox is the site's own extent — which the two indoor courts stretched
     from ~50 m across to ~170 m. It still fits, because the panel scales it, but
     the hall outline has to be in it: without the shell the pair reads as two
     courts adrift in the corner, and the whole point of the plan is that it says
     where things are. The `pad` is what keeps the 20 m courts from touching the
     edge; it is in metres, like everything else here. */
  function buildPlan(venue, names) {
    if (!venue || !venue.courts) return '';
    var pts = [], shapes = [];
    venue.courts.forEach(function (c) {
      var cx = c.center[0], cy = c.center[1], L = c.length / 2, W = c.width / 2;
      var s = Math.sin(c.yaw), co = Math.cos(c.yaw), corner = [];
      [[-L, -W], [L, -W], [L, W], [-L, W]].forEach(function (d) {
        var x = cx + d[0] * co - d[1] * s, y = cy + d[0] * s + d[1] * co;
        corner.push([x, -y]); pts.push([x, -y]);
      });
      /* The number the CLUB uses, not the venue index. venue.json is numbered as
         OSM found the courts and the club renumbered them — court-1 is Baan 2 —
         so printing i+1 put a "1" on the court this very table calls Baan 2.
         Falls back to the index only if no display name was passed. */
      var nm = names && names[c.id];
      var dig = nm && /(\d+)/.exec(nm);
      shapes.push({
        id: c.id, corner: corner, c: [cx, -cy], num: dig ? dig[1] : null,
        net: [[cx + W * s, -(cy - W * co)], [cx - W * s, -(cy + W * co)]]
      });
    });

    var halls = ((venue.halls) || []).filter(function (h) {
      return h && h.points && h.points.length > 2;
    }).map(function (h) {
      return h.points.map(function (p) {
        pts.push([p[0], -p[1]]);
        return p[0].toFixed(2) + ',' + (-p[1]).toFixed(2);
      }).join(' ');
    });

    var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
    var pad = 6;
    var x0 = Math.min.apply(null, xs) - pad, x1 = Math.max.apply(null, xs) + pad;
    var y0 = Math.min.apply(null, ys) - pad, y1 = Math.max.apply(null, ys) + pad;

    /* Behind the courts, so a hover highlight always wins over the shell. */
    var hg = halls.map(function (poly) {
      return '<polygon class="pl-hall" points="' + poly + '"/>';
    }).join('');

    var g = shapes.map(function (s, i) {
      var poly = s.corner.map(function (p) { return p[0].toFixed(2) + ',' + p[1].toFixed(2); }).join(' ');
      return '<g class="pl-court" data-court="' + esc(s.id) + '">' +
        '<polygon class="pl-face" points="' + poly + '"/>' +
        '<line class="pl-net" x1="' + s.net[0][0].toFixed(2) + '" y1="' + s.net[0][1].toFixed(2) +
        '" x2="' + s.net[1][0].toFixed(2) + '" y2="' + s.net[1][1].toFixed(2) + '"/>' +
        '<text class="pl-num" x="' + s.c[0].toFixed(2) + '" y="' + s.c[1].toFixed(2) + '">' +
        esc(s.num || (i + 1)) + '</text>' +
        '</g>';
    }).join('');

    return '<svg class="pl" viewBox="' + x0.toFixed(2) + ' ' + y0.toFixed(2) + ' ' +
      (x1 - x0).toFixed(2) + ' ' + (y1 - y0).toFixed(2) +
      '" preserveAspectRatio="xMidYMid meet" role="img" aria-hidden="true" focusable="false">' +
      hg + g + '</svg>';
  }

  /* ===================================================================== */

  function init(root, data) {
    if (!root || !data) return;
    if (root.dataset.ttReady === '1') return;   /* one sheet, one timer */

    var courts = data.courts || [];
    var sched = data.schedule || { slots: [], matches: [] };
    var slots = sched.slots || [];
    var matches = sched.matches || [];
    var byId = {}, courtName = {};
    matches.forEach(function (m) { byId[m.id] = m; });
    courts.forEach(function (c) { courtName[c.id] = courtLabel(c); });

    /* ---- live state ------------------------------------------------------
       `teams` is the draw as it stands: teams.json, with any registration
       that filled an open slot merged in. `results` and `koSlot` come from
       the backend overlay and are empty until (and unless) it resolves.    */
    var teams = {}, results = {}, koSlot = {}, byMatch = {};
    function indexTeams(list) {
      teams = {};
      (list || []).forEach(function (t) { if (t && t.id) teams[t.id] = t; });
    }
    indexTeams(data.teams);

    /* ---- when is "now"? -------------------------------------------------
       ?now=HH:MM is a screenshot hook only and nothing in the UI advertises
       it (BRIEF §0 rule 8). On the day itself the real clock drives this. */
    var now = clockNow();     /* re-read once a minute — see `update` below */

    /* ---- refs ----------------------------------------------------------- */
    var $ = function (s) { return root.querySelector(s); };
    var elThead = $('[data-tt-thead]'), elTbody = $('[data-tt-tbody]');
    var elSwitch = $('[data-tt-switch]'), elVenue = $('[data-tt-venue]');
    var elWrap = $('.tt-gridwrap');
    var elPlan = $('[data-tt-plan]'), elCanvas = $('[data-tt-canvas]');
    if (!elTbody) return;

    /* ---- the one control: mobile court switcher --------------------------
       Six segments across 390px, so the visible label is the short form from
       courts.json ("B1") and the full name goes in aria-label — a screen reader
       hears "Baan 1", never "B1". Falls back to the full name if a court has no
       `short`, which then simply wraps rather than disappearing. */
    elSwitch.innerHTML =
      '<button type="button" class="tt-seg" data-v="all" aria-pressed="true"' +
      ' aria-label="Alle banen">Alle</button>' +
      courts.map(function (c) {
        var full = courtName[c.id];
        return '<button type="button" class="tt-seg" data-v="' + esc(c.id) + '"' +
          ' aria-pressed="false" aria-label="' + esc(full) + '">' +
          esc(c.short || full) + '</button>';
      }).join('');

    /* ---- table head: the court name, nothing else ------------------------ */
    elThead.innerHTML = '<tr role="row" class="tt-hrow">' +
      '<th role="columnheader" scope="col" class="tt-hcell tt-hcell--time"><span class="u-sr-only">Tijd</span></th>' +
      courts.map(function (c) {
        return '<th role="columnheader" scope="col" class="tt-hcell" data-court="' + esc(c.id) + '">' +
          esc(courtName[c.id]) + '</th>';
      }).join('') + '</tr>';

    /* ---- rows ------------------------------------------------------------ */

    /* A knockout entry is a placeholder until the bracket can name it. Once
       the group (or the previous round) is finished, ChampBracket hands back a
       real team id and the row simply reads two names instead. */
    function sideIds(m) {
      var bm = byMatch[m.id], out = [], i, id;
      for (i = 0; i < 2; i++) {
        id = m.teams[i];
        out.push((bm && bm.resolvedTeams && bm.resolvedTeams[i]) || koSlot[id] || id);
      }
      return out;
    }

    function side(id) {
      var t = teams[id];
      if (t) {
        var players = (t.players || []).filter(Boolean);
        /* An unsold place must read as available: printed plainly, never
           hidden, never blank, never "TBD". A registration that filled the
           slot arrives with its two players and reads like any other team.
           Before the draw is public there is nothing to be available for, so
           the same seat reads "Nog te bepalen" instead. */
        if (!players.length) {
          return showDraw()
            ? { open: true, name: t.label || OPEN, full: 'een vrije plaats' }
            : { open: true, name: SOON, full: 'nog te bepalen' };
        }
        /* Teams enter under a team name; the players stay in the aria text so
           a listener still hears who is on court. Data without a name (never
           the case in production) falls back to the surname pair. */
        var label = (typeof t.name === 'string' && t.name.trim())
          ? t.name.trim()
          : players.map(surname).join(' & ');
        return { open: false, name: label, full: label + ' (' + players.join(' en ') + ')' };
      }
      var k = KO[id] || String(id);
      return { open: false, tbd: true, name: k, full: k };
    }

    function stateOf(m) {
      if (now == null) return '';
      var s = toMin(m.start), e = toMin(m.end);
      if (now >= s && now < e) return 'is-live';
      if (now >= e) return 'is-done';
      return '';
    }

    function matchHtml(m, r, c) {
      var ids = sideIds(m);
      var A = side(ids[0]), B = side(ids[1]);
      var res = readResult(results[m.id]);
      /* A score outranks the clock: an entered result means played, whatever
         the time says.

         The clock alone is not enough for anything else. A halve finale whose
         seats still read "Winnaar kwartfinale 4" cannot be in play, and a
         "Vrije plaats" never plays at all — at 19:15 the clock happily marked
         both NU BEZIG. So a clock state is only trusted once both seats are
         two real pairs; until then the row is simply a row. */
      var playable = !A.open && !A.tbd && !B.open && !B.tbd;
      var stcls = res ? 'is-done' : playable ? stateOf(m) : '';

      /* The client asked for the type of every match to be visible on the match
         itself, not only in the phase heading it sits under — a poule row and a
         knock-out row look identical otherwise. roundLabel already carries it
         ("Poule 1", "Poule dames", "Kwartfinale", "Kleine finale", …). */
      var kind = m.roundLabel || phaseName(m);

      var aria = m.start + ', ' + (courtName[m.court] || m.court) + '. ' +
        (kind ? kind + '. ' : '') +
        A.full + ' tegen ' + B.full +
        (res
          ? '. Uitslag ' + res.spoken +
            (res.win === null ? '.' : '. Gewonnen door ' + (res.win ? B : A).full + '.')
          : stcls === 'is-live' ? '. Nu bezig.' : stcls === 'is-done' ? '. Gespeeld.' : '.');

      function nm(s, i) {
        var cls = s.open ? ' is-open' : s.tbd ? ' is-tbd' : '';
        if (res && res.win !== null) cls += res.win === i ? ' is-win' : ' is-lost';
        return '<span class="tt-m__n' + cls + '">' + esc(s.name) + '</span>';
      }

      return '<button type="button" class="tt-m' + (stcls ? ' ' + stcls : '') +
        (res ? ' has-score' : '') +
        '" data-m="' + esc(m.id) + '" data-court="' + esc(m.court) + '" data-r="' + r + '" data-c="' + c +
        '" aria-label="' + esc(aria) + '">' +
        '<span class="tt-m__court">' + esc(courtName[m.court] || m.court) + '</span>' +
        (kind ? '<span class="tt-m__kind">' + esc(kind) + '</span>' : '') +
        '<span class="tt-m__tie">' + nm(A, 0) +
        '<span class="tt-m__b"><span class="tt-m__v" aria-hidden="true">vs</span>' +
        nm(B, 1) + '</span>' +
        (res ? '<span class="tt-m__score u-tabular" aria-hidden="true">' + esc(res.text) + '</span>' : '') +
        /* Inside the tie, so it lands on its own line under the names at both
           viewports instead of competing with them for the row. */
        (stcls === 'is-live'
          ? '<span class="tt-m__live"><span class="tt-m__live-dot" aria-hidden="true"></span>Nu bezig</span>'
          : '') +
        '</span>' +
        '</button>';
    }

    function headingHtml(kind, text) {
      return '<tr class="tt-headrow" role="row"><td role="cell" colspan="' + (courts.length + 1) +
        '" class="tt-heading tt-heading--' + kind + '">' + esc(text) + '</td></tr>';
    }

    /* ---- indexes --------------------------------------------------------- */
    var heads = Array.prototype.slice.call(elThead.querySelectorAll('.tt-hcell[data-court]'));
    var buttons = [], rows = [], grid = [];

    /* Rendered twice at most: once synchronously from the static data, once
       more if the live overlay resolves. Every listener is delegated to
       elTbody / elThead, so nothing has to be rebound. */
    function renderRows() {
      var html = [], r = -1, rank = -1;

      /* Padel only: the only rows that are not a match are the four headings. */
      slots.forEach(function (t) {
        var inSlot = matches.filter(function (m) { return m.start === t; });
        if (!inSlot.length) return;

        /* one heading per phase, at the slot the phase begins — the DEEPEST
           round in the slot decides, so the dames-poulematch next to the
           first kwartfinale never drags the sheet back to "Poules" */
        var top = -1;
        inSlot.forEach(function (m) { var k = phaseRank(m); if (k > top) top = k; });
        if (top > rank) {
          rank = top;
          if (PHASE_NAME[rank]) {
            html.push(headingHtml(rank === 3 ? 'final' : 'phase', PHASE_NAME[rank]));
          }
        }

        r++;
        var cells = courts.map(function (c, ci) {
          var m = inSlot.filter(function (x) { return x.court === c.id; })[0];
          return '<td role="cell" class="tt-cell" data-court="' + esc(c.id) + '">' +
            (m ? matchHtml(m, r, ci) : '') + '</td>';
        }).join('');

        html.push('<tr class="tt-row" role="row" data-slot="' + esc(t) + '" data-r="' + r + '">' +
          '<th role="rowheader" scope="row" class="tt-time u-tabular">' + esc(t) + '</th>' +
          cells + '</tr>');
      });

      elTbody.innerHTML = html.join('');

      buttons = Array.prototype.slice.call(elTbody.querySelectorAll('.tt-m'));
      rows = Array.prototype.slice.call(elTbody.querySelectorAll('.tt-row'));
      grid = [];
      buttons.forEach(function (b) {
        var rr = +b.dataset.r, cc = +b.dataset.c;
        (grid[rr] = grid[rr] || [])[cc] = b;
      });
    }

    /* ---- 3D + plan ------------------------------------------------------- */
    var planNode = null;

    function matchInfo(id) {
      var m = byId[id]; if (!m) return null;
      /* Resolved ids, so the plate over a knockout court names the same two
         pairs the row does. */
      var ids = sideIds(m);
      var A = side(ids[0]), B = side(ids[1]);
      return {
        id: m.id, court: m.court, start: m.start, end: m.end,
        round: m.round, roundLabel: m.roundLabel,
        teams: [{ name: A.name }, { name: B.name }],
        title: A.name + ' tegen ' + B.name
      };
    }

    /* `quiet` = drive the 3D but paint no highlight in the schedule. The idle
       state must not look like something is selected — a green column header
       that nobody caused is a question the visitor has to stop and answer. */
    function setActive(courtId, matchId, quiet) {
      call('setActiveCourt', courtId || null);
      /* An active court always gets a tie: the engine's own matchless state
         prints a placeholder that reads as broken. */
      var info = matchId ? matchInfo(matchId) : null;
      if (info) call('setMatch', courtId, info);

      if (planNode) {
        Array.prototype.forEach.call(planNode.querySelectorAll('.pl-court'), function (g) {
          g.classList.toggle('is-active', !quiet && !!courtId && g.dataset.court === courtId);
        });
      }
      Array.prototype.forEach.call(elTbody.querySelectorAll('.tt-m.is-hot'), function (b) {
        b.classList.remove('is-hot');
      });
      if (matchId && !quiet) {
        var btn = elTbody.querySelector('.tt-m[data-m="' + matchId + '"]');
        if (btn) btn.classList.add('is-hot');
      }
      heads.forEach(function (h) {
        h.classList.toggle('is-hot', !quiet && h.dataset.court === courtId);
      });
    }

    /* Resting state: the wide shot of all five courts, nothing selected.
       Choosing one court on mobile is the exception — the switcher said "just
       this one", so the 3D frames it with whatever is on it now or next. */
    var shown = 'all';
    function defaultView() {
      if (shown === 'all') { setActive(null, null, true); return; }
      var mine = matches.filter(function (m) { return m.court === shown; });
      var target =
        (now != null && mine.filter(function (m) {
          return now >= toMin(m.start) && now < toMin(m.end);
        })[0]) ||
        (now != null && mine.filter(function (m) { return toMin(m.start) >= now; })[0]) ||
        mine.filter(function (m) { return m.round === 'final'; })[0] ||
        mine[0];
      setActive(shown, target && target.id, true);
    }

    elTbody.addEventListener('pointerover', function (e) {
      var b = e.target.closest('.tt-m'); if (!b) return;
      setActive(b.dataset.court, b.dataset.m);
    });
    elTbody.addEventListener('focusin', function (e) {
      var b = e.target.closest('.tt-m'); if (!b) return;
      /* the stop follows the focus, so leaving and re-entering the sheet
         returns to the row the visitor was last on */
      rover = b.dataset.m;
      buttons.forEach(function (x) { x.tabIndex = x === b ? 0 : -1; });
      setActive(b.dataset.court, b.dataset.m);
    });
    /* tap = the touch equivalent of hover; nothing else happens, nothing to learn */
    elTbody.addEventListener('click', function (e) {
      var b = e.target.closest('.tt-m'); if (!b) return;
      setActive(b.dataset.court, b.dataset.m);
    });
    elTbody.addEventListener('pointerleave', defaultView);

    elThead.addEventListener('pointerover', function (e) {
      var h = e.target.closest('.tt-hcell[data-court]'); if (!h) return;
      var cid = h.dataset.court;
      var m = (now != null && matches.filter(function (x) {
        return x.court === cid && now >= toMin(x.start) && now < toMin(x.end);
      })[0]) || matches.filter(function (x) { return x.court === cid && x.round === 'final'; })[0]
        || matches.filter(function (x) { return x.court === cid; })[0];
      setActive(cid, m && m.id);
    });
    elThead.addEventListener('pointerleave', defaultView);

    /* keyboard: arrow around the grid like a draw sheet */
    elTbody.addEventListener('keydown', function (e) {
      var b = e.target.closest('.tt-m'); if (!b) return;
      var dr = 0, dc = 0;
      if (e.key === 'ArrowRight') dc = 1;
      else if (e.key === 'ArrowLeft') dc = -1;
      else if (e.key === 'ArrowDown') dr = 1;
      else if (e.key === 'ArrowUp') dr = -1;
      else return;
      e.preventDefault();
      var rr = +b.dataset.r, cc = +b.dataset.c, max = courts.length - 1;
      for (var i = 0; i < 40; i++) {
        rr += dr; cc += dc;
        if (dc && (cc < 0 || cc > max)) return;
        if (rr < 0 || rr >= grid.length) return;
        var next = grid[rr] && grid[rr][cc];
        if (next && !next.classList.contains('is-off')) { next.focus(); return; }
        if (dc) return;
      }
    });

    /* ---- one tab stop for the whole sheet --------------------------------
       53 rows are 53 buttons, and the button only exists to light up the 3D —
       tabbing through all of them to reach the DJ bill is a poor trade. So the
       grid is one stop and the arrow keys move inside it, as a draw sheet
       should. `rover` survives a repaint because it is keyed on the match id. */
    var rover = null;

    function applyRoving() {
      var vis = buttons.filter(function (b) { return !b.classList.contains('is-off'); });
      if (!vis.length) { rover = null; return; }
      var at = vis.filter(function (b) { return b.dataset.m === rover; })[0] || vis[0];
      rover = at.dataset.m;
      buttons.forEach(function (b) { b.tabIndex = b === at ? 0 : -1; });
    }

    /* ---- court switcher (mobile only; desktop shows all five) ------------ */
    function applyCourt() {
      buttons.forEach(function (b) {
        var off = shown !== 'all' && b.dataset.court !== shown;
        b.classList.toggle('is-off', off);
        b.parentNode.classList.toggle('is-off', off);
        b.inert = off;
      });
      applyRoving();
      rows.forEach(function (row) {
        row.classList.toggle('is-empty', !row.querySelector('.tt-m:not(.is-off)'));
      });
      /* one court chosen = the court name on every row is now noise */
      if (elWrap) elWrap.classList.toggle('is-single', shown !== 'all');
      Array.prototype.forEach.call(elSwitch.querySelectorAll('.tt-seg'), function (s) {
        s.setAttribute('aria-pressed', String(s.dataset.v === shown));
      });
    }

    elSwitch.addEventListener('click', function (e) {
      var s = e.target.closest('.tt-seg'); if (!s) return;
      shown = s.dataset.v;
      applyCourt();
      defaultView();
    });

    /* ---- paint -----------------------------------------------------------
       A repaint rebuilds the rows, so it must not cost the visitor anything
       they had: the chosen court lives in `shown` and is re-applied, the tab
       stop in `rover`, and keyboard focus is put back on the row it was on.
       Focus is never taken — only returned to where it already was. */
    function paint() {
      var act = document.activeElement;
      var keep = (act && act.classList && act.classList.contains('tt-m') &&
                  elTbody.contains(act)) ? act.dataset.m : null;

      renderRows();
      applyCourt();
      defaultView();

      if (keep) {
        var back = elTbody.querySelector('.tt-m[data-m="' + keep + '"]');
        if (back && !back.classList.contains('is-off')) back.focus({ preventScroll: true });
      }
    }

    /* The static sheet first, always, synchronously. The overlay is a second
       pass: scores, resolved knockout names and registrations. If it never
       arrives — no backend, no demo state, offline — the sheet stands.

       `force` is the clock: the state can be byte-identical while the minute
       has moved a match from next to now. */
    var lastSig = null;

    function applyState(state, force) {
      state = state || {};
      /* Draw not published yet (CHAMP_CONFIG.showDraw === false): the sheet
         keeps its times, banen and poule-labels, but the overlay is dropped on
         the floor — no registrations merged into the seats, no scores, no
         resolved knock-out names. Everything reads "Vrije plaats", which is
         exactly what teams.json says on its own. */
      if (!showDraw()) return;
      var sig = null;
      try { sig = JSON.stringify([state.results || {}, state.teams || []]); } catch (e) { /* repaint */ }
      if (sig !== null && sig === lastSig && !force) return;
      lastSig = sig;

      var list = data.teams || [];
      var L = window.ChampLive;
      if (L && typeof L.mergedTeams === 'function') {
        try { list = L.mergedTeams(list, state) || list; } catch (e) { /* keep teams.json */ }
      }
      indexTeams(list);

      results = state.results || {};
      koSlot = {}; byMatch = {};
      var B = window.ChampBracket;
      if (B && typeof B.resolve === 'function') {
        try {
          var out = B.resolve(sched, list, results) || {};
          koSlot = out.slots || {};
          byMatch = out.byMatch || {};
        } catch (e) { /* placeholders stay placeholders */ }
      }
      paint();
    }

    /* ---- keeping up with the day ----------------------------------------
       The client asked for scores that appear on the site itself, so the sheet
       does not need reloading: once a minute it re-reads the clock and, when
       there is a backend, re-pulls the state and re-applies the whole overlay.
       Nothing here animates and nothing polls while the tab is in the
       background; coming back to the tab repaints at once. */
    /* One minute — the rate the published state can actually change at: the
       static read in livedata.js buckets its cache-buster on Math.floor(now /
       60000), so a faster tick would only re-read the same CDN copy. A score
       typed in /admin/ is on every phone within the minute.

       ⚠️ This is free ONLY while the GitHub state branch is being published
       (Script property GITHUB_TOKEN). Without it every tick falls back to
       `action=state` on Apps Script, which is billed runtime against the ~90
       min/day quota — at one tick per phone per minute a busy afternoon eats
       it. If that branch ever stops updating, put this back to 180000.

       The ±30% jitter keeps a crowd of phones from asking in the same second. */
    var TICK = 60000;
    var tick = null;

    function clockNow() {
      var n = liveNow(sched);
      if (n != null && slots.length) {
        var lo = toMin(slots[0]) - 60, hi = toMin(slots[slots.length - 1]) + 90;
        if (n < lo || n > hi) n = null;
      }
      return n;
    }

    function endpoint() {
      var c = window.CHAMP_CONFIG;
      return c ? String(c.apiEndpoint || '').trim() : '';
    }

    /* May the visitor see the draw? Default is HIDDEN: a page that somehow
       loads without config.js must not leak the poules by accident. */
    function showDraw() {
      var c = window.CHAMP_CONFIG;
      return !!(c && c.showDraw);
    }

    function update() {
      if (document.hidden) return;
      var next = clockNow();
      var moved = next !== now;
      now = next;

      /* Outside the event window there is nothing live to fetch — the one-shot
         pull at mount already filled the draw. Without this gate every open
         tab polled the backend once a minute, every day of the year. */
      if (next === null) { if (moved) paint(); return; }

      var L = window.ChampLive;
      /* Nothing to fetch while the draw is hidden — the overlay would only be
         thrown away, and a hidden draw should cost the backend nothing. */
      if (showDraw() && endpoint() && L && typeof L.refresh === 'function') {
        try {
          Promise.resolve(L.refresh()).then(function (state) { applyState(state, moved); },
            function () { if (moved) paint(); });
          return;
        } catch (e) { /* fall through to the clock-only repaint */ }
      }
      if (moved) paint();
    }

    function onVisible() { if (!document.hidden) update(); }

    /* ---- mount ----------------------------------------------------------- */
    elVenue.dataset.mode = has3D() ? '3d' : 'plan';

    fetch(dataUrl('venue.json'))
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; })
      .then(function (venue) {
        if (venue && elPlan) {
          elPlan.innerHTML = buildPlan(venue, courtName);
          planNode = elPlan;
        }
        /* courtNames: venue.json numbers the courts as OSM found them, which
           is not how the club names them. The plates must read what this
           table reads. */
        if (elCanvas) call('mount', elCanvas, { venue: venue, courtNames: courtName });
        elVenue.dataset.mode = has3D() ? '3d' : 'plan';
        defaultView();
      });

    paint();

    /* init never waits on the network (app.js awaits it before the next
       section renders). */
    if (showDraw() && window.ChampLive && typeof window.ChampLive.state === 'function') {
      try {
        Promise.resolve(window.ChampLive.state()).then(function (state) { applyState(state); },
          function () { /* keep static */ });
      } catch (e) { /* keep static */ }
    }

    tick = setInterval(update, TICK * (0.7 + Math.random() * 0.6));
    document.addEventListener('visibilitychange', onVisible);

    /* pause the render loop whenever we are off screen (BRIEF §4.6) */
    var io = null;
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { call(en.isIntersecting ? 'resume' : 'pause'); });
      }, { rootMargin: '160px 0px' });
      io.observe(elVenue);
    }

    root.dataset.ttReady = '1';
    init._destroy = function () {
      if (tick) { clearInterval(tick); tick = null; }
      document.removeEventListener('visibilitychange', onVisible);
      if (io) io.disconnect();
      call('destroy');
    };
  }

  window.Sections.timetable = {
    init: init,
    destroy: function () { if (init._destroy) init._destroy(); }
  };
})();
