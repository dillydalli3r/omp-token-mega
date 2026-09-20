/**
 * DeepSeek account balance client.
 *
 * Endpoint: GET https://api.deepseek.com/user/balance
 * Docs:     https://api-docs.deepseek.com/api/get-user-balance
 *
 * The response amounts are strings, not numbers, and the payload is untrusted
 * network input, so everything is parsed tolerantly and never throws into a
 * caller's event handler.
 */

import { DEEPSEEK_PROVIDER } from "./deepseek.js";
import { money } from "./measure.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Derive the balance endpoint from the provider's chat base URL, tolerating the
 * OpenAI-compatible `/v1` (or `/v2`, …) suffix: `https://host/v1` -> `https://host/user/balance`.
 */
export function balanceEndpoint(baseUrl) {
	const base = String(baseUrl ?? DEFAULT_BASE_URL)
		.trim()
		.replace(/\/+$/, "");
	return `${base.replace(/\/v\d+$/i, "")}/user/balance`;
}

/** Symbol for a DeepSeek balance currency code; unknown codes keep the code as a prefix. */
export function currencySymbol(currency) {
	const code = String(currency ?? "").toUpperCase();
	if (code === "USD") return "$";
	if (code === "CNY") return "\u00a5";
	return code ? `${code} ` : "";
}

function amount(value) {
	const n = Number.parseFloat(String(value ?? ""));
	return Number.isFinite(n) ? n : undefined;
}

/**
 * Normalize an untrusted `/user/balance` payload into
 * `{ available, infos: [{ currency, symbol, total, granted, toppedUp }] }`.
 * Entries without a parseable `total_balance` are dropped.
 */
export function normalizeBalance(payload) {
	const rawInfos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
	const infos = [];
	for (const info of rawInfos) {
		const total = amount(info?.total_balance);
		if (total === undefined) continue;
		const currency = String(info?.currency ?? "").toUpperCase();
		infos.push({
			currency,
			symbol: currencySymbol(currency),
			total,
			granted: amount(info?.granted_balance) ?? 0,
			toppedUp: amount(info?.topped_up_balance) ?? 0,
		});
	}
	return { available: payload?.is_available !== false, infos };
}

/**
 * Fetch and normalize the account balance.
 * Returns `{ ok: true, balance }` or `{ ok: false, error }` — never throws.
 */
export async function fetchBalance({ apiKey, baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	if (!apiKey) return { ok: false, error: "no DeepSeek API key" };
	const url = balanceEndpoint(baseUrl);
	try {
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await response.text();
		let payload;
		try {
			payload = JSON.parse(text);
		} catch {
			payload = undefined;
		}
		if (!response.ok) {
			const detail = payload?.error?.message ?? text.slice(0, 200);
			return { ok: false, error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}` };
		}
		if (!payload) return { ok: false, error: "non-JSON response" };
		return { ok: true, balance: normalizeBalance(payload) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Resolve the DeepSeek credential and base URL the way the model request path
 * does, so the balance call uses the same account the session is billing.
 */
export async function resolveCredentials(ctx) {
	const model = ctx?.models?.current?.() ?? ctx?.model;
	const registry = ctx?.modelRegistry;
	let apiKey;
	if (registry?.getApiKeyAndHeaders && model) {
		const resolved = await registry.getApiKeyAndHeaders(model);
		if (resolved?.ok) apiKey = resolved.apiKey;
	}
	if (!apiKey) apiKey = process.env.DEEPSEEK_API_KEY || undefined;

	let baseUrl;
	try {
		baseUrl = registry?.getProviderBaseUrl?.(DEEPSEEK_PROVIDER);
	} catch {
		baseUrl = undefined;
	}
	baseUrl ??= model?.provider === DEEPSEEK_PROVIDER ? model?.baseUrl : undefined;
	return { apiKey, baseUrl };
}

/** One-line account balance, preferring the CNY account DeepSeek bills in. */
export function balanceText(balance) {
	const infos = balance?.infos ?? [];
	const info = infos.find((entry) => entry.currency === "CNY") ?? infos[0];
	if (!info) return undefined;
	return `${info.symbol}${money(info.total)}`;
}
