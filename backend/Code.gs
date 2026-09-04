/* CHAMPETOETERS & FRIENDS — backend (Google Apps Script web app).
 * Implements backend/API.md. tools/devserver.js is the identical local twin.
 *
 * DEPLOY — 8 steps, no experience needed
 *  1. Go to script.google.com → New project. Name it "Champetoeters backend".
 *  2. Delete the sample code in Code.gs, paste this whole file, save (Ctrl/Cmd+S).
 *  3. Left rail → Project Settings → Script properties → Add script property,
 *     three times:
 *        ADMIN_PASSWORD  the password the organisers type in /admin/
 *        PAY_IBAN        optional — defaults to IE75 SUMU 9903 6513 1743 98
 *        PAY_HOLDER      the name on the account, e.g. Sebbe Benoit
 *     Optional: GITHUB_TOKEN — a fine-grained token (Contents: read/write on
 *     the champetoeters.github.io repo only). With it, every score/registration
 *     is pushed to GitHub as static state.json and visitors' phones read THAT,
 *     costing this script no runtime. Strongly recommended for the event day.
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

var TEAM_PRICE = 44;            // authoritative — an amount from the client is ignored
/* The four open-air formulas. Every one is the same entry ticket; the drink
   and the wristband that comes with it is the difference.

   The KEY is what the browser sends; label/short/price are the server's, and
   the amount is NEVER taken from the request. Repeated from
   site/data/tickets.json because Apps Script cannot read it —
   tools/bracket.test.mjs fails if the ids or the prices drift apart. */
var TICKET_TYPES = {
  'basis': { label: 'Toegangsticket', short: 'Enkel toegang', price: 3 },
  'soda': { label: 'Toegangsticket + Soda/Pint', short: 'Soda/Pint', price: 5 },
  'cocktail': { label: 'Toegangsticket + Cocktail/Glas Champetoeter (Pommery)',
                short: 'Cocktail/Glas Champetoeter', price: 10 },
  'fles': { label: 'Toegangsticket + Fles Champetoeter (Pommery)',
            short: 'Fles Champetoeter', price: 79 }
};

/* Tickets in ONE order. Each one carries a person's name, so this is also how
   long the order form can get. Anti-spam, not a sales limit. */
var MAX_TICKETS = 25;

/* teams.json (site/data/teams.json) is the source of truth for the draw; Apps
   Script cannot read it, so the two numbers it needs live here. Keep in step:
   TOTAL_SLOTS = teams.length, OPEN_SLOTS = the ids with confirmed:false. */
var TOTAL_SLOTS = 22;
/* Empty since 2026-09-04: every seat is named in ROSTER (tools/gendata.py) —
   the draw is the organisers' Excel, pushed as code, and no registration can
   be handed a seat any more. freeSlots_ is therefore always [], which is what
   reports register:false and counts 22/22. */
var OPEN_SLOTS = [];

/* Since the format restructure the slot id ENCODES the competition
   (tools/gendata.py): t01–t16 are the vier herenpoules, t17–t22 the
   damespoule. A registration must land in its own half — hand a vrouwenteam
   t01 and the public draw seats it in Poule 1 on Baan 1 and feeds it into the
   heren knock-out. freeSlots_ routes on teamType; tools/bracket.test.mjs
   checks this list against teams.json group "V". */
var WOMEN_SLOTS = ['t17', 't18', 't19', 't20', 't21', 't22'];

/* The two choices the entry form asks for. The KEY is what the browser sends
   (the <option value> in site/sections/register.html — Apps Script cannot read
   that file, so the pair is repeated here and tools/bracket.test.mjs fails if
   the two ever drift). The VALUE is what gets stored and mailed: the organiser
   reads this straight out of the Sheet, and "heel-vaak" is not an answer. */
var TEAM_TYPES = {
  'vrouwen': 'Vrouwenteam',
  'mannen': 'Mannenteam'
};
var LEVELS = {
  'af-en-toe': 'Ik speel af en toe (Geen idee welke P/P50)',
  'vaak': 'Ik speel vaak (P100/P200)',
  'heel-vaak': 'Ik speel heel vaak (P300/P400)'
};

/* At most this many women's teams in the draw (client). DELIBERATELY NOT
   ADVERTISED: the form never names the cap and ?action=state never carries the
   tally, so nobody can watch it fill. The 7th women's entry is refused at
   submit with `women-full`, and register.js prints that under the team-type
   field — the one place where it is actionable, because switching the answer
   to Mannenteam is the way on. The cap is checked INSIDE withLock_, so two
   simultaneous 6th entries cannot both slip through. */
var MAX_WOMEN_TEAMS = 6;

/* register/order are unauthenticated and send mail, so they are capped: the
   same address may not pile up rows, and a whole day cannot be flooded (the
   GmailApp quota is about 100 mails a day — measured 100 on this account
   2026-08-09 via MailApp.getRemainingDailyQuota()). */
var MAX_PER_EMAIL = 3;
/* Anti-spam for the Sheet, NOT a sales limit (client decision). Rows per tab
   per calendar day, so it really only bounds ticket orders — registrations run
   out of slots at TOTAL_SLOTS long before this. register/order are public and
   unauthenticated and each row MAILS an address the caller chose, so removing
   this ceiling would make the endpoint an open relay; MAX_PER_EMAIL does not
   cover it (an attacker just varies the address). Raised 120 → 500 on
   2026-08-09: 120 was picked to sit just above the then-assumed ~100/day mail
   quota, and the paid Workspace tier lifted that to 1500, so the old number
   only risked refusing a real buyer on launch night. A refusal answers
   `too-many`, which tickets.js shows as its GENERIC failure — indistinguishable
   from a network error, so the ceiling must stay clear of real volume. */
var MAX_PER_DAY = 500;
/* Log a warning once the day's mail allowance drops to this. */
var MAIL_QUOTA_WARN = 20;
var STATE_CACHE_KEY = 'state-v1';
var STATE_CACHE_TTL = 60;

/* Static-state publishing: after every mutation the fresh state is pushed to
   the GitHub repo (branch 'state'), and the SITE reads it from GitHub — reads
   then cost NO script runtime, so any number of phones can watch the scores.
   Needs Script property GITHUB_TOKEN (fine-grained, Contents read/write on the
   one repo). Without the token the feature is simply off and reads fall back
   to ?action=state here. */
var STATE_REPO = 'champetoeters/champetoeters.github.io';
var STATE_BRANCH = 'state';
var STATE_PATH = 'state.json';

/* The address the mails go out FROM. No mail prints it any more (the contact
   line was dropped 2026-08-09) — replies land here regardless, since nothing
   sets a Reply-To. */
var CONTACT_EMAIL = 'event@champetoeters.be';
var EVENT_NAME = 'CHAMPETOETERS & FRIENDS';
var EVENT_WHEN = 'zaterdag 5 september 2026, 12:30 → 02:00';
var EVENT_WHERE = 'TC Leiemeers, Luitenant-Generaal Gérardstraat 62, 8520 Kuurne';
/* Mails are plain text with a naive HTML twin (sendMail_), so links go in as
   bare URLs — there is no anchor to hide them behind. */
var INSTAGRAM_URL = 'https://www.instagram.com/champetoeters/';
var TICKETS_URL = 'https://champetoeters.be/tickets/';
/* The club's Google Maps listing, addressed by place CID — the stable half of
   the feature id in the organiser's own share link
   (…!1s0x47c33ba24c56b12d:0xc8c979546509cf7f → 0xc8c979546509cf7f in decimal).
   EVENT_WHERE is anchored to this in the HTML body (mailHtml_) because a phone
   left to auto-detect the address swallows the "TC Leiemeers, " prefix and
   geocodes it to the wrong pin. Rebuild from 50.8470306, 3.2883501 if the
   listing ever moves; site/data/venue.json holds the surveyed court origin. */
var VENUE_MAP_URL = 'https://maps.google.com/?cid=14468228681283784575';

var COLUMNS = {
  registrations: ['ref', 'teamId', 'teamName', 'player1', 'player2', 'email', 'phone',
                  'teamType', 'level', 'at', 'paid', 'clientRef'],
  /* `tickets` is the order itself: a JSON array of { holder, type, label,
     price, paid }, one entry per named ticket. label and price are frozen into
     the row on purpose — a formula whose price changes later must not silently
     rewrite what somebody already agreed to pay.
     `summary` and `amount` are derived, and exist so the raw Sheet stays
     readable to a human who never opens /admin/. */
  /* No buyer name column: the page asks only for an e-mail and the name on
     each ticket, and the person ordering need not be one of the ticket
     holders — so there is nobody to put in it (client, r11). `ref` identifies
     the row here and in /admin/; it is deliberately never shown to a buyer
     and never mailed, and a ticket order carries no mededeling at all. */
  orders: ['ref', 'email', 'tickets', 'summary', 'amount', 'at', 'clientRef'],
  results: ['matchId', 'sets', 'winner', 'at'],
  payments: ['key', 'paid', 'at'],
  log: ['at', 'action', 'detail']
};

/* Run this ONCE from the editor after pasting a new version: it is the only
   function without a trailing underscore besides doGet/doPost (underscored
   functions are hidden from the Run menu), so it is the button that triggers
   Google's authorization dialog for every permission the script needs — and
   it immediately performs a real state push as the test. */
function authorize() {
  publishState_();
}

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
  var result;
  try {
    if (action === 'register') result = actRegister_(body);
    else if (action === 'order') result = actOrder_(body);
    else if (action === 'admin') result = actAdmin_(body);
    else if (action === 'health') result = actHealth_();
    else if (action === 'state') result = actState_();
    else result = fail_('bad-request');
  } catch (err) {
    result = serverError_(action, err);
  }
  /* Publishing happens OUTSIDE the lock and after the work, like mail: a slow
     GitHub round-trip may delay this response but never blocks another write. */
  if (PUBLISH_) { PUBLISH_ = false; publishState_(); }
  return out_(result);
}

/* Set by dropStateCache_ — i.e. by every successful mutation. */
var PUBLISH_ = false;

function publishState_() {
  var token = String(props_().getProperty('GITHUB_TOKEN') || '').trim();
  if (!token) return;   /* feature off — reads fall back to ?action=state */
  try {
    var payload = buildState_();
    try {
      CacheService.getScriptCache()
        .put(STATE_CACHE_KEY, JSON.stringify(payload), STATE_CACHE_TTL);
    } catch (e) { /* cache is a bonus */ }

    var api = 'https://api.github.com/repos/' + STATE_REPO + '/contents/' + STATE_PATH;
    var headers = {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json'
    };
    var sha = null;
    var got = UrlFetchApp.fetch(api + '?ref=' + STATE_BRANCH,
      { headers: headers, muteHttpExceptions: true });
    if (got.getResponseCode() === 200) {
      sha = JSON.parse(got.getContentText()).sha || null;
    }
    var put = UrlFetchApp.fetch(api, {
      method: 'put',
      headers: headers,
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify({
        message: 'state ' + new Date().toISOString(),
        content: Utilities.base64Encode(JSON.stringify(payload), Utilities.Charset.UTF_8),
        branch: STATE_BRANCH,
        sha: sha || undefined
      })
    });
    var code = put.getResponseCode();
    if (code < 200 || code >= 300) log_('publish-failed', 'HTTP ' + code);
  } catch (err) {
    try { log_('publish-failed', String(err && err.message ? err.message : err)); } catch (e) { /* noop */ }
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
    writeHeader_(sh, name);
  } else {
    healHeader_(sh, name);
  }
  TABS_[name] = sh;
  return sh;
}

function writeHeader_(sh, name) {
  var want = COLUMNS[name];
  sh.getRange(1, 1, 1, want.length).setValues([want]);
  sh.setFrozenRows(1);
  /* Every column plain text, or Sheets parses what it is given: "0476…" loses
     its zero, "+32…" becomes a formula, an ISO stamp becomes a local
     date-time. Numbers and booleans are read back through Number()/bool_(), so
     text format costs nothing there. */
  sh.getRange(1, 1, sh.getMaxRows(), want.length).setNumberFormat('@');
}

/* A tab created by an OLDER version of this file still carries that version's
   header row, and rows_() maps by header NAME — so a column this version
   writes lands nowhere and reads back as undefined. That is exactly how the
   registrations tab once stored teamName without ever reading it.

   Repair it, but only while the tab is EMPTY: rewriting a header over existing
   rows would relabel real data, which is worse than the mismatch. A non-empty
   mismatch is left alone and warned about — resetAll clears the rows, and the
   next call through here fixes the header for good.

   console.warn, never log_(): log_ writes through tab_() and would recurse. */
function healHeader_(sh, name) {
  var want = COLUMNS[name];
  var width = Math.max(want.length, sh.getLastColumn() || want.length);
  var got = sh.getRange(1, 1, 1, width).getValues()[0].map(function (v) {
    return String(v == null ? '' : v).trim();
  });
  var ok = true;
  want.forEach(function (c, i) { if (got[i] !== c) ok = false; });
  got.slice(want.length).forEach(function (v) { if (v) ok = false; });
  if (ok) return;

  if (sh.getLastRow() > 1) {
    try {
      console.warn('[champ] ' + name + ' has an old header row (' + got.join(',') +
                   ') and ' + (sh.getLastRow() - 1) + ' rows in it. Run resetAll, ' +
                   'then reload — the header repairs itself once the tab is empty.');
    } catch (err) { /* console is a bonus */ }
    return;
  }
  if (width > want.length) sh.getRange(1, 1, 1, width).clearContent();
  writeHeader_(sh, name);
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
  /* ⚠️ Every column in COLUMNS.registrations must be mapped here, or a stored
     field silently reads back as undefined — teamName and clientRef were once
     written but never read, which disabled the public team names AND the
     idempotent-replay dedupe in production. tools/gascheck.mjs guards this. */
  return rows_('registrations').map(function (r) {
    return {
      ref: String(r.ref),
      teamId: r.teamId ? String(r.teamId) : null,
      teamName: String(r.teamName || ''),
      player1: String(r.player1),
      player2: String(r.player2),
      email: String(r.email),
      phone: String(r.phone),
      teamType: String(r.teamType || ''),
      level: String(r.level || ''),
      at: iso_(r.at),
      paid: bool_(r.paid),
      clientRef: String(r.clientRef || ''),
      __row: r.__row
    };
  });
}

/* A stored tickets cell, back into an array. Anything unreadable becomes an
   empty order rather than throwing: one corrupt cell must not take out the
   whole orders view. */
function parseTickets_(raw) {
  var list;
  try { list = JSON.parse(String(raw || '[]')); } catch (err) { return []; }
  if (!Array.isArray(list)) return [];
  return list.map(function (t) {
    t = t && typeof t === 'object' ? t : {};
    return {
      holder: String(t.holder || ''),
      type: String(t.type || ''),
      label: String(t.label || ''),
      price: Number(t.price) || 0,
      paid: !!t.paid
    };
  });
}

function orders_() {
  /* Same rule as registrations_: map every COLUMNS.orders field. */
  return rows_('orders').map(function (r) {
    return {
      ref: String(r.ref),
      email: String(r.email),
      tickets: parseTickets_(r.tickets),
      summary: String(r.summary || ''),
      amount: Number(r.amount) || 0,
      at: iso_(r.at),
      clientRef: String(r.clientRef || ''),
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

/* Without a teamType this is the OVERALL capacity (the health flag: is any
   place left at all); with one it is the pool that type may actually take —
   dames in t17–t22, heren in t01–t16. Rows carry the LABEL ('Vrouwenteam'),
   see countTeamType_ below. */
function freeSlots_(regs, teamType) {
  var women = teamType === TEAM_TYPES.vrouwen;
  var pool = !teamType ? OPEN_SLOTS : OPEN_SLOTS.filter(function (id) {
    return (WOMEN_SLOTS.indexOf(id) !== -1) === women;
  });
  var taken = regs.map(function (r) { return r.teamId; });
  return pool.filter(function (id) { return taken.indexOf(id) === -1; });
}

/* Rows already carry the LABEL ('Vrouwenteam'), not the form key — cleanEntry_
   maps it through TEAM_TYPES before the row is written, and /admin/ writes the
   same shape. Compare against the label, never against 'vrouwen'. */
function countTeamType_(regs, label) {
  var n = 0;
  for (var i = 0; i < regs.length; i++) {
    if (String(regs[i].teamType || '') === label) n++;
  }
  return n;
}

function womenFull_(regs) {
  return countTeamType_(regs, TEAM_TYPES.vrouwen) >= MAX_WOMEN_TEAMS;
}

/* Same address piling up, or the whole tab flooded today. */
/* One mailbox, one identity: lowercase and strip a +tag, so jan+2@ cannot
   sidestep the per-address cap. */
function capEmail_(v) {
  return String(v || '').toLowerCase().replace(/\+[^@]*(?=@)/, '');
}

function overLimit_(rows, email) {
  var today = new Date().toISOString().slice(0, 10);
  var sameDay = rows.filter(function (r) {
    return String(r.at || '').slice(0, 10) === today;
  }).length;
  if (sameDay >= MAX_PER_DAY) return true;
  var mail = capEmail_(email);
  return rows.filter(function (r) {
    return capEmail_(r.email) === mail;
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
   resetAll clears both marks. */
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

function payIban_() { return String(props_().getProperty('PAY_IBAN') || 'IE75 SUMU 9903 6513 1743 98').trim(); }
function payHolder_() { return String(props_().getProperty('PAY_HOLDER') || 'Sebbe Benoit').trim(); }

/* Both mails ask for the same transfer in the same words (client, 2026-08-09):
   only the noun ("inschrijving" / "bestelling") and the mededeling differ. The
   mededeling is what identifies the payment — the team name for a register,
   the ticket holders for an order — so it is never optional here.
   Transfer is the ONLY route offered: no pay-at-the-event line. */
function payBlock_(amount, noun, mededeling) {
  var iban = payIban_();
  if (!iban) {
    return ['Het rekeningnummer volgt nog. Je hoeft nu dus nog niets over te schrijven.'];
  }
  return [
    'Om je ' + noun + ' definitief te bevestigen, vragen we je om het totaalbedrag van',
    '€' + amount + ' over te schrijven op onderstaande rekening:',
    '  IBAN: ' + iban + ' (' + payHolder_() + ')',
    '  Bedrag: €' + amount,
    '  Mededeling: ' + mededeling
  ];
}

/* Where and when — the last two lines of both mails. Neither prints a contact
   line any more (client, 2026-08-09): the mails carry no Reply-To, so a reply
   already lands on CONTACT_EMAIL, the account that sent them. */
function eventLines_() {
  return [
    EVENT_NAME + ' · ' + EVENT_WHEN,
    EVENT_WHERE
  ];
}

/* The client's mails greet by first name. A player field holds a full name, so
   the first word is the closest thing to one; a single-word name is its own
   first name, and an empty field falls back to the neutral greeting. */
function firstName_(full) {
  return String(full || '').trim().split(/\s+/)[0] || '';
}

/* Shortened to match orderMail_ (client, 2026-08-09): the payment ask moves up
   to just under the greeting — it is the one thing the reader must act on —
   and everything that only reassured ("helemaal in orde", "wij hebben er zin
   in", "laat gerust iets weten") is gone, along with the emoji and the
   contact line. The "inschrijvingsgeld: €44" line went with it: payBlock_
   already states the amount twice. */
function registerMail_(entry) {
  var who = [entry.player1, entry.player2].filter(Boolean).join(' & ');
  var voornaam = firstName_(entry.player1);
  return {
    to: entry.email,
    /* No " · CHAMPETOETERS & FRIENDS" tail: the sender already reads as the
       event (sendMail_ passes `name: EVENT_NAME`), so the suffix only pushed
       the useful half of the subject off a phone's screen. */
    subject: 'Inschrijving ontvangen',
    lines: [
      voornaam ? 'Hallo ' + voornaam + ',' : 'Hallo,',
      '',
      'Goed nieuws! Jullie inschrijving voor het padeltornooi van ' + EVENT_NAME +
        ' is goed ontvangen.',
      '',
      'Betaling'
    ].concat(payBlock_(TEAM_PRICE, 'inschrijving', entry.teamName || who), [
      '',
      'We kijken er alvast naar uit om jullie te verwelkomen.',
      'Als deelnemer krijg je van ons sowieso:',
      '• Een welkomstticket',
      '• Padelballen',
      '• Een gratis drankje',
      '',
      'Het speelschema en de praktische info ontvangen jullie later in een aparte mail.',
      '',
      'Wil je ondertussen niets missen? Volg ' + EVENT_NAME + ' op Instagram:',
      INSTAGRAM_URL,
      'Daar delen we alle updates en nieuwtjes rond het event.',
      'Supporters kunnen hun toegangsticket kopen via ' + TICKETS_URL,
      '',
      'Bedankt voor je inschrijving en tot dan!',
      'Team ' + EVENT_NAME,
      ''
    ], eventLines_())
  };
}

/* Wording per the client's template (Mails champetoeters.pdf, p.1). That
   template asks for the buyer's own name as mededeling, but no buyer name is
   collected (client, r11) — the names ON the tickets are the only names an
   order has, so those are what identifies the transfer.
   Shortened 2026-08-09: no "we hebben je bestelling ontvangen" preamble, no
   separate total (payBlock_ already states the amount twice), no emoji, and no
   contact line — only the where/when footer. */
function orderMail_(order) {
  var tickets = parseTickets_(order.tickets);
  /* One line per ticket, named: the buyer has to be able to check that the
     right person is on the right formula before they transfer anything. */
  var lines = tickets.map(function (t) {
    return '  · ' + t.holder + ' — ' + t.label + ' (€' + t.price + ')';
  });
  var mededeling = tickets.map(function (t) { return t.holder; }).join(', ');
  var pay = payBlock_(order.amount, 'bestelling', mededeling);
  /* No name in the greeting: the only names in an order are the ones ON the
     tickets, and whoever ordered may be none of them. Greeting them by the
     first ticket holder would address the mail to the wrong person. */
  return {
    to: order.email,
    subject: 'Je open air tickets',   /* no event suffix — see registerMail_ */
    lines: [
      'Hallo,',
      '',
      'Bedankt voor je bestelling voor ' + EVENT_NAME + '!',
      '',
      'Jouw bestelling'
    ].concat(lines, [
      '',
      'Betaling'
    ], pay, [
      '',
      'Zodra we je betaling hebben ontvangen, is je bestelling volledig in orde.',
      '',
      'Op de dag van het event ontvang je bij aankomst wat inbegrepen is in de door jou',
      'gekozen formule. Hou deze bevestigingsmail daarom bij de hand.',
      '',
      'Wil je ondertussen niets missen? Volg ' + EVENT_NAME + ' op Instagram:',
      INSTAGRAM_URL,
      'Daar delen we alle updates en nieuwtjes rond het event.',
      '',
      'Bedankt voor je bestelling en tot dan!',
      'Team ' + EVENT_NAME,
      ''
    ], eventLines_())
  };
}

function escHtml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* The naive HTML twin of the plain-text body: same lines, <br> between them.
   The venue line is the exception — it goes out as a real link to the club's
   Maps listing. Left bare, iOS/Gmail detect it themselves and hand their guess
   (including the "TC Leiemeers, " prefix, which is a POI name and not part of
   the postal address) to a geocoder that drops the pin somewhere else. An
   anchor stops the detector guessing; the visible text is unchanged. */
function mailHtml_(lines) {
  return '<p>' + lines.map(function (line) {
    var safe = escHtml_(line);
    return line === EVENT_WHERE
      ? '<a href="' + escHtml_(VENUE_MAP_URL) + '">' + safe + '</a>'
      : safe;
  }).join('<br>') + '</p>';
}

/* A mail that bounces (quota, bad address) must not lose the entry: the row is
   already written and the failure is logged. */
/* Returns whether the mail actually left: the response carries it as `mailed`
   so the confirmation screen never claims a mail that died on the quota. The
   entry itself stands either way — the screen shows every payment detail. */
/* Run straight from the editor (Run ▸ mailQuota) to read the mail budget
   without going through the web app. Same number as admin op "mailQuota".
   NOTE what the reading means: Apps Script grants 100 recipients/day to
   consumer accounts AND to Google Workspace accounts STILL IN TRIAL, and 1500
   to a converted paid Workspace. So a reading at or under 100 on a paid plan
   points at the subscription not having left trial, not at your usage. */
function mailQuota() {
  var left = MailApp.getRemainingDailyQuota();
  Logger.log('sender:    ' + Session.getEffectiveUser().getEmail());
  Logger.log('remaining: ' + left);
  Logger.log(left > 100
    ? 'cap is 1500 — paid Workspace, out of trial'
    : 'cap is 100 unless mail already went out today — consumer or TRIAL Workspace');
  return left;
}

/* GmailApp, NOT MailApp. MailApp's relay accepts a message from this account
   and never transmits it: sendEmail returns without throwing, a copy is filed
   back into the sender's own mailbox (Delivered-To: event@champetoeters.be on
   a mail addressed to gmail.com), no bounce is raised, and the recipient — on
   Gmail or anywhere else — gets nothing. GmailApp sends through the account's
   own Gmail instead, the same path a hand-written mail takes, which arrives.
   Verified 2026-08-09. Costs a broader OAuth scope: after pasting this, run
   any function once in the editor to grant it, THEN redeploy. */
function sendMail_(mail) {
  try {
    /* No replyTo: replies go to the account this script runs under — the
       event's own address. */
    GmailApp.sendEmail(mail.to, mail.subject, mail.lines.join('\n'), {
      name: EVENT_NAME,
      htmlBody: mailHtml_(mail.lines)
    });
    /* Early warning in the log tab: past the allowance every further
       confirmation is lost (the row still stands, the screen still tells the
       truth). Logged, not thrown — a low budget must never fail a booking. */
    var left = MailApp.getRemainingDailyQuota();
    if (left <= MAIL_QUOTA_WARN) log_('mail-quota-low', left + ' left today');
    return true;
  } catch (err) {
    log_('mail-failed', mail.to + ': ' + (err && err.message ? err.message : err));
    return false;
  }
}

/* ------------------------------------------------------------- public acts */

/* Script properties REGISTER_OPEN / ORDERS_OPEN: set to "false" to close a
   flow (the site then reads "nog niet open"); anything else, or unset, is
   open. Read at runtime, so flipping them needs NO redeploy. */
/* Idempotency: a retried submit carries the same clientRef, and the reply is
   the ORIGINAL result — never a second row or a second mail. Apps Script's
   response redirect is measurably flaky (~1 in 10 lost), so the client retries;
   this is what makes that safe. */
function cleanToken_(v) {
  return String(v == null ? '' : v).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
}
function replay_(rows, token) {
  if (!token) return null;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].clientRef || '') === token) return rows[i];
  }
  return null;
}

function flagOpen_(key) {
  return String(props_().getProperty(key) || '').trim().toLowerCase() !== 'false';
}

function actHealth_() {
  return {
    ok: true,
    register: flagOpen_('REGISTER_OPEN') && freeSlots_(registrations_()).length > 0,
    orders: flagOpen_('ORDERS_OPEN')
  };
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
  PUBLISH_ = true;   /* every mutation republishes the static state */
  try { CacheService.getScriptCache().remove(STATE_CACHE_KEY); } catch (err) { /* noop */ }
}

function buildState_() {
  var regs = registrations_();
  return {
    ok: true,
    /* The open/closed flags ride along so the pages can answer "is this open?"
       from the static file too — no per-visitor call to this script. The
       flags are re-published on every mutation; after flipping REGISTER_OPEN /
       ORDERS_OPEN in Script properties, run authorize() once to push them. */
    register: flagOpen_('REGISTER_OPEN') && freeSlots_(regs).length > 0,
    orders: flagOpen_('ORDERS_OPEN'),
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
    clientRef: cleanToken_(body.clientRef),
    teamName: clean_(body.teamName, 40),
    player1: clean_(body.player1, 60),
    player2: clean_(body.player2, 60),
    email: cleanEmail_(body.email),
    phone: clean_(body.phone, 40),
    /* Stored as the Dutch label, resolved from the allow-list above. An
       unknown key is not coerced to a default — it fails the whole entry,
       because silently filing a team under the wrong niveau is worse than
       refusing it. */
    teamType: TEAM_TYPES[String(body.teamType || '')] || '',
    level: LEVELS[String(body.level || '')] || '',
    at: new Date().toISOString(),
    paid: !!paid
  };
  if (entry.teamName.length < 2 || !hasLetter_(entry.teamName)) return null;
  if (!entry.player1 || !entry.player2) return null;
  if (!hasLetter_(entry.player1) || !hasLetter_(entry.player2)) return null;
  if (!isEmail_(entry.email)) return null;
  if (!isPhone_(entry.phone)) return null;
  if (!entry.teamType || !entry.level) return null;
  return entry;
}

/* Same deal for order / addOrder. Every ticket in the basket carries the name
   of the person it is for, and its own paid flag. */
function cleanOrder_(body, paidAll) {
  var list = Array.isArray(body.tickets) ? body.tickets : null;
  if (!list || !list.length || list.length > MAX_TICKETS) return null;

  var tickets = [];
  for (var i = 0; i < list.length; i++) {
    var t = list[i] && typeof list[i] === 'object' ? list[i] : {};
    var spec = TICKET_TYPES[String(t.type || '')];
    if (!spec) return null;                       /* unknown formula → refuse */
    var holder = clean_(t.holder, 60);
    if (holder.length < 2 || !hasLetter_(holder)) return null;
    tickets.push({
      holder: holder,
      type: String(t.type),
      label: spec.label,
      price: spec.price,                          /* the server's price, always */
      paid: !!paidAll
    });
  }

  /* No buyer name is asked or inferred (client, r11). The person ordering may
     be none of the ticket holders — paying for other people is normal here —
     so guessing one from the basket would put the wrong name on the mail and
     in the Sheet. An e-mail to send the confirmation to is all that is
     needed; the order's own `ref` identifies it. A `name` sent by an older
     client is accepted and ignored. */
  var order = {
    ref: '',
    clientRef: cleanToken_(body.clientRef),
    email: cleanEmail_(body.email),
    tickets: JSON.stringify(tickets),
    summary: summaryOf_(tickets),
    amount: amountOf_(tickets),
    at: new Date().toISOString()
  };
  if (!isEmail_(order.email)) return null;
  return order;
}

function amountOf_(tickets) {
  var sum = 0;
  tickets.forEach(function (t) { sum += Number(t.price) || 0; });
  return sum;
}

/* "Jan Peeters — Soda of pint · An Maes — Enkel toegang". For the human
   reading the Sheet; /admin/ renders from the tickets array itself. */
function summaryOf_(tickets) {
  return tickets.map(function (t) {
    var spec = TICKET_TYPES[t.type];
    return t.holder + ' — ' + ((spec && spec.short) || t.label);
  }).join(' · ');
}

function actRegister_(body) {
  if (!flagOpen_('REGISTER_OPEN')) return fail_('closed');
  var entry = cleanEntry_(body, false);
  if (!entry) return fail_('bad-request');

  var mail = null;
  var res = withLock_(function () {
    var regs = registrations_();
    var seen = replay_(regs, entry.clientRef);
    if (seen) return { ok: true, reference: seen.ref, teamId: seen.teamId, amount: TEAM_PRICE };
    var free = freeSlots_(regs, entry.teamType);
    /* Before the e-mail cap, so a woman's team that is one too many hears the
       reason it can act on rather than the generic retry message. The pool
       check backs up the tally: six dames slots, six teams, either way full. */
    if (entry.teamType === TEAM_TYPES.vrouwen && (womenFull_(regs) || !free.length)) {
      return fail_('women-full');
    }
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

  /* A replay answers WITHOUT `mailed` (the attempt belonged to the original
     call); the client treats absent as sent — only an explicit false switches
     the confirmation copy. */
  if (mail) res.mailed = sendMail_(mail);
  return res;
}

function actOrder_(body) {
  if (!flagOpen_('ORDERS_OPEN')) return fail_('closed');
  var order = cleanOrder_(body, 0);
  if (!order) return fail_('bad-request');

  var mail = null;
  var res = withLock_(function () {
    var rows = orders_();
    var seen = replay_(rows, order.clientRef);
    if (seen) return { ok: true, reference: seen.ref, amount: seen.amount };
    if (overLimit_(rows, order.email)) return fail_('too-many');

    order.ref = nextRef_('TKT', rows);
    append_('orders', order);
    log_('order', order.ref + ' x' + parseTickets_(order.tickets).length + ' ' + order.email);
    dropStateCache_();
    mail = orderMail_(order);
    return { ok: true, reference: order.ref, amount: order.amount };
  });

  if (mail) res.mailed = sendMail_(mail);   /* see actRegister_ */
  return res;
}

/* -------------------------------------------------------------------- admin */

function actAdmin_(body) {
  var expected = String(props_().getProperty('ADMIN_PASSWORD') || '');
  if (!expected || String(body.password || '') !== expected) return fail_('unauthorized');
  var op = String(body.op || '');

  if (op === 'login') return { ok: true };

  /* Mail budget. GmailApp and MailApp draw on ONE shared daily allowance, so
     MailApp.getRemainingDailyQuota() reports it even though we send with
     GmailApp. `remaining` is what is LEFT today, not what was used — Apps
     Script exposes no used-counter and no reset clock (it rolls over on a
     rolling 24h, not at midnight). */
  if (op === 'mailQuota') {
    return {
      ok: true,
      remaining: MailApp.getRemainingDailyQuota(),
      sender: Session.getEffectiveUser().getEmail()
    };
  }

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

  /* One named ticket at a time: with four prices in one basket, "3 of 4 paid"
     says nothing about how much came in. seq is 1-based, as /admin/ shows it. */
  if (op === 'setTicketPaid') {
    var ref = String(body.ref || '');
    var seq = Math.trunc(Number(body.seq));
    if (!Number.isFinite(seq)) return fail_('bad-request');
    var paidFlag = !!body.paid;
    return withLock_(function () {
      var order = orders_().filter(function (o) { return o.ref === ref; })[0];
      if (!order) return fail_('not-found');
      if (seq < 1 || seq > order.tickets.length) return fail_('bad-request');
      var list = order.tickets.map(function (t, i) {
        return {
          holder: t.holder, type: t.type, label: t.label, price: t.price,
          paid: (i === seq - 1) ? paidFlag : t.paid
        };
      });
      setCell_('orders', order.__row, 'tickets', JSON.stringify(list));
      log_('setTicketPaid', ref + '#' + seq + ' ' + paidFlag);
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
      var seen = replay_(regs, newReg.clientRef);
      if (seen) return { ok: true, reference: seen.ref, teamId: seen.teamId };
      var free = freeSlots_(regs, newReg.teamType);
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

  /* The organiser selling at the door: same validation as the public action,
     no caps, no mail. `paid` marks the WHOLE basket paid — cash in hand. */
  if (op === 'addOrder') {
    var newOrder = cleanOrder_(body, !!body.paid);
    if (!newOrder) return fail_('bad-request');
    return withLock_(function () {
      var rows = orders_();
      var seen = replay_(rows, newOrder.clientRef);
      if (seen) return { ok: true, reference: seen.ref };
      newOrder.ref = nextRef_('TKT', rows);
      append_('orders', newOrder);
      log_('addOrder', newOrder.ref + ' ' + newOrder.summary);
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

