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
  `full`, `women-full`, `not-found`, `too-many`, `closed`, `server`.
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
                              // teams.json slot with confirmed:false; null if the draw is full)
  "teamName": "…",            // REQUIRED: ≥2 chars, ≥1 letter, max 40, name-scrubbed —
                              // this is what the public draw prints
  "player1": "…", "player2": "…", "email": "…", "phone": "…",
  "teamType": "Vrouwenteam",  // REQUIRED. Sent as a KEY ("vrouwen" | "mannen"),
                              // stored as the Dutch label — see TEAM_TYPES in Code.gs.
  "level": "Ik speel vaak (P100/P200)",   // REQUIRED. Sent as a key
                              // ("af-en-toe" | "vaak" | "heel-vaak"), stored as the
                              // label — see LEVELS in Code.gs. An unknown key on
                              // either field fails the whole entry (bad-request):
                              // a team filed under a guessed niveau is worse than
                              // a team not filed at all.
  "at": "2026-08-01T10:00:00Z",
  "paid": false }

// ticket order — created by action=order
// A basket of NAMED tickets: every ticket is for one person, because the
// wristband handed over at the door has to match that person's formula.
// There is NO buyer name: the page asks only for an e-mail and the name on
// each ticket, and whoever orders/pays need not be one of the holders.
{ "ref": "TKT-12",
  "email": "…",                    // where the confirmation went
  "tickets": [                     // 1..25, sent as { holder, type } only
    { "holder": "An Maes",         // REQUIRED: ≥2 chars, ≥1 letter, max 60
      "type": "cocktail",          // basis | soda | cocktail | fles — TICKET_TYPES
      "label": "Toegangsticket + cocktail of glas Champetoeter (Pommery)",
      "price": 10,                 // the SERVER's price, frozen into the row:
                                   // repricing a formula must never rewrite an
                                   // order somebody already agreed to
      "paid": false }              // per ticket, admin-controlled
  ],
  "summary": "An Maes — Cocktail of glas Champetoeter",  // derived, for the Sheet
  "amount": 10,                    // derived: sum of the ticket prices
  "at": "…" }

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
`register:false` when all slots are taken (`TOTAL_SLOTS` in Code.gs — 22, and it
must be kept in step with `site/data/teams.json`).

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
`{ ok:true, reference:"INS-07", teamId:"t15", amount:44, mailed:true }`
(`amount` = `TEAM_PRICE` in Code.gs, which must match `event.json.teamEntry.price`)..
**`mailed`** reports whether the confirmation mail actually left (false = quota/
error; the entry stands, and the client switches the confirmation copy so the
page never claims a mail that died). A clientRef REPLAY answers without
`mailed` — treat absent as sent.
If no slots left → `{ ok:false, error:"full" }`. Past the abuse caps →
`{ ok:false, error:"too-many" }`.

**`women-full`** — the draw holds at most `MAX_WOMEN_TEAMS` (6) women's teams.
The cap is checked inside the lock, after `full` and before the abuse caps, and
only for `teamType` = `Vrouwenteam`; men's entries are unaffected while places
remain. It is DELIBERATELY NOT ADVERTISED: `?action=state` carries no per-type
tally and the form names no number, so the cap surfaces only here, on the
submit it blocks. register.js prints it under the team-type field (not the
volzet panel — the draw is not full, and changing that one answer is the way
on). `admin.addRegistration` is NOT capped: organisers overrule.

### POST `{ action:"order", email, tickets }`
`tickets` is an array of 1..25 `{ holder, type }` — one entry per person, and
`type` must be a key of `TICKET_TYPES`. The browser never sends an amount: the
server prices every ticket from its own table and sums them. An unknown type,
a missing holder name, an empty array or more than 25 entries → `bad-request`.
No buyer name is taken — a `name` sent by an older client is ignored.

Sends confirmation email listing every named ticket. It has NO mededeling and
no greeting by name: the named tickets are the record of the order. Returns
`{ ok:true, reference:"TKT-12", amount: <sum of prices>, mailed:true }`
(`mailed`: see register). Past the abuse caps → `{ ok:false, error:"too-many" }`
— the caps count ORDERS, not tickets, so one basket of 25 is one row.

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
| `addRegistration` | `teamName, player1, player2, email, phone, paid?` | organiser-entered team (someone signs up at the bar). Validated **exactly** like the public `register` action (same clean/scrub, same rules) but with **no abuse caps** and **no confirmation e-mail**; `paid` is an optional boolean, default `false`. Assigns the next open slot like `register` → `{ok:true, reference:"INS-07", teamId:"t15"}`. No slots left → `{ok:false,error:"full"}` |
| `deleteRegistration` | `ref` | remove the row and free its slot (`health.register` flips back to `true`) → `{ok:true}`. Unknown ref → `{ok:false,error:"not-found"}`, so a repeated call is harmless |
| `addOrder` | `email, tickets[], paid?` | organiser-entered ticket order. Validated **exactly** like the public `order` action, **no caps**, **no e-mail**; `paid` optional boolean, marks the whole basket paid (cash at the door), default `false` → `{ok:true, reference:"TKT-12"}`. There is no per-ticket `paid` here: /admin/ files the basket with this one flag and corrects a mixed one afterwards with `setTicketPaid` |
| `setTicketPaid` | `ref, seq, paid` | tick ONE named ticket in an order. `seq` is 1-based, as /admin/ lists them. Out of range → `{ok:false,error:"bad-request"}`; unknown ref → `not-found` |
| `deleteOrder` | `ref` | remove the row → `{ok:true}`. Unknown ref → `{ok:false,error:"not-found"}` |
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

`resetAll` clears both marks. A
deleted number is simply skipped, so refs may have gaps — that is intended.

Team payment state for organiser-entered teams (any `confirmed` slot in teams.json) is stored as
`{ key, paid }` rows; registrations carry their own `paid` field addressed by ref.
`overview` returns `teamPaid: { "t01": true, … }` alongside.

## EMAIL (sent by backend on register/order — Dutch, plain + concise)

Subject register: `Inschrijving ontvangen · CHAMPETOETERS & FRIENDS`
Subject order:    `Je open air tickets · CHAMPETOETERS & FRIENDS`

Body must contain: what was registered/ordered, the amount, payment instructions
block. A register mail greets the players by name and carries a mededeling (the
team name); an order mail greets nobody by name and carries NO mededeling — it
lists the named tickets instead, and nobody is asked to type a reference:

> Betalen kan op twee manieren:
> • Overschrijving naar {IBAN} op naam van {HOLDER}[ met mededeling "{MEDEDELING}"].

{MEDEDELING} is the TEAM NAME for a register mail. An order mail has none, and
the clause is left out entirely — the line ends after {HOLDER}.
> • Of ter plaatse op het event (cash of Payconiq).
> Nog niet betaald? Geen probleem — je plaats/tickets staan vast zodra we je
> betaling ontvangen of je ter plaatse betaalt.

IBAN/HOLDER come from Script Properties `PAY_IBAN`, `PAY_HOLDER`. ⚠ Both have a
HARDCODED fallback in `payIban_()` / `payHolder_()` (and the same in the dev stub):
leaving the property **unset** does NOT disable the IBAN — it mails the fallback,
which is the event's real account. Only an explicitly EMPTY `PAY_IBAN` produces the
"Het rekeningnummer volgt nog — betalen kan ook ter plaatse." variant. Set both
properties deliberately; do not rely on "unset" meaning "off".
No Reply-To header: replies go to the sending account (the event's own address).
Include contact line + venue/date footer.

## The clock

`?now=HH:MM` on any page → every "now" computation pretends it is that moment on
event day, on the 12:30 → 26:00 event scale. It is a VIEW hook: it moves which
match reads as live and which act reads as on stage, and it is the only way to
see the event-day rendering before the day. It cannot reach this API, write
anything, or make a page claim a result the published state does not carry.
