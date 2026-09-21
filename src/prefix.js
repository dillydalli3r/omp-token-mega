/**
 * Prefix identity and cache-miss attribution.
 *
 * A provider's prefix cache — DeepSeek's persisted KV units, Gemini's implicit cache,
 * Anthropic's and OpenAI's prompt caches — is automatic: a request hits only when its
 * leading tokens match a prefix the provider cached earlier, and the tail cannot be
 * half-cached. So the only thing worth tracking is *what changed in the prefix*, which is
 * what this module fingerprints and names.
 *
 * omp can hold that prefix still — `provider.appendOnlyContext` keeps the system prompt,
 * tool catalogue and message log unchanged from turn to turn — but it only turns that mode
 * on by itself for DeepSeek, the local engines and store-backed routes. On every other
 * provider (opencode-go, google, anthropic, openai) the prefix is only as stable as omp's
 * normal serialization, so a needless re-serialization there costs the whole prefix's hits
 * on each affected turn. This module deliberately does NOT rewrite the prefix — it observes
 * it, so a change that costs hits is named instead of guessed at.
 */

import { createHash } from "node:crypto";

/**
 * Reason enum for a lost cache, ordered by how actionable the cause is: what the client or
 * the session changed in the prefix first (`first_turn` through `model_switch`), then the two
 * session-level causes, then the causes only the host produces (`branch_nav`, `resume`) and
 * the catch-all (`external_miss`).
 *
 * The two session-level entries are split by what a user can do about them. An idle eviction
 * (`idle_ttl`) is the miss the user prevents by working sooner, so it is named first. A prefix
 * under the provider's minimum cacheable unit (`prefix_too_small`) is the one miss no amount
 * of client-side work can fix, so it is labelled rather than chased and sits behind everything
 * the client can be asked to change. `branch_nav` and `resume` trail the named causes because
 * they are deliberate acts, not a prefix nobody held onto.
 */
export const MISS_REASONS = [
	"first_turn",
	"system_change",
	"tool_change",
	"history_rewrite",
	"compaction",
	"model_switch",
	"idle_ttl",
	"prefix_too_small",
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
 *
 * Causes are tested most-specific-first, and a client-side change outranks the idle gap: when
 * the system prompt changed *and* the session sat idle past the TTL, the change is the one the
 * user can act on now.
 *
 * `billedInput` is what the request billed as prompt tokens (uncached + read + written) and
 * `minPrefixTokens` the configured `cache.minPrefixTokens` floor. Below most providers' minimum
 * cacheable unit an absent cache is inherent rather than a defect, so that miss is *labelled*
 * by the floor instead of chased — but the label is opt-in: with a floor of 0 (the default, and
 * what a caller that passes neither option gets) `prefix_too_small` can never be returned.
 */
export function attributeMiss(previous, next, { idleMs = 0, requests = 0, idleTtlMs = IDLE_TTL_MS, billedInput = 0, minPrefixTokens = 0 } = {}) {
	if (!previous || requests === 0) return "first_turn";
	if (previous.modelKey !== next.modelKey) return "model_switch";
	if (previous.system !== next.system) return "system_change";
	if (previous.tools?.id !== next.tools?.id) return "tool_change";
	if (next.messageCount < previous.messageCount) return "history_rewrite";
	if (idleMs > idleTtlMs) return "idle_ttl";
	if (minPrefixTokens > 0 && billedInput > 0 && billedInput < minPrefixTokens) return "prefix_too_small";
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
