/**
 * Provider-agnostic model accessors.
 *
 * Every feature gates on the model that is live *now* rather than the one captured at
 * startup, because omp has no extension-facing model-change event: a `/model` switch has
 * to be able to stop a poller, hide a segment, or end the cache accounting.
 *
 * Cache accounting is gated on a *capability*, never on a provider list. omp normalizes
 * every provider's usage record into `{ input, output, cacheRead, cacheWrite, totalTokens,
 * cost }`, so a model that reports cached input tokens is measured identically wherever it
 * is served: a provider is accountable because it reports those tokens and declares a
 * cache-read rate, not because someone wrote its name down. The list below is only the
 * fallback for the providers whose catalogue carries no rate — a measurement, not a
 * preference — so on those the hit rate and the cached-token count are still shown where
 * the money is not. A model that reports nothing and declares nothing is left alone: no
 * fingerprint, no shard, no row segment.
 */

/** Live session model. `ctx.models.current()` is read lazily and reflects `/model` switches. */
export function activeModel(ctx) {
	return ctx?.models?.current?.() ?? ctx?.model;
}

/** `provider/id` of the live model, or `undefined` when no model is loaded. */
export function modelKey(model) {
	if (!model) return undefined;
	const provider = typeof model.provider === "string" && model.provider ? model.provider : "?";
	const id = typeof model.id === "string" && model.id ? model.id : "?";
	return `${provider}/${id}`;
}

/**
 * Whether the catalogue prices a cache read. This is what turns a hit into money: without a
 * registered rate there is still a measured hit rate, but a saving would have to be
 * invented, and an invented saving is worse than an admitted unknown.
 */
export function cachePriced(model) {
	return Number(model?.cost?.cacheRead) > 0;
}

/**
 * Providers measured to report cached input tokens while their catalogue registers no
 * cache-read rate for at least some of their models. Every entry is an observation on this
 * machine rather than a claim about a contract: every `deepseek` model declares a rate (so
 * the entry is a belt to that braces), 35 of 40 `opencode-go` models do, 29 of 58 `google`
 * models do and the two Google alias providers route to the same reporting, and all four
 * `lithosai` models do. `anthropic` and `openai` normalize their prompt-cache reads into
 * `cacheRead`, and `openrouter` reports whatever the upstream provider reported.
 */
export const CACHE_PROVIDERS = [
	"deepseek",
	"lithosai",
	"google",
	"google-vertex",
	"google-antigravity",
	"opencode-go",
	"opencode-zen",
	"anthropic",
	"openai",
	"openrouter",
];

/**
 * Whether a model can be accounted for at all. A declared cache-read rate is enough on any
 * provider — `cacheSavings` needs one to price a hit — and a listed provider is enough
 * without one, because the tokens are still reported and the hit rate is then the figure
 * that matters. Neither, and there is nothing to measure.
 */
export function cacheCapable(model) {
	return cachePriced(model) || CACHE_PROVIDERS.includes(model?.provider);
}

/** Whether the live model is one this plugin can account for at all. */
export function isCacheCapable(ctx) {
	return cacheCapable(activeModel(ctx));
}

/** Providers omp itself turns append-only context on for, so this plugin says nothing. */
const AUTO_APPEND_ONLY_PROVIDERS = ["deepseek", "ollama", "ollama-cloud", "lm-studio", "llama.cpp"];

/** Dotted-quad only; a hostname of any other shape is not an address this rule covers. */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Loopback, RFC1918 and mDNS: a model served on this machine or on this network. */
function localHost(hostname) {
	// `new URL` serializes an IPv6 host with its brackets, so the literal has two spellings.
	if (hostname === "localhost" || hostname === "0.0.0.0" || hostname === "::1" || hostname === "[::1]") return true;
	if (hostname.endsWith(".local")) return true;
	const parts = IPV4.exec(hostname);
	if (!parts) return false;
	const octets = parts.slice(1).map(Number);
	if (octets.some((octet) => octet > 255)) return false;
	const [first, second] = octets;
	return first === 127 || first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31);
}

/**
 * Mirrors omp's own auto rule for `provider.appendOnlyContext`: true for `deepseek`, for the
 * local engines, for a model served over loopback/RFC1918/`.local`, and for a route whose
 * compat config sets `supportsStore` (a store-backed route keeps the prompt server-side, so
 * re-serializing it cannot help). Every other provider re-serializes the system prompt and
 * the tool catalogue each turn unless the setting is forced `on`, which a prefix cache can
 * read as a change — so this is the predicate the prefix-stability advice hangs off.
 *
 * Unparseable `baseUrl`, or none at all, is false: the rule is a fallback for a model omp
 * knows, never a guess about one it does not.
 */
export function appendOnlyAutoEnabled(model) {
	if (AUTO_APPEND_ONLY_PROVIDERS.includes(model?.provider)) return true;
	if (model?.compatConfig?.supportsStore === true) return true;
	if (typeof model?.baseUrl !== "string" || !model.baseUrl) return false;
	try {
		return localHost(new URL(model.baseUrl).hostname);
	} catch {
		return false;
	}
}
