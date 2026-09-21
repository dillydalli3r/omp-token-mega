/**
 * Regenerate `package.json` from `src/config.js` — in place, atomically.
 *
 * The harness reads the manifest statically (`omp plugin config list`, and the settings
 * editor it builds from the declared schema), while the plugin reads `CONFIG_SCHEMA` at
 * runtime — so the two have to agree. This script makes the manifest a projection of the
 * schema instead of a second copy of it, and `test/cache.test.mjs` fails when they drift.
 *
 *   node scripts/manifest.mjs
 *
 * The documented usage used to be `node scripts/manifest.mjs > package.json`, and that is
 * how this manifest was nearly lost during the merge: the shell truncates the redirect
 * target *before* the process starts, so anything that goes wrong afterwards — a thrown
 * error, a failed import, one stray byte on stdout — leaves an empty `package.json`
 * behind, and Node then refuses to load the plugin at all. So the document is written to
 * `package.json.tmp` beside the real manifest and renamed over it only once the bytes are
 * on disk: a failure leaves the previous manifest exactly as it was, and stdout carries a
 * one-line receipt instead of the document.
 */

import { renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONFIG_SCHEMA } from "../src/config.js";

const settings = {};
for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
	const entry = { type: schema.type };
	if (schema.values) entry.values = schema.values;
	entry.default = schema.default;
	if (schema.min !== undefined) entry.min = schema.min;
	if (schema.max !== undefined) entry.max = schema.max;
	entry.env = schema.env;
	entry.description = schema.description;
	settings[key] = entry;
}

const pkg = {
	name: "@dillydalli3r/omp-token-mega",
	version: "2.0.0",
	description:
		"One oh-my-pi plugin for the token economy: prefix-cache accounting and advice for every provider whose models report cached input tokens (DeepSeek, OpenCode Go, Google Gemini, LithosAI, Anthropic, OpenAI), a cache-safe reducer that shrinks a tool result before it is first sent, the account behind the active model with the session's USD cost, and the LithosAI provider with published rates, measured tokens/second and rate-limit metrics. One command, one settings menu, one status row.",
	license: "MIT",
	author: "dillydalli3r",
	type: "module",
	repository: { type: "git", url: "git+https://github.com/dillydalli3r/omp-token-mega.git" },
	homepage: "https://github.com/dillydalli3r/omp-token-mega",
	bugs: { url: "https://github.com/dillydalli3r/omp-token-mega/issues" },
	keywords: ["omp", "oh-my-pi", "tokens", "cost", "prefix-cache", "prompt-cache", "kv-cache", "cache-hit-rate", "cache-accounting", "append-only-context", "tool-output", "compression", "dedupe", "context", "subagents", "balance", "spend", "statusline", "tui", "lithosai", "deepseek", "gemini", "anthropic", "openai", "opencode"],
	omp: { extensions: ["./src/index.js"], settings },
	files: ["src", "scripts", "test", "README.md", "LICENSE", "CREDITS.md"],
	scripts: {
		check: "node --check src/index.js && node --check src/config.js && node --check src/status.js && node --check src/report.js && node --check src/menu.js && node --check src/token.js && node --check src/cache.js && node --check src/balance.js && node --check src/balance-client.js && node --check src/compress.js && node --check src/dedupe.js && node --check src/measure.js && node --check src/audit.js && node --check src/stats.js && node --check src/prefix.js && node --check src/deepseek.js && node --check src/repair.js && node --check src/usage.js && node --check src/lithosai.js && node --check src/model.js",
		test: "node test/token.test.mjs && node test/cache.test.mjs && node test/lithosai.test.mjs && node test/balance.test.mjs && node test/shell.test.mjs",
		manifest: "node scripts/manifest.mjs",
	},
	engines: { node: ">=18" },
};

const target = fileURLToPath(new URL("../package.json", import.meta.url));
const temporary = `${target}.tmp`;
writeFileSync(temporary, `${JSON.stringify(pkg, null, 2)}\n`);
renameSync(temporary, target);
process.stdout.write(`Wrote ${target}: ${Object.keys(settings).length} settings from src/config.js (${pkg.name} v${pkg.version}).\n`);
