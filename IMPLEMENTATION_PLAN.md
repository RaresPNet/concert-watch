# IMPLEMENTATION_PLAN.md — Concert Alerts

Companion to `DESIGN.md`, which is the contract. Where this plan and the design
disagree, the design wins; raise the conflict in `PROGRESS.md` rather than
resolving it silently.

## How to use this

Each step is written to be handed to a **fresh agentic instance with no memory
of the others**. Every step therefore states its own inputs, outputs, and
done-when, and names what it must not touch.

Rules for every step:

1. Read `DESIGN.md` first. Read `PROGRESS.md` to see what already exists.
2. Stay inside the files listed under **Touches**. If the work seems to require
   editing something outside that list, stop and write the reason in
   `PROGRESS.md` instead of expanding scope.
3. Append to `PROGRESS.md` when done: what was built, what was assumed, what
   was left undone, and a proposed commit message. Append only — never rewrite
   another step's entry.
4. Do not write tests beyond what the step asks for. Test budget is
   deliberately small.

**Legend** — `[R]` Rareș does this by hand · `[A]` agentic step ·
`∥` marks steps that can run in parallel with each other.

---

## Phase 0 — Platform setup `[R]`

Nothing can start until these exist. All manual.

### S0.1 `[R]` Repo and Worker skeleton

- Git repo with `DESIGN.md`, `IMPLEMENTATION_PLAN.md`, empty `PROGRESS.md`.
- `wrangler` project, TypeScript, deploys a hello-world Worker.
- Bindings declared: D1 (`DB`), R2 (`IMAGES`), Email Service, cron trigger at
  `0 5 * * *` UTC (08:00 EET).

### S0.2 `[R]` Domain and mail

- Domain on Cloudflare, Email Routing enabled.
- Catch-all or specific address routed to the Worker.
- Cloudflare Email Service enabled; DNS/DKIM records in place.
- **Verify both personal addresses as Email Routing destinations.** Each owner
  clicks a confirmation link. Sending is free on the Workers Free plan only to
  verified destinations (§3) — without this step nothing sends.
- Verify a hello-world send lands in a real inbox and isn't marked spam.
- Confirm the account stays on the Workers Free plan. Do not upgrade
  preemptively; §3.1 names the one symptom that would justify it.

### S0.3 `[R]` Credentials

- Ticketmaster Discovery API key (free, self-serve).
- Send the Bandsintown access request to `biz@bandsintown.com`. Do not block
  on it; the adapter ships disabled (§6.2).
- Apply for a Songkick API key. Same — don't block on it.
- Anthropic API key, with a **billing alert and a hard spend cap set in the
  console**. Belt and braces alongside the in-app ceiling of §12.4.
- Secrets stored via `wrangler secret`, never committed.

**Done when:** a deployed Worker can be pinged, can query D1, can send one
email, and receives mail sent to the address.

---

## Phase 1 — Foundations

All four are `∥` parallel with each other once Phase 0 is done. They share no
files.

### S1.1 `[A]` `∥` D1 schema and migrations

**Goal.** Every table in `DESIGN.md` §4, as numbered migration files, plus a
tiny typed query layer.

**Touches.** `migrations/`, `src/db/schema.ts`, `src/db/queries.ts`

**Notes.**
- Add the `preferences` free-text column and `verified_at` on `subscribers`
  (§3, §11.3), and the `message_id` / `in_reply_to` / `references` /
  `thread_id` columns on `inbox` (§11.2) — all in the design but easy to miss
  from §4 alone.
- Add a `source_health` table: `source`, `consecutive_failures`,
  `last_ok_at`, `last_error` (§6.2).
- Add a `usage` table: `day`, `path`, `model`, `input_tokens`,
  `output_tokens`, `est_cost` (§12.4), and `inbox.attempts` (§12.3).
- Add a `rate_limit` table or KV equivalent keyed on sender + hour (§12.3).
- Index `events.fingerprint`, `events.tour_id`, `watchlist.artist_id`,
  `inbox.status`, `inbox.thread_id`.

**Done when.** Migrations apply cleanly to a local D1 and to remote; a seed
script inserts one subscriber and one artist and reads them back.

**Do not.** Write any business logic. This step is schema only.

### S1.2 `[A]` `∥` Reachability seed data

**Goal.** Populate `origins` and `reachability` per `DESIGN.md` §7.

**Touches.** `data/origins.json`, `data/routes.json`, `scripts/seed-reach.ts`

**Notes.**
- Research the current direct-route list for CLJ, BUD, OMR, SBZ, OTP, IAS —
  destination city, airport, airline, rough weekly frequency and operating
  days where available.
- CLJ alone is roughly 56 non-stop destinations across 24 countries; BUD is
  substantially larger. Expect this file to be big, and generate it, don't type
  it.
- Derive tier per `(city_key, origin_iata)` using the A/B/C/D rules in §7.2,
  including the ≤3 h ground rule for tier B. Ground legs need a rough
  rail-time source; approximate is fine and should be marked approximate.
- `route_note` is user-facing prose: *"direct CLJ→LBA, Wizz, Tue/Sat"*.
- Write the script so a monthly re-run refreshes the tables idempotently.

**Done when.** `reachability` is populated; spot-checks return tier A for
Leeds, London, Milan, Barcelona from CLJ, and tier C for Budapest and Vienna.

**Do not.** Call any flight-pricing API. This is route topology, not fares.

### S1.3 `[A]` `∥` Mailer

**Goal.** A `mailer` interface with a Cloudflare Email Service implementation.

**Touches.** `src/mail/mailer.ts`, `src/mail/cloudflare.ts`

**Notes.**
- Interface takes `{ to, subject, html, text, headers }` and returns a result
  including the sent `Message-ID`, which callers persist for threading.
- Keep the interface narrow enough that a Resend implementation is a new file,
  not a refactor (§3).
- Always send a plain-text alternative.
- **Refuse to send to any address without `subscribers.verified_at`.** On the
  free plan an unverified recipient fails, so this is a guard, not politeness.
- **Confirm delivery from the email sending metrics/logs, not the Email
  Routing summary**, which reports Worker-sent mail as dropped even on success
  (§3.1). `sent_at` depends on getting this right (§9.3).
- Set `Auto-Submitted: auto-replied` and `Precedence: bulk` on every outbound
  message (§12.4).

**Done when.** A test send produces a message in a real inbox with correct
`Message-ID` returned, and a send to an unverified address is refused locally
rather than failing upstream.

### S1.4 `[A]` `∥` Inbound mail capture

**Goal.** Email Worker handler that writes raw messages into `inbox`.

**Touches.** `src/mail/inbound.ts`

**Notes.**
- Parse DKIM/SPF results and store them. Do not interpret the body (§11.1).
- Extract and store `Message-ID`, `In-Reply-To`, `References`; derive
  `thread_id` from the root of the references chain.
- Unknown sender → drop silently, status `ignored`.
- **Loop guards (§12.3).** Drop mail carrying `Auto-Submitted`,
  `Precedence: bulk` or `Precedence: list`, or any `List-*` header. Enforce
  the per-sender hourly cap here, before anything downstream can spend money.
  This is the single most likely source of a surprise bill; treat it as a
  correctness requirement, not a nicety.

**Done when.** Mail sent to the address appears as a `pending` inbox row with
auth flags and threading headers populated; a message with
`Auto-Submitted: auto-replied` is dropped; the seventh message from one sender
in an hour is deferred rather than handled.

**Do not.** Call any model. This step never interprets anything.

---

## Phase 2 — Source adapters

`∥` parallel with each other. Depends on S1.1 only.

### S2.0 `[A]` Adapter interface and normaliser

**Must land before S2.1–S2.4.** Small step, do it first.

**Goal.** A `SourceAdapter` interface plus the normaliser that turns any
source's response into `events` rows, including fingerprint computation.

**Touches.** `src/sources/types.ts`, `src/sources/normalise.ts`

**Notes.**
- Fingerprint is `sha1(mbid | date | normalised_city)` (§4). City
  normalisation needs to be shared and deterministic — this is the single
  most important function in the codebase, because everything downstream
  depends on the same show from three sources collapsing to one row.
- `content_hash` covers material fields only: date, venue, status, on-sale.
- Events without an MBID are quarantined, not dropped.

**Done when.** Given hand-written fixture payloads from two different sources
describing the same show, the normaliser produces one fingerprint.

### S2.1 `[A]` `∥` Ticketmaster adapter

**Touches.** `src/sources/ticketmaster.ts`

Attraction-ID lookup, event fetch, pagination, on-sale and presale dates,
attraction images. Respect 5 req/s. Record failures to `source_health`.

### S2.2 `[A]` `∥` Bandsintown adapter — disabled

**Touches.** `src/sources/bandsintown.ts`

Write the adapter against the documented endpoint shape, but ship it **behind
a config flag, defaulting off** (§6.2). It has no key and must not run.

**Do not** use an arbitrary `app_id` to make it work. Their terms restrict the
API to artists and their representatives; an access request is pending. If the
flag is off, the adapter returns empty and logs nothing.

### S2.3 `[A]` `∥` Tour-page adapter — primary source

**Touches.** `src/sources/tourpage.ts`

Promoted from a supplementary check to one of the two sources the system
actually relies on (§6.2). Give it proportionate care.

Fetch the artist's tour page, hash the content, compare against
`artists.tour_page_hash`. On change, extract JSON-LD `MusicEvent` blocks. If
JSON-LD exists, emit events with no model call at all. If not, mark the artist
as needing a model parse and stop — do not call a model from this file.

Handle the common shapes: a bare `MusicEvent`, an array of them, a `@graph`
wrapper, and `EventSeries`. Test against three real band sites rather than a
synthetic fixture, since real-world JSON-LD is messier than the spec.

### S2.4 `[A]` `∥` MusicBrainz lookup

**Touches.** `src/sources/musicbrainz.ts`

Name → candidate MBIDs with disambiguation strings, for use by the resolution
pass. Respect the 1 req/s rate limit and set a proper User-Agent.

---

## Phase 3 — Core logic

Sequential. Each depends on the one before.

### S3.1 `[A]` Artist resolution pass

**Depends on.** S2.0–S2.4

**Goal.** Given a band name, produce a populated `artists` row (§5).

**Touches.** `src/core/resolve.ts`

**Notes.**
- Model-assisted: gather candidates from MusicBrainz, Ticketmaster and
  Bandsintown, then have the model pick and explain.
- Ambiguity is returned to the caller as a question, never guessed. The
  contract is `{ resolved } | { ambiguous, candidates, question }`.
- Sets `coverage` to `api` or `dark`.

**Done when.** "IDLES", "Low", and a deliberately obscure Romanian band each
produce the right outcome — two resolved, one flagged dark or ambiguous.

### S3.2 `[A]` Poll orchestrator

**Depends on.** S3.1

**Goal.** The daily deterministic pass. No model calls anywhere in this file.

**Touches.** `src/core/poll.ts`

**Notes.**
- Poll set is `SELECT DISTINCT artist_id FROM watchlist` — the deduplication
  requirement (§4). Two subscribers watching one band must produce one fetch.
- Upsert events by fingerprint; detect material change via `content_hash`.
- Update `last_polled_at`, `last_activity_at`, `source_health`.
- All 25 artists every day; no rotation (§6.3).

**Done when.** A run against fixtures inserts new events, updates changed ones,
and leaves unchanged ones untouched — verified by row-level assertions.

### S3.3 `[A]` Tour clustering and notification state machine

**Depends on.** S3.2

**Goal.** Group events into tours and decide what deserves a notification.

**Touches.** `src/core/tours.ts`, `src/core/notify.ts`

**Notes.**
- Clustering per §9.1: **no window**. A tour is all currently-known unnotified
  future dates for an artist at first sighting. Later dates attach to the
  existing tour and fire `new_dates`.
- Four triggers per §9.2. Apply the priority→tier filter from §8 *before*
  writing a notification row, per subscriber.
- `sent_at` stays NULL until delivery confirms (§9.3). This is the single
  most important ordering constraint in the system.

**Done when.** A fixture sequence — tour announced, extra dates added a week
later, one date moved, one on-sale window approaching — produces exactly four
notification rows for a P1 subscriber and fewer for a P4 one.

### S3.4 `[A]` Reachability join

**Depends on.** S1.2, S3.3

**Goal.** Attach tier and route note to each event, pick the top three per
tour.

**Touches.** `src/core/reach.ts`

Ranking: direct from CLJ beats direct from BUD beats one-stop from CLJ; apply
`penalty_minutes` for otherwise-equal options (§7.1).

---

## Phase 4 — Output

### S4.1 `[A]` Digest payload builder

**Depends on.** S3.4

**Goal.** Assemble the structured payload the email is rendered from — per
subscriber, pending notifications, tours, top three dates, tiers, route notes,
handles, and which contextual affordance applies to each block (§10.2).

**Touches.** `src/digest/payload.ts`, `src/digest/payload.types.ts`

**Done when.** Payload for a fixture DB matches a committed snapshot. Empty
payload → explicit "no send" result.

### S4.2 `[A]` `∥` HTML email template

**Depends on.** `payload.types.ts` from S4.1 only — write that type first, then
S4.1 and S4.2 run in parallel.

**Touches.** `src/digest/render.ts`, `src/digest/template.html`

**Notes.**
- Tables and inline CSS only; no flexbox or grid (§10.4).
- **Stay inside the 10 ms CPU budget of the Workers Free plan (§3.1).** String
  templating, no rendering framework, no image processing in the request path.
  This is the most likely place to trip `EXCEEDED_CPU`.
- Dark-mode handling explicit.
- Under ~102 KB total or Gmail clips it.
- Images from R2, resized. Plain-text alternative required.
- Contextual affordances and the standing footer per §10.2, with rotating
  phrasings.
- Aim for competent and clean. Serious visual design is deferred; do not
  invent a brand.

**Done when.** Rendered output of the snapshot payload survives Gmail, Apple
Mail and Outlook web in light and dark mode.

### S4.3 `[A]` Image pipeline

**Depends on.** S2.1, S2.2

**Touches.** `src/images/fetch.ts`

Pull artist images from whichever source supplied the event; Wikimedia Commons
fallback for `dark` artists. Resize, store in R2, record the key. Logos are
in scope but optional — skip rather than ship a broken layout.

### S4.4 `[A]` Model client and budget guards

**Depends on.** S1.1

**Goal.** One place where every *billed* model call goes through, with metering
and degradation built in. Nothing else in the codebase calls the API directly.

Scope note: this covers the **reply path only** (§3). Digest, sweep and
resolution run on app quota through MCP and never touch this client.

**Touches.** `src/model/client.ts`, `src/model/budget.ts`

**Notes.**
- Routing per §11.5: Haiku 4.5 by default, Sonnet 5 on escalation.
- Every call writes to `usage` — tokens in, tokens out, estimated cost.
- Enforce the monthly ceiling (§12.5): over budget, live replies degrade to
  being handled by the next scheduled run, and a notice line is queued.
- Prompt caching enabled on the thread path only.
- Hard caps enforced here, not in callers: 8 tool calls, 40k input tokens.

**Done when.** A forced over-budget state degrades correctly instead of
throwing, and `usage` reconciles against a hand-computed figure for a fixture
run.

**Do not.** Optimise token counts. §12.2 explains why that's not where the
money is.

### S4.5 `[A]` Agent tools

**Depends on.** S3.1, S3.4, S4.4

**Goal.** The tool catalogue from §11.5, each one returning a decision rather
than a blob.

**Touches.** `src/agent/tools.ts`

**Notes.**
- `get_reachability` returns one line from the precomputed table. The model
  must never work routes out from first principles — this is the main reason
  trip planning is cheap.
- `get_tour` returns a compact summary, never 25 raw event rows.
- `web_search` capped at 3 calls per email, enforced in the tool, not the
  prompt.
- Every tool validates that the acting subscriber owns the row it touches.

**Done when.** Each tool has a fixture test asserting its *output size* as
well as its correctness. A tool that returns too much is a bug.

### S4.6 `[A]` Inbound command handler

**Depends on.** S1.4, S4.5

**Goal.** Interpret pending inbox rows and act (§11.6).

**Touches.** `src/mail/handle.ts`, `src/mail/conversation.ts`

**Notes.**
- Load the full thread plus the relevant tour rows before invoking the model
  (§11.2). Stateful from the first commit.
- Standing preferences append to `subscribers.preferences` (§11.3).
- Written once, called from two places: the Email Worker on arrival (live) and
  the daily cron (sweeping deferred or failed rows). Same code path.
- On cap breach, reply honestly and ask the sender to narrow it down. Never
  loop, never silently drop.

**Done when.** A reply thread — "add Fontaines D.C." → confirmation → "actually
make that P1" → confirmation → "how would I get to the Prague date" → trip
options — works end to end, live, in under a minute, and the `usage` row for
it is under a cent.

---

### S4.7 `[A]` MCP endpoint

**Depends on.** S4.1, S3.1

**Goal.** The surface the Claude scheduled task uses to do the app-quota work
(§3). Same pattern as kindle-digest.

**Touches.** `src/mcp/server.ts`

**Tools exposed:**

| Tool | Purpose |
|---|---|
| `get_pending_digest(subscriber)` | the structured payload from S4.1 |
| `submit_digest(subscriber, html, text)` | hand back rendered output; Worker sends it |
| `get_sweep_targets()` | `dark` artists due a search |
| `submit_sweep_results(artist_id, events)` | normalised events found by search |
| `get_unparsed_pages()` | changed tour pages with no JSON-LD |
| `submit_parsed_events(artist_id, events)` | results of a page parse |
| `refresh_reachability(rows)` | monthly route table update |
| `status()` | source health, spend to date, pending counts |

**Notes.**
- Authenticate with a bearer token in the URL path, as kindle-digest does.
- Submitted events go through the **same normaliser** as S2.0. The model never
  writes directly to `events`.
- Every submission is idempotent — a repeated call must not double-send a
  digest or duplicate events.

**Done when.** A manual MCP session can fetch a pending payload, submit
rendered HTML, and see the email arrive.

### S4.8 `[A]` Fallback digest and heartbeat

**Depends on.** S4.1, S1.3

**Goal.** Guarantee delivery independent of the scheduled task (§10.3).

**Touches.** `src/digest/fallback.ts`

**Notes.**
- If any notification has been pending >36 h with no successful send, render a
  plain templated digest straight from D1 — **no model call anywhere in this
  file** — and send it, with a one-line note that it's the plain version.
- 30-day heartbeat: nothing sent in a month → short still-alive note with
  bands watched, source health, and spend to date.
- This is the step that makes the app-quota decision safe. Treat it as
  load-bearing, not as a nicety.

**Done when.** With the MCP path disabled entirely, a pending notification
still results in a readable email within 36 h.

### S4.9 `[R]` Claude scheduled task

Manual. Create a scheduled task in the Claude app pointed at the MCP endpoint,
running shortly after the Worker cron. Its instructions: fetch sweep targets
and unparsed pages, do the research, submit results, fetch the pending digest
payload, write the digest, submit it.

Keep the task's prompt in the repo as `SCHEDULED_TASK.md` so it's versioned
rather than living only in the app.

---

## Phase 5 — Assembly

### S5.1 `[A]` Cron wiring

**Depends on.** S4.1–S4.8

Single scheduled entry point: poll → cluster → notify → reach → build payload,
then stop. The Worker does **not** compose the digest — it leaves the payload
pending for the scheduled task (S4.9) to collect. It does check whether
anything has gone unsent past the 36 h threshold and fires the fallback if so.
Cap work per run and defer overflow to tomorrow (§12).

### S5.2 `[A]` Paula's invite flow

**Depends on.** S5.1

Manually triggered invite (§2). Introduction email, free-text reply parsed
into resolved artists, confirmation email with did-you-means. Must survive a
messy reply — partial names, a band that doesn't exist, three bands on one
line.

### S5.3 `[A]` Source health reporting

**Depends on.** S5.1

Warning line in the digest after three consecutive failures for any source
(§6.2). A separate alert to Rareș only if every source for a given artist has
been failing for a week.

---

## Dependency summary

```
S0.1 ─┬─ S0.2 ─┬─▶ S1.1 ─┬──────────────────────▶ S2.0 ─┬─ S2.1 ─┐
      └─ S0.3 ─┘         ├─ S1.2 ──────────────────┐    ├─ S2.2 ─┤
                         ├─ S1.3 ────────────────┐ │    ├─ S2.3 ─┤
                         └─ S1.4 ──────────────┐ │ │    └─ S2.4 ─┤
                                               │ │ │             │
                                               │ │ └─────────────┴─▶ S3.1
                                               │ │                    │
                                               │ │              S3.2 ─┘
                                               │ │                │
                                               │ └───── S3.4 ◀─ S3.3
                                               │          │
                                               │        S4.1 ─┬─ S4.2 ∥
                                               │        S4.3 ─┤
                                               └─────── S4.4 ─┤
                                                              │
                                                    S5.1 ─┬─ S5.2
                                                          └─ S5.3
```

Parallel batches: **{S1.1, S1.2, S1.3, S1.4}**, then **{S2.1, S2.2, S2.3,
S2.4}**, then **{S4.1, S4.3, S4.4, S4.8}** with **S4.2** alongside S4.1 once
the payload type is fixed. S4.5 needs S4.4; S4.6 needs S4.5; S4.7 needs S4.1.

Critical-path note: S4.4 gates every billed model call, and S4.8 is what makes
the app-quota split safe. Neither is optional and both only need early
dependencies — start them sooner than their position in the list suggests.

---

## Deliberately out of scope

Everything in `DESIGN.md` §13. In particular: no web UI, no Google Calendar, no
shared digest, no rotation queue, and no serious visual design pass. If a step
seems to need one of these, it doesn't — write the reason in `PROGRESS.md` and
move on.