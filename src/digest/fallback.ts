/**
 * Fallback digest and 30-day heartbeat (IMPLEMENTATION_PLAN.md S4.8,
 * DESIGN.md §10.3). This is what makes the app-quota split (§3) safe: the
 * scheduled Claude task composes the *good* digest, but if it doesn't fire —
 * quota exhausted, task deleted, a bad day — this file guarantees delivery
 * anyway, straight from D1, with no model call anywhere in it.
 *
 * Two independent checks, meant to be called daily from the cron handler
 * (S5.1, not built yet):
 *
 * - `runFallbackDigestCheck` — any notification pending (`sent_at IS NULL`)
 *   for more than 36 hours gets a plain, model-free digest sent immediately,
 *   covering *all* of that subscriber's pending notifications (not just the
 *   overdue ones) so the email carries the same information a normal digest
 *   would have. `sent_at` is only set after the send succeeds (§9.3 — "the
 *   single most important ordering constraint in the system," per S3.3's own
 *   PROGRESS.md entry): a failed send must not cost the subscriber the
 *   announcement.
 * - `runHeartbeatCheck` — if nothing has been sent to a subscriber for 30
 *   days (and no heartbeat has covered that silence already), send a short
 *   still-alive note: bands watched, source health, spend to date.
 *
 * Both reuse S4.1's `buildDigestPayload` for data assembly and S1.3's
 * `Mailer` interface for sending. Deliberately does NOT reuse S4.2's
 * `render.ts` — that file always prints rotating contextual-invitation copy
 * and a rotating footer, which §10.3 explicitly says the plain version must
 * not have ("no prose, no contextual invitations"). Forcing a "plain mode"
 * flag into `render.ts` (out of this step's touch list, and a much more
 * elaborate file) seemed like the wrong shape for something this step needs
 * to be deliberately, verifiably dumber than. So this file carries its own,
 * much smaller, plain-text/minimal-HTML rendering, independent of
 * `render.ts`'s copy-rotation machinery.
 *
 * Timestamp format note: `created_at`/the SQLite `datetime('now')` default
 * used throughout `migrations/0001_init_schema.sql` produces
 * `"YYYY-MM-DD HH:MM:SS"` (space-separated, no `T`, no `Z`, no
 * milliseconds) — not `Date#toISOString()`'s format. This file is the first
 * real caller of `markNotificationSent`/`getUnsentNotificationsOlderThan`/
 * `setSubscriberLastHeartbeatAt` with real timestamps (S4.1 only read;
 * nothing wrote `sent_at` before this), so it establishes the convention:
 * every timestamp this file writes or compares against `created_at`/
 * `sent_at`/`last_heartbeat_at` is formatted via `toSqliteUtc` below, to
 * match D1's own default format exactly and keep lexicographic string
 * comparison equivalent to chronological comparison throughout.
 */

import {
	getAllSourceHealth,
	getAllSubscribers,
	getLastSentAtForSubscriber,
	getSubscriberById,
	getTotalSpend,
	getUnsentNotificationsOlderThan,
	getWatchlistForSubscriber,
	markNotificationSent,
	setSubscriberLastHeartbeatAt,
} from '../db/queries';
import type { SourceHealthRow, SubscriberRow } from '../db/schema';
import type { Mailer } from '../mail/mailer';
import { buildDigestPayload } from './payload';
import type { DigestEventSummary, DigestPayload, DigestTourBlock } from './payload.types';

const FALLBACK_THRESHOLD_MS = 36 * 60 * 60 * 1000;
const HEARTBEAT_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

/** Formats a `Date` as D1's own `datetime('now')` default shape (UTC, space-separated, no fractional seconds) — see the file header note on why. */
function toSqliteUtc(date: Date): string {
	return date.toISOString().slice(0, 19).replace('T', ' ');
}

// ---------------------------------------------------------------------------
// Plain rendering — deliberately not render.ts. No rotating copy, no
// contextual invitations, one line at the top marking it as the plain
// version (§10.3's hard requirement).
// ---------------------------------------------------------------------------

function escapeHtml(input: string): string {
	return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const PLAIN_VERSION_NOTE =
	"This is the plain version — the styled digest didn't go out in time, so here are the plain facts instead of waiting any longer.";

function renderPlainEventText(ev: DigestEventSummary): string {
	const place = [ev.venue_name, ev.city, ev.country].filter((p): p is string => !!p).join(', ');
	const lines = [`  - ${ev.starts_at ?? 'date TBC'}${place ? ` -- ${place}` : ''}${ev.tier ? ` [tier ${ev.tier}]` : ''}`];
	if (ev.tier && ev.route_note) lines.push(`    ${ev.route_note}`);
	if (ev.onsale_at) lines.push(`    On sale ${ev.onsale_at}`);
	if (ev.ticket_url) lines.push(`    Tickets: ${ev.ticket_url}`);
	return lines.join('\n');
}

function renderPlainTourText(tour: DigestTourBlock): string {
	const lines: string[] = [];
	const handleSuffix = tour.handle ? ` (${tour.handle})` : '';
	lines.push(`${tour.artist_name}${handleSuffix}`);
	if (tour.label) lines.push(tour.label);
	const range = [tour.first_date, tour.last_date && tour.last_date !== tour.first_date ? tour.last_date : null]
		.filter((p): p is string => !!p)
		.join(' to ');
	lines.push(`${tour.date_count} date${tour.date_count === 1 ? '' : 's'}${range ? `, ${range}` : ''}`);
	if (tour.official_url) lines.push(`Tour page: ${tour.official_url}`);
	if (tour.more_dates_expected) lines.push('More dates for this tour may be announced.');
	lines.push(...tour.top_dates.map(renderPlainEventText));
	return lines.join('\n');
}

/** Plain-text body: the whole point of this file, so kept as the primary rendering; HTML below just wraps the same lines. */
export function renderFallbackDigestText(payload: DigestPayload): string {
	const greeting = payload.display_name ? `Hi ${payload.display_name},` : 'Hi,';
	const body = payload.tours.length > 0 ? payload.tours.map(renderPlainTourText).join('\n\n') : 'Nothing pending.';
	return [PLAIN_VERSION_NOTE, '', greeting, '', body].join('\n');
}

function renderPlainEventHtml(ev: DigestEventSummary): string {
	const place = [ev.venue_name, ev.city, ev.country].filter((p): p is string => !!p).join(', ');
	const parts = [`${escapeHtml(ev.starts_at ?? 'date TBC')}`];
	if (place) parts.push(escapeHtml(place));
	if (ev.tier) parts.push(`[tier ${ev.tier}]`);
	let line = `<div>- ${parts.join(' -- ')}</div>`;
	if (ev.tier && ev.route_note) line += `<div style="padding-left:12px;">${escapeHtml(ev.route_note)}</div>`;
	if (ev.onsale_at) line += `<div style="padding-left:12px;">On sale ${escapeHtml(ev.onsale_at)}</div>`;
	if (ev.ticket_url)
		line += `<div style="padding-left:12px;">Tickets: <a href="${escapeHtml(ev.ticket_url)}">${escapeHtml(ev.ticket_url)}</a></div>`;
	return line;
}

function renderPlainTourHtml(tour: DigestTourBlock): string {
	const handleSuffix = tour.handle ? ` (${escapeHtml(tour.handle)})` : '';
	const range = [tour.first_date, tour.last_date && tour.last_date !== tour.first_date ? tour.last_date : null]
		.filter((p): p is string => !!p)
		.join(' to ');
	const parts: string[] = [];
	parts.push(`<tr><td style="font-weight:bold;padding-top:12px;">${escapeHtml(tour.artist_name)}${handleSuffix}</td></tr>`);
	if (tour.label) parts.push(`<tr><td>${escapeHtml(tour.label)}</td></tr>`);
	parts.push(`<tr><td>${tour.date_count} date${tour.date_count === 1 ? '' : 's'}${range ? `, ${escapeHtml(range)}` : ''}</td></tr>`);
	if (tour.official_url) {
		parts.push(`<tr><td>Tour page: <a href="${escapeHtml(tour.official_url)}">${escapeHtml(tour.official_url)}</a></td></tr>`);
	}
	if (tour.more_dates_expected) parts.push(`<tr><td>More dates for this tour may be announced.</td></tr>`);
	parts.push(`<tr><td>${tour.top_dates.map(renderPlainEventHtml).join('')}</td></tr>`);
	return parts.join('');
}

/** Minimal HTML body -- tables only (§10.4), no images, no colour, no rotating copy. Same content as the text body. */
export function renderFallbackDigestHtml(payload: DigestPayload): string {
	const greeting = payload.display_name ? `Hi ${escapeHtml(payload.display_name)},` : 'Hi,';
	const body =
		payload.tours.length > 0
			? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${payload.tours.map(renderPlainTourHtml).join('')}</table>`
			: '<div>Nothing pending.</div>';
	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Concert watch -- plain digest</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2328;">
	<div style="font-style:italic;margin-bottom:12px;">${escapeHtml(PLAIN_VERSION_NOTE)}</div>
	<div>${greeting}</div>
	${body}
</body>
</html>`;
}

export interface FallbackDigestResult {
	subscriber_id: number;
	sent: boolean;
	notification_count?: number;
	reason?: string;
}

/** Sends the plain fallback digest for one subscriber who has at least one stale notification, covering every pending notification they have (§10.3: "same information" as the real digest would carry). */
async function sendFallbackDigestForSubscriber(
	db: D1Database,
	mailer: Mailer,
	subscriberId: number,
	now: Date,
): Promise<FallbackDigestResult> {
	const built = await buildDigestPayload(db, subscriberId);
	if (!built.send) {
		// Defensive: we only got here because a stale notification exists for
		// this subscriber, so this should be unreachable in practice.
		return { subscriber_id: subscriberId, sent: false, reason: built.reason };
	}

	const subscriber = await getSubscriberById(db, subscriberId);
	if (!subscriber) return { subscriber_id: subscriberId, sent: false, reason: 'subscriber_not_found' };

	const html = renderFallbackDigestHtml(built.payload);
	const text = renderFallbackDigestText(built.payload);

	try {
		await mailer.send({ to: subscriber.email, subject: 'Concert watch (plain digest)', html, text });
	} catch (err) {
		// §9.3: a failed send must never mark sent_at. Leave every notification
		// pending so the next run (or the next fallback check) tries again.
		return { subscriber_id: subscriberId, sent: false, reason: err instanceof Error ? err.message : String(err) };
	}

	const sentAt = toSqliteUtc(now);
	const notificationIds = built.payload.tours.flatMap((t) => t.notification_ids);
	for (const id of notificationIds) {
		await markNotificationSent(db, id, sentAt);
	}

	return { subscriber_id: subscriberId, sent: true, notification_count: notificationIds.length };
}

/**
 * DESIGN.md §10.3's core guarantee: any notification pending (unsent) for
 * more than 36 hours triggers an immediate plain digest for its subscriber,
 * independent of whether the scheduled MCP task ever ran. No model call
 * anywhere in this function or anything it calls.
 */
export async function runFallbackDigestCheck(db: D1Database, mailer: Mailer, now: Date = new Date()): Promise<FallbackDigestResult[]> {
	const cutoff = toSqliteUtc(new Date(now.getTime() - FALLBACK_THRESHOLD_MS));
	const stale = await getUnsentNotificationsOlderThan(db, cutoff);

	const subscriberIds = [...new Set(stale.map((n) => n.subscriber_id))];
	const results: FallbackDigestResult[] = [];
	for (const subscriberId of subscriberIds) {
		results.push(await sendFallbackDigestForSubscriber(db, mailer, subscriberId, now));
	}
	return results;
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export interface HeartbeatResult {
	subscriber_id: number;
	sent: boolean;
	reason?: string;
}

function summariseSourceHealth(rows: SourceHealthRow[]): string {
	if (rows.length === 0) return 'no sources polled yet';
	const unhealthy = rows.filter((r) => r.consecutive_failures > 0);
	if (unhealthy.length === 0) return `all ${rows.length} source(s) healthy`;
	const names = unhealthy.map((r) => `${r.source} (${r.consecutive_failures} failures)`).join(', ');
	return `${unhealthy.length}/${rows.length} source(s) struggling: ${names}`;
}

interface HeartbeatContent {
	display_name: string | null;
	bandsWatched: number;
	sourceHealthLine: string;
	totalSpend: number;
}

function renderHeartbeatText(input: HeartbeatContent): string {
	const greeting = input.display_name ? `Hi ${input.display_name},` : 'Hi,';
	return [
		greeting,
		'',
		"Still here -- nothing new to send, so here's a status check instead.",
		'',
		`Bands watched: ${input.bandsWatched}`,
		`Sources: ${input.sourceHealthLine}`,
		`Spend to date: $${input.totalSpend.toFixed(2)}`,
	].join('\n');
}

function renderHeartbeatHtml(input: HeartbeatContent): string {
	const greeting = input.display_name ? `Hi ${escapeHtml(input.display_name)},` : 'Hi,';
	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Concert watch -- still here</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2328;">
	<div>${greeting}</div>
	<p>Still here -- nothing new to send, so here's a status check instead.</p>
	<table role="presentation" cellpadding="0" cellspacing="0" border="0">
		<tr><td>Bands watched:</td><td>${input.bandsWatched}</td></tr>
		<tr><td>Sources:</td><td>${escapeHtml(input.sourceHealthLine)}</td></tr>
		<tr><td>Spend to date:</td><td>$${input.totalSpend.toFixed(2)}</td></tr>
	</table>
</body>
</html>`;
}

/**
 * The most recent timestamp we know this subscriber heard from us -- either
 * a delivered notification, a previous heartbeat, or (if neither has ever
 * happened) the subscriber's own `created_at`, so a brand-new subscriber
 * doesn't get an immediate heartbeat on day one.
 */
async function lastContactAt(db: D1Database, subscriber: SubscriberRow): Promise<string> {
	const lastSent = await getLastSentAtForSubscriber(db, subscriber.id);
	const candidates = [lastSent, subscriber.last_heartbeat_at, subscriber.created_at].filter((v): v is string => !!v);
	return candidates.reduce((latest, current) => (current > latest ? current : latest));
}

async function checkHeartbeatForSubscriber(db: D1Database, mailer: Mailer, subscriber: SubscriberRow, now: Date): Promise<HeartbeatResult> {
	const lastContact = await lastContactAt(db, subscriber);
	const silentMs = now.getTime() - new Date(lastContact.replace(' ', 'T') + 'Z').getTime();
	if (silentMs < HEARTBEAT_THRESHOLD_MS) {
		return { subscriber_id: subscriber.id, sent: false, reason: 'not_yet_due' };
	}

	const watchlist = await getWatchlistForSubscriber(db, subscriber.id);
	const sourceHealth = await getAllSourceHealth(db);
	const totalSpend = await getTotalSpend(db);

	const content: HeartbeatContent = {
		display_name: subscriber.display_name,
		bandsWatched: watchlist.length,
		sourceHealthLine: summariseSourceHealth(sourceHealth),
		totalSpend,
	};

	try {
		await mailer.send({
			to: subscriber.email,
			subject: 'Concert watch -- still here',
			html: renderHeartbeatHtml(content),
			text: renderHeartbeatText(content),
		});
	} catch (err) {
		return { subscriber_id: subscriber.id, sent: false, reason: err instanceof Error ? err.message : String(err) };
	}

	await setSubscriberLastHeartbeatAt(db, subscriber.id, toSqliteUtc(now));
	return { subscriber_id: subscriber.id, sent: true };
}

/**
 * DESIGN.md §10.3's heartbeat: if nothing has been sent to a subscriber for
 * 30 days (no delivered notification and no prior heartbeat within that
 * window), send a short still-alive note. Paused subscribers are skipped --
 * they've deliberately silenced the digest, matching S4.1's own precedent
 * for excluding `paused` from `buildAllDigestPayloads`. No model call
 * anywhere in this function or anything it calls.
 */
export async function runHeartbeatCheck(db: D1Database, mailer: Mailer, now: Date = new Date()): Promise<HeartbeatResult[]> {
	const subscribers = await getAllSubscribers(db);
	const results: HeartbeatResult[] = [];
	for (const subscriber of subscribers) {
		if (subscriber.status === 'paused') continue;
		results.push(await checkHeartbeatForSubscriber(db, mailer, subscriber, now));
	}
	return results;
}
