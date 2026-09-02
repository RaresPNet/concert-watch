-- Migration number: 0003 	 2026-09-02T00:00:00.000Z
-- S4.7 (MCP endpoint): durable queue for tour pages that changed but carried
-- no usable JSON-LD `MusicEvent` data.
--
-- S3.2 (src/core/poll.ts) already detects this case -- `checkTourPage`
-- (S2.3) returns `{ status: 'needs_model_parse', hash, html }` -- but its own
-- PROGRESS.md entry flags explicitly that nothing durably persists it: "no
-- schema for 'tour pages awaiting a model parse' ... adding one is a
-- migration, outside every S3.x touch list ... flagging this gap explicitly
-- for S4.7/S6.4." This is that migration.
--
-- One row per artist (PRIMARY KEY artist_id): an artist can only have one
-- tour page, so only one page can ever be "currently awaiting a parse" for
-- it. If the page changes again before the pending row is resolved, the
-- fresher html/hash simply overwrites the older one (upsert, not append) --
-- there's nothing useful about keeping a stale, already-superseded snapshot
-- around. A row is deleted once `submit_parsed_events` (S4.7) reports back
-- results for that artist, which is also what makes that tool idempotent:
-- a repeat submission after the row is gone is just a no-op deletion.
CREATE TABLE pending_page_parses (
  artist_id INTEGER PRIMARY KEY REFERENCES artists(id),
  tour_url TEXT NOT NULL,
  html TEXT NOT NULL,
  hash TEXT NOT NULL,          -- the artists.tour_page_hash value this snapshot corresponds to
  queued_at TEXT NOT NULL DEFAULT (datetime('now'))
);
