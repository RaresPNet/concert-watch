/**
 * Image pipeline (S4.3, DESIGN.md §10.4). Pulls an artist image from
 * whichever source produced the current event, falls back to Wikimedia
 * Commons for `coverage: 'dark'` artists, and caches the bytes in the
 * `IMAGES` R2 bucket. Records the resulting R2 key on `artists.image_url`
 * (or `.logo_url`) via `src/db/queries.ts` so the digest can read it later.
 *
 * No model is called anywhere in this file.
 *
 * ---
 *
 * On "whichever source the event came from" (DESIGN.md §10.4): as of S2.0
 * (`src/sources/types.ts`), `RawSourceEvent.image_url` is captured by an
 * adapter at fetch time but is dropped before it reaches `NormalisedEvent`
 * or `EventRow` — neither carries an image field (see S2.1's PROGRESS.md
 * entry, "Attraction-level images are fetched internally but not exposed
 * anywhere"). Rather than widen `NormalisedEvent`/`EventRow` for this step
 * (explicitly out of scope — "don't restructure S2.1/S2.0's types"), this
 * file's entry point takes an optional `sourceImageUrl` the *caller*
 * supplies while it still has a `RawSourceEvent` in hand (e.g. right after
 * `TicketmasterAdapter.fetchEvents()` returns, before the poll orchestrator
 * — S3.2, not yet built — normalises and discards it). That is "whichever
 * source the event came from" without a type change. Failing that, it falls
 * back to whatever is already sitting in `artists.image_url` (set at
 * add-time by S3.1's resolution pass per DESIGN.md §5, still a raw URL at
 * that point, not yet an R2 key), and finally to the Wikimedia fallback for
 * `dark` artists.
 *
 * On resizing: `wrangler.jsonc` has no Cloudflare Images binding and no
 * `nodejs_compat` flag (confirmed by reading the file directly), so there is
 * no bitmap-resizing primitive available to this Worker at all — adding one
 * would be a new binding, which is outside this step's touch list and not
 * "genuinely required" the way S1.3/S2.1's exceptions were, because a
 * cheaper option exists for the one source that actually needs it:
 *   - Ticketmaster already returns multiple pre-sized image variants per
 *     event (see `pickBestImage` in `src/sources/ticketmaster.ts`), so
 *     whatever URL a caller hands in here is already a reasonably-sized,
 *     source-picked image. No further resizing is attempted for it.
 *   - The Wikimedia Commons fallback is resized *at the source*: the
 *     MediaWiki `pageimages` API's `pithumbsize` parameter asks Wikimedia's
 *     own thumbnail service for an image already scaled to a given pixel
 *     width, rather than fetching the (often huge — 5000px+) original and
 *     resizing it ourselves. Verified live below.
 * This is "store at original size, flag resizing as not wired up" for the
 * general case (per the step's own "skip rather than ship a broken layout"
 * instruction) softened by the one place a real resize was available for
 * free.
 */

import { updateArtistImageKey, updateArtistLogoKey } from '../db/queries';
import type { ArtistRow } from '../db/schema';

/**
 * Wikimedia asks API consumers to identify themselves with a real contact
 * address (same convention as `src/sources/musicbrainz.ts`'s
 * `MUSICBRAINZ_USER_AGENT`, and the same real address).
 */
export const WIKIMEDIA_USER_AGENT = 'concert-watch/0.1 (raresp98@gmail.com)';

/** Pixel width requested from Wikimedia's thumbnail service — see file header. */
const DEFAULT_WIKIMEDIA_THUMB_WIDTH = 800;

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'image/svg+xml': 'svg',
};

export interface WikimediaImage {
	url: string;
	title: string;
	width: number | null;
	height: number | null;
}

/**
 * Finds a representative image for an artist via Wikipedia/Wikimedia
 * Commons — the fallback for `coverage: 'dark'` artists (DESIGN.md §10.4).
 *
 * Two real MediaWiki API calls, deliberately not one:
 *
 * 1. `action=opensearch` — a high-precision title lookup (prefix/near-title
 *    matching, the same engine behind Wikipedia's own search box
 *    suggestions), used only to resolve `artistName` to a canonical page
 *    title.
 * 2. `action=query&prop=pageimages` on that exact title, to read its lead
 *    image as a pre-sized thumbnail.
 *
 * A single-call `action=query&generator=search&prop=pageimages` (full-text
 * search) was tried first and rejected: querying a genuinely absent band
 * name ("Robin and the Backstabbers") returned "Music of Romania" as the
 * top hit — a real false positive, with no signal in the response to catch
 * it. `opensearch` on the same query returns no suggestion at all, the
 * correct answer. See PROGRESS.md's S4.3 entry for the live transcripts.
 */
export async function findWikimediaImage(
	artistName: string,
	opts?: { fetchImpl?: typeof fetch; thumbWidth?: number },
): Promise<WikimediaImage | null> {
	const fetchImpl = opts?.fetchImpl ?? fetch;
	const thumbWidth = opts?.thumbWidth ?? DEFAULT_WIKIMEDIA_THUMB_WIDTH;
	const name = artistName.trim();
	if (!name) return null;

	const searchUrl = new URL('https://en.wikipedia.org/w/api.php');
	searchUrl.search = new URLSearchParams({
		action: 'opensearch',
		search: name,
		limit: '1',
		namespace: '0',
		format: 'json',
	}).toString();

	const searchRes = await fetchImpl(searchUrl.toString(), { headers: { 'User-Agent': WIKIMEDIA_USER_AGENT } });
	if (!searchRes.ok) {
		throw new Error(`Wikipedia opensearch failed: ${searchRes.status} ${searchRes.statusText}`);
	}
	// opensearch's response shape is a 4-tuple: [query, titles[], descriptions[], urls[]].
	const searchJson = (await searchRes.json()) as [string, string[], string[], string[]];
	const title = searchJson?.[1]?.[0];
	if (!title) return null;

	const imageUrl = new URL('https://en.wikipedia.org/w/api.php');
	imageUrl.search = new URLSearchParams({
		action: 'query',
		titles: title,
		prop: 'pageimages',
		piprop: 'thumbnail',
		pithumbsize: String(thumbWidth),
		format: 'json',
		redirects: '1',
	}).toString();

	const imageRes = await fetchImpl(imageUrl.toString(), { headers: { 'User-Agent': WIKIMEDIA_USER_AGENT } });
	if (!imageRes.ok) {
		throw new Error(`Wikipedia pageimages failed: ${imageRes.status} ${imageRes.statusText}`);
	}
	const imageJson = (await imageRes.json()) as {
		query?: { pages?: Record<string, { title?: string; thumbnail?: { source?: string; width?: number; height?: number } }> };
	};
	const pages = imageJson.query?.pages ?? {};
	const page = Object.values(pages)[0];
	const thumb = page?.thumbnail;
	if (!thumb?.source) return null;

	return { url: thumb.source, title: page?.title ?? title, width: thumb.width ?? null, height: thumb.height ?? null };
}

export type ArtistImageResult =
	| { status: 'cached'; r2Key: string }
	| { status: 'stored'; r2Key: string; contentType: string; bytes: number; sourceUrl: string; via: 'source' | 'wikimedia' }
	| { status: 'skipped'; reason: string };

export interface FetchArtistImageOptions {
	fetchImpl?: typeof fetch;
	/**
	 * A raw image URL the caller already has in hand from whichever source
	 * produced the current event — e.g. a `RawSourceEvent.image_url` from a
	 * fresh Ticketmaster fetch. See file header for why this is a parameter
	 * rather than something read off `EventRow`.
	 */
	sourceImageUrl?: string | null;
	thumbWidth?: number;
	/** Re-fetch even if `artist.image_url` already looks like a cached R2 key. */
	force?: boolean;
}

function isHttpUrl(value: string | null | undefined): value is string {
	return !!value && /^https?:\/\//i.test(value);
}

/** R2 keys minted by this file always live under `artists/`; anything else is treated as a not-yet-cached raw URL. */
function isCachedKey(value: string | null | undefined): value is string {
	return !!value && value.startsWith('artists/');
}

async function downloadAndStore(
	images: R2Bucket,
	sourceUrl: string,
	key: string,
	fetchImpl: typeof fetch,
): Promise<{ ok: true; r2Key: string; contentType: string; bytes: number } | { ok: false; reason: string }> {
	let res: Response;
	try {
		res = await fetchImpl(sourceUrl, { headers: { 'User-Agent': WIKIMEDIA_USER_AGENT } });
	} catch (err) {
		return { ok: false, reason: `fetch threw: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!res.ok) {
		return { ok: false, reason: `fetch failed: ${res.status} ${res.statusText}` };
	}
	const contentType = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
	if (!contentType.startsWith('image/')) {
		return { ok: false, reason: `not an image (content-type "${contentType || 'unknown'}")` };
	}
	const bytes = await res.arrayBuffer();
	if (bytes.byteLength === 0) {
		return { ok: false, reason: 'empty response body' };
	}
	const ext = EXTENSION_BY_CONTENT_TYPE[contentType] ?? 'bin';
	const finalKey = `${key}.${ext}`;
	await images.put(finalKey, bytes, { httpMetadata: { contentType } });
	return { ok: true, r2Key: finalKey, contentType, bytes: bytes.byteLength };
}

/**
 * Fetches, caches (R2), and persists (D1) an artist's image. Never throws —
 * any failure (network, non-image response, no usable source at all) comes
 * back as `{ status: 'skipped', reason }` rather than blocking a caller's
 * larger batch, per DESIGN.md §10.4's "skip rather than ship a broken
 * layout."
 */
export async function fetchAndCacheArtistImage(
	db: D1Database,
	images: R2Bucket,
	artist: ArtistRow,
	opts: FetchArtistImageOptions = {},
): Promise<ArtistImageResult> {
	const fetchImpl = opts.fetchImpl ?? fetch;

	if (!opts.force && isCachedKey(artist.image_url)) {
		return { status: 'cached', r2Key: artist.image_url as string };
	}

	let resolved: { url: string; via: 'source' | 'wikimedia' } | null = null;
	if (isHttpUrl(opts.sourceImageUrl)) {
		resolved = { url: opts.sourceImageUrl, via: 'source' };
	} else if (isHttpUrl(artist.image_url)) {
		resolved = { url: artist.image_url, via: 'source' };
	} else if (artist.coverage === 'dark') {
		try {
			const wiki = await findWikimediaImage(artist.name, { fetchImpl, thumbWidth: opts.thumbWidth });
			if (wiki) resolved = { url: wiki.url, via: 'wikimedia' };
		} catch (err) {
			return { status: 'skipped', reason: `wikimedia lookup failed: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	if (!resolved) {
		return { status: 'skipped', reason: 'no usable image source (no source URL, artist is not dark, or wikimedia had no image)' };
	}

	const stored = await downloadAndStore(images, resolved.url, `artists/${artist.id}/image`, fetchImpl);
	if (!stored.ok) {
		return { status: 'skipped', reason: stored.reason };
	}

	await updateArtistImageKey(db, artist.id, stored.r2Key);
	return {
		status: 'stored',
		r2Key: stored.r2Key,
		contentType: stored.contentType,
		bytes: stored.bytes,
		sourceUrl: resolved.url,
		via: resolved.via,
	};
}

/**
 * Best-effort logo caching. Logos are explicitly optional per DESIGN.md
 * §10.4 ("Logos are fine to use; they are just awkward to lay out") — this
 * only reuses `artist.logo_url` if a source already set one (S3.1's
 * add-time resolution pass is the only writer of that column today; no
 * adapter currently surfaces a logo URL). There is no Wikimedia fallback for
 * logos: Commons has no reliable "artist logo" concept distinct from a
 * photo, and inventing a heuristic for it is exactly the disproportionate
 * effort this step is told to avoid. Never throws.
 */
export async function fetchAndCacheArtistLogo(
	db: D1Database,
	images: R2Bucket,
	artist: ArtistRow,
	opts: Pick<FetchArtistImageOptions, 'fetchImpl' | 'force'> = {},
): Promise<ArtistImageResult> {
	const fetchImpl = opts.fetchImpl ?? fetch;

	if (!opts.force && isCachedKey(artist.logo_url)) {
		return { status: 'cached', r2Key: artist.logo_url as string };
	}
	if (!isHttpUrl(artist.logo_url)) {
		return { status: 'skipped', reason: 'no logo_url set for this artist' };
	}

	const stored = await downloadAndStore(images, artist.logo_url, `artists/${artist.id}/logo`, fetchImpl);
	if (!stored.ok) {
		return { status: 'skipped', reason: stored.reason };
	}

	await updateArtistLogoKey(db, artist.id, stored.r2Key);
	return {
		status: 'stored',
		r2Key: stored.r2Key,
		contentType: stored.contentType,
		bytes: stored.bytes,
		sourceUrl: artist.logo_url,
		via: 'source',
	};
}
