/**
 * Reachability join (IMPLEMENTATION_PLAN.md S3.4, DESIGN.md §7). Attaches
 * tier and route note to each event on a tour, and picks the three most
 * reachable dates the digest actually prints (§10.1).
 *
 * Ranking, per DESIGN.md §7.1: "a direct flight from CLJ always beats a
 * direct flight from BUD; a direct from BUD beats a one-stop from CLJ" —
 * i.e. compare tier first (A best), then break ties by the origin's
 * `penalty_minutes` (its drive time from Cluj; CLJ itself is 0).
 *
 * `pickBestReachability` here is deliberately similar to notify.ts's
 * `bestTierForCity`, not a shared import — notify.ts only ever needs the
 * *tier* to run the priority filter (§8) and runs a step earlier in the
 * pipeline (S3.3, before this step exists per the plan's own sequencing);
 * this file needs the full row (tier + route_note + which origin) to build
 * the digest's actual per-event display data. Small, deliberate duplication
 * over a cross-file dependency for a few lines of comparison logic, in
 * keeping with this codebase's existing precedent (see tourpage.ts's own
 * note on `hashTourPageContent`).
 */

import { getAllOrigins, getEventsForTour, getReachability } from '../db/queries';
import type { EventRow, ReachabilityRow, ReachabilityTier } from '../db/schema';

const TIER_RANK: Record<ReachabilityTier, number> = { A: 0, B: 1, C: 2, D: 3 };

export interface EventWithReachability extends EventRow {
	tier: ReachabilityTier | null;
	route_note: string | null;
	origin_iata: string | null;
}

export interface TourReachability {
	tour_id: number;
	/** Every event on the tour, each carrying its own best reachability option. */
	events: EventWithReachability[];
	/** The three most reachable dates — DESIGN.md §10.1's "three most reachable dates" for the digest block. */
	top_three: EventWithReachability[];
}

/** Best reachability option for a city across every origin: lowest tier wins, ties broken by origin penalty_minutes. */
export function pickBestReachability(rows: ReachabilityRow[], originPenaltyMinutes: Map<string, number>): ReachabilityRow | null {
	if (rows.length === 0) return null;
	return rows.reduce((best, row) => {
		const tierDelta = TIER_RANK[row.tier] - TIER_RANK[best.tier];
		if (tierDelta !== 0) return tierDelta < 0 ? row : best;
		const rowPenalty = originPenaltyMinutes.get(row.origin_iata) ?? Number.POSITIVE_INFINITY;
		const bestPenalty = originPenaltyMinutes.get(best.origin_iata) ?? Number.POSITIVE_INFINITY;
		return rowPenalty < bestPenalty ? row : best;
	});
}

/** Attaches reachability to every event on a tour and picks the top three by (tier asc, date asc). */
export async function attachReachabilityToTour(db: D1Database, tourId: number): Promise<TourReachability> {
	const events = await getEventsForTour(db, tourId);
	const origins = await getAllOrigins(db);
	const originPenaltyMinutes = new Map(origins.map((o) => [o.iata, o.penalty_minutes ?? Number.POSITIVE_INFINITY]));

	const cityKeys = [...new Set(events.map((e) => e.city_key).filter((k): k is string => k !== null))];
	const reachabilityByCity = new Map<string, ReachabilityRow[]>();
	for (const cityKey of cityKeys) {
		reachabilityByCity.set(cityKey, await getReachability(db, cityKey));
	}

	const withReachability: EventWithReachability[] = events.map((event) => {
		const rows = event.city_key ? (reachabilityByCity.get(event.city_key) ?? []) : [];
		const best = pickBestReachability(rows, originPenaltyMinutes);
		return {
			...event,
			tier: best?.tier ?? null,
			route_note: best?.route_note ?? null,
			origin_iata: best?.origin_iata ?? null,
		};
	});

	const ranked = [...withReachability].sort((a, b) => {
		const tierDelta = (a.tier ? TIER_RANK[a.tier] : TIER_RANK.D + 1) - (b.tier ? TIER_RANK[b.tier] : TIER_RANK.D + 1);
		if (tierDelta !== 0) return tierDelta;
		return (a.starts_at ?? '').localeCompare(b.starts_at ?? '');
	});

	return { tour_id: tourId, events: withReachability, top_three: ranked.slice(0, 3) };
}
