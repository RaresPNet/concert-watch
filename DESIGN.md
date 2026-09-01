# DESIGN.md — Concert Alerts

A daily watcher for a small, curated list of bands that emails a styled digest
when something happens worth knowing about, and takes instructions back by
email reply.

Status: design agreed, not yet implemented.

---

## 1. Purpose

Rareș and his girlfriend are not on social media and consistently find out
about tours after tickets have sold. This system watches their bands, detects
new tours and on-sale windows, works out how reachable each show is from
Romania, and sends one well-made email when — and only when — there is
something new.

### Non-goals

- Not a ticket purchaser. It links; it never buys.
- Not a discovery engine. It watches an explicit list; it does not recommend
  new bands.
- Not a calendar or web app. Email is the only interface in v1.
- Not multi-tenant. Two users, both in Cluj, hardcoded assumptions are fine
  where they buy simplicity — except where noted in §4.

---

## 2. Users

Two subscribers, both departing from the Cluj region.

| Field | Notes |
|---|---|
| `email` | primary key in practice |
| `display_name` | used in the digest greeting |
| `status` | `invited` / `active` / `paused` |

**Onboarding (Paula's path).** Rareș triggers a one-time invite. The system
sends an introduction — this is Rareș's concert watcher, reply with your
favourite bands and you'll get an email when they announce dates. Her reply is
free text and will be messy ("Radiohead, Coldplay, that band with the guy").
The handler resolves what it can and replies with a confirmation list, flagging
anything ambiguous with a did-you-mean. Resolution is a conversation, not a
parse.

She must be told the mail is coming; cold mail from a new domain will land in
spam.

**Separate digests.** Each subscriber gets their own email. A shared "couples"
mode is explicitly deferred.

---

## 3. Architecture

One Cloudflare Worker, as with kindle-digest.

```
                    ┌─────────────────────────────┐
   cron 08:00 EET ─▶│                             │
                    │      concert-watcher        │
   inbound mail ───▶│         (Worker)            │──▶ Resend / CF Email ──▶ 📧
   (Email Routing)  │                             │
                    └──────┬───────────┬──────────┘
                           │           │
                        D1 │           │ R2
                     (state)       (cached images)
                           │
                    ┌──────┴──────────────────────┐
                    │ Ticketmaster Discovery      │
                    │ Bandsintown                 │
                    │ band tour pages (JSON-LD)   │
                    │ Claude + web search         │
                    └─────────────────────────────┘
```

- **D1** holds all state. Schema in §4.
- **R2** caches artist images and logos, resized.
- **Cron** fires once daily at 08:00 EET. The poll path is deterministic and
  involves no model at all (§6).
- **Email in** via Cloudflare Email Routing → Email Worker. Receiving is free.
- **Email out** via **Cloudflare Email Service** (public beta since April 2026,
  native Workers binding, no API keys, no HTTP boilerplate). Chosen for the
  integration simplicity. Accepted risk: it is beta and the API may change
  before GA. Keep sending behind a thin `mailer` interface so swapping to
  Resend is a one-file change if the beta bites.
- **Claude, split by who triggers it.** This split is deliberate and is the
  core cost-safety decision of the project:
  - **Scheduled, autonomous work** — the daily digest and the `dark`-artist
    search sweep — runs on **app quota**, via a Claude scheduled task that
    talks to the Worker over **MCP** (same pattern as kindle-digest). Quota
    cannot bill anyone. Nothing that runs on a timer can spend money.
  - **Human-triggered work** — the live email reply path — runs on an **API
    key** held by the Worker (§11.4). It only fires when a person sends an
    email, so it cannot accrue cost unobserved.
  - Consequence and its mitigation: the digest now depends on a scheduled task
    firing. See §10.4, the fallback digest.

---

## 4. Data model

Artists and events are **global**, never per-subscriber. The poll set is
`SELECT DISTINCT artist_id FROM watchlist`, so two people watching the same
band cause one fetch. Fan-out happens at digest time.

```sql
subscribers (
  id, email UNIQUE, display_name,
  status,                      -- invited | active | paused
  created_at
)

artists (
  id,
  mbid UNIQUE,                 -- MusicBrainz, canonical identity
  name, sort_name,
  tm_attraction_id,            -- Ticketmaster
  bit_slug,                    -- Bandsintown
  songkick_id,
  official_url, tour_url,
  image_url, logo_url,         -- R2 keys once cached
  coverage,                    -- api | dark | unknown
  tour_page_hash,              -- content hash for cheap change detection
  last_polled_at,
  last_activity_at,            -- last time anything was announced
  resolution_notes             -- free text from the add-time pass
)

watchlist (
  subscriber_id, artist_id,
  priority,                    -- P1..P4, see §7
  added_at,
  PRIMARY KEY (subscriber_id, artist_id)
)

tours (
  id, artist_id,
  label,                       -- "European Tour 2027" or synthesised
  official_url,
  announced_on,
  date_count, first_date, last_date
)

events (
  id,
  fingerprint UNIQUE,          -- sha1(mbid | date | normalised_city)
  artist_id, tour_id,
  starts_at, timezone,
  city, country, city_key,     -- city_key e.g. "gb:leeds"
  venue_name, lat, lon,
  onsale_at, presale_at,
  ticket_url,
  status,                      -- active | cancelled | postponed
  source, source_event_id,
  content_hash,                -- material fields only
  first_seen_at, last_seen_at
)

notifications (
  id, subscriber_id, tour_id, event_id NULL,
  trigger,                     -- new_tour | new_dates | material_change | onsale_soon
  notified_hash,
  sent_at                      -- NULL until delivery confirmed
)

reachability (
  city_key, origin_iata,
  tier,                        -- A | B | C | D
  route_note,                  -- "direct CLJ→LBA, Wizz, Tue/Sat"
  computed_at,
  PRIMARY KEY (city_key, origin_iata)
)

origins (
  iata, name, drive_km, drive_minutes, penalty_minutes
)

inbox (
  id, from_addr, subscriber_id NULL,
  dkim_pass, spf_pass,
  subject, body_text, received_at,
  status,                      -- pending | handled | ignored
  handled_at, result_note
)
```

**Fingerprints.** The same show arrives from several sources with different
IDs. `sha1(mbid | date | normalised_city)` collapses them. Anything without an
MBID cannot be fingerprinted reliably and stays quarantined until resolved.

---

## 5. Adding an artist

A one-time resolution pass, run by Claude when a band is added. After this the
daily poll hits IDs, never names — daily name-matching on bands called Low,
Boris, or Girl Band produces constant false positives.

The pass stores: MBID, Ticketmaster attraction ID, Bandsintown slug, Songkick
ID if obtainable, official site, tour page URL, and an image. It sets
`coverage` to `api` if any structured source returned the artist, `dark`
otherwise.

Ambiguity is resolved by asking, not guessing. An unresolvable name is
reported back in the confirmation email rather than silently dropped.

---

## 6. Monitoring

### 6.1 What we do not use

- **Instagram / Facebook** — no usable API, scraping is a permanent fight, and
  unnecessary: Bandsintown *is* the artist announcement channel, because bands
  post there specifically to reach fans' apps.
- **Spotify "On tour"** — Songkick/Ticketmaster data underneath, not an
  independent source.
- **Bandcamp** — rarely carries dates.
- **Band mailing lists** — rejected. Cheapest possible channel, unpleasant to
  live with.

### 6.2 Sources, in cost order

1. **Ticketmaster Discovery API.** Free key, 5000 calls/day, 5 req/s. Strong
   coverage of the UK, Germany, Netherlands, Nordics, Spain, Ireland — where
   most of these shows will be. Does not operate in Romania or Hungary.
2. **Bandsintown.** Best coverage for self-reported dates anywhere. Official
   keys are artist-scoped unless Bandsintown authorises broader access through
   their partnership programme, so we use the **free legacy public `app_id`
   endpoint**. It works today; it is unofficial and can disappear without
   notice.

   Because of that, every source sits behind a common adapter interface and a
   source that starts failing **degrades rather than breaks the run**. Record
   consecutive failures per source; after three, include a one-line warning at
   the bottom of the next digest. Losing Bandsintown silently would be the
   worst possible failure mode, since it covers the bands Ticketmaster
   doesn't.
3. **Songkick.** Documented keyed API; keys have been hard to obtain for
   years. Apply, don't plan around it.
4. **Band tour pages.** Fetch, hash, compare. One HTTP request per artist per
   day. Only a *changed* hash triggers any parsing.

### 6.3 Poll cadence

25 bands is small enough that rotation and sweep budgeting are unnecessary in
v1. Every artist is polled every day.

`last_polled_at` and `last_activity_at` are still recorded so a
staleness-weighted queue can be added later without a migration if the list
grows.

### 6.4 Where the model actually runs

The daily poll path is LLM-free. Beyond it, model work splits by who pays:

**App quota, via the Claude scheduled task over MCP:**

- the daily `dark`-artist search sweep,
- parsing a changed tour page that has no JSON-LD,
- composing the digest,
- the monthly reachability refresh (§7),
- resolving a newly added artist, when added during a scheduled run.

**API key, in the Worker:**

- inbound email replies, and any artist resolution or trip research they
  trigger (§11).

**Cost lever:** never feed raw HTML to the model. Most band sites, Songkick and
Bandsintown embed JSON-LD `MusicEvent` blocks. Extract those in the Worker
first. When they are present — usually — the parse costs nothing.

---

## 7. Reachability

Both subscribers depart from Cluj, so reachability is a static lookup, not a
per-user computation. The table is precomputed for a set of origin airports and
refreshed monthly by a Claude run — never by the cron.

### 7.1 Origins

CLJ is a Wizz Air focus city with roughly 35 daily departures to 56 non-stop
destinations across 24 countries, which makes it a far better base than its
size suggests.

In precedence order:

| # | IATA | Airport | Drive from Cluj | Notes |
|---|---|---|---|---|
| 1 | CLJ | Cluj-Napoca | — | primary |
| 2 | BUD | Budapest | ~450 km, 6h | route network larger than every Romanian airport combined |
| 3 | OMR | Oradea | ~150 km, 2h30 | genuinely drivable; also on the way to BUD |
| 4 | SBZ | Sibiu | ~175 km, 2h45 | genuinely drivable |
| 5 | OTP | Bucharest Otopeni | ~450 km, 6h30 | only for routes nothing else serves |
| 6 | IAS | Iași | ~400 km, 6h | as above |

Budapest ranks second despite the drive: it is the same distance as Otopeni for
far more destinations, and driving to Budapest to fly is normal practice from
Transylvania. Note that Oradea sits roughly halfway along that drive, so a
CLJ→BUD trip passes it — worth surfacing when both offer a route.

Each origin carries a `penalty_minutes` equal to its drive time, applied when
ranking otherwise-equal options. A direct flight from CLJ always beats a direct
flight from BUD; a direct from BUD beats a one-stop from CLJ.

### 7.2 Tiers

| Tier | Meaning |
|---|---|
| **A** | Direct flight from CLJ to the event city (or ≤60 min ground from its airport) |
| **B** | Direct flight from CLJ, then ≤3 h train or ground |
| **C** | Direct from a secondary origin, or one connection, or drivable from Cluj (≤600 km) |
| **D** | Anything else |

Tier is stored per `(city_key, origin_iata)` with a human-readable
`route_note` — *"direct CLJ→LBA, Wizz, Tue/Sat"* — which is what the digest
actually prints.

### 7.3 Trip planning

Not done at digest time, and never for every date on a tour. Pricing 25 dates
each morning is a lot of calls for data that changes hourly and that isn't
needed until a show is interesting.

Instead, the digest prints tier and route note; **actual trip options are
produced on demand, by email reply.** "How would I do the Leeds one?" causes
the handler to load that tour's events from D1 and research two or three trip
shapes with rough costs and dates. The reply path is stateful by design, not
bolted on — follow-ups like *"that date doesn't work"* or *"I'd rather do
Prague than London"* must work.

---

## 8. Priorities and the notification rule

Each `(subscriber, artist)` carries a priority. Priority is the **filter on
reachability tier** — this is the whole noise-control mechanism.

| Priority | Meaning | Notifies on |
|---|---|---|
| **P1** chase | would fly anywhere in Europe | A, B, C, D |
| **P2** travel | would fly if it's easy | A, B |
| **P3** regional | drivable only | C where drivable |
| **P4** local | Cluj / Bucharest only | Romania |

Without this, 25 bands × Europe becomes unreadable within a month.

---

## 9. Tours and the notification state machine

### 9.1 The unit is the tour, not the event

A European tour announcement is 25 events at once. Notifying per event floods
the inbox and buries everything else. Notification fires per `tours` row.

**No clustering window.** Bands almost always post a whole leg at once, so
waiting to see whether more dates arrive costs latency for no benefit. The rule
is: **as soon as any qualifying dates appear, send.** A tour is created from
all currently-known unnotified future dates for that artist at first sighting.

If we have positive evidence that more dates are coming — the tour page says
"more dates to be announced", or the known dates cover an obviously partial
geography — say so in that first email. Do not speculate when we don't know.

Later dates landing on an existing tour fire `new_dates` and produce a second,
shorter email. `onsale_soon` is genuinely per-market and fires per event.

### 9.2 Triggers

| Trigger | Fires when |
|---|---|
| `new_tour` | a tour cluster is seen for the first time |
| `new_dates` | dates are added to a known tour that pass the subscriber's priority filter |
| `material_change` | date, venue, or status changes on an event already notified |
| `onsale_soon` | `onsale_at` falls within 72 h, for a qualifying event |

Everything else is silence. In particular, an unchanged tour is never
mentioned twice.

`onsale_soon` is the feature that justifies the project. What gets missed is
almost never the announcement — it's the presale window weeks later.

### 9.3 Delivery ordering

A `notifications` row is written when a trigger fires and `sent_at` is set
**only after delivery succeeds.** Marking on fetch means a failed send eats an
announcement permanently.

---

## 10. The digest

Sent at 08:00 EET, **only when there is something to say.** No "nothing new
today" mail. Realistically: three emails one week, nothing for a month.

### 10.1 Content

One block per tour, sorted by tier then date:

- Band name, artist image
- Date range and total date count
- Link to the official tour page
- The three most reachable dates, each with tier, venue, city, route note, and
  on-sale date
- A short handle (`#A3F`) for referencing it in a reply

The handle is printed small and grey. It is a convenience, not a requirement —
replies referring to "the IDLES one" must also work, and the handle only earns
its place when a band has two live tours at once.

### 10.2 Conversational affordances

The email must teach its own interface. Nobody reads documentation for their
own side project six months later, and Paula never had any.

Every email carries **one contextual invitation per tour block** and a **short
standing footer**. Contextual invitations are specific to what's on screen:

- next to a tier A/B tour → *"Reply and I'll work out how to get there."*
- next to a tour with an on-sale date → *"Want a nudge the day before tickets
  drop?"*
- next to a multi-date tour → *"Reply for the full list, or ask about a city
  that isn't here."*
- next to a tier C/D tour on a P1 band → *"This one's awkward to reach — ask me
  and I'll see what's possible."*

The footer is constant and short: reply to add or remove a band, change a
band's priority, pause the digest, or just ask a question.

Rotate the phrasings rather than printing the same sentence every time. The
goal is that both of us discover the reply channel by using it, not by
remembering it exists.

### 10.3 The fallback digest

Putting the digest on app quota buys cost safety at the price of a dependency:
if the scheduled task doesn't fire — quota exhausted, task deleted, Claude
having a bad day — notifications sit in D1 and nobody hears anything. Having
worried about invisible spending, we must not accept invisible *non-delivery*
in its place.

So the Worker owns delivery, and the model only owns polish.

**Rule.** If a notification has been pending for more than 36 hours with no
successful send, the Worker composes a **plain templated digest directly from
D1 — no model involved at all** — and sends it. Same information, no prose, no
contextual invitations, a single line at the top saying it's the plain version.

This is not a degraded edge case to be tolerated; it is the guarantee that the
system works. The scheduled task makes the email good. The Worker makes sure
the email arrives.

**Heartbeat.** If nothing at all has been sent for 30 days, send a short
still-alive note: bands watched, sources healthy or not, API spend so far.
That covers the opposite failure — the system quietly dying, or quietly
running, while being forgotten.

### 10.4 Styling

Target: *festival lineup curator*, not *plain old Claude*. Deferred until the
pipeline works, but the constraints are fixed now because they shape the
markup:

- Tables and inline CSS only. No flexbox, no grid — Outlook still renders with
  Word's engine.
- Dark mode inverts backgrounds unless explicitly handled.
- Gmail clips messages over ~102 KB. Cache images in R2, resized, rather than
  hotlinking CDN URLs that rot.
- Single column, one image per tour, generous whitespace.

Images come from whichever source the event came from — Ticketmaster returns
attraction images in several ratios, Bandsintown returns an artist image.
Wikimedia Commons is the fallback for API-dark artists (`find_images` from
kindle-digest already does this). Logos are fine to use; they are just
awkward to lay out, since aspect ratios vary wildly and transparent black
logos vanish in dark mode.

---

## 11. Inbound email and the conversation model

Cloudflare Email Routing → Email Worker. The Worker parses nothing; it writes
the raw message into `inbox` with status `pending`. A Claude run reads pending
rows and interprets them.

### 11.1 Auth and injection

Check DKIM/SPF pass rather than trusting the `From` header, which is trivially
spoofed. Mail from an address not in `subscribers` is dropped silently. A
secret sub-address (`concerts+7f3a91@domain`) handles the rest.

Email bodies are **data, not instructions**. A stranger who finds the address
must not be able to write text that Claude acts on. Only allow-listed,
authenticated senders can issue commands, and even their mail is treated as a
request to be interpreted rather than a script to be executed.

### 11.2 Threading

This is what makes it a conversation rather than a command line. Store
`message_id`, `in_reply_to` and `references` on every inbox row and every sent
mail, and derive a `thread_id`. A reply loads its whole thread plus the D1 rows
for whatever tour it concerns, so the model sees real context rather than
whatever the client happened to quote.

Consequence worth stating plainly: follow-ups like *"that date doesn't work"*
or *"what about Prague instead"* only work because the thread carries the tour.
Design the handler as stateful from the first commit; retrofitting threading
onto a stateless command parser means rewriting it.

### 11.3 Durable preferences

Conversations produce standing facts — *"I won't fly Ryanair"*, *"never a
Sunday night return"*, *"I'd rather do two nights than a day trip"*. Store
these as free text on the subscriber, appended when stated and fed into every
future planning reply. Without this, the same corrections get repeated forever
and the thing feels stupid.

Google Calendar availability (§13) slots naturally into the same place once
it's wired up.

### 11.4 Latency — resolved: live, on the API key

Replies are handled by the Email Worker **on arrival**, using the API key, so
they come back in seconds. Batching them to the daily run would have made
watchlist management fine and trip planning useless, which is the flow where
responsiveness actually matters.

This is the **only** path that spends money, and it is human-triggered by
construction: no email, no cost.

### 11.5 Agent runtime

The reply handler is a small tool-using loop, not a single completion.

**Model routing.**

- **Haiku 4.5** (`claude-haiku-4-5-20251001`, $1/$5 per MTok) handles the
  common case: watchlist CRUD, priority changes, confirmations, listing,
  did-you-mean resolution.
- **Sonnet 5** (`claude-sonnet-5`, $2/$10 per MTok) handles trip planning and
  anything needing web search.
- Escalation is a **tool**, not a separate classifier pass. Haiku gets
  `escalate(reason)` and the loop restarts on Sonnet with the same thread.
  Paying for a classification call on every message would cost more than the
  occasional wasted Haiku turn.

**Tool design principle: tools return decisions, not data.** The model should
never receive a blob it has to reason over when the Worker can hand it a
conclusion. Concretely:

| Tool | Returns |
|---|---|
| `list_watchlist(subscriber)` | names and priorities, nothing else |
| `add_artist(name)` | resolved artist, or candidates + a question |
| `remove_artist(id)` / `set_priority(id, p)` | confirmation |
| `get_tour(handle_or_name)` | compact tour summary, not 25 raw event rows |
| `get_reachability(city)` | one line: tier, origin, route note |
| `save_preference(text)` | ack |
| `web_search(q)` | capped at 3 calls per email |
| `escalate(reason)` | switches model |

`get_reachability` is the important one. The expensive part of trip
planning — which airport, what connection, how bad is it — is already
precomputed in D1 (§7). The model composes prose around a lookup; it never
works routes out from first principles.

**Hard caps per email:** 8 tool calls, 40k total input tokens, 2 handling
attempts. On breach, reply honestly ("this is taking longer than I expected —
can you narrow it down?") rather than looping.

**Prompt caching** on the thread path only, where several turns land within
minutes and cache hits cost 10% of base input. Isolated emails hours apart
would pay the cache write for nothing.

### 11.6 Supported intents

Interpreted, not pattern-matched:

- add / remove a band
- set or change a priority
- list the current watchlist
- pause or resume the digest
- ask for trip options on a tour, and converse about them across replies
- state a standing preference
- anything else → a polite "I didn't follow that", never a silent drop

---

## 12. Cost model

### 12.1 Infrastructure — effectively free

| Item | Daily | Quota |
|---|---|---|
| Worker invocations | ~30 | 100k/day free |
| Ticketmaster calls | ~25 | 5000/day free |
| Bandsintown calls | ~25 | — |
| Tour page fetches | ~25, hash-compared | — |
| D1 / R2 | negligible | — |

### 12.2 Model spend — only the reply path bills

Everything scheduled runs on app quota and costs nothing in money. The API key
is used solely for inbound email replies, so spend is a direct function of how
often two people write to it.

| Path | Model | Est. / month |
|---|---|---|
| Live replies (~30) | Haiku 4.5 | ~$0.60 |
| Trip planning (~10, with search) | Sonnet 5 | ~$0.70 |
| Digest, sweep, resolution, refresh | — | app quota, $0 |

**Order of a dollar or two a month, and only in months where we actually use
it.** A month where nobody emails costs nothing at all.

### 12.3 Making spend impossible to forget

The stated worry is a process running invisibly and eating money slowly. Three
mechanisms, in descending order of how much they actually guarantee:

1. **Prepaid credits, auto-recharge off.** Buy a small balance up front. This
   is the only mechanism that is a *hard* guarantee rather than a promise: the
   spend cannot exceed the balance, because there is nothing to draw on. At the
   estimate above, a $5 balance is several months.
2. **A spend line in the digest footer.** Month-to-date cost, printed in the
   thing that already arrives in the inbox. It cannot be forgotten if it's in
   every email.
3. **The 30-day heartbeat (§10.3).** If nothing has been sent for a month, the
   system says so and reports its spend. Covers the case where it's quietly
   running, or quietly dead.

### 12.4 Tail risks — this is where money would actually go

1. **Mail loops.** An out-of-office autoresponder ping-ponging with our
   replies can generate thousands of calls overnight. Since the reply path is
   the billed one, this is *the* way to get a surprise bill. Mitigations, all
   required:
   - set `Auto-Submitted: auto-replied` and `Precedence: bulk` on everything
     we send;
   - drop inbound mail carrying `Auto-Submitted`, `Precedence: bulk/list`, or
     any `List-*` header;
   - per-sender rate limit: at most 6 live-handled emails per hour.
2. **Unbounded agent loops.** Capped at 8 tool calls and 40k input tokens per
   email (§11.5).
3. **Retry storms.** `inbox.attempts`, maximum 2, then the row is marked
   `deferred` and picked up by the next scheduled run — never retried in a
   tight loop.
4. **Oversized fetches.** Truncate any fetched page to a fixed byte ceiling
   *before* it can reach a model.

Note that all four are about the reply path. Nothing on a timer can spend
money, which is the point of the split in §3.

### 12.5 Spend ceiling

A `usage` table tracks input/output tokens and estimated cost per day and per
month. Above a configurable monthly ceiling, live replies **degrade** to being
handled by the next scheduled run on app quota — slower, still working, no
longer billing. Rareș gets one notice line in the next digest.

Silently spending is worse than silently degrading.

### 12.6 Cheap by construction

The daily poll path involves no model at all (§6.4). JSON-LD extraction
removes most parse calls. Reachability is precomputed, so trip planning is
prose around a lookup. These three decisions matter more than any token
tuning.

---

## 13. Deferred

- Google Calendar availability checking. Nearly free to add later — Claude
  already has a Calendar connector — but out of v1 until the email loop works.
- A shared "couples" digest.
- Rotation / staleness-weighted sweep queue, if the list outgrows 25 bands.
- Serious visual design of the digest.
- Anything resembling a web UI.

---

## 14. Decisions taken

1. **Bandsintown** — free legacy endpoint, with per-source failure tracking and
   a warning line in the digest after three consecutive failures (§6.2).
2. **Email** — Cloudflare Email Service, behind a swappable `mailer`
   interface (§3).
3. **Budapest** — included, ranked second among origins (§7.1).
4. **Clustering** — no window. Send as soon as qualifying dates appear; flag
   "more expected" only on positive evidence; follow up when later dates land
   (§9.1).

5. **Model access — split by trigger.** Scheduled work (digest, sweep,
   resolution, refresh) runs on app quota via a Claude scheduled task over
   MCP. The API key covers only the live email reply path. Nothing that runs
   on a timer can spend money (§3, §12).
6. **Delivery guarantee.** The Worker sends a plain, model-free fallback
   digest if notifications go unsent for 36 hours, plus a 30-day heartbeat
   (§10.3).
7. **Addresses.** Both subscribers use their existing personal email
   addresses. No new mailboxes. Note the implication: personal addresses are
   more likely to carry vacation autoresponders, which makes the loop guards
   in §12.4 mandatory rather than defensive.

## 15. Still open

- The search sweep for `dark` artists is the largest recurring line item.
  Daily at 25 bands is affordable; if the list grows, move it to a rotation
  before anything else.
- Visual direction for the digest. Deferred until the pipeline works.