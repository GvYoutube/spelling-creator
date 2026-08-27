// Any server that speaks the OpenAI chat-completions API — which is to say, the
// self-hosted option.
//
// Ollama, llama.cpp's server, vLLM, LM Studio, LiteLLM, text-generation-webui and
// a dozen hosted gateways all expose this shape, so one provider covers all of
// them. It is the AI story for an instance that has neither a hosted API key nor
// Cloudflare's Workers AI binding, and it is the only provider here where the
// model can run on the same machine as the app.
//
// Configured entirely by environment, because the whole point is that we don't
// know what it is:
//
//   OPENAI_COMPATIBLE_URL      required; the base URL, e.g. http://ollama:11434/v1
//   OPENAI_COMPATIBLE_MODELS   required; comma-separated, tried in order
//   OPENAI_COMPATIBLE_API_KEY  optional; most local runtimes want no auth
//   OPENAI_COMPATIBLE_JSON     optional; 'schema' for servers that enforce one
//
// The default for structured output is the weaker `json_object` mode, with the
// shape described in the prompt — the same thing the Groq provider does, for the
// same reason. Whether a server honours `json_schema` depends on which runtime it
// is and which version, and a wrong guess here fails every question suggestion
// with a 400. An operator who knows their server enforces schemas gets the
// stricter behaviour by setting OPENAI_COMPATIBLE_JSON=schema.

import { chatCompletion, firstModelThatAnswers, modelList } from './chatCompletions.js';

export const id = 'openai-compatible';

/** The chat-completions endpoint, tolerating a base URL given with or without /v1. */
export function endpointFor(baseUrl) {
	const base = String(baseUrl || '').replace(/\/+$/, '');
	if (base.endsWith('/chat/completions')) return base;
	// `/v1` is part of the OpenAI path, and operators supply it about half the
	// time — accept both rather than making the difference a 404 to debug.
	return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

export function isConfigured(env) {
	// No API-key check: a local runtime normally has no auth at all, so the URL
	// is what says whether this provider is available.
	//
	// The model list is read the same way generate() reads it, rather than merely
	// tested for being non-empty: a value of ` , ` is a setting somebody meant to
	// fill in and didn't, and reporting the provider as configured on the strength
	// of it turns "no AI configured" into every suggestion failing with "No models
	// configured".
	return Boolean(env.OPENAI_COMPATIBLE_URL && modelList(env.OPENAI_COMPATIBLE_MODELS, []).length > 0);
}

export async function generate({ prompt, schema, env }) {
	const models = modelList(env.OPENAI_COMPATIBLE_MODELS, []);
	return await firstModelThatAnswers(models, (model) =>
		chatCompletion({
			endpoint: endpointFor(env.OPENAI_COMPATIBLE_URL),
			apiKey: env.OPENAI_COMPATIBLE_API_KEY,
			model,
			prompt,
			schema,
			jsonMode: env.OPENAI_COMPATIBLE_JSON === 'schema' ? 'schema' : 'object',
			label: 'OpenAI-compatible',
		}),
	);
}
