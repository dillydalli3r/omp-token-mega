/**
 * DeepSeek account balance and session spend.
 *
 * Renders nothing unless the ACTIVE model belongs to the `deepseek` provider: no row
 * segment, no balance request, no timer. Switching away from DeepSeek hides the segment
 * and stops all network traffic; switching back resumes it. Session spend is read from
 * the session branch and needs no network, so it survives a failing balance call and
 * stays available with the poller switched off.
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
import { DEEPSEEK_PROVIDER, isDeepSeek } from "./deepseek.js";
import { money, percent } from "./measure.js";
import { sessionSpend } from "./usage.js";

const BALANCE_RETRY_MS = 15_000;

export function installBalance(pi, shell) {
	const state = {
		ctx: undefined,
		balance: undefined,
		balanceError: undefined,
		balanceFetchedAt: 0,
		timer: undefined,
		inFlight: false,
		spendCache: { key: undefined, value: undefined },
	};

	const values = () => shell.values();
	const ttlMs = () => Math.max(15, Number(values()["balance.ttlSeconds"]) || 60) * 1000;
	/** The single source of truth for "should this feature be doing anything". */
	const gated = () => values().enabled === true && isDeepSeek(state.ctx);
	/** Polling on top of the gate: the local spend read is not a network operation. */
	const polling = () => gated() && values()["balance.enabled"] === true;

	function spendNow(ctx) {
		const branch = ctx?.sessionManager?.getBranch?.() ?? [];
		const key = `${ctx?.sessionManager?.getSessionId?.() ?? ""}:${branch.length}`;
		if (state.spendCache.key === key && state.spendCache.value) return state.spendCache.value;
		const value = sessionSpend(branch);
		state.spendCache = { key, value };
		return value;
	}

	/** One row segment: the account balance (when known) and this session's USD spend. */
	function segment() {
		if (!gated()) return undefined;
		const spend = spendNow(state.ctx);
		const parts = [];
		const balance = balanceText(state.balance);
		if (balance) parts.push(`DS ${balance}`);
		else if (state.balanceError) parts.push("DS bal \u2717");
		else if (values()["balance.enabled"] === true) parts.push("DS bal \u2026");

		const agents = spend.agents.cost;
		parts.push(
			agents > 0
				? `used $${money(spend.total.cost)} (main $${money(spend.parent.cost)} + agents $${money(agents)})`
				: `used $${money(spend.total.cost)}`,
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

	/** Markdown section for `/mega`, `/mega balance` and the `deepseek_balance` tool. */
	async function section(ctx) {
		if (!isDeepSeek(ctx)) {
			return `### DeepSeek account\n\n- No DeepSeek model is active (current: \`${ctx?.models?.current?.()?.provider ?? "none"}\`).`;
		}
		state.ctx = ctx;
		if (values()["balance.enabled"] === true) await refreshBalance({ force: true });
		const spend = sessionSpend(ctx.sessionManager?.getBranch?.() ?? []);
		const lines = ["### DeepSeek account", ""];

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

		lines.push("", "#### This session", "");
		lines.push("| bucket | cost (USD) | input | output | cache read | calls |");
		lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
		for (const [label, t] of [
			["main", spend.parent],
			["agents", spend.agents],
			["total", spend.total],
		]) {
			lines.push(
				`| ${label} | ${money(t.cost)} | ${t.input.toLocaleString("en-US")} | ${t.output.toLocaleString("en-US")} | ${t.cacheRead.toLocaleString("en-US")} | ${t.calls} |`,
			);
		}
		const hit = percent(spend.hitRate, 1);
		if (hit) {
			lines.push("", `Prefix cache hit rate: **${hit}** (${spend.cachedRequests}/${spend.assistantRequests} requests).`);
		}
		if (!isDeepSeek(ctx)) lines.push("", `Provider \`${DEEPSEEK_PROVIDER}\` is not the active one; spend totals cover whatever ran this session.`);
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
	pi.on("session_shutdown", async () => {
		stopTimer();
		forgetBalance();
		reset();
	});

	const z = pi.zod;
	pi.registerTool({
		name: "deepseek_balance",
		label: "DeepSeek Balance",
		description:
			"Report the DeepSeek account balance and the USD spend of this session, split into main-session and subagent totals. Only meaningful when a DeepSeek model is active.",
		parameters: z.object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			state.ctx = ctx;
			return { content: [{ type: "text", text: await section(ctx) }], details: {} };
		},
	});

	return { segment, section, reset, state };
}
