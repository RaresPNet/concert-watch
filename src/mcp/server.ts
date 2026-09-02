/**
 * MCP endpoint (IMPLEMENTATION_PLAN.md S4.7, DESIGN.md §3/§6.4). The surface
 * a Claude scheduled task talks to over MCP to do every piece of
 * scheduled/autonomous work on app quota rather than a billed API key: the
 * daily digest, the `dark`-artist search sweep, tour-page parsing when no
 * JSON-LD is present, the quarterly reachability refresh, and (implicitly,
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
	deleteOrigin,
	deletePendingPageParse,
	deleteReachability,
	getAllPendingPageParses,
	getAllSourceHealth,
	getArtistById,
	getDarkArtists,
	getPendingNotificationsForSubscriber,
	getReachabilityByOrigin,
	getSubscriberByMcpToken,
	getSubscriberById,
	getTotalSpend,
	markNotificationSent,
	setSubscriberMcpToken,
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
import { AGENT_TOOLS, callAgentTool, createWebSearchState, type AgentToolContext } from '../agent/tools';

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
	/**
	 * S5.3: the same two secrets `src/index.ts`'s `/__test-resolve` route
	 * already reads off `env as any` for `resolveArtist`. The subscriber-
	 * scoped agent tools (`add_artist` via `resolveArtist`, `web_search`) need
	 * both to do real work; without them those two tools fail at call time
	 * rather than at startup, same as every other place this repo threads an
	 * unset secret through.
	 */
	ANTHROPIC_API_KEY?: string;
	TICKETMASTER_API_KEY?: string;
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
				'Returns the concerts waiting to be told to one subscriber, grouped by tour with travel options attached. ' +
				"Returns { send: false } when nothing is waiting -- that's normal and common; most days there's nothing.",
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
				"Sends a subscriber's pending digest by email using the given HTML and plain-text content, then marks the " +
				"concerts it covered as delivered so they won't be included in a future digest. Idempotent: calling this " +
				'again after a successful send is a no-op ({ sent: false, reason: "no_pending_notifications" }), since ' +
				'there is nothing left pending to send.',
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
				'Artists with no reliable automated source for their tour dates, so a live web search sweep is the only ' +
				'way to find out what is on for them. Returns every such artist due for a sweep -- at the current scale ' +
				"that's every artist tracked this way, not filtered by how recently each was last checked, so the same " +
				'list can come back day after day if nothing has changed.',
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
				'Submits events a web-search sweep found for one artist, to be stored the same way any other discovered ' +
				'date is. Safe to call more than once with the same events -- resubmitting an event already on file ' +
				'updates it in place rather than duplicating it. Does not group dates into tours or decide who gets ' +
				'notified about them; that happens in a separate, later pass.',
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
				'Tour pages that recently changed but whose content could not be automatically read as structured event data, ' +
				'so a person (or model) needs to read the page text and pull out the dates by hand. Each entry includes the ' +
				`page's raw HTML, truncated to ${MAX_HTML_CHARS.toLocaleString()} characters if the page is very large, as a ` +
				'safety margin.',
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
				"Submits events extracted by reading one artist's tour page (the pages returned by get_unparsed_pages), " +
				'to be stored the same way any other discovered date is. Also marks that page as handled so it stops ' +
				'showing up in get_unparsed_pages. Safe to call more than once for the same page.',
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

	// -- get_current_routes(origin_iata?) -------------------------------------
	server.registerTool(
		'get_current_routes',
		{
			description:
				"Scheduled-task only. The travel-reachability data currently on file for one origin airport's routes -- " +
				'destination city, a difficulty tier from A (easy) to D (hard), and a human-readable note naming the ' +
				'airline and roughly how often it flies (e.g. "direct CLJ→LBA, Wizz Air, ~3/wk"). Call this before ' +
				'researching a reachability refresh so only what actually changed needs submitting to refresh_reachability, ' +
				'instead of re-researching every route from scratch each time. Pass origin_iata (e.g. "CLJ") to work one ' +
				'airport at a time -- all origins together can be several hundred rows, too much to return unfiltered in ' +
				'one call.',
			inputSchema: z.object({
				origin_iata: z
					.string()
					.length(3)
					.optional()
					.describe('Three-letter IATA airport code, e.g. "CLJ". Omit only if you actually want every origin at once.'),
			}),
		},
		async ({ origin_iata }) => {
			const rows = await getReachabilityByOrigin(db, origin_iata);
			return textResult({
				origin_iata: origin_iata ?? null,
				count: rows.length,
				routes: rows.map((r) => ({
					origin_iata: r.origin_iata,
					destination_city_key: r.city_key,
					tier: r.tier,
					route_note: r.route_note,
					computed_at: r.computed_at,
				})),
			});
		},
	);

	// -- refresh_reachability(rows) -------------------------------------------
	server.registerTool(
		'refresh_reachability',
		{
			description:
				'Refreshes the travel-reachability data on file. Meant to be run roughly once a quarter -- airline route ' +
				'networks mostly change at the seasonal schedule changes in late March and late October, so a monthly pass ' +
				'would mostly just re-confirm nothing moved. This is a PARTIAL update: pass only the rows that changed ' +
				'since the last refresh (call get_current_routes first to see what is already on file), not the full set. ' +
				"Researching what a route's tier and note should be happens before calling this tool; this tool only saves " +
				"or deletes whatever it's given. To add or update a route, put a row in origins/reachability; to remove a " +
				'route that no longer exists (simply leaving it out of the submitted rows is NOT read as "removed" -- it ' +
				'only means "unchanged"), put its {city_key, origin_iata} in remove_reachability, or its iata code in ' +
				'remove_origins if an entire origin airport is gone.',
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
					.optional()
					.describe('Origins to add or update. Omit or leave empty if only reachability rows changed.'),
				reachability: z
					.array(
						z.object({
							city_key: z.string(),
							origin_iata: z.string().length(3),
							tier: z.enum(['A', 'B', 'C', 'D']),
							route_note: z.string().nullable().optional(),
						}),
					)
					.optional()
					.describe('Reachability rows to add or update -- only the ones that changed, not the full table.'),
				remove_reachability: z
					.array(z.object({ city_key: z.string(), origin_iata: z.string().length(3) }))
					.optional()
					.describe('Reachability rows to delete outright -- e.g. a route that was discontinued this season.'),
				remove_origins: z
					.array(z.string().length(3))
					.optional()
					.describe('Origin airports to delete outright. Their reachability rows are not cascade-deleted -- list those separately above.'),
			}),
		},
		async ({ origins, reachability, remove_reachability, remove_origins }) => {
			for (const o of origins ?? []) {
				await upsertOrigin(db, {
					iata: o.iata,
					name: o.name,
					drive_km: o.drive_km ?? null,
					drive_minutes: o.drive_minutes ?? null,
					penalty_minutes: o.penalty_minutes ?? null,
				});
			}
			for (const r of reachability ?? []) {
				await upsertReachability(db, {
					city_key: r.city_key,
					origin_iata: r.origin_iata,
					tier: r.tier as ReachabilityTier,
					route_note: r.route_note ?? null,
				});
			}
			for (const rm of remove_reachability ?? []) {
				await deleteReachability(db, rm.city_key, rm.origin_iata);
			}
			for (const iata of remove_origins ?? []) {
				await deleteOrigin(db, iata);
			}
			return textResult({
				origins_upserted: origins?.length ?? 0,
				reachability_upserted: reachability?.length ?? 0,
				reachability_removed: remove_reachability?.length ?? 0,
				origins_removed: remove_origins?.length ?? 0,
			});
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

	// -- mint_subscriber_token(subscriber_id) --------------------------------
	server.registerTool(
		'mint_subscriber_token',
		{
			description:
				'Generates a fresh, random access credential for one subscriber and saves it, replacing any credential that ' +
				'subscriber already had. Give the returned token to that person as part of their own private connection URL: ' +
				'anyone holding it can act only as that one subscriber (view and manage only their own watchlist), never as ' +
				'anyone else and never as the scheduled task this admin credential itself represents.',
			inputSchema: z.object({
				subscriber_id: z.number().int().positive().describe('The subscriber to generate a credential for.'),
			}),
		},
		async ({ subscriber_id }) => {
			const subscriber = await getSubscriberById(db, subscriber_id);
			if (!subscriber) return errorResult(`mint_subscriber_token: no subscriber with id ${subscriber_id}`);
			const token = generateSubscriberToken();
			await setSubscriberMcpToken(db, subscriber_id, token);
			return textResult({ subscriber_id, email: subscriber.email, token });
		},
	);

	return server;
}

/**
 * CSPRNG token generation (S5.3's own explicit requirement: `crypto.getRandomValues`,
 * not `Math.random`, since a guessable token would defeat the whole point of a
 * per-person credential). `crypto` here is the Web Crypto global every
 * Cloudflare Worker already has -- no `nodejs_compat` flag, no `node:crypto`
 * import (wrangler.jsonc has neither, and this repo has stayed off that flag
 * throughout, per this file's own header note on runtime deps). 32 random
 * bytes hex-encoded -> a 64-character token, comfortably beyond brute-force
 * range for a bearer credential.
 */
function generateSubscriberToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Turns one `AgentToolDefinition`'s `input_schema` (plain JSON Schema, the
 * shape Anthropic's Messages API expects -- see `src/agent/tools.ts`) into
 * the Zod raw shape `McpServer.registerTool` needs. Deliberately narrow: it
 * only understands the handful of JSON Schema shapes the agent tool
 * catalogue actually uses today (string/integer/number/boolean leaves,
 * `enum`, `array` of objects, nested `object`, `required`) rather than being
 * a general-purpose converter -- if a future tool's schema needs more than
 * this, extend it here rather than reaching for a dependency.
 *
 * `jsonSchemaPropertyToZod` handles one property node and recurses for
 * `array`/`object` so a field like `add_artists`'s `bands` (an array of
 * `{ name, priority? }` objects) round-trips correctly instead of falling
 * through to the plain-string default every other leaf type used to fall
 * back to (the bug this fixed: an `array` property with no explicit case
 * silently became `z.string()`, which rejected every real call).
 */
function jsonSchemaPropertyToZod(prop: Record<string, unknown>): z.ZodTypeAny {
	let field: z.ZodTypeAny;
	if (Array.isArray(prop.enum)) {
		const values = prop.enum as string[];
		field = z.enum(values as [string, ...string[]]);
	} else if (prop.type === 'array') {
		const items = (prop.items ?? {}) as Record<string, unknown>;
		field = z.array(jsonSchemaPropertyToZod(items));
	} else if (prop.type === 'object') {
		field = z.object(agentInputSchemaToZodShape(prop));
	} else if (prop.type === 'integer') {
		field = z.number().int();
	} else if (prop.type === 'number') {
		field = z.number();
	} else if (prop.type === 'boolean') {
		field = z.boolean();
	} else {
		field = z.string();
	}
	if (typeof prop.description === 'string') field = field.describe(prop.description);
	return field;
}

function agentInputSchemaToZodShape(inputSchema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
	const properties = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
	const required = new Set((inputSchema.required as string[] | undefined) ?? []);
	const shape: Record<string, z.ZodTypeAny> = {};

	for (const [key, prop] of Object.entries(properties)) {
		let field = jsonSchemaPropertyToZod(prop);
		if (!required.has(key)) field = field.optional();
		shape[key] = field;
	}

	return shape;
}

/**
 * The subscriber-facing MCP surface (S5.3): the agent tool catalogue
 * (`AGENT_TOOLS`, S4.5's `src/agent/tools.ts`) exposed over MCP, one fresh
 * `McpServer` per request exactly like `buildMcpServer` above. The identity
 * behind every call is `subscriberId`, resolved once by `routeMcpRequest`
 * from the request's own bearer token -- never an argument a caller
 * supplies, which is what makes handing someone this URL safe: nothing they
 * type can make a tool act on another subscriber's data, because there is
 * no field to put another subscriber's id into in the first place. Every
 * tool's actual ownership check still lives in `src/agent/tools.ts` itself
 * (scoped queries, affected-row checks) -- this function only resolves who
 * `ctx.subscriberId` is and calls `callAgentTool`; it does not re-implement
 * or weaken any of those checks.
 *
 * Deliberately does NOT register any of `buildMcpServer`'s scheduled-task
 * tools -- a subscriber token has no business seeing `submit_digest`,
 * `get_sweep_targets`, `refresh_reachability`, etc., all of which act
 * outside any one subscriber's own data or spend real budget on the
 * scheduled task's behalf.
 */
export function buildSubscriberMcpServer(db: D1Database, env: McpEnv, subscriberId: number): McpServer {
	const server = new McpServer({ name: 'concert-watch', version: '1.0.0' });

	const ctx: AgentToolContext = {
		db,
		subscriberId,
		anthropicApiKey: env.ANTHROPIC_API_KEY ?? '',
		ticketmasterApiKey: env.TICKETMASTER_API_KEY ?? '',
		// A fresh cap per request, not per subscriber conversation -- see
		// PROGRESS.md's S5.3 entry: this endpoint issues one McpServer per
		// HTTP request (matching buildMcpServer's own documented model), so
		// the "3 web searches per email" cap this same counter enforces for
		// the email reply path does not carry across separate MCP tool calls
		// here. Flagged as a known gap, not silently accepted.
		webSearchState: createWebSearchState(),
	};

	for (const tool of AGENT_TOOLS) {
		server.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema: z.object(agentInputSchemaToZodShape(tool.input_schema)),
			},
			async (input) => {
				try {
					const output = await callAgentTool(tool.name, input, ctx);
					return textResult(output);
				} catch (err) {
					return errorResult(`${tool.name}: ${err instanceof Error ? err.message : String(err)}`);
				}
			},
		);
	}

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
 * its response, serving the scheduled-task tool catalogue. Called only after
 * `routeMcpRequest` has already verified the admin bearer token, so it
 * performs no auth itself.
 */
export async function handleMcpRequest(request: Request, env: McpEnv): Promise<Response> {
	const handler = createMcpHandler(() => buildMcpServer(env.DB, env));
	return handler.fetch(request);
}

/**
 * S5.3: same shape as `handleMcpRequest` above, but serving one resolved
 * subscriber's own agent tool catalogue (`buildSubscriberMcpServer`).
 * Called only after `routeMcpRequest` has already resolved `subscriberId`
 * from the request's bearer token, so it performs no auth itself either.
 */
export async function handleSubscriberMcpRequest(request: Request, env: McpEnv, subscriberId: number): Promise<Response> {
	const handler = createMcpHandler(() => buildSubscriberMcpServer(env.DB, env, subscriberId));
	return handler.fetch(request);
}

/**
 * Entry point wired into the Worker's `fetch` handler (see `src/index.ts`).
 * Returns `null` for any request outside the `/mcp/` path so the caller can
 * fall through to its other routes unchanged; returns a `Response` (success
 * or the 404 auth rejection) for anything under it.
 *
 * Two credentials share this one path prefix (S5.3): the single admin
 * secret (`MCP_AUTH_TOKEN`) is checked first -- a plain equality check, same
 * as before this step -- and only when that doesn't match does the token get
 * looked up as a per-subscriber credential in `subscribers.mcp_token`. A
 * token that is neither gets the same 404 an unauthenticated request always
 * got, so probing this endpoint still can't distinguish "wrong token" from
 * "route doesn't exist" (this file's own long-standing 401-vs-404 reasoning,
 * unchanged by adding a second credential kind).
 */
export async function routeMcpRequest(request: Request, env: McpEnv): Promise<Response | null> {
	const url = new URL(request.url);
	if (!url.pathname.startsWith(MCP_PATH_PREFIX)) return null;

	const token = url.pathname.slice(MCP_PATH_PREFIX.length).split('/')[0];
	if (!token) return new Response('Not found', { status: 404 });

	const adminToken = env.MCP_AUTH_TOKEN;
	if (adminToken && token === adminToken) {
		return handleMcpRequest(request, env);
	}

	const subscriber = await getSubscriberByMcpToken(env.DB, token);
	if (subscriber) {
		return handleSubscriberMcpRequest(request, env, subscriber.id);
	}

	return new Response('Not found', { status: 404 });
}
