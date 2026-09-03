/**
 * Tiny typed query layer over D1. No ORM — plain prepared statements wrapped
 * in functions that return the row types from `schema.ts`. This file
 * deliberately contains no business logic (no clustering, no notification
 * decisions, no mail handling): just reads and writes shaped to match the
 * tables in `migrations/`.
 *
 * Conventions:
 * - Every function takes `db: D1Database` first (the `DB` binding from `Env`).
 * - Insert helpers return the created row's `id` (or full key for tables
 *   without a surrogate key) rather than re-selecting, to keep round trips
 *   cheap; callers that need the full row call the matching `getBy*`.
 * - Booleans are stored as SQLite integers (0/1), matching `schema.ts`.
 */

import type {
	ArtistCoverage,
	ArtistRow,
	EventRow,
	InboxRow,
	InboxStatus,
	NotificationRow,
	NotificationTrigger,
	OriginRow,
	PendingPageParseRow,
	Priority,
	ReachabilityRow,
	SentReplyRow,
	SourceHealthRow,
	SubscriberRow,
	SubscriberStatus,
	TourRow,
	UsageRow,
	WatchlistRow,
} from './schema';

// ---------------------------------------------------------------------------
// subscribers
// ---------------------------------------------------------------------------

export async function insertSubscriber(
	db: D1Database,
	input: { email: string; display_name?: string | null; status?: SubscriberStatus },
): Promise<number> {
	const result = await db
		.prepare(`INSERT INTO subscribers (email, display_name, status) VALUES (?, ?, ?) RETURNING id`)
		.bind(input.email, input.display_name ?? null, input.status ?? 'invited')
		.first<{ id: number }>();
	if (!result) throw new Error('insertSubscriber: insert did not return an id');
	return result.id;
}

export async function getSubscriberById(db: D1Database, id: number): Promise<SubscriberRow | null> {
	return db.prepare(`SELECT * FROM subscribers WHERE id = ?`).bind(id).first<SubscriberRow>();
}

export async function getSubscriberByEmail(db: D1Database, email: string): Promise<SubscriberRow | null> {
	return db.prepare(`SELECT * FROM subscribers WHERE email = ?`).bind(email).first<SubscriberRow>();
}

/** Every subscriber row — S4.1's digest run iterates this to decide who gets a payload built. */
export async function getAllSubscribers(db: D1Database): Promise<SubscriberRow[]> {
	const result = await db.prepare(`SELECT * FROM subscribers ORDER BY id ASC`).all<SubscriberRow>();
	return result.results;
}

export async function setSubscriberVerifiedAt(db: D1Database, id: number, verifiedAt: string): Promise<void> {
	await db.prepare(`UPDATE subscribers SET verified_at = ? WHERE id = ?`).bind(verifiedAt, id).run();
}

/** S4.8: records that the 30-day heartbeat fired for this subscriber, so `runHeartbeatCheck` doesn't refire it every day thereafter. */
export async function setSubscriberLastHeartbeatAt(db: D1Database, id: number, at: string): Promise<void> {
	await db.prepare(`UPDATE subscribers SET last_heartbeat_at = ? WHERE id = ?`).bind(at, id).run();
}

/** S5.3: resolves an MCP bearer token straight back to the one subscriber it was minted for, or `null` if no subscriber holds it (an unknown/revoked token). This is the only lookup a subscriber-scoped MCP request ever needs -- it never takes a subscriber id as input. */
export async function getSubscriberByMcpToken(db: D1Database, token: string): Promise<SubscriberRow | null> {
	return db.prepare(`SELECT * FROM subscribers WHERE mcp_token = ?`).bind(token).first<SubscriberRow>();
}

/** S5.3: sets (or replaces) one subscriber's MCP bearer token. The caller is responsible for generating `token` with a CSPRNG -- see `mint_subscriber_token` in `src/mcp/server.ts`, the only current caller. */
export async function setSubscriberMcpToken(db: D1Database, id: number, token: string): Promise<void> {
	await db.prepare(`UPDATE subscribers SET mcp_token = ? WHERE id = ?`).bind(token, id).run();
}

export async function appendSubscriberPreference(db: D1Database, id: number, note: string): Promise<void> {
	// Appends free text, one line per call — see DESIGN.md §11.3.
	await db
		.prepare(
			`UPDATE subscribers
       SET preferences = COALESCE(preferences || char(10), '') || ?
       WHERE id = ?`,
		)
		.bind(note, id)
		.run();
}

export async function clearSubscriberPreferences(db: D1Database, id: number): Promise<void> {
	await db.prepare(`UPDATE subscribers SET preferences = NULL WHERE id = ?`).bind(id).run();
}

// ---------------------------------------------------------------------------
// artists
// ---------------------------------------------------------------------------

export async function insertArtist(
	db: D1Database,
	input: {
		mbid?: string | null;
		name: string;
		sort_name?: string | null;
		tm_attraction_id?: string | null;
		bit_slug?: string | null;
		songkick_id?: string | null;
		official_url?: string | null;
		tour_url?: string | null;
		image_url?: string | null;
		logo_url?: string | null;
		coverage?: ArtistCoverage;
		resolution_notes?: string | null;
	},
): Promise<number> {
	const result = await db
		.prepare(
			`INSERT INTO artists (
        mbid, name, sort_name, tm_attraction_id, bit_slug, songkick_id,
        official_url, tour_url, image_url, logo_url, coverage, resolution_notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id`,
		)
		.bind(
			input.mbid ?? null,
			input.name,
			input.sort_name ?? null,
			input.tm_attraction_id ?? null,
			input.bit_slug ?? null,
			input.songkick_id ?? null,
			input.official_url ?? null,
			input.tour_url ?? null,
			input.image_url ?? null,
			input.logo_url ?? null,
			input.coverage ?? 'unknown',
			input.resolution_notes ?? null,
		)
		.first<{ id: number }>();
	if (!result) throw new Error('insertArtist: insert did not return an id');
	return result.id;
}

export async function getArtistById(db: D1Database, id: number): Promise<ArtistRow | null> {
	return db.prepare(`SELECT * FROM artists WHERE id = ?`).bind(id).first<ArtistRow>();
}

export async function getArtistByMbid(db: D1Database, mbid: string): Promise<ArtistRow | null> {
	return db.prepare(`SELECT * FROM artists WHERE mbid = ?`).bind(mbid).first<ArtistRow>();
}

export async function touchArtistPolled(db: D1Database, id: number, polledAt: string): Promise<void> {
	await db.prepare(`UPDATE artists SET last_polled_at = ? WHERE id = ?`).bind(polledAt, id).run();
}

export async function touchArtistActivity(db: D1Database, id: number, activityAt: string): Promise<void> {
	await db.prepare(`UPDATE artists SET last_activity_at = ? WHERE id = ?`).bind(activityAt, id).run();
}

export async function updateArtistTourPageHash(db: D1Database, id: number, hash: string): Promise<void> {
	await db.prepare(`UPDATE artists SET tour_page_hash = ? WHERE id = ?`).bind(hash, id).run();
}

/** S4.3: records the R2 key once an artist's image has been fetched and cached. */
export async function updateArtistImageKey(db: D1Database, id: number, r2Key: string): Promise<void> {
	await db.prepare(`UPDATE artists SET image_url = ? WHERE id = ?`).bind(r2Key, id).run();
}

/** S4.3: records the R2 key once an artist's logo has been fetched and cached. */
export async function updateArtistLogoKey(db: D1Database, id: number, r2Key: string): Promise<void> {
	await db.prepare(`UPDATE artists SET logo_url = ? WHERE id = ?`).bind(r2Key, id).run();
}

// ---------------------------------------------------------------------------
// watchlist
// ---------------------------------------------------------------------------

export async function addToWatchlist(
	db: D1Database,
	input: { subscriber_id: number; artist_id: number; priority: Priority },
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO watchlist (subscriber_id, artist_id, priority) VALUES (?, ?, ?)
       ON CONFLICT (subscriber_id, artist_id) DO UPDATE SET priority = excluded.priority`,
		)
		.bind(input.subscriber_id, input.artist_id, input.priority)
		.run();
}

export async function getWatchlistForSubscriber(db: D1Database, subscriberId: number): Promise<WatchlistRow[]> {
	const result = await db.prepare(`SELECT * FROM watchlist WHERE subscriber_id = ?`).bind(subscriberId).all<WatchlistRow>();
	return result.results;
}

/**
 * S4.5: the single (subscriber, artist) watchlist row, or null if that
 * subscriber does not watch that artist. This is the ownership-check
 * primitive `src/agent/tools.ts` calls before letting a tool touch an
 * artist row on a subscriber's behalf -- a subscriber must not be able to
 * affect or read another subscriber's watchlist entry through a crafted
 * tool call (DESIGN.md §11.1's "data, not instructions" principle extends
 * to tool arguments, not just email bodies).
 */
export async function getWatchlistEntry(db: D1Database, subscriberId: number, artistId: number): Promise<WatchlistRow | null> {
	return db.prepare(`SELECT * FROM watchlist WHERE subscriber_id = ? AND artist_id = ?`).bind(subscriberId, artistId).first<WatchlistRow>();
}

/**
 * S4.5: case-insensitive artist name lookup scoped to one subscriber's own
 * watchlist (a join, not a global `artists` search) -- so `get_tour`'s
 * free-text path can never resolve to, or leak the existence of, an artist
 * the acting subscriber doesn't watch. Matches on exact name or a
 * substring, preferring an exact match when both exist.
 */
export async function findWatchedArtistByName(db: D1Database, subscriberId: number, name: string): Promise<ArtistRow | null> {
	const needle = name.trim().toLowerCase();
	if (!needle) return null;
	const result = await db
		.prepare(
			`SELECT a.* FROM artists a
       JOIN watchlist w ON w.artist_id = a.id
       WHERE w.subscriber_id = ? AND LOWER(a.name) LIKE ?
       ORDER BY (LOWER(a.name) = ?) DESC, a.name ASC
       LIMIT 1`,
		)
		.bind(subscriberId, `%${needle}%`, needle)
		.first<ArtistRow>();
	return result;
}

/**
 * S4.5: every artist a subscriber watches, artist row plus its own
 * priority -- the shape `list_watchlist` needs (names and priorities,
 * nothing else per DESIGN.md §11.5) without a second round trip per row.
 */
export async function getWatchlistWithArtists(
	db: D1Database,
	subscriberId: number,
): Promise<Array<{ artist_id: number; name: string; priority: Priority }>> {
	const result = await db
		.prepare(
			`SELECT a.id AS artist_id, a.name AS name, w.priority AS priority
       FROM watchlist w
       JOIN artists a ON a.id = w.artist_id
       WHERE w.subscriber_id = ?
       ORDER BY a.name ASC`,
		)
		.bind(subscriberId)
		.all<{ artist_id: number; name: string; priority: Priority }>();
	return result.results;
}

/**
 * S4.5: removes one (subscriber, artist) watchlist row. Returns whether a
 * row actually existed to remove -- the caller (`remove_artist`) uses this
 * as its ownership check rather than doing a separate `getWatchlistEntry`
 * read first, since D1's `meta.changes` already tells us.
 */
export async function removeFromWatchlist(db: D1Database, subscriberId: number, artistId: number): Promise<boolean> {
	const result = await db.prepare(`DELETE FROM watchlist WHERE subscriber_id = ? AND artist_id = ?`).bind(subscriberId, artistId).run();
	return (result.meta?.changes ?? 0) > 0;
}

/** Removes every watchlist row for one subscriber (onboarding reset). Returns the number of rows deleted. */
export async function deleteWatchlistForSubscriber(db: D1Database, subscriberId: number): Promise<number> {
	const result = await db.prepare(`DELETE FROM watchlist WHERE subscriber_id = ?`).bind(subscriberId).run();
	return result.meta?.changes ?? 0;
}

/**
 * S4.5: updates the priority on one (subscriber, artist) watchlist row.
 * Returns whether a row existed to update, for the same ownership-check
 * reason as `removeFromWatchlist`.
 */
export async function setWatchlistPriority(db: D1Database, subscriberId: number, artistId: number, priority: Priority): Promise<boolean> {
	const result = await db
		.prepare(`UPDATE watchlist SET priority = ? WHERE subscriber_id = ? AND artist_id = ?`)
		.bind(priority, subscriberId, artistId)
		.run();
	return (result.meta?.changes ?? 0) > 0;
}

/** The daily poll set: every artist watched by at least one subscriber (DESIGN.md §4). */
export async function getDistinctWatchedArtistIds(db: D1Database): Promise<number[]> {
	const result = await db.prepare(`SELECT DISTINCT artist_id FROM watchlist`).all<{ artist_id: number }>();
	return result.results.map((r) => r.artist_id);
}

/**
 * S6.2: every currently-watched artist's full row, ordered oldest-polled
 * first (`last_polled_at ASC` -- SQLite sorts `NULL` before any real value in
 * ascending order, so a never-polled artist is always due before one polled
 * at any timestamp). The daily cron uses this ordering to decide *which*
 * artists to poll when a per-run cap defers the rest to tomorrow: capping a
 * plain unordered list would let the same tail of artists starve every day,
 * while this ordering rotates fairly -- whichever artists ran out of budget
 * today are the least-recently-polled tomorrow, so they poll first.
 */
export async function getWatchedArtistsForPoll(db: D1Database): Promise<ArtistRow[]> {
	const result = await db
		.prepare(`SELECT * FROM artists WHERE id IN (SELECT DISTINCT artist_id FROM watchlist) ORDER BY last_polled_at ASC`)
		.all<ArtistRow>();
	return result.results;
}

/** Every subscriber watching one artist, with their priority — the S3.3 notification pass's fan-out. */
export async function getWatchlistForArtist(db: D1Database, artistId: number): Promise<WatchlistRow[]> {
	const result = await db.prepare(`SELECT * FROM watchlist WHERE artist_id = ?`).bind(artistId).all<WatchlistRow>();
	return result.results;
}

// ---------------------------------------------------------------------------
// tours
// ---------------------------------------------------------------------------

export async function insertTour(
	db: D1Database,
	input: {
		artist_id: number;
		label?: string | null;
		official_url?: string | null;
		announced_on?: string | null;
		date_count?: number | null;
		first_date?: string | null;
		last_date?: string | null;
	},
): Promise<number> {
	const result = await db
		.prepare(
			`INSERT INTO tours (artist_id, label, official_url, announced_on, date_count, first_date, last_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
		)
		.bind(
			input.artist_id,
			input.label ?? null,
			input.official_url ?? null,
			input.announced_on ?? null,
			input.date_count ?? null,
			input.first_date ?? null,
			input.last_date ?? null,
		)
		.first<{ id: number }>();
	if (!result) throw new Error('insertTour: insert did not return an id');
	return result.id;
}

export async function getTourById(db: D1Database, id: number): Promise<TourRow | null> {
	return db.prepare(`SELECT * FROM tours WHERE id = ?`).bind(id).first<TourRow>();
}

/**
 * The artist's currently "open" tour, if any — the most recently created
 * tour whose `last_date` hasn't passed yet. S3.3's clustering pass attaches
 * newly-seen dates to this tour (`new_dates`) rather than starting a new one.
 * Simplification: an artist with two genuinely simultaneous but geographically
 * distinct tours (rare — DESIGN.md §10.1's own handle mechanism anticipates
 * it) collapses to whichever tour was created most recently; see PROGRESS.md.
 */
export async function getOpenTourForArtist(db: D1Database, artistId: number, todayIso: string): Promise<TourRow | null> {
	return db
		.prepare(
			`SELECT * FROM tours
       WHERE artist_id = ? AND (last_date IS NULL OR last_date >= ?)
       ORDER BY created_at DESC LIMIT 1`,
		)
		.bind(artistId, todayIso)
		.first<TourRow>();
}

/**
 * S4.5: every tour ever created for one artist, most recent first --
 * `get_tour`'s handle-resolution path needs every tour (not just the
 * currently-"open" one from `getOpenTourForArtist`) so a handle referencing
 * a band's earlier tour still resolves, and so it can reproduce
 * `payload.ts`'s `makeHandle` formula against each candidate.
 */
export async function getToursForArtist(db: D1Database, artistId: number): Promise<TourRow[]> {
	const result = await db
		.prepare(`SELECT * FROM tours WHERE artist_id = ? ORDER BY created_at DESC, id DESC`)
		.bind(artistId)
		.all<TourRow>();
	return result.results;
}

export async function updateTourSummary(
	db: D1Database,
	id: number,
	input: { date_count: number; first_date: string | null; last_date: string | null },
): Promise<void> {
	await db
		.prepare(`UPDATE tours SET date_count = ?, first_date = ?, last_date = ? WHERE id = ?`)
		.bind(input.date_count, input.first_date, input.last_date, id)
		.run();
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

export async function upsertEventByFingerprint(
	db: D1Database,
	input: {
		fingerprint: string;
		artist_id: number;
		tour_id?: number | null;
		starts_at?: string | null;
		timezone?: string | null;
		city?: string | null;
		country?: string | null;
		city_key?: string | null;
		venue_name?: string | null;
		lat?: number | null;
		lon?: number | null;
		onsale_at?: string | null;
		presale_at?: string | null;
		ticket_url?: string | null;
		status?: EventRow['status'];
		source?: string | null;
		source_event_id?: string | null;
		content_hash?: string | null;
	},
): Promise<number> {
	const result = await db
		.prepare(
			`INSERT INTO events (
        fingerprint, artist_id, tour_id, starts_at, timezone, city, country, city_key,
        venue_name, lat, lon, onsale_at, presale_at, ticket_url, status, source,
        source_event_id, content_hash, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT (fingerprint) DO UPDATE SET
        tour_id = COALESCE(excluded.tour_id, events.tour_id),
        starts_at = excluded.starts_at,
        timezone = excluded.timezone,
        city = excluded.city,
        country = excluded.country,
        city_key = excluded.city_key,
        venue_name = excluded.venue_name,
        lat = excluded.lat,
        lon = excluded.lon,
        onsale_at = excluded.onsale_at,
        presale_at = excluded.presale_at,
        ticket_url = excluded.ticket_url,
        status = excluded.status,
        source = excluded.source,
        source_event_id = excluded.source_event_id,
        content_hash = excluded.content_hash,
        last_seen_at = datetime('now')
      RETURNING id`,
		)
		.bind(
			input.fingerprint,
			input.artist_id,
			input.tour_id ?? null,
			input.starts_at ?? null,
			input.timezone ?? null,
			input.city ?? null,
			input.country ?? null,
			input.city_key ?? null,
			input.venue_name ?? null,
			input.lat ?? null,
			input.lon ?? null,
			input.onsale_at ?? null,
			input.presale_at ?? null,
			input.ticket_url ?? null,
			input.status ?? 'active',
			input.source ?? null,
			input.source_event_id ?? null,
			input.content_hash ?? null,
		)
		.first<{ id: number }>();
	if (!result) throw new Error('upsertEventByFingerprint: upsert did not return an id');
	return result.id;
}

export async function getEventByFingerprint(db: D1Database, fingerprint: string): Promise<EventRow | null> {
	return db.prepare(`SELECT * FROM events WHERE fingerprint = ?`).bind(fingerprint).first<EventRow>();
}

export async function getEventsForTour(db: D1Database, tourId: number): Promise<EventRow[]> {
	const result = await db.prepare(`SELECT * FROM events WHERE tour_id = ? ORDER BY starts_at ASC`).bind(tourId).all<EventRow>();
	return result.results;
}

export async function getEventById(db: D1Database, id: number): Promise<EventRow | null> {
	return db.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first<EventRow>();
}

/** Future, still-active events for one artist not yet assigned to a tour — the S3.3 clustering pass's input. */
export async function getFutureActiveEventsWithoutTour(db: D1Database, artistId: number, todayIso: string): Promise<EventRow[]> {
	const result = await db
		.prepare(
			`SELECT * FROM events
       WHERE artist_id = ? AND tour_id IS NULL AND status = 'active' AND starts_at >= ?
       ORDER BY starts_at ASC`,
		)
		.bind(artistId, todayIso)
		.all<EventRow>();
	return result.results;
}

export async function setEventTourId(db: D1Database, eventId: number, tourId: number): Promise<void> {
	await db.prepare(`UPDATE events SET tour_id = ? WHERE id = ?`).bind(tourId, eventId).run();
}

/** Events (any artist) whose on-sale window falls within [fromIso, toIso] — the S3.3 `onsale_soon` scan. */
export async function getEventsOnsaleBetween(db: D1Database, fromIso: string, toIso: string): Promise<EventRow[]> {
	const result = await db
		.prepare(`SELECT * FROM events WHERE onsale_at IS NOT NULL AND onsale_at >= ? AND onsale_at <= ?`)
		.bind(fromIso, toIso)
		.all<EventRow>();
	return result.results;
}

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------

export async function insertNotification(
	db: D1Database,
	input: {
		subscriber_id: number;
		tour_id: number;
		event_id?: number | null;
		trigger: NotificationTrigger;
		notified_hash?: string | null;
	},
): Promise<number> {
	const result = await db
		.prepare(
			`INSERT INTO notifications (subscriber_id, tour_id, event_id, trigger, notified_hash)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id`,
		)
		.bind(input.subscriber_id, input.tour_id, input.event_id ?? null, input.trigger, input.notified_hash ?? null)
		.first<{ id: number }>();
	if (!result) throw new Error('insertNotification: insert did not return an id');
	return result.id;
}

export async function markNotificationSent(db: D1Database, id: number, sentAt: string): Promise<void> {
	await db.prepare(`UPDATE notifications SET sent_at = ? WHERE id = ?`).bind(sentAt, id).run();
}

export async function getUnsentNotificationsOlderThan(db: D1Database, isoCutoff: string): Promise<NotificationRow[]> {
	const result = await db
		.prepare(`SELECT * FROM notifications WHERE sent_at IS NULL AND created_at <= ?`)
		.bind(isoCutoff)
		.all<NotificationRow>();
	return result.results;
}

/** Every notification ever written for one event, across all subscribers — used to detect "already notified" (onsale_soon dedup). */
export async function getNotificationsForEvent(db: D1Database, eventId: number): Promise<NotificationRow[]> {
	const result = await db.prepare(`SELECT * FROM notifications WHERE event_id = ?`).bind(eventId).all<NotificationRow>();
	return result.results;
}

/**
 * Every notification ever written for one tour — both event-level rows
 * (`event_id` set, e.g. onsale_soon/material_change) and tour-level rows
 * (`event_id` NULL, e.g. new_tour/new_dates — DESIGN.md §9.1). A subscriber
 * counts as "already notified about event X" if either kind covers it (the
 * tour-level kind covers it implicitly, via `notified_hash`'s comma-separated
 * event id list) — see notify.ts's material_change handling.
 */
export async function getNotificationsForTour(db: D1Database, tourId: number): Promise<NotificationRow[]> {
	const result = await db.prepare(`SELECT * FROM notifications WHERE tour_id = ?`).bind(tourId).all<NotificationRow>();
	return result.results;
}

/** Every not-yet-delivered notification for one subscriber — S4.1's digest payload builder groups these by tour_id into blocks. */
export async function getPendingNotificationsForSubscriber(db: D1Database, subscriberId: number): Promise<NotificationRow[]> {
	const result = await db
		.prepare(`SELECT * FROM notifications WHERE subscriber_id = ? AND sent_at IS NULL ORDER BY id ASC`)
		.bind(subscriberId)
		.all<NotificationRow>();
	return result.results;
}

/** S4.8: the most recent `sent_at` across every delivered notification for one subscriber, or null if none has ever been delivered. Feeds the 30-day heartbeat's "nothing sent" check. */
export async function getLastSentAtForSubscriber(db: D1Database, subscriberId: number): Promise<string | null> {
	const row = await db
		.prepare(`SELECT MAX(sent_at) AS last_sent_at FROM notifications WHERE subscriber_id = ? AND sent_at IS NOT NULL`)
		.bind(subscriberId)
		.first<{ last_sent_at: string | null }>();
	return row?.last_sent_at ?? null;
}

// ---------------------------------------------------------------------------
// reachability / origins
// ---------------------------------------------------------------------------

export async function upsertReachability(
	db: D1Database,
	input: { city_key: string; origin_iata: string; tier: ReachabilityRow['tier']; route_note?: string | null },
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO reachability (city_key, origin_iata, tier, route_note, computed_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT (city_key, origin_iata) DO UPDATE SET
         tier = excluded.tier, route_note = excluded.route_note, computed_at = datetime('now')`,
		)
		.bind(input.city_key, input.origin_iata, input.tier, input.route_note ?? null)
		.run();
}

export async function getReachability(db: D1Database, cityKey: string): Promise<ReachabilityRow[]> {
	const result = await db.prepare(`SELECT * FROM reachability WHERE city_key = ?`).bind(cityKey).all<ReachabilityRow>();
	return result.results;
}

/**
 * S5.5: backs the `get_current_routes` MCP tool -- every currently-stored
 * reachability row for one origin airport, or (when `originIata` is
 * omitted) every row for every origin. This is the "what's already there"
 * side of the diff-not-rebuild refresh: the refreshing model reads this
 * before researching, so it only needs to submit rows that actually changed
 * to `refresh_reachability` instead of re-deriving the whole table.
 */
export async function getReachabilityByOrigin(db: D1Database, originIata?: string): Promise<ReachabilityRow[]> {
	if (originIata) {
		const result = await db
			.prepare(`SELECT * FROM reachability WHERE origin_iata = ? ORDER BY city_key`)
			.bind(originIata)
			.all<ReachabilityRow>();
		return result.results;
	}
	const result = await db.prepare(`SELECT * FROM reachability ORDER BY origin_iata, city_key`).all<ReachabilityRow>();
	return result.results;
}

/**
 * S5.5: the deletion half of the diff-refresh. A discontinued route isn't
 * expressible by omission -- `upsertReachability` only ever adds or updates
 * a row, so a route that no longer exists needs an explicit delete or it
 * just sits in D1 claiming a tier it no longer has. Called from
 * `refresh_reachability`'s `remove_reachability` list.
 */
export async function deleteReachability(db: D1Database, cityKey: string, originIata: string): Promise<void> {
	await db.prepare(`DELETE FROM reachability WHERE city_key = ? AND origin_iata = ?`).bind(cityKey, originIata).run();
}

/**
 * S4.5: `get_reachability(city)`'s lookup when the model's free-text city
 * doesn't match a `city_key` exactly. `city_key` is `"<country>:<city>"`
 * (DESIGN.md §4, e.g. `"gb:leeds"`) with no punctuation in the city part,
 * so this does a suffix match against a slugified query (lowercased,
 * non-alphanumeric stripped) -- `"Leeds"` and `"leeds"` both become `%:leeds`
 * and match `gb:leeds` without needing the country.
 */
export async function getReachabilityByCitySlug(db: D1Database, citySlug: string): Promise<ReachabilityRow[]> {
	const result = await db
		.prepare(`SELECT * FROM reachability WHERE city_key LIKE ? ESCAPE '\\'`)
		.bind(`%:${citySlug.replace(/[%_\\]/g, '\\$&')}`)
		.all<ReachabilityRow>();
	return result.results;
}

export async function upsertOrigin(db: D1Database, input: OriginRow): Promise<void> {
	await db
		.prepare(
			`INSERT INTO origins (iata, name, drive_km, drive_minutes, penalty_minutes)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (iata) DO UPDATE SET
         name = excluded.name, drive_km = excluded.drive_km,
         drive_minutes = excluded.drive_minutes, penalty_minutes = excluded.penalty_minutes`,
		)
		.bind(input.iata, input.name, input.drive_km ?? null, input.drive_minutes ?? null, input.penalty_minutes ?? null)
		.run();
}

export async function getAllOrigins(db: D1Database): Promise<OriginRow[]> {
	const result = await db.prepare(`SELECT * FROM origins`).all<OriginRow>();
	return result.results;
}

/**
 * S5.5: symmetric with `deleteReachability` -- an origin airport dropping
 * out entirely (unlikely, but expressible) needs the same explicit-delete
 * treatment rather than silent omission. `reachability` rows are not
 * cascade-deleted here; a caller removing an origin is expected to also
 * list its reachability rows in `remove_reachability` if it wants those
 * gone too, same as every other table in this file (no ON DELETE CASCADE
 * in the schema).
 */
export async function deleteOrigin(db: D1Database, iata: string): Promise<void> {
	await db.prepare(`DELETE FROM origins WHERE iata = ?`).bind(iata).run();
}

// ---------------------------------------------------------------------------
// inbox
// ---------------------------------------------------------------------------

export async function insertInboxMessage(
	db: D1Database,
	input: {
		from_addr: string;
		subscriber_id?: number | null;
		dkim_pass?: boolean | null;
		spf_pass?: boolean | null;
		subject?: string | null;
		body_text?: string | null;
		status?: InboxStatus;
		message_id?: string | null;
		in_reply_to?: string | null;
		references?: string | null;
		thread_id?: string | null;
	},
): Promise<number> {
	const result = await db
		.prepare(
			`INSERT INTO inbox (
        from_addr, subscriber_id, dkim_pass, spf_pass, subject, body_text, status,
        message_id, in_reply_to, "references", thread_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id`,
		)
		.bind(
			input.from_addr,
			input.subscriber_id ?? null,
			input.dkim_pass === undefined || input.dkim_pass === null ? null : input.dkim_pass ? 1 : 0,
			input.spf_pass === undefined || input.spf_pass === null ? null : input.spf_pass ? 1 : 0,
			input.subject ?? null,
			input.body_text ?? null,
			input.status ?? 'pending',
			input.message_id ?? null,
			input.in_reply_to ?? null,
			input.references ?? null,
			input.thread_id ?? null,
		)
		.first<{ id: number }>();
	if (!result) throw new Error('insertInboxMessage: insert did not return an id');
	return result.id;
}

export async function getPendingInboxMessages(db: D1Database): Promise<InboxRow[]> {
	const result = await db.prepare(`SELECT * FROM inbox WHERE status = 'pending' ORDER BY received_at ASC`).all<InboxRow>();
	return result.results;
}

/** S6.1: fetches the row `handleInboundEmail` just inserted, so the live
 * Email Worker path can hand it straight to `handleInboxRow` without
 * re-deriving it from the raw message. */
export async function getInboxRowById(db: D1Database, id: number): Promise<InboxRow | null> {
	const result = await db.prepare(`SELECT * FROM inbox WHERE id = ?`).bind(id).first<InboxRow>();
	return result ?? null;
}

/**
 * S6.2: rows the live inbound path (S6.1) or an earlier live-attempt failure
 * (S4.6's attempts-cap) left in `deferred` -- exactly the set DESIGN.md
 * §12.4 says "picked up by the next scheduled run." Oldest first, so a
 * per-run cap works through the backlog in arrival order rather than
 * newest-first.
 */
export async function getDeferredInboxMessages(db: D1Database): Promise<InboxRow[]> {
	const result = await db.prepare(`SELECT * FROM inbox WHERE status = 'deferred' ORDER BY received_at ASC`).all<InboxRow>();
	return result.results;
}

export async function getInboxThread(db: D1Database, threadId: string): Promise<InboxRow[]> {
	const result = await db.prepare(`SELECT * FROM inbox WHERE thread_id = ? ORDER BY received_at ASC`).bind(threadId).all<InboxRow>();
	return result.results;
}

export async function markInboxHandled(
	db: D1Database,
	id: number,
	input: { status: InboxStatus; result_note?: string | null },
): Promise<void> {
	await db
		.prepare(`UPDATE inbox SET status = ?, result_note = ?, handled_at = datetime('now') WHERE id = ?`)
		.bind(input.status, input.result_note ?? null, id)
		.run();
}

export async function incrementInboxAttempts(db: D1Database, id: number): Promise<number> {
	const result = await db
		.prepare(`UPDATE inbox SET attempts = attempts + 1 WHERE id = ? RETURNING attempts`)
		.bind(id)
		.first<{ attempts: number }>();
	if (!result) throw new Error('incrementInboxAttempts: update did not return attempts');
	return result.attempts;
}

/**
 * S4.6: marks a row `deferred` without stamping `handled_at` -- unlike
 * `markInboxHandled`, a deferred row is explicitly NOT done; it is waiting
 * for a later, different code path (a cron sweep, or eventually a
 * scheduled-task/app-quota pass) to pick it up. Used for both retry-storm
 * exhaustion (§12.4: 2 failed live attempts) and monthly-budget degrade
 * (§12.5) -- see `src/mail/handle.ts` for which is which. This is the
 * "combined insert-with-note helper" gap S1.4's own PROGRESS.md entry
 * flagged as worth adding alongside S4.6's needs; kept narrow (just the
 * UPDATE) rather than folding insert and note-setting into one function,
 * since S1.4's own inbound.ts is outside this step's touch list.
 */
export async function markInboxDeferred(db: D1Database, id: number, resultNote: string): Promise<void> {
	await db.prepare(`UPDATE inbox SET status = 'deferred', result_note = ? WHERE id = ?`).bind(resultNote, id).run();
}

/** Removes every inbox row for one subscriber (onboarding reset). Returns the number of rows deleted. */
export async function deleteInboxForSubscriber(db: D1Database, subscriberId: number): Promise<number> {
	const result = await db.prepare(`DELETE FROM inbox WHERE subscriber_id = ?`).bind(subscriberId).run();
	return result.meta?.changes ?? 0;
}

// ---------------------------------------------------------------------------
// sent_replies (migrations/0005_sent_replies.sql, S4.6)
// ---------------------------------------------------------------------------

/**
 * Persists one reply the inbound command handler actually sent (only ever
 * called after the mailer confirms delivery -- DESIGN.md §9.3's "don't mark
 * success until delivery confirms" discipline). Returns the new row's id.
 */
export async function insertSentReply(
	db: D1Database,
	input: {
		inbox_id: number;
		subscriber_id: number;
		thread_id: string;
		message_id: string;
		in_reply_to?: string | null;
		references?: string | null;
		body_text: string;
	},
): Promise<number> {
	const result = await db
		.prepare(
			`INSERT INTO sent_replies (inbox_id, subscriber_id, thread_id, message_id, in_reply_to, "references", body_text)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
		)
		.bind(
			input.inbox_id,
			input.subscriber_id,
			input.thread_id,
			input.message_id,
			input.in_reply_to ?? null,
			input.references ?? null,
			input.body_text,
		)
		.first<{ id: number }>();
	if (!result) throw new Error('insertSentReply: insert did not return an id');
	return result.id;
}

/**
 * Every reply sent so far in one thread, oldest first -- the "assistant"
 * half of the conversation `src/mail/conversation.ts` interleaves with
 * `getInboxThread`'s "user" half to reconstruct the whole exchange before
 * calling the model (DESIGN.md §11.2: "a reply loads its whole thread...
 * so the model sees real context rather than whatever the client happened
 * to quote").
 */
export async function getSentRepliesForThread(db: D1Database, threadId: string): Promise<SentReplyRow[]> {
	const result = await db
		.prepare(`SELECT * FROM sent_replies WHERE thread_id = ? ORDER BY sent_at ASC, id ASC`)
		.bind(threadId)
		.all<SentReplyRow>();
	return result.results;
}

/** Removes every sent-reply row for one subscriber (onboarding reset). Returns the number of rows deleted. */
export async function deleteSentRepliesForSubscriber(db: D1Database, subscriberId: number): Promise<number> {
	const result = await db.prepare(`DELETE FROM sent_replies WHERE subscriber_id = ?`).bind(subscriberId).run();
	return result.meta?.changes ?? 0;
}

// ---------------------------------------------------------------------------
// source_health
// ---------------------------------------------------------------------------

export async function recordSourceSuccess(db: D1Database, source: string, at: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO source_health (source, consecutive_failures, last_ok_at, last_error)
       VALUES (?, 0, ?, NULL)
       ON CONFLICT (source) DO UPDATE SET consecutive_failures = 0, last_ok_at = excluded.last_ok_at`,
		)
		.bind(source, at)
		.run();
}

export async function recordSourceFailure(db: D1Database, source: string, error: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO source_health (source, consecutive_failures, last_ok_at, last_error)
       VALUES (?, 1, NULL, ?)
       ON CONFLICT (source) DO UPDATE SET
         consecutive_failures = consecutive_failures + 1, last_error = excluded.last_error`,
		)
		.bind(source, error)
		.run();
}

export async function getSourceHealth(db: D1Database, source: string): Promise<SourceHealthRow | null> {
	return db.prepare(`SELECT * FROM source_health WHERE source = ?`).bind(source).first<SourceHealthRow>();
}

export async function getAllSourceHealth(db: D1Database): Promise<SourceHealthRow[]> {
	const result = await db.prepare(`SELECT * FROM source_health`).all<SourceHealthRow>();
	return result.results;
}

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------

export async function recordUsage(
	db: D1Database,
	input: {
		day: string;
		path: string;
		model: string;
		input_tokens: number;
		output_tokens: number;
		est_cost: number;
	},
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO usage (day, path, model, input_tokens, output_tokens, est_cost)
       VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(input.day, input.path, input.model, input.input_tokens, input.output_tokens, input.est_cost)
		.run();
}

export async function getUsageForMonth(db: D1Database, yyyyMm: string): Promise<UsageRow[]> {
	const result = await db.prepare(`SELECT * FROM usage WHERE day LIKE ? ORDER BY day ASC`).bind(`${yyyyMm}%`).all<UsageRow>();
	return result.results;
}

/**
 * S4.8: cumulative spend across every `usage` row ever written, for the
 * 30-day heartbeat's "spend to date" line (DESIGN.md §10.3) -- deliberately
 * all-time, not month-to-date like `budget.ts`'s `getBudgetStatus` (S4.4),
 * since "spend to date" reads as the running total rather than resetting
 * each month. S4.4's `budget.ts` only exposes a month-scoped helper; if it
 * later grows an all-time one, this is a natural place to switch to it
 * instead of querying `usage` directly.
 */
export async function getTotalSpend(db: D1Database): Promise<number> {
	const row = await db.prepare(`SELECT COALESCE(SUM(est_cost), 0) AS total FROM usage`).first<{ total: number }>();
	return row?.total ?? 0;
}

// ---------------------------------------------------------------------------
// rate_limit
// ---------------------------------------------------------------------------

/**
 * Increments the count for (sender, hour_bucket) and returns the new total.
 * Callers compare the result against the cap (6/hour per DESIGN.md §12.4).
 */
export async function incrementRateLimit(db: D1Database, sender: string, hourBucket: string): Promise<number> {
	const result = await db
		.prepare(
			`INSERT INTO rate_limit (sender, hour_bucket, count) VALUES (?, ?, 1)
       ON CONFLICT (sender, hour_bucket) DO UPDATE SET count = count + 1
       RETURNING count`,
		)
		.bind(sender, hourBucket)
		.first<{ count: number }>();
	if (!result) throw new Error('incrementRateLimit: upsert did not return a count');
	return result.count;
}

export async function getRateLimitCount(db: D1Database, sender: string, hourBucket: string): Promise<number> {
	const row = await db
		.prepare(`SELECT count FROM rate_limit WHERE sender = ? AND hour_bucket = ?`)
		.bind(sender, hourBucket)
		.first<{ count: number }>();
	return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// S4.7 additions -- MCP endpoint (src/mcp/server.ts)
// ---------------------------------------------------------------------------

/** Every `dark`-coverage artist -- S4.7's `get_sweep_targets` MCP tool. Per DESIGN.md §6.3, "every artist is polled every day" at this scale, so this is every dark artist, unfiltered by `last_polled_at` (no rotation, per §6.3/§15's explicit deferral). */
export async function getDarkArtists(db: D1Database): Promise<ArtistRow[]> {
	const result = await db.prepare(`SELECT * FROM artists WHERE coverage = 'dark' ORDER BY id ASC`).all<ArtistRow>();
	return result.results;
}

/** Count of `notifications` rows not yet delivered, across every subscriber -- one of S4.7's `status()` pending counts. */
export async function countPendingNotifications(db: D1Database): Promise<number> {
	const row = await db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE sent_at IS NULL`).first<{ n: number }>();
	return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// pending_page_parses (migrations/0003_pending_page_parses.sql, S4.7)
// ---------------------------------------------------------------------------

export async function upsertPendingPageParse(
	db: D1Database,
	input: { artist_id: number; tour_url: string; html: string; hash: string },
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO pending_page_parses (artist_id, tour_url, html, hash, queued_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT (artist_id) DO UPDATE SET
         tour_url = excluded.tour_url, html = excluded.html, hash = excluded.hash, queued_at = excluded.queued_at`,
		)
		.bind(input.artist_id, input.tour_url, input.html, input.hash)
		.run();
}

export async function getAllPendingPageParses(db: D1Database): Promise<PendingPageParseRow[]> {
	const result = await db.prepare(`SELECT * FROM pending_page_parses ORDER BY queued_at ASC`).all<PendingPageParseRow>();
	return result.results;
}

export async function getPendingPageParse(db: D1Database, artistId: number): Promise<PendingPageParseRow | null> {
	return db.prepare(`SELECT * FROM pending_page_parses WHERE artist_id = ?`).bind(artistId).first<PendingPageParseRow>();
}

/** Idempotent by construction -- deleting a row that's already gone (a repeat `submit_parsed_events` call) is a no-op, not an error. */
export async function deletePendingPageParse(db: D1Database, artistId: number): Promise<void> {
	await db.prepare(`DELETE FROM pending_page_parses WHERE artist_id = ?`).bind(artistId).run();
}
