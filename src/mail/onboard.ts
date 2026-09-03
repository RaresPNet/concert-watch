/**
 * Subscriber onboarding: the one-time welcome email that starts the reply
 * conversation (IMPLEMENTATION_PLAN.md S6.3, DESIGN.md §2's "Onboarding
 * (Paula's path)").
 *
 * DESIGN.md is explicit that onboarding for both subscribers happens by
 * email, not by an admin hand-typing a watchlist for one of them: Rareș
 * triggers a one-time invite, the reply is free text ("Radiohead, Coldplay,
 * that band with the guy"), and "resolution is a conversation, not a parse."
 * The invite this file composes must therefore make an explicit promise —
 * that replying gets a confirmation back naming what was found and flagging
 * anything uncertain — because without that promise a messy reply feels
 * risky to send, and a messy reply is the expected, designed-for case.
 *
 * This file only composes and sends the invite. The reply itself is handled
 * entirely by the existing inbound pipeline (`src/mail/inbound.ts` ->
 * `src/mail/handle.ts` -> `src/mail/conversation.ts`), which already routes
 * a free-text reply to `add_artists` (`src/agent/tools.ts`) and lets the
 * model compose the confirmation reply from that tool's output. Nothing
 * about *receiving* the reply needed to change here.
 */

import {
	clearSubscriberPreferences,
	deleteInboxForSubscriber,
	deleteSentRepliesForSubscriber,
	deleteWatchlistForSubscriber,
	getSubscriberById,
} from '../db/queries';
import type { Mailer } from './mailer';

// ---------------------------------------------------------------------------
// Composing the invite
// ---------------------------------------------------------------------------

export interface WelcomeInviteContent {
	subject: string;
	html: string;
	text: string;
}

function escapeHtml(input: string): string {
	return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The person this system already answers to (Rareș) is who it's introduced
 * as belonging to, per DESIGN.md's own worked example: "this is Rareș's
 * concert watcher." Kept as a literal here rather than threaded through as a
 * parameter -- this system has exactly two subscribers by design (DESIGN.md
 * §1's own non-goal: "Not multi-tenant... hardcoded assumptions are fine
 * where they buy simplicity"), and the invite is always introducing the
 * same one person's project.
 */
const INTRODUCER_NAME = 'Rareș';

/** Every outbound email in this system signs off as Claude, not Rareș -- same convention `src/mail/conversation.ts`'s system prompt sets for reply-path mail. */
const SIGNATURE = 'Claude';

const SUBJECT = 'A heads-up before the concert emails start';

/** Builds the welcome invite for one subscriber. Pure and synchronous so it's trivial to test without a database or a mailer. */
export function composeWelcomeInvite(subscriber: { display_name: string | null }): WelcomeInviteContent {
	const greetingName = subscriber.display_name?.trim() || 'there';

	const textLines = [
		`Hi ${greetingName},`,
		'',
		`This is ${INTRODUCER_NAME}'s concert watcher. It keeps an eye on a small list of bands and emails you when one of them announces ` +
			'a tour or a show worth knowing about, and it works out how easy each one would be to actually get to from Cluj.',
		'',
		"To get started, just reply to this email with the bands you'd want to hear about. Write it however comes naturally: " +
			'"Radiohead, Coldplay, that band with the guy" is a completely fine reply. Nothing needs to be a tidy list, and a partial ' +
			"or half-remembered name is fine too; if something can't be matched with confidence, you'll be asked about it rather than " +
			'guessed at.',
		'',
		'If some of them matter more than others, say so in the same reply, something like "my favourites are Radiohead and ' +
			'Fontaines D.C., I also just like their support act" is enough. The reply you get back will say which priority ' +
			"was worked out for each band, so anything that's wrong is easy to correct.",
		'',
		"Whatever you reply with, you'll get a confirmation email back listing exactly what was found and added, and flagging " +
			'anything that was ambiguous or that it drew a blank on, so you always know exactly what ended up on the list.',
		'',
		'Once a couple of bands are on the list, replying at any time adds or removes a band, changes how eagerly you want to hear ' +
			"about one, pauses the whole thing, or asks about travel for a specific date. It's a running conversation, not a one-time form.",
		'',
		SIGNATURE,
	];

	const htmlParagraphs = [
		`<p>Hi ${escapeHtml(greetingName)},</p>`,
		`<p>This is ${escapeHtml(INTRODUCER_NAME)}'s concert watcher. It keeps an eye on a small list of bands and emails you when one of ` +
			'them announces a tour or a show worth knowing about, and it works out how easy each one would be to actually get to from ' +
			'Cluj.</p>',
		"<p>To get started, just reply to this email with the bands you'd want to hear about. Write it however comes naturally: " +
			'&quot;Radiohead, Coldplay, that band with the guy&quot; is a completely fine reply. Nothing needs to be a tidy list, and a ' +
			"partial or half-remembered name is fine too; if something can't be matched with confidence, you'll be asked about it " +
			'rather than guessed at.</p>',
		'<p>If some of them matter more than others, say so in the same reply, something like &quot;my favourites are Radiohead and ' +
			'Fontaines D.C., I also just like their support act&quot; is enough. The reply you get back will say which priority was ' +
			"worked out for each band, so anything that's wrong is easy to correct.</p>",
		"<p>Whatever you reply with, you'll get a confirmation email back listing exactly what was found and added, and flagging " +
			'anything that was ambiguous or that it drew a blank on, so you always know exactly what ended up on the list.</p>',
		'<p>Once a couple of bands are on the list, replying at any time adds or removes a band, changes how eagerly you want to hear ' +
			"about one, pauses the whole thing, or asks about travel for a specific date. It's a running conversation, not a " +
			'one-time form.</p>',
		`<p>${escapeHtml(SIGNATURE)}</p>`,
	];

	const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>${escapeHtml(SUBJECT)}</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2328;">
	${htmlParagraphs.join('\n\t')}
</body>
</html>`;

	return { subject: SUBJECT, html, text: textLines.join('\n') };
}

// ---------------------------------------------------------------------------
// Sending the invite
// ---------------------------------------------------------------------------

export type SendWelcomeInviteResult =
	{ sent: true; subscriber_id: number; message_id: string } | { sent: false; subscriber_id: number; reason: string };

/**
 * Sends the welcome invite to one subscriber, by id. This is the "manually
 * triggered" send DESIGN.md's onboarding note describes ("Rareș triggers a
 * one-time invite") -- reachable from a real, permanently-wired admin route
 * (`src/index.ts`'s `/admin/reset-onboarding`, gated by the `ADMIN_OPS_TOKEN`
 * secret) rather than a route hand-added and torn down per use. See
 * `resetSubscriberOnboarding` below for the reset-and-resend that route
 * actually calls.
 *
 * Mirrors `src/mcp/server.ts`'s `submit_digest` handler's own explicit
 * `verified_at` check (same reasoning: DESIGN.md §3 -- Cloudflare's free
 * Workers plan only sends to a verified Email Routing destination, so a
 * subscriber who hasn't completed that step yet must be refused here rather
 * than handed to `mailer.send` to fail less legibly downstream). This
 * function does not construct its own `Mailer` -- unlike `submit_digest`,
 * building a suitably-scoped `Mailer` (e.g. Cloudflare's, restricted to this
 * one recipient) is left to the caller, following the same shape
 * `sendFallbackDigestForSubscriber`/`checkHeartbeatForSubscriber`
 * (`src/digest/fallback.ts`) already use.
 */
export async function sendWelcomeInvite(db: D1Database, mailer: Mailer, subscriberId: number): Promise<SendWelcomeInviteResult> {
	const subscriber = await getSubscriberById(db, subscriberId);
	if (!subscriber) {
		return { sent: false, subscriber_id: subscriberId, reason: 'no subscriber with that id' };
	}
	if (!subscriber.verified_at) {
		return {
			sent: false,
			subscriber_id: subscriberId,
			reason: `${subscriber.email} has no verified_at -- Cloudflare's free plan only sends to a verified Email Routing destination, so this subscriber must confirm that first`,
		};
	}

	const invite = composeWelcomeInvite(subscriber);
	try {
		const result = await mailer.send({ to: subscriber.email, subject: invite.subject, html: invite.html, text: invite.text });
		return { sent: true, subscriber_id: subscriberId, message_id: result.messageId };
	} catch (err) {
		return { sent: false, subscriber_id: subscriberId, reason: err instanceof Error ? err.message : String(err) };
	}
}

// ---------------------------------------------------------------------------
// Resetting onboarding
// ---------------------------------------------------------------------------

export interface ResetSubscriberOnboardingResult {
	subscriber_id: number;
	deleted: { watchlist: number; inbox: number; sent_replies: number };
	invite: SendWelcomeInviteResult;
}

/**
 * Wipes one subscriber back to a pre-onboarding state and resends the
 * welcome invite: every watchlist entry, every inbox row (the subscriber's
 * own sent mail is never touched -- only what *they* sent in), every
 * sent_replies row, and any standing `preferences` text. The subscriber row
 * itself (id, email, verified_at, display_name) is left alone -- re-sending
 * the invite still needs a verified destination, and there is no reason to
 * make a subscriber re-verify their address just to reset their watchlist.
 *
 * Does not touch `artists`/`tours`/`events` -- those are shared reference
 * data (which bands exist, what tour dates are known), not
 * subscriber-specific, so "reset onboarding" has no reason to affect them.
 */
export async function resetSubscriberOnboarding(db: D1Database, mailer: Mailer, subscriberId: number): Promise<ResetSubscriberOnboardingResult> {
	const [watchlist, inbox, sentReplies] = await Promise.all([
		deleteWatchlistForSubscriber(db, subscriberId),
		deleteInboxForSubscriber(db, subscriberId),
		deleteSentRepliesForSubscriber(db, subscriberId),
	]);
	await clearSubscriberPreferences(db, subscriberId);

	const invite = await sendWelcomeInvite(db, mailer, subscriberId);
	return { subscriber_id: subscriberId, deleted: { watchlist, inbox, sent_replies: sentReplies }, invite };
}
