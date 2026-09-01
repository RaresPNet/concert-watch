/**
 * Inbound mail capture — IMPLEMENTATION_PLAN.md S1.4.
 *
 * Cloudflare Email Routing delivers inbound mail to this Worker's `email()`
 * handler. Per DESIGN.md §11.1, this file parses NOTHING out of the body and
 * acts on NOTHING a sender wrote — it authenticates the envelope, guards
 * against mail loops, rate-limits, and writes a raw row into `inbox` with
 * status `pending` for a later step (S4.6) to interpret. No model call
 * happens anywhere in this file, ever.
 *
 * Loop guards (DESIGN.md §12.3/§12.4) are treated as a correctness
 * requirement: an autoresponder ping-ponging with our replies is the
 * single most likely way this project generates a surprise bill, since the
 * reply path (S4.6) is the only one that spends money. Everything in this
 * file runs *before* that path, so a mistake here is the difference between
 * "annoying" and "expensive".
 */

import { getSubscriberByEmail, incrementRateLimit, insertInboxMessage, markInboxHandled } from '../db/queries';
import type { InboxStatus as SchemaInboxStatus } from '../db/schema';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** DESIGN.md §12.4: "per-sender rate limit: at most 6 live-handled emails per
 * hour." The 7th+ message in the bucket is deferred, not processed. */
const HOURLY_CAP = 6;

/** Body text is stored for a later step to interpret, but we still bound it
 * so one huge message can't blow the CPU/storage budget in *this* step
 * (DESIGN.md §3.1, §12.4 point 4 — the same "truncate before it can cost
 * anything" instinct applied to storage instead of a model call). */
const MAX_BODY_CHARS = 20_000;

/** This file only ever writes `pending` | `ignored` | `deferred` — `handled`
 * is written by S4.6, which is why the schema's InboxStatus is a superset of
 * this one. */
export type InboxStatus = Extract<SchemaInboxStatus, 'pending' | 'ignored' | 'deferred'>;

// ---------------------------------------------------------------------------
// Minimal shape of the inbound message this module needs.
//
// The real Worker receives a `ForwardableEmailMessage` (see
// worker-configuration.d.ts): { from, to, headers, raw, rawSize, ... }.
// The handler below only touches `from`, `headers` and `raw`, so it is typed
// against that narrow slice — this is also exactly what the standalone test
// harness needs to fake, without pulling in the ambient Workers types.
// ---------------------------------------------------------------------------
export interface InboundEmailLike {
	readonly from: string;
	readonly headers: Headers;
	readonly raw: ReadableStream<Uint8Array>;
}

// ---------------------------------------------------------------------------
// D1 access, isolated behind a narrow interface.
//
// S1.1 (`src/db/schema.ts` / `src/db/queries.ts`) landed in parallel with
// this step, so `createD1InboundDb` below is a thin adapter onto its typed
// query layer (`getSubscriberByEmail`, `incrementRateLimit`,
// `insertInboxMessage`) rather than hand-rolled SQL — see PROGRESS.md's S1.1
// entry for the column names this relies on (in particular: `rate_limit` is
// keyed on `sender`, and `inbox`'s References column is the quoted SQL
// keyword `"references"`, exposed by queries.ts as `references`).
// `InboundDb` stays as a seam so the handler logic remains testable without
// D1 at all.
// ---------------------------------------------------------------------------

export interface InboxInsert {
	fromAddr: string;
	subscriberId: number | null;
	dkimPass: boolean;
	spfPass: boolean;
	subject: string | null;
	bodyText: string | null;
	messageId: string | null;
	inReplyTo: string | null;
	referencesHeader: string | null;
	threadId: string;
	receivedAt: string;
	status: InboxStatus;
	resultNote: string | null;
}

export interface InboundDb {
	/** Returns the subscriber id for an email address, or null if unknown. */
	findSubscriberIdByEmail(email: string): Promise<number | null>;
	/** Atomically increments the (sender, hour_bucket) counter and returns
	 * the count *after* incrementing. */
	bumpRateLimit(fromAddr: string, hourBucket: string): Promise<number>;
	/** Persists one inbox row. */
	insertInboxRow(row: InboxInsert): Promise<void>;
}

/** D1-backed `InboundDb`, adapting `handleInboundEmail`'s shape onto
 * `src/db/queries.ts`. */
export function createD1InboundDb(db: D1Database): InboundDb {
	return {
		async findSubscriberIdByEmail(email) {
			const row = await getSubscriberByEmail(db, email);
			return row?.id ?? null;
		},

		async bumpRateLimit(fromAddr, hourBucket) {
			return incrementRateLimit(db, fromAddr, hourBucket);
		},

		async insertInboxRow(r) {
			const id = await insertInboxMessage(db, {
				from_addr: r.fromAddr,
				subscriber_id: r.subscriberId,
				dkim_pass: r.dkimPass,
				spf_pass: r.spfPass,
				subject: r.subject,
				body_text: r.bodyText,
				status: r.status,
				message_id: r.messageId,
				in_reply_to: r.inReplyTo,
				references: r.referencesHeader,
				thread_id: r.threadId,
			});
			// `insertInboxMessage` (src/db/queries.ts, S1.1) has no `result_note`
			// parameter — that column is written by `markInboxHandled`, which
			// also stamps `handled_at`. That's correct for `ignored` rows (they
			// really are terminal, nothing will process them further) but wrong
			// for `deferred` ones (§12.4: picked up by the next scheduled run —
			// not "handled" yet), so it's used only for the former; a narrow
			// direct update covers the latter without implying it's done. If
			// queries.ts grows a combined insert-with-note helper, both branches
			// collapse into one call.
			if (!r.resultNote) return;
			if (r.status === 'ignored') {
				await markInboxHandled(db, id, { status: 'ignored', result_note: r.resultNote });
			} else {
				await db.prepare(`UPDATE inbox SET result_note = ? WHERE id = ?`).bind(r.resultNote, id).run();
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Pure helpers — exported individually so the done-when checks can exercise
// each one directly, not just the end-to-end handler.
// ---------------------------------------------------------------------------

/** Parses the `Authentication-Results` header for DKIM/SPF verdicts.
 * DESIGN.md §11.1: "Check DKIM/SPF pass rather than trusting the `From`
 * header, which is trivially spoofed." We never trust `from` alone. */
export function parseAuthResults(headers: Headers): { dkimPass: boolean; spfPass: boolean; raw: string | null } {
	const raw = headers.get('authentication-results');
	if (!raw) return { dkimPass: false, spfPass: false, raw: null };
	const dkim = raw.match(/\bdkim=(\w+)/i);
	const spf = raw.match(/\bspf=(\w+)/i);
	return {
		dkimPass: dkim?.[1]?.toLowerCase() === 'pass',
		spfPass: spf?.[1]?.toLowerCase() === 'pass',
		raw,
	};
}

/** DESIGN.md §12.4 / IMPLEMENTATION_PLAN.md S1.4: drop mail carrying
 * `Auto-Submitted` (other than `no`), `Precedence: bulk`/`list`, or any
 * `List-*` header — the classic shape of an autoresponder or mailing list
 * that would otherwise ping-pong with our replies forever. */
export function checkLoopRisk(headers: Headers): { risk: boolean; reason: string | null } {
	const autoSubmitted = headers.get('auto-submitted');
	if (autoSubmitted && autoSubmitted.trim().toLowerCase() !== 'no') {
		return { risk: true, reason: `Auto-Submitted: ${autoSubmitted}` };
	}

	const precedence = headers.get('precedence');
	if (precedence && ['bulk', 'list'].includes(precedence.trim().toLowerCase())) {
		return { risk: true, reason: `Precedence: ${precedence}` };
	}

	for (const key of headers.keys()) {
		if (key.toLowerCase().startsWith('list-')) {
			return { risk: true, reason: `List header present: ${key}` };
		}
	}

	return { risk: false, reason: null };
}

/** Strips angle brackets and surrounding whitespace from a Message-ID-shaped
 * token so the same id compares equal however it was quoted. */
export function normalizeMessageId(id: string): string {
	return id.trim().replace(/^</, '').replace(/>$/, '');
}

/** DESIGN.md §11.2: "derive a `thread_id`" from `Message-ID` /
 * `In-Reply-To` / `References`. The root of a thread is the *first* id in
 * `References` (RFC 5322 §3.6.4 has clients append, not prepend, so the
 * oldest message is first). Falls back to `In-Reply-To`, then to this
 * message's own `Message-ID` when it starts a new thread. */
export function deriveThreadId(messageId: string | null, inReplyTo: string | null, references: string | null): string {
	if (references) {
		const ids = references
			.split(/\s+/)
			.map((s) => s.trim())
			.filter(Boolean);
		if (ids.length > 0) return normalizeMessageId(ids[0]);
	}
	if (inReplyTo) return normalizeMessageId(inReplyTo);
	if (messageId) return normalizeMessageId(messageId);
	// No threading headers at all (some senders omit Message-ID). Still need a
	// stable, non-colliding thread root; a random id starts a new thread of one.
	return `generated:${crypto.randomUUID()}`;
}

/** Hour bucket for the rate limiter, e.g. "2026-09-01T14". A fixed UTC
 * bucket rather than a rolling window — simpler, and precise enough for a
 * safety net rather than an SLA (see PROGRESS.md). */
export function hourBucket(date: Date): string {
	return date.toISOString().slice(0, 13);
}

/** Reads the raw MIME stream and returns *only* the raw text following the
 * header block, capped at MAX_BODY_CHARS. Deliberately not a MIME parser:
 * this step stores the body for a later step to interpret (§11.1) and must
 * not spend CPU decoding multipart/quoted-printable/base64 content it isn't
 * allowed to act on anyway. */
export async function extractBodyText(raw: ReadableStream<Uint8Array>): Promise<string> {
	const full = await new Response(raw).text();
	const headerEnd = full.search(/\r?\n\r?\n/);
	const body = headerEnd === -1 ? '' : full.slice(headerEnd).replace(/^\r?\n\r?\n/, '');
	return body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body;
}

// ---------------------------------------------------------------------------
// Core handler — DB-agnostic so it can be driven by an in-memory stub in
// tests and by `createD1InboundDb` in production.
// ---------------------------------------------------------------------------

export interface InboundResult {
	status: InboxStatus;
	reason?: string;
}

export async function handleInboundEmail(message: InboundEmailLike, db: InboundDb, now: Date = new Date()): Promise<InboundResult> {
	const headers = message.headers;
	const fromAddr = message.from;

	const messageId = headers.get('message-id');
	const inReplyTo = headers.get('in-reply-to');
	const references = headers.get('references');
	const subject = headers.get('subject');
	const auth = parseAuthResults(headers);
	const threadId = deriveThreadId(messageId, inReplyTo, references);
	const receivedAt = now.toISOString();

	const writeIgnored = async (reason: string, subscriberId: number | null) => {
		await db.insertInboxRow({
			fromAddr,
			subscriberId,
			dkimPass: auth.dkimPass,
			spfPass: auth.spfPass,
			subject,
			bodyText: null, // never bothers reading/storing the body of dropped mail
			messageId,
			inReplyTo,
			referencesHeader: references,
			threadId,
			receivedAt,
			status: 'ignored',
			resultNote: reason,
		});
		return { status: 'ignored' as const, reason };
	};

	// 1. Loop guards, before anything else and regardless of who the sender
	// is — a known subscriber's vacation autoresponder is exactly the case
	// this exists to catch (DESIGN.md §14.7).
	const loop = checkLoopRisk(headers);
	if (loop.risk) {
		return writeIgnored(`loop-guard: ${loop.reason}`, null);
	}

	// 2. Sender must be both a known subscriber AND authenticated. Trusting
	// `from` alone is exactly what §11.1 warns against.
	const subscriberId = await db.findSubscriberIdByEmail(fromAddr);
	if (subscriberId === null) {
		return writeIgnored('unknown sender', null);
	}
	if (!auth.dkimPass && !auth.spfPass) {
		return writeIgnored('sender matched but DKIM and SPF both failed', subscriberId);
	}

	// 3. Per-sender hourly cap, enforced before anything downstream can spend
	// money (§12.3/§12.4): the 7th message in an hour is deferred, not
	// handled.
	const bucket = hourBucket(now);
	const countThisHour = await db.bumpRateLimit(fromAddr, bucket);
	const bodyText = await extractBodyText(message.raw);

	if (countThisHour > HOURLY_CAP) {
		await db.insertInboxRow({
			fromAddr,
			subscriberId,
			dkimPass: auth.dkimPass,
			spfPass: auth.spfPass,
			subject,
			bodyText,
			messageId,
			inReplyTo,
			referencesHeader: references,
			threadId,
			receivedAt,
			status: 'deferred',
			resultNote: `rate limit: message ${countThisHour} from this sender in bucket ${bucket} (cap ${HOURLY_CAP})`,
		});
		return { status: 'deferred', reason: 'rate limited' };
	}

	// 4. Capture, untouched. Interpretation is a later step's job entirely.
	await db.insertInboxRow({
		fromAddr,
		subscriberId,
		dkimPass: auth.dkimPass,
		spfPass: auth.spfPass,
		subject,
		bodyText,
		messageId,
		inReplyTo,
		referencesHeader: references,
		threadId,
		receivedAt,
		status: 'pending',
		resultNote: null,
	});
	return { status: 'pending' };
}

// ---------------------------------------------------------------------------
// Worker wiring
// ---------------------------------------------------------------------------

/** Entry point wired into the Worker's default export (see `src/index.ts`).
 * Kept to plumbing only — all logic lives in `handleInboundEmail` above so
 * it can be unit-tested without a real `ForwardableEmailMessage`. */
export async function emailHandler(message: ForwardableEmailMessage, env: Env): Promise<void> {
	const db = createD1InboundDb(env.DB);
	await handleInboundEmail(message, db);
	// Deliberately no forward/reply/setReject call here: capture only. The
	// sender gets no response until S4.6 interprets the row.
}
