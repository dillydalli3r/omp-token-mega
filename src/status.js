/**
 * The status row.
 *
 * One line, one widget, one key — every number this plugin tracks is a part of that single
 * row rather than a row of its own. The alternative (each feature claiming its own row) is
 * what the merged plugins did separately, and it costs a line of transcript chrome per
 * feature for the rest of the session.
 *
 * The row is drawn by a component the plugin registers itself — `ctx.ui.setWidget(key,
 * factory, { placement: "belowEditor" })` — rather than by `ctx.ui.setStatus`, because omp
 * sanitizes hook status text: ANSI/VT escape sequences are stripped (`omp://hooks.md`,
 * "Status line behavior"), so a tinted token would reach the terminal as plain text. The
 * TUI calls a widget's `render(width)` with the live theme, which is the only place a state
 * such as peak pricing can keep its color.
 *
 * A segment may hold several parts, so one token inside it can carry a tone while its
 * neighbours stay plain. A part is `string | { text, color }`, `color` naming a tone in
 * `TINTS`; an unknown tone name renders plain.
 *
 * Segments are dropped whole, never half-written: a row clipped mid-token reads as a
 * different number than the one it came from, which is worse than the segment not being
 * there. The order in `statusSegments` is the priority order, so the groups a user cares
 * about are the ones that survive a narrow terminal.
 */

/** Separator between segments, and between the parts of one segment. */
export const SEPARATOR = " \u00b7 ";

/**
 * Tone name -> theme role. The row's tones are named by the feature that raises them
 * (`red` for peak pricing), so a theme change or a different status palette never has to
 * reach into the features.
 */
export const TINTS = { red: "error", green: "success", yellow: "warning" };

/**
 * Bind the tone names to a theme. The TUI hands the theme to the widget factory, not to the
 * composer, so this is the seam where a tone becomes an escape sequence.
 */
export function themeTint(theme) {
	return (tone, text) => theme.fg(TINTS[tone] ?? "text", text);
}

/** One rendered piece of a segment with the tone it carries, if any. */
function toParts(segment) {
	const list = Array.isArray(segment) ? segment : [segment];
	const parts = [];
	for (const item of list) {
		if (typeof item === "string") {
			if (item !== "") parts.push({ text: item });
			continue;
		}
		if (item && typeof item.text === "string" && item.text !== "") {
			const color = item.color;
			const named = typeof color === "string" && color !== "";
			parts.push(named ? { text: item.text, color } : { text: item.text });
		}
	}
	return parts;
}

/**
 * Compose the row from the per-feature segments.
 *
 * `segments` maps a group name (`cache`, `balance`, `token`) to its already-rendered text —
 * or to several parts, when one token inside the segment carries a tone — and to
 * `undefined`/`""` when that feature has nothing to say right now: a non-DeepSeek model, a
 * disabled feature, no requests yet.
 *
 * Returns rows of parts rather than a string: tinting needs a theme, and the theme only
 * exists inside the TUI component that calls `renderRow`. A trailing segment that would
 * push the row past `maxChars` is dropped whole; the first segment is kept even when it
 * overflows, because an empty row reads as a broken plugin and `renderRow` clips to the
 * real width anyway.
 */
export function composeRow({ names, segments, maxChars }) {
	const budget = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 120;
	const rows = [];
	let used = 0;
	for (const name of names) {
		const parts = toParts(segments[name]);
		if (parts.length === 0) continue;
		// The budget counts the characters the terminal will show, so the row is measured
		// plain; `renderRow` adds the tint afterwards, which changes no visible width.
		const length = parts.reduce((sum, part) => sum + part.text.length, 0);
		const next = rows.length === 0 ? length : used + SEPARATOR.length + length;
		if (rows.length > 0 && next > budget) break;
		rows.push(parts);
		used = next;
	}
	return rows.length === 0 ? undefined : rows;
}

/**
 * Draw the composed rows as one line, tinted and clipped.
 *
 * Clipping is by `String.prototype.length`, which is right for this row: the characters are
 * ASCII plus `\u00b7`, `\u26a0`, `\u2717`, `\u00a5` and `\u2013`, none of which is astral or
 * a combining mark. The tint is applied after the slice, so a color code never inflates the
 * measured width.
 */
export function renderRow(rows, { width = Infinity, tint } = {}) {
	if (!Array.isArray(rows) || rows.length === 0) return undefined;
	const limit = Number.isFinite(width) && width > 0 ? Math.floor(width) : Infinity;
	const pieces = [];
	let used = 0;
	for (const row of rows) {
		for (const part of row ?? []) {
			const text = typeof part?.text === "string" ? part.text : "";
			if (text === "") continue;
			const prefix = pieces.length === 0 ? "" : SEPARATOR;
			const room = limit === Infinity ? Infinity : limit - used - prefix.length;
			if (room <= 0) return pieces.join("");
			const shown = text.length > room ? text.slice(0, room) : text;
			pieces.push(prefix, part.color && tint ? tint(part.color, shown) : shown);
			used += prefix.length + shown.length;
			if (shown.length < text.length) return pieces.join("");
		}
	}
	return pieces.length === 0 ? undefined : pieces.join("");
}
