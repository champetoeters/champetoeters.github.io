/* lineup — "& FRIENDS": the bill of performers. Owned by the lineup builder.

   One job (BRIEF §0.1): who is playing music, and when. Nothing to operate.

   Every act is presented IDENTICALLY (client, r10): same size, same background,
   same rules. The night's value gradient lives once on .ln__sky; no per-artist
   plate, tone or grain is emitted here — a per-entry wash made the closer read
   as a lighter silver band and the client called it out.

   Perf (§4): IntersectionObserver only, transform/opacity only, and nothing
   carrying backdrop-filter is ever animated. */
window.Sections = window.Sections || {};

(function () {
  "use strict";

  var EVENT_DAY = "2026-09-05";
  var DAY_AFTER = "2026-09-06";
  var NIGHT_END = 26 * 60;

  /* Sets are never named (BRIEF §0, remark 6). `tier` stays a class only — it
     drives nothing visual any more and must not become words. */

  /* ---------- the night runs on a 14:00 → 26:00 clock ---------- */
  function toMin(hhmm) {
    var p = String(hhmm).split(":");
    var m = (+p[0]) * 60 + (+p[1]);
    return m < 8 * 60 ? m + 24 * 60 : m;
  }

  /* ---------- name typesetting -------------------------------------------
     A name is set on ONE line and fitted to the measure by its FULL length
     (--cl). Fitting by the longest word instead is what stacked "NOVA" over
     "SCHELDT" on mobile. Only a single word longer than MAX_WORD — longer than
     any measure can hold — is broken, at the consonant pair nearest its middle. */
  var MAX_WORD = 24;   /* no name in the bill comes close; the break is a fallback */
  var VOWEL = "AEIOUY";

  function isCons(ch) { return VOWEL.indexOf(ch) === -1 && /[A-Z]/.test(ch); }

  function hyphenate(word) {
    if (word.length <= MAX_WORD || /[^A-Z]/.test(word)) return null;
    var mid = word.length / 2, best = -1, bestD = 1e3, i, d;
    for (i = 3; i <= word.length - 3; i++) {          /* prefer a consonant pair */
      if (isCons(word.charAt(i - 1)) && isCons(word.charAt(i))) {
        d = Math.abs(i - mid);
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    if (best === -1) {                                 /* else break after a vowel */
      for (i = 3; i <= word.length - 3; i++) {
        if (!isCons(word.charAt(i - 1)) && isCons(word.charAt(i))) {
          d = Math.abs(i - mid);
          if (d < bestD) { bestD = d; best = i; }
        }
      }
    }
    if (best === -1) best = Math.ceil(word.length / 2);
    return [word.slice(0, best), word.slice(best)];
  }

  function words(name) {
    var raw = String(name).split(/\s+/), out = [], i;
    for (i = 0; i < raw.length; i++) {
      if (raw[i] === "&" && out.length) out[out.length - 1] += " &";
      else out.push(raw[i]);
    }
    return out;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /* Returns { html, chars, line }.
       line  — the whole name on ONE line, spaces included, the italic kicker
               counted at its real 0.32em size. This is the ONLY measure the
               CSS fits against, at every viewport: the words are `inline`
               everywhere, so a name never stacks and never wraps.
       chars — longest single word. Kept for the hyphenation fallback only.
     Word spans are joined with a real space, which renders between inline
     boxes and is what separates the words on screen. */
  var KICK_EM = 0.32;

  function typeset(name) {
    var ws = words(name);
    var kicker = ws.length > 1 && ws[0].length <= 2 ? ws[0] : null;
    var body = kicker ? ws.slice(1) : ws;
    var chars = 1, line = 0, parts = [];

    if (kicker) {
      parts.push('<span class="ln__w ln__w--kick">' + esc(kicker) + "</span>");
      line += kicker.length * KICK_EM;
    }

    body.forEach(function (w) {
      var cut = hyphenate(w);
      line += w.length;
      if (cut) {
        chars = Math.max(chars, cut[0].length + 1, cut[1].length);
        /* the two halves are ONE word: no space between them, so they rejoin
           cleanly when the hyphen is hidden and they go inline on desktop */
        parts.push('<span class="ln__w">' + esc(cut[0]) +
                   '<span class="ln__hy" aria-hidden="true">-</span></span>' +
                   '<span class="ln__w">' + esc(cut[1]) + "</span>");
      } else {
        chars = Math.max(chars, w.length);
        parts.push('<span class="ln__w">' + esc(w) + "</span>");
      }
    });

    line += parts.length - 1;                       /* the spaces between words */
    return {
      html: parts.join(" "),
      chars: chars,
      line: Math.max(1, Math.round(line * 10) / 10)
    };
  }

  /* ---------- "on stage now" ----------------------------------------------
     One clock for the whole site: ChampLive.nowMinutes() on the same 14:00 →
     26:00 event scale, with the same precedence (?now=HH:MM → demoNow → the
     real clock on 5/6 sept 2026). The local implementation below is only the
     fallback for pages that do not load js/livedata.js — the standalone
     preview harness — and must keep that precedence identical. */
  function liveMinutes() {
    var L = window.ChampLive;
    if (L && typeof L.nowMinutes === "function") {
      try { return L.nowMinutes(); } catch (e) { /* fall through */ }
    }

    var q = null;   // ?now=23:45 forces the live state for screenshots (BRIEF §0 rule 8)
    try { q = new URLSearchParams(location.search).get("now"); } catch (e) { q = null; }
    if (q && /^\d{1,2}:\d{2}$/.test(q)) return toMin(q);

    var demo = window.CHAMP_CONFIG && window.CHAMP_CONFIG.demoNow;
    if (demo && /^\d{1,2}:\d{2}$/.test(String(demo))) return toMin(demo);

    var d = new Date();
    var iso = d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
    var m = d.getHours() * 60 + d.getMinutes();
    if (iso === EVENT_DAY) return m;
    if (iso === DAY_AFTER && m <= 2 * 60) return m + 24 * 60;
    return null;
  }

  /* ---------- render ---------- */
  function setHTML(dj, i, total) {
    var tier = dj.tier;
    var name = typeset(dj.name);

    /* No inline custom property at all. The type is fitted from ONE --cl set on
       the list (the longest name), so every act is the same size at every width
       by construction rather than by the cap happening to bind. Nothing here may
       set a colour, a tone or an opacity — all five share one background. */
    return '' +
      '<li class="ln__set ln__set--' + tier + '" data-set="' + i + '">' +

        /* the spine, desktop only — display:none below 1024px so it can never
           run through a centred name (client, r10) */
        '<div class="ln__rail" aria-hidden="true"></div>' +

        '<p class="ln__when">' +
          '<span class="ln__start u-tabular">' + esc(dj.start) + "</span>" +
          '<span class="ln__till u-tabular">&#8211; ' + esc(dj.end) + "</span>" +
          '<span class="ln__live glass glass--pill glass--flat" hidden>' +
            '<span class="ln__live-dot" aria-hidden="true"></span>Speelt nu</span>' +
        "</p>" +

        '<div class="ln__body">' +
          '<h3 class="ln__head3" aria-label="' + esc(dj.name) + '">' +
            '<span class="ln__name" aria-hidden="true">' + name.html + "</span>" +
          "</h3>" +
        "</div>" +

        '<p class="ln__genre">' + esc(dj.genre) + "</p>" +
      "</li>";
  }

  /* One bill, one clock. Module scope so destroy() can reach it and so a second
     init() can never leave a first timer running. */
  var timer = null;

  function destroy() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function init(root, data) {
    if (!root || root.dataset.lnReady === "1") return;
    var list = root.querySelector("[data-ln-list]");
    var djs = (data && data.djs) || (window.GlasData && window.GlasData.djs) || [];
    if (!list || !djs.length) return;
    root.dataset.lnReady = "1";

    // Chronological: the night unfolds downward.
    var order = djs.slice().sort(function (a, b) { return toMin(a.start) - toMin(b.start); });

    list.innerHTML = order.map(function (dj, i) {
      return setHTML(dj, i, order.length);
    }).join("");

    /* ONE size for the whole bill (client: there is no headliner). Every name is
       fitted by the LONGEST name's one-line length, so the five render at an
       identical size at every viewport — not only where --cap happens to bind.
       Fitting each name by its own length made the short ones bigger at 320px
       and at exactly 1024px; fitting by the longest word stacked NOVA/SCHELDT. */
    var widest = order.reduce(function (m, dj) {
      return Math.max(m, typeset(dj.name).line);
    }, 1);
    list.style.setProperty("--cl", String(widest));

    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var sets = Array.prototype.slice.call(list.querySelectorAll(".ln__set"));

    /* ---- reveal: IntersectionObserver only, never a scroll handler (§4) ---- */
    if (reduce || !("IntersectionObserver" in window)) {
      sets.forEach(function (li) { li.classList.add("is-in"); });
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          e.target.classList.add("is-in");
          io.unobserve(e.target);
        });
      }, { rootMargin: "0px 0px -8% 0px", threshold: 0.1 });
      sets.forEach(function (li) { io.observe(li); });
    }

    /* ---- on stage now ---- */
    function paintLive() {
      var m = liveMinutes();
      sets.forEach(function (li, i) {
        var dj = order[i];
        var on = m !== null && m >= toMin(dj.start) && m < toMin(dj.end);
        var pill = li.querySelector(".ln__live");
        li.classList.toggle("is-live", on);
        if (pill) pill.hidden = !on;
      });
      if (m === null || m > NIGHT_END) destroy();   /* the night is over */
    }
    paintLive();
    destroy();
    if (liveMinutes() !== null) timer = setInterval(paintLive, 60000);
  }

  window.Sections.lineup = { init: init, destroy: destroy };
})();
