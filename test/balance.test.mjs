/**
 * Verifies the account feature on every model it speaks for: DeepSeek shows its polled
 * balance tagged `DS` plus the session cost, every other cache-capable provider shows the
 * same cost under its own tag and calls nothing (only DeepSeek publishes a balance
 * endpoint), and a model this plugin cannot speak for gets no segment, no call and no
 * timer. Also pins the credit state the wire does carry on LithosAI, that a model
 * registered with no rates reads as unpriced rather than free, and the money formatter.
 *
 *   node test/balance.test.mjs
 */

import { checks, GEMINI_MODEL, makeHost, OPENCODE_MODEL, tick, UNCACHED_MODEL, UNPRICED_MODEL, withConfig } from "./harness.mjs";
import { LITHOS_BASE_URL } from "../src/lithosai.js";
import { money } from "../src/measure.js";

const { expect, done } = checks();

let fetches = 0;
globalThis.fetch = async () => {
	fetches += 1;
	return new Response(
		JSON.stringify({
			is_available: true,
			balance_infos: [{ currency: "USD", total_balance: "11.48", granted_balance: "0", topped_up_balance: "11.48" }],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
};

const MODEL_REGISTRY = {
	getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test" }),
	getProviderBaseUrl: () => "https://api.deepseek.com/v1",
};

/** A DeepSeek registration as omp hands it over: id, base URL and the declared tariff. */
const DEEPSEEK_MODEL = {
	provider: "deepseek",
	id: "deepseek-flash",
	baseUrl: "https://api.deepseek.com/v1",
	cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
};

/** A LithosAI registration: no `cost` on the model is needed, the published card prices it. */
const KIMI = { provider: "lithosai", id: "moonshotai/Kimi-K3", baseUrl: LITHOS_BASE_URL };

/** One assistant turn and one `task` child, as the session branch records them. */
const BRANCH = [
	{ type: "message", message: { role: "assistant", usage: { input: 100_000, cacheRead: 20_000, output: 10_000, cost: { total: 0.84 } } } },
	{ type: "message", message: { role: "toolResult", toolName: "task", details: { usage: { input: 20_000, output: 1_000, cost: { total: 0.16 } } } } },
];

// ----------------------------------------------------------------- DeepSeek

await withConfig({}, async () => {
	fetches = 0;
	const host = await makeHost({ model: DEEPSEEK_MODEL, modelRegistry: MODEL_REGISTRY });
	host.ctx.sessionManager.getBranch = () => BRANCH;
	await host.start();
	await tick();

	expect("deepseek: row rendered", typeof host.row === "string" && host.row.includes("DS "), host.row);
	expect("deepseek: the row rounds the balance to hundredths", host.row?.includes("$11.48") && !host.row.includes("$11.4800"), host.row);
	expect("deepseek: balance endpoint called once", fetches === 1, fetches);
	expect("deepseek: poll timer armed", host.timers.size === 1, [...host.timers.values()].map((timer) => timer.ms));
	// The cost figure is the same one LithosAI shows; the DS tag belongs to the balance alone.
	expect(
		"deepseek: the session cost rides the same row",
		host.row?.includes("used $1.00 (main $0.84 + agents $0.16)") && !host.row.includes("DS $1.00"),
		host.row,
	);

	// Switch to a provider this plugin can say nothing about mid-session.
	host.setModel(UNCACHED_MODEL);
	await host.fire("turn_end", {});
	await tick();
	expect("uncacheable provider: no account segment in the row", !host.row?.includes("DS ") && !host.row?.includes("used $"), host.row);
	expect("uncacheable provider: the provider-agnostic segment stays", host.row?.includes("TS"), host.row);
	expect("uncacheable provider: poll timer stopped", host.timers.size === 0, host.timers.size);

	// Even a surviving tick must not reach the network.
	const before = fetches;
	for (const [, timer] of [...host.timers.entries()]) await timer.fn();
	await tick();
	expect("uncacheable provider: no balance request", fetches === before, fetches);
	expect("uncacheable provider: still no balance segment", !host.row?.includes("DS bal"), host.row);

	// Switch back: the segment returns and the poller re-arms.
	host.setModel(DEEPSEEK_MODEL);
	await host.fire("turn_end", {});
	await tick();
	expect("switched back: row rendered again", typeof host.row === "string" && host.row.includes("DS "), host.row);
	expect("switched back: poll timer re-armed", host.timers.size === 1, host.timers.size);

	await host.shutdown();
	expect("shutdown: timer released", host.timers.size === 0, host.timers.size);

	expect("command registered", host.commands.has("mega"));
	expect("tool registered", host.tools.has("account_balance"));

	// The one tool reports for the model, and never claims an account when none is priced.
	const tool = host.tools.get("account_balance");
	expect("tool returns the balance section", String((await tool.execute("1", {}, undefined, undefined, host.ctx)).content[0].text).includes("DeepSeek account"));
	host.setModel(UNCACHED_MODEL);
	const refused = String((await tool.execute("1", {}, undefined, undefined, host.ctx)).content[0].text);
	expect(
		"uncacheable report refuses rather than inventing an account",
		refused.includes("No cache-capable model is active") && refused.includes("some-proxy/gpt-x"),
		refused.slice(0, 200),
	);
});

// ----------------------------------------------------------------- DeepSeek, poller off

await withConfig({ "balance.enabled": false }, async () => {
	fetches = 0;
	const host = await makeHost({ model: DEEPSEEK_MODEL, modelRegistry: MODEL_REGISTRY });
	host.ctx.sessionManager.getBranch = () => BRANCH;
	await host.start();
	await tick();

	// The switch governs the poller, not the cost: no request, no phantom balance figure.
	expect("poller off: no balance request", fetches === 0, fetches);
	expect("poller off: no balance segment", !host.row?.includes("DS bal") && !host.row?.includes("$11.48"), host.row);
	expect("poller off: the session cost stays", host.row?.includes("used $1.00"), host.row);
	await host.shutdown();
});

// ----------------------------------------------------------------- LithosAI

await withConfig({}, async () => {
	fetches = 0;
	const host = await makeHost({ model: KIMI });
	host.ctx.sessionManager.getBranch = () => BRANCH;
	await host.start();
	await tick();

	// No balance endpoint exists to call: the credit is console-only, so the feature must
	// not invent a URL or arm a poller for it — the row carries cost and nothing else.
	expect("lithosai: no balance request", fetches === 0, fetches);
	expect("lithosai: no poll timer", host.timers.size === 0, host.timers.size);
	// The same segment DeepSeek draws, minus the figure its API does not publish: the tag and
	// the cost, in DeepSeek's order.
	expect("lithosai: the tag rides where DS sits, with the same cost figure", host.row?.includes("LITHOS \u00b7 used $1.00 (main $0.84 + agents $0.16)") && !host.row.includes("DS"), host.row);

	const tool = host.tools.get("account_balance");
	const section = async () => String((await tool.execute("1", {}, undefined, undefined, host.ctx)).content[0].text);
	const first = await section();
	expect("lithosai: the section is titled for the provider", first.includes("### LithosAI account"), first.slice(0, 120));
	expect("lithosai: it names the console, not a phantom endpoint", first.includes("no balance endpoint") && first.includes("console.lithosai.cloud/billing"), first.slice(0, 700));
	expect("lithosai: the published rates price the session", first.includes("$2.4/Mtok in") && first.includes("(published)"), first.slice(0, 900));
	expect("lithosai: the same cost table as DeepSeek", first.includes("| main | 0.8400 | 100,000 | 10,000 | 20,000 | 1 |") && first.includes("| agents | 0.1600 | 20,000 | 1,000 | 0 | 1 |"), first);
	expect("lithosai: the hit rate is computed from the same usage", first.includes("Prefix cache hit rate: **17%** (1/1 requests)"), first);
	expect("lithosai: no response seen yet says exactly that", first.includes("No response observed in this session yet"), first);

	// The credit state the wire does carry.
	await host.fire("after_provider_response", { status: 402 });
	const out = await section();
	expect("lithosai: a 402 reports exhaustion and points at the console", out.includes("HTTP 402") && out.includes("Exhausted"), out.slice(0, 700));
	await host.fire("after_provider_response", { status: 200 });
	const admitted = await section();
	expect("lithosai: an admitted response reports the balance is above zero", admitted.includes("so the balance is not zero"), admitted.slice(0, 700));
	await host.fire("after_provider_response", { status: 500 });
	const refused = await section();
	expect("lithosai: any other refusal claims nothing about the balance", refused.includes("says nothing about the balance"), refused.slice(0, 700));

	// The credit line follows the live model, not the last LithosAI response seen.
	host.setModel(UNCACHED_MODEL);
	const off = await section();
	expect("lithosai: switching away drops the account, not just the segment", off.includes("No cache-capable model is active"), off.slice(0, 200));

	// An id nobody has priced reports that, instead of the $0.00 that reads as free.
	host.setModel({ provider: "lithosai", id: "zai/GLM-5.3", baseUrl: LITHOS_BASE_URL });
	host.ctx.sessionManager.getBranch = () => [];
	await host.fire("turn_end", {});
	await tick();
	expect("unpriced LithosAI id: the row says n/a rather than $0.00", host.row?.includes("used n/a (rates unset)"), host.row);
	expect("unpriced LithosAI id: no balance request either", fetches === 0, fetches);
	await host.shutdown();
});

// ----------------------------------------------------------------- every other provider it speaks for

// The tag names the account the session is spending, so an OpenCode Go or Google session
// draws its own where a DeepSeek session draws `DS` — the same figures after it, and the
// same absence of a balance figure, because DeepSeek's is the only endpoint this plugin
// reads. Each is priced from the branch the same way, so the `used $` figure is identical.
for (const [label, model, tag, title] of [
	["opencode-go", OPENCODE_MODEL, "GO", "OpenCode Go"],
	["google", GEMINI_MODEL, "GEMINI", "Google Gemini"],
]) {
	await withConfig({}, async () => {
		fetches = 0;
		const host = await makeHost({ model });
		host.ctx.sessionManager.getBranch = () => BRANCH;
		await host.start();
		await tick();

		expect(`${label}: the row draws its own tag and the branch's cost`, host.row?.includes(`${tag} \u00b7 used $1.00 (main $0.84 + agents $0.16)`), host.row);
		expect(`${label}: no balance request`, fetches === 0, fetches);
		expect(`${label}: no poll timer`, host.timers.size === 0, host.timers.size);

		const tool = host.tools.get("account_balance");
		const report = String((await tool.execute("1", {}, undefined, undefined, host.ctx)).content[0].text);
		expect(`${label}: the section is titled for the account`, report.startsWith(`### ${title} account`), report.slice(0, 120));
		expect(`${label}: it says the account surface is not polled`, report.includes(`not polled by this plugin for \`${model.provider}\``), report.slice(0, 700));
		expect(`${label}: the same session table as DeepSeek`, report.includes("| main | 0.8400 | 100,000 | 10,000 | 20,000 | 1 |"), report);
		await host.shutdown();
	});
}

// ----------------------------------------------------------------- DeepSeek → Google

// The poller is gated on DeepSeek alone, so a switch to another account this plugin *does*
// speak for has to stop it: the Google session keeps its segment and its cost, and the
// DeepSeek endpoint is not called again even by a tick that was already scheduled.
await withConfig({}, async () => {
	fetches = 0;
	const host = await makeHost({ model: DEEPSEEK_MODEL, modelRegistry: MODEL_REGISTRY });
	await host.start();
	await tick();
	expect("switch to google: the poller is armed first", host.timers.size === 1, host.timers.size);

	const armed = [...host.timers.values()][0];
	host.setModel(GEMINI_MODEL);
	await host.fire("turn_end", {});
	await tick();
	expect("switch to google: the poller stops", host.timers.size === 0, host.timers.size);
	expect("switch to google: the row keeps the account, under Google's tag", host.row?.includes("GEMINI \u00b7"), host.row);

	const before = fetches;
	await armed.fn();
	await tick();
	expect("switch to google: a surviving tick issues no request", fetches === before, fetches);
	await host.shutdown();
});

// ----------------------------------------------------------------- unpriced

// A model registered with no rates at all must read as unpriced, never as the `$0.00` that
// reads as a free session: the row says the rates are unset, and the section says in words
// what the zero cost means.
await withConfig({}, async () => {
	fetches = 0;
	const host = await makeHost({ model: UNPRICED_MODEL });
	host.ctx.sessionManager.getBranch = () => BRANCH;
	await host.start();
	await tick();

	expect("unpriced: the row says the rates are unset, not $0.00", host.row?.includes("GO \u00b7 used n/a (rates unset)") && !host.row.includes("used $0.00"), host.row);
	expect("unpriced: no balance request", fetches === 0, fetches);

	const tool = host.tools.get("account_balance");
	const report = String((await tool.execute("1", {}, undefined, undefined, host.ctx)).content[0].text);
	expect("unpriced: the section still titles the account", report.startsWith("### OpenCode Go account"), report.slice(0, 120));
	expect(
		"unpriced: the section says in words what the zero cost means",
		report.includes("Costs read $0 because this model is registered with no rates; the token columns are unaffected."),
		report.slice(-300),
	);
	await host.shutdown();
});

// Amounts render every decimal place of their precision, used or not.
expect("money: trailing zeros kept", money(11.48) === "11.4800" && money(0.1) === "0.1000");
expect("money: sub-cent keeps six places", money(0.0041) === "0.004100");
expect("money: zero never renders a sign", money(0) === "0.0000" && money(-0.0000001) === "0.000000");
// The row's precision, pinned by the caller: currency, not a ledger figure.
expect("money: hundredths round both ways", money(11.48, 2) === "11.48" && money(0.005892, 2) === "0.01", money(0.005892, 2));
expect("money: hundredths still drop a rounded-away sign", money(0.0041, 2) === "0.00" && money(-0.004, 2) === "0.00", money(-0.004, 2));

done();