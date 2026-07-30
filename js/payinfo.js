/* payinfo.js — the payment panel, shared by register.html and tickets.html.
   Owned by: flows builder.

     PayInfo.render(el, { amount, reference, kind })   kind: 'register' | 'order'

   turns `el` into ONE glass panel: what it costs, where it goes, the mededeling
   to type, a scannable EPC069-12 QR (backend/API.md) and the line that says you
   can also pay at the event. It returns { panel, title } so the caller can move
   focus to the heading.

     PayInfo.recap({ amount, reference })   → "€50 · BE68 … · mededeling INS-01"

   is the same information as one line, for the confirmation views: they replace
   the panel, and the details must survive that.

   Account details come from CHAMP_CONFIG.payment. With no IBAN configured the
   panel says the rekeningnummer follows and shows a tidy "QR volgt" tile —
   there is no code path to a broken or empty QR.

   The encoder (vendor/qrcode.js) is loaded by the page only when an IBAN
   exists; without it the tile is simply left out, never faked.

   epcPayload() is pure and exported for node, so the payload can be checked
   against API.md without a browser. */

(function () {
  'use strict';

  const CTRL = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E]/g;

  const clean = v => String(v == null ? '' : v).replace(CTRL, '').replace(/\s+/g, ' ').trim();

  const compactIban = v => String(v == null ? '' : v).replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  const groupIban   = v => compactIban(v).replace(/(.{4})(?=.)/g, '$1 ');

  /* Display is Dutch (comma), the QR payload is EPC (dot). Never share one. */
  function euro(n) {
    const v = Number(n);
    if (!isFinite(v)) return '';
    return '€' + (Number.isInteger(v) ? String(v) : v.toFixed(2).replace('.', ','));
  }

  /* Always two decimals: "EUR50.00". The standard allows a bare integer, but
     several Belgian apps read the shorter form as cents or refuse it outright,
     and two decimals is what every one of them accepts. */
  function payloadAmount(n) {
    const cents = Math.round(Number(n) * 100);
    if (!isFinite(cents) || cents <= 0) return '';
    return 'EUR' + (cents / 100).toFixed(2);
  }

  /* EPC069-12 "SEPA credit transfer", version 002, UTF-8. Twelve lines exactly;
     the two empty ones are Purpose and the structured reference, which a village
     club transfer does not use. Field caps are the standard's: 70 / 140. */
  function epcPayload(o) {
    const src = o || {};
    const iban = compactIban(src.iban);
    const amount = payloadAmount(src.amount);
    if (!iban || !amount) return '';
    const reference = clean(src.reference).slice(0, 140);
    return [
      'BCD',
      '002',
      '1',
      'SCT',
      compactIban(src.bic),
      clean(src.holder).slice(0, 70),
      iban,
      amount,
      '',
      '',
      reference,
      /* Field 12 (beneficiary-to-originator information) is capped at 70 by the
         standard; the 140 cap belongs to field 11, the unstructured remittance
         line above it. */
      reference ? ('Betaling ' + reference).slice(0, 70) : ''
    ].join('\n');
  }

  /* Our own SVG, not the library's table/img output: crisp at any size, one
     path, no raster, and a real quiet zone (4 modules, per the QR spec). */
  function qrSvg(payload) {
    if (!payload || typeof qrcode !== 'function') return '';
    let qr;
    try {
      /* Line 3 of the payload declares charset 1 = UTF-8, and the vendored
         encoder defaults to a Latin-1 byte writer: an accented holder name went
         out as Latin-1 under a UTF-8 flag and banking apps read it as mojibake.
         Switch the writer to the UTF-8 one the library already ships. */
      if (qrcode.stringToBytesFuncs && qrcode.stringToBytesFuncs['UTF-8']) {
        qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
      }
      qr = qrcode(0, 'M');
      qr.addData(payload);
      qr.make();
    } catch (e) {
      return '';
    }
    const n = qr.getModuleCount();
    const q = 4;
    const size = n + q * 2;
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += 'M' + (c + q) + ' ' + (r + q) + 'h1v1h-1z';
      }
    }
    return '<svg viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges" ' +
      'xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true">' +
      '<rect width="' + size + '" height="' + size + '" fill="#F4F7FB"/>' +
      '<path d="' + d + '" fill="#0D1637"/></svg>';
  }

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* ONE calm line for a confirmation view: what it costs, where it goes, what to
     type. The payment panel is gone by then and a visitor who took a screenshot
     of the confirmation must still be able to pay from it. With no IBAN
     configured there is nothing to transfer to yet, so the line points at the
     mail instead of printing half an instruction. */
  function recap(o) {
    const s = o || {};
    const cfg = (typeof window !== 'undefined' && window.CHAMP_CONFIG) || {};
    const iban = compactIban((cfg.payment || {}).iban);
    const reference = clean(s.reference);
    const line = [
      euro(s.amount),
      iban ? groupIban(iban) : '',
      reference ? 'mededeling ' + reference : ''
    ].filter(Boolean).join(' · ');
    if (!line) return '';
    return iban ? line : line + ' — alle details staan in je mailbox';
  }

  function render(el, opts) {
    if (!el) return null;

    const o = opts || {};
    const cfg = (typeof window !== 'undefined' && window.CHAMP_CONFIG) || {};
    const pay = cfg.payment || {};

    const iban      = compactIban(pay.iban);
    const holder    = clean(pay.holder) || 'Champetoeters';
    const reference = clean(o.reference);
    const amount    = Number(o.amount);
    const kind      = o.kind === 'order' ? 'order' : 'register';

    const svg = qrSvg(epcPayload({
      iban: iban, bic: pay.bic, holder: holder, amount: amount, reference: reference
    }));

    const rows = [];
    if (!iban) {
      /* The row stays where the number will be: what is missing is visible, and
         the sentence tells you how you will get it. */
      rows.push(
        '<div class="pay__row">' +
          '<p class="pay__k">Rekeningnummer</p>' +
          '<p class="pay__note">Volgt nog — je krijgt het per mail.</p>' +
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
    if (reference) {
      rows.push(
        '<div class="pay__row">' +
          '<p class="pay__k">Mededeling</p>' +
          '<p class="pay__v pay__ref">' + esc(reference) + '</p>' +
        '</div>');
    }

    /* An IBAN and no encoder is a broken build, not a state to draw: the tile
       goes, the account details stay. Only a missing IBAN gets a placeholder. */
    const tile = svg
      ? '<div class="pay__tile" role="img" aria-label="' +
          esc('QR-code: overschrijving van ' + euro(amount) +
              (kind === 'order' ? ' voor je tickets' : ' voor je inschrijving') +
              (reference ? ', mededeling ' + reference : '')) + '">' + svg + '</div>' +
        '<p class="pay__hint">Scan met je bank-app.</p>'
      : iban
        ? ''
        : '<div class="pay__tile pay__tile--soon" aria-hidden="true"><span>QR volgt</span></div>';

    el.classList.add('pay', 'glass', 'glass--panel');
    el.innerHTML =
      '<p class="u-eyebrow pay__eyebrow">' +
        (kind === 'order' ? 'Open air ticket' : 'Inschrijving') + '</p>' +
      '<h2 class="pay__title" tabindex="-1" data-pay="title">Betalen — ' +
        '<span class="pay__amt">' + esc(euro(amount)) + '</span></h2>' +
      '<div class="pay__body">' +
        '<div class="pay__rows">' + rows.join('') + '</div>' +
        (tile ? '<div class="pay__qr">' + tile + '</div>' : '') +
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
      const fallback = () => { speak(select() ? 'Rekeningnummer geselecteerd.' : 'Kopiëren lukt niet — typ het nummer over.'); };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(iban).then(done, fallback);
      } else {
        fallback();
      }
    });
  }

  const api = { render: render, recap: recap, epcPayload: epcPayload,
                groupIban: groupIban, euro: euro };

  if (typeof window !== 'undefined') window.PayInfo = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();
