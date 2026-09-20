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
	// The registered key is the variable's VALUE, or nothing at all — never the name. The
	// dedicated block below pins both states; this run takes the environment as it finds it.
	expect("provider: the key is never the variable name", provider?.config.apiKey !== LITHOS_KEY_ENV, provider?.config.apiKey);
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

// ----------------------------------------------------------------- the key, and discovery

{
	// `LITHOSAI_API_KEY` is not a plugin setting, so `withEnv`/`withConfig` never pin it.
	// Each case below sets it itself and restores it here, so a machine that happens to
	// export the variable cannot decide the outcome of any of them.
	const ambient = process.env[LITHOS_KEY_ENV];
	try {
		// Unset, no stored login: no key exists anywhere, so none is registered. That
		// absence is what stops omp from reporting `lithosai` as signed in on a bare install.
		delete process.env[LITHOS_KEY_ENV];
		await withConfig({}, async () => {
			const host = await makeHost({ model: LITHOS_MODEL });
			await host.start();
			await tick();
			const provider = host.providers.get(LITHOS_PROVIDER);
			expect("env key: unset registers no apiKey at all", !("apiKey" in provider.config), provider?.config.apiKey);

			// Nothing to discover without a key, and no request goes out to discover it.
			const realFetch = globalThis.fetch;
			let calls = 0;
			globalThis.fetch = async () => {
				calls += 1;
				throw new Error("discovery must not reach the network without a key");
			};
			try {
				expect("discovery: no key resolves to an empty catalogue", (await provider.config.fetchDynamicModels(undefined)).length === 0);
				expect("discovery: no key touches no network", calls === 0, calls);
			} finally {
				globalThis.fetch = realFetch;
			}
		});

		// Set: the registered key is the variable's value, and `/models` fills the catalogue
		// through it, at the configured rates.
		process.env[LITHOS_KEY_ENV] = "lithos-test-key";
		await withConfig({ "lithos.inputPerMillion": 0.6, "lithos.outputPerMillion": 2.4, "lithos.cachedPerMillion": 0.06 }, async () => {
			const host = await makeHost({ model: LITHOS_MODEL });
			await host.start();
			await tick();
			const provider = host.providers.get(LITHOS_PROVIDER);
			expect("env key: the variable's value is registered, not its name", provider?.config.apiKey === "lithos-test-key", provider?.config.apiKey);

			const realFetch = globalThis.fetch;
			globalThis.fetch = async (url, init) => {
				expect("discovery: reads /models on the configured base", url === `${LITHOS_BASE_URL}/models`, url);
				expect("discovery: presents the key as a bearer token", init?.headers?.Authorization === "Bearer lithos-test-key", init?.headers);
				return {
					ok: true,
					status: 200,
					json: async () => ({
						object: "list",
						data: [
							{ id: "moonshotai/Kimi-K3", object: "model", created: 1, owned_by: "Moonshot AI" },
							{ id: "zai/GLM-5.3", object: "model", created: 1, owned_by: "Z.ai" },
						],
					}),
				};
			};
			try {
				const models = await provider.config.fetchDynamicModels("lithos-test-key");
				expect(
					"discovery: both live ids, at the configured rates and limits",
					models.map((model) => model.id).join(",") === "moonshotai/Kimi-K3,zai/GLM-5.3" &&
						models.every((model) => model.cost.input === 0.6 && model.cost.output === 2.4 && model.cost.cacheRead === 0.06) &&
						models.every((model) => model.contextWindow > 0 && model.maxTokens > 0),
					models,
				);
			} finally {
				globalThis.fetch = realFetch;
			}

			// A refusal is thrown, not reported as an empty catalogue: omp keeps the cached
			// catalogue and retries after a rejection, but an empty success is authoritative.
			globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: "invalid key" }) });
			try {
				let thrown;
				try {
					await provider.config.fetchDynamicModels("lithos-test-key");
				} catch (error) {
					thrown = error;
				}
				expect("discovery: a 401 rejects instead of returning an empty list", thrown instanceof Error && thrown.message.includes("401"), thrown?.message);
			} finally {
				globalThis.fetch = realFetch;
			}
		});
	} finally {
		if (ambient === undefined) delete process.env[LITHOS_KEY_ENV];
		else process.env[LITHOS_KEY_ENV] = ambient;
	}
}

// ----------------------------------------------------------------- the catalogue

{
	// What LithosAI's own `/v1/models` answered, in its own order. The registration has to
	// declare all of it: omp runs discovery *after* the provider loads and treats a failed
	// fetch as "keep what you have", so a catalogue of one model leaves an install whose
	// endpoint is unreachable — a filtered resolver, a machine offline, no key yet —
	// choosing between one model and none.
	const SERVED = [
		"deepseek-ai/DeepSeek-V4.1-Flash",
		"moonshotai/Kimi-K3",
		"moonshotai/Kimi-K3-fast",
		"moonshotai/Kimi-K3-ultra",
	];

	const ambient = process.env[LITHOS_KEY_ENV];
	process.env[LITHOS_KEY_ENV] = "lithos-test-key";
	try {
		await withConfig({}, async () => {
			const host = await makeHost({ model: LITHOS_MODEL });
			await host.start();
			await tick();
			const provider = host.providers.get(LITHOS_PROVIDER);
			const declared = provider.config.models.map((model) => model.id);
			expect("catalogue: every served id is declared, in the service's order", declared.join(",") === SERVED.join(","), declared);
			// The model the user asked for by name, and the name the console gives it.
			const deepseek = provider.config.models.find((model) => model.id === "deepseek-ai/DeepSeek-V4.1-Flash");
			expect("catalogue: DeepSeek V4.1 Flash is declared with its console name", deepseek?.name === "DeepSeek V4.1 Flash on LithosAI", deepseek);
			expect("catalogue: every entry is loadable as-is", provider.config.models.every((model) => model.name && model.contextWindow > 0 && model.maxTokens > 0 && model.cost), provider.config.models[0]);

			// The same id has to be the same entry whether it arrives declared or discovered:
			// omp merges the two by id, so a name or a cost that differed would change under
			// the user the first time discovery succeeded.
			const realFetch = globalThis.fetch;
			globalThis.fetch = async () => ({
				ok: true,
				status: 200,
				json: async () => ({ object: "list", data: [...SERVED, "zai/GLM-5.3"].map((id) => ({ id, object: "model" })) }),
			});
			let discovered;
			try {
				discovered = await provider.config.fetchDynamicModels("lithos-test-key");
			} finally {
				globalThis.fetch = realFetch;
			}
			expect(
				"catalogue: discovery restates a declared model unchanged",
				SERVED.every((id) => JSON.stringify(discovered.find((model) => model.id === id)) === JSON.stringify(provider.config.models.find((model) => model.id === id))),
				discovered,
			);
			expect(
				"catalogue: an id the bundle does not know is still registered",
				discovered.find((model) => model.id === "zai/GLM-5.3")?.name === "zai/GLM-5.3 on LithosAI",
				discovered.at(-1),
			);

			// The report has to say which list the picker is showing: the endpoint's, or the
			// bundle's when the endpoint could not be reached.
			await host.commands.get("mega").handler("lithos", host.ctx);
			expect(
				"catalogue: the report names what /models served",
				/5 model\(s\) at \d\d:\d\d:\d\d UTC, new: `zai\/GLM-5\.3`/.test(host.rendered),
				host.rendered.slice(0, 500),
			);
			expect("catalogue: the report lists the bundled ids", SERVED.every((id) => host.rendered.includes(`\`${id}\``)), host.rendered.slice(0, 400));
		});

		// An unreachable endpoint: the fetch rejects (omp keeps the catalogue and retries),
		// and the report has to explain why the picker is showing the bundled list instead of
		// leaving a one-model provider unexplained.
		await withConfig({}, async () => {
			const host = await makeHost({ model: LITHOS_MODEL });
			await host.start();
			await tick();
			const provider = host.providers.get(LITHOS_PROVIDER);
			const realFetch = globalThis.fetch;
			globalThis.fetch = async () => {
				throw new Error("getaddrinfo ENOTFOUND api.lithosai.cloud");
			};
			try {
				let thrown;
				try {
					await provider.config.fetchDynamicModels("lithos-test-key");
				} catch (error) {
					thrown = error;
				}
				expect("catalogue: an unreachable endpoint rejects the fetch", thrown instanceof Error && thrown.message.includes("ENOTFOUND"), thrown?.message);
			} finally {
				globalThis.fetch = realFetch;
			}
			await host.commands.get("mega").handler("lithos", host.ctx);
			expect(
				"catalogue: the report names the failure and the list the picker falls back to",
				/unreachable at \d\d:\d\d:\d\d UTC — getaddrinfo ENOTFOUND/.test(host.rendered) && host.rendered.includes("`/model` offers the bundled catalogue"),
				host.rendered.slice(0, 500),
			);
		});
	} finally {
		if (ambient === undefined) delete process.env[LITHOS_KEY_ENV];
		else process.env[LITHOS_KEY_ENV] = ambient;
	}
}

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
