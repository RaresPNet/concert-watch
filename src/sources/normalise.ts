/**
 * Turns a `RawSourceEvent` from any adapter into one `events` row shape,
 * via the city-key normalisation and fingerprint computation DESIGN.md §4
 * calls "the single most important function in the codebase": the same
 * show, reported by Ticketmaster, a tour page, and Bandsintown, must
 * collapse to one fingerprint.
 *
 * No DB access here — this is a pure function layer. Callers (S3.2) own
 * persistence.
 */

import type { EventStatus } from '../db/schema';
import type { NormalisedEvent, RawSourceEvent } from './types';

/**
 * `sha1(mbid | date | normalised_city)` per DESIGN.md §4. `date` is the
 * YYYY-MM-DD prefix of `starts_at` — deliberately not the full timestamp,
 * so the same date reported with a slightly different time-of-day by two
 * sources still collapses to one fingerprint.
 */
export async function computeFingerprint(mbid: string, startsAt: string, cityKey: string): Promise<string> {
	const date = extractDate(startsAt);
	return sha1Hex(`${mbid}|${date}|${cityKey}`);
}

/**
 * Covers material fields only, per DESIGN.md §4: date, venue, status,
 * on-sale. Anything else changing (e.g. a re-fetched lat/lon) must not
 * register as a change worth notifying about.
 */
export async function computeContentHash(input: {
	starts_at: string;
	venue_name: string | null;
	status: EventStatus;
	onsale_at: string | null;
}): Promise<string> {
	const date = extractDate(input.starts_at);
	return sha1Hex([date, input.venue_name ?? '', input.status, input.onsale_at ?? ''].join('|'));
}

/**
 * Deterministic `city_key`, matching the `iso2:snake_case_ascii_name`
 * convention `scripts/seed-reach.ts` (S1.2) already established for
 * `reachability`/`origins` (e.g. "gb:leeds", "ro:targu_mures") — the join
 * in S3.4 depends on both sides agreeing on this scheme.
 */
export function normaliseCityKey(city: string, countryCode: string): string {
	const cc = countryCode.trim().toLowerCase();
	if (!/^[a-z]{2}$/.test(cc)) {
		throw new Error(`normaliseCityKey: expected a 2-letter ISO country code, got "${countryCode}"`);
	}
	const slug = asciiSlug(city);
	if (!slug) {
		throw new Error(`normaliseCityKey: city "${city}" normalised to an empty slug`);
	}
	return `${cc}:${slug}`;
}

export type NormaliseResult = { ok: true; event: NormalisedEvent } | { ok: false; reason: 'missing_mbid'; raw: RawSourceEvent };

/**
 * Events without an MBID are quarantined, not dropped (DESIGN.md §4) — the
 * artist's MBID is what the fingerprint is keyed on, so without one the
 * event can't be reliably deduplicated against the same show from another
 * source. Callers are expected to hold quarantined raw events aside (e.g.
 * for a later resolution pass) rather than discard them.
 */
export async function normaliseEvent(raw: RawSourceEvent, artist: { id: number; mbid: string | null }): Promise<NormaliseResult> {
	if (!artist.mbid) {
		return { ok: false, reason: 'missing_mbid', raw };
	}

	const cityKey = normaliseCityKey(raw.city, raw.country);
	const status: EventStatus = raw.status ?? 'active';
	const [fingerprint, content_hash] = await Promise.all([
		computeFingerprint(artist.mbid, raw.starts_at, cityKey),
		computeContentHash({
			starts_at: raw.starts_at,
			venue_name: raw.venue_name ?? null,
			status,
			onsale_at: raw.onsale_at ?? null,
		}),
	]);

	return {
		ok: true,
		event: {
			fingerprint,
			artist_id: artist.id,
			starts_at: raw.starts_at,
			timezone: raw.timezone ?? null,
			city: raw.city,
			country: raw.country,
			city_key: cityKey,
			venue_name: raw.venue_name ?? null,
			lat: raw.lat ?? null,
			lon: raw.lon ?? null,
			onsale_at: raw.onsale_at ?? null,
			presale_at: raw.presale_at ?? null,
			ticket_url: raw.ticket_url ?? null,
			status,
			source: raw.source,
			source_event_id: raw.source_event_id,
			content_hash,
		},
	};
}

function extractDate(startsAt: string): string {
	const match = /^\d{4}-\d{2}-\d{2}/.exec(startsAt);
	if (!match) throw new Error(`extractDate: "${startsAt}" is not an ISO date/date-time string`);
	return match[0];
}

const COMBINING_DIACRITICS = /[̀-ͯ]/g;

function asciiSlug(value: string): string {
	return value
		.normalize('NFD')
		.replace(COMBINING_DIACRITICS, '') // ș/ț/ă → s/t/a, etc.
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
}

async function sha1Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
