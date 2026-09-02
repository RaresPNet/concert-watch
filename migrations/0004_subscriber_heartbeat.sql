-- Migration number: 0004 	 2026-09-02T00:00:01.000Z
-- S4.8 (fallback digest + 30-day heartbeat): tracks the last time a
-- heartbeat was sent to a subscriber, so `runHeartbeatCheck` doesn't refire
-- every single day once the 30-day silence threshold has been crossed once.
-- Additive only -- a nullable column, no backfill needed.
--
-- Numbered 0004, not 0003: S4.7 landed a 0003_pending_page_parses.sql
-- concurrently (a genuine collision between two parallel steps, not a
-- mistake in either) -- this file was renumbered after the fact once that
-- became visible on disk.

ALTER TABLE subscribers ADD COLUMN last_heartbeat_at TEXT;
