// Verifies the settings governor: which core knobs it recommends for a model and which it
// declines, the pin rule that keeps the user's own configuration out of the plugin's hands,
// the write path (runtime override by default, persistence only on request), the receipt that
// records the displaced value, revert in both modes and its safety when run twice, and the
// advice-only rows that carry a command instead of a write.
//
//   node test/tune.test.mjs
import {
	advisoryRows,
	roleEffort,
	subagentAdvice,
	apply,
	formatPlan,
	formatReceipt,
	KNOBS,
	plan,
	revert,
	TUNE_CATEGORIES,
} from "../src/tune.js";

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
		process.exit(1);
	}
	console.log(`all ${passed} checks passed`);
};

/**
 * omp's live `Settings` singleton as the module sees it: a value map, an override map that
 * wins over it, the set of keys the user's own configuration supplied, and a call log.
 */
function fakeSettings({ values = {}, configured = [], drop = [] } = {}) {
	const state = { values: { ...values }, overrides: new Map(), configured: new Set(configured), calls: [] };
	const settings = {
		get(path) {
			state.calls.push(["get", path]);
			return state.overrides.has(path) ? state.overrides.get(path) : state.values[path];
		},
		override(path, value) {
			state.calls.push(["override", path, value]);
			state.overrides.set(path, value);
		},
		clearOverride(path) {
			state.calls.push(["clearOverride", path]);
			state.overrides.delete(path);
		},
		set(path, value) {
			state.calls.push(["set", path, value]);
			state.values[path] = value;
			state.configured.add(path);
		},
		isConfigured(path) {
			state.calls.push(["isConfigured", path]);
			return state.configured.has(path) || state.overrides.has(path);
		},
	};
	for (const name of drop) delete settings[name];
	state.callsOf = (name) => state.calls.filter((call) => call[0] === name);
	return { settings, state };
}

/** The live model on the gateway this plugin is built around: 1M window, priced cache read. */
const GATEWAY_MODEL = {
	provider: "opencode-go",
	id: "deepseek-v4.1-flash",
	baseUrl: "https://opencode.ai/zen/go/v1",
	contextWindow: 1_000_000,
	maxTokens: 384_000,
	cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
	reasoning: true,
};

/** The one provider omp's own append-only auto rule already covers. */
const DEEPSEEK_MODEL = {
	provider: "deepseek",
	id: "deepseek-v4.1-flash",
	baseUrl: "https://api.deepseek.com",
	contextWindow: 1_000_000,
	cost: { cacheRead: 0.003 },
};

/** The same gateway model with no window declared: nothing to size a spill threshold against. */
const NO_WINDOW_MODEL = { ...GATEWAY_MODEL, contextWindow: undefined };

/** A model this plugin cannot account for at all: no declared cache-read rate, no cache provider. */
const UNPRICED_MODEL = { provider: "acme", id: "acme-1", baseUrl: "https://api.acme.test/v1" };

/** A store-backed route, which omp's auto rule covers whatever the provider says. */
const STORE_MODEL = { ...UNPRICED_MODEL, provider: "opencode-go", compatConfig: { supportsStore: true }, cost: { cacheRead: 0.003 } };

const row = (planned, key) => planned.rows.find((r) => r.key === key);
const change = (planned, key) => planned.changes.find((c) => c.key === key);

// ---------------------------------------------------------------- knob surface
expect("categories are the four groups in report order", JSON.stringify(TUNE_CATEGORIES) === JSON.stringify(["cache", "spend", "finish", "time"]));
expect(
	"every knob is a descriptor with a key, group, label, why and a model rule",
	KNOBS.length === 7 &&
		KNOBS.every(
			(knob) =>
				typeof knob.key === "string" &&
				knob.key.includes(".") &&
				TUNE_CATEGORIES.includes(knob.category) &&
				typeof knob.label === "string" &&
				knob.label.length > 0 &&
				typeof knob.why === "string" &&
				knob.why.length > 20 &&
				typeof knob.recommend === "function",
		),
);
expect("knob keys are unique", new Set(KNOBS.map((knob) => knob.key)).size === KNOBS.length);
// A `why` with a pipe in it would break the markdown table the plan is rendered into.
expect("no why contains a table pipe", KNOBS.every((knob) => !knob.why.includes("|")));
expect(
	"the seven knobs are the documented ones",
	JSON.stringify(KNOBS.map((knob) => knob.key)) ===
		JSON.stringify([
			"provider.appendOnlyContext",
			"display.cacheMissMarker",
			"tools.artifactSpillThreshold",
			"retry.waitForUsageReset",
			"todo.remindersMax",
			"task.softRequestBudget",
			"bash.autoBackground.thresholdMs",
		]),
);

// ---------------------------------------------------------------- append-only
{
	const { settings } = fakeSettings();
	const planned = plan({ model: GATEWAY_MODEL, settings });
	expect("the gateway model recommends append-only context", row(planned, "provider.appendOnlyContext").state === "change");
	expect("append-only is recommended as on", change(planned, "provider.appendOnlyContext").to === "on");
	expect("the append-only row carries the cache group", row(planned, "provider.appendOnlyContext").category === "cache");
	expect("the append-only why prices the miss (2% of a cache read)", row(planned, "provider.appendOnlyContext").why.includes("2%"));
}

// omp's own auto rule already covers deepseek, so the plugin says nothing there: a row that
// keeps recommending what the harness does anyway is the noise that makes advice ignorable.
{
	const { settings } = fakeSettings();
	const planned = plan({ model: DEEPSEEK_MODEL, settings });
	expect("provider deepseek is left to omp's auto rule", row(planned, "provider.appendOnlyContext").state === "n/a");
	expect("deepseek emits no append-only change", change(planned, "provider.appendOnlyContext") === undefined);
}

// A store-backed route is the same story: omp turns append-only context on by itself.
{
	const { settings } = fakeSettings();
	expect("a store-backed route is n/a for append-only", row(plan({ model: STORE_MODEL, settings }), "provider.appendOnlyContext").state === "n/a");
}

// ---------------------------------------------------------------- capability gate
{
	const { settings } = fakeSettings();
	const planned = plan({ model: UNPRICED_MODEL, settings });
	expect("an unaccountable model gets no append-only advice", row(planned, "provider.appendOnlyContext").state === "n/a");
	expect("an unaccountable model gets no cache-miss marker", row(planned, "display.cacheMissMarker").state === "n/a");
}

// ---------------------------------------------------------------- cache-miss marker
{
	const { settings } = fakeSettings();
	const planned = plan({ model: GATEWAY_MODEL, settings });
	expect("a cache-capable model recommends the miss marker", change(planned, "display.cacheMissMarker").to === true);
}

{
	const { settings } = fakeSettings({ values: { "display.cacheMissMarker": true } });
	const planned = plan({ model: GATEWAY_MODEL, settings });
	expect("a marker already on is kept, not written", row(planned, "display.cacheMissMarker").state === "keep");
	expect("keep emits no change", change(planned, "display.cacheMissMarker") === undefined);
}

// ---------------------------------------------------------------- artifact spill
// 1M tokens / 8000 = 125, capped at 50 KB by the audit's own rule.
{
	const { settings } = fakeSettings({ values: { "tools.artifactSpillThreshold": 20 } });
	const planned = plan({ model: GATEWAY_MODEL, settings });
	expect("a spill threshold below the target is raised", change(planned, "tools.artifactSpillThreshold").to === 50);
	expect("the raised threshold is in the spend group", row(planned, "tools.artifactSpillThreshold").category === "spend");
}

{
	const { settings } = fakeSettings({ values: { "tools.artifactSpillThreshold": 50 } });
	expect("a spill threshold at the target is kept", row(plan({ model: GATEWAY_MODEL, settings }), "tools.artifactSpillThreshold").state === "keep");
}

{
	const { settings } = fakeSettings({ values: { "tools.artifactSpillThreshold": 100 } });
	const planned = plan({ model: GATEWAY_MODEL, settings });
	expect("a spill threshold above the target is never lowered", row(planned, "tools.artifactSpillThreshold").state === "n/a");
	expect("no spill change is emitted for a higher live value", change(planned, "tools.artifactSpillThreshold") === undefined);
}

{
	const { settings } = fakeSettings();
	const planned = plan({ model: NO_WINDOW_MODEL, settings });
	expect("no context window means no spill recommendation", row(planned, "tools.artifactSpillThreshold").state === "n/a");
	expect("an unset spill threshold is not written when it already matches the schema default", change(planned, "tools.artifactSpillThreshold") === undefined);
}

{
	// The schema default is what omp actually uses when nothing is stored, so a stored 8 KB on
	// a small window still reads as lower than that window's target and gets raised.
	const { settings } = fakeSettings({ values: { "tools.artifactSpillThreshold": "8" } });
	const planned = plan({ model: { ...GATEWAY_MODEL, contextWindow: 120_000 }, settings });
	expect("a numeric string is compared as a number", change(planned, "tools.artifactSpillThreshold").to === 15);
}

// ---------------------------------------------------------------- fixed recommendations
{
	const { settings } = fakeSettings();
	const planned = plan({ model: GATEWAY_MODEL, settings });
	expect("a quota hit waits for the reset", change(planned, "retry.waitForUsageReset").to === true);
	expect("the reset wait is a time knob", row(planned, "retry.waitForUsageReset").category === "time");
	expect("todo reminders are raised to 6", change(planned, "todo.remindersMax").to === 6);
	expect("the subagent budget is raised to 400", change(planned, "task.softRequestBudget").to === 400);
	expect("the subagent budget is a finish knob", row(planned, "task.softRequestBudget").category === "finish");
	expect("slow commands background at 30s", change(planned, "bash.autoBackground.thresholdMs").to === 30000);
	expect("every knob with a recommendation is emitted on a fresh session", planned.changes.length === 7);
	expect("the status counts what the plan contains", planned.status.total === 7 && planned.status.change === 7 && planned.status.na === 0);
}

// ---------------------------------------------------------------- category scoping
{
	const { settings } = fakeSettings();
	const planned = plan({ model: GATEWAY_MODEL, settings, categories: ["cache"] });
	expect("a category scope limits the rows", planned.rows.length === 2 && planned.rows.every((r) => r.category === "cache"));
	expect("a category scope limits the changes", planned.changes.length === 2);
	expect("a category scope is counted in the status", planned.status.total === 2);
	const none = plan({ model: GATEWAY_MODEL, settings, categories: ["nonsense"] });
	expect("an unknown category name selects nothing", none.rows.length === 0 && none.changes.length === 0);
}

// ---------------------------------------------------------------- pinning
{
	const { settings } = fakeSettings({ values: { "provider.appendOnlyContext": "off" }, configured: ["provider.appendOnlyContext"] });
	const planned = plan({ model: GATEWAY_MODEL, settings });
	const pinned = row(planned, "provider.appendOnlyContext");
	expect("a knob the user configured is pinned", pinned.state === "pinned");
	expect("a pinned knob still shows its live value", pinned.current === "off");
	expect("a pinned knob emits no change", change(planned, "provider.appendOnlyContext") === undefined);
	expect("the pinned knob is counted", planned.status.pinned === 1 && planned.status.change === 6);

	const forced = plan({ model: GATEWAY_MODEL, settings, force: true });
	expect("force offers a pinned knob anyway", row(forced, "provider.appendOnlyContext").state === "change");
	expect("force emits the change it offered", change(forced, "provider.appendOnlyContext").to === "on");
}

// A key this plugin already wrote is not the user's configuration even though isConfigured
// says so — the plugin's own override is what put it there.
{
	const { settings } = fakeSettings({ values: { "provider.appendOnlyContext": "on" }, configured: ["provider.appendOnlyContext"] });
	const receipt = { appliedAt: "2026-09-21T00:00:00.000Z", entries: [{ key: "provider.appendOnlyContext", from: "auto", to: "on", mode: "override" }] };
	expect("the plugin's own write is not mistaken for a pin", row(plan({ model: GATEWAY_MODEL, settings, receipt }), "provider.appendOnlyContext").state === "keep");
}

// ---------------------------------------------------------------- unusable settings
{
	const missing = fakeSettings({ drop: ["clearOverride"] }).settings;
	expect("a settings object without clearOverride is unusable", plan({ model: GATEWAY_MODEL, settings: missing }) === undefined);
	const partial = fakeSettings({ drop: ["isConfigured", "set"] }).settings;
	expect("a settings object missing several methods is unusable", plan({ model: GATEWAY_MODEL, settings: partial }) === undefined);
	expect("no settings object at all means no plan", plan({ model: GATEWAY_MODEL }) === undefined);
	expect("an empty object means no plan", plan({ model: GATEWAY_MODEL, settings: {} }) === undefined);
	// The writers stay defensive rather than throwing at a half-built host.
	expect("apply on unusable settings returns an empty receipt", apply(undefined, [{ key: "a.b", to: 1 }]).entries.length === 0);
	expect("revert on unusable settings returns nothing", revert({}, { entries: [{ key: "a.b", to: 1, mode: "override" }] }).clearedOverride.length === 0);
	expect("revert with no receipt returns nothing", revert(fakeSettings().settings, undefined).restored.length === 0);
}

// ---------------------------------------------------------------- writing
{
	const { settings, state } = fakeSettings({ values: { "provider.appendOnlyContext": "auto" } });
	const planned = plan({ model: GATEWAY_MODEL, settings });
	const receipt = apply(settings, planned.changes);
	expect("apply writes with override, never with set, by default", state.callsOf("set").length === 0 && state.callsOf("override").length === planned.changes.length);
	expect("an override is what the live value becomes", settings.get("provider.appendOnlyContext") === "on");
	expect("the receipt records one entry per write", receipt.entries.length === planned.changes.length);
	const written = receipt.entries.find((entry) => entry.key === "provider.appendOnlyContext");
	expect("the receipt records the displaced value", written.from === "auto" && written.to === "on");
	expect("the receipt records how the value was written", written.mode === "override");
	expect("the receipt carries an ISO timestamp", typeof receipt.appliedAt === "string" && !Number.isNaN(Date.parse(receipt.appliedAt)));

	const again = apply(settings, planned.changes);
	expect("a second apply writes nothing", again.entries.length === 0);
	expect("a second apply calls no writer", state.callsOf("override").length === planned.changes.length);
}

{
	const { settings, state } = fakeSettings();
	const planned = plan({ model: GATEWAY_MODEL, settings });
	const receipt = apply(settings, planned.changes, { persist: true });
	expect("persist writes with set and not with override", state.callsOf("override").length === 0 && state.callsOf("set").length === planned.changes.length);
	expect("a persisted entry says so", receipt.entries.every((entry) => entry.mode === "persist"));
	expect("persist reaches the stored value", settings.get("todo.remindersMax") === 6);
}

{
	const { settings, state } = fakeSettings({ values: { "todo.remindersMax": 6 } });
	const receipt = apply(settings, [{ key: "todo.remindersMax", to: 6 }]);
	expect("a key already at the target is skipped", receipt.entries.length === 0 && state.callsOf("override").length === 0);
	expect("a skipped key is still read before deciding", state.callsOf("get").length >= 1);
	const noValue = apply(settings, [{ key: "todo.remindersMax" }, { to: 3 }]);
	expect("a malformed change is ignored", noValue.entries.length === 0);
}

// ---------------------------------------------------------------- revert
{
	const { settings, state } = fakeSettings({ values: { "display.cacheMissMarker": false, "todo.remindersMax": 3 } });
	const receipt = apply(settings, [
		{ key: "display.cacheMissMarker", to: true },
		{ key: "todo.remindersMax", to: 6 },
	]);
	expect("an override is applied before the revert is tested", settings.get("todo.remindersMax") === 6);
	const undone = revert(settings, receipt);
	expect("revert clears every override it wrote", undone.clearedOverride.length === 2 && undone.clearedOverride.includes("todo.remindersMax"));
	expect("revert restores the value the override displaced", settings.get("todo.remindersMax") === 3 && settings.get("display.cacheMissMarker") === false);
	expect("revert clears the override rather than overriding again", state.callsOf("clearOverride").length === 2);
	expect("revert writes no persisted value for an override entry", state.callsOf("set").length === 0);
}

{
	const { settings, state } = fakeSettings({ values: { "todo.remindersMax": 3 }, configured: ["todo.remindersMax"] });
	const receipt = apply(settings, [{ key: "todo.remindersMax", to: 6 }], { persist: true });
	expect("the persisted value is live before the revert", settings.get("todo.remindersMax") === 6);
	const undone = revert(settings, receipt);
	expect("revert restores a persisted value from the receipt", undone.restored.length === 1 && settings.get("todo.remindersMax") === 3);
	expect("a persisted revert writes the old value and clears nothing", state.callsOf("set").length === 2 && state.callsOf("clearOverride").length === 0);
}

{
	const { settings, state } = fakeSettings();
	const receipt = apply(settings, [{ key: "todo.remindersMax", to: 6 }]);
	revert(settings, receipt);
	const writesBefore = state.callsOf("clearOverride").length;
	const second = revert(settings, receipt);
	expect("a second revert reports nothing to undo", second.restored.length === 0 && second.clearedOverride.length === 0);
	expect("a second revert touches no override", state.callsOf("clearOverride").length === writesBefore);
	expect("a second revert leaves the value as the first one left it", settings.get("todo.remindersMax") === undefined);
}

{
	// An entry whose write the runtime already dropped — a session that ended, a value set
	// back by hand — must not be cleared a second time blindly.
	const { settings, state } = fakeSettings({ values: { "todo.remindersMax": 9 } });
	const receipt = { appliedAt: "2026-09-21T00:00:00.000Z", entries: [{ key: "todo.remindersMax", from: 3, to: 6, mode: "override" }] };
	const undone = revert(settings, receipt);
	expect("a stale override entry is not cleared", undone.clearedOverride.length === 0 && state.callsOf("clearOverride").length === 0);
}

// ---------------------------------------------------------------- format
{
	const { settings } = fakeSettings({ values: { "provider.appendOnlyContext": "off" }, configured: ["provider.appendOnlyContext"] });
	const text = formatPlan(plan({ model: GATEWAY_MODEL, settings }));
	expect("the plan prints a markdown table header", text.startsWith("| Knob | Current | Recommended | Why | State |"));
	expect("the plan has a row per knob", text.split("\n").filter((line) => line.startsWith("| `")).length === 7);
	expect("a pinned row says the value is the user's own", text.includes("your own configuration"));
	expect("the plan names the pinned key", text.includes("`provider.appendOnlyContext`"));
	expect("an unavailable plan says so", formatPlan(undefined).includes("unavailable"));
}

{
	const { settings } = fakeSettings();
	const planned = plan({ model: GATEWAY_MODEL, settings });
	const receipt = apply(settings, planned.changes);
	const line = formatReceipt(receipt);
	expect("the receipt is one line", !line.includes("\n"));
	expect("the receipt counts the writes and names the mode", line.includes("7 setting(s) runtime-only"));
	expect("the receipt names a written key and its value", line.includes("provider.appendOnlyContext=on") && line.includes("todo.remindersMax=6"));
	const persisted = formatReceipt(apply(settings, [{ key: "todo.remindersMax", to: 7 }], { persist: true }));
	expect("a persisted receipt says where it went", persisted.includes("persisted to config.yml"));
	expect("an empty receipt says nothing changed", formatReceipt({ appliedAt: "x", entries: [] }).includes("no setting changed"));
}

// ---------------------------------------------------------------- advice-only rows
{
	const { settings } = fakeSettings({ values: { "provider.appendOnlyContext": "off" }, configured: ["provider.appendOnlyContext"] });
	const rows = advisoryRows({ model: GATEWAY_MODEL, settings });
	const pinned = rows.find((r) => r.key === "provider.appendOnlyContext");
	expect("a pinned knob is advice-only", pinned !== undefined);
	expect("advisory advice carries the exact command", pinned.command === "omp config set provider.appendOnlyContext on");
	expect("advisory advice states the live value and the recommendation", pinned.current === "off" && pinned.recommended === "on");
	expect("advisory advice explains itself", typeof pinned.why === "string" && pinned.why.length > 10);
	expect("a knob the user did not configure is not advice-only", rows.every((r) => r.key !== "todo.remindersMax" || r.command.includes("todo.remindersMax")));
	expect("a knob already at the recommended value is not advice-only", rows.every((r) => r.key !== "display.cacheMissMarker"));
}

{
	const { settings } = fakeSettings({ configured: ["todo.remindersMax"], values: { "todo.remindersMax": 3 } });
	const rows = advisoryRows({ model: GATEWAY_MODEL, settings });
	expect("every advisory row has a command in omp's form", rows.length > 0 && rows.every((r) => r.command.startsWith("omp config set ")));
	expect("the command names the knob and the recommended value", rows[0].command === "omp config set todo.remindersMax 6");
}

{
	const { settings } = fakeSettings();
	const selector = "opencode-go/deepseek-v4.1-flash:max";
	const rows = advisoryRows({ model: GATEWAY_MODEL, settings, roleSelector: selector });
	const role = rows.find((r) => r.key === "modelRoles.default");
	expect("a pinned role effort is advisory", role !== undefined);
	expect(
		"the role advice drops the effort suffix",
		role !== undefined && role.recommended === "opencode-go/deepseek-v4.1-flash" && role.command === "omp config set modelRoles.default opencode-go/deepseek-v4.1-flash",
		role,
	);
	expect("the role advice names the pinned effort it read", role !== undefined && role.current === selector && role.why.includes("max"));
	expect("the role row is named by the role the caller passes", advisoryRows({ model: GATEWAY_MODEL, settings, roleSelector: "a/b:high", role: "smol" }).some((r) => r.key === "modelRoles.smol"));
	expect("an auto effort is nothing to advise", advisoryRows({ model: GATEWAY_MODEL, settings, roleSelector: "a/b:auto" }).length === 0);
	expect("a deliberately cheap effort is nothing to advise", advisoryRows({ model: GATEWAY_MODEL, settings, roleSelector: "a/b:low" }).length === 0);
	expect("a role with no effort suffix is nothing to advise", advisoryRows({ model: GATEWAY_MODEL, settings, roleSelector: "a/b" }).length === 0);
	expect("a colon that is not an effort is part of the model", roleEffort("openrouter/vendor/model:beta") === undefined);
	expect("the effort is read from the suffix", roleEffort("a/b:xhigh") === "xhigh" && roleEffort("a/b:MAX") === "max");
	expect("advice with no pin and no user value is empty", advisoryRows({ model: GATEWAY_MODEL, settings }).length === 0);
}

// ---------------------------------------------------------------- delegated work
{
	const { settings } = fakeSettings();
	const cheap = { provider: "opencode-go", id: "muse-spark", cost: { output: 0.2 }, contextWindow: 1_048_576 };
	const pricier = { provider: "opencode-go", id: "kimi-k3", cost: { output: 15 }, contextWindow: 1_048_576 };
	const other = { provider: "anthropic", id: "haiku", cost: { output: 0.02 }, contextWindow: 200_000 };
	const tiny = { provider: "opencode-go", id: "tiny", cost: { output: 0.01 }, contextWindow: 32_000 };

	const row = subagentAdvice({ model: GATEWAY_MODEL, models: [cheap, pricier, other, tiny], settings });
	expect("subagents: the cheapest same-provider model is named", row !== undefined && row.recommended === "opencode-go/muse-spark", row);
	expect("subagents: a small-window model is not offered for delegated work", !row.recommended.includes("tiny"));
	expect("subagents: another provider is not offered either", !row.recommended.includes("haiku"));
	expect("subagents: the ratio against the live model is stated", row.why.includes("3.0x cheaper"), row.why);
	expect("subagents: the command names the knob", row.command.startsWith("omp config set task.agentModelOverrides"), row.command);
	expect("subagents: nothing to say without a catalog", subagentAdvice({ model: GATEWAY_MODEL, models: [], settings }) === undefined);
	expect("subagents: a user-configured override is not second-guessed", subagentAdvice({ model: GATEWAY_MODEL, models: [cheap], settings: fakeSettings({ configured: ["task.agentModelOverrides"] }).settings }) === undefined);
	expect("subagents: a model with no rates is not a delegate", subagentAdvice({ model: { provider: "x", id: "y", cost: {} }, models: [cheap], settings }) === undefined);
}

done();
