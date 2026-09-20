/**
 * Verifies the LithosAI half: the provider registration and its `/login` flow, the
 * header-to-usage normalization, and the metrics the plugin draws from them.
 *
 * The provider contract is checked against LithosAI's published API
 * (https://docs.lithosai.com): `https://api.lithosai.cloud/v1`, bearer key, `/models` for
 * discovery, and the `x-ratelimit-*` header set on any response whose budgets were
 * consulted.
 *
 *   node test/lithosai.test.mjs
 */

import { checks, makeHost, tick, withConfig } from "./harness.mjs";
import { LITHOS_BASE_URL, LITHOS_KEY_ENV, LITHOS_PROVIDER, loginLithos, parseBudgets, parseRateLimitHeaders, validateKey } from "../src/lithosai.js";

const { expect, done } = checks();

const HEADERS = {
	"x-ratelimit-limit-requests": "60",
	"x-ratelimit-remaining-requests": "58",
	"x-ratelimit-reset-requests": "1s",
	"x-ratelimit-limit-tokens": "256000",
	"x-ratelimit-remaining-tokens": "131072",
	"x-ratelimit-reset-tokens": "0s",
};

const LITHOS_MODEL = { provider: LITHOS_PROVIDER, id: "moonshotai/Kimi-K3", baseUrl: LITHOS_BASE_URL };

// ----------------------------------------------------------------- header parsing

{
	const budgets = parseBudgets(HEADERS);
	expect("budgets: request bucket read", budgets?.requests.limit === 60 && budgets.requests.remaining === 58, budgets?.requests);
	expect("budgets: token bucket read", budgets?.tokens.limit === 256000 && budgets.tokens.remaining === 131072, budgets?.tokens);
	expect("budgets: reset strings kept verbatim", budgets?.requests.reset === "1s" && budgets.tokens.reset === "0s");
	expect("budgets: a response without them yields nothing", parseBudgets({ "content-type": "application/json" }) === undefined);
	expect("budgets: retry advice prefers milliseconds", parseBudgets({ ...HEADERS, "retry-after-ms": "1500", "retry-after": "9" })?.retryAfterMs === 1500);
	expect("budgets: seconds are converted when milliseconds are absent", parseBudgets({ ...HEADERS, "retry-after": "9" })?.retryAfterMs === 9000);
	expect("budgets: x-should-retry false is surfaced", parseBudgets({ ...HEADERS, "x-should-retry": "false" })?.shouldRetry === false);

	const report = parseRateLimitHeaders(HEADERS, 1_000);
	expect("usage report: provider id", report?.provider === LITHOS_PROVIDER, report?.provider);
	expect("usage report: two limits", report?.limits.length === 2, report?.limits);
	const requests = report?.limits.find((limit) => limit.id === "requests");
	// A balance, not a countdown: used is derived from the reported remaining.
	expect("usage report: requests limit is limit-minus-remaining", requests?.amount.used === 2 && requests.amount.limit === 60, requests?.amount);
	expect("usage report: limit is scoped to the provider", requests?.scope.provider === LITHOS_PROVIDER, requests?.scope);
	expect("usage report: empty headers yield null", parseRateLimitHeaders({}, 1) === null);
	expect("usage report: a bucket pair without its limit is dropped", parseRateLimitHeaders({ "x-ratelimit-remaining-requests": "5" }, 1) === null);
}

// ----------------------------------------------------------------- key validation

{
	const ok = await validateKey("k", {
		fetchImpl: async (url, init) => {
			expect("validate: hits /models on the configured base", url === `${LITHOS_BASE_URL}/models`, url);
			expect("validate: sends the bearer header", init.headers.Authorization === "Bearer k", init.headers);
			return { ok: true, status: 200, json: async () => ({ object: "list", data: [{ id: "moonshotai/Kimi-K3" }, { id: "zai/GLM-5.3" }] }) };
		},
	});
	expect("validate: accepted key lists models", ok.ok === true && ok.models.length === 2, ok);

	const refused = await validateKey("bad", { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
	expect("validate: 401 is a refusal with a status", refused.ok === false && refused.status === 401, refused);

	const offline = await validateKey("k", {
		fetchImpl: async () => {
			throw new Error("getaddrinfo ENOTFOUND");
		},
	});
	expect("validate: transport failure is not a refusal", offline.ok === false && offline.status === undefined && /ENOTFOUND/.test(offline.error), offline);
}

// ----------------------------------------------------------------- login flow

{
	const prompts = [];
	const progress = [];
	const accepted = await loginLithos(
		{
			onProgress: (message) => progress.push(message),
			onPrompt: async (prompt) => {
				prompts.push(prompt);
				return "  key-from-console  ";
			},
			fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "moonshotai/Kimi-K3" }] }) }),
		},
		{ baseUrl: LITHOS_BASE_URL },
	);
	expect("login: key is masked at the prompt", prompts[0]?.secret === true, prompts[0]);
	expect("login: the key is trimmed and returned as a string", accepted === "key-from-console", accepted);
	expect("login: progress names the console", progress[0]?.includes("console.lithosai.cloud/keys"), progress[0]);
	expect("login: progress reports the model count", progress.some((line) => line.includes("1 model(s)")), progress);

	let rejected;
	try {
		await loginLithos(
			{ onProgress() {}, onPrompt: async () => "revoked", fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) },
			{ baseUrl: LITHOS_BASE_URL },
		);
	} catch (error) {
		rejected = error.message;
	}
	expect("login: a 401 is fatal and says so", typeof rejected === "string" && rejected.includes("rejected"), rejected);

	const offline = await loginLithos(
		{
			onProgress: () => {},
			onPrompt: async () => "unverifiable",
			fetch: async () => {
				throw new Error("ENOTFOUND");
			},
		},
		{ baseUrl: LITHOS_BASE_URL },
	);
	expect("login: an unreachable endpoint still stores the key", offline === "unverifiable", offline);

	let empty;
	try {
		await loginLithos({ onProgress() {}, onPrompt: async () => "   " }, { baseUrl: LITHOS_BASE_URL });
	} catch (error) {
		empty = error.message;
	}
	expect("login: an empty answer is refused", typeof empty === "string" && empty.includes("no LithosAI API key"), empty);
}

// ----------------------------------------------------------------- registration and metrics

await withConfig({}, async () => {
	const host = await makeHost({ model: LITHOS_MODEL });
	await host.start();
	await tick();

	const provider = host.providers.get(LITHOS_PROVIDER);
	expect("provider: registered under the lithosai id", Boolean(provider), [...host.providers.keys()]);
	expect("provider: endpoint is the documented base URL", provider?.config.baseUrl === LITHOS_BASE_URL, provider?.config.baseUrl);
	expect("provider: OpenAI-compatible transport", provider?.config.api === "openai-completions", provider?.config.api);
	expect("provider: key comes from the documented env var", provider?.config.apiKey === LITHOS_KEY_ENV, provider?.config.apiKey);
	expect("provider: /login entry is named", provider?.config.oauth?.name === "LithosAI", provider?.config.oauth?.name);
	expect("provider: the documented model is declared", provider?.config.models?.some((model) => model.id === "moonshotai/Kimi-K3"), provider?.config.models?.map((model) => model.id));
	expect("provider: usage reporting is wired", typeof provider?.config.usage?.parseRateLimitHeaders === "function");
	expect("provider: cost is zero until rates are set", provider?.config.models?.every((model) => model.cost.input === 0), provider?.config.models?.[0]?.cost);

	// Dynamic discovery is what fills the catalogue once a key exists.
	expect("discovery: without a key nothing is fetched", (await provider.config.fetchDynamicModels(undefined)).length === 0);

	// No response yet: the segment says so rather than inventing numbers.
	expect("segment: present and honest before any request", host.row?.includes("LITHOS") && host.row.includes("ready"), host.row);

	// A response whose budgets were consulted.
	await host.fire("after_provider_response", { status: 200, headers: HEADERS, requestId: "r1" });
	expect("segment: budget buckets appear", host.row?.includes("req 58/60") && host.row.includes("tok 131k/256k"), host.row);

	// Speed is measured, not assumed: 400 output tokens over a 500 ms stream.
	const realNow = Date.now;
	let clock = realNow();
	Date.now = () => clock;
	try {
		await host.fire("after_provider_response", { status: 200, headers: HEADERS });
		clock += 500;
		await host.fire("message_end", { message: { role: "assistant", usage: { input: 1000, output: 400, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
	} finally {
		Date.now = realNow;
	}
	expect("speed: 400 tokens in 500 ms reads as 800 tok/s", host.row?.includes("800 tok/s"), host.row);

	// A refusal is visible, with the advice the docs say to prefer.
	await host.fire("after_provider_response", { status: 429, headers: { ...HEADERS, "retry-after-ms": "2000", "x-should-retry": "false" } });
	expect("segment: refusal and retry advice", host.row?.includes("\u2717 429") && host.row.includes("retry 2s"), host.row);

	await host.commands.get("mega").handler("lithos", host.ctx);
	const report = host.rendered;
	expect("report: names the endpoint", report.includes(LITHOS_BASE_URL));
	expect("report: states the rates are unset rather than faking cost", report.includes("not configured"), report.slice(0, 400));
	expect("report: reports the measured speed", /p50 800 tok\/s/.test(report), report.slice(0, 900));
	expect("report: explains the buckets are balances", report.includes("refill continuously"));
	expect("report: surfaces the last refusal", report.includes("HTTP 429"));

	// The host's own usage path parses the same headers through the registered provider.
	const native = provider.config.usage.parseRateLimitHeaders(HEADERS, 2_000);
	expect("native usage: same two limits", native?.limits.length === 2, native?.limits);

	// On another provider nothing is measured and no segment is drawn.
	host.setModel({ provider: "openai", id: "gpt-x" });
	await host.fire("message_end", { message: { role: "assistant", usage: { input: 10, output: 10 } } });
	expect("gate: no lithos segment on another provider", !host.row?.includes("LITHOS"), host.row);
	await host.commands.get("mega").handler("lithos", host.ctx);
	expect("gate: the section explains how to sign in", host.rendered.includes(`/login ${LITHOS_PROVIDER}`), host.rendered.slice(-600));

	// Config-driven rates reach the registration.
	host.setModel(LITHOS_MODEL);
	await host.commands.get("mega").handler("config", host.ctx);
	expect("config: lithos keys are surfaced", host.rendered.includes("lithos.inputPerMillion"), host.rendered.slice(0, 200));
});

// ----------------------------------------------------------------- rates

await withConfig({ "lithos.inputPerMillion": 0.6, "lithos.outputPerMillion": 2.4, "lithos.cachedPerMillion": 0.06 }, async () => {
	const host = await makeHost({ model: LITHOS_MODEL });
	await host.start();
	await tick();
	const provider = host.providers.get(LITHOS_PROVIDER);
	expect("rates: configured rates reach the model cost", provider?.config.models?.[0]?.cost.input === 0.6 && provider.config.models[0].cost.cacheRead === 0.06, provider?.config.models?.[0]?.cost);
	expect("rates: output rate carried too", provider?.config.models?.[0]?.cost.output === 2.4, provider?.config.models?.[0]?.cost);
});

done();
