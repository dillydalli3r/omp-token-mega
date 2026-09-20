/**
 * omp-token-mega — one plugin for the oh-my-pi token economy.
 *
 * Three features that used to be three plugins, sharing one configuration, one command
 * and **one status row**:
 *
 *   token    reduce a tool result before it is ever sent (any provider)
 *   cache    measure the DeepSeek prefix cache: hit rate, miss attribution, drift
 *   lithos   register LithosAI (models, /login), measure its speed and budgets
 *   balance  DeepSeek account balance and this session's USD spend
 *
 * The status row is the reason they were merged. omp renders one footer line per status
 * key (`status-line/component.ts`: `this.#sortedHookStatuses.map(text => lines.push(...))`),
 * so three plugins meant three rows of chrome for the rest of the session. This plugin
 * registers exactly one key and composes every metric into that line; segments that do not
 * fit the configured width are dropped whole.
 *
 *   /mega                  report: token saving, cache, balance — one document
 *   /mega status           the status row, as text
 *   /mega config           all thirty settings, their values and the layer that supplied each
 *   /mega config reset     drop stored settings so the defaults apply again
 *   /mega menu             interactive settings editor, grouped by feature
 *   /mega preset [name]    list or switch the token-saving preset bundle
 *   /mega audit            where this session's input tokens go, and which omp knobs to change
 *   /mega cache [doctor|fix|rollback]   cache section, or compat-key repair
 *   /mega lithos           LithosAI speed, per-minute budgets and spend
 *   /mega balance          account balance and the session spend table
 *   /mega reset            zero this session's counters
 *   tool `deepseek_balance`  the same figures for the model itself
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
import { composeStatus } from "./status.js";
import { megaReport } from "./report.js";
import { configMenu, menuFallback, writeSetting } from "./menu.js";
import { installToken } from "./token.js";
import { installCache } from "./cache.js";
import { installBalance } from "./balance.js";
import { installLithos } from "./lithosai.js";

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
	function statusText() {
		const segments = {
			cache: features.cache?.segment(),
			lithos: features.lithos?.segment(),
			balance: features.balance?.segment(),
			token: features.token?.segment(),
		};
		return composeStatus({
			names: statusSegmentNames(values()),
			segments,
			maxChars: values().statusMaxChars,
		});
	}

	/** Last text handed to the host, so an unchanged row is not repainted. */
	let lastRow;

	function render() {
		const ctx = state.ctx;
		if (!ctx?.hasUI) return;
		try {
			const show = enabled() && values().statusRow === true;
			const text = show ? statusText() : undefined;
			if (text === lastRow) return;
			lastRow = text;
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			// No status surface in this mode.
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

	pi.registerCommand("mega", {
		description: "Token Mega: savings report, cache accounting, balance, settings menu and audit",
		handler: async (args, ctx) => {
			state.ctx = ctx;
			const parts = String(args ?? "")
				.trim()
				.split(/\s+/)
				.filter(Boolean);
			const sub = parts[0] ?? "report";
			const rest = parts.slice(1).join(" ");

			if (sub === "status") {
				const line = enabled() && values().statusRow === true ? statusText() : undefined;
				ctx.ui.notify(line ?? (enabled() ? "No metrics yet." : "Token Mega is disabled (`enabled`)."), "info");
				return;
			}

			if (sub === "help") {
				say(
					[
						"### Token Mega",
						"",
						"- `/mega` — one report: token saving, prefix cache, account",
						"- `/mega status` — the one-line status row, as text",
						"- `/mega config` — all settings, their values and sources",
						"- `/mega config reset [key] [global|project]` — drop stored settings",
						"- `/mega menu` — interactive settings editor",
						`- \`/mega preset [${PRESET_NAMES.join("|")}]\` — show or switch the token-saving bundle`,
						"- `/mega audit` — request-envelope token audit and omp knob advice",
						"- `/mega cache [doctor|fix|rollback]` — cache section, or compat-key repair",
						"- `/mega lithos` — LithosAI: speed, per-minute budgets, session spend",
						"- `/mega balance` — DeepSeek account balance and the session spend table",
						"- `/mega reset` — zero this session's counters",
					].join("\n"),
				);
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
				// Re-read before printing: settings are otherwise read once per session.
				say(formatConfig(await reload(ctx)));
				render();
				return;
			}

			if (sub === "menu") {
				const applied = await reload(ctx);
				if (!ctx.hasUI) {
					say(menuFallback(applied));
					return;
				}
				try {
					await configMenu({ pi, ctx, reload: () => reload(ctx) });
				} catch (error) {
					// A dialog host that cannot answer must not leave the command hanging with
					// nothing said: name the failure and point at the non-interactive surface.
					ctx.ui.notify(`Menu failed: ${error?.message ?? error}. Use /mega config for the values.`, "error");
				}
				render();
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
				const written = await writeSetting(pi, config().name, "token.preset", rest);
				const applied = await reload(ctx);
				const shadowed = applied.sources["token.preset"] !== "global" || applied.values["token.preset"] !== rest;
				ctx.ui.notify(
					written.ok
						? `Preset '${rest}' selected${shadowed ? ` — but '${applied.values["token.preset"]}' from ${applied.sources["token.preset"]} wins` : ""} (${Object.keys(presetValues(rest)).length} keys).`
						: `Could not write the setting${written.because ? ` (${written.because})` : ""}. Run: ${written.hint}`,
					written.ok ? "info" : "error",
				);
				render();
				return;
			}

			if (sub === "audit") {
				await reload(ctx);
				try {
					say(await features.token.audit(ctx));
				} catch (error) {
					// The audit is a diagnostic; it must report its own failure rather than
					// take down the session or fail silently in a mode with fewer surfaces.
					ctx.ui.notify(`Audit failed: ${error?.message ?? error}`, "error");
				}
				return;
			}

			if (sub === "cache") {
				const action = parts[1] ?? "report";
				if (action === "doctor") {
					say(await features.cache.doctor(ctx));
					return;
				}
				if (action === "fix") {
					const outcome = await features.cache.repair(ctx);
					ctx.ui.notify(outcome.message, outcome.level);
					return;
				}
				if (action === "rollback") {
					const outcome = await features.cache.undo(ctx);
					ctx.ui.notify(outcome.message, outcome.level);
					return;
				}
				if (action !== "report") {
					ctx.ui.notify("Usage: `/mega cache [report|doctor|fix|rollback]`.", "error");
					return;
				}
				say(await features.cache.section(ctx));
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
				features.token.reset();
				features.lithos.reset();
				features.balance.reset();
				await features.cache.reset(ctx);
				render();
				ctx.ui.notify("Counters reset for this session.", "info");
				return;
			}

			say(await fullReport(ctx));
		},
	});
}
