/**
 * Verifies the DeepSeek-only gate for the balance feature: no row segment, no network
 * call and no live timer on a non-DeepSeek model, and correct resume when the model
 * switches back. Also pins the money formatter and the tool/command registration.
 *
 *   node test/balance.test.mjs
 */

import { checks, makeHost, tick, withConfig } from "./harness.mjs";
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

await withConfig({}, async () => {
	const host = await makeHost({ model: { provider: "deepseek", id: "deepseek-flash", baseUrl: "https://api.deepseek.com/v1" }, modelRegistry: MODEL_REGISTRY });
	host.ctx.sessionManager.getBranch = () => [];
	await host.start();
	await tick();

	expect("deepseek: row rendered", typeof host.row === "string" && host.row.includes("DS "), host.row);
	expect("deepseek: the row rounds the balance to hundredths", host.row?.includes("$11.48") && !host.row.includes("$11.4800"), host.row);
	expect("deepseek: balance endpoint called once", fetches === 1, fetches);
	expect("deepseek: poll timer armed", host.timers.size === 1, [...host.timers.values()].map((timer) => timer.ms));

	// Switch to a non-DeepSeek model mid-session.
	host.setModel({ provider: "openai", id: "gpt-x" });
	await host.fire("turn_end", {});
	await tick();
	expect("other provider: no DeepSeek segment in the row", !host.row?.includes("DS "), host.row);
	expect("other provider: the provider-agnostic segment stays", host.row?.includes("TS"), host.row);
	expect("other provider: poll timer stopped", host.timers.size === 0, host.timers.size);

	// Even a surviving tick must not reach the network.
	const before = fetches;
	for (const [, timer] of [...host.timers.entries()]) await timer.fn();
	await tick();
	expect("other provider: no balance request", fetches === before, fetches);
	expect("other provider: still no balance segment", !host.row?.includes("DS bal"), host.row);

	// Switch back: the segment returns and the poller re-arms.
	host.setModel({ provider: "deepseek", id: "deepseek-flash", baseUrl: "https://api.deepseek.com/v1" });
	await host.fire("turn_end", {});
	await tick();
	expect("switched back: row rendered again", typeof host.row === "string" && host.row.includes("DS "), host.row);
	expect("switched back: poll timer re-armed", host.timers.size === 1, host.timers.size);

	await host.shutdown();
	expect("shutdown: timer released", host.timers.size === 0, host.timers.size);

	expect("command registered", host.commands.has("mega"));
	expect("tool registered", host.tools.has("deepseek_balance"));

	// The one tool reports for the model, and never claims a balance when nothing is active.
	const tool = host.tools.get("deepseek_balance");
	expect("tool returns the balance section", String((await tool.execute("1", {}, undefined, undefined, host.ctx)).content[0].text).includes("DeepSeek account"));
	host.setModel({ provider: "openai", id: "gpt-x" });
	expect("non-deepseek report refuses", String((await tool.execute("1", {}, undefined, undefined, host.ctx)).content[0].text).includes("No DeepSeek model"));
});

// Amounts render every decimal place of their precision, used or not.
expect("money: trailing zeros kept", money(11.48) === "11.4800" && money(0.1) === "0.1000");
expect("money: sub-cent keeps six places", money(0.0041) === "0.004100");
expect("money: zero never renders a sign", money(0) === "0.0000" && money(-0.0000001) === "0.000000");
// The row's precision, pinned by the caller: currency, not a ledger figure.
expect("money: hundredths round both ways", money(11.48, 2) === "11.48" && money(0.005892, 2) === "0.01", money(0.005892, 2));
expect("money: hundredths still drop a rounded-away sign", money(0.0041, 2) === "0.00" && money(-0.004, 2) === "0.00", money(-0.004, 2));

done();
