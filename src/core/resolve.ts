/**
 * Artist resolution pass (IMPLEMENTATION_PLAN.md S3.1, DESIGN.md §5). Given a
 * free-text band name, produces a populated `artists` row shape — or reports
 * ambiguity back to the caller as a question, never a guess.
 *
 * Model-assisted: gathers candidates from MusicBrainz (S2.4) and Ticketmaster
 * (an attraction-search call, duplicated here rather than reusing
 * TicketmasterAdapter — that class's lookup is a private implementation
 * detail of `fetchEvents`, and this step's touch list is this file only),
 * then asks Claude to pick the right MusicBrainz identity and explain why.
 *
 * Bandsintown is not gathered from. Its adapter (S2.2) was never built —
 * skipped per PROGRESS.md, the access request to biz@bandsintown.com is
 * still pending, and DESIGN.md §6.2 says it ships disabled regardless. So
 * this pass relies on MusicBrainz + Ticketmaster only, one source fewer than
 * §5 describes, but nothing Bandsintown would have contributed exists to
 * lose.
 *
 * Persisting the result to `artists` is the caller's job — this file never
 * touches D1.
 */

import { lookupArtistCandidates, type MusicBrainzArtistCandidate } from '../sources/musicbrainz';
import type { ArtistCoverage } from '../db/schema';

const TICKETMASTER_ATTRACTION_URL = 'https://app.ticketmaster.com/discovery/v2/attractions.json';
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';

/**
 * Haiku 4.5 per DESIGN.md §11.5's model routing — resolution is the "common
 * case" tier (watchlist CRUD, did-you-mean), not the Sonnet-tier trip
 * planning / web-search work.
 */
const MODEL = 'claude-haiku-4-5-20251001';

export interface TicketmasterAttractionCandidate {
	tm_attraction_id: string;
	name: string;
	image_url: string | null;
}

export interface ResolvedArtist {
	mbid: string;
	name: string;
	sort_name: string;
	tm_attraction_id: string | null;
	/** Bandsintown never gathered from — see file header. */
	bit_slug: null;
	/** No Songkick key yet (DESIGN.md §6.2 — "apply, don't plan around it"); left for a later pass if one arrives. */
	songkick_id: null;
	official_url: string | null;
	tour_url: string | null;
	image_url: string | null;
	coverage: ArtistCoverage;
	resolution_notes: string;
}

export interface ResolutionCandidateSummary {
	mbid: string;
	name: string;
	disambiguation: string | null;
	country: string | null;
	begin_date: string | null;
}

export type ArtistResolutionResult =
	{ resolved: ResolvedArtist } | { ambiguous: true; candidates: ResolutionCandidateSummary[]; question: string };

export interface ResolveArtistOptions {
	anthropicApiKey: string;
	ticketmasterApiKey: string;
	/** Injectable for tests; defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
	/** Injectable for tests; defaults to the real MusicBrainz lookup (S2.4). */
	musicbrainzLookup?: (name: string) => Promise<MusicBrainzArtistCandidate[]>;
}

/**
 * Resolves one free-text band name per DESIGN.md §5's contract: `{ resolved }`
 * when confident, or `{ ambiguous, candidates, question }` when not — the
 * caller (an add-artist flow, not yet built) is expected to surface the
 * question rather than pick for the subscriber.
 */
export async function resolveArtist(name: string, opts: ResolveArtistOptions): Promise<ArtistResolutionResult> {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const musicbrainzLookup = opts.musicbrainzLookup ?? lookupArtistCandidates;

	const [mbCandidates, tmCandidates] = await Promise.all([
		musicbrainzLookup(name),
		lookupTicketmasterAttractions(name, opts.ticketmasterApiKey, fetchImpl),
	]);

	if (mbCandidates.length === 0) {
		// No MusicBrainz identity at all — nothing to fingerprint against
		// (DESIGN.md §4 keys the fingerprint on the artist's MBID). Coverage
		// stays 'dark' rather than inventing an identity; the search sweep
		// (§6.2) is what's expected to carry artists like this.
		return {
			resolved: {
				mbid: '',
				name,
				sort_name: name,
				tm_attraction_id: tmCandidates[0]?.tm_attraction_id ?? null,
				bit_slug: null,
				songkick_id: null,
				official_url: null,
				tour_url: null,
				image_url: tmCandidates[0]?.image_url ?? null,
				coverage: 'dark',
				resolution_notes: `No MusicBrainz match for "${name}". Coverage set to dark; relies on the search sweep (DESIGN.md §6.2) rather than a fabricated identity.`,
			},
		};
	}

	const decision = await askModelToResolve(name, mbCandidates, tmCandidates, opts.anthropicApiKey, fetchImpl);

	if (decision.decision === 'ambiguous') {
		return {
			ambiguous: true,
			candidates: mbCandidates.map((c) => ({
				mbid: c.mbid,
				name: c.name,
				disambiguation: c.disambiguation,
				country: c.country,
				begin_date: c.beginDate,
			})),
			question: decision.question,
		};
	}

	const chosen = mbCandidates.find((c) => c.mbid === decision.mbid);
	if (!chosen) {
		// The model named an MBID it was never offered — refuse to trust a
		// hallucinated identity rather than silently accepting it.
		throw new Error(`resolveArtist: model returned mbid "${decision.mbid}" which was not among the candidates offered for "${name}"`);
	}

	const tmMatch = decision.tm_attraction_id ? tmCandidates.find((c) => c.tm_attraction_id === decision.tm_attraction_id) : undefined;

	return {
		resolved: {
			mbid: chosen.mbid,
			name: chosen.name,
			sort_name: chosen.sortName,
			tm_attraction_id: tmMatch?.tm_attraction_id ?? null,
			bit_slug: null,
			songkick_id: null,
			official_url: decision.official_url,
			tour_url: decision.tour_url,
			image_url: tmMatch?.image_url ?? null,
			// coverage = 'api' if a structured source (here, Ticketmaster) knows
			// the artist; MusicBrainz itself is a naming lookup, not one of the
			// structured event sources DESIGN.md §6.2 enumerates.
			coverage: tmMatch ? 'api' : 'dark',
			resolution_notes: decision.notes,
		},
	};
}

async function lookupTicketmasterAttractions(
	name: string,
	apiKey: string,
	fetchImpl: typeof fetch,
): Promise<TicketmasterAttractionCandidate[]> {
	const url = new URL(TICKETMASTER_ATTRACTION_URL);
	url.searchParams.set('apikey', apiKey);
	url.searchParams.set('keyword', name);
	url.searchParams.set('classificationName', 'Music');
	url.searchParams.set('size', '5');

	const res = await fetchImpl(url.toString());
	if (!res.ok) {
		// A Ticketmaster hiccup must not block resolution entirely — the
		// MusicBrainz identity is what matters most; Ticketmaster coverage is
		// an enrichment on top of it, not a prerequisite.
		return [];
	}
	const body = (await res.json()) as {
		_embedded?: { attractions?: Array<{ id: string; name: string; images?: Array<{ url: string; ratio?: string; fallback?: boolean }> }> };
	};
	const attractions = body._embedded?.attractions ?? [];
	return attractions.map((a) => ({
		tm_attraction_id: a.id,
		name: a.name,
		image_url: pickAttractionImage(a.images),
	}));
}

function pickAttractionImage(images: Array<{ url: string; ratio?: string; fallback?: boolean }> | undefined): string | null {
	if (!images || images.length === 0) return null;
	const wide = images.find((i) => i.ratio === '16_9' && !i.fallback);
	return (wide ?? images[0]).url;
}

interface ModelDecision {
	decision: 'resolved' | 'ambiguous';
	mbid: string;
	tm_attraction_id: string | null;
	official_url: string | null;
	tour_url: string | null;
	notes: string;
	question: string;
}

const RESOLVE_TOOL_NAME = 'resolve_artist';

/**
 * Asks Claude to pick the right MusicBrainz candidate (or flag ambiguity),
 * via forced tool-use so the response is structured rather than free text
 * that would need its own fragile parsing.
 */
async function askModelToResolve(
	queryName: string,
	mbCandidates: MusicBrainzArtistCandidate[],
	tmCandidates: TicketmasterAttractionCandidate[],
	apiKey: string,
	fetchImpl: typeof fetch,
): Promise<ModelDecision> {
	const prompt = [
		`A subscriber wants to watch the band "${queryName}".`,
		``,
		`MusicBrainz candidates (ranked by relevance):`,
		...mbCandidates.map(
			(c, i) =>
				`${i + 1}. mbid=${c.mbid} name="${c.name}" type=${c.type ?? 'unknown'} country=${c.country ?? 'unknown'} disambiguation="${c.disambiguation ?? ''}" begin=${c.beginDate ?? 'unknown'} score=${c.score}`,
		),
		``,
		`Ticketmaster attraction candidates:`,
		...(tmCandidates.length
			? tmCandidates.map((c, i) => `${i + 1}. tm_attraction_id=${c.tm_attraction_id} name="${c.name}"`)
			: ['(none found)']),
		``,
		`Pick the MusicBrainz candidate that is genuinely the band the subscriber means. If two or more candidates are plausible and the name alone doesn't tell you which, call this ambiguous and ask a short, specific did-you-mean question (mention what distinguishes the candidates — genre, country, era). Do not guess when genuinely unsure: an unresolvable name must be reported back, never silently guessed (DESIGN.md §5). If you happen to know the band's official site or tour/shows page with real confidence, include it; otherwise leave it null rather than inventing a URL.`,
	].join('\n');

	const res = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': apiKey,
			'anthropic-version': ANTHROPIC_API_VERSION,
		},
		body: JSON.stringify({
			model: MODEL,
			max_tokens: 1024,
			messages: [{ role: 'user', content: prompt }],
			tools: [
				{
					name: RESOLVE_TOOL_NAME,
					description: 'Report the artist resolution decision.',
					input_schema: {
						type: 'object',
						properties: {
							decision: { type: 'string', enum: ['resolved', 'ambiguous'] },
							mbid: {
								type: 'string',
								description: 'Required when decision is "resolved" — must be exactly one of the candidate mbids offered above.',
							},
							tm_attraction_id: {
								type: 'string',
								description:
									'The matching Ticketmaster attraction id, if one of the candidates is clearly the same act. Omit if none matches.',
							},
							official_url: { type: 'string', description: "The band's official site, if known with confidence. Omit otherwise." },
							tour_url: { type: 'string', description: "The band's tour/shows page, if known with confidence. Omit otherwise." },
							notes: { type: 'string', description: 'One or two sentences explaining the choice, stored as artists.resolution_notes.' },
							question: {
								type: 'string',
								description: 'Required when decision is "ambiguous" — a short did-you-mean question for the subscriber.',
							},
						},
						required: ['decision', 'notes'],
					},
				},
			],
			tool_choice: { type: 'tool', name: RESOLVE_TOOL_NAME },
		}),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Anthropic Messages API ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
	}

	const data = (await res.json()) as { content: Array<{ type: string; input?: unknown }> };
	const toolUse = data.content.find((block) => block.type === 'tool_use');
	if (!toolUse || typeof toolUse.input !== 'object' || toolUse.input === null) {
		throw new Error('Anthropic Messages API: response carried no tool_use block');
	}

	const input = toolUse.input as Record<string, unknown>;
	const decision = input.decision === 'ambiguous' ? 'ambiguous' : 'resolved';
	return {
		decision,
		mbid: typeof input.mbid === 'string' ? input.mbid : '',
		tm_attraction_id: typeof input.tm_attraction_id === 'string' ? input.tm_attraction_id : null,
		official_url: typeof input.official_url === 'string' ? input.official_url : null,
		tour_url: typeof input.tour_url === 'string' ? input.tour_url : null,
		notes: typeof input.notes === 'string' ? input.notes : '',
		question: typeof input.question === 'string' ? input.question : `Which "${queryName}" did you mean?`,
	};
}
