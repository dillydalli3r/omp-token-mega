/**
 * The merge's own contract.
 *
 * Three plugins became one, and the parts that must be *one* are the parts a user sees:
 * one status row (a second key is a second footer line), one command, and one settings
 * menu covering every feature's keys. This suite pins those, plus the composition rules
 * the row relies on: the row is a widget the plugin renders itself, which is what lets the
 * tariff note carry the host theme's colours even though omp strips ANSI from status text.
 *
 *   node test/shell.test.mjs
 */

import { checks, createFakeSettings, DEEPSEEK_MODEL, makeHost, OPENCODE_MODEL, SCHEDULED_MODEL, STATUS_KEY, tick, withConfig } from "./harness.mjs";
import { CONFIG_KEYS, CONFIG_SCHEMA, KEY_GROUPS, STATUS_SEGMENTS, statusSegmentNames } from "../src/config.js";
import { composeRow, renderRow, TINTS } from "../src/status.js";

const { expect, done } = checks();

// ----------------------------------------------------------------- composition rules

{
	const names = ["cache", "balance", "token"];
	const segments = { cache: "DS cache 87%", balance: "DS \u00a511.48", token: "TS -1.0 KB" };

	// `composeRow` decides what belongs on the line — order, separators, budget — and
	// `renderRow` turns its parts into the one string the widget hands the host.
	const all = renderRow(composeRow({ names, segments, maxChars: 120 }));
	expect("composition: every segment on one line", all === "DS cache 87% \u00b7 DS \u00a511.48 \u00b7 TS -1.0 KB", all);
	expect("composition: separators are the family's middle dot", (all.match(/\u00b7/g) ?? []).length === 2, all);

	const ordered = renderRow(composeRow({ names: ["token", "cache"], segments, maxChars: 120 }));
	expect("composition: order follows the configured list", ordered === "TS -1.0 KB \u00b7 DS cache 87%", ordered);

	const unknown = renderRow(composeRow({ names: ["cache", "nope", "token"], segments, maxChars: 120 }));
	expect("composition: unknown segment names are ignored", unknown === "DS cache 87% \u00b7 TS -1.0 KB", unknown);

	// A feature with nothing to say is absent from the map, not mapped to a placeholder.
	const absent = renderRow(composeRow({ names: ["cache", "nope"], segments, maxChars: 120 }));
	expect("composition: an absent feature contributes nothing", absent === "DS cache 87%", absent);
	const partial = renderRow(composeRow({ names, segments: { cache: "DS cache 87%", balance: undefined, token: "TS -1.0 KB" }, maxChars: 120 }));
	expect("composition: a gated-off feature is skipped, not blanked", partial === "DS cache 87% \u00b7 TS -1.0 KB", partial);

	const dropped = renderRow(composeRow({ names, segments, maxChars: 20 }));
	expect("composition: a segment that does not fit is dropped whole", dropped === "DS cache 87%", dropped);

	// The first segment has no earlier one to give up for it, so it survives composition and
	// the renderer clips it to the terminal instead: a narrow row still shows something.
	const long = composeRow({ names, segments: { cache: "x".repeat(80) }, maxChars: 40 });
	expect("composition: an over-long first segment is kept whole", long?.[0]?.[0]?.text?.length === 80, long?.[0]?.[0]?.text?.length);
	const sliced = renderRow(long, { width: 40 });
	expect("composition: a first segment longer than the row is hard-sliced", sliced.length === 40, sliced.length);

	expect("composition: nothing to show yields nothing", composeRow({ names, segments: {}, maxChars: 120 }) === undefined);
}

// ----------------------------------------------------------------- the row's tones

{
	// The host hands the widget a theme; a tone name resolves through TINTS to the role that
	// paints it. The palette below is the harness theme, spelled out so the escapes the row
	// is expected to carry are readable here.
	const ANSI = { error: "\u001b[31m", success: "\u001b[32m", warning: "\u001b[33m" };
	const theme = { fg: (role, text) => (ANSI[role] ? `${ANSI[role]}${text}\u001b[39m` : text) };
	const tint = (tone, text) => theme.fg(TINTS[tone] ?? "text", text);

	const rows = composeRow({
		names: ["cache"],
		segments: { cache: [{ text: "DS cache 87%" }, { text: "off-peak", color: "green" }] },
		maxChars: 120,
	});
	// Parts of one segment are separated exactly like segments are, so a tinted note reads
	// as part of the cache group rather than as a row of its own.
	const plain = renderRow(rows);
	expect("tones: parts of one segment are separated too", plain === "DS cache 87% \u00b7 off-peak", plain);
	expect("tones: without a tint the row is plain text", !plain.includes("\u001b"), plain);
	const painted = renderRow(rows, { tint });
	expect("tones: a green part is drawn in the theme's success colour", painted === "DS cache 87% \u00b7 \u001b[32moff-peak\u001b[39m", painted);
	const mauve = renderRow(composeRow({ names: ["cache"], segments: { cache: [{ text: "DS cache 87%", color: "mauve" }] }, maxChars: 120 }), { tint });
	expect("tones: a part whose tone the theme does not know stays plain", mauve === "DS cache 87%", mauve);
}

// ----------------------------------------------------------------- the one row

await withConfig({}, async () => {
	const host = await makeHost({ model: DEEPSEEK_MODEL });
	await host.start();
	await tick();

	// A DeepSeek session with a completed response and a rewritten tool result: all four
	// features have something to say, and all of it lands on one keyed widget — the plugin's
	// own renderer, which is what lets the row carry theme colours.
	await host.fire("before_agent_start", { systemPrompt: ["you are omp"] });
	await host.request([1, 2], [{ function: { name: "bash" } }]);
	await host.response({ input: 10_000, output: 100, cacheRead: 9_800, cacheWrite: 0, cost: { total: 0.003 } });
	await host.toolResult(`${"noise   \n".repeat(500)}`);

	expect("row: the plugin publishes exactly one widget key, ever", host.rowKeys.length === 1 && host.rowKeys[0] === STATUS_KEY, host.rowKeys);
	expect("row: the key is the plugin's own", STATUS_KEY === "omp-token-mega", STATUS_KEY);
	expect("row: cache segment present", host.row?.includes("cache"), host.row);
	expect("row: balance segment present", host.row?.includes("used $"), host.row);
	expect("row: token segment present", host.row?.includes("TS "), host.row);
	expect("row: one line, never a newline", !host.row?.includes("\n"), host.row);

	const writes = host.rowWrites.length;
	// Nothing changed between two renders: the host must not be repainted for no reason.
	await host.fire("turn_end", {});
	expect("row: an unchanged row is not rewritten", host.rowWrites.length === writes, host.rowWrites.length - writes);

	// The plugin's clear path is the same write with no content: releasing the widget is
	// what hides the row, rather than painting it empty.
	host.ctx.ui.setWidget(STATUS_KEY, undefined);
	expect("row: clearing the widget clears the row", host.row === undefined, host.row);
});

await withConfig({ statusSegments: "token" }, async () => {
	const host = await makeHost({ model: DEEPSEEK_MODEL });
	await host.start();
	await tick();
	await host.request([1, 2], [{ function: { name: "bash" } }]);
	await host.response({ input: 10_000, output: 100, cacheRead: 9_800, cacheWrite: 0, cost: { total: 0.003 } });
	expect("segments: only the configured group is drawn", host.row?.startsWith("TS ") && !host.row.includes("DS "), host.row);
});

await withConfig({ statusSegments: "nope" }, async () => {
	// No known name survives the parse, which is what an empty list resolves to; an empty
	// *string* cannot express it, because an empty environment variable means "unset".
	const host = await makeHost({ model: DEEPSEEK_MODEL });
	await host.start();
	await tick();
	expect("segments: a list with nothing usable hides the row", host.row === undefined, host.row);
});

// ----------------------------------------------------------------- the row's tint

{
	// The tariff note is the one part of the row whose meaning *is* its colour, and omp
	// strips ANSI from status text — so it can only be drawn by the plugin's own widget,
	// in the theme the host passes the factory. 2026-09-16 is a Wednesday: 02:00 UTC sits
	// inside the 01:00–04:00Z peak window and 12:00 UTC inside none, and pinning the clock
	// keeps the assertions from depending on when the suite runs.
	const peakAt = Date.UTC(2026, 8, 16, 2, 0, 0);
	const offPeakAt = Date.UTC(2026, 8, 16, 12, 0, 0);
	const realNow = Date.now;
	/** omp renders status text with ANSI stripped; colour is the only difference. */
	const strip = (text) => text.replace(/\u001b\[\d+m/g, "");

	/** The row a session on `model` publishes, read while the clock says `clock`. */
	const rowAt = async (model, clock) => {
		Date.now = () => clock;
		try {
			return await withConfig({}, async () => {
				const host = await makeHost({ model });
				await host.start();
				await tick();
				await host.request([1, 2], [{ function: { name: "bash" } }]);
				await host.response({ input: 10_000, output: 100, cacheRead: 9_800, cacheWrite: 0, cost: { total: 0.003 } });
				return { row: host.row, tint: host.tint };
			});
		} finally {
			Date.now = realNow;
		}
	};

	// The window itself is pinned string-exact in the pricing suite, which names its zone;
	// here the row has to name a dated, zoned window without this suite's own zone deciding
	// the string, so the shape is what is checked.
	const WINDOW = /\bpeak \d{4}-\d{2}-\d{2} \d{2}:\d{2}\u2013\d{4}-\d{2}-\d{2} \d{2}:\d{2} [A-Z]{2,5}\b/;
	const peak = await rowAt(SCHEDULED_MODEL, peakAt);
	expect("tint: a peak row names the window it is in, dated and zoned", WINDOW.test(peak.row ?? ""), peak.row);
	expect("tint: a peak-priced row is drawn red", peak.tint?.includes("\u001b[31mpeak "), peak.tint);
	expect("tint: the host's plain row is the tinted row without its escapes", Boolean(peak.row) && strip(peak.tint ?? "") === peak.row, peak.row);

	const offPeak = await rowAt(SCHEDULED_MODEL, offPeakAt);
	expect("tint: an off-peak row names the peak window it waits for", /\boff-peak, peak \d{4}-\d{2}-\d{2} /.test(offPeak.row ?? ""), offPeak.row);
	expect("tint: an off-peak row is drawn green", offPeak.tint?.includes("\u001b[32moff-peak"), offPeak.tint);

	// A model with no declared schedule has one price all day: both periods cost the same,
	// so there is nothing to name and nothing to tint — the row stays plain.
	const flat = await rowAt(DEEPSEEK_MODEL, offPeakAt);
	expect("tint: a row with no tariff note carries no colour at all", Boolean(flat.row) && !(flat.tint ?? "").includes("\u001b"), flat.tint);
}

// ----------------------------------------------------------------- the row's append-only advice

// The warning is earned, not decorative: it waits for a miss this session actually recorded,
// and for a provider omp will not pin the prefix on by itself. Until a request has been
// measured there is nothing to advise about, which is exactly what the row says.
await withConfig({}, async () => {
	const host = await makeHost({ model: OPENCODE_MODEL });
	await host.start();
	await tick();
	expect(
		"append-only: the cache segment is drawn, with no advice before a request is measured",
		typeof host.row === "string" && host.row.includes("cache: no requests yet") && !host.row.includes("append-only"),
		host.row,
	);

	await host.fire("before_agent_start", { systemPrompt: ["you are omp"] });
	await host.request([1, 2], [{ function: { name: "bash" } }]);
	// A response reporting no cached read is a miss — the event the advice hangs off.
	await host.response({ input: 10_000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.003 } });
	expect("append-only: a measured miss on a provider omp leaves alone draws the warning", host.row?.includes("\u26a0 append-only off"), host.row);
	expect("append-only: it is drawn as the yellow nudge, not as an error", host.tint?.includes("\u001b[33m\u26a0 append-only off"), host.tint);
	expect("append-only: the measurement it was drawn beside stays on the row", host.row?.includes("cache 0%"), host.row);
});

// `cache.appendOnly=false` is the user saying they have read the advice: the part goes, the
// measurement that produced it does not.
await withConfig({ "cache.appendOnly": false }, async () => {
	const host = await makeHost({ model: OPENCODE_MODEL });
	await host.start();
	await tick();
	await host.fire("before_agent_start", { systemPrompt: ["you are omp"] });
	await host.request([1, 2], [{ function: { name: "bash" } }]);
	await host.response({ input: 10_000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.003 } });
	expect("append-only: the setting suppresses the part, not the measurement", !host.row?.includes("append-only") && host.row?.includes("cache 0%"), host.row);
	expect("append-only: the rest of the row is untouched", host.row?.includes("GO \u00b7 used $0.00"), host.row);
});

// ----------------------------------------------------------------- segment list rules

{
	// Every group the row can compose is a documented settings group, and the default list is
	// exactly the groups the row builds — a name with no feature behind it would be a promise
	// the row never keeps.
	expect(
		"segments: every segment name is a schema-documented group",
		STATUS_SEGMENTS.every((name) => CONFIG_KEYS.some((key) => key === name || key.startsWith(`${name}.`))),
		STATUS_SEGMENTS,
	);
	expect(
		"segments: the default list is drawn from the known names",
		statusSegmentNames({ statusSegments: CONFIG_SCHEMA.statusSegments.default }).join() === STATUS_SEGMENTS.join(),
		CONFIG_SCHEMA.statusSegments.default,
	);
	expect("segments: duplicates collapse", statusSegmentNames({ statusSegments: "token,token,cache" }).join() === "token,cache");
	expect("segments: whitespace and case are tolerated", statusSegmentNames({ statusSegments: " Token , CACHE " }).join() === "token,cache");
	expect("segments: an unknown name is dropped, not rendered", statusSegmentNames({ statusSegments: "token,nope" }).join() === "token");
	// A group that no longer exists is dropped like any other unknown name: the row keeps the
	// metrics on the balance segment, so `lithos` never resolved to a segment of its own.
	expect("segments: a removed group is tolerated in a stored list", statusSegmentNames({ statusSegments: "lithos,token" }).join() === "token");
}

// ----------------------------------------------------------------- the one command

await withConfig({}, async () => {
	const host = await makeHost({ model: DEEPSEEK_MODEL });
	await host.start();
	await tick();

	expect("command: exactly one is registered", host.commands.size === 1, [...host.commands.keys()]);
	expect("command: it is /mega", host.commands.has("mega"), [...host.commands.keys()]);
	for (const legacy of ["tokens", "deepseek-cache", "deepseek-balance"]) {
		expect(`command: no legacy /${legacy}`, !host.commands.has(legacy));
	}
	expect("tool: the account tool is still exposed", [...host.tools.keys()].join() === "account_balance", [...host.tools.keys()]);

	const command = host.commands.get("mega");
	await command.handler("help", host.ctx);
	expect("command: help lists the merged surface", host.rendered.includes("/mega cache [report|doctor|fix|rollback|stability]"), host.rendered.slice(0, 600));
	expect("command: help covers lithos", host.rendered.includes("/mega lithos"));
	// The cache line is the only place a user learns the action exists, so it has to name
	// it and say what it answers.
	const cacheHelp = host.rendered.split("\n").find((line) => line.includes("/mega cache [")) ?? "";
	expect("command: help lists stability among the cache actions, and what it answers", cacheHelp.includes("stability") && cacheHelp.includes("append-only"), cacheHelp);
	await command.handler("nonsense-subcommand", host.ctx);
	expect("command: an unknown subcommand falls back to the report", host.rendered.includes("# Token Mega"), host.rendered.slice(0, 120));

	await command.handler("status", host.ctx);
	expect("command: status prints the row's text", host.notified.includes("cache") || host.notified.includes("TS "), host.notified.slice(0, 200));

	await command.handler("cache doctor", host.ctx);
	expect("command: the cache doctor is reachable", host.rendered.includes("Compat-key doctor"), host.rendered.slice(-300));

	await command.handler("balance", host.ctx);
	expect("command: the balance section is reachable", host.rendered.includes("### DeepSeek account"), host.rendered.slice(-400));

	await command.handler("lithos", host.ctx);
	expect("command: the lithos section is reachable", host.rendered.includes("### LithosAI"), host.rendered.slice(-400));

	await command.handler("config", host.ctx);
	const config = host.rendered.slice(host.rendered.indexOf("### Effective configuration"));
	for (const group of KEY_GROUPS) expect(`config: the ${group.label} group is printed`, config.includes(`**${group.label}**`));
	expect("config: every key appears", CONFIG_KEYS.every((key) => config.includes(`\`${key}`)), CONFIG_KEYS.filter((key) => !config.includes(`\`${key}`)));
});

// ----------------------------------------------------------------- prefix stability

// `/mega cache stability` answers the one question the row can only hint at: is omp holding
// the request prefix still here? On a provider its own rule covers there is nothing to do;
// on the providers it does not, the answer is a single command for the user to run — this
// plugin reports the setting and never writes it.
await withConfig({}, async () => {
	const host = await makeHost({ model: DEEPSEEK_MODEL });
	await host.start();
	await tick();
	await host.commands.get("mega").handler("cache stability", host.ctx);
	expect("stability: the block is printed under its own heading", host.rendered.includes("### Prefix stability"), host.rendered.slice(0, 200));
	expect(
		"stability: the mode is named as automatic on DeepSeek",
		host.rendered.includes("Append-only context is automatic on `deepseek/deepseek-flash`"),
		host.rendered.slice(-400),
	);
});

await withConfig({}, async () => {
	const host = await makeHost({ model: OPENCODE_MODEL });
	await host.start();
	await tick();
	await host.commands.get("mega").handler("cache stability", host.ctx);
	const text = host.rendered.slice(host.rendered.indexOf("### Prefix stability"));
	expect(
		"stability: the mode is named as not automatic on OpenCode Go",
		text.includes("Append-only context is NOT automatic on `opencode-go/deepseek-v4.1-flash`"),
		text,
	);
	expect("stability: the one command that forces it is named", text.includes("omp config set provider.appendOnlyContext on"), text);
	expect("stability: and the plugin says it never writes the setting itself", text.includes("this plugin reports the setting and never writes it"), text);
});

// ----------------------------------------------------------------- the one menu

{
	// Every key belongs to exactly one group, so the menu cannot hide a setting.
	const grouped = KEY_GROUPS.flatMap((group) => group.keys);
	expect("menu: groups cover every key exactly once", grouped.length === CONFIG_KEYS.length && new Set(grouped).size === CONFIG_KEYS.length, { grouped: grouped.length, keys: CONFIG_KEYS.length });
	expect("menu: group prefixes match their keys", KEY_GROUPS.every((group) => group.keys.every((key) => (group.prefix === "" ? !key.includes(".") : key.startsWith(group.prefix)))));
}

await withConfig({}, async () => {
	const host = await makeHost({
		model: DEEPSEEK_MODEL,
		answers: {
			// The hub, then Settings, then group "LithosAI", then the base URL key, then a new
			// value. Each option is found by its label among the ones the menu built, not by
			// guessing the wording.
			select: [
				(title, options) => options.find((label) => label.startsWith("Settings —")),
				(title, options) => options.find((label) => label.startsWith("LithosAI —")),
				(title, options) => options.find((label) => label.startsWith("lithos.baseUrl = ")),
				"Back",
				"Done",
			],
			input: ["https://engine.internal/v1"],
		},
	});
	await host.start();
	await tick();
	await host.commands.get("mega").handler("menu", host.ctx);

	const write = host.execs.at(-1);
	expect("menu: the write goes through omp's own CLI", write?.command === "omp" && write.args.slice(0, 4).join(" ") === "plugin config set @dillydalli3r/omp-token-mega", write);
	expect("menu: the key keeps its group prefix", write?.args[4] === "lithos.baseUrl", write?.args);
	expect("menu: the value is the one typed", write?.args[5] === "https://engine.internal/v1", write?.args);
	// The write went to the real CLI, so this process still reads the pinned layer: the menu
	// says so rather than pretending the value took effect (the pin here is an env var).
	expect("menu: the outcome names the key and its effective source", /lithos\.baseUrl = .*\[env\]/.test(host.notified), host.notified.slice(-220));
});

await withConfig({}, async () => {
	const host = await makeHost({
		model: DEEPSEEK_MODEL,
		answers: {
			// Clear the token preset: hub, Settings, the Token group, its preset key, "(clear)".
			select: [
				(title, options) => options.find((label) => label.startsWith("Settings —")),
				(title, options) => options.find((label) => label.startsWith("Token saving —")),
				(title, options) => options.find((label) => label.startsWith("token.preset = ")),
				"(clear)",
				"Back",
				"Done",
			],
		},
	});
	await host.start();
	await tick();
	await host.commands.get("mega").handler("menu", host.ctx);
	const clear = host.execs.at(-1);
	expect("menu: clearing a setting deletes it", clear?.args.slice(0, 5).join(" ") === "plugin config delete @dillydalli3r/omp-token-mega token.preset", clear);
});

// The hub is what a bare `/mega` opens, so every subcommand has to be reachable from it
// without the user remembering a syntax — the report and the preset switch are the two an
// action needs to reach a feature rather than the settings writer.
await withConfig({}, async () => {
	const host = await makeHost({
		model: DEEPSEEK_MODEL,
		answers: {
			select: [
				(title, options) => options.find((label) => label.startsWith("Report —")),
				(title, options) => options.find((label) => label.startsWith("Token preset —")),
				"aggressive",
				(title, options) => options.find((label) => label.startsWith("LithosAI —")),
				"Done",
			],
		},
	});
	await host.start();
	await tick();
	await host.commands.get("mega").handler("", host.ctx);
	const report = host.rendered;
	expect("hub: a bare /mega opens the menu and its report action renders the report", report.includes("# Token Mega") && report.includes("### Prefix cache"), report.slice(0, 200));
	expect("hub: a feature entry opens that feature's section", report.includes("### LithosAI"), report.slice(-260));
	const preset = host.execs.at(-1);
	expect(
		"hub: the preset action writes the chosen bundle through omp's CLI",
		preset?.args.slice(0, 5).join(" ") === "plugin config set @dillydalli3r/omp-token-mega token.preset" && preset.args[5] === "aggressive",
		preset?.args,
	);
});

await withConfig({}, async () => {
	const host = await makeHost({ model: DEEPSEEK_MODEL });
	await host.start();
	const bare = { ...host.ctx, hasUI: false };
	await host.commands.get("mega").handler("menu", bare);
	const text = host.rendered;
	expect("menu: without a dialog surface it lists the keys", text.includes("Effective configuration") && text.includes("lithos.baseUrl"), text.length);
	expect("menu: and the shell commands that change them", text.includes("omp plugin config set @dillydalli3r/omp-token-mega"), text.slice(0, 300));
});

// The tuner is the one place the plugin writes an omp setting, so what it writes, where it
// writes it and what it leaves alone are the contract this suite pins: session overrides by
// default (nothing the user owns is touched), `set` only when the user asks for a saved
// change, and a knob a human configured is advice with the command to change it.
await withConfig({}, async () => {
	const host = await makeHost({
		model: { ...OPENCODE_MODEL, contextWindow: 1_000_000 },
		coreSettings: createFakeSettings(),
		availableModels: [
			{ ...OPENCODE_MODEL, contextWindow: 1_000_000 },
			{ provider: "opencode-go", id: "muse-spark-1.3-contributor", cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 }, contextWindow: 1_048_576 },
		],
	});
	await host.start();
	await tick();
	const command = host.commands.get("mega");

	await command.handler("tune", host.ctx);
	const plan = host.rendered;
	expect("tune: the plan names the append-only knob for a gateway DeepSeek route", plan.includes("provider.appendOnlyContext"), plan.slice(0, 400));
	expect("tune: the plan explains the dollars, not the setting", plan.includes("2% of a miss"), plan.slice(0, 600));
	expect("tune: the plan offers the apply command", plan.includes("/mega tune apply"), plan.slice(-400));
	expect("tune: the plan routes delegated work to the cheaper sibling", plan.includes("opencode-go/muse-spark") && plan.includes("3.0x cheaper"), plan.slice(-700));
	expect("tune: reading the plan writes nothing", host.coreSettings.calls.length === 0, host.coreSettings.calls);

	await command.handler("tune apply", host.ctx);
	const applied = host.coreSettings.calls.filter((call) => call.method === "override");
	expect("tune apply: the knob is written as a runtime override", applied.some((call) => call.path === "provider.appendOnlyContext" && call.value === "on"), host.coreSettings.calls);
	expect("tune apply: nothing is persisted", host.coreSettings.calls.every((call) => call.method !== "set"), host.coreSettings.calls);
	expect("tune apply: the receipt says what changed", host.notified.includes("provider.appendOnlyContext"), host.notified.slice(-200));

	await command.handler("tune apply", host.ctx);
	expect("tune apply is idempotent: the second run writes nothing", host.coreSettings.calls.filter((call) => call.method === "override").length === applied.length, host.coreSettings.calls);

	await command.handler("tune revert", host.ctx);
	expect("tune revert: the override is cleared", host.coreSettings.calls.some((call) => call.method === "clearOverride" && call.path === "provider.appendOnlyContext"), host.coreSettings.calls);
	expect("tune revert: the knob reads as untouched again", host.coreSettings.get("provider.appendOnlyContext") === undefined, host.coreSettings.get("provider.appendOnlyContext"));

	await command.handler("tune save", host.ctx);
	expect("tune save: the knob is persisted instead", host.coreSettings.calls.some((call) => call.method === "set" && call.path === "provider.appendOnlyContext" && call.value === "on"), host.coreSettings.calls);
	await host.shutdown();
});

await withConfig({}, async () => {
	const settings = createFakeSettings({ initial: { "provider.appendOnlyContext": "off" }, configured: ["provider.appendOnlyContext"] });
	const host = await makeHost({ model: OPENCODE_MODEL, coreSettings: settings });
	await host.start();
	await tick();
	await host.commands.get("mega").handler("tune", host.ctx);

	expect("tune: a knob the user configured is not in the plan's changes", host.rendered.includes("yours") || host.rendered.includes("pinned"), host.rendered.slice(-500));
	expect("tune: and it carries the exact command to change it", host.rendered.includes("omp config set provider.appendOnlyContext on"), host.rendered.slice(-500));
	await host.commands.get("mega").handler("tune apply", host.ctx);
	expect("tune: applying never overwrites the user's own value", settings.get("provider.appendOnlyContext") === "off", settings.overrides);
	expect("tune: nothing was written for it", settings.overrides["provider.appendOnlyContext"] === undefined, settings.overrides);
	await host.shutdown();
});

// The report has to explain the whole plugin in one command, and the row has to carry the
// account's headroom — a quota window that is spent stops the work regardless of credit.
await withConfig({}, async () => {
	const host = await makeHost({ model: { ...OPENCODE_MODEL, contextWindow: 1_000_000 }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) } });
	await host.start();
	await tick();
	expect("row: the usage-window group is part of the default row", statusSegmentNames({ statusSegments: CONFIG_SCHEMA.statusSegments.default }).includes("window"));
	expect("row: every window group name is a documented settings group", STATUS_SEGMENTS.every((name) => CONFIG_KEYS.some((key) => key === name || key.startsWith(`${name}.`))), STATUS_SEGMENTS);
	await host.shutdown();
});

done();
