/* CHAMPETOETERS & FRIENDS — integration config.
 *
 * The site is static (GitHub Pages); everything live goes through ONE backend
 * URL. See backend/API.md for the contract.
 *
 *   apiEndpoint empty  → not-connected mode. The site renders, the timetable
 *                        falls back to data/demo-state.json, and registration /
 *                        ticket sales read "nog niet open". Nothing can fake a
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

  apiEndpoint: "https://script.google.com/macros/s/AKfycbwP7UgY4GRaunT597IgpGot0suHRIVg_ZTLyaMBBu5BqYb8R0zBBM-X5RroC0H9pZHs/exec",

  /* Manual payments: bank transfer or at the event. The IBAN also drives the
     scannable EPC QR on the payment panel; leave it empty until it is known
     and the QR shows a tidy "volgt nog" placeholder instead. */
  payment: {
    iban: "BE37 9731 8485 2328",
    holder: "Champetoeters",
  },

  /* Demo clock for the verification round: "HH:MM" pretends it is that moment
     on the event day (drives live-match + on-stage-now highlights). Empty for
     production — the real clock takes over on 5 sept 2026. */
  demoNow: "18:45",

  contactEmail: "padel@tcleiemeers.be",
  contactPhone: "+32 476 95 35 33",
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
