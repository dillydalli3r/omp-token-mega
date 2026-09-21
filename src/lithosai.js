/**
 * LithosAI: provider registration, interactive login, and metrics.
 *
 * LithosAI (`https://api.lithosai.cloud/v1`) is an OpenAI-compatible inference service
 * that sells speed: the same weights, served by their engine, at hundreds of tokens per
 * second per user. Nothing in omp's catalog ships a `lithosai` provider, so this plugin
 * registers one at runtime — models, `/login` entry and usage reporting — and then
 * measures what the service actually delivered.
 *
 * The three numbers worth showing are the three the docs name:
 *
 *   speed     their claim is tokens per second per user, so the plugin times the stream
 *             (`after_provider_response` → `message_end`) and divides by the output
 *             tokens that stream reported. Measured, not assumed.
 *   budgets   every admitted request comes back with `x-ratelimit-*` headers describing
 *             three per-minute buckets (requests, input tokens, output tokens). The
 *             remaining values are balances that refill continuously, so they are
 *             reported as balances, never as "limit minus spend this minute".
 *   cost      prepaid credit, debited per token at three rates (input, cached input,
 *             output). The API publishes none of them and `/models` carries ids and owners
 *             only, so the rates are declared from LithosAI's public price list, with
 *             `lithos.*PerMillion` as the override for a console figure that differs.
 *             A model nobody priced reports "unknown" rather than a zero bill.
 *
 * The session's cost, cached tokens and spend table are the balance feature's
 * (`/mega balance`), which works the same on either metered provider — so a LithosAI session
 * shows DeepSeek's row: the same cache figures, the same `used $` cost, and this provider's
 * tag where `DS` sits, supplied by the balance segment rather than by this module. The
 * speed and budget this module measures are the report's (`/mega lithos`) and omp's own
 * usage surface's (`/usage`), never extra parts on the status row.
 *
 * Everything is scoped to the LithosAI provider: on any other model nothing is registered,
 * nothing is polled, and no metric is recorded. The provider registration itself is the
 * exception — it exists so a LithosAI model is *available* to load in the first place.
 *
 * Auth is one key, and it comes from a `/login lithosai` credential or from the *value* of
 * `LITHOSAI_API_KEY` — never from the variable name. omp resolves a registered provider
 * `apiKey` as "the environment variable's value, else the literal string", so registering
 * the name would hand every install the literal `LITHOSAI_API_KEY` as a credential: omp
 * would report `lithosai` as signed in (config override), that override would outrank
 * whatever `/login` stored, and `/models` would answer 401.
 *
 * Docs: https://docs.lithosai.com (base URL, rate limits, billing, per-harness guides).
 */

import { activeModel } from "./model.js";
import { sessionSpend } from "./usage.js";
import { money, timing } from "./measure.js";

export const LITHOS_PROVIDER = "lithosai";
export const LITHOS_BASE_URL = "https://api.lithosai.cloud/v1";
export const LITHOS_KEY_ENV = "LITHOSAI_API_KEY";
export const LITHOS_CONSOLE_KEYS_URL = "https://console.lithosai.cloud/keys";
/** Where the prepaid balance and the per-model spend are actually reported. */
export const LITHOS_BILLING_URL = "https://console.lithosai.cloud/billing";
/** The public price list the bundled rates come from. */
export const LITHOS_PRICING_URL = "https://www.lithosai.com/pricing";
export const LITHOS_PRICING_RETRIEVED = "2026-09-20";

/**
 * The models LithosAI serves, with the specs and rates the service publishes.
 *
 * Three numbers per model matter here, and the API reports none of them: `/models` carries
 * ids and owners only. So they are declared, from LithosAI's own sources, and can be
 * overridden per rate with `lithos.*PerMillion`.
 *
 *   rates          the public price list (LITHOS_PRICING_URL, retrieved
 *                  LITHOS_PRICING_RETRIEVED): the early-access card, which is what the
 *                  console bills while the discount holds. Without them a session cannot
 *                  price its own tokens — the row's `used $` and every cost column read
 *                  zero, which is what "cost is unknown" has to look like rather than a
 *                  wrong number.
 *   contextWindow  the published window. Each model's own figure, taken from the same
 *                  model in omp's catalog: Kimi K3 declares 2^20, DeepSeek V4.1 Flash
 *                  declares 1000000.
 *   maxTokens      the published output ceiling, same source. A wrong value here is not
 *                  cosmetic: omp sends `max_tokens` for Kimi-family models, so an
 *                  understated ceiling truncates generations and an overstated one is
 *                  refused by the endpoint.
 *
 * Ids the live `/models` reports and this list does not know keep the conservative
 * fallbacks below and price at zero until `lithos.*PerMillion` is set.
 */
export const LITHOS_CATALOGUE = [
	{
		id: "deepseek-ai/DeepSeek-V4.1-Flash",
		name: "DeepSeek V4.1 Flash",
		tier: "Base",
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		rates: { input: 0.15, cached: 0.003, output: 0.6 },
	},
	{
		id: "moonshotai/Kimi-K3",
		name: "Kimi K3",
		tier: "Base",
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		rates: { input: 2.4, cached: 0.24, output: 12 },
	},
	{
		id: "moonshotai/Kimi-K3-fast",
		name: "Kimi K3 Fast",
		tier: "Fast",
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		rates: { input: 4, cached: 0.4, output: 20 },
	},
	{
		id: "moonshotai/Kimi-K3-ultra",
		name: "Kimi K3 Ultra",
		tier: "Ultra",
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		rates: { input: 5.6, cached: 0.56, output: 28 },
	},
];

/** Declared limits for an id the bundle does not know: the floor every LithosAI model meets. */
export const LITHOS_FALLBACK_CONTEXT_WINDOW = 262_144;
export const LITHOS_FALLBACK_MAX_TOKENS = 32_768;

export function isLithosModel(model) {
	return model?.provider === LITHOS_PROVIDER;
}

/** Where the plugin attaches; matches `activeModel(ctx)`.
 * `ctx.models.current()` reflects `/model` switches, so a LithosAI conversation that
 * moves to another provider stops being measured on the next event. */
export function isLithos(ctx) {
	return isLithosModel(activeModel(ctx));
}

const int = (value) => {
	const n = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(n) ? n : undefined;
};

/**
 * Read the rate-limit headers from one response.
 *
 * `headers` are the provider response's header record, lowercased. Returns `undefined`
 * when the response carried no budget headers at all (which is every non-LithosAI
 * response, and any response where the budgets were not consulted).
 */
export function parseBudgets(headers) {
	const get = (name) => int(headers?.[name]);
	const requests = {
		limit: get("x-ratelimit-limit-requests"),
		remaining: get("x-ratelimit-remaining-requests"),
		reset: headers?.["x-ratelimit-reset-requests"],
	};
	const tokens = {
		limit: get("x-ratelimit-limit-tokens"),
		remaining: get("x-ratelimit-remaining-tokens"),
		reset: headers?.["x-ratelimit-reset-tokens"],
	};
	if (requests.limit === undefined && requests.remaining === undefined && tokens.limit === undefined && tokens.remaining === undefined) {
		return undefined;
	}
	const retryAfterMs = get("retry-after-ms");
	const retryAfterSeconds = get("retry-after");
	return {
		requests,
		tokens,
		retryAfterMs: retryAfterMs ?? (retryAfterSeconds === undefined ? undefined : retryAfterSeconds * 1000),
		shouldRetry: headers?.["x-should-retry"] === "false" ? false : undefined,
	};
}

/** A budget pair as one usage limit, or `undefined` when the header pair is incomplete. */
function budgetLimit(id, label, unit, bucket) {
	if (!(Number(bucket?.limit) > 0) || bucket.remaining === undefined) return undefined;
	return {
		id,
		label,
		scope: { provider: LITHOS_PROVIDER },
		amount: { used: Math.max(0, bucket.limit - bucket.remaining), limit: bucket.limit, unit },
	};
}

/**
 * Normalize budget headers into the host's usage-report shape.
 *
 * omp calls this back (through the registered usage provider) wherever it parses
 * provider rate-limit headers, so the numbers behind the plugin's own segment also reach
 * [`/usage`] and any native status-line segment that reads provider usage.
 */
export function parseRateLimitHeaders(headers, now = Date.now()) {
	const budgets = parseBudgets(headers);
	if (!budgets) return null;
	const limits = [
		budgetLimit("requests", "Requests / minute", "requests", budgets.requests),
		budgetLimit("tokens", "Tokens / minute", "tokens", budgets.tokens),
	].filter(Boolean);
	if (limits.length === 0) return null;
	return { provider: LITHOS_PROVIDER, fetchedAt: now, limits };
}

/**
 * One rate: the configured override when one is set, otherwise the model's published
 * figure, otherwise zero — zero meaning "unknown", never a price.
 */
function rateOf(overrides, published, kind) {
	const override = Number(overrides?.[kind]) || 0;
	return override > 0 ? override : (published?.[kind] ?? 0);
}

/**
 * One model registration entry. Static and discovered models go through here so the same id
 * is the same entry either way: omp merges the two by id, and a name that changed with the
 * source would rename a model under the user every time discovery succeeded.
 *
 * Rates come from the published card unless `lithos.*PerMillion` overrides them, because an
 * unread rate makes every cost in this plugin read `$0` — an entry registered without one
 * cannot price the tokens it is billed for.
 */
function modelSpec(id, overrides) {
	const known = LITHOS_CATALOGUE.find((entry) => entry.id === id);
	const published = known?.rates;
	return {
		id,
		name: known?.name ?? id,
		reasoning: true,
		input: ["text"],
		cost: {
			input: rateOf(overrides, published, "input"),
			output: rateOf(overrides, published, "output"),
			cacheRead: rateOf(overrides, published, "cached"),
			cacheWrite: 0,
		},
		contextWindow: known?.contextWindow ?? LITHOS_FALLBACK_CONTEXT_WINDOW,
		maxTokens: known?.maxTokens ?? LITHOS_FALLBACK_MAX_TOKENS,
	};
}

/**
 * The effective rates of one model, with where each figure came from: `{ input, cached,
 * output, source }` where `source` is `"published"`, `"configured"`, a mix
 * (`"published + lithos.inputPerMillion"`), or `"unknown"` when neither source priced it.
 * The section reads this instead of re-deriving the precedence, so what it prints and what
 * the registration bills cannot disagree.
 */
export function lithosRates(modelId, overrides = {}) {
	const published = LITHOS_CATALOGUE.find((entry) => entry.id === modelId)?.rates;
	const rates = {
		input: rateOf(overrides, published, "input"),
		cached: rateOf(overrides, published, "cached"),
		output: rateOf(overrides, published, "output"),
	};
	const kinds = ["input", "cached", "output"];
	const fromConfig = kinds.filter((kind) => (Number(overrides?.[kind]) || 0) > 0);
	const known = rates.input > 0 || rates.cached > 0 || rates.output > 0;
	const source = !known
		? "unknown"
		: fromConfig.length === 0
			? "published"
			: published
				? `published, with ${fromConfig.map((kind) => `lithos.${kind}PerMillion`).join(" and ")} overriding`
				: fromConfig.map((kind) => `lithos.${kind}PerMillion`).join(" and ");
	return { ...rates, source };
}

/**
 * The model list this provider declares at registration: the whole catalogue, one entry per
 * model LithosAI serves. It is what makes every LithosAI model loadable before any key
 * exists; the live catalogue, ids discovered from `/models` at these same rates, arrives
 * through `fetchDynamicModels` once the provider is authenticated.
 */
export function lithosModels(rates) {
	return LITHOS_CATALOGUE.map((entry) => modelSpec(entry.id, rates));
}

/** Models a live `/models` call reports, at the configured rates. */
function discoveredModels(ids, rates) {
	return ids.map((id) => modelSpec(id, rates));
}

/**
 * Check a key against `/models`.
 *
 * Returns `{ ok: true, models }` on a 200, `{ ok: false, status }` on a refusal, and
 * `{ ok: false, error }` when the check could not be made at all — the caller decides
 * whether an unreachable endpoint should block a login. Never throws.
 */
export async function validateKey(key, { baseUrl = LITHOS_BASE_URL, fetchImpl = fetch } = {}) {
	if (!key) return { ok: false, error: "no API key" };
	try {
		const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, "")}/models`, {
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
		});
		if (!response.ok) {
			return { ok: false, status: response.status, error: `HTTP ${response.status}` };
		}
		const payload = await response.json();
		const ids = Array.isArray(payload?.data) ? payload.data.map((model) => model?.id).filter((id) => typeof id === "string" && id) : [];
		return { ok: true, models: ids };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * The `/login` flow.
 *
 * A LithosAI credential is a console-issued API key, so the flow is a masked prompt plus
 * a validation call. A refusal is fatal — pasting a revoked key is a mistake worth
 * naming — while an unreachable endpoint only warns: a key cannot be validated offline,
 * and storing it is still the right outcome when the alternative is a broken setup.
 */
export async function loginLithos(callbacks, { baseUrl = LITHOS_BASE_URL } = {}) {
	callbacks.onProgress?.(`Create a key at ${LITHOS_CONSOLE_KEYS_URL}, then paste it below.`);
	const answer = await callbacks.onPrompt({ message: "LithosAI API key", secret: true });
	const key = String(answer ?? "").trim();
	if (!key) throw new Error("no LithosAI API key was provided");

	const checked = await validateKey(key, { baseUrl, fetchImpl: callbacks.fetch ?? fetch });
	if (!checked.ok && (checked.status === 401 || checked.status === 403)) {
		throw new Error(`LithosAI rejected that key (${checked.error}). Create a new one at ${LITHOS_CONSOLE_KEYS_URL}.`);
	}
	if (checked.ok) {
		callbacks.onProgress?.(
			checked.models.length > 0 ? `Key accepted — ${checked.models.length} model(s) available.` : "Key accepted.",
		);
	} else {
		callbacks.onProgress?.(`Could not verify the key (${checked.error}); storing it anyway.`);
	}
	return key;
}

/**
 * The API key `LITHOSAI_API_KEY` holds, or `undefined` when the variable is unset or
 * blank.
 *
 * omp reads a registered provider `apiKey` as "the environment variable's value, else the
 * literal string", so the registration must carry a resolved value or nothing: registering
 * the variable NAME would make `lithosai` look authenticated — with the literal
 * `LITHOSAI_API_KEY` as the credential — on every install that has neither the variable
 * nor a `/login`, and that config override would outrank the stored login too. Reading the
 * value here keeps "no key anywhere" a state omp can see, and lets a `/login` credential
 * be the only key in play.
 */
function lithosEnvKey() {
	const value = process.env[LITHOS_KEY_ENV];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function installLithos(pi, shell) {
	const state = {
		ctx: undefined,
		/** Last budget snapshot and when it was seen. */
		budgets: undefined,
		budgetsAt: 0,
		/** HTTP status of the last provider response, so a refusal is visible. */
		lastStatus: undefined,
		/** When the last response's headers arrived — the start of the measured stream. */
		responseAt: 0,
		/** Output tokens per second, one sample per completed response. */
		speeds: [],
		requests: 0,
		/** Last `/models` outcome: `{ at, ids }` on a 200, `{ at, error }` on a failure. */
		discovery: undefined,
		/** What the provider was last registered with, so a config change re-registers. */
		registered: undefined,
	};

	const values = () => shell.values();
	const rates = () => ({
		input: Number(values()["lithos.inputPerMillion"]) || 0,
		output: Number(values()["lithos.outputPerMillion"]) || 0,
		cached: Number(values()["lithos.cachedPerMillion"]) || 0,
	});
	const baseUrl = () => String(values()["lithos.baseUrl"] || LITHOS_BASE_URL);
	/** Registration is the one part of this feature that is not provider-gated. */
	const registering = () => values().enabled === true && values()["lithos.enabled"] === true;
	const active = () => registering() && isLithos(state.ctx);

	function registration() {
		const currentRates = rates();
		const url = baseUrl();
		const key = lithosEnvKey();
		return {
			baseUrl: url,
			api: "openai-completions",
			// Only a value that exists is registered; see `lithosEnvKey`. An absent `apiKey`
			// leaves a `/login` credential — or nothing — as the provider's only key.
			...(key === undefined ? {} : { apiKey: key }),
			models: lithosModels(currentRates),
			fetchDynamicModels: async (apiKey) => {
				// No resolved key is "nothing to discover", not "ask anyway": a request without
				// one can only 401, and it would do it on every startup of an unauthenticated
				// install.
				if (!apiKey) return [];
				// A refusal throws rather than returning an empty list, and the difference is
				// deliberate: omp reads a rejected discovery fetch as "keep the cached catalogue
				// and try again", while a successful-but-empty `/models` is authoritative for
				// this cycle and clears it. Both outcomes are kept for `/mega lithos`, which is
				// where the bundled catalogue explains itself.
				const checked = await validateKey(apiKey, { baseUrl: url });
				if (!checked.ok) {
					state.discovery = { at: Date.now(), error: checked.error };
					throw new Error(`LithosAI /models failed: ${checked.error}`);
				}
				state.discovery = { at: Date.now(), ids: checked.models };
				return discoveredModels(checked.models, currentRates);
			},
			oauth: {
				name: "LithosAI",
				login: (callbacks) => loginLithos(callbacks, { baseUrl: url }),
			},
			usage: {
				id: LITHOS_PROVIDER,
				async fetchUsage() {
					// There is no billing endpoint to poll: the only budget figures LithosAI
					// reports are the headers on a response, so the freshest observation is
					// the report.
					if (!state.budgets) return null;
					const report = parseRateLimitHeaders(budgetHeaders(state.budgets), state.budgetsAt);
					return report;
				},
				parseRateLimitHeaders: (headers, now) => parseRateLimitHeaders(headers, now),
				retainLastGoodOnFailure: true,
			},
		};
	}

	/** The last snapshot re-expressed as headers, so one normalizer serves both paths. */
	function budgetHeaders(budgets) {
		const headers = {};
		const put = (name, value) => {
			if (value !== undefined && value !== null) headers[name] = String(value);
		};
		put("x-ratelimit-limit-requests", budgets?.requests?.limit);
		put("x-ratelimit-remaining-requests", budgets?.requests?.remaining);
		put("x-ratelimit-reset-requests", budgets?.requests?.reset);
		put("x-ratelimit-limit-tokens", budgets?.tokens?.limit);
		put("x-ratelimit-remaining-tokens", budgets?.tokens?.remaining);
		put("x-ratelimit-reset-tokens", budgets?.tokens?.reset);
		return headers;
	}

	/** What a registration is decided by: endpoint, rates, and the resolved key. */
	const fingerprint = () => JSON.stringify({ baseUrl: baseUrl(), ...rates(), apiKey: lithosEnvKey() });

	/** Register at load with schema defaults so the provider exists for `/login` and `/model`. */
	pi.registerProvider(LITHOS_PROVIDER, registration());
	state.registered = fingerprint();

	/** Re-register when the resolved configuration differs from what is registered. */
	function syncRegistration() {
		if (!registering()) return;
		const next = fingerprint();
		if (next === state.registered) return;
		try {
			pi.unregisterProvider(LITHOS_PROVIDER);
		} catch {
			// Nothing registered under this name; the registration below is the whole point.
		}
		pi.registerProvider(LITHOS_PROVIDER, registration());
		state.registered = next;
	}

	pi.on("session_start", async (_event, ctx) => {
		state.ctx = ctx;
		syncRegistration();
		shell.render();
	});
	pi.on("session_switch", async (_event, ctx) => {
		state.ctx = ctx;
		reset();
		syncRegistration();
		shell.render();
	});
	pi.on("after_provider_response", async (event, ctx) => {
		state.ctx = ctx;
		if (!active()) return;
		state.lastStatus = Number(event?.status) || undefined;
		state.responseAt = Date.now();
		const parsed = parseBudgets(event?.headers);
		if (parsed) {
			state.budgets = parsed;
			state.budgetsAt = state.responseAt;
		}
		shell.render();
	});
	pi.on("message_end", async (event, ctx) => {
		state.ctx = ctx;
		if (!active()) return;
		const message = event?.message;
		if (message?.role !== "assistant" || !message.usage) return;
		state.requests += 1;
		const output = Number(message.usage.output) || 0;
		const elapsedMs = state.responseAt > 0 ? Date.now() - state.responseAt : 0;
		// Below ~50 ms the sample is header-to-hook noise rather than generation, and a
		// zero-output turn (a tool call that produced none) has no rate to report.
		if (output > 0 && elapsedMs >= 50) {
			state.speeds.push(output / (elapsedMs / 1000));
			if (state.speeds.length > 256) state.speeds.shift();
		}
		shell.render();
	});
	pi.on("session_shutdown", async () => {
		state.ctx = undefined;
	});

	function reset() {
		state.budgets = undefined;
		state.budgetsAt = 0;
		state.lastStatus = undefined;
		state.responseAt = 0;
		state.speeds = [];
		state.requests = 0;
	}

	/** The window and the output ceiling the registration declares for an id. */
	function declaredLimits(modelId) {
		const known = LITHOS_CATALOGUE.find((entry) => entry.id === modelId);
		const window = known?.contextWindow ?? LITHOS_FALLBACK_CONTEXT_WINDOW;
		const output = known?.maxTokens ?? LITHOS_FALLBACK_MAX_TOKENS;
		const source = known ? `published, the ${known.tier} tier` : "fallback — the id is not in the bundled catalogue";
		return `${window.toLocaleString("en-US")} tokens, ${output.toLocaleString("en-US")} max output (${source})`;
	}

	/** The effective rates for an id, and which source priced each figure. */
	function ratesLine(modelId) {
		const effective = lithosRates(modelId, rates());
		if (effective.source === "unknown") {
			return "- Rates: unknown for this id — the bundled card does not price it and no `lithos.*PerMillion` is set, so cost reads $0.";
		}
		const provenance =
			effective.source === "published" ? `published card, ${LITHOS_PRICING_URL} (retrieved ${LITHOS_PRICING_RETRIEVED})` : effective.source;
		return `- Rates: $${effective.input}/Mtok in, $${effective.cached}/Mtok cached, $${effective.output}/Mtok out — ${provenance}.`;
	}

	/**
	 * The last `/models` outcome, in one line: when it answered, what it served and which of
	 * those ids the bundled catalogue does not know; when it did not, why — because "the
	 * picker shows the bundled list" is a fact the user has to be able to explain.
	 */
	function discoveryLine() {
		const seen = state.discovery;
		if (!seen) return "not fetched yet — omp asks once the provider has a key";
		const at = new Date(seen.at).toISOString().slice(11, 19);
		if (seen.error) return `unreachable at ${at} UTC — ${seen.error}; \`/model\` offers the bundled catalogue`;
		const bundled = new Set(LITHOS_CATALOGUE.map((entry) => entry.id));
		const fresh = seen.ids.filter((id) => !bundled.has(id));
		const served = `${seen.ids.length} model(s) at ${at} UTC`;
		return fresh.length > 0 ? `${served}, new: ${fresh.map((id) => `\`${id}\``).join(", ")}` : `${served}, all in the bundled catalogue`;
	}

	/** Markdown section for `/mega`, `/mega lithos`. */
	function section(ctx) {
		const spend = sessionSpend(ctx?.sessionManager?.getBranch?.() ?? []);
		const model = activeModel(ctx);
		const lines = ["### LithosAI", ""];
		lines.push(`- Endpoint: \`${baseUrl()}\``);
		lines.push(`- Bundled catalogue: ${LITHOS_CATALOGUE.map((entry) => `\`${entry.id}\``).join(", ")}`);
		lines.push(`- Live \`/models\`: ${discoveryLine()}`);
		if (!isLithos(ctx)) {
			lines.push(`- No LithosAI model is active (current: \`${model?.provider ?? "none"}/${model?.id ?? "none"}\`).`);
			lines.push(
				`- Sign in with \`/login ${LITHOS_PROVIDER}\` (or set \`${LITHOS_KEY_ENV}\`), then pick a LithosAI model with \`/model\`.`,
			);
			return lines.join("\n");
		}
		lines.push(`- Model: \`${model?.id ?? "unknown"}\``);
		lines.push(`- Declared limits: ${declaredLimits(model?.id)}`);
		lines.push(ratesLine(model?.id));
		lines.push(`- Responses measured this session: ${state.requests}`);

		const speed = timing(state.speeds);
		if (speed) {
			lines.push(
				`- Output speed: p50 ${Math.round(speed.median)} tok/s, max ${Math.round(speed.max)} tok/s over ${speed.count} response(s), measured header-to-completion`,
			);
		} else {
			lines.push("- Output speed: no completed response yet (a sample needs >0 output tokens and ≥50 ms of stream)");
		}

		lines.push("", "#### Per-minute budgets (last response)", "");
		if (state.budgets) {
			const seen = state.budgetsAt ? new Date(state.budgetsAt).toISOString().slice(11, 19) : "?";
			const describe = (label, bucket, unit) => {
				if (!bucket || (bucket.limit === undefined && bucket.remaining === undefined)) return `- ${label}: not reported`;
				const reset = bucket.reset ? `, refills in ${bucket.reset}` : "";
				return `- ${label}: ${bucket.remaining ?? "?"}${bucket.limit ? ` of ${bucket.limit}` : ""} ${unit} left${reset}`;
			};
			lines.push(describe("Requests", state.budgets.requests, "requests"));
			lines.push(describe("Tokens", state.budgets.tokens, "tokens"));
			lines.push("");
			lines.push(
				`These are balances that refill continuously, not a countdown from a fixed window, so they are never rendered as a percentage of spend. Observed at ${seen} UTC.`,
			);
		} else {
			lines.push("- No budget headers seen yet: they accompany any response whose budgets were consulted.");
		}
		if (state.budgets?.retryAfterMs) {
			lines.push("", `Last refusal advised waiting ${Math.round(state.budgets.retryAfterMs / 1000)}s${state.budgets.shouldRetry === false ? ", and marked itself not worth retrying" : ""}.`);
		}
		if (Number(state.lastStatus) >= 400) lines.push("", `Last provider response: HTTP ${state.lastStatus}.`);

		{
			// The cost ledger is the account section's (`/mega balance`), which shows the same
			// main/agents/total table for every provider this plugin prices; this section names
			// the figure so "what did LithosAI cost me" is answered here too, once.
			const ratesNow = lithosRates(model?.id, rates());
			lines.push("", "#### This session", "");
			lines.push(
				ratesNow.source === "unknown"
					? `- Cost: unknown — set \`lithos.inputPerMillion\`, \`lithos.cachedPerMillion\` and \`lithos.outputPerMillion\`; until then every cost reads $0.`
					: `- Cost: $${money(spend.total.cost)} (main $${money(spend.parent.cost)} + agents $${money(spend.agents.cost)}) — the per-bucket table is in \`/mega balance\`.`,
			);
			lines.push(`- Tokens billed: ${spend.total.input.toLocaleString("en-US")} input, ${spend.total.cacheRead.toLocaleString("en-US")} cached, ${spend.total.output.toLocaleString("en-US")} output over ${spend.total.calls} call(s).`);
		}
		return lines.join("\n");
	}

	return { section, reset, state };
}
