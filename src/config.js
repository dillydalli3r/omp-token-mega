/**
 * Configuration.
 *
 * Every knob of the merged plugin is declared once, in `CONFIG_SCHEMA`, and resolved
 * from five sources — highest wins:
 *
 *   1. environment variable        (per-process override; also what `-e` dev runs use)
 *   2. project override file       `<cwd>/.omp/plugin-overrides.json` → `settings[<package>]`
 *   3. global plugin setting       `<pluginsDir>/omp-plugins.lock.json` → `settings[<package>]`
 *   4. preset bundle               one of `PRESETS`, selected by the `token.preset` key itself
 *   5. built-in default
 *
 * Layers 2 and 3 are the maps `omp plugin config set <package> <key> <value>` writes, so
 * the plugin honours the settings omp believes it has. The plugin cannot import omp's own
 * resolver (`getPluginSettings` lives on an unexported internal path) and deliberately has
 * no runtime dependencies, so it reads those two documented JSON files itself: the
 * lockfile the plugin manager maintains and the project override file it merges on top.
 * Layer 1 is read straight from `process.env`, which is what the matching `env` entry in
 * the manifest schema advertises to `omp plugin config list`.
 *
 * Keys are grouped with a dotted prefix — `token.*` for the tool-result reducer, `cache.*`
 * for the prefix-cache accounting of any provider that reports cached input, `balance.*`
 * for the account poller — and the unprefixed keys configure the shell itself (the master
 * switch, the single status row, the shard directory). Verified against omp 18.2.6: `omp
 * plugin config set` stores a dotted key verbatim, so a group prefix is a naming
 * convention and never a nested path.
 *
 * The preset layer is what makes the extremes reachable in one command. `/mega preset max`
 * (or `token.preset` in any other layer) selects a coherent bundle of the `token.*` keys;
 * any key set at a higher layer still wins, so a preset is a starting point, never a lock.
 * `configDefaults()` and the `balanced` preset agree, so the default configuration is the
 * one the report describes.
 *
 * An unreadable or malformed layer is reported, never fatal: a broken override file must
 * not take a session down, and a value that fails validation is ignored — the next layer,
 * or the default, supplies the value, and the `config` command prints what was rejected.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { LITHOS_BASE_URL } from "./lithosai.js";

/** Tools whose output is verbose, rarely edited and safe to reduce. */
const NOISY_TOOLS = "bash,grep,glob,web_search,eval,mcp__*";

/** The groups a status-row segment can come from, in the default display order. */
export const STATUS_SEGMENTS = ["cache", "window", "balance", "token"];

export const CONFIG_SCHEMA = {
	enabled: {
		type: "boolean",
		default: true,
		env: "OMP_TOKEN_MEGA_ENABLED",
		description: "Master switch. false makes the whole plugin inert: no hooks, no counters, no shards, no network call, no status row.",
	},
	statusRow: {
		type: "boolean",
		default: true,
		env: "OMP_TOKEN_MEGA_STATUS_ROW",
		description: "Draw the status row. Every metric this plugin tracks goes on that one line; turn it off to keep the numbers on demand only.",
	},
	statusMaxChars: {
		type: "number",
		default: 120,
		min: 40,
		max: 400,
		env: "OMP_TOKEN_MEGA_STATUS_MAX_CHARS",
		description: "Maximum width of the status row. A segment that does not fit is dropped whole, never half-written.",
	},
	statusSegments: {
		type: "string",
		default: "cache,window,balance,token",
		env: "OMP_TOKEN_MEGA_STATUS_SEGMENTS",
		description: `Which groups the row shows, in order: ${STATUS_SEGMENTS.join(", ")}. Unknown names are ignored; an empty list hides the row.`,
	},
	stateDir: {
		type: "string",
		default: "",
		env: "OMP_TOKEN_MEGA_DIR",
		description: "Directory holding the cache-accounting shards. Empty uses <agentDir>/omp-token-mega-stats.d.",
	},

	"token.enabled": {
		type: "boolean",
		default: true,
		env: "OMP_TOKEN_MEGA_TOKEN_ENABLED",
		description: "Reduce tool results before they are first sent. Independent of the cache accounting and the balance poller.",
	},
	"token.preset": {
		type: "enum",
		values: ["off", "conservative", "balanced", "aggressive", "max"],
		default: "balanced",
		env: "OMP_TOKEN_MEGA_TOKEN_PRESET",
		description: "Named bundle of every other token.* knob, covering the extremes. Individual settings override it.",
	},
	"token.tools": {
		type: "string",
		default: NOISY_TOOLS,
		env: "OMP_TOKEN_MEGA_TOKEN_TOOLS",
		description:
			"Comma-separated tool names to reduce. `*` means every tool, `prefix*` matches a name prefix (`mcp__*` = all MCP tools), `-name` excludes.",
	},
	"token.minChars": {
		type: "number",
		default: 2000,
		min: 0,
		max: 1000000,
		env: "OMP_TOKEN_MEGA_TOKEN_MIN_CHARS",
		description: "Results below this size are left untouched: a marker is not worth a rewrite.",
	},
	"token.maxScanBytes": {
		type: "number",
		default: 262144,
		min: 4096,
		max: 16777216,
		env: "OMP_TOKEN_MEGA_TOKEN_MAX_SCAN_BYTES",
		description:
			"Hard ceiling on the text this plugin will scan. Larger results go straight to omp's own artifact spill. Bounds worst-case hook time.",
	},
	"token.squeeze": {
		type: "boolean",
		default: true,
		env: "OMP_TOKEN_MEGA_TOKEN_SQUEEZE",
		description: "Strip terminal escapes, control characters and trailing whitespace; collapse blank-line runs.",
	},
	"token.fold": {
		type: "boolean",
		default: true,
		env: "OMP_TOKEN_MEGA_TOKEN_FOLD",
		description: "Collapse runs of identical consecutive lines into one line plus a count.",
	},
	"token.foldMinRun": {
		type: "number",
		default: 4,
		min: 2,
		max: 100,
		env: "OMP_TOKEN_MEGA_TOKEN_FOLD_MIN_RUN",
		description: "Shortest run of identical lines worth folding.",
	},
	"token.clip": {
		type: "number",
		default: 768,
		min: 0,
		max: 100000,
		env: "OMP_TOKEN_MEGA_TOKEN_CLIP",
		description:
			"Per-line column cap for tools omp does not already cap. 0 disables. omp's own tools.outputMaxColumns default is 768.",
	},
	"token.json": {
		type: "boolean",
		default: true,
		env: "OMP_TOKEN_MEGA_TOKEN_JSON",
		description:
			"Remove whitespace outside JSON string literals from payloads that parse as JSON. A string-aware strip, never a parse-and-reserialize, so numeric literals are preserved.",
	},
	"token.dedupe": {
		type: "boolean",
		default: true,
		env: "OMP_TOKEN_MEGA_TOKEN_DEDUPE",
		description: "Replace a result whose content is byte-identical to an earlier one in this session with a back-reference.",
	},
	"token.dedupeMinChars": {
		type: "number",
		default: 512,
		min: 64,
		max: 1000000,
		env: "OMP_TOKEN_MEGA_TOKEN_DEDUPE_MIN_CHARS",
		description: "Shortest result eligible for duplicate collapsing.",
	},
	"token.maxChars": {
		type: "number",
		default: 0,
		min: 0,
		max: 1000000,
		env: "OMP_TOKEN_MEGA_TOKEN_MAX_CHARS",
		description:
			"Per-result budget. Above it the middle is elided behind an artifact:// handle. 0 defers to omp's tools.artifactSpillThreshold (50 KB).",
	},
	"token.headChars": {
		type: "number",
		default: 6000,
		min: 0,
		max: 500000,
		env: "OMP_TOKEN_MEGA_TOKEN_HEAD_CHARS",
		description: "Bytes kept from the start when a result is elided to its budget.",
	},
	"token.tailChars": {
		type: "number",
		default: 6000,
		min: 0,
		max: 500000,
		env: "OMP_TOKEN_MEGA_TOKEN_TAIL_CHARS",
		description: "Bytes kept from the end when a result is elided to its budget.",
	},
	"token.stash": {
		type: "boolean",
		default: true,
		env: "OMP_TOKEN_MEGA_TOKEN_STASH",
		description: "Write removed text to a session artifact so artifact://<id> recovers it. The store omp's own spill uses.",
	},
	"token.minSavingsTokens": {
		type: "number",
		default: 24,
		min: 0,
		max: 100000,
		env: "OMP_TOKEN_MEGA_TOKEN_MIN_SAVINGS_TOKENS",
		description: "A rewrite must save this much on top of the marker it adds, or the original is sent untouched.",
	},
	"token.perf": {
		type: "boolean",
		default: true,
		env: "OMP_TOKEN_MEGA_TOKEN_PERF",
		description: "Time the tool-result hook and report p50/max in the report, so the throughput cost is visible.",
	},

	"cache.enabled": {
		type: "boolean",
		default: true,
		env: "OMP_TOKEN_MEGA_CACHE_ENABLED",
		description:
			"Measure the prefix cache: accounting, miss attribution, drift notes. Active while the live model is cache capable — its provider is one that reports cached input, or its own card prices cached reads.",
	},
	"cache.minPrefixTokens": {
		type: "number",
		default: 1024,
		min: 0,
		max: 1000000,
		env: "OMP_TOKEN_MEGA_CACHE_MIN_PREFIX_TOKENS",
		description:
			"Prefixes shorter than this are below most providers' minimum cacheable unit, so a miss on one is labelled `prefix_too_small` instead of being chased — there is no client-side change that turns such a request into a hit. Gemini's implicit cache floor is 1024 tokens on the 2.5+ tiers, which is the default. 0 disables the label.",
	},
	"cache.appendOnly": {
		type: "boolean",
		default: true,
		env: "OMP_TOKEN_MEGA_CACHE_APPEND_ONLY",
		description:
			"Report whether omp's append-only context mode is on for the live provider, where it is not, and what it costs to leave it off. `/mega tune` is the one place that writes it — as a session override, never to your config, unless you ask for that — and `/mega tune revert` takes it back.",
	},
	"cache.subagents": {
		type: "boolean",
		default: true,
		env: "OMP_TOKEN_MEGA_CACHE_SUBAGENTS",
		description: "Aggregate the shards this process's subagent sessions write.",
	},
	"cache.idleTtlMinutes": {
		type: "number",
		default: 5,
		min: 1,
		max: 1440,
		env: "OMP_TOKEN_MEGA_CACHE_IDLE_TTL_MINUTES",
		description: "Idle gap after which a miss is attributed to the provider cache expiring (`idle_ttl`).",
	},
	"cache.retentionDays": {
		type: "number",
		default: 7,
		min: 0,
		max: 365,
		env: "OMP_TOKEN_MEGA_CACHE_RETENTION_DAYS",
		description: "Delete shards not written for this many days. 0 keeps them forever.",
	},

	"lithos.enabled": {
		type: "boolean",
		default: true,
		env: "OMP_TOKEN_MEGA_LITHOS_ENABLED",
		description:
			"Register the LithosAI provider (models, /login, usage reporting) and measure its speed and per-minute budgets for the report. Requires a restart to take effect when switched off.",
	},
	"lithos.baseUrl": {
		type: "string",
		default: LITHOS_BASE_URL,
		env: "OMP_TOKEN_MEGA_LITHOS_BASE_URL",
		description: "LithosAI endpoint. Point it at a self-hosted Lithos Engine to use the same provider, login and metrics on-prem.",
	},
	"lithos.inputPerMillion": {
		type: "number",
		default: 0,
		min: 0,
		max: 100000,
		env: "OMP_TOKEN_MEGA_LITHOS_INPUT_PER_MILLION",
		description: "USD per million input tokens. 0 uses the rate LithosAI publishes for the model; set it to override the published card (a console figure, an on-prem engine, a volume deal).",
	},
	"lithos.outputPerMillion": {
		type: "number",
		default: 0,
		min: 0,
		max: 100000,
		env: "OMP_TOKEN_MEGA_LITHOS_OUTPUT_PER_MILLION",
		description: "USD per million output tokens. 0 uses the published rate. Cached input is a subset of input, not an addition to it.",
	},
	"lithos.cachedPerMillion": {
		type: "number",
		default: 0,
		min: 0,
		max: 100000,
		env: "OMP_TOKEN_MEGA_LITHOS_CACHED_PER_MILLION",
		description: "USD per million cached input tokens. 0 uses the published rate.",
	},

	"balance.enabled": {
		type: "boolean",
		default: true,
		env: "OMP_TOKEN_MEGA_BALANCE_ENABLED",
		description:
			"Poll the account balance for the status row where one is published (DeepSeek's is; LithosAI publishes none, so its section reports the credit state the wire shows instead). Off means no balance request is ever made; session cost is unaffected.",
	},
	"balance.ttlSeconds": {
		type: "number",
		default: 60,
		min: 15,
		max: 3600,
		env: "OMP_TOKEN_MEGA_BALANCE_TTL_SECONDS",
		description: "How long a fetched balance is reused before the poller refreshes it.",
	},

	"window.enabled": {
		type: "boolean",
		default: true,
		env: "OMP_TOKEN_MEGA_WINDOW_ENABLED",
		description:
			"Poll the provider's quota windows and show the headroom left in them, in the row and in the report. Today that is OpenCode Go's 5-hour, weekly and monthly windows (`GET /v1/usage`), the figures that decide whether a session can still bill. Off means no request is ever made.",
	},
	"window.warnAt": {
		type: "number",
		default: 80,
		min: 50,
		max: 99,
		env: "OMP_TOKEN_MEGA_WINDOW_WARN_AT",
		description:
			"Percent of a quota window at which the row turns yellow and the report starts advising a slower pace. Reaching 100%, or the provider answering `rate-limited`, turns it red: the session is about to stop, not slow down.",
	},
};

export const CONFIG_KEYS = Object.keys(CONFIG_SCHEMA);

/** Keys whose group a menu groups them under; the shell's own keys have no prefix. */
export const KEY_GROUPS = [
	{ id: "general", label: "Shell", prefix: "", keys: CONFIG_KEYS.filter((key) => !key.includes(".")) },
	{ id: "token", label: "Token saving", prefix: "token.", keys: CONFIG_KEYS.filter((key) => key.startsWith("token.")) },
	{ id: "cache", label: "Cache accounting", prefix: "cache.", keys: CONFIG_KEYS.filter((key) => key.startsWith("cache.")) },
	{ id: "lithos", label: "LithosAI", prefix: "lithos.", keys: CONFIG_KEYS.filter((key) => key.startsWith("lithos.")) },
	{ id: "balance", label: "Balance", prefix: "balance.", keys: CONFIG_KEYS.filter((key) => key.startsWith("balance.")) },
	{ id: "window", label: "Usage windows", prefix: "window.", keys: CONFIG_KEYS.filter((key) => key.startsWith("window.")) },
];

export const PRESET_NAMES = CONFIG_SCHEMA["token.preset"].values;

/**
 * The extremes, and the two sensible stops between them.
 *
 * `off` is for a user who wants the plugin installed but silent. `conservative` only
 * removes bytes no reader needs and never touches content identity. `balanced` is the
 * default. `aggressive` adds a per-result budget below omp's own 50 KB spill threshold.
 * `max` additionally reaches every tool — including `read`, whose hashline anchors the
 * elision can invalidate, which is why no other preset goes there.
 */
export const PRESETS = {
	off: { "token.enabled": false },
	conservative: {
		"token.tools": "bash,grep,glob",
		"token.squeeze": true,
		"token.fold": true,
		"token.foldMinRun": 6,
		"token.clip": 0,
		"token.json": false,
		"token.dedupe": false,
		"token.minChars": 4000,
		"token.maxChars": 0,
		"token.minSavingsTokens": 32,
	},
	balanced: {
		"token.tools": NOISY_TOOLS,
		"token.squeeze": true,
		"token.fold": true,
		"token.foldMinRun": 4,
		"token.clip": 768,
		"token.json": true,
		"token.dedupe": true,
		"token.dedupeMinChars": 512,
		"token.minChars": 2000,
		"token.maxChars": 0,
		"token.minSavingsTokens": 24,
	},
	aggressive: {
		"token.tools": `${NOISY_TOOLS},task`,
		"token.squeeze": true,
		"token.fold": true,
		"token.foldMinRun": 3,
		"token.clip": 512,
		"token.json": true,
		"token.dedupe": true,
		"token.dedupeMinChars": 256,
		"token.minChars": 1000,
		"token.maxChars": 24000,
		"token.headChars": 5000,
		"token.tailChars": 4000,
		"token.minSavingsTokens": 16,
	},
	max: {
		"token.tools": "*",
		"token.squeeze": true,
		"token.fold": true,
		"token.foldMinRun": 2,
		"token.clip": 256,
		"token.json": true,
		"token.dedupe": true,
		"token.dedupeMinChars": 128,
		"token.minChars": 512,
		"token.maxChars": 12000,
		"token.headChars": 3000,
		"token.tailChars": 2000,
		"token.minSavingsTokens": 16,
	},
};

/** Package name used as the settings key; `package.json` wins when it is readable. */
let settingsKeyCache;

export async function settingsKey() {
	if (settingsKeyCache === undefined) {
		try {
			const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
			settingsKeyCache = typeof pkg?.name === "string" && pkg.name ? pkg.name : "@dillydalli3r/omp-token-mega";
		} catch {
			settingsKeyCache = "@dillydalli3r/omp-token-mega";
		}
	}
	return settingsKeyCache;
}

export function configDefaults() {
	const values = {};
	for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) values[key] = schema.default;
	return values;
}

/** What a preset resolves to before any explicit setting overrides it. */
export function presetValues(name) {
	const values = configDefaults();
	const bundle = PRESETS[name];
	if (bundle) Object.assign(values, bundle);
	return values;
}

/** The synchronous shape returned before the first load lands, and when it fails. */
export function defaultConfig() {
	return {
		name: "@dillydalli3r/omp-token-mega",
		keys: CONFIG_KEYS,
		values: configDefaults(),
		sources: {},
		problems: [],
		files: {},
		preset: CONFIG_SCHEMA["token.preset"].default,
	};
}

/**
 * Agent directory (the omp state root).
 *
 * Session directories are not at a fixed depth: a main session is `<agentDir>/sessions/<slug>`,
 * while a subagent's rebound session is `<agentDir>/sessions/<slug>/<sessionFile>`. So instead
 * of counting `dirname` hops, walk up to the `sessions` segment and take its parent — correct
 * for both layouts, and still correct under `--profile`.
 */
export function resolveAgentDir(ctx) {
	const override = process.env.PI_CODING_AGENT_DIR;
	if (override) return override;

	let dir;
	try {
		dir = ctx?.sessionManager?.getSessionDir?.();
	} catch {
		dir = undefined;
	}
	if (!dir) return undefined;

	let current = String(dir);
	for (let hops = 0; hops < 8; hops += 1) {
		if (basename(current) === "sessions") return dirname(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	// Unrecognized layout: fall back to the documented two-level shape rather than
	// reading settings from somewhere arbitrary.
	return dirname(dirname(String(dir)));
}

/** The shape `loadConfig` returns when resolution itself failed: defaults, no layers. */
export async function fallbackConfig() {
	return { ...defaultConfig(), name: await settingsKey() };
}

/** `{ ok: true, value }` or `{ ok: false, error }`. Never throws. */
export function coerceValue(schema, raw) {
	switch (schema.type) {
		case "boolean": {
			if (typeof raw === "boolean") return { ok: true, value: raw };
			if (typeof raw === "string") {
				const text = raw.trim().toLowerCase();
				if (["true", "yes", "on", "1"].includes(text)) return { ok: true, value: true };
				if (["false", "no", "off", "0"].includes(text)) return { ok: true, value: false };
			}
			return { ok: false, error: "expected a boolean" };
		}
		case "number": {
			const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
			if (!Number.isFinite(value)) return { ok: false, error: "expected a number" };
			if (schema.min !== undefined && value < schema.min) return { ok: false, error: `must be >= ${schema.min}` };
			if (schema.max !== undefined && value > schema.max) return { ok: false, error: `must be <= ${schema.max}` };
			return { ok: true, value };
		}
		case "enum": {
			if (typeof raw !== "string") return { ok: false, error: "expected a string" };
			const text = raw.trim().toLowerCase();
			if (!schema.values.includes(text)) return { ok: false, error: `expected one of ${schema.values.join(", ")}` };
			return { ok: true, value: text };
		}
		default:
			if (typeof raw !== "string") return { ok: false, error: "expected a string" };
			return { ok: true, value: raw.trim() };
	}
}

async function readJson(path) {
	if (!path) return { ok: false, missing: true };
	try {
		return { ok: true, data: JSON.parse(await readFile(path, "utf8")) };
	} catch (error) {
		return { ok: false, missing: error?.code === "ENOENT", error: String(error?.message ?? error) };
	}
}

function settingsFrom(data, name) {
	const settings = data?.settings?.[name];
	return settings && typeof settings === "object" && !Array.isArray(settings) ? settings : undefined;
}

/**
 * `<pluginsDir>/omp-plugins.lock.json` — the plugin manager's runtime state.
 *
 * omp derives the plugins directory from its config root, which the plugin can only see
 * indirectly, so two candidates are produced: the sibling of the agent directory (correct
 * for the default layout, `--profile`, and the XDG layout, where the session directory
 * itself sits beside `plugins/`), then the plain `~/.omp/plugins` omp uses when
 * `PI_CODING_AGENT_DIR` relocates the agent dir alone. The first candidate that actually
 * carries settings wins.
 */
export function pluginsLockfilePaths(agentDir, home) {
	const paths = [];
	if (agentDir) paths.push(join(dirname(agentDir), "plugins", "omp-plugins.lock.json"));
	if (home) paths.push(join(home, ".omp", "plugins", "omp-plugins.lock.json"));
	return [...new Set(paths)];
}

/** `<cwd>/.omp/plugin-overrides.json` — the project-scope override omp merges last. */
export function projectOverridesPath(cwd) {
	return cwd ? join(cwd, ".omp", "plugin-overrides.json") : undefined;
}

/**
 * Resolve the effective configuration.
 *
 * Returns `{ keys, values, sources, problems, name, files, preset }`; `sources[key]` is one
 * of `default` / `preset:<name>` / `global` / `project` / `env`, so the `config` command and
 * the menu can show where each value came from and whether a write will be shadowed.
 */
export async function loadConfig({ agentDir, cwd, home, env = process.env } = {}) {
	const name = await settingsKey();
	const problems = [];

	// Collect the settings maps first; the preset is itself a setting, so it has to be
	// resolved before any key can fall back to a preset bundle.
	const layers = [];
	let projectPath = projectOverridesPath(cwd);
	const projectResult = await readJson(projectPath);
	if (projectResult.ok) {
		const settings = settingsFrom(projectResult.data, name);
		if (settings) layers.push({ source: "project", settings });
	} else {
		if (!projectResult.missing) problems.push({ source: "project", error: `${projectPath}: ${projectResult.error}` });
		projectPath = undefined;
	}

	// The candidates are alternate locations of one logical lockfile. The first that
	// actually carries settings for this plugin wins; a lockfile without them (the plugin
	// installed under a different root) must not shadow the other candidate.
	const globalPaths = pluginsLockfilePaths(agentDir, home);
	let globalPath;
	let existingPath;
	let globalSettings;
	for (const path of globalPaths) {
		const result = await readJson(path);
		if (!result.ok) {
			if (!result.missing) problems.push({ source: "global", error: `${path}: ${result.error}` });
			continue;
		}
		existingPath ??= path;
		const settings = settingsFrom(result.data, name);
		if (!settings) continue;
		globalPath = path;
		globalSettings = settings;
		break;
	}
	if (globalSettings) layers.push({ source: "global", settings: globalSettings });

	const files = { global: globalPath ?? existingPath ?? globalPaths[0], project: projectPath };

	/** First layer (env, then project, then global) that carries a usable value for `key`. */
	function explicit(key) {
		const schema = CONFIG_SCHEMA[key];
		const candidates = [];
		const rawEnv = schema.env ? env?.[schema.env] : undefined;
		if (rawEnv !== undefined && rawEnv !== "") candidates.push({ source: "env", raw: rawEnv });
		for (const layer of layers) {
			const raw = layer.settings[key];
			if (raw !== undefined) candidates.push({ source: layer.source, raw });
		}
		for (const candidate of candidates) {
			const coerced = coerceValue(schema, candidate.raw);
			if (coerced.ok) return { value: coerced.value, source: candidate.source };
			problems.push({ key, source: candidate.source, value: candidate.raw, error: coerced.error });
		}
		return undefined;
	}

	const presetChoice = explicit("token.preset");
	const preset = presetChoice ? presetChoice.value : CONFIG_SCHEMA["token.preset"].default;
	const bundle = presetValues(preset);

	const values = {};
	const sources = {};
	for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
		if (key === "token.preset") {
			values[key] = preset;
			sources[key] = presetChoice ? presetChoice.source : "default";
			continue;
		}
		const chosen = explicit(key);
		if (chosen) {
			values[key] = chosen.value;
			sources[key] = chosen.source;
			continue;
		}
		const fromPreset = PRESETS[preset]?.[key];
		if (fromPreset !== undefined) {
			values[key] = bundle[key];
			sources[key] = `preset:${preset}`;
			continue;
		}
		values[key] = schema.default;
		sources[key] = "default";
	}

	return { name, keys: CONFIG_KEYS, values, sources, problems, files, preset };
}

/**
 * Drop this plugin's settings so the schema defaults apply again.
 *
 * The plugin manager holds the lockfile in memory per process and rewrites the whole
 * document on its next `omp plugin config` mutation, so this is deliberately the same
 * operation `omp plugin config delete` performs — minus that command's requirement to
 * name one key at a time, and minus its blind spot for the project override file.
 *
 * Only this plugin's own entry is touched: every other package's settings, and every
 * other key in the document, survive byte for byte because the file is re-serialized
 * with the same pretty-printing the manager writes. A file that cannot be parsed is
 * reported and left alone rather than overwritten.
 *
 * `key` limits the reset to one setting; `scope` to `"global"` or `"project"`. Returns
 * `{ name, cleared, skipped }` — `cleared` lists what was removed, `skipped` why a
 * target was left alone.
 */
export async function resetConfig({ agentDir, cwd, home, key, scope } = {}) {
	const name = await settingsKey();
	if (key !== undefined && !(key in CONFIG_SCHEMA)) {
		return { name, cleared: [], skipped: [{ scope: "config", reason: `unknown setting \`${key}\`` }] };
	}
	const cleared = [];
	const skipped = [];
	const targets = [];
	if (scope !== "project") {
		for (const path of pluginsLockfilePaths(agentDir, home)) targets.push({ scope: "global", path });
	}
	if (scope !== "global") {
		const path = projectOverridesPath(cwd);
		if (path) targets.push({ scope: "project", path });
	}

	for (const target of targets) {
		const result = await readJson(target.path);
		if (!result.ok) {
			if (!result.missing) skipped.push({ scope: target.scope, file: target.path, reason: `unreadable: ${result.error}` });
			continue;
		}
		const settings = settingsFrom(result.data, name);
		if (!settings) continue;
		const keys = Object.keys(settings).filter((candidate) => key === undefined || candidate === key);
		if (keys.length === 0) {
			skipped.push({
				scope: target.scope,
				file: target.path,
				reason: key === undefined ? "no settings stored here" : `\`${key}\` is not set here`,
			});
			continue;
		}
		for (const candidate of keys) delete settings[candidate];
		// Leave no empty containers behind: the plugin's map goes, and so does a `settings`
		// object that no longer holds anything.
		if (Object.keys(settings).length === 0) {
			delete result.data.settings[name];
			if (Object.keys(result.data.settings).length === 0) delete result.data.settings;
		}
		const error = await writeJson(target.path, result.data);
		if (error) skipped.push({ scope: target.scope, file: target.path, reason: error });
		else cleared.push({ scope: target.scope, file: target.path, keys });
	}
	return { name, cleared, skipped };
}

/** Atomic pretty-printed JSON write, matching the plugin manager's own formatting. */
async function writeJson(path, data) {
	try {
		const temp = `${path}.${process.pid}.tmp`;
		await writeFile(temp, JSON.stringify(data, null, 2), "utf8");
		await rename(temp, path);
		return undefined;
	} catch (error) {
		return `could not write: ${error?.message ?? error}`;
	}
}

/**
 * Tool selector. Entries are comma-separated:
 *
 *   `bash`        exact name
 *   `mcp__*`      name prefix (`mcp__` is how omp mints MCP tool names)
 *   `*`           everything
 *   `-read`       exclusion, by the same rules, never overridden by a positive
 *
 * A conjunction written without a comma expands (`*-read` is `*, -read`), because no tool
 * name contains `*` and leaving it literal would silently match nothing.
 *
 * An empty list of positives is not a veto: `-read` alone means "everything except read".
 */
export function toolSelected(spec, toolName) {
	if (typeof spec !== "string" || spec.trim() === "") return false;
	const positives = [];
	const negatives = [];
	for (const raw of spec.split(",")) {
		for (const part of expandWildcard(raw.trim())) {
			if (!part) continue;
			if (part.startsWith("-")) negatives.push(part.slice(1));
			else positives.push(part);
		}
	}
	const matches = (entry) => {
		if (entry === "*") return true;
		if (entry.endsWith("*")) return toolName.startsWith(entry.slice(0, -1));
		return entry === toolName;
	};
	if (negatives.some(matches)) return false;
	return positives.length === 0 ? true : positives.some(matches);
}

/** `*-read` -> ["*", "-read"]; anything else -> itself. */
function expandWildcard(entry) {
	return entry.startsWith("*-") ? ["*", entry.slice(1)] : [entry];
}

/** The subset of the configuration `compress.js` consumes. */
export function compressionConfig(values) {
	return {
		squeeze: values["token.squeeze"] === true,
		fold: values["token.fold"] === true,
		foldMinRun: values["token.foldMinRun"],
		clip: values["token.clip"],
		json: values["token.json"] === true,
	};
}

/** The status-row groups the user asked for, in their order; unknown names dropped. */
export function statusSegmentNames(values) {
	const spec = typeof values.statusSegments === "string" ? values.statusSegments : "";
	const names = [];
	for (const raw of spec.split(",")) {
		const name = raw.trim().toLowerCase();
		if (STATUS_SEGMENTS.includes(name) && !names.includes(name)) names.push(name);
	}
	return names;
}

/** Markdown block for `/mega config`: every key, grouped, with its source. */
export function formatConfig(config) {
	const lines = ["### Effective configuration", ""];
	const width = Math.max(...config.keys.map((key) => key.length));
	for (const group of KEY_GROUPS) {
		lines.push(`**${group.label}**`, "");
		for (const key of group.keys) {
			const schema = CONFIG_SCHEMA[key];
			const value = config.values[key];
			const shown = schema.type === "string" && value === "" ? '""' : String(value);
			lines.push(`- \`${key.padEnd(width)}\` = ${shown}  _(${config.sources[key]})_`);
			if (schema.description) lines.push(`  - ${schema.description}`);
		}
		lines.push("");
	}
	lines.push("### Where these come from", "");
	lines.push("- `default` — the schema default.");
	lines.push(`- \`preset:<name>\` — the \`token.preset\` bundle (currently \`${config.preset}\`); an explicit setting still wins.`);
	lines.push(`- \`global\` — \`${config.files.global ?? "(unresolved)"}\`, written by \`omp plugin config set ${config.name} <key> <value>\`.`);
	lines.push(`- \`project\` — \`${config.files.project ?? "(unresolved)"}\`, a \`settings.${config.name}\` entry, so one repository can differ.`);
	lines.push("- `env` — per-process override, listed as `env:` by `omp plugin config list`.");

	if (config.problems.length > 0) {
		lines.push("", "### Rejected values", "");
		for (const problem of config.problems) {
			const where = problem.key ? `\`${problem.key}\` from ${problem.source}` : problem.source;
			const value = problem.value === undefined ? "" : ` (${JSON.stringify(problem.value)})`;
			lines.push(`- ${where}${value}: ${problem.error} — ignored.`);
		}
	}
	lines.push("", "Reset stored settings with `/mega config reset` (everything, both scopes), `/mega config reset <key>`, or add `global` / `project` to touch one scope. Values are re-read by `/mega config`.");
	return lines.join("\n");
}

/** Markdown block for `/mega preset`. */
export function formatPresets(current) {
	const lines = [
		"### Presets",
		"",
		"| Preset | tools | minChars | fold | clip | json | dedupe | maxChars | minSavings |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	];
	for (const name of PRESET_NAMES) {
		const values = presetValues(name);
		const marks = name === current ? " **← active**" : "";
		lines.push(
			`| \`${name}\`${marks} | \`${values["token.tools"]}\` | ${values["token.minChars"]} | ${values["token.fold"] ? values["token.foldMinRun"] : "off"} | ${values["token.clip"] || "off"} | ${values["token.json"] ? "on" : "off"} | ${values["token.dedupe"] ? values["token.dedupeMinChars"] : "off"} | ${values["token.maxChars"] || "omp default"} | ${values["token.minSavingsTokens"]} |`,
		);
	}
	lines.push(
		"",
		"`off` installs the plugin silently, `conservative` is lossless-cleanup only, `balanced` is the default,",
		"`aggressive` adds a 24 KB per-result budget, `max` drops to 12 KB and reaches every tool — including",
		"`read`, whose hashline anchors a middle elision can invalidate. Switch with `/mega preset <name>`,",
		"which writes the same setting `omp plugin config set` does. Presets cover the `token.*` keys only;",
		"the cache and balance groups are independent.",
	);
	return lines.join("\n");
}
