import { schemaToExampleShape } from '../jsonSchema.js';

// gpt-oss-20b is Groq's current recommended fast/cheap default (llama-3.1-8b
// and llama-3.3-70b were deprecated 2026-06-17) — re-check
// https://console.groq.com/docs/models if this ever starts erroring.
const DEFAULT_MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'];

export const id = 'groq';

export function isConfigured(env) {
	return Boolean(env.GROQ_API_KEY);
}

function modelList(env) {
	const raw = env.GROQ_MODELS;
	return raw
		? raw
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		: DEFAULT_MODELS;
}

async function callModel(model, { prompt, schema, env }) {
	const body = { model };
	let finalPrompt = prompt;
	// Groq's structured `json_schema` output support is inconsistent across
	// its hosted models, so rather than trust strict enforcement we use plain
	// json_object mode and describe the exact shape in the prompt.
	if (schema) {
		const shape = JSON.stringify(schemaToExampleShape(schema));
		finalPrompt = `${prompt}\n\nRespond with ONLY a single JSON object (no markdown fencing, no commentary) matching exactly this shape: ${shape}`;
		body.response_format = { type: 'json_object' };
	}
	body.messages = [{ role: 'user', content: finalPrompt }];

	const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GROQ_API_KEY}` },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`Groq ${model} error ${res.status}`);

	const data = await res.json();
	const text = data?.choices?.[0]?.message?.content;
	if (!text) throw new Error(`Groq ${model} returned no text`);
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
