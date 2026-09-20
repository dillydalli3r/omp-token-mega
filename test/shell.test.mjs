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

import { checks, DEEPSEEK_MODEL, makeHost, SCHEDULED_MODEL, STATUS_KEY, tick, withConfig } from "./harness.mjs";
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
	const absent = renderRow(composeRow({ names: ["cache", "lithos"], segments, maxChars: 120 }));
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
	expect("row: cache segment present", host.row?.includes("DS cache"), host.row);
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

	const peak = await rowAt(SCHEDULED_MODEL, peakAt);
	expect("tint: a peak row names the window it is in", peak.row?.includes("peak 01:00\u201304:00Z"), peak.row);
	expect("tint: a peak-priced row is drawn red", peak.tint?.includes("\u001b[31mpeak "), peak.tint);
	expect("tint: the host's plain row is the tinted row without its escapes", Boolean(peak.row) && strip(peak.tint ?? "") === peak.row, peak.row);

	const offPeak = await rowAt(SCHEDULED_MODEL, offPeakAt);
	expect("tint: an off-peak row names the peak window it waits for", offPeak.row?.includes("off-peak (peak "), offPeak.row);
	expect("tint: an off-peak row is drawn green", offPeak.tint?.includes("\u001b[32moff-peak"), offPeak.tint);

	// A model with no declared schedule has one price all day: both periods cost the same,
	// so there is nothing to name and nothing to tint — the row stays plain.
	const flat = await rowAt(DEEPSEEK_MODEL, offPeakAt);
	expect("tint: a row with no tariff note carries no colour at all", Boolean(flat.row) && !(flat.tint ?? "").includes("\u001b"), flat.tint);
}

// ----------------------------------------------------------------- segment list rules

{
	expect("segments: every segment name is a schema-documented group", STATUS_SEGMENTS.every((name) => ["cache", "lithos", "balance", "token"].includes(name)), STATUS_SEGMENTS);
	expect(
		"segments: the default list is drawn from the known names",
		statusSegmentNames({ statusSegments: CONFIG_SCHEMA.statusSegments.default }).join() === STATUS_SEGMENTS.join(),
		CONFIG_SCHEMA.statusSegments.default,
	);
	expect("segments: duplicates collapse", statusSegmentNames({ statusSegments: "token,token,cache" }).join() === "token,cache");
	expect("segments: whitespace and case are tolerated", statusSegmentNames({ statusSegments: " Token , CACHE " }).join() === "token,cache");
	expect("segments: an unknown name is dropped, not rendered", statusSegmentNames({ statusSegments: "token,nope" }).join() === "token");
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
	expect("tool: the balance tool is still exposed", [...host.tools.keys()].join() === "deepseek_balance", [...host.tools.keys()]);

	const command = host.commands.get("mega");
	await command.handler("help", host.ctx);
	expect("command: help lists the merged surface", host.rendered.includes("/mega cache [doctor|fix|rollback]"), host.rendered.slice(0, 600));
	expect("command: help covers lithos", host.rendered.includes("/mega lithos"));
	await command.handler("nonsense-subcommand", host.ctx);
	expect("command: an unknown subcommand falls back to the report", host.rendered.includes("# Token Mega"), host.rendered.slice(0, 120));

	await command.handler("status", host.ctx);
	expect("command: status prints the row's text", host.notified.includes("DS cache") || host.notified.includes("TS "), host.notified.slice(0, 200));

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
			// Group "LithosAI", then the base URL key, then a new value. The key is found by
			// its label among the options the menu built, not by guessing the wording.
			select: [
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
			// Clear the token preset: pick the Token group, its preset key, then "(clear)".
			select: [
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

await withConfig({}, async () => {
	const host = await makeHost({ model: DEEPSEEK_MODEL });
	await host.start();
	const bare = { ...host.ctx, hasUI: false };
	await host.commands.get("mega").handler("menu", bare);
	const text = host.rendered;
	expect("menu: without a dialog surface it lists the keys", text.includes("Effective configuration") && text.includes("lithos.baseUrl"), text.length);
	expect("menu: and the shell commands that change them", text.includes("omp plugin config set @dillydalli3r/omp-token-mega"), text.slice(0, 300));
});

done();
