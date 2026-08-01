/* payinfo.js — the payment panel, shared by register.html and tickets.html.
   Owned by: flows builder.

     PayInfo.render(el, { amount, mededeling, kind })   kind: 'register' | 'order'

   turns `el` into ONE glass panel: what it costs, where it goes, the mededeling
   to type (the team name for an inschrijving, the buyer's name for tickets —
   that is how the organisers match the transfers), and the line that says you
   can also pay at the event. Returns { panel, title } so the caller can move
   focus to the heading.

     PayInfo.recap({ amount, mededeling })   → "€50 · BE37 9731 8485 2328 · mededeling …"

   is the same information as one line, for the confirmation views: they replace
   the panel, and the details must survive that.

   Account details come from CHAMP_CONFIG.payment. With no IBAN configured the
   panel says the rekeningnummer follows per mail. */

(function () {
  'use strict';

  const CTRL = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E]/g;

  const clean = v => String(v == null ? '' : v).replace(CTRL, '').replace(/\s+/g, ' ').trim();

  const compactIban = v => String(v == null ? '' : v).replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  const groupIban   = v => compactIban(v).replace(/(.{4})(?=.)/g, '$1 ');

  function euro(n) {
    const v = Number(n);
    if (!isFinite(v)) return '';
    return '€' + (Number.isInteger(v) ? String(v) : v.toFixed(2).replace('.', ','));
  }

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* Callers historically passed `reference`; the mededeling wins when given. */
  const mededelingOf = o => clean((o || {}).mededeling) || clean((o || {}).reference);

  /* ONE calm line for a confirmation view: what it costs, where it goes, what to
     type. The payment panel is gone by then and a visitor who took a screenshot
     of the confirmation must still be able to pay from it. */
  function recap(o) {
    const s = o || {};
    const cfg = (typeof window !== 'undefined' && window.CHAMP_CONFIG) || {};
    const iban = compactIban((cfg.payment || {}).iban);
    const mededeling = mededelingOf(s);
    const line = [
      euro(s.amount),
      iban ? groupIban(iban) : '',
      mededeling ? 'mededeling "' + mededeling + '"' : ''
    ].filter(Boolean).join(' · ');
    if (!line) return '';
    return iban ? line : line + ' · alle details staan in je mailbox';
  }

  function render(el, opts) {
    if (!el) return null;

    const o = opts || {};
    const cfg = (typeof window !== 'undefined' && window.CHAMP_CONFIG) || {};
    const pay = cfg.payment || {};

    const iban       = compactIban(pay.iban);
    const holder     = clean(pay.holder) || 'Champetoeters';
    const mededeling = mededelingOf(o);
    const amount     = Number(o.amount);
    const kind       = o.kind === 'order' ? 'order' : 'register';

    const rows = [];
    if (!iban) {
      rows.push(
        '<div class="pay__row">' +
          '<p class="pay__k">Rekeningnummer</p>' +
          '<p class="pay__note">Volgt nog. Je krijgt het per mail.</p>' +
        '</div>');
    } else {
      rows.push(
        '<div class="pay__row">' +
          '<p class="pay__k">Rekeningnummer</p>' +
          '<p class="pay__vline">' +
            '<span class="pay__v pay__iban u-tabular" data-pay="iban">' + esc(groupIban(iban)) + '</span>' +
            '<button type="button" class="pay__copy" data-pay="copy">Kopieer</button>' +
          '</p>' +
          '<p class="pay__sub">op naam van ' + esc(holder) + '</p>' +
        '</div>');
    }
    if (mededeling) {
      rows.push(
        '<div class="pay__row">' +
          '<p class="pay__k">Mededeling</p>' +
          '<p class="pay__v pay__ref">' + esc(mededeling) + '</p>' +
        '</div>');
    }

    el.classList.add('pay', 'glass', 'glass--panel');
    el.innerHTML =
      '<p class="u-eyebrow pay__eyebrow">' +
        (kind === 'order' ? 'Open air ticket' : 'Inschrijving') + '</p>' +
      '<h2 class="pay__title" tabindex="-1" data-pay="title">Betalen: ' +
        '<span class="pay__amt">' + esc(euro(amount)) + '</span></h2>' +
      '<div class="pay__body">' +
        '<div class="pay__rows">' + rows.join('') + '</div>' +
      '</div>' +
      '<p class="pay__alt">Liever ter plaatse? Betalen kan ook aan de kassa op het event.</p>' +
      '<p class="pay__sr" role="status" aria-live="polite" data-pay="say"></p>';

    wireCopy(el, iban);
    return { panel: el, title: el.querySelector('[data-pay="title"]') };
  }

  /* Copy the IBAN without spaces — that is what a banking app wants pasted.
     Clipboard access can be refused (insecure origin, permission, older
     engine); then the number is selected instead so one gesture still gets it,
     and tapping the number selects it too. */
  function wireCopy(el, iban) {
    const btn  = el.querySelector('[data-pay="copy"]');
    const num  = el.querySelector('[data-pay="iban"]');
    const say  = el.querySelector('[data-pay="say"]');
    if (!num) return;

    const speak = msg => { if (say) { say.textContent = ''; window.setTimeout(() => { say.textContent = msg; }, 60); } };

    function select() {
      try {
        const range = document.createRange();
        range.selectNodeContents(num);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return true;
      } catch (e) { return false; }
    }

    num.addEventListener('click', select);
    if (!btn) return;

    let timer = 0;
    btn.addEventListener('click', () => {
      const done = () => {
        btn.textContent = 'Gekopieerd';
        btn.classList.add('is-copied');
        speak('Rekeningnummer gekopieerd.');
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          btn.textContent = 'Kopieer';
          btn.classList.remove('is-copied');
        }, 2600);
      };
      const fallback = () => { speak(select() ? 'Rekeningnummer geselecteerd.' : 'Kopiëren lukt niet. Typ het nummer over.'); };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(iban).then(done, fallback);
      } else {
        fallback();
      }
    });
  }

  const api = { render: render, recap: recap, groupIban: groupIban, euro: euro };

  if (typeof window !== 'undefined') window.PayInfo = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();
