/**
 * Daily cron orchestrator (IMPLEMENTATION_PLAN.md S6.2, DESIGN.md §3/§9/§10.3).
 * The single function the Worker's `scheduled()` handler calls: runs the
 * whole deterministic chain -- poll (S3.2) -> cluster (S3.3) -> notify (S3.3)
 * -> reach + build payload (S3.4/S4.1) -- against real D1, sweeps any
 * `deferred` inbox row through the same live-reply path S6.1 already wired
 * up (DESIGN.md §12.4: "picked up by the next scheduled run"), and runs the
 * two delivery safety nets from S4.8 (36h fallback digest, 30-day
 * heartbeat). All of this is model-free or API-key-billed (never app quota):
 * the Claude scheduled task over MCP is what actually composes and sends the
 * *good* digest (`get_pending_digest`/`submit_digest`, `src/mcp/server.ts`)
 * -- this file only makes sure the pending notifications and payload data
 * are correct and waiting for that task to collect, per DESIGN.md §3's "the
 * Worker does not compose the digest."
 *
 * Per-run cap, and why it's a cap rather than "just process everything":
 * poll and the inbox sweep are the two things whose size scales with things
 * outside this file's control (watchlist growth, a burst of budget-deferred
 * mail while over the monthly ceiling), so both are capped and ordered so
 * that whatever a cap defers today is first in line tomorrow --
 * `getWatchedArtistsForPoll`'s `last_polled_at ASC` ordering (queries.ts) for
 * artists, arrival order for deferred inbox rows. At today's scale (a
 * handful of artists, two subscribers) neither cap is ever reached; they
 * exist so a busier future doesn't let one bad day snowball into an
 * unbounded run, per this step's own instruction.
 */

import { getAllSubscribers, getDeferredInboxMessages, getWatchedArtistsForPoll } from '../db/queries';
import type { InboxRow } from '../db/schema';
import { pollOneArtist, type PollArtistResult, type PollDeps } from './poll';
import { clusterTours, type ClusterOutcome } from './tours';
import { runNotificationPass } from './notify';
import type { NotificationRow } from '../db/schema';
import { buildAllDigestPayloads } from '../digest/payload';
import { runFallbackDigestCheck, runHeartbeatCheck, type FallbackDigestResult, type HeartbeatResult } from '../digest/fallback';
import { handleInboxRow, type HandleInboxRowOutcome } from '../mail/handle';
import { CloudflareMailer } from '../mail/cloudflare';
import type { Mailer } from '../mail/mailer';
import { TicketmasterAdapter } from '../sources/ticketmaster';
import type { BudgetEnv } from '../model/budget';
import type { ConversationDeps } from '../mail/conversation';

// ---------------------------------------------------------------------------
// Second daily run -- config toggle, defaulting off (see this step's own
// note in IMPLEMENTATION_PLAN.md). Reasoning: the poll path is deterministic
// and free, so a second run halves worst-case detection latency for
// something that goes on sale between the two runs -- but `wrangler.jsonc`'s
// `triggers.crons` today lists only PRIMARY_CRON, so this toggle currently
// has nothing to gate in production. It's implemented anyway so that
// switching it on later is a two-line change (add SECONDARY_CRON to
// `wrangler.jsonc` and set `ENABLE_SECOND_CRON=true`) rather than new code,
// and so `shouldRunForCron`'s branch is exercised by a test today instead of
// only once someone flips the toggle for the first time.
// ---------------------------------------------------------------------------

/** Matches the one entry `wrangler.jsonc`'s `triggers.crons` has today (08:00 EET / 05:00 UTC). */
export const PRIMARY_CRON = '0 5 * * *';

/** Not yet registered in `wrangler.jsonc` -- see the file header note above. 20:00 EET / 17:00 UTC. */
export const SECONDARY_CRON = '0 17 * * *';

export function isSecondCronEnabled(env: { ENABLE_SECOND_CRON?: string }): boolean {
	return env.ENABLE_SECOND_CRON === 'true';
}

/** Whether a given `ScheduledEvent.cron` value should trigger a full run. Anything other than the recognised secondary pattern always runs -- an unexpected cron string is far more likely to be a manual `--test-scheduled` trigger than a real second schedule, and doing the work is the safe default there. */
export function shouldRunForCron(cron: string, env: { ENABLE_SECOND_CRON?: string }): boolean {
	if (cron === SECONDARY_CRON) return isSecondCronEnabled(env);
	return true;
}

// ---------------------------------------------------------------------------
// Env slice this file needs -- same narrow-slice convention `src/mail/inbound.ts`'s
// `EmailHandlerEnv` and `src/mcp/server.ts`'s `McpEnv` already use, for the
// same reason: `ANTHROPIC_API_KEY`/`TICKETMASTER_API_KEY`/`DIGEST_FROM_ADDRESS`/
// `ENABLE_SECOND_CRON` are plain wrangler secrets/vars with no declared
// binding.
// ---------------------------------------------------------------------------
export interface ScheduleEnv extends BudgetEnv {
	DB: D1Database;
	EMAIL: SendEmail;
	ANTHROPIC_API_KEY?: string;
	TICKETMASTER_API_KEY?: string;
	DIGEST_FROM_ADDRESS?: string;
	ENABLE_SECOND_CRON?: string;
}

export interface ScheduleDeps {
	db: D1Database;
	email: SendEmail;
	fromAddress: string;
	anthropicApiKey: string;
	ticketmasterApiKey?: string;
	budgetEnv?: BudgetEnv;
	/** Injectable for tests; defaults to `() => new Date()`. */
	now?: () => Date;
	/** Injectable for tests; forwarded to the Ticketmaster adapter, the tour-page checker, and the reply conversation loop. */
	fetchImpl?: typeof fetch;
	tourPageFetchImpl?: typeof fetch;
	/** Injectable for tests -- forwarded through `handleInboxRow` to `conversation.ts` -> `add_artist`. */
	musicbrainzLookup?: ConversationDeps['musicbrainzLookup'];
	/** Artists polled this run, oldest-`last_polled_at`-first; the rest wait for tomorrow. */
	maxArtistsPerRun?: number;
	/** Deferred inbox rows swept this run, oldest-first; the rest wait for tomorrow. */
	maxDeferredRowsPerRun?: number;
}

/** See the file header note on caps: comfortably above today's scale, just bounding the worst case. */
const DEFAULT_MAX_ARTISTS_PER_RUN = 60;
const DEFAULT_MAX_DEFERRED_ROWS_PER_RUN = 20;

export interface ScheduleResult {
	ranAt: string;
	poll: {
		artistsPolled: number;
		artistsDeferredToTomorrow: number;
		artists: PollArtistResult[];
	};
	cluster: ClusterOutcome[];
	notify: NotificationRow[];
	/** `send: false` just means nothing pending for that subscriber this run -- not an error. */
	payloads: { subscriberId: number; send: boolean }[];
	inboxSweep: {
		rowsSwept: number;
		rowsDeferredToTomorrow: number;
		outcomes: HandleInboxRowOutcome[];
	};
	fallback: FallbackDigestResult[];
	heartbeat: HeartbeatResult[];
}

/**
 * Builds a `Mailer` scoped to every subscriber whose address is currently a
 * verified Email Routing destination (DESIGN.md §3) -- the same trust
 * boundary `submit_digest` (`src/mcp/server.ts`) applies to its own sends,
 * reapplied here since `runFallbackDigestCheck`/`runHeartbeatCheck`
 * (`src/digest/fallback.ts`) take a `Mailer` and send to whichever
 * subscriber they're checking without asserting `verified_at` themselves.
 */
async function buildVerifiedSubscriberMailer(db: D1Database, email: SendEmail, fromAddress: string): Promise<Mailer> {
	const subscribers = await getAllSubscribers(db);
	const verified = new Set(subscribers.filter((s) => s.verified_at).map((s) => s.email));
	return new CloudflareMailer(email, { from: fromAddress, isVerifiedRecipient: (addr) => verified.has(addr) });
}

/** Builds a `Mailer` scoped to a single inbox row's own sender -- identical to `src/mail/inbound.ts`'s `emailHandler` (S6.1): this row's sender is already a known, DKIM/SPF-passing subscriber (S1.4), the only address a live reply to it is ever sent to. */
function buildRowScopedMailer(email: SendEmail, fromAddress: string, row: InboxRow): Mailer {
	return new CloudflareMailer(email, { from: fromAddress, isVerifiedRecipient: (addr) => addr === row.from_addr });
}

/**
 * Runs the whole daily chain once, against real D1. Safe to call more than
 * once a day (every stage is already idempotent on its own: `pollOneArtist`
 * upserts by fingerprint, `runNotificationPass` only ever writes a
 * notification once per its own dedup checks, `handleInboxRow` no-ops on an
 * already-`handled`/`ignored` row, the fallback/heartbeat checks are pure
 * threshold reads) -- there is no cross-run state in this file itself.
 */
export async function runDailySchedule(deps: ScheduleDeps): Promise<ScheduleResult> {
	const now = deps.now?.() ?? new Date();
	const nowIso = now.toISOString();
	const maxArtists = deps.maxArtistsPerRun ?? DEFAULT_MAX_ARTISTS_PER_RUN;
	const maxDeferred = deps.maxDeferredRowsPerRun ?? DEFAULT_MAX_DEFERRED_ROWS_PER_RUN;

	// ---- poll ----------------------------------------------------------------
	const watchedArtists = await getWatchedArtistsForPoll(deps.db);
	const artistsToPoll = watchedArtists.slice(0, maxArtists);

	const ticketmasterAdapter = deps.ticketmasterApiKey
		? new TicketmasterAdapter({ apiKey: deps.ticketmasterApiKey, db: deps.db, fetchImpl: deps.fetchImpl })
		: undefined;
	const pollDeps: PollDeps = {
		ticketmasterAdapter,
		db: deps.db,
		now: () => nowIso,
		tourPageFetchImpl: deps.tourPageFetchImpl,
	};

	const artistResults: PollArtistResult[] = [];
	for (const artist of artistsToPoll) {
		artistResults.push(await pollOneArtist(artist, pollDeps, nowIso));
	}

	// ---- cluster ---------------------------------------------------------------
	// Every watched artist, not just the ones this run's poll touched:
	// `clusterToursForArtist` no-ops (returns null) for an artist with nothing
	// pending, so this is cheap, and it's the only thing that ever clusters
	// events the scheduled Claude task wrote via `submit_sweep_results`/
	// `submit_parsed_events` (`src/mcp/server.ts`) -- neither of those MCP
	// tools clusters what it persists, and nothing else in the codebase does
	// either (the only other caller, `src/core/acquire.ts`, clusters a single
	// just-added artist once, at add-time). Restricting this to poll's own
	// `inserted`/`changed` outcomes would silently strand every dark-artist-
	// sweep and tour-page-parse discovery as an untoured, unnotified `events`
	// row forever.
	const clusterOutcomes = await clusterTours(
		deps.db,
		watchedArtists.map((a) => a.id),
		nowIso,
	);

	// ---- notify ------------------------------------------------------------------
	const changedEventIds = artistResults
		.flatMap((r) => r.events)
		.filter((e) => e.kind === 'changed' && e.event_id !== null)
		.map((e) => e.event_id as number);
	const notifications = await runNotificationPass({ db: deps.db, clusterOutcomes, changedEventIds, now: nowIso });

	// ---- reach + build payload -------------------------------------------------------
	// Nothing here writes anything -- `buildAllDigestPayloads` (S4.1) is a pure
	// read+assembly over the `notifications` rows just written above, joining
	// in reachability (S3.4). Running it now, rather than only when
	// `get_pending_digest` is later called, is what "poll -> cluster -> notify
	// -> reach -> build payload" (this step's own note) means by a cron run
	// completing "without error": it exercises the full chain end to end, not
	// just the two stages that happen to write rows.
	const payloadResults = await buildAllDigestPayloads(deps.db);

	// ---- sweep deferred inbox rows ---------------------------------------------------
	const deferredRows = await getDeferredInboxMessages(deps.db);
	const rowsToSweep = deferredRows.slice(0, maxDeferred);
	const inboxOutcomes: HandleInboxRowOutcome[] = [];
	for (const row of rowsToSweep) {
		try {
			inboxOutcomes.push(
				await handleInboxRow(row, {
					db: deps.db,
					mailer: buildRowScopedMailer(deps.email, deps.fromAddress, row),
					anthropicApiKey: deps.anthropicApiKey,
					ticketmasterApiKey: deps.ticketmasterApiKey ?? '',
					fromAddress: deps.fromAddress,
					budgetEnv: deps.budgetEnv,
					fetchImpl: deps.fetchImpl,
					now: deps.now,
					musicbrainzLookup: deps.musicbrainzLookup,
				}),
			);
		} catch (err) {
			// Same discipline `src/mail/inbound.ts`'s `emailHandler` applies to a
			// throw out of `handleInboxRow` (S6.1): logged, not rethrown, so one
			// bad row can't abort the rest of the sweep or the checks below it.
			console.error(`handleInboxRow threw for deferred inbox row ${row.id}:`, err);
		}
	}

	// ---- fallback + heartbeat ---------------------------------------------------------
	const digestMailer = await buildVerifiedSubscriberMailer(deps.db, deps.email, deps.fromAddress);
	const fallback = await runFallbackDigestCheck(deps.db, digestMailer, now);
	const heartbeat = await runHeartbeatCheck(deps.db, digestMailer, now);

	return {
		ranAt: nowIso,
		poll: {
			artistsPolled: artistsToPoll.length,
			artistsDeferredToTomorrow: watchedArtists.length - artistsToPoll.length,
			artists: artistResults,
		},
		cluster: clusterOutcomes,
		notify: notifications,
		payloads: payloadResults.map((p) => ({ subscriberId: p.send ? p.payload.subscriber_id : p.subscriber_id, send: p.send })),
		inboxSweep: {
			rowsSwept: rowsToSweep.length,
			rowsDeferredToTomorrow: deferredRows.length - rowsToSweep.length,
			outcomes: inboxOutcomes,
		},
		fallback,
		heartbeat,
	};
}
