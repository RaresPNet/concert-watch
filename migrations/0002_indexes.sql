-- Migration number: 0002 	 2026-09-01T00:00:01.000Z
-- Indexes called out explicitly in IMPLEMENTATION_PLAN.md S1.1.
-- Note: events.fingerprint is already covered by the UNIQUE constraint in
-- 0001, which creates its own implicit index; listed here anyway as an
-- explicit statement of intent since the plan calls it out by name.

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_fingerprint ON events(fingerprint);
CREATE INDEX IF NOT EXISTS idx_events_tour_id ON events(tour_id);
CREATE INDEX IF NOT EXISTS idx_watchlist_artist_id ON watchlist(artist_id);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox(status);
CREATE INDEX IF NOT EXISTS idx_inbox_thread_id ON inbox(thread_id);
