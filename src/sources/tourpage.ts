/**
 * Tour-page adapter (S2.3). Promoted from a supplementary check to one of the
 * two sources the system actually relies on (DESIGN.md §6.2) — the artist's
 * own published data, in a format explicitly meant to be machine-read
 * (JSON-LD), on their own site.
 *
 * Flow, per DESIGN.md §6.2/§6.4:
 *   1. Fetch `artist.tour_url`.
 *   2. Hash the fetched content; compare against the artist's previously
 *      stored `artists.tour_page_hash`.
 *   3. If unchanged, there is nothing to do.
 *   4. If changed, extract JSON-LD `MusicEvent` blocks from
 *      `<script type="application/ld+json">` tags and emit `RawSourceEvent[]`
 *      — no model call at all, pure parsing.
 *   5. If the page changed but carries no usable `MusicEvent` JSON-LD, this
 *      file must STOP and hand back a "needs a model parse" signal — that
 *      parse itself is a separate, later step (S3.x/S6.4) and must not be
 *      done here.
 *
 * Interface note (why this isn't a plain `SourceAdapter`). `SourceAdapter`
 * (src/sources/types.ts) is `fetchEvents(artist) => Promise<RawSourceEvent[]>`
 * — it has no way to receive the artist's *previous* `tour_page_hash`, and no
 * way to express "unchanged" or "needs a model parse" as anything other than
 * an empty array, which would be indistinguishable from "checked, found
 * nothing new." Both distinctions matter to this file's caller (S3.2): it
 * must not re-store a hash that didn't change, and it must be able to queue
 * "needs model parse" artists for a different, later pass. So this file
 * exports a purpose-built `checkTourPage()` with an explicit discriminated
 * union return type (`TourPageCheckResult`) instead of implementing
 * `SourceAdapter` directly. It still fits the spirit of the interface
 * (fetch one artist's events from one source) closely enough that adapting it
 * to `SourceAdapter` later, if a caller wants that shape too, is a thin
 * wrapper around `checkTourPage()` — not a rewrite.
 */

import { recordSourceFailure, recordSourceSuccess } from '../db/queries';
import type { EventStatus } from '../db/schema';
import type { RawSourceEvent, SourceArtistRef } from './types';

/** What `checkTourPage` needs beyond the common `SourceArtistRef` shape. */
export type TourPageArtistRef = SourceArtistRef & { tour_url: string };

/**
 * Result of checking one artist's tour page. Exactly one of these shapes:
 * - `unchanged` — fetched fine, hash matches what was stored; nothing to do.
 * - `events` — content changed and usable `MusicEvent` JSON-LD was found and
 *   mapped (`skipped` counts JSON-LD `MusicEvent` nodes found but not usable,
 *   e.g. missing a start date — see `mapMusicEventsToRawEvents`).
 * - `needs_model_parse` — content changed but no usable `MusicEvent` JSON-LD
 *   was found at all. Carries the page's HTML so the later model-parse step
 *   doesn't have to re-fetch it, and the fresh `hash` so the caller can still
 *   mark the page as "seen" even though no events came out of this pass.
 * - `fetch_failed` — the page couldn't be fetched (network error or non-2xx
 *   status). No `hash` — nothing meaningful to compare or store. Already
 *   recorded to `source_health` by the time this is returned.
 *
 * In every case except `fetch_failed`, the caller is expected to persist the
 * returned `hash` to `artists.tour_page_hash` — that's what makes the next
 * poll's "unchanged" comparison work.
 */
export type TourPageCheckResult =
	| { status: 'unchanged'; hash: string }
	| { status: 'events'; hash: string; events: RawSourceEvent[]; skipped: number }
	| { status: 'needs_model_parse'; hash: string; html: string }
	| { status: 'fetch_failed'; error: string };

const DEFAULT_USER_AGENT = 'concert-watch/0.1 (+https://raresp.net; tour-page monitor)';

/**
 * Fetch `artist.tour_url`, hash it, compare against `previousHash`, and
 * either report "unchanged", parse JSON-LD `MusicEvent` data into
 * `RawSourceEvent[]`, or signal that a model parse is needed. Records
 * success/failure to `source_health` under the `'tourpage'` source name.
 *
 * `fetchImpl`/`now` are injected (defaulting to the real `fetch`/current
 * time) purely for testability — no behavioural significance beyond that.
 */
export async function checkTourPage(
	db: D1Database,
	artist: TourPageArtistRef,
	previousHash: string | null,
	opts?: { fetchImpl?: typeof fetch; now?: () => string },
): Promise<TourPageCheckResult> {
	const fetchImpl = opts?.fetchImpl ?? fetch;
	const now = opts?.now ?? (() => new Date().toISOString());

	let html: string;
	try {
		const response = await fetchImpl(artist.tour_url, {
			headers: { 'User-Agent': DEFAULT_USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} ${response.statusText}`);
		}
		html = await response.text();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await recordSourceFailure(db, 'tourpage', `${artist.name}: ${message}`);
		return { status: 'fetch_failed', error: message };
	}

	const hash = await hashTourPageContent(html);
	await recordSourceSuccess(db, 'tourpage', now());

	if (previousHash !== null && previousHash === hash) {
		return { status: 'unchanged', hash };
	}

	const blocks = extractJsonLdScripts(html);
	const musicEvents = parseMusicEventsFromJsonLd(blocks);

	if (musicEvents.length === 0) {
		return { status: 'needs_model_parse', hash, html };
	}

	const { events, skipped } = await mapMusicEventsToRawEvents(musicEvents);
	return { status: 'events', hash, events, skipped };
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * sha1 of the raw fetched HTML, via Web Crypto (see normalise.ts for the
 * same reasoning: no `nodejs_compat` flag in wrangler.jsonc, so `node:crypto`
 * is not available at runtime). Not exported from normalise.ts, so this is a
 * small, deliberate duplicate rather than a cross-file dependency for one
 * three-line function.
 */
export async function hashTourPageContent(html: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(html));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// JSON-LD extraction
// ---------------------------------------------------------------------------

// Deliberately a regex over the raw HTML text rather than an HTML parser.
// Cloudflare Workers does provide `HTMLRewriter`, which would be the more
// "correct" tool for pulling `<script>` tag contents out of HTML — but it
// only exists inside the workerd runtime, which means any code written
// against it can only be exercised via `wrangler dev`/Miniflare, not a plain
// Node/tsx harness. Since this step's own done-when is "fetch three real
// band sites and verify the parser against them," being able to run that
// verification with `fetch` + this file's exported functions directly in
// Node (no workerd needed) was worth more than the marginal robustness
// HTMLRewriter would add over a well-anchored `<script type="application/
// ld+json">...</script>` regex. `<script>` bodies practically never contain
// a literal `</script>` (browsers don't handle that either without escaping
// it), so the non-greedy match is safe in practice.
const JSON_LD_SCRIPT_RE = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;

/** Pulls the raw text content of every `<script type="application/ld+json">` tag. */
export function extractJsonLdScripts(html: string): string[] {
	const blocks: string[] = [];
	for (const match of html.matchAll(JSON_LD_SCRIPT_RE)) {
		const raw = match[1];
		if (raw && raw.trim()) blocks.push(raw);
	}
	return blocks;
}

/**
 * Parses each JSON-LD block and pulls out every `MusicEvent` node found
 * anywhere inside it — handling, per the plan:
 * - a bare `MusicEvent` object,
 * - an array of `MusicEvent` objects,
 * - a `@graph` wrapper (`{ "@graph": [...] }`),
 * - `EventSeries` (nests individual dates under `subEvent`).
 *
 * Real-world pages are messier than that list, so after parsing each block
 * this walks the *entire* resulting JSON tree (not just the four known
 * shapes above) looking for any object whose `@type` includes `MusicEvent`,
 * bounded to a shallow depth to keep this cheap. That catches JSON-LD
 * embedded one level deeper than expected (e.g. an `ItemList` of events, or a
 * site that wraps everything in its own top-level object) without needing a
 * new case for every shape encountered in the wild.
 *
 * Malformed blocks (invalid JSON even after a couple of common real-world
 * fixups) are skipped, not fatal — one bad `<script>` tag on a page must not
 * take down every other block on it.
 */
export function parseMusicEventsFromJsonLd(blocks: string[]): Record<string, unknown>[] {
	const found: Record<string, unknown>[] = [];
	for (const block of blocks) {
		const parsed = parseJsonLdBlock(block);
		if (parsed === undefined) continue;
		collectMusicEvents(parsed, found, 0);
	}
	return found;
}

function parseJsonLdBlock(raw: string): unknown {
	let text = raw.trim();
	// Strip an HTML comment wrapper or CDATA section some sites use, e.g.
	// <script type="application/ld+json"><!-- {...} --></script>.
	text = text.replace(/^<!--/, '').replace(/-->$/, '');
	text = text.replace(/^\/\*\s*<!\[CDATA\[\s*\*\//, '').replace(/\/\*\s*\]\]>\s*\*\/$/, '');
	text = text.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
	text = text.trim();
	if (!text) return undefined;

	try {
		return JSON.parse(text);
	} catch {
		// Fall through to a couple of narrow, common real-world fixups.
	}

	// Trailing commas before a closing ] or } (some CMS templates emit these).
	const noTrailingCommas = text.replace(/,(\s*[}\]])/g, '$1');
	// HTML-entity-encoded quotes/ampersands leaking into a supposedly-raw
	// JSON block (seen on a couple of WordPress event plugins).
	const entityDecoded = noTrailingCommas
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>');
	try {
		return JSON.parse(entityDecoded);
	} catch {
		return undefined;
	}
}

function normaliseTypes(type: unknown): string[] {
	if (typeof type === 'string') return [type];
	if (Array.isArray(type)) return type.filter((t): t is string => typeof t === 'string');
	return [];
}

function collectMusicEvents(node: unknown, out: Record<string, unknown>[], depth: number): void {
	if (depth > 6 || node === null || node === undefined) return;
	if (Array.isArray(node)) {
		for (const item of node) collectMusicEvents(item, out, depth + 1);
		return;
	}
	if (typeof node !== 'object') return;

	const obj = node as Record<string, unknown>;
	const types = normaliseTypes(obj['@type']);
	if (types.includes('MusicEvent')) {
		out.push(obj);
	}
	// Keep walking regardless — a MusicEvent can itself sit inside another
	// MusicEvent-typed wrapper in the wild, and EventSeries/@graph/ItemList
	// wrappers need their children visited even though the wrapper itself
	// didn't match.
	for (const value of Object.values(obj)) {
		if (value && typeof value === 'object') collectMusicEvents(value, out, depth + 1);
	}
}

// ---------------------------------------------------------------------------
// MusicEvent -> RawSourceEvent mapping
// ---------------------------------------------------------------------------

/**
 * ISO 3166-1 alpha-2 lookup for the country names `location.address.
 * addressCountry` is observed to carry in the wild — schema.org allows either
 * a bare string or a `Country` object there, and in practice sites put
 * anything from a full English country name to an already-ISO2 code in it.
 * `mapCountryToIso2` below handles both: a 2-letter input is accepted as-is
 * (uppercased); anything else is looked up here case-insensitively. This
 * table covers the touring markets DESIGN.md §6.2 calls out (UK/DE/NL/
 * Nordics/ES/IE) plus the rest of Western/Central Europe and the other
 * countries most likely for a touring band's home/other markets (US, CA,
 * AU). It is **not** exhaustive — an unmapped country name (e.g. a
 * transliteration this table didn't anticipate) causes that one event to be
 * skipped (counted in `skipped`), not the whole page to fail. Extend this
 * table as real skips turn up rather than guessing every possible spelling
 * up front.
 */
const COUNTRY_NAME_TO_ISO2: Record<string, string> = {
	'united kingdom': 'GB',
	'great britain': 'GB',
	uk: 'GB', // not actually valid ISO2 (GB is), but common in the wild — see mapCountryToIso2
	england: 'GB',
	scotland: 'GB',
	wales: 'GB',
	'northern ireland': 'GB',
	germany: 'DE',
	deutschland: 'DE',
	netherlands: 'NL',
	'the netherlands': 'NL',
	holland: 'NL',
	ireland: 'IE',
	'republic of ireland': 'IE',
	spain: 'ES',
	españa: 'ES',
	france: 'FR',
	italy: 'IT',
	italia: 'IT',
	belgium: 'BE',
	belgië: 'BE',
	belgique: 'BE',
	austria: 'AT',
	österreich: 'AT',
	switzerland: 'CH',
	suisse: 'CH',
	schweiz: 'CH',
	portugal: 'PT',
	poland: 'PL',
	polska: 'PL',
	'czech republic': 'CZ',
	czechia: 'CZ',
	romania: 'RO',
	românia: 'RO',
	hungary: 'HU',
	magyarország: 'HU',
	sweden: 'SE',
	sverige: 'SE',
	norway: 'NO',
	norge: 'NO',
	denmark: 'DK',
	danmark: 'DK',
	finland: 'FI',
	suomi: 'FI',
	iceland: 'IS',
	greece: 'GR',
	croatia: 'HR',
	slovenia: 'SI',
	slovakia: 'SK',
	serbia: 'RS',
	bulgaria: 'BG',
	luxembourg: 'LU',
	'united states': 'US',
	'united states of america': 'US',
	usa: 'US',
	us: 'US',
	canada: 'CA',
	australia: 'AU',
	'new zealand': 'NZ',
	japan: 'JP',
	mexico: 'MX',
	brazil: 'BR',
};

/**
 * The name-table lookup is tried *before* the "already 2 letters" passthrough
 * on purpose: real-world `addressCountry` values that happen to be exactly
 * two letters are not reliably valid ISO2 already — a real tour page hit
 * during this step's verification used `"UK"` (not the correct `"GB"`) as
 * its `addressCountry`. Table hits (including such aliases) win; only a
 * genuinely unrecognised 2-letter string falls through to being trusted
 * as-is.
 */
function mapCountryToIso2(raw: string): string | null {
	const trimmed = raw.trim();
	const byName = COUNTRY_NAME_TO_ISO2[trimmed.toLowerCase()];
	if (byName) return byName;
	if (/^[a-zA-Z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
	return null;
}

function eventStatusFromSchema(raw: unknown): EventStatus {
	if (typeof raw !== 'string') return 'active';
	if (/Cancelled/i.test(raw)) return 'cancelled';
	if (/Postponed/i.test(raw)) return 'postponed';
	// EventScheduled, EventRescheduled, EventMovedOnline, or anything unknown
	// all read as "still happening, per the latest date on the record."
	return 'active';
}

function firstOf<T>(value: T | T[] | undefined | null): T | undefined {
	if (value === undefined || value === null) return undefined;
	return Array.isArray(value) ? value[0] : value;
}

function toNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return null;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

interface MappedLocation {
	city: string;
	country: string;
	venue_name: string | null;
	lat: number | null;
	lon: number | null;
}

/**
 * Extracts city/country/venue/coords from a `MusicEvent.location` (a
 * `Place`). Returns `null` if unusable (e.g. a bare venue-name string with
 * no address information anywhere).
 *
 * `location.address` is spec'd as a `PostalAddress` object
 * (`addressLocality`/`addressCountry`), but real sites — confirmed against
 * an official band site's own JSON-LD during this step's verification, not
 * hypothesised — instead emit a bare string like `"London, United Kingdom"`
 * or `"Brooklyn, United States"` (seemingly whatever their venue-picker
 * widget's display label was, verbatim). `parseAddressString` below handles
 * that shape: last comma-separated segment is the country, the one before
 * it is the city. This is a heuristic, not a spec, so an address string with
 * an unexpected shape (no comma, or ordered differently) fails closed —
 * `mapLocation` returns `null` and that event is skipped, not guessed at.
 */
function mapLocation(rawLocation: unknown): MappedLocation | null {
	const place = firstOf(rawLocation as any) as Record<string, unknown> | string | undefined;
	if (!place || typeof place === 'string') return null; // a bare venue-name string carries no city/country

	const address = firstOf(place.address as any) as Record<string, unknown> | string | undefined;
	let city: string | undefined;
	let countryRaw: string | undefined;
	if (typeof address === 'string') {
		const parsed = parseAddressString(address);
		city = parsed?.city;
		countryRaw = parsed?.countryRaw;
	} else if (address) {
		city = asString(address.addressLocality);
		countryRaw = asString(address.addressCountry) ?? asString((address.addressCountry as any)?.name);
	}
	if (!city || !countryRaw) return null;

	const country = mapCountryToIso2(countryRaw);
	if (!country) return null;

	const geo = firstOf(place.geo as any) as Record<string, unknown> | undefined;
	return {
		city,
		country,
		venue_name: asString(place.name) ?? null,
		lat: geo ? toNumber(geo.latitude) : null,
		lon: geo ? toNumber(geo.longitude) : null,
	};
}

/** `"London, United Kingdom"` -> `{ city: "London", countryRaw: "United Kingdom" }`. Last segment is the country, the one before it is the city; anything further left (e.g. a venue name folded into the same string) is ignored. */
function parseAddressString(address: string): { city: string; countryRaw: string } | undefined {
	const parts = address
		.split(',')
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	if (parts.length < 2) return undefined;
	return { city: parts[parts.length - 2], countryRaw: parts[parts.length - 1] };
}

interface MappedOffer {
	ticket_url: string | null;
	onsale_at: string | null;
	presale_at: string | null;
}

function mapOffers(rawOffers: unknown): MappedOffer {
	const offer = firstOf(rawOffers as any) as Record<string, unknown> | undefined;
	if (!offer) return { ticket_url: null, onsale_at: null, presale_at: null };
	return {
		ticket_url: asString(offer.url) ?? null,
		onsale_at: asString(offer.availabilityStarts) ?? asString(offer.validFrom) ?? null,
		presale_at: null, // schema.org has no standard presale field; left null, matching S2.1's own honesty about what it can't get
	};
}

/**
 * Maps parsed `MusicEvent` JSON-LD nodes to `RawSourceEvent[]`. Each node is
 * handled independently and defensively — a missing `startDate` or an
 * unusable `location` skips that one event (counted in the returned
 * `skipped` total) rather than failing the whole page.
 */
export async function mapMusicEventsToRawEvents(
	musicEvents: Record<string, unknown>[],
): Promise<{ events: RawSourceEvent[]; skipped: number }> {
	const events: RawSourceEvent[] = [];
	let skipped = 0;

	for (const raw of musicEvents) {
		const startsAt = asString(raw.startDate);
		if (!startsAt) {
			skipped++;
			continue;
		}
		const location = mapLocation(raw.location);
		if (!location) {
			skipped++;
			continue;
		}
		const offers = mapOffers(raw.offers);
		const sourceEventId =
			asString(raw['@id']) ??
			offers.ticket_url ??
			asString(raw.url) ??
			(await hashTourPageContent(`${startsAt}|${location.city}|${location.venue_name ?? ''}|${asString(raw.name) ?? ''}`));

		events.push({
			source: 'tourpage',
			source_event_id: sourceEventId,
			starts_at: startsAt,
			timezone: null, // schema.org MusicEvent carries no explicit timezone field
			city: location.city,
			country: location.country,
			venue_name: location.venue_name,
			lat: location.lat,
			lon: location.lon,
			onsale_at: offers.onsale_at,
			presale_at: offers.presale_at,
			ticket_url: offers.ticket_url,
			status: eventStatusFromSchema(raw.eventStatus),
			image_url: asString(firstOf(raw.image as any) as any) ?? null,
		});
	}

	return { events, skipped };
}
