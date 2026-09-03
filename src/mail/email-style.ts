/**
 * Shared visual tokens for every HTML email this system sends: the digest
 * (`src/digest/render.ts`, deterministic template over a `DigestPayload`)
 * and the reply path (`src/mail/format.ts`, a light markdown-subset renderer
 * over model-generated text).
 *
 * The two don't share a rendering *engine* -- one turns structured D1 data
 * into a fixed table-per-tour layout, the other turns free text a model
 * wrote into a handful of block shapes (paragraph/list/table), and those are
 * different enough problems that forcing one template function to do both
 * would mean the digest's layout degrading to "whatever a paragraph-shaped
 * renderer can do," or the reply path carrying a `DigestTourBlock`-shaped
 * schema no model output actually has. What *should* be shared, and wasn't
 * before this file existed, is the palette -- so a reply and a digest read
 * as the same product instead of drifting apart color by color.
 */

export const EMAIL_FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export const EMAIL_COLORS = {
	textPrimary: '#1f2328',
	textSecondary: '#57606a',
	textMuted: '#6e7781',
	border: '#e5e7eb',
	link: '#0969da',
	pageBg: '#f6f8fa',
	cardBg: '#ffffff',
} as const;

/** `prefers-color-scheme: dark` counterparts to `EMAIL_COLORS`, same keys. */
export const EMAIL_COLORS_DARK = {
	textPrimary: '#e6edf3',
	textSecondary: '#9198a1',
	textMuted: '#8b949e',
	border: '#30363d',
	link: '#4493f8',
	pageBg: '#0d1117',
	cardBg: '#161b22',
} as const;

/** Reachability tier badge colors (§10.1's A/B/C/D tiers) -- currently only the digest renders a badge, but a reply table may want one too. */
export const TIER_COLOR: Record<'A' | 'B' | 'C' | 'D', { bg: string; fg: string }> = {
	A: { bg: '#1a7f37', fg: '#ffffff' },
	B: { bg: '#0969da', fg: '#ffffff' },
	C: { bg: '#9a6700', fg: '#ffffff' },
	D: { bg: '#57606a', fg: '#ffffff' },
};
