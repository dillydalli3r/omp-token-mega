/**
 * Request-envelope accounting and advice.
 *
 * This is the half of the plugin that never touches a request. omp owns almost every
 * token lever that matters — artifact spill, pre-compaction pruning, superseded-read
 * pruning, useless-result elision, shake, snapcompact — and each of those is already
 * cache-aware. Reimplementing them would be duplication with a new way to be wrong. What
 * is missing is a single place that answers "where do this session's input tokens
 * actually go, and which of omp's own knobs is set wrong for this model?".
 *
 * Two sources are read here:
 *
 *   - the live session, through `pi.getAllTools()` / `ctx.getContextUsage()`, which are
 *     exact and free;
 *   - omp's own settings files, parsed with a deliberately small YAML reader, because the
 *     extension API exposes no settings surface at all. Only scalar dotted keys and
 *     inline scalar arrays are understood; anything else is ignored rather than guessed
 *     at, and a key this reader cannot see falls back to the documented schema default.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { formatBytes, formatTokens, percent, tokensFromBytes, utf8Bytes } from "./measure.js";
import { appendOnlyAutoEnabled, cacheCapable } from "./model.js";

/**
 * omp 18.x schema defaults for the keys this audit reasons about, used only when the
 * settings files do not carry the key. A value that drifts from the harness schema makes
 * the *recommendation* stale, never the plugin wrong: the audit prints the value it
 * believes it read next to the one it recommends, and `/mega audit` shows both.
 */
export const CORE_DEFAULTS = {
	// The one key here that is not a token lever but a prefix-stability lever: omp only
	// auto-enables append-only context for DeepSeek, the local engines, routes served over
	// loopback or the local network, and store-backed routes, so elsewhere the setting is
	// whatever the user stored — and until one is stored, no settings file carries it.
	"provider.appendOnlyContext": "auto",
	"tools.artifactSpillThreshold": 50,
	"tools.artifactTailBytes": 20,
	"tools.artifactHeadBytes": 20,
	"tools.artifactTailLines": 500,
	"tools.outputMaxColumns": 768,
	"compaction.enabled": true,
	"compaction.supersedeReads": true,
	"compaction.dropUseless": true,
	"compaction.keepRecentTokens": 20000,
	"compaction.idleEnabled": false,
	"compaction.idleThresholdTokens": 200000,
	"compaction.thresholdPercent": -1,
	"read.defaultLimit": 300,
	"read.summarize.enabled": true,
	"read.summarize.prose": false,
};

/**
 * Gemini's implicit cache floor: the provider only caches a prefix above a model-specific
 * minimum, 1024 tokens on the 2.5 and later tiers. Below it a request is billed fully
 * uncached, so a short envelope's miss is the provider's floor — not a regression in the
 * setup, and not something a client-side setting can change.
 */
const GOOGLE_CACHE_FLOOR = 1024;

function scalar(raw) {
	const text = raw.trim();
	if (text === "") return undefined;
	if (text.startsWith("[") && text.endsWith("]")) {
		const inner = text.slice(1, -1).trim();
		if (inner === "") return [];
		return inner.split(",").map((part) => scalar(part));
	}
	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
		return text.slice(1, -1);
	}
	if (text === "true" || text === "yes") return true;
	if (text === "false" || text === "no") return false;
	if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
	return text;
}

/** Strip a trailing `# comment`, ignoring `#` inside quotes. */
function stripComment(line) {
	let quote;
	for (let i = 0; i < line.length; i += 1) {
		const ch = line[i];
		if (quote) {
			if (ch === quote) quote = undefined;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
			return line.slice(0, i);
		}
	}
	return line;
}

/**
 * Dotted-key view of a YAML mapping, limited to what a settings file actually contains:
 * nested mappings of scalars, and inline scalar arrays. Lists written as block sequences
 * (`- item`) and any other construct are skipped — the audit then reports the documented
 * default for that key, which is honest, instead of a value it invented.
 */
export function parseScalars(text) {
	const values = {};
	const stack = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = stripComment(rawLine.replace(/\t/g, "  "));
		if (!line.trim()) continue;
		const indent = line.length - line.trimStart().length;
		const body = line.trim();
		const colon = body.indexOf(":");
		if (colon <= 0) continue;
		const key = body.slice(0, colon).trim();
		const rest = body.slice(colon + 1);
		while (stack.length > 0 && indent <= stack[stack.length - 1].indent) stack.pop();
		const path = [...stack.map((frame) => frame.key), key].join(".");
		if (rest.trim() === "") {
			stack.push({ indent, key });
			continue;
		}
		values[path] = scalar(rest);
	}
	return values;
}

async function readText(path) {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

/** Settings locations omp documents, lowest precedence first. */
export function coreSettingsFiles({ agentDir, cwd }) {
	const files = [];
	if (agentDir) files.push(join(agentDir, "config.yml"), join(agentDir, "config.yaml"), join(agentDir, "settings.json"));
	if (cwd) files.push(join(cwd, ".omp", "config.yml"), join(cwd, ".omp", "config.yaml"), join(cwd, ".omp", "settings.json"));
	return files;
}

/**
 * Effective values for the keys in CORE_DEFAULTS: defaults, then the global file, then the
 * project file — the same direction omp merges, minus the layers a plugin cannot see
 * (`--config` overlays and runtime flags, which the audit therefore cannot claim to know).
 */
export async function readCoreSettings({ agentDir, cwd }) {
	const values = { ...CORE_DEFAULTS };
	const seen = {};
	const problems = [];
	for (const path of coreSettingsFiles({ agentDir, cwd })) {
		const text = await readText(path);
		if (text === undefined) continue;
		let parsed;
		try {
			parsed = path.endsWith(".json") ? JSON.parse(text) : parseScalars(text);
		} catch (error) {
			problems.push(`${path}: ${error?.message ?? error}`);
			continue;
		}
		for (const key of Object.keys(CORE_DEFAULTS)) {
			const value = path.endsWith(".json") ? lookupDotted(parsed, key) : parsed[key];
			if (value !== undefined) {
				values[key] = value;
				seen[key] = path;
			}
		}
	}
	return { values, seen, problems };
}

function lookupDotted(object, path) {
	let node = object;
	for (const part of path.split(".")) {
		if (!node || typeof node !== "object") return undefined;
		node = node[part];
	}
	return node;
}

/**
 * The system prompt, split into its top-level blocks and ranked. omp already knows the
 * total (a system-prompt token count is part of its own context breakdown); this only adds
 * the shape of it, which is what tells a user *which* block to trim.
 */
export function systemPromptSections(prompt) {
	const lines = Array.isArray(prompt) ? prompt : [String(prompt ?? "")];
	const heading = /^(#{1,3} .{0,60}|<[a-zA-Z][\w:.-]*>)$/;
	const sections = [];
	let current = { title: "(preamble)", bytes: 0, lines: 0 };
	for (const line of lines) {
		const trimmed = line.trim();
		if (heading.test(trimmed)) {
			if (current.bytes > 0) sections.push(current);
			current = { title: trimmed, bytes: 0, lines: 0 };
			continue;
		}
		current.bytes += utf8Bytes(line) + 1;
		current.lines += 1;
	}
	if (current.bytes > 0) sections.push(current);
	const total = sections.reduce((sum, section) => sum + section.bytes, 0);
	return { sections: sections.sort((a, b) => b.bytes - a.bytes), totalBytes: total };
}

/** Tool schemas, ranked, with the call counts this session actually produced. */
export function catalogue(allTools, activeNames, calls) {
	const active = new Set(activeNames ?? []);
	const rows = [];
	for (const tool of allTools ?? []) {
		let schema;
		try {
			schema = JSON.stringify(tool?.parameters ?? {});
		} catch {
			schema = "{}";
		}
		const bytes = utf8Bytes(schema) + utf8Bytes(String(tool?.description ?? ""));
		rows.push({
			name: String(tool?.name ?? "?"),
			bytes,
			tokens: tokensFromBytes(bytes),
			active: active.has(tool?.name),
			calls: calls?.get(tool?.name) ?? 0,
		});
	}
	rows.sort((a, b) => b.bytes - a.bytes);
	const activeRows = rows.filter((row) => row.active);
	return {
		rows,
		activeCount: activeRows.length,
		totalCount: rows.length,
		activeBytes: activeRows.reduce((sum, row) => sum + row.bytes, 0),
		inactiveBytes: rows.filter((row) => !row.active).reduce((sum, row) => sum + row.bytes, 0),
		neverCalled: activeRows.filter((row) => row.calls === 0),
	};
}

/** `omp config set` line for a recommendation. */
function command(key, value) {
	return `omp config set ${key} ${value}`;
}

/**
 * The spill threshold that keeps one tool result under ~2% of the context window — the
 * point past which a single call can crowd out the conversation it was meant to serve.
 * Clamped to omp's own useful range: below 8 KB the artifact churn outweighs the tokens,
 * above 50 KB the value is omp's default and there is nothing to recommend.
 */
export function recommendedSpillThreshold(contextWindow) {
	if (!(contextWindow > 0)) return undefined;
	return Math.min(50, Math.max(8, Math.round(contextWindow / 8000)));
}

/**
 * Advice rows in the shape `formatAudit` renders: `{ key, current, recommended, why, command }`.
 * `model` is the live model and is optional — the two rows that depend on the provider (omp's
 * append-only context, Gemini's cache floor) simply never fire without it, which is what keeps
 * an audit with no model loaded honest.
 */
export function recommendations({ core, usage, catalog, config, model }) {
	const rows = [];
	const window = usage?.contextWindow ?? 0;

	// The largest cache win this plugin can name, and the only one it cannot apply itself:
	// omp's auto rule covers DeepSeek, the local engines, routes served over loopback or the
	// local network, and store-backed routes; on every other provider a prefix cache can read
	// the per-turn re-serialization of the system prompt and tool catalogue as a change. The
	// row reports the setting and the command; the plugin never writes omp's settings.
	if (model && cacheCapable(model) && core.values["provider.appendOnlyContext"] !== "on" && !appendOnlyAutoEnabled(model)) {
		rows.push({
			key: "provider.appendOnlyContext",
			current: String(core.values["provider.appendOnlyContext"] ?? "auto"),
			recommended: "on",
			why: "omp turns append-only context on by itself only for DeepSeek, the local engines, routes served over loopback or the local network, and store-backed routes — this provider is none of those, so the live system prompt and tool catalogue are re-serialized each turn, which a provider prefix cache can read as a change; append-only freezes the prefix once and appends, which is what makes the cache hit. This row is the plugin reporting the setting, never a write.",
			command: command("provider.appendOnlyContext", "on"),
		});
	}

	// The one miss worth naming instead of chasing: Gemini's implicit cache only applies
	// above a model-specific minimum, so a short envelope is billed fully uncached and no
	// client-side change turns it into a hit. No command, because there is nothing to set.
	if (String(model?.provider ?? "").startsWith("google") && Number(usage?.tokens) > 0 && Number(usage?.tokens) < GOOGLE_CACHE_FLOOR) {
		rows.push({
			key: "gemini implicit cache",
			current: `${usage.tokens} tokens in context`,
			recommended: "no change",
			why: `Gemini's implicit cache only applies above a model-specific minimum (${GOOGLE_CACHE_FLOOR} tokens on the 2.5+ tiers), so below it every request is billed fully uncached and no client-side change can turn it into a hit — the miss is the provider's floor, not a regression in the setup.`,
			command: undefined,
		});
	}

	const spill = Number(core.values["tools.artifactSpillThreshold"]);
	const target = recommendedSpillThreshold(window);
	if (target !== undefined && Number.isFinite(spill) && spill > target) {
		rows.push({
			key: "tools.artifactSpillThreshold",
			current: `${spill} KB`,
			recommended: `${target} KB`,
			why: `a single tool result above this is elided to head+tail behind an artifact:// handle, so one noisy call cannot eat the conversation; ${target} KB is ~2% of a ${formatTokens(window)}-token window`,
			command: command("tools.artifactSpillThreshold", target),
		});
	}

	if (core.values["compaction.idleEnabled"] !== true) {
		const idleThreshold = Number(core.values["compaction.idleThresholdTokens"]);
		if (window > 0 && Number.isFinite(idleThreshold) && idleThreshold <= window) {
			rows.push({
				key: "compaction.idleEnabled",
				current: "false",
				recommended: "true",
				why: `compacts while the session is idle, so a long gap does not turn into a full re-prime on the next request (threshold ${formatTokens(idleThreshold)} tokens fits this window)`,
				command: command("compaction.idleEnabled", "true"),
			});
		}
	}

	if (core.values["read.summarize.enabled"] !== true) {
		rows.push({
			key: "read.summarize.enabled",
			current: "false",
			recommended: "true",
			why: "large source files are read as a declaration skeleton with re-read hints instead of verbatim text; omp's structural summary is what keeps a 2,000-line file from costing 20k tokens",
			command: command("read.summarize.enabled", "true"),
		});
	}

	if (Number(core.values["read.defaultLimit"]) > 300) {
		rows.push({
			key: "read.defaultLimit",
			current: String(core.values["read.defaultLimit"]),
			recommended: "300",
			why: "an open-ended read above 300 lines pays for the whole file; the tool adds explicit selectors cheaply when more is genuinely needed",
			command: command("read.defaultLimit", "300"),
		});
	}

	if (Number(core.values["tools.outputMaxColumns"]) > 1024) {
		rows.push({
			key: "tools.outputMaxColumns",
			current: String(core.values["tools.outputMaxColumns"]),
			recommended: "768",
			why: "cap on a single line of streaming output; beyond ~768 columns a line is a minified blob nobody reads",
			command: command("tools.outputMaxColumns", "768"),
		});
	}

	if (config.values["token.maxChars"] > 0 && Number.isFinite(spill) && spill * 1024 <= config.values["token.maxChars"]) {
		rows.push({
			key: "token.maxChars",
			current: `${config.values["token.maxChars"]} chars`,
			recommended: "0 or below the spill threshold",
			why: `omp's own spill (${spill} KB) fires first, so this budget never gets to apply: the plugin's per-result budget only ever sees results omp left whole`,
			command: `omp plugin config set ${config.name} token.maxChars 0`,
		});
	}

	if (catalog.neverCalled.length > 0) {
		const bytes = catalog.neverCalled.reduce((sum, row) => sum + row.bytes, 0);
		rows.push({
			key: "tool catalogue",
			current: `${catalog.activeCount} active tools, ${catalog.neverCalled.length} never called this session`,
			recommended: "disable what you do not use",
			why: `every tool schema is sent on every request: the never-called ones account for ${formatBytes(bytes)} (~${formatTokens(tokensFromBytes(bytes))} tok) per request for this session`,
			command: undefined,
		});
	}

	return rows;
}

/** The audit document. Everything numeric states its source; estimates say so. */
export function formatAudit({ config, core, usage, prompt, catalog, stats, perf, model }) {
	const lines = ["### Token audit", ""];

	lines.push("**This request envelope**", "");
	if (usage) {
		lines.push(
			`- Context: ${usage.tokens.toLocaleString("en-US")} / ${usage.contextWindow.toLocaleString("en-US")} tokens (${usage.percent.toFixed(0)}%) — omp's own count`,
		);
	} else {
		lines.push("- Context: unavailable in this mode.");
	}
	lines.push(
		`- System prompt: ${formatBytes(prompt.totalBytes)} (~${formatTokens(tokensFromBytes(prompt.totalBytes))} tok, est.) in ${prompt.sections.length} block(s)`,
	);
	lines.push(
		`- Tool catalogue: ${catalog.activeCount}/${catalog.totalCount} active, ${formatBytes(catalog.activeBytes)} (~${formatTokens(tokensFromBytes(catalog.activeBytes))} tok, est.) — ${formatBytes(catalog.inactiveBytes)} inactive`,
	);
	lines.push(
		"- Everything above is re-sent on every request, which is why it is the first place to look: an elided tool result is paid for once, a fat system prompt is paid for every turn.",
	);

	if (prompt.sections.length > 0) {
		lines.push("", "**Largest system-prompt blocks** (est.)", "");
		lines.push("| block | bytes | est. tokens | share |", "| --- | --- | --- | --- |");
		for (const section of prompt.sections.slice(0, 8)) {
			const share = percent(section.bytes, prompt.totalBytes) ?? "n/a";
			lines.push(`| \`${section.title.replace(/\|/g, "\\|")}\` | ${formatBytes(section.bytes)} | ${formatTokens(tokensFromBytes(section.bytes))} | ${share} |`);
		}
	}

	if (catalog.rows.length > 0) {
		lines.push("", "**Largest tool schemas** (est.)", "");
		lines.push("| tool | bytes | est. tokens | active | calls |", "| --- | --- | --- | --- | --- |");
		for (const row of catalog.rows.slice(0, 10)) {
			lines.push(`| \`${row.name}\` | ${formatBytes(row.bytes)} | ${formatTokens(row.tokens)} | ${row.active ? "yes" : "no"} | ${row.calls} |`);
		}
	}

	const advice = recommendations({ core, usage, catalog, config, model });
	lines.push("", "**Recommendations**", "");
	if (advice.length === 0) lines.push("- Nothing outstanding: the levers this audit checks are already set for this model.");
	for (const row of advice) {
		lines.push(`- \`${row.key}\`: ${row.current} → **${row.recommended}**`);
		lines.push(`  - ${row.why}`);
		if (row.command) lines.push(`  - \`${row.command}\``);
	}

	lines.push("", "**What omp already does for you** (this plugin does not duplicate any of it)", "");
	const on = (key) => (core.values[key] === true ? "on" : core.values[key] === false ? "**off**" : String(core.values[key]));
	lines.push(
		`- Artifact spill at \`tools.artifactSpillThreshold\` (${core.values["tools.artifactSpillThreshold"]} KB) → head+tail + \`artifact://\` recovery.`,
	);
	lines.push(
		`- Pre-compaction pruning (\`pruneToolOutputs\`) and superseded-read pruning (\`compaction.supersedeReads\` ${on("compaction.supersedeReads")}).`,
	);
	lines.push(
		`- Useless-result elision (\`compaction.dropUseless\` ${on("compaction.dropUseless")}), \`shake\`, \`snapcompact\`, structural \`read\` summaries.`,
	);
	lines.push(
		`- Cache-aware timing: pruning waits for a small suffix or an idled session, because rewriting history would cost more than it saves.`,
	);
	if (core.problems.length > 0) {
		lines.push("", "**Settings files that could not be parsed**", "");
		for (const problem of core.problems) lines.push(`- ${problem}`);
	}
	if (Object.keys(core.seen).length > 0) {
		lines.push("", "**Where these values came from**", "");
		const byFile = new Map();
		for (const [key, file] of Object.entries(core.seen)) {
			if (!byFile.has(file)) byFile.set(file, []);
			byFile.get(file).push(key);
		}
		for (const [file, keys] of byFile) lines.push(`- \`${file}\`: ${keys.join(", ")}`);
	}

	lines.push("", "**This plugin's own work in this session**", "");
	lines.push(
		`- Removed: ${formatBytes(stats.savedBytes)} (~${formatTokens(tokensFromBytes(stats.savedBytes))} tok, est.) from ${stats.reduced} result(s) of ${stats.results} seen.`,
	);
	lines.push(
		`  - compression ${formatBytes(ruleSum(stats.byRule, ["squeeze", "fold", "clip", "json"]))}, budget elision ${formatBytes(stats.byRule.elide)}, duplicates ${formatBytes(stats.byRule.dedupe)} (${stats.duplicates} result(s))`,
	);
	lines.push(`- Artifacts written: ${stats.stashes}; failures: ${stats.stashFailures}.`);
	lines.push(`- Skipped: ${stats.skipped.small} below \`minChars\`, ${stats.skipped.noWin} with no net win, ${stats.skipped.native} already spilled by omp.`);
	if (perf) lines.push(`- Tool-result hook: p50 ${perf.median.toFixed(2)} ms, max ${perf.max.toFixed(2)} ms over ${perf.count} call(s).`);
	return lines.join("\n");
}

function ruleSum(byRule, keys) {
	return keys.reduce((sum, key) => sum + (Number(byRule?.[key]) || 0), 0);
}
