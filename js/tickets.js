/* tickets.js — one product: how many, who you are, one button.
 * Owned by: flows builder.
 *
 * Four views, each fitting one phone screen:
 *   e-mail + one named ticket per person
 *     → POST { action:'order', … } (ChampLive, backend/API.md)
 *     → payment panel (js/payinfo.js: bedrag, IBAN — no mededeling)
 *     → gereserveerd + terug naar de startpagina.
 *
 * Liveness is decided by the API, never by a flag in the page (BRIEF §0.13):
 * CHAMP_CONFIG.health() → { orders }. orders:true plus an apiEndpoint and the
 * live module means a real order and a real confirmation; anything else leaves
 * the button on "Ticketverkoop nog niet open", and no code path in this file
 * can reach the payment or done view.
 *
 * Hard rules: no card / expiry / CVC input, no provider key in the browser, no
 * <form>. The only request this page makes is the order POST.
 */

window.Sections = window.Sections || {};

window.Sections.tickets = (() => {
  'use strict';

  /* "€12", never "€ 12": one euro format across the site (register, the payment
     panel, the mail) and this file used to be the one with a space in it. */
  const EUR = n => '€' + n.toLocaleString('nl-BE');
  const MAX_TICKETS = 25;
  /* Mirrors the server's clean() so the page accepts exactly what the server
     will keep (BRIEF §0.11) — @ included: it is legal there, and stripping it
     silently rewrote names the server would have stored intact. */
  const NAME_BAD = /[^\p{L}\p{N} .,'’&@+()/-]/gu;
  const NAME_LETTER = /\p{L}/u;

  /* Every word the page says. Dutch, plain. */
  const COPY = {
    name:      'Open air ticket',
    /* No explainer under the title (client): the four priced formulas in the
       picker say what the ticket is, and the paragraph only repeated them. */
    buy:       'Tickets reserveren',
    off:       'Ticketverkoop nog niet open',
    sending:   'Versturen…',
    errShort:  'Naam is te kort.',
    errLetter: 'Gebruik gewone letters.',
    errMail:   'Vul je e-mailadres in.',
    errMailOk: 'Controleer je e-mailadres.',
    failSend:  'Versturen is niet gelukt. Probeer opnieuw',
    soldOut:   'Alle tickets zijn weg. Er is niets verstuurd.',
    ticket:    'ticket',
    tickets:   'tickets',
    holder:    'Op naam van',
    formula:   'Formule',
    errHolder: 'Vul de naam in van wie dit ticket gebruikt.',
    addMore:   '+ Nog een ticket',
    full:      'Meer dan ' + MAX_TICKETS + ' tickets in één bestelling gaat niet. ' +
               'Plaats een tweede bestelling.',
    remove:    'Dit ticket verwijderen'
  };

  const cfg = () => window.CHAMP_CONFIG || {};

  /* This file's own URL, so the extras it needs resolve however the page
     itself is routed. */
  const BASE = (() => {
    const me = document.currentScript;
    try { if (me && me.src) return me.src; } catch (e) { /* noop */ }
    return null;
  })();

  /* app.js only loads js/<section>.js. A failure resolves anyway —
     not-connected is the safe direction. */
  function need(rel) {
    let src = rel;
    try { if (BASE) src = new URL(rel, BASE).href; } catch (e) { /* noop */ }
    let s = document.querySelector('script[data-champ-src="' + rel + '"]');
    if (!s) {
      s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.dataset.champSrc = rel;
      document.head.appendChild(s);
    } else if (s.dataset.champDone === '1') {
      return Promise.resolve();
    }
    return new Promise(done => {
      const mark = () => { s.dataset.champDone = '1'; done(); };
      s.addEventListener('load', mark, { once: true });
      s.addEventListener('error', mark, { once: true });
    });
  }

  /* ======================================================================== */

  async function init(root, data) {
    await need('config.js');

    /* The payment panel is always needed; the live module only when there is
       an API. */
    const deps = [need('payinfo.js')];
    if (cfg().apiEndpoint) deps.push(need('livedata.js'));
    await Promise.all(deps);

    const D = (data && data.tickets) || (window.GlasData && window.GlasData.tickets) || [];
    const event = (data && data.event) || (window.GlasData && window.GlasData.event) || {};

    /* The four formulas, in the order data/tickets.json lists them — cheapest
       first, so the picker opens on the entry-level choice. */
    const TYPES = D.filter(t => t && t.id && typeof t.price === 'number');
    const specOf = id => TYPES.filter(t => t.id === id)[0] || null;

    const $ = sel => root.querySelector(sel);

    /* The basket: one entry per ticket, each on a person. */
    let rows = [];
    let seq = 0;
    let salesOpen = false;   // what ?action=health said about ticket sales
    let busy = false;

    const liveEl = $('#tk-live');
    const say = msg => { liveEl.textContent = ''; window.setTimeout(() => { liveEl.textContent = msg; }, 60); };
    const payBtn   = $('#tk-pay');
    const payAmt   = $('#tk-pay-amt');
    const payLabel = $('#tk-pay-label');
    const emailEl  = $('#tk-email');
    const noticeEl = $('#tk-notice');
    const rowsEl   = $('#tk-rows');
    const addBtn   = $('#tk-add');
    const totEl    = $('#tk-tot');

    /* ---- 1. what the ticket is -------------------------------------------
       The header is written here, not typed into the fragment: the price is
       the cheapest formula in the data, so adding or repricing a formula moves
       it without anyone remembering to edit the markup. */

    $('#tk-title').textContent = COPY.name;
    /* The exact same date-and-place line as the register page (client). */
    $('#tk-when').textContent =
      (event.dateDisplay || 'ZA 5 SEPT 2026') + ' · ' + (event.venue || 'TC Leiemeers');
    const cheapest = TYPES.reduce((lo, t) => (lo === null || t.price < lo ? t.price : lo), null);
    root.querySelector('.tk__amt').textContent = String(cheapest === null ? '' : cheapest);

    const total = () => rows.reduce((sum, r) => {
      const spec = specOf(r.type);
      return sum + (spec ? spec.price : 0);
    }, 0);
    const units = n => (n === 1 ? COPY.ticket : COPY.tickets);

    /* ---- 2b. the basket --------------------------------------------------
       Rows are state, not DOM: a row is rebuilt from `rows` after every add and
       remove, so removing the middle of five tickets cannot leave the wrong
       name sitting in the wrong <input>. Values are read back into the state on
       every input, so a rebuild never loses a keystroke. */

    /* The client's full wording, price FIRST (client). Every option starts with
       "Toegangsticket" on purpose — all four ARE the same entry ticket — so the
       price is what tells them apart, and it leads for a second reason: these
       are long enough to be clipped by a narrow <select>, and a clipped price
       is the one part that must never be in doubt. */
    const optionsHtml = sel => TYPES.map(t =>
      '<option value="' + t.id + '"' + (t.id === sel ? ' selected' : '') + '>' +
      EUR(t.price) + ' · ' + esc(t.name || t.short) + '</option>').join('');

    function esc(v) {
      return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function addRow(holder) {
      if (rows.length >= MAX_TICKETS) { notice(COPY.full); return false; }
      rows.push({
        id: 'tk-r' + (++seq),
        holder: holder || '',
        type: TYPES.length ? TYPES[0].id : '',
        err: ''
      });
      return true;
    }

    function renderRows() {
      rowsEl.innerHTML = rows.map((r, i) => {
        const nid = r.id + '-n';
        const fid = r.id + '-f';
        return '<li class="tk-row" data-row="' + r.id + '">' +
          '<div class="tk-row__fields">' +
            '<div class="glass-field tk-row__name">' +
              /* No "… 1" / "… 2" counter: the rows are already visibly stacked
                 and the number read as a ticket number (client, r11). */
              '<label class="glass-label" for="' + nid + '">' +
                COPY.holder + '</label>' +
              '<input class="glass-input" id="' + nid + '" type="text" maxlength="60"' +
                ' autocomplete="off" data-f="holder" value="' + esc(r.holder) + '"' +
                (r.err ? ' aria-invalid="true"' : '') +
                ' aria-describedby="' + r.id + '-e">' +
              /* The error lives INSIDE the name field, not at the end of the
                 row: the only row error is about the name, and printed after
                 the formula it pointed at the wrong control — unreadable once
                 there are five rows on screen. */
              '<p class="glass-error tk-err" id="' + r.id + '-e"' + (r.err ? '' : ' hidden') + '>' +
                esc(r.err) + '</p>' +
            '</div>' +
            '<div class="glass-field tk-row__type">' +
              '<label class="glass-label" for="' + fid + '">' + COPY.formula + '</label>' +
              '<select class="glass-select" id="' + fid + '" data-f="type">' +
                optionsHtml(r.type) + '</select>' +
            '</div>' +
          '</div>' +
          /* The remove control only exists once there is more than one ticket:
             an order with zero tickets is not a state this page can be in. */
          (rows.length > 1
            ? '<button type="button" class="tk-row__x" data-act="rm"' +
              ' aria-label="' + esc(COPY.remove + ' (' + (r.holder || (i + 1)) + ')') + '">' +
              '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
              '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8"' +
              ' stroke-linecap="round"/></svg></button>'
            : '') +
        '</li>';
      }).join('');
      /* A closed shop stays closed through a re-render too: without the
         salesOpen term this only held because renderRows() happens to run
         before setSalesOpen(false, …) at boot.
         The cap does NOT disable the button — a dead control explains nothing.
         It stays live so addRow() can say why (COPY.full), which is otherwise
         unreachable copy. */
      addBtn.disabled = !salesOpen;
      paint();
    }

    /* The running total, and the same figure on the button. */
    function paint() {
      const n = rows.length;
      const amount = total();
      payAmt.textContent = EUR(amount);
      totEl.hidden = n < 2;
      if (n >= 2) totEl.textContent = n + ' ' + units(n) + ' · ' + EUR(amount);
      payBtn.setAttribute('aria-label', salesOpen
        ? COPY.buy + ', ' + n + ' ' + units(n) + ', ' + EUR(amount)
        : COPY.off);
    }

    /* Closed is the default and the safe direction: a button that cannot take
       an order must not carry a price or look like it can — .is-off takes the
       amount off it (tickets.css §3). */
    function setSalesOpen(next, pending) {
      /* pending = a LIVE build waiting for the health probe: the action label,
         disabled, no price — the text never flips "niet open" → open (client:
         that jump reads as a glitch). Closed is only ever printed as an answer. */
      salesOpen = next;
      payLabel.textContent = (next || pending) ? COPY.buy : COPY.off;
      payBtn.classList.toggle('is-off', !next && !pending);
      payBtn.classList.toggle('is-wait', !!pending);
      if (next) payBtn.removeAttribute('aria-disabled');
      else payBtn.setAttribute('aria-disabled', 'true');
      /* A closed shop must not take typing either — the fields would promise
         an order the backend will refuse. */
      rowsEl.querySelectorAll('input, select').forEach(el => { el.disabled = !next; });
      addBtn.disabled = !next;      /* the cap is explained, not disabled — see renderRows */
      emailEl.disabled = !next;
      paint();
    }

    const rowOf = el => {
      const li = el.closest('[data-row]');
      return li ? rows.filter(r => r.id === li.dataset.row)[0] : null;
    };

    rowsEl.addEventListener('input', e => {
      const r = rowOf(e.target);
      if (!r || !e.target.dataset.f) return;
      const field = e.target.dataset.f;
      if (field === 'holder') {
        const clean = e.target.value.replace(NAME_BAD, '');
        if (clean !== e.target.value) e.target.value = clean;
        r.holder = clean;
        if (r.err) { r.err = ''; setRowErr(r, ''); }
      } else {
        r.type = e.target.value;
        paint();
      }
      clearNotice();
    });

    rowsEl.addEventListener('click', e => {
      const btn = e.target.closest('[data-act="rm"]');
      if (!btn) return;
      const r = rowOf(btn);
      if (!r || rows.length <= 1) return;
      /* Focus the row that takes the deleted one's place (the last row when
         the last was deleted) — not the first, which threw someone deleting
         ticket 7 of 8 back to the top of the basket. */
      const at = rows.indexOf(r);
      rows = rows.filter(x => x !== r);
      renderRows();
      clearNotice();
      say('Ticket verwijderd. ' + rows.length + ' ' + units(rows.length) + ', ' + EUR(total()) + '.');
      const near = rows[Math.min(at, rows.length - 1)];
      const input = near && rowsEl.querySelector('#' + near.id + '-n');
      if (input) input.focus();
    });

    addBtn.addEventListener('click', () => {
      if (!addRow('')) return;
      renderRows();
      clearNotice();
      const inputs = rowsEl.querySelectorAll('input[data-f="holder"]');
      const last = inputs[inputs.length - 1];
      if (last) last.focus();
      say(rows.length + ' ' + units(rows.length) + ', ' + EUR(total()) + '.');
    });

    /* Paint one row's error without rebuilding the list — a rebuild during
       typing would take the caret with it. */
    function setRowErr(r, msg) {
      const box = rowsEl.querySelector('#' + r.id + '-e');
      const input = rowsEl.querySelector('#' + r.id + '-n');
      if (box) { box.textContent = msg || ''; box.hidden = !msg; }
      if (input) {
        if (msg) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
      }
    }

    /* ---- 3. validation ---------------------------------------------------- */

    function setErr(input, errEl, msg) {
      if (msg) {
        input.setAttribute('aria-invalid', 'true');
        errEl.textContent = msg;
        errEl.hidden = false;
      } else {
        input.removeAttribute('aria-invalid');
        errEl.hidden = true;
        errEl.textContent = '';
      }
      return !msg;
    }

    function checkEmail(report) {
      const v = emailEl.value.trim();
      const msg = !v ? COPY.errMail
                : !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v) ? COPY.errMailOk : '';
      if (report || !msg) setErr(emailEl, $('#tk-email-err'), msg);
      return !msg;
    }

    /* Every ticket needs a person on it. Same three rules as the server, in
       the same order (BRIEF §0.11): something, at least two characters, at
       least one letter. Returns the first bad row, or null.
       These names are the ONLY names the order carries. They say nothing about
       who ordered or who pays — that person need not be on any ticket, which
       is why no name is asked and none is inferred. */
    function checkRows(report) {
      let firstBad = null;
      rows.forEach(r => {
        const v = String(r.holder || '').trim();
        const msg = !v ? COPY.errHolder
                  : v.length < 2 ? COPY.errShort
                  : !NAME_LETTER.test(v) ? COPY.errLetter : '';
        if (msg && !firstBad) firstBad = r;
        if (report || !msg) { r.err = msg; setRowErr(r, msg); }
      });
      return firstBad;
    }

    function notice(msg) {
      noticeEl.textContent = msg;
      noticeEl.hidden = !msg;
      if (msg) say(msg);
    }
    const clearNotice = () => { if (!noticeEl.hidden) notice(''); };

    emailEl.addEventListener('input', () => {
      clearNotice();
      if (emailEl.hasAttribute('aria-invalid')) checkEmail(true);
    });
    emailEl.addEventListener('blur', () => checkEmail(true));
    /* Enter goes to the first ticket name, not straight to the order: the
       basket below is the rest of the form, not an optional extra. */
    emailEl.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const first = rowsEl.querySelector('input[data-f="holder"]');
      if (first) first.focus(); else payBtn.click();
    });

    /* ---- 4. views --------------------------------------------------------- */

    const views = {
      form:       root.querySelector('[data-view="form"]'),
      processing: root.querySelector('[data-view="processing"]'),
      pay:        root.querySelector('[data-view="pay"]'),
      done:       root.querySelector('[data-view="done"]')
    };

    /* .is-flow drops the sales header and the link to the other page once the
       order exists: the payment panel and the confirmation say everything, and
       the header would cost the height that keeps a view on one screen. */
    function setView(next) {
      for (const k in views) views[k].hidden = (k !== next);
      root.classList.toggle('is-flow', next === 'pay' || next === 'done');

      /* A view change wipes what the previous view said. A field error or a
         failed-send notice belongs to the form; it must not still be sitting in
         the live region behind the payment panel or the confirmation. */
      liveEl.textContent = '';
      noticeEl.textContent = '';
      noticeEl.hidden = true;

      /* The confirmation carries its own full-width way home, so the
         page-chrome "Terug" pill beside it would be a second one. */
      /* From the payment step on there is nothing to go "Terug" to — the
         order is already submitted. The pill leaves with the form. */
      if (next === 'pay' || next === 'done') document.body.dataset.champFlowDone = '1';
      else delete document.body.dataset.champFlowDone;
    }

    /* ---- 5. order --------------------------------------------------------- */

    payBtn.addEventListener('click', () => {
      if (busy) return;
      if (!salesOpen) { say(COPY.off + '.'); return; }
      const okE = checkEmail(true);
      const badRow = checkRows(true);
      if (!okE || badRow) {
        const target = !okE ? emailEl : rowsEl.querySelector('#' + badRow.id + '-n');
        if (target) target.focus();
        return;
      }
      placeOrder();
    });

    /* One idempotency token per order: kept across retries so a lost answer
       can never order twice; a new order (after success) gets a new token.
       It also survives a RELOAD (sessionStorage) — reused only when the
       retyped order MATCHES the fingerprint it was stored with, so a reload
       during "Versturen…" plus the same resubmit can never order twice, and
       a genuinely different order still gets its own token (see register.js). */
    const TOK_KEY = 'champ.tkt.token';
    const fingerprintOf = () =>
      [emailEl.value.trim(),
       rows.map(r => r.holder.trim() + ':' + r.type).join('|')].join('');
    let orderToken = null;

    /* The server owns the price and the reference; the page only says how many. */
    async function placeOrder() {
      busy = true;
      const fp = fingerprintOf();
      if (!orderToken) {
        try {
          const kept = JSON.parse(window.sessionStorage.getItem(TOK_KEY) || 'null');
          if (kept && kept.t && kept.f === fp) orderToken = String(kept.t);
        } catch (e) { /* storage blocked → in-memory only */ }
      }
      if (!orderToken) {
        orderToken = (window.ChampLive && window.ChampLive.token)
          ? window.ChampLive.token()
          : 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
      }
      try {
        window.sessionStorage.setItem(TOK_KEY, JSON.stringify({ t: orderToken, f: fp }));
      } catch (e) { /* noop */ }
      notice('');
      setView('processing');
      say(COPY.sending);

      try {
        const body = await window.ChampLive.post({
          action:    'order',
          clientRef: orderToken,
          email:     emailEl.value.trim(),
          tickets:   rows.map(r => ({ holder: r.holder.trim(), type: r.type }))
        }, { retries: 2 });
        busy = false;
        if (body && body.ok) { showPay(body); return; }
        setView('form');
        notice(body && body.error === 'full' ? COPY.soldOut : failText());
        payBtn.focus();
      } catch (err) {
        busy = false;
        setView('form');
        notice(failText());
        payBtn.focus();
      }
    }

    const failText = () =>
      COPY.failSend + (cfg().contactEmail ? ', of mail ' + cfg().contactEmail : '') + '.';

    /* ---- 6. how to pay ---------------------------------------------------- */

    /* What the server charged, so the confirmation can still print it once the
       payment panel is gone. */
    let paidAmount = 0;
    let mailedOk = true;   /* only an explicit mailed:false switches copy */

    function showPay(body) {
      orderToken = null;   /* this order is in; the next one is its own */
      try { window.sessionStorage.removeItem(TOK_KEY); } catch (e) { /* noop */ }
      mailedOk = !(body && body.mailed === false);
      const amount = (body && typeof body.amount === 'number') ? body.amount : total();
      paidAmount = amount;

      /* A ticket order carries NO mededeling (client, r11): no buyer name is
         asked, and the internal TKT-nn is not something a visitor is made to
         type. The named tickets — listed on the confirmation and in the mail —
         are the record. PayInfo drops the row entirely when it is empty. */
      setView('pay');
      const panel = window.PayInfo
        ? window.PayInfo.render($('#tk-pay-panel'), { amount: amount, kind: 'order' })
        : null;

      $('#tk-pay-ok').onclick = () => showDone();

      if (panel && panel.title) panel.title.focus();
      say('Gereserveerd. Betalen: ' + EUR(amount) + '.');
    }

    /* ---- 7. reserved ------------------------------------------------------ */

    function showDone() {
      setView('done');

      /* Names, not a count: whoever ordered has to be able to check that the
         right person is on the right formula before transferring anything —
         and with no mededeling asked, this list IS the record of the order. */
      const recap = $('#tk-done-recap');
      recap.textContent = rows.map(r => {
        const spec = specOf(r.type);
        return r.holder.trim() + ' — ' + (spec ? (spec.short || spec.name) : '');
      }).join(' · ');

      /* The mail sentence must be true: when the backend said the mail did
         not leave, say so — everything needed is on this screen anyway. */
      const mailEl = $('#tk-done-mail');
      if (mailEl && !mailedOk) {
        mailEl.textContent = 'De bevestigingsmail kon niet verstuurd worden. ' +
          'Hieronder staat alles wat je nodig hebt. Betaald = binnen.';
      }

      /* The payment view is gone; its facts are not. One line: bedrag ·
         rekening (payinfo.js owns the wording, and leaves out the mededeling
         when there is none). */
      const payLine = $('#tk-done-pay');
      const txt = (window.PayInfo && typeof window.PayInfo.recap === 'function')
        ? window.PayInfo.recap({ amount: paidAmount || total() })
        : '';
      payLine.textContent = txt;
      payLine.hidden = !txt;

      $('#tk-done-contact').textContent =
        [cfg().contactEmail, cfg().contactPhone].filter(Boolean).join(' · ');

      const title = $('#tk-done-title');
      title.focus();
      say(mailedOk
        ? 'Je tickets zijn gereserveerd. Bevestiging in je mailbox.'
        : 'Je tickets zijn gereserveerd. De bevestigingsmail kon niet verstuurd worden.');
    }

    /* ---- 8. boot ----------------------------------------------------------
       Closed until the API says otherwise, so an unreachable or unconfigured
       API can only ever withhold an order, never invent one. */

    /* One ticket to start with — an empty basket is not a state this page can
       be in, and "add your first ticket" is a step nobody needs. */
    addRow('');
    renderRows();

    setSalesOpen(false, !!cfg().apiEndpoint);

    const probe = typeof cfg().health === 'function'
      ? cfg().health()
      : Promise.resolve({ orders: false });

    return probe.then(h => {
      setSalesOpen(!!(h && h.orders) && !!cfg().apiEndpoint &&
        !!(window.ChampLive && typeof window.ChampLive.post === 'function'));
    });
  }

  return { init };
})();
