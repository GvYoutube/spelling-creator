import { toOpenAiStrictSchema } from '../jsonSchema.js';

// Models to try, newest/cheapest-capable first. Verified against OpenAI's
// docs as of 2026-07 — re-check https://platform.openai.com/docs/models if
// this ever starts erroring, as the lineup moves fast.
const DEFAULT_MODELS = ['gpt-5.4-mini', 'gpt-5-mini'];

export const id = 'openai';

export function isConfigured(env) {
	return Boolean(env.OPENAI_API_KEY);
}

function modelList(env) {
	const raw = env.OPENAI_MODELS;
	return raw
		? raw
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		: DEFAULT_MODELS;
}

async function callModel(model, { prompt, schema, env }) {
	const body = { model, messages: [{ role: 'user', content: prompt }] };
	if (schema) {
		body.response_format = {
			type: 'json_schema',
			json_schema: { name: 'response', strict: true, schema: toOpenAiStrictSchema(schema) },
		};
	}

	const res = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`OpenAI ${model} error ${res.status}`);

	const data = await res.json();
	const text = data?.choices?.[0]?.message?.content;
	if (!text) throw new Error(`OpenAI ${model} returned no text`);
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
