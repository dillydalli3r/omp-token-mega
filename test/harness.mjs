/**
 * The fake extension host the suites drive.
 *
 * Every suite runs the *merged* plugin, so the host has to model what the merge relies on:
 * several handlers per event (the shell reloads configuration and three features each
 * subscribe to their own slice of the lifecycle), one command, one tool, and a status
 * surface that records every write — including the key it was written under, because
 * "one row" is a property of the plugin (one status key), not of the renderer.
 *
 * End-to-end suites pin *every* plugin setting through its environment variable, which is
 * the highest-precedence layer, so a run cannot be perturbed by a global plugin config or
 * a project override that happens to exist on the machine running the tests. The state
 * directory is pinned to a temp path for the same reason: a test must not write shards
 * into the checkout.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG_SCHEMA, settingsKey } from "../src/config.js";
import tokenMega from "../src/index.js";

export const STATUS_KEY = "omp-token-mega";

/** A DeepSeek model with the declared tariff the cache accounting prices against. */
export const DEEPSEEK_MODEL = {
	provider: "deepseek",
	id: "deepseek-flash",
	baseUrl: "https://api.deepseek.com",
	cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
};

/** The same model with DeepSeek's declared peak schedule: 01:00–04:00 and 06:00–10:00 UTC, Mon–Fri. */
export const SCHEDULED_MODEL = {
	...DEEPSEEK_MODEL,
	cost: {
		...DEEPSEEK_MODEL.cost,
		timeBased: {
			offPeakMultiplier: 0.5,
			peakWindows: [
				{ weekdays: [1, 2, 3, 4, 5], startMinute: 60, endMinute: 240 },
				{ weekdays: [1, 2, 3, 4, 5], startMinute: 360, endMinute: 600 },
			],
		},
	},
};

export const ENV_KEYS = Object.values(CONFIG_SCHEMA)
	.map((schema) => schema.env)
	.filter(Boolean);

export async function withEnv(vars, fn) {
	const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
	for (const key of ENV_KEYS) delete process.env[key];
	for (const [key, value] of Object.entries(vars ?? {})) process.env[key] = value === undefined ? "" : String(value);
	try {
		return await fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/** Pin every setting through its env var; `stateDir` defaults to a temp dir per call. */
export function pinConfig(overrides = {}) {
	const saved = new Map();
	for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
		if (!schema.env) continue;
		saved.set(schema.env, process.env[schema.env]);
		const value = key in overrides ? overrides[key] : schema.default;
		process.env[schema.env] = String(value);
	}
	return () => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

/** Run `fn` with every setting pinned; a temp `stateDir` keeps shards out of the checkout. */
export async function withConfig(overrides, fn) {
	const root = await mkdtemp(join(tmpdir(), "token-mega-state-"));
	const restore = pinConfig({ stateDir: root, ...overrides });
	try {
		return await fn({ stateDir: root });
	} finally {
		restore();
		await rm(root, { recursive: true, force: true });
	}
}

let hostSeq = 0;

/**
 * Build a host, install the plugin into it, and start the session.
 *
 * `root` (optional) is a directory to lay out like a real install: an agent dir with a
 * session directory, and the plugins root beside it holding the lockfile that carries
 * `settings`. Without it, configuration comes from the pinned environment alone.
 */
export async function makeHost({
	model = DEEPSEEK_MODEL,
	artifacts = true,
	hasUI = true,
	answers = {},
	root,
	settings,
	overrides,
	sessionDirOverride,
	cwd,
	agentDirOverride,
	modelRegistry = {},
} = {}) {
	hostSeq += 1;
	let activeModel = model;
	let base = root;
	if (base && (settings || overrides)) {
		await mkdir(join(base, "plugins"), { recursive: true });
		await writeFile(
			join(base, "plugins", "omp-plugins.lock.json"),
			JSON.stringify({ plugins: {}, settings: settings ?? {} }),
			"utf8",
		);
		if (overrides) {
			await mkdir(join(base, ".omp"), { recursive: true });
			await writeFile(join(base, ".omp", "plugin-overrides.json"), JSON.stringify({ settings: overrides }), "utf8");
		}
	}
	const agentDir = agentDirOverride ?? (base ? join(base, "agent") : undefined);
	const sessionDir = sessionDirOverride ?? (agentDir ? join(agentDir, "sessions", "--w--") : join(tmpdir(), "token-mega-sessions"));
	if (agentDir) await mkdir(sessionDir, { recursive: true });
	const stateDir = agentDir ? join(agentDir, "omp-token-mega-stats.d") : undefined;
	const shardsDir = stateDir ? join(stateDir, "shards") : undefined;
	if (shardsDir) await mkdir(shardsDir, { recursive: true });

	const handlers = new Map();
	const saved = [];
	const commands = new Map();
	const tools = new Map();
	const providers = new Map();
	const execs = [];
	const statuses = new Map();
	const statusWrites = [];
	const notifications = [];
	const messages = [];
	const timers = new Map();

	const ctx = {
		hasUI,
		cwd: cwd ?? (base ?? process.cwd()),
		ui: {
			notify(text, level) {
				notifications.push({ text, level });
			},
			setStatus(key, value) {
				statuses.set(key, value);
				statusWrites.push({ key, value });
			},
			async select(title, options) {
				return scripted("select", title, options);
			},
			async input(title) {
				return scripted("input", title);
			},
			async confirm(title) {
				return scripted("confirm", title) === true || scripted("confirm", title) === "true";
			},
		},
		models: { current: () => activeModel },
		model: activeModel,
		modelRegistry,
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionDir: () => sessionDir,
			getBranch: () => [],
			saveArtifact: async (text, toolType) => {
				if (!artifacts) throw new Error("no artifact directory");
				saved.push({ text, toolType });
				return String(saved.length - 1);
			},
		},
		getContextUsage: () => ({ tokens: 1000, contextWindow: 128_000, percent: 0.8 }),
		getSystemPrompt: () => ["## Role", "be helpful"],
		setTimeout(fn, ms) {
			const id = timers.size + 1;
			timers.set(id, { fn, ms });
			return id;
		},
		clearTimer(timer) {
			timers.delete(timer);
		},
	};

	function scripted(kind, title, options) {
		const queue = answers[kind];
		if (!Array.isArray(queue) || queue.length === 0) return undefined;
		const entry = queue.shift();
		if (typeof entry !== "function") return entry;
		// A function sees the options the dialog was built from, so a script can pick the
		// label the plugin actually offered instead of guessing at its wording.
		const labels = Array.isArray(options) ? options.map((option) => (typeof option === "string" ? option : option?.label)) : [];
		return entry(title, labels);
	}
	/** Let the test answer a dialog interactively (the menu loop needs a live queue). */
	ctx.ui.enqueue = (kind, ...values) => {
		answers[kind] = [...(answers[kind] ?? []), ...values];
	};

	const pi = {
		zod: {
			object: () => ({}),
			string: () => ({}),
		},
		setLabel() {},
		registerProvider(name, config, sourceId) {
			providers.set(name, { config, sourceId });
		},
		unregisterProvider(name) {
			providers.delete(name);
		},
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		registerTool(definition) {
			tools.set(definition.name, definition);
		},
		getAllTools: () => [{ name: "bash", description: "run", parameters: { type: "object" } }],
		getActiveTools: () => ["bash"],
		sendMessage(message) {
			messages.push(message);
		},
		exec: async (command, args) => {
			execs.push({ command, args });
			return { code: 0, stdout: "", stderr: "" };
		},
	};

	await tokenMega(pi);

	const emit = async (event, payload, context = ctx) => {
		const results = [];
		for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, context));
		return results.filter((result) => result !== undefined);
	};

	const host = {
		pi,
		ctx,
		saved,
		commands,
		tools,
		providers,
		execs,
		statuses,
		statusWrites,
		notifications,
		messages,
		timers,
		handlers,
		agentDir,
		sessionDir,
		stateDir,
		shardsDir,
		events: handlers,
		emit,
		fire: (name, event) => emit(name, event),
		async start() {
			await emit("session_start", { type: "session_start" });
		},
		async shutdown() {
			await emit("session_shutdown", { type: "session_shutdown" });
		},
		setModel(next) {
			activeModel = next;
			ctx.model = next;
		},
		/** Fire every pending managed timer (the balance poller schedules one). */
		async fireTimers() {
			const pending = [...timers.entries()];
			for (const [id, timer] of pending) {
				timers.delete(id);
				await timer.fn();
			}
			await tick();
		},
		get row() {
			return statuses.get(STATUS_KEY);
		},
		/** Every status key written, deduplicated — one key is the "one row" contract. */
		get statusKeys() {
			return [...new Set(statusWrites.map((write) => write.key))];
		},
		get rendered() {
			return messages.map((message) => String(message.content)).join("\n");
		},
		get notified() {
			return notifications.map((entry) => entry.text).join("\n");
		},
		request: (payloadMessages, tools) => emit("before_provider_request", { payload: { model: activeModel?.id, messages: payloadMessages, tools } }),
		response: (usage) => emit("message_end", { message: { role: "assistant", usage } }),
		toolResult: (text, overrides = {}) =>
			emit("tool_result", {
				toolCallId: "1",
				toolName: "bash",
				input: {},
				content: [{ type: "text", text }],
				details: {},
				isError: false,
				...overrides,
			}),
		async shardFiles() {
			return shardsDir && existsSync(shardsDir) ? await readdir(shardsDir) : [];
		},
		async generatedSettingsKey() {
			return await settingsKey();
		},
	};
	return host;
}

/** Wait for pending microtasks/timers the plugin's async handlers may have queued. */
export const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A tiny assertion harness: every check prints, and the run fails if any did not hold. */
export function checks() {
	const fail = [];
	let passed = 0;
	const expect = (label, condition, extra) => {
		if (condition) passed += 1;
		else fail.push(label);
		console.log(`${condition ? "PASS" : "FAIL"}  ${label}${condition || extra === undefined ? "" : `  -> ${JSON.stringify(extra)}`}`);
	};
	const done = () => {
		if (fail.length > 0) {
			console.error(`\n${fail.length} failing:\n`);
			for (const label of fail) console.error(`  x ${label}`);
			console.error(`\n${passed} passed, ${fail.length} failed`);
			process.exit(1);
		}
		console.log(`all ${passed} checks passed`);
	};
	return { expect, done };
}
