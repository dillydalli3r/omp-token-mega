/**
 * DeepSeek detection, usage normalization, and cache economics.
 *
 * Everything in this plugin is scoped to the DeepSeek provider. DeepSeek bills a
 * cache hit at a small fraction of the uncached input rate (deepseek-flash peaks at
 * $0.30/Mtok uncached vs $0.006/Mtok cached), which is what makes a hit worth
 * measuring at all.
 */

import { activeModel, modelKey } from "./model.js";

export const DEEPSEEK_PROVIDER = "deepseek";

export function isDeepSeekModel(model) {
	return model?.provider === DEEPSEEK_PROVIDER;
}

export function isDeepSeek(ctx) {
	return isDeepSeekModel(activeModel(ctx));
}

const num = (value) => {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
};

/**
 * Token accounting for one response.
 *
 * omp already folds DeepSeek's `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
 * into the normalized usage record: `input` is the uncached remainder, `cacheRead` the
 * hit, and `cacheWrite` is forced to 0 because DeepSeek charges no cache-write fee.
 */
export function cacheStats(usage) {
	const input = num(usage?.input);
	const cacheRead = num(usage?.cacheRead);
	const cacheWrite = num(usage?.cacheWrite);
	const output = num(usage?.output);
	return {
		input,
		cacheRead,
		cacheWrite,
		output,
		cost: num(usage?.cost?.total),
		billedInput: input + cacheRead + cacheWrite,
		hitRate: input + cacheRead + cacheWrite > 0 ? cacheRead / (input + cacheRead + cacheWrite) : undefined,
		hit: cacheRead > 0,
	};
}

/**
 * DeepSeek's declared rates are the peak card; off-peak hours are billed at
 * `offPeakMultiplier` (0.5 for every DeepSeek model, discounting both the uncached
 * and the cache-read rate). A saving computed from the headline rate would therefore
 * be 2× too high for half the day, so the tariff period is resolved per request.
 *
 * Mirrors omp's own `timeBasedMultiplier` (pi-catalog `models.ts`): UTC-only integer
 * arithmetic, `weekday` counted from the Unix epoch's Thursday, `minute` since UTC
 * midnight, half-open windows `[startMinute, endMinute)`. Scheduled rate cards
 * (`timeBased.effectiveRates`) and long-context tiers are not modelled — no DeepSeek
 * model declares either, and every DeepSeek model does declare the peak schedule.
 */
export function priceMultiplier(model, at = Date.now()) {
	const schedule = model?.cost?.timeBased;
	if (!schedule || !Array.isArray(schedule.peakWindows)) return 1;
	const day = Math.floor(at / 86_400_000);
	const weekday = (((day + 4) % 7) + 7) % 7;
	const minute = Math.floor((at - day * 86_400_000) / 60_000);
	for (const window of schedule.peakWindows) {
		if (minute >= window.startMinute && minute < window.endMinute && window.weekdays?.includes(weekday)) return 1;
	}
	return num(schedule.offPeakMultiplier) || 1;
}

/** `"peak"` / `"off-peak"`, or `undefined` when the model declares no schedule. */
export function pricePeriod(model, at = Date.now()) {
	if (!model?.cost?.timeBased) return undefined;
	return priceMultiplier(model, at) === 1 ? "peak" : "off-peak";
}

/**
 * USD avoided by serving `cacheRead` tokens from cache instead of billing them
 * as uncached input, at the tariff in force when the request was made. Zero when the
 * model declares no cache-read rate.
 */
export function cacheSavings({ cacheRead }, model, at = Date.now()) {
	const inputRate = num(model?.cost?.input);
	const cacheRate = num(model?.cost?.cacheRead);
	if (cacheRead <= 0 || inputRate <= 0) return 0;
	return (Math.max(0, inputRate - cacheRate) * cacheRead * priceMultiplier(model, at)) / 1_000_000;
}
