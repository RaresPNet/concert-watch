/**
 * The single choke point for every *billed* Anthropic API call
 * (IMPLEMENTATION_PLAN.md S4.4, DESIGN.md §3 / §11.4-§11.5). Once S4.5's
 * agent tools and S4.6's inbound command handler exist, neither should call
 * the Anthropic API directly -- everything on the reply path routes through
 * a `ModelSession` here, so metering (the `usage` table) and the hard
 * per-thread caps (§11.5 / §12.4) are enforced in one place instead of being
 * re-implemented, or forgotten, per caller.
 *
 * Explicitly out of scope: the scheduled/app-quota work (daily digest, the
 * `dark`-artist search sweep, tour-page parsing, the reachability refresh,
 * and artist resolution run during a scheduled pass -- DESIGN.md §6.4) runs
 * over MCP on Claude's own scheduled-task quota and never touches this file.
 * `src/core/resolve.ts` (S3.1) predates this client and makes its own direct
 * `fetch` call to the Anthropic API for exactly that reason: it is
 * scheduled/resolution work, not reply-path work, so per this step's own
 * scope note it is intentionally NOT migrated to use this client. See
 * PROGRESS.md's S4.4 entry.
 */

import { recordUsage } from '../db/queries';

// ---------------------------------------------------------------------------
// Models and pricing (DESIGN.md §11.5)
// ---------------------------------------------------------------------------

/** Common case: watchlist CRUD, priority changes, confirmations, listing, did-you-mean. */
export const MODEL_HAIKU = 'claude-haiku-4-5-20251001';
/** Escalation target: trip planning, anything needing web search. */
export const MODEL_SONNET = 'claude-sonnet-5';

export type ModelId = typeof MODEL_HAIKU | typeof MODEL_SONNET;

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';

/**
 * $ per million tokens, taken verbatim from DESIGN.md §11.5's routing table
 * ("Haiku 4.5 ... $1/$5 per MTok", "Sonnet 5 ... $2/$10 per MTok"). These are
 * the numbers the whole cost model in §12.2 is built on, so `est_cost` is
 * computed against them rather than against Anthropic's live list price (the
 * two can drift apart over time -- e.g. Sonnet 5 currently carries a lower
 * introductory rate on top of this at the API level). If Anthropic repricing
 * makes this materially wrong, update this table and DESIGN.md §11.5/§12.2
 * together, not just one of them.
 */
const PRICING_PER_MTOK: Record<ModelId, { input: number; output: number }> = {
	[MODEL_HAIKU]: { input: 1, output: 5 },
	[MODEL_SONNET]: { input: 2, output: 10 },
};

export function estimateCost(model: ModelId, inputTokens: number, outputTokens: number): number {
	const pricing = PRICING_PER_MTOK[model];
	return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

/** A tool definition in Anthropic's `tools[]` shape. Deliberately untyped beyond this -- S4.5 owns the actual tool set. */
export interface AnthropicToolDef {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
}

export interface AnthropicTextBlock {
	type: 'text';
	text: string;
}

export interface AnthropicToolUseBlock {
	type: 'tool_use';
	id: string;
	name: string;
	input: unknown;
}

/** Anything else Anthropic returns (thinking blocks, server-tool blocks, etc.) -- passed through untouched. */
export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | { type: string; [key: string]: unknown };

export interface AnthropicToolResultParam {
	type: 'tool_result';
	tool_use_id: string;
	content: string;
	is_error?: boolean;
}

export interface AnthropicCacheableTextBlock {
	type: 'text';
	text: string;
	cache_control?: { type: 'ephemeral' };
}

export type AnthropicMessageContentPart = AnthropicContentBlock | AnthropicToolResultParam | AnthropicCacheableTextBlock;

export interface AnthropicMessageParam {
	role: 'user' | 'assistant';
	content: string | AnthropicMessageContentPart[];
}

export type AnthropicToolChoice = { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string };

export interface ModelCallRequest {
	model: ModelId;
	/** Plain system prompt text. Combine with `cacheThread: true` to mark it cacheable. */
	system?: string;
	messages: AnthropicMessageParam[];
	tools?: AnthropicToolDef[];
	toolChoice?: AnthropicToolChoice;
	maxTokens?: number;
	/**
	 * Marks the system prompt and the last content block of the last message
	 * with Anthropic's `cache_control: {type: "ephemeral"}` --
	 * DESIGN.md §11.5's "prompt caching on the thread path only, where several
	 * turns land within minutes and cache hits cost 10% of base input."
	 *
	 * Pass `true` only when this call is another turn in an existing,
	 * recently-active thread (the common case for the tool-using loop S4.5
	 * builds). Leave it `false`/omitted for a single isolated call -- per
	 * §11.5, "isolated emails hours apart would pay the cache write for
	 * nothing."
	 */
	cacheThread?: boolean;
}

export interface ModelUsage {
	inputTokens: number;
	outputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
	estCost: number;
}

export interface ModelCallSuccess {
	ok: true;
	model: ModelId;
	content: AnthropicContentBlock[];
	stopReason: string;
	usage: ModelUsage;
	/** Number of `tool_use` blocks in this response -- how much of the tool-call cap this one call consumed. */
	toolUseCount: number;
}

export type CapBreachReason = 'tool_calls' | 'input_tokens';

export interface ModelCallCapBreach {
	ok: false;
	capBreached: CapBreachReason;
	message: string;
}

export type ModelCallResult = ModelCallSuccess | ModelCallCapBreach;

/** A real transport/API failure (network error, non-2xx response, malformed body) -- distinct from a cap breach, which is not an error. */
export class ModelCallError extends Error {
	readonly status?: number;
	readonly body?: string;

	constructor(message: string, status?: number, body?: string) {
		super(message);
		this.name = 'ModelCallError';
		this.status = status;
		this.body = body;
	}
}

// ---------------------------------------------------------------------------
// Hard caps (DESIGN.md §11.5 / §12.4)
// ---------------------------------------------------------------------------

/**
 * "Hard caps per email: 8 tool calls..." (DESIGN.md §11.5) originally, raised
 * to 20 in S5.2: 8 was an anti-runaway guess, not a cost control, and a real
 * multi-band onboarding reply (via `add_artists`, one call regardless of
 * list length) or a trip-planning turn can legitimately spend several tool
 * calls before writing a word. `MAX_INPUT_TOKENS_PER_SESSION` below is the
 * real cost control and is unchanged.
 */
export const MAX_TOOL_CALLS_PER_SESSION = 20;
/** "...40k total input tokens..." (DESIGN.md §11.5). */
export const MAX_INPUT_TOKENS_PER_SESSION = 40_000;

export interface ModelSessionOptions {
	db: D1Database;
	anthropicApiKey: string;
	/** Written to `usage.path` -- a free-text label for this billed path, e.g. `"reply"` or `"trip_planning"`. */
	path: string;
	/** Injectable for tests; defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
	/** Injectable for tests; defaults to `() => new Date()`. */
	now?: () => Date;
}

/**
 * One logical "thread-handling attempt" -- DESIGN.md §11.5's unit for the
 * hard caps, in practice one live email and however many tool-use turns it
 * takes to answer it (S4.5's loop will call `call()` once per turn on the
 * same `ModelSession`). Escalating from Haiku to Sonnet mid-thread
 * (§11.5's `escalate(reason)` tool) is just calling `call()` again with
 * `model: MODEL_SONNET` on the same session -- the cumulative caps
 * deliberately carry over rather than resetting, since they bound the whole
 * thread-handling attempt, not one model's share of it.
 *
 * Caps are checked *before* a call is attempted, never discovered after the
 * fact: a breach returns `{ ok: false, capBreached, message }` instead of
 * throwing, so a caller can react per §11.5 ("reply honestly... rather than
 * looping") instead of catching an exception mid-loop.
 *
 * Every call that actually reaches the API -- success only; a refused,
 * pre-flight-capped call never touches the network and has nothing to meter
 * -- is written to the `usage` table before `call()` returns.
 */
export class ModelSession {
	private totalInputTokens = 0;
	private totalToolCalls = 0;
	private readonly db: D1Database;
	private readonly apiKey: string;
	private readonly path: string;
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => Date;

	constructor(opts: ModelSessionOptions) {
		this.db = opts.db;
		this.apiKey = opts.anthropicApiKey;
		this.path = opts.path;
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.now = opts.now ?? (() => new Date());
	}

	/** Tokens billed so far this session, across every model used. */
	get cumulativeInputTokens(): number {
		return this.totalInputTokens;
	}

	/** Tool calls the model has made so far this session, across every turn. */
	get cumulativeToolCalls(): number {
		return this.totalToolCalls;
	}

	async call(request: ModelCallRequest): Promise<ModelCallResult> {
		if (this.totalInputTokens >= MAX_INPUT_TOKENS_PER_SESSION) {
			return {
				ok: false,
				capBreached: 'input_tokens',
				message: `session already at ${this.totalInputTokens} input tokens (cap ${MAX_INPUT_TOKENS_PER_SESSION})`,
			};
		}
		if (this.totalToolCalls >= MAX_TOOL_CALLS_PER_SESSION) {
			return {
				ok: false,
				capBreached: 'tool_calls',
				message: `session already made ${this.totalToolCalls} tool calls (cap ${MAX_TOOL_CALLS_PER_SESSION})`,
			};
		}

		const body = buildRequestBody(request);
		const res = await this.fetchImpl(ANTHROPIC_MESSAGES_URL, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-api-key': this.apiKey,
				'anthropic-version': ANTHROPIC_API_VERSION,
			},
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new ModelCallError(`Anthropic Messages API ${res.status} ${res.statusText}`, res.status, text.slice(0, 500));
		}

		const data = (await res.json()) as {
			content: AnthropicContentBlock[];
			stop_reason: string;
			usage: {
				input_tokens: number;
				output_tokens: number;
				cache_creation_input_tokens?: number;
				cache_read_input_tokens?: number;
			};
		};

		const inputTokens = data.usage.input_tokens;
		const outputTokens = data.usage.output_tokens;
		const estCost = estimateCost(request.model, inputTokens, outputTokens);
		const toolUseCount = data.content.filter((b) => b.type === 'tool_use').length;

		// Meter first, then update in-memory totals -- a thrown error from
		// recordUsage should not leave the session's own accounting out of
		// sync with what actually got billed.
		await recordUsage(this.db, {
			day: isoDay(this.now()),
			path: this.path,
			model: request.model,
			input_tokens: inputTokens,
			output_tokens: outputTokens,
			est_cost: estCost,
		});

		this.totalInputTokens += inputTokens;
		this.totalToolCalls += toolUseCount;

		return {
			ok: true,
			model: request.model,
			content: data.content,
			stopReason: data.stop_reason,
			usage: {
				inputTokens,
				outputTokens,
				cacheCreationInputTokens: data.usage.cache_creation_input_tokens ?? 0,
				cacheReadInputTokens: data.usage.cache_read_input_tokens ?? 0,
				estCost,
			},
			toolUseCount,
		};
	}
}

/** Convenience constructor -- equivalent to `new ModelSession(opts)`, kept for a slightly more readable call site in S4.5/S4.6. */
export function createModelSession(opts: ModelSessionOptions): ModelSession {
	return new ModelSession(opts);
}

function isoDay(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function buildRequestBody(request: ModelCallRequest): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: request.model,
		max_tokens: request.maxTokens ?? 1024,
		messages: request.cacheThread ? markLastMessageCacheable(request.messages) : request.messages,
	};
	if (request.system) {
		body.system = request.cacheThread ? [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }] : request.system;
	}
	if (request.tools) body.tools = request.tools;
	if (request.toolChoice) body.tool_choice = request.toolChoice;
	return body;
}

/**
 * Marks the last content block of the last message as cacheable. Anthropic's
 * prompt caching is a prefix match, so this is the correct place to put the
 * breakpoint for "everything before this message" to be reusable by the
 * *next* turn in the same thread (that next call will itself carry one more
 * message and re-mark the new last block, moving the breakpoint forward).
 */
function markLastMessageCacheable(messages: AnthropicMessageParam[]): AnthropicMessageParam[] {
	if (messages.length === 0) return messages;
	const lastIdx = messages.length - 1;
	const last = messages[lastIdx];

	if (typeof last.content === 'string') {
		return [
			...messages.slice(0, lastIdx),
			{ ...last, content: [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }] },
		];
	}
	if (last.content.length === 0) return messages;

	const lastBlockIdx = last.content.length - 1;
	const newContent = last.content.map((block, i) => (i === lastBlockIdx ? { ...block, cache_control: { type: 'ephemeral' } } : block));
	return [...messages.slice(0, lastIdx), { ...last, content: newContent }];
}
