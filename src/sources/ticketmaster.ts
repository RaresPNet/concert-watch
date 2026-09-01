/**
 * Ticketmaster Discovery API v2 adapter (DESIGN.md §6.2, IMPLEMENTATION_PLAN.md
 * S2.1). The backbone source: free key, 5000 calls/day, 5 req/s, strong
 * coverage of the UK/DE/NL/Nordics/ES/IE. Does not operate in Romania or
 * Hungary (context only — nothing here special-cases it).
 *
 * API shape verified against developer.ticketmaster.com/products-and-docs/apis/
 * discovery-api/v2/ (fetched 2026-09-01), not assumed from training data:
 * - Attraction search: GET /discovery/v2/attractions.json?keyword=&classificationName=
 *   -> `_embedded.attractions[]` ({ id, name, images[], classifications[] }).
 * - Event search: GET /discovery/v2/events.json?attractionId=&classificationName=
 *   -> `_embedded.events[]`, pagination via `page.{number,totalPages,size,totalElements}`.
 * - Event shape: `dates.start.{localDate,dateTime}`, `dates.timezone`,
 *   `dates.status.code`, `sales.public.{startDateTime,endDateTime}`,
 *   `sales.presales[].{name,startDateTime,endDateTime}`, `images[]`, `url`,
 *   `_embedded.venues[].{name,city.name,country.countryCode,location.{latitude,longitude}}`.
 *   `country.countryCode` is already ISO 3166-1 alpha-2 — no mapping needed.
 * - Auth: `apikey` query parameter (not a header).
 * - Rate limiting: `Rate-Limit`/`Rate-Limit-Available`/`Rate-Limit-Reset`/
 *   `Rate-Limit-Over` response headers; a 429/quota-exceeded body is an Apigee
 *   "fault" envelope (`{ fault: { faultstring, detail: { errorcode } } }`),
 *   not documented in full on the page fetched — treated generically here as
 *   any non-2xx response.
 */

import { recordSourceFailure, recordSourceSuccess } from '../db/queries';
import type { RawSourceEvent, SourceAdapter, SourceArtistRef } from './types';
import type { EventStatus } from '../db/schema';

const SOURCE = 'ticketmaster' as const;
const API_BASE = 'https://app.ticketmaster.com/discovery/v2';

/** 5 requests/second per DESIGN.md §6.2 — a fixed minimum gap between calls. */
const MIN_REQUEST_INTERVAL_MS = 1000 / 5;

/** Ticketmaster caps event search page size at 200. */
const EVENTS_PAGE_SIZE = 200;

/** Safety bound on pagination — well above any real single-artist result count. */
const MAX_EVENT_PAGES = 20;

interface TMImage {
	url: string;
	ratio?: string;
	width?: number;
	height?: number;
	fallback?: boolean;
}

interface TMAttraction {
	id: string;
	name: string;
	images?: TMImage[];
}

interface TMAttractionSearchResponse {
	_embedded?: { attractions?: TMAttraction[] };
	page?: { number: number; totalPages: number; size: number; totalElements: number };
}

interface TMVenue {
	name?: string;
	city?: { name?: string };
	country?: { countryCode?: string };
	location?: { latitude?: string; longitude?: string };
}

interface TMSalesWindow {
	startDateTime?: string;
	endDateTime?: string;
}

interface TMPresale extends TMSalesWindow {
	name?: string;
}

interface TMEvent {
	id: string;
	url?: string;
	images?: TMImage[];
	dates?: {
		start?: { localDate?: string; dateTime?: string };
		timezone?: string;
		status?: { code?: string };
	};
	sales?: {
		public?: TMSalesWindow;
		presales?: TMPresale[];
	};
	_embedded?: { venues?: TMVenue[] };
}

interface TMEventSearchResponse {
	_embedded?: { events?: TMEvent[] };
	page?: { number: number; totalPages: number; size: number; totalElements: number };
}

export interface TicketmasterAdapterOptions {
	/** Discovery API key (DESIGN.md §6.2: free tier, 5000 calls/day, 5 req/s). */
	apiKey: string;
	/** D1 binding, used only to record source_health via recordSourceSuccess/Failure. */
	db: D1Database;
	/** Injectable for tests; defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
	/** Injectable sleep for tests; defaults to a real setTimeout-based delay. */
	sleepImpl?: (ms: number) => Promise<void>;
	/** Injectable clock for tests; defaults to Date.now. */
	now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Maps `dates.status.code` to the narrower `EventStatus` the rest of the
 * system understands. Ticketmaster's `onsale`/`offsale`/`rescheduled` all
 * collapse into the defaults documented on `RawSourceEvent.status`
 * ("defaults to 'active'") except the two states that actually matter
 * downstream: cancelled and postponed (rescheduled is treated as postponed —
 * the show didn't happen as originally listed).
 */
function mapStatus(code: string | undefined): EventStatus | undefined {
	switch (code) {
		case 'cancelled':
			return 'cancelled';
		case 'postponed':
		case 'rescheduled':
			return 'postponed';
		default:
			return undefined; // let RawSourceEvent's default ('active') apply
	}
}

/** Picks the presale with the earliest startDateTime, if any. */
function earliestPresaleStart(presales: TMPresale[] | undefined): string | null {
	if (!presales || presales.length === 0) return null;
	const starts = presales.map((p) => p.startDateTime).filter((s): s is string => typeof s === 'string');
	if (starts.length === 0) return null;
	return starts.reduce((earliest, s) => (s < earliest ? s : earliest));
}

/**
 * Picks one representative image from a Ticketmaster `images[]` array.
 * Prefers a non-fallback 16:9 image (Ticketmaster's standard wide crop),
 * falling back to the largest image by width, then to the first entry.
 */
function pickBestImage(images: TMImage[] | undefined): string | null {
	if (!images || images.length === 0) return null;
	const wide = images.find((img) => img.ratio === '16_9' && !img.fallback);
	if (wide) return wide.url;
	const byWidth = [...images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
	return byWidth[0]?.url ?? images[0].url;
}

function parseCoord(value: string | undefined): number | null {
	if (value === undefined) return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

export class TicketmasterAdapter implements SourceAdapter {
	readonly source = SOURCE;

	private readonly apiKey: string;
	private readonly db: D1Database;
	private readonly fetchImpl: typeof fetch;
	private readonly sleepImpl: (ms: number) => Promise<void>;
	private readonly now: () => number;
	private lastRequestAt = 0;

	constructor(options: TicketmasterAdapterOptions) {
		this.apiKey = options.apiKey;
		this.db = options.db;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.sleepImpl = options.sleepImpl ?? defaultSleep;
		this.now = options.now ?? Date.now;
	}

	async fetchEvents(artist: SourceArtistRef): Promise<RawSourceEvent[]> {
		try {
			const attractionId = artist.tm_attraction_id ?? (await this.lookupAttractionId(artist.name));
			if (!attractionId) {
				// No match found is not an upstream failure — it's a legitimate
				// "Ticketmaster doesn't know this artist" result.
				await recordSourceSuccess(this.db, SOURCE, new Date(this.now()).toISOString());
				return [];
			}

			const events = await this.fetchAllEventPages(attractionId);
			const raw = events.map((e) => this.toRawSourceEvent(e)).filter((e): e is RawSourceEvent => e !== null);

			await recordSourceSuccess(this.db, SOURCE, new Date(this.now()).toISOString());
			return raw;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await recordSourceFailure(this.db, SOURCE, message);
			throw err;
		}
	}

	/** Attraction-ID lookup by artist name, used when `tm_attraction_id` is missing. */
	private async lookupAttractionId(name: string): Promise<string | null> {
		const url = new URL(`${API_BASE}/attractions.json`);
		url.searchParams.set('apikey', this.apiKey);
		url.searchParams.set('keyword', name);
		url.searchParams.set('classificationName', 'Music');
		url.searchParams.set('size', '5');

		const body = await this.request<TMAttractionSearchResponse>(url);
		const candidates = body._embedded?.attractions ?? [];
		if (candidates.length === 0) return null;

		const exact = candidates.find((a) => a.name.toLowerCase() === name.toLowerCase());
		return (exact ?? candidates[0]).id;
	}

	/** Fetches every page of events for one attraction, throttled to 5 req/s. */
	private async fetchAllEventPages(attractionId: string): Promise<TMEvent[]> {
		const events: TMEvent[] = [];
		let page = 0;
		let totalPages = 1;

		while (page < totalPages && page < MAX_EVENT_PAGES) {
			const url = new URL(`${API_BASE}/events.json`);
			url.searchParams.set('apikey', this.apiKey);
			url.searchParams.set('attractionId', attractionId);
			url.searchParams.set('classificationName', 'Music');
			url.searchParams.set('size', String(EVENTS_PAGE_SIZE));
			url.searchParams.set('page', String(page));

			const body = await this.request<TMEventSearchResponse>(url);
			events.push(...(body._embedded?.events ?? []));

			totalPages = body.page?.totalPages ?? 1;
			page += 1;
		}

		return events;
	}

	/** Converts one Ticketmaster event into `RawSourceEvent`, or null if unusable. */
	private toRawSourceEvent(event: TMEvent): RawSourceEvent | null {
		const venue = event._embedded?.venues?.[0];
		const city = venue?.city?.name;
		const country = venue?.country?.countryCode;
		const startsAt = event.dates?.start?.dateTime ?? event.dates?.start?.localDate;

		// city/country/starts_at are load-bearing for normalisation (city_key,
		// fingerprint) — an event missing any of them can't be normalised, so
		// it's skipped here rather than passed downstream to fail there.
		if (!city || !country || !startsAt) return null;

		const status = mapStatus(event.dates?.status?.code);

		return {
			source: SOURCE,
			source_event_id: event.id,
			starts_at: startsAt,
			timezone: event.dates?.timezone ?? null,
			city,
			country,
			venue_name: venue?.name ?? null,
			lat: parseCoord(venue?.location?.latitude),
			lon: parseCoord(venue?.location?.longitude),
			onsale_at: event.sales?.public?.startDateTime ?? null,
			presale_at: earliestPresaleStart(event.sales?.presales),
			ticket_url: event.url ?? null,
			...(status !== undefined ? { status } : {}),
			image_url: pickBestImage(event.images),
		};
	}

	/** Throttles to at most 5 requests/second, then performs one GET, parsed as JSON. */
	private async request<T>(url: URL): Promise<T> {
		await this.throttle();

		const res = await this.fetchImpl(url.toString());
		if (!res.ok) {
			const bodyText = await res.text().catch(() => '');
			throw new Error(`Ticketmaster Discovery API ${res.status} ${res.statusText} for ${url.pathname}: ${bodyText.slice(0, 500)}`);
		}

		return (await res.json()) as T;
	}

	private async throttle(): Promise<void> {
		const elapsed = this.now() - this.lastRequestAt;
		if (elapsed < MIN_REQUEST_INTERVAL_MS) {
			await this.sleepImpl(MIN_REQUEST_INTERVAL_MS - elapsed);
		}
		this.lastRequestAt = this.now();
	}
}
