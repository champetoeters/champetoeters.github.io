/* ============================================================================
   hero.js — CHAMPETOETERS & FRIENDS
   Owned by: hero builder.

   Two jobs, both cheap:
     1. Fit the Didone wordmark to its lockup so it spans it exactly, at any
        width, whichever serif the machine actually has (Playfair, Didot,
        Bodoni and Times are wildly different widths — a CSS clamp cannot know).
     2. Close the team CTA when the draw is full, from the live count — and
        both CTAs once the online inschrijvingen close (CHAMP_CONFIG.
        onlineCloses, event day 11:30): from then on the tickets are at the
        door, so the buttons go dead rather than lead to two closed pages.

   Both CTAs are ordinary page navigations (/register/ and /tickets/), so there
   is no click handler in this section at all.

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
  init(root) {
    if (!root || root.dataset.heroReady === "1") return;
    root.dataset.heroReady = "1";

    const $ = (sel) => root.querySelector(sel);
    const byKey = (k) => root.querySelector('[data-hero="' + k + '"]');

    /* ---- 1. Volzet -----------------------------------------------------
       The client took the live count off this page: it is either possible to
       enter or it is not, and a running figure only invites the visitor to do
       arithmetic. So nothing paints in the ordinary case — the buttons ship
       exactly as the markup has them — and the ONE thing worth saying is said
       when the draw fills up.

       Closing is live-only and one-way. A missing, slow or unusable answer
       leaves the page open, because the registration page checks the count
       again on submit and the backend is the judge either way: the worst a
       stale hero can do is send someone one click further. */

    const teamCta = byKey("cta-team");
    const ticketCta = byKey("cta-ticket");

    const live = window.ChampLive;
    const cfg = window.CHAMP_CONFIG || {};
    const closedForDay = !!(live && typeof live.onlineClosed === "function" && live.onlineClosed());

    /* A dead chip, not a link: no href, so it leaves the tab order and cannot
       be clicked or opened in a new tab. Uppercased by .hero__cta--dead. */
    function deaden(el, text) {
      el.removeAttribute("href");
      el.setAttribute("aria-disabled", "true");
      el.classList.remove("glass-btn--primary", "glass-btn--ghost");
      el.classList.add("glass-btn--disabled", "hero__cta--dead");
      el.textContent = text;
    }

    function closeTeamEntry() {
      if (!teamCta) return;
      /* A dead chip, not a link: no href, so it leaves the tab order and
         cannot be clicked or opened in a new tab. Its promise is gone, so the
         ticket button takes over the primary weight — the page's biggest tap
         must always lead somewhere that can still say yes. */
      /* Keeps its subject. A bare "Volzet" only reads to someone who saw the
         button it replaced — a visitor arriving after the draw filled up has
         never seen "Schrijf je team in" and would be told that something,
         unspecified, is full. */
      deaden(teamCta, "Padel volzet");
      if (ticketCta && !closedForDay) {
        ticketCta.classList.remove("glass-btn--ghost");
        ticketCta.classList.add("glass-btn--primary");
      }
    }

    if (closedForDay) {
      /* Nothing left to sell online: both chips say so, neither leads anywhere.
         The count is not asked — the clock has already answered. */
      closeTeamEntry();
      if (ticketCta) deaden(ticketCta, "Tickets aan de deur");
    } else if (live && typeof live.state === "function" && cfg.apiEndpoint) {
      try {
        Promise.resolve(live.state()).then((state) => {
          const c = (state && state.counts) || null;
          if (c && typeof c.slots === "number" && typeof c.registrations === "number" &&
              c.slots > 0 && c.registrations >= c.slots) {
            closeTeamEntry();
          }
        }, () => { /* no answer → leave it open */ });
      } catch (e) { /* leave it open */ }
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
