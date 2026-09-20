/**
 * Regenerate the `omp.settings` block of `package.json` from `src/config.js`.
 *
 * The harness reads the manifest statically (`omp plugin config list`, and the settings
 * editor it builds from the declared schema), while the plugin reads `CONFIG_SCHEMA` at
 * runtime — so the two have to agree. This script makes the manifest a projection of the
 * schema instead of a second copy of it, and `test/cache.test.mjs` fails when they drift.
 *
 *   node scripts/manifest.mjs > package.json
 */

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
	version: "1.0.0",
	description:
		"One oh-my-pi plugin for the token economy: cache-safe reduction of live tool results, DeepSeek prefix-cache accounting with miss attribution, and the DeepSeek account balance and session spend. One command, one settings menu, one status row.",
	license: "MIT",
	author: "dillydalli3r",
	type: "module",
	repository: { type: "git", url: "git+https://github.com/dillydalli3r/omp-token-mega.git" },
	homepage: "https://github.com/dillydalli3r/omp-token-mega",
	bugs: { url: "https://github.com/dillydalli3r/omp-token-mega/issues" },
	keywords: ["omp", "oh-my-pi", "tokens", "cost", "compression", "tool-output", "dedupe", "context", "deepseek", "prefix-cache", "prompt-cache", "kv-cache", "cache-hit-rate", "balance", "spend", "statusline", "tui", "subagents"],
	omp: { extensions: ["./src/index.js"], settings },
	files: ["src", "scripts", "test", "README.md", "LICENSE", "CREDITS.md"],
	scripts: {
		check: "node --check src/index.js && node --check src/config.js && node --check src/status.js && node --check src/report.js && node --check src/menu.js && node --check src/token.js && node --check src/cache.js && node --check src/balance.js && node --check src/balance-client.js && node --check src/compress.js && node --check src/dedupe.js && node --check src/measure.js && node --check src/audit.js && node --check src/stats.js && node --check src/prefix.js && node --check src/deepseek.js && node --check src/repair.js && node --check src/usage.js",
		test: "node test/token.test.mjs && node test/cache.test.mjs && node test/lithosai.test.mjs && node test/balance.test.mjs && node test/shell.test.mjs",
		manifest: "node scripts/manifest.mjs > package.json",
	},
	engines: { node: ">=18" },
};
process.stdout.write(JSON.stringify(pkg, null, 2) + "\n");
