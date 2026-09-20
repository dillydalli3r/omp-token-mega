/**
 * Provider-agnostic model accessors.
 *
 * Every feature gates on the model that is live *now* rather than the one captured at
 * startup, because omp has no extension-facing model-change event: a `/model` switch has
 * to be able to stop a poller, hide a segment, or end the cache accounting.
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
