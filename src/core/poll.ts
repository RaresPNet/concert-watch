/**
 * Daily poll orchestrator (IMPLEMENTATION_PLAN.md S3.2). The deterministic
 * pass — DESIGN.md §6.4: "the daily poll path is LLM-free." No model call
 * anywhere in this file.
 *
 * Poll set is `SELECT DISTINCT artist_id FROM watchlist` (S1.1's
 * `getDistinctWatchedArtistIds`) — the dedup requirement in DESIGN.md §4:
 * two subscribers watching one band produce one fetch, not two.
 *
 * Sources are injected, not constructed here (this file has no API keys of
 * its own): a Ticketmaster-shaped `SourceAdapter` and the tour-page checker
 * (`checkTourPage`, S2.3). Bandsintown is absent — its adapter (S2.2) was
 * never built (skipped, ships disabled regardless per DESIGN.md §6.2).
 *
 * This file does NOT cluster events into tours or decide what to notify —
 * that's S3.3. Newly-inserted/changed events are left with `tour_id = NULL`
 * (or whatever tour_id an earlier poll already assigned, untouched) and
 * reported back in `PollRunResult` so S3.3 knows which artists/events need
 * attention this run, without having to re-derive that from `events` itself.
 */

import {
	getArtistById,
	getDistinctWatchedArtistIds,
	getEventByFingerprint,
	touchArtistActivity,
	touchArtistPolled,
	updateArtistTourPageHash,
	upsertEventByFingerprint,
} from '../db/queries';
import type { ArtistRow } from '../db/schema';
import { checkTourPage } from '../sources/tourpage';
import { normaliseEvent } from '../sources/normalise';
import type { RawSourceEvent, SourceAdapter, SourceArtistRef } from '../sources/types';

export type PollEventKind = 'inserted' | 'changed' | 'unchanged' | 'quarantined';

export interface PollEventOutcome {
	kind: PollEventKind;
	event_id: number | null; // null only for 'quarantined' (no MBID -> nothing was written)
	fingerprint: string | null;
}

export interface PollArtistResult {
	artist_id: number;
	events: PollEventOutcome[];
	/** True when the tour page changed but carried no usable JSON-LD — S3.x/S4.7's model-parse queue, not handled here. */
	needs_model_parse: boolean;
	errors: string[]; // one entry per source that failed this artist (ticketmaster and/or tourpage)
}

export interface PollRunResult {
	polled_at: string;
	artists: PollArtistResult[];
}

export interface PollDeps {
	/** Fetches an artist's events from Ticketmaster. Omit to skip Ticketmaster entirely (e.g. a fixture run with only tour-page data). */
	ticketmasterAdapter?: SourceAdapter;
	db: D1Database;
	now?: () => string; // ISO timestamp, injectable for tests
	tourPageFetchImpl?: typeof fetch;
}

function toArtistRef(artist: ArtistRow): SourceArtistRef {
	return {
		artist_id: artist.id,
		mbid: artist.mbid,
		name: artist.name,
		tm_attraction_id: artist.tm_attraction_id,
		bit_slug: artist.bit_slug,
		tour_url: artist.tour_url,
	};
}

/** Persists one `RawSourceEvent`, comparing against any prior row by fingerprint to classify inserted/changed/unchanged. */
async function persistRawEvent(db: D1Database, raw: RawSourceEvent, artist: ArtistRow): Promise<PollEventOutcome> {
	const result = await normaliseEvent(raw, { id: artist.id, mbid: artist.mbid });
	if (!result.ok) {
		// Quarantined, not dropped (DESIGN.md §4) — the caller is left to decide
		// what to do with an event from a dark/unresolved artist. Nothing is
		// written to `events` for it.
		return { kind: 'quarantined', event_id: null, fingerprint: null };
	}

	const existing = await getEventByFingerprint(db, result.event.fingerprint);
	const eventId = await upsertEventByFingerprint(db, result.event);

	if (!existing) {
		return { kind: 'inserted', event_id: eventId, fingerprint: result.event.fingerprint };
	}
	const kind: PollEventKind = existing.content_hash === result.event.content_hash ? 'unchanged' : 'changed';
	return { kind, event_id: eventId, fingerprint: result.event.fingerprint };
}

async function pollOneArtist(artist: ArtistRow, deps: PollDeps, nowIso: string): Promise<PollArtistResult> {
	const outcomes: PollEventOutcome[] = [];
	const errors: string[] = [];
	let needsModelParse = false;

	if (deps.ticketmasterAdapter) {
		try {
			const raw = await deps.ticketmasterAdapter.fetchEvents(toArtistRef(artist));
			for (const event of raw) {
				outcomes.push(await persistRawEvent(deps.db, event, artist));
			}
		} catch (err) {
			// source_health is already recorded by the adapter itself
			// (recordSourceFailure) — this file just keeps polling other
			// artists/sources rather than letting one failure abort the run.
			errors.push(`ticketmaster: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	if (artist.tour_url) {
		const result = await checkTourPage(deps.db, { ...toArtistRef(artist), tour_url: artist.tour_url }, artist.tour_page_hash, {
			fetchImpl: deps.tourPageFetchImpl,
			now: deps.now,
		});
		switch (result.status) {
			case 'unchanged':
				break;
			case 'events':
				await updateArtistTourPageHash(deps.db, artist.id, result.hash);
				for (const event of result.events) {
					outcomes.push(await persistRawEvent(deps.db, event, artist));
				}
				break;
			case 'needs_model_parse':
				// Store the fresh hash so this same unchanged-but-unparsed page
				// isn't re-flagged every day — but the HTML itself isn't
				// persisted anywhere by this step; a later step (S4.7's
				// get_unparsed_pages / a dedicated table) owns queuing it for a
				// model parse. Flagged in PROGRESS.md.
				await updateArtistTourPageHash(deps.db, artist.id, result.hash);
				needsModelParse = true;
				break;
			case 'fetch_failed':
				errors.push(`tourpage: ${result.error}`);
				break;
		}
	}

	await touchArtistPolled(deps.db, artist.id, nowIso);
	if (outcomes.some((o) => o.kind === 'inserted' || o.kind === 'changed')) {
		await touchArtistActivity(deps.db, artist.id, nowIso);
	}

	return { artist_id: artist.id, events: outcomes, needs_model_parse: needsModelParse, errors };
}

/** Runs the daily deterministic poll across every currently-watched artist. */
export async function pollAll(deps: PollDeps): Promise<PollRunResult> {
	const nowIso = (deps.now ?? (() => new Date().toISOString()))();
	const artistIds = await getDistinctWatchedArtistIds(deps.db);

	const results: PollArtistResult[] = [];
	for (const artistId of artistIds) {
		const artist = await getArtistById(deps.db, artistId);
		if (!artist) continue; // watchlist row pointing at a deleted artist -- nothing to poll
		results.push(await pollOneArtist(artist, deps, nowIso));
	}

	return { polled_at: nowIso, artists: results };
}
