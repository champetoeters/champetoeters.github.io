# CHAMPETOETERS — Backend API contract (v1)

One backend, two implementations with **identical behaviour**:

- `backend/Code.gs` — Google Apps Script web app (production). Storage = Google Sheet,
  email = MailApp, admin password = Script Properties key `ADMIN_PASSWORD`.
- `tools/devserver.js` — Node dev stub (local testing). Storage = JSON file
  `server-data/state.json` (gitignored), email = appended to `server-data/outbox.jsonl`.
  Also serves `site/` on :8080 and exposes the API under the SAME origin at `/api`.

The site READS live state static-first: the backend pushes `state.json` to the
repo's `state` branch on every mutation (Script property `GITHUB_TOKEN`,
fine-grained, Contents read/write on the one repo), and clients fetch it from
raw.githubusercontent.com (`CHAMP_CONFIG.stateUrl`) — reads cost the script no
runtime, so any crowd can watch. A failed/empty static read falls back to
`?action=state`. All WRITES go to `CHAMP_CONFIG.apiEndpoint`.
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
  `full`, `not-found`, `too-many`, `closed`, `server`.
- `too-many` = an abuse cap was hit on a public write (`register` / `order`):
  max 3 rows per e-mail address per tab (lowercased, +tag stripped), max 120 rows per tab per calendar day (anti-spam, not a sales limit; mail past Google's ~100/day is best-effort).
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
  "teamName": "…",            // REQUIRED: ≥2 chars, ≥1 letter, max 40, name-scrubbed —
                              // this is what the public draw prints
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

Script properties `REGISTER_OPEN` / `ORDERS_OPEN` (dev: env vars): set to
`false` to close a flow — health reports it closed and the public write answers
`{ok:false,error:"closed"}`. Unset or anything else = open. Read at runtime:
flipping them needs no redeploy — but run `authorize()` once after flipping so
the static state.json republished on GitHub carries the new flags.

### GET `?action=health`
→ `{ ok:true, register:true, orders:true }` (flags flip when the event is full/closed).
`register:false` when 16 slots are taken.

### GET `?action=state`
The live overlay the public site polls. **Public-safe fields only.**
```jsonc
{ "ok": true,
  "register": true, "orders": true,   // open/closed — pages read health from
                                      // the static file, no per-visitor call
  "results": { "m01": { "sets": [[6,3],[6,4]], "winner": "A" }, … },
  "teams":   [ { "teamId": "t15", "name": "De Cavaliers",
                 "players": ["Anna Peeters","Tom Claes"] }, … ],
             // registrations that filled an open slot → the TEAM NAME appears in
             // the draw; players stay available for detail/aria text
  "counts":  { "registrations": 14, "slots": 16 } }
```

All four write actions (`register`, `order`, admin `addRegistration`/`addOrder`)
accept an optional **`clientRef`** (token, `[A-Za-z0-9_-]` max 40). A request whose
`clientRef` matches a stored row is answered with THAT row's original result — no
second row, no second mail. This is what makes client retries safe: Apps Script's
response redirect measurably loses ~1 in 10 answers, so `ChampLive.post(…,
{retries: 2})` retries with the same token after a 25s timeout per attempt.
The pages also keep the token in **sessionStorage** together with a fingerprint
of the typed fields, so a reload during "Versturen…" followed by resubmitting
the SAME entry reuses the token (replay, no duplicate) — while different
fields mint a fresh one (never answered with someone else's confirmation).
The stored token is cleared on success.
(Sheet note: `clientRef` is appended as the LAST column of `registrations` and
`orders`, so existing sheets keep working — only their header label is missing.)

### POST `{ action:"register", teamName, player1, player2, email, phone, clientRef? }`
Validation mirrors `site/js/register.js` scrub rules (max lengths 60/60/160/40, same
character policy). On success: stores entry, assigns next open team slot, sends the
confirmation email (Dutch, includes payment instructions — see EMAIL below), returns
`{ ok:true, reference:"INS-07", teamId:"t15", amount:50, mailed:true }`.
**`mailed`** reports whether the confirmation mail actually left (false = quota/
error; the entry stands, and the client switches the confirmation copy so the
page never claims a mail that died). A clientRef REPLAY answers without
`mailed` — treat absent as sent.
If no slots left → `{ ok:false, error:"full" }`. Past the abuse caps →
`{ ok:false, error:"too-many" }`.

### POST `{ action:"order", name, email, quantity }`
quantity integer 1..8. Sends confirmation email. Returns
`{ ok:true, reference:"TKT-12", amount: quantity*12, mailed:true }` (`mailed`:
see register). Past the abuse caps → `{ ok:false, error:"too-many" }`.

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
| `addRegistration` | `teamName, player1, player2, email, phone, paid?` | organiser-entered team (someone signs up at the bar). Validated **exactly** like the public `register` action (same clean/scrub, same rules) but with **no abuse caps** and **no confirmation e-mail**; `paid` is an optional boolean, default `false`. Assigns the next open slot like `register` → `{ok:true, reference:"INS-07", teamId:"t15"}`. No slots left → `{ok:false,error:"full"}` |
| `deleteRegistration` | `ref` | remove the row and free its slot (`health.register` flips back to `true`) → `{ok:true}`. Unknown ref → `{ok:false,error:"not-found"}`, so a repeated call is harmless |
| `addOrder` | `name, email, quantity, paidCount?` | organiser-entered ticket order. Validated **exactly** like the public `order` action (quantity integer 1..8), **no caps**, **no e-mail**; `paidCount` optional, clamped 0..quantity, default 0 → `{ok:true, reference:"TKT-12"}` |
| `deleteOrder` | `ref` | remove the row → `{ok:true}`. Unknown ref → `{ok:false,error:"not-found"}` |
| `seedDemo` | `state` | replace ALL data with the given demo state (verification round). Accepts `site/data/demo-state.json` wholesale: `state.adminDemo.{orders,teamPaid,registrations}` is merged with the top-level keys, and `teams` entries whose slot is already described in full are skipped |
| `resetAll` | – | wipe registrations, orders, results, payments (go-live cleanup) |

The four add/delete ops are ordinary admin writes: password-checked, run inside the
same lock as every other mutation, and drop the `?action=state` cache on success.
Neither add op sends mail — the organiser is standing next to the person.

### References are never reused

`INS-nn` / `TKT-nn` are handed out from a **monotonic high-water mark**, not from
"highest row + 1" — otherwise deleting the newest registration would give its
number to the next one, and two different teams would end up sharing a payment
reference. The next number is `max(highest ref still stored, stored mark) + 1`;
the mark then moves up. Consulting the stored rows as well means a hand-edited
Sheet (or a wiped mark) can only ever push the counter forward, never back.

- `Code.gs` — Script Properties `REF_SEQ_INS` / `REF_SEQ_TKT`.
- `devserver.js` — `refSeq: { INS, TKT }` inside `state.json`.

`resetAll` clears both marks; `seedDemo` restarts them from the seeded rows. A
deleted number is simply skipped, so refs may have gaps — that is intended.

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

## Demo / verification seam

`CHAMP_CONFIG.demoNow = "18:45"` → every "now" computation on the site pretends it is
18:45 on event day. Empty string → real clock. Production cleanup = empty it.
`site/data/demo-state.json` = the same shape as `?action=state`'s payload, used as
fallback when `apiEndpoint` is empty, so the static site still shows the halfway story.
