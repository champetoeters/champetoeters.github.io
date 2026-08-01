/* tickets.js — one product: how many, who you are, one button.
 * Owned by: flows builder.
 *
 * Four views, each fitting one phone screen:
 *   how many + naam + e-mail
 *     → POST { action:'order', … } (ChampLive, backend/API.md)
 *     → payment panel (js/payinfo.js: bedrag, IBAN, mededeling, EPC QR)
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
 *
 * ?state=filled|pay|success renders a view locally for screenshots (BRIEF §0
 * rule 8). It never touches the network.
 */

window.Sections = window.Sections || {};

window.Sections.tickets = (() => {
  'use strict';

  /* "€12", never "€ 12": one euro format across the site (register, the payment
     panel, the mail) and this file used to be the one with a space in it. */
  const EUR = n => '€' + n.toLocaleString('nl-BE');
  const MAX_QTY = 8;
  /* Mirrors the server's clean() so the page accepts exactly what the server
     will keep (BRIEF §0.11) — @ included: it is legal there, and stripping it
     silently rewrote names the server would have stored intact. */
  const NAME_BAD = /[^\p{L}\p{N} .,'’&@+()/-]/gu;
  const NAME_LETTER = /\p{L}/u;

  /* Every word the page says. Dutch, plain. */
  const COPY = {
    name:      'Open air ticket',
    gets:      'Alle wedstrijden en alle dj\'s, tot 02:00.',
    buy:       'Tickets reserveren',
    off:       'Ticketverkoop nog niet open',
    sending:   'Versturen…',
    errName:   'Vul je naam in.',
    errShort:  'Naam is te kort.',
    errLetter: 'Gebruik gewone letters.',
    errMail:   'Vul je e-mailadres in.',
    errMailOk: 'Controleer je e-mailadres.',
    failSend:  'Versturen is niet gelukt. Probeer opnieuw',
    soldOut:   'Alle tickets zijn weg. Er is niets verstuurd.',
    ticket:    'ticket',
    tickets:   'tickets'
  };

  const cfg = () => window.CHAMP_CONFIG || {};

  /* This file's own URL, so the extras it needs resolve from both
     site/tickets.html and site/preview/tickets.html. */
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

    /* The payment panel is always needed; the encoder only when there is an
       account to encode, and the live module only when there is an API. */
    const deps = [need('payinfo.js')];
    if (cfg().payment && cfg().payment.iban) deps.push(need('../vendor/qrcode.js'));
    if (cfg().apiEndpoint) deps.push(need('livedata.js'));
    await Promise.all(deps);

    const D = (data && data.tickets) || (window.GlasData && window.GlasData.tickets) || [];
    const event = (data && data.event) || (window.GlasData && window.GlasData.event) || {};

    /* One product. A second entry in the data would still buy the first one
       rather than growing a picker back. */
    const T = D[0] || { price: 12, remaining: 999 };
    const cap = Math.max(1, Math.min(MAX_QTY, T.remaining || MAX_QTY));

    const $ = sel => root.querySelector(sel);

    let qty = 1;
    let salesOpen = false;   // what ?action=health said about ticket sales
    let frozen = false;      // ?state= preview
    let busy = false;

    const liveEl = $('#tk-live');
    const say = msg => { liveEl.textContent = ''; window.setTimeout(() => { liveEl.textContent = msg; }, 60); };

    /* ---- 1. what the ticket is ------------------------------------------- */

    $('#tk-title').textContent = COPY.name;
    /* The exact same date-and-place line as the register page (client). */
    $('#tk-when').textContent =
      (event.dateDisplay || 'ZA 5 SEPT 2026') + ' · ' + (event.venue || 'TC Leiemeers');
    root.querySelector('.tk__amt').textContent = String(T.price);
    $('#tk-gets').textContent = COPY.gets;

    /* ---- 2. how many ------------------------------------------------------ */

    const qtyEl    = $('#tk-qty');
    const payBtn   = $('#tk-pay');
    const payAmt   = $('#tk-pay-amt');
    const payLabel = $('#tk-pay-label');
    const nameEl   = $('#tk-name');
    const emailEl  = $('#tk-email');
    const noticeEl = $('#tk-notice');
    const stepper  = $('#tk-stepper');
    const minusBtn = stepper.querySelector('[data-delta="-1"]');
    const plusBtn  = stepper.querySelector('[data-delta="1"]');

    const total = () => T.price * qty;
    const units = n => (n === 1 ? COPY.ticket : COPY.tickets);

    function paint() {
      qtyEl.textContent = String(qty);
      payAmt.textContent = EUR(total());
      minusBtn.disabled = qty <= 1;
      plusBtn.disabled = qty >= cap;
      payBtn.setAttribute('aria-label', salesOpen
        ? COPY.buy + ', ' + qty + ' ' + units(qty) + ', ' + EUR(total())
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
      paint();
    }

    stepper.addEventListener('click', e => {
      const btn = e.target.closest('.tk-stepper__btn');
      if (!btn || btn.disabled) return;
      qty = Math.min(cap, Math.max(1, qty + Number(btn.dataset.delta)));
      paint();
      say(qty + ' ' + units(qty) + ', ' + EUR(total()) + '.');
    });

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

    /* Same three rules the server applies, in the same order (BRIEF §0.11):
       something, at least two characters, at least one letter. */
    function checkName(report) {
      const v = nameEl.value.trim();
      const msg = !v ? COPY.errName
                : v.length < 2 ? COPY.errShort
                : !NAME_LETTER.test(v) ? COPY.errLetter : '';
      if (report || !msg) setErr(nameEl, $('#tk-name-err'), msg);
      return !msg;
    }

    function checkEmail(report) {
      const v = emailEl.value.trim();
      const msg = !v ? COPY.errMail
                : !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v) ? COPY.errMailOk : '';
      if (report || !msg) setErr(emailEl, $('#tk-email-err'), msg);
      return !msg;
    }

    function notice(msg) {
      noticeEl.textContent = msg;
      noticeEl.hidden = !msg;
      if (msg) say(msg);
    }
    const clearNotice = () => { if (!noticeEl.hidden) notice(''); };

    nameEl.addEventListener('input', () => {
      const clean = nameEl.value.replace(NAME_BAD, '');
      if (clean !== nameEl.value) nameEl.value = clean;
      clearNotice();
      if (nameEl.hasAttribute('aria-invalid')) checkName(true);
    });
    emailEl.addEventListener('input', () => {
      clearNotice();
      if (emailEl.hasAttribute('aria-invalid')) checkEmail(true);
    });
    nameEl.addEventListener('blur', () => checkName(true));
    emailEl.addEventListener('blur', () => checkEmail(true));
    nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') emailEl.focus(); });
    emailEl.addEventListener('keydown', e => { if (e.key === 'Enter') payBtn.click(); });

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
      const okN = checkName(true);
      const okE = checkEmail(true);
      if (!okN || !okE) { (okN ? emailEl : nameEl).focus(); return; }
      placeOrder();
    });

    /* One idempotency token per order: kept across retries so a lost answer
       can never order twice; a new order (after success) gets a new token. */
    let orderToken = null;

    /* The server owns the price and the reference; the page only says how many. */
    async function placeOrder() {
      busy = true;
      if (!orderToken) {
        orderToken = (window.ChampLive && window.ChampLive.token)
          ? window.ChampLive.token()
          : 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
      }
      notice('');
      setView('processing');
      say(COPY.sending);

      try {
        const body = await window.ChampLive.post({
          action:    'order',
          clientRef: orderToken,
          name:      nameEl.value.trim(),
          email:     emailEl.value.trim(),
          quantity:  qty
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

    function showPay(body) {
      orderToken = null;   /* this order is in; the next one is its own */
      /* The mededeling is the BUYER'S NAME — that is how the organisers match
         a transfer to an order. The server's TKT-nn stays internal. */
      const mededeling = nameEl.value.trim();
      const amount = (body && typeof body.amount === 'number') ? body.amount : total();
      paidAmount = amount;

      setView('pay');
      const panel = window.PayInfo
        ? window.PayInfo.render($('#tk-pay-panel'), { amount: amount, mededeling: mededeling, kind: 'order' })
        : null;

      $('#tk-pay-ok').onclick = () => showDone(mededeling);

      if (panel && panel.title && !frozen) panel.title.focus();
      say('Gereserveerd. Betalen: ' + EUR(amount) + '.');
    }

    /* ---- 7. reserved ------------------------------------------------------ */

    function showDone(mededeling) {
      setView('done');

      const recap = $('#tk-done-recap');
      recap.textContent = qty + ' ' + units(qty) + '.';

      /* The payment view is gone; its three facts are not. One line: bedrag ·
         rekening · mededeling (payinfo.js owns the wording). */
      const payLine = $('#tk-done-pay');
      const txt = (window.PayInfo && typeof window.PayInfo.recap === 'function')
        ? window.PayInfo.recap({ amount: paidAmount || total(), mededeling: mededeling })
        : '';
      payLine.textContent = txt;
      payLine.hidden = !txt;

      $('#tk-done-contact').textContent =
        [cfg().contactEmail, cfg().contactPhone].filter(Boolean).join(' · ');

      const title = $('#tk-done-title');
      if (!frozen) title.focus();
      say('Je tickets zijn gereserveerd. Bevestiging in je mailbox.');
    }

    /* ---- 8. boot ----------------------------------------------------------
       Closed until the API says otherwise, so an unreachable or unconfigured
       API can only ever withhold an order, never invent one. */

    setSalesOpen(false, !!cfg().apiEndpoint);

    const params = new URLSearchParams(location.search);

    /* Local preview of the rendered design (§0 rule 8): query only, no visible
       affordance, and it never reaches the network. */
    const wanted = params.get('state');
    if (wanted === 'filled' || wanted === 'pay' || wanted === 'success') {
      frozen = true;
      qty = 2;
      paint();
      nameEl.value = 'Jan Vermeulen';
      emailEl.value = 'jan@leiemeers.be';
      if (wanted === 'pay') showPay({ ok: true, reference: 'TKT-12', amount: total() });
      if (wanted === 'success') showDone('TKT-12');
    }

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
