import { toGeminiSchema } from '../jsonSchema.js';

// Models to try, newest first. If a model is unavailable or errors (e.g. not
// yet rolled out to this key), we fall back to the next one in order.
const DEFAULT_MODELS = ['gemini-3.5-flash', 'gemini-3-flash', 'gemini-2.5-flash'];

export const id = 'gemini';

export function isConfigured(env) {
	return Boolean(env.GEMINI_API_KEY);
}

function modelList(env) {
	const raw = env.GEMINI_MODELS;
	return raw
		? raw
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		: DEFAULT_MODELS;
}

async function callModel(model, { prompt, schema, env }) {
	const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
	if (schema) {
		body.generationConfig = {
			responseMimeType: 'application/json',
			responseSchema: toGeminiSchema(schema),
		};
	}

	const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`Gemini ${model} error ${res.status}`);

	const data = await res.json();
	const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
	if (!text) throw new Error(`Gemini ${model} returned no text`);
	return { text };
}

// Run generateContent against the model list in order, returning the first
// success. Throws the last error only if every model fails.
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
