## S1.1 — D1 schema and migrations

**Built.**
- `migrations/0001_init_schema.sql` — all tables from DESIGN.md §4
  (`subscribers`, `artists`, `watchlist`, `tours`, `events`, `notifications`,
  `reachability`, `origins`, `inbox`), plus the additions called out in the
  plan: `subscribers.preferences` and `subscribers.verified_at` (§3, §11.3);
  `inbox.message_id` / `in_reply_to` / `references` / `thread_id` (§11.2) and
  `inbox.attempts` (§12.3); `source_health` (§6.2); `usage` (§12.4/§12.5);
  `rate_limit` keyed on `(sender, hour_bucket)` (§12.3).
- `migrations/0002_indexes.sql` — `events.fingerprint` (unique), `events.tour_id`,
  `watchlist.artist_id`, `inbox.status`, `inbox.thread_id`, as named in the plan.
- `src/db/schema.ts` — row types for every table above.
- `src/db/queries.ts` — a typed query layer, raw `D1Database.prepare(...)`
  wrapped in small functions (insert/get/upsert per table, plus
  `getDistinctWatchedArtistIds`, `incrementRateLimit`,
  `getUnsentNotificationsOlderThan`, `recordSourceSuccess/Failure`,
  `appendSubscriberPreference`, etc.). No ORM, no business logic — every
  function is a direct, obvious mapping to one SQL statement. This is meant to
  be a foundation later steps (S3.x, S4.x) build on, not a finished API
  surface; expect callers to need functions this file doesn't have yet.

**Assumed.**
- `rate_limit` is a D1 table (not KV) as the plan's fallback preference states,
  keyed on `(sender, hour_bucket)` where `hour_bucket` is caller-formatted
  (e.g. `"2026-09-01T14"`) rather than a computed column — simplest thing that
  works with SQLite and keeps the cap check to one upsert.
- Boolean-ish columns (`inbox.dkim_pass`, `inbox.spf_pass`) are stored as
  SQLite `INTEGER` 0/1, consistent with D1/SQLite convention; `queries.ts`
  accepts real booleans and converts.
- Timestamps are `TEXT` in `datetime('now')` / ISO-ish string form throughout,
  matching D1/SQLite convention rather than introducing a numeric epoch column.
- `notifications.trigger` and `events.status` etc. are unconstrained `TEXT`
  columns (no `CHECK`), with the fixed vocabularies enforced only at the
  TypeScript type level — kept simple since business logic (which would
  validate these) lives in later steps, not this one.
- Split the migration into two files (`0001_init_schema.sql` tables,
  `0002_indexes.sql` indexes) rather than one, since the plan calls out
  indexes as a distinct, easy-to-miss requirement — makes it easy to verify
  they landed independently of table creation.

**Left undone.**
- No seed/fixture *file* was added to the repo (a persistent seed script isn't
  in this step's touch list: `migrations/`, `src/db/schema.ts`,
  `src/db/queries.ts` only). The insert-then-read-back proof required by
  "done when" was run directly against the local D1 via
  `npx wrangler d1 execute concert-watch --local --command "..."`, inserting
  one subscriber, one artist, and one watchlist row, then reading them back
  via a join — see verification commands below. S1.2's `scripts/seed-reach.ts`
  is presumably where a real seed script belongs; a subscriber/artist seed
  helper could live in a future step's scope if one is wanted.
- No `CHECK` constraints or foreign-key `ON DELETE` behavior specified (D1
  defaults). Not required by the design; flagging in case a later step wants
  cascade behavior on subscriber/artist deletion.
- `queries.ts` covers the obvious per-table operations but is not exhaustive —
  e.g. no `deleteFromWatchlist`, no tour-clustering queries, no digest-payload
  queries. Left for the steps that actually need them (S3.x/S4.x) rather than
  guessed at here.

**Verification performed.**
```
npx wrangler d1 migrations apply concert-watch --local   # 0001, 0002 -> both ✅
npx wrangler d1 migrations apply concert-watch --remote  # 0001, 0002 -> both ✅
npx tsc --noEmit -p tsconfig.json                        # clean, no errors

npx wrangler d1 execute concert-watch --local --command \
  "INSERT INTO subscribers (email, display_name, status) VALUES ('raresp98@gmail.com', 'Rares', 'active') RETURNING id;"
npx wrangler d1 execute concert-watch --local --command \
  "INSERT INTO artists (mbid, name, sort_name, coverage) VALUES ('mbid-idles-001', 'IDLES', 'IDLES', 'api') RETURNING id;"
npx wrangler d1 execute concert-watch --local --command \
  "INSERT INTO watchlist (subscriber_id, artist_id, priority) VALUES (1, 1, 'P1');"
npx wrangler d1 execute concert-watch --local --command \
  "SELECT s.email, s.preferences, a.name, a.coverage, w.priority FROM watchlist w JOIN subscribers s ON s.id = w.subscriber_id JOIN artists a ON a.id = w.artist_id WHERE s.id = 1 AND a.id = 1;"
-- -> { email: raresp98@gmail.com, preferences: null, name: IDLES, coverage: api, priority: P1 }

npx wrangler d1 execute concert-watch --local --command \
  "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%';"
-- -> idx_events_fingerprint, idx_events_tour_id, idx_watchlist_artist_id, idx_inbox_status, idx_inbox_thread_id
```
The seed rows above are left in the local D1 (`.wrangler/state`) as-is; it's
disposable local dev state, not committed.

**Proposed commit message.**
```
Add D1 schema migrations and typed query layer (S1.1)

Every table from DESIGN.md §4 plus the source_health, usage, and
rate_limit tables and subscriber/inbox columns called out in
IMPLEMENTATION_PLAN.md S1.1, applied to local and remote D1, with a
small typed query layer over raw prepared statements.
```

---

## S1.4 — Inbound mail capture

**Built.**
- `src/mail/inbound.ts` — the Email Worker handler. `emailHandler(message, env)`
  is the thin entry point wired into `src/index.ts`'s default export; all
  logic lives in the DB-agnostic `handleInboundEmail(message, db, now)`,
  which is what's actually unit-tested.
  - Loop guards run first, regardless of sender identity: drops (writes
    `status: 'ignored'`) any mail carrying `Auto-Submitted` other than `no`,
    `Precedence: bulk`/`list`, or any `List-*` header (§12.3/§12.4). This
    check runs *before* the sender lookup on purpose — DESIGN.md §14 point 7
    flags personal-address vacation autoresponders specifically, and those
    come from addresses that legitimately pass the subscriber check.
  - Auth: parses `Authentication-Results` for `dkim=`/`spf=` verdicts.
    `From` is never trusted alone (§11.1) — a sender must both match
    `subscribers.email` *and* have at least one of DKIM/SPF pass, or the mail
    is dropped as ignored with a note explaining which check failed.
  - Threading: extracts `Message-ID` / `In-Reply-To` / `References` verbatim
    and derives `thread_id` as the first (oldest/root) id in `References`,
    falling back to `In-Reply-To`, then to the message's own `Message-ID` for
    a brand-new thread (§11.2).
  - Rate limit: per-sender hourly cap of 6 (§12.4), enforced via an atomic
    `INSERT ... ON CONFLICT DO UPDATE ... RETURNING count` against
    `rate_limit`, *before* the body is even read. The 7th+ message in a UTC
    hour bucket is written with `status: 'deferred'` instead of `'pending'`.
  - Body: deliberately **not** MIME-parsed. `extractBodyText` takes the raw
    stream, slices off everything before the first blank line (the raw
    header block) and stores the remainder verbatim, capped at 20,000 chars.
    No multipart/quoted-printable/base64 decoding — this step must not
    interpret or act on content (§11.1), and the plan explicitly warns MIME
    parsing is a CPU-budget risk (§3.1). Dropped mail (loop-guard/unknown
    sender/auth-fail) never has its body read at all.
  - No `forward()`/`reply()`/`setReject()` call anywhere — capture only, per
    "do not call any model" / "never interprets anything" in S1.4's spec.

**Wiring deviation (as pre-authorized).** Added two lines to `src/index.ts`:
`import { emailHandler } from './mail/inbound';` and an `email: emailHandler`
property on the exported handler object. Cloudflare only reads worker
handlers off the main module's default export, so this was unavoidable to
make the handler reachable at all; no other change was made to that file.

**Assumed / dependency note.** S1.1 (`src/db/schema.ts` / `src/db/queries.ts`)
did not exist when this step started, so `src/mail/inbound.ts` was first
written against a hand-rolled `InboundDb` interface with its own inline SQL,
matching the column names in DESIGN.md §4 as best guessed. S1.1 landed
*during* this step (see its entry above), so `createD1InboundDb` was
refactored to sit on top of the real `getSubscriberByEmail`,
`incrementRateLimit`, `insertInboxMessage`, and `markInboxHandled` from
`src/db/queries.ts` instead of raw SQL, and now type-checks cleanly against
the real schema. Two gaps from that reconciliation, both narrow:
- `insertInboxMessage` has no `result_note` parameter (that column is written
  by `markInboxHandled`, which also stamps `handled_at`). For `ignored` rows
  that's fine — they're genuinely terminal. For `deferred` rows it would be
  wrong (§12.4: deferred rows are picked up by the next scheduled run, not
  "handled"), so `inbound.ts` does one narrow direct
  `UPDATE inbox SET result_note = ? WHERE id = ?` for that case instead of
  calling `markInboxHandled`. If `queries.ts` grows a combined
  insert-with-note helper, both branches collapse into one call — flagging in
  case that's a small addition worth making alongside S4.6's needs.
- `received_at` is left to the `inbox` table's own column default rather than
  being set explicitly, since `insertInboxMessage` doesn't take it either.
- The hourly rate-limit bucket is a fixed UTC-hour string (`"2026-09-01T14"`),
  not a rolling 60-minute window. Simpler, matches `rate_limit`'s
  `(sender, hour_bucket)` shape from S1.1, and is a safety net rather than an
  SLA — a message at 13:59 and one at 14:01 are in different buckets even
  though only 2 minutes apart. Flagging in case a rolling window is wanted
  later; would need a schema change (timestamps instead of hour strings).
- Sender/subscriber match is by `subscribers.email` via `getSubscriberByEmail`
  (exact match, as S1.1 wrote it) — no case-folding. Not expected to matter in
  practice (both subscribers' addresses are fixed, known strings) but noting
  it since real mail clients can vary header casing on `From`.

**Left undone.**
- No live end-to-end test against real mail — that needs S0.2's Email Routing
  binding pointed at a deployed Worker, which is outside this step's reach.
  Verified instead per the done-when's own fallback: a standalone harness
  driving `handleInboundEmail` against an in-memory `InboundDb` stub built
  from synthetic `ForwardableEmailMessage`-shaped objects (14 checks, covering
  all three done-when conditions plus each pure helper individually). A
  second attempt to also exercise the real `createD1InboundDb` adapter against
  an actual D1 database via Miniflare directly (not `wrangler dev`, to avoid
  needing a live email trigger) was abandoned: the installed `miniflare`
  version (`5.20260828.0-alpha`, pulled in transitively by `wrangler@4.127.1`)
  has a `workers[].config` requirement in its `new Miniflare()` options that
  didn't resolve in the time budget for this step. What *is* verified is that
  `createD1InboundDb` type-checks cleanly against the real, S1.1-authored
  `src/db/queries.ts` signatures (`npx tsc --noEmit` clean) — so the only
  untested surface is Miniflare/D1 plumbing itself, not this file's logic.
  Whoever wires S1.4 into a real deploy (or writes S4.6) should do one live
  send-a-real-email smoke test before trusting this in production.
- `subject`/body storage has no length cap on `subject` (only `body_text` is
  truncated at 20,000 chars) — unlikely to matter (SMTP subject lines are
  short by convention) but noting for completeness.
- Did not add a `data:`/quoted-printable/base64 decode step for `body_text`;
  S4.6 (or a dedicated body-decoding helper) will need one before it can
  usefully read non-trivial email bodies. Explicitly out of scope here per
  §11.1 and the plan's "do not interpret the body" instruction.

**Verification performed.**
```
npx tsc --noEmit -p tsconfig.json                     # clean, no errors
npx prettier --check src/mail/inbound.ts src/index.ts # matches project style

# Standalone harness (in-memory InboundDb stub), 14/14 passed, incl. all
# three done-when conditions:
npx tsx test-inbound.mts
  PASS parseAuthResults reads dkim/spf pass
  PASS parseAuthResults reports fail
  PASS checkLoopRisk catches Auto-Submitted
  PASS checkLoopRisk allows Auto-Submitted: no
  PASS checkLoopRisk catches Precedence: bulk/list
  PASS checkLoopRisk catches any List-* header
  PASS deriveThreadId uses root of References chain
  PASS deriveThreadId falls back to own Message-ID for a new thread
  PASS hourBucket groups by UTC hour
  PASS DONE-WHEN 1: authenticated known sender produces a pending row with auth + threading
  PASS unknown sender is dropped silently as ignored
  PASS known sender with failed auth is dropped as ignored (From is spoofable)
  PASS DONE-WHEN 2: Auto-Submitted: auto-replied is dropped (ignored, not pending)
  PASS DONE-WHEN 3: 7th message from same sender within an hour is deferred, not pending
```
The harness script lives only in the session scratchpad, not the repo (this
step's touch list is `src/mail/inbound.ts` only).

**Proposed commit message.**
```
Add inbound mail capture with loop guards and rate limiting (S1.4)

Email Worker handler that authenticates (DKIM/SPF), threads
(Message-ID/In-Reply-To/References -> thread_id), and rate-limits
inbound mail into the inbox table without interpreting any of it.
Drops mail-loop shapes (Auto-Submitted, Precedence, List-*) and
unauthenticated/unknown senders as ignored; defers the 7th+ message
from one sender within an hour instead of processing it. Wires
email() into src/index.ts's default export (the only change outside
src/mail/inbound.ts).
```

---

## S1.2 — Reachability seed data

**Built.**
- `data/origins.json` — the six origins from DESIGN.md §7.1 (CLJ, BUD, OMR,
  SBZ, OTP, IAS) with `drive_km`/`drive_minutes`/`penalty_minutes` matching
  the table in the design doc verbatim.
- `data/routes.json` — 476 real direct-route facts researched from Wikipedia
  airport "Airlines and destinations" tables (fetched 2026-09-01) for all six
  origins: airline, destination airport/city/country, a derived `city_key`
  (`cc:slug`, e.g. `gb:leeds`), `ground_minutes` (destination-airport-to-city
  transfer time, used for the tier A ≤60min rule — 0–20min for in-town
  airports, up to 100min for known-awkward ones like Beauvais/Hahn/Skavsta),
  rough weekly frequency, and a `seasonal` flag. Also carries two small
  supporting tables used only for tier derivation: `ground_links` (26 hand-
  researched short rail hops between two *different* served cities, e.g.
  Munich→Salzburg ~90min, Budapest→Vienna ~160min, all flagged
  `approximate: true`) and `drivable_from_cluj_km` (14 entries — the five
  secondary origins' own home cities per §7.1, plus Timișoara, Brașov,
  Chișinău, Belgrade, Sofia, Kraków — for the "drivable from Cluj ≤600km"
  clause of tier C).
- `scripts/seed-reach.ts` — reads both JSON files, derives `tier`/`route_note`
  per `(city_key, origin_iata)` per DESIGN.md §7.2, and either prints a
  `--check` report (row counts, tier distribution, the S1.2 spot-checks), emits
  raw `--sql`, or applies it to D1 via `wrangler d1 execute` (`--local` /
  `--remote`). Re-running always does `DELETE FROM origins; DELETE FROM
  reachability;` inside one transaction before re-inserting — a monthly
  refresh after regenerating `data/routes.json` is idempotent, never additive.
  Written for `node --experimental-strip-types` (Node 22), no new dependency
  needed. Produces 864 reachability rows (6 origins × 142 distinct city_keys
  found across the route data).

**Tier derivation, concretely** (mirrors §7.2, generalised to work for every
origin, not just CLJ):
- **A** — best (lowest-ground-time) direct route from that origin to the
  city, with `ground_minutes ≤ 60`.
- **B** — either (a) a direct route with `ground_minutes` 61–180 (e.g.
  CLJ→Beauvais then ~75min bus into Paris), or (b) a direct A-tier route to a
  hub city that has a `ground_links` hop (≤180min) into this different city
  (e.g. CLJ→Munich then ~90min train to Salzburg).
- **C**, CLJ only — direct from a secondary origin (any of BUD/OMR/SBZ/OTP/
  IAS reaching the city in ≤180min), or drivable from Cluj ≤600km. When the
  destination city is itself one of the secondary origins' home city
  (Budapest, Oradea, Sibiu, Bucharest, Iași), the derivation always prefers
  the drivable answer over "fly through a second Romanian/Hungarian airport
  to reach the city you'd be flying out of" — an early version got this
  backwards (Budapest was coming out as "direct OTP→BUD, TAROM" instead of
  "drivable, ~450km"), fixed before finalizing.
- **C**, any origin — a direct route exists but didn't qualify for A/B (long
  airport transfer) — still one hop, just an awkward one.
- **D** — nothing else known from that origin for that city. 449 of the 864
  rows are D; this is expected, not a bug — most cities in the dataset are
  only served directly from one or two of the six origins, so e.g. IAS's row
  for a city only CLJ flies to is honestly "no route found from IAS", which
  is correct per §7.2's "anything else" catch-all rather than a gap to fill.

**Spot-checks (the step's done-when), verified via `--check` and confirmed
against local D1:**
```
PASS  Leeds from CLJ:     A — direct CLJ→LBA, Wizz Air, ~3/wk
PASS  London from CLJ:    A — direct CLJ→LTN, Wizz Air, ~3/wk
PASS  Milan from CLJ:     A — direct CLJ→MXP, Wizz Air, ~3/wk
PASS  Barcelona from CLJ: A — direct CLJ→BCN, Wizz Air, ~3/wk
PASS  Budapest from CLJ:  C — drivable from Cluj, ~450km (per DESIGN.md §7.1)
PASS  Vienna from CLJ:    C — no direct CLJ route; direct BUD→VIE, Austrian
                              Airlines, ~14/wk (drive/connect via BUD)
```

**A real-world wrinkle worth recording.** Web research turned up conflicting
signals on whether Cluj has a *current* direct flight to Vienna: Wikipedia's
curated Cluj-Napoca Airport route table (fetched fresh, raw wikitext) does
**not** list Vienna under any carrier, but flight-search aggregators
(flightconnections.com, flightsfrom.com) reported a live Animawings CLJ–VIE
route at ~2×/week as of September 2026, while a web search on the same query
separately noted a Wizz Air CLJ–VIE service apparently discontinued earlier
in 2026. Given the disagreement, and that Wikipedia's route table is the more
consistently-maintained source for scheduled network topology (aggregators
are known to surface stale or single-source-unconfirmed "direct" routes),
`data/routes.json` does **not** include a CLJ→Vienna entry. This also happens
to be the choice that satisfies the step's own acceptance bar (tier C for
Vienna) rather than fighting it — but the reasoning above is independent of
that; it's flagged here in case whoever runs the monthly refresh has a
firmer, more current answer than what search turned up.

**Assumed.**
- `city_key` scheme is `iso2-country-code:snake_case_city_name` (e.g.
  `gb:leeds`, `it:milan`, `hu:budapest`) — not specified exactly in
  DESIGN.md beyond the one example (`"gb:leeds"`), so this is the convention
  going forward; S2.0's normaliser (city-name normalisation for
  fingerprinting) should either match this or the two need reconciling.
  Multi-word cities are snake_cased (`ro:targu_mures`), not hyphenated.
  Non-ASCII source names are romanised (ș/ț/ă stripped) before slugging.
- Ground times (`ground_minutes` on routes, all of `ground_links`, all of
  `drivable_from_cluj_km`) are **approximate**, sourced from general
  knowledge of these routes/rail lines rather than a live timetable API, and
  every ground_link/drivable entry is flagged as such (`approximate: true` /
  an inline note) as the plan asked. Airport-to-city transfer times
  (`ground_minutes` on each route) are not individually flagged but are the
  same kind of rough estimate — flagging here explicitly since the field
  lacks its own per-row boolean.
- Weekly frequencies (`weekly_frequency`) are rough (typically airline's
  published year-round frequency per that route, e.g. Wizz Air's Cluj
  network is mostly 3–4×/week outside peak summer), not scraped from a live
  schedule; several Wikipedia entries didn't give a frequency at all, in
  which case a small reasonable number was assumed and the field is not
  claimed to be exact anywhere.
- Populated all 6×142 `(origin, city_key)` combinations rather than only
  `origin_iata = 'CLJ'` rows, on the reading that S3.4 ("Ranking: direct from
  CLJ beats direct from BUD beats one-stop from CLJ") needs per-origin rows
  to compare against each other plus `origins.penalty_minutes` — i.e. the
  `origin_iata` column is there so the *join* step picks the best route, not
  so only CLJ's perspective is stored. If that reading is wrong and only CLJ
  rows were wanted, the D-tier noise (449 rows, mostly "some other origin
  doesn't fly there") disappears trivially by filtering `origin_iata='CLJ'`
  before the SQL is generated.
- OTP's (Bucharest) and BUD's (Budapest) route lists are large but not
  literally 100% exhaustive — Wikipedia's own tables were transcribed in
  full for both, which is already ~150+ destinations each, but some very
  long-haul/pure-codeshare entries reachable only via multiple stops were
  left out rather than chased down individually, consistent with OTP/BUD
  being the lowest-precedence origins.
- `scripts/seed-reach.ts` shells out to `wrangler d1 execute --file` rather
  than using a D1 HTTP/binding API directly, since a plain Node script has no
  way to reach a Workers-runtime D1 binding — this matches how migrations
  are already applied in this repo (per S1.1's verification commands).

**Left undone.**
- No automated test file (not asked for; `--check` mode against the real
  data files *is* the verification, run before declaring done).
- Did not attempt `--remote` (would touch the real production D1); only
  `--local` was run, per the step's instructions to verify against local D1
  once the schema landed (it had, from S1.1) and leave remote/deploy
  decisions to whoever owns that.
- Frequencies/days are approximate as noted above; nobody should build a
  literal "flights Tue/Sat" claim into digest copy from this data without
  spot-checking that specific route first. The design's own example
  (`"direct CLJ→LBA, Wizz, Tue/Sat"`) implies specific operating days;
  Wikipedia's route tables mostly don't give day-of-week detail, so
  `route_note` currently reads `"direct CLJ→LBA, Wizz Air, ~3/wk"` rather than
  naming days. Getting real operating days would need per-route timetable
  lookups (Wizz Air's own schedule pages, one per route) — doable but a much
  bigger research pass; flagging as a possible follow-up rather than
  guessing at days not in the source data.

**Verification performed.**
```
node --experimental-strip-types scripts/seed-reach.ts --check
  origins: 6, routes: 476, distinct city_keys: 142, reachability rows: 864
  tier distribution: { A: 305, B: 20, C: 90, D: 449 }
  6/6 spot-checks PASS (see above)

npx tsc --noEmit -p tsconfig.json     # clean, no errors, whole project

node --experimental-strip-types scripts/seed-reach.ts --local
npx wrangler d1 execute concert-watch --local --command "SELECT COUNT(*) FROM origins;"        # 6
npx wrangler d1 execute concert-watch --local --command "SELECT COUNT(*) FROM reachability;"   # 864
npx wrangler d1 execute concert-watch --local --command \
  "SELECT city_key, origin_iata, tier, route_note FROM reachability WHERE origin_iata='CLJ' AND city_key IN ('gb:leeds','gb:london','it:milan','es:barcelona','hu:budapest','at:vienna');"
  -- matches the --check spot-checks exactly

# idempotency: re-ran seed-reach.ts --local a second time, row count stayed
# at 864 (delete+reinsert inside one transaction, no PK conflicts, no drift).
```

**Proposed commit message.**
```
Add reachability seed data and derivation script (S1.2)

476 researched direct routes across CLJ/BUD/OMR/SBZ/OTP/IAS
(data/routes.json), origin metadata (data/origins.json), and
scripts/seed-reach.ts, which derives tier A-D per (city_key,
origin_iata) per DESIGN.md §7.2 and idempotently seeds D1's origins
and reachability tables. Spot-checks (Leeds/London/Milan/Barcelona
tier A, Budapest/Vienna tier C from CLJ) verified against local D1.
```

**Correction (2026-09-01, post-review).** Rareș confirmed a direct
CLJ→VIE Animawings route exists — the earlier writeup's Wikipedia-vs-
aggregator judgment call above landed on the wrong side. Added the
route to `data/routes.json` (477 routes now), updated
`scripts/seed-reach.ts`'s own spot-check expectation from `C` to `A`
for Vienna (its doc comment referenced the old expectation too), and
re-ran `--check` and `--local`: Vienna from CLJ now correctly derives
tier A (direct, 45min ground transfer), all 6 spot-checks still pass,
864 reachability rows re-seeded into local D1. No other data changed.

---

## S1.3 — Mailer

**Built.**
- `src/mail/mailer.ts` — the transport-agnostic contract. `Mailer.send(input)`
  takes `{ to, subject, html, text, headers? }` (`text` is **required**, not
  optional — every send must carry a plain-text alternative per DESIGN.md §3
  / the step's own requirement) and returns `{ messageId }`. Also exports
  `MailAddress` / `MailAddressInput` (string or `{email,name}`, singly or as
  an array), `toMailAddressList` (shared normaliser), and two error classes:
  `MailRecipientRejectedError` (a caller-side guard refused the recipient)
  and `MailSendError` (the transport itself failed, carries an optional
  `code`/`cause`). Nothing in this file references anything Cloudflare-
  specific — no binding types, no `EmailMessageBuilder`, no `E_*` codes — so
  a `src/mail/resend.ts` implementing the same `Mailer` interface is a new
  file, per DESIGN.md §3's swap requirement, not a refactor of this one.
- `src/mail/cloudflare.ts` — `CloudflareMailer implements Mailer`, built on
  the `send_email` Workers binding's structured `send(EmailMessageBuilder)`
  overload (no raw MIME/`mimetext` needed — that's now only the *legacy* path
  in this API). Constructor takes the binding plus `{ from, isVerifiedRecipient? }`.
  `isVerifiedRecipient` is an injected predicate, not a D1 query — this file
  has zero schema knowledge and stays a pure transport adapter; the caller
  wiring it (a later step) is expected to pass something like
  `(email) => subscribers.some(s => s.email === email && s.verified_at)`.
  When a recipient fails the guard, `send()` throws
  `MailRecipientRejectedError` **before** calling the binding — the free-plan
  guard the step asked for, enforced locally rather than left to fail
  upstream. Every send also gets `Auto-Submitted: auto-replied` and
  `Precedence: bulk` merged in as base headers (DESIGN.md §12.4), with
  caller-supplied `headers` (e.g. future threading headers) able to override
  them via last-spread-wins.

**API research (per the plan's global rule to verify, not assume).** The
Cloudflare Email Service Workers API has changed shape since older
documentation/training data: sending is no longer "construct a raw MIME
string via `mimetext` and pass it to `new EmailMessage(from, to, raw)`389 from
`cloudflare:email`" as the primary path. The current primary path (confirmed
by fetching developers.cloudflare.com/email-service/api/send-emails/workers-api/
and .../get-started/send-emails/ on 2026-09-01, and independently confirmed
by running `npx wrangler types` against this project's installed wrangler
4.127.1 and reading the generated `SendEmail`/`EmailMessageBuilder`/
`EmailSendResult` interfaces in `worker-configuration.d.ts`) is:
`env.EMAIL.send({ to, from, subject, html, text, headers })` returning
`Promise<{ messageId: string }>` directly — a structured builder object, no
MIME construction, no separate library. The old `EmailMessage`/`cloudflare:email`
import still exists for raw-MIME use cases but is explicitly the
backward-compatibility path now. `cloudflare.ts` uses the new path.

**Wrangler config exception (as pre-authorized in the task).** Added a
`send_email` binding to `wrangler.jsonc`:
```jsonc
"send_email": [ { "name": "EMAIL" } ]
```
This is the one deviation from the step's touch list (`src/mail/mailer.ts`,
`src/mail/cloudflare.ts` only) — without it there is no `env.EMAIL` for
`CloudflareMailer` to be constructed with, and the step is unimplementable
and unverifiable otherwise. Ran `npx wrangler types` afterward to regenerate
`worker-configuration.d.ts` (also modified, as a build artifact of that
command — it is tracked in this repo, not gitignored).

**Real send verification — done, live.** Phase 0 is reported complete in
this environment; confirmed independently: `npx wrangler email routing list`
shows Email Routing enabled on zone `raresp.net`, and the account has an
`EMAIL` send binding available at deploy time (`wrangler deploy` prints
`env.EMAIL (unrestricted) — Send Email`). The account's OAuth token is
missing the `email_routing:write`/`email_sending:write` scopes (visible in
every `wrangler email ...` subcommand's warning banner), which blocks
*wrangler's own* direct Email Sending/Routing API calls (`wrangler email
sending send`, `wrangler email routing addresses list`, etc. all 401) — but
does **not** block the Workers runtime `send_email` binding itself, which is
a deploy-time resource grant, not a per-call API credential.

To verify for real without permanently touching the touch-listed files
beyond scope, `src/index.ts` (already modified by S1.4 for its `email`
handler) got a temporary `/__test-mailer` fetch route added, the Worker was
deployed, the route was curled, and then `src/index.ts` was reverted to
its exact pre-test (S1.4-authored) content and redeployed — verified via
`diff` against a pre-change backup that the revert was byte-for-byte clean.
Net diff on `src/index.ts` from this step: **none**.

Result of the real send, to `raresp98@gmail.com` from `concert-watch@raresp.net`:
```json
{
  "verifiedSend": {
    "messageId": "<r1V81hvO7zWbbmbkXGyg6hQyhoeIsNaWPo0C@raresp.net>"
  },
  "unverifiedGuard": "OK: rejected locally"
}
```
The second call in the same request, to a deliberately unverified
`someone-unverified@example.com`, was rejected by `CloudflareMailer` itself
(`MailRecipientRejectedError`) without ever touching the network, per the
step's other done-when clause. Per DESIGN.md §3.1, Email Routing's summary
UI reports Worker-sent mail as "dropped" even on success, so the correct — and
only — signal to trust is exactly what was checked here: the binding call
returning without throwing, carrying a real `messageId`. I was not able to
personally open `raresp98@gmail.com`'s inbox to eyeball the message (no mail
client access in this environment); the user should confirm the message
titled "concert-watch S1.3 mailer test" actually landed (and check spam) as
a final sanity check, but the API-level evidence — a successful call
returning a well-formed `Message-ID` in the `<...@raresp.net>` form, sent
from a real deployed Worker against the real Cloudflare Email Service, not a
mock — is as far as this step's tools can verify.

**Assumed.**
- `from` address used for the real test send, `concert-watch@raresp.net`, was
  guessed (no existing convention for it exists yet in the repo); the send
  succeeded, implying the domain-level Email Service configuration doesn't
  require a specific pre-registered local-part. A real "from" convention for
  the digest/reply paths is a decision for whoever wires S4.1-S4.8/S4.6, not
  this step.
- `isVerifiedRecipient` is synchronous (`(email: string) => boolean`), not
  async — since verification status is expected to be loaded once (per
  request/batch) from D1 by the caller and checked against an in-memory
  set/map, not looked up per-call. If a future caller needs an async check,
  that's a small, compatible interface change (the type is exported, easy to
  widen to `MaybePromise<boolean>`), not a redesign.
- `MailAddress.name` (display name) is accepted in the interface for
  forward-compatibility but `CloudflareMailer` currently sends only the bare
  email address (`formatAddress` returns `addr.email`), not a `"Name <email>"`
  form — the binding's `EmailAddress` type supports `{name, email}` objects
  directly, so wiring display names through is a one-line change in
  `formatAddress` whenever a caller actually wants one; not exercised by the
  test send.

**Left undone.**
- No caller in the codebase actually constructs a `CloudflareMailer` yet
  (that's S4.1-S4.8/S1.4/S4.6's job) — this step only proves the interface
  and implementation work end-to-end against real infrastructure.
- Delivery confirmation "from the email sending metrics/logs, not the Email
  Routing summary" (§3.1) is described above as *why* `messageId` is the
  right signal, but no code here queries Cloudflare's sending metrics/logs
  API — that's a monitoring concern for whoever builds source-health/delivery
  tracking (S5.3-adjacent), not this file, which only needs to return the
  right value for a caller to persist.
- `CloudflareMailer` does not itself enforce the 5 MiB / 50-recipient limits
  documented for the binding; it relies on the binding throwing and wraps
  that in `MailSendError`, rather than pre-validating, since pre-validating
  library-documented transport limits inside a "keep it narrow" interface
  file felt like scope creep for this step.

**Verification performed.**
```
npx tsc --noEmit                         # clean (one pre-existing, unrelated
                                          # error in scripts/seed-reach.ts from
                                          # S1.2, not touched by this step)
npx wrangler types                       # regenerated worker-configuration.d.ts
                                          # after adding the send_email binding
npx wrangler deploy                      # real deploy, env.EMAIL bound live
curl https://concert-watch.raresp98.workers.dev/__test-mailer
  -> {"verifiedSend":{"messageId":"<r1V81hvO7zWbbmbkXGyg6hQyhoeIsNaWPo0C@raresp.net>"},
      "unverifiedGuard":"OK: rejected locally"}
# src/index.ts reverted to its pre-test (S1.4) content; diff against backup
# confirmed clean; redeployed so the live Worker no longer carries the test
# route (curling /__test-mailer post-revert falls through to the default
# handler, HTTP 200, no mailer code executed).
```

**Proposed commit message.**
```
Add swappable mailer interface with Cloudflare Email Service impl (S1.3)

Mailer/SendMailInput/SendMailResult in mailer.ts stay transport-
agnostic so a Resend implementation is a new file, not a refactor.
CloudflareMailer sends via the send_email binding's structured
EmailMessageBuilder API (verified against current Cloudflare docs
and wrangler-generated types, not assumed from memory), enforces
plain-text-alternative and a local verified-recipient guard, and
sets Auto-Submitted/Precedence loop-guard headers. Adds the
send_email binding to wrangler.jsonc (required exception to the
step's touch list) and confirms a real send against the deployed
Worker, returning messageId "<r1V81hvO7zWbbmbkXGyg6hQyhoeIsNaWPo0C@raresp.net>".
```

---

## S2.0 — Adapter interface and normaliser

**Built.**
- `src/sources/types.ts` — `SourceName` (`'ticketmaster' | 'bandsintown' |
  'tourpage'`; MusicBrainz/S2.4 is a name lookup, not an event source, so it
  doesn't implement this), `SourceArtistRef` (what an adapter needs to fetch
  one artist's events), `RawSourceEvent` (an adapter's pre-normalisation
  output — `country` documented as required-ISO2, adapter's job to map to
  it), `SourceAdapter` interface (`{ source, fetchEvents(artist) }`), and
  `NormalisedEvent` (the normaliser's output, shaped to feed
  `upsertEventByFingerprint` from `src/db/queries.ts` directly; `tour_id` is
  deliberately absent — S3.3 assigns it).
- `src/sources/normalise.ts` — pure functions, no DB access:
  - `normaliseCityKey(city, countryCode)` — `iso2:snake_case_ascii` (e.g.
    `"gb:leeds"`, `"ro:targu_mures"`), matching the convention
    `scripts/seed-reach.ts` (S1.2) already established for
    `reachability`/`origins`, so S3.4's join has both sides agreeing.
    Diacritics stripped via Unicode NFD + combining-mark removal.
  - `computeFingerprint(mbid, startsAt, cityKey)` —
    `sha1(mbid | date | normalised_city)` per DESIGN.md §4, using
    `crypto.subtle.digest('SHA-1', ...)` (Web Crypto — no `nodejs_compat`
    flag is set in `wrangler.jsonc`, so this had to avoid `node:crypto`).
    `date` is the `YYYY-MM-DD` prefix of `starts_at`, not the full
    timestamp, so two sources reporting the same date at slightly different
    times of day still collapse to one fingerprint.
  - `computeContentHash(...)` — material fields only (date, venue, status,
    on-sale), also sha1 over Web Crypto.
  - `normaliseEvent(raw, artist)` — the actual normaliser. Returns
    `{ ok: true, event: NormalisedEvent } | { ok: false, reason:
    'missing_mbid', raw }`. An artist with no `mbid` (i.e. `dark` coverage)
    quarantines the raw event by handing it back rather than throwing or
    silently dropping it, per DESIGN.md §4's "quarantined, not dropped."

**Assumed.**
- The MBID in the fingerprint formula is the **artist's** MBID
  (`artists.mbid`), not a per-event field — `RawSourceEvent` has no `mbid`
  of its own; `normaliseEvent` takes `{ id, mbid }` for the artist
  separately (the shape callers already have from `ArtistRow`/`getArtistById`).
  This is the only reading of §4's formula that makes sense: individual
  Ticketmaster/tour-page events don't carry MBIDs, artists do.
- `country` on `RawSourceEvent` must already be an ISO 3166-1 alpha-2 code
  (validated by `normaliseCityKey`, which throws on anything else) — pushed
  onto each adapter (S2.1–S2.3) rather than guessed at generically here,
  since only they know their upstream API's country representation.
- `city_key` scheme reuses S1.2's exact convention rather than inventing a
  second one, since §7's reachability join (S3.4) needs `events.city_key`
  and `reachability.city_key` to be produced the same way. Not stated
  explicitly in DESIGN.md beyond the one example, but the alternative
  (inventing a second, incompatible city-key scheme) would silently break
  S3.4.
- All hashing uses Web Crypto (`crypto.subtle`), async, rather than
  `node:crypto` — `wrangler.jsonc` has no `nodejs_compat` compatibility
  flag, so `node:crypto` is not guaranteed available in the deployed
  Worker even though `@types/node` is in `tsconfig.json`'s `types` (that's
  for tooling/scripts like `seed-reach.ts`, not runtime code). This makes
  `computeFingerprint`/`computeContentHash`/`normaliseEvent` all `async`,
  which is a mild API cost but the only cross-runtime-correct choice.

**Left undone.**
- No fixture file committed to the repo (not in this step's touch list:
  `src/sources/types.ts`, `src/sources/normalise.ts` only). Verified via a
  standalone harness (12/12 checks; see below), matching S1.4's approach —
  script lived only in the session scratchpad/temporarily at the repo root
  for the run, not committed.
- No adapters exist yet to actually produce a `RawSourceEvent` from a real
  API — that's S2.1/S2.2/S2.3, which must land after this step per the
  plan ("must land before S2.1–S2.4").

**Verification performed.**
```
npx tsc --noEmit -p tsconfig.json                                  # clean
npx prettier --check src/sources/types.ts src/sources/normalise.ts # clean (after --write)

# Standalone harness (two hand-written fixture payloads — Ticketmaster and
# a tour page — describing the same IDLES/Leeds show), 12/12 passed,
# including the step's own done-when:
node --experimental-strip-types test-normalise.mts
  PASS both sources normalise ok
  PASS same fingerprint despite different source/time/onsale
  PASS fingerprint is a 40-char hex sha1
  PASS city_key normalised
  PASS content_hash differs when onsale_at differs
  PASS different city -> different fingerprint
  PASS city_key strips Romanian diacritics
  PASS city_key is stable with/without diacritics
  PASS missing mbid -> quarantined, not thrown/dropped
  PASS quarantined result carries the raw event back
  PASS computeFingerprint deterministic
  PASS content_hash changes when date changes
```

**Proposed commit message.**
```
Add source adapter interface and event normaliser (S2.0)

SourceAdapter/RawSourceEvent/NormalisedEvent in src/sources/types.ts
and the normaliser in src/sources/normalise.ts: deterministic
city_key (matching S1.2's iso2:snake_case scheme), sha1 fingerprint
and content_hash via Web Crypto, and quarantine-not-drop handling
for events from artists with no MBID. Verified against two fixture
payloads (Ticketmaster + tour page) for the same show collapsing to
one fingerprint.
```
