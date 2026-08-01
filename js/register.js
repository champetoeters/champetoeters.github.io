/* register.js — CHAMPETOETERS & FRIENDS · team entry.
   Owned by: flows builder.

   Four fields, one button, all copy Dutch. Every number comes from
   data/event.json → teamEntry; nothing is hard-coded.

   The flow is three views, each fitting one phone screen:
     form → POST action=register (ChampLive) → payment panel → confirmation.

   A fourth view stands in for the form when the draw is full: no fields, one
   panel, and the one thing still possible (come and watch). It is reached only
   from a live API — the count at load, or a `full` answer to a submit.

   Liveness (BRIEF §0 item 13): CHAMP_CONFIG.health() decides. register:true
   plus an apiEndpoint and the live module means a real POST and a real
   confirmation; anything else — feature off, API unreachable, config missing —
   leaves the button on "Inschrijvingen nog niet open" and there is no code path
   to the payment or confirmation views. The page never fakes a confirmation.

   Sanitising (item 11): scrub() mirrors the server's clean() exactly, so what
   the field shows is what the server will store.

   Debug hooks, invisible to a visitor (§0 rule 8):
   ?state=filled | error | pay | success — rendered locally, never a request. */

window.Sections = window.Sections || {};

/* Resolved against this file's own URL so it works from site/register.html and
   from site/preview/register.html without either page knowing about it. */
var REG_BASE = (function () {   /* var: a double-injected classic script must not
     throw a redeclaration SyntaxError. */
  const me = document.currentScript;
  try { if (me && me.src) return me.src; } catch (e) { /* noop */ }
  return null;
})();

/* app.js only loads js/<section>.js, so the section pulls in what it needs
   itself. A failure resolves anyway — not-connected is the safe direction. */
function regNeed(rel) {
  let src = rel;
  try { if (REG_BASE) src = new URL(rel, REG_BASE).href; } catch (e) { /* noop */ }
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

/* ---- input sanitising -----------------------------------------------------
   Kept byte-for-byte in step with the server's clean(). Letters of any script
   survive, so accents and non-Latin names are safe; control characters, bidi
   overrides, emoji and markup punctuation do not. */
const REG_CTRL = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E]/g;
const REG_DISALLOWED = /[^\p{L}\p{N} .,'\u2019&@+()/-]/gu;
const REG_LETTER = /\p{L}/u;
const REG_MAX = { 'team-name': 40, 'p1-name': 60, 'p2-name': 60, 'reg-email': 160, 'reg-tel': 40 };

/* collapse=false while typing, so a space the visitor just pressed survives. */
function scrub(value, max, collapse) {
  let s = String(value == null ? '' : value).replace(REG_CTRL, '').replace(REG_DISALLOWED, '');
  if (collapse) s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, max);
}

/* Emails keep their legal specials (_ ! % # etc. are valid in a local part —
   the name allow-list was silently corrupting them). Mirrors the server's
   cleanEmail(): control chars and whitespace out, nothing else touched. */
function scrubEmail(value) {
  return String(value == null ? '' : value).replace(REG_CTRL, '').replace(/\s+/g, '').slice(0, 160);
}

window.Sections.register = {
  async init(root, data) {
    if (!root || root.dataset.regReady === '1') return;
    root.dataset.regReady = '1';

    await regNeed('config.js');
    const CFG = window.CHAMP_CONFIG || {};

    /* The payment panel is always needed; the encoder only when there is an
       account to encode, and the live module only when there is an API. */
    const deps = [regNeed('payinfo.js')];
    if (CFG.payment && CFG.payment.iban) deps.push(regNeed('../vendor/qrcode.js'));
    if (CFG.apiEndpoint) deps.push(regNeed('livedata.js'));
    await Promise.all(deps);

    /* ---- data ---------------------------------------------------------- */
    const D     = data || window.GlasData || {};
    const teams = D.teams || [];
    const entry = (D.event && D.event.teamEntry) || {};

    const num = (v, fallback) => (typeof v === 'number' && isFinite(v) ? v : fallback);

    const TOTAL     = num(entry.places,    teams.length);
    const TAKEN     = num(entry.confirmed, teams.filter(t => t.confirmed).length);
    const REMAINING = num(entry.open,      Math.max(0, TOTAL - TAKEN));
    const FEE       = num(entry.price, 50);
    const FEE_TXT   = '€' + FEE;

    /* The open air ticket, for the volzet panel's one way on. */
    const TICKETS   = (D.tickets && D.tickets[0]) || {};
    const TKT_TXT   = '€' + num(TICKETS.price, 12);

    /* The weekday costs the eyebrow a line on a 390px phone and says nothing
       the date does not. */
    const DATE_TXT = String((D.event && D.event.dateDisplay) || '')
      .replace(/^(mon|tue|wed|thu|fri|sat|sun)\w*\s+/i, '');

    /* ---- shorthands ---------------------------------------------------- */
    const ref  = name => root.querySelector('[data-reg="' + name + '"]');
    const byId = id => root.querySelector('#' + id);
    const esc  = s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const form      = ref('form');
    const live      = ref('live');       /* visible summary — not a live region */
    const srAlert   = ref('sr-alert');   /* off-screen role="alert"             */
    const srStatus  = ref('sr-status');  /* off-screen role="status", polite    */
    const submitBtn = ref('submit');
    const processEl = ref('processing');

    /* =====================================================================
       RENDER
       ==================================================================== */

    const EYEBROW_TXT =
      [DATE_TXT, (D.event && D.event.venue) || ''].filter(Boolean).join(' · ');
    ref('eyebrow').textContent = EYEBROW_TXT;

    /* What the fee buys, in one line. The price comes from event.json; the three
       things it includes are teamEntry.includes, said shorter than the data spells
       them out (BRIEF §0 rule 6 — plain and short beats complete). */
    ref('gets').textContent =
      FEE_TXT + ' per team — twee spelers, minstens drie wedstrijden, open air voor beiden.';

    let remaining = REMAINING;

    function paintCounts() {
      const p = ref('slots-pre');
      const n = ref('slots-n');
      const l = ref('slots-label');
      if (remaining <= 0) {
        p.hidden = true;
        n.hidden = true;
        l.textContent = 'Volzet';
      } else {
        p.hidden = false;
        n.hidden = false;
        p.textContent = 'Nog';
        n.textContent = remaining;
        l.textContent = remaining === 1 ? 'plaats' : 'plaatsen';
      }
    }
    /* With a live backend the count stays blank until the state answers —
       painting the static "Nog 2" and flipping it to "Volzet" a beat later
       reads as a glitch (client). Unwired builds paint the static figure. */
    const countIsLive = !!(CFG.apiEndpoint && window.ChampLive &&
                           typeof window.ChampLive.state === 'function');
    if (!countIsLive) paintCounts();

    /* =====================================================================
       VIEWS — one screen each. data-state drives what the section shows
       around them (register.css §6/§7); the views themselves are [hidden].
       ==================================================================== */

    const views = {
      form: root.querySelector('[data-view="form"]'),
      full: root.querySelector('[data-view="full"]'),
      pay:  root.querySelector('[data-view="pay"]'),
      done: root.querySelector('[data-view="done"]')
    };

    function setView(name) {
      Object.keys(views).forEach(k => { views[k].hidden = (k !== name); });

      /* A view change wipes what the previous view said. "3 fouten. Eerst: …"
         belongs to the form; it must not still be sitting in the live regions —
         or in the visible summary — behind the payment or the confirmation. */
      srAlert.textContent = '';
      srStatus.textContent = '';
      noticeOn = false;
      paintSummary([]);

      /* The confirmation carries its own full-width way home, so the page-chrome
         "Terug" pill beside it would be a second one (register.css §7). */
      if (name === 'done') document.body.dataset.champFlowDone = '1';
      else delete document.body.dataset.champFlowDone;
    }

    /* =====================================================================
       LIVENESS — the API decides, and it starts closed
       ==================================================================== */

    let isLive = false;
    let settled = false;      /* has the health probe answered yet? */
    let closedTxt = 'Inschrijvingen nog niet open';

    function paintButton() {
      submitBtn.textContent = isLive ? 'Schrijf ons team in · ' + FEE_TXT : closedTxt;

      /* A form that cannot be sent must not look like it can: the accent comes
         off the button and the fields go quiet with it, so nobody fills in four
         answers only to be told afterwards that nothing was sent. Only once the
         probe has answered — until then the page does not know, and taking a
         half-typed field away from someone is worse than either state. */
      const off = settled && !isLive;
      submitBtn.classList.toggle('glass-btn--primary', !off);
      submitBtn.classList.toggle('is-off', off);
      submitBtn.disabled = off;
      form.classList.toggle('is-closed', off);
      root.querySelectorAll('.reg-input').forEach(el => { el.disabled = off; });
    }
    paintButton();

    /* Not awaited: a slow or missing API must not hold up the page. Until it
       answers, the button says entries are closed — the safe direction. */
    Promise.resolve(typeof CFG.health === 'function' ? CFG.health() : null)
      .then(h => {
        isLive = !!(h && h.register) && !!CFG.apiEndpoint &&
                 !!(window.ChampLive && typeof window.ChampLive.post === 'function');
      })
      .catch(() => { isLive = false; })
      .then(() => { settled = true; paintButton(); });

    /* The place count must follow the live draw, not event.json — a build
       whose event is full may not keep promising "Nog 2 plaatsen". And a draw
       that is genuinely full does not get a form at all: only a live API can
       tell us that, which is why this lives here and not next to the probe. */
    if (countIsLive) {
      window.ChampLive.state().then(st => {
        const c = st && st.counts;
        if (!c || typeof c.registrations !== 'number' || typeof c.slots !== 'number') {
          paintCounts();               /* unusable answer → static after all */
          return;
        }
        remaining = Math.max(0, c.slots - c.registrations);
        paintCounts();
        if (remaining === 0) showFullPanel(c.slots, false);
      });
    }

    /* =====================================================================
       VALIDATION — plain Dutch, one line each
       ==================================================================== */

    const EMAIL = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

    /* Kuurne is 10 km from the French border and not far off the Dutch one, so
       a Belgian-only rule would reject the friends this form exists to reach.
       +32, +31, +33 and any other plausible number all pass, however spaced. */
    const telDigits = v => v.replace(/[\s.\-()/]/g, '');
    const TEL = /^(?:\+|00)?\d{8,15}$/;

    const nameRule = who => v => {
      const s = scrub(v, 60, true);
      if (!s) return 'Vul de naam van speler ' + who + ' in.';
      /* One character is a typo, not a name — and the confirmation mail is
         addressed to whatever is typed here. */
      if (s.length < 2) return 'Deze naam is te kort.';
      if (!REG_LETTER.test(s)) return 'Gebruik gewone letters.';
      return '';
    };

    const RULES = {
      'team-name': v => {
        const s = scrub(v, 40, true);
        if (!s) return 'Vul jullie teamnaam in.';
        if (s.length < 2) return 'Deze naam is te kort.';
        if (!REG_LETTER.test(s)) return 'Gebruik gewone letters.';
        return '';
      },
      'p1-name': nameRule(1),
      'p2-name': nameRule(2),
      'reg-email': v => {
        const s = scrubEmail(v);
        if (!s) return 'Vul je e-mailadres in.';
        return EMAIL.test(s) ? '' : 'Dit e-mailadres klopt niet.';
      },
      'reg-tel': v => {
        const s = scrub(v, 40, true);
        if (!s) return 'Vul je gsm-nummer in.';
        return TEL.test(telDigits(s)) ? '' : 'Dit gsm-nummer klopt niet.';
      }
    };
    const ORDER = ['team-name', 'p1-name', 'p2-name', 'reg-email', 'reg-tel'];

    const labelOf = el => {
      const l = root.querySelector('label[for="' + el.id + '"]');
      return l ? l.textContent.trim() : el.id;
    };

    function setError(el, msg) {
      const box = byId(el.id + '-err');
      if (msg) el.setAttribute('aria-invalid', 'true');
      else el.removeAttribute('aria-invalid');
      if (box) { box.textContent = msg || ''; box.hidden = !msg; }
    }

    function validateField(el) {
      const rule = RULES[el.id];
      if (!rule) return true;
      const msg = rule(el.value);
      setError(el, msg);
      return !msg;
    }

    /* collect(false) is a pure read: it counts what is wrong without touching
       the DOM, which is what lets the summary be recomputed on every keystroke
       without dragging errors onto fields nobody has visited yet. */
    function collect(apply) {
      const bad = [];
      ORDER.forEach(id => {
        const el  = byId(id);
        const msg = RULES[id](el.value);
        if (apply) validateField(el);
        if (msg) bad.push({ el: el, name: labelOf(el), msg: msg });
      });
      return bad;
    }

    const checkAll = () => collect(true);

    /* =====================================================================
       SUMMARY + ANNOUNCEMENTS
       Speech goes to the two off-screen regions on their own tick, so a focus
       move in the same frame cannot swallow the count.
       ==================================================================== */

    let summaryOn = false;

    function summaryText(bad) {
      if (!bad.length) return '';
      const f = bad[0];
      return bad.length === 1
        ? '1 fout. ' + f.name + ' — ' + f.msg
        : bad.length + ' fouten. Eerst: ' + f.name + ' — ' + f.msg;
    }

    /* Field errors live under their fields, never in a box above the form
       (client). The visible box is only ever a notice (volzet, network); the
       screen-reader summary still speaks on submit via speakAlert. */
    function paintSummary(bad) {
      void bad;
      live.textContent = '';                 /* .reg-live:empty hides the box */
      delete live.dataset.tone;
      summaryOn = false;
    }

    /* A message that is not about a field, so it must not be recomputed away
       by the next keystroke: it clears itself on the next input instead. */
    let noticeOn = false;
    function notice(txt) {
      live.dataset.tone = 'alert';
      live.textContent = txt;
      summaryOn = false;
      noticeOn = true;
      speakAlert(txt);
    }

    function refreshSummary() {
      if (noticeOn) return;
      if (summaryOn) paintSummary(collect(false));
    }

    function speakAlert(msg) {
      srAlert.textContent = '';
      window.setTimeout(() => { srAlert.textContent = msg; }, 150);
    }
    function speakStatus(msg) {
      srStatus.textContent = '';
      window.setTimeout(() => { srStatus.textContent = msg; }, 80);
    }

    /* =====================================================================
       WIRING
       ==================================================================== */

    /* Strip in place, then put the caret back where it was. Email inputs do
       not expose a selection, hence the guard. */
    function sanitizeInPlace(el) {
      const max = REG_MAX[el.id];
      if (!max) return;
      const cleaned = el.id === 'reg-email'
        ? scrubEmail(el.value)
        : scrub(el.value, max, false);
      if (cleaned === el.value) return;
      const at = el.selectionStart;
      const shift = el.value.length - cleaned.length;
      el.value = cleaned;
      if (typeof at === 'number') {
        const pos = Math.max(0, at - shift);
        try { el.setSelectionRange(pos, pos); } catch (e) { /* unsupported type */ }
      }
    }

    /* validate on blur, never on every keystroke */
    form.addEventListener('focusout', e => {
      if (e.target.id && RULES[e.target.id]) validateField(e.target);
      refreshSummary();
    });

    /* once a field is wrong, let it clear itself as the visitor fixes it —
       and let the summary above it drop its count in the same breath */
    form.addEventListener('input', e => {
      const el = e.target;
      sanitizeInPlace(el);
      if (noticeOn) { noticeOn = false; paintSummary([]); }
      if (el.id && RULES[el.id] && el.getAttribute('aria-invalid') === 'true') {
        validateField(el);
      }
      refreshSummary();
    });

    /* =====================================================================
       SUBMIT
       ==================================================================== */

    /* Exactly what the server will store, computed the way the server does. */
    const payload = () => ({
      teamName: scrub(byId('team-name').value, 40, true),
      player1: scrub(byId('p1-name').value, 60, true),
      player2: scrub(byId('p2-name').value, 60, true),
      email:   scrubEmail(byId('reg-email').value),
      phone:   scrub(byId('reg-tel').value, 40, true),
      submittedAt: new Date().toISOString()
    });

    function showProcessing() {
      root.dataset.state = 'processing';
      processEl.hidden = false;
      submitBtn.disabled = true;
      paintSummary([]);
      noticeOn = false;
      speakStatus('We versturen je inschrijving…');
    }

    function stopProcessing() {
      root.dataset.state = 'idle';
      processEl.hidden = true;
      submitBtn.disabled = false;
    }

    const contactLine = () =>
      [CFG.contactEmail, CFG.contactPhone].filter(Boolean).join(' · ');

    /* ---- view 2: how to pay ---------------------------------------------- */

    /* The amount the server charged, so the confirmation can still print it
       after the payment panel is gone. */
    let payAmount = FEE;
    let flowStarted = false;   /* past the form: a late count must not intrude */

    function showPay(body) {
      const refNo  = (body && (body.reference || body.ref)) || '';
      const amount = (body && typeof body.amount === 'number') ? body.amount : FEE;
      payAmount = amount;
      flowStarted = true;

      root.dataset.state = 'pay';
      processEl.hidden = true;
      setView('pay');

      const panel = window.PayInfo
        ? window.PayInfo.render(ref('pay'), { amount: amount, reference: refNo, kind: 'register' })
        : null;

      ref('pay-ok').onclick = () => showDone(refNo);

      if (panel && panel.title) panel.title.focus();
      speakStatus('Inschrijving ontvangen.' + (refNo ? ' Nummer ' + refNo + '.' : '') +
        ' Betalen: €' + amount + '.');

      /* A place really was taken, so the count on screen moves with it. */
      if (remaining > 0) { remaining -= 1; paintCounts(); }
    }

    /* ---- view 3: confirmed ----------------------------------------------- */

    function showDone(refNo) {
      const p = payload();
      const who = p.teamName ||
        [p.player1, p.player2].filter(Boolean).join(' & ') || 'Jullie team';

      flowStarted = true;
      root.dataset.state = 'success';
      setView('done');

      ref('done-lead').innerHTML = esc(who) + '.' +
        (refNo ? ' Nummer <span class="reg-done__ref">' + esc(refNo) + '</span>.' : '');

      /* The payment view is gone; its three facts are not. One line: bedrag ·
         rekening · mededeling (payinfo.js owns the wording). */
      const payEl = ref('done-pay');
      const recap = (window.PayInfo && typeof window.PayInfo.recap === 'function')
        ? window.PayInfo.recap({ amount: payAmount, reference: refNo })
        : '';
      payEl.textContent = recap;
      payEl.hidden = !recap;

      ref('done-contact').textContent = contactLine();

      ref('done-title').focus();
      speakStatus('Jullie zijn ingeschreven.' + (refNo ? ' Nummer ' + refNo + '.' : '') +
        ' We hebben je een bevestiging gemaild.');
    }

    /* ---- volzet: one panel INSTEAD of the form ---------------------------
       Reached two ways, and both mean the same thing: the live count said zero
       when the page opened, or the server refused the entry because the last
       place went in the meantime. Either way the form is the wrong thing to
       show, so it goes and this takes its place — with the one thing that IS
       still possible (come and watch) as the panel's single action. */

    function showFullPanel(slots, nothingSent) {
      if (flowStarted) return;   /* already registered: their own place stands */

      remaining = 0;
      paintCounts();
      isLive = false;
      settled = true;
      closedTxt = 'Volzet';
      paintButton();

      const places = (typeof slots === 'number' && slots > 0) ? slots : TOTAL;
      const lead = 'Alle ' + places + ' plaatsen zijn bezet.' +
        (nothingSent ? ' Je inschrijving is niet verstuurd.' : '');

      root.dataset.state = 'full';
      processEl.hidden = true;
      setView('full');

      ref('full-eyebrow').textContent = EYEBROW_TXT;
      ref('full-lead').textContent = lead;
      ref('full-tickets').textContent = 'Kom supporteren — open air ticket ' + TKT_TXT;

      ref('full-title').focus();
      speakStatus('Volzet. ' + lead);
    }

    form.addEventListener('submit', async e => {
      e.preventDefault();

      const bad = checkAll();
      paintSummary(bad);
      if (bad.length) {
        const first = bad[0];
        if (first.el && first.el.focus) first.el.focus();
        speakAlert(summaryText(bad));
        return;
      }

      /* Entries closed: the form validated and the visitor is told exactly
         what happened — nothing. No path from here to the payment view. */
      if (!isLive) {
        notice(closedTxt === 'Volzet'
          ? 'Volzet — er is niets verstuurd.'
          : 'Inschrijvingen zijn nog niet open. Er is niets verstuurd.');
        return;
      }

      showProcessing();
      try {
        const body = await window.ChampLive.post(Object.assign({ action: 'register' }, payload()));
        if (body && body.ok) {
          showPay(body);
          return;
        }
        stopProcessing();
        /* Every other code — bad-request, too-many, server — is one generic
           retry failure: none of them is a state a visitor can act on. */
        if (body && body.error === 'full') showFullPanel(null, true);
        else notice('Versturen is niet gelukt. Probeer opnieuw' +
          (CFG.contactEmail ? ', of mail ' + CFG.contactEmail : '') + '.');
      } catch (err) {
        /* Nothing typed is thrown away — the visitor presses the button again. */
        stopProcessing();
        notice('Versturen is niet gelukt. Probeer opnieuw' +
          (CFG.contactEmail ? ', of mail ' + CFG.contactEmail : '') + '.');
      }
    });

    /* =====================================================================
       DEBUG HOOKS — screenshots only, invisible to a visitor (§0 rule 8).
       Local render, no request, no reference the server did not give: the
       fixture number is only ever shown to whoever typed ?state= themselves.
       ==================================================================== */

    function fill(map) {
      Object.keys(map).forEach(id => { const el = byId(id); if (el) el.value = map[id]; });
    }

    const FIXTURE = { 'team-name': 'De Baseliners',
                      'p1-name': 'Jasper Vanhoutte', 'p2-name': 'Lien Vandewalle',
                      'reg-email': 'jasper@example.be', 'reg-tel': '+32 470 12 34 56' };

    let params;
    try { params = new URLSearchParams(window.location.search); }
    catch (err) { params = new URLSearchParams(''); }

    switch (params.get('state')) {
      case 'error':
        fill({ 'team-name': 'D', 'p1-name': 'Jasper Vanhoutte', 'p2-name': '',
               'reg-email': 'jasper@', 'reg-tel': '0499' });
        paintSummary(checkAll());
        break;
      case 'filled':
        fill(FIXTURE);
        break;
      case 'pay':
        fill(FIXTURE);
        showPay({ ok: true, reference: 'INS-07', amount: FEE });
        break;
      case 'success':
        fill(FIXTURE);
        showDone('INS-07');
        break;
      default: break;
    }
  }
};
