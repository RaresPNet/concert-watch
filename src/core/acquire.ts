/**
 * Acquisition-time ingest (IMPLEMENTATION_PLAN.md S5.1). Adding a band to a
 * watchlist should not mean "wait for tomorrow's poll to find out what's on
 * sale" — this file fetches, normalises, upserts and clusters everything
 * currently known about one artist in the same request that adds it, so the
 * confirmation reply can say what's already on, and the *next* scheduled
 * poll is a genuine before/after comparison rather than a guaranteed first
 * miss (every event would otherwise show up as "new" on day one regardless).
 *
 * Deliberately thin: it reuses `pollOneArtist` (src/core/poll.ts, S3.2) for
 * the fetch-normalise-upsert sequence and `clusterToursForArtist`
 * (src/core/tours.ts, S3.3) for clustering, rather than reimplementing
 * either. The only genuinely new behaviour here is the summarisation for the
 * caller (tour count / date count / nearest reachable date) and the decision
 * *not* to run a notification pass over the result.
 *
 * No `new_tour`/`new_dates` notification is fired for anything found here.
 * This is not implemented as a flag threaded through `clusterToursForArtist`
 * — that function has no notify-suppression parameter, and none was added,
 * since suppression falls out of the existing pipeline shape for free:
 * `runNotificationPass` (src/core/notify.ts) is never called from this file
 * at all, and the events acquired here are handed a real `tour_id` by
 * `clusterToursForArtist` in the same pass, so they no longer satisfy
 * `getFutureActiveEventsWithoutTour` (tour_id IS NULL) — the query every
 * future clustering pass uses to decide what's newly pending. A later poll
 * over this artist will not re-cluster them and so cannot hand them to a
 * notification pass a second time either. See PROGRESS.md's S5.1 entry for
 * the full reasoning.
 */

import { getArtistById, getToursForArtist } from '../db/queries';
import type { ReachabilityTier, TourRow } from '../db/schema';
import { attachReachabilityToTour } from './reach';
import { pollOneArtist, type PollArtistResult, type PollDeps } from './poll';
import { clusterToursForArtist } from './tours';

const TIER_RANK: Record<ReachabilityTier, number> = { A: 0, B: 1, C: 2, D: 3 };

export interface AcquireArtistReachableDate {
	starts_at: string;
	city: string | null;
	country: string | null;
	tier: ReachabilityTier | null;
}

export interface AcquireArtistResult {
	artist_id: number;
	/** Artist wasn't found at all -- caller passed a bad id. Nothing else is populated. */
	found: boolean;
	/** Currently-active tours (last_date IS NULL or in the future) for this artist, after this pass. */
	tour_count: number;
	/** Sum of date_count across those active tours. */
	date_count: number;
	/** The single most reachable upcoming date across all of the artist's active tours, or null if there is none yet. */
	nearest_reachable_date: AcquireArtistReachableDate | null;
	/** Per-source fetch errors from this pass (ticketmaster and/or tourpage) -- surfaced, not swallowed. */
	errors: string[];
	/** True when the tour page changed but had no usable JSON-LD -- queued for a later model parse, same signal `pollAll` reports. */
	needs_model_parse: boolean;
}

/** A tour still worth summarising: not yet fully in the past. Same predicate as `getOpenTourForArtist`'s SQL (db/queries.ts). */
function isActiveTour(tour: TourRow, todayIso: string): boolean {
	return tour.last_date === null || tour.last_date >= todayIso;
}

/**
 * Fetches every enabled source for one artist, persists what's found, and
 * clusters it into tours -- all in one pass, immediately (S5.1). Does not
 * send or queue any notification; see the module doc for why that's safe.
 */
export async function acquireArtist(artistId: number, deps: PollDeps): Promise<AcquireArtistResult> {
	const nowIso = (deps.now ?? (() => new Date().toISOString()))();

	const artist = await getArtistById(deps.db, artistId);
	if (!artist) {
		return {
			artist_id: artistId,
			found: false,
			tour_count: 0,
			date_count: 0,
			nearest_reachable_date: null,
			errors: [`artist ${artistId} not found`],
			needs_model_parse: false,
		};
	}

	const pollResult: PollArtistResult = await pollOneArtist(artist, deps, nowIso);
	// Deliberately not fed into runNotificationPass -- see module doc.
	await clusterToursForArtist(deps.db, artistId, nowIso);

	const allTours = await getToursForArtist(deps.db, artistId);
	const activeTours = allTours.filter((t) => isActiveTour(t, nowIso));

	let dateCount = 0;
	let nearest: AcquireArtistReachableDate | null = null;
	let nearestRank = Number.POSITIVE_INFINITY;
	for (const tour of activeTours) {
		dateCount += tour.date_count ?? 0;
		const reach = await attachReachabilityToTour(deps.db, tour.id);
		for (const event of reach.top_three) {
			if (!event.starts_at || event.starts_at < nowIso) continue;
			const rank = event.tier ? TIER_RANK[event.tier] : TIER_RANK.D + 1;
			const better = rank < nearestRank || (rank === nearestRank && (!nearest || event.starts_at < nearest.starts_at));
			if (better) {
				nearestRank = rank;
				nearest = { starts_at: event.starts_at, city: event.city, country: event.country, tier: event.tier };
			}
		}
	}

	return {
		artist_id: artistId,
		found: true,
		tour_count: activeTours.length,
		date_count: dateCount,
		nearest_reachable_date: nearest,
		errors: pollResult.errors,
		needs_model_parse: pollResult.needs_model_parse,
	};
}
