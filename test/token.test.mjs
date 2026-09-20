/**
 * Tests for the token-saving feature of omp-token-mega.
 *
 * Scope is the part of the plugin that can be wrong in a way nobody would notice: the
 * reducer's arithmetic, its determinism, the admission test that decides whether a rewrite
 * is worth making, configuration resolution across five layers, and the hook pipeline
 * driven end to end against a fake extension host.
 *
 * Every end-to-end test pins *all* plugin settings through their environment variables
 * (`pinConfig`). Environment is the highest resolution layer, so pinning it makes the run
 * hermetic — it cannot be perturbed by a global plugin config or a project override that
 * happens to exist on the machine running the tests.
 *
 *   node test/token.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	clip,
	compressionMarker,
	countLines,
	duplicateMarker,
	elide,
	fold,
	marker,
	minifyJson,
	reduce,
	squeeze,
	worthwhile,
} from "../src/compress.js";
import { CONFIG_SCHEMA, defaultConfig, loadConfig, presetValues, toolSelected } from "../src/config.js";
import { createDuplicateIndex } from "../src/dedupe.js";
import { estimateTokens, formatBytes, formatTokens, lineCost, tokensFromBytes } from "../src/measure.js";
import { parseScalars, recommendedSpillThreshold, systemPromptSections } from "../src/audit.js";
import { makeHost, withConfig } from "./harness.mjs";

let passed = 0;
const failures = [];

async function test(name, fn) {
	try {
		await fn();
		passed += 1;
	} catch (error) {
		failures.push(`${name}: ${error?.message ?? error}`);
	}
}

// ---------------------------------------------------------------------------
// Reduction
// ---------------------------------------------------------------------------

await test("squeeze removes escapes, control characters and trailing whitespace", () => {
	const input = "\u001b[31merror\u001b[0m: boom  \r\nprogress 10%\rprogress \u0007 100%\n\n\n\nnext\t\n";
	const { text, saved } = squeeze(input);
	// A bare CR separates lines rather than vanishing, and the trailing tab goes with the
	// rest of the line's trailing whitespace.
	assert.equal(text, "error: boom\nprogress 10%\nprogress  100%\n\nnext\n");
	assert.ok(saved > 0, "should report bytes removed");
});

await test("squeeze is idempotent and leaves clean text byte-identical", () => {
	const input = "\u001b[1mhello\u001b[0m   \n\n\n\nworld\n";
	const once = squeeze(input).text;
	assert.equal(squeeze(once).text, once);
	const clean = "nothing to do here\nsecond line\n";
	assert.equal(squeeze(clean).text, clean);
	assert.equal(squeeze(clean).saved, 0);
});

await test("fold collapses identical runs, keeps one copy, and reports the exact count", () => {
	const input = ["start", ...Array(6).fill("same frame"), "end"].join("\n");
	const { text, runs, saved } = fold(input, 4);
	assert.equal(runs, 1);
	assert.ok(saved > 0);
	const lines = text.split("\n");
	assert.equal(lines[0], "start");
	assert.equal(lines[1], "same frame");
	assert.match(lines[2], /5 identical lines folded/);
	assert.equal(lines[3], "end");
});

await test("fold leaves a short run alone and never folds blank lines", () => {
	const short = ["a", "b", "b", "c"].join("\n");
	assert.equal(fold(short, 4).text, short);
	const blanks = ["a", "", "", "", "", "b"].join("\n");
	assert.equal(fold(blanks, 2).text, blanks, "blank-line runs are squeeze's business, not fold's");
});

await test("clip caps only over-long lines and marks the cut", () => {
	const long = "a".repeat(100);
	const { text, saved, lines } = clip(`short\n${long}\ntiny`, 10);
	assert.equal(lines, 1);
	assert.equal(text, `short\n${"a".repeat(10)}\u2026\ntiny`);
	assert.ok(saved > 0);
	assert.equal(clip("short\ntiny", 10).text, "short\ntiny");
	assert.equal(clip("short", 0).text, "short", "0 disables the pass");
});

await test("minifyJson strips whitespace outside strings and keeps string contents", () => {
	const pretty = JSON.stringify({ a: 1, b: [1, 2, 3], c: { d: "keep   these   spaces" } }, null, 2);
	const result = minifyJson(pretty);
	assert.ok(result);
	assert.equal(result.text, '{"a":1,"b":[1,2,3],"c":{"d":"keep   these   spaces"}}');
	assert.ok(result.saved > 0);
});

await test("minifyJson preserves escapes and numeric literals exactly", () => {
	const source = '{ "n": 1.0, "e": 1e2, "s": "a\\"b\\\\c", "u": "\\u00e9" }';
	assert.equal(minifyJson(source).text, '{"n":1.0,"e":1e2,"s":"a\\"b\\\\c","u":"\\u00e9"}');
});

await test("minifyJson refuses what is not JSON", () => {
	assert.equal(minifyJson("{ not: json, just: a literal }"), null);
	assert.equal(minifyJson("plain text"), null);
	assert.equal(minifyJson('{"a":1}'), null, "already minimal: nothing to remove");
});

await test("reduce orders clip before json so the minifier cannot be undone", () => {
	const pretty = JSON.stringify({ rows: Array(50).fill({ value: "x".repeat(400) }) }, null, 2);
	const result = reduce(pretty, { squeeze: true, fold: true, foldMinRun: 2, clip: 80, json: true });
	assert.ok(result.savedBytes > 0);
	assert.ok(result.text.includes("\u2026"), "the long line was clipped");
	assert.equal(result.steps.fold, 0, "nothing to fold in a JSON payload");
	assert.equal(result.changed, true);
});

await test("reduce is deterministic, and never touches text it cannot improve", () => {
	const input = `\u001b[32m${"line\n".repeat(200)}\u001b[0m    \n\n\n${"dup\n".repeat(30)}`;
	const config = { squeeze: true, fold: true, foldMinRun: 3, clip: 100, json: true };
	const first = reduce(input, config);
	const second = reduce(input, config);
	assert.equal(first.text, second.text, "same input must reduce to the same bytes, always");
	assert.equal(first.savedBytes, second.savedBytes);
	const untouched = reduce("clean text\n", config);
	assert.equal(untouched.text, "clean text\n");
	assert.equal(untouched.changed, false);
});

await test("reduce's per-rule steps sum to its total", () => {
	const input = `${"a  \n".repeat(10)}\n\n\n${"same\n".repeat(5)}${"y".repeat(500)}\n`;
	const result = reduce(input, { squeeze: true, fold: true, foldMinRun: 2, clip: 40, json: false });
	const sum = Object.values(result.steps).reduce((total, bytes) => total + bytes, 0);
	assert.equal(sum, result.savedBytes);
});

await test("elide keeps head and tail and reports exactly what it dropped", () => {
	const text = `${"H".repeat(100)}${"M".repeat(200)}${"T".repeat(100)}`;
	const result = elide(text, { headChars: 100, tailChars: 100 });
	assert.equal(result.head, "H".repeat(100));
	assert.equal(result.tail, "T".repeat(100));
	assert.equal(result.removed, "M".repeat(200));
	assert.equal(result.removedBytes, 200);
	assert.equal(result.headLines, 1);
});

await test("elide on a text shorter than its budgets drops nothing", () => {
	const result = elide("short", { headChars: 100, tailChars: 100 });
	assert.equal(result.removed, "");
	assert.equal(result.removedBytes, 0);
	assert.equal(result.head + result.tail, "short");
});

await test("admission test charges the marker against the saving", () => {
	const cost = lineCost(compressionMarker(10_000, { fold: 10_000 }));
	assert.equal(worthwhile(10_000, cost, 24), true, "a real saving passes");
	assert.equal(worthwhile(cost + 10, cost, 24), false, "a saving smaller than its own marker fails");
	assert.equal(worthwhile(cost + 23 * 4, cost, 24), false, "exactly at the floor is not a win");
	assert.equal(worthwhile(cost + 24 * 4, cost, 24), true);
	assert.equal(worthwhile(cost, cost, 0), true, "a zero floor only requires the marker to pay for itself");
});

await test("markers are uniform and carry the provenance prefix", () => {
	assert.match(compressionMarker(2048, { fold: 2048 }), /^\[token-saver: -2\.0 KB .* via fold; content complete\]$/);
	assert.match(duplicateMarker("bash", 4096, "artifact://3"), /^\[token-saver: identical to the earlier bash result .*full text artifact:\/\/3\]$/);
	assert.equal(marker("x"), "[token-saver: x]");
});

await test("countLines counts what it says", () => {
	assert.equal(countLines(""), 0);
	assert.equal(countLines("one"), 1);
	assert.equal(countLines("one\ntwo\n"), 3);
});

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

await test("the estimator matches omp's own fallback formula", () => {
	// (utf8Bytes + 3) >> 2 -- byteEstimate in packages/agent/src/tokenizer.ts.
	assert.equal(estimateTokens(""), 0);
	assert.equal(estimateTokens("abcd"), 1);
	assert.equal(estimateTokens("abcde"), 2);
	assert.equal(estimateTokens("é"), 1, "two bytes round up to one token");
	assert.equal(tokensFromBytes(4096), 1024);
	assert.equal(lineCost("x"), 2);
});

await test("formatters stay compact and honest", () => {
	assert.equal(formatBytes(512), "512 B");
	assert.equal(formatBytes(2048), "2.0 KB");
	assert.equal(formatBytes(1024 * 1024 * 3), "3.00 MB");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(12_345), "12.3k");
	assert.equal(formatTokens(2_400_000), "2.40M");
});

// ---------------------------------------------------------------------------
// Duplicate index
// ---------------------------------------------------------------------------

await test("the duplicate index matches on exact content only", () => {
	const index = createDuplicateIndex({ minChars: 8 });
	assert.equal(index.skips("short"), true);
	assert.equal(index.skips("this is long enough"), false);
	const first = index.remember("bash", "identical payload");
	assert.equal(index.lookup("identical payload"), first);
	assert.equal(index.lookup("identical payloa"), undefined, "a near miss is not a duplicate");
	assert.equal(first.copies, 0);
	index.count(first);
	assert.equal(first.copies, 1);
});

await test("the duplicate index is bounded and evicts the oldest entry", () => {
	const index = createDuplicateIndex({ minChars: 1 });
	for (let i = 0; i < 2200; i += 1) index.remember("bash", `payload ${i}`);
	assert.ok(index.size <= 2048, `expected a bounded index, got ${index.size}`);
	assert.equal(index.lookup("payload 0"), undefined, "the oldest entry was evicted");
	assert.ok(index.lookup("payload 2199"), "the newest entry is retained");
});

await test("re-registering content refreshes it rather than duplicating it", () => {
	const index = createDuplicateIndex({ minChars: 1 });
	const first = index.remember("bash", "payload");
	assert.equal(index.remember("read", "payload"), first);
	assert.equal(index.size, 1);
});

// ---------------------------------------------------------------------------
// Tool selection
// ---------------------------------------------------------------------------

await test("the tool selector handles wildcards, prefixes and exclusions", () => {
	assert.equal(toolSelected("bash,grep", "bash"), true);
	assert.equal(toolSelected("bash,grep", "read"), false);
	assert.equal(toolSelected("*", "anything"), true);
	assert.equal(toolSelected("mcp__*", "mcp__github_list_issues"), true);
	assert.equal(toolSelected("mcp__*", "bash"), false);
	assert.equal(toolSelected("mcp__*", "mcp"), false, "a prefix needs its separator");
	assert.equal(toolSelected("*-read", "read"), false);
	assert.equal(toolSelected("*-read", "bash"), true);
	assert.equal(toolSelected("-read", "bash"), true, "exclusions alone mean everything else");
	assert.equal(toolSelected("-read", "read"), false);
	assert.equal(toolSelected("", "bash"), false, "an empty selector matches nothing");
	assert.equal(toolSelected("bash, grep ,glob", "grep"), true, "spaces are tolerated");
});

// ---------------------------------------------------------------------------
// Presets and configuration
// ---------------------------------------------------------------------------

await test("every preset is complete and stays inside its schema", () => {
	for (const name of CONFIG_SCHEMA["token.preset"].values) {
		const values = presetValues(name);
		for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
			const value = values[key];
			assert.ok(value !== undefined, `${name}.${key} must have a value`);
			if (schema.type === "number") assert.ok(value >= schema.min && value <= schema.max, `${name}.${key} = ${value} is out of range`);
			if (schema.type === "enum") assert.ok(schema.values.includes(value), `${name}.${key} = ${value} is not allowed`);
		}
	}
});

await test("the extremes are ordered by aggressiveness", () => {
	const conservative = presetValues("conservative");
	const balanced = presetValues("balanced");
	const aggressive = presetValues("aggressive");
	const max = presetValues("max");
	assert.equal(presetValues("off")["token.enabled"], false, "off must actually switch the plugin off");
	assert.equal(conservative["token.dedupe"], false);
	assert.equal(aggressive["token.dedupe"], true);
	assert.ok(aggressive["token.minChars"] < balanced["token.minChars"], "aggressive looks at smaller results");
	assert.ok(max["token.minChars"] < aggressive["token.minChars"], "max looks at smaller results still");
	assert.ok(aggressive["token.maxChars"] > 0);
	assert.ok(max["token.maxChars"] < aggressive["token.maxChars"], "max elides harder");
	assert.ok(max["token.foldMinRun"] <= balanced["token.foldMinRun"]);
	assert.equal(max["token.tools"], "*", "only max reaches every tool, including read");
	assert.ok(!toolSelected(balanced["token.tools"], "read"), "read is out of scope at every preset but max");
});

await test("the default configuration is the balanced preset", () => {
	assert.deepEqual(defaultConfig().values, presetValues("balanced"));
});

async function withTempEnv(fn) {
	const root = await mkdtemp(join(tmpdir(), "token-saver-"));
	try {
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		await mkdir(agentDir, { recursive: true });
		await mkdir(join(cwd, ".omp"), { recursive: true });
		await mkdir(join(root, "plugins"), { recursive: true });
		return await fn({ root, agentDir, cwd });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

await test("configuration resolves env over project over global over preset", async () => {
	await withTempEnv(async ({ root, agentDir, cwd }) => {
		const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
		await writeFile(
			join(root, "plugins", "omp-plugins.lock.json"),
			JSON.stringify({ settings: { [pkg.name]: { "token.preset": "aggressive", "token.clip": 111 } } }),
		);
		await writeFile(join(cwd, ".omp", "plugin-overrides.json"), JSON.stringify({ settings: { [pkg.name]: { "token.clip": 222 } } }));

		const config = await loadConfig({ agentDir, cwd, home: root, env: { OMP_TOKEN_MEGA_TOKEN_CLIP: "333" } });
		assert.equal(config.values["token.preset"], "aggressive", "the global preset applies");
		assert.equal(config.values["token.clip"], 333, "env wins");
		assert.equal(config.sources["token.clip"], "env");
		assert.equal(config.values["token.json"], true, "aggressive bundles json on");
		assert.equal(config.sources["token.json"], "preset:aggressive");
		assert.equal(config.values.statusRow, true, "untouched keys fall back to the schema default");
		assert.equal(config.sources.statusRow, "default");

		const withoutEnv = await loadConfig({ agentDir, cwd, home: root, env: {} });
		assert.equal(withoutEnv.values["token.clip"], 222, "project beats global");
		assert.equal(withoutEnv.sources["token.clip"], "project");

		const globalOnly = await loadConfig({ agentDir, cwd: undefined, home: root, env: {} });
		assert.equal(globalOnly.values["token.clip"], 111);
		assert.equal(globalOnly.sources["token.clip"], "global");
	});
});

await test("invalid values are rejected and reported, not applied", async () => {
	await withTempEnv(async ({ root, agentDir, cwd }) => {
		const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
		await writeFile(
			join(cwd, ".omp", "plugin-overrides.json"),
			JSON.stringify({ settings: { [pkg.name]: { "token.preset": "nonsense", "token.clip": "not a number", "token.fold": "yes" } } }),
		);
		const config = await loadConfig({ agentDir, cwd, home: root, env: {} });
		assert.equal(config.values["token.preset"], "balanced", "the bad preset falls through to the default");
		assert.equal(config.values["token.clip"], CONFIG_SCHEMA["token.clip"].default);
		assert.equal(config.values["token.fold"], true, "'yes' is a boolean this schema accepts");
		assert.deepEqual(
			config.problems.map((problem) => problem.key).sort(),
			["token.clip", "token.preset"],
		);
	});
});

await test("a missing configuration is not an error", async () => {
	await withTempEnv(async ({ root, agentDir, cwd }) => {
		const config = await loadConfig({ agentDir, cwd, home: root, env: {} });
		assert.deepEqual(config.values, defaultConfig().values);
		assert.deepEqual(config.problems, []);
	});
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

await test("the YAML reader understands the settings files it is given", () => {
	const parsed = parseScalars(
		[
			"# a comment",
			"tools:",
			"  artifactSpillThreshold: 16 # trailing comment",
			"  outputMaxColumns: 768",
			"compaction:",
			"  supersedeReads: true",
			"  idleEnabled: false",
			"  methodOrder: [remote, shake]",
			"  nested:",
			"    deep: 3",
			'quoted: "a value: with a colon"',
			"",
			"blockList:",
			"  - not-a-scalar",
		].join("\n"),
	);
	assert.equal(parsed["tools.artifactSpillThreshold"], 16);
	assert.equal(parsed["tools.outputMaxColumns"], 768);
	assert.equal(parsed["compaction.supersedeReads"], true);
	assert.equal(parsed["compaction.idleEnabled"], false);
	assert.deepEqual(parsed["compaction.methodOrder"], ["remote", "shake"]);
	assert.equal(parsed["compaction.nested.deep"], 3);
	assert.equal(parsed.quoted, "a value: with a colon");
	assert.equal(parsed["blockList.not-a-scalar"], undefined, "block sequences are skipped, not guessed at");
});

await test("the spill recommendation scales with the window and stays in range", () => {
	assert.equal(recommendedSpillThreshold(0), undefined);
	assert.equal(recommendedSpillThreshold(32_000), 8, "never below 8 KB");
	assert.equal(recommendedSpillThreshold(128_000), 16);
	assert.equal(recommendedSpillThreshold(1_000_000), 50, "never above omp's own default");
});

await test("system-prompt sections are ranked by size", () => {
	const prompt = ["<conventions>", "x".repeat(100), "</conventions>", "## Role", "y".repeat(400), "## Small", "z"];
	const { sections, totalBytes } = systemPromptSections(prompt);
	assert.equal(sections.length, 3);
	assert.equal(sections[0].title, "## Role", "largest first");
	assert.ok(totalBytes > 500);
	assert.equal(sections[0].lines, 1);
});

// ---------------------------------------------------------------------------
// End-to-end hook behaviour, against a fake extension host
// ---------------------------------------------------------------------------

await test("no handler in the merged plugin can rewrite an already-sent prefix", async () => {
	const host = await makeHost();
	await host.start();
	assert.deepEqual(
		[...host.handlers.keys()].sort(),
		[
			"after_provider_response",
			"before_agent_start",
			"before_provider_request",
			"message_end",
			"session_branch",
			"session_compact",
			"session_shutdown",
			"session_start",
			"session_switch",
			"session_tree",
			"tool_execution_end",
			"tool_execution_start",
			"tool_result",
			"turn_end",
		],
		"a `context` handler here would let the plugin rewrite the prefix it measures",
	);
	// The two payload-bearing hooks exist (cache fingerprints the request, the shell records
	// the system prompt) but neither may replace what is sent.
	const payload = { model: "deepseek-flash", messages: [{ role: "user", content: "hi" }], tools: [{ function: { name: "bash" } }] };
	assert.deepEqual(await host.emit("before_provider_request", { payload }), [], "before_provider_request must observe, not replace");
	assert.deepEqual(await host.emit("before_agent_start", { systemPrompt: ["you are omp"] }), [], "before_agent_start must not override the system prompt");
	assert.equal(host.handlers.has("context"), false, "no context handler exists to rewrite history");
});

await test("a noisy in-scope result is reduced, with real content intact", async () => {
	await withConfig({ "token.minChars": 0, "token.minSavingsTokens": 0 }, async () => {
		const host = await makeHost();
		await host.start();
		const noisy = `${"progress   \n".repeat(400)}\u001b[32mdone\u001b[0m\n`;
		const [out] = await host.toolResult(noisy);
		assert.ok(out, "the handler returns a replacement");
		const text = out.content[0].text;
		assert.ok(text.includes("[token-saver:"), "the marker is present");
		assert.ok(text.length < noisy.length / 2, "the text is materially shorter");
		assert.ok(text.includes("done"), "real content survives");
		assert.equal(host.row?.includes("TS -"), true, "the status row reflects the saving");
	});
});

await test("results below minChars, above maxScanBytes, or out of scope are left alone", async () => {
	await withConfig({ "token.minChars": 100_000 }, async () => {
		const host = await makeHost();
		await host.start();
		assert.equal((await host.toolResult("x ".repeat(5000))).length, 0, "below minChars");
	});
	await withConfig({ "token.minChars": 0, "token.maxScanBytes": 4096 }, async () => {
		const host = await makeHost();
		await host.start();
		assert.equal((await host.toolResult("x ".repeat(5000))).length, 0, "above maxScanBytes");
	});
	await withConfig({ "token.minChars": 0, "token.tools": "grep" }, async () => {
		const host = await makeHost();
		await host.start();
		assert.equal((await host.toolResult("x   \n".repeat(2000))).length, 0, "out of scope");
		await host.commands.get("mega").handler("report", host.ctx);
		assert.match(String(host.messages.at(-1).content), /1 out of scope/);
	});
});

await test("an identical repeat becomes a back-reference with a recovery handle", async () => {
	await withConfig({ "token.minChars": 0, "token.json": false, "token.squeeze": false, "token.fold": false, "token.clip": 0, "token.dedupeMinChars": 64 }, async () => {
		const host = await makeHost();
		await host.start();
		const payload = `unique payload\n${Array.from({ length: 200 }, (_, i) => `row ${i}`).join("\n")}`;
		assert.equal((await host.toolResult(payload)).length, 0, "the first copy is sent as produced");
		const [out] = await host.toolResult(payload);
		assert.ok(out, "the duplicate is replaced");
		assert.match(out.content[0].text, /^\[token-saver: identical to the earlier bash result/);
		assert.equal(host.saved.length, 1, "the stub is backed by one artifact holding the full text");
		assert.equal(host.saved[0].text, payload);
	});
});

await test("a budget elision keeps head and tail, stashes the original, and names the handle", async () => {
	await withConfig(
		{ "token.minChars": 0, "token.squeeze": false, "token.fold": false, "token.clip": 0, "token.json": false, "token.dedupe": false, "token.maxChars": 400, "token.headChars": 100, "token.tailChars": 100 },
		async () => {
			const host = await makeHost();
			await host.start();
			const payload = Array.from({ length: 300 }, (_, i) => `unique line ${i} ${"y".repeat(i % 7)}`).join("\n");
			const [out] = await host.toolResult(payload);
			assert.ok(out, "the result is elided");
			const text = out.content[0].text;
			assert.ok(text.startsWith(payload.slice(0, 100)), "the head is intact");
			assert.ok(text.endsWith(payload.slice(-100)), "the tail is intact");
			assert.ok(text.includes("middle elided"), "the omission is announced");
			assert.ok(text.includes("artifact://0"), "the handle is named");
			assert.equal(host.saved.length, 1);
			assert.equal(host.saved[0].text, payload, "the artifact holds the text as it arrived");
			assert.equal(host.saved[0].toolType, "bash");
		},
	);
});

await test("a result omp already spilled is compressed but never re-elided", async () => {
	await withConfig({ "token.minChars": 0, "token.maxChars": 400, "token.squeeze": true, "token.fold": false, "token.clip": 0, "token.json": false, "token.dedupe": false }, async () => {
		const host = await makeHost();
		await host.start();
		const payload = `${"trailing spaces   \n".repeat(400)}`;
		const [out] = await host.toolResult(payload, { details: { meta: { truncation: { artifactId: "7" } } } });
		assert.ok(out, "compression still applies");
		assert.ok(!out.content[0].text.includes("middle elided"), "omp already elided this result");
		assert.equal(host.saved.length, 0, "no second artifact is written");
	});
});

await test("an error is never elided, deduped, or stashed", async () => {
	await withConfig({ "token.minChars": 0, "token.maxChars": 400, "token.minSavingsTokens": 0, "token.dedupeMinChars": 64, "token.squeeze": false, "token.fold": false, "token.clip": 40, "token.json": false }, async () => {
		const host = await makeHost();
		await host.start();
		const failure = `Traceback:\n${Array.from({ length: 200 }, (_, i) => `  at frame ${i} ${"f".repeat(60)}`).join("\n")}`;
		const first = await host.toolResult(failure, { isError: true });
		if (first.length > 0) {
			const text = first[0].content[0].text;
			assert.ok(!text.includes("middle elided"), "an error is never elided");
			assert.ok(!text.includes("identical to the earlier"), "an error is never deduped");
		}
		await host.toolResult(failure, { isError: true });
		assert.equal(host.saved.length, 0, "an error is never stashed");
	});
});

await test("a failing artifact writer degrades instead of failing the tool call", async () => {
	await withConfig({ "token.minChars": 0, "token.maxChars": 400, "token.headChars": 50, "token.tailChars": 50, "token.squeeze": false, "token.fold": false, "token.clip": 0, "token.json": false }, async () => {
		const host = await makeHost({ artifacts: false });
		await host.start();
		const payload = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
		const [out] = await host.toolResult(payload);
		assert.ok(out, "the result is still elided");
		assert.ok(out.content[0].text.includes("not stashed"), "and it says recovery is unavailable");
	});
});

await test("counters, report, config, audit and preset all render", async () => {
	await withConfig({}, async () => {
		const host = await makeHost();
		await host.start();
		await host.emit("tool_execution_start", { toolExecutionId: "1", toolCallId: "1", toolName: "bash", args: {} });
		await host.toolResult(`${"noise   \n".repeat(500)}`);
		for (const sub of ["report", "status", "config", "audit", "preset", "preset max", "reset", "help"]) {
			await host.commands.get("mega").handler(sub, host.ctx);
		}
		const rendered = host.messages.map((message) => String(message.content)).join("\n");
		assert.ok(rendered.includes("Prefix-cache safety"), "the report states the contract");
		assert.ok(rendered.includes("Token audit"), "the audit renders");
		assert.ok(rendered.includes("Effective configuration"), "the config dump renders");
		assert.ok(rendered.includes("| `max`"), "the preset table renders");
		assert.ok(
			host.notifications.some((entry) => entry.text.includes("Preset 'max' selected")),
			"the preset switch reports",
		);
	});
});

await test("without a dialog surface the menu prints the settings instead", async () => {
	await withConfig({}, async () => {
		const host = await makeHost();
		await host.start();
		await host.commands.get("mega").handler("menu", { ...host.ctx, hasUI: false });
		const rendered = String(host.messages.at(-1).content);
		assert.ok(rendered.includes("Change a setting"), "the fallback names the shell commands");
		assert.ok(rendered.includes("omp plugin config set"), "with the exact command");
		assert.ok(rendered.includes("Effective configuration"), "and the current values");
	});
});

// ---------------------------------------------------------------------------

if (failures.length > 0) {
	console.error(`\n${failures.length} failing:\n`);
	for (const failure of failures) console.error(`  x ${failure}`);
	console.error(`\n${passed} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`all ${passed} tests passed`);
