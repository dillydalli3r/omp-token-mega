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

/** Weekday short names, indexed the way `weekday` is: 0 = Sunday. */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A model's peak schedule plus the UTC clock reading `at` maps to, or `undefined` when the
 * model declares no schedule — the one place the tariff is parsed, so `priceMultiplier`,
 * `pricePeriod` and `peakLabel` can never disagree about when peak is.
 *
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
function peakClock(model, at) {
	const schedule = model?.cost?.timeBased;
	if (!schedule || !Array.isArray(schedule.peakWindows)) return undefined;
	const day = Math.floor(at / 86_400_000);
	return {
		schedule,
		day,
		weekday: (((day + 4) % 7) + 7) % 7,
		minute: Math.floor((at - day * 86_400_000) / 60_000),
	};
}

/**
 * The off-peak multiplier when it actually discounts the headline rate, `undefined`
 * otherwise. A schedule that bills both periods the same is not a tariff: naming a period
 * for it would put a peak/off-peak label on a model whose price never moves.
 */
function discountMultiplier(schedule) {
	const multiplier = num(schedule?.offPeakMultiplier);
	return multiplier > 0 && multiplier !== 1 ? multiplier : undefined;
}

/** The half-open window `[startMinute, endMinute)` the clock sits in, or `undefined`. */
function windowAt({ schedule, weekday, minute }) {
	for (const window of schedule.peakWindows) {
		if (minute >= window.startMinute && minute < window.endMinute && window.weekdays?.includes(weekday)) return window;
	}
	return undefined;
}

export function priceMultiplier(model, at = Date.now()) {
	const clock = peakClock(model, at);
	if (!clock) return 1;
	const multiplier = discountMultiplier(clock.schedule);
	if (multiplier === undefined) return 1;
	return windowAt(clock) ? 1 : multiplier;
}

/** `"peak"` / `"off-peak"`, or `undefined` when neither a schedule nor a difference exists. */
export function pricePeriod(model, at = Date.now()) {
	const clock = peakClock(model, at);
	if (!clock || discountMultiplier(clock.schedule) === undefined) return undefined;
	return windowAt(clock) ? "peak" : "off-peak";
}

/** `HH:MM` for a minute of day; an end of 1440 prints as `24:00`, which is how a schedule writes midnight. */
function clockTime(minute) {
	return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** The window's own bounds: `01:00\u201304:00Z`. */
function windowRange(window) {
	return `${clockTime(window.startMinute)}\u2013${clockTime(window.endMinute)}Z`;
}

/**
 * The first window at or after the clock, scanning up to 8 days ahead (a full week plus a
 * day, so a Monday-Friday schedule always resolves). Windows are ranked by start minute
 * rather than by array order, because the declared order is not part of the contract.
 */
function nextWindow({ schedule, weekday, minute }) {
	for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
		const day = (weekday + dayOffset) % 7;
		let earliest;
		for (const window of schedule.peakWindows) {
			if (!window.weekdays?.includes(day)) continue;
			if (dayOffset === 0 && window.startMinute <= minute) continue;
			if (!earliest || window.startMinute < earliest.startMinute) earliest = window;
		}
		if (earliest) return { window: earliest, weekday: day, dayOffset };
	}
	return undefined;
}

/**
 * The tariff period as a status-row label, or `undefined` when the model prices both periods
 * the same (or declares no schedule) — a label for an unchanged rate is noise.
 *
 * The label carries a whole window rather than a countdown to the next boundary because the
 * user asked when peak starts and ends: `peak` names the window the current minute sits in,
 * off peak names the next one, with the weekday prefixed only when that window does not open
 * today. A discounted schedule whose windows never match still reports `off-peak` — the rate
 * really is discounted, there is simply no window to promise.
 */
export function peakLabel(model, at = Date.now()) {
	const clock = peakClock(model, at);
	if (!clock || discountMultiplier(clock.schedule) === undefined) return undefined;
	const open = windowAt(clock);
	if (open) return { period: "peak", text: `peak ${windowRange(open)}` };
	const next = nextWindow(clock);
	if (!next) return { period: "off-peak", text: "off-peak" };
	const day = next.dayOffset === 0 ? "" : `${WEEKDAYS[next.weekday]} `;
	return { period: "off-peak", text: `off-peak (peak ${day}${windowRange(next.window)})` };
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
