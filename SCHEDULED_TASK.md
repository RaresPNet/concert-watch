# SCHEDULED_TASK.md

How to set up the daily scheduled task that runs concert-watch's digest
routine. Read once when creating it; you shouldn't need it again unless
something breaks.

## What the task does

The Worker's own cron runs at 05:00 UTC (08:00 EET). It polls every watched
artist, groups new dates into tours, decides who should hear about what, and
tags each date with how reachable it is. Then it stops, leaving a payload
waiting for anyone with news.

Nothing has been emailed at that point. This task is what turns a waiting
payload into a sent email — and it runs on app quota rather than the API key,
which is the whole reason it's a scheduled task rather than something the
Worker does itself.

It also does the work that needs judgment rather than parsing: searching for
tour dates for bands that no API covers, reading tour pages that couldn't be
parsed mechanically, and once a quarter refreshing the flight-route data.

## Creating it

**Instructions field:**

```
/concert-watch
```

That's it. The `concert-watch` skill holds the entire routine, and invoking it
by name means there's exactly one copy of the prompt — the skill — with nothing
to drift out of sync.

If the skill doesn't trigger reliably from a scheduled run, fall back to
pasting the skill's body (everything below its frontmatter) into the
instructions instead, and add one line at the top:

> You are running automatically, once a day, shortly after concert-watch's
> daily poll finishes. No recipient was given — run for everyone with
> something pending.

Only do that if the one-liner genuinely doesn't work. A pasted copy is a second
source of truth, and the moment the skill changes the two disagree with no
warning.

**Schedule:** daily, shortly after 05:00 UTC. Fifteen minutes is plenty — the
Worker's cron finishes in seconds.

**Connector:** the task needs concert-watch's MCP connector enabled, using the
**admin** token. That's the one that can act for any subscriber and reach the
sweep, digest and route tools. A subscriber token won't work here; it only sees
one person's watchlist.

The connector URL is `https://<worker-host>/mcp/<token>`, where the token is
the `MCP_AUTH_TOKEN` Wrangler secret. Secrets are write-only — if it's lost,
mint a new one with `openssl rand -hex 16`, set it with
`wrangler secret put MCP_AUTH_TOKEN`, redeploy, and update the connector URL.

## Checking it worked

Run `/concert-watch` by hand first, before trusting the schedule. It's the same
routine, so a successful manual run means the automatic one will work too.

With nothing pending, a correct run does almost nothing and sends no email —
that's the normal outcome most days, not a failure. To see it actually produce
something, wait until there's real news rather than forcing it.

`/concert-watch recipient="Name"` runs the digest for one person only, which is
the quickest way to test without emailing everyone.

## If it stops running

Quota exhausted, task deleted, a bad day at Anthropic — whatever the cause, the
Worker notices. Anything still unsent after 36 hours gets a plain, model-free
digest built straight from the database and sent without any of this. Same
information, no prose.

So a silent failure here costs you a well-written email, not the news itself.
Worth fixing, not worth panicking about.

There's also a 30-day heartbeat: if nothing at all has been sent in a month,
the Worker sends a short note saying it's still alive, with what it's watching
and what it has spent. If that arrives and you weren't expecting it, the
scheduled task is probably dead.

## Changing the routine

Edit the `concert-watch` skill. Don't edit the task's instructions in the app —
with the one-line setup there's nothing there to edit anyway, which is the
point.