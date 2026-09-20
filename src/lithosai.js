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
 *             output). The rates live in the console rather than the API, so they are
 *             configured here; until they are, a session's cost reads as unknown.
 *
 * Everything is scoped to the LithosAI provider: on any other model nothing is registered,
 * nothing is polled, and no segment is drawn. The provider registration itself is the
 * exception — it exists so a LithosAI model is *available* to load in the first place.
 *
 * Docs: https://docs.lithosai.com (base URL, rate limits, billing, per-harness guides).
 */

import { activeModel } from "./model.js";
import { sessionSpend } from "./usage.js";
import { formatTokens, money, timing } from "./measure.js";

export const LITHOS_PROVIDER = "lithosai";
export const LITHOS_BASE_URL = "https://api.lithosai.cloud/v1";
export const LITHOS_KEY_ENV = "LITHOSAI_API_KEY";
export const LITHOS_CONSOLE_KEYS_URL = "https://console.lithosai.cloud/keys";

/** The model id LithosAI's own omp guide names; the live catalogue comes from `/models`. */
export const LITHOS_DEFAULT_MODEL = "moonshotai/Kimi-K3";
/**
 * Limits for the static fallback model, from that same guide. `/models` returns ids and
 * owners only — no limits and no rates — so discovered models are registered with these
 * and the configured rates; a console that shows something else is an override in
 * `models.yml` away.
 */
export const LITHOS_CONTEXT_WINDOW = 262_144;
export const LITHOS_MAX_TOKENS = 32_768;

/** Where the plugin attaches; matches `activeModel(ctx)`.
 * `ctx.models.current()` reflects `/model` switches, so a LithosAI conversation that
 * moves to another provider stops being measured on the next event. */
export function isLithos(ctx) {
	return activeModel(ctx)?.provider === LITHOS_PROVIDER;
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

/** The model list this provider declares: one documented model, at the configured rates. */
export function lithosModels(rates) {
	return [
		{
			id: LITHOS_DEFAULT_MODEL,
			name: "Kimi K3 on LithosAI",
			reasoning: true,
			input: ["text"],
			cost: { input: rates.input, output: rates.output, cacheRead: rates.cached, cacheWrite: 0 },
			contextWindow: LITHOS_CONTEXT_WINDOW,
			maxTokens: LITHOS_MAX_TOKENS,
		},
	];
}

/** Models a live `/models` call reports, at the configured rates. */
function discoveredModels(ids, rates) {
	return ids.map((id) => ({
		id,
		name: `${id} on LithosAI`,
		reasoning: true,
		input: ["text"],
		cost: { input: rates.input, output: rates.output, cacheRead: rates.cached, cacheWrite: 0 },
		contextWindow: LITHOS_CONTEXT_WINDOW,
		maxTokens: LITHOS_MAX_TOKENS,
	}));
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
		return {
			baseUrl: url,
			api: "openai-completions",
			apiKey: LITHOS_KEY_ENV,
			models: lithosModels(currentRates),
			fetchDynamicModels: async (apiKey) => {
				if (!apiKey) return [];
				const checked = await validateKey(apiKey, { baseUrl: url });
				return checked.ok ? discoveredModels(checked.models, currentRates) : [];
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

	/** Register at load with schema defaults so the provider exists for `/login` and `/model`. */
	pi.registerProvider(LITHOS_PROVIDER, registration());
	state.registered = JSON.stringify({ baseUrl: baseUrl(), ...rates() });

	/** Re-register when the resolved configuration differs from what is registered. */
	function syncRegistration() {
		if (!registering()) return;
		const fingerprint = JSON.stringify({ baseUrl: baseUrl(), ...rates() });
		if (fingerprint === state.registered) return;
		try {
			pi.unregisterProvider(LITHOS_PROVIDER);
		} catch {
			// Nothing registered under this name; the registration below is the whole point.
		}
		pi.registerProvider(LITHOS_PROVIDER, registration());
		state.registered = fingerprint;
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

	/** One row segment: measured speed, the remaining per-minute budgets, and any refusal. */
	function segment() {
		if (!values().enabled || !values()["lithos.enabled"] || !isLithos(state.ctx)) return undefined;
		const parts = ["LITHOS"];
		if (Number(state.lastStatus) >= 400) {
			const retry = state.budgets?.retryAfterMs;
			parts.push(`\u2717 ${state.lastStatus}${retry ? ` retry ${Math.round(retry / 1000)}s` : ""}`);
		}
		const speed = timing(state.speeds);
		if (speed) parts.push(`${Math.round(speed.median)} tok/s`);
		const requests = state.budgets?.requests;
		if (requests?.limit > 0 && requests.remaining !== undefined) parts.push(`req ${requests.remaining}/${requests.limit}`);
		const tokens = state.budgets?.tokens;
		if (tokens?.limit > 0 && tokens.remaining !== undefined) {
			parts.push(`tok ${formatTokens(tokens.remaining)}/${formatTokens(tokens.limit)}`);
		}
		if (parts.length === 1) parts.push(state.requests > 0 ? `${state.requests} req` : "ready");
		return parts.join(" \u00b7 ");
	}

	/** Markdown section for `/mega`, `/mega lithos`. */
	function section(ctx) {
		const spend = sessionSpend(ctx?.sessionManager?.getBranch?.() ?? []);
		const model = activeModel(ctx);
		const lines = ["### LithosAI", ""];
		lines.push(`- Endpoint: \`${baseUrl()}\``);
		if (!isLithos(ctx)) {
			lines.push(`- No LithosAI model is active (current: \`${model?.provider ?? "none"}/${model?.id ?? "none"}\`).`);
			lines.push(
				`- Sign in with \`/login ${LITHOS_PROVIDER}\` (or set \`${LITHOS_KEY_ENV}\`), then pick a LithosAI model with \`/model\`.`,
			);
			return lines.join("\n");
		}
		lines.push(`- Model: \`${model?.id ?? "unknown"}\``);
		const ratesNow = rates();
		lines.push(
			ratesNow.input > 0 || ratesNow.output > 0
				? `- Rates: $${ratesNow.input}/Mtok in, $${ratesNow.cached}/Mtok cached, $${ratesNow.output}/Mtok out (\`lithos.*PerMillion\`)`
				: "- Rates: not configured, so session cost reads $0 — set `lithos.inputPerMillion`, `lithos.cachedPerMillion` and `lithos.outputPerMillion` from the console.",
		);
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
			lines.push("", "#### This session", "");
			lines.push("| bucket | cost (USD) | input | output | cache read | calls |");
			lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
			for (const [label, totals] of [
				["main", spend.parent],
				["agents", spend.agents],
				["total", spend.total],
			]) {
				lines.push(
					`| ${label} | ${money(totals.cost)} | ${totals.input.toLocaleString("en-US")} | ${totals.output.toLocaleString("en-US")} | ${totals.cacheRead.toLocaleString("en-US")} | ${totals.calls} |`,
				);
			}
			if (spend.hitRate !== undefined) {
				lines.push("", `Cached-input share: **${Math.round(spend.hitRate * 100)}%** of billed input tokens.`);
			}
		}
		return lines.join("\n");
	}

	return { segment, section, reset, state };
}
