/**
 * Session spend accounting.
 *
 * Two buckets, kept separate so a subagent's spend is never double counted:
 *
 *   parent — LLM calls this session paid for directly: assistant turns plus the
 *            model-generated `branch_summary` / `compaction` entries.
 *   agents — subagent (`task` tool) children. omp accumulates each child's own
 *            usage and hands it back on the tool result as `details.usage`
 *            (task/index.ts `addUsageTotals`), which is what we read here.
 *
 * `toolResult` entries are deliberately excluded from `parent`: for a `task` call
 * that entry's usage is the child's, which the agents bucket already owns.
 */

export function emptyTotals() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, tokens: 0, calls: 0 };
}

/** Accumulate one usage record defensively; malformed fields count as 0. */
export function addUsage(totals, usage) {
	if (!usage || typeof usage !== "object") return;
	const num = (value) => {
		const n = Number(value);
		return Number.isFinite(n) ? n : 0;
	};
	const input = num(usage.input);
	const output = num(usage.output);
	const cacheRead = num(usage.cacheRead);
	const cacheWrite = num(usage.cacheWrite);
	totals.input += input;
	totals.output += output;
	totals.cacheRead += cacheRead;
	totals.cacheWrite += cacheWrite;
	totals.tokens += input + output + cacheRead + cacheWrite;
	totals.cost += num(usage.cost?.total);
	totals.calls += 1;
}

function mergeInto(target, source) {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.tokens += source.tokens;
	target.cost += source.cost;
	target.calls += source.calls;
}

function spawnUsage(entry) {
	const message = entry?.message;
	if (entry?.type !== "message" || message?.role !== "toolResult") return undefined;
	if (message.toolName !== "task") return undefined;
	return message.details?.usage ?? message.usage;
}

/**
 * Total spend for one session branch: `{ parent, agents, total, hitRate }`.
 * `total.cost` is the figure to show as "used in this session".
 */
export function sessionSpend(entries) {
	const parent = emptyTotals();
	const agents = emptyTotals();
	let assistantRequests = 0;
	let cachedRequests = 0;

	for (const entry of entries ?? []) {
		if (entry?.type === "message") {
			const message = entry.message;
			if (message?.role === "assistant") {
				if (message.usage) {
					addUsage(parent, message.usage);
					assistantRequests += 1;
					if (Number(message.usage.cacheRead) > 0) cachedRequests += 1;
				}
				continue;
			}
			const child = spawnUsage(entry);
			if (child) addUsage(agents, child);
			continue;
		}
		if (entry?.type === "branch_summary" || entry?.type === "compaction") {
			addUsage(parent, entry.usage);
		}
	}

	const total = emptyTotals();
	mergeInto(total, parent);
	mergeInto(total, agents);

	// Same hit-rate definition omp publishes: cached input over all billed input.
	const billedInput = parent.input + parent.cacheRead + parent.cacheWrite;
	return {
		parent,
		agents,
		total,
		hitRate: billedInput > 0 ? parent.cacheRead / billedInput : undefined,
		assistantRequests,
		cachedRequests,
	};
}
