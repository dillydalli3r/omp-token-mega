# Credits and prior art

`omp-token-mega` is the merged plugin: what used to ship as three separate oh-my-pi plugins
(`omp-token-saver`, `omp-deepseek-mega-cache`, `omp-deepseek-balance`) is now one package with
one command, one settings menu and one status row — plus a fourth feature, the LithosAI
provider and metrics — see the last section. The three credit files are reproduced below
unchanged in substance, because the prior art each one records is still the prior art behind
the feature it describes.

## No code was copied

Every line in `src/` was written for this plugin. Nothing was vendored, translated or
transliterated from another repository: the consolidation is conceptual — the technique sets,
the failure modes of the earlier tools, and the measurements that say which techniques are
worth having at all.

## From `omp-token-saver` — the result reducer


### No code was copied

Every line in `src/` was written for this plugin. Nothing was vendored, translated or
transliterated from another repository. The consolidation is conceptual: the technique set,
the failure modes of the earlier tools, and the measurements that say which techniques are
worth having at all.

The licence position of the upstreams read here is worth stating plainly, because it explains
why nothing *could* have been taken in two cases. **None of them is unlicensed, and none is
copyleft.** Two are restriction-licensed — [mksglu/context-mode](https://github.com/mksglu/context-mode)
is ELv2, which is not OSI-approved, and [pi-infected/tokenade-npm](https://github.com/pi-infected/tokenade-npm)
is proprietary freemium ("Other") whose product is a signed prebuilt binary — so reading them
for technique was the whole of their contribution. Two others are Apache-2.0
([claudioemmanuel/squeez](https://github.com/claudioemmanuel/squeez),
[chopratejas/headroom](https://github.com/chopratejas/headroom)), which an MIT plugin could
reuse from; it does not. Where the survey could not state a licence, the repository page was
read and the result recorded here — [toon-format/toon](https://github.com/toon-format/toon)
turned out to be MIT, not unstated.

### Consolidation sources

### MIT — concept and technique reuse

| Repository | What was taken |
| --- | --- |
| [alilfrances/tokenslim](https://github.com/alilfrances/tokenslim) · MIT (repository page) | Deterministic per-command result compressors keyed on tool, command context and file extension — with ANSI/progress stripping, repeated-line and stack-trace collapse, a head+tail cap, and failures left **verbatim**. Also the `[tokenslim: …]` provenance-marker convention, the re-hash on Edit/Write that keeps the *next* read collapsible, and the fixture-benchmark method that reports pipeline reduction **and** end-to-end reduction including thresholds, failure gates and marker overhead. |
| [claudioemmanuel/squeez](https://github.com/claudioemmanuel/squeez) · Apache-2.0 (repository page) | The net-win admission test that charges the compressor's own marker against the saving it advertises (the `# squeez` header costs ~15–25 tokens; `net_win_min_tokens` defaults to 24). The preservation guard: score navigation-anchor survival (paths, `file:line`, error markers, test verdicts) on ≥90%-reduction calls and fall back to the verbatim original below a 0.70 floor, tagging `[anchors: N%]`. Duplicate collapsing by exact hash plus fuzzy trigram-shingle Jaccard ≥0.85, log-template folding of near-identical lines, an identifier factsheet so a summary never silently drops a SHA or ticket, and the content-class estimator that counts dense tool output at ~2 chars/token rather than chars/4. |
| [mcowger/pi-rtk](https://pi.dev/packages/pi-rtk) · MIT (package page) | The `tool_result` filter taxonomy per output class (source / build / test / git / search / linter) and the agent-callable escape hatch, registered for the specific reason that aggressive source filtering breaks text-match edits. |
| [PrivateArena/pi-tokenoptimizer](https://github.com/PrivateArena/pi-tokenoptimizer) · MIT (repository README) | Per-command token profiles with literal/regex `replace` and a `file` action, a per-command blacklist with `maxLines`/`dropOutput`, and the do-not-read file pointer that moves a small-but-noisy command's output to disk and returns a pointer instead of the text. |
| [openai/tiktoken](https://github.com/openai/tiktoken) · MIT (repository page) | The accounting discipline behind every savings claim: count the payload that is actually sent, classify it, and never present a byte reduction as a token reduction. This plugin takes the discipline but not the dependency — `src/measure.js` reuses oh-my-pi's own `(utf8Bytes + 3) >> 2` fallback estimator (`byteEstimate` in `packages/agent/src/tokenizer.ts`) so its numbers stay on the harness's scale, and every token figure it prints is labelled an estimate. |

Two properties in the first two rows are the ones the design leans on hardest: **ingress-only
compression** — every one of these tools reduces a result *before it is sent*, and none of
them rewrites history — and **per-rule determinism**, same input plus same config yields the
same bytes, which is what makes the result cache-safe rather than merely smaller.

The command-family taxonomies above informed what to leave alone rather than what to build.
This plugin's passes are keyed on the *tool*, not on the command, and are text-level
(`squeeze`, `fold`, `clip`, `json`) plus dedup; command dispatch and command rewriting are the
two places the measurement work below found trouble, and oh-my-pi already elides a single
result above 50 KB on its own.

One entry the survey named — a Claude Code re-read/re-run dedup — could not be located to a
readable repository, so it is deliberately absent: nothing here is cited from a page this
ledger did not read.

### Technique only — read, not reused

| Repository | Licence | Position |
| --- | --- | --- |
| [mksglu/context-mode](https://github.com/mksglu/context-mode) | ELv2 — not OSI-approved (repository page) | The queryable externalized index: output past a size threshold is indexed into FTS5 and replaced with a pointer the model *searches* (BM25) rather than re-reads, with code blocks returned exactly rather than summarised. Read as prior art for where offloaded text can go. ELv2 is not compatible with an MIT plugin, and none of it was needed; no code reused. |
| [pi-infected/tokenade-npm](https://github.com/pi-infected/tokenade-npm) | Other — proprietary freemium, signed prebuilt binary (repository page) | Batching independent commands into a single turn to cut turn count, and cache-expiry timing as an explicit signal for when old context may be trimmed. Read as prior art; the binary layer is closed source, so there was nothing to read into the design; no code reused. |
| [chopratejas/headroom](https://github.com/chopratejas/headroom) | Apache-2.0 (repository page) | Compresses conversation history as well as tool output, which is exactly the trade this plugin refuses; THOL prices that arm at a loss (below). Its `CacheAligner` — flag volatile content, never rewrite the prompt — is the part consistent with this plugin's stance. No code reused. |
| [ooples/token-optimizer-mcp](https://github.com/ooples/token-optimizer-mcp) | MIT (repository page) | Prior art for the cache multiplier in its accounting — cached tokens re-read at 0.1×, rewritten ones billed at 1.25× — and for measuring the bill rather than the bytes; its published head-to-head reports its own front-of-prefix arm winning the invoice by 11–42%. Its Read/Grep/Edit interception (denying a call, serving a diff) is a different design with a different risk profile; no code reused. |
| [zilliztech/claude-context](https://github.com/zilliztech/claude-context) | MIT (repository page) | Semantic code search as an MCP server. Read and rejected for this plugin: its tool schemas are permanent per-turn overhead and oh-my-pi already ships LSP, ast-grep and `read.summarize` for the navigation job; no code reused. |
| [toon-format/toon](https://github.com/toon-format/toon) | MIT (repository page; the survey could not state it) | Schema-aware key elision for arrays of uniform objects — declare the field names once per array instead of per row. Not taken: this plugin's `json` pass removes insignificant whitespace only, and oh-my-pi already caps line width (`tools.outputMaxColumns`) and elides oversized results. No code reused. |

### Measurement sources

The cache-safety stance is not an aesthetic preference; it is what the end-to-end work below
prices.

| Source | What it establishes |
| --- | --- |
| [THOL — Token-Harness Optimizer Leaderboard](https://github.com/pi-infected/token-harness-optimizer-leaderboard) · MIT (repository page); live board at [pi-infected.github.io/token-harness-optimizer-leaderboard](https://pi-infected.github.io/token-harness-optimizer-leaderboard/) | End-to-end cost per **solved** task against a no-optimizer control, same model, harness, repo and prompts, with a programmatic verifier and ground truth never present in the workspace — failed runs never count as savings. On the long-session band of the live board (tasks where vanilla Claude Code burns over 200,000 tokens; positive = cheaper) the spread runs from +38.9% down to `headroom` at **−52.8%** — the arm that rewrites conversation history every turn — with the control sat at 0.0%; `rtk` v0.42.3 measures −7.1% there. The board's own explanation of the headroom row is the mechanism this plugin is built around: rewriting the growing history means the cached prefix no longer matches byte-for-byte, so the model re-reads the whole context as fresh input instead of at the cached rate, which is roughly 10× cheaper. Its summary: measured end to end, most of these tools move the cost of a session far less than their documentation suggests, because adoption is hard, lossy compaction makes the agent re-fetch, and standing overhead is re-billed every turn. |
| [JetBrains — caveman skill, part 1: "Does Speaking to Agents Like Cavemen Really Save 65% of Tokens? We Test"](https://blog.jetbrains.com/ai/2026/07/speak-to-ai-agents-like-cavemen-tosave-tokens/) | Paired A/B on SkillsBench, 82 clean pairs, activation forced. Advertised −65% output tokens; measured −8.5%. Agent output is dominated by code, diffs, tool calls and exact error strings — the token classes an output-side brevity skill deliberately preserves — so output compression is not where an agent's bill lives. |
| [JetBrains — rtk, part 2: "Does 'rtk' skill really cut agent tokens by 60–90%? We tested it"](https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/) | Same paired method, 80 clean pairs. The command-rewriting hook measured **+7.6% more expensive** per task at low reasoning effort (p=0.004), on +13.8% turns (p=0.03) and +14.3% cache reads (p=0.008), against an advertised 60–90%; +0.1% (p=0.99) at high effort. The ceiling analysis is the reusable part: the hook could only ever see ~33% of Bash calls and just under 20% of tool-result chars, and it reported 96.2 M tokens saved while the measured bill rose. |
| [JetBrains — ponytail, part 3: "Ponytail Skill for Claude Code: Does It Really Cut Agent Code by 54%?"](https://blog.jetbrains.com/ai/2026/07/ponytail-skill-claude-tested/) | The one arm in the series with a solid cost *saving*: −10.3% per task (p=0.004), earned by writing less code (−15.4% lines). The input side barely moved — fresh tokens −3.9% (p=0.085), history re-reads −8.4% (p=0.138) — which is the split this plugin is built on: what the model writes is cheap to change, and what it *reads* has to be reduced before it is sent. |
| [The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization for Agent Context Management](https://arxiv.org/abs/2508.21433) (arXiv 2508.21433) | Peer-reviewed evidence that masking old observations halves cost relative to the raw agent while matching, and sometimes slightly exceeding, LLM summarization's solve rate. The cache-aware version of that finding is what oh-my-pi already ships; cited here as evidence for the native design, not as a technique to port. |
| [LLMLingua: Compressing Prompts for Accelerated Inference of Large Language Models](https://arxiv.org/abs/2310.05736) (arXiv 2310.05736, Microsoft) | Coarse-to-fine prompt compression reporting up to 20× compression with little performance loss. It rewrites prompt text, so no cached prefix can match byte-for-byte afterwards, and it needs a local model plus added latency. Read as the clearest statement of the technique this plugin refuses. |

Locally, the sibling plugin `omp-deepseek-mega-cache` keeps measuring the prefix this plugin
leaves untouched; its `CREDITS.md` is the family ledger this file follows.

### oh-my-pi's own machinery

The single most important prior art is oh-my-pi itself, which already ships every reduction
this plugin could have duplicated. All of them are cache-aware:

- artifact spill at `tools.artifactSpillThreshold` (default 50 KB) — an oversized result becomes
  head+tail behind an `artifact://` handle, with `tools.artifactHeadBytes`,
  `tools.artifactTailBytes` and `tools.artifactTailLines` setting the split, and
  `tools.outputMaxColumns` capping line width;
- pre-compaction pruning of old tool output (`pruneToolOutputs`);
- superseded-read pruning (`compaction.supersedeReads`) and useless-result elision
  (`compaction.dropUseless`);
- compaction-time transcript reduction (`shake`, `snapcompact`, tool results included);
- structural `read` summaries (`read.summarize.enabled`, on by default) — a declaration
  skeleton with re-read hints instead of verbatim text.

A second implementation would only add a second way to be wrong. This plugin therefore
duplicates none of them: it subscribes to `tool_result` for text oh-my-pi is about to send for
the first time, applies its own passes, and skips its own budget when oh-my-pi has already
elided the result (the `skipped.native` counter). Where it stashes removed text it uses
`ctx.sessionManager.saveArtifact`, the same store and the same `artifact://` URL oh-my-pi's
spill uses, so the model needs no new vocabulary to recover it.

What `/tokens audit` adds is reporting, not replacement. It reads oh-my-pi's own settings
(`CORE_DEFAULTS` in `src/audit.js`), lists each native mechanism above with its current value,
scores the request envelope — tool catalogue, system-prompt sections, never-called tools — and
prints the `omp config set …` command for any knob it would change. It never writes one.

### Deliberately not implemented

**History rewriting.** Not offered in any form. The plugin subscribes to exactly one
payload-bearing event, `tool_result`, and returns only a content replacement; it registers no
`context`, `before_provider_request` or `before_agent_start` handler. This is what makes the
non-interference claim checkable rather than aspirational, and the measurement sources above
are why: every provider's cache is a prefix cache that misses from the first changed token, so
providers' own accounting re-reads cached tokens at a fraction of fresh input, and the arms
that rewrite history or the command that runs measured *more* expensive end to end — headroom
at −52.8% on THOL, rtk at +7.6% at low effort with +14.3% more cache reads. Reducing what is
appended carries no such trade: the reduced text is what the session stores and replays, so the
saving is paid out again on every subsequent request.

**Cache warming.** Not implemented. The plugin registers no request hook — its only
session-boundary handlers load config at `session_start` and reset counters at
`session_switch` and `session_shutdown` — and it has no visibility into when a provider's cache
unit expires, which is the one thing a warming schedule would have to know. It reduces bytes at
ingress and nothing else, so a warming arm would be an addition rather than a completion of
this design; the rtk result above is a warning against paying per-turn overhead for a timing
gamble.

**Mid-session tool-catalogue pruning.** Rejected: the tool catalogue is part of the cached
prefix and oh-my-pi keeps it byte-stable (`provider.appendOnlyContext`, enabled automatically
for DeepSeek, with deterministic tool ordering). Registering, hiding or reordering a tool
mid-session forks the prefix, so the plugin registers no tool of its own and the audit instead
reports the catalogue's per-request cost — active tools, never-called tools and their bytes —
leaving the decision to the session's own configuration.

**Writing core oh-my-pi settings.** Never. The only configuration the plugin writes is its own,
and it writes that through `omp plugin config`, so the file it lands in is the file
`omp plugin config list` reads; advice about oh-my-pi's own knobs ships as text and as a
runnable command in the audit output. The only other thing it writes is the artifact a
stashed elision or duplicate stub is recovered from, through oh-my-pi's own recovery path.

### Licence

MIT — see [`LICENSE`](LICENSE). Copyright (c) 2026 dillydalli3r.

## From `omp-deepseek-mega-cache` — the prefix-cache accounting


`omp-deepseek-mega-cache` consolidates the *findings* of a generation of Pi / oh-my-pi
prefix-cache extensions into one oh-my-pi-native plugin. Provenance is recorded precisely
here, including the licence position of every repository consulted.

### No code was copied

Every line in `src/` was written for this plugin. Nothing was vendored, translated or
transliterated from another repository. The consolidation is therefore conceptual — the
technique set, the miss-cause taxonomy, and the failure modes of the earlier tools — while
the implementation is new and specific to omp 18.2.6's extension API.

That matters because several of the most instructive upstream repositories carry **no
licence at all** (all rights reserved by default), and one is AGPL-3.0. Reading them for
technique was useful; reusing their code would not have been permissible.

### Consolidation sources

### MIT — concept and technique reuse

| Repository | What was taken |
| --- | --- |
| [jiangge/pi-cache-optimizer](https://github.com/jiangge/pi-cache-optimizer) | The config-transaction pattern (timestamped backup → write → hash-bound receipt → rollback) and per-instance shard state. Its `RECEIPT_COMPAT_KEYS` list is also the source of the dead-key names this plugin repairs. It is the repository running on the machine that motivated this work. |
| [blingdivinity/omp-cache-warmer](https://github.com/blingdivinity/omp-cache-warmer) | Managed-timer discipline for long-lived extension work, and the miss-classification idea of separating a legitimate cold re-prime from a genuine prefix divergence. Its own author banner ("unrecommended for use" pending omp transcript pinning) is why warming is **not** implemented here. |
| [poip2/pi-reasonix](https://github.com/poip2/pi-reasonix) | Hashing the prefix over the system prompt plus tool definitions only, excluding history, so ordinary conversation growth is never misreported as instability. |
| [WuP1ao0/pi-for-k3](https://github.com/WuP1ao0/pi-for-k3) | The closed miss-cause enum (`first_turn`, `prefix_drift`, `model_switch`, `idle_ttl`, `compaction`, `branch_nav`, `tool_change`, `external_miss`) with `external_miss` as the honest fallback, and deterministic tool ordering because a set-equivalent but reordered catalogue still invalidates the prefix. |
| [pisceslailai/deepseek-kvcache](https://github.com/pisceslailai/deepseek-kvcache) | The compaction-prefix-replay idea — make the summarisation request reuse the main conversation prefix so compaction is not a full cache reset. See "Deliberately not implemented" below. |
| [thetrebor/pi-reasonix](https://github.com/thetrebor/pi-reasonix) | The framing of cache health as a measurable regression rather than a vibe. |
| [icefairy/pi-cache-guardian](https://github.com/icefairy/pi-cache-guardian) | Skill-index compression and session-overview churn removal as prefix-shrinking techniques; both are already handled inside omp for DeepSeek, so neither is reimplemented. |
| [pibi/oh-my-pi-plugin-cache-miss](https://github.com/pibi/oh-my-pi-plugin-cache-miss) | oh-my-pi plugin scaffolding, and the exact `usage`/`cost` field names relied on by the accounting code. |
| [rblaine95/omp-plugins](https://github.com/rblaine95/omp-plugins) | oh-my-pi packaging conventions (`omp.extensions` manifest, `.omp-plugin/marketplace.json`). |
| [tonoyondaweb/pi-cache-harness](https://github.com/tonoyondaweb/pi-cache-harness) | The "declared capability is a hypothesis until telemetry confirms it" stance, which is why this plugin measures instead of asserting. |

### No licence — read for technique only, no reuse

These repositories carry no licence, so nothing was taken from them beyond the general
understanding that their problem is real:

- [renezander030/pi-cache-optimizer](https://github.com/renezander030/pi-cache-optimizer) — repo-hop detection, cache-bust guards. Its habit of writing a `.claudecodeignore` into the user's working tree was deliberately not imitated.
- [DarceyLloyd/pi-aftc-cache-optimizer](https://github.com/DarceyLloyd/pi-aftc-cache-optimizer) — dual per-turn and session-average hit rates.
- [micc99/deepseek-balance-monitor](https://github.com/micc99/deepseek-balance-monitor)
- [seenark/omp-plugins](https://github.com/seenark/omp-plugins)

### AGPL-3.0 — not used

- [flakusha/omp-plugins](https://github.com/flakusha/omp-plugins) — licence-incompatible with an MIT plugin; nothing was read into the design.

### oh-my-pi's own built-in protection

The single most important prior art is oh-my-pi itself. `provider.appendOnlyContext` is
enabled automatically when `model.provider === "deepseek"`
(`src/config/append-only-context-mode.ts`, `shouldAutoEnableAppendOnlyContext`), which
keeps the system prompt, tool catalogue and message log byte-stable across turns; omp also
moved the date and working directory out of the system prompt into a per-request
`<system-reminder>` for exactly this reason.

Because that machinery already exists, this plugin does **not** freeze, reorder or rewrite
the prompt. It observes. A second implementation of the same idea would only add a way to
break the prefix.

### Deliberately not implemented

**Compaction prefix replay.** The technique is sound and the DeepSeek-specific win is real,
but omp exposes extensions no header hook (`before_provider_headers` does not exist here),
and rewriting a compaction request's payload from a heuristic risks producing a wrong
summary — a correctness failure traded for a cost saving. Rejected on those grounds.

## From `omp-deepseek-balance` — the account balance and session spend


This plugin is an independent oh-my-pi implementation. Its design derives from
earlier DeepSeek balance extensions for the Pi / oh-my-pi lineage, and the
provenance is recorded here:

### oscar-wang-xin/pi-deepseek-balance — MIT

<https://github.com/oscar-wang-xin/pi-deepseek-balance>

The direct ancestor. Reused from it (algorithm, re-implemented here in
omp-native ESM JavaScript):

- the `/user/balance` endpoint derivation that strips a trailing `/v<N>` from the
  provider base URL (`balanceEndpoint`);
- reading balance amounts as strings and formatting them with a currency symbol;
- attributing session usage from session entries, including the `toolResult`,
  `branch_summary` and `compaction` entries;
- the status-row approach (`ctx.ui.setStatus`) and the balance-success /
  failure-retry polling cadence.

Deliberate divergences: it gates on the *existence of DeepSeek credentials*
whereas this plugin gates on the *active model's provider*, it imports Pi-only
symbols (`@earendil-works/pi-coding-agent`, `@sinclair/typebox`), and it does not
separate subagent spend from main-session spend. All three are changed here.

### blingdivinity/omp-cache-warmer — MIT

<https://github.com/blingdivinity/omp-cache-warmer>

Source of the TTL-cadence and managed-timer discipline used for the polling
loop (long-lived extension timers must not be able to crash the session).

### rblaine95/omp-plugins, pibi/oh-my-pi-plugin-cache-miss — MIT

<https://github.com/rblaine95/omp-plugins>
<https://github.com/pibi/oh-my-pi-plugin-cache-miss>

Prior art for oh-my-pi plugin packaging (`package.json` `omp.extensions`, the
`.omp-plugin/marketplace.json` catalog, a `.omp/agent`-relative extension
layout) and for the exact `usage`/`cost` field names on session messages.

### pibi/oh-my-pi-plugin-cache-miss

No code was taken. Listed because it confirms the `usage.cost.total` accounting
shape this plugin relies on.

### Not used

`flakusha/omp-plugins` is AGPL-3.0 and no rendering surface was needed from it,
so nothing from it is present. `micc99/deepseek-balance-monitor` and
`seenark/omp-plugins` carry no license, so no code was copied; only the general
ideas of tolerant parsing of string amounts and 401/403-vs-5xx handling were
re-derived independently.

## LithosAI — provider registration, login and metrics

New in the merge, and written against LithosAI's published material rather than any
implementation: no LithosAI code exists to reuse, and none was taken.

| Source | What it supplied |
| --- | --- |
| [docs.lithosai.com](https://docs.lithosai.com) (`/index`, `/authentication`, `/rate-limits`, `/billing`, `/coding-agents/omp`) | The base URL (`https://api.lithosai.cloud/v1`), the bearer-key scheme and console key page, the `LITHOSAI_API_KEY` convention, the `x-ratelimit-*` / `retry-after-ms` / `x-should-retry` header set, the "balance, not a countdown" reading of the per-minute buckets, the prepaid-credit model with HTTP 402 `insufficient_quota` (which is what the account section reads as "exhausted"), and the billing console URL it links. |
| [www.lithosai.com/pricing](https://www.lithosai.com/pricing) (retrieved 2026-09-20) | The early-access rate card the plugin ships: Kimi K3 $2.40/$0.24/$12 per Mtok, K3 Fast $4/$0.40/$20, K3 Ultra $5.60/$0.56/$28, DeepSeek V4.1 Flash $0.15/$0.003/$0.60, and the **1M-token context window** every one of the four is sold with. This is what prices a session out of the box, and what the row's `used $` and the sections' ledgers are computed at; `lithos.*PerMillion` still overrides it per rate. |
| [artificialanalysis.ai/providers/lithos-ai](https://artificialanalysis.ai/providers/lithos-ai) | The provider's model set as an outside party counts it — exactly the four models the bundle declares, one per tier — plus a cross-check on the tokens/second the plugin measures itself (DeepSeek V4.1 Flash ~374 t/s, Kimi K3 ~233, Fast ~215, Ultra ~230). No figure from it is shipped as a number; the speed metric is still measured per session. |
| [docs.lithosai.com/openapi.yaml](https://docs.lithosai.com/openapi.yaml) | The endpoint list (`/models`, `/models/{author}/{slug}`, `/chat/completions`), which is why the plugin discovers models from `/models`, reports budgets from response headers, and polls nothing for a LithosAI balance: there is no billing or usage endpoint to poll. |
| oh-my-pi's own catalog (`omp models find deepseek-flash`, `omp models find kimi` — the DeepSeek provider and the `opencode-go` provider) | The declared limits for the same models: DeepSeek V4.1 Flash `1000000` context with a `384000` output ceiling, Kimi K3 `1048576` with `131072`. Driven through omp's own registry rather than transcribed from a guide, so a catalog update is one `omp models find` away from being the bundle's figure. |

The registration itself is oh-my-pi's own extension surface (`pi.registerProvider` with
`models`, `oauth.login`, `fetchDynamicModels` and a `usage` provider), documented in the
harness's `extensions.md`.
