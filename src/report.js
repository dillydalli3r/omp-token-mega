/**
 * The `/mega` report: one document, one section per feature, plus the token audit's
 * accounting of where the session's input tokens actually go.
 *
 * The token section's prefix-safety paragraph is the plugin's contract, written in terms
 * the reader can check against the code rather than as a promise: which event the reducer
 * subscribes to, what a subscriber is allowed to return, and which figures the cache side
 * of the ledger can and cannot price.
 */

import { formatBytes, formatTokens, tokensFromBytes } from "./measure.js";

/**
 * Section for the tool-result reducer.
 *
 * The accounting rows are the reducer's ledger (`emptyStats` in `token.js`), printed so
 * that it adds up on the page: the three component figures are the *gross* bytes the
 * passes named on each line removed, and the provenance markers those same rewrites wrote
 * into the results are subtracted once — in the headline and again as a row of their own.
 * So
 *
 *   lossless + budget elision + duplicates collapsed - markers === stats.savedBytes
 *
 * holds for the figures as printed.
 */
export function tokenSection({ config, stats, perf, index, model }) {
	const values = config.values;
	const lines = ["### Token saving", ""];
	lines.push(`- Preset: \`${config.preset}\` (${config.sources["token.preset"] ?? "default"})`);
	lines.push(`- Model: \`${model ?? "unknown"}\``);
	if (values["token.enabled"] !== true) {
		lines.push("- **Disabled** by the `token.enabled` setting: no hooks run, nothing is measured.");
		return lines.join("\n");
	}
	lines.push(`- Tool results in scope: ${stats.results} (tools: \`${values["token.tools"]}\`)`);
	lines.push(`- Results rewritten: ${stats.reduced}`);
	const byRule = stats.byRule;
	const lossless = byRule.squeeze + byRule.fold + byRule.clip + byRule.json;
	const gross = lossless + byRule.elide + byRule.dedupe;
	lines.push(
		`- Removed from the transcript: ${formatBytes(stats.savedBytes)} (~${formatTokens(tokensFromBytes(stats.savedBytes))} tok, est.) — ${formatBytes(gross)} removed by the passes below, less ${formatBytes(stats.markerBytes)} of provenance markers`,
	);
	lines.push(
		`  - lossless passes ${formatBytes(lossless)} (squeeze ${formatBytes(byRule.squeeze)}, fold ${formatBytes(byRule.fold)}, clip ${formatBytes(byRule.clip)}, json ${formatBytes(byRule.json)})`,
	);
	lines.push(`  - budget elision ${formatBytes(byRule.elide)}; duplicates collapsed ${formatBytes(byRule.dedupe)}`);
	lines.push(
		`  - provenance markers written into the reduced results: ${formatBytes(stats.markerBytes)} (a marker is never a saving: those bytes are in the results and are subtracted above)`,
	);
	lines.push(`- Duplicate index: ${index.size} distinct result(s); ${stats.duplicates} copy(ies) collapsed.`);
	lines.push(`- Artifacts written: ${stats.stashes}; write failures: ${stats.stashFailures}.`);
	lines.push(
		`- Skipped: ${stats.skipped.small} below \`token.minChars\`, ${stats.skipped.large} above \`token.maxScanBytes\`, ${stats.skipped.outOfScope} out of scope, ${stats.skipped.noWin} with no net win, ${stats.skipped.native} already elided by omp.`,
	);

	lines.push("", "#### Prefix-cache safety", "");
	lines.push(
		"- The reducer touches exactly one thing: the content of a tool result, **before** it is first persisted and sent. Reduced text is what the session stores, so every later request replays the same bytes: the prefix stays byte-stable, and a saving earned once is paid out again on every request that follows it.",
	);
	lines.push(
		"- It subscribes to exactly one event whose return value can change what the model sees, `tool_result`, and returns only a content replacement: no `context`, `before_provider_request` or `before_agent_start` handler, and no content-replacing tool. The handlers it does register — `session_start`, `session_switch`, `tool_execution_start`, `session_shutdown` — return nothing. The system prompt, the tool catalogue and the message log are exactly what omp would have built without it, which is the whole reason it cannot turn a cache hit into a miss.",
	);
	lines.push(
		"- A rewrite is admitted only when it pays for its own provenance marker (`token.minSavingsTokens`), and the marker's bytes are subtracted from the saving rather than counted as one, so the figure above is net of them. A rewrite that does not pay is not made: forking the prefix for nothing costs more than sending the original bytes.",
	);
	lines.push(
		"- Elided tokens are never sent, so they never enter the provider's prefix cache at all — and they cannot appear in the cached-input counts the `cache.*` side prices either, because a token that was never sent was never cached. The `cache.*` side measures the hit rate and the saving over what *is* sent, for every provider whose models report cached input tokens; the two figures answer different questions and are not additive.",
	);
	lines.push(
		"- omp's own history-level reductions (artifact spill, `pruneToolOutputs`, `supersedeReads`, `dropUseless`, `shake`) run on their own cache-aware schedule and are left alone; when omp has already elided a result, this plugin only compresses what remains.",
	);

	if (perf) {
		lines.push("", "#### Throughput", "");
		lines.push(
			`- Tool-result hook: p50 ${perf.median.toFixed(2)} ms, max ${perf.max.toFixed(2)} ms over ${perf.count} call(s) (\`token.perf\` setting).`,
		);
		lines.push(
			`- Work is bounded by \`token.maxScanBytes\` (${formatBytes(values["token.maxScanBytes"])}): anything larger is handed to omp untouched. No I/O happens unless text is actually stashed or elided.`,
		);
	}
	return lines.join("\n");
}

/** The other sections in display order, so one command explains the whole plugin. */
export const REPORT_SECTIONS = ["token", "cache", "tune", "lithos", "balance"];

/**
 * Assemble the merged document. `sections` maps a section name to its markdown, or to
 * `undefined` when the feature has nothing to report in this session.
 */
export function megaReport({ model, sessionId, preset, sections }) {
	const lines = ["# Token Mega", ""];
	lines.push(`- Model: \`${model ?? "unknown"}\``);
	lines.push(`- Token preset: \`${preset}\``);
	for (const name of REPORT_SECTIONS) {
		const body = sections[name];
		if (typeof body !== "string" || body === "") continue;
		lines.push("", body);
	}
	lines.push(
		"",
		"### Knobs",
		"",
		"- `/mega config` — every setting, its effective value and which layer supplied it.",
		"- `/mega menu` — change any of them interactively, grouped by feature.",
		"- `/mega preset <name>` — switch the token-saving bundle: `off`, `conservative`, `balanced`, `aggressive`, `max`.",
		"- `/mega audit` — where this session's input tokens actually go, and which omp knobs to change.",
		"- `/mega tune [apply|save|revert]` — the core settings this model wants changed, applied as session overrides or written to your config.",
		"- `/mega cache doctor` — scan the model config for inert compat keys; `fix` removes them, `rollback` restores.",
	);
	if (sessionId) lines.push("", `Session \`${sessionId}\`.`);
	return lines.join("\n");
}
