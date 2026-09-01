/**
 * Shared shapes for source adapters (S2.1-S2.4) and the normaliser
 * (normalise.ts) that turns their output into `events` rows. See
 * DESIGN.md §4-§6.
 */

import type { EventStatus } from '../db/schema';

/**
 * Sources that produce event listings directly and implement
 * `SourceAdapter`. MusicBrainz (S2.4) is a name-resolution lookup used by
 * artist resolution (S3.1), not an event source, so it isn't one of these.
 */
export type SourceName = 'ticketmaster' | 'bandsintown' | 'tourpage';

/** The artist context an adapter needs to fetch that artist's events. */
export interface SourceArtistRef {
	artist_id: number;
	mbid: string | null;
	name: string;
	tm_attraction_id?: string | null;
	bit_slug?: string | null;
	tour_url?: string | null;
}

/**
 * One event as an adapter reports it, before normalisation. `country` must
 * be an ISO 3166-1 alpha-2 code (e.g. "GB") — adapters own mapping whatever
 * their upstream API returns into that form, so normalisation itself stays
 * deterministic and source-agnostic.
 */
export interface RawSourceEvent {
	source: SourceName;
	source_event_id: string;
	starts_at: string; // ISO 8601, at least a YYYY-MM-DD prefix
	timezone?: string | null;
	city: string;
	country: string; // ISO 3166-1 alpha-2
	venue_name?: string | null;
	lat?: number | null;
	lon?: number | null;
	onsale_at?: string | null;
	presale_at?: string | null;
	ticket_url?: string | null;
	status?: EventStatus; // defaults to 'active'
	image_url?: string | null;
}

/** Implemented by each of S2.1 (Ticketmaster), S2.2 (Bandsintown), S2.3 (tour pages). */
export interface SourceAdapter {
	readonly source: SourceName;
	fetchEvents(artist: SourceArtistRef): Promise<RawSourceEvent[]>;
}

/**
 * What `normalise.ts` produces, shaped to feed `upsertEventByFingerprint`
 * (src/db/queries.ts) directly. `tour_id` is deliberately absent —
 * clustering (S3.3) assigns it, not this layer.
 */
export interface NormalisedEvent {
	fingerprint: string;
	artist_id: number;
	starts_at: string;
	timezone: string | null;
	city: string;
	country: string;
	city_key: string;
	venue_name: string | null;
	lat: number | null;
	lon: number | null;
	onsale_at: string | null;
	presale_at: string | null;
	ticket_url: string | null;
	status: EventStatus;
	source: SourceName;
	source_event_id: string;
	content_hash: string;
}
