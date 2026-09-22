/**
 * omp-token-mega — one plugin for the oh-my-pi token economy.
 *
 * Three features that used to be three plugins, sharing one configuration, one command
 * and **one status row**:
 *
 *   token    reduce a tool result before it is ever sent (any provider)
 *   cache    measure the prefix cache — hit rate, miss attribution, drift — on every model
 *            whose provider reports cached input tokens and declares a cache-read rate
 *   lithos   register LithosAI (models, /login), measure its speed and budgets
 *   balance  the account behind the model, and this session's USD cost
 *
 * The status row is the reason they were merged: one line, one key, every metric a part of
 * it — three plugins used to mean three rows of chrome for the rest of the session. The row
 * is published as a widget the plugin draws itself (`ctx.ui.setWidget`, `placement:
 * "belowEditor"`) instead of as a status entry, because omp strips ANSI from hook status
 * text and would flatten the peak/off-peak tint (see ./status.js); segments that do not fit
 * the configured width are dropped whole.
 *
 *   /mega                  the menu: report, status, settings, preset, audit, cache, balance
 *   /mega report           one document: token saving, cache, LithosAI, balance
 *   /mega status           the status row, as text
 *   /mega config           all settings, their values and the layer that supplied each
 *   /mega config reset     drop stored settings so the defaults apply again
 *   /mega menu             the menu spelled out (a bare /mega opens it too)
 *   /mega preset [name]    list or switch the token-saving preset bundle
 *   /mega audit            where this session's input tokens go, and which omp knobs to change
 *   /mega cache [report|doctor|fix|rollback|stability]
 *                          cache section, compat-key repair, append-only context stability
 *   /mega lithos           LithosAI catalogue, speed, per-minute budgets and cost
 *   /mega balance          the account behind the model and the session cost table
 *   /mega reset            zero this session's counters
 *   tool `account_balance` the same figures for the model itself
 *
 * The menu and the subcommands are the same code: each entry calls the action the
 * subcommand calls, so nothing is reachable one way but not the other.
 *
 * Settings come from `omp plugin config` (global, plus `.omp/plugin-overrides.json` per
 * project), a preset bundle and environment fallbacks; see ./config.js.
 */

import { homedir } from "node:os";
import {
	CONFIG_SCHEMA,
	defaultConfig,
	formatConfig,
	formatPresets,
	loadConfig,
	PRESET_NAMES,
	presetValues,
	resetConfig,
	resolveAgentDir,
	statusSegmentNames,
} from "./config.js";
import { composeRow, renderRow, themeTint } from "./status.js";
import { megaReport } from "./report.js";
import { megaHub, menuFallback, settingsMenu, writeSetting } from "./menu.js";
import { installToken } from "./token.js";
import { installCache } from "./cache.js";
import { installBalance } from "./balance.js";
import { installLithos } from "./lithosai.js";
import { advisoryRows, apply as applyTune, formatPlan, formatReceipt, plan as planTune, revert as revertTune, subagentAdvice } from "./tune.js";

const STATUS_KEY = "omp-token-mega";
const CUSTOM_TYPE = "omp-token-mega";

export default function tokenMega(pi) {
	const state = {
		ctx: undefined,
		config: undefined,
	};

	pi.setLabel("Token Mega");

	/** Effective settings; the schema defaults until the first load lands. */
	const config = () => state.config ?? defaultConfig();
	const values = () => config().values;
	/** Master switch: everything off means no hooks, no counters, no row. */
	const enabled = () => values().enabled === true;

	async function reload(ctx) {
		try {
			state.config = await loadConfig({
				agentDir: resolveAgentDir(ctx ?? state.ctx),
				cwd: (ctx ?? state.ctx)?.cwd,
				home: homedir(),
			});
		} catch {
			// Unreadable configuration must not take a session down: defaults apply.
			state.config = undefined;
		}
		return config();
	}

	function modelKey(ctx) {
		try {
			const model = ctx?.models?.current?.() ?? ctx?.model;
			return model ? `${model.provider ?? "?"}/${model.id ?? "?"}` : undefined;
		} catch {
			return undefined;
		}
	}

	function sessionId(ctx) {
		try {
			return ctx?.sessionManager?.getSessionId?.();
		} catch {
			return undefined;
		}
	}

	/** The one row: every feature's segment, in the configured order. */
	function row() {
		const segments = {
			cache: features.cache?.segment(),
			window: features.balance?.windowSegment(),
			balance: features.balance?.segment(),
			token: features.token?.segment(),
		};
		return composeRow({
			names: statusSegmentNames(values()),
			segments,
			maxChars: values().statusMaxChars,
		});
	}

	/** Last text handed to the host, so an unchanged row is not republished. */
	let lastRow;

	function render() {
		const ctx = state.ctx;
		if (!ctx?.hasUI) return;
		try {
			const show = enabled() && values().statusRow === true;
			const rows = show ? row() : undefined;
			// Deduplicated on the plain text: tint and clipping are derived from these same
			// rows, so a row that reads the same is never republished to the host.
			const text = renderRow(rows);
			if (text === lastRow) return;
			lastRow = text;
			// The row is bounded by the narrower of the terminal and `statusMaxChars`: the
			// budget chooses which segments fit, and a first segment wider than the budget
			// still has to be clipped when the component draws it.
			const cap = Number.isFinite(values().statusMaxChars) && values().statusMaxChars > 0 ? values().statusMaxChars : Number.POSITIVE_INFINITY;
			ctx.ui.setWidget(
				STATUS_KEY,
				rows === undefined
					? undefined
					: (_tui, theme) => ({
							render: (width) => {
								const line = renderRow(rows, { width: Math.min(width, cap), tint: themeTint(theme) });
								return line === undefined ? [] : [line];
							},
							invalidate() {},
						}),
				{ placement: "belowEditor" },
			);
		} catch {
			// A host with no widget surface (RPC, ACP, headless) must not fail the turn.
		}
	}

	function say(markdown, attribution = "agent") {
		try {
			// `attribution: "agent"` because this text is extension output: marking it as user
			// input invites the model to treat a report as an instruction from the user.
			pi.sendMessage({ customType: CUSTOM_TYPE, content: markdown, display: true, attribution }, { triggerTurn: false });
		} catch {
			// A rendering surface that cannot accept a custom message must not fail the command.
		}
	}

	/** What the features get: shared config, the one renderer, and the message surface. */
	const shell = { pi, state, config, values, enabled, reload, render, say, modelKey, sessionId };

	/**
	 * Session lifecycle first, before any feature subscribes to the same events: every
	 * feature reads `shell.values()`, so the configuration has to be resolved before the
	 * feature handlers for an event run. Registration order is dispatch order.
	 */
	pi.on("session_start", async (_event, ctx) => {
		state.ctx = ctx;
		await reload(ctx);
		render();
	});

	pi.on("session_switch", async (_event, ctx) => {
		state.ctx = ctx;
		await reload(ctx);
		render();
	});

	// The row is refreshed after every turn, tool result and assistant message. That is what
	// makes a `/model` switch visible: the features that gate on the live model re-evaluate
	// on the next event, and `render()` skips the host call when nothing changed.
	for (const event of ["turn_end", "tool_result", "message_end"]) {
		pi.on(event, async (_event, ctx) => {
			state.ctx = ctx;
			render();
		});
	}

	/** Populated by the installers below; `render` reads it lazily, so order is free. */
	const features = {};
	features.token = installToken(pi, shell);
	features.cache = installCache(pi, shell);
	features.lithos = installLithos(pi, shell);
	features.balance = installBalance(pi, shell);

	pi.on("session_shutdown", async () => {
		state.ctx = undefined;
	});

	/**
	 * `/mega config reset [key] [global|project]`
	 *
	 * Removes this plugin's stored settings so the schema defaults apply again. Anything
	 * an environment variable still pins is reported, because resetting files cannot
	 * change it.
	 */
	async function resetConfiguration(ctx, tokens) {
		const scopes = tokens.filter((token) => token === "global" || token === "project");
		const names = tokens.filter((token) => token !== "global" && token !== "project");
		if (names.length > 1 || scopes.length > 1 || (names[0] !== undefined && !(names[0] in config().values))) {
			ctx.ui.notify(
				`Usage: \`/mega config reset [key] [global|project]\` — keys: ${config().keys.join(", ")}.`,
				"error",
			);
			return;
		}

		const result = await resetConfig({
			agentDir: resolveAgentDir(ctx),
			cwd: ctx?.cwd,
			home: homedir(),
			key: names[0],
			scope: scopes[0],
		});
		const applied = await reload(ctx);
		render();

		const what = names[0] ? `\`${names[0]}\`` : "all settings";
		if (result.cleared.length === 0) {
			const why = result.skipped.map((entry) => entry.reason).join("; ") || "nothing was stored";
			ctx.ui.notify(`Nothing to reset: ${what} — ${why}.`, "info");
			return;
		}
		const files = result.cleared
			.map((entry) => `${entry.scope} (${entry.keys.length} key${entry.keys.length === 1 ? "" : "s"})`)
			.join(", ");
		// A reset only clears stored layers; an env var keeps overriding the default, so
		// name the variable the user has to unset rather than the key they already know.
		const stillEnv = (names[0] ? [names[0]] : applied.keys).filter((key) => applied.sources[key] === "env");
		const suffix = stillEnv.length
			? ` Still overridden by ${stillEnv.map((key) => `\`${CONFIG_SCHEMA[key]?.env ?? key}\``).join(", ")}.`
			: "";
		const failures = result.skipped.filter(
			(entry) => entry.reason.startsWith("unreadable") || entry.reason.startsWith("could not write"),
		);
		const failureNote = failures.length
			? ` Skipped ${failures.map((entry) => `${entry.file}: ${entry.reason}`).join("; ")}.`
			: "";
		ctx.ui.notify(`Reset ${what} to defaults in ${files}.${suffix}${failureNote}`, "info");
	}

	async function fullReport(ctx) {
		const sections = {
			token: features.token.section(ctx),
			cache: await features.cache.section(ctx),
			tune: tuneSection(ctx),
			lithos: features.lithos.section(ctx),
			balance: await features.balance.section(ctx),
		};
		return megaReport({
			model: modelKey(ctx),
			sessionId: sessionId(ctx),
			preset: config().preset,
			sections,
		});
	}

	/**
	 * One action per thing the command can do, each the single implementation of it: the
	 * subcommands and the menu both call these, so an action cannot mean two things
	 * depending on how it was reached.
	 */
	function showStatus(ctx) {
		const rows = enabled() && values().statusRow === true ? row() : undefined;
		const line = renderRow(rows, { width: values().statusMaxChars });
		ctx.ui.notify(line ?? (enabled() ? "No metrics yet." : "Token Mega is disabled (`enabled`)."), "info");
	}

	async function showConfig(ctx) {
		// Re-read before printing: settings are otherwise read once per session.
		say(formatConfig(await reload(ctx)));
		render();
	}

	async function showAudit(ctx) {
		await reload(ctx);
		try {
			say(await features.token.audit(ctx));
		} catch (error) {
			// The audit is a diagnostic; it must report its own failure rather than take down
			// the session or fail silently in a mode with fewer surfaces.
			ctx.ui.notify(`Audit failed: ${error?.message ?? error}`, "error");
		}
	}

	async function showCache(ctx, action = "report") {
		if (action === "report") {
			say(await features.cache.section(ctx));
			return;
		}
		if (action === "doctor") {
			say(await features.cache.doctor(ctx));
			return;
		}
		if (action === "stability") {
			say(await features.cache.stability(ctx));
			return;
		}
		if (action === "fix" || action === "rollback") {
			const outcome = action === "fix" ? await features.cache.repair(ctx) : await features.cache.undo(ctx);
			ctx.ui.notify(outcome.message, outcome.level);
			return;
		}
		ctx.ui.notify("Usage: `/mega cache [report|doctor|fix|rollback|stability]`.", "error");
	}

	/** Apply a preset through omp's CLI, then report which layer actually supplies it. */
	async function applyPreset(ctx, name) {
		const written = await writeSetting(pi, config().name, "token.preset", name);
		const applied = await reload(ctx);
		const shadowed = applied.sources["token.preset"] !== "global" || applied.values["token.preset"] !== name;
		ctx.ui.notify(
			written.ok
				? `Preset '${name}' selected${shadowed ? ` — but '${applied.values["token.preset"]}' from ${applied.sources["token.preset"]} wins` : ""} (${Object.keys(presetValues(name)).length} keys).`
				: `Could not write the setting${written.because ? ` (${written.because})` : ""}. Run: ${written.hint}`,
			written.ok ? "info" : "error",
		);
		render();
	}

	/**
	 * omp's live `Settings` singleton, reached through the package namespace the host injects
	 * as `pi.pi`. This is the only handle a plugin has on core settings — there is no
	 * extension-facing API for them — so it is feature-detected, and its absence (an older
	 * host, a test host) turns the tuning feature into advice rather than an error.
	 */
	function coreSettings() {
		const settings = pi.pi?.settings;
		return settings && typeof settings.get === "function" && typeof settings.override === "function" ? settings : undefined;
	}

	/** The live model, without the `provider/id` formatting `modelKey` does. */
	function liveModel(ctx) {
		try {
			return ctx?.models?.current?.() ?? ctx?.model;
		} catch {
			return undefined;
		}
	}

	/**
	 * Every model this session can call — the same set `--model` picks from. Used for one
	 * question only: is there a cheaper sibling on the live provider to delegate to.
	 */
	function availableModels(ctx) {
		try {
			return ctx?.models?.list?.() ?? [];
		} catch {
			return [];
		}
	}

	/**
	 * The live model role, which omp writes as `provider/model:effort`. The effort suffix is
	 * the only place a session-wide thinking level is pinned, so it is read (never written)
	 * by the advice side of the tuner.
	 */
	function roleSelector() {
		try {
			const roles = coreSettings()?.getModelRoles?.() ?? coreSettings()?.get?.("modelRoles");
			return typeof roles?.default === "string" ? roles.default : undefined;
		} catch {
			return undefined;
		}
	}

	/** Last tuning write, so `/mega tune revert` can undo exactly it. Session-scoped, like the writes. */
	const tuneState = { receipt: undefined };

	function tunePlan(ctx, { force = false } = {}) {
		return planTune({ model: liveModel(ctx), settings: coreSettings(), receipt: tuneState.receipt, force });
	}

	/**
	 * The tuning section: the knobs this model wants changed, what is advice rather than a
	 * change, and what this session already applied. `undefined` when there is nothing to say,
	 * so a session that is already tuned does not carry a table in every report.
	 */
	function tuneSection(ctx) {
		const result = tunePlan(ctx);
		const advice = coreSettings() ? advisoryRows({ model: liveModel(ctx), settings: coreSettings(), roleSelector: roleSelector() }) : [];
		const subagent = subagentAdvice({ model: liveModel(ctx), models: availableModels(ctx), settings: coreSettings() });
		if (!result && advice.length === 0 && !subagent) {
			return coreSettings()
				? undefined
				: "### Tuning\n\n- Core settings are not reachable from this host (`pi.pi.settings` is unavailable), so nothing can be read or written here. Apply the advice below with `omp config set`.";
		}
		const lines = ["### Tuning", ""];
		if (result) lines.push(formatPlan(result));
		else lines.push("- No core settings handle: every recommendation below is advice to apply by hand.");
		if (tuneState.receipt) lines.push("", `- Applied this session: ${formatReceipt(tuneState.receipt)}`);
		if (advice.length > 0 || subagent) {
			lines.push("", "#### Yours to change", "");
			for (const row of advice) {
				lines.push(`- \`${row.key}\` at \`${row.current ?? "unset"}\` — \`${row.command}\``);
				lines.push(`  - ${row.why}`);
			}
			if (subagent) {
				lines.push(`- \`${subagent.key}\` — \`${subagent.command}\``);
				lines.push(`  - ${subagent.why}`);
			}
		}
		if (result && result.status.change > 0) {
			lines.push("", "- Apply for this session: `/mega tune apply` (runtime overrides, undone by `/mega tune revert`). Write them to your config: `/mega tune save`.");
		}
		return lines.join("\n");
	}

	/** Write the recommendation, either as session overrides or into the user's config. */
	async function applyTuning(ctx, { persist = false, force = false } = {}) {
		const result = tunePlan(ctx, { force });
		if (!result) {
			ctx.ui.notify("Core settings are not reachable from this host; nothing can be written.", "error");
			return;
		}
		if (result.changes.length === 0) {
			ctx.ui.notify(
				result.status.pinned > 0
					? `Nothing to apply: ${result.status.pinned} knob(s) are yours (\`/mega tune\` lists them with the command to change them).`
					: "Nothing to apply: this model is already tuned.",
				"info",
			);
			return;
		}
		const receipt = applyTune(coreSettings(), result.changes, { persist });
		tuneState.receipt = receipt;
		ctx.ui.notify(`${formatReceipt(receipt)}${persist ? "" : " — session only; `/mega tune save` writes them to config."}`, "info");
		await reload(ctx);
		render();
	}

	async function revertTuning(ctx) {
		if (!tuneState.receipt) {
			ctx.ui.notify("Nothing to revert: no tuning was applied this session.", "info");
			return;
		}
		const outcome = revertTune(coreSettings(), tuneState.receipt);
		tuneState.receipt = undefined;
		ctx.ui.notify(
			`Reverted ${outcome.clearedOverride.length + outcome.restored.length} setting(s)${outcome.restored.length ? ` (${outcome.restored.join(", ")} written back)` : ""}.`,
			"info",
		);
		await reload(ctx);
		render();
	}

	async function showTune(ctx, action) {
		if (action === undefined || action === "plan") {
			say(tuneSection(ctx) ?? "### Tuning\n\n- This model is already tuned, and no knob is waiting on you.");
			return;
		}
		if (action === "apply") {
			await applyTuning(ctx);
			return;
		}
		if (action === "save") {
			await applyTuning(ctx, { persist: true });
			return;
		}
		if (action === "revert") {
			await revertTuning(ctx);
			return;
		}
		if (action === "force") {
			await applyTuning(ctx, { force: true });
			return;
		}
		ctx.ui.notify("Usage: `/mega tune [apply|save|revert|force]`.", "error");
	}

	async function pickTune(ctx) {
		const choice = await ctx.ui.select("Tuning — the cost and time profile for this model", [
			"Show — the plan, and what is yours to change",
			"Apply — for this session (runtime overrides)",
			"Save — write them to your config",
			"Revert — undo what this session applied",
			"Force — re-offer knobs your own config pins",
			"Back",
		]);
		const action = { Show: "plan", Apply: "apply", Save: "save", Revert: "revert", Force: "force" }[String(choice).split(" ")[0]];
		if (!action) return;
		await showTune(ctx, action);
	}

	async function resetCounters(ctx) {
		features.token.reset();
		features.lithos.reset();
		features.balance.reset();
		await features.cache.reset(ctx);
		render();
		ctx.ui.notify("Counters reset for this session.", "info");
	}

	/** The cache actions the menu offers, label and subcommand paired. */
	const CACHE_ACTIONS = [
		["report", "Report — the cache section"],
		["doctor", "Doctor — scan the model config for inert compat keys"],
		["fix", "Repair — remove the inert keys (writes a backup first)"],
		["rollback", "Rollback — undo the last repair"],
		["stability", "Prefix stability — is omp's append-only context mode on?"],
	];

	/**
	 * The hub. Every subcommand appears here, so the menu is a complete interface rather
	 * than a shortcut to four of them, and the labels carry the live value where one exists
	 * (the preset, the balance) so the menu itself answers the common question.
	 */
	function hubActions(ctx) {
		return [
			{ label: "Report — token saving, cache, LithosAI, balance", run: async () => say(await fullReport(ctx)) },
			{ label: "Status row — as text", run: () => showStatus(ctx) },
			{ label: "Settings — pick a group and edit", run: () => settingsMenu({ pi, ctx, reload: () => reload(ctx) }) },
			{ label: `Token preset — currently ${config().preset}`, run: () => pickPreset(ctx) },
			{ label: "Settings as text — every key, value and source", run: () => showConfig(ctx) },
			{ label: "Token audit — request envelope and omp knobs", run: () => showAudit(ctx) },
			{ label: "Tune — the cost and time profile for this model", run: () => pickTune(ctx) },
			{ label: "Cache — report, doctor, repair, rollback", run: () => pickCache(ctx) },
			{ label: "LithosAI — models, speed, budgets, cost", run: () => say(features.lithos.section(ctx)) },
			{ label: "Account — balance, quota windows, session spend", run: async () => say(await features.balance.section(ctx)) },
			{ label: "Reset counters — zero this session", run: () => resetCounters(ctx) },
		];
	}

	async function pickPreset(ctx) {
		await reload(ctx);
		const choice = await ctx.ui.select(`Token preset — currently ${config().preset}`, [...PRESET_NAMES, "Back"]);
		if (!choice || choice === "Back") return;
		await applyPreset(ctx, choice);
	}

	async function pickCache(ctx) {
		const labels = CACHE_ACTIONS.map(([, label]) => label);
		const choice = await ctx.ui.select("Cache — pick an action", [...labels, "Back"]);
		if (!choice || choice === "Back") return;
		const picked = CACHE_ACTIONS[labels.indexOf(choice)];
		if (picked) await showCache(ctx, picked[0]);
	}

	/** The hub, with a dialog host that cannot answer turned into a message rather than a hang. */
	async function openHub(ctx) {
		try {
			await megaHub({ ctx, actions: hubActions(ctx) });
		} catch (error) {
			ctx.ui.notify(`Menu failed: ${error?.message ?? error}. Use /mega help for the subcommands.`, "error");
		}
		render();
	}

	const HELP = [
		"### Token Mega",
		"",
		"- `/mega` — the menu: report, settings, preset, audit, cache, balance",
		"- `/mega report` — one document: token saving, prefix cache, LithosAI, account",
		"- `/mega status` — the one-line status row, as text",
		"- `/mega config` — all settings, their values and sources",
		"- `/mega config reset [key] [global|project]` — drop stored settings",
		"- `/mega menu` — the menu, spelled out",
		`- \`/mega preset [${PRESET_NAMES.join("|")}]\` — show or switch the token-saving bundle`,
		"- `/mega audit` — request-envelope token audit and omp knob advice",
		"- `/mega tune [apply|save|revert]` — the cost and time profile for this model: what to change, applied for the session or written to config",
		"- `/mega cache [report|doctor|fix|rollback|stability]` — cache section, compat keys, append-only",
		"- `/mega lithos` — LithosAI: catalogue, speed, per-minute budgets, session cost",
		"- `/mega balance` — the account behind the model: balance, quota windows, session cost table",
		"- `/mega reset` — zero this session's counters",
	].join("\n");

	pi.registerCommand("mega", {
		description: "Token Mega: the menu, the savings report, cache accounting, balance and audit",
		handler: async (args, ctx) => {
			state.ctx = ctx;
			const parts = String(args ?? "")
				.trim()
				.split(/\s+/)
				.filter(Boolean);
			const sub = parts[0];
			const rest = parts.slice(1).join(" ");

			// Bare `/mega` is the menu: one keystroke, every action. A host with no dialogs
			// cannot be asked anything, so it gets the report the menu's first entry shows.
			if (sub === undefined) {
				if (!ctx.hasUI) {
					say(await fullReport(ctx));
					return;
				}
				await openHub(ctx);
				return;
			}

			if (sub === "help") {
				say(HELP);
				return;
			}

			if (sub === "report") {
				say(await fullReport(ctx));
				return;
			}

			if (sub === "status") {
				showStatus(ctx);
				return;
			}

			if (sub === "config") {
				if (parts[1] === "reset") {
					await reload(ctx);
					await resetConfiguration(ctx, parts.slice(2));
					return;
				}
				if (parts[1] !== undefined) {
					ctx.ui.notify(
						`Unknown \`config\` option \`${parts[1]}\`. Use \`/mega config\`, or \`/mega config reset [key] [global|project]\`.`,
						"error",
					);
					return;
				}
				await showConfig(ctx);
				return;
			}

			if (sub === "menu") {
				if (!ctx.hasUI) {
					say(menuFallback(await reload(ctx)));
					return;
				}
				await openHub(ctx);
				return;
			}

			if (sub === "preset") {
				if (!rest) {
					await reload(ctx);
					say(formatPresets(config().preset));
					return;
				}
				if (!PRESET_NAMES.includes(rest)) {
					ctx.ui.notify(`Unknown preset '${rest}'. One of: ${PRESET_NAMES.join(", ")}.`, "error");
					return;
				}
				await applyPreset(ctx, rest);
				return;
			}

			if (sub === "audit") {
				await showAudit(ctx);
				return;
			}

			if (sub === "tune") {
				await showTune(ctx, parts[1]);
				return;
			}

			if (sub === "cache") {
				await showCache(ctx, parts[1] ?? "report");
				return;
			}

			if (sub === "lithos") {
				say(features.lithos.section(ctx));
				return;
			}

			if (sub === "balance") {
				say(await features.balance.section(ctx));
				return;
			}

			if (sub === "reset") {
				await resetCounters(ctx);
				return;
			}

			say(await fullReport(ctx));
		},
	});
}
