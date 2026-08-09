/* CHAMPETOETERS & FRIENDS — integration config.
 *
 * The site is static (GitHub Pages); everything live goes through ONE backend
 * URL. See backend/API.md for the contract.
 *
 *   apiEndpoint empty  → not-connected mode. The site renders, the timetable
 *                        shows the draw with no results in it, and registration
 *                        / ticket sales read "nog niet open". Nothing can fake a
 *                        confirmation.
 *   apiEndpoint set    → live mode. Set it to the Apps Script web-app URL
 *                        (https://script.google.com/macros/s/…/exec) or, in
 *                        local dev, to "/api" (node tools/devserver.js).
 */

window.CHAMP_CONFIG = {
  /* Where the published live state lives (pushed by the backend on every
     change; GitHub serves it to any crowd for free). Empty = read state from
     apiEndpoint directly. */
  stateUrl: "https://raw.githubusercontent.com/champetoeters/champetoeters.github.io/state/state.json",

  apiEndpoint: "https://script.google.com/macros/s/AKfycbwPbYUoLCogNGAz3so-7ov6c-8gHe8G4enqG6_13sAq7LfV6B93bQy2xBy1boRYX7Of/exec",

  /* Manual payments: bank transfer or at the event. The IBAN fills the payment
     panel (with a copy button); leave it empty until it is known and the panel
     says the rekeningnummer follows per mail instead. */
  payment: {
    iban: "IE75 SUMU 9903 6513 1743 98",
    holder: "Sebbe Benoit",
  },

  /* Is the draw public yet?
   *
   *   false → the sheet still renders in full (tijden, banen, poules, het
   *           3D-beeld), but every seat reads "Vrije plaats": registrations
   *           are NOT merged into the poules and no results are shown. The
   *           organisers keep seeing everything at /admin/ — this only hides
   *           the draw from the visitor.
   *   true  → live mode: registrations fill their slot, scores print, and the
   *           bracket names the knock-out seats as they resolve.
   *
   * Flip to true once the poules are final and may be published. Nothing else
   * has to change. */
  showDraw: false,

  contactEmail: "event@champetoeters.be",
  contactPhone: "",
};

/* Resolves { register: bool, orders: bool } — false on any failure.
   Probed once per page load; every caller shares the same promise. */
window.CHAMP_CONFIG.health = (() => {
  let probe = null;
  return () => {
    if (!probe) {
      const cfg = window.CHAMP_CONFIG;
      const base = cfg.apiEndpoint;
      const stat = String(cfg.stateUrl || "").trim();
      const viaApi = () =>
        fetch(base + (base.indexOf("?") === -1 ? "?" : "&") + "action=health",
              { cache: "no-store", redirect: "follow" })
          .then(r => (r.ok ? r.json() : {}))
          .then(h => ({ register: !!h.register, orders: !!h.orders }))
          .catch(() => ({ register: false, orders: false }));
      /* Static-first: the published state carries the open/closed flags, so
         opening the register/tickets page costs the backend nothing. A file
         without the flags (older backend) falls back to the script. The
         backend stays the judge on every submit, so a stale flag can only
         mis-DISPLAY for a few minutes, never mis-ACCEPT. */
      probe = !base
        ? Promise.resolve({ register: false, orders: false })
        : !stat
          ? viaApi()
          : fetch(stat + (stat.indexOf("?") === -1 ? "?" : "&") +
                  "b=" + Math.floor(Date.now() / 60000), { cache: "no-store" })
              .then(r => (r.ok ? r.json() : {}))
              .then(j => (j && typeof j.register === "boolean" && typeof j.orders === "boolean")
                ? { register: j.register, orders: j.orders }
                : viaApi())
              .catch(viaApi);
    }
    return probe;
  };
})();
