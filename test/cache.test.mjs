// Verifies the cache accounting of omp-token-mega: miss attribution (including
// lifecycle-named causes), configuration resolution and its effects, agent-directory
// resolution, subagent shard aggregation, shard retention, the config doctor's
// transaction, and the merged command surface.
//
//   node test/cache.test.mjs
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeHost, withEnv, tick } from "./harness.mjs";
import { CONFIG_SCHEMA, configDefaults, coerceValue, fallbackConfig, formatConfig, loadConfig, resetConfig, resolveAgentDir, settingsKey } from "../src/config.js";
import { addTotals, pruneShards, readSubagentTotals } from "../src/stats.js";
import { cacheSavings, peakLabel, priceMultiplier, pricePeriod } from "../src/deepseek.js";
import { DEAD_KEYS, fix, removeDeadKeys, rollback, scan, scanText } from "../src/repair.js";

const fail = [];
const expect = (label, cond, extra) => {
	console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond || extra === undefined ? "" : `  -> ${JSON.stringify(extra)}`}`);
	if (!cond) fail.push(label);
};

import { DEEPSEEK_MODEL as MODEL, SCHEDULED_MODEL as MODEL_SCHEDULED } from "./harness.mjs";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeHarness({ root, settings, overrides, env, model } = {}) {
	const host = await makeHost({
		root: root ?? (await mkdtemp(join(tmpdir(), "token-mega-"))),
		settings,
		overrides,
		model,
	});
	await withEnv(env, async () => {
		await host.start();
	});
	const fire = (name, event) => withEnv(env, () => host.emit(name, event, host.ctx));
	return {
		base: host.ctx.cwd,
		agentDir: host.agentDir,
		sessionDir: host.sessionDir,
		stateDir: host.stateDir,
		shardsDir: host.shardsDir,
		ctx: host.ctx,
		handlers: host.handlers,
		messages: host.messages,
		env: env ?? {},
		get notices() {
			return host.notifications.map((entry) => entry.text);
		},
		/** The row as the plugin last drew it: one ANSI-stripped line, `undefined` when none. */
		get row() {
			return host.row;
		},
		command: () => host.commands.get("mega"),
		fire,
		request: (messages, tools) => fire("before_provider_request", { payload: { model: model?.id, messages, tools } }),
		response: (usage) => fire("message_end", { message: { role: "assistant", usage } }),
		shardFiles: () => host.shardFiles(),
	};
}

const TOOLS_A = [{ function: { name: "bash" } }, { function: { name: "read" } }];

// ---------------------------------------------------------------- accounting
{
	const h = await makeHarness();
	await h.fire("before_agent_start", { systemPrompt: ["you are omp"] });

	await h.request([1, 2], TOOLS_A);
	await h.response({ input: 10_000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.003 } });

	await h.request([1, 2, 3, 4], TOOLS_A);
	await h.response({ input: 200, output: 100, cacheRead: 9_800, cacheWrite: 0, cost: { total: 0.00018 } });

	// Tool catalogue changed (bash removed) -> attributable miss.
	await h.request([1, 2, 3, 4, 5], [{ function: { name: "read" } }]);
	await h.response({ input: 10_000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.003 } });

	await h.request([1, 2, 3, 4, 5, 6], [{ function: { name: "read" } }]);
	await h.response({ input: 100, output: 100, cacheRead: 10_000, cacheWrite: 0, cost: { total: 0.0001 } });

	// An all-zero usage record must not invent a request.
	await h.request([1, 2, 3, 4, 5, 6, 7], [{ function: { name: "read" } }]);
	await h.response({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } });

	await h.fire("session_shutdown", {});

	const shardFiles = await h.shardFiles();
	expect("shard persisted", shardFiles.length === 1, shardFiles);
	const shard = await readJson(join(h.shardsDir, shardFiles[0]));
	expect("shard kind/version", shard.kind === "omp-token-mega-shard" && shard.version === 1);
	expect("four requests recorded (zero-usage turn ignored)", shard.totals.requests === 4, shard.totals);
	expect("two requests had a hit", shard.totals.hitRequests === 2, shard.totals.hitRequests);
	expect("cached input token total", shard.totals.cachedInputTokens === 19_800, shard.totals.cachedInputTokens);
	expect("uncached input excludes cached", shard.totals.uncachedInputTokens === 20_300, shard.totals.uncachedInputTokens);
	expect(
		"savings use the cache-read spread",
		Math.abs(shard.totals.savedUsd - 19_800 * ((0.3 - 0.006) / 1_000_000)) < 1e-12,
		shard.totals.savedUsd,
	);
	expect("cold start attributed to first_turn", shard.misses.byReason.first_turn === 1, shard.misses.byReason);
	expect("tool change attributed", shard.misses.byReason.tool_change === 1, shard.misses.byReason);
	expect("stable turns not blamed", (shard.misses.byReason.external_miss ?? 0) === 0, shard.misses.byReason);
	expect("status row shows hit rate and savings", /DS cache \d+%/.test(h.row ?? ""));
}

// ---------------------------------------------------------------- lifecycle causes
{
	const h = await makeHarness();
	await h.fire("before_agent_start", { systemPrompt: ["you are omp"] });

	await h.request([1, 2], TOOLS_A);
	await h.response({ input: 10_000, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } });

	// Compaction rewrites the transcript: the next miss is named, not guessed.
	await h.fire("session_compact", {});
	await h.request([1], TOOLS_A);
	await h.response({ input: 9_000, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } });

	// Branch navigation rewinds history.
	await h.fire("session_branch", { previousSessionFile: undefined });
	await h.request([1, 2], TOOLS_A);
	await h.response({ input: 9_000, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } });

	// Tree navigation too, through the same cause.
	await h.fire("session_tree", {});
	await h.request([1, 2, 3], TOOLS_A);
	await h.response({ input: 9_000, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } });

	// A resumed session replays a transcript onto a cold cache.
	await h.fire("session_switch", { reason: "resume", previousSessionFile: "x" });
	await h.request([1, 2, 3, 4], TOOLS_A);
	await h.response({ input: 9_000, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } });

	// A lifecycle cause is consumed by the first miss and does not leak onto later ones.
	await h.request([1, 2, 3, 4, 5], TOOLS_A);
	await h.response({ input: 9_000, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } });

	await h.fire("session_shutdown", {});
	const shardFiles = await h.shardFiles();
	const shards = await Promise.all(shardFiles.map((name) => readJson(join(h.shardsDir, name))));
	const reasons = shards.reduce((acc, shard) => {
		for (const [reason, count] of Object.entries(shard.misses.byReason ?? {})) acc[reason] = (acc[reason] ?? 0) + count;
		return acc;
	}, {});
	expect("compaction named as the miss cause", reasons.compaction === 1, reasons);
	expect("branch navigation named", reasons.branch_nav === 2, reasons);
	expect("resume named", reasons.resume === 1, reasons);
	expect(
		"lifecycle cause consumed once",
		(reasons.first_turn ?? 0) === 1 && (reasons.external_miss ?? 0) === 1,
		reasons,
	);
}

// ---------------------------------------------------------------- idle attribution
{
	const h = await makeHarness({ settings: { "@dillydalli3r/omp-token-mega": { "cache.idleTtlMinutes": 1 } } });
	await h.fire("before_agent_start", { systemPrompt: ["you are omp"] });

	const realNow = Date.now;
	let clock = realNow();
	Date.now = () => clock;
	try {
		await h.request([1, 2], TOOLS_A);
		await h.response({ input: 10_000, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } });
		await h.request([1, 2, 3], TOOLS_A);
		await h.response({ input: 200, output: 10, cacheRead: 9_800, cacheWrite: 0, cost: { total: 0 } });
		// 90s idle with a 1-minute TTL: the miss must be attributed to the provider cache.
		clock += 90_000;
		await h.request([1, 2, 3, 4], TOOLS_A);
		await h.response({ input: 10_000, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } });
	} finally {
		Date.now = realNow;
	}
	await h.fire("session_shutdown", {});
	const [shard] = await Promise.all((await h.shardFiles()).map((name) => readJson(join(h.shardsDir, name))));
	expect("idle_ttl honours the configured TTL", shard.misses.byReason.idle_ttl === 1, shard.misses.byReason);
}

// ---------------------------------------------------------------- real-time pricing
{
	const peak = Date.UTC(2026, 8, 16, 2, 0, 0); // Wednesday 02:00 UTC — inside a peak window
	const early = Date.UTC(2026, 8, 16, 4, 30, 0); // Wednesday 04:30 UTC — past the first window, before the second
	const midday = Date.UTC(2026, 8, 16, 12, 0, 0); // Wednesday 12:00 UTC — outside every window
	const weekend = Date.UTC(2026, 8, 20, 2, 0, 0); // Sunday 02:00 UTC — same minute, no weekday match
	expect("peak fixture is a weekday peak minute", new Date(peak).getUTCDay() === 3 && new Date(peak).getUTCHours() === 2, new Date(peak).toISOString());
	expect("weekend fixture is a Sunday", new Date(weekend).getUTCDay() === 0, new Date(weekend).toISOString());

	expect("peak keeps the headline rate", priceMultiplier(MODEL_SCHEDULED, peak) === 1 && pricePeriod(MODEL_SCHEDULED, peak) === "peak");
	expect("off-peak applies the multiplier", priceMultiplier(MODEL_SCHEDULED, weekend) === 0.5 && priceMultiplier(MODEL_SCHEDULED, midday) === 0.5);
	expect("off-peak period is named", pricePeriod(MODEL_SCHEDULED, weekend) === "off-peak");
	expect(
		"a model without a schedule has no period and no label",
		pricePeriod(MODEL, peak) === undefined && priceMultiplier(MODEL, peak) === 1 && peakLabel(MODEL, peak) === undefined,
		{ period: pricePeriod(MODEL, peak), label: peakLabel(MODEL, peak) },
	);

	// The label names the window whose bounds bracket the state: the user asked when peak
	// starts and ends, not how long is left of it.
	const label = (at) => peakLabel(MODEL_SCHEDULED, at);
	expect(
		"peak label names the window in force",
		label(peak)?.period === "peak" && label(peak)?.text === "peak 01:00\u201304:00Z",
		label(peak),
	);
	expect(
		"off-peak label names today's next window without a weekday",
		label(early)?.text === "off-peak (peak 06:00\u201310:00Z)",
		label(early),
	);
	expect("off-peak label names tomorrow's window", label(midday)?.text === "off-peak (peak Thu 01:00\u201304:00Z)", label(midday));
	expect("off-peak label crosses the weekend to Monday", label(weekend)?.text === "off-peak (peak Mon 01:00\u201304:00Z)", label(weekend));

	// A schedule that bills both periods the same is not a tariff: with no difference to
	// report there is no period, no label, and the row must not claim a discount.
	const flat = {
		...MODEL_SCHEDULED,
		cost: { ...MODEL_SCHEDULED.cost, timeBased: { offPeakMultiplier: 1, peakWindows: MODEL_SCHEDULED.cost.timeBased.peakWindows } },
	};
	expect(
		"an equal tariff reports no period",
		pricePeriod(flat, peak) === undefined && priceMultiplier(flat, peak) === 1 && peakLabel(flat, peak) === undefined,
		{ period: pricePeriod(flat, peak), multiplier: priceMultiplier(flat, peak), label: peakLabel(flat, peak) },
	);
	// Discounted, but with no window to promise: the period still has to be named.
	const windowless = {
		...MODEL_SCHEDULED,
		cost: { ...MODEL_SCHEDULED.cost, timeBased: { offPeakMultiplier: 0.5, peakWindows: [] } },
	};
	expect(
		"a discounted schedule without windows still reports off-peak",
		peakLabel(windowless, peak)?.text === "off-peak",
		peakLabel(windowless, peak),
	);

	const million = (at) => cacheSavings({ cacheRead: 1_000_000 }, MODEL_SCHEDULED, at);
	expect("savings use the peak spread", Math.abs(million(peak) - 1_000_000 * ((0.3 - 0.006) / 1_000_000)) < 1e-12, million(peak));
	expect("savings are halved off-peak", Math.abs(million(weekend) - million(peak) / 2) < 1e-12, million(weekend));

	// The live path must price each request at the tariff in force when it was sent.
	const h = await makeHarness({ model: MODEL_SCHEDULED });
	await h.fire("before_agent_start", { systemPrompt: ["you are omp"] });
	const realNow = Date.now;
	Date.now = () => weekend;
	try {
		await h.request([1, 2], TOOLS_A);
		await h.response({ input: 10_000, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } });
		await h.request([1, 2, 3], TOOLS_A);
		await h.response({ input: 0, output: 10, cacheRead: 1_000_000, cacheWrite: 0, cost: { total: 0.006 } });
	} finally {
		Date.now = realNow;
	}
	// Read while the row the off-peak turn drew is still the current one: the label names the
	// next window (Monday's, from a Sunday) so the row and the report agree about the tariff.
	const periodRow = h.row ?? "";
	await h.fire("session_shutdown", {});
	const [shard] = await Promise.all((await h.shardFiles()).map((name) => readJson(join(h.shardsDir, name))));
	expect("recorded savings use the off-peak card", Math.abs(shard.totals.savedUsd - million(weekend)) < 1e-12, shard.totals.savedUsd);
	expect("the status row names the period and its window", periodRow.includes("off-peak (peak Mon 01:00\u201304:00Z)"), periodRow);
}

// ---------------------------------------------------------------- session-wide metrics
{
	const h = await makeHarness();
	await h.fire("before_agent_start", { systemPrompt: ["you are omp"] });
	await h.request([1, 2], TOOLS_A);
	await h.response({ input: 10_000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.003 } });
	await h.request([1, 2, 3], TOOLS_A);
	await h.response({ input: 0, output: 100, cacheRead: 9_800, cacheWrite: 0, cost: { total: 0.0001 } });

	// A child session of this process, with traffic of its own.
	await writeFile(
		join(h.shardsDir, "child.json"),
		JSON.stringify({
			version: 1,
			kind: "omp-token-mega-shard",
			instanceId: "child-instance",
			pid: process.pid,
			startedAt: Date.now() + 1,
			updatedAt: Date.now(),
			totals: { requests: 2, hitRequests: 2, cachedInputTokens: 100_000, uncachedInputTokens: 0, outputTokens: 20, costUsd: 0.0013, savedUsd: 0.0001 },
		}),
		"utf8",
	);

	await h.request([1, 2, 3, 4], TOOLS_A);
	await h.response({ input: 0, output: 100, cacheRead: 9_900, cacheWrite: 0, cost: { total: 0.0001 } });
	const row = h.row ?? "";
	expect("status row includes subagent traffic", row.includes("1 agents 100%"), row);
	// The merged row keeps one money figure per feature: the cache segment reports what the
	// cache saved, the balance segment reports what the session spent. Asserting `cost` here
	// would be the same number twice.
	expect("status row reports the session-wide saving rounded to hundredths", row.includes("$0.01 saved"), row);
	expect("status row cached tokens cover the whole session", row.includes("120k cached"), row);
	// Main alone is 19,700 / 29,700 = 66%; the child lifts the session figure to 92%.
	expect("status row hit rate is the session figure", /DS cache 92%/.test(row), row);

	await h.command().handler("", h.ctx);
	const report = h.messages.at(-1)?.content ?? "";
	expect("report headline is session-wide", report.includes("- Requests: 5 (4 with a cache hit)"), report.slice(0, 400));
	expect("report names the scope", report.includes("plus 1 subagent session(s)"), report.slice(0, 400));
	expect("report breaks out the child", /- Subagents \(1 session\(s\)\): 2 request\(s\), 100\.0% hit/.test(report), report.split("\n").filter((line) => line.startsWith("- Subagents")).join(" | "));
	expect("report breaks out the main session", report.includes("- Main session: 3 request(s)"), report);
	expect(
		"combined totals sum field-wise",
		JSON.stringify(addTotals({ requests: 1, cachedInputTokens: 5, costUsd: 0.5 }, { requests: 2, cachedInputTokens: 7, savedUsd: 0.25 })) ===
			JSON.stringify({ requests: 3, hitRequests: 0, cachedInputTokens: 12, uncachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0.5, savedUsd: 0.25 }),
	);
}

// ---------------------------------------------------------------- resolution + aggregation
const mainCtx = { sessionManager: { getSessionDir: () => join("C:", "agent", "sessions", "--slug--") } };
const childCtx = {
	sessionManager: { getSessionDir: () => join("C:", "agent", "sessions", "--slug--", "2026-09-20T04-50-19-817Z_abc") },
};
expect("main session resolves the agent dir", resolveAgentDir(mainCtx) === join("C:", "agent"));
// A subagent's rebound session sits one level deeper; both must resolve to the same root.
expect("child session resolves the same agent dir", resolveAgentDir(childCtx) === join("C:", "agent"));

{
	const h = await makeHarness();
	await h.shardFiles();
	await writeFile(
		join(h.shardsDir, "sibling.json"),
		JSON.stringify({
			version: 1,
			kind: "omp-token-mega-shard",
			instanceId: "sibling-instance",
			pid: process.pid,
			startedAt: Date.now(),
			totals: { requests: 2, hitRequests: 1, cachedInputTokens: 900, uncachedInputTokens: 100, outputTokens: 10, costUsd: 0.002, savedUsd: 0.0003 },
		}),
		"utf8",
	);
	await writeFile(
		join(h.shardsDir, "foreign.json"),
		JSON.stringify({
			version: 1,
			kind: "omp-token-mega-shard",
			instanceId: "foreign-instance",
			pid: process.pid + 1,
			startedAt: Date.now(),
			totals: { requests: 99, costUsd: 5 },
		}),
		"utf8",
	);
	const siblings = await readSubagentTotals(h.stateDir, { excludeInstanceId: "self", sinceMs: 0 });
	expect("sibling shard aggregated", siblings.shards === 1 && siblings.requests === 2, siblings);
	expect("another process's shard excluded", siblings.costUsd === 0.002, siblings.costUsd);
	expect("sibling cached tokens aggregated", siblings.cachedInputTokens === 900, siblings.cachedInputTokens);
}

// ---------------------------------------------------------------- retention
{
	const h = await makeHarness();
	await h.shardFiles();
	const stale = {
		version: 1,
		kind: "omp-token-mega-shard",
		instanceId: "stale",
		pid: process.pid,
		startedAt: 1_000,
		updatedAt: 1_000,
		totals: { requests: 5 },
	};
	const fresh = { ...stale, instanceId: "fresh", updatedAt: Date.now() };
	const other = { ...stale, instanceId: "other", kind: "some-other-plugin" };
	await writeFile(join(h.shardsDir, "stale.json"), JSON.stringify(stale), "utf8");
	await writeFile(join(h.shardsDir, "fresh.json"), JSON.stringify(fresh), "utf8");
	await writeFile(join(h.shardsDir, "other.json"), JSON.stringify(other), "utf8");

	const result = await pruneShards(h.stateDir, { retentionDays: 7, excludeInstanceId: undefined });
	const left = await h.shardFiles();
	expect("stale shard pruned", result.removed === 1 && !left.includes("stale.json"), { result, left });
	expect("running shard kept", left.includes("fresh.json"), left);
	expect("foreign shard kind untouched", left.includes("other.json"), left);
	expect("retention 0 is a no-op", (await pruneShards(h.stateDir, { retentionDays: 0 })).removed === 0);
}

// ---------------------------------------------------------------- configuration
{
	const defaults = await loadConfig({ env: {} });
	const presetKeys = defaults.keys.filter((key) => defaults.sources[key].startsWith("preset:"));
	expect(
		"unset configuration resolves to defaults and presets",
		presetKeys.length > 0 &&
			presetKeys.every((key) => key.startsWith("token.") && defaults.sources[key] === "preset:balanced") &&
			defaults.keys.every((key) => defaults.sources[key].startsWith("preset:") || defaults.sources[key] === "default"),
		defaults.sources,
	);
	expect(
		"no stored or environment layer leaks in",
		!Object.values(defaults.sources).some((source) => ["env", "global", "project"].includes(source)),
		defaults.sources,
	);
	expect("defaults match the schema", JSON.stringify(defaults.values) === JSON.stringify(configDefaults()), defaults.values);

	const env = await loadConfig({
		env: {
			OMP_TOKEN_MEGA_STATUS_ROW: "off",
			OMP_TOKEN_MEGA_STATUS_MAX_CHARS: "77",
			OMP_TOKEN_MEGA_DIR: "/tmp/megacache-custom",
		},
	});
	expect("env overrides are coerced", env.values.statusRow === false && env.values.statusMaxChars === 77, env.values);
	expect("env source is recorded", env.sources.statusRow === "env" && env.sources.stateDir === "env", env.sources);
	expect("untouched keys stay default", env.sources["cache.subagents"] === "default", env.sources);

	const root = await mkdtemp(join(tmpdir(), "megacache-cfg-"));
	const agentDir = join(root, "agent");
	await mkdir(join(root, "plugins"), { recursive: true });
	const key = await settingsKey();
	await writeFile(
		join(root, "plugins", "omp-plugins.lock.json"),
		JSON.stringify({
			plugins: {},
			settings: { [key]: { "cache.subagents": false, "cache.idleTtlMinutes": 30, statusMaxChars: 999, stateDir: "/from/lockfile" } },
		}),
		"utf8",
	);
	const lockfile = await loadConfig({ agentDir, home: join(root, "unused-home"), env: {} });
	expect(
		"global plugin settings are honoured",
		lockfile.values["cache.subagents"] === false && lockfile.values["cache.idleTtlMinutes"] === 30,
		lockfile.values,
	);
	expect("global source is recorded", lockfile.sources["cache.subagents"] === "global", lockfile.sources);
	expect(
		"out-of-range global value is rejected, not applied",
		lockfile.values.statusMaxChars === CONFIG_SCHEMA.statusMaxChars.default && lockfile.problems.length === 1,
		{ values: lockfile.values, problems: lockfile.problems },
	);
	expect("lockfile path is reported", lockfile.files.global === join(root, "plugins", "omp-plugins.lock.json"), lockfile.files);

	await mkdir(join(root, ".omp"), { recursive: true });
	await writeFile(
		join(root, ".omp", "plugin-overrides.json"),
		JSON.stringify({ settings: { [key]: { "cache.subagents": true, "cache.idleTtlMinutes": 60 } } }),
		"utf8",
	);
	const project = await loadConfig({ agentDir, cwd: root, env: {} });
	expect("project override beats the global setting", project.values["cache.idleTtlMinutes"] === 60 && project.values["cache.subagents"] === true, project.values);
	expect("project source is recorded", project.sources["cache.idleTtlMinutes"] === "project", project.sources);

	const envWins = await loadConfig({ agentDir, cwd: root, env: { OMP_TOKEN_MEGA_CACHE_IDLE_TTL_MINUTES: "2" } });
	expect("env beats the project override", envWins.values["cache.idleTtlMinutes"] === 2 && envWins.sources["cache.idleTtlMinutes"] === "env", envWins);

	const broken = await loadConfig({ agentDir, cwd: root, env: { OMP_TOKEN_MEGA_CACHE_IDLE_TTL_MINUTES: "soon" } });
	expect(
		"an unparsable env value falls through to the next layer",
		broken.values["cache.idleTtlMinutes"] === 60 && broken.problems.some((problem) => problem.key === "cache.idleTtlMinutes"),
		{ values: broken.values, problems: broken.problems },
	);

	expect("boolean coercion accepts omp spellings", coerceValue(CONFIG_SCHEMA.enabled, "yes").value === true && coerceValue(CONFIG_SCHEMA.enabled, "0").value === false);
	expect("number coercion reports bounds", coerceValue(CONFIG_SCHEMA.statusMaxChars, 10).error === "must be >= 40");
	expect("string coercion rejects a number", coerceValue(CONFIG_SCHEMA.stateDir, 7).ok === false);

	const rendered = formatConfig(project);
	expect("config report lists every key", project.keys.every((name) => rendered.includes(name)));
	expect("config report names the sources", rendered.includes("(project)") && rendered.includes("omp plugin config set"));
	expect("degraded config still renders", formatConfig(await fallbackConfig()).includes("### Effective configuration"));

	// A lockfile at the derived location without this plugin's settings must not shadow
	// the `~/.omp/plugins` candidate omp is actually reading.
	const bare = await mkdtemp(join(tmpdir(), "megacache-bare-"));
	await mkdir(join(bare, "plugins"), { recursive: true });
	await writeFile(join(bare, "plugins", "omp-plugins.lock.json"), JSON.stringify({ plugins: {}, settings: {} }), "utf8");
	const home = await mkdtemp(join(tmpdir(), "megacache-home-"));
	await mkdir(join(home, ".omp", "plugins"), { recursive: true });
	await writeFile(
		join(home, ".omp", "plugins", "omp-plugins.lock.json"),
		JSON.stringify({ plugins: {}, settings: { [key]: { statusMaxChars: 200 } } }),
		"utf8",
	);
	const viaHome = await loadConfig({ agentDir: join(bare, "agent"), home, env: {} });
	expect(
		"settings are found in the home lockfile when the derived one has none",
		viaHome.values.statusMaxChars === 200 && viaHome.sources.statusMaxChars === "global",
		{ values: viaHome.values, files: viaHome.files },
	);
	expect("the file actually used is reported", viaHome.files.global === join(home, ".omp", "plugins", "omp-plugins.lock.json"), viaHome.files);
}

// ---------------------------------------------------------------- manifest parity
{
	const pkg = await readJson(new URL("../package.json", import.meta.url));
	const declared = pkg.omp?.settings ?? {};
	const keys = Object.keys(CONFIG_SCHEMA);
	expect("manifest declares every setting", keys.every((key) => key in declared), Object.keys(declared));
	expect("manifest declares nothing extra", Object.keys(declared).length === keys.length, Object.keys(declared));
	const mismatches = keys.filter((key) => {
		const a = CONFIG_SCHEMA[key];
		const b = declared[key];
		return (
			b.type !== a.type ||
			b.default !== a.default ||
			(b.env ?? undefined) !== (a.env ?? undefined) ||
			(b.min ?? undefined) !== (a.min ?? undefined) ||
			(b.max ?? undefined) !== (a.max ?? undefined) ||
			b.description !== a.description
		);
	});
	expect("manifest schema matches the code", mismatches.length === 0, mismatches);
	expect("settings key is the package name", (await settingsKey()) === pkg.name, pkg.name);
}

// ---------------------------------------------------------------- settings take effect
{
	const h = await makeHarness({ env: { OMP_TOKEN_MEGA_ENABLED: "0" } });
	await h.fire("before_agent_start", { systemPrompt: ["you are omp"] });
	await h.request([1, 2], TOOLS_A);
	await h.response({ input: 10_000, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } });
	await h.fire("session_shutdown", {});
	expect("disabled plugin writes no shard", (await h.shardFiles()).length === 0);
	expect("disabled plugin draws no status row", h.row === undefined, h.row);

	const quiet = await makeHarness({ settings: { "@dillydalli3r/omp-token-mega": { statusRow: false } } });
	await quiet.fire("before_agent_start", { systemPrompt: ["you are omp"] });
	await quiet.request([1, 2], TOOLS_A);
	await quiet.response({ input: 10_000, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } });
	await quiet.fire("session_shutdown", {});
	expect("statusRow off still accounts", (await quiet.shardFiles()).length === 1);
	expect("statusRow off clears the row", quiet.row === undefined, quiet.row);

	const narrow = await makeHarness({ settings: { "@dillydalli3r/omp-token-mega": { statusMaxChars: 40 } } });
	await narrow.fire("before_agent_start", { systemPrompt: ["you are omp"] });
	await narrow.request([1, 2], TOOLS_A);
	await narrow.response({ input: 10_000, output: 10, cacheRead: 9_800, cacheWrite: 0, cost: { total: 0.001 } });
	const row = narrow.row ?? "";
	expect("statusMaxChars is honoured", row.length <= 40 && row.length > 0, { row, length: row.length });

	const noAgents = await makeHarness({ settings: { "@dillydalli3r/omp-token-mega": { "cache.subagents": false } } });
	await noAgents.fire("before_agent_start", { systemPrompt: ["you are omp"] });
	await noAgents.command().handler("", noAgents.ctx);
	expect(
		"subagents off is stated in the report",
		(noAgents.messages.at(-1)?.content ?? "").includes("`cache.subagents` is off"),
		noAgents.messages.at(-1)?.content?.slice(0, 120),
	);

	const small = await makeHarness();
	await small.fire("before_agent_start", { systemPrompt: ["you are omp"] });
	await small.request([1, 2], TOOLS_A);
	await small.response({ input: 10_000, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.003 } });
	await small.request([1, 2, 3], TOOLS_A);
	await small.response({ input: 128, output: 10, cacheRead: 128, cacheWrite: 0, cost: { total: 0.000039 } });
	const smallRow = small.row ?? "";
	// 128 cached tokens stay legible in the row, not rounded to `0k`. The money the row
	// carries is currency — hundredths — so a sub-cent saving reads `$0.00` there, and the
	// magnitude lives in the section, which is the ledger.
	expect("small counts keep their magnitude", smallRow.includes("128 cached") && smallRow.includes("$0.00 saved"), smallRow);
	await small.command().handler("cache", small.ctx);
	expect(
		"the section keeps the sub-cent saving",
		/\$0\.0000\d\d/.test(small.messages.at(-1)?.content ?? ""),
		(small.messages.at(-1)?.content ?? "").slice(-400),
	);

	const custom = join(await mkdtemp(join(tmpdir(), "megacache-statedir-")), "elsewhere");
	const redirected = await makeHarness({ env: { OMP_TOKEN_MEGA_DIR: custom } });
	await redirected.fire("before_agent_start", { systemPrompt: ["you are omp"] });
	await redirected.request([1, 2], TOOLS_A);
	await redirected.response({ input: 10_000, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } });
	await redirected.fire("session_shutdown", {});
	expect("stateDir redirects the shard", (await readdir(join(custom, "shards"))).length === 1);
	expect("stateDir leaves the default location empty", (await redirected.shardFiles()).length === 0, await redirected.shardFiles());

	const pruned = await makeHarness();
	await pruned.shardFiles();
	await writeFile(
		join(pruned.shardsDir, "stale.json"),
		JSON.stringify({
			version: 1,
			kind: "omp-token-mega-shard",
			instanceId: "stale",
			pid: 1,
			startedAt: 1_000,
			updatedAt: 1_000,
			totals: {},
		}),
		"utf8",
	);
	await pruned.fire("session_start", {});
	let prunedAway = false;
	for (let attempt = 0; attempt < 20 && !prunedAway; attempt += 1) {
		prunedAway = !(await pruned.shardFiles()).includes("stale.json");
		if (!prunedAway) await sleep(25);
	}
	expect("stale sibling shards are pruned on session start", prunedAway);
}

// ---------------------------------------------------------------- reset to defaults
{
	const root = await mkdtemp(join(tmpdir(), "megacache-reset-"));
	const agentDir = join(root, "agent");
	const key = await settingsKey();
	await mkdir(join(root, "plugins"), { recursive: true });
	const lockPath = join(root, "plugins", "omp-plugins.lock.json");
	await writeFile(
		lockPath,
		JSON.stringify({
			plugins: {
				[key]: { version: "1.1.0", enabledFeatures: null, enabled: true },
				"other-plugin": { version: "1.0.0", enabledFeatures: null, enabled: true },
			},
			settings: { [key]: { statusRow: false, "cache.idleTtlMinutes": 30 }, "other-plugin": { token: "keep-me" } },
		}),
		"utf8",
	);
	await mkdir(join(root, ".omp"), { recursive: true });
	const projectPath = join(root, ".omp", "plugin-overrides.json");
	await writeFile(projectPath, JSON.stringify({ disabled: ["x"], settings: { [key]: { "cache.subagents": false } } }), "utf8");
	const resetOptions = { agentDir, cwd: root, home: join(root, "no-such-home") };

	const scoped = await resetConfig({ ...resetOptions, key: "statusRow", scope: "global" });
	expect("a key-scoped reset clears exactly that key", scoped.cleared.length === 1 && scoped.cleared[0].keys.join() === "statusRow", scoped);
	let lockText = await readFile(lockPath, "utf8");
	let lock = JSON.parse(lockText);
	expect("the plugin's other setting survives", lock.settings[key]["cache.idleTtlMinutes"] === 30, lock.settings[key]);
	expect("another plugin's settings survive", lock.settings["other-plugin"].token === "keep-me", lock.settings);
	expect("the file keeps the manager's formatting", !lockText.endsWith("\n") && lockText.includes('\n  "plugins": {'), lockText.slice(0, 40));

	const everything = await resetConfig(resetOptions);
	expect(
		"an unscoped reset clears both scopes",
		everything.cleared.length === 2 && everything.cleared.some((entry) => entry.scope === "project"),
		everything.cleared,
	);
	lock = JSON.parse(await readFile(lockPath, "utf8"));
	expect("the plugin's settings entry is gone", lock.settings[key] === undefined, lock.settings);
	expect("enablement is untouched by a settings reset", lock.plugins[key].enabled === true, lock.plugins[key]);
	const project = JSON.parse(await readFile(projectPath, "utf8"));
	expect("the project override entry is gone", project.settings === undefined && project.disabled[0] === "x", project);

	const again = await resetConfig(resetOptions);
	expect("reset is idempotent", again.cleared.length === 0, again);
	expect("a reset config resolves to defaults", (await loadConfig(resetOptions)).values.statusRow === CONFIG_SCHEMA.statusRow.default);

	const unknown = await resetConfig({ ...resetOptions, key: "nope" });
	expect("an unknown key is refused", unknown.cleared.length === 0 && /unknown setting/.test(unknown.skipped[0].reason), unknown.skipped);

	const brokenRoot = await mkdtemp(join(tmpdir(), "megacache-broken-"));
	await mkdir(join(brokenRoot, "plugins"), { recursive: true });
	const brokenPath = join(brokenRoot, "plugins", "omp-plugins.lock.json");
	await writeFile(brokenPath, "{ not json", "utf8");
	const broken = await resetConfig({ agentDir: join(brokenRoot, "agent"), home: join(brokenRoot, "unused") });
	expect(
		"a malformed file is reported rather than overwritten",
		broken.cleared.length === 0 && broken.skipped.some((entry) => entry.reason.startsWith("unreadable")),
		broken.skipped,
	);
	expect("the malformed file is left byte-identical", (await readFile(brokenPath, "utf8")) === "{ not json");
}

// ---------------------------------------------------------------- config doctor
{
	const h = await makeHarness();
	const dead = Object.keys(DEAD_KEYS)[0];
	const liveText = [
		"providers:",
		"  deepseek:",
		"    modelOverrides:",
		"      deepseek-flash:",
		"        compat:",
		`          ${dead}: true`,
		"          stripImageInput: false",
		"",
	].join("\n");
	await writeFile(join(h.agentDir, "models.yml"), liveText, "utf8");
	await writeFile(
		join(h.agentDir, "models.json"),
		JSON.stringify({ providers: { deepseek: { modelOverrides: { "deepseek-flash": { compat: { [dead]: true } } } } } }, null, 2),
		"utf8",
	);

	const found = await scan(h.agentDir);
	expect("doctor finds the live offender", found.live.offenders.length === 1, found.live.offenders);
	expect("doctor finds the legacy offender", found.legacy.offenders.length === 1, found.legacy.offenders);

	const receipt = await fix(h.agentDir);
	expect("fix touched both files", receipt.changedFiles.length === 2, receipt.changedFiles.map((file) => file.file));
	const fixedLive = await readFile(join(h.agentDir, "models.yml"), "utf8");
	expect("dead key removed from the live file", !fixedLive.includes(dead));
	expect("sibling valid key preserved", fixedLive.includes("stripImageInput: false"));
	expect("comments and structure intact", fixedLive.startsWith("providers:\n  deepseek:\n    modelOverrides:"));
	expect("backup written", existsSync(join(h.agentDir, receipt.changedFiles[0].backupFile)));
	expect("doctor clean after fix", (await scan(h.agentDir)).live.offenders.length === 0);

	const restored = await rollback(h.agentDir);
	expect("rollback restores the live file", restored.ok && (await readFile(join(h.agentDir, "models.yml"), "utf8")) === liveText, restored);

	const onlyDead = ["providers:", "  deepseek:", "    compat:", `      ${dead}: true`, ""].join("\n");
	expect("emptied block becomes an empty mapping, not null", /compat: \{\}/.test(removeDeadKeys(onlyDead, scanText(onlyDead))));

	// Two identical block headers: only the block that owns the key may be emptied.
	const twins = [
		"a:",
		"  compat:",
		"    stripImageInput: false",
		"b:",
		"  compat:",
		`    ${dead}: true`,
		"",
	].join("\n");
	const twinned = removeDeadKeys(twins, scanText(twins));
	expect(
		"only the owning block is emptied",
		twinned === ["a:", "  compat:", "    stripImageInput: false", "b:", "  compat: {}", ""].join("\n"),
		twinned,
	);
}

// ---------------------------------------------------------------- command surface
{
	const h = await makeHarness();
	await h.fire("before_agent_start", { systemPrompt: ["you are omp"] });
	const command = h.command();

	await command.handler("status", h.ctx);
	expect("status subcommand notifies", /DS cache/.test(h.notices.at(-1) ?? ""), h.notices.at(-1));

	await command.handler("", h.ctx);
	const report = h.messages.at(-1)?.content ?? "";
	expect("report rendered", report.includes("### DeepSeek prefix cache"), report.slice(0, 80));
	expect("report has a breakdown section", report.includes("#### Breakdown"));
	expect("report lists miss causes", report.includes("Misses by attributed cause"));
	expect("report includes fingerprints", report.includes("Tool catalogue:"));
	expect("report names the effective configuration", report.includes("- Config:"), report.slice(-400));

	await command.handler("config", h.ctx);
	const configReport = h.messages.at(-1)?.content ?? "";
	expect("config subcommand reports settings", configReport.includes("### Effective configuration") && configReport.includes("statusRow"), configReport.slice(0, 120));
	expect("config report documents the reset", configReport.includes("/mega config reset"), configReport.slice(-400));

	await command.handler("config bogus", h.ctx);
	expect("an unknown config option is refused", /Unknown `config` option/.test(h.notices.at(-1) ?? ""), h.notices.at(-1));

	// Reset from inside the session: one key, then everything, then the env caveat.
	const resetHarness = await makeHarness({
		settings: { "@dillydalli3r/omp-token-mega": { statusRow: false, "cache.idleTtlMinutes": 30 } },
		env: { OMP_TOKEN_MEGA_STATUS_MAX_CHARS: "77" },
	});
	const lockPath = join(resetHarness.base, "plugins", "omp-plugins.lock.json");
	await resetHarness.command().handler("config reset statusRow", resetHarness.ctx);
	expect("reset reports the key it cleared", /Reset `statusRow` to defaults/.test(resetHarness.notices.at(-1) ?? ""), resetHarness.notices.at(-1));
	expect("only the named key was cleared", (await readJson(lockPath)).settings["@dillydalli3r/omp-token-mega"]["cache.idleTtlMinutes"] === 30, await readJson(lockPath));

	await withEnv(resetHarness.env ?? {}, () => resetHarness.command().handler("config reset", resetHarness.ctx));
	expect("reset clears the rest", ((await readJson(lockPath)).settings ?? {})["@dillydalli3r/omp-token-mega"] === undefined, await readJson(lockPath));
	expect(
		"an env override surviving the reset is called out",
		/Still overridden by `OMP_TOKEN_MEGA_STATUS_MAX_CHARS`/.test(resetHarness.notices.at(-1) ?? ""),
		resetHarness.notices.at(-1),
	);

	await withEnv(resetHarness.env ?? {}, () => resetHarness.command().handler("config reset", resetHarness.ctx));
	expect("a second reset says there is nothing to do", /Nothing to reset/.test(resetHarness.notices.at(-1) ?? ""), resetHarness.notices.at(-1));

	await resetHarness.command().handler("config reset nope", resetHarness.ctx);
	expect("an unknown setting name is refused", /Usage: `\/mega config reset/.test(resetHarness.notices.at(-1) ?? ""), resetHarness.notices.at(-1));

	const dead = Object.keys(DEAD_KEYS)[0];
	await writeFile(join(h.agentDir, "models.yml"), ["providers:", "  deepseek:", "    compat:", `      ${dead}: true`, ""].join("\n"), "utf8");
	await command.handler("cache doctor", h.ctx);
	expect("doctor command reports the offender", (h.messages.at(-1)?.content ?? "").includes(dead));

	await command.handler("cache fix", h.ctx);
	expect("fix reports a repair", /Repaired \d+ file/.test(h.notices.at(-1) ?? ""), h.notices.at(-1));
	expect("fix removed the key", !(await readFile(join(h.agentDir, "models.yml"), "utf8")).includes(dead));

	await command.handler("cache rollback", h.ctx);
	expect("rollback reports a restore", /^Restored:/.test(h.notices.at(-1) ?? ""), h.notices.at(-1));

	await command.handler("reset", h.ctx);
	expect("reset notifies", /reset/i.test(h.notices.at(-1) ?? ""), h.notices.at(-1));
	// Every report goes into the transcript as agent text: marking extension output as user
	// input invites the model to act on a report as though the user had asked for it.
	expect(
		"every report is attributed to the agent",
		h.messages.length >= 3 && h.messages.every((message) => message.attribution === "agent"),
		h.messages.map((message) => message.customType),
	);
}

console.log(fail.length ? `\n${fail.length} FAILED` : "\nall checks passed");
process.exit(fail.length ? 1 : 0);
