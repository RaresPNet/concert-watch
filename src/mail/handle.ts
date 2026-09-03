/**
 * The inbound command handler's top-level entry point (IMPLEMENTATION_PLAN.md
 * S4.6, DESIGN.md §11). `handleInboxRow` is written once and called from two
 * places -- the Email Worker on live arrival, and (from S5.1, not yet built)
 * the daily cron sweeping `deferred`/failed rows -- and is deliberately
 * agnostic to which: it reads `row.status`/`row.attempts` off the row it's
 * handed, not off any "I was just invoked live" assumption.
 *
 * This file owns: the retry-storm guard (§12.4, `inbox.attempts`), the
 * monthly-budget degrade check (§12.5) *before* any model call is attempted,
 * calling into `conversation.ts` for the actual model-driven reply, sending
 * that reply via `Mailer` with correct threading headers (§11.2), and only
 * then marking the `inbox` row `handled` (§9.3: never before delivery is
 * confirmed). `conversation.ts` owns everything upstream of "here is the
 * reply text"; this file never touches `ModelSession`/`AGENT_TOOLS` directly.
 */

import { getBudgetStatus, decideReplyHandling, formatBudgetDegradeNotice, type BudgetEnv, type BudgetStatus } from '../model/budget';
import { runConversation, type ConversationDeps, type ConversationResult } from './conversation';
import { incrementInboxAttempts, insertSentReply, markInboxDeferred, markInboxHandled } from '../db/queries';
import type { InboxRow } from '../db/schema';
import type { Mailer } from './mailer';
import { renderReplyHtml } from './format';

/**
 * DESIGN.md §12.4: "inbox.attempts, maximum 2, then the row is marked
 * deferred and picked up by the next scheduled run -- never retried in a
 * tight loop." A row that has already failed this many times is not
 * attempted live again by this function at all -- it stays `deferred`
 * (or is moved there) for a later, different code path to eventually
 * resolve, exactly as with the budget-degrade case below.
 */
export const MAX_LIVE_ATTEMPTS = 2;

export interface HandleInboxRowDeps {
	db: D1Database;
	mailer: Mailer;
	anthropicApiKey: string;
	ticketmasterApiKey: string;
	/** The `From` address used for replies. */
	fromAddress: string;
	/** Read for `MODEL_MONTHLY_CEILING_USD` -- same shape `budget.ts` already expects. */
	budgetEnv?: BudgetEnv;
	/** Injectable for tests; defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
	/** Injectable for tests; defaults to `() => new Date()`. */
	now?: () => Date;
	/** Injectable for tests -- forwarded through to `conversation.ts` -> `add_artist`. */
	musicbrainzLookup?: ConversationDeps['musicbrainzLookup'];
}

export type HandleInboxRowOutcome =
	| { outcome: 'skipped'; reason: string }
	| { outcome: 'deferred'; reason: 'attempts_exhausted' | 'budget'; note: string }
	| { outcome: 'handled'; replyText: string; capBreached: boolean; messageId: string }
	| { outcome: 'error'; reason: string; attempts: number; deferred: boolean };

// ---------------------------------------------------------------------------
// Threading headers for the reply (DESIGN.md §11.2)
// ---------------------------------------------------------------------------

/**
 * Builds `In-Reply-To`/`References` for a reply to `row`, following RFC 5322
 * §3.6.4: a message's `References` is its parent's `References` with the
 * parent's own `Message-ID` appended. `row.message_id`/`row.references` are
 * stored verbatim (angle brackets and all -- see `src/mail/inbound.ts`), so
 * no reformatting is needed here, only concatenation.
 */
export function buildThreadingHeaders(row: InboxRow): { inReplyTo: string | null; references: string | null } {
	if (!row.message_id) return { inReplyTo: null, references: row.references ?? null };
	const priorRefs = row.references ? row.references.trim() : '';
	const references = priorRefs ? `${priorRefs} ${row.message_id}` : row.message_id;
	return { inReplyTo: row.message_id, references };
}

function replySubject(original: string | null): string {
	const subject = (original ?? '').trim() || '(no subject)';
	return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Handles one `inbox` row end to end: retry-storm guard, budget degrade
 * check, model conversation, send, mark handled. Safe to call repeatedly on
 * the same row (from a cron sweep) -- every branch either makes forward
 * progress (handled) or leaves the row in a well-defined non-live state
 * (deferred) rather than re-spending API-key money on a row already given up
 * on live.
 */
export async function handleInboxRow(row: InboxRow, deps: HandleInboxRowDeps): Promise<HandleInboxRowOutcome> {
	if (row.status === 'handled' || row.status === 'ignored') {
		return { outcome: 'skipped', reason: `row ${row.id} is already ${row.status}` };
	}

	if (row.subscriber_id === null) {
		// Defensive only -- S1.4 never writes a pending/deferred row without a
		// resolved subscriber_id (an unknown sender is dropped as `ignored`
		// before a row like this can exist).
		await markInboxHandled(deps.db, row.id, { status: 'ignored', result_note: 'no subscriber_id on a non-ignored row (defensive)' });
		return { outcome: 'skipped', reason: 'missing subscriber_id' };
	}

	if (row.attempts >= MAX_LIVE_ATTEMPTS) {
		const note = `live handling already failed ${row.attempts} time(s); awaiting a scheduled sweep rather than retrying live`;
		if (row.status !== 'deferred') await markInboxDeferred(deps.db, row.id, note);
		return { outcome: 'deferred', reason: 'attempts_exhausted', note };
	}

	const now = deps.now?.() ?? new Date();

	// Budget degrade (DESIGN.md §12.5), checked BEFORE any model call --
	// the whole point is that a row over the monthly ceiling never reaches
	// `ModelSession` on this (API-key-billed) path at all. `attempts` is
	// deliberately NOT incremented here: this isn't a failure, it's a policy
	// decision, and a row parked here should simply wait for the ceiling to
	// reset or for a future scheduled/app-quota pass (S4.7's MCP surface) to
	// resolve it -- not eventually get "given up on" the way a genuinely
	// broken row does.
	const budgetStatus: BudgetStatus = await getBudgetStatus(deps.db, deps.budgetEnv, now);
	if (decideReplyHandling(budgetStatus) === 'defer_to_scheduled') {
		const note = `deferred: ${formatBudgetDegradeNotice(budgetStatus)}`;
		await markInboxDeferred(deps.db, row.id, note);
		return { outcome: 'deferred', reason: 'budget', note };
	}

	let result: ConversationResult;
	try {
		result = await runConversation(row, {
			db: deps.db,
			anthropicApiKey: deps.anthropicApiKey,
			ticketmasterApiKey: deps.ticketmasterApiKey,
			fetchImpl: deps.fetchImpl,
			now: deps.now,
			musicbrainzLookup: deps.musicbrainzLookup,
		});
	} catch (err) {
		return handleFailure(row, deps, err);
	}

	const threading = buildThreadingHeaders(row);
	const threadId = row.thread_id ?? `inbox:${row.id}`;

	let sendResult: { messageId: string };
	try {
		sendResult = await deps.mailer.send({
			to: row.from_addr,
			subject: replySubject(row.subject),
			html: renderReplyHtml(result.replyText),
			text: result.replyText,
			headers: {
				...(threading.inReplyTo ? { 'In-Reply-To': threading.inReplyTo } : {}),
				...(threading.references ? { References: threading.references } : {}),
			},
		});
	} catch (err) {
		// DESIGN.md §9.3's discipline applies here too: a failed send must not
		// be treated as a successful handling of this row. Falls through to the
		// same attempts-counting path as a conversation-loop failure.
		return handleFailure(row, deps, err);
	}

	// Delivery confirmed -- only now do we persist the reply and mark the row
	// handled (§9.3).
	await insertSentReply(deps.db, {
		inbox_id: row.id,
		subscriber_id: row.subscriber_id,
		thread_id: threadId,
		message_id: sendResult.messageId,
		in_reply_to: threading.inReplyTo,
		references: threading.references,
		body_text: result.replyText,
	});

	const noteParts = [`${result.turns} turn(s)`, `model=${result.modelUsed}`];
	if (result.escalated) noteParts.push('escalated');
	if (result.capBreached) noteParts.push('cap breach -- sent honest narrow-it-down reply');
	await markInboxHandled(deps.db, row.id, { status: 'handled', result_note: noteParts.join(', ') });

	return { outcome: 'handled', replyText: result.replyText, capBreached: result.capBreached, messageId: sendResult.messageId };
}

/**
 * Shared failure path for both a thrown error in the conversation loop and a
 * failed send. DESIGN.md §12.4's retry-storm guard: increments `attempts`;
 * once that reaches `MAX_LIVE_ATTEMPTS`, the row moves to `deferred` instead
 * of being retried again in a tight loop. Below the cap, the row is left
 * exactly as it was (still `pending`/`deferred`) -- a subsequent, separate
 * invocation of this function (the next cron sweep, or another live retry if
 * the sender writes again) is what tries again, never a loop within this
 * call.
 */
async function handleFailure(row: InboxRow, deps: HandleInboxRowDeps, err: unknown): Promise<HandleInboxRowOutcome> {
	const message = err instanceof Error ? err.message : String(err);
	const attempts = await incrementInboxAttempts(deps.db, row.id);
	let deferred = false;
	if (attempts >= MAX_LIVE_ATTEMPTS) {
		await markInboxDeferred(deps.db, row.id, `live handling failed ${attempts} time(s), most recently: ${message}`);
		deferred = true;
	}
	return { outcome: 'error', reason: message, attempts, deferred };
}
