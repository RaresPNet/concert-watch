/**
 * Notification state machine (IMPLEMENTATION_PLAN.md S3.3, DESIGN.md §8-§9).
 * Decides which `notifications` rows to write from a poll+cluster pass, one
 * per (subscriber, tour|event, trigger) — never per raw event for the
 * tour-level triggers.
 *
 * Priority is the filter on reachability tier (§8) — applied per subscriber
 * *before* a notification row is written. `sent_at` stays NULL here; it's
 * only set once delivery is confirmed (§9.3, a later step's job — the
 * digest/mailer).
 *
 * Priority -> tier mapping, exactly as specified for P1/P2, approximated for
 * P3/P4 (see below and PROGRESS.md):
 *   P1 chase   — notifies on A, B, C, D (i.e. always).
 *   P2 travel  — notifies on A, B.
 *   P3 regional — spec says "C where drivable"; `reachability` stores a
 *     single tier per (city_key, origin_iata) with no separate
 *     drivable-vs-connection flag (that distinction lives only in the
 *     free-text `route_note`, S1.2), so this is approximated as "tier C",
 *     the broader set. Flagged as an assumption, not silently narrowed.
 *   P4 local   — spec says "Cluj / Bucharest only." Reachability tiers don't
 *     encode city-level Romania-only vs. drivable-elsewhere, but
 *     `events.country` does: approximated as `country === 'RO'`.
 */

import {
	getEventById,
	getEventsOnsaleBetween,
	getNotificationsForEvent,
	getNotificationsForTour,
	getReachability,
	getWatchlistForArtist,
	insertNotification,
} from '../db/queries';
import type { EventRow, NotificationRow, NotificationTrigger, Priority, ReachabilityTier } from '../db/schema';
import type { ClusterOutcome } from './tours';

const TIER_RANK: Record<ReachabilityTier, number> = { A: 0, B: 1, C: 2, D: 3 };

/** Best (lowest) tier known for a city across every origin, or null if the city has no reachability rows at all. */
async function bestTierForCity(db: D1Database, cityKey: string): Promise<ReachabilityTier | null> {
	const rows = await getReachability(db, cityKey);
	if (rows.length === 0) return null;
	return rows.reduce((best, row) => (TIER_RANK[row.tier] < TIER_RANK[best] ? row.tier : best), rows[0].tier);
}

function priorityAllows(priority: Priority, tier: ReachabilityTier | null, country: string | null): boolean {
	switch (priority) {
		case 'P1':
			return true;
		case 'P2':
			return tier === 'A' || tier === 'B';
		case 'P3':
			return tier === 'C';
		case 'P4':
			return country === 'RO';
	}
}

export interface NotifyRunInput {
	db: D1Database;
	/** From tours.ts's clustering pass this run — drives new_tour/new_dates. */
	clusterOutcomes: ClusterOutcome[];
	/** Event ids poll.ts classified as 'changed' this run — drives material_change. */
	changedEventIds: number[];
	/** ISO timestamp "now" for this run — drives the onsale_soon 72h window. */
	now: string;
}

/** 72 hours, per DESIGN.md §9.2's onsale_soon trigger. */
const ONSALE_SOON_WINDOW_MS = 72 * 60 * 60 * 1000;

async function notifyForClusterOutcome(db: D1Database, outcome: ClusterOutcome): Promise<NotificationRow[]> {
	const watchers = await getWatchlistForArtist(db, outcome.artist_id);
	if (watchers.length === 0) return [];

	const created: NotificationRow[] = [];
	for (const watcher of watchers) {
		const qualifying: EventRow[] = [];
		for (const event of outcome.events) {
			const tier = event.city_key ? await bestTierForCity(db, event.city_key) : null;
			if (priorityAllows(watcher.priority, tier, event.country)) qualifying.push(event);
		}
		if (qualifying.length === 0) continue;

		const id = await insertNotification(db, {
			subscriber_id: watcher.subscriber_id,
			tour_id: outcome.tour_id,
			event_id: null, // tour-level trigger, per DESIGN.md §9.1 ("notification fires per tours row")
			trigger: outcome.trigger,
			notified_hash: qualifying
				.map((e) => e.id)
				.sort((a, b) => a - b)
				.join(','),
		});
		created.push(makeRow(id, watcher.subscriber_id, outcome.tour_id, null, outcome.trigger, null));
	}
	return created;
}

/** Does a delivered tour-level notification (new_tour/new_dates, event_id NULL) already cover this event via its comma-separated notified_hash? */
function tourLevelNotifCoversEvent(n: NotificationRow, eventId: number): boolean {
	if (n.event_id !== null || n.sent_at === null || !n.notified_hash) return false;
	return n.notified_hash.split(',').includes(String(eventId));
}

async function notifyForMaterialChange(db: D1Database, eventId: number): Promise<NotificationRow[]> {
	const event = await getEventById(db, eventId);
	if (!event || event.tour_id === null) return [];

	// Notifications are written per (subscriber, tour) for new_tour/new_dates
	// (event_id NULL, DESIGN.md §9.1) and per (subscriber, event) for
	// onsale_soon/material_change — so "already notified about this specific
	// event" has to check both shapes, not just rows with event_id = eventId.
	const tourNotifs = await getNotificationsForTour(db, event.tour_id);
	const priorNotifs = tourNotifs.filter((n) => n.event_id === eventId);
	const alreadyNotifiedSubscribers = new Set(
		tourNotifs
			.filter((n) => (n.event_id === eventId && n.sent_at !== null) || tourLevelNotifCoversEvent(n, eventId))
			.map((n) => n.subscriber_id),
	);
	if (alreadyNotifiedSubscribers.size === 0) return [];

	const watchers = await getWatchlistForArtist(db, event.artist_id);
	const created: NotificationRow[] = [];
	for (const subscriberId of alreadyNotifiedSubscribers) {
		const watcher = watchers.find((w) => w.subscriber_id === subscriberId);
		if (!watcher) continue;

		const alreadySentForThisChange = priorNotifs.some(
			(n) => n.subscriber_id === subscriberId && n.trigger === 'material_change' && n.notified_hash === event.content_hash,
		);
		if (alreadySentForThisChange) continue;

		const tier = event.city_key ? await bestTierForCity(db, event.city_key) : null;
		if (!priorityAllows(watcher.priority, tier, event.country)) continue;

		const id = await insertNotification(db, {
			subscriber_id: subscriberId,
			tour_id: event.tour_id,
			event_id: event.id,
			trigger: 'material_change',
			notified_hash: event.content_hash,
		});
		created.push(makeRow(id, subscriberId, event.tour_id, event.id, 'material_change', event.content_hash));
	}
	return created;
}

async function notifyOnsaleSoon(db: D1Database, fromIso: string, toIso: string): Promise<NotificationRow[]> {
	const events = await getEventsOnsaleBetween(db, fromIso, toIso);
	const created: NotificationRow[] = [];

	for (const event of events) {
		if (event.status !== 'active' || event.tour_id === null || event.onsale_at === null) continue;

		const watchers = await getWatchlistForArtist(db, event.artist_id);
		if (watchers.length === 0) continue;
		const priorNotifs = await getNotificationsForEvent(db, event.id);

		for (const watcher of watchers) {
			const alreadySent = priorNotifs.some(
				(n) => n.subscriber_id === watcher.subscriber_id && n.trigger === 'onsale_soon' && n.notified_hash === event.onsale_at,
			);
			if (alreadySent) continue;

			const tier = event.city_key ? await bestTierForCity(db, event.city_key) : null;
			if (!priorityAllows(watcher.priority, tier, event.country)) continue;

			const id = await insertNotification(db, {
				subscriber_id: watcher.subscriber_id,
				tour_id: event.tour_id,
				event_id: event.id,
				trigger: 'onsale_soon',
				notified_hash: event.onsale_at,
			});
			created.push(makeRow(id, watcher.subscriber_id, event.tour_id, event.id, 'onsale_soon', event.onsale_at));
		}
	}
	return created;
}

function makeRow(
	id: number,
	subscriber_id: number,
	tour_id: number,
	event_id: number | null,
	trigger: NotificationTrigger,
	notified_hash: string | null,
): NotificationRow {
	return { id, subscriber_id, tour_id, event_id, trigger, notified_hash, sent_at: null, created_at: new Date().toISOString() };
}

/** Runs all four triggers (§9.2) for one poll pass and writes the resulting `notifications` rows. */
export async function runNotificationPass(input: NotifyRunInput): Promise<NotificationRow[]> {
	const { db } = input;
	const created: NotificationRow[] = [];

	for (const outcome of input.clusterOutcomes) {
		created.push(...(await notifyForClusterOutcome(db, outcome)));
	}
	for (const eventId of input.changedEventIds) {
		created.push(...(await notifyForMaterialChange(db, eventId)));
	}
	const windowEnd = new Date(new Date(input.now).getTime() + ONSALE_SOON_WINDOW_MS).toISOString();
	created.push(...(await notifyOnsaleSoon(db, input.now, windowEnd)));

	return created;
}
