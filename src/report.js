/**
 * The `/mega` report: one document, one section per feature, plus the token audit's
 * accounting of where the session's input tokens actually go.
 *
 * The token section keeps the prefix-safety paragraph verbatim, because it is the
 * plugin's contract and it is stated in terms the reader can check against the code:
 * which events are subscribed to, and what a subscriber is allowed to return.
 */

import { formatBytes, formatTokens, tokensFromBytes } from "./measure.js";

/** Section for the tool-result reducer. */
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
	lines.push(
		`- Removed from the transcript: ${formatBytes(stats.savedBytes)} (~${formatTokens(tokensFromBytes(stats.savedBytes))} tok, est.), net of ${formatBytes(stats.markerBytes)} of provenance markers`,
	);
	lines.push(
		`  - lossless passes ${formatBytes(stats.byRule.squeeze + stats.byRule.fold + stats.byRule.clip + stats.byRule.json)} (squeeze ${formatBytes(stats.byRule.squeeze)}, fold ${formatBytes(stats.byRule.fold)}, clip ${formatBytes(stats.byRule.clip)}, json ${formatBytes(stats.byRule.json)})`,
	);
	lines.push(`  - budget elision ${formatBytes(stats.byRule.elide)}; duplicates collapsed ${formatBytes(stats.byRule.dedupe)}`);
	lines.push(`- Duplicate index: ${index.size} distinct result(s); ${stats.duplicates} copy(ies) collapsed.`);
	lines.push(`- Artifacts written: ${stats.stashes}; write failures: ${stats.stashFailures}.`);
	lines.push(
		`- Skipped: ${stats.skipped.small} below \`token.minChars\`, ${stats.skipped.large} above \`token.maxScanBytes\`, ${stats.skipped.outOfScope} out of scope, ${stats.skipped.noWin} with no net win, ${stats.skipped.native} already elided by omp.`,
	);

	lines.push("", "#### Prefix-cache safety", "");
	lines.push(
		"- This plugin touches exactly one thing: the content of a tool result, **before** it is first persisted and sent. Reduced text is what the session stores, so every later request replays the same bytes.",
	);
	lines.push(
		"- It registers no `context`, `before_provider_request` or `before_agent_start` handler and no content-replacing tool: the system prompt, the tool catalogue and the message log are exactly what omp would have built without it. That is the whole reason it cannot turn a cache hit into a miss.",
	);
	lines.push(
		"- A rewrite is admitted only when it pays for its own provenance marker (`token.minSavingsTokens`); otherwise the original bytes go out untouched, because a pointless rewrite would fork the prefix for nothing.",
	);
	lines.push(
		"- Elided tokens are never sent, so they never enter the provider's cache accounting at all. Cache-hit rate and cache savings are unaffected and are measured by the `cache.*` side of this plugin — the two numbers are not additive.",
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
export const REPORT_SECTIONS = ["token", "cache", "lithos", "balance"];

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
		"- `/mega cache doctor` — scan the model config for inert compat keys; `fix` removes them, `rollback` restores.",
	);
	if (sessionId) lines.push("", `Session \`${sessionId}\`.`);
	return lines.join("\n");
}
