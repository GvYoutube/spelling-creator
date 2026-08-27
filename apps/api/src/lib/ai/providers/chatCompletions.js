// The OpenAI chat-completions call, shared by every provider that speaks it.
//
// Three do: OpenAI itself, Groq, and whatever an operator points
// `openai-compatible` at (Ollama, llama.cpp, vLLM, LM Studio, LiteLLM, an
// OpenRouter account). They differ in three things — the endpoint, the
// credential, and how much structured-output support the server actually has —
// and in nothing else, so those are the arguments and this is the code.
//
// Structured output is the only part with real judgement in it. Two modes:
//
//   'schema'  response_format: json_schema, with the schema sent for the server
//             to enforce. Correct where it is supported; a 400 where it is not.
//   'object'  response_format: json_object, with the shape described in the
//             prompt instead. Weaker — the server guarantees valid JSON but not
//             the right JSON — and understood essentially everywhere.
//
// Which to use is the caller's call because it depends on the server, not on the
// request: OpenAI enforces schemas properly, Groq's support varies by model, and
// a local runtime depends on which one and which version.

import { schemaToExampleShape, toOpenAiStrictSchema } from '../jsonSchema.js';

// Long enough for a slow model on a small local GPU, short enough that a failing
// provider doesn't hold a request open while the fallback chain waits its turn.
const TIMEOUT_MS = 20_000;

/**
 * Parse a comma-separated model list from configuration, falling back to a
 * built-in default. Every provider offers the same override, so it lives here.
 *
 * @param {string | undefined} raw
 * @param {string[]} defaults
 * @returns {string[]}
 */
export function modelList(raw, defaults) {
	if (!raw) return defaults;
	const ids = raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return ids.length > 0 ? ids : defaults;
}

/**
 * One chat completion.
 *
 * @param {object} request
 * @param {string} request.endpoint   Full URL of the chat-completions endpoint.
 * @param {string} [request.apiKey]   Sent as a bearer token; omitted when absent, which is how a local runtime with no auth works.
 * @param {string} request.model
 * @param {string} request.prompt
 * @param {object} [request.schema]   A plain JSON Schema; omit for prose.
 * @param {'schema' | 'object'} [request.jsonMode] How to ask for structure. Defaults to 'schema'.
 * @param {string} request.label      Provider name, for error messages.
 * @param {typeof fetch} [request.fetch] Injectable for tests.
 * @returns {Promise<{ text: string }>}
 */
export async function chatCompletion({ endpoint, apiKey, model, prompt, schema, jsonMode = 'schema', label, fetch: doFetch = fetch }) {
	const body = { model };
	let content = prompt;

	if (schema && jsonMode === 'schema') {
		body.response_format = {
			type: 'json_schema',
			json_schema: { name: 'response', strict: true, schema: toOpenAiStrictSchema(schema) },
		};
	} else if (schema) {
		// No enforcement available, so the shape goes in the prompt and
		// json_object at least guarantees the reply parses.
		const shape = JSON.stringify(schemaToExampleShape(schema));
		content = `${prompt}\n\nRespond with ONLY a single JSON object (no markdown fencing, no commentary) matching exactly this shape: ${shape}`;
		body.response_format = { type: 'json_object' };
	}

	body.messages = [{ role: 'user', content }];

	const headers = { 'Content-Type': 'application/json' };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const res = await doFetch(endpoint, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!res.ok) {
		const error = new Error(`${label} ${model} error ${res.status}`);
		error.status = res.status;
		throw error;
	}

	const data = await res.json();
	const text = data?.choices?.[0]?.message?.content;
	if (!text) throw new Error(`${label} ${model} returned no text`);
	return { text };
}

/**
 * Try each model in turn, returning the first that answers and re-throwing the
 * last failure if none does. Every provider wants this and none wants it
 * differently.
 *
 * @param {string[]} models
 * @param {(model: string) => Promise<{ text: string }>} call
 */
export async function firstModelThatAnswers(models, call) {
	let lastErr;
	for (const model of models) {
		try {
			return await call(model);
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr ?? new Error('No models configured');
}
