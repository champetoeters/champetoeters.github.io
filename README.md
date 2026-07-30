# CHAMPETOETERS & FRIENDS

Open air en padel · TC Leiemeers, Kuurne · zaterdag 5 september 2026, 14:00 → 02:00.

**Live site:** https://champetoeters.github.io

This repository is the static site, served by GitHub Pages. The live layer
(inschrijvingen, tickets, uitslagen, betalingen) runs on a Google Apps Script
web app — see `backend/API.md` for the contract and the top of
`backend/Code.gs` for the deploy steps. There are **no secrets in this repo**:
the admin password and rekeningnummer live in Apps Script Script-properties,
and all personal data lives in a private Google Sheet.

| where | what |
|---|---|
| `/` | landing: hero → wedstrijdschema (live uitslagen) → dj-lineup |
| `/register.html` | team-inschrijving (€50) |
| `/tickets.html` | open air tickets (€12) |
| `/admin/` | organisers only: uitslagen + betalingen (wachtwoord) |
| `js/config.js` | the only file to edit when wiring the backend or IBAN |

Built with plain HTML/CSS/JS — no build step, no dependencies. Editing:
change files, commit, push; Pages redeploys automatically.
