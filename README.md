# omp-token-mega

One plugin for the [oh-my-pi](https://omp.sh) token economy: it shrinks a tool result
*before it is ever sent*, measures the DeepSeek prefix cache it cannot break, reports the
DeepSeek account it is spending, and adds the [LithosAI](#lithosai) provider with its speed
and rate-limit metrics — behind **one command, one settings menu and one status row**.

```
DS cache 92% · 120k cached · $0.84 saved · off-peak (peak 06:00–10:00Z) · DS ¥11.48 · used $1.27 · TS -28.8 KB (~7.4k tok) · 1/1 results
LITHOS 812 tok/s · req 58/60 · tok 131k/256k · TS -28.8 KB (~7.4k tok)
```

That is the row on a DeepSeek session and on a LithosAI session respectively. omp renders
**one footer line per status key** (`status-line/component.ts` pushes a line per hook status),
so this used to be three lines of chrome for the rest of the session — `omp-token-saver`,
`omp-deepseek-mega-cache` and `omp-deepseek-balance` were three plugins with three rows. They
are now one plugin with one key and one line, published through
`ctx.ui.setWidget(key, component, { placement: "belowEditor" })` with a component the plugin
owns — not `ctx.ui.setStatus`, because omp sanitizes status-line text and strips ANSI, which
would erase the peak tint. Segments are dropped whole when they do not fit rather than clipped
mid-number. Money on the row is currency: hundredths, so a figure can be read at a glance. The
sections keep the ledger's precision (four places, six below a cent) — rounding those would
throw away the sub-cent numbers they exist to carry.

Every feature is independent: turn one off and the others keep working, drop a segment from
`statusSegments` and the rest of the row is untouched.

| Feature | What it does | Scope |
| --- | --- | --- |
| **Token saving** | Reduces a tool result before it is first sent: terminal escapes, identical line runs, over-long lines, pretty-printed JSON, byte-identical repeats, over-budget results elided behind `artifact://` handles. | Every provider |
| **Cache accounting** | Measures the DeepSeek prefix cache: hit rate, cached tokens, USD saved, the peak/off-peak window the tariff is in (named and tinted on the row), miss attribution, tool-catalogue drift, subagent shards. Read-only on the request path. | DeepSeek |
| **LithosAI** | Registers the LithosAI provider (models, `/login`, usage reporting) and measures observed tokens/second plus the per-minute request and token budgets from response headers. | LithosAI |
| **Balance** | DeepSeek account balance, the session spend table split into main session and subagents, and the prefix-cache hit rate that produced it. | DeepSeek |

## The one rule

Shrink a tool result before it is first sent; never touch anything already sent. Every
provider's cache is a prefix cache — DeepSeek only hits when its leading tokens match a
persisted cache unit byte for byte, OpenAI matches 128-token blocks from the start of the
request, Anthropic matches at and after an explicit breakpoint — and all of them miss from the
first token that changed. Rewriting history therefore trades an expensive miss for a cheap hit,
and independent A/B work on history-rewriting compressors measures a *worse* end-to-end bill
than doing nothing.

So the reducer subscribes to exactly one payload-bearing event, `tool_result`, and returns only
a content replacement. There is no `context` handler anywhere in the plugin, and the two
payload-bearing hooks it does register — `before_provider_request` for the cache fingerprint,
`before_agent_start` for the system-prompt hash — return `undefined`. The system prompt, the
tool catalogue and the message log are exactly what omp would have built without this plugin,
which is what makes the non-interference claim checkable rather than aspirational.

## Install

From the marketplace this repository publishes:

```bash
omp plugin marketplace add dillydalli3r/omp-token-mega
omp plugin install omp-token-mega@omp-token-mega
```

Or straight from the repository:

```bash
omp plugin install github:dillydalli3r/omp-token-mega
```

Then start a new omp session (extension modules are imported at session start; a hot-plugged
plugin needs one restart). Check what omp sees:

```bash
omp plugin list
omp plugin config list @dillydalli3r/omp-token-mega   # every setting, its type and its env fallback
```

For LithosAI models and login, see [LithosAI](#lithosai).

## Commands

One command, `/mega`:

| Command | Effect |
| --- | --- |
| `/mega` | One report: token saving, prefix cache, LithosAI, account — in that order. |
| `/mega status` | The status row, as plain text and untinted, for modes where the widget is not drawn. |
| `/mega config` | All 34 settings, grouped, with the layer that supplied each (`default`, `preset:<name>`, `global`, `project`, `env`). |
| `/mega config reset [key] [global\|project]` | Drop stored settings so defaults and presets apply again; names any env var still overriding. |
| `/mega menu` | Interactive settings menu, grouped by feature. |
| `/mega preset [off\|conservative\|balanced\|aggressive\|max]` | Show or switch the token-saving bundle. |
| `/mega audit` | Where this session's input tokens actually go, and which omp knobs to change. |
| `/mega cache [doctor\|fix\|rollback]` | Cache section, or the compat-key doctor, its repair (backup + receipt) and the rollback. |
| `/mega lithos` | LithosAI: endpoint, model, rates, measured speed, per-minute budgets, session spend. |
| `/mega balance` | DeepSeek account balance and the session spend table. |
| `/mega reset` | Zero this session's counters. |

The model also gets one tool, `deepseek_balance`, which returns the balance-and-spend section
for the model itself.

## Token saving

Deterministic, one-shot reduction — no model in the loop, no rewrite of what is already in the
transcript. Each pass reports what it removed, and a rewrite is admitted only when it survives
paying for the provenance line it adds (`token.minSavingsTokens`, default 24):

- **squeeze** — ANSI/OSC terminal escapes, control characters, CRLF, trailing whitespace,
  blank-line runs. Lossless in content.
- **fold** — runs of identical consecutive lines become one line plus a count (logs, repeated
  test output, progress bars).
- **clip** — per-line column cap for tools omp does not already cap (`token.clip`, 768 by
  default, matching `tools.outputMaxColumns`).
- **json** — whitespace outside string literals, removed by a string-aware scanner rather than
  a parse-and-reserialize, so numeric literals and escapes are preserved byte for byte.
- **dedupe** — a result whose bytes are already in this session is replaced by a back-reference
  plus an `artifact://` handle holding the full text.
- **elide** — a whole result over `token.maxChars` keeps its head and tail and stashes the
  middle behind an `artifact://` handle. Errors are never elided, deduped or stashed: an elided
  stack trace is a wrong answer, not a saving.

Removed text goes to the same artifact store omp's own spill uses, so `artifact://<id>` is the
one URL the model needs. Markers carry the vocabulary `[token-saver: …]` — the pass names and
their counts are the report's own numbers.

Presets bundle every `token.*` knob: `off` (installed but silent), `conservative` (lossless
cleanup only), `balanced` (the default), `aggressive` (adds a 24 KB per-result budget), `max`
(12 KB, every tool — including `read`, whose hashline anchors a middle elision can invalidate,
which is why no other preset goes there).

## Cache accounting

Active only while the active model belongs to the `deepseek` provider. Nothing is
fingerprinted, nothing is persisted and no segment is drawn on any other model. It never
rewrites a payload: every claim comes from provider-reported usage or from a fingerprint the
plugin computed itself.

- **Hit rate and savings** — token-weighted, priced at the tariff in force when the request was
  sent (DeepSeek's off-peak multiplier included), main session and subagents reported
  separately and summed.
- **Peak indicator** — the row names the window the tariff is in: `peak 01:00–04:00Z` while peak
  is in force, `off-peak (peak 06:00–10:00Z)` off peak, and
  `off-peak (peak Mon 01:00–04:00Z)` when the next window opens on a later weekday. Peak is
  tinted in the theme's error colour, off peak in success. A model that bills both periods the
  same shows no peak text at all — and no "Price period" line in `/mega cache` either.
- **Miss attribution** — `first_turn`, `tool_change`, `system_prompt_change`, `idle_ttl`,
  `compaction`, `branch_nav`, `resume`, `external_miss`. A cold start is a miss too, so expected
  misses stay separable from regressions.
- **Drift** — the system prompt and tool catalogue fingerprints ride in the prefix; a change is
  named on the row (`⚠ tools changed`) and in the report.
- **Subagents** — each child session writes its own shard; the parent aggregates the shards of
  its own process (`cache.subagents`), because a `task` result only carries usage for blocking
  spawns.
- **Retention** — shards nothing has written for `cache.retentionDays` (7 by default) are
  pruned at session start.

## LithosAI

[LithosAI](https://www.lithosai.com) is an OpenAI-compatible inference service. omp ships no
provider for it, so this plugin registers one at runtime: the endpoint
(`https://api.lithosai.cloud/v1`), the model catalogue, a `/login` entry, and usage reporting.

**Sign in.** `/login lithosai` prompts for a console key with masked input, validates it against
`/models`, and stores it. The value of `LITHOSAI_API_KEY` works instead of a login: when the
variable is set and non-blank the provider is registered with that value as its key, and a key
set at registration is a config override, so it takes precedence over whatever `/login` stored;
with the variable unset, the stored login is the only credential that can exist. With neither,
omp reports no credentials for `lithosai` — nothing claims to be logged in, and `/models` is not
called. Create keys at <https://console.lithosai.cloud/keys>.

**Models.** The live catalogue is fetched from `GET /models` with that key (login-stored or
environment) and the returned ids are registered at the configured rates.
`moonshotai/Kimi-K3` — the model LithosAI's own omp guide names — remains the offline fallback
declared in the registration. A failed `/models` call keeps the last good catalogue: the fetch
rejects, so omp holds on to the models it already discovered and retries, rather than replacing
them with an empty list. Their `/models` response carries ids and owners only, so discovered
models are registered with the limits from that guide (256K context, 32K output); put different
ones in `models.yml` if your console shows something else.

**Metrics.** Three numbers, on the one row and in `/mega lithos`:

- **tokens/second** — measured, not quoted: the plugin times each stream
  (`after_provider_response` → `message_end`) and divides by the output tokens that stream
  reported. p50 and max over the session.
- **per-minute budgets** — `x-ratelimit-*` headers from every admitted request, for the request
  and token buckets. These are balances that refill continuously, not windows that reset, so
  they are reported as balances and never as "percent spent".
- **cost** — prepaid credit debited per token at three rates. The rates live in the console
  rather than the API, so set them once: `lithos.inputPerMillion`, `lithos.cachedPerMillion`,
  `lithos.outputPerMillion`. Until then cost reads `$0` and the report says why.

A refusal is visible rather than inferred: the segment shows `LITHOS ✗ 429 retry 2s`, from the
status line and the `retry-after-ms` advice LithosAI asks you to prefer. Point
`lithos.baseUrl` at a self-hosted Lithos Engine to get the same provider, login and metrics
on-prem. The provider's usage reports reach omp's own surfaces too (`/usage`), because the
plugin registers a `usage` provider whose `parseRateLimitHeaders` normalizes the same headers.

## Balance

DeepSeek account balance and session spend, active only on a DeepSeek model: no row segment, no
balance request and no timer otherwise. Two buckets are kept separate so a subagent's spend is
never double counted — `main` (assistant turns plus model-generated branch summaries and
compactions) and `agents` (subagent sessions, read from `details.usage` on `task` results).

Balances are cached for `balance.ttlSeconds` (60 by default) and polled on a managed timer that
is released on shutdown; a failed fetch retries after 15 seconds. Turning `balance.enabled` off
stops the network call and keeps the local spend figures.

## Configuration

Every setting is declared once and resolved from five layers, highest first: environment
variable, project override (`<cwd>/.omp/plugin-overrides.json`), global plugin setting
(`omp plugin config set`), preset bundle, built-in default. Sources are shown per key by
`/mega config`, and a write that a higher layer shadows says so instead of silently doing
nothing.

| Group | Keys |
| --- | --- |
| Shell | `enabled`, `statusRow`, `statusMaxChars`, `statusSegments`, `stateDir` |
| Token saving | `token.enabled`, `token.preset`, `token.tools`, `token.minChars`, `token.maxScanBytes`, `token.squeeze`, `token.fold`, `token.foldMinRun`, `token.clip`, `token.json`, `token.dedupe`, `token.dedupeMinChars`, `token.maxChars`, `token.headChars`, `token.tailChars`, `token.stash`, `token.minSavingsTokens`, `token.perf` |
| Cache accounting | `cache.enabled`, `cache.subagents`, `cache.idleTtlMinutes`, `cache.retentionDays` |
| LithosAI | `lithos.enabled`, `lithos.baseUrl`, `lithos.inputPerMillion`, `lithos.outputPerMillion`, `lithos.cachedPerMillion` |
| Balance | `balance.enabled`, `balance.ttlSeconds` |

`statusSegments` is the row's whole layout: a comma-separated list drawn from `cache`,
`lithos`, `balance`, `token` (`"cache,lithos,balance,token"` by default). Order is display
order, unknown names are ignored, and a segment that does not fit `statusMaxChars` is dropped
whole — a row clipped mid-number reads as a different number than the one it came from.

```bash
# examples
omp plugin config set @dillydalli3r/omp-token-mega token.preset aggressive
omp plugin config set @dillydalli3r/omp-token-mega statusSegments token,balance
omp plugin config set @dillydalli3r/omp-token-mega balance.ttlSeconds 300
omp plugin config delete @dillydalli3r/omp-token-mega token.preset   # back to the default bundle
```

Environment fallbacks are `OMP_TOKEN_MEGA_*` (`OMP_TOKEN_MEGA_TOKEN_*`, `OMP_TOKEN_MEGA_CACHE_*`,
`OMP_TOKEN_MEGA_LITHOS_*`, `OMP_TOKEN_MEGA_BALANCE_*` for the groups), listed as `env:` by
`omp plugin config list`.

`/mega menu` edits all of it in the TUI, grouped by feature: pick a group, pick a key, and the
write goes through `omp plugin config` so omp's own files stay authoritative. In print, RPC and
ACP modes the same content is printed as text with the exact shell commands.

### Deliberately not implemented

- **History rewriting.** Never. See [the one rule](#the-one-rule) — it is the reason all of
  this is measured rather than assumed.
- **A second implementation of omp's own reductions** (artifact spill, `pruneToolOutputs`,
  `supersedeReads`, `dropUseless`, `shake`, structural `read` summaries). They are already
  cache-aware; when omp has elided a result, this plugin compresses what is left and skips its
  own budget.
- **Compressing errors.** Lossless passes only — never elided, deduped or stashed.
- **A balance or usage endpoint for LithosAI.** There is none to poll; budgets come from the
  headers on real traffic.

## Migrating from the three plugins

```bash
omp plugin uninstall @dillydalli3r/omp-token-saver
omp plugin uninstall @dillydalli3r/omp-deepseek-mega-cache
omp plugin uninstall @dillydalli3r/omp-deepseek-balance
omp plugin install github:dillydalli3r/omp-token-mega
```

Then re-apply your settings under the new key: settings are namespaced per package, so the old
`@dillydalli3r/omp-token-saver` / `…-mega-cache` entries do not carry over. Prefixed names are
the only change — `minChars` became `token.minChars`, `idleTtlMinutes` became
`cache.idleTtlMinutes`, and the shared shell keys (`enabled`, `statusRow`, `statusMaxChars`,
`stateDir`) kept their names. `/mega config` prints the effective values, `/mega menu` edits
them.

Leftovers from the old installs are safe to delete: the shard directory
`~/.omp/agent/omp-deepseek-mega-cache-stats.d/` (the merged plugin uses
`omp-token-mega-stats.d/`), and any `omp-deepseek-mega-cache-fix-receipt.json` in the agent
directory (the merged plugin writes `omp-token-mega-fix-receipt.json`).

## Credits

Prior art, licence positions and what was (and was not) taken from each upstream are recorded
in [CREDITS.md](./CREDITS.md), including the LithosAI sources for the provider registration.

## License

MIT — see [LICENSE](./LICENSE).
