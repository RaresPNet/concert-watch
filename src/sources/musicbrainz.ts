/**
 * MusicBrainz artist lookup (S2.4). Name -> candidate MBIDs with
 * disambiguation strings, for S3.1's (not yet built) artist resolution
 * pass to reason/choose over. This is deliberately NOT a `SourceAdapter`
 * (src/sources/types.ts) -- MusicBrainz is a name-resolution lookup, not
 * an event source, per that file's own `SourceName` comment.
 *
 * API shape verified live against https://musicbrainz.org/ws/2/artist/
 * (fmt=json) on 2026-09-01 -- see PROGRESS.md's S2.4 entry for the real
 * request/response pairs this was checked against, plus
 * https://musicbrainz.org/doc/MusicBrainz_API/Search and
 * https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting for the
 * documented contract (query params, User-Agent requirement, 1 req/sec).
 */

const MUSICBRAINZ_ARTIST_SEARCH_URL = 'https://musicbrainz.org/ws/2/artist/';

/**
 * MusicBrainz requires a descriptive User-Agent identifying the
 * application and a contact (email or URL) -- see
 * https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting. Generic or
 * missing User-Agent strings get throttled harder or blocked.
 *
 * Contact is the project owner's real address (raresp98@gmail.com), per
 * MusicBrainz's own recommended "Application/version ( contact )" form.
 */
export const MUSICBRAINZ_USER_AGENT = 'concert-watch/0.1 (raresp98@gmail.com)';

/** MusicBrainz's documented limit for unauthenticated/standard use. */
const MIN_REQUEST_INTERVAL_MS = 1000;

/**
 * MusicBrainz's search index occasionally returns a transient 503 ("server
 * is currently busy") under normal load -- observed live during S2.4's own
 * verification and again during S3.1's live resolve.ts testing (a genuine,
 * not hypothetical, failure). These statuses are worth one retry with
 * backoff; anything else (4xx other than 429, a genuine query problem) is
 * not retried.
 */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 1000;

/**
 * One candidate artist returned by a MusicBrainz name search, trimmed to
 * the fields S3.1's disambiguation step needs to show/reason over.
 * `mbid` is MusicBrainz's `id` field, renamed here to match this
 * project's own naming (`artists.mbid` in src/db/schema.ts).
 */
export interface MusicBrainzArtistCandidate {
	mbid: string;
	name: string;
	sortName: string;
	/** Free-text disambiguation MusicBrainz attaches when multiple artists
	 * share a name, e.g. "post-punk" or "German trance duo". Absent on
	 * artists with no ambiguity to note. */
	disambiguation: string | null;
	/** MusicBrainz's own relevance score for this query, 0-100. */
	score: number;
	/** "Person", "Group", "Orchestra", etc. Absent for some sparse entries. */
	type: string | null;
	/** ISO 3166-1 alpha-2, from the artist's associated area/country. Absent
	 * for many entries -- MusicBrainz doesn't require it. */
	country: string | null;
	/** Year (or full date) the artist began, if known. */
	beginDate: string | null;
	/** Year (or full date) the artist ended, if known and applicable. */
	endDate: string | null;
}

export interface MusicBrainzLookupOptions {
	/** Max candidates to return. MusicBrainz allows 1-100; defaults to 10,
	 * which is plenty for a disambiguation UI/prompt. */
	limit?: number;
	/** Overrides the module-level throttle (mainly for tests). */
	minRequestIntervalMs?: number;
}

/** Raw shape of one element of the `artists` array in a MusicBrainz
 * `GET /ws/2/artist/?fmt=json` response, trimmed to the fields this file
 * reads. Confirmed live 2026-09-01 (see PROGRESS.md) against real
 * responses for "IDLES" and "Chrome". */
interface MusicBrainzApiArtist {
	id: string;
	name: string;
	'sort-name': string;
	disambiguation?: string;
	score?: number | string;
	type?: string;
	country?: string;
	'life-span'?: {
		begin?: string;
		end?: string;
	};
}

interface MusicBrainzApiResponse {
	created: string;
	count: number;
	offset: number;
	artists: MusicBrainzApiArtist[];
}

/** Escapes Lucene special characters in a raw artist name so it can be
 * safely embedded in a MusicBrainz `query=` search term. MusicBrainz's
 * search syntax is Lucene-based (see MusicBrainz_API/Search); without
 * this, names containing e.g. `+`, `"`, `(`, `)`, `:` can throw off the
 * query parser or be interpreted as field/operator syntax. */
function escapeLuceneQuery(value: string): string {
	return value.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');
}

let lastRequestAt = 0;

/** Waits, if needed, so the next fetch is at least `minIntervalMs` after
 * the previous one -- MusicBrainz's documented 1 request/second limit for
 * unauthenticated/standard use. Module-scoped, so it throttles across all
 * callers sharing this module, not just calls on one lookup instance. */
async function throttle(minIntervalMs: number): Promise<void> {
	const now = Date.now();
	const elapsed = now - lastRequestAt;
	const wait = minIntervalMs - elapsed;
	if (wait > 0) {
		await new Promise((resolve) => setTimeout(resolve, wait));
	}
	lastRequestAt = Date.now();
}

function toCandidate(artist: MusicBrainzApiArtist): MusicBrainzArtistCandidate {
	const rawScore = artist.score;
	const score = typeof rawScore === 'string' ? Number(rawScore) : (rawScore ?? 0);
	return {
		mbid: artist.id,
		name: artist.name,
		sortName: artist['sort-name'],
		disambiguation: artist.disambiguation ?? null,
		score: Number.isFinite(score) ? score : 0,
		type: artist.type ?? null,
		country: artist.country ?? null,
		beginDate: artist['life-span']?.begin ?? null,
		endDate: artist['life-span']?.end ?? null,
	};
}

/**
 * Looks up candidate MusicBrainz artists for a free-text name, e.g. from a
 * subscriber's watchlist request. Returns MusicBrainz's own ranked
 * candidate list (highest `score` first, as the API already sorts them) --
 * picking *the* right one is S3.1's job (model-assisted disambiguation),
 * not this function's.
 *
 * Throttled to at most one request/second across all calls in this
 * process (MusicBrainz's documented limit); a call that arrives sooner
 * than that will `await` until it's safe to send.
 */
export async function lookupArtistCandidates(name: string, options: MusicBrainzLookupOptions = {}): Promise<MusicBrainzArtistCandidate[]> {
	const trimmed = name.trim();
	if (trimmed.length === 0) {
		return [];
	}

	const limit = options.limit ?? 10;
	const minIntervalMs = options.minRequestIntervalMs ?? MIN_REQUEST_INTERVAL_MS;

	const url = new URL(MUSICBRAINZ_ARTIST_SEARCH_URL);
	url.searchParams.set('query', `artist:${escapeLuceneQuery(trimmed)}`);
	url.searchParams.set('fmt', 'json');
	url.searchParams.set('limit', String(limit));

	let lastError: Error | undefined;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		await throttle(minIntervalMs);

		const response = await fetch(url.toString(), {
			headers: {
				'User-Agent': MUSICBRAINZ_USER_AGENT,
				Accept: 'application/json',
			},
		});

		if (response.ok) {
			const body = (await response.json()) as MusicBrainzApiResponse;
			return (body.artists ?? []).map(toCandidate);
		}

		lastError = new Error(`MusicBrainz artist search failed: ${response.status} ${response.statusText} for query "${trimmed}"`);
		if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_ATTEMPTS) {
			throw lastError;
		}
		// Exponential backoff on top of the standard throttle -- 1s, then 2s.
		await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS * attempt));
	}

	// Unreachable (the loop always returns or throws), but keeps TypeScript
	// happy about every code path returning.
	throw lastError ?? new Error(`MusicBrainz artist search failed for query "${trimmed}"`);
}
