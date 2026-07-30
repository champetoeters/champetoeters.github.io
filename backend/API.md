# CHAMPETOETERS — Backend API contract (v1)

One backend, two implementations with **identical behaviour**:

- `backend/Code.gs` — Google Apps Script web app (production). Storage = Google Sheet,
  email = MailApp, admin password = Script Properties key `ADMIN_PASSWORD`.
- `tools/devserver.js` — Node dev stub (local testing). Storage = JSON file
  `server-data/state.json` (gitignored), email = appended to `server-data/outbox.jsonl`.
  Also serves `site/` on :8080 and exposes the API under the SAME origin at `/api`.

The site talks to exactly one URL: `CHAMP_CONFIG.apiEndpoint`.
- Production: `https://script.google.com/macros/s/…/exec`
- Dev: `/api` (devserver)

## Transport rules (Apps-Script-compatible — the stub must honour them too)

- **GET** `apiEndpoint + '?action=<name>'` for reads.
- **POST** `apiEndpoint` with **`Content-Type: text/plain;charset=utf-8`** (avoids CORS
  preflight; GAS cannot answer OPTIONS) and body = JSON `{ "action": "...", ... }`.
- Client must use `fetch(url, { redirect: 'follow' })` semantics (GAS 302s to
  googleusercontent). Never send custom headers.
- Response is always HTTP 200 with JSON `{ "ok": true, ... }` or
  `{ "ok": false, "error": "<code>" }`. Error codes: `bad-request`, `unauthorized`,
  `full`, `not-found`, `too-many`, `server`.
- `too-many` = an abuse cap was hit on a public write (`register` / `order`):
  max 3 rows per e-mail address per tab, max 150 rows per tab per calendar day.
  Both are protections for the Sheet and the mail quota, not user-facing states;
  the client may show the generic "probeer opnieuw" failure.
- All server responses include no secrets. The public actions never return emails,
  phone numbers or payment status.

## Data model (stored server-side)

```jsonc
// registration (team entry) — created by action=register
{ "ref": "INS-07",            // sequential, server-assigned
  "teamId": "t15",            // the open slot this entry fills (server picks the next
                              // teams.json slot with confirmed:false; null if all 16 full)
  "player1": "…", "player2": "…", "email": "…", "phone": "…",
  "at": "2026-08-01T10:00:00Z",
  "paid": false }

// ticket order — created by action=order
{ "ref": "TKT-12", "name": "…", "email": "…", "quantity": 3,
  "at": "…", "paidCount": 0 }   // 0..quantity, admin-controlled

// match result — set by admin op=setResult
{ "matchId": "m01",
  "sets": [[6,3],[4,6],[10,7]],  // 1..3 sets, games per side, integers 0..99
  "winner": "A" }                // 'A' | 'B' = index 0 | 1 of schedule.json teams[]
```

## Public actions

### GET `?action=health`
→ `{ ok:true, register:true, orders:true }` (flags flip when the event is full/closed).
`register:false` when 16 slots are taken.

### GET `?action=state`
The live overlay the public site polls. **Public-safe fields only.**
```jsonc
{ "ok": true,
  "results": { "m01": { "sets": [[6,3],[6,4]], "winner": "A" }, … },
  "teams":   [ { "teamId": "t15", "players": ["Anna Peeters","Tom Claes"] }, … ],
             // registrations that filled an open slot → names appear in the draw
  "counts":  { "registrations": 14, "slots": 16 } }
```

### POST `{ action:"register", player1, player2, email, phone }`
Validation mirrors `site/js/register.js` scrub rules (max lengths 60/60/160/40, same
character policy). On success: stores entry, assigns next open team slot, sends the
confirmation email (Dutch, includes payment instructions — see EMAIL below), returns
`{ ok:true, reference:"INS-07", teamId:"t15", amount:50 }`.
If no slots left → `{ ok:false, error:"full" }`. Past the abuse caps →
`{ ok:false, error:"too-many" }`.

### POST `{ action:"order", name, email, quantity }`
quantity integer 1..8. Sends confirmation email. Returns
`{ ok:true, reference:"TKT-12", amount: quantity*12 }`. Past the abuse caps →
`{ ok:false, error:"too-many" }`.

## Admin actions — all POST `{ action:"admin", password, op, ... }`

Password checked on every call against Script Property `ADMIN_PASSWORD`
(dev stub: env `ADMIN_PASSWORD`, default `champ-dev`). Wrong → `{ok:false,error:"unauthorized"}`.

| op | payload | effect / returns |
|---|---|---|
| `login` | – | `{ok:true}` — verify only |
| `overview` | – | `{ok:true, registrations:[…full objects…], orders:[…], results:{…}}` |
| `setResult` | `matchId, sets, winner` | upsert result → `{ok:true}` |
| `clearResult` | `matchId` | remove result → `{ok:true}` |
| `setTeamPaid` | `key, paid` | key = teamId (`t01`…) for pre-entered teams or ref (`INS-07`); bool → `{ok:true}` |
| `setOrderPaid` | `ref, paidCount` | clamp 0..quantity → `{ok:true}` |
| `seedDemo` | `state` | replace ALL data with the given demo state (verification round). Accepts `site/data/demo-state.json` wholesale: `state.adminDemo.{orders,teamPaid,registrations}` is merged with the top-level keys, and `teams` entries whose slot is already described in full are skipped |
| `resetAll` | – | wipe registrations, orders, results, payments (go-live cleanup) |

Team payment state for pre-entered teams (`t01`–`t14` from teams.json) is stored as
`{ key, paid }` rows; registrations carry their own `paid` field addressed by ref.
`overview` returns `teamPaid: { "t01": true, … }` alongside.

## EMAIL (sent by backend on register/order — Dutch, plain + concise)

Subject register: `Inschrijving ontvangen — CHAMPETOETERS & FRIENDS`
Subject order:    `Je open air tickets — CHAMPETOETERS & FRIENDS`

Body must contain: greeting with name(s), what was registered/ordered, the amount
(€50 team / €12 × qty), payment instructions block:

> Betalen kan op twee manieren:
> • Overschrijving naar {IBAN} op naam van {HOLDER} met mededeling "{REF}".
> • Of ter plaatse op het event (cash of Payconiq).
> Nog niet betaald? Geen probleem — je plaats/tickets staan vast zodra we je
> betaling ontvangen of je ter plaatse betaalt.

IBAN/HOLDER come from Script Properties `PAY_IBAN`, `PAY_HOLDER` (dev stub: env or
defaults `BE00 0000 0000 0000` / `Champetoeters`). If `PAY_IBAN` unset, the email says
"Het rekeningnummer volgt nog — betalen kan ook ter plaatse."
No Reply-To header: replies go to the sending account (the event's own address).
Include contact line + venue/date footer.

## EPC QR (client-side, `site/js/payinfo.js`)

Payment pages render an EPC069-12 "SEPA credit transfer" QR (scannable by Belgian
banking apps) when `CHAMP_CONFIG.payment.iban` is set:

```
BCD\n002\n1\nSCT\n{BIC or empty}\n{holder}\n{IBAN no spaces}\nEUR{amount, always two dot decimals: EUR50.00}\n\n\n{reference}\nBetaling {reference}
```

Encoder: `site/vendor/qrcode.js` (qrcode-generator, MIT — already vendored).
No IBAN configured → show a tidy placeholder tile ("QR volgt") instead; never a broken QR.

## Demo / verification seam

`CHAMP_CONFIG.demoNow = "18:45"` → every "now" computation on the site pretends it is
18:45 on event day. Empty string → real clock. Production cleanup = empty it.
`site/data/demo-state.json` = the same shape as `?action=state`'s payload, used as
fallback when `apiEndpoint` is empty, so the static site still shows the halfway story.
