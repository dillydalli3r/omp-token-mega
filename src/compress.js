/**
 * Deterministic, one-shot reduction of tool-result text.
 *
 * Everything here is pure: same input plus same config yields the same output, byte for
 * byte. That is the property that makes the plugin cache-safe. A result is reduced once,
 * *before* it is first sent; from then on the reduced text is what the session stores and
 * replays, so the provider's prefix cache keeps seeing a stable prefix. Nothing in this
 * module — or in the plugin — ever rewrites a message that has already been sent.
 *
 * The passes are ordered so that a later pass can never invalidate an earlier one:
 *
 *   clip -> json
 *
 * because minifying JSON produces very long lines, and a column cap applied afterwards
 * would cut them and destroy the payload.
 *
 * Reduction is not truncation. `squeeze`, `fold` and `clip` remove characters a reader
 * does not need (escape codes, blank-line runs, duplicated lines, line tails past any
 * useful column) and say so in a marker; `json` removes insignificant whitespace only.
 * Truncation exists in omp already, twice (`tools.artifactSpillThreshold` at 50 KB and
 * the compaction-time prune), so this module deliberately does not reimplement it; the
 * optional budget in `elide()` is a *tighter per-tool* lever that reuses omp's own
 * `artifact://` recovery path rather than inventing a second one.
 *
 * The arithmetic here was audited against the reducer's ledger and left as it was, because
 * it is already the property that ledger needs:
 *
 *   - Every marker is returned *bare*. The newline that carries it belongs to the caller,
 *     which charges the marker through `measure.js` `lineCost` — marker plus that newline —
 *     against the saving the marker advertises. Nothing in this module sizes a marker and
 *     nothing hides one: `fold`'s fold-counts and `clip`'s ellipses are written into the
 *     pass's own output, so their bytes are inside that pass's own delta.
 *   - Every pass clamps at zero and `reduce` books only a positive delta, so a pass that
 *     costs more than it removes is a no-op rather than a credit. A marker can therefore
 *     never be booked as a saving.
 *   - `reduce().steps` sums to `reduce().savedBytes`: each pass measures its own delta
 *     against its own input, and the text it hands on is the text it measured. That is
 *     what lets the reducer attribute a gross figure to each rule, and it is why the
 *     marker text a caller appends afterwards is nowhere in either number.
 */

import { formatSaving, utf8Bytes } from "./measure.js";

/** Provenance prefix on every replacement, so a reduced result is never mistaken for raw output. */
export const MARK = "token-saver:";

/**
 * Escape sequences a terminal would consume but a model should not pay for:
 * OSC (window title), CSI (colour and cursor), and two-character ESC sequences.
 */
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ESC = /\u001b[@-Z\\-_]/g;
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const TRAILING_WS = /[^\S\n]+(?=\n)/g;
const BLANK_RUN = /\n{3,}/g;

/**
 * Guards for the passes above. These are deliberately separate, non-global regexes:
 * a `/g` regex carries `lastIndex` between `.test()` calls, which would make this
 * module answer differently depending on what it was asked a moment ago — the one
 * property the whole design cannot lose.
 */
const HAS_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const HAS_TRAILING_WS = /[^\S\n]+(?=\n)/;
const HAS_BLANK_RUN = /\n{3,}/;

/**
 * Terminal escape codes, stray control characters, CRLF, trailing whitespace and blank
 * line runs. Every one of these is a byte a human never sees and a model never needs.
 */
export function squeeze(text) {
	let out = text;
	// Line endings first: CR is a control character, so normalizing after the control strip
	// would delete a bare CR and silently join two lines instead of separating them.
	if (out.includes("\r")) out = out.replace(/\r\n?/g, "\n");
	// Each guard is a cheap scan; most results contain none of these and skip the pass.
	if (out.includes("\u001b")) {
		out = out.replace(OSC, "").replace(CSI, "").replace(ESC, "");
	}
	if (HAS_CONTROLS.test(out)) out = out.replace(CONTROLS, "");
	if (HAS_TRAILING_WS.test(out)) out = out.replace(TRAILING_WS, "").replace(/[^\S\n]+$/, "");
	// Three newlines carry exactly as much as two: one empty line.
	if (HAS_BLANK_RUN.test(out)) out = out.replace(BLANK_RUN, "\n\n");
	return { text: out, saved: Math.max(0, utf8Bytes(text) - utf8Bytes(out)) };
}

/**
 * Runs of identical consecutive lines become one line plus a count. Logs, repeated test
 * failures and stack frames produced by a loop are where this pays; a file of prose is
 * where it does nothing, and a run of blank lines is deliberately left alone (the marker
 * would cost more than the blanks).
 */
export function fold(text, minRun) {
	if (!(minRun >= 2)) return { text, saved: 0, runs: 0 };
	const lines = text.split("\n");
	const out = [];
	let runs = 0;
	let index = 0;
	while (index < lines.length) {
		const line = lines[index];
		let end = index + 1;
		while (end < lines.length && lines[end] === line) end += 1;
		const count = end - index;
		out.push(line);
		if (count >= minRun && line.trim() !== "") {
			out.push(`[${MARK} ${count - 1} identical ${count - 1 === 1 ? "line" : "lines"} folded]`);
			runs += 1;
		} else {
			for (let copy = index + 1; copy < end; copy += 1) out.push(line);
		}
		index = end;
	}
	const folded = out.join("\n");
	return { text: folded, saved: Math.max(0, utf8Bytes(text) - utf8Bytes(folded)), runs };
}

/**
 * Column cap for tools omp does not already cap. A single minified 40 KB line is worth
 * almost nothing past the first screenful; the ellipsis marks where it was cut so the
 * model knows the line continues.
 */
export function clip(text, maxColumns) {
	if (!(maxColumns > 0)) return { text, saved: 0, lines: 0 };
	const out = [];
	let lines = 0;
	for (const line of text.split("\n")) {
		if (line.length <= maxColumns) {
			out.push(line);
			continue;
		}
		out.push(`${line.slice(0, maxColumns)}\u2026`);
		lines += 1;
	}
	if (lines === 0) return { text, saved: 0, lines: 0 };
	const clipped = out.join("\n");
	return { text: clipped, saved: Math.max(0, utf8Bytes(text) - utf8Bytes(clipped)), lines };
}

/** Largest payload handed to `JSON.parse`. Parsing is the one super-linear step here. */
const MAX_JSON_PARSE_BYTES = 131_072;

/**
 * Whitespace outside string literals, removed by a scanner rather than a parse and
 * re-serialize. `JSON.stringify(JSON.parse(x))` is one line shorter, but it rewrites
 * numeric literals (`1.0` -> `1`, `1e2` -> `100`), and this text may be a config or a
 * fixture the model later writes back verbatim.
 */
function stripJsonWhitespace(text) {
	const parts = [];
	let inString = false;
	let escaped = false;
	let runStart = 0;
	let i = 0;
	while (i < text.length) {
		const code = text.charCodeAt(i);
		if (inString) {
			if (escaped) escaped = false;
			else if (code === 92) escaped = true;
			else if (code === 34) inString = false;
		} else if (code === 34) {
			inString = true;
		} else if (code === 32 || code === 9 || code === 10 || code === 13) {
			if (i > runStart) parts.push(text.slice(runStart, i));
			i += 1;
			runStart = i;
			continue;
		}
		i += 1;
	}
	if (runStart === 0) return text;
	if (i > runStart) parts.push(text.slice(runStart, i));
	return parts.join("");
}

/**
 * Minify a JSON payload. Returns null unless the text parses as JSON: the scanner
 * removes whitespace that is insignificant *in JSON*, which on something that merely
 * looks like it — a JavaScript object literal in a shell result — would corrupt it.
 * A successful parse is the licence to touch it.
 */
export function minifyJson(text) {
	const trimmed = text.trim();
	if (trimmed.length < 2) return null;
	const first = trimmed[0];
	if (first !== "{" && first !== "[") return null;
	if (utf8Bytes(trimmed) > MAX_JSON_PARSE_BYTES) return null;
	try {
		JSON.parse(trimmed);
	} catch {
		return null;
	}
	const stripped = stripJsonWhitespace(trimmed);
	const saved = utf8Bytes(text) - utf8Bytes(stripped);
	return saved > 0 ? { text: stripped, saved } : null;
}

/**
 * Run the configured passes in order and report what each one removed.
 * `steps` sums to `savedBytes`: each pass measures its own delta against its input.
 */
export function reduce(text, cfg) {
	const steps = { squeeze: 0, fold: 0, clip: 0, json: 0 };
	let out = text;
	let runs = 0;
	let clippedLines = 0;

	if (cfg.squeeze) {
		const result = squeeze(out);
		if (result.saved > 0) {
			steps.squeeze = result.saved;
			out = result.text;
		}
	}
	if (cfg.fold) {
		const result = fold(out, cfg.foldMinRun);
		if (result.saved > 0) {
			steps.fold = result.saved;
			runs = result.runs;
			out = result.text;
		}
	}
	const clipped = clip(out, cfg.clip);
	if (clipped.saved > 0) {
		steps.clip = clipped.saved;
		clippedLines = clipped.lines;
		out = clipped.text;
	}
	if (cfg.json) {
		const result = minifyJson(out);
		if (result) {
			steps.json = result.saved;
			out = result.text;
		}
	}

	return { text: out, changed: out !== text, savedBytes: Math.max(0, utf8Bytes(text) - utf8Bytes(out)), steps, runs, clippedLines };
}

/** Head and tail kept by the budget, plus what was dropped between them. */
export function elide(text, { headChars, tailChars }) {
	const head = headChars > 0 ? text.slice(0, headChars) : "";
	const tailStart = Math.max(head.length, text.length - Math.max(0, tailChars));
	const tail = tailStart < text.length ? text.slice(tailStart) : "";
	const removed = text.slice(head.length, text.length - tail.length);
	return {
		head,
		tail,
		removed,
		removedBytes: utf8Bytes(removed),
		headLines: countLines(head),
		tailLines: countLines(tail),
	};
}

export function countLines(text) {
	if (!text) return 0;
	let lines = 1;
	for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lines += 1;
	return lines;
}

/**
 * Admission test. The marker is part of the transcript for the rest of the session, so it
 * is charged against the saving it advertises: a rewrite that does not pay for its own
 * provenance line is not a saving, and it would still fork the prompt-cache prefix for
 * nothing. `minSavingsTokens` is converted at the estimator's own rate (4 bytes/token).
 */
export function worthwhile(savedBytes, markerBytes, minSavingsTokens) {
	return savedBytes - markerBytes >= Math.max(0, minSavingsTokens) * 4;
}

export function marker(text) {
	return `[${MARK} ${text}]`;
}

/** Provenance for a lossless reduction: nothing was dropped, only made cheaper to read. */
export function compressionMarker(savedBytes, steps) {
	const rules = Object.entries(steps)
		.filter(([, bytes]) => bytes > 0)
		.map(([rule]) => rule)
		.join("+");
	return marker(`${formatSaving(savedBytes)} via ${rules}; content complete`);
}

/** Provenance for a budget elision, naming the handle that restores the middle. */
export function elisionMarker(removedBytes, handle) {
	return marker(`middle elided ${formatSaving(removedBytes)}; full output ${handle}`);
}

/** Provenance for a result already present in this session. */
export function duplicateMarker(toolName, removedBytes, handle) {
	const recovery = handle ? `; full text ${handle}` : "";
	return marker(`identical to the earlier ${toolName} result ${formatSaving(removedBytes)}${recovery}`);
}
