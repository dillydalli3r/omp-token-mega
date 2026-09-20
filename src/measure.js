/**
 * Size and token measurement.
 *
 * Nothing here tokenizes. When a plugin runs inside oh-my-pi there is no reachable
 * exact tokenizer: `Tokenizer` lives in `@oh-my-pi/pi-agent-core`, which the
 * coding-agent root does not re-export, and its exact path needs the native addon.
 * So the estimate below is deliberately the *same formula omp itself falls back to*
 * when no encoding is loaded — `(utf8Bytes + 3) >> 2`, `byteEstimate` in
 * `packages/agent/src/tokenizer.ts` — which keeps this plugin's numbers on the same
 * scale as the rest of the harness instead of inventing a second unit.
 *
 * Byte counts are exact (we hold the string). Token counts are an estimate and are
 * labelled as one everywhere they surface.
 */

/** omp's own estimator: utf8 bytes / 4, rounded up. */
export function estimateTokens(text) {
	return tokensFromBytes(utf8Bytes(text));
}

/** The same estimator applied to a byte count we already measured — no allocation. */
export function tokensFromBytes(bytes) {
	return (Math.max(0, Math.round(Number(bytes) || 0)) + 3) >> 2;
}

export function utf8Bytes(text) {
	if (typeof text !== "string" || text.length === 0) return 0;
	// Buffer.byteLength is a native call and avoids allocating an encoded copy.
	return Buffer.byteLength(text, "utf-8");
}

/** Compact token count: 987, 12.3k, 1.24M. */
export function formatTokens(value) {
	const n = Math.round(Number(value) || 0);
	if (Math.abs(n) < 1000) return String(n);
	if (Math.abs(n) < 1_000_000) {
		const k = n / 1000;
		return `${k < 100 ? k.toFixed(1) : Math.round(k)}k`;
	}
	return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Compact byte count: 412 B, 12.3 KB, 1.24 MB. */
export function formatBytes(value) {
	const n = Number(value) || 0;
	if (n < 1024) return `${Math.round(n)} B`;
	if (n < 1024 * 1024) {
		const kb = n / 1024;
		return `${kb < 100 ? kb.toFixed(1) : Math.round(kb)} KB`;
	}
	return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** One marker-friendly summary of a byte saving: "-12.3 KB (~3.1k tok)". */
export function formatSaving(bytes) {
	return `-${formatBytes(bytes)} (~${formatTokens(tokensFromBytes(bytes))} tok)`;
}

/**
 * Fixed-decimal money: every decimal place of the chosen precision is rendered, zeros
 * included, so a figure's width never depends on whether trailing digits happen to be
 * used. Six places below a cent keep sub-cent amounts visible; zero itself uses the
 * four-place form. Never renders "-0".
 *
 * `digits` pins the precision. The row asks for hundredths — the precision a currency
 * is read at — while the ledgers (the sections, the balance table, the model-facing
 * figures) keep the default, because rounding a ledger to the cent throws away the
 * only numbers it exists to carry.
 */
export function money(value, digits) {
	const n = Number(value);
	if (!Number.isFinite(n)) return (0).toFixed(digits ?? 4);
	const places = Number.isInteger(digits) && digits >= 0 ? digits : n !== 0 && Math.abs(n) < 0.01 ? 6 : 4;
	const text = Math.abs(n).toFixed(places);
	if (Number(text) === 0) return text;
	return n < 0 ? `-${text}` : text;
}

/** Rounded percentage, or undefined when there is no denominator. */
export function percent(part, whole) {
	if (!(whole > 0)) return undefined;
	return `${Math.round((part / whole) * 100)}%`;
}

/**
 * What a marker costs the transcript: its own bytes plus the newline that separates it
 * from the text it annotates. Every admission test is charged this, so a saving is only
 * taken when it survives paying for the line that advertises it.
 */
export function lineCost(text) {
	return utf8Bytes(`\n${text}`);
}

/** p50 and max of a numeric sample; undefined-safe. */
export function timing(samples) {
	if (!samples || samples.length === 0) return undefined;
	const sorted = [...samples].sort((a, b) => a - b);
	const mid = sorted[sorted.length >> 1];
	return { median: mid, max: sorted[sorted.length - 1], count: sorted.length };
}
