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

/** The window's own bounds in the schedule's frame: `01:00\u201304:00Z`. */
function windowRange(window) {
	return `${clockTime(window.startMinute)}\u2013${clockTime(window.endMinute)}Z`;
}

/**
 * One occurrence of a window as absolute UTC milliseconds.
 *
 * `dayOffset` is relative to the clock's UTC day, which the caller resolves — the occurrence
 * in force may have opened the previous day when the window crosses midnight. A window whose
 * end is not after its start is exactly that crossing case, so its end lands on the next day;
 * an end of 1440 is midnight and stays on the start's day.
 */
function windowSpan(clock, window, dayOffset) {
	const startDay = clock.day + dayOffset;
	const endDay = startDay + (window.endMinute > window.startMinute ? 0 : 1);
	const instant = (day, minute) => (day * 1440 + minute) * 60_000;
	return { start: instant(startDay, window.startMinute), end: instant(endDay, window.endMinute) };
}

/** One formatter per zone: building these is the expensive part of every label. */
const LOCAL_FORMATS = new Map();

function localParts(at, timeZone) {
	const key = timeZone ?? "";
	let format = LOCAL_FORMATS.get(key);
	if (!format) {
		format = new Intl.DateTimeFormat("en-US", {
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
			timeZoneName: "short",
			...(timeZone === undefined ? {} : { timeZone }),
		});
		LOCAL_FORMATS.set(key, format);
	}
	const parts = format.formatToParts(at);
	const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
	return {
		stamp: `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`,
		zone: get("timeZoneName"),
	};
}

/**
 * A span as local wall-clock times, dated, with the zone in force:
 * `2026-09-20 21:00\u20132026-09-21 00:00 EDT`.
 *
 * The schedule is declared in UTC and priced in UTC, but the person reading the row lives in
 * a zone: a window that reads 01:00\u201304:00Z is 21:00\u201300:00 the evening before wherever the
 * offset is \u22124, and the same window is an hour different once the zone changes offset. Dates
 * are part of the label because a window can open days later, and because the local dates of
 * its bounds need not be the same day at all.
 */
function localRange(span, timeZone) {
	const from = localParts(span.start, timeZone);
	const to = localParts(span.end, timeZone);
	const zone = from.zone === to.zone ? from.zone : `${from.zone}\u2013${to.zone}`;
	return `${from.stamp}\u2013${to.stamp} ${zone}`.trim();
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
 * `text` is the row's form: the window in local time, dated, with the zone in force, because
 * that is the reading a user can act on. `detail` adds the schedule's own UTC frame for the
 * report, where there is room for both and the UTC reading is what the rate card declares.
 * `timeZone` is an IANA zone for tests; the row uses the machine's zone.
 *
 * On peak, the label names the window the current minute sits in — its start may be on the
 * previous local day when the window crosses local midnight. Off peak, it names the next one,
 * which can open up to a week later, so that label carries its date rather than a weekday
 * name: a date answers "when" and also "which day is that". A discounted schedule whose
 * windows never match still reports `off-peak` — the rate really is discounted, there is
 * simply no window to promise.
 */
export function peakLabel(model, at = Date.now(), timeZone) {
	const clock = peakClock(model, at);
	if (!clock || discountMultiplier(clock.schedule) === undefined) return undefined;
	const open = windowAt(clock);
	if (open) {
		// `windowAt` matched the current minute against `[start, end)` on the clock's own UTC
		// day (the rule omp prices by), so the occurrence in force opened earlier today.
		const span = windowSpan(clock, open, 0);
		return {
			period: "peak",
			text: `peak ${localRange(span, timeZone)}`,
			detail: `${windowRange(open)} = ${localRange(span, timeZone)}`,
		};
	}
	const next = nextWindow(clock);
	if (!next) return { period: "off-peak", text: "off-peak", detail: "peak windows are not scheduled" };
	const span = windowSpan(clock, next.window, next.dayOffset);
	const local = localRange(span, timeZone);
	return {
		period: "off-peak",
		text: `off-peak, peak ${local}`,
		detail: `peak ${WEEKDAYS[next.weekday]} ${windowRange(next.window)} = ${local}`,
	};
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
