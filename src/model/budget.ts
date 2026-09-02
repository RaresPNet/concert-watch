/**
 * The monthly spend ceiling for the reply path (DESIGN.md §12.5): "Above a
 * configurable monthly ceiling, live replies degrade to being handled by the
 * next scheduled run on app quota -- slower, still working, no longer
 * billing. Rareș gets one notice line in the next digest."
 *
 * This file is the cheap pre-flight check plus the degrade decision and
 * notice text. It deliberately does NOT implement the hand-off mechanism
 * itself (writing an `inbox` row to a deferred/pending status so the next
 * scheduled MCP run picks it up) -- that belongs to S4.6's inbound command
 * handler, which does not exist yet. What's exposed here is exactly what
 * S4.6 needs to make that call correctly: a status check
 * (`getBudgetStatus`/`isOverMonthlyBudget`), a pure decision function
 * (`decideReplyHandling`), and the one-line digest notice
 * (`formatBudgetDegradeNotice`).
 */

import { getUsageForMonth } from '../db/queries';

/**
 * DESIGN.md §12.2 estimates normal spend at "the order of a dollar or two a
 * month." $8 leaves roughly 4-8x headroom over that estimate -- enough to
 * absorb a busier-than-usual month of trip planning (Sonnet-tier, §11.5)
 * without being so high it stops meaning anything as a ceiling. This is a
 * judgment call, not a number derived from the design doc -- see PROGRESS.md's
 * S4.4 entry, which flags it explicitly. Override per-environment via the
 * `MODEL_MONTHLY_CEILING_USD` wrangler var (see wrangler.jsonc's `vars`).
 */
export const DEFAULT_MONTHLY_CEILING_USD = 8;

export interface BudgetEnv {
	MODEL_MONTHLY_CEILING_USD?: string;
}

/** Reads the configured ceiling from `env.MODEL_MONTHLY_CEILING_USD` if present and valid, else the documented default. */
export function getMonthlyCeiling(env?: BudgetEnv): number {
	const raw = env?.MODEL_MONTHLY_CEILING_USD;
	if (!raw) return DEFAULT_MONTHLY_CEILING_USD;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MONTHLY_CEILING_USD;
}

export interface BudgetStatus {
	/** `YYYY-MM`, the month this status is computed for. */
	yyyyMm: string;
	monthToDateCost: number;
	ceiling: number;
	overBudget: boolean;
}

/** Month-to-date spend against the `usage` table, compared to the configured ceiling (DESIGN.md §12.5). */
export async function getBudgetStatus(db: D1Database, env: BudgetEnv | undefined, now: Date): Promise<BudgetStatus> {
	const yyyyMm = now.toISOString().slice(0, 7);
	const rows = await getUsageForMonth(db, yyyyMm);
	const monthToDateCost = rows.reduce((sum, r) => sum + r.est_cost, 0);
	const ceiling = getMonthlyCeiling(env);
	return { yyyyMm, monthToDateCost, ceiling, overBudget: monthToDateCost >= ceiling };
}

/**
 * Cheap pre-flight check -- call this before attempting any live reply-path
 * model call (i.e. before constructing a `ModelSession` in `client.ts`).
 */
export async function isOverMonthlyBudget(db: D1Database, env: BudgetEnv | undefined, now: Date = new Date()): Promise<boolean> {
	const status = await getBudgetStatus(db, env, now);
	return status.overBudget;
}

export type DegradeAction = 'proceed_live' | 'defer_to_scheduled';

/**
 * The decision S4.6's inbound handler needs when a new email arrives: spend
 * on it live (the normal path), or defer it to the next scheduled run on app
 * quota (DESIGN.md §12.5's degrade). Kept as a pure function over an already-
 * computed `BudgetStatus` so it's trivially unit-testable without touching D1.
 */
export function decideReplyHandling(status: BudgetStatus): DegradeAction {
	return status.overBudget ? 'defer_to_scheduled' : 'proceed_live';
}

/**
 * The "one notice line" DESIGN.md §12.5 promises in the next digest. Only
 * meaningful when `status.overBudget` is true; callers should not print this
 * otherwise. Composing the actual digest email is out of scope here (S4.1-ish
 * territory) -- this just produces the line's text.
 */
export function formatBudgetDegradeNotice(status: BudgetStatus): string {
	return (
		`Live email replies are paused for the rest of ${status.yyyyMm} ` +
		`(spend $${status.monthToDateCost.toFixed(2)} reached the $${status.ceiling.toFixed(2)} monthly ceiling) -- ` +
		`they'll be picked up by tomorrow's scheduled run instead.`
	);
}
