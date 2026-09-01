/**
 * Tour clustering (IMPLEMENTATION_PLAN.md S3.3, DESIGN.md §9.1). "The unit is
 * the tour, not the event" — this assigns each newly-seen, still-future
 * event to a `tours` row so notify.ts can decide once per tour, not once per
 * date.
 *
 * No clustering window (§9.1): a tour is *all* currently-known unnotified
 * future dates for an artist at first sighting. Later dates landing on an
 * already-open tour attach to it instead of starting a second one.
 *
 * Simplification, documented rather than solved: "open tour" is resolved as
 * the artist's most recently created tour whose `last_date` hasn't passed
 * (`getOpenTourForArtist`, src/db/queries.ts). An artist genuinely running
 * two simultaneous, geographically distinct tours (DESIGN.md §10.1 itself
 * anticipates this — it's why tours get a short handle) would have its
 * second leg incorrectly folded into the first rather than clustered
 * separately. Not handled here; flagged in PROGRESS.md.
 */

import {
	getEventsForTour,
	getFutureActiveEventsWithoutTour,
	getOpenTourForArtist,
	insertTour,
	setEventTourId,
	updateTourSummary,
} from '../db/queries';
import type { EventRow, NotificationTrigger } from '../db/schema';

export interface ClusterOutcome {
	artist_id: number;
	tour_id: number;
	/** `new_tour` when this artist had no open tour; `new_dates` when dates attached to an existing one. */
	trigger: Extract<NotificationTrigger, 'new_tour' | 'new_dates'>;
	/** The events attached to the tour in this pass (not the tour's full event list). */
	events: EventRow[];
}

/** Clusters one artist's pending (tour_id IS NULL, future, active) events. Returns null if there's nothing pending. */
export async function clusterToursForArtist(db: D1Database, artistId: number, todayIso: string): Promise<ClusterOutcome | null> {
	const pending = await getFutureActiveEventsWithoutTour(db, artistId, todayIso);
	if (pending.length === 0) return null;

	const openTour = await getOpenTourForArtist(db, artistId, todayIso);
	const trigger: ClusterOutcome['trigger'] = openTour ? 'new_dates' : 'new_tour';
	const tourId = openTour ? openTour.id : await insertTour(db, { artist_id: artistId, announced_on: todayIso });

	for (const event of pending) {
		await setEventTourId(db, event.id, tourId);
	}

	// Recompute the summary across the tour's full event list (existing +
	// newly attached), not just the ones added this pass.
	const allEvents = await getEventsForTour(db, tourId);
	const dates = allEvents
		.map((e) => e.starts_at)
		.filter((d): d is string => d !== null)
		.sort();
	await updateTourSummary(db, tourId, {
		date_count: allEvents.length,
		first_date: dates[0] ?? null,
		last_date: dates[dates.length - 1] ?? null,
	});

	return { artist_id: artistId, tour_id: tourId, trigger, events: pending };
}

/** Clusters every artist in `artistIds`, skipping any with nothing pending. */
export async function clusterTours(db: D1Database, artistIds: number[], todayIso: string): Promise<ClusterOutcome[]> {
	const outcomes: ClusterOutcome[] = [];
	for (const artistId of artistIds) {
		const outcome = await clusterToursForArtist(db, artistId, todayIso);
		if (outcome) outcomes.push(outcome);
	}
	return outcomes;
}
