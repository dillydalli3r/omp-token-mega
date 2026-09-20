/**
 * The status row.
 *
 * One line, one `setStatus` call, one status key — every number this plugin tracks is a
 * segment of that single row rather than a row of its own. The alternative (each feature
 * claiming its own row) is what the merged plugins did separately, and it costs a line of
 * transcript chrome per feature for the rest of the session.
 *
 * Segments are dropped whole, never half-written: a row clipped mid-token reads as a
 * different number than the one it came from, which is worse than the segment not being
 * there. The order in `statusSegments` is the priority order, so the groups a user cares
 * about are the ones that survive a narrow terminal.
 */

/** Separator between segments; matches the vocabulary the individual plugins used. */
const SEPARATOR = " \u00b7 ";

/**
 * Compose the row from the per-feature segments.
 *
 * `segments` maps a group name (`cache`, `balance`, `token`) to its already-rendered text,
 * or to `undefined`/`""` when that feature has nothing to say right now — a non-DeepSeek
 * model, a disabled feature, no requests yet.
 */
export function composeStatus({ names, segments, maxChars }) {
	const budget = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 120;
	const available = names.map((name) => segments[name]).filter((text) => typeof text === "string" && text !== "");
	if (available.length === 0) return undefined;

	let line = available[0];
	if (line.length > budget) return line.slice(0, budget);
	for (let index = 1; index < available.length; index += 1) {
		const next = `${line}${SEPARATOR}${available[index]}`;
		if (next.length > budget) break;
		line = next;
	}
	return line;
}
