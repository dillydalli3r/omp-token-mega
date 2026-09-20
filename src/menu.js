/**
 * The configuration menu for every feature in this plugin.
 *
 * `omp plugin config set` requires knowing the key names, and this plugin has thirty of
 * them, so `/mega menu` groups them by feature and edits one at a time. Writes go through
 * omp's own CLI rather than editing the plugin lockfile behind omp's back, so the file it
 * lands in is the file `omp plugin config list` reads, and a shadowed write (an env var,
 * a project override or a preset outranks it) is reported instead of silently doing
 * nothing.
 *
 * Interactive mode only; print, RPC and ACP get the same content as text
 * (`menuFallback`), because a dialog host that cannot answer must not leave the command
 * hanging with nothing said.
 */

import { homedir } from "node:os";
import { CONFIG_SCHEMA, KEY_GROUPS, formatConfig, formatPresets, resetConfig, resolveAgentDir } from "./config.js";

/**
 * Write one setting through omp's CLI, so omp's file stays authoritative.
 *
 * Bounded on purpose: the child is a full `omp` process, and a command that waits on one
 * forever is worse than one that reports what to run by hand. A non-zero exit (the plugin
 * not being installed is the common one) and a timeout both land on the same hint.
 */
export async function writeSetting(pi, name, key, value) {
	const args =
		value === undefined ? ["plugin", "config", "delete", name, key] : ["plugin", "config", "set", name, key, String(value)];
	try {
		const result = await pi.exec("omp", args, { timeout: 15_000 });
		if (result?.code === 0) return { ok: true };
		if (result?.stderr || result?.stdout) {
			const first = String(result.stderr || result.stdout).trim().split("\n")[0];
			if (first) return { ok: false, hint: `omp ${args.join(" ")}`, because: first };
		}
	} catch {
		// Timed out, not installed, or no executable: the hint below is the answer either way.
	}
	return { ok: false, hint: `omp ${args.join(" ")}` };
}

function shown(schema, value) {
	return schema.type === "string" && value === "" ? '""' : String(value);
}

/**
 * Edit one key: booleans and enums get a selector, everything else a text prompt.
 * Returns `{ changed }` so the caller knows whether to re-read the configuration.
 */
async function editKey({ pi, ctx, config, key }) {
	const schema = CONFIG_SCHEMA[key];
	const current = config.values[key];
	let next;
	if (schema.type === "boolean") {
		next = await ctx.ui.select(`${key} — currently ${current}`, ["true", "false", "(clear)"]);
	} else if (schema.type === "enum") {
		next = await ctx.ui.select(`${key} — currently ${current}`, [...schema.values, "(clear)"]);
	} else {
		next = await ctx.ui.input(
			`${key} (${schema.type}${schema.min !== undefined ? `, ${schema.min}..${schema.max}` : ""}) — currently ${current}`,
			"empty clears the setting",
		);
		if (next === undefined) return { changed: false };
		next = next.trim() === "" ? "(clear)" : next.trim();
	}
	if (next === undefined) return { changed: false };

	const cleared = next === "(clear)";
	const written = await writeSetting(pi, config.name, key, cleared ? undefined : next);
	if (!written.ok) {
		ctx.ui.notify(
			`Write failed${written.because ? ` (${written.because})` : ""}. Run it yourself: ${written.hint}`,
			"error",
		);
		return { changed: false };
	}
	return { changed: true, cleared, value: next };
}

/**
 * The settings submenu: pick a group, then a key inside it, and edit in place.
 *
 * The group list carries how many keys are set, so a non-default layer is visible before
 * opening a group. `Done` returns to the hub, which is why this is a submenu rather than the
 * whole command.
 */
export async function settingsMenu({ pi, ctx, reload }) {
	for (;;) {
		let config = await reload();
		const groupOptions = KEY_GROUPS.map((group) => {
			const changed = group.keys.filter((key) => config.sources[key] !== "default").length;
			return `${group.label} — ${group.keys.length} setting(s)${changed > 0 ? `, ${changed} set` : ""}`;
		});
		const options = [...groupOptions, "Reset stored settings…", "Back"];
		const choice = await ctx.ui.select("Token Mega settings — pick a group", options);
		if (!choice || choice === "Back") return;

		if (choice === "Reset stored settings…") {
			const confirmed = await ctx.ui.confirm(
				"Reset stored settings",
				"Remove every stored setting for this plugin from the global lockfile and the project override file? Environment variables are not touched.",
			);
			if (!confirmed) continue;
			const result = await resetConfig({ agentDir: resolveAgentDir(ctx), cwd: ctx.cwd, home: homedir() });
			config = await reload();
			ctx.ui.notify(
				result.cleared.length === 0
					? "Nothing to reset: no settings were stored."
					: `Reset ${result.cleared.map((entry) => `${entry.scope} (${entry.keys.length} key(s))`).join(", ")}.`,
				"info",
			);
			continue;
		}

		const group = KEY_GROUPS[groupOptions.indexOf(choice)];
		if (!group) continue;

		for (;;) {
			config = await reload();
			const keys = group.keys.filter((key) => key in CONFIG_SCHEMA);
			const keyOptions = keys.map((key) => `${key} = ${shown(CONFIG_SCHEMA[key], config.values[key])}   [${config.sources[key]}]`);
			keyOptions.push("Back");
			const picked = await ctx.ui.select(`${group.label} — pick a setting`, keyOptions);
			if (!picked || picked === "Back") break;
			const key = keys[keyOptions.indexOf(picked)];
			if (!key) continue;

			const outcome = await editKey({ pi, ctx, config, key });
			if (!outcome.changed) continue;
			config = await reload();
			const source = outcome.cleared ? "(cleared)" : config.sources[key];
			const shadowed = !outcome.cleared && source !== "global" && source !== "project";
			ctx.ui.notify(
				`${key} = ${shown(CONFIG_SCHEMA[key], config.values[key])} [${source}]${shadowed ? " — note: a higher layer (env or preset) supplies this value" : ""}`,
				"info",
			);
		}
	}
}

/**
 * `/mega` — the one menu.
 *
 * Every entry the command had as a subcommand is an action here, so the settings are
 * editable and the reports readable without remembering a syntax; the subcommands keep
 * working for scripting and for hosts without dialogs. An action that has more than a
 * handful of outcomes (settings, preset, cache) opens its own submenu, and everything
 * returns here rather than exiting, because a menu that closes after one edit makes the
 * second edit a re-type.
 */
export async function megaHub({ ctx, actions }) {
	for (;;) {
		const labels = actions.map((action) => action.label);
		const choice = await ctx.ui.select("Token Mega — pick an action", [...labels, "Done"]);
		if (!choice || choice === "Done") return;
		const action = actions[labels.indexOf(choice)];
		if (!action) continue;
		await action.run();
	}
}

/** Text for a menu-less context (print mode, RPC, ACP), plus the tables it would edit. */
export function menuFallback(config) {
	const lines = [
		"### Change a setting",
		"",
		"Interactive editing needs the TUI. From a shell:",
		"",
		"```",
		`omp plugin config set ${config.name} <key> <value>`,
		`omp plugin config delete ${config.name} <key>    # fall back to the preset/default`,
		`omp plugin config list ${config.name}`,
		"```",
		"",
		`Groups: ${KEY_GROUPS.map((group) => `${group.label} (${group.prefix ? `${group.prefix}*` : "unprefixed"}, ${group.keys.length})`).join(" · ")}`,
		"",
		formatPresets(config.preset),
		"",
		formatConfig(config),
	];
	return lines.join("\n");
}
