/**
 * Persisted cache accounting.
 *
 * One shard per process-session, day-rolled, written atomically.
 *
 * Subagents are accounted for by reading the shards their own rebound sessions wrote,
 * not from the parent's `task` tool result: `TaskToolDetails.usage` is populated only for
 * blocking spawns (`usage: syncUsage`), and an async spawn reports `usage: null` at every
 * observation — verified against a live run. A child's own shard is therefore the only
 * complete source, and it carries the child's cache reads too.
 *
 * Sibling shards are matched on `pid`, so a long-running process accumulating many
 * sessions does not silently fold unrelated traffic into the subagent figure.
 */

import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fingerprint } from "./prefix.js";
import { resolveAgentDir } from "./config.js";

export const SHARD_VERSION = 1;
export const SHARD_KIND = "omp-token-mega-shard";
export const STATE_DIR_NAME = "omp-token-mega-stats.d";
const FLUSH_DEBOUNCE_MS = 1_500;

/** Directory holding this plugin's shards; `override` comes from the `stateDir` setting. */
export function resolveStateDir(ctx, override) {
	if (override) return override;
	const agentDir = resolveAgentDir(ctx);
	return agentDir ? join(agentDir, STATE_DIR_NAME) : undefined;
}

/**
 * Delete shards this process did not write and that nothing has touched for
 * `retentionDays`.
 *
 * Age is measured from `updatedAt`, not `startedAt`: a live session flushes on
 * every turn end, so a file only ages out once its writer has stopped, and a
 * shard belonging to a long-running peer session is never touched. Shards of
 * other kinds, and files that do not parse, are left alone. Never throws.
 */
export async function pruneShards(dir, { retentionDays, excludeInstanceId, now = Date.now() } = {}) {
	if (!dir || !(retentionDays > 0)) return { removed: 0 };
	const cutoff = now - retentionDays * 86_400_000;
	const shardsDir = join(dir, "shards");
	let names;
	try {
		names = await readdir(shardsDir);
	} catch {
		return { removed: 0 };
	}
	let removed = 0;
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const path = join(shardsDir, name);
		let parsed;
		try {
			parsed = JSON.parse(await readFile(path, "utf8"));
		} catch {
			continue;
		}
		if (parsed?.kind !== SHARD_KIND || parsed.instanceId === excludeInstanceId) continue;
		const updatedAt = Number(parsed.updatedAt ?? parsed.startedAt ?? 0);
		if (!(updatedAt > 0) || updatedAt > cutoff) continue;
		try {
			await unlink(path);
			removed += 1;
		} catch {
			// Another process pruned it first, or the volume is read-only.
		}
	}
	return { removed };
}

function emptyTotals() {
	return {
		requests: 0,
		hitRequests: 0,
		cachedInputTokens: 0,
		uncachedInputTokens: 0,
		cacheWriteTokens: 0,
		outputTokens: 0,
		costUsd: 0,
		savedUsd: 0,
	};
}

/**
 * Field-wise sum of totals records, so the main session and the subagent shards can
 * be reported as one session-wide figure. Unknown fields are ignored; missing ones
 * count as zero.
 */
export function addTotals(...records) {
	const sum = emptyTotals();
	for (const record of records) {
		if (!record) continue;
		for (const key of Object.keys(sum)) sum[key] += Number(record[key]) || 0;
	}
	return sum;
}

function addInto(target, stats, savings) {
	target.requests += 1;
	if (stats.hit) target.hitRequests += 1;
	target.cachedInputTokens += stats.cacheRead;
	target.uncachedInputTokens += stats.input;
	target.cacheWriteTokens += stats.cacheWrite;
	target.outputTokens += stats.output;
	target.costUsd += stats.cost;
	target.savedUsd += savings;
}

function day() {
	return new Date().toISOString().slice(0, 10);
}

export function createStore({ dir, sessionId }) {
	const empty = () => ({
		version: SHARD_VERSION,
		kind: SHARD_KIND,
		instanceId: randomUUID(),
		pid: process.pid,
		sessionHash: fingerprint(String(sessionId ?? "unknown"), 16),
		day: day(),
		startedAt: Date.now(),
		updatedAt: Date.now(),
		totals: emptyTotals(),
		misses: { byReason: {} },
		models: {},
		lastFingerprint: undefined,
	});

	let shard = empty();
	let timer;
	let pending;
	let dirty = false;

	const shardPath = dir ? join(dir, "shards", `${shard.instanceId}.json`) : undefined;

	function rollover() {
		const today = day();
		if (shard.day === today) return;
		const identity = {
			version: shard.version,
			kind: shard.kind,
			instanceId: shard.instanceId,
			pid: shard.pid,
			sessionHash: shard.sessionHash,
			startedAt: shard.startedAt,
			lastFingerprint: shard.lastFingerprint,
		};
		shard = { ...empty(), ...identity, day: today };
	}

	async function write() {
		if (!shardPath) return;
		dirty = false;
		shard.updatedAt = Date.now();
		const payload = `${JSON.stringify(shard, null, 2)}\n`;
		try {
			await mkdir(dirname(shardPath), { recursive: true });
			const temp = `${shardPath}.${process.pid}.tmp`;
			await writeFile(temp, payload, "utf8");
			await rename(temp, shardPath);
		} catch {
			// Accounting must never take the session down; the in-memory shard stays authoritative.
		}
	}

	/** Debounced persist so a fast turn loop does not thrash the disk. */
	function scheduleFlush(ctx) {
		dirty = true;
		if (timer || !shardPath) return;
		timer = ctx?.setTimeout?.(() => {
			timer = undefined;
			if (dirty) void write();
		}, FLUSH_DEBOUNCE_MS);
	}

	return {
		get path() {
			return shardPath;
		},
		get instanceId() {
			return shard.instanceId;
		},
		get startedAt() {
			return shard.startedAt;
		},
		get lastFingerprint() {
			return shard.lastFingerprint;
		},
		recordRequest({ modelKey, stats, savings, missReason, drift }, ctx) {
			rollover();
			addInto(shard.totals, stats, savings);
			shard.models[modelKey] ??= emptyTotals();
			addInto(shard.models[modelKey], stats, savings);
			if (missReason) shard.misses.byReason[missReason] = (shard.misses.byReason[missReason] ?? 0) + 1;
			if (drift) shard.lastDrift = drift;
			scheduleFlush(ctx);
		},
		recordFingerprint(value, ctx) {
			shard.lastFingerprint = value;
			scheduleFlush(ctx);
		},
		snapshot() {
			return shard;
		},
		flush: async () => {
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			pending ??= write();
			await pending;
			pending = undefined;
		},
	};
}

/**
 * Aggregate every other shard written by this process since `sinceMs` — i.e. the
 * subagent sessions it spawned. Returns `undefined` when the shard directory is
 * unavailable, so callers can distinguish "no children" from "cannot tell".
 */
export async function readSubagentTotals(dir, { excludeInstanceId, pid = process.pid, sinceMs = 0 } = {}) {
	if (!dir) return undefined;
	const shardsDir = join(dir, "shards");
	let names;
	try {
		names = await readdir(shardsDir);
	} catch {
		return { shards: 0, ...emptyTotals() };
	}
	const totals = emptyTotals();
	let shards = 0;
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		let parsed;
		try {
			parsed = JSON.parse(await readFile(join(shardsDir, name), "utf8"));
		} catch {
			continue;
		}
		if (parsed?.kind !== SHARD_KIND) continue;
		if (parsed.instanceId === excludeInstanceId) continue;
		if (parsed.pid !== pid) continue;
		if (sinceMs && (parsed.startedAt ?? 0) < sinceMs) continue;
		shards += 1;
		const t = parsed.totals ?? {};
		totals.requests += t.requests ?? 0;
		totals.hitRequests += t.hitRequests ?? 0;
		totals.cachedInputTokens += t.cachedInputTokens ?? 0;
		totals.uncachedInputTokens += t.uncachedInputTokens ?? 0;
		totals.cacheWriteTokens += t.cacheWriteTokens ?? 0;
		totals.outputTokens += t.outputTokens ?? 0;
		totals.costUsd += t.costUsd ?? 0;
		totals.savedUsd += t.savedUsd ?? 0;
	}
	return { shards, ...totals };
}

/** Aggregate hit rate across a totals record. */
export function summarize(totals) {
	const t = totals ?? emptyTotals();
	const billedInput = t.cachedInputTokens + t.uncachedInputTokens + t.cacheWriteTokens;
	return {
		...t,
		hitRate: billedInput > 0 ? t.cachedInputTokens / billedInput : undefined,
		requestHitRate: t.requests > 0 ? t.hitRequests / t.requests : undefined,
	};
}
