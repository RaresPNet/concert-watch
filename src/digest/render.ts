/**
 * HTML/plain-text rendering for the daily digest (IMPLEMENTATION_PLAN.md
 * S4.2, DESIGN.md §10). Renders a `DigestPayload` (S4.1's fixed contract,
 * `payload.types.ts`) into the two bodies `SendMailInput` (S1.3,
 * `src/mail/mailer.ts`) requires: `html` and `text`.
 *
 * String templating only, deliberately -- no JSX, no template-engine
 * dependency, no image processing. DESIGN.md §3.1 flags rendering the digest
 * HTML as one of the two places most likely to trip the Workers Free plan's
 * 10ms CPU budget (`EXCEEDED_CPU`); string concatenation over a handful of
 * tour blocks is cheap by construction, so there is nothing here to budget
 * carefully -- just nothing to avoid adding either (no DOM parser, no HTML
 * sanitiser library, no Intl.DateTimeFormat, all date formatting is manual
 * UTC field extraction).
 *
 * Tables and inline CSS only per §10.4 (Outlook renders with Word's engine --
 * no flexbox, no grid, anywhere in this file). Dark mode is handled
 * explicitly via a `prefers-color-scheme: dark` block plus `color-scheme`
 * meta tags, per §10.4's "dark mode inverts backgrounds unless explicitly
 * handled." Single column, one image per tour, per §10.4.
 */

import type { ContextualAffordance, DigestEventSummary, DigestPayload, DigestTourBlock } from './payload.types';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Escapes text for safe placement inside HTML element content or attributes. */
function escapeHtml(input: string): string {
	return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Formats an ISO datetime/date string as "12 Mar 2027". Uses UTC field
 * extraction rather than `Intl.DateTimeFormat` or client-local `Date`
 * methods -- cheaper, and deterministic regardless of the Worker's runtime
 * timezone (always UTC in practice, but this avoids depending on that).
 * Returns null for null/unparseable input so callers can omit the field
 * cleanly instead of printing "Invalid Date".
 */
function formatDate(iso: string | null): string | null {
	if (!iso) return null;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Comma-joins non-null, non-empty parts. */
function joinParts(parts: Array<string | null | undefined>, sep = ', '): string {
	return parts.filter((p): p is string => !!p && p.length > 0).join(sep);
}

// ---------------------------------------------------------------------------
// Rotating copy (§10.2): 2-3 phrasings per affordance category, plus the
// standing footer, rotated deterministically rather than printed identically
// every time. Rotation is `id % variants.length` -- no real randomness
// needed, per the plan's own note.
// ---------------------------------------------------------------------------

const AFFORDANCE_COPY: Record<Exclude<ContextualAffordance, null>, string[]> = {
	trip_help: [
		"Reply and I'll work out how to get there.",
		"Say the word and I'll sketch out a trip for this one.",
		'Want routes and prices? Just reply.',
	],
	onsale_nudge: [
		'Want a nudge the day before tickets drop?',
		'I can ping you right before this goes on sale -- just ask.',
		"Say so and I'll remind you before the on-sale window opens.",
	],
	multi_date_ask: [
		"Reply for the full list, or ask about a city that isn't here.",
		"There's more than this -- reply if you want every date, or a specific city.",
		"Only the closest few are shown. Ask and I'll send the rest.",
	],
	awkward_p1: [
		"This one's awkward to reach -- ask me and I'll see what's possible.",
		"Not an easy trip from here, but ask and I'll look into it anyway.",
		'Getting to this one takes some work -- reply if you want me to dig in.',
	],
};

/** Picks the rotating phrasing for a tour block's affordance, or null if it has none. */
function affordanceLine(tour: DigestTourBlock): string | null {
	if (!tour.affordance) return null;
	const variants = AFFORDANCE_COPY[tour.affordance];
	return variants[tour.tour_id % variants.length];
}

const FOOTER_VARIANTS = [
	"Reply any time to add or remove a band, change a band's priority, pause this digest, or just ask a question.",
	"You can reply to this email to manage your bands, change a priority, pause things, or ask something -- it's a conversation, not just a notice.",
	"This inbox listens: reply to add or drop a band, adjust a priority, pause the digest, or ask anything about what's above.",
];

/** Picks the rotating footer, keyed off something that varies run to run rather than a constant per subscriber. */
function footerLine(payload: DigestPayload): string {
	const seed = payload.tours.reduce((acc, t) => acc + t.notification_ids.reduce((a, b) => a + b, 0), payload.subscriber_id);
	return FOOTER_VARIANTS[seed % FOOTER_VARIANTS.length];
}

// ---------------------------------------------------------------------------
// Tier badge
// ---------------------------------------------------------------------------

const TIER_COLOR: Record<'A' | 'B' | 'C' | 'D', { bg: string; fg: string }> = {
	A: { bg: '#1a7f37', fg: '#ffffff' },
	B: { bg: '#0969da', fg: '#ffffff' },
	C: { bg: '#9a6700', fg: '#ffffff' },
	D: { bg: '#57606a', fg: '#ffffff' },
};

function tierBadgeHtml(tier: DigestEventSummary['tier']): string {
	if (!tier) return '';
	const c = TIER_COLOR[tier];
	return `<span style="display:inline-block;padding:2px 7px;border-radius:4px;background-color:${c.bg};color:${c.fg};font-size:11px;font-weight:700;letter-spacing:0.02em;">${tier}</span>`;
}

// ---------------------------------------------------------------------------
// Per-date row (§10.1: "three most reachable dates, each with tier, venue,
// city, route note, and on-sale date")
// ---------------------------------------------------------------------------

function renderEventHtml(ev: DigestEventSummary): string {
	const when = formatDate(ev.starts_at) ?? 'date TBC';
	const place = joinParts([ev.venue_name, ev.city, ev.country]);
	// §3.4's PROGRESS.md note: an event can have no reachability row at all
	// (tier null). Omit the badge and route note rather than printing "null".
	const badge = tierBadgeHtml(ev.tier);
	const routeNote =
		ev.tier && ev.route_note ? `<div style="font-size:12px;color:#6e7781;margin-top:2px;">${escapeHtml(ev.route_note)}</div>` : '';
	const onsale = ev.onsale_at
		? `<div style="font-size:12px;color:#6e7781;margin-top:2px;">On sale ${escapeHtml(formatDate(ev.onsale_at) ?? '')}</div>`
		: '';
	const link = ev.ticket_url
		? `<div style="margin-top:4px;"><a href="${escapeHtml(ev.ticket_url)}" style="font-size:12px;color:#0969da;text-decoration:underline;">Tickets</a></div>`
		: '';

	return `
	<tr>
		<td style="padding:8px 0;border-top:1px solid #e5e7eb;" class="row-border">
			<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
				<tr>
					<td style="font-size:14px;font-weight:600;color:#1f2328;padding-right:8px;white-space:nowrap;vertical-align:top;" class="text-primary">${escapeHtml(when)}</td>
					<td style="font-size:14px;color:#1f2328;vertical-align:top;" class="text-primary">
						${place ? escapeHtml(place) : ''}${badge ? ` &nbsp;${badge}` : ''}
						${routeNote}
						${onsale}
						${link}
					</td>
				</tr>
			</table>
		</td>
	</tr>`;
}

// ---------------------------------------------------------------------------
// Tour block (§10.1: band name, image, date range + count, official link,
// top three dates, handle)
// ---------------------------------------------------------------------------

function renderTourBlockHtml(tour: DigestTourBlock): string {
	const dateRange = joinParts([formatDate(tour.first_date), tour.last_date !== tour.first_date ? formatDate(tour.last_date) : null], ' – ');
	const countLabel = `${tour.date_count} date${tour.date_count === 1 ? '' : 's'}`;
	const heading = joinParts([tour.label, dateRange || null], ' — ') || dateRange;

	const image = tour.artist_image_url
		? `<img src="${escapeHtml(tour.artist_image_url)}" width="72" height="72" alt="${escapeHtml(tour.artist_name)}" style="display:block;border-radius:6px;width:72px;height:72px;object-fit:cover;background-color:#e5e7eb;" />`
		: `<div style="width:72px;height:72px;border-radius:6px;background-color:#e5e7eb;" class="img-placeholder"></div>`;

	const officialLink = tour.official_url
		? `<a href="${escapeHtml(tour.official_url)}" style="font-size:13px;color:#0969da;text-decoration:underline;">Official tour page</a>`
		: '';

	const handle = tour.handle
		? `<span style="font-size:11px;color:#8c959f;font-family:ui-monospace,Menlo,Consolas,monospace;" class="text-muted">${escapeHtml(tour.handle)}</span>`
		: '';

	const moreExpected = tour.more_dates_expected
		? `<tr><td style="font-size:12px;color:#6e7781;padding-top:4px;font-style:italic;" class="text-muted">More dates for this tour are expected.</td></tr>`
		: '';

	const eventsHtml = tour.top_dates.map(renderEventHtml).join('');

	const affordance = affordanceLine(tour);
	const affordanceHtml = affordance
		? `<tr><td style="padding-top:10px;font-size:13px;color:#0969da;" class="link-color">${escapeHtml(affordance)}</td></tr>`
		: '';

	return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
	<tr>
		<td style="background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;" class="card-bg card-border">
			<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
				<tr>
					<td width="72" style="padding-right:14px;vertical-align:top;">${image}</td>
					<td style="vertical-align:top;">
						<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
							<tr>
								<td style="font-size:17px;font-weight:700;color:#1f2328;" class="text-primary">
									${escapeHtml(tour.artist_name)} ${handle ? `&nbsp;${handle}` : ''}
								</td>
							</tr>
							<tr>
								<td style="font-size:13px;color:#57606a;padding-top:2px;" class="text-secondary">
									${escapeHtml(heading || '')} &nbsp;·&nbsp; ${escapeHtml(countLabel)}
								</td>
							</tr>
							${officialLink ? `<tr><td style="padding-top:4px;">${officialLink}</td></tr>` : ''}
							${moreExpected}
						</table>
					</td>
				</tr>
			</table>
			<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;">
				${eventsHtml}
				${affordanceHtml}
			</table>
		</td>
	</tr>
</table>`;
}

// ---------------------------------------------------------------------------
// Full HTML document
// ---------------------------------------------------------------------------

/** Inline styles are the baseline (for clients that strip <style>); the <style> block layers dark-mode overrides on top, per §10.4. */
const STYLE_BLOCK = `
	<style>
		body, table, td { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
		table { border-collapse: collapse; }
		img { -ms-interpolation-mode: bicubic; }
		a { color: #0969da; }
		@media (prefers-color-scheme: dark) {
			.body-bg { background-color: #0d1117 !important; }
			.container-bg { background-color: #0d1117 !important; }
			.card-bg { background-color: #161b22 !important; }
			.card-border { border-color: #30363d !important; }
			.row-border { border-color: #30363d !important; }
			.text-primary { color: #e6edf3 !important; }
			.text-secondary { color: #9198a1 !important; }
			.text-muted { color: #8b949e !important; }
			.link-color { color: #4493f8 !important; }
			.img-placeholder { background-color: #30363d !important; }
			a { color: #4493f8 !important; }
		}
	</style>`;

/**
 * Renders the full digest email HTML for one subscriber's payload.
 *
 * Callers should not pass a payload with an empty `tours` array in normal
 * operation -- S4.1's `DigestBuildResult` returns `{ send: false }` for that
 * case instead, per its own done-when. This function still renders something
 * valid rather than throwing if it ever is called that way (defensive, not
 * a supported path) -- see PROGRESS.md's "Left undone" for this step.
 */
export function renderDigestHtml(payload: DigestPayload): string {
	const greetingName = payload.display_name ? escapeHtml(payload.display_name) : null;
	const greeting = greetingName ? `Hi ${greetingName},` : 'Hi,';

	const body =
		payload.tours.length > 0
			? payload.tours.map(renderTourBlockHtml).join('')
			: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="font-size:14px;color:#57606a;" class="text-secondary">Nothing to report today.</td></tr></table>`;

	const footer = footerLine(payload);

	return `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<meta http-equiv="X-UA-Compatible" content="IE=edge" />
	<meta name="color-scheme" content="light dark" />
	<meta name="supported-color-schemes" content="light dark" />
	<title>Concert watch digest</title>
	${STYLE_BLOCK}
</head>
<body style="margin:0;padding:0;background-color:#f6f8fa;" class="body-bg">
	<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f6f8fa;" class="container-bg">
		<tr>
			<td align="center" style="padding:24px 12px;">
				<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
					<tr>
						<td style="padding-bottom:18px;font-size:15px;color:#1f2328;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" class="text-primary">
							${greeting}
						</td>
					</tr>
					<tr>
						<td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
							${body}
						</td>
					</tr>
					<tr>
						<td style="padding-top:8px;font-size:12px;line-height:1.5;color:#6e7781;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" class="text-muted">
							${escapeHtml(footer)}
						</td>
					</tr>
				</table>
			</td>
		</tr>
	</table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Plain-text alternative (required on every send: DESIGN.md §3, mailer.ts's
// `SendMailInput.text`)
// ---------------------------------------------------------------------------

function renderEventText(ev: DigestEventSummary): string {
	const when = formatDate(ev.starts_at) ?? 'date TBC';
	const place = joinParts([ev.venue_name, ev.city, ev.country]);
	const lines = [`  - ${when}${place ? ` — ${place}` : ''}${ev.tier ? ` [tier ${ev.tier}]` : ''}`];
	if (ev.tier && ev.route_note) lines.push(`    ${ev.route_note}`);
	if (ev.onsale_at) lines.push(`    On sale ${formatDate(ev.onsale_at)}`);
	if (ev.ticket_url) lines.push(`    Tickets: ${ev.ticket_url}`);
	return lines.join('\n');
}

function renderTourBlockText(tour: DigestTourBlock): string {
	const dateRange = joinParts([formatDate(tour.first_date), tour.last_date !== tour.first_date ? formatDate(tour.last_date) : null], ' - ');
	const countLabel = `${tour.date_count} date${tour.date_count === 1 ? '' : 's'}`;
	const lines: string[] = [];

	const handleSuffix = tour.handle ? ` (${tour.handle})` : '';
	lines.push(`${tour.artist_name}${handleSuffix}`);
	lines.push(joinParts([tour.label, dateRange, countLabel], ' - '));
	if (tour.official_url) lines.push(`Tour page: ${tour.official_url}`);
	if (tour.more_dates_expected) lines.push('More dates for this tour are expected.');
	lines.push('');
	lines.push(...tour.top_dates.map(renderEventText));

	const affordance = affordanceLine(tour);
	if (affordance) {
		lines.push('');
		lines.push(affordance);
	}

	return lines.join('\n');
}

/** Renders the plain-text alternative body for the same `DigestPayload` `renderDigestHtml` renders. */
export function renderDigestText(payload: DigestPayload): string {
	const greeting = payload.display_name ? `Hi ${payload.display_name},` : 'Hi,';

	const body =
		payload.tours.length > 0
			? payload.tours.map(renderTourBlockText).join('\n\n----------------------------------------\n\n')
			: 'Nothing to report today.';

	const footer = footerLine(payload);

	return [greeting, '', body, '', '----------------------------------------', '', footer].join('\n');
}

/** Convenience wrapper for callers building a `SendMailInput` (S1.3) directly from a payload. */
export function renderDigest(payload: DigestPayload): { html: string; text: string } {
	return { html: renderDigestHtml(payload), text: renderDigestText(payload) };
}
