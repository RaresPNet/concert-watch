# ADMIN.md

Ad-hoc admin operations against the live Worker -- things done rarely, by
hand, outside the daily digest/reply flows. Currently just one.

## Resetting a subscriber's onboarding

`GET /admin/reset-onboarding?token=<ADMIN_OPS_TOKEN>&subscriber_id=<id>`
(or `&email=<address>` instead of `subscriber_id`)

Wipes that subscriber back to a pre-onboarding state -- every watchlist
entry, every inbox row, every sent reply, and any standing `preferences`
text -- then resends the welcome invite. The subscriber row itself
(id, email, `verified_at`, display name) is untouched, and neither is shared
reference data (`artists`/`tours`/`events`).

Returns JSON: what got deleted, and whether the invite send succeeded.

```
curl "https://concert-watch.raresp98.workers.dev/admin/reset-onboarding?token=$ADMIN_OPS_TOKEN&subscriber_id=1"
```

**Auth:** `ADMIN_OPS_TOKEN`, a Wrangler secret distinct from `MCP_AUTH_TOKEN`
(SCHEDULED_TASK.md) on purpose -- rotating this one never disturbs the
scheduled task's MCP connector. Secrets are write-only; if it's lost, mint a
new one and redeploy:

```
openssl rand -hex 20 | wrangler secret put ADMIN_OPS_TOKEN
wrangler deploy
```

**Why this route stays wired permanently** (unlike `sendWelcomeInvite`'s
original design note, since superseded): the alternative -- hand-adding an
HTTP route gated by a freshly-minted secret, deploying, curling it once, then
tearing both back out and redeploying again -- is pure overhead repeated on
every use, for a capability worth having on tap. This route is scoped
narrowly (one action, one token check, no free-form SQL or code execution)
so the permanence trade-off is worth it.
