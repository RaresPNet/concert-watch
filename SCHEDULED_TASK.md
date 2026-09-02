# SCHEDULED_TASK.md — wiring notes for the Claude scheduled task

Companion to `SKILL.md`. `SKILL.md` is the one versioned prompt for
concert-watch's app-quota research-and-composition routine — scheduled/
autonomous work that must never bill anyone. It is written so the exact same
text works whether it's triggered by a person typing `/concert-watch` or by
the Claude app's own scheduled-task feature running it automatically once a
day. This file is *not* a second copy of that prompt; it's the setup notes
for wiring the automatic side up, plus the small amount of framing the
automatic trigger needs that a manual invocation doesn't.

## The prompt

Use `SKILL.md`'s body verbatim — everything below its frontmatter's closing
`---`. When creating or updating the scheduled task in the Claude app, paste
that text into the task's instructions field, preceded by one line of
scheduling context so the run knows why it's happening:

> You are running automatically, once a day, shortly after concert-watch's
> own daily poll finishes. No `recipient` was given — run for everyone with
> something pending.

Do not edit the copy sitting in the app directly. If the routine needs to
change, change `SKILL.md`, then re-paste its body here into the app —
otherwise the versioned prompt and the one actually running drift apart,
which defeats the point of keeping it in the repo at all.

## Endpoint and schedule

Point the task at the deployed Worker's MCP endpoint
(`src/mcp/server.ts`): `https://<worker-host>/mcp/<MCP_AUTH_TOKEN>`. The
bearer token is `MCP_AUTH_TOKEN`, set as a Wrangler secret
(`wrangler secret put MCP_AUTH_TOKEN`) — not committed anywhere; put the same
value in the scheduled task's configured URL.

Schedule the task for shortly after the Worker's own daily cron
(`0 5 * * *` UTC, 08:00 EET). That cron does its own poll → cluster →
notify → reachability-tagging pass and leaves a payload pending for each
subscriber with something new; this task picks up from there and turns that
pending payload into an actual sent email.

## If the task doesn't fire

Quota exhausted, the task deleted, a bad day — whatever the reason, the
Worker's own 36-hour fallback sends a plain, model-free version of anything
still pending, so nothing goes silently missing. This task makes the email
good; the Worker makes sure it arrives.
