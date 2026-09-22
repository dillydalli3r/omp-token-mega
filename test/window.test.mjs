// Verifies the provider usage windows: the all-or-nothing decode of the gateway's report, the
// endpoint derived from a model's own base URL, the fetch's headers and every way it fails
// without a report, the burn rate and its guards, the exhaustion ETA including the reset that
// lands first, the compact duration, the tint each window carries on the row, the advice
// lines, and the markdown section.
//
//   node test/window.test.mjs

import {
	WINDOW_PROVIDERS,
	burnRate,
	decodeUsage,
	duration,
	exhaustionEta,
	fetchUsage,
	usageEndpoint,
	windowAdvice,
	windowParts,
	windowProvider,
	windowSection,
} from "../src/window.js";

let passed = 0;
const failed = [];
const expect = (label, condition, extra) => {
	if (condition) passed += 1;
	else failed.push(label);
	console.log(`${condition ? "PASS" : "FAIL"}  ${label}${condition || extra === undefined ? "" : `  -> ${JSON.stringify(extra)}`}`);
};
const done = () => {
	if (failed.length > 0) {
		console.error(`\n${failed.length} failing:\n`);
		for (const label of failed) console.error(`  x ${label}`);
		console.error(`\n${passed} passed, ${failed.length} failed`);
		process.exit(1);
	}
	console.log(`all ${passed} checks passed`);
};

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);

/** The model this feature exists for: the Go route, on the flash model the plugin prices. */
const MODEL = {
	provider: "opencode-go",
	id: "deepseek-v4.1-flash",
	baseUrl: "https://opencode.ai/zen/go/v1",
	cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
};

const RESET = { rolling: NOW + 4 * HOUR + 12 * 60_000, weekly: NOW + 2 * DAY + 4 * HOUR, monthly: NOW + 10 * DAY };

/** One complete report, as the gateway sends it: all three windows, all ISO reset times. */
const report = () => ({
	usage: {
		rolling: { percent: 12, status: "ok", resetsAt: new Date(RESET.rolling).toISOString() },
		weekly: { percent: 84, status: "ok", resetsAt: new Date(RESET.weekly).toISOString() },
		monthly: { percent: 61, status: "ok", resetsAt: new Date(RESET.monthly).toISOString() },
	},
});

/** The same report with one field changed: the payload shapes an untrusted route can send. */
const mangled = (key, patch) => {
	const payload = report();
	Object.assign(payload.usage[key], patch);
	return payload;
};

const without = (key) => {
	const payload = report();
	delete payload.usage[key];
	return payload;
};

// ------------------------------------------------------------------- decode

const decoded = decodeUsage(report());
expect("decode: every window, in the order the provider declares them", decoded?.length === 3 && decoded.map((w) => w.id).join(",") === "5h,7d,monthly");
expect("decode: the table supplies the label", decoded?.[0].label === "5 Hour" && decoded?.[2].label === "Monthly");
expect("decode: an ISO reset becomes epoch ms", decoded?.[0].resetsAt === RESET.rolling);
expect("decode: a reset already in epoch ms is taken as it is", decodeUsage(mangled("rolling", { resetsAt: NOW }))?.[0].resetsAt === NOW);
// 84% is a perfectly healthy window; 80% is only where the reader wants to be warned.
expect("decode: below the warn line is ok, and above it is still ok", decoded?.[1].percent === 84 && decoded?.[1].status === "ok");
expect("decode: the provider's rate-limited flag reads exhausted", decodeUsage(mangled("weekly", { status: "rate-limited" }))?.[1].status === "exhausted");
expect("decode: at 100% reads exhausted", decodeUsage(mangled("monthly", { percent: 100 }))?.[2].status === "exhausted");
// All-or-nothing: one unusable window makes the whole report unusable, so a partial payload
// can never overwrite a complete last-good one.
expect("decode: a window the payload omits is unusable", decodeUsage(without("weekly")) === undefined);
expect("decode: a non-numeric percent is unusable", decodeUsage(mangled("rolling", { percent: "12" })) === undefined);
expect("decode: a status the route does not define is unusable", decodeUsage(mangled("rolling", { status: "paused" })) === undefined);
expect("decode: an unparseable reset time is unusable", decodeUsage(mangled("rolling", { resetsAt: "tomorrow" })) === undefined);
expect("decode: a missing reset time is unusable", decodeUsage(mangled("rolling", { resetsAt: undefined })) === undefined);
expect("decode: no usage object is unusable", decodeUsage({}) === undefined && decodeUsage(undefined) === undefined);

// -------------------------------------------------------- table and provider

expect("table: the go entry declares the documented route", WINDOW_PROVIDERS["opencode-go"].path === "/v1/usage" && WINDOW_PROVIDERS["opencode-go"].baseUrl === "https://opencode.ai/zen/go/v1");
expect("table: the rolling window is the one with a five-hour length", WINDOW_PROVIDERS["opencode-go"].windows[0].durationMs === 5 * HOUR);
expect("provider: a provider with a usage route resolves", windowProvider(MODEL) === WINDOW_PROVIDERS["opencode-go"]);
expect("provider: a provider with none resolves to nothing", windowProvider({ provider: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta" }) === undefined);
expect("provider: no model resolves to nothing", windowProvider(undefined) === undefined);
expect("provider: the table is not reached through the prototype", windowProvider({ provider: "constructor" }) === undefined);

// ----------------------------------------------------------------- endpoint

expect("endpoint: the route is the base URL plus the declared path", usageEndpoint(MODEL) === "https://opencode.ai/zen/go/v1/usage");
expect("endpoint: a base without the version suffix gets the full path", usageEndpoint({ provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go" }) === "https://opencode.ai/zen/go/v1/usage");
expect("endpoint: a trailing slash is not a doubled path", usageEndpoint({ provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1/" }) === "https://opencode.ai/zen/go/v1/usage");
expect("endpoint: a base carrying a version suffix is not doubled", usageEndpoint({ provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" }) === "https://opencode.ai/zen/go/v1/usage");
expect("endpoint: a model with no base URL falls back to the provider's", usageEndpoint({ provider: "opencode-go" }) === "https://opencode.ai/zen/go/v1/usage");
expect("endpoint: another provider has no route to ask", usageEndpoint({ provider: "deepseek", baseUrl: "https://api.deepseek.com/v1" }) === undefined);

// --------------------------------------------------------------- fetchUsage

const ENDPOINT = "https://opencode.ai/zen/go/v1/usage";
let captured;
const stub = (response) => async (url, init) => {
	captured = { url, init };
	return response;
};
const okResponse = () => stub({ ok: true, status: 200, json: async () => report() });

captured = undefined;
const fetched = await fetchUsage({ endpoint: ENDPOINT, apiKey: "sk-test", sessionId: "install-42", fetchImpl: okResponse() });
expect("fetch: the call goes to the endpoint it was given", captured?.url === ENDPOINT);
expect("fetch: accept and authorization headers", captured?.init.headers.accept === "application/json" && captured?.init.headers.authorization === "Bearer sk-test");
expect("fetch: the user agent names the plugin", captured?.init.headers["user-agent"] === "omp-token-mega");
expect("fetch: the install id rides the read", captured?.init.headers["x-opencode-session"] === "install-42");
expect(
	"fetch: success yields the decoded windows and when they were read",
	fetched?.windows.length === 3 && fetched.windows[0].percent === 12 && fetched.endpoint === ENDPOINT && typeof fetched.fetchedAt === "number",
	fetched,
);

captured = undefined;
await fetchUsage({ endpoint: ENDPOINT, apiKey: "sk-test", fetchImpl: okResponse() });
expect("fetch: with no session id, no session header", captured?.init.headers["x-opencode-session"] === undefined);

captured = undefined;
const controller = new AbortController();
await fetchUsage({ endpoint: ENDPOINT, apiKey: "sk-test", fetchImpl: okResponse(), signal: controller.signal });
expect("fetch: the caller's abort signal is passed through", captured?.init.signal === controller.signal);

expect("fetch: 401 keeps the last good report", (await fetchUsage({ endpoint: ENDPOINT, apiKey: "sk-bad", fetchImpl: stub({ ok: false, status: 401 }) })) === undefined);
expect("fetch: 403 keeps it too", (await fetchUsage({ endpoint: ENDPOINT, apiKey: "sk-bad", fetchImpl: stub({ ok: false, status: 403 }) })) === undefined);
expect("fetch: a 500 is not a report either", (await fetchUsage({ endpoint: ENDPOINT, apiKey: "sk-test", fetchImpl: stub({ ok: false, status: 500 }) })) === undefined);
expect(
	"fetch: a body that is not JSON is not a report",
	(await fetchUsage({
		endpoint: ENDPOINT,
		apiKey: "sk-test",
		fetchImpl: stub({
			ok: true,
			status: 200,
			json: async () => {
				throw new SyntaxError("Unexpected token");
			},
		}),
	})) === undefined,
);
expect(
	"fetch: a body that does not decode is not a report",
	(await fetchUsage({ endpoint: ENDPOINT, apiKey: "sk-test", fetchImpl: stub({ ok: true, status: 200, json: async () => without("monthly") }) })) === undefined,
);
expect(
	"fetch: a network failure is not a report",
	(await fetchUsage({
		endpoint: ENDPOINT,
		apiKey: "sk-test",
		fetchImpl: async () => {
			throw new Error("ECONNREFUSED");
		},
	})) === undefined,
);
let called = 0;
const counting = async () => {
	called += 1;
	return { ok: true, status: 200, json: async () => report() };
};
expect("fetch: no key, no request", (await fetchUsage({ endpoint: ENDPOINT, apiKey: "", fetchImpl: counting })) === undefined && called === 0);
expect("fetch: no endpoint, no request", (await fetchUsage({ apiKey: "sk-test", fetchImpl: counting })) === undefined && called === 0);

// ----------------------------------------------------------------- burnRate

expect("burnRate: percent per hour from the first and last sample", burnRate([{ at: NOW, percent: 10 }, { at: NOW + 30 * 60_000, percent: 16 }]) === 12);
expect("burnRate: rounded to two decimals", burnRate([{ at: NOW, percent: 10 }, { at: NOW + 3 * HOUR, percent: 11 }]) === 0.33);
expect("burnRate: one sample is not a rate", burnRate([{ at: NOW, percent: 10 }]) === undefined && burnRate([]) === undefined && burnRate(undefined) === undefined);
expect("burnRate: a zero time delta is not a rate", burnRate([{ at: NOW, percent: 10 }, { at: NOW, percent: 20 }]) === undefined);
expect("burnRate: a falling percentage is not a rate", burnRate([{ at: NOW, percent: 20 }, { at: NOW + HOUR, percent: 10 }]) === undefined);
expect("burnRate: an unparseable sample is not a rate", burnRate([{ at: NOW, percent: "10" }, { at: NOW + HOUR, percent: 20 }]) === undefined);

// ------------------------------------------------------------ exhaustionEta

const rolling = decoded[0];
expect("eta: a pace and a roomy reset give the time to 100%", exhaustionEta({ ...rolling, percent: 80, resetsAt: NOW + DAY }, 10, NOW) === 2 * HOUR);
expect("eta: the reset landing first means the window never exhausts", exhaustionEta({ ...rolling, percent: 80, resetsAt: NOW + HOUR }, 10, NOW) === undefined);
expect("eta: a window behind its own reset has nothing left to project", exhaustionEta({ ...rolling, percent: 80, resetsAt: NOW - HOUR }, 10, NOW) === undefined && exhaustionEta({ ...rolling, percent: 80, resetsAt: NOW }, 10, NOW) === undefined);
expect("eta: an exhausted window has no eta", exhaustionEta({ ...rolling, percent: 100 }, 10, NOW) === undefined);
expect("eta: the provider's own flag also closes the projection", exhaustionEta({ ...rolling, status: "exhausted", percent: 40 }, 10, NOW) === undefined);
expect("eta: no pace, no eta", exhaustionEta({ ...rolling, percent: 40 }, 0, NOW) === undefined && exhaustionEta({ ...rolling, percent: 40 }, undefined, NOW) === undefined);
expect("eta: 12% burning at 50%/h exhausts inside its 4h12m reset", exhaustionEta(rolling, 50, NOW) === Math.round((88 / 50) * HOUR));
expect("eta: the same pace with the reset moved inside it gives nothing", exhaustionEta({ ...rolling, resetsAt: NOW + HOUR }, 50, NOW) === undefined);

// ----------------------------------------------------------------- duration

expect("duration: hours and minutes", duration(4_200_000) === "1h10m");
expect("duration: a whole hour keeps one unit", duration(HOUR) === "1h");
expect("duration: seconds below a minute", duration(30_000) === "30s");
expect("duration: days and hours", duration(2 * DAY + 4 * HOUR) === "2d4h");
expect("duration: a whole number of days", duration(2 * DAY) === "2d");
expect("duration: minutes and seconds", duration(90_000) === "1m30s");
expect("duration: a countdown of a moment already past has no form", duration(-1) === undefined && duration(undefined) === undefined);

// -------------------------------------------------------------- windowParts

const parts = windowParts(decoded, { now: NOW });
expect("parts: one part per window, with id, percent and countdown", parts.length === 3 && parts[0].text === "5h 12% \u21bb4h12m", parts);
expect("parts: the countdown is dropped once the reset has passed", windowParts([{ ...rolling, resetsAt: NOW - HOUR }], { now: NOW })[0].text === "5h 12%");
expect("parts: a healthy window is left plain", parts[0].color === undefined);
expect("parts: exactly at warnAt is already a warning", windowParts([{ ...rolling, percent: 80 }], { now: NOW })[0].color === "yellow");
expect("parts: above warnAt is a warning", windowParts([{ ...rolling, percent: 91 }], { now: NOW })[0].color === "yellow");
expect("parts: 100% is exhausted and red", windowParts([{ ...rolling, percent: 100 }], { now: NOW })[0].color === "red");
expect("parts: the provider's own flag is red below 100%", windowParts([{ ...decoded[1], status: "exhausted", percent: 84 }], { now: NOW })[0].color === "red");
expect("parts: another warn line moves the tint", windowParts([{ ...rolling, percent: 50 }], { now: NOW, warnAt: 50 })[0].color === "yellow");
expect("parts: no windows, nothing to draw", windowParts(undefined, { now: NOW }) === undefined);

// ------------------------------------------------------------- windowAdvice

const advice = windowAdvice(decoded, { now: NOW, percentPerHour: 40 });
expect("advice: a window ahead of its own reset is paced", advice.some((line) => line.includes("**5 Hour**") && line.includes("12% used") && line.includes("exhaustion in 2h12m, ahead of the reset in 4h12m") && line.includes("Pace requests.")), advice);
expect("advice: every window earning a line gets one", advice.length === 3, advice);
expect("advice: a closed window has only the reset left", windowAdvice([{ ...rolling, percent: 100 }], { now: NOW })[0].includes("Wait for the reset."));
expect("advice: a window the provider closed waits for the reset too", windowAdvice([{ ...decoded[1], status: "exhausted" }], { now: NOW })[0].includes("Wait for the reset."));
const unpaced = windowAdvice([decoded[1]], { now: NOW });
expect("advice: no measured pace names the one action that needs none", unpaced.length === 1 && unpaced[0].includes("**Weekly**") && unpaced[0].includes("no burn rate measured") && unpaced[0].includes("switch model."), unpaced);
expect(
	"advice: a reset inside the projection says so instead of inventing an eta",
	windowAdvice([{ ...rolling, percent: 80, resetsAt: NOW + HOUR }], { now: NOW, percentPerHour: 10 })[0].includes("exhaustion in 2h, but the reset in 1h lands first. Pace requests."),
);
expect("advice: a quiet window says nothing", windowAdvice([decoded[0]], { now: NOW, percentPerHour: 1 })?.length === 0);
expect(
	"advice: a reset already behind the clock is named, not reported missing",
	windowAdvice([{ ...rolling, percent: 80, resetsAt: NOW - HOUR }], { now: NOW, percentPerHour: 10 })[0].includes("exhaustion in 2h, the reset time has passed. Pace requests."),
);
expect("advice: no report, no advice", windowAdvice(undefined, { now: NOW }) === undefined);

// ------------------------------------------------------------ windowSection

const section = windowSection(decoded, { now: NOW, percentPerHour: 40, endpoint: ENDPOINT });
expect("section: a heading and the route it read", section.startsWith("### Usage windows\n") && section.includes(`- Endpoint: \`${ENDPOINT}\``), section);
expect("section: one row per window, under a header and a separator", (section.match(/^\| /gm) ?? []).length === 5, section);
expect(
	"section: each row carries the label, percent, status and the reset in local time",
	/^\| 5 Hour \| 12% \| ok \| .+\(in 4h12m\) \|$/m.test(section) && /^\| Weekly \| 84% \| warning \| .+\(in 2d4h\) \|$/m.test(section) && /^\| Monthly \| 61% \| ok \| .+\(in 10d\) \|$/m.test(section),
	section,
);
expect("section: the advice follows the table", section.includes("Pace requests."), section);
expect(
	"section: a reset behind the clock is marked as past, not counted down",
	windowSection([{ ...rolling, resetsAt: NOW - HOUR }], { now: NOW }).includes("(past)"),
);
expect("section: no report, no section", windowSection(undefined, { now: NOW }) === undefined);

done();
