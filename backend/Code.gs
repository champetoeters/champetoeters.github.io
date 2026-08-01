/* CHAMPETOETERS & FRIENDS — backend (Google Apps Script web app).
 * Implements backend/API.md. tools/devserver.js is the identical local twin.
 *
 * DEPLOY — 8 steps, no experience needed
 *  1. Go to script.google.com → New project. Name it "Champetoeters backend".
 *  2. Delete the sample code in Code.gs, paste this whole file, save (Ctrl/Cmd+S).
 *  3. Left rail → Project Settings → Script properties → Add script property,
 *     three times:
 *        ADMIN_PASSWORD  the password the organisers type in /admin/
 *        PAY_IBAN        e.g. BE68 5390 0754 7034  (leave empty until known)
 *        PAY_HOLDER      e.g. Champetoeters
 *     Optional: SHEET_ID to use an existing Google Sheet. Without it the script
 *     creates a Sheet named "CHAMPETOETERS backend" in your Drive on first use
 *     and remembers its id here; if you paste this into a Sheet-bound script
 *     (Extensions → Apps Script) it uses that Sheet.
 *  4. Deploy → New deployment → gear icon → Web app.
 *        Execute as:      Me
 *        Who has access:  Anyone
 *     Deploy → Authorise access → pick your account → Advanced → Go to project
 *     (unsafe) → Allow. That prompt is Google warning you about your own script.
 *  5. Copy the Web app URL — it ends in /exec.
 *  6. Paste it into site/js/config.js as apiEndpoint, commit, push.
 *  7. Check it: open <exec URL>?action=health in a browser. You should see
 *     {"ok":true,"register":true,"orders":true}.
 *  8. Changed this file later? Deploy → Manage deployments → pencil → Version:
 *     New version → Deploy. The /exec URL stays the same.
 *     Changed columns? Delete the old tabs/spreadsheet — they are recreated.
 *     (COLUMNS below is the header row; a tab that already exists is never
 *     re-headed, so an added column would land in the wrong cell. Deleting the
 *     "CHAMPETOETERS backend" Sheet — or just its tabs — makes the script build
 *     them again on the next call. Old rows are gone, so do it before go-live.)
 *
 * Notes
 *  - Runtime must be V8 (the default since 2020).
 *  - Tabs registrations / orders / results / payments / log are created on first
 *    use. You may read them freely; the script only ever appends or edits rows
 *    it owns, so do not re-order the columns.
 *  - Did the COLUMNS layout change in a newer version of this file? Delete the
 *    old tabs (or the whole "CHAMPETOETERS backend" spreadsheet) before using
 *    it — they are recreated with the new columns on first use.
 *  - Apps Script cannot answer CORS preflight, which is why the site POSTs
 *    text/plain (see API.md) and why every reply is HTTP 200 + JSON.
 *  - register/order are public and send mail, so they are rate-capped
 *    (MAX_PER_EMAIL / MAX_PER_DAY) and answer "too-many" past the cap.
 *  - ?action=state is cached for 20s in CacheService and dropped on every
 *    write, so a busy landing page cannot run up the Sheets quota.
 */

var TEAM_PRICE = 50;            // authoritative — an amount from the client is ignored
var TICKET_PRICE = 12;
var MAX_QTY = 8;

/* teams.json (site/data/teams.json) is the source of truth for the draw; Apps
   Script cannot read it, so the two numbers it needs live here. Keep in step:
   TOTAL_SLOTS = teams.length, OPEN_SLOTS = the ids with confirmed:false. */
var TOTAL_SLOTS = 16;
var OPEN_SLOTS = ['t15', 't16'];

/* register/order are unauthenticated and send mail, so they are capped: the
   same address may not pile up rows, and a whole day cannot be flooded (the
   MailApp quota is about 100 mails a day). */
var MAX_PER_EMAIL = 3;
var MAX_PER_DAY = 150;
var STATE_CACHE_KEY = 'state-v1';
var STATE_CACHE_TTL = 20;

var CONTACT_EMAIL = 'padel@tcleiemeers.be';
var CONTACT_PHONE = '+32 476 95 35 33';
var EVENT_NAME = 'CHAMPETOETERS & FRIENDS';
var EVENT_WHEN = 'zaterdag 5 september 2026, 14:00 → 02:00';
var EVENT_WHERE = 'TC Leiemeers, Luitenant-Generaal Gérardstraat 62, 8520 Kuurne';

var COLUMNS = {
  registrations: ['ref', 'teamId', 'teamName', 'player1', 'player2', 'email', 'phone', 'at', 'paid'],
  orders: ['ref', 'name', 'email', 'quantity', 'at', 'paidCount'],
  results: ['matchId', 'sets', 'winner', 'at'],
  payments: ['key', 'paid', 'at'],
  log: ['at', 'action', 'detail']
};

/* ------------------------------------------------------------------ entry */

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  try {
    if (action === 'health') return out_(actHealth_());
    if (action === 'state') return out_(actState_());
    return out_(fail_('bad-request'));
  } catch (err) {
    return out_(serverError_(action, err));
  }
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return out_(fail_('bad-request'));
  }
  if (!body || typeof body !== 'object') return out_(fail_('bad-request'));

  var action = String(body.action || '');
  try {
    if (action === 'register') return out_(actRegister_(body));
    if (action === 'order') return out_(actOrder_(body));
    if (action === 'admin') return out_(actAdmin_(body));
    if (action === 'health') return out_(actHealth_());
    if (action === 'state') return out_(actState_());
    return out_(fail_('bad-request'));
  } catch (err) {
    return out_(serverError_(action, err));
  }
}

/* Writes only, and only after the request has been validated and (for admin
   ops) authenticated — an anonymous caller must never be able to hold the lock
   and starve a registration. Mail is sent after the lock is released. */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
  } catch (err) {
    return fail_('server');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function fail_(code) {
  return { ok: false, error: code };
}

function serverError_(action, err) {
  try { log_('error', action + ': ' + (err && err.message ? err.message : err)); } catch (e) { /* noop */ }
  return fail_('server');
}

/* ------------------------------------------------------------------ sheet */

function props_() {
  return PropertiesService.getScriptProperties();
}

/* Opening the spreadsheet is the most expensive call here, so both the book and
   its tabs are memoised for the lifetime of one execution. */
var BOOK_ = null;
var TABS_ = {};

function book_() {
  if (BOOK_) return BOOK_;
  var props = props_();
  var id = props.getProperty('SHEET_ID');
  if (id) {
    try { BOOK_ = SpreadsheetApp.openById(id); return BOOK_; }
    catch (err) { /* deleted or shared away — recreated below */ }
  }
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    props.setProperty('SHEET_ID', active.getId());
    BOOK_ = active;
    return BOOK_;
  }
  var made = SpreadsheetApp.create('CHAMPETOETERS backend');
  props.setProperty('SHEET_ID', made.getId());
  BOOK_ = made;
  return BOOK_;
}

function tab_(name) {
  if (TABS_[name]) return TABS_[name];
  var ss = book_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, COLUMNS[name].length).setValues([COLUMNS[name]]);
    sh.setFrozenRows(1);
    /* Every column plain text, or Sheets parses what it is given: "0476…"
       loses its zero, "+32…" becomes a formula, an ISO stamp becomes a local
       date-time. Numbers and booleans are read back through Number()/bool_(),
       so text format costs nothing there. */
    sh.getRange(1, 1, sh.getMaxRows(), COLUMNS[name].length).setNumberFormat('@');
  }
  TABS_[name] = sh;
  return sh;
}

/* An 'at' cell edited by hand can still come back as a Date. */
function iso_(v) {
  if (v instanceof Date) return v.toISOString();
  return v ? String(v) : '';
}

function rows_(name) {
  var cols = COLUMNS[name];
  var sh = tab_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, cols.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === '') continue;
    var o = {};
    for (var c = 0; c < cols.length; c++) o[cols[c]] = values[i][c];
    o.__row = i + 2;
    out.push(o);
  }
  return out;
}

function append_(name, obj) {
  var cols = COLUMNS[name];
  var row = cols.map(function (k) { return obj[k] === undefined ? '' : obj[k]; });
  tab_(name).appendRow(row);
}

function setCell_(name, row, key, value) {
  tab_(name).getRange(row, COLUMNS[name].indexOf(key) + 1).setValue(value);
}

function clearTab_(name) {
  var sh = tab_(name);
  var last = sh.getLastRow();
  if (last > 1) sh.deleteRows(2, last - 1);
}

function log_(action, detail) {
  append_('log', { at: new Date().toISOString(), action: action, detail: detail || '' });
}

/* --------------------------------------------------------------- read model */

function registrations_() {
  return rows_('registrations').map(function (r) {
    return {
      ref: String(r.ref),
      teamId: r.teamId ? String(r.teamId) : null,
      player1: String(r.player1),
      player2: String(r.player2),
      email: String(r.email),
      phone: String(r.phone),
      at: iso_(r.at),
      paid: bool_(r.paid),
      __row: r.__row
    };
  });
}

function orders_() {
  return rows_('orders').map(function (r) {
    return {
      ref: String(r.ref),
      name: String(r.name),
      email: String(r.email),
      quantity: Number(r.quantity) || 0,
      at: iso_(r.at),
      paidCount: Number(r.paidCount) || 0,
      __row: r.__row
    };
  });
}

/* Prototype-free maps: a "__proto__" key from a hand-edited sheet must never
   reach an object literal. isMatchId_ rejects it on the way in as well. */
function results_() {
  var out = Object.create(null);
  rows_('results').forEach(function (r) {
    if (!isMatchId_(r.matchId)) return;
    var sets = null;
    try { sets = JSON.parse(String(r.sets)); } catch (err) { sets = null; }
    var clean = cleanResult_(sets, String(r.winner));
    if (clean) out[String(r.matchId)] = clean;
  });
  return out;
}

function teamPaid_() {
  var out = Object.create(null);
  rows_('payments').forEach(function (r) {
    if (isTeamId_(r.key)) out[String(r.key)] = bool_(r.paid);
  });
  return out;
}

/* Sheet-only affordance: an organiser ticking a cell by hand may type ja / x / 1
   instead of TRUE. Over the API only real booleans arrive. */
function bool_(v) {
  if (v === true) return true;
  var s = String(v).trim().toLowerCase();
  return s === 'true' || s === 'ja' || s === 'x' || s === '1';
}

function freeSlots_(regs) {
  var taken = regs.map(function (r) { return r.teamId; });
  return OPEN_SLOTS.filter(function (id) { return taken.indexOf(id) === -1; });
}

/* Same address piling up, or the whole tab flooded today. */
function overLimit_(rows, email) {
  var today = new Date().toISOString().slice(0, 10);
  var sameDay = rows.filter(function (r) {
    return String(r.at || '').slice(0, 10) === today;
  }).length;
  if (sameDay >= MAX_PER_DAY) return true;
  var mail = String(email).toLowerCase();
  return rows.filter(function (r) {
    return String(r.email || '').toLowerCase() === mail;
  }).length >= MAX_PER_EMAIL;
}

/* --------------------------------------------------------------- sanitising */

/* Mirrors scrub()/scrubEmail() in site/js/register.js: letters of any script
   survive, control characters, bidi overrides, emoji and markup punctuation
   do not. The browser also does this; the server is the boundary. */
function clean_(s, max) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E]/g, '')
    .replace(/[^\p{L}\p{N} .,'’&@+()/-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanEmail_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\s]/g, '')
    .slice(0, 160);
}

function hasLetter_(s) { return /\p{L}/u.test(s); }
function isEmail_(s) { return /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(s); }
function isPhone_(s) { return /^(?:\+|00)?\d{8,15}$/.test(String(s).replace(/[\s.\-()/]/g, '')); }
var RESERVED_KEYS = ['__proto__', 'constructor', 'prototype'];

function isMatchId_(id) {
  var s = String(id);
  return /^[A-Za-z0-9_-]{1,20}$/.test(s) && RESERVED_KEYS.indexOf(s) === -1;
}

function isTeamId_(key) {
  var s = String(key);
  if (!/^t\d{2}$/.test(s)) return false;
  var n = Number(s.slice(1));
  return n >= 1 && n <= TOTAL_SLOTS;
}

function pad2_(n) { return n < 10 ? '0' + n : String(n); }

function maxRefNumber_(rows) {
  var max = 0;
  (rows || []).forEach(function (r) {
    var m = /(\d+)$/.exec(String(r && r.ref));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return max;
}

function refSeq_(prefix) {
  var n = parseInt(props_().getProperty('REF_SEQ_' + prefix), 10);
  return n > 0 ? n : 0;
}

function setRefSeq_(prefix, n) {
  props_().setProperty('REF_SEQ_' + prefix, String(n > 0 ? n : 0));
}

/* A ref is never reused. The next number is one past a high-water mark kept in
   Script Properties (REF_SEQ_INS / REF_SEQ_TKT), not one past the highest row
   still present — deleting the newest registration must not hand its number to
   the next one. The live rows are still consulted, so a hand-edited sheet or a
   wiped property store can only ever push the counter forward, never back.
   resetAll clears both marks; seedDemo rebuilds them from the seeded rows. */
function nextRef_(prefix, rows) {
  var n = Math.max(maxRefNumber_(rows), refSeq_(prefix)) + 1;
  setRefSeq_(prefix, n);
  return prefix + '-' + pad2_(n);
}

/* 1..3 sets, integers 0..99. Winner: the side that took more sets; a given
   winner may only break a tie, never contradict a decided majority. Level sets
   with no winner is a bad request (the admin UI asks). */
function cleanResult_(sets, winner) {
  if (!Array.isArray(sets) || !sets.length || sets.length > 3) return null;
  var out = [];
  for (var i = 0; i < sets.length; i++) {
    var s = sets[i];
    if (!Array.isArray(s) || s.length !== 2) return null;
    var a = Number(s[0]);
    var b = Number(s[1]);
    if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
    if (a < 0 || a > 99 || b < 0 || b > 99) return null;
    out.push([a, b]);
  }
  var w = (winner === 'A' || winner === 'B') ? winner : null;
  var na = out.filter(function (x) { return x[0] > x[1]; }).length;
  var nb = out.filter(function (x) { return x[1] > x[0]; }).length;
  if (na === nb) {
    if (!w) return null;
  } else {
    var majority = na > nb ? 'A' : 'B';
    if (w && w !== majority) return null;
    w = majority;
  }
  return { sets: out, winner: w };
}

/* -------------------------------------------------------------------- mail */

function payIban_() { return String(props_().getProperty('PAY_IBAN') || '').trim(); }
function payHolder_() { return String(props_().getProperty('PAY_HOLDER') || 'Champetoeters').trim(); }

function paymentLines_(reference) {
  var iban = payIban_();
  var first = iban
    ? '• Overschrijving naar ' + iban + ' op naam van ' + payHolder_() +
      ' met mededeling "' + reference + '".'
    : '• Het rekeningnummer volgt nog — betalen kan ook ter plaatse.';
  return [
    'Betalen kan op twee manieren:',
    first,
    '• Of ter plaatse op het event (cash of Payconiq).',
    'Nog niet betaald? Geen probleem — je plaats/tickets staan vast zodra we je',
    'betaling ontvangen of je ter plaatse betaalt.'
  ];
}

function footerLines_() {
  return [
    'Vragen? Mail ' + CONTACT_EMAIL + ' of bel ' + CONTACT_PHONE + '.',
    '',
    EVENT_NAME + ' — ' + EVENT_WHEN,
    EVENT_WHERE
  ];
}

function registerMail_(entry) {
  var who = [entry.player1, entry.player2].filter(Boolean).join(' & ');
  return {
    to: entry.email,
    subject: 'Inschrijving ontvangen — ' + EVENT_NAME,
    lines: [
      'Hallo ' + who + ',',
      '',
      'Jullie inschrijving is binnen. Nummer ' + entry.ref + '.',
      'Team: ' + (entry.teamName || who) + ' (' + who + ')',
      'Inschrijvingsgeld: €' + TEAM_PRICE + ' per team.',
      ''
    ].concat(paymentLines_(entry.ref), [''], footerLines_())
  };
}

function orderMail_(order) {
  var total = order.quantity * TICKET_PRICE;
  return {
    to: order.email,
    subject: 'Je open air tickets — ' + EVENT_NAME,
    lines: [
      'Hallo ' + order.name + ',',
      '',
      'Je tickets zijn gereserveerd. Nummer ' + order.ref + '.',
      'Aantal: ' + order.quantity + ' × €' + TICKET_PRICE + ' = €' + total + '.',
      ''
    ].concat(paymentLines_(order.ref), [''], footerLines_())
  };
}

function escHtml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* A mail that bounces (quota, bad address) must not lose the entry: the row is
   already written and the failure is logged. */
function sendMail_(mail) {
  try {
    /* No replyTo: replies go to the account this script runs under — the
       event's own address. */
    MailApp.sendEmail({
      to: mail.to,
      name: EVENT_NAME,
      subject: mail.subject,
      body: mail.lines.join('\n'),
      htmlBody: '<p>' + mail.lines.map(escHtml_).join('<br>') + '</p>'
    });
  } catch (err) {
    log_('mail-failed', mail.to + ': ' + (err && err.message ? err.message : err));
  }
}

/* ------------------------------------------------------------- public acts */

function actHealth_() {
  return { ok: true, register: freeSlots_(registrations_()).length > 0, orders: true };
}

/* The landing page polls ?action=state, and each build costs a handful of Sheets
   round-trips. 20 seconds of cache absorbs a crowd; every mutation drops it, so
   an admin never sees their own edit go missing. */
function actState_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(STATE_CACHE_KEY);
  if (hit) {
    try { return JSON.parse(hit); } catch (err) { /* fall through and rebuild */ }
  }
  var payload = buildState_();
  try { cache.put(STATE_CACHE_KEY, JSON.stringify(payload), STATE_CACHE_TTL); }
  catch (err) { /* cache is a bonus, never a requirement */ }
  return payload;
}

function dropStateCache_() {
  try { CacheService.getScriptCache().remove(STATE_CACHE_KEY); } catch (err) { /* noop */ }
}

function buildState_() {
  var regs = registrations_();
  return {
    ok: true,
    results: results_(),
    teams: regs.filter(function (r) { return !!r.teamId; }).map(function (r) {
      return {
        teamId: r.teamId,
        name: String(r.teamName || ''),
        players: [r.player1, r.player2].filter(Boolean)
      };
    }),
    counts: {
      registrations: TOTAL_SLOTS - freeSlots_(regs).length,
      slots: TOTAL_SLOTS
    }
  };
}

/* Shared by the public register action and the admin addRegistration op, so the
   two can never drift apart. Returns the scrubbed entry, or null when invalid. */
function cleanEntry_(body, paid) {
  var entry = {
    ref: '',
    teamId: null,
    teamName: clean_(body.teamName, 40),
    player1: clean_(body.player1, 60),
    player2: clean_(body.player2, 60),
    email: cleanEmail_(body.email),
    phone: clean_(body.phone, 40),
    at: new Date().toISOString(),
    paid: !!paid
  };
  if (entry.teamName.length < 2 || !hasLetter_(entry.teamName)) return null;
  if (!entry.player1 || !entry.player2) return null;
  if (!hasLetter_(entry.player1) || !hasLetter_(entry.player2)) return null;
  if (!isEmail_(entry.email)) return null;
  if (!isPhone_(entry.phone)) return null;
  return entry;
}

/* Same deal for order / addOrder. paidCount is clamped to 0..quantity; the
   public action always passes 0. */
function cleanOrder_(body, paidCount) {
  var qty = Number(body.quantity);
  var order = {
    ref: '',
    name: clean_(body.name, 60),
    email: cleanEmail_(body.email),
    quantity: qty,
    at: new Date().toISOString(),
    paidCount: 0
  };
  if (!order.name || !hasLetter_(order.name)) return null;
  if (!isEmail_(order.email)) return null;
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return null;
  order.paidCount = Math.max(0, Math.min(qty, Math.trunc(Number(paidCount)) || 0));
  return order;
}

function actRegister_(body) {
  var entry = cleanEntry_(body, false);
  if (!entry) return fail_('bad-request');

  var mail = null;
  var res = withLock_(function () {
    var regs = registrations_();
    var free = freeSlots_(regs);
    if (!free.length) return fail_('full');
    if (overLimit_(regs, entry.email)) return fail_('too-many');

    entry.teamId = free[0];
    entry.ref = nextRef_('INS', regs);
    append_('registrations', entry);
    log_('register', entry.ref + ' ' + entry.teamId + ' ' + entry.email);
    dropStateCache_();
    mail = registerMail_(entry);
    return { ok: true, reference: entry.ref, teamId: entry.teamId, amount: TEAM_PRICE };
  });

  if (mail) sendMail_(mail);
  return res;
}

function actOrder_(body) {
  var order = cleanOrder_(body, 0);
  if (!order) return fail_('bad-request');

  var mail = null;
  var res = withLock_(function () {
    var rows = orders_();
    if (overLimit_(rows, order.email)) return fail_('too-many');

    order.ref = nextRef_('TKT', rows);
    append_('orders', order);
    log_('order', order.ref + ' x' + order.quantity + ' ' + order.email);
    dropStateCache_();
    mail = orderMail_(order);
    return { ok: true, reference: order.ref, amount: order.quantity * TICKET_PRICE };
  });

  if (mail) sendMail_(mail);
  return res;
}

/* -------------------------------------------------------------------- admin */

function actAdmin_(body) {
  var expected = String(props_().getProperty('ADMIN_PASSWORD') || '');
  if (!expected || String(body.password || '') !== expected) return fail_('unauthorized');
  var op = String(body.op || '');

  if (op === 'login') return { ok: true };

  if (op === 'overview') {
    return {
      ok: true,
      registrations: registrations_().map(strip_),
      orders: orders_().map(strip_),
      results: results_(),
      teamPaid: teamPaid_()
    };
  }

  if (op === 'setResult') {
    if (!isMatchId_(body.matchId)) return fail_('bad-request');
    var res = cleanResult_(body.sets, body.winner);
    if (!res) return fail_('bad-request');
    var id = String(body.matchId);
    return withLock_(function () {
      var existing = rows_('results').filter(function (r) { return String(r.matchId) === id; })[0];
      var row = {
        matchId: id,
        sets: JSON.stringify(res.sets),
        winner: res.winner,
        at: new Date().toISOString()
      };
      if (existing) {
        setCell_('results', existing.__row, 'sets', row.sets);
        setCell_('results', existing.__row, 'winner', row.winner);
        setCell_('results', existing.__row, 'at', row.at);
      } else {
        append_('results', row);
      }
      log_('setResult', id + ' ' + row.sets + ' ' + row.winner);
      dropStateCache_();
      return { ok: true };
    });
  }

  if (op === 'clearResult') {
    if (!isMatchId_(body.matchId)) return fail_('bad-request');
    var wanted = String(body.matchId);
    return withLock_(function () {
      var hit = rows_('results').filter(function (r) { return String(r.matchId) === wanted; })[0];
      if (hit) tab_('results').deleteRow(hit.__row);
      log_('clearResult', wanted);
      dropStateCache_();
      return { ok: true };
    });
  }

  if (op === 'setTeamPaid') {
    var key = String(body.key || '');
    var paid = !!body.paid;
    return withLock_(function () {
      if (isTeamId_(key)) {
        var pay = rows_('payments').filter(function (r) { return String(r.key) === key; })[0];
        if (pay) setCell_('payments', pay.__row, 'paid', paid);
        else append_('payments', { key: key, paid: paid, at: new Date().toISOString() });
      } else {
        var reg = registrations_().filter(function (r) { return r.ref === key; })[0];
        if (!reg) return fail_(/^[A-Za-z]{2,4}-\d+$/.test(key) ? 'not-found' : 'bad-request');
        setCell_('registrations', reg.__row, 'paid', paid);
      }
      log_('setTeamPaid', key + ' ' + paid);
      dropStateCache_();
      return { ok: true };
    });
  }

  if (op === 'setOrderPaid') {
    var ref = String(body.ref || '');
    var n = Math.trunc(Number(body.paidCount));
    if (!Number.isFinite(n)) return fail_('bad-request');
    return withLock_(function () {
      var order = orders_().filter(function (o) { return o.ref === ref; })[0];
      if (!order) return fail_('not-found');
      var count = Math.max(0, Math.min(order.quantity, n));
      setCell_('orders', order.__row, 'paidCount', count);
      log_('setOrderPaid', ref + ' ' + count);
      dropStateCache_();
      return { ok: true };
    });
  }

  /* Row bookkeeping the organisers do by hand: someone signs up at the bar, or
     a duplicate has to go. Same validation as the public actions, but no abuse
     caps (the caller is authenticated) and no confirmation mail (the organiser
     talks to the person in front of them). */
  if (op === 'addRegistration') {
    var newReg = cleanEntry_(body, body.paid);
    if (!newReg) return fail_('bad-request');
    return withLock_(function () {
      var regs = registrations_();
      var free = freeSlots_(regs);
      if (!free.length) return fail_('full');
      newReg.teamId = free[0];
      newReg.ref = nextRef_('INS', regs);
      append_('registrations', newReg);
      log_('addRegistration', newReg.ref + ' ' + newReg.teamId);
      dropStateCache_();
      return { ok: true, reference: newReg.ref, teamId: newReg.teamId };
    });
  }

  /* Deleting frees the slot again (health.register flips back to true), and
     never frees the ref — see nextRef_. A second call is simply not-found. */
  if (op === 'deleteRegistration') {
    var regRef = String(body.ref || '');
    return withLock_(function () {
      var hit = registrations_().filter(function (r) { return r.ref === regRef; })[0];
      if (!hit) return fail_('not-found');
      tab_('registrations').deleteRow(hit.__row);
      log_('deleteRegistration', regRef);
      dropStateCache_();
      return { ok: true };
    });
  }

  if (op === 'addOrder') {
    var newOrder = cleanOrder_(body, body.paidCount);
    if (!newOrder) return fail_('bad-request');
    return withLock_(function () {
      var rows = orders_();
      newOrder.ref = nextRef_('TKT', rows);
      append_('orders', newOrder);
      log_('addOrder', newOrder.ref + ' x' + newOrder.quantity);
      dropStateCache_();
      return { ok: true, reference: newOrder.ref };
    });
  }

  if (op === 'deleteOrder') {
    var orderRef = String(body.ref || '');
    return withLock_(function () {
      var row = orders_().filter(function (o) { return o.ref === orderRef; })[0];
      if (!row) return fail_('not-found');
      tab_('orders').deleteRow(row.__row);
      log_('deleteOrder', orderRef);
      dropStateCache_();
      return { ok: true };
    });
  }

  if (op === 'seedDemo') {
    return withLock_(function () {
      seed_(body.state);
      log_('seedDemo', '');
      dropStateCache_();
      return { ok: true };
    });
  }

  if (op === 'resetAll') {
    return withLock_(function () {
      clearTab_('registrations');
      clearTab_('orders');
      clearTab_('results');
      clearTab_('payments');
      setRefSeq_('INS', 0);
      setRefSeq_('TKT', 0);
      log_('resetAll', '');
      dropStateCache_();
      return { ok: true };
    });
  }

  return fail_('bad-request');
}

/* Row bookkeeping never leaves the server. */
function strip_(o) {
  var copy = {};
  Object.keys(o).forEach(function (k) { if (k !== '__row') copy[k] = o[k]; });
  return copy;
}

/* site/data/demo-state.json keeps its admin-only rows under `adminDemo`, so the
   file can be seeded wholesale: nested orders / teamPaid / registrations are
   merged with the top-level keys, top level winning on a key clash. */
function seedSource_(raw) {
  var src = raw && typeof raw === 'object' ? raw : {};
  var nested = src.adminDemo && typeof src.adminDemo === 'object' ? src.adminDemo : {};
  var arr = function (v) { return Array.isArray(v) ? v : []; };
  return {
    /* Full objects first, public { teamId, players } entries after: a slot
       already described in detail is not duplicated by its public twin. */
    registrations: arr(src.registrations).concat(arr(nested.registrations), arr(src.teams)),
    orders: arr(src.orders).concat(arr(nested.orders)),
    results: src.results && typeof src.results === 'object' ? src.results : nested.results,
    teamPaid: Object.assign({}, nested.teamPaid, nested.payments, src.teamPaid, src.payments)
  };
}

/* Replace ALL data with the given demo state. Registrations may arrive as full
   objects or as the public { teamId, players } shape of ?action=state. */
function seed_(raw) {
  var src = seedSource_(raw);

  clearTab_('registrations');
  clearTab_('orders');
  clearTab_('results');
  clearTab_('payments');
  /* The demo state carries its own refs, so the counters restart from it. */
  setRefSeq_('INS', 0);
  setRefSeq_('TKT', 0);

  var kept = [];
  src.registrations.forEach(function (r) {
    if (!r || typeof r !== 'object') return;
    var players = Array.isArray(r.players) ? r.players : [r.player1, r.player2];
    var teamId = isTeamId_(r.teamId) ? String(r.teamId) : '';
    var entry = {
      ref: clean_(r.ref, 20) || nextRef_('INS', kept),
      teamId: teamId,
      teamName: clean_(r.teamName || r.name, 40),
      player1: clean_(players[0], 60),
      player2: clean_(players[1], 60),
      email: cleanEmail_(r.email),
      phone: clean_(r.phone, 40),
      at: typeof r.at === 'string' ? r.at : new Date().toISOString(),
      paid: !!r.paid
    };
    if (!entry.player1 && !entry.player2) return;
    var dupe = kept.filter(function (x) {
      return x.ref === entry.ref || (teamId && x.teamId === teamId);
    }).length > 0;
    if (dupe) return;
    kept.push(entry);
    append_('registrations', entry);
  });

  var keptOrders = [];
  src.orders.forEach(function (o) {
    if (!o || typeof o !== 'object') return;
    var qty = Number(o.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return;
    var name = clean_(o.name, 60);
    if (!name) return;
    var paidCount = Math.max(0, Math.min(qty, Math.trunc(Number(o.paidCount)) || 0));
    var row = {
      ref: clean_(o.ref, 20) || nextRef_('TKT', keptOrders),
      name: name,
      email: cleanEmail_(o.email),
      quantity: qty,
      at: typeof o.at === 'string' ? o.at : new Date().toISOString(),
      paidCount: paidCount
    };
    keptOrders.push(row);
    append_('orders', row);
  });

  var results = src.results && typeof src.results === 'object' ? src.results : {};
  Object.keys(results).forEach(function (id) {
    if (!isMatchId_(id)) return;
    var r = results[id] || {};
    var ok = cleanResult_(r.sets, r.winner);
    if (!ok) return;
    append_('results', {
      matchId: id,
      sets: JSON.stringify(ok.sets),
      winner: ok.winner,
      at: new Date().toISOString()
    });
  });

  Object.keys(src.teamPaid).forEach(function (key) {
    if (!isTeamId_(key)) return;
    append_('payments', { key: key, paid: !!src.teamPaid[key], at: new Date().toISOString() });
  });

  setRefSeq_('INS', Math.max(refSeq_('INS'), maxRefNumber_(kept)));
  setRefSeq_('TKT', Math.max(refSeq_('TKT'), maxRefNumber_(keptOrders)));
}
