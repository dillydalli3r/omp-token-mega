/**
 * The account behind the active model: its balance, and the USD cost of this session.
 *
 * Active while the ACTIVE model is one this plugin can account for — every model that
 * declares a cache-read rate, plus every provider whose models cache prefix context even
 * where the rate is unset (see `cacheCapable` in ./model.js). On any other model: no row
 * segment, no balance request, no timer. Switching away hides the segment and stops all
 * network traffic; switching back resumes it. The session spend is read from the session
 * branch and needs no network, so it survives a failing balance call and stays available
 * with the poller switched off.
 *
 * Where a balance can come from is the only provider-specific part, and exactly one
 * provider has one this plugin reads:
 *
 *   deepseek   GET /user/balance, polled on a managed timer like any other account figure.
 *   lithosai   nothing to poll: the API publishes no balance endpoint, and the prepaid
 *              figure is read in the console. What the wire does say is reported instead —
 *              a 402 `insufficient_quota` means the account is out of credit, an admitted
 *              response means it is not zero — and the console is named.
 *   every other nothing to poll either, and no wire signal this plugin interprets, so the
 *              section names the provider honestly instead of inventing a figure for it.
 *              Reporting the session cost there is the whole point: a Gemini or
 *              opencode-go session shows its own spend where a DeepSeek session does.
 *
 * A second account figure is not a balance at all: the quota windows a provider meters the
 * account with. OpenCode Go publishes three (`GET /v1/usage`: 5-hour, weekly, monthly), each a
 * percent used, a status and the instant it resets, and those are what decides whether a
 * session can still bill — a spent window stops the work no matter how much credit is left.
 * They are polled on the same timer, in the same refresh, with the same last-good-on-failure
 * policy as a balance, and they are reported in the same section: the account behind the
 * model, whether that account is a balance or a window.
 *
 * Everything after that line is the same on all of them, which is the point: the used and
 * cached figures, the two buckets and the table are what a session costs on any of them.
 *
 * Two buckets, kept separate so a subagent's spend is never double counted:
 *
 *   parent — LLM calls this session paid for directly: assistant turns plus the
 *            model-generated `branch_summary` / `compaction` entries.
 *   agents — subagent (`task` tool) children. omp accumulates each child's own
 *            usage and hands it back on the tool result as `details.usage`, which is
 *            what `usage.js` reads.
 */

import { balanceText, fetchBalance, resolveCredentials } from "./balance-client.js";
import { DEEPSEEK_PROVIDER } from "./deepseek.js";
import { LITHOS_BILLING_URL, LITHOS_PROVIDER, lithosRates } from "./lithosai.js";
import { money, percent } from "./measure.js";
import { activeModel, cacheCapable, cachePriced, modelKey } from "./model.js";
import { sessionSpend } from "./usage.js";
import { burnRate, fetchUsage, usageEndpoint, windowParts, windowProvider, windowSection } from "./window.js";

const BALANCE_RETRY_MS = 15_000;

/**
 * One entry per provider this feature speaks for: the section title, and the tag that opens
 * the row segment. The tag names the account the session is spending on, so every provider
 * carries one — DeepSeek's `DS` sits where a Gemini session's `GEMINI` sits, and the figures
 * after it are the same on either. The three Google provider ids are one account because
 * they are one account surface, which is why they share a tag.
 */
const ACCOUNTS = {
	[DEEPSEEK_PROVIDER]: { label: "DeepSeek", tag: "DS" },
	[LITHOS_PROVIDER]: { label: "LithosAI", tag: "LITHOS" },
	"opencode-go": { label: "OpenCode Go", tag: "GO" },
	"opencode-zen": { label: "OpenCode Zen", tag: "ZEN" },
	google: { label: "Google Gemini", tag: "GEMINI" },
	"google-vertex": { label: "Google Gemini", tag: "GEMINI" },
	"google-antigravity": { label: "Google Gemini", tag: "GEMINI" },
	anthropic: { label: "Anthropic", tag: "CLAUDE" },
	openai: { label: "OpenAI", tag: "OAI" },
	openrouter: { label: "OpenRouter", tag: "OR" },
};

/**
 * The identity of the account being spent: the declared entry, or a derived one for a
 * provider this plugin accounts for without having a name for. The derived tag is the first
 * four characters of the provider id uppercased, so a model that declares a cache-read rate
 * is never dropped from the feature just because its provider is unlisted.
 */
function accountIdentity(provider) {
	const declared = ACCOUNTS[provider];
	if (declared) return declared;
	const id = String(provider ?? "");
	return { label: id || "unknown provider", tag: id.slice(0, 4).toUpperCase() || "?" };
}

export function installBalance(pi, shell) {
	const state = {
		ctx: undefined,
		balance: undefined,
		balanceError: undefined,
		balanceFetchedAt: 0,
		/** The quota windows last read from the provider, and what went wrong reading them. */
		windows: undefined,
		windowsError: undefined,
		windowsFetchedAt: 0,
		/** One `{ at, percent }` sample of the shortest window per refresh, for the burn rate. */
		samples: [],
		timer: undefined,
		inFlight: false,
		spendCache: { key: undefined, value: undefined },
		/** Last provider response, for the LithosAI credit state: `{ status, at }`. */
		credit: undefined,
	};

	const values = () => shell.values();
	const ttlMs = () => Math.max(15, Number(values()["balance.ttlSeconds"]) || 60) * 1000;
	/** Percent at which a quota window turns yellow in the row and in the report. */
	const warnAt = () => Math.min(99, Math.max(50, Number(values()["window.warnAt"]) || 80));

	/**
	 * The account the session is spending, or `undefined` when the model is not one this
	 * plugin can speak for — the single source of truth for "should this feature be doing
	 * anything". The gate is `cacheCapable`, so a model that declares a cache-read rate is
	 * spoken for on any provider, not only on the two whose account surfaces are special.
	 * `priced` says whether the model carries rates at all: a session on one that does not
	 * shows `n/a`, never the `$0.00` that reads as free. LithosAI is the exception because
	 * its rates are declared by this plugin rather than by the catalog, so "priced" is
	 * whether `lithosRates` could resolve them.
	 */
	function accountOf(ctx) {
		const model = activeModel(ctx);
		if (!cacheCapable(model)) return undefined;
		const provider = model?.provider;
		return {
			provider,
			...accountIdentity(provider),
			priced: provider === LITHOS_PROVIDER ? lithosRates(model?.id, values()).source !== "unknown" : cachePriced(model),
		};
	}

	/** The master switch on one of the models this feature accounts for: the row segment's gate. */
	const gated = () => values().enabled === true && accountOf(state.ctx) !== undefined;
	/** Polling on top of the gate: only DeepSeek publishes a balance to poll. */
	const balancePolled = () => gated() && accountOf(state.ctx).provider === DEEPSEEK_PROVIDER && values()["balance.enabled"] === true;
	/**
	 * Windows are a second, independent account figure: a provider that publishes quota
	 * windows has them polled whether or not it also publishes a balance, which is why this
	 * is a gate of its own rather than a clause of the balance one.
	 */
	const windowPolled = () =>
		gated() && values()["window.enabled"] === true && windowProvider(activeModel(state.ctx)) !== undefined;
	/** The timer runs while *any* polled account figure is in scope. */
	const polling = () => balancePolled() || windowPolled();

	/**
	 * The credential the live model's own request path would use. The usage route bills the
	 * account behind that model, so it reads the same key the session's requests carry
	 * rather than a provider-wide default.
	 */
	async function liveApiKey(ctx) {
		try {
			const resolved = await ctx?.modelRegistry?.getApiKeyAndHeaders?.(activeModel(ctx));
			if (resolved?.ok) return resolved.apiKey;
		} catch {
			// An unreadable credential store is a missing poll, never a broken session.
		}
		return undefined;
	}

	function spendNow(ctx) {
		const branch = ctx?.sessionManager?.getBranch?.() ?? [];
		const key = `${ctx?.sessionManager?.getSessionId?.() ?? ""}:${branch.length}`;
		if (state.spendCache.key === key && state.spendCache.value) return state.spendCache.value;
		const value = sessionSpend(branch);
		state.spendCache = { key, value };
		return value;
	}

	/**
	 * The credit state, which is everything the wire says about a LithosAI balance: the
	 * figure itself is console-only, but a 402 means the account is out of credit and an
	 * admitted response means it is not zero.
	 */
	function creditLine() {
		const seen = state.credit;
		if (!seen) return "No response observed in this session yet, so nothing about the credit state is known.";
		const at = new Date(seen.at).toISOString().slice(11, 19);
		if (seen.status === 402) {
			return `**Exhausted**: the last response (${at} UTC) was HTTP 402 \`insufficient_quota\` — top up in the console before the next request.`;
		}
		if (seen.status >= 200 && seen.status < 300) {
			return `Last response (${at} UTC) was admitted (HTTP ${seen.status}), so the balance is not zero.`;
		}
		return `Last response (${at} UTC) was refused (HTTP ${seen.status}), which says nothing about the balance.`;
	}

	/**
	 * One row segment: the tag of the account being spent, the balance when one is known,
	 * and this session's USD cost — the same layout on every provider this feature speaks
	 * for, with only the balance figure itself provider-specific. DeepSeek is the one
	 * provider that publishes a balance, so every other segment resolves to the tag and the
	 * cost; it never invents an amount the provider's API does not have.
	 */
	function segment() {
		const current = accountOf(state.ctx);
		if (!current) return undefined;
		const parts = [current.tag];
		if (current.provider === DEEPSEEK_PROVIDER) {
			const balance = balanceText(state.balance);
			if (balance) parts.push(balance);
			else if (state.balanceError) parts.push("bal \u2717");
			else if (values()["balance.enabled"] === true) parts.push("bal \u2026");
		}
		if (!current.priced) {
			parts.push("used n/a (rates unset)");
			return parts.join(" \u00b7 ");
		}
		const spend = spendNow(state.ctx);
		const agents = spend.agents.cost;
		parts.push(
			agents > 0
				? `used $${money(spend.total.cost, 2)} (main $${money(spend.parent.cost, 2)} + agents $${money(agents, 2)})`
				: `used $${money(spend.total.cost, 2)}`,
		);
		return parts.join(" \u00b7 ");
	}

	/**
	 * The `time` group's segment: headroom in the provider's quota windows and how long
	 * until each resets. This is the figure that decides whether the session can still bill,
	 * so it is composed from the same parts the report prints, tinted yellow as a window
	 * approaches the configured limit and red once the provider is refusing requests.
	 *
	 * A model whose provider publishes no windows returns `undefined` — the group drops out
	 * of the row rather than reporting a figure that does not exist.
	 */
	function windowSegment() {
		if (values()["window.enabled"] !== true) return undefined;
		if (!gated() || windowProvider(activeModel(state.ctx)) === undefined) return undefined;
		if (!state.windows) return [state.windowsError ? "win \u2717" : "win \u2026"];
		return windowParts(state.windows, { now: Date.now(), warnAt: warnAt() });
	}

	function stopTimer() {
		if (!state.timer) return;
		try {
			state.ctx?.clearTimer?.(state.timer);
		} catch {
			// Timer already gone; nothing to release.
		}
		state.timer = undefined;
	}

	function forgetBalance() {
		state.balance = undefined;
		state.balanceError = undefined;
		state.balanceFetchedAt = 0;
		state.windows = undefined;
		state.windowsError = undefined;
		state.windowsFetchedAt = 0;
		state.credit = undefined;
	}

	/**
	 * Account figures are cached; the network call happens only when the cache is stale.
	 * One refresh serves both figures — a balance where one is published, quota windows
	 * where they are — because they share a timer, a cadence and a failure policy.
	 */
	async function refreshAccount({ force = false } = {}) {
		if (state.inFlight) return;
		// Hard gate on the network path: a stale timer must never reach the API.
		if (!polling()) return;
		const stale = Date.now() - Math.min(state.balanceFetchedAt, state.windowsFetchedAt) >= ttlMs();
		if (!force && !stale) return;
		state.inFlight = true;
		try {
			if (balancePolled()) {
				const { apiKey, baseUrl } = await resolveCredentials(state.ctx);
				const result = await fetchBalance({ apiKey, baseUrl });
				state.balanceFetchedAt = Date.now();
				if (result.ok) {
					state.balance = result.balance;
					state.balanceError = undefined;
				} else {
					state.balanceError = result.error;
				}
			}
			if (windowPolled()) await refreshWindows();
		} finally {
			state.inFlight = false;
			shell.render();
		}
	}

	/**
	 * Read the quota windows. The shortest window is also sampled for the burn rate: one
	 * sample every refresh is what turns "12% used" into "at this pace, four hours left".
	 */
	async function refreshWindows() {
		const endpoint = usageEndpoint(activeModel(state.ctx));
		const apiKey = await liveApiKey(state.ctx);
		const result = await fetchUsage({
			endpoint: endpoint ?? undefined,
			apiKey,
			sessionId: state.ctx?.sessionManager?.getSessionId?.(),
		});
		state.windowsFetchedAt = Date.now();
		if (!result?.windows) {
			state.windowsError = apiKey ? "no usable usage report" : "no API key";
			return;
		}
		state.windows = result.windows;
		state.windowsError = undefined;
		const shortest = result.windows[0];
		if (shortest && Number.isFinite(shortest.percent)) {
			state.samples.push({ at: result.fetchedAt ?? Date.now(), percent: shortest.percent });
			// Two samples are enough for a slope; keeping a day of them bounds the array
			// without ever dropping the pair the rate is read from.
			if (state.samples.length > 24) state.samples.splice(0, state.samples.length - 24);
		}
	}

	/** Managed timer chain: fast retry after a failure, normal cadence otherwise. */
	function schedule() {
		stopTimer();
		if (!state.ctx || !polling()) return;
		const failed = state.balanceError !== undefined || state.windowsError !== undefined;
		const delay = failed ? BALANCE_RETRY_MS : ttlMs();
		state.timer = state.ctx.setTimeout(() => {
			if (!polling()) {
				stopTimer();
				shell.render();
				return;
			}
			void refreshAccount().then(schedule);
		}, delay);
	}

	/**
	 * Reconcile against the live model. Cheap and idempotent: called on every
	 * lifecycle event, because omp has no extension-facing model-change event.
	 */
	function reconcile(ctx) {
		state.ctx = ctx;
		if (polling()) {
			if (!state.timer) void refreshAccount({ force: !state.balance && !state.windows }).then(schedule);
		} else {
			stopTimer();
			if (!gated()) forgetBalance();
		}
		shell.render();
	}

	/** The session's cost table: the same rows and columns on every model this feature speaks for. */
	function spendTable(spend) {
		const lines = ["", "#### This session", ""];
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
		const hit = percent(spend.hitRate, 1);
		if (hit) {
			lines.push("", `Prefix cache hit rate: **${hit}** (${spend.cachedRequests}/${spend.assistantRequests} requests).`);
		}
		return lines;
	}

	/** Markdown section for `/mega`, `/mega balance` and the `account_balance` tool. */
	async function section(ctx) {
		const current = accountOf(ctx);
		if (!current) {
			const model = activeModel(ctx);
			return [
				"### Account",
				"",
				`- No cache-capable model is active (current: \`${modelKey(model) ?? "none"}\`), so there is no account to read and no cost to report.`,
			].join("\n");
		}
		state.ctx = ctx;
		await refreshAccount({ force: true });
		const spend = sessionSpend(ctx.sessionManager?.getBranch?.() ?? []);
		const lines = [`### ${current.label} account`, ""];

		if (current.provider === DEEPSEEK_PROVIDER) {
			if (state.balance) {
				for (const info of state.balance.infos) {
					lines.push(`- Available: **${info.symbol}${money(info.total)}** (${info.currency})`);
					lines.push(`  - topped up: ${info.symbol}${money(info.toppedUp)}`);
					lines.push(`  - granted: ${info.symbol}${money(info.granted)}`);
				}
				lines.push(`- Billable: ${state.balance.available ? "yes" : "no"}`);
			} else if (values()["balance.enabled"] === false) {
				lines.push("- Balance polling is off (`balance.enabled`); the figures below are computed from the session.");
			} else {
				lines.push(`- Unavailable: ${state.balanceError ?? "not fetched"}`);
			}
		} else if (current.provider === LITHOS_PROVIDER) {
			lines.push(
				`- Credit: not exposed by an API — LithosAI's reference documents \`/models\`, \`/models/{author}/{slug}\` and \`/chat/completions\` and no balance endpoint, so the prepaid figure is read in the console: ${LITHOS_BILLING_URL}.`,
			);
			lines.push(`- ${creditLine()}`);
			const rates = lithosRates(activeModel(ctx)?.id, values());
			lines.push(
				rates.source === "unknown"
					? "- Rates: unknown for this model — set `lithos.inputPerMillion`, `lithos.cachedPerMillion` and `lithos.outputPerMillion`; until then cost reads $0."
					: `- Rates: $${rates.input}/Mtok in, $${rates.cached}/Mtok cached, $${rates.output}/Mtok out (${rates.source}) — the cost below is computed at them.`,
			);
		} else {
			lines.push(
				windowPolled()
					? `- Balance: no balance endpoint is read for \`${current.provider}\` — DeepSeek's \`/user/balance\` is the only one this plugin polls. The windows below are the account surface ${current.label} does publish.`
					: `- Balance: not polled by this plugin for \`${current.provider}\` — DeepSeek's \`/user/balance\` is the only account endpoint this plugin reads, so ${current.label} contributes no figure here and the table below is this session's own spend.`,
			);
		}

		if (windowPolled()) {
			if (state.windows) {
				const block = windowSection(state.windows, {
					now: Date.now(),
					warnAt: warnAt(),
					percentPerHour: burnRate(state.samples),
					endpoint: usageEndpoint(activeModel(ctx)),
				});
				if (block) lines.push("", block);
			} else {
				lines.push("", `- Usage windows: ${state.windowsError ? `unavailable (${state.windowsError})` : "not read yet"}.`);
			}
		}

		lines.push(...spendTable(spend));
		if (!current.priced) {
			lines.push("", "Costs read $0 because this model is registered with no rates; the token columns are unaffected.");
		}
		return lines.join("\n");
	}

	/** Zero the per-session caches; the account's balance and windows are the account's own. */
	function reset() {
		state.spendCache = { key: undefined, value: undefined };
		state.samples = [];
	}

	pi.on("session_start", async (_event, ctx) => reconcile(ctx));
	pi.on("session_switch", async (_event, ctx) => {
		forgetBalance();
		reset();
		reconcile(ctx);
	});
	pi.on("turn_end", async (_event, ctx) => reconcile(ctx));
	pi.on("tool_result", async (_event, ctx) => reconcile(ctx));
	// The credit state of a provider that publishes no balance: the status line of every
	// response is all the wire offers, and this feature reads it without borrowing the
	// LithosAI feature's state.
	pi.on("after_provider_response", async (event, ctx) => {
		state.ctx = ctx;
		if (accountOf(ctx)?.provider !== LITHOS_PROVIDER) return;
		const status = Number(event?.status);
		if (Number.isFinite(status)) state.credit = { status, at: Date.now() };
		shell.render();
	});
	pi.on("session_shutdown", async () => {
		stopTimer();
		forgetBalance();
		reset();
	});

	const z = pi.zod;
	pi.registerTool({
		name: "account_balance",
		label: "Account balance",
		description:
			"Report the account behind the active model and the USD cost of this session, split into main-session and subagent totals. Active on every cache-capable model: DeepSeek, whose account balance this plugin polls; LithosAI, which publishes none, so its prepaid credit is read in its console and the section gives the state observable on the wire; and every other provider whose models report cached input — Google Gemini, OpenCode Go and OpenCode Zen, Anthropic, OpenAI and OpenRouter — where the section reports the tag, the session cost and the fact that the provider's account surface is not polled by this plugin.",
		parameters: z.object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			state.ctx = ctx;
			return { content: [{ type: "text", text: await section(ctx) }], details: {} };
		},
	});

	return { segment, windowSegment, section, reset, state };
}