/**
 * Config hygiene for model compat keys.
 *
 * Prior prefix-cache "optimizers" wrote compat keys that oh-my-pi does not define.
 * Two separate mistakes are repaired here:
 *
 *   1. Unknown keys. `compat` is validated by omp's ApiCompatSchema, which has no
 *      `sendSessionAffinityHeaders`, `supportsLongCacheRetention`, … The real surfaces
 *      are `compat.promptCacheSessionHeader` (xai only) and per-model `headers`.
 *      An undeclared key is silently tolerated, so it looks like a fix and does nothing.
 *   2. The wrong file. omp loads `models.yml` (model-registry.ts `ModelsConfigFile
 *      .relocate(getAgentDir()/models.yml)`). A `models.json` sibling is read by nothing,
 *      so a "fix" written there cannot affect a single request.
 *
 * Edits are line-scoped text surgery, never a parse/serialize round trip, so the
 * comments in the user's `models.yml` survive. Every fix writes a timestamped backup
 * and a receipt, and `rollback` restores from it.
 */

import { copyFile, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** Live model config, and the legacy sibling that omp does not read. */
export const LIVE_FILE = "models.yml";
export const LEGACY_FILE = "models.json";

/** Keys a prior optimizer invented, with the name omp would actually accept. */
export const DEAD_KEYS = {
	sendSessionAffinityHeaders: "no such compat field (use headers, or compat.promptCacheSessionHeader on xai hosts)",
	supportsLongCacheRetention: "spelled supportsLongPromptCacheRetention",
	requiresReasoningContentOnAssistantMessages: "spelled requiresReasoningContentForAllAssistantTurns",
	forceAdaptiveThinking: "no such compat field",
	allowEmptySignature: "no such compat field",
};

export const RECEIPT_FILE = "omp-token-mega-fix-receipt.json";

const RECEIPT_KIND = "omp-token-mega-fix-receipt";

function keyPattern(key) {
	// Matches `key:`, `"key":`, `'key':` at any indent — YAML and JSON spellings alike.
	return new RegExp(`^\\s*["']?${key}["']?\\s*:`);
}

/**
 * Find dead-key lines without parsing the document.
 * Returns `{ key, line, indent, reason }` per offender, 1-based line numbers.
 */
export function scanText(text) {
	const lines = text.split(/\r?\n/);
	const offenders = [];
	for (let i = 0; i < lines.length; i += 1) {
		for (const [key, reason] of Object.entries(DEAD_KEYS)) {
			if (keyPattern(key).test(lines[i])) {
				offenders.push({ key, line: i + 1, indent: lines[i].match(/^\s*/)[0].length, reason });
			}
		}
	}
	return offenders;
}

export async function scanFile(path) {
	try {
		return { path, exists: true, offenders: scanText(await readFile(path, "utf8")) };
	} catch {
		return { path, exists: false, offenders: [] };
	}
}

/** Scan the live config and the legacy sibling. */
export async function scan(agentDir) {
	return {
		live: await scanFile(join(agentDir, LIVE_FILE)),
		legacy: await scanFile(join(agentDir, LEGACY_FILE)),
	};
}

/**
 * Remove the offending lines, and if that empties its block, make the block an empty
 * mapping (`compat: {}`) rather than a null that the schema would reject.
 */
export function removeDeadKeys(text, offenders) {
	const lines = text.split(/\r?\n/);
	const drop = new Set(offenders.map((o) => o.line - 1));
	const kept = lines.filter((_, i) => !drop.has(i));
	// Original line index for every kept line, so patching a block header edits the
	// occurrence that owns the offender rather than an earlier identical line.
	const origins = lines.map((_, i) => i).filter((i) => !drop.has(i));

	for (const offender of offenders) {
		// Walk back to the block header that owns this key.
		for (let i = offender.line - 2; i >= 0; i -= 1) {
			const line = lines[i];
			if (!line.trim() || /^\s*#/.test(line)) continue;
			const indent = line.match(/^\s*/)[0].length;
			if (indent >= offender.indent) continue;
			if (!/^\s*["']?[A-Za-z_][\w.-]*["']?\s*:/.test(line)) break;
			// Children still present at deeper indent?
			const hasSiblings = lines.some((other, j) => {
				if (drop.has(j) || j <= i) return false;
				if (!other.trim() || /^\s*#/.test(other)) return false;
				return other.match(/^\s*/)[0].length > indent;
			});
			if (!hasSiblings) {
				const index = origins.indexOf(i);
				if (index >= 0) kept[index] = `${line.trimEnd()} {}`;
			}
			break;
		}
	}
	return kept.join("\n");
}

function stamp() {
	return new Date().toISOString().replace(/[:.]/g, "");
}

/**
 * Apply the repair to both files, backing up each one that changes.
 * Returns a receipt; `changedFiles` is empty when there was nothing to do.
 */
export async function fix(agentDir, { files = [LIVE_FILE, LEGACY_FILE] } = {}) {
	const receipt = {
		version: 1,
		kind: RECEIPT_KIND,
		transactionId: randomUUID(),
		createdAt: Date.now(),
		appliedAt: Date.now(),
		changedFiles: [],
	};
	for (const name of files) {
		const path = join(agentDir, name);
		let text;
		try {
			text = await readFile(path, "utf8");
		} catch {
			continue;
		}
		const offenders = scanText(text);
		if (offenders.length === 0) continue;
		const backupFile = `${name}.backup-mega-cache-${stamp()}`;
		await copyFile(path, join(agentDir, backupFile));
		await writeFile(path, removeDeadKeys(text, offenders), "utf8");
		receipt.changedFiles.push({
			file: name,
			backupFile,
			removed: offenders.map(({ key, line }) => ({ key, line })),
			live: name === LIVE_FILE,
		});
	}
	if (receipt.changedFiles.length > 0) {
		await writeFile(join(agentDir, RECEIPT_FILE), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
	}
	return receipt;
}

/** Restore every file recorded by a receipt, newest receipt unless one is given. */
export async function rollback(agentDir, receiptPath) {
	const path = receiptPath ?? join(agentDir, RECEIPT_FILE);
	let receipt;
	try {
		receipt = JSON.parse(await readFile(path, "utf8"));
	} catch {
		return { ok: false, error: `no receipt at ${path}` };
	}
	if (receipt?.kind !== RECEIPT_KIND) return { ok: false, error: "unrecognized receipt" };
	const restored = [];
	for (const entry of receipt.changedFiles ?? []) {
		try {
			await copyFile(join(agentDir, entry.backupFile), join(agentDir, entry.file));
			restored.push(entry.file);
		} catch (error) {
			return { ok: false, error: `could not restore ${entry.file}: ${error instanceof Error ? error.message : String(error)}` };
		}
	}
	return { ok: true, restored };
}
