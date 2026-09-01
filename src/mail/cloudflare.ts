/**
 * Cloudflare Email Service implementation of `Mailer` (DESIGN.md §3, §3.1;
 * IMPLEMENTATION_PLAN.md S1.3).
 *
 * Uses the `send_email` Workers binding (see `wrangler.jsonc` -> `EMAIL`)
 * and its structured `EmailMessageBuilder` send() overload — no raw MIME
 * construction needed. Current shape verified against the `SendEmail` /
 * `EmailMessageBuilder` / `EmailSendResult` types generated into
 * `worker-configuration.d.ts` by `wrangler types` for this project's
 * installed wrangler version (4.127.1), and cross-checked against
 * developers.cloudflare.com/email-service/api/send-emails/workers-api/ and
 * .../get-started/send-emails/ (fetched 2026-09-01), since this API predates
 * this file and may have changed since any earlier training data.
 *
 * Free-plan constraint (DESIGN.md §3, §3.1): sending only works, for free,
 * to destination addresses verified in the account's Email Routing. This
 * implementation refuses locally (`MailRecipientRejectedError`) rather than
 * letting an unverified send fail upstream — cheaper to diagnose and keeps
 * the failure mode a caller can catch before D1 state changes.
 *
 * Loop-guard headers (DESIGN.md §12.4): every outbound message carries
 * `Auto-Submitted: auto-replied` and `Precedence: bulk` so that automated
 * responders on the other end (out-of-office autoresponders etc.) don't
 * treat our mail as something to reply to, and so our own inbound handler
 * (S1.4) can recognise and drop anything that loops back.
 */

import { MailRecipientRejectedError, MailSendError, toMailAddressList } from './mailer';
import type { Mailer, MailAddress, SendMailInput, SendMailResult } from './mailer';

/** Predicate deciding whether a recipient address may be sent to. */
export type RecipientGuard = (email: string) => boolean;

export interface CloudflareMailerOptions {
	/** The `From` address (and optional display name) used for every send. */
	from: string | MailAddress;
	/**
	 * Optional guard applied to every recipient before sending. Callers wire
	 * this to `subscribers.verified_at` (DESIGN.md §3) — deliberately kept as
	 * an injected predicate rather than a D1 query here, so this file has no
	 * knowledge of the schema and stays a pure transport adapter.
	 *
	 * When omitted, no local check is performed (useful for one-off/manual
	 * sends, e.g. verification testing, where the caller already knows the
	 * destination is verified).
	 */
	isVerifiedRecipient?: RecipientGuard;
}

/**
 * Loop-guard and provenance headers applied to every send, per DESIGN.md
 * §12.4. Callers may override any of these via `SendMailInput.headers`
 * (e.g. threading headers from S1.4), since a later spread wins.
 */
const BASE_HEADERS: Record<string, string> = {
	'Auto-Submitted': 'auto-replied',
	Precedence: 'bulk',
};

function formatAddress(addr: MailAddress): string {
	return addr.email;
}

export class CloudflareMailer implements Mailer {
	private readonly binding: SendEmail;
	private readonly from: MailAddress;
	private readonly isVerifiedRecipient?: RecipientGuard;

	constructor(binding: SendEmail, options: CloudflareMailerOptions) {
		this.binding = binding;
		this.from = typeof options.from === 'string' ? { email: options.from } : options.from;
		this.isVerifiedRecipient = options.isVerifiedRecipient;
	}

	async send(input: SendMailInput): Promise<SendMailResult> {
		const recipients = toMailAddressList(input.to);
		if (recipients.length === 0) {
			throw new MailSendError('send() requires at least one recipient');
		}

		if (this.isVerifiedRecipient) {
			for (const r of recipients) {
				if (!this.isVerifiedRecipient(r.email)) {
					throw new MailRecipientRejectedError(
						r.email,
						'not a verified Email Routing destination address (Workers Free plan requires verification, DESIGN.md §3)',
					);
				}
			}
		}

		try {
			const result = await this.binding.send({
				from: formatAddress(this.from),
				to: recipients.map(formatAddress),
				subject: input.subject,
				html: input.html,
				text: input.text,
				headers: {
					...BASE_HEADERS,
					...input.headers,
				},
			});

			return { messageId: result.messageId };
		} catch (err) {
			const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
			const message = err instanceof Error ? err.message : String(err);
			throw new MailSendError(`Cloudflare Email Service send failed: ${message}`, { code, cause: err });
		}
	}
}
