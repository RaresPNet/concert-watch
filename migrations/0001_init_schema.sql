-- Migration number: 0001 	 2026-09-01T00:00:00.000Z
-- Initial schema per DESIGN.md §4, plus the additions called out in
-- IMPLEMENTATION_PLAN.md S1.1 (subscriber preferences/verified_at, inbox
-- threading, source_health, usage, rate_limit, inbox.attempts).

CREATE TABLE subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'invited', -- invited | active | paused
  verified_at TEXT,                       -- set once confirmed as an Email Routing destination (§3)
  preferences TEXT,                       -- free-text standing preferences, appended over time (§11.3)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE artists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mbid TEXT UNIQUE,                       -- MusicBrainz, canonical identity
  name TEXT NOT NULL,
  sort_name TEXT,
  tm_attraction_id TEXT,                  -- Ticketmaster
  bit_slug TEXT,                          -- Bandsintown
  songkick_id TEXT,
  official_url TEXT,
  tour_url TEXT,
  image_url TEXT,                         -- R2 key once cached
  logo_url TEXT,                          -- R2 key once cached
  coverage TEXT NOT NULL DEFAULT 'unknown', -- api | dark | unknown
  tour_page_hash TEXT,                    -- content hash for cheap change detection
  last_polled_at TEXT,
  last_activity_at TEXT,                  -- last time anything was announced
  resolution_notes TEXT,                  -- free text from the add-time pass
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE watchlist (
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id),
  artist_id INTEGER NOT NULL REFERENCES artists(id),
  priority TEXT NOT NULL,                 -- P1..P4, see §7
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (subscriber_id, artist_id)
);

CREATE TABLE tours (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_id INTEGER NOT NULL REFERENCES artists(id),
  label TEXT,                             -- "European Tour 2027" or synthesised
  official_url TEXT,
  announced_on TEXT,
  date_count INTEGER,
  first_date TEXT,
  last_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL UNIQUE,       -- sha1(mbid | date | normalised_city)
  artist_id INTEGER NOT NULL REFERENCES artists(id),
  tour_id INTEGER REFERENCES tours(id),
  starts_at TEXT,
  timezone TEXT,
  city TEXT,
  country TEXT,
  city_key TEXT,                          -- e.g. "gb:leeds"
  venue_name TEXT,
  lat REAL,
  lon REAL,
  onsale_at TEXT,
  presale_at TEXT,
  ticket_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active | cancelled | postponed
  source TEXT,
  source_event_id TEXT,
  content_hash TEXT,                      -- material fields only
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id),
  tour_id INTEGER NOT NULL REFERENCES tours(id),
  event_id INTEGER REFERENCES events(id),
  trigger TEXT NOT NULL,                  -- new_tour | new_dates | material_change | onsale_soon
  notified_hash TEXT,
  sent_at TEXT,                           -- NULL until delivery confirmed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE reachability (
  city_key TEXT NOT NULL,
  origin_iata TEXT NOT NULL,
  tier TEXT NOT NULL,                     -- A | B | C | D
  route_note TEXT,                        -- "direct CLJ→LBA, Wizz, Tue/Sat"
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (city_key, origin_iata)
);

CREATE TABLE origins (
  iata TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  drive_km REAL,
  drive_minutes INTEGER,
  penalty_minutes INTEGER
);

CREATE TABLE inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_addr TEXT NOT NULL,
  subscriber_id INTEGER REFERENCES subscribers(id),
  dkim_pass INTEGER,                      -- boolean: 0/1
  spf_pass INTEGER,                       -- boolean: 0/1
  subject TEXT,
  body_text TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'pending', -- pending | handled | ignored | deferred
  handled_at TEXT,
  result_note TEXT,
  message_id TEXT,                        -- Message-ID header (§11.2)
  in_reply_to TEXT,                       -- In-Reply-To header (§11.2)
  "references" TEXT,                      -- References header, raw (§11.2)
  thread_id TEXT,                         -- derived root of the references chain (§11.2)
  attempts INTEGER NOT NULL DEFAULT 0     -- handling attempts, capped at 2 (§12.3)
);

-- Per-source failure tracking so a struggling source degrades rather than
-- breaking the run (§6.2).
CREATE TABLE source_health (
  source TEXT PRIMARY KEY,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_ok_at TEXT,
  last_error TEXT
);

-- Token/cost metering for the billed reply path only (§12.4, §12.5).
CREATE TABLE usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,                      -- YYYY-MM-DD
  path TEXT NOT NULL,                     -- e.g. "reply", "trip_planning"
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  est_cost REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-sender hourly rate limiting for inbound mail handling (§12.3, §12.4).
-- Keyed on sender address + the UTC hour bucket it applies to.
CREATE TABLE rate_limit (
  sender TEXT NOT NULL,
  hour_bucket TEXT NOT NULL,              -- e.g. "2026-09-01T14"
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sender, hour_bucket)
);
