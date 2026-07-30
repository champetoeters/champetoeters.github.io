/* ============================================================================
   hero.js — CHAMPETOETERS & FRIENDS
   Owned by: hero builder.

   Two jobs, both cheap:
     1. Fit the Didone wordmark to its lockup so it spans it exactly, at any
        width, whichever serif the machine actually has (Playfair, Didot,
        Bodoni and Times are wildly different widths — a CSS clamp cannot know).
     2. Bind the real numbers: event.json first, then the live count from
        ChampLive.state() so "nog N plaatsen" cannot outlive the last slot.

   Both CTAs are ordinary page navigations (register.html / tickets.html), so
   there is no click handler in this section at all.

   Nothing here runs on a timer, and that is deliberate: the hero's beat — the
   glow pulse, the sheen pass, the wordmark's breathe — is entirely CSS
   animation on `transform` and `opacity`, so it lives on the compositor and
   survives a busy main thread. There is no JS clock to keep in sync with it,
   and adding one would be the only way to make this hero drop frames.

   Perf (§4): reads and writes are never interleaved inside a rAF; the fitter
   does one batched read pass then one write pass, driven by ResizeObserver.
   ========================================================================= */

window.Sections = window.Sections || {};

window.Sections.hero = {
  init(root, data) {
    if (!root || root.dataset.heroReady === "1") return;
    root.dataset.heroReady = "1";

    const $ = (sel) => root.querySelector(sel);
    const byKey = (k) => root.querySelector('[data-hero="' + k + '"]');

    const event = (data && data.event) || {};
    const stats = event.stats || {};
    const entry = event.teamEntry || {};

    /* ---- 1. Real numbers ----------------------------------------------
       Open places live in event.teamEntry.open; the tickets.json lookup is
       only a second source. Both are the build-time figure — the live count
       below overrides them the moment the backend answers, so the hero can
       never promise a place the registration page has already sold. */

    const slotsLine = byKey("slots-line");

    function renderSlots(open, total) {
      if (!slotsLine || !(open >= 0) || !(total > 0)) return;
      slotsLine.textContent = "";
      if (open === 0) { slotsLine.textContent = "Volzet"; return; }
      slotsLine.insertAdjacentHTML("afterbegin",
        'Nog <b class="u-tabular" data-hero="slots">' + Math.round(open) +
        '</b> van de <span class="u-tabular" data-hero="teams-total">' +
        Math.round(total) + "</span> plaatsen");
    }

    const places = typeof entry.places === "number" ? entry.places : stats.teams;

    let open = typeof entry.open === "number" ? entry.open : null;
    if (open == null) {
      const team = ((data && data.tickets) || []).find((t) => t && t.id === "team");
      if (team && typeof team.remaining === "number") open = team.remaining;
    }
    if (open != null) renderSlots(open, places);

    /* The live count. ChampLive is absent on the standalone preview page, and
       state() resolves {} when there is no backend and no demo clock — in both
       cases the static figure above simply stands. */
    const live = window.ChampLive;
    if (live && typeof live.state === "function") {
      try {
        Promise.resolve(live.state()).then((state) => {
          const c = (state && state.counts) || null;
          if (!c || typeof c.slots !== "number" || typeof c.registrations !== "number") return;
          renderSlots(Math.max(0, c.slots - c.registrations), c.slots);
        }, () => {});
      } catch (e) { /* the hero never depends on the live layer */ }
    }

    /* ---- 2. Fit the wordmark ------------------------------------------
       Measure the glyph run with a Range (the element itself is a block and
       would just report its container's width), then scale the type so it
       lands on the lockup's edge. One read pass, one write pass.

       The box measured is .hero__lockup, NOT .hero__inner: on mobile the
       lockup steps outside the container gutter (see hero.css §6) and is the
       wider of the two. Falls back to .hero__inner if the lockup is absent. */

    const box  = $(".hero__lockup") || $(".hero__inner");
    const word = byKey("fit");
    const REF   = 200;           // measure at a big size for precision
    let lastW   = -1;

    function fitWordmark(force) {
      if (!box || !word) return;

      const avail = box.clientWidth;                         // read
      if (!avail) return;
      if (!force && Math.abs(avail - lastW) < 0.5) return;
      lastW = avail;

      word.style.fontSize = REF + "px";                      // write
      const range = document.createRange();                  // read
      range.selectNodeContents(word);
      const glyphW = range.getBoundingClientRect().width;
      range.detach && range.detach();
      if (!glyphW) { word.style.fontSize = ""; return; }

      // Cap so a wide, short window cannot push the CTA past the fold: the
      // hero is one viewport tall at both sizes and the four lines under the
      // name have to fit inside it.
      const capH = Math.max(48, window.innerHeight * 0.183);
      const size = Math.min((avail * 0.995) / glyphW * REF, capH, 220);

      word.style.fontSize = "";                              // write
      root.style.setProperty("--hb-wm", size.toFixed(2) + "px");
    }

    fitWordmark(true);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => fitWordmark(true)).catch(() => {});
    }

    let ro = null;
    if (window.ResizeObserver && box) {
      ro = new ResizeObserver(() => fitWordmark(false));
      ro.observe(box);
    } else {
      window.addEventListener("resize", () => fitWordmark(false), { passive: true });
    }

    /* ---- 3. Teardown -------------------------------------------------- */

    this.destroy = () => {
      if (ro) ro.disconnect();
    };
  },
};
