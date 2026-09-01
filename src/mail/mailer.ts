/**
 * The mailer interface. Everything in the codebase that needs to send an
 * email depends on this file, never on a concrete implementation.
 *
 * DESIGN.md §3 requires sending to stay behind a thin, swappable interface:
 * "If the verified-destination route ever stops being workable, Resend's
 * free tier (3,000/month) is a one-file swap." That is the constraint this
 * file exists to satisfy — it must not leak anything Cloudflare-specific
 * (binding types, EmailMessageBuilder shapes, Cloudflare error codes) so a
 * `src/mail/resend.ts` implementing the same `Mailer` interface can be
 * dropped in later without touching this file or any caller.
 */

/** A single recipient/sender address. */
export interface MailAddress {
	email: string;
	name?: string;
}

/** One or more addresses, as callers naturally have them. */
export type MailAddressInput = string | MailAddress | Array<string | MailAddress>;

export interface SendMailInput {
	to: MailAddressInput;
	subject: string;
	/** HTML body. */
	html: string;
	/**
	 * Plain-text alternative. Required, not optional — every outbound email
	 * must carry one (DESIGN.md §3, IMPLEMENTATION_PLAN.md S1.3), both for
	 * accessibility/deliverability and because Paula's mail client is
	 * unknown.
	 */
	text: string;
	/** Extra headers to set or override (e.g. threading headers). */
	headers?: Record<string, string>;
}

export interface SendMailResult {
	/**
	 * The Message-ID of the sent message, in the form callers can store
	 * verbatim and later match against inbound `In-Reply-To` / `References`
	 * headers for threading (S1.4). Implementations must return the *actual*
	 * sent value, not a value they merely requested.
	 */
	messageId: string;
}

/**
 * Thrown when a caller asks to send to a recipient the implementation will
 * not send to. Mailer implementations that enforce a recipient allow-list
 * (e.g. "verified destination addresses only" on Cloudflare's free plan,
 * DESIGN.md §3) should throw this rather than letting the send fail
 * upstream, so the guard is enforced locally and cheaply.
 */
export class MailRecipientRejectedError extends Error {
	readonly email: string;

	constructor(email: string, reason: string) {
		super(`refusing to send to ${email}: ${reason}`);
		this.name = 'MailRecipientRejectedError';
		this.email = email;
	}
}

/** Thrown when the underlying transport rejects or fails a send. */
export class MailSendError extends Error {
	/** Transport-specific error code, if one was reported (e.g. Cloudflare's `E_*` codes). */
	readonly code?: string;
	readonly cause?: unknown;

	constructor(message: string, opts?: { code?: string; cause?: unknown }) {
		super(message);
		this.name = 'MailSendError';
		this.code = opts?.code;
		this.cause = opts?.cause;
	}
}

/** The narrow contract every mailer implementation must satisfy. */
export interface Mailer {
	send(input: SendMailInput): Promise<SendMailResult>;
}

/** Normalises a `MailAddressInput` into a flat array of `MailAddress`. */
export function toMailAddressList(input: MailAddressInput): MailAddress[] {
	const arr = Array.isArray(input) ? input : [input];
	return arr.map((a) => (typeof a === 'string' ? { email: a } : a));
}
