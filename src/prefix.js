/**
 * Prefix identity and cache-miss attribution.
 *
 * DeepSeek's cache is an automatic, disk-backed prefix KV cache: a request hits only
 * when its leading tokens match a previously persisted cache unit byte for byte, and
 * matching is all-or-nothing per unit rather than a longest-common-prefix scan. So the
 * only thing worth tracking is *what changed in the prefix*, which is what this module
 * fingerprints and names.
 *
 * omp already protects the prefix for DeepSeek (`provider.appendOnlyContext` is enabled
 * automatically when `model.provider === "deepseek"`, keeping the system prompt, tool
 * catalogue and message log byte-stable). This module deliberately does NOT rewrite the
 * prefix — it observes it, so a regression elsewhere can be named instead of guessed at.
 */

import { createHash } from "node:crypto";

/** Reason enum for a lost cache. Ordered by how actionable each cause is. */
export const MISS_REASONS = [
	"first_turn",
	"system_change",
	"tool_change",
	"history_rewrite",
	"compaction",
	"model_switch",
	"idle_ttl",
	"branch_nav",
	"resume",
	"external_miss",
];

/** Default idle gap after which the provider cache is assumed gone (`idleTtlMinutes`). */
export const IDLE_TTL_MS = 5 * 60_000;

/** JSON with object keys sorted, so key-order jitter is never reported as a change. */
export function stableStringify(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/** Short stable digest; `length` is truncated to keep persisted shards readable. */
export function fingerprint(value, length = 12) {
	return createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex").slice(0, length);
}

/**
 * Tool-catalogue identity. Tool schemas sit ahead of the system prompt inside the
 * cached prefix and cannot be pinned by an extension, so a set-equivalent but
 * reordered catalogue still invalidates the cache — hence sorting by name.
 */
export function toolsFingerprint(tools) {
	if (!Array.isArray(tools)) return undefined;
	const entries = tools
		.map((tool) => {
			const name = String(tool?.function?.name ?? tool?.name ?? "?");
			return [name, stableStringify(tool)];
		})
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	return { id: fingerprint(entries), names: entries.map(([name]) => name) };
}

/** Which tools appeared / vanished between two catalogues. */
export function toolDiff(previous, next) {
	const before = new Set(previous?.names ?? []);
	const after = new Set(next?.names ?? []);
	return {
		added: [...after].filter((n) => !before.has(n)),
		removed: [...before].filter((n) => !after.has(n)),
	};
}

/**
 * Name the cause of a lost prefix.
 *
 * `previous` is the fingerprint set recorded for the last billed request in this
 * session; `next` the one observed now. Returns `undefined` when nothing about the
 * prefix changed, in which case a miss is provider-side and reported as
 * `external_miss` rather than blamed on the client.
 */
export function attributeMiss(previous, next, { idleMs = 0, requests = 0, idleTtlMs = IDLE_TTL_MS } = {}) {
	if (!previous || requests === 0) return "first_turn";
	if (previous.modelKey !== next.modelKey) return "model_switch";
	if (previous.system !== next.system) return "system_change";
	if (previous.tools?.id !== next.tools?.id) return "tool_change";
	if (next.messageCount < previous.messageCount) return "history_rewrite";
	if (idleMs > idleTtlMs) return "idle_ttl";
	return "external_miss";
}

/** Compact, human-readable drift note for the status row; undefined when stable. */
export function driftNote(previous, next) {
	if (!previous) return undefined;
	if (previous.modelKey !== next.modelKey) return "model switched";
	if (previous.system !== next.system) return "system changed";
	if (previous.tools?.id !== next.tools?.id) {
		const { added, removed } = toolDiff(previous.tools, next.tools);
		const parts = [];
		if (added.length) parts.push(`+${added.slice(0, 2).join(",")}`);
		if (removed.length) parts.push(`-${removed.slice(0, 2).join(",")}`);
		return `tools ${parts.join(" ") || "reordered"}`;
	}
	if (next.messageCount < previous.messageCount) return "history rewritten";
	return undefined;
}
