# omp-token-mega

One plugin for the [oh-my-pi](https://omp.sh) token economy: it shrinks a tool result
*before it is ever sent*, meters the prefix cache on every model whose provider reports one,
names the omp settings that keep that prefix byte-stable and cheap — and, through
[`/mega tune`](#tuning), writes them as session overrides — reports the account behind the
active model with its quota windows and the session's USD cost, and adds the
[LithosAI](#lithosai) provider with its speed and rate-limit metrics — behind **one command,
one settings menu and one status row**.

```
cache 92% · 120k cached · $0.84 saved · off-peak, peak 2026-09-20 21:00–2026-09-21 00:00 EDT · DS ¥11.48 · used $1.27 · TS -28.8 KB (~7.4k tok) · 1/1 results
5h 12% ↻4h12m · 7d 61% ↻2d20h · monthly 88% · GO · used $1.27 · TS -12.3 KB (~3.1k tok)
cache 49% · 19k cached · $0.04 saved · LITHOS · used $0.06 · TS ready
cache 71% · 44k cached · $0.02 saved · ⚠ append-only off · GEMINI · used $0.31 · TS ready
```

That is the row on a DeepSeek session, an OpenCode Go session, a LithosAI session and a
Google Gemini session respectively: one layout on all four, carrying the same metrics under
the same names — hit rate, cached tokens, USD saved, USD used — with only the
provider-specific parts differing. The tag names the account being spent (`DS`, `LITHOS`,
`GEMINI`, and `GO`, `ZEN`, `CLAUDE`, `OAI`, `OR` for the rest); the `window` group is the
quota headroom a metered provider publishes, which is the figure that decides whether a
session can still bill; DeepSeek then contributes the peak/off-peak tariff and the polled
balance figure (`DS ¥11.48`); LithosAI publishes no balance and bills flat rates, so its row
stops after the tag, and a Gemini row carries the warning that nothing is holding its prefix
still (see [Prefix stability](#prefix-stability)). LithosAI's speed and per-minute budgets
are measured and reported in `/mega lithos`, not as extra row segments — the row is the same
row on every provider. omp renders
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

## Prefix stability

The largest cache lever here is not in this plugin. A prefix cache hits only while the
leading tokens of a request match what the provider cached earlier, and omp's own
`provider.appendOnlyContext` is what holds those leading tokens still: the system prompt, the
tool catalogue and the message log are frozen once and appended to, instead of being
re-serialized on every request.

omp turns that mode on by itself only where its rule covers the model — `deepseek`, the local
engines (`ollama`, `ollama-cloud`, `lm-studio`, `llama.cpp`), a model served over loopback,
RFC1918 or `.local`, and a route whose compat config sets `supportsStore`. On **every other
provider** — OpenCode Go and OpenCode Zen, Google Gemini, LithosAI's remote endpoint,
Anthropic, OpenAI, OpenRouter — the leading block is rebuilt per request from the live system
prompt, tool catalogue and message log. A prefix is cached from the front, so one line that
comes out different early in it costs the hits of everything behind it. Rebuilding is not the
same as changing — a session whose inputs happen to be stable hits just as well — which is why
this is *insurance*, and why the hit rate the cache accounting measures is what says whether it
was needed. On a measured session on this plugin's own gateway, the cache hit rate sat at 99.6%
of input tokens with append-only off, so the honest expectation is not "this doubles your
savings" but "the turns where something moved stop costing the whole prefix".

Three doors to the same setting:

- on the row, as a yellow `⚠ append-only off` part, drawn only when the plugin and the cache
  accounting are on, the live model is cache capable, omp's auto rule does not cover its
  provider, `cache.appendOnly` is on, and this session's shard has recorded at least one miss;
- in `/mega cache` under `#### Prefix stability`, and on its own as
  `/mega cache stability`: the model, whether append-only is automatic there and which part of
  omp's rule decides it, and the remedy;
- in `/mega audit`, as a `provider.appendOnlyContext: auto → **on**` row — current value
  `auto` until something stores one — carrying the reason and
  `omp config set provider.appendOnlyContext on`.

`/mega tune` is the one thing that writes it, and it writes a **runtime override**: the setting
changes for this process, `config.yml` is untouched, and `/mega tune revert` puts it back.
`/mega tune save` is the explicit request to write it to your config instead. The advice is
still printed with the exact `omp config set` line for a user who would rather make the change
themselves, and `cache.appendOnly=false` still suppresses the advice and the row part without
stopping the measurement.

Every feature is independent: turn one off and the others keep working, drop a segment from
`statusSegments` and the rest of the row is untouched.

| Feature | What it does | Scope |
| --- | --- | --- |
| **Token saving** | Reduces a tool result before it is first sent: terminal escapes, identical line runs, over-long lines, pretty-printed JSON, byte-identical repeats, over-budget results elided behind `artifact://` handles. | Every provider |
| **Cache accounting** | Measures the prefix cache: hit rate, cached tokens, USD saved, the peak/off-peak window the tariff is in (named and tinted on the row), miss attribution, tool-catalogue drift, subagent shards, and whether omp is holding the prefix …
| **LithosAI** | Registers the LithosAI provider (models, `/login`, usage reporting) and measures observed tokens/second plus the per-minute request and token budgets from response headers. | LithosAI || **Balance** | The account behind the active model and the session cost table split into main session and subagents, plus the prefix-cache hit rate that produced it. DeepSeek's balance is polled; LithosAI publishes none, so its section reports the credit state the wire shows and names the console; every other model the cache accounting can measure gets the tag, this session's spend, and the fact that its account surface is not polled here. | Every model the cache accounting can measure |

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

On Windows, `install.bat` in the repository root does the same and then verifies: it checks
that `omp` and `bun` are on `PATH` (omp installs plugins by running `bun install`), installs,
and confirms `omp plugin list` and `omp plugin config list` both see the package, so a failed
install cannot look like a successful one.

```bat
install.bat                      install from github:dillydalli3r/omp-token-mega
install.bat local                install this working copy instead (a symlink; refused
                                 unless this shell can create one - Developer Mode or elevated)
install.bat force                reinstall or upgrade over an existing install
install.bat nopause              never wait for a keypress when finished
install.bat help
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
| `/mega` | The menu: report, status, settings, preset, audit, cache, LithosAI, balance, reset. |
| `/mega report` | One report: token saving, prefix cache, LithosAI, account — in that order. |
| `/mega status` | The status row, as plain text and untinted, for modes where the widget is not drawn. |
| `/mega config` | All 38 settings, grouped, with the layer that supplied each (`default`, `preset:<name>`, `global`, `project`, `env`). |
| `/mega config reset [key] [global\|project]` | Drop stored settings so defaults and presets apply again; names any env var still overriding. |
| `/mega menu` | The same menu, spelled out (a bare `/mega` opens it too). |
| `/mega preset [off\|conservative\|balanced\|aggressive\|max]` | Show or switch the token-saving bundle. |
| `/mega audit` | Where this session's input tokens actually go, and which omp knobs to change. |
| `/mega cache [doctor\|fix\|rollback\|stability]` | Cache section, the compat-key doctor, its repair (backup + receipt) and the rollback, or the prefix-stability block on its own. |
| `/mega lithos` | LithosAI: endpoint, catalogue, what `/models` served, rates, measured speed, budgets, session cost. |
| `/mega balance` | The account behind the active model — DeepSeek's polled balance, the credit state LithosAI's wire shows, or the tag and this session's spend — and the session cost table. |
| `/mega reset` | Zero this session's counters. |

`/mega` on its own opens the menu rather than printing the report, because the menu is where
every action lives and the report is its first entry. Subcommands stay: they are what a script,
a keystroke macro or a host without dialogs uses, and each menu entry calls the same function
the subcommand does. A dialog host that cannot answer gets the report or the settings text
instead of a hung command.

The model also gets one tool, `account_balance` (labelled *Account balance*), which returns
the account-and-cost section for the model itself.

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

The ledger reconciles by construction rather than by inspection: net bytes removed from the
transcript are the sum of each pass's own contribution — `squeeze`, `fold`, `clip`, `json`,
`elide` and `dedupe`, each measured as the difference between that pass's input and its output,
so a count `fold` writes into its own line is already inside its figure — minus the provenance
markers written in their place, newlines included, since a marker is never a saving. Elision is
booked from the figure the elision itself computed (`elided.removedBytes`), not from the head
and tail lengths, because a multi-byte character straddling either cut would otherwise be
counted twice. A rewrite that does not clear `token.minSavingsTokens` books nothing at all, so
no partial credit can appear on the page.

Presets bundle every `token.*` knob: `off` (installed but silent), `conservative` (lossless
cleanup only), `balanced` (the default), `aggressive` (adds a 24 KB per-result budget), `max`
(12 KB, every tool — including `read`, whose hashline anchors a middle elision can invalidate,
which is why no other preset goes there).

## Cache accounting

Active while the live model is cache capable, which is this feature's whole gate: its
catalogue declares a cache-read rate (`cost.cacheRead > 0`), **or** its provider is one whose
models are known to report cached input tokens — `deepseek`, `lithosai`, `google` and its two
alias routes, `opencode-go`, `opencode-zen`, `anthropic`, `openai`, `openrouter`. The provider
list is the fallback for a catalogue that carries no rate, never the definition of scope: omp
normalizes every provider's usage into the same `{ input, output, cacheRead, cacheWrite }`
record, so a model that reports cached tokens is measured the same way wherever it is served.
Where the rate is missing, the hit rate and the token counts still stand and only the money is
unknown — the section says `unknown` rather than `$0.00 saved`, because an unpriced saving and
a zero saving are different facts. On a model that reports neither, nothing is fingerprinted,
nothing is persisted and no segment is drawn. The feature never rewrites a payload: every claim
comes from provider-reported usage or from a fingerprint the plugin computed itself.

- **Hit rate and savings** — token-weighted, priced at the tariff in force when the request was
  sent (DeepSeek's off-peak multiplier included), main session and subagents reported
  separately and summed.
- **Peak indicator** — the row names the window the tariff is in, in **your** zone, dated, with
  the zone named: `peak 2026-09-15 21:00–2026-09-16 00:00 EDT` while peak is in force,
  `off-peak, peak 2026-09-20 21:00–2026-09-21 00:00 EDT` off peak. DeepSeek declares its
  windows in UTC (`01:00–04:00Z`, `06:00–10:00Z`, Mon–Fri), so the schedule is converted at the
  offset in force: the same window reads `20:00–23:00 EST` in January, and a window that
  crosses local midnight shows both dates. Off peak always names the next window *and its
  date*, which can be up to a week away, so "when is peak" needs no mental arithmetic. The UTC
  bounds stay in `/mega cache`, where the rate card is quoted: `Price period: off-peak … —
  next window: peak Mon 01:00–04:00Z = 2026-09-20 21:00–2026-09-21 00:00 EDT`. Peak is tinted in
  the theme's error colour, off peak in success. A model that declares no schedule shows no
  peak text at all — and no "Price period" line in `/mega cache` either; LithosAI bills three
  flat rates, so its row carries no period.
- **Miss attribution** — `first_turn`, `system_change`, `tool_change`, `history_rewrite`,
  `compaction`, `model_switch`, `idle_ttl`, `prefix_too_small`, `branch_nav`, `resume`,
  `external_miss`, most-specific cause first. A cold start is a miss too, so expected misses
  stay separable from regressions; a cause named by a lifecycle event (a compaction, a branch
  move, a resume) outranks the inference, because the host knows what it just did.
- **Drift** — the system prompt and tool catalogue fingerprints ride in the prefix; a change is
  named on the row (`⚠ tools changed`) and in the report.
- **Prefix stability** — the section's own `#### Prefix stability` block, `/mega cache
  stability`, and the row's yellow `⚠ append-only off` part: whether omp is holding the prefix
  still on this provider, and the one command that would. See
  [Prefix stability](#prefix-stability).
- **Subagents** — each child session writes its own shard; the parent aggregates the shards of
  its own process (`cache.subagents`), because a `task` result only carries usage for blocking
  spawns.
- **Retention** — shards nothing has written for `cache.retentionDays` (7 by default) are
  pruned at session start.

### The miss that is labelled, not chased

`prefix_too_small` is the one attributed cause no client-side change can fix, so it is named
and then left alone. Most providers cache a prefix only above a model-specific floor, so a
request whose billed input is under `cache.minPrefixTokens` (1024 by default) is billed fully
uncached by construction — on Gemini 2.5 and later that floor is exactly 1024 tokens. The label
is gated by the floor and sits behind every cause the client *can* act on: it is returned only
when the floor is above zero, the request billed something, and its billed input is under the
floor and no more specific cause applies. Set `cache.minPrefixTokens` to `0` to stop labelling
short prefixes and let them read as ordinary misses, or raise it to your provider's real floor.

## Usage windows

Cost is not the only thing that stops a long session; a spent quota is. OpenCode Go meters the
account with three windows — 5-hour rolling, weekly, monthly — and publishes them at
`GET https://opencode.ai/zen/go/v1/usage`: a percent used, a status (`ok` or `rate-limited`)
and the instant each resets. Hit the ceiling on the rolling window and requests stop until it
rolls, whatever credit is left on the account. That is the number a session plan has to be
built around, so it is read, drawn and projected:

- **On the row**, as the `window` group: `5h 12% ↻4h12m · 7d 61% ↻2d20h`, yellow from
  `window.warnAt` percent (80 by default) and red once the provider is refusing requests. The
  group is dropped when the provider publishes no windows, so a Google or Anthropic session's
  row is exactly what it was.
- **In `/mega balance`**, as `### Usage windows`: one row per window with the used percentage,
  the status and the reset on **your** clock plus the countdown, then the advice.
- **With a burn rate.** Every refresh samples the shortest window, so the section can say
  `burning 6.2%/h — exhaustion in 4h10m, ahead of the reset in 5h` and name the action: pace
  requests, switch model, or wait for the reset. A window whose reset lands before the
  projected exhaustion is reported that way instead of being given a bogus ETA.

The route is the same one omp's own usage provider reads, with the same credential the model's
requests carry (`x-opencode-session` included), polled on the balance timer, cached, and kept
on a failure: a 401 or a 500 leaves the last good report in place rather than blanking the
row. `window.enabled=false` stops the request entirely.

## Tuning

Everything above measures. This is the part that acts on what it measures — via
`pi.pi.settings`, omp's live `Settings` singleton, which is the only handle a plugin has on
core settings.

`/mega tune` prints the plan for the live model: every knob the plugin would change, its live
value, the recommendation, and the reason. `/mega tune apply` writes them as **runtime
overrides** — the setting changes for this process, `config.yml` is untouched, and
`/mega tune revert` takes it back. `/mega tune save` is the explicit request to persist them
instead. Nothing is ever written to a knob **you** configured: it is reported as yours, with
the exact `omp config set …` line, and only `force` re-offers it.

| Knob | Recommended | Why |
| --- | --- | --- |
| `provider.appendOnlyContext` | `on`, when the model is cache capable but omp's own auto rule does not cover its provider | a cache read bills a fraction of a miss — on DeepSeek-class routes 2% — and this is the setting that keeps the leading block byte-stable, so a turn where something under it moves does not cost the whole prefix. Insurance, not a doubling: check the hit rate the cache section reports before and after |
| `display.cacheMissMarker` | `true` on a cache-capable model | a miss is the most expensive event in the session; an invisible one cannot be diagnosed |
| `tools.artifactSpillThreshold` | sized to the live context window (`contextWindow / 8000`, clamped 8–50 KB) | on a large window a 50 KB inline result is paid for again on every later request |
| `retry.waitForUsageReset` | `true` | a request that hits a 5-hour or weekly limit sleeps until the reset instead of failing, so a long run finishes without a human restarting it |
| `todo.remindersMax` | `6` (omp's default is 3) | omp nudges an agent that stops with an unfinished todo list; the extra nudges are cheap turns that finish the work instead of leaving it to be redone |
| `task.softRequestBudget` | `400` (omp's default is 200, force-stop at 1.5×) | a subagent stopped mid-investigation pays for its requests twice when a fresh child starts over |
| `bash.autoBackground.thresholdMs` | `30000` (omp's default is 60000) | a slow command is backgrounded a minute earlier, so the turn stops waiting on it |

The plan is advice where a knob is a behaviour choice rather than a token lever. Two of those
rows are worth reading before the table:

- **Where delegated work runs.** A `task` subagent bills its own model, and omp delegates by
  default, so the model a child runs on is a first-order cost decision. The plan names the
  cheapest model on the live provider that can hold the work (a real price, cheaper output, at
  least a 100k window) and the ratio against the current one — on the gateway this plugin was
  built for, a third of the output price — with the `task.agentModelOverrides` command and a
  pointer to omp's own `/agents` hub, which is where that choice belongs.
- **A model role that pins a thinking effort** (`opencode-go/deepseek-v4.1-flash:max`). On a
  route that requires reasoning to be replayed — DeepSeek's, where the gateway declares
  `requires-reasoning-content-for-tool-calls` — the thinking text is billed as **input** on every
  subsequent tool-call step, so a pinned `max` pays for the same reasoning again and again while
  `auto` hands the decision to omp's own classifier. The plugin prints the command; it will not
  change your model choice for you.

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

**Models.** Every model LithosAI serves is declared in the registration, so all of them are
pickable before anything is fetched:

```
deepseek-ai/DeepSeek-V4.1-Flash   moonshotai/Kimi-K3   moonshotai/Kimi-K3-fast   moonshotai/Kimi-K3-ultra
```

The live catalogue is refreshed from `GET /models` with that key (login-stored or environment)
whenever it answers, and any id the bundle does not know is registered from the response. The
bundle matters because omp runs discovery *after* the provider loads and keeps the previous
catalogue when the fetch fails: without it, an install whose endpoint is unreachable — a
resolver that filters the host, a machine offline, a key that has not been pasted yet — would
offer a single model and look like the service had one. `/mega lithos` reports what the endpoint
served last (`4 model(s) at 06:20:11 UTC, all in the bundled catalogue`) and says so plainly
when it could not be reached, naming the list the picker fell back to. Their `/models` response
carries ids and owners only, so each entry is declared with the specs LithosAI publishes: a
**1M-token context window** on all four models (DeepSeek V4.1 Flash 1,000,000 × 384,000 output;
the Kimi K3 family 1,048,576 × 131,072), taken from the same models in omp's own catalog, and
**names with no provider suffix**, because the picker is already inside LithosAI's list. An id
the bundle does not know gets the conservative 262,144 × 32,768 floor instead of an invented
one; put your own figures in `models.yml` if your console shows something else.

**Metrics.** Three numbers, in `/mega lithos` and on omp's own `/usage` surface:

- **tokens/second** — measured, not quoted: the plugin times each stream
  (`after_provider_response` → `message_end`) and divides by the output tokens that stream
  reported. p50 and max over the session.
- **per-minute budgets** — `x-ratelimit-*` headers from every admitted request, for the request
  and token buckets, reported in `/mega lithos` and `/usage`. These are balances that refill
  continuously, not windows that reset, so they are reported as balances and never as "percent
  spent".
- **cost** — prepaid credit debited per token at three rates, which the plugin ships from
  [LithosAI's public price list](https://www.lithosai.com/pricing): Kimi K3 $2.40/Mtok in,
  $0.24 cached, $12 out; Fast $4 / $0.40 / $20; Ultra $5.60 / $0.56 / $28; DeepSeek V4.1 Flash
  $0.15 / $0.003 / $0.60. A session therefore shows what it cost the moment it starts — the
  row's `used $`, and the per-bucket table in `/mega balance`. `lithos.*PerMillion` overrides
  the published card per rate (a console figure, a volume deal, a self-hosted engine); every
  figure is priced from wherever it came from, and `/mega lithos` says which
  (`published card, https://www.lithosai.com/pricing (retrieved 2026-09-20)`). An id nobody has
  priced reads `unknown`, never `$0.00` — a zero bill and an unpriced model are different facts.

The row is the same row DeepSeek draws — hit rate, cached tokens, USD saved, USD used, in that
order — with `LITHOS` where `DS` sits. The provider-specific parts are exactly the ones the API
does not supply: no balance figure and no tariff period, because LithosAI publishes neither.

A refusal is visible rather than inferred: `/mega lithos` shows `HTTP 429` and the
`retry-after-ms` advice LithosAI asks you to prefer, while the row stays the metric row it is
on DeepSeek. Point
`lithos.baseUrl` at a self-hosted Lithos Engine to get the same provider, login and metrics
on-prem. The provider's usage reports reach omp's own surfaces too (`/usage`), because the
plugin registers a `usage` provider whose `parseRateLimitHeaders` normalizes the same headers.

## Balance

The account behind the active model, and what the session spent on it. It speaks for every
model the cache accounting can measure — the same gate — and each one gets a tag naming the
account: `DS`, `LITHOS`, `GO` (OpenCode Go), `ZEN` (OpenCode Zen), `GEMINI` (all three Google
routes), `CLAUDE` (Anthropic), `OAI` (OpenAI), `OR` (OpenRouter), and the first four characters
of the provider id uppercased for anything else. On any other model there is no row segment, no
balance request and no timer, and the section says so instead of inventing an account.

Two buckets are kept separate so a subagent's spend is never double counted — `main` (assistant
turns plus model-generated branch summaries and compactions) and `agents` (subagent sessions,
read from `details.usage` on `task` results) — and every model gets the same table, the same
hit rate and the same `used $` figure on the row. A model registered with no rates at all reads
`used n/a (rates unset)` rather than `$0.00`, because a free session and an unpriced one are
different facts.

What differs is only where a balance can come from:

- **DeepSeek** publishes one: `GET /user/balance` is polled on a managed timer, cached for
  `balance.ttlSeconds` (60 by default), released on shutdown, and retried 15 seconds after a
  failure. The amount rides the row after the `DS` tag as `DS ¥11.48`, tagged because the
  currency is not the session's USD. Turning `balance.enabled` off stops the network call and
  keeps every local figure — the tag included, so the row still names the account in use.
- **LithosAI** publishes none. Its reference documents `/models`, `/models/{author}/{slug}` and
  `/chat/completions` — there is no balance or usage endpoint to poll, so nothing is polled and
  no URL is guessed. Its row is therefore the tag and the cost — `LITHOS · used $0.06` — with no
  figure invented in place of the one the API lacks. The section says that, names the console
  where the prepaid figure and its top-ups live
  (`https://console.lithosai.cloud/billing`), and reports the state the wire *does* carry: HTTP
  402 `insufficient_quota` on the last response means the balance is exhausted, an admitted
  response means it is not zero, and any other refusal is reported as saying nothing about the
  balance.
- **Every other cache-capable provider** — Google Gemini, OpenCode Go and Zen, Anthropic,
  OpenAI, OpenRouter, and any provider whose model declares a cache-read rate — publishes
  nothing this plugin polls either. Its row is the tag and the spend (`GEMINI · used $0.31`),
  and its section names the provider, says that DeepSeek's `/user/balance` is the only account
  endpoint this plugin reads, and reports this session's own cost — which is the point: a
  Gemini or OpenCode Go session otherwise has no cost figure anywhere.

```text
### LithosAI account

- Credit: not exposed by an API — LithosAI's reference documents `/models`,
  `/models/{author}/{slug}` and `/chat/completions` and no balance endpoint, so the prepaid
  figure is read in the console: https://console.lithosai.cloud/billing.
- Last response (06:43:07 UTC) was admitted (HTTP 200), so the balance is not zero.
- Rates: $2.4/Mtok in, $0.24/Mtok cached, $12/Mtok out (published) — the cost below is
  computed at them.

#### This session

| bucket | cost (USD) | input | output | cache read | calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| main | 0.8400 | 100,000 | 10,000 | 20,000 | 1 |
| agents | 0.1600 | 20,000 | 1,000 | 0 | 1 |
| total | 1.0000 | 120,000 | 11,000 | 20,000 | 2 |

Prefix cache hit rate: **17%** (1/1 requests).
```

## Audit

`/mega audit` answers the one question the per-feature sections do not: where this session's
input tokens actually go, and which of omp's own knobs is set wrong for this model. It reads
the live session (`pi.getAllTools()`, `ctx.getContextUsage()` — exact and free) and omp's
settings files, parsed with a deliberately small dotted-key reader, so its view is exactly what
`config.yml` says and nothing else; a key the reader cannot see falls back to the documented
default, and the audit prints the value it read next to the one it recommends. After the
request envelope, the largest system-prompt blocks and the largest tool schemas, it prints a
recommendation list. `/mega tune` reads the *live* settings instead — the same values omp is
acting on, including a runtime override — and is the one place those recommendations can be
applied. Two of the audit's rows are about the cache:

- **`provider.appendOnlyContext`** — appears when the live model is cache capable, the setting
  is not already `on` (it reads `auto` until something stores a value), and omp's auto rule does
  not cover the provider: a Gemini, OpenCode Go or Zen, Anthropic, OpenAI or OpenRouter session.
  It recommends `on` and prints `omp config set provider.appendOnlyContext on` — the same lever
  the row's `⚠ append-only off` part and `/mega cache stability` report. See
  [Prefix stability](#prefix-stability).
- **`gemini implicit cache`** — appears on a Google model whose live context is above zero and
  under 1024 tokens. It recommends no change and prints no command, because there is none:
  Gemini's implicit cache only applies above a model-specific minimum, so a short envelope is
  billed fully uncached whatever the client does. It is the same floor the cache accounting
  labels `prefix_too_small` on its own side.

Neither row exists without a live model, and both are absent once the lever is already where it
should be — an audit with nothing outstanding says so rather than inventing work.

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
| Cache accounting | `cache.enabled`, `cache.minPrefixTokens`, `cache.appendOnly`, `cache.subagents`, `cache.idleTtlMinutes`, `cache.retentionDays` |
| LithosAI | `lithos.enabled`, `lithos.baseUrl`, `lithos.inputPerMillion`, `lithos.outputPerMillion`, `lithos.cachedPerMillion` |
| Balance | `balance.enabled`, `balance.ttlSeconds` |
| Usage windows | `window.enabled`, `window.warnAt` |

Two of the `cache.*` keys are about the prefix rather than the arithmetic, and neither changes
what is measured: `cache.minPrefixTokens` (1024) is the floor under which a miss is labelled
`prefix_too_small` instead of being chased, and `cache.appendOnly` (true) is whether the
append-only advice is offered — the yellow row part, and the recommendation line in the
stability block. Turn it off and the stability block still says whether omp is holding the
prefix still; it just stops telling you to change it.

`statusSegments` is the row's whole layout: a comma-separated list drawn from `cache`,
`window`, `balance`, `token` (`"cache,window,balance,token"` by default). Order is display
order, unknown names are ignored, a group whose feature has nothing to report (a provider that
publishes no windows, a model the accounting cannot meter) contributes nothing, and a segment
that does not fit `statusMaxChars` is dropped whole — a row clipped mid-number reads as a
different number than the one it came from.

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

The menu edits all of it in the TUI: `/mega` opens it, **Settings** groups the keys by feature and
edits one at a time, and the write goes through `omp plugin config` so omp's own files stay
authoritative. The menu also switches the preset, prints the values with their sources, resets
stored settings and opens every report, so none of the subcommands has to be remembered. In
print, RPC and ACP modes the same content is printed as text with the exact shell commands.

### Deliberately not implemented

- **History rewriting.** Never. See [the one rule](#the-one-rule) — it is the reason all of
  this is measured rather than assumed.
- **A second implementation of omp's own reductions** (artifact spill, `pruneToolOutputs`,
  `supersedeReads`, `dropUseless`, `shake`, structural `read` summaries). They are already
  cache-aware; when omp has elided a result, this plugin compresses what is left and skips its
  own budget.
- **Compressing errors.** Lossless passes only — never elided, deduped or stashed.
- **A guessed LithosAI balance endpoint.** There is none to poll — the published surface is
  `/models`, `/models/{author}/{slug}` and `/chat/completions` — so the section reports the
  credit state the wire shows and names the console rather than calling a URL that does not
  exist. Budgets come from the headers on real traffic; usage comes from each response.
- **Writing omp's own settings unasked.** The plugin writes them in exactly one place,
  `/mega tune`, and only after you run it: as runtime overrides by default, with a receipt that
  `/mega tune revert` replays, and never over a value you configured yourself. Everything else —
  the audit rows, the stability block, the row part — prints the command and leaves the choice
  to you. Its own keys are written through `omp plugin config`.

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
`stateDir`) kept their names. `/mega config` prints the effective values and the `/mega` menu
edits them.

Leftovers from the old installs are safe to delete: the shard directory
`~/.omp/agent/omp-deepseek-mega-cache-stats.d/` (the merged plugin uses
`omp-token-mega-stats.d/`), and any `omp-deepseek-mega-cache-fix-receipt.json` in the agent
directory (the merged plugin writes `omp-token-mega-fix-receipt.json`).

## Upgrading from 1.x

One breaking change: the tool the model calls is now **`account_balance`**, not
`deepseek_balance` — the same section, the same label (*Account balance*), under a name that
matches what it reports, since it speaks for every model whose provider reports cached input
tokens and not only for DeepSeek. Anything that named the old tool in a prompt, a permission
list or a hook has to be updated; `/mega`, `/mega balance` and the settings are unchanged.

Everything else is additive or wider, and nothing is measured differently. The two new
`cache.*` settings default to `1024` and `true`: the append-only advice is offered, and a miss
on a prefix under 1024 billed tokens is labelled `prefix_too_small` instead of reading as an
unexplained miss. The cache accounting and the account section now speak for every
cache-capable model rather than a fixed pair of providers, so a Gemini, Anthropic, OpenAI,
OpenRouter or OpenCode session that 1.x left alone now draws a row segment, a cache section and
a cost table — the same figures, computed the same way, on a session that previously had none.

## Upgrading from 2.x

Two features arrive, and one default changes:

- **`/mega tune`** — the first thing this plugin writes into omp itself, and only when asked:
  session overrides (runtime, `config.yml` untouched) for the knobs that decide what a session
  costs and whether it finishes, with `/mega tune revert` to undo them and `force` to re-offer
  a knob you configured yourself.
- **Usage windows** — a new `window` row group and `### Usage windows` section for providers
  that meter the account (OpenCode Go's 5-hour, weekly and monthly limits), with the burn rate
  and where it projects exhaustion. The polling rides the balance timer, so an OpenCode Go
  session now makes one request per `balance.ttlSeconds` where it previously made none;
  `window.enabled=false` stops it.
- **`statusSegments` now defaults to `"cache,window,balance,token"`.** A stored list keeps
  whatever it says — add `window` to it to see the new group, or leave it out. The group
  contributes nothing on a provider that publishes no windows, so a Gemini or Anthropic row is
  unchanged either way.
- **`balance` now reads as the account group**, reporting windows where they exist and the
  balance where one does; `/mega balance` and the `account_balance` tool return both.

## Credits

Prior art, licence positions and what was (and was not) taken from each upstream are recorded
in [CREDITS.md](./CREDITS.md), including the LithosAI sources for the provider registration.

## License

MIT — see [LICENSE](./LICENSE).
