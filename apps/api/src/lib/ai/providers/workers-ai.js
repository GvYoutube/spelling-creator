// Cloudflare Workers AI, called through the native `AI` binding (wrangler.jsonc)
// rather than fetch — it's a platform binding, not an external HTTP call, so
// there's no API key to configure and no AbortSignal timeout to add (it's
// bound by the Worker's own execution limits like any other binding call).
// llama-3.2-3b-instruct first (fast/cheap), gpt-oss-20b as the stronger
// fallback — both support JSON Mode. Re-check
// https://developers.cloudflare.com/workers-ai/models/ if this ever starts
// erroring, as the model catalog changes.
const DEFAULT_MODELS = ['@cf/meta/llama-3.2-3b-instruct', '@cf/openai/gpt-oss-20b'];

export const id = 'workers-ai';

export function isConfigured(env) {
	return Boolean(env.AI);
}

function modelList(env) {
	const raw = env.WORKERS_AI_MODELS;
	return raw
		? raw
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		: DEFAULT_MODELS;
}

async function callModel(model, { prompt, schema, env }) {
	const body = { messages: [{ role: 'user', content: prompt }] };
	// Workers AI's JSON Mode takes the schema directly as `json_schema` (no
	// name/strict wrapper like OpenAI's) and returns the already-parsed object
	// under `response`, so it's re-serialized to keep the { text } convention
	// uniform across providers.
	if (schema) body.response_format = { type: 'json_schema', json_schema: schema };

	const result = await env.AI.run(model, body);
	const text = schema ? JSON.stringify(result?.response) : result?.response;
	if (!text) throw new Error(`Workers AI ${model} returned no text`);
	return { text };
}

export async function generate({ prompt, schema, env }) {
	let lastErr;
	for (const model of modelList(env)) {
		try {
			return await callModel(model, { prompt, schema, env });
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr;
}
