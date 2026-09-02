-- Migration number: 0006 	 2026-09-02T00:00:03.000Z
-- S5.3: per-subscriber MCP identity. Up to now the only credential the MCP
-- endpoint (S4.7) recognised was the single shared MCP_AUTH_TOKEN secret,
-- which acts for the scheduled task and (by construction) for any
-- subscriber at once -- there was no way to hand one specific person a URL
-- that only ever acts as them.
--
-- `mcp_token` is that per-person credential: a CSPRNG-generated bearer token
-- (minted via the new `mint_subscriber_token` admin tool in src/mcp/server.ts,
-- which uses Web Crypto's `crypto.getRandomValues` -- this runs in a
-- Cloudflare Worker, not Node, so `node:crypto` is not an option here)
-- stored once per subscriber and never derived from anything guessable
-- (email, id). A request bearing it resolves straight to that subscriber
-- and is handed the agent tool catalogue (src/agent/tools.ts, S4.5) scoped
-- to that identity alone -- see server.ts's `buildSubscriberMcpServer` for
-- how identity replaces every `subscriber_id` argument those tools would
-- otherwise need.
--
-- NULL by default (existing subscribers have no MCP access until a token is
-- minted for them). The uniqueness constraint is a separate index rather
-- than an inline `UNIQUE` on the column, because SQLite's `ALTER TABLE ...
-- ADD COLUMN` rejects `UNIQUE` outright ("Cannot add a UNIQUE column") --
-- confirmed against a real SQLite engine while building this migration, not
-- assumed. A plain (non-partial) unique index still allows any number of
-- NULLs in SQLite, so subscribers without a minted token don't collide with
-- each other.
ALTER TABLE subscribers ADD COLUMN mcp_token TEXT;

CREATE UNIQUE INDEX idx_subscribers_mcp_token ON subscribers(mcp_token);
