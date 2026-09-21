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
		timer: undefined,
		inFlight: false,
		spendCache: { key: undefined, value: undefined },
		/** Last provider response, for the LithosAI credit state: `{ status, at }`. */
		credit: undefined,
	};

	const values = () => shell.values();
	const ttlMs = () => Math.max(15, Number(values()["balance.ttlSeconds"]) || 60) * 1000;

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
	const polling = () => gated() && accountOf(state.ctx).provider === DEEPSEEK_PROVIDER && values()["balance.enabled"] === true;

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
		state.credit = undefined;
	}

	/** Balances are cached; the network call happens only when the cache is stale. */
	async function refreshBalance({ force = false } = {}) {
		if (state.inFlight) return;
		// Hard gate on the network path: a stale timer must never reach the API.
		if (!polling()) return;
		if (!force && Date.now() - state.balanceFetchedAt < ttlMs()) return;
		state.inFlight = true;
		try {
			const { apiKey, baseUrl } = await resolveCredentials(state.ctx);
			const result = await fetchBalance({ apiKey, baseUrl });
			state.balanceFetchedAt = Date.now();
			if (result.ok) {
				state.balance = result.balance;
				state.balanceError = undefined;
			} else {
				state.balanceError = result.error;
			}
		} finally {
			state.inFlight = false;
			shell.render();
		}
	}

	/** Managed timer chain: fast retry after a failure, normal cadence otherwise. */
	function schedule() {
		stopTimer();
		if (!state.ctx || !polling()) return;
		const delay = state.balanceError ? BALANCE_RETRY_MS : ttlMs();
		state.timer = state.ctx.setTimeout(() => {
			if (!polling()) {
				stopTimer();
				shell.render();
				return;
			}
			void refreshBalance().then(schedule);
		}, delay);
	}

	/**
	 * Reconcile against the live model. Cheap and idempotent: called on every
	 * lifecycle event, because omp has no extension-facing model-change event.
	 */
	function reconcile(ctx) {
		state.ctx = ctx;
		if (polling()) {
			if (!state.timer) void refreshBalance({ force: !state.balance }).then(schedule);
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
		if (current.provider === DEEPSEEK_PROVIDER && values()["balance.enabled"] === true) await refreshBalance({ force: true });
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
				`- Balance: not polled by this plugin for \`${current.provider}\` — DeepSeek's \`/user/balance\` is the only account endpoint this plugin reads, so ${current.label} contributes no figure here and the table below is this session's own spend.`,
			);
		}

		lines.push(...spendTable(spend));
		if (!current.priced) {
			lines.push("", "Costs read $0 because this model is registered with no rates; the token columns are unaffected.");
		}
		return lines.join("\n");
	}

	/** Zero the per-session caches; the balance itself is a property of the account. */
	function reset() {
		state.spendCache = { key: undefined, value: undefined };
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

	return { segment, section, reset, state };
}