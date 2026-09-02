/**
 * MCP endpoint (IMPLEMENTATION_PLAN.md S4.7, DESIGN.md §3/§6.4). The surface
 * a Claude scheduled task talks to over MCP to do every piece of
 * scheduled/autonomous work on app quota rather than a billed API key: the
 * daily digest, the `dark`-artist search sweep, tour-page parsing when no
 * JSON-LD is present, the monthly reachability refresh, and (implicitly,
 * via `submit_sweep_results`/`submit_parsed_events`) the events an add-time
 * or sweep-time resolution pass finds. Nothing in this file ever calls the
 * Anthropic API itself -- it is the *target* MCP tools are called against,
 * not a caller of anything model-shaped.
 *
 * SDK choice (this repo had zero runtime dependencies before this step --
 * flagged prominently below and in PROGRESS.md, following S1.3's precedent
 * for a pre-authorized cross-cutting deviation). Implementing the MCP
 * Streamable HTTP JSON-RPC protocol by hand would be a large, easy-to-get-
 * subtly-wrong undertaking for no benefit over a maintained SDK, so
 * `@modelcontextprotocol/server` (published 2.0.0, the current "v2"
 * TypeScript SDK line at ts.sdk.modelcontextprotocol.io/v2/, fetched
 * 2026-09-02 -- NOT the older, heavier `@modelcontextprotocol/sdk` package,
 * which pulls in `express`/`hono`/`@hono/node-server` as dependencies and is
 * clearly Node-server-oriented) was added instead. This package ships a
 * dedicated `shimsWorkerd` build and a `createMcpHandler()` entry point
 * whose own docs list Cloudflare Workers as a first-class target -- exactly
 * this file's runtime, with no Node-specific APIs anywhere in the request
 * path. Its `WebStandardStreamableHTTPServerTransport` (which
 * `createMcpHandler` builds and drives internally) implements the
 * Streamable HTTP transport spec entirely on Fetch API primitives
 * (`Request`/`Response`/`ReadableStream`), confirmed by reading the actual
 * shipped `.d.mts` declarations in `node_modules/@modelcontextprotocol/server`
 * (not from training-data memory of the older SDK's Node-only transport
 * shape) plus the package's own hosted docs. Verified real: a published,
 * installable version (not a prerelease guess) -- `npm view
 * @modelcontextprotocol/server versions` lists `2.0.0` as the latest stable
 * release.
 *
 * Server shape. `createMcpHandler(factory, options)` takes a per-request
 * `McpServerFactory` -- "a fresh McpServer serves every call" is the
 * documented model, which suits this endpoint well: each call already pays
 * a D1 round trip or two, so re-registering eight cheap tool definitions
 * per request is not a meaningful cost, and it means no MCP-SDK state is
 * ever held across requests in the Worker's global scope (nothing to get
 * subtly stale between an isolate's requests). `buildMcpServer` below is
 * that factory, closing over the `D1Database` and the handful of env values
 * each tool needs (the mailer's from-address, the budget ceiling) rather
 * than threading them through `McpRequestContext`.
 */

import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
	countPendingNotifications,
	deletePendingPageParse,
	getAllPendingPageParses,
	getAllSourceHealth,
	getArtistById,
	getDarkArtists,
	getPendingNotificationsForSubscriber,
	getSubscriberById,
	getTotalSpend,
	markNotificationSent,
	touchArtistActivity,
	touchArtistPolled,
	upsertOrigin,
	upsertReachability,
} from '../db/queries';
import type { ArtistRow, ReachabilityTier } from '../db/schema';
import { buildDigestPayload } from '../digest/payload';
import { CloudflareMailer } from '../mail/cloudflare';
import { persistRawEvent, type PollEventOutcome } from '../core/poll';
import { getBudgetStatus } from '../model/budget';
import type { RawSourceEvent } from '../sources/types';

// ---------------------------------------------------------------------------
// Env slice this file needs. Deliberately narrower than the generated `Env`
// (worker-configuration.d.ts) and, for `MCP_AUTH_TOKEN`/`DIGEST_FROM_ADDRESS`,
// wider than it -- those two are read as plain wrangler secrets/vars that
// aren't declared as bindings in `wrangler.jsonc`, matching the existing
// `(env as any).ANTHROPIC_API_KEY` / `TICKETMASTER_API_KEY` convention
// already used by `src/index.ts` and `src/core/resolve.ts` for exactly the
// same reason (a secret needs no static binding declaration to exist at
// runtime, and `wrangler types` has nothing to generate for it). See
// PROGRESS.md for why this file doesn't touch `wrangler.jsonc`.
// ---------------------------------------------------------------------------
export interface McpEnv {
	DB: D1Database;
	EMAIL: SendEmail;
	MCP_AUTH_TOKEN?: string;
	MODEL_MONTHLY_CEILING_USD?: string;
	/** Overrides the default `From` address for `submit_digest`'s send. */
	DIGEST_FROM_ADDRESS?: string;
}

const DEFAULT_FROM_ADDRESS = 'concert-watch@raresp.net'; // the domain S1.3 already verified a real send against
const DIGEST_SUBJECT = 'Concert watch digest';

// ---------------------------------------------------------------------------
// Shared zod schemas
// ---------------------------------------------------------------------------

/**
 * One submitted event, mirroring `RawSourceEvent` (src/sources/types.ts)
 * minus `source`/`source_event_id`'s implicit trust: `source` is NOT taken
 * from the caller here (both `submit_sweep_results` and
 * `submit_parsed_events` stamp their own fixed `source` value onto every
 * event they persist -- 'dark_sweep' / 'tourpage' respectively -- rather
 * than letting the model assert an arbitrary source name for data it found
 * itself). Every field otherwise matches `RawSourceEvent` so the payload
 * this schema accepts is exactly what `normaliseEvent` (S2.0) already knows
 * how to turn into an `events` row -- no separate translation layer.
 */
const submittedEventSchema = z.object({
	source_event_id: z.string(),
	starts_at: z.string(), // ISO 8601, at least a YYYY-MM-DD prefix -- see normalise.ts's extractDate
	timezone: z.string().nullable().optional(),
	city: z.string(),
	country: z.string().length(2), // ISO 3166-1 alpha-2, per RawSourceEvent's own contract
	venue_name: z.string().nullable().optional(),
	lat: z.number().nullable().optional(),
	lon: z.number().nullable().optional(),
	onsale_at: z.string().nullable().optional(),
	presale_at: z.string().nullable().optional(),
	ticket_url: z.string().nullable().optional(),
	status: z.enum(['active', 'cancelled', 'postponed']).optional(),
});

type SubmittedEvent = z.infer<typeof submittedEventSchema>;

function textResult(payload: unknown): { content: [{ type: 'text'; text: string }] } {
	return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string): { content: [{ type: 'text'; text: string }]; isError: true } {
	return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Shared persistence path for `submit_sweep_results` and
 * `submit_parsed_events` (DESIGN.md's "submitted events go through the same
 * normaliser as S2.0 -- the model never writes directly to `events`"). Both
 * tools call this rather than touching `normaliseEvent`/`upsertEventByFingerprint`
 * directly: it's the exact same normalise -> upsert-by-fingerprint ->
 * classify sequence `src/core/poll.ts`'s daily pass already runs for every
 * other source, now exported from there (`persistRawEvent`) specifically so
 * this file doesn't re-implement it. `upsertEventByFingerprint` (S1.1) is an
 * `ON CONFLICT (fingerprint) DO UPDATE`, so re-submitting the same event
 * (same artist/date/city -> same fingerprint) is inherently idempotent: a
 * repeat call updates the existing row in place rather than duplicating it,
 * per this step's "every submission is idempotent" requirement.
 */
async function persistSubmittedEvents(
	db: D1Database,
	artist: ArtistRow,
	events: SubmittedEvent[],
	source: RawSourceEvent['source'],
): Promise<{ inserted: number; changed: number; unchanged: number; quarantined: number }> {
	const counts = { inserted: 0, changed: 0, unchanged: 0, quarantined: 0 };
	let anyActivity = false;

	for (const e of events) {
		const raw: RawSourceEvent = {
			source,
			source_event_id: e.source_event_id,
			starts_at: e.starts_at,
			timezone: e.timezone ?? null,
			city: e.city,
			country: e.country,
			venue_name: e.venue_name ?? null,
			lat: e.lat ?? null,
			lon: e.lon ?? null,
			onsale_at: e.onsale_at ?? null,
			presale_at: e.presale_at ?? null,
			ticket_url: e.ticket_url ?? null,
			status: e.status,
		};
		const outcome: PollEventOutcome = await persistRawEvent(db, raw, artist);
		counts[outcome.kind]++;
		if (outcome.kind === 'inserted' || outcome.kind === 'changed') anyActivity = true;
	}

	const nowIso = new Date().toISOString();
	await touchArtistPolled(db, artist.id, nowIso);
	if (anyActivity) await touchArtistActivity(db, artist.id, nowIso);

	return counts;
}

// ---------------------------------------------------------------------------
// Server factory -- see file header for why this is per-request.
// ---------------------------------------------------------------------------

export function buildMcpServer(db: D1Database, env: McpEnv): McpServer {
	const server = new McpServer({ name: 'concert-watch', version: '1.0.0' });

	// -- get_pending_digest(subscriber) -------------------------------------
	server.registerTool(
		'get_pending_digest',
		{
			description:
				"The structured digest payload for one subscriber (S4.1's buildDigestPayload): tour blocks, reachability, " +
				"affordances. { send: false } when there is nothing pending -- DESIGN.md §10's \"no 'nothing new today' mail\" " +
				'means this is the normal, common result, not an error.',
			inputSchema: z.object({ subscriber_id: z.number().int().positive() }),
		},
		async ({ subscriber_id }) => {
			const result = await buildDigestPayload(db, subscriber_id);
			return textResult(result);
		},
	);

	// -- submit_digest(subscriber, html, text) ------------------------------
	server.registerTool(
		'submit_digest',
		{
			description:
				"Hands back the rendered HTML/text for a subscriber's pending digest; the Worker sends it via the " +
				"configured mailer and marks the covered notifications' sent_at once delivery is confirmed. Idempotent: " +
				're-submitting after a successful send is a no-op ({ sent: false, reason: "no_pending_notifications" }), ' +
				'since the covering notifications no longer have sent_at IS NULL.',
			inputSchema: z.object({
				subscriber_id: z.number().int().positive(),
				html: z.string().min(1),
				text: z.string().min(1),
			}),
		},
		async ({ subscriber_id, html, text }) => {
			const subscriber = await getSubscriberById(db, subscriber_id);
			if (!subscriber) return errorResult(`submit_digest: no subscriber with id ${subscriber_id}`);

			// Idempotency guard (this step's own "every submission is
			// idempotent" requirement, applied per its own suggested signal):
			// the covering notifications are the ones with sent_at IS NULL
			// right now. If there aren't any, either nothing was ever pending
			// for this subscriber, or a prior submit_digest call already sent
			// this exact digest and marked them -- either way, sending again
			// would be a duplicate. There is deliberately no separate
			// "already sent this content" hash check: sent_at IS NULL is the
			// single source of truth DESIGN.md §9.3 already establishes for
			// "has this been delivered," so re-deriving a second signal here
			// would just be two ways to get the same answer, with room for
			// them to disagree.
			const pending = await getPendingNotificationsForSubscriber(db, subscriber_id);
			if (pending.length === 0) {
				return textResult({ sent: false, reason: 'no_pending_notifications' });
			}

			if (!subscriber.verified_at) {
				return errorResult(
					`submit_digest: subscriber ${subscriber_id} (${subscriber.email}) has no verified_at -- refusing to send ` +
						'per DESIGN.md §3 (Workers Free plan requires a verified Email Routing destination).',
				);
			}

			const fromAddress = env.DIGEST_FROM_ADDRESS ?? DEFAULT_FROM_ADDRESS;
			const mailer = new CloudflareMailer(env.EMAIL, {
				from: fromAddress,
				// Narrow, single-recipient guard rather than a full subscriber
				// table scan (src/mail/cloudflare.ts's own doc comment
				// anticipates exactly this shape of caller-supplied predicate) --
				// this call only ever sends to the one subscriber it already
				// loaded and already checked verified_at for.
				isVerifiedRecipient: (email) => email === subscriber.email,
			});

			let sendResult: { messageId: string };
			try {
				sendResult = await mailer.send({ to: subscriber.email, subject: DIGEST_SUBJECT, html, text });
			} catch (err) {
				// DESIGN.md §9.3: sent_at is set ONLY after delivery is
				// confirmed. A failed/rejected send must leave every pending
				// notification untouched so the next attempt (a retried MCP
				// call, or eventually S4.8's 36h fallback) still sees them as
				// pending -- nothing is marked here on this path.
				return errorResult(`submit_digest: send failed: ${err instanceof Error ? err.message : String(err)}`);
			}

			// Delivery confirmed (a real messageId came back from the
			// binding, never merely assumed -- DESIGN.md §3.1's point that
			// Email Routing's own summary UI reports Worker-sent mail as
			// "dropped" even on success, so the binding's return value, not
			// any routing-side signal, is what's trusted here). Only now is
			// sent_at written, exactly for the set of notifications this
			// digest was built from.
			const sentAt = new Date().toISOString();
			for (const n of pending) {
				await markNotificationSent(db, n.id, sentAt);
			}

			return textResult({ sent: true, messageId: sendResult.messageId, notification_ids: pending.map((n) => n.id) });
		},
	);

	// -- get_sweep_targets() -------------------------------------------------
	server.registerTool(
		'get_sweep_targets',
		{
			description:
				'Every `dark`-coverage artist due a Claude search sweep (DESIGN.md §6.2/§6.4). At this scale (§6.3: ' +
				'"every artist is polled every day," no rotation) this is every dark artist, unfiltered by last_polled_at ' +
				'-- see PROGRESS.md for why no staleness filtering was added.',
			inputSchema: z.object({}),
		},
		async () => {
			const artists = await getDarkArtists(db);
			return textResult({
				targets: artists.map((a) => ({
					artist_id: a.id,
					name: a.name,
					official_url: a.official_url,
					tour_url: a.tour_url,
					last_polled_at: a.last_polled_at,
					last_activity_at: a.last_activity_at,
				})),
			});
		},
	);

	// -- submit_sweep_results(artist_id, events) -----------------------------
	server.registerTool(
		'submit_sweep_results',
		{
			description:
				'Normalised events the search sweep found for one dark artist. Runs through the same normaliser/fingerprint ' +
				'upsert as the daily poll (src/sources/normalise.ts, src/core/poll.ts) -- the model never writes to `events` ' +
				"directly. Idempotent via upsertEventByFingerprint's ON CONFLICT. Does NOT cluster into tours or decide " +
				'notifications -- that happens in the same pass the daily poll itself feeds (S3.3), not here, matching ' +
				"poll.ts's own event/cluster/notify separation.",
			inputSchema: z.object({
				artist_id: z.number().int().positive(),
				events: z.array(submittedEventSchema),
			}),
		},
		async ({ artist_id, events }) => {
			const artist = await getArtistById(db, artist_id);
			if (!artist) return errorResult(`submit_sweep_results: no artist with id ${artist_id}`);
			const outcome = await persistSubmittedEvents(db, artist, events, 'dark_sweep');
			return textResult(outcome);
		},
	);

	// -- get_unparsed_pages() -------------------------------------------------
	server.registerTool(
		'get_unparsed_pages',
		{
			description:
				"Tour pages that changed but carried no usable JSON-LD MusicEvent data (src/sources/tourpage.ts's " +
				'needs_model_parse result, durably queued in `pending_page_parses` -- migrations/0003). HTML is capped at ' +
				`${MAX_HTML_CHARS.toLocaleString()} characters per page as a safety margin before it can reach a model, ` +
				'per DESIGN.md §12.4\'s "truncate any fetched page to a fixed byte ceiling before it can reach a model."',
			inputSchema: z.object({}),
		},
		async () => {
			const rows = await getAllPendingPageParses(db);
			const pages = [];
			for (const row of rows) {
				const artist = await getArtistById(db, row.artist_id);
				pages.push({
					artist_id: row.artist_id,
					artist_name: artist?.name ?? null,
					tour_url: row.tour_url,
					hash: row.hash,
					queued_at: row.queued_at,
					html: truncateHtml(row.html),
					html_truncated: row.html.length > MAX_HTML_CHARS,
				});
			}
			return textResult({ pages });
		},
	);

	// -- submit_parsed_events(artist_id, events) -----------------------------
	server.registerTool(
		'submit_parsed_events',
		{
			description:
				"Events extracted by a model parse of one artist's tour page (from get_unparsed_pages). Same normaliser/" +
				"upsert path as submit_sweep_results. Clears that artist's pending_page_parses row on success -- a repeat " +
				'call after that (idempotent) is just a no-op deletion the second time.',
			inputSchema: z.object({
				artist_id: z.number().int().positive(),
				events: z.array(submittedEventSchema),
			}),
		},
		async ({ artist_id, events }) => {
			const artist = await getArtistById(db, artist_id);
			if (!artist) return errorResult(`submit_parsed_events: no artist with id ${artist_id}`);
			const outcome = await persistSubmittedEvents(db, artist, events, 'tourpage');
			await deletePendingPageParse(db, artist_id);
			return textResult(outcome);
		},
	);

	// -- refresh_reachability(rows) -------------------------------------------
	server.registerTool(
		'refresh_reachability',
		{
			description:
				'Monthly reachability refresh (DESIGN.md §7): persists precomputed origin/reachability rows into D1. Tier ' +
				"derivation itself happens on the caller's side (the app-quota Claude run, per §7's \"refreshed monthly by " +
				'a Claude run"); this tool only upserts whatever it\'s handed, the same idempotent upserts scripts/seed-' +
				'reach.ts (S1.2) already uses.',
			inputSchema: z.object({
				origins: z
					.array(
						z.object({
							iata: z.string().length(3),
							name: z.string(),
							drive_km: z.number().nullable().optional(),
							drive_minutes: z.number().nullable().optional(),
							penalty_minutes: z.number().nullable().optional(),
						}),
					)
					.optional(),
				reachability: z.array(
					z.object({
						city_key: z.string(),
						origin_iata: z.string().length(3),
						tier: z.enum(['A', 'B', 'C', 'D']),
						route_note: z.string().nullable().optional(),
					}),
				),
			}),
		},
		async ({ origins, reachability }) => {
			for (const o of origins ?? []) {
				await upsertOrigin(db, {
					iata: o.iata,
					name: o.name,
					drive_km: o.drive_km ?? null,
					drive_minutes: o.drive_minutes ?? null,
					penalty_minutes: o.penalty_minutes ?? null,
				});
			}
			for (const r of reachability) {
				await upsertReachability(db, {
					city_key: r.city_key,
					origin_iata: r.origin_iata,
					tier: r.tier as ReachabilityTier,
					route_note: r.route_note ?? null,
				});
			}
			return textResult({ origins_upserted: origins?.length ?? 0, reachability_upserted: reachability.length });
		},
	);

	// -- status() --------------------------------------------------------------
	server.registerTool(
		'status',
		{
			description:
				'Source health, spend to date, and pending-work counts -- the at-a-glance operational snapshot for the ' +
				'scheduled task to check before/after doing its work.',
			inputSchema: z.object({}),
		},
		async () => {
			const [sourceHealth, darkArtists, pendingNotifications, pendingPageParses, budgetStatus, totalSpend] = await Promise.all([
				getAllSourceHealth(db),
				getDarkArtists(db),
				countPendingNotifications(db),
				getAllPendingPageParses(db),
				getBudgetStatus(db, env, new Date()),
				getTotalSpend(db),
			]);
			return textResult({
				source_health: sourceHealth,
				dark_artist_count: darkArtists.length,
				pending_notifications: pendingNotifications,
				pending_page_parses: pendingPageParses.length,
				spend: {
					month_to_date_usd: budgetStatus.monthToDateCost,
					monthly_ceiling_usd: budgetStatus.ceiling,
					over_budget: budgetStatus.overBudget,
					total_to_date_usd: totalSpend,
				},
			});
		},
	);

	return server;
}

const MAX_HTML_CHARS = 200_000;

function truncateHtml(html: string): string {
	return html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
}

// ---------------------------------------------------------------------------
// HTTP wiring -- bearer token in the URL path, per this step's own
// instruction ("as kindle-digest does"). Shape: POST /mcp/<token>.
//
// 401 vs 404 on mismatch (the step leaves this as "your choice, document
// it"): this returns 404. A 401 confirms to anyone probing the URL that
// *something* protected lives at /mcp/<anything>, inviting further guessing;
// a 404 makes an unauthenticated request indistinguishable from a route that
// doesn't exist at all, which is the stronger posture for an endpoint that
// -- unlike a normal API needing a login flow -- has no legitimate anonymous
// caller to serve a helpful 401 to in the first place.
// ---------------------------------------------------------------------------

const MCP_PATH_PREFIX = '/mcp/';

/**
 * Builds a fresh MCP HTTP handler bound to this request's `env` and returns
 * its response. Called only after `routeMcpRequest` has already verified the
 * bearer token, so it performs no auth itself.
 */
export async function handleMcpRequest(request: Request, env: McpEnv): Promise<Response> {
	const handler = createMcpHandler(() => buildMcpServer(env.DB, env));
	return handler.fetch(request);
}

/**
 * Entry point wired into the Worker's `fetch` handler (see `src/index.ts`).
 * Returns `null` for any request outside the `/mcp/` path so the caller can
 * fall through to its other routes unchanged; returns a `Response` (success
 * or the 404 auth rejection) for anything under it.
 */
export async function routeMcpRequest(request: Request, env: McpEnv): Promise<Response | null> {
	const url = new URL(request.url);
	if (!url.pathname.startsWith(MCP_PATH_PREFIX)) return null;

	const token = url.pathname.slice(MCP_PATH_PREFIX.length).split('/')[0];
	const expected = env.MCP_AUTH_TOKEN;
	if (!expected || !token || token !== expected) {
		return new Response('Not found', { status: 404 });
	}

	return handleMcpRequest(request, env);
}
