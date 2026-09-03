/**
 * Welcome to Cloudflare Workers!
 *
 * This is a template for a Scheduled Worker: a Worker that can run on a
 * configurable interval:
 * https://developers.cloudflare.com/workers/platform/triggers/cron-triggers/
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Run `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"` to see your Worker in action
 * - Run `npm run deploy` to publish your Worker
 *
 * Bind resources to your Worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { emailHandler } from './mail/inbound';
import { resolveArtist } from './core/resolve';
import { routeMcpRequest } from './mcp/server';
import { runDailySchedule, shouldRunForCron, type ScheduleEnv } from './core/schedule';
import { resetSubscriberOnboarding } from './mail/onboard';
import { CloudflareMailer } from './mail/cloudflare';
import { getSubscriberByEmail } from './db/queries';

// Same domain S1.3 verified a real send against, and the same default every
// other file reading DIGEST_FROM_ADDRESS off `env as any` falls back to
// (`src/mcp/server.ts`, `src/mail/inbound.ts`) -- kept in sync by literal
// value per this repo's established convention for a secret with no
// declared binding.
const DEFAULT_FROM_ADDRESS = 'concert-watch@raresp.net';

export default {
	// S1.4: inbound mail capture. Logic lives in src/mail/inbound.ts; this is
	// wiring only, since Workers only reads handlers off the main module's
	// default export.
	email: emailHandler,

	async fetch(req, env) {
		// S4.7: MCP endpoint. `env` is cast the same way the existing
		// `/__test-resolve` route below already casts it for
		// ANTHROPIC_API_KEY/TICKETMASTER_API_KEY -- MCP_AUTH_TOKEN is a plain
		// wrangler secret, not a declared binding, so it has no entry in the
		// generated `Env` type. Returns `null` (falls through to the routes
		// below) for anything outside `/mcp/`.
		const mcpResponse = await routeMcpRequest(req, env as any);
		if (mcpResponse) return mcpResponse;

		const url = new URL(req.url);

		if (url.pathname === '/__test-resolve') {
			const name = url.searchParams.get('name') ?? 'IDLES';
			try {
				const result = await resolveArtist(name, {
					anthropicApiKey: (env as any).ANTHROPIC_API_KEY,
					ticketmasterApiKey: (env as any).TICKETMASTER_API_KEY,
				});
				return new Response(JSON.stringify({ ok: true, name, result }), { headers: { 'content-type': 'application/json' } });
			} catch (err) {
				return new Response(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }), {
					status: 500,
					headers: { 'content-type': 'application/json' },
				});
			}
		}

		// Permanent admin utility: resets one subscriber back to a
		// pre-onboarding state (watchlist/inbox/sent_replies/preferences wiped)
		// and resends the welcome invite, in one call -- see
		// `resetSubscriberOnboarding` (src/mail/onboard.ts) for exactly what's
		// touched. Gated by ADMIN_OPS_TOKEN, a secret distinct from
		// MCP_AUTH_TOKEN so rotating it never disturbs the scheduled task's MCP
		// connector (SCHEDULED_TASK.md). Kept wired permanently rather than
		// added/removed per use -- see PROGRESS.md for why.
		if (url.pathname === '/admin/reset-onboarding') {
			const adminEnv = env as any;
			const token = url.searchParams.get('token');
			if (!adminEnv.ADMIN_OPS_TOKEN || token !== adminEnv.ADMIN_OPS_TOKEN) {
				return new Response('unauthorized', { status: 401 });
			}
			const subscriberIdParam = url.searchParams.get('subscriber_id');
			const emailParam = url.searchParams.get('email');
			let subscriberId = subscriberIdParam ? Number(subscriberIdParam) : null;
			if (subscriberId === null && emailParam) {
				const subscriber = await getSubscriberByEmail(adminEnv.DB, emailParam);
				if (!subscriber) return new Response(JSON.stringify({ error: `no subscriber with email ${emailParam}` }), { status: 404 });
				subscriberId = subscriber.id;
			}
			if (subscriberId === null) {
				return new Response(JSON.stringify({ error: 'pass ?subscriber_id=<n> or ?email=<address>' }), { status: 400 });
			}
			const fromAddress = adminEnv.DIGEST_FROM_ADDRESS ?? DEFAULT_FROM_ADDRESS;
			const mailer = new CloudflareMailer(adminEnv.EMAIL, { from: fromAddress, isVerifiedRecipient: () => true });
			const result = await resetSubscriberOnboarding(adminEnv.DB, mailer, subscriberId);
			return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
		}

		url.pathname = '/__scheduled';
		url.searchParams.append('cron', '* * * * *');
		return new Response(`To test the scheduled handler, ensure you have used the "--test-scheduled" then try running "curl ${url.href}".`);
	},

	// S6.2: the daily poll -> cluster -> notify -> reach -> build-payload chain,
	// the deferred-inbox sweep, and the 36h fallback/30-day heartbeat safety
	// nets. Logic lives in src/core/schedule.ts; this is wiring only, same
	// division as the `email` handler above.
	async scheduled(event, env): Promise<void> {
		const scheduleEnv = env as unknown as ScheduleEnv;

		if (!shouldRunForCron(event.cron, scheduleEnv)) {
			console.log(`scheduled: cron "${event.cron}" is the optional second daily run and ENABLE_SECOND_CRON is not set -- skipping`);
			return;
		}

		const result = await runDailySchedule({
			db: scheduleEnv.DB,
			email: scheduleEnv.EMAIL,
			fromAddress: scheduleEnv.DIGEST_FROM_ADDRESS ?? DEFAULT_FROM_ADDRESS,
			anthropicApiKey: scheduleEnv.ANTHROPIC_API_KEY ?? '',
			ticketmasterApiKey: scheduleEnv.TICKETMASTER_API_KEY,
			budgetEnv: scheduleEnv,
		});

		console.log(
			`scheduled run (cron "${event.cron}") complete: ` +
				JSON.stringify({
					polled: result.poll.artistsPolled,
					pollDeferred: result.poll.artistsDeferredToTomorrow,
					clustered: result.cluster.length,
					notified: result.notify.length,
					inboxSwept: result.inboxSweep.rowsSwept,
					inboxDeferred: result.inboxSweep.rowsDeferredToTomorrow,
					fallbackSent: result.fallback.filter((f) => f.sent).length,
					heartbeatSent: result.heartbeat.filter((h) => h.sent).length,
				}),
		);
	},
} satisfies ExportedHandler<Env>;
