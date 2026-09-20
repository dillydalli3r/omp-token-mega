/**
 * Duplicate-result collapsing.
 *
 * Agents re-run the same command and re-read the same file constantly, and the second
 * copy is pure waste: the session already holds those exact bytes above. omp has nothing
 * for this at ingress — `compaction.supersedeReads` prunes a superseded *read* later, at
 * compaction time, while the duplicate's full text has already been sent on every request
 * in between.
 *
 * Identity is the content hash, so the claim in the marker ("identical to the earlier X
 * result") is literal and verifiable, and comparison is against bytes rather than a
 * heuristic similarity score that could call two different results the same. The index
 * stores hashes and counters only — never the text — so a long session holds a few
 * hundred bytes here, not a second copy of its own transcript.
 */

import { createHash } from "node:crypto";
import { utf8Bytes } from "./measure.js";

/** Below this, a back-reference marker costs more than the text it replaces. */
export const DEDUPE_MIN_CHARS = 512;

/**
 * honey: fixed ceiling on indexed results. Each entry is a 32-char hash plus three
 * small fields, so 2048 entries is well under a megabyte; raise it only if a session
 * routinely repeats more distinct results than that.
 */
const MAX_ENTRIES = 2048;

export function hashText(text) {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

export function createDuplicateIndex({ minChars = DEDUPE_MIN_CHARS } = {}) {
	/** Insertion-ordered, so the oldest key is the first one the iterator yields. */
	const seen = new Map();

	return {
		/** Content too small to be worth a back-reference, or too cheap to hash. */
		skips(text) {
			return text.length < minChars || text.trim() === "";
		},

		/** The earlier occurrence of this exact content, or undefined. Read-only. */
		lookup(text) {
			const key = hashText(text);
			return seen.get(key);
		},

		/** Register content that was sent in full. Re-registering refreshes recency. */
		remember(toolName, text, handle) {
			const key = hashText(text);
			const previous = seen.get(key);
			if (previous) {
				seen.delete(key);
				seen.set(key, previous);
				return previous;
			}
			const entry = { key, toolName, bytes: utf8Bytes(text), copies: 0, handle };
			seen.set(key, entry);
			if (seen.size > MAX_ENTRIES) seen.delete(seen.keys().next().value);
			return entry;
		},

		/** Attach a recovery handle to an entry once its text has been stashed. */
		attachHandle(entry, handle) {
			if (entry && handle && !entry.handle) entry.handle = handle;
			return entry;
		},

		/** Count one collapsed copy against an entry, for the report. */
		count(entry) {
			if (entry) entry.copies += 1;
			return entry;
		},

		get size() {
			return seen.size;
		},

		reset() {
			seen.clear();
		},
	};
}
