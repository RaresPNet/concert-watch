# IMPLEMENTATION_PLAN.md — concert-watch

Companion to `DESIGN.md`, which is the contract. Where this plan and the design
disagree, the design wins; raise the conflict in `PROGRESS.md` rather than
resolving it silently.

**Status: Phases 0–4 complete.** Phase 5 revises what's built; Phase 6
assembles it into a running system.

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
5. **Anything a model reads at runtime — MCP tool descriptions, agent tool
   descriptions, input schema field descriptions, system prompts, skill
   text — must make sense to a reader who has never seen this repository.** No
   step numbers, no `DESIGN.md` section references, no function names, no file
   paths. The model consuming these has none of that context and will be
   confused by it, not helped. Write what the thing does and when to use it, in
   plain language. This rule has already been violated once, and it's easy to
   violate by accident: the writing agent *has* the context and forgets the
   reader doesn't.

**Legend** — `[R]` Rareș does this by hand · `[A]` agentic step ·
`∥` marks steps that can run in parallel with each other.

---

## Phases 0–4 — complete

Summarised for orientation only. Full detail, assumptions and known gaps are in
`PROGRESS.md`; read that rather than trusting this table to be complete.

| Step | What exists |
|---|---|
| S0.1–S0.3 | Repo, Worker, D1, R2, domain, Email Routing + Sending, secrets |
| S1.1 | Schema and migrations 0001–0005, typed query layer |
| S1.2 | 477 researched routes, 6 origins, 864 reachability rows, seed script |
| S1.3 | `Mailer` interface + Cloudflare Email Service implementation |
| S1.4 | Inbound capture: auth, threading, loop guards, rate limit |
| S2.0 | Adapter interface, city-key normaliser, fingerprint, content hash |
| S2.1 | Ticketmaster Discovery adapter |
| S2.2 | **Skipped** — Bandsintown access not granted, no adapter written |
| S2.3 | Tour-page adapter: fetch, hash, JSON-LD `MusicEvent` extraction |
| S2.4 | MusicBrainz artist lookup with retry/backoff |
| S3.1 | Model-assisted artist resolution |
| S3.2 | Poll orchestrator (deterministic, no model) |
| S3.3 | Tour clustering, four notification triggers, priority filter |
| S3.4 | Reachability join, top-three ranking |
| S4.1 | Digest payload builder, handles, contextual affordances |
| S4.2 | HTML + text digest rendering |
| S4.3 | Image pipeline, Wikimedia fallback, R2 storage |
| S4.4 | Model client, usage metering, caps, monthly budget ceiling |
| S4.5 | Agent tool catalogue (nine tools) |
| S4.6 | Thread-aware conversation loop and reply sending |
| S4.7 | MCP endpoint, eight scheduled-task tools, bearer-token auth |
| S4.8 | Fallback digest (36 h) and 30-day heartbeat |

**Known gaps carried into Phase 5**, all flagged in `PROGRESS.md`:

- Nothing runs on a schedule; `scheduled()` is unwired.
- `src/index.ts`'s email handler writes to `inbox` but never calls
  `handleInboxRow`, so no inbound mail gets a reply.
- Adding a band does nothing until the next poll.
- `resolveArtist`'s own model call is not metered into `usage`.
- No MIME/quoted-printable decoding of inbound bodies.
- MCP tool descriptions reference repo internals (see rule 5).

---

## Phase 5 — Revisions

Changes to already-built code, prompted by walking the system end to end.
S5.1 and S5.2 gate onboarding in Phase 6; the rest are independent.

### S5.1 `[A]` `∥` Acquisition-time ingest

**Depends on.** Nothing new — S3.1, S3.2, S3.3 and S2.3 all exist.

**Goal.** Adding a band ingests everything about it immediately, so the
confirmation email can say what's already on and the next scheduled poll is a
genuine comparison rather than a guaranteed miss.

**Touches.** `src/core/acquire.ts` (new), `src/core/poll.ts`,
`src/agent/tools.ts`

**Notes.**

- New `acquireArtist(artistId, deps)`: fetch from every enabled source, **hash
  and parse** the tour page in the same pass, normalise, upsert, then cluster
  into tours. Reuse `persistRawEvent` and `clusterToursForArtist` rather than
  reimplementing either.
- Hashing without parsing is the trap. Store the hash and skip the parse, and
  the first scheduled poll sees "unchanged" — so the dates already on the page
  are never ingested at all. Do both.
- `add_artist` calls this after a successful resolution and returns a compact
  summary of what was found: tour count, date count, nearest reachable date.
  The reply needs that to say anything useful.
- **Do not fire `new_tour` for dates found at acquisition.** A band you just
  added announcing a tour six months ago isn't news, and surfacing 25 of those
  as announcements would make the first digest unreadable. Report them in the
  confirmation reply instead. Suppress via a flag on the clustering call or by
  marking those tours pre-notified — either is fine, but say which in
  `PROGRESS.md`.

**Done when.** Adding a band with an active announced tour populates `events`
and `tours` in the same request, produces no notification rows, and returns a
summary naming the most reachable upcoming date.

### S5.2 `[A]` Bulk add and raised caps

**Depends on.** S5.1

**Goal.** A 25-band onboarding reply must not breach the per-email tool-call
cap.

**Touches.** `src/agent/tools.ts`, `src/model/client.ts`,
`src/mail/conversation.ts`

**Notes.**

- New `add_artists(bands)` taking a list, each entry a name plus optional
  priority. Resolves each, acquires each, returns one compact result grouped
  into resolved / ambiguous-with-a-question / not-found. One tool call
  regardless of list length.
- Keep single `add_artist`. It's the right shape for "also add Boris", and the
  model shouldn't have to wrap one band in a list.
- Raise `MAX_TOOL_CALLS_PER_SESSION` from 8 to **20**. Eight was an
  anti-runaway guess, not a cost control, and a real trip-planning turn can
  spend all eight before writing a word.
- `MAX_CONVERSATION_TURNS` in `conversation.ts` is **12** and would bind before
  20 tool calls ever fire. Raise it to 25 or the new cap does nothing. This is
  the actual bug in this step.
- Leave `MAX_INPUT_TOKENS_PER_SESSION` at 40k. That's the real bound, and the
  monthly ceiling is the real cost control.
- Bulk acquisition is slow: each band hits MusicBrainz at 1 req/s plus
  Ticketmaster plus a tour page. Twenty-five could take a minute or more.
  Confirm it fits the Worker's limits and record the measured time in
  `PROGRESS.md`. If it doesn't fit, say so rather than silently truncating the
  list.

**Done when.** One email listing 25 bands with mixed priorities resolves all of
them, acquires their current tours, and produces one confirmation reply without
breaching any cap.

### S5.3 `[A]` `∥` Agent tools over MCP, per-subscriber tokens

**Depends on.** S4.5, S4.7

**Goal.** Let a person drive the system from the Claude app rather than only by
email — asking what they're watching, adding a band, checking a route — on app
quota instead of the API key.

**Touches.** `src/mcp/server.ts`, `src/db/schema.ts`, `src/db/queries.ts`,
`migrations/0006_subscriber_mcp_token.sql`

**Notes.**

- Two kinds of token, and the distinction is the point:
  - **Admin token** (`MCP_AUTH_TOKEN`, existing secret) — the scheduled task.
    Sees the scheduled-task tools and can act for any subscriber.
  - **Subscriber token** (new `subscribers.mcp_token` column) — one per
    person. Sees the agent tools only, permanently scoped to that subscriber.
    These tools take no `subscriber_id` argument at all; identity comes from
    the token. That's what makes it safe to hand someone a URL.
- Expose the agent tools through MCP, resolving the subscriber from the token
  rather than from an argument. Their ownership checks are already correct and
  tested — don't weaken or duplicate them.
- Expose `add_artists` too once S5.2 lands.
- Generate tokens with a CSPRNG. Provide a script or a documented
  `wrangler d1 execute` line for setting one, and record it in `PROGRESS.md` —
  minting a second subscriber's token shouldn't require reading the source.

**Done when.** Two different subscriber tokens each list only their own
watchlist, and a subscriber token is refused when it calls a scheduled-task
tool.

### S5.4 `[A]` Tool descriptions rewritten for their actual reader

**Depends on.** S5.3, so it covers the expanded set

**Goal.** Every description a model reads at runtime makes sense without the
repository.

**Touches.** `src/mcp/server.ts`, `src/agent/tools.ts`

**Notes.**

- Current descriptions cite design-doc sections, step numbers and internal
  function names. The model has never seen any of it. One live example
  explains that a result shape follows a numbered section of a document about
  not sending "nothing new today" mail — which tells the reader nothing and
  implies a document it cannot open.
- Each description states what the tool does, when to reach for it, and what
  comes back, **including what a normal empty result looks like**, so the
  model doesn't read emptiness as failure.
- Same treatment for every field in every input schema.
- Concretely, the digest fetch should read roughly: *"Returns the concerts
  waiting to be told to one subscriber, grouped by tour with travel options
  attached. Returns `send: false` when nothing is waiting — that's normal and
  common; most days there's nothing."*
- The bar: hand a description to someone who has never seen this project and
  ask what the tool does. If they can't say, rewrite it.
- Rule 5 applies to every future step too. This is cleanup, not permission to
  stop caring afterwards.

**Done when.** No runtime-visible string contains a section reference, step
number, file path or internal function name.

### S5.5 `[A]` `∥` Reachability refresh: read tool and quarterly cadence

**Depends on.** S4.7

**Goal.** Make the refresh a diff rather than a rebuild.

**Touches.** `src/mcp/server.ts`, `src/db/queries.ts`, `data/routes.json`

**Notes.**

- Add a read tool returning the current route set — origin, destination,
  airline, frequency — so the refreshing model can check what changed instead
  of re-researching all 477 routes from scratch every time.
- That's a lot to return at once. Support filtering by origin so the task can
  work one airport per turn.
- `refresh_reachability` should accept a partial update — changed rows only —
  rather than requiring the full set. Note in `PROGRESS.md` whether removals
  are expressible: a discontinued route needs deleting, not merely omitting.
- Cadence moves from monthly to **quarterly**. Airline networks change on the
  IATA seasonal boundaries in late March and late October, so a monthly pass
  mostly rediscovers that nothing moved.

**Done when.** The read tool returns current routes for one origin, and a
refresh submitting three changed routes updates exactly those three.

### S5.6 `[A]` The skill

**Depends on.** S5.4

**Goal.** One versioned prompt that both the scheduled task and a manual
`/concert-watch` invocation run.

**Touches.** `SKILL.md`, `SCHEDULED_TASK.md`

**Notes.**

- The routine: fetch sweep targets and unparsed pages, do the research, submit
  results, fetch each pending digest payload, write the digest, submit it.
- Accept an optional recipient argument, so `/concert-watch recipient="Paula"`
  runs it for her alone. With no argument, run for everyone with something
  pending.
- Include a quarterly branch for the reachability refresh, run only when asked
  or when a season boundary has passed.
- Write it for someone who has never read this repo — rule 5. This file *is* a
  runtime prompt.
- State plainly in the skill what the digest should read like: a festival
  lineup curator, not a status report. That instruction belongs here rather
  than in code, which is the whole reason for keeping it in the repo.

**Done when.** Running the skill by hand against a seeded pending notification
produces a sent digest, and `recipient=` scopes it to one person.

---

## Phase 6 — Assembly

### S6.1 `[A]` Live inbound handling

**Depends on.** S5.2

**Goal.** An inbound email actually gets a reply. This is the missing plumbing
flagged in `PROGRESS.md`.

**Touches.** `src/index.ts`, `src/mail/inbound.ts`

**Notes.**

- After capture writes a `pending` row, call `handleInboxRow` on it. Capture
  must complete and commit first — a model failure cannot be allowed to lose
  the message.
- Rows written as `deferred` (rate-limited, over budget, attempts exhausted)
  are not handled live; the cron sweeps them.
- Add MIME/quoted-printable decoding of `body_text`. Plain-text mail from a
  simple client works today, but an HTML-only or encoded message reaches the
  model garbled, and real clients send both. `postal-mime` is the usual choice.
  Watch the free-plan CPU budget — this is one of the two places most likely to
  trip `EXCEEDED_CPU`, so measure it and record the number.

**Done when.** A real email from a personal account gets a real reply in under
a minute, and an HTML-only email is read correctly.

### S6.2 `[A]` Cron wiring

**Depends on.** S6.1

**Goal.** The system runs on its own.

**Touches.** `src/index.ts`, `src/core/schedule.ts` (new)

**Notes.**

- Daily at 08:00 EET: poll → cluster → notify → reach → build payload, then
  stop. The Worker does not compose the digest; it leaves the payload pending
  for the scheduled task to collect.
- Same run: sweep `deferred` inbox rows, check the 36-hour fallback threshold,
  check the 30-day heartbeat.
- Cap work per run and defer overflow to tomorrow rather than letting a busy
  day snowball.
- Consider a second cron at 20:00. The poll path is deterministic and free, and
  a second run halves worst-case detection latency. Implement as a config
  toggle defaulting off, and record the reasoning.

**Done when.** A manually triggered scheduled event runs the whole chain
against real D1 without error, and a seeded 40-hour-old pending notification
triggers the fallback.

### S6.3 `[A]` Subscriber onboarding

**Depends on.** S6.2

**Goal.** Both subscribers onboard by email — not an admin flow for one person
and a hand-typed list for the other.

**Touches.** `src/mail/onboard.ts` (new), `src/agent/tools.ts`

**Notes.**

- A manually triggered invite sends the welcome mail. It must say explicitly
  that replying with their bands will get a confirmation back naming what was
  found and flagging anything uncertain. Without that promise a messy reply
  feels risky to send, and messy replies are the expected case.
- The reply routes through the normal conversation loop using `add_artists`.
- The confirmation names what resolved, asks about anything ambiguous, and
  **carries the catch-up**: what these bands already have announced and how
  reachable it is. This is the first real impression the system makes; give it
  proportionate care.
- Infer priority from natural phrasing — "my favourites are X, Y" is highest,
  "I also like Z" is lower — and state the inferred priorities in the
  confirmation so they can be corrected in a reply.
- Must survive: partial names, a band that doesn't exist, several bands on one
  line, mixed priorities in a single sentence.

**Done when.** A free-text reply listing bands at mixed priorities produces
correct watchlist rows and a confirmation naming both the resolutions and
what's already on.

### S6.4 `[A]` `∥` Source health reporting

**Depends on.** S6.2

**Touches.** `src/digest/payload.ts`, `src/digest/fallback.ts`

Warning line in the digest after three consecutive failures for any source. A
separate alert only if every source for a given artist has been failing for a
week. Ticketmaster failing silently is now the worst case, since it carries
most of the reachable shows.

---

## Dependency summary

```
Phases 0–4 (done)
   │
   ├─ S5.1 ─▶ S5.2 ──────────────┐
   │                             │
   ├─ S5.3 ─▶ S5.4 ─▶ S5.6       │
   │                             │
   └─ S5.5                       │
                                 ▼
                               S6.1 ─▶ S6.2 ─┬─ S6.3
                                             └─ S6.4
```

Parallel: **{S5.1, S5.3, S5.5}** start together. S5.2 needs S5.1; S5.4 needs
S5.3; S5.6 needs S5.4. Phase 6 is sequential except S6.3 and S6.4, which run in
parallel once S6.2 lands.

Critical path to a working system: **S5.1 → S5.2 → S6.1 → S6.2 → S6.3.**
S5.3–S5.6 improve it, but nothing depends on them to run.

---

## Manual steps for Rareș

- **Mint the MCP admin token.** `openssl rand -hex 16`, then
  `npx wrangler secret put MCP_AUTH_TOKEN`. The connector URL is then
  `https://<worker>.workers.dev/mcp/<token>`.
- **Mint subscriber tokens** after S5.3, one each.
- **Create the scheduled task** in the Claude app after S5.6, pointed at the
  MCP endpoint and running shortly after the Worker cron. Its prompt is
  `SCHEDULED_TASK.md` — paste from there rather than rewriting it in the app,
  or the versioned copy drifts from what actually runs.
- **Send the invites** after S6.3.

---

## Deliberately out of scope

Everything in `DESIGN.md` §13: no web UI, no Google Calendar, no shared digest,
no rotation queue, no serious visual design pass. Also still out: Bandsintown
(no access), Songkick (no key), flight pricing.

If a step seems to need one of these, it doesn't — write the reason in
`PROGRESS.md` and move on.