/**
 * Digest payload builder (IMPLEMENTATION_PLAN.md S4.1, DESIGN.md §10). Pure
 * D1 read + assembly — no model call anywhere in this file, matching the
 * deterministic-core pattern of S3.2/S3.3/S3.4.
 *
 * One `DigestTourBlock` per (subscriber, tour) that has at least one pending
 * (`sent_at IS NULL`) notification this run — notify.ts (S3.3) already
 * decided *whether* a subscriber should hear about a tour; this file only
 * groups its pending rows, joins in reachability (S3.4) and the tour/artist
 * rows, and picks the one contextual affordance (§10.2) each block gets.
 *
 * Sending itself, `sent_at` bookkeeping, and HTML rendering are later steps'
 * jobs (§9.3, S4.2) — this file only reads and assembles.
 */

import {
	getAllSourceHealth,
	getAllSubscribers,
	getArtistById,
	getPendingNotificationsForSubscriber,
	getSubscriberById,
	getTourById,
	getWatchlistForSubscriber,
} from '../db/queries';
import { attachReachabilityToTour } from '../core/reach';
import type { NotificationRow, NotificationTrigger, Priority, ReachabilityTier, SourceHealthRow } from '../db/schema';
import type { ContextualAffordance, DigestBuildResult, DigestEventSummary, DigestPayload, DigestTourBlock } from './payload.types';

const TIER_SORT_RANK: Record<ReachabilityTier, number> = { A: 0, B: 1, C: 2, D: 3 };
/** Rank used for a block with no known tier at all (worse than D) — sorts last, per S3.4's own precedent for "unknown tier". */
const NO_TIER_RANK = 4;

/**
 * Which of §10.2's four contextual invitations wins when more than one could
 * apply to the same block. The design lists four conditions without an
 * explicit priority order (only one affordance is printed per block), so
 * this order is this step's own call — documented in PROGRESS.md:
 *
 *   1. onsale_nudge — a concrete, time-boxed action (tickets drop on a known
 *      date) beats a generic invitation regardless of how reachable the show
 *      is; it's useful even on a tour the subscriber can't easily attend.
 *   2. trip_help — tier A/B, no onsale date yet: the natural next step is
 *      "help me get there."
 *   3. awkward_p1 — tier C/D, but only on a P1 ("chase") band: distinct from
 *      trip_help precisely because tier is bad, so it can never fire
 *      alongside it.
 *   4. multi_date_ask — the weakest signal (just "more than one date"), used
 *      only when nothing more specific applies.
 */
function selectAffordance(params: {
	hasOnsale: boolean;
	tier: ReachabilityTier | null;
	priority: Priority | null;
	dateCount: number;
}): ContextualAffordance {
	if (params.hasOnsale) return 'onsale_nudge';
	if (params.tier === 'A' || params.tier === 'B') return 'trip_help';
	if ((params.tier === 'C' || params.tier === 'D') && params.priority === 'P1') return 'awkward_p1';
	if (params.dateCount > 1) return 'multi_date_ask';
	return null;
}

/**
 * Short handle for referencing a tour in a reply (§10.1's `#A3F`). Derived,
 * not stored: first letter of the artist name + the tour id in base36
 * (2 chars, zero-padded) — short, stable across runs (depends only on
 * immutable-once-created `tours.id`), and distinguishes an artist's two
 * live tours from each other, which is the only case §10.1 says it needs to
 * earn its place.
 */
function makeHandle(artistName: string, tourId: number): string {
	const initial = (artistName.trim()[0] ?? 'X').toUpperCase();
	const suffix = tourId.toString(36).toUpperCase().slice(-2).padStart(2, '0');
	return `#${initial}${suffix}`;
}

/** Distinct triggers among a block's pending notifications, in the order they were first written (by notification id). */
function uniqueTriggersInOrder(notifs: NotificationRow[]): NotificationTrigger[] {
	const sorted = [...notifs].sort((a, b) => a.id - b.id);
	const seen = new Set<NotificationTrigger>();
	const result: NotificationTrigger[] = [];
	for (const n of sorted) {
		if (!seen.has(n.trigger)) {
			seen.add(n.trigger);
			result.push(n.trigger);
		}
	}
	return result;
}

function tierRank(block: DigestTourBlock): number {
	const tier = block.top_dates[0]?.tier ?? null;
	return tier ? TIER_SORT_RANK[tier] : NO_TIER_RANK;
}

/** Builds the digest payload for one subscriber. Empty (no pending notifications) -> explicit `send: false`, per this step's done-when. */
export async function buildDigestPayload(db: D1Database, subscriberId: number): Promise<DigestBuildResult> {
	const pending = await getPendingNotificationsForSubscriber(db, subscriberId);
	if (pending.length === 0) {
		return { send: false, subscriber_id: subscriberId, reason: 'no_pending_notifications' };
	}

	const subscriber = await getSubscriberById(db, subscriberId);
	const watchlist = await getWatchlistForSubscriber(db, subscriberId);
	const priorityByArtist = new Map(watchlist.map((w) => [w.artist_id, w.priority]));

	const byTour = new Map<number, NotificationRow[]>();
	for (const n of pending) {
		const list = byTour.get(n.tour_id);
		if (list) list.push(n);
		else byTour.set(n.tour_id, [n]);
	}

	const blocks: DigestTourBlock[] = [];
	const blocksByArtist = new Map<number, DigestTourBlock[]>();

	for (const [tourId, notifs] of byTour) {
		const tour = await getTourById(db, tourId);
		if (!tour) continue; // defensive: a notification referencing a tour that no longer exists shouldn't crash the whole digest
		const artist = await getArtistById(db, tour.artist_id);
		if (!artist) continue;

		const reach = await attachReachabilityToTour(db, tourId);
		const topDates: DigestEventSummary[] = reach.top_three.map((e) => ({
			event_id: e.id,
			starts_at: e.starts_at,
			city: e.city,
			country: e.country,
			venue_name: e.venue_name,
			tier: e.tier,
			route_note: e.route_note,
			onsale_at: e.onsale_at,
			presale_at: e.presale_at,
			ticket_url: e.ticket_url,
		}));

		const headlineTier = reach.top_three[0]?.tier ?? null;
		const hasOnsale = reach.events.some((e) => e.onsale_at !== null);
		const dateCount = tour.date_count ?? reach.events.length;
		const priority = priorityByArtist.get(artist.id) ?? null;

		const block: DigestTourBlock = {
			tour_id: tour.id,
			artist_id: artist.id,
			artist_name: artist.name,
			artist_image_url: artist.image_url,
			label: tour.label,
			official_url: tour.official_url,
			date_count: dateCount,
			first_date: tour.first_date,
			last_date: tour.last_date,
			top_dates: topDates,
			handle: null, // filled in below, once every artist's block count in this digest is known
			triggers: uniqueTriggersInOrder(notifs),
			notification_ids: notifs.map((n) => n.id).sort((a, b) => a - b),
			// No upstream step (tours.ts/poll.ts) currently produces a "more dates
			// TBA" signal — defaulted false rather than guessed. See PROGRESS.md.
			more_dates_expected: false,
			affordance: selectAffordance({ hasOnsale, tier: headlineTier, priority, dateCount }),
		};

		blocks.push(block);
		const artistBlocks = blocksByArtist.get(artist.id);
		if (artistBlocks) artistBlocks.push(block);
		else blocksByArtist.set(artist.id, [block]);
	}

	// Handle only earns its place when a band has two (or more) live tours in
	// this same digest (§10.1) — a single-tour band gets `handle: null`.
	for (const artistBlocks of blocksByArtist.values()) {
		if (artistBlocks.length < 2) continue;
		for (const block of artistBlocks) block.handle = makeHandle(block.artist_name, block.tour_id);
	}

	blocks.sort((a, b) => {
		const tierDelta = tierRank(a) - tierRank(b);
		if (tierDelta !== 0) return tierDelta;
		return (a.first_date ?? '').localeCompare(b.first_date ?? '');
	});

	const payload: DigestPayload = {
		subscriber_id: subscriberId,
		email: subscriber?.email ?? '',
		display_name: subscriber?.display_name ?? null,
		tours: blocks,
	};

	return { send: true, payload };
}

/** Builds a payload for every non-paused subscriber. Paused subscribers are skipped entirely (no digest, per DESIGN.md §2's `paused` status). */
export async function buildAllDigestPayloads(db: D1Database): Promise<DigestBuildResult[]> {
	const subscribers = await getAllSubscribers(db);
	const results: DigestBuildResult[] = [];
	for (const subscriber of subscribers) {
		if (subscriber.status === 'paused') continue;
		results.push(await buildDigestPayload(db, subscriber.id));
	}
	return results;
}

// ---------------------------------------------------------------------------
// Source health (IMPLEMENTATION_PLAN.md S6.4, DESIGN.md §6.2's "record
// consecutive failures per source in source_health; after three, add a
// one-line warning at the bottom of the next digest").
//
// `source_health` is keyed globally by `source` string only (see
// `src/db/schema.ts`'s `SourceHealthRow` and the write helpers around
// `src/db/queries.ts`'s `recordSourceSuccess`/`recordSourceFailure`) -- there
// is no per-artist failure tracking anywhere in the schema. S6.4's own plan
// text asks for "a separate alert only if every source for a given artist
// has been failing for a week," which cannot be computed from what the
// schema actually records: doing so would need a per-(artist, source)
// failure table and a migration, both outside this step's touch list (only
// `payload.ts` and `fallback.ts`). The closest honest reading reachable from
// the *global* `source_health` table alone: "every source" == every source
// currently tracked in `source_health`, and "failing for a week" ==
// currently failing (`consecutive_failures > 0`) with either no recorded
// success at all (`last_ok_at IS NULL`) or a last success more than ~7 days
// ago. Flagged in full in PROGRESS.md's S6.4 entry, not silently
// reinterpreted.
// ---------------------------------------------------------------------------

/** DESIGN.md §6.2: "after three [consecutive failures], add a one-line warning." */
const SOURCE_FAILURE_WARNING_THRESHOLD = 3;
/** Approximates S6.4's "failing for a week" against the only timestamp `source_health` actually keeps (`last_ok_at`). */
const ALL_SOURCES_FAILING_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface SourceHealthSummary {
	/** Sources with >= 3 consecutive failures (DESIGN.md §6.2), in `source_health`'s own row order. Empty when nothing is struggling. */
	strugglingSources: SourceHealthRow[];
	/**
	 * True when *every* row currently in `source_health` is both failing now
	 * and has been for roughly a week — the global approximation of S6.4's
	 * per-artist "every source has been failing for a week" described above.
	 * False when `source_health` has no rows at all (nothing to alert on).
	 */
	allSourcesFailingForAWeek: boolean;
}

/** Parses D1's `datetime('now')` default shape ("YYYY-MM-DD HH:MM:SS", UTC, no `T`/`Z`) — same convention `fallback.ts` already established for comparing against `source_health.last_ok_at`. */
function parseSqliteUtc(value: string): number {
	return new Date(value.replace(' ', 'T') + 'Z').getTime();
}

/** Reads `source_health` and classifies it per DESIGN.md §6.2 / IMPLEMENTATION_PLAN.md S6.4. Pure D1 read, no model call, matching this file's own deterministic-core pattern. */
export async function buildSourceHealthSummary(db: D1Database, now: Date = new Date()): Promise<SourceHealthSummary> {
	const rows = await getAllSourceHealth(db);
	const strugglingSources = rows.filter((r) => r.consecutive_failures >= SOURCE_FAILURE_WARNING_THRESHOLD);
	const allSourcesFailingForAWeek =
		rows.length > 0 &&
		rows.every(
			(r) =>
				r.consecutive_failures > 0 &&
				(r.last_ok_at === null || now.getTime() - parseSqliteUtc(r.last_ok_at) >= ALL_SOURCES_FAILING_WEEK_MS),
		);
	return { strugglingSources, allSourcesFailingForAWeek };
}
