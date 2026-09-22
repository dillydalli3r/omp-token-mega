/**
 * The governor: which oh-my-pi core setting this model wants changed, the write, and the undo.
 *
 * `audit.js` reads omp's settings files and prints what it would change, because a plugin
 * cannot write a settings file it cannot see. This module is that same advice with a hand on
 * the dial. The extension factory is handed omp's live `Settings` object, so a recommendation
 * can be applied to the running session (`override`, runtime-only, gone when the session
 * ends) or persisted to config.yml (`set`), and — because every write records the live value
 * it displaced in a receipt — reverted exactly.
 *
 * Three rules shape every decision here.
 *
 * A value the user configured is theirs. `isConfigured` is true whenever the global file, the
 * project file, or a runtime override supplied a value, and a knob under it is reported
 * `pinned` and left alone: silently overwriting a deliberate choice is how a plugin loses its
 * welcome. `force` is the caller saying it means it.
 *
 * A write only happens when it changes something. `apply` re-reads the live value and skips a
 * key already at the target, so applying the same plan twice writes once — which is what makes
 * a plan safe to re-run from a command or a menu entry.
 *
 * The receipt is what makes `revert` exact. An `override` entry is undone by *clearing* the
 * override rather than writing the displaced value back: what an override usually displaced is
 * the schema default, and a stale copy of it written as a second override would outlive the
 * reason it was written. A `persist` entry is undone by writing its old value back, because
 * there the displaced value was the user's own stored setting. Reverting twice is therefore
 * safe: the second pass finds that the live value is no longer the one the receipt wrote and
 * does nothing.
 *
 * Everything in this file is pure except `apply` and `revert`, which is exactly why the
 * settings object arrives as a duck-typed argument instead of being imported: the only thing
 * this module needs from it is the five methods below, and a test can hand it a fake that
 * records every call.
 */

import { CORE_DEFAULTS, recommendedSpillThreshold } from "./audit.js";
import { appendOnlyAutoEnabled, cacheCapable } from "./model.js";

/** The catalog's thinking vocabulary: the only suffixes a model role may pin. */
const THINKING_EFFORTS = new Set(["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * The efforts worth advising against on a model that replays reasoning. A pin at `minimal`
 * or `low` is a deliberate cheap choice; `medium` and up is where the reasoning text starts
 * costing more than the answer it produces.
 */
const EXPENSIVE_EFFORTS = new Set(["medium", "high", "xhigh", "max"]);

/** The knob groups a caller may scope a plan to, in the order the plan reports them. */
export const TUNE_CATEGORIES = ["cache", "spend", "finish", "time"];

/** The method set a settings object must expose before this module will touch it at all. */
const REQUIRED_METHODS = ["get", "override", "clearOverride", "set", "isConfigured"];

/**
 * A finite number, or undefined. omp stores a threshold as a number but a hand-edited YAML
 * file can hold `"50"`, and a value this module cannot read as a number is one it will not
 * compare against, let alone overwrite.
 */
function numeric(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

/**
 * Whether two setting values are the same value. `true` and `"true"` are the same setting to
 * a YAML reader wearing a schema, and `30000` and `"30000"` likewise; anything else compares
 * strictly, and an absent value is never equal to a present one — "unset" and "false" are
 * both falsy and are not the same setting.
 */
function same(a, b) {
	if (a === b) return true;
	if (a === undefined || a === null || b === undefined || b === null) return false;
	if (typeof a === "boolean" || typeof b === "boolean") return String(a) === String(b);
	const na = numeric(a);
	const nb = numeric(b);
	return na !== undefined && nb !== undefined && na === nb;
}

/** One value as the user types it into `omp config set`: no quotes, no JSON. */
function renderValue(value) {
	if (value === undefined || value === null) return "unset";
	if (typeof value === "string") return value;
	return String(value);
}

/** The exact `omp config set` line for a recommendation, in audit's shape. */
function command(key, value) {
	return `omp config set ${key} ${renderValue(value)}`;
}

/**
 * The thinking effort a model role pins, or `undefined` when the role pins nothing.
 *
 * omp writes a role as `provider/model:effort` — the suffix is the only place a per-session
 * effort is chosen, and it is a human's decision, so this module reads it to advise and never
 * rewrites it. Only the catalog's own effort vocabulary counts as a suffix: a model id may
 * contain a colon of its own, and a name that is not an effort is part of the model.
 */
export function roleEffort(selector) {
	if (typeof selector !== "string") return undefined;
	const match = /:([a-z]+)$/i.exec(selector.trim());
	return match && THINKING_EFFORTS.has(match[1].toLowerCase()) ? match[1].toLowerCase() : undefined;
}

/** Live value, or undefined. A settings object that throws on read is not one to die over. */
function live(settings, key) {
	try {
		return settings.get(key);
	} catch {
		return undefined;
	}
}

/** Whether the user's own global/project/runtime configuration supplied this key. */
function configured(settings, key) {
	try {
		return settings.isConfigured(key) === true;
	} catch {
		return false;
	}
}

/** Whether the object exposes every method `apply`/`revert`/`plan` will call. */
function usable(settings) {
	return Boolean(settings) && REQUIRED_METHODS.every((name) => typeof settings[name] === "function");
}

/**
 * The knobs, each with the model condition that makes it worth changing. `recommend` is the
 * whole model-specific part of the module and is called with the live value so a knob that is
 * only worth touching in one direction can say so; undefined means "this model has no use for
 * it" and the plan reports the row as `n/a` while emitting nothing.
 */
export const KNOBS = [
	{
		key: "provider.appendOnlyContext",
		category: "cache",
		label: "Append-only context",
		why: "a cache read bills 2% of a miss, and without append-only the leading block — system prompt, tool catalogue — is rebuilt on every request, so any input that shifts under it costs the hits of everything behind it. Insurance, priced by the hit rate the cache section already measures.",
		recommend({ model }) {
			if (!cacheCapable(model)) return undefined;
			// omp already turns this on by itself for DeepSeek, the local engines, loopback and
			// store-backed routes; recommending it there is noise, and recommending it for a model
			// whose requests are not cacheable at all is wrong.
			if (appendOnlyAutoEnabled(model)) return undefined;
			return "on";
		},
	},
	{
		key: "display.cacheMissMarker",
		category: "cache",
		label: "Cache-miss marker",
		why: "a miss is the most expensive event in the session — the whole prefix is billed at the miss rate — and an invisible one cannot be diagnosed.",
		recommend({ model }) {
			return cacheCapable(model) ? true : undefined;
		},
	},
	{
		key: "tools.artifactSpillThreshold",
		category: "spend",
		label: "Artifact spill threshold (KB)",
		why: "below this a routine result is elided to head and tail behind an artifact:// handle, so the model pays a second read to see the rest of what it already fetched.",
		recommend({ contextWindow, current }) {
			const target = recommendedSpillThreshold(contextWindow);
			if (target === undefined) return undefined;
			// An absent key is the schema default, which is the value omp is effectively using;
			// comparing against it is what keeps this knob from writing a redundant override.
			const value = numeric(current) ?? numeric(CORE_DEFAULTS["tools.artifactSpillThreshold"]);
			if (value === undefined) return undefined;
			// Raising is this knob's only direction. A threshold the user set above the target is
			// their call and costs this model nothing; equal is nothing to write.
			return value <= target ? target : undefined;
		},
	},
	{
		key: "retry.waitForUsageReset",
		category: "time",
		label: "Wait out usage resets",
		why: "a session that hits a 5-hour or weekly quota sleeps until the reset instead of failing the request, so a long run finishes without a human restarting it.",
		recommend() {
			return true;
		},
	},
	{
		key: "todo.remindersMax",
		category: "finish",
		label: "Todo reminders",
		why: "omp's default of 3 lets the agent settle with an unfinished todo list; the extra reminders are cheap turns that finish it instead of leaving it to be redone later.",
		recommend() {
			// omp's schema default is 3; the cost of the reminder itself is one short turn.
			return 6;
		},
	},
	{
		key: "task.softRequestBudget",
		category: "finish",
		label: "Subagent request budget",
		why: "a subagent is force-stopped at 1.5x its budget, and one stopped mid-investigation pays for its requests twice when a fresh child starts over.",
		recommend() {
			// omp's schema default is 200; 400 leaves room for one investigation that needs a
			// second pass over the files it already read.
			return 400;
		},
	},
	{
		key: "bash.autoBackground.thresholdMs",
		category: "time",
		label: "Auto-background threshold (ms)",
		why: "a slow command is backgrounded a minute earlier, so the turn stops waiting on it and the requests that would be spent waiting are not.",
		recommend() {
			// omp's schema default is 60000; 30s is past any interactive command and short of the
			// point where a turn looks hung.
			return 30000;
		},
	},
];

/**
 * The plan for the live model: every knob in scope, the value it holds now, what this model
 * wants it to be, and whether anything will be written. Returns undefined when the settings
 * object is not usable at all — a plan that cannot be applied is not worth rendering.
 *
 * `receipt` is the record of what this plugin already wrote this session: a key in it is not
 * "the user's configuration" even though `isConfigured` says so, because the plugin's own
 * override is what put it there.
 */
export function plan({ model, settings, receipt, categories, force } = {}) {
	if (!usable(settings)) return undefined;
	const scope = Array.isArray(categories) && categories.length > 0 ? new Set(categories) : undefined;
	const written = new Set(
		(Array.isArray(receipt?.entries) ? receipt.entries : []).map((entry) => entry?.key).filter(Boolean),
	);
	const rows = [];
	const changes = [];
	const status = { total: 0, change: 0, keep: 0, pinned: 0, na: 0 };

	for (const knob of KNOBS) {
		if (scope && !scope.has(knob.category)) continue;
		const current = live(settings, knob.key);
		const recommended = knob.recommend({ model, contextWindow: model?.contextWindow, current });
		let state;
		if (recommended === undefined) state = "n/a";
		else if (configured(settings, knob.key) && !written.has(knob.key) && force !== true) state = "pinned";
		else if (same(current, recommended)) state = "keep";
		else state = "change";

		rows.push({ key: knob.key, label: knob.label, category: knob.category, current, recommended, why: knob.why, state });
		status.total += 1;
		if (state === "n/a") status.na += 1;
		else status[state] += 1;

		if (state === "change") changes.push({ key: knob.key, to: recommended, category: knob.category, label: knob.label });
	}
	return { rows, changes, status };
}

/**
 * Write a plan's changes and return the receipt that makes them reversible. The only writer in
 * the module: `override` by default, because a session-scoped value needs no file edit and
 * disappears on its own, and `set` only when the caller explicitly asked for `persist`.
 *
 * A key already holding the target is not written, so applying a plan twice writes once; the
 * receipt therefore lists only the writes that actually happened, which is what keeps `revert`
 * from undoing something it did not do.
 */
export function apply(settings, changes, { persist = false } = {}) {
	const receipt = { appliedAt: new Date().toISOString(), entries: [] };
	if (!usable(settings) || !Array.isArray(changes)) return receipt;
	for (const change of changes) {
		const key = change?.key;
		const to = change?.to;
		if (typeof key !== "string" || key === "" || to === undefined) continue;
		const from = live(settings, key);
		if (same(from, to)) continue;
		const mode = persist ? "persist" : "override";
		try {
			if (persist) settings.set(key, to);
			else settings.override(key, to);
		} catch {
			// A settings object that refuses one write is not a reason to abandon the rest: the
			// receipt lists what got through, and revert undoes exactly that.
			continue;
		}
		receipt.entries.push({ key, from, to, mode });
	}
	return receipt;
}

/**
 * Undo exactly what a receipt recorded. Overrides are cleared rather than rewritten — the value
 * an override displaced is nearly always the schema default, and writing that back as a second
 * override would outlive the session it was meant to protect. Persisted entries get their old
 * value back.
 *
 * The live value is compared against what the receipt wrote before touching anything, so
 * reverting twice is a no-op: after the first pass the live value is no longer the receipt's
 * `to`, and clearing an override that is not there is nothing to do.
 */
export function revert(settings, receipt) {
	const restored = [];
	const clearedOverride = [];
	if (!usable(settings)) return { restored, clearedOverride };
	const seen = new Set();
	for (const entry of Array.isArray(receipt?.entries) ? receipt.entries : []) {
		const key = entry?.key;
		if (typeof key !== "string" || key === "" || seen.has(key)) continue;
		seen.add(key);
		if (!same(live(settings, key), entry.to)) continue;
		if (entry.mode === "override") {
			try {
				settings.clearOverride(key);
			} catch {
				continue;
			}
			clearedOverride.push(key);
			continue;
		}
		try {
			settings.set(key, entry.from);
		} catch {
			continue;
		}
		restored.push(key);
	}
	return { restored, clearedOverride };
}

/**
 * The plan as the markdown table a `/mega` section or a menu entry renders. A pinned row is
 * called out below the table, because the state alone does not say *why* the plan is not
 * touching a knob this model wants changed.
 */
export function formatPlan(planResult) {
	if (!planResult) return "omp settings are unavailable in this session: nothing to plan.";
	const lines = ["| Knob | Current | Recommended | Why | State |", "| --- | --- | --- | --- | --- |"];
	for (const row of planResult.rows) {
		lines.push(
			`| \`${row.key}\` | ${renderValue(row.current)} | ${renderValue(row.recommended)} | ${row.why} | ${row.state} |`,
		);
	}
	const pinned = planResult.rows.filter((row) => row.state === "pinned");
	if (pinned.length > 0) {
		lines.push(
			"",
			`Pinned (left alone, the value came from your own configuration; \`force\` offers it anyway): ${pinned
				.map((row) => `\`${row.key}\``)
				.join(", ")}`,
		);
	}
	return lines.join("\n");
}

/** One line for a notify or a report: how many settings changed, how they were written, which. */
export function formatReceipt(receipt) {
	const entries = Array.isArray(receipt?.entries) ? receipt.entries : [];
	if (entries.length === 0) return "omp-token-mega: no setting changed";
	const persisted = entries.every((entry) => entry.mode === "persist");
	const mode = persisted ? "persisted to config.yml" : entries.some((entry) => entry.mode === "persist") ? "mixed" : "runtime-only";
	return `omp-token-mega: ${entries.length} setting(s) ${mode}: ${entries.map((entry) => `${entry.key}=${renderValue(entry.to)}`).join(", ")}`;
}

/**
 * Where delegated work should go: the cheapest capable model on the live model's own
 * provider, if one is cheaper than the model that is currently doing the delegating.
 *
 * `task` subagents bill their own model, and an omp session delegates by default, so the
 * model a child runs on is a first-order cost decision — on the gateway this plugin was
 * built for, the same provider answers with a model whose output is a third of the price.
 * The recommendation is deliberately narrow: same provider (so the same account and the same
 * key), a real price, cheaper output, and a context window worth delegating into. Nothing is
 * written here — which model does the work is the user's choice, and omp configures it per
 * agent in its own `/agents` hub, so this module returns the row and the command and stops.
 */
export function subagentAdvice({ model, models = [], settings } = {}) {
	const provider = model?.provider;
	const out = Number(model?.cost?.output);
	if (!provider || !Number.isFinite(out) || out <= 0) return undefined;
	if (configured(settings, "task.agentModelOverrides")) return undefined;
	const cheaper = [];
	for (const candidate of models) {
		if (!candidate || candidate.provider !== provider || candidate.id === model.id) continue;
		const price = Number(candidate.cost?.output);
		const window = Number(candidate.contextWindow);
		// A cheaper model that cannot hold the work is not cheaper: the floor keeps a
		// small-window model from being recommended for a job that will not fit in it.
		if (!Number.isFinite(price) || price <= 0 || price >= out) continue;
		if (Number.isFinite(window) && window < 100_000) continue;
		cheaper.push({ id: candidate.id, price });
	}
	if (cheaper.length === 0) return undefined;
	cheaper.sort((a, b) => a.price - b.price);
	const best = cheaper[0];
	const ratio = (out / best.price).toFixed(1);
	return {
		key: "task.agentModelOverrides",
		label: "Subagent model",
		current: undefined,
		recommended: `${provider}/${best.id}`,
		why: `delegated work bills the child's own model, and \`${provider}/${best.id}\` answers at $${best.price}/Mtok out against this model's $${out}/Mtok — ${ratio}x cheaper on the same account. Set it per agent in omp's \`/agents\` hub.`,
		command: `omp config set task.agentModelOverrides.task ${provider}/${best.id}`,
	};
}

/**
 * The advice this module will not apply: a knob whose value the user configured themselves,
 * where the change is theirs to make, and the model-role thinking suffix, where the setting is
 * a behaviour choice rather than a token lever. Each row carries the exact command instead of
 * being written, because a plugin that edits the user's own choice is one nobody keeps.
 *
 * `roleSelector` is the live value of a model role (`settings.get("modelRoles").default`),
 * which omp writes as `provider/model:effort` — the suffix is the pin. On this gateway a
 * model that requires reasoning replay bills its thinking text as *input* tokens on every
 * tool-call step, so a pinned effort pays for the same reasoning again on every step of a
 * long tool loop; dropping the suffix hands that decision back to omp's own classifier.
 * `role` names the role, so a caller can advise on one other than the default.
 */
export function advisoryRows({ model, settings, roleSelector, role = "default" } = {}) {
	const rows = [];
	for (const knob of KNOBS) {
		const current = live(settings, knob.key);
		const recommended = knob.recommend({ model, contextWindow: model?.contextWindow, current });
		// Only a value the user supplied themselves is advice rather than a change; a knob with
		// nothing to recommend, nothing to move, or no user behind it is not a row here.
		if (recommended === undefined || same(current, recommended) || !configured(settings, knob.key)) continue;
		rows.push({
			key: knob.key,
			current,
			recommended,
			why: knob.why,
			command: command(knob.key, recommended),
		});
	}
	const pinned = roleEffort(roleSelector);
	if (pinned && EXPENSIVE_EFFORTS.has(pinned)) {
		const key = `modelRoles.${role}`;
		const next = roleSelector.slice(0, roleSelector.length - pinned.length - 1);
		rows.push({
			key,
			current: roleSelector,
			recommended: next,
			why: `the resolved role pins thinking at \`${pinned}\`; on this gateway a model that requires reasoning replay bills the thinking text as input tokens on every tool-call step, so a pinned effort pays for the same reasoning on every step.`,
			command: command(key, next),
		});
	}
	return rows;
}
