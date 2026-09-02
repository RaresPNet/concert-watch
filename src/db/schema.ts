/**
 * Row types mirroring the tables created in `migrations/`. These are plain
 * data shapes, not an ORM — see `queries.ts` for the typed access layer that
 * uses them.
 *
 * Kept in sync with DESIGN.md §4 by hand; if you add a column, add it here
 * too.
 */

export type SubscriberStatus = 'invited' | 'active' | 'paused';

export interface SubscriberRow {
	id: number;
	email: string;
	display_name: string | null;
	status: SubscriberStatus;
	verified_at: string | null;
	preferences: string | null;
	created_at: string;
	/** S4.8 (migration 0004): last time the 30-day heartbeat fired for this subscriber, so it doesn't refire daily once silence crosses the threshold. */
	last_heartbeat_at: string | null;
}

export type ArtistCoverage = 'api' | 'dark' | 'unknown';

export interface ArtistRow {
	id: number;
	mbid: string | null;
	name: string;
	sort_name: string | null;
	tm_attraction_id: string | null;
	bit_slug: string | null;
	songkick_id: string | null;
	official_url: string | null;
	tour_url: string | null;
	image_url: string | null;
	logo_url: string | null;
	coverage: ArtistCoverage;
	tour_page_hash: string | null;
	last_polled_at: string | null;
	last_activity_at: string | null;
	resolution_notes: string | null;
	created_at: string;
}

export type Priority = 'P1' | 'P2' | 'P3' | 'P4';

export interface WatchlistRow {
	subscriber_id: number;
	artist_id: number;
	priority: Priority;
	added_at: string;
}

export interface TourRow {
	id: number;
	artist_id: number;
	label: string | null;
	official_url: string | null;
	announced_on: string | null;
	date_count: number | null;
	first_date: string | null;
	last_date: string | null;
	created_at: string;
}

export type EventStatus = 'active' | 'cancelled' | 'postponed';

export interface EventRow {
	id: number;
	fingerprint: string;
	artist_id: number;
	tour_id: number | null;
	starts_at: string | null;
	timezone: string | null;
	city: string | null;
	country: string | null;
	city_key: string | null;
	venue_name: string | null;
	lat: number | null;
	lon: number | null;
	onsale_at: string | null;
	presale_at: string | null;
	ticket_url: string | null;
	status: EventStatus;
	source: string | null;
	source_event_id: string | null;
	content_hash: string | null;
	first_seen_at: string;
	last_seen_at: string;
}

export type NotificationTrigger = 'new_tour' | 'new_dates' | 'material_change' | 'onsale_soon';

export interface NotificationRow {
	id: number;
	subscriber_id: number;
	tour_id: number;
	event_id: number | null;
	trigger: NotificationTrigger;
	notified_hash: string | null;
	sent_at: string | null;
	created_at: string;
}

export type ReachabilityTier = 'A' | 'B' | 'C' | 'D';

export interface ReachabilityRow {
	city_key: string;
	origin_iata: string;
	tier: ReachabilityTier;
	route_note: string | null;
	computed_at: string;
}

export interface OriginRow {
	iata: string;
	name: string;
	drive_km: number | null;
	drive_minutes: number | null;
	penalty_minutes: number | null;
}

export type InboxStatus = 'pending' | 'handled' | 'ignored' | 'deferred';

export interface InboxRow {
	id: number;
	from_addr: string;
	subscriber_id: number | null;
	dkim_pass: number | null; // SQLite boolean: 0/1
	spf_pass: number | null; // SQLite boolean: 0/1
	subject: string | null;
	body_text: string | null;
	received_at: string;
	status: InboxStatus;
	handled_at: string | null;
	result_note: string | null;
	message_id: string | null;
	in_reply_to: string | null;
	references: string | null;
	thread_id: string | null;
	attempts: number;
}

export interface SourceHealthRow {
	source: string;
	consecutive_failures: number;
	last_ok_at: string | null;
	last_error: string | null;
}

export interface UsageRow {
	id: number;
	day: string; // YYYY-MM-DD
	path: string;
	model: string;
	input_tokens: number;
	output_tokens: number;
	est_cost: number;
	created_at: string;
}

export interface RateLimitRow {
	sender: string;
	hour_bucket: string; // e.g. "2026-09-01T14"
	count: number;
}

/**
 * S4.6 (migrations/0005_sent_replies.sql): one row per reply the inbound
 * command handler actually sent, keyed to the `inbox` row it answered. See
 * the migration's own header comment for why this table exists -- in short,
 * DESIGN.md §11.2 asks for threading headers on "every sent mail" but the
 * schema in §4 never gave sent mail a table, and S4.6's stateful-thread
 * requirement needs the model to see its own prior replies, not just what
 * the subscriber wrote.
 */
export interface SentReplyRow {
	id: number;
	inbox_id: number;
	subscriber_id: number;
	thread_id: string;
	message_id: string;
	in_reply_to: string | null;
	references: string | null;
	body_text: string;
	sent_at: string;
}

/**
 * S4.7 (migrations/0003_pending_page_parses.sql): a tour page that changed
 * but carried no usable JSON-LD `MusicEvent` data, awaiting a model parse via
 * the MCP `get_unparsed_pages`/`submit_parsed_events` tools. One row per
 * artist -- see the migration's own comment for why a plain PRIMARY KEY on
 * `artist_id` (upsert, not append) is correct here.
 */
export interface PendingPageParseRow {
	artist_id: number;
	tour_url: string;
	html: string;
	hash: string;
	queued_at: string;
}
