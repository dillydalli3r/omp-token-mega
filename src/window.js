/**
 * The provider's rate-limit windows: what a session has already spent, how fast it is
 * spending it, and when the window comes back.
 *
 * A long agent session on the Go gateway ends the same way every time: not with a bigger
 * bill but with the window closing mid-task, where the first thing that reveals the ceiling
 * is the request that fails. The gateway's usage route publishes the figures up front —
 * three rolling windows, each with a percentage, a status and a reset time — so a session
 * can be paced while it still has room, and a switch to another model can be a decision
 * rather than a recovery. Reading that route is the whole job of this module.
 *
 * Three properties shape everything below:
 *
 *   all-or-nothing decode   Each report replaces the last good one in the state it is
 *                           written to, so a payload with one window missing or malformed is
 *                           unusable *whole*. A partial report that overwrites a complete one
 *                           turns a stale-but-true number into a wrong one, and a wrong number
 *                           is exactly what walks a session into the ceiling it was tracking.
 *   nothing global          Every helper is pure: the clock, the endpoint, the key, the
 *                           session id, the fetch implementation and the samples all arrive
 *                           as arguments. Resolving the credential and owning the poll timer
 *                           belongs to the installer, which is also what lets this module be
 *                           exercised without a network, a session or a timer.
 *   one tint per window     The row shows each window as its own part, because the color a
 *                           window carries is the message — `red` this one is closed,
 *                           `yellow` this one is close — and a part flattened into a plain
 *                           string (see ./status.js) cannot be tinted afterwards.
 */

/** The one provider whose usage route this plugin reads. */
const OPENCODE_GO = "opencode-go";

/** The route the gateway documents for its own usage report, relative to the chat base URL. */
const USAGE_PATH = "/v1/usage";

/** Names the plugin, not the user: the gateway dedupes this route by UA, not by account. */
const USER_AGENT = "omp-token-mega";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The percentage a window warns at. A warning is only worth raising while there is still room
 * to act on it: at 80% of a window, a fifth of it is left — more than one long agent turn —
 * so the reader can finish the turn, switch model, or let the window reset, instead of being
 * told about the ceiling by the request that hits it.
 */
const WARN_AT = 80;

/** Duration units, largest first, each with the glyph that follows it in the compact form. */
const UNITS = [
	{ suffix: "d", ms: DAY_MS },
	{ suffix: "h", ms: HOUR_MS },
	{ suffix: "m", ms: 60_000 },
	{ suffix: "s", ms: 1000 },
];

/**
 * Where each provider publishes its windows, and what its payload calls them.
 *
 * The table is the only provider-specific thing here: the route, and one entry per window
 * with the key the payload uses, the short id and label the row and the section show, and the
 * window's own length. `usageEndpoint` and `decodeUsage` read it, so a second provider with a
 * usage route is an entry and nothing else.
 */
export const WINDOW_PROVIDERS = {
	[OPENCODE_GO]: {
		baseUrl: "https://opencode.ai/zen/go/v1",
		path: USAGE_PATH,
		windows: [
			{ key: "rolling", id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS },
			{ key: "weekly", id: "7d", label: "Weekly", durationMs: 7 * DAY_MS },
			// The monthly window has no published length, so its row counts down from the
			// reset timestamp alone and the window's own duration stays unknown.
			{ key: "monthly", id: "monthly", label: "Monthly", durationMs: undefined },
		],
	},
};

/** Finite number, or undefined. Every figure below arrives from a payload or a caller. */
function num(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Two decimals, the precision a percentage-per-hour reading is worth: 0.33, never 0.3333. */
function round2(value) {
	return Math.round(value * 100) / 100;
}

/**
 * Epoch milliseconds from a reset timestamp. The payload sends an ISO string, but a number
 * already in epoch milliseconds is accepted too; anything else is undefined, because a reset
 * time that cannot be placed on the clock cannot be counted down.
 */
function timestamp(value) {
	const direct = num(value);
	if (direct !== undefined) return direct;
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** One window's reset time in epoch milliseconds, or undefined when it is unusable. */
function resetTime(window) {
	return timestamp(window?.resetsAt);
}

/**
 * The status of one window as a reader sees it, from its decoded status and its percentage.
 *
 * The hard stop wins over the warn line, and a window the provider itself flagged as
 * rate-limited reads as exhausted whatever percentage it reports: the percentage is a retry
 * hint, the flag is the fact.
 */
function windowStatus(window, warnAt) {
	const percent = num(window?.percent);
	const warn = num(warnAt) ?? WARN_AT;
	if (window?.status === "exhausted" || (percent !== undefined && percent >= 100)) return "exhausted";
	if (percent !== undefined && percent >= warn) return "warning";
	return "ok";
}

/** The tone each status carries on the row; `undefined` leaves the part plain. */
const STATUS_TINT = { exhausted: "red", warning: "yellow", ok: undefined };

/**
 * Milliseconds until the window reaches 100% at the given pace, ignoring the reset.
 * undefined when the pace is not a positive number or the window has nothing left to spend:
 * a projection from either is not a projection.
 */
function projectedEta(window, percentPerHour) {
	const rate = num(percentPerHour);
	const percent = num(window?.percent);
	if (rate === undefined || rate <= 0) return undefined;
	if (percent === undefined || window?.status === "exhausted" || percent >= 100) return undefined;
	return ((100 - percent) / rate) * HOUR_MS;
}

/**
 * The usage table entry for a model's provider, or undefined when this plugin reads no usage
 * route for it — which is every provider but one.
 */
export function windowProvider(model) {
	const provider = model?.provider;
	if (typeof provider !== "string" || !Object.hasOwn(WINDOW_PROVIDERS, provider)) return undefined;
	return WINDOW_PROVIDERS[provider];
}

/**
 * The usage route for a model: the model's own base URL (the route this session is actually
 * billing on, so the call reads the account being spent) with its OpenAI-compatible version
 * suffix dropped and the provider's path appended —
 * `https://opencode.ai/zen/go/v1` -> `https://opencode.ai/zen/go/v1/usage`.
 *
 * undefined for a provider with no usage route, and for a model with neither its own base URL
 * nor the provider's.
 */
export function usageEndpoint(model) {
	const provider = windowProvider(model);
	if (!provider) return undefined;
	const declared = typeof model?.baseUrl === "string" && model.baseUrl.trim() !== "" ? model.baseUrl : provider.baseUrl;
	const base = String(declared ?? "")
		.trim()
		.replace(/\/+$/, "")
		.replace(/\/v\d+$/i, "");
	if (base === "") return undefined;
	return `${base}${provider.path}`;
}

/**
 * Normalize an untrusted usage payload into `[{ id, label, percent, status, resetsAt }]`, in
 * the order the provider declares its windows, or undefined when the payload is not a
 * complete report — see the all-or-nothing note at the top of this file.
 *
 * `status` here is the window's own state, not the reader's: the warn line is a threshold of
 * whoever is looking at the row, so it belongs to `windowParts` and `windowSection` and is
 * applied there, while this function answers only what the provider said.
 */
export function decodeUsage(payload, provider = WINDOW_PROVIDERS[OPENCODE_GO]) {
	if (!provider || !Array.isArray(provider.windows)) return undefined;
	const usage = payload?.usage;
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
	const windows = [];
	for (const def of provider.windows) {
		const entry = usage[def.key];
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
		// A percentage outside 0..100 is not a percentage this route can mean; a negative one
		// is not a percentage at all.
		const percent = num(entry.percent);
		if (percent === undefined || percent < 0) return undefined;
		if (entry.status !== "ok" && entry.status !== "rate-limited") return undefined;
		const resetsAt = timestamp(entry.resetsAt);
		if (resetsAt === undefined) return undefined;
		windows.push({
			id: def.id,
			label: def.label,
			percent,
			status: entry.status === "rate-limited" || percent >= 100 ? "exhausted" : "ok",
			resetsAt,
		});
	}
	return windows;
}

/**
 * Fetch and decode the usage report: `{ windows, fetchedAt, endpoint }`.
 *
 * undefined on anything that leaves the numbers unknown — nothing to ask with, a network
 * failure, a non-2xx (401/403 mean a bad key or an account with no Go subscription; every
 * other status is transient — either way the caller keeps the last good report rather than
 * replacing it with a guess), or a payload that does not decode. It never throws: it is
 * called from a timer callback, where a throw is an unhandled rejection.
 */
export async function fetchUsage({ endpoint, apiKey, sessionId, fetchImpl, signal } = {}) {
	if (typeof endpoint !== "string" || endpoint.trim() === "") return undefined;
	const key = apiKey === undefined || apiKey === null ? "" : String(apiKey).trim();
	if (key === "") return undefined;
	const send = fetchImpl ?? globalThis.fetch;
	if (typeof send !== "function") return undefined;
	const headers = {
		accept: "application/json",
		authorization: `Bearer ${key}`,
		"user-agent": USER_AGENT,
	};
	// The install id, when the caller has one: it ties this read to the session whose spend it
	// reports, and the route rejects no request without it.
	if (sessionId) headers["x-opencode-session"] = String(sessionId);
	try {
		const response = await send(endpoint, signal ? { headers, signal } : { headers });
		if (response?.ok === false) return undefined;
		const status = num(response?.status);
		if (status !== undefined && (status < 200 || status >= 300)) return undefined;
		// Neither signal: something that is not a response came back, so there is no report.
		if (response?.ok !== true && status === undefined) return undefined;
		const windows = decodeUsage(await response.json());
		if (windows === undefined) return undefined;
		return { windows, fetchedAt: Date.now(), endpoint };
	} catch {
		return undefined;
	}
}

/**
 * Percent per hour between the first and the last sample of `[{ at, percent }]`, ascending, or
 * undefined when the pair cannot carry a rate.
 *
 * Only the endpoints are read. A rate fitted through every sample would smooth exactly the
 * step change the row exists to show — a compaction re-reading a megabyte of context, a
 * subagent fanned out on the same window — and two points are the shape of a short history.
 * A pair that spans no time, or whose percentage did not rise, has no rate at all: a session
 * between turns and a window just reset both look flat, and reporting a rate for them would
 * make the projection that reads it meaningless.
 */
export function burnRate(samples) {
	if (!Array.isArray(samples) || samples.length < 2) return undefined;
	const first = samples[0];
	const last = samples[samples.length - 1];
	const from = num(first?.at);
	const to = num(last?.at);
	const before = num(first?.percent);
	const after = num(last?.percent);
	if (from === undefined || to === undefined || before === undefined || after === undefined) return undefined;
	const elapsed = to - from;
	const delta = after - before;
	if (elapsed <= 0 || delta <= 0) return undefined;
	return round2(delta / (elapsed / HOUR_MS));
}

/**
 * When this window reaches 100% at the measured pace: milliseconds from `now`.
 *
 * undefined when no pace is known and when the window is already exhausted — and, the case
 * worth spelling out, when the reset lands first. A window that comes back before it would
 * run out does not run out, so an ETA there would be a number the reader acts on and the
 * window never delivers.
 */
export function exhaustionEta(window, percentPerHour, now) {
	const eta = projectedEta(window, percentPerHour);
	if (eta === undefined) return undefined;
	const resetAt = resetTime(window);
	const at = num(now) ?? Date.now();
	if (resetAt !== undefined && resetAt - at <= eta) return undefined;
	return Math.round(eta);
}

/**
 * Compact duration: 4_200_000 -> "1h10m", 3_600_000 -> "1h", 30_000 -> "30s", a day and four
 * hours -> "2d4h", and a whole number of days -> "2d".
 *
 * Two units at most, and the lower one dropped when it is zero: a countdown is read at a
 * glance ("4h12m", never "4h12m03s"), while the unit below the leading one is what says
 * whether the leading figure is barely there or all but rounded up. undefined for a negative
 * or non-finite input — a countdown of a moment already past is not a countdown.
 */
export function duration(ms) {
	const value = num(ms);
	if (value === undefined || value < 0) return undefined;
	for (const [index, unit] of UNITS.entries()) {
		if (value < unit.ms && index < UNITS.length - 1) continue;
		const whole = Math.floor(value / unit.ms);
		const next = UNITS[index + 1];
		if (next === undefined) return `${whole}${unit.suffix}`;
		const rest = Math.floor((value % unit.ms) / next.ms);
		return rest > 0 ? `${whole}${unit.suffix}${rest}${next.suffix}` : `${whole}${unit.suffix}`;
	}
	return undefined;
}

/**
 * The row parts for the usage segment: one `{ text, color }` per window, in the order the
 * provider declares them — `"5h 12% ↻4h12m"`, tinted `red` when the window is closed and
 * `yellow` once it is past the warn line.
 *
 * `now` and `warnAt` are arguments rather than reads of a clock and a configuration, because
 * the row is redrawn on every turn over the same report: only the clock moves, and the caller
 * already owns both.
 *
 * The countdown is omitted once the reset has passed. A window whose reset time is behind the
 * clock is one the poller has not refreshed yet, and a negative countdown would read as a bug
 * in the row rather than as a stale report.
 */
export function windowParts(windows, { now = Date.now(), warnAt = WARN_AT } = {}) {
	if (!Array.isArray(windows)) return undefined;
	const at = num(now) ?? Date.now();
	const parts = [];
	for (const window of windows) {
		const percent = num(window?.percent);
		if (percent === undefined) continue;
		const resetAt = resetTime(window);
		const remaining = resetAt === undefined ? undefined : resetAt - at;
		const countdown = remaining !== undefined && remaining > 0 ? duration(remaining) : undefined;
		parts.push({
			text: `${window?.id ?? window?.label ?? "?"} ${Math.round(percent)}%${countdown ? ` \u21bb${countdown}` : ""}`,
			color: STATUS_TINT[windowStatus(window, warnAt)],
		});
	}
	return parts;
}

/** One advice line: the window, its percentage, the pace, the projection, and one action. */
function adviceLine({ window, percent, status, rate, projected, eta, at }) {
	const label = window?.label ?? window?.id ?? "window";
	const resetAt = resetTime(window);
	const remaining = resetAt === undefined ? undefined : resetAt - at;
	const resetPhrase =
		remaining === undefined ? "no reset time reported" : remaining > 0 ? `the reset in ${duration(remaining)}` : "the reset time has passed";
	const used = `${Math.round(percent)}% used`;
	if (status === "exhausted") {
		// Nothing here can be paced out of a closed window: the only thing left is the reset.
		return `- **${label}**: ${used}, already exhausted — ${resetPhrase}. Wait for the reset.`;
	}
	// A window past the warn line with no measured pace is the one case this module cannot
	// project: pacing needs a speed, so the honest action is to route the work elsewhere
	// rather than to guess how close the window is.
	if (rate === undefined || rate <= 0 || projected === undefined) {
		return `- **${label}**: ${used}, no burn rate measured — switch model.`;
	}
	const burn = `burning ${round2(rate)}%/h`;
	if (eta !== undefined) {
		const ahead = remaining !== undefined && remaining > eta ? `, ahead of ${resetPhrase}` : "";
		return `- **${label}**: ${used}, ${burn} — exhaustion in ${duration(eta)}${ahead}. Pace requests.`;
	}
	if (remaining !== undefined && remaining > 0) {
		return `- **${label}**: ${used}, ${burn} — exhaustion in ${duration(projected)}, but the reset in ${duration(remaining)} lands first. Pace requests.`;
	}
	// No reset ahead of the projection: either none was reported, or the one on file is
	// already due, which `resetPhrase` says rather than hiding behind "unknown".
	return `- **${label}**: ${used}, ${burn} — exhaustion in ${duration(projected)}, ${resetPhrase}. Pace requests.`;
}

/**
 * The advice lines for `/mega`, one per window that has something to say, each naming the
 * current percentage, the pace it was measured at, where the projected exhaustion lands
 * relative to the reset, and one action: `pace requests`, `switch model` or
 * `wait for the reset`.
 *
 * A window gets a line while it is at or past the warn line, or as soon as the measured pace
 * projects exhaustion before its reset — the second case is the point of the feature: at 40%
 * and climbing fast, the useful moment to act is well before 80%.
 */
export function windowAdvice(windows, { now = Date.now(), warnAt = WARN_AT, percentPerHour } = {}) {
	if (!Array.isArray(windows)) return undefined;
	const at = num(now) ?? Date.now();
	const rate = num(percentPerHour);
	const lines = [];
	for (const window of windows) {
		const percent = num(window?.percent);
		if (percent === undefined) continue;
		const status = windowStatus(window, warnAt);
		const eta = exhaustionEta(window, rate, at);
		if (status === "ok" && eta === undefined) continue;
		lines.push(adviceLine({ window, percent, status, rate, projected: projectedEta(window, rate), eta, at }));
	}
	return lines;
}

/** The reset column: the local clock time plus the countdown, or the reason there is none. */
function resetCell(window, at) {
	const resetAt = resetTime(window);
	if (resetAt === undefined) return "n/a";
	const clock = new Date(resetAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (resetAt <= at) return `${clock} (past)`;
	const countdown = duration(resetAt - at);
	return countdown === undefined ? clock : `${clock} (in ${countdown})`;
}

/**
 * The `/mega` section: one markdown row per window — label, percentage, status, and the reset
 * as it falls on the reader's own clock with the countdown to it — followed by the advice.
 * undefined when there is no report to show, which is what tells the caller apart "this
 * provider reports no windows" from a report with an empty list.
 */
export function windowSection(windows, { now = Date.now(), warnAt = WARN_AT, percentPerHour, endpoint } = {}) {
	if (!Array.isArray(windows)) return undefined;
	const at = num(now) ?? Date.now();
	const lines = ["### Usage windows", ""];
	if (typeof endpoint === "string" && endpoint !== "") lines.push(`- Endpoint: \`${endpoint}\``, "");
	lines.push("| Window | Used | Status | Resets |", "| --- | ---: | --- | --- |");
	for (const window of windows) {
		const percent = num(window?.percent);
		const used = percent === undefined ? "n/a" : `${Math.round(percent)}%`;
		lines.push(`| ${window?.label ?? window?.id ?? "?"} | ${used} | ${windowStatus(window, warnAt)} | ${resetCell(window, at)} |`);
	}
	const advice = windowAdvice(windows, { now: at, warnAt, percentPerHour }) ?? [];
	lines.push("", ...(advice.length > 0 ? advice : ["- No window is near its ceiling."]));
	return lines.join("\n");
}
