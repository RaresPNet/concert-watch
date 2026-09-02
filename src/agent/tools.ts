/**
 * The agent tool catalogue (IMPLEMENTATION_PLAN.md S4.5, DESIGN.md §11.5).
 * Each tool is defined in the shape `ModelSession` (S4.4, `src/model/client.ts`)
 * and Anthropic's tool-use API expect -- `name`/`description`/`input_schema`
 * plus a handler function -- following the same forced-tool-use convention
 * `src/core/resolve.ts` (S3.1) already established for talking to the
 * Messages API.
 *
 * **Tool design principle, verbatim from DESIGN.md §11.5: "tools return
 * decisions, not data."** Every handler below returns a small, shaped
 * result -- never a raw D1 row array, never a full `events` table, never an
 * unbounded list -- so the model spends tokens reasoning about a
 * conclusion, not about a blob it has to summarise itself. This is also
 * exactly what S4.5's own done-when tests for: output *size*, not just
 * correctness.
 *
 * **Ownership, enforced per tool, not centrally.** Every handler that
 * touches a row keyed by (subscriber, artist/tour/preference) either scopes
 * its D1 query to `ctx.subscriberId` from the start (so a row belonging to
 * another subscriber is never even visible to the query -- `list_watchlist`,
 * `get_tour`'s name/handle resolution) or checks the query's affected-row
 * count after a write scoped by `subscriber_id AND artist_id` in the same
 * statement (`remove_artist`, `set_priority` -- see
 * `removeFromWatchlist`/`setWatchlistPriority` in `db/queries.ts`). Nothing
 * here trusts an id the model reports without also filtering by
 * `ctx.subscriberId` in the same query. `save_preference`, `web_search` and
 * `escalate` never take a cross-subscriber id argument at all, so there is
 * nothing to check.
 *
 * This file does not implement the tool-using loop itself (turn-by-turn
 * `ModelSession.call()` calls, feeding `tool_result`s back, the 2-attempt
 * cap) -- that is S4.6's inbound command handler. What's exported here is
 * the stable surface S4.6 builds on: `AGENT_TOOLS` (the `tools[]` array to
 * hand to `ModelSession.call()`) and `callAgentTool` (the dispatcher S4.6's
 * loop calls once per `tool_use` block).
 */

import {
	addToWatchlist,
	appendSubscriberPreference,
	findWatchedArtistByName,
	getAllOrigins,
	getArtistByMbid,
	getReachabilityByCitySlug,
	getToursForArtist,
	getWatchlistEntry,
	getWatchlistWithArtists,
	insertArtist,
	recordUsage,
	removeFromWatchlist,
	setWatchlistPriority,
} from '../db/queries';
import type { ArtistRow, Priority, ReachabilityTier, TourRow } from '../db/schema';
import { resolveArtist, type ArtistResolutionResult, type ResolveArtistOptions } from '../core/resolve';
import { attachReachabilityToTour, pickBestReachability } from '../core/reach';
import { acquireArtist, type AcquireArtistResult } from '../core/acquire';
import { MODEL_SONNET, estimateCost, type AnthropicToolDef } from '../model/client';
import type { MusicBrainzArtistCandidate } from '../sources/musicbrainz';
import { TicketmasterAdapter } from '../sources/ticketmaster';

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';

// ---------------------------------------------------------------------------
// Tool context -- everything a handler needs, threaded in by S4.6's loop
// ---------------------------------------------------------------------------

/** Per-email-handling-session state for `web_search`'s cap (DESIGN.md §11.5: "capped at 3 calls per email"). Create one with `createWebSearchState()` per inbound email, not per tool call. */
export interface WebSearchState {
	callsUsed: number;
}

export function createWebSearchState(): WebSearchState {
	return { callsUsed: 0 };
}

export interface AgentToolContext {
	db: D1Database;
	/** The acting subscriber -- every ownership check below is scoped to this id, never to an id argument alone. */
	subscriberId: number;
	anthropicApiKey: string;
	ticketmasterApiKey: string;
	/** Shared across every tool call in one email-handling session -- see `WebSearchState`. */
	webSearchState: WebSearchState;
	/** Injectable for tests; defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
	/** Injectable for tests; defaults to `() => new Date()`. */
	now?: () => Date;
	/** Injectable for tests -- forwarded to `resolveArtist` (S3.1) so `add_artist` can be tested without a real MusicBrainz call. */
	musicbrainzLookup?: (name: string) => Promise<MusicBrainzArtistCandidate[]>;
}

/** One entry in the catalogue: an Anthropic tool definition plus the handler that executes it. `TInput`/`TOutput` are for this file's own type-checking; the wire shape (`input_schema`) is what Anthropic actually validates against. */
export interface AgentToolDefinition<TInput = unknown, TOutput = unknown> extends AnthropicToolDef {
	handler: (input: TInput, ctx: AgentToolContext) => Promise<TOutput>;
}

// ---------------------------------------------------------------------------
// list_watchlist
// ---------------------------------------------------------------------------

export interface ListWatchlistOutput {
	artists: Array<{ id: number; name: string; priority: Priority }>;
}

async function handleListWatchlist(_input: Record<string, never>, ctx: AgentToolContext): Promise<ListWatchlistOutput> {
	const rows = await getWatchlistWithArtists(ctx.db, ctx.subscriberId);
	return { artists: rows.map((r) => ({ id: r.artist_id, name: r.name, priority: r.priority })) };
}

const listWatchlistTool: AgentToolDefinition<Record<string, never>, ListWatchlistOutput> = {
	name: 'list_watchlist',
	description:
		"Lists the acting subscriber's own watched bands with their priority (P1-P4). Returns names and priorities only -- nothing else.",
	input_schema: { type: 'object', properties: {}, additionalProperties: false },
	handler: handleListWatchlist,
};

// ---------------------------------------------------------------------------
// add_artist
// ---------------------------------------------------------------------------

export interface AddArtistInput {
	name: string;
	/** Optional; defaults to 'P3' (regional) -- DESIGN.md §11.5 doesn't specify a default, this is this step's own judgment call, flagged in PROGRESS.md. */
	priority?: Priority;
}

/** Compact "what's already on" summary attached to a resolved add_artist result -- see buildAcquisitionSummary. */
export interface AddArtistAcquisitionSummary {
	tour_count: number;
	date_count: number;
	nearest_reachable_date: { starts_at: string; city: string | null; country: string | null; tier: ReachabilityTier | null } | null;
}

export type AddArtistOutput =
	| {
			resolved: true;
			artist: { id: number; name: string; priority: Priority };
			already_watching: boolean;
			/** What's already on for this band, fetched immediately rather than waiting for tomorrow's poll. */
			acquisition: AddArtistAcquisitionSummary;
	  }
	| {
			resolved: false;
			ambiguous: true;
			candidates: Array<{ name: string; disambiguation: string | null; country: string | null }>;
			question: string;
	  };

const DEFAULT_ADD_PRIORITY: Priority = 'P3';
/** Ambiguous candidates are capped here, independent of whatever `resolveArtist` gathered -- the model gets a short did-you-mean, never a full MusicBrainz candidate dump (tool design principle above). */
const MAX_AMBIGUOUS_CANDIDATES = 5;

/**
 * One band's full resolve-and-acquire pipeline: resolve the free-text name,
 * insert/find the `artists` row, add it to this subscriber's watchlist (or
 * find the existing entry), and acquire its current tour data. Shared by
 * `add_artist` (one band) and `add_artists` (S5.2, many bands in one tool
 * call) so the per-band logic exists exactly once -- `add_artists` is just
 * this function called in a loop, with its own grouping of the results.
 */
async function resolveAndAddOneArtist(name: string, priorityInput: Priority | undefined, ctx: AgentToolContext): Promise<AddArtistOutput> {
	const resolveOpts: ResolveArtistOptions = {
		anthropicApiKey: ctx.anthropicApiKey,
		ticketmasterApiKey: ctx.ticketmasterApiKey,
		fetchImpl: ctx.fetchImpl,
		musicbrainzLookup: ctx.musicbrainzLookup,
	};
	const result: ArtistResolutionResult = await resolveArtist(name, resolveOpts);

	if ('ambiguous' in result) {
		return {
			resolved: false,
			ambiguous: true,
			candidates: result.candidates.slice(0, MAX_AMBIGUOUS_CANDIDATES).map((c) => ({
				name: c.name,
				disambiguation: c.disambiguation,
				country: c.country,
			})),
			question: result.question,
		};
	}

	const r = result.resolved;
	let artist: ArtistRow | null = r.mbid ? await getArtistByMbid(ctx.db, r.mbid) : null;
	let artistId: number;
	if (artist) {
		artistId = artist.id;
	} else {
		artistId = await insertArtist(ctx.db, {
			mbid: r.mbid || null,
			name: r.name,
			sort_name: r.sort_name,
			tm_attraction_id: r.tm_attraction_id,
			bit_slug: r.bit_slug,
			songkick_id: r.songkick_id,
			official_url: r.official_url,
			tour_url: r.tour_url,
			image_url: r.image_url,
			coverage: r.coverage,
			resolution_notes: r.resolution_notes,
		});
	}

	const existingEntry = await getWatchlistEntry(ctx.db, ctx.subscriberId, artistId);
	const priority = existingEntry?.priority ?? priorityInput ?? DEFAULT_ADD_PRIORITY;
	if (!existingEntry) {
		await addToWatchlist(ctx.db, { subscriber_id: ctx.subscriberId, artist_id: artistId, priority });
	}

	const acquired: AcquireArtistResult = await acquireArtist(artistId, {
		db: ctx.db,
		ticketmasterAdapter: new TicketmasterAdapter({ apiKey: ctx.ticketmasterApiKey, db: ctx.db, fetchImpl: ctx.fetchImpl }),
		tourPageFetchImpl: ctx.fetchImpl,
		now: () => (ctx.now ?? (() => new Date()))().toISOString(),
	});

	return {
		resolved: true,
		artist: { id: artistId, name: r.name, priority },
		already_watching: existingEntry !== null,
		acquisition: {
			tour_count: acquired.tour_count,
			date_count: acquired.date_count,
			nearest_reachable_date: acquired.nearest_reachable_date,
		},
	};
}

async function handleAddArtist(input: AddArtistInput, ctx: AgentToolContext): Promise<AddArtistOutput> {
	return resolveAndAddOneArtist(input.name, input.priority, ctx);
}

const addArtistTool: AgentToolDefinition<AddArtistInput, AddArtistOutput> = {
	name: 'add_artist',
	description:
		"Resolves a free-text band name and adds it to the acting subscriber's watchlist. Also immediately checks that band's known tour sources, so a resolved result comes back with a summary of what's already on: how many upcoming tours, how many dates total, and the single most reachable upcoming date, if any. Returns either that resolved artist (with its watchlist priority and summary) or, when the name is genuinely ambiguous, a short list of candidates plus a did-you-mean question -- never a guess.",
	input_schema: {
		type: 'object',
		properties: {
			name: { type: 'string', description: 'The band name as the subscriber wrote it.' },
			priority: {
				type: 'string',
				enum: ['P1', 'P2', 'P3', 'P4'],
				description: "Optional. Defaults to 'P3' if the subscriber didn't state one.",
			},
		},
		required: ['name'],
		additionalProperties: false,
	},
	handler: handleAddArtist,
};

// ---------------------------------------------------------------------------
// add_artists (S5.2 -- add many bands in one tool call)
// ---------------------------------------------------------------------------

export interface AddArtistsInput {
	bands: Array<{ name: string; priority?: Priority }>;
}

export interface AddArtistsResolvedEntry {
	input_name: string;
	artist: { id: number; name: string; priority: Priority };
	already_watching: boolean;
	acquisition: AddArtistAcquisitionSummary;
}

export interface AddArtistsAmbiguousEntry {
	input_name: string;
	candidates: Array<{ name: string; disambiguation: string | null; country: string | null }>;
	question: string;
}

export interface AddArtistsNotFoundEntry {
	input_name: string;
	reason: string;
}

export interface AddArtistsOutput {
	resolved: AddArtistsResolvedEntry[];
	ambiguous: AddArtistsAmbiguousEntry[];
	not_found: AddArtistsNotFoundEntry[];
}

/**
 * S5.2: onboarding a long list of bands (e.g. a 25-band "here's everything
 * I follow" email) one at a time through `add_artist` would spend one tool
 * call per band against `MAX_TOOL_CALLS_PER_SESSION` -- this tool does the
 * same resolve-and-acquire work for the whole list inside a single call, so
 * list length no longer competes with the per-email tool-call cap.
 *
 * Bands are processed one at a time, in order, not concurrently: MusicBrainz
 * lookups (inside `resolveArtist`) already share one process-wide 1-request-
 * per-second throttle (`src/sources/musicbrainz.ts`), so running them
 * concurrently would not make the MusicBrainz portion any faster, and
 * sequencing everything else the same way keeps this straightforward and
 * avoids concurrent writes to the same subscriber's watchlist rows. See
 * PROGRESS.md's S5.2 entry for the resulting wall-clock estimate for 25
 * bands and why it fits inside a Worker's CPU-time budget despite that.
 *
 * A band that throws partway through (a real fetch/API failure, not a
 * resolution ambiguity) is caught here and reported in `not_found` with the
 * error message as `reason`, rather than aborting the whole list -- one
 * flaky source must not cost the subscriber every other band in the email.
 */
async function handleAddArtists(input: AddArtistsInput, ctx: AgentToolContext): Promise<AddArtistsOutput> {
	const resolved: AddArtistsResolvedEntry[] = [];
	const ambiguous: AddArtistsAmbiguousEntry[] = [];
	const not_found: AddArtistsNotFoundEntry[] = [];

	for (const band of input.bands) {
		try {
			const result = await resolveAndAddOneArtist(band.name, band.priority, ctx);
			if (result.resolved) {
				resolved.push({
					input_name: band.name,
					artist: result.artist,
					already_watching: result.already_watching,
					acquisition: result.acquisition,
				});
			} else {
				ambiguous.push({ input_name: band.name, candidates: result.candidates, question: result.question });
			}
		} catch (err) {
			not_found.push({ input_name: band.name, reason: err instanceof Error ? err.message : String(err) });
		}
	}

	return { resolved, ambiguous, not_found };
}

const addArtistsTool: AgentToolDefinition<AddArtistsInput, AddArtistsOutput> = {
	name: 'add_artists',
	description:
		"Adds many bands to the acting subscriber's watchlist in one call -- use this instead of calling add_artist repeatedly whenever the " +
		'subscriber lists more than one or two bands at once (e.g. onboarding a whole list, or a message that names several bands on one ' +
		'line). Each band is resolved and its current tours fetched exactly as add_artist would, independently of the others, so one bad or ' +
		'ambiguous name never blocks the rest. Before calling, read priority out of how each band was phrased, even when several bands with ' +
		'different priorities appear in the same sentence: language like "my favourites are X and Y" or "I\'d fly anywhere for X" means the ' +
		'highest priority (P1); "I\'d also go if it were easy" or "worth travelling for" is more moderate (P2); an offhand mention with no ' +
		'stated enthusiasm, or a band named only regionally/locally, is lower (P3 or P4); when nothing in the phrasing signals either way, ' +
		"leave priority unset and the default applies. Whatever reply summarises this call's results should say, in plain words, what " +
		'priority was inferred for each band and invite a correction -- the subscriber did not type "P1", they typed a sentence, and this is ' +
		'the only chance to check the inference was read the way they meant it. That reply should also carry the catch-up for anything ' +
		"resolved: how many tours and dates are already on, and the closest reachable date if there is one -- this may be the subscriber's " +
		'first real answer from the system, so it should feel like a substantive reply, not just an acknowledgement. Returns three groups: ' +
		'"resolved" (added, with a summary of what\'s already on for each), "ambiguous" (a name that matched more than one band -- each ' +
		'comes with a short did-you-mean question to relay to the subscriber), and "not_found" (a band that could not be processed, with a ' +
		'plain-text reason). A normal result often has entries in more than one group at once; that is not a failure.',
	input_schema: {
		type: 'object',
		properties: {
			bands: {
				type: 'array',
				description: 'The bands to add, in the order the subscriber listed them.',
				items: {
					type: 'object',
					properties: {
						name: { type: 'string', description: 'The band name as the subscriber wrote it.' },
						priority: {
							type: 'string',
							enum: ['P1', 'P2', 'P3', 'P4'],
							description:
								'Optional. The priority inferred from how the subscriber phrased this particular band -- P1 for stated favourites or ' +
								'"anywhere" enthusiasm, P2 for "worth travelling for", P3 for a casual/regional mention, P4 for local-only interest. ' +
								'Leave unset when the wording gives no signal either way; P3 is applied automatically in that case.',
						},
					},
					required: ['name'],
					additionalProperties: false,
				},
				minItems: 1,
			},
		},
		required: ['bands'],
		additionalProperties: false,
	},
	handler: handleAddArtists,
};

// ---------------------------------------------------------------------------
// remove_artist
// ---------------------------------------------------------------------------

export interface RemoveArtistInput {
	id: number;
}

export type RemoveArtistOutput = { ok: true } | { ok: false; reason: 'not_found' };

async function handleRemoveArtist(input: RemoveArtistInput, ctx: AgentToolContext): Promise<RemoveArtistOutput> {
	// Ownership enforced inside removeFromWatchlist's own WHERE clause
	// (subscriber_id = ctx.subscriberId AND artist_id = input.id) -- a
	// crafted id belonging to another subscriber deletes zero rows and comes
	// back indistinguishable from "not watching this band", which is the
	// correct externally-visible behaviour (no confirmation either way that
	// the id even exists for someone else).
	const removed = await removeFromWatchlist(ctx.db, ctx.subscriberId, input.id);
	return removed ? { ok: true } : { ok: false, reason: 'not_found' };
}

const removeArtistTool: AgentToolDefinition<RemoveArtistInput, RemoveArtistOutput> = {
	name: 'remove_artist',
	description: "Removes a band from the acting subscriber's own watchlist, by the artist id returned from list_watchlist or add_artist.",
	input_schema: {
		type: 'object',
		properties: { id: { type: 'integer', description: 'The artist id (from list_watchlist / add_artist), not a name.' } },
		required: ['id'],
		additionalProperties: false,
	},
	handler: handleRemoveArtist,
};

// ---------------------------------------------------------------------------
// set_priority
// ---------------------------------------------------------------------------

export interface SetPriorityInput {
	id: number;
	priority: Priority;
}

export type SetPriorityOutput = { ok: true; priority: Priority } | { ok: false; reason: 'not_found' | 'invalid_priority' };

const VALID_PRIORITIES: readonly Priority[] = ['P1', 'P2', 'P3', 'P4'];

async function handleSetPriority(input: SetPriorityInput, ctx: AgentToolContext): Promise<SetPriorityOutput> {
	if (!VALID_PRIORITIES.includes(input.priority)) {
		return { ok: false, reason: 'invalid_priority' };
	}
	// Same same-statement ownership scoping as remove_artist.
	const updated = await setWatchlistPriority(ctx.db, ctx.subscriberId, input.id, input.priority);
	return updated ? { ok: true, priority: input.priority } : { ok: false, reason: 'not_found' };
}

const setPriorityTool: AgentToolDefinition<SetPriorityInput, SetPriorityOutput> = {
	name: 'set_priority',
	description:
		"Changes a watched band's priority on the acting subscriber's own watchlist, by artist id (P1 = chase it anywhere, P2 = worth travelling for, P3 = regional, P4 = local only).",
	input_schema: {
		type: 'object',
		properties: {
			id: { type: 'integer', description: 'The artist id (from list_watchlist / add_artist), not a name.' },
			priority: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4'] },
		},
		required: ['id', 'priority'],
		additionalProperties: false,
	},
	handler: handleSetPriority,
};

// ---------------------------------------------------------------------------
// get_tour
// ---------------------------------------------------------------------------

export interface GetTourInput {
	handle_or_name: string;
}

export interface CompactTourDate {
	starts_at: string | null;
	city: string | null;
	country: string | null;
	venue_name: string | null;
	tier: string | null;
	route_note: string | null;
	onsale_at: string | null;
}

export type GetTourOutput =
	| {
			found: true;
			tour_id: number;
			handle: string;
			artist_name: string;
			label: string | null;
			official_url: string | null;
			date_count: number;
			first_date: string | null;
			last_date: string | null;
			/** Never the full events array -- at most 3 rows, the same "most reachable dates" the digest itself prints (DESIGN.md §10.1). */
			top_dates: CompactTourDate[];
	  }
	| { found: false };

/**
 * Reproduces `src/digest/payload.ts`'s `makeHandle` formula exactly (first
 * letter of the artist name, uppercased, + the tour id in base36, 2 chars,
 * zero-padded) so a handle printed in a digest email is decodable here.
 * Deliberately duplicated rather than imported -- `makeHandle` is a private,
 * unexported helper in `payload.ts` and this is a few lines of pure string
 * formatting, in keeping with this codebase's existing precedent for small
 * cross-file duplication over a coupling (see `reach.ts`'s own note on
 * `pickBestReachability` vs. `notify.ts`'s `bestTierForCity`). If
 * `payload.ts`'s formula ever changes, this must change with it.
 */
function deriveTourHandle(artistName: string, tourId: number): string {
	const initial = (artistName.trim()[0] ?? 'X').toUpperCase();
	const suffix = tourId.toString(36).toUpperCase().slice(-2).padStart(2, '0');
	return `#${initial}${suffix}`;
}

/** Picks the tour a bare artist name should resolve to: the currently "open" one (not yet ended) if any, else the most recent tour ever, else none. */
function pickDefaultTour(tours: TourRow[], todayIso: string): TourRow | null {
	const open = tours.find((t) => t.last_date === null || t.last_date >= todayIso);
	return open ?? tours[0] ?? null;
}

async function resolveHandleOrName(
	input: string,
	ctx: AgentToolContext,
): Promise<{ artist_name: string; tour: TourRow; handle: string } | null> {
	const trimmed = input.trim();
	const now = ctx.now ?? (() => new Date());
	const todayIso = now().toISOString();

	if (trimmed.startsWith('#')) {
		// Handle path: scoped to this subscriber's own watchlist by
		// construction -- we only ever enumerate artists getWatchlistWithArtists
		// returns for ctx.subscriberId, so a handle happening to collide with
		// another subscriber's tour can never resolve here.
		const watched = await getWatchlistWithArtists(ctx.db, ctx.subscriberId);
		const wanted = trimmed.toUpperCase();
		for (const w of watched) {
			const tours = await getToursForArtist(ctx.db, w.artist_id);
			for (const tour of tours) {
				const handle = deriveTourHandle(w.name, tour.id);
				if (handle === wanted) {
					return { artist_name: w.name, tour, handle };
				}
			}
		}
		return null;
	}

	// Name path: findWatchedArtistByName already joins on watchlist scoped to
	// ctx.subscriberId, so an artist this subscriber doesn't watch is never
	// visible to this query in the first place.
	const artist = await findWatchedArtistByName(ctx.db, ctx.subscriberId, trimmed);
	if (!artist) return null;
	const tours = await getToursForArtist(ctx.db, artist.id);
	const tour = pickDefaultTour(tours, todayIso);
	if (!tour) return null;
	return { artist_name: artist.name, tour, handle: deriveTourHandle(artist.name, tour.id) };
}

async function handleGetTour(input: GetTourInput, ctx: AgentToolContext): Promise<GetTourOutput> {
	const match = await resolveHandleOrName(input.handle_or_name, ctx);
	if (!match) return { found: false };

	const reach = await attachReachabilityToTour(ctx.db, match.tour.id);
	const top_dates: CompactTourDate[] = reach.top_three.map((e) => ({
		starts_at: e.starts_at,
		city: e.city,
		country: e.country,
		venue_name: e.venue_name,
		tier: e.tier,
		route_note: e.route_note,
		onsale_at: e.onsale_at,
	}));

	return {
		found: true,
		tour_id: match.tour.id,
		handle: match.handle,
		artist_name: match.artist_name,
		label: match.tour.label,
		official_url: match.tour.official_url,
		date_count: match.tour.date_count ?? reach.events.length,
		first_date: match.tour.first_date,
		last_date: match.tour.last_date,
		top_dates,
	};
}

const getTourTool: AgentToolDefinition<GetTourInput, GetTourOutput> = {
	name: 'get_tour',
	description:
		'Looks up a tour by its short handle (e.g. "#I02", printed small and grey in digest emails) or by a band\'s free-text name, scoped to the acting subscriber\'s own watchlist. Returns a compact summary (date range, date count, official link, and the three most reachable dates) -- never the full list of event rows.',
	input_schema: {
		type: 'object',
		properties: { handle_or_name: { type: 'string', description: 'A "#XXX" handle from an email, or a band name/partial name.' } },
		required: ['handle_or_name'],
		additionalProperties: false,
	},
	handler: handleGetTour,
};

// ---------------------------------------------------------------------------
// get_reachability
// ---------------------------------------------------------------------------

export interface GetReachabilityInput {
	city: string;
}

export type GetReachabilityOutput = { found: true; line: string } | { found: false; message: string };

function slugifyCity(city: string): string {
	return city
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '');
}

async function handleGetReachability(input: GetReachabilityInput, ctx: AgentToolContext): Promise<GetReachabilityOutput> {
	const slug = slugifyCity(input.city);
	if (!slug) return { found: false, message: `"${input.city}" isn't a recognisable city name.` };

	const rows = await getReachabilityByCitySlug(ctx.db, slug);
	if (rows.length === 0) {
		return { found: false, message: `No reachability data for "${input.city}" yet.` };
	}

	const origins = await getAllOrigins(ctx.db);
	const penaltyByOrigin = new Map(origins.map((o) => [o.iata, o.penalty_minutes ?? Number.POSITIVE_INFINITY]));
	const best = pickBestReachability(rows, penaltyByOrigin);
	if (!best) return { found: false, message: `No reachability data for "${input.city}" yet.` };

	const cityLabel = best.city_key.split(':')[1] ?? input.city;
	const routeNote = best.route_note ?? 'no route note recorded';
	return { found: true, line: `${cityLabel}: Tier ${best.tier} from ${best.origin_iata} -- ${routeNote}` };
}

const getReachabilityTool: AgentToolDefinition<GetReachabilityInput, GetReachabilityOutput> = {
	name: 'get_reachability',
	description:
		'Looks up how reachable a city is from Cluj, from precomputed travel data -- one line: difficulty tier, origin airport, and a route note. Never derive a route yourself; always call this instead.',
	input_schema: {
		type: 'object',
		properties: { city: { type: 'string', description: 'A city name, e.g. "Leeds" or "Prague".' } },
		required: ['city'],
		additionalProperties: false,
	},
	handler: handleGetReachability,
};

// ---------------------------------------------------------------------------
// save_preference
// ---------------------------------------------------------------------------

export interface SavePreferenceInput {
	text: string;
}

export interface SavePreferenceOutput {
	ok: true;
}

async function handleSavePreference(input: SavePreferenceInput, ctx: AgentToolContext): Promise<SavePreferenceOutput> {
	// Always writes to ctx.subscriberId's own row -- there is no id argument
	// to spoof here, so no separate ownership check is needed.
	await appendSubscriberPreference(ctx.db, ctx.subscriberId, input.text.trim());
	return { ok: true };
}

const savePreferenceTool: AgentToolDefinition<SavePreferenceInput, SavePreferenceOutput> = {
	name: 'save_preference',
	description:
		'Records a standing preference the subscriber stated in conversation (e.g. "I won\'t fly Ryanair", "never a Sunday night return") so future trip-planning replies honour it. Appends; does not overwrite earlier preferences.',
	input_schema: {
		type: 'object',
		properties: { text: { type: 'string', description: 'The preference, in the subscriber’s own words or a short paraphrase.' } },
		required: ['text'],
		additionalProperties: false,
	},
	handler: handleSavePreference,
};

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

export interface WebSearchInput {
	q: string;
}

export interface WebSearchResultItem {
	title: string | null;
	url: string;
}

export type WebSearchOutput = { ok: true; results: WebSearchResultItem[] } | { ok: false; refused: true; reason: string };

/** DESIGN.md §11.5: "web_search(q) -- capped at 3 calls per email." Enforced here, in the tool, per the plan's explicit instruction -- not left to the model's own restraint. */
export const MAX_WEB_SEARCHES_PER_EMAIL = 3;

/** At most this many results are surfaced back to the model per call -- "tools return decisions, not data" applies to search results too. */
const MAX_WEB_SEARCH_RESULTS = 5;

/**
 * Delegates to Anthropic's native server-side web search tool
 * (`web_search_20260209`/name `web_search`, verified live against the
 * bundled `claude-api` skill's current docs -- see PROGRESS.md's S4.5 entry
 * for the research trail and why this isn't a client-side search API call).
 * That tool's own `max_uses` param bounds searches *within one Messages API
 * request*; it does not bound calls *across* the several sequential
 * requests one email-handling session makes as the tool-use loop runs
 * multiple turns, which is what DESIGN.md §11.5's "3 calls per email" is
 * actually about. Hence the explicit `ctx.webSearchState` counter here, on
 * top of also setting `max_uses: 1` on each individual delegated call.
 */
async function handleWebSearch(input: WebSearchInput, ctx: AgentToolContext): Promise<WebSearchOutput> {
	if (ctx.webSearchState.callsUsed >= MAX_WEB_SEARCHES_PER_EMAIL) {
		return {
			ok: false,
			refused: true,
			reason: `web_search is capped at ${MAX_WEB_SEARCHES_PER_EMAIL} calls per email and that cap has been reached -- answer from what's already known, or tell the subscriber the search budget for this reply ran out.`,
		};
	}
	ctx.webSearchState.callsUsed += 1;

	const fetchImpl = ctx.fetchImpl ?? fetch;
	const now = ctx.now ?? (() => new Date());
	const res = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': ctx.anthropicApiKey,
			'anthropic-version': ANTHROPIC_API_VERSION,
		},
		body: JSON.stringify({
			model: MODEL_SONNET,
			max_tokens: 1024,
			messages: [{ role: 'user', content: input.q }],
			tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 1 }],
		}),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`web_search: Anthropic Messages API ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
	}

	const data = (await res.json()) as {
		content: Array<{ type: string; content?: unknown }>;
		usage: { input_tokens: number; output_tokens: number };
	};

	// Metered directly here (not via ModelSession -- this is a second,
	// nested Anthropic call the tool handler makes on its own, not a turn
	// of the calling session) so it still lands in the usage table for
	// DESIGN.md §12.5's monthly ceiling. See PROGRESS.md's S4.5 entry: this
	// call's input tokens are NOT currently added to the calling
	// ModelSession's own 40k-input-token cumulative cap, a flagged gap.
	await recordUsage(ctx.db, {
		day: now().toISOString().slice(0, 10),
		path: 'web_search',
		model: MODEL_SONNET,
		input_tokens: data.usage.input_tokens,
		output_tokens: data.usage.output_tokens,
		est_cost: estimateCost(MODEL_SONNET, data.usage.input_tokens, data.usage.output_tokens),
	});

	const resultBlock = data.content.find((b) => b.type === 'web_search_tool_result');
	if (!resultBlock || !Array.isArray(resultBlock.content)) {
		// Either no search actually happened (the model's phrasing didn't
		// trigger one) or the server tool returned an error object instead of
		// a results array (e.g. { error_code: "max_uses_exceeded" }) -- both
		// are "no results", not a thrown error.
		return { ok: true, results: [] };
	}

	const results: WebSearchResultItem[] = (resultBlock.content as Array<{ title?: string; url?: string }>)
		.slice(0, MAX_WEB_SEARCH_RESULTS)
		.filter((r): r is { title?: string; url: string } => typeof r.url === 'string')
		.map((r) => ({ title: r.title ?? null, url: r.url }));

	return { ok: true, results };
}

const webSearchTool: AgentToolDefinition<WebSearchInput, WebSearchOutput> = {
	name: 'web_search',
	description:
		'Searches the web for current information (e.g. flight/train prices, festival lineups). Capped at 3 calls per email -- use it sparingly and only when get_reachability and known facts are not enough.',
	input_schema: {
		type: 'object',
		properties: { q: { type: 'string', description: 'A short, specific search query.' } },
		required: ['q'],
		additionalProperties: false,
	},
	handler: handleWebSearch,
};

// ---------------------------------------------------------------------------
// escalate
// ---------------------------------------------------------------------------

export interface EscalateInput {
	reason: string;
}

export interface EscalateOutput {
	escalate: true;
	reason: string;
}

/**
 * "Escalation is a tool, not a separate classifier pass. Haiku gets
 * escalate(reason) and the loop restarts on Sonnet with the same thread."
 * (DESIGN.md §11.5). This handler does not itself restart anything -- it
 * has no access to the loop -- it just returns the signal shape S4.6's
 * inbound command handler (not yet built) is expected to check for and act
 * on by calling `ModelSession.call()` again with `model: MODEL_SONNET` on
 * the same session.
 */
async function handleEscalate(input: EscalateInput): Promise<EscalateOutput> {
	return { escalate: true, reason: input.reason };
}

const escalateTool: AgentToolDefinition<EscalateInput, EscalateOutput> = {
	name: 'escalate',
	description:
		'Hands the conversation to the more capable model (Sonnet) for trip planning or anything needing web search -- call this instead of attempting trip research yourself. Give a one-sentence reason.',
	input_schema: {
		type: 'object',
		properties: {
			reason: { type: 'string', description: 'Why this needs the more capable model, e.g. "trip planning for the Leeds date".' },
		},
		required: ['reason'],
		additionalProperties: false,
	},
	handler: handleEscalate,
};

// ---------------------------------------------------------------------------
// Catalogue + dispatcher
// ---------------------------------------------------------------------------

/** The full tool catalogue, in the shape `ModelCallRequest.tools` (S4.4's `client.ts`) expects. */
export const AGENT_TOOLS: AgentToolDefinition[] = [
	listWatchlistTool,
	addArtistTool,
	addArtistsTool,
	removeArtistTool,
	setPriorityTool,
	getTourTool,
	getReachabilityTool,
	savePreferenceTool,
	webSearchTool,
	escalateTool,
] as AgentToolDefinition[];

const TOOLS_BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.name, t]));

/** The tool definitions only (no handlers) -- pass this straight into `ModelCallRequest.tools`. */
export function agentToolDefinitions(): AnthropicToolDef[] {
	return AGENT_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

/**
 * Executes one named tool call by its (parsed) input. S4.6's loop calls this
 * once per `tool_use` block in a model response and feeds the (stringified)
 * result back as a `tool_result`. Throws for an unknown tool name -- that's
 * a wiring bug (a name Anthropic returned that isn't in `AGENT_TOOLS`), not
 * a user-facing condition to handle gracefully.
 */
export async function callAgentTool(name: string, input: unknown, ctx: AgentToolContext): Promise<unknown> {
	const tool = TOOLS_BY_NAME.get(name);
	if (!tool) throw new Error(`callAgentTool: unknown tool "${name}"`);
	return tool.handler(input, ctx);
}
