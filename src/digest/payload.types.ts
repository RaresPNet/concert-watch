/**
 * Digest payload shape (IMPLEMENTATION_PLAN.md S4.1, DESIGN.md §10). This is
 * the contract between S4.1 (builds it from D1) and S4.2 (renders it to
 * HTML/text) — written first so both steps can run in parallel against a
 * fixed type.
 *
 * One `DigestTourBlock` per tour with at least one pending (unsent)
 * notification for this subscriber this run. Sorted by tier then date per
 * §10.1. `affordance` is the *one* contextual invitation §10.2 asks for per
 * tour block — selected here, not at render time, since the selection logic
 * depends on data (tier, onsale window, date count) that's already in scope
 * when the payload is built.
 */

import type { NotificationTrigger, ReachabilityTier } from '../db/schema';

/**
 * Which of §10.2's four contextual invitations applies to a tour block.
 * `null` when none of the conditions apply (still gets the standing footer).
 */
export type ContextualAffordance =
	| 'trip_help' // tier A/B tour -> "Reply and I'll work out how to get there."
	| 'onsale_nudge' // has an on-sale date -> "Want a nudge the day before tickets drop?"
	| 'multi_date_ask' // multi-date tour -> "Reply for the full list, or ask about a city that isn't here."
	| 'awkward_p1' // tier C/D tour on a P1 band -> "This one's awkward to reach..."
	| null;

/** One of the tour's most reachable dates, per §10.1's per-date fields. */
export interface DigestEventSummary {
	event_id: number;
	starts_at: string | null;
	city: string | null;
	country: string | null;
	venue_name: string | null;
	tier: ReachabilityTier | null;
	route_note: string | null;
	onsale_at: string | null;
	presale_at: string | null;
	ticket_url: string | null;
}

/** One digest block: one tour, the subscriber's reason(s) for seeing it this run. */
export interface DigestTourBlock {
	tour_id: number;
	artist_id: number;
	artist_name: string;
	/** R2 key or URL for the artist image, per §10.4; null if none cached yet. */
	artist_image_url: string | null;
	label: string | null;
	official_url: string | null;
	date_count: number;
	first_date: string | null;
	last_date: string | null;
	/** The three most reachable dates, per §10.1 ("the three most reachable dates"). */
	top_dates: DigestEventSummary[];
	/**
	 * Short handle for referencing this tour in a reply (§10.1's `#A3F`), or
	 * null when the band has only one live tour and a handle would add
	 * nothing. Uniqueness scope is per-subscriber-per-digest, not global.
	 */
	handle: string | null;
	/** Which trigger(s) produced a pending notification for this block this run. */
	triggers: NotificationTrigger[];
	/** notifications.id for every row this block reports on — the caller marks these sent_at after delivery (§9.3). */
	notification_ids: number[];
	/** True if the tour page/source indicated more dates are still to come (§9.1: "say so... do not speculate when we don't know"). */
	more_dates_expected: boolean;
	affordance: ContextualAffordance;
}

export interface DigestPayload {
	subscriber_id: number;
	email: string;
	display_name: string | null;
	/** Sorted by tier then date, per §10.1. */
	tours: DigestTourBlock[];
}

/** Empty payload -> explicit "no send" result, per S4.1's done-when. */
export type DigestBuildResult =
	{ send: true; payload: DigestPayload } | { send: false; subscriber_id: number; reason: 'no_pending_notifications' };
