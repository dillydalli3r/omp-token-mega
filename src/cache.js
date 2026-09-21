/**
 * Prefix-cache accounting, attribution and config hygiene.
 *
 * Scope: every model this plugin can account for, which is every model whose provider
 * reports cached input tokens — `deepseek`, `opencode-go`, the Google routes, `lithosai`,
 * `anthropic`, `openai`, `openrouter` — or whose catalogue declares a cache-read rate. The
 * gate is that capability (`cacheCapable`), not a provider list, because omp normalizes
 * every provider's usage record into the same token fields, so one accounting path serves
 * them all. Where a model reports cached tokens without registering a rate, the hit rate and
 * the token counts still stand and only the money is unknown — a hit rate that cannot be
 * priced is still the figure that tells a user whether the prefix is holding. On a model
 * that reports neither, nothing is fingerprinted, nothing is persisted, no shard is written.
 *
 * The mechanism is the same everywhere: an automatic prefix cache that a request hits only
 * where its leading tokens match a persisted cache unit byte for byte, which is why what
 * gets fingerprinted is *what changed in the prefix*. omp protects that prefix by itself
 * only where it auto-enables `provider.appendOnlyContext` — `deepseek`, the local engines,
 * and routes whose compat config sets `supportsStore` — so on every other provider the
 * system prompt and the tool catalogue are re-serialized each turn, and a prefix cache can
 * read that as a change. Reporting that is the largest cache win available here, which is
 * why it is a section of its own (`stability`) and a row part, and why it is advice only:
 * this feature is deliberately read-only on the request path — it never rewrites a payload,
 * every claim it makes is derived from provider-reported usage or from a fingerprint it
 * computed itself, and the one omp setting worth changing is printed as a command for the
 * user to run rather than written behind their back.
 *
 * Only the tariff is provider-specific: DeepSeek prices a peak and an off-peak card, and
 * `peakLabel` returns nothing for a model that declares no schedule (LithosAI bills three
 * flat rates), so the row simply carries no period there. That peak/off-peak card is the
 * only provider-specific thing left in this module.
 */

import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { activeModel, appendOnlyAutoEnabled, cachePriced, isCacheCapable, modelKey } from "./model.js";
import { cacheSavings, cacheStats, peakLabel, priceMultiplier } from "./deepseek.js";
import { MISS_REASONS, attributeMiss, driftNote, fingerprint, toolsFingerprint } from "./prefix.js";
import {
	addTotals,
	createStore,
	pruneShards,
	readSubagentTotals,
	resolveStateDir,
	summarize,
} from "./stats.js";
import { fix, rollback, scan } from "./repair.js";
import { resolveAgentDir } from "./config.js";
import { money } from "./measure.js";

export function installCache(pi, shell) {
	const state = {
		ctx: undefined,
		store: undefined,
		systemPromptId: undefined,
		pending: undefined,
		/** Cause set by a lifecycle event (compaction, branch, resume) for the next miss. */
		pendingCause: undefined,
		lastRequestAt: 0,
		lastSeen: undefined,
		/** Aggregated subagent totals, refreshed when a task call ends. */
		agents: undefined,
	};

	const values = () => shell.values();

	/** Loaded = a cache-capable model is active and both the master and this switch are on. */
	const active = () => values().enabled === true && values()["cache.enabled"] === true && isCacheCapable(state.ctx);

	function payloadMessages(payload) {
		if (Array.isArray(payload?.messages)) return payload.messages;
		if (Array.isArray(payload?.input)) return payload.input;
		return [];
	}

	function ensureStore(ctx) {
		if (state.store) return state.store;
		const dir = resolveStateDir(ctx, values().stateDir);
		const store = createStore({ dir, sessionId: ctx?.sessionManager?.getSessionId?.() });
		if (dir) void mkdir(join(dir, "shards"), { recursive: true }).catch(() => {});
		state.store = store;
		return store;
	}

	/** Shards nothing has written for `cache.retentionDays` are dead weight; drop them. */
	function prune(ctx) {
		const dir = resolveStateDir(ctx, values().stateDir);
		const days = values()["cache.retentionDays"];
		if (!dir || !(days > 0)) return;
		void pruneShards(dir, { retentionDays: days, excludeInstanceId: state.store?.instanceId }).catch(() => {});
	}

	/**
	 * Session-wide numbers: this session file plus every subagent session this process
	 * spawned. A child's cache lineage is its own, but the tokens it burns and saves are
	 * the session's, so the row reports the sum and names the child count separately.
	 */
	function sessionView() {
		const main = summarize(state.store?.snapshot()?.totals);
		const agents = values()["cache.subagents"] === true ? state.agents : undefined;
		const total = agents?.shards > 0 ? summarize(addTotals(main, agents)) : main;
		return { main, agents, total };
	}

	/** Compact token count for the row: 128 → `128`, 119,700 → `120k`. */
	const tokens = (value) => (value >= 1000 ? `${Math.round(value / 1000)}k` : String(value));

	/**
	 * One row segment: hit rate, cache reads, the money they avoided, and any drift.
	 *
	 * Parts are returned unjoined — the row renderer owns the separator — because the tariff
	 * part carries a tone, and a part flattened into a plain string cannot be tinted afterwards.
	 */
	function segment() {
		if (!active()) return undefined;
		const model = activeModel(state.ctx);
		const { total, agents } = sessionView();
		if (!state.store || total.requests === 0) return "cache: no requests yet";
		const parts = [];
		parts.push(`cache ${total.hitRate === undefined ? "?" : `${Math.round(total.hitRate * 100)}%`}`);
		if (total.cachedInputTokens > 0) parts.push(`${tokens(total.cachedInputTokens)} cached`);
		if (total.savedUsd > 0) parts.push(`$${money(total.savedUsd, 2)} saved`);
		if (agents?.shards > 0) {
			const agentHit = summarize(agents).hitRate;
			parts.push(`${agents.shards} agents${agentHit === undefined ? "" : ` ${Math.round(agentHit * 100)}%`}`);
		}
		// The tariff is the one figure that changes meaning rather than size, so it is the one
		// part that carries a tone: red while the headline rate is in force, green while it is
		// discounted. `peakLabel` is undefined when both periods bill the same, in which case
		// the row says nothing about a period at all.
		const peak = peakLabel(model);
		if (peak) parts.push({ text: peak.text, color: peak.period === "peak" ? "red" : "green" });
		const drift = state.lastSeen?.drift;
		if (drift) parts.push(`\u26a0 ${drift}`);
		// Nudge, not a fault: the guard above has already established that a cache-capable
		// model is live and that a request was billed, so all that is left is a miss this
		// session and a provider where omp will not pin the prefix by itself. Yellow, because
		// one forced setting removes every miss this part is about.
		if (missCount() > 0 && !appendOnlyAutoEnabled(model) && values()["cache.appendOnly"] !== false) {
			parts.push({ text: "\u26a0 append-only off", color: "yellow" });
		}
		return parts;
	}

	/** Misses attributed in this session's own shard; subagent shards keep their own counts. */
	function missCount() {
		let total = 0;
		for (const count of Object.values(state.store?.snapshot()?.misses?.byReason ?? {})) total += count;
		return total;
	}

	/** Fingerprint the request prefix. Observational only — the payload is never replaced. */
	function captureRequest(payload, ctx) {
		const model = activeModel(ctx);
		const tools = toolsFingerprint(payload?.tools);
		return {
			modelKey: modelKey(model),
			system: state.systemPromptId,
			tools,
			messageCount: payloadMessages(payload).length,
			at: Date.now(),
		};
	}

	function accountResponse(message, ctx) {
		const store = state.store;
		if (!store || message?.role !== "assistant" || !message.usage) return;
		const model = activeModel(ctx);
		const stats = cacheStats(message.usage);
		// omp emits assistant messages with an all-zero usage record (observed on subagent
		// sessions and terminal turns). Counting those would invent requests and misses.
		if (stats.billedInput === 0 && stats.output === 0) return;
		const previous = store.lastFingerprint;
		const current = state.pending ?? {
			modelKey: modelKey(model),
			system: state.systemPromptId,
			tools: undefined,
			messageCount: 0,
			at: Date.now(),
		};
		// Priced at the moment the request was sent, so an off-peak turn is credited at
		// the off-peak card rather than the headline rate.
		const savings = cacheSavings(stats, model, current.at);
		const requests = store.snapshot().totals.requests;
		// A cold start is a miss too; counting it as `first_turn` keeps expected misses
		// separable from regressions instead of hiding them. A cause named by a lifecycle
		// event (compaction, branch, resume) is more precise, so it wins. A request whose
		// billed input is under `cache.minPrefixTokens` is below most providers' minimum
		// cacheable unit, so `attributeMiss` labels it instead of letting it read as an
		// unexplained miss; the key is read with `|| 0` here and nowhere else, which is the
		// agreed degradation when the setting is absent.
		const missed = !stats.hit;
		const missReason = missed
			? (state.pendingCause ??
				attributeMiss(previous, current, {
					idleMs: current.at - state.lastRequestAt,
					requests,
					idleTtlMs: values()["cache.idleTtlMinutes"] * 60_000,
					billedInput: stats.billedInput,
					minPrefixTokens: Number(values()["cache.minPrefixTokens"]) || 0,
				}))
			: undefined;
		state.pendingCause = undefined;
		const drift = driftNote(previous, current);

		store.recordRequest({ modelKey: current.modelKey, stats, savings, missReason, drift }, ctx);
		store.recordFingerprint(current, ctx);
		state.lastSeen = { ...current, drift: drift ?? undefined };
		state.lastRequestAt = Date.now();
		shell.render();
	}

	/** Read the shards this process's subagent sessions wrote. Never throws. */
	async function refreshAgents(ctx) {
		const store = state.store;
		if (values()["cache.subagents"] !== true) {
			state.agents = undefined;
			return state.agents;
		}
		try {
			state.agents = await readSubagentTotals(resolveStateDir(ctx, values().stateDir), {
				excludeInstanceId: store?.instanceId,
				sinceMs: store?.startedAt ?? 0,
			});
		} catch {
			state.agents = undefined;
		}
		return state.agents;
	}

	/** One line naming any cache.* setting that differs from its default. */
	function configSummary() {
		const cfg = shell.config();
		const changed = cfg.keys.filter((key) => key.startsWith("cache.") && cfg.sources[key] !== "default");
		if (changed.length === 0) return "all defaults (`/mega config`)";
		return changed.map((key) => `${key}=${cfg.values[key]} (${cfg.sources[key]})`).join(", ");
	}

	/** Markdown section for `/mega` and `/mega report`. */
	async function section(ctx) {
		const lines = [];
		const model = activeModel(ctx);
		const now = Date.now();
		lines.push("### Prefix cache", "");
		// The capability gate comes before anything that touches the filesystem: reading a
		// report is a diagnostic, and a model this plugin cannot account for deliberately
		// gets no store at session start, so a report must not hand it one — the shard such
		// a store writes at shutdown would be exactly the persistence the gate exists to
		// avoid.
		if (!isCacheCapable(ctx)) {
			lines.push(
				`- No cache accounting for \`${modelKey(model)}\`: its catalogue declares no cache-read rate and its provider is not one known to report cached input tokens, so there is no hit rate to compute. Nothing is fingerprinted or persisted.`,
			);
			return lines.join("\n");
		}
		// The tariff in force, plus the window it is priced by: the schedule's own UTC bounds
		// and the same window in the reader's zone, dated.
		const tariff = peakLabel(model, now);
		const store = ensureStore(ctx);
		const shard = store.snapshot();
		await refreshAgents(ctx);
		const { main, agents, total } = sessionView();
		const subagentsEnabled = values()["cache.subagents"] === true;

		lines.push(`- Model: \`${modelKey(model)}\``);
		if (!subagentsEnabled) lines.push("- Scope: this session only (`cache.subagents` is off)");
		else if (agents?.shards > 0) lines.push(`- Scope: this session plus ${agents.shards} subagent session(s) in this process`);
		else lines.push("- Scope: this session (no subagent sessions in this process)");
		lines.push(`- Requests: ${total.requests} (${total.hitRequests} with a cache hit)`);
		lines.push(`- Cached input tokens: ${total.cachedInputTokens.toLocaleString("en-US")}`);
		lines.push(`- Uncached input tokens: ${total.uncachedInputTokens.toLocaleString("en-US")}`);
		lines.push(`- Output tokens: ${total.outputTokens.toLocaleString("en-US")}`);
		lines.push(`- Session cost: $${total.costUsd.toFixed(6)}`);
		// The hit rate and the token counts survive a missing rate; only the money does not,
		// and "$0.00 saved" would read as a broken cache rather than an unpriced one.
		if (cachePriced(model)) lines.push(`- Saved by cache reads: $${total.savedUsd.toFixed(6)}`);
		else lines.push("- Saved by cache reads: unknown — the catalogue registers no cache-read rate, so cached tokens are counted but cannot be priced.");
		if (total.hitRate !== undefined) lines.push(`- Token-weighted hit rate: ${(total.hitRate * 100).toFixed(1)}%`);
		if (tariff) {
			const multiplier = priceMultiplier(model, now);
			const which = tariff.period === "peak" ? "window in force" : "next window";
			lines.push(
				`- Price period: ${tariff.period}${multiplier === 1 ? "" : ` (rates ×${multiplier}, so savings are discounted the same way)`} — ${which}: ${tariff.detail}`,
			);
		}

		lines.push("", "#### Cache economics", "");
		lines.push(...economicsLines(model, now));

		lines.push("", "#### Breakdown", "");
		lines.push(
			`- Main session: ${main.requests} request(s), ${main.hitRate === undefined ? "n/a" : `${(main.hitRate * 100).toFixed(1)}%`} hit, $${main.costUsd.toFixed(6)} cost, $${main.savedUsd.toFixed(6)} saved`,
		);
		if (agents?.shards > 0) {
			const agentHit = summarize(agents).hitRate;
			lines.push(
				`- Subagents (${agents.shards} session(s)): ${agents.requests} request(s), ${agentHit === undefined ? "n/a" : `${(agentHit * 100).toFixed(1)}%`} hit, $${agents.costUsd.toFixed(6)} cost, $${agents.savedUsd.toFixed(6)} saved`,
			);
			lines.push(
				"- Read from each child's own shard: a `task` result only carries usage for blocking spawns, so the parent cannot see an async child's tokens any other way.",
			);
		} else if (!subagentsEnabled) {
			lines.push("- Subagents: disabled by the `cache.subagents` setting.");
		} else if (!agents) {
			lines.push("- Subagents: unavailable — the shard directory could not be read.");
		} else {
			lines.push("- Subagents: none spawned in this process.");
		}

		const reasons = Object.entries(shard.misses.byReason ?? {}).filter(([, n]) => n > 0);
		lines.push("", "#### Misses by attributed cause (main session)", "");
		if (reasons.length === 0) lines.push("- None recorded.");
		else {
			for (const reason of MISS_REASONS) {
				const count = shard.misses.byReason?.[reason];
				if (count) lines.push(`- ${reason}: ${count}`);
			}
		}

		const drift = state.lastSeen?.drift;
		if (drift) lines.push("", `Current prefix drift: **${drift}**`);
		lines.push("", "#### Fingerprints (main session)", "");
		lines.push(`- System prompt: \`${state.systemPromptId ?? "unknown"}\``);
		lines.push(
			`- Tool catalogue: \`${state.lastSeen?.tools?.id ?? "unknown"}\` (${state.lastSeen?.tools?.names?.length ?? 0} tools)`,
		);
		lines.push(`- Config: ${configSummary()}`);
		if (store.path) lines.push(`- Shard: \`${store.path}\``);
		else lines.push("- Shard: not persisted (no session directory resolved)");
		lines.push("", "#### Prefix stability", "");
		lines.push(...stabilityLines(model));
		return lines.join("\n");
	}

	/**
	 * The registered rate card: what a cache read costs against an uncached input token, and
	 * the multiplier a scheduled tariff applies right now. The rates are read off the model's
	 * own cost record, so they are the catalogue's registered figures and not a quote — a
	 * promo, a batch tier or a negotiated price the catalogue does not carry is invisible
	 * here, and the section says so rather than implying the numbers are what gets billed.
	 */
	function economicsLines(model, now) {
		const lines = [];
		const input = Number(model?.cost?.input);
		const cacheRead = Number(model?.cost?.cacheRead);
		if (input > 0 && cacheRead > 0) {
			const discount = 1 - cacheRead / input;
			lines.push(
				`- Input $${money(input)}/1M tokens vs cache read $${money(cacheRead)}/1M: a hit is billed at ${(100 - discount * 100).toFixed(2)}% of the input rate, a discount of ${(discount * 100).toFixed(1)}%.`,
			);
		} else if (input > 0) {
			lines.push(
				`- Input $${money(input)}/1M tokens; no cache-read rate is registered, so there is no discount ratio to state and a hit's worth is counted in tokens only.`,
			);
		} else {
			lines.push("- The catalogue registers no input rate for this model, so no rate card can be stated from it.");
		}
		if (model?.cost?.timeBased) {
			lines.push(
				`- Time-based tariff declared: the scheduled rate in force at this instant is ×${priceMultiplier(model, now)} of the headline card, and a saving priced now is scaled by it.`,
			);
		}
		lines.push("- Registered rates, not a quote.");
		return lines;
	}

	/**
	 * Whether omp keeps the request prefix byte-stable here, and the one setting that makes it
	 * so where it does not.
	 *
	 * This is the only lever this plugin can name rather than measure, and it is a lever only
	 * the user can pull: writing an omp setting from a plugin would change how every other
	 * plugin's requests are serialized, so the remedy is printed as a command and never run.
	 */
	function stabilityLines(model) {
		const key = modelKey(model);
		if (appendOnlyAutoEnabled(model)) {
			return [
				`- Append-only context is automatic on \`${key}\`: omp's own rule covers it — \`deepseek\`, a local engine, a loopback/RFC1918/\`.local\` base URL, or a route whose compat config sets \`supportsStore\` — so the system prompt and the tool catalogue stay byte-identical between turns and only the message log grows.`,
			];
		}
		const lines = [
			`- Append-only context is NOT automatic on \`${key}\`: omp's auto rule covers \`deepseek\`, the local engines and store-backed routes, and this provider is none of them, so the system prompt and the tool catalogue are re-serialized every turn and a prefix cache may read that as a change.`,
		];
		// `cache.appendOnly` gates the advice, not the measurement: a user who turned it off
		// asked not to be told again, and the section still reports the drift it causes.
		if (values()["cache.appendOnly"] !== false) {
			lines.push(
				"- `omp config set provider.appendOnlyContext on` forces the same byte-stable prefix here; this plugin reports the setting and never writes it.",
			);
		} else {
			lines.push("- The recommendation is suppressed by `cache.appendOnly=false`.");
		}
		return lines;
	}

	/** `/mega cache stability` — the prefix-stability block on its own, as markdown. */
	function stability(ctx) {
		const model = activeModel(ctx);
		const lines = ["### Prefix stability", ""];
		if (!model) lines.push("- No model is loaded, so there is no provider to report on.");
		else lines.push(...stabilityLines(model));
		return lines.join("\n");
	}

	function formatScan(result) {
		const rows = [];
		for (const [label, file] of [
			["live", result.live],
			["legacy", result.legacy],
		]) {
			if (!file.exists) {
				rows.push(`- ${label} \`${file.path}\`: absent`);
				continue;
			}
			if (file.offenders.length === 0) {
				rows.push(`- ${label} \`${file.path}\`: clean`);
				continue;
			}
			rows.push(`- ${label} \`${file.path}\`: ${file.offenders.length} inert key(s)`);
			for (const offender of file.offenders) {
				rows.push(`  - line ${offender.line}: \`${offender.key}\` — ${offender.reason}`);
			}
		}
		return rows.join("\n");
	}

	function agentDir(ctx) {
		return resolveAgentDir(ctx) ?? values().stateDir;
	}

	/** `/mega cache doctor` — the compat-key scan, as a markdown block. */
	async function doctor(ctx) {
		const dir = agentDir(ctx);
		if (!dir) return "Could not resolve the omp agent directory.";
		const result = await scan(dir);
		return ["### Compat-key doctor", "", formatScan(result)].join("\n");
	}

	/** `/mega cache fix` — remove the inert keys, timestamped backup and receipt. */
	async function repair(ctx) {
		const dir = agentDir(ctx);
		if (!dir) return { message: "Could not resolve the omp agent directory.", level: "error" };
		const receipt = await fix(dir);
		const changed = receipt.changedFiles.length;
		return {
			message:
				changed === 0
					? "Nothing to repair: no inert compat keys found."
					: `Repaired ${changed} file(s); backups written next to each original.`,
			level: "info",
		};
	}

	/** `/mega cache rollback` — restore the files from the last receipt. */
	async function undo(ctx) {
		const dir = agentDir(ctx);
		if (!dir) return { message: "Could not resolve the omp agent directory.", level: "error" };
		const result = await rollback(dir);
		return result.ok
			? { message: `Restored: ${result.restored.join(", ")}`, level: "info" }
			: { message: `Rollback failed: ${result.error}`, level: "error" };
	}

	/** Zero this process's counters: a fresh shard, no fingerprints, no agents. */
	async function reset(ctx) {
		state.store = undefined;
		state.lastSeen = undefined;
		state.agents = undefined;
		state.lastRequestAt = 0;
		state.pending = undefined;
		state.pendingCause = undefined;
		if (active()) {
			const fresh = ensureStore(ctx);
			await fresh.flush();
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		state.ctx = ctx;
		if (active()) {
			ensureStore(ctx);
			prune(ctx);
		}
		shell.render();
	});
	pi.on("session_switch", async (event, ctx) => {
		// A different session is a different cache lineage: close the shard before
		// the next request is accounted, so two sessions never share counters.
		await state.store?.flush();
		state.store = undefined;
		state.pending = undefined;
		state.lastSeen = undefined;
		state.agents = undefined;
		state.lastRequestAt = 0;
		state.ctx = ctx;
		// A resumed or forked transcript is replayed onto a cold cache, so the first
		// miss is expected — name it instead of reporting a bare cold start.
		state.pendingCause = event?.reason === "resume" || event?.reason === "fork" ? "resume" : undefined;
		if (active()) ensureStore(ctx);
		shell.render();
	});
	pi.on("before_agent_start", async (event, ctx) => {
		state.ctx = ctx;
		state.systemPromptId = fingerprint(event.systemPrompt ?? []);
		shell.render();
	});
	pi.on("before_provider_request", async (event, ctx) => {
		state.ctx = ctx;
		if (!active()) return undefined;
		state.pending = captureRequest(event.payload, ctx);
		// Observation only: returning undefined leaves the request payload untouched.
		return undefined;
	});
	pi.on("message_end", async (event, ctx) => {
		state.ctx = ctx;
		if (!active()) return;
		accountResponse(event.message, ctx);
		// Children flush their own shard at their turn end; folding them in here keeps the
		// row session-wide instead of only as fresh as the last `task` tool call.
		if (values()["cache.subagents"] === true) {
			await refreshAgents(ctx);
			shell.render();
		}
	});
	pi.on("session_compact", async (_event, ctx) => {
		state.ctx = ctx;
		// Compaction rewrites history, so the next request cannot possibly hit.
		if (active()) state.pendingCause = "compaction";
	});
	pi.on("session_branch", async (_event, ctx) => {
		state.ctx = ctx;
		if (active()) state.pendingCause = "branch_nav";
	});
	pi.on("session_tree", async (_event, ctx) => {
		state.ctx = ctx;
		if (active()) state.pendingCause = "branch_nav";
	});
	pi.on("tool_result", async (event, ctx) => {
		state.ctx = ctx;
		if (!active() || event.toolName !== "task") return;
		await refreshAgents(ctx);
		shell.render();
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		state.ctx = ctx;
		// Covers async spawns, whose shard lands after the tool call has returned.
		if (!active() || event.toolName !== "task") return;
		await refreshAgents(ctx);
		shell.render();
	});
	pi.on("turn_end", async (_event, ctx) => {
		state.ctx = ctx;
		// Durability: persist what this turn earned before the next request starts.
		await state.store?.flush();
	});
	pi.on("session_shutdown", async () => {
		await state.store?.flush();
		state.store = undefined;
		state.pending = undefined;
		state.pendingCause = undefined;
		state.lastSeen = undefined;
		state.systemPromptId = undefined;
	});

	return { segment, section, stability, doctor, repair, undo, reset, state };
}
