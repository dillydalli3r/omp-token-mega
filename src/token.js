/**
 * The tool-result reducer.
 *
 * The idea in one sentence: shrink a tool result *before it is ever sent*, and never touch
 * anything that has already been sent.
 *
 * Why that constraint rather than "compress the context": every provider's cache is a
 * prefix cache. DeepSeek only hits when its leading tokens match a persisted cache unit
 * byte for byte, OpenAI matches 128-token blocks from the start of the request, Anthropic
 * matches at, and after, an explicit breakpoint — and all of them miss from the first token
 * that changed. Rewriting history therefore trades an expensive miss for a cheap hit, and
 * independent A/B work on history-rewriting compressors measures a *worse* end-to-end bill
 * than doing nothing. Reducing what is appended, before it is appended, carries no such
 * trade: the reduced text is what the session stores and replays, so the prefix stays
 * byte-stable and the saving is paid out again on every subsequent request.
 *
 * So this feature subscribes to exactly one payload-bearing event, `tool_result`, and
 * returns only a content replacement. It registers no `context`, `before_provider_request`
 * or `before_agent_start` handler — which is what makes the non-interference claim
 * checkable rather than aspirational: the system prompt, the tool catalogue and the message
 * log are exactly what omp would have built without it. In particular the prefix-cache
 * accounting this same plugin runs keeps measuring an untouched prefix; the only way the
 * reducer moves those numbers is by sending fewer tokens, never by turning a cache hit into
 * a miss.
 *
 * It also deliberately does not reimplement omp's own reductions — artifact spill at
 * `tools.artifactSpillThreshold`, pre-compaction `pruneToolOutputs`, `supersedeReads`,
 * `dropUseless`, `shake`, snapcompact, structural `read` summaries. Those are already
 * cache-aware, and a second implementation would only add a second way to be wrong. When
 * omp has already elided a result, this feature compresses what is left and skips its own
 * budget.
 */

import { compressionConfig, resolveAgentDir, toolSelected } from "./config.js";
import { compressionMarker, duplicateMarker, elide, elisionMarker, reduce, worthwhile } from "./compress.js";
import { createDuplicateIndex } from "./dedupe.js";
import { catalogue, formatAudit, readCoreSettings, systemPromptSections } from "./audit.js";
import { formatBytes, formatTokens, lineCost, timing, tokensFromBytes, utf8Bytes } from "./measure.js";
import { tokenSection } from "./report.js";

function emptyStats() {
	return {
		results: 0,
		reduced: 0,
		savedBytes: 0,
		markerBytes: 0,
		byRule: { squeeze: 0, fold: 0, clip: 0, json: 0, elide: 0, dedupe: 0 },
		duplicates: 0,
		stashes: 0,
		stashFailures: 0,
		skipped: { small: 0, large: 0, outOfScope: 0, noWin: 0, native: 0 },
	};
}

export function installToken(pi, shell) {
	const state = {
		ctx: undefined,
		index: createDuplicateIndex(),
		stats: emptyStats(),
		/** Rolling sample of tool-result hook durations in ms; capped so it cannot grow. */
		perf: [],
		/** Tool name -> calls this session, for the audit's "never called" list. */
		calls: new Map(),
	};

	const values = () => shell.values();
	/** Master switch and this feature's own switch, both of which have to be on. */
	const active = () => values().enabled === true && values()["token.enabled"] === true;

	function perfSummary() {
		return values()["token.perf"] === true ? timing(state.perf) : undefined;
	}

	/**
	 * Store removed text as a session artifact — the same store, and the same `artifact://`
	 * URL, omp's own spill uses, so the model needs no new vocabulary to recover it.
	 */
	async function stash(ctx, toolName, text) {
		if (values()["token.stash"] !== true || typeof text !== "string" || text === "") return undefined;
		try {
			const id = await ctx?.sessionManager?.saveArtifact?.(text, toolName || "tool");
			if (typeof id === "string" && id !== "") {
				state.stats.stashes += 1;
				return `artifact://${id}`;
			}
			return undefined;
		} catch {
			state.stats.stashFailures += 1;
			return undefined;
		}
	}

	/** omp's own elision marker, when it already spilled this result to an artifact. */
	function nativeArtifact(details) {
		const id = details?.meta?.truncation?.artifactId;
		return typeof id === "string" && id !== "" ? id : undefined;
	}

	function textBlocks(content) {
		return Array.isArray(content) ? content.filter((block) => block?.type === "text" && typeof block.text === "string") : [];
	}

	/** A result that is one text block and nothing else: the only shape replaced wholesale. */
	function soleTextBlock(content) {
		if (!Array.isArray(content) || content.length !== 1) return undefined;
		const block = content[0];
		return block?.type === "text" && typeof block.text === "string" ? block : undefined;
	}

	function replaceText(content, replacement) {
		const out = [];
		let placed = false;
		for (const block of content) {
			if (block?.type === "text" && typeof block.text === "string") {
				if (!placed) {
					out.push({ ...block, text: replacement });
					placed = true;
				}
				continue;
			}
			out.push(block);
		}
		return out;
	}

	/**
	 * The pipeline for one tool result. Returns replacement content, or undefined to leave
	 * the result exactly as omp produced it. Never throws: `tool_result` handlers are
	 * fail-closed, so an exception here would fail the tool call itself.
	 */
	async function processResult(event, ctx) {
		const cfg = values();
		const stats = state.stats;
		const content = event.content;
		stats.results += 1;

		const blocks = textBlocks(content);
		if (blocks.length === 0) return undefined;

		let total = 0;
		for (const block of blocks) total += utf8Bytes(block.text);
		if (total < cfg["token.minChars"]) {
			stats.skipped.small += 1;
			return undefined;
		}
		if (total > cfg["token.maxScanBytes"]) {
			// Bounded work: past this size omp's own spill is the right tool, not this one.
			stats.skipped.large += 1;
			return undefined;
		}

		const sole = soleTextBlock(content);
		const original = sole?.text;
		const spill = nativeArtifact(event.details);
		// Errors are load-bearing: they get the lossless passes and nothing else. An elided
		// stack trace or a collapsed assertion is a wrong answer, not a saving.
		const losslessOnly = event.isError === true;

		// 1. Duplicate: these exact bytes are already in this session's transcript, so a
		//    back-reference plus a recovery handle costs a line instead of a copy.
		if (original !== undefined && cfg["token.dedupe"] === true && !losslessOnly && !state.index.skips(original)) {
			const earlier = state.index.lookup(original);
			if (earlier) {
				const handle = earlier.handle ?? (await stash(ctx, earlier.toolName, original));
				if (handle) earlier.handle = handle;
				const stub = duplicateMarker(earlier.toolName, utf8Bytes(original), handle);
				const net = utf8Bytes(original) - lineCost(stub);
				if (worthwhile(utf8Bytes(original), lineCost(stub), cfg["token.minSavingsTokens"])) {
					state.index.count(earlier);
					state.index.remember(event.toolName, original, handle);
					stats.duplicates += 1;
					stats.byRule.dedupe += utf8Bytes(original);
					stats.markerBytes += lineCost(stub);
					stats.savedBytes += net;
					stats.reduced += 1;
					return { content: replaceText(content, stub) };
				}
			}
		}

		// 2. Lossless-in-content passes, per text block.
		const compression = compressionConfig(cfg);
		const replacement = new Map();
		let gross = 0;
		let markers = 0;
		for (const block of blocks) {
			const reduced = reduce(block.text, compression);
			if (reduced.savedBytes <= 0) continue;
			const markerText = compressionMarker(reduced.savedBytes, reduced.steps);
			if (!worthwhile(reduced.savedBytes, lineCost(markerText), cfg["token.minSavingsTokens"])) {
				stats.skipped.noWin += 1;
				continue;
			}
			replacement.set(block, `${reduced.text}\n${markerText}`);
			gross += reduced.savedBytes;
			markers += lineCost(markerText);
			for (const [rule, bytes] of Object.entries(reduced.steps)) stats.byRule[rule] += bytes;
		}

		// 3. Budget: a tighter per-tool lever than omp's global spill threshold, applied only
		//    to a whole-result replacement, only when omp has not already elided this result,
		//    and never to an error.
		if (sole && cfg["token.maxChars"] > 0 && !losslessOnly) {
			const current = replacement.get(sole) ?? sole.text;
			if (spill) {
				if (utf8Bytes(current) > cfg["token.maxChars"]) stats.skipped.native += 1;
			} else if (utf8Bytes(current) > cfg["token.maxChars"]) {
				const elided = elide(current, { headChars: cfg["token.headChars"], tailChars: cfg["token.tailChars"] });
				const dropped = utf8Bytes(current) - utf8Bytes(elided.head) - utf8Bytes(elided.tail);
				if (elided.removedBytes > 0 && dropped > 0) {
					// The handle points at the text as it arrived, not at the text after the
					// lossless passes: "full output" has to mean the full output.
					const handle = await stash(ctx, event.toolName, original ?? current);
					const markerText = elisionMarker(
						elided.removedBytes,
						handle ?? "(not stashed; re-read the source, or raise `token.maxChars`)",
					);
					if (worthwhile(dropped, lineCost(markerText), cfg["token.minSavingsTokens"])) {
						replacement.set(sole, `${elided.head}\n${markerText}\n${elided.tail}`);
						gross += dropped;
						markers += lineCost(markerText);
						stats.byRule.elide += dropped;
					} else {
						stats.skipped.noWin += 1;
					}
				}
			}
		}

		if (replacement.size === 0) {
			if (original !== undefined) state.index.remember(event.toolName, original);
			return undefined;
		}

		const out = content.map((block) => (replacement.has(block) ? { ...block, text: replacement.get(block) } : block));
		stats.markerBytes += markers;
		stats.savedBytes += gross - markers;
		stats.reduced += 1;
		// Index what arrived, not what was sent: a repeat of the same command must match the
		// first occurrence, whose stored text may already be reduced.
		if (original !== undefined) state.index.remember(event.toolName, original);
		return { content: out };
	}

	pi.on("session_start", async (_event, ctx) => {
		state.ctx = ctx;
		shell.render();
	});

	pi.on("session_switch", async (_event, ctx) => {
		// The counters describe a session; a different session starts from zero.
		state.ctx = ctx;
		reset();
		shell.render();
	});

	// Observability only. The audit turns these counts into "these schemas ride in every
	// request and were never used".
	pi.on("tool_execution_start", async (event) => {
		if (typeof event?.toolName === "string") state.calls.set(event.toolName, (state.calls.get(event.toolName) ?? 0) + 1);
	});

	pi.on("tool_result", async (event, ctx) => {
		state.ctx = ctx;
		const cfg = values();
		if (!active()) return undefined;
		if (!toolSelected(cfg["token.tools"], event.toolName)) {
			state.stats.skipped.outOfScope += 1;
			return undefined;
		}
		const started = cfg["token.perf"] === true ? performance.now() : 0;
		try {
			const result = await processResult(event, ctx);
			if (result) shell.render();
			return result;
		} catch {
			// A token optimisation must never fail a tool call.
			return undefined;
		} finally {
			if (started > 0) {
				state.perf.push(performance.now() - started);
				if (state.perf.length > 256) state.perf.shift();
			}
		}
	});

	pi.on("session_shutdown", async () => {
		state.ctx = undefined;
		state.index.reset();
	});

	function reset() {
		state.stats = emptyStats();
		state.perf = [];
		state.calls = new Map();
		state.index.reset();
	}

	/** One row segment: what the reducer removed, and how much of it was not rewritten. */
	function segment() {
		const cfg = values();
		if (cfg.enabled !== true) return undefined;
		if (cfg["token.enabled"] !== true) return "TS off";
		if (state.stats.results === 0) return `TS ready · ${shell.config().preset}`;
		const parts = [];
		if (state.stats.savedBytes > 0) {
			parts.push(
				`TS -${formatBytes(state.stats.savedBytes)} (~${formatTokens(tokensFromBytes(state.stats.savedBytes))} tok)`,
			);
		} else {
			parts.push("TS 0 saved");
		}
		parts.push(`${state.stats.reduced}/${state.stats.results} results`);
		if (state.stats.duplicates > 0) parts.push(`${state.stats.duplicates} dup`);
		const skippedNative = state.stats.skipped.native;
		if (skippedNative > 0) parts.push(`${skippedNative} via omp`);
		const perf = perfSummary();
		if (perf) parts.push(`${perf.median.toFixed(2)}ms`);
		const preset = shell.config().preset;
		if (preset !== "balanced") parts.push(preset);
		return parts.join(" \u00b7 ");
	}

	/** Markdown section for `/mega` and `/mega report`. */
	function section(ctx) {
		return tokenSection({
			config: shell.config(),
			stats: state.stats,
			perf: perfSummary(),
			index: state.index,
			model: shell.modelKey(ctx),
		});
	}

	/**
	 * Tool metadata, or empty when this mode does not expose it. Every surface the audit
	 * reads is optional: print, RPC and ACP wire up different subsets, and a diagnostic
	 * that throws on a missing one is worse than one that reports less.
	 */
	function toolSnapshot() {
		try {
			const tools = pi.getAllTools();
			const active = pi.getActiveTools();
			return { tools: Array.isArray(tools) ? tools : [], active: Array.isArray(active) ? active : [] };
		} catch {
			return { tools: [], active: [] };
		}
	}

	function contextUsage(ctx) {
		try {
			return ctx.getContextUsage() ?? undefined;
		} catch {
			return undefined;
		}
	}

	function promptSections(ctx) {
		try {
			return systemPromptSections(ctx.getSystemPrompt());
		} catch {
			return { sections: [], totalBytes: 0 };
		}
	}

	/** `/mega audit`: where this session's input tokens go, and which omp knobs to change. */
	async function audit(ctx) {
		const agentDir = resolveAgentDir(ctx);
		const core = await readCoreSettings({ agentDir, cwd: ctx.cwd });
		const { tools, active: activeTools } = toolSnapshot();
		return formatAudit({
			config: shell.config(),
			core,
			usage: contextUsage(ctx),
			prompt: promptSections(ctx),
			catalog: catalogue(tools, activeTools, state.calls),
			stats: state.stats,
			perf: perfSummary(),
		});
	}

	return { segment, section, audit, reset, state };
}
