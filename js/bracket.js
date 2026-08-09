/* ============================================================================
   bracket.js — CHAMPETOETERS & FRIENDS

   Standings + knockout resolution. Pure: no DOM, no fetch, no globals besides
   the export. The same function feeds the public timetable and the admin app,
   so it must be identical in both and safe on anything the server hands back.

   ChampBracket.resolve(schedule, teams, results) → { standings, slots, byMatch }

   Owns: js/bracket.js
   ========================================================================= */
(function (root) {
  'use strict';

  /* The draw: which poule place fills which knock-out seat. [group, place],
     place 0 = winner, 1 = runner-up.

     Four poules, winner AND runner-up through, so the eight seats are filled
     CROSS-WISE — A's winner in the first quarter, A's runner-up in the third.
     The two halves of the bracket meet only in the finale, so two teams out of
     the same poule can never be knocked out by each other before it. The
     pairing is generated to match by tools/gendata.py, and
     tools/bracket.test.mjs fails if the two ever disagree. */
  var GROUP_SLOT = {
    QF1A: ['A', 0], QF1B: ['B', 1],
    QF2A: ['C', 0], QF2B: ['D', 1],
    QF3A: ['B', 0], QF3B: ['A', 1],
    QF4A: ['D', 0], QF4B: ['C', 1]
  };

  /* Seats filled by the winner of an earlier match, READ OFF THE SCHEDULE
     rather than typed. These used to be literal ids (m49…m54) and every change
     of draw size silently re-pointed them at the wrong matches — the group
     matches come first, so all of them shift at once. The schedule already
     says which round a match belongs to; that is the durable fact. */
  function winnerSlots(matches) {
    var byRound = { qf: [], sf: [], final: [] };
    matches.forEach(function (m) {
      if (byRound[m.round]) byRound[m.round].push(m.id);
    });
    var map = {};
    byRound.sf.forEach(function (id, i) {
      map['SF' + (i + 1) + 'A'] = byRound.qf[i * 2];
      map['SF' + (i + 1) + 'B'] = byRound.qf[i * 2 + 1];
    });
    byRound.final.forEach(function (id, i) {
      if (i) return;                       /* one finale, always */
      map.FA = byRound.sf[0];
      map.FB = byRound.sf[1];
    });
    return map;
  }

  /* Every seat name the resolver can fill. The knock-out seats are fixed by
     GROUP_SLOT; the rest follow the deepest bracket the schedule can describe,
     which is what slotNames has always promised its callers. */
  var SLOT_NAMES = Object.keys(GROUP_SLOT)
    .concat(['SF1A', 'SF1B', 'SF2A', 'SF2B', 'FA', 'FB']);

  /* ----------------------------------------------------- input hardening
     Everything below treats schedule/teams/results as hostile: results come
     from a spreadsheet through two layers of JSON and a bad row must cost at
     most that one match, never an exception. */

  /* Games survive a Sheet round-trip as strings often enough to accept them. */
  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string' && /^\d{1,2}$/.test(v.trim())) return +v.trim();
    return null;
  }

  function cleanSets(sets) {
    if (!Array.isArray(sets) || sets.length < 1 || sets.length > 3) return null;
    var out = [];
    for (var i = 0; i < sets.length; i++) {
      var s = sets[i];
      if (!Array.isArray(s) || s.length < 2) return null;
      var a = num(s[0]), b = num(s[1]);
      if (a === null || b === null) return null;
      out.push([a, b]);
    }
    return out;
  }

  function cleanResult(r) {
    if (!r || typeof r !== 'object') return null;
    if (r.winner !== 'A' && r.winner !== 'B') return null;
    var sets = cleanSets(r.sets);
    if (!sets) return null;
    return { sets: sets, winner: r.winner };
  }

  function matchList(schedule) {
    var raw = Array.isArray(schedule) ? schedule
      : (schedule && Array.isArray(schedule.matches) ? schedule.matches : []);
    return raw.filter(function (m) {
      return m && typeof m.id === 'string' && Array.isArray(m.teams) && m.teams.length >= 2;
    });
  }

  /* Accepts the API's { m01: result } map and an array of { matchId, … }. */
  function resultMap(results, byId) {
    var out = {};
    if (!results || typeof results !== 'object') return out;
    var pairs = Array.isArray(results)
      ? results.map(function (r) { return [r && r.matchId, r]; })
      : Object.keys(results).map(function (k) { return [k, results[k]]; });

    pairs.forEach(function (p) {
      var id = p[0];
      if (typeof id !== 'string' || !byId[id]) return;   /* unknown match → drop */
      var r = cleanResult(p[1]);
      if (r) out[id] = r;
    });
    return out;
  }

  /* ------------------------------------------------------------ standings */

  function blankStat(id) {
    return {
      teamId: id, played: 0, wins: 0,
      setsFor: 0, setsAgainst: 0, gamesFor: 0, gamesAgainst: 0
    };
  }

  function tally(stat, sets, side, won) {
    stat.played += 1;
    if (won) stat.wins += 1;
    sets.forEach(function (s) {
      var mine = s[side], theirs = s[1 - side];
      stat.gamesFor += mine;
      stat.gamesAgainst += theirs;
      if (mine > theirs) stat.setsFor += 1;
      else if (theirs > mine) stat.setsAgainst += 1;
    });
  }

  /* wins → head-to-head (two-way ties only) → set diff → game diff → teamId */
  function rankGroup(ids, stat, h2h) {
    return ids.slice().sort(function (x, y) {
      var a = stat[x], b = stat[y];
      if (b.wins !== a.wins) return b.wins - a.wins;

      var tied = ids.filter(function (id) { return stat[id].wins === a.wins; });
      if (tied.length === 2) {
        var w = h2h[x] && h2h[x][y];
        if (w === x) return -1;
        if (w === y) return 1;
      }

      var ds = (b.setsFor - b.setsAgainst) - (a.setsFor - a.setsAgainst);
      if (ds) return ds;
      var dg = (b.gamesFor - b.gamesAgainst) - (a.gamesFor - a.gamesAgainst);
      if (dg) return dg;
      return x < y ? -1 : (x > y ? 1 : 0);
    }).map(function (id) { return stat[id]; });
  }

  /* ===================================================================== */

  function resolve(schedule, teams, results) {
    var matches = matchList(schedule);
    var byId = {};
    matches.forEach(function (m) { byId[m.id] = m; });

    var played = resultMap(results, byId);

    /* teams → group membership */
    var group = {}, order = [];
    (Array.isArray(teams) ? teams : []).forEach(function (t) {
      if (!t || typeof t.id !== 'string' || typeof t.group !== 'string') return;
      if (!group[t.group]) { group[t.group] = []; order.push(t.group); }
      group[t.group].push(t.id);
    });
    order.sort();

    var groupOf = {};
    order.forEach(function (g) {
      group[g].forEach(function (id) { groupOf[id] = g; });
    });

    /* group matches = both sides are real teams of the same group, so the
       phase labels in the schedule are never load-bearing here */
    var stat = {}, h2h = {}, complete = {};
    Object.keys(groupOf).forEach(function (id) { stat[id] = blankStat(id); h2h[id] = {}; });
    order.forEach(function (g) { complete[g] = true; });

    matches.forEach(function (m) {
      var a = m.teams[0], b = m.teams[1];
      var g = groupOf[a];
      if (!g || groupOf[b] !== g || a === b) return;

      var r = played[m.id];
      if (!r) { complete[g] = false; return; }

      var winner = r.winner === 'A' ? a : b;
      tally(stat[a], r.sets, 0, winner === a);
      tally(stat[b], r.sets, 1, winner === b);
      h2h[a][b] = winner;
      h2h[b][a] = winner;
    });

    var standings = {};
    order.forEach(function (g) { standings[g] = rankGroup(group[g], stat, h2h); });

    /* --------------------------------------------------------- slots ---- */

    var slots = {};
    SLOT_NAMES.forEach(function (k) { slots[k] = null; });

    Object.keys(GROUP_SLOT).forEach(function (k) {
      var g = GROUP_SLOT[k][0], i = GROUP_SLOT[k][1];
      /* a place only exists once the whole group has been played out */
      if (!complete[g] || !standings[g] || !standings[g][i]) return;
      slots[k] = standings[g][i].teamId;
    });

    function sideIds(m) {
      return [0, 1].map(function (i) {
        var e = m.teams[i];
        if (groupOf[e]) return e;                    /* literal team id */
        return Object.prototype.hasOwnProperty.call(slots, e) ? slots[e] : null;
      });
    }

    function winnerOf(id) {
      var m = byId[id], r = played[id];
      if (!m || !r) return null;
      return sideIds(m)[r.winner === 'A' ? 0 : 1];
    }

    var winnerSlot = winnerSlots(matches);
    Object.keys(winnerSlot).forEach(function (k) {
      slots[k] = winnerOf(winnerSlot[k]);
    });

    /* -------------------------------------------------------- byMatch --- */

    var byMatch = {};
    matches.forEach(function (m) {
      var ids = sideIds(m), r = played[m.id] || null;
      byMatch[m.id] = {
        result: r,
        winnerTeamId: r ? ids[r.winner === 'A' ? 0 : 1] : null,
        resolvedTeams: ids
      };
    });

    return { standings: standings, slots: slots, byMatch: byMatch };
  }

  var api = { resolve: resolve, slotNames: SLOT_NAMES.slice() };

  root.ChampBracket = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
