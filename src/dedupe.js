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

/**
 * `enabled` is the master switch, and it is a predicate rather than a boolean because the
 * index is built at install time — before the configuration is loaded — so a boolean
 * captured here would be fixed for the life of the session, while `token.dedupe` is editable
 * mid-session. It is asked at every entry point instead of at the call sites because every
 * path in this file that hashes is behind this one line: a caller that forgets to test the
 * switch cannot re-introduce the hash the switch exists to skip. Absent, it defaults to on,
 * which is what an index built without a configuration to consult should mean.
 */
export function createDuplicateIndex({ minChars = DEDUPE_MIN_CHARS, enabled = () => true } = {}) {
	/** Insertion-ordered, so the oldest key is the first one the iterator yields. */
	const seen = new Map();
	/** The floor this index was built with, for callers that have no setting to pass. */
	const defaultFloor = minChars;
	const isEnabled = enabled;

	return {
		/**
		 * Content too small to be worth a back-reference, or too cheap to hash. A numeric
		 * `minChars` overrides the floor this index was constructed with, because the index
		 * is built once at install time — before the configuration is loaded — and
		 * `token.dedupeMinChars` is editable mid-session, so a floor captured in the
		 * constructor is a floor the user cannot change. Taking it here puts the setting at
		 * the decision point, where it is read afresh for every result.
		 */
		skips(text, minChars) {
			const floor = typeof minChars === "number" ? minChars : defaultFloor;
			return text.length < floor || text.trim() === "";
		},

		/**
		 * The earlier occurrence of this exact content, or undefined. Read-only.
		 *
		 * Inert while the switch is off, and that loses nothing: the same predicate stops a
		 * result being registered, so an index left empty by the switch cannot hold an entry
		 * a lookup should have found. The two are one decision, taken in one place.
		 */
		lookup(text) {
			if (!isEnabled()) return undefined;
			const key = hashText(text);
			return seen.get(key);
		},

		/**
		 * Register content that was sent in full. Re-registering refreshes recency.
		 *
		 * Inert while the switch is off: this is the hot path — every in-scope result passes
		 * through it — and hashing bytes that no lookup will ever compare is work bought for
		 * nothing. The stretch spent off is not replayed when the switch goes back on, so a
		 * result that arrived while it was off is not collapsed against a later repeat of the
		 * same bytes. That is the deliberate trade: the alternative is paying the hash on every
		 * result for the whole session to cover the case where the user turns the feature on
		 * mid-session and immediately repeats something.
		 */
		remember(toolName, text, handle) {
			if (!isEnabled()) return undefined;
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
