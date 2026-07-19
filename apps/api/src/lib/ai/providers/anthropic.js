// max_tokens is a required Anthropic field with no built-in default; 4096 is
// generous for the short lesson-text/question/idea outputs this app generates.
const MAX_TOKENS = 4096;

// Haiku first (cheap/fast, mirrors Gemini's flash-first default), Sonnet as
// the stronger fallback.
const DEFAULT_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-5'];

export const id = 'anthropic';

export function isConfigured(env) {
	return Boolean(env.ANTHROPIC_API_KEY);
}

function modelList(env) {
	const raw = env.ANTHROPIC_MODELS;
	return raw
		? raw
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		: DEFAULT_MODELS;
}

async function callModel(model, { prompt, schema, env }) {
	const body = {
		model,
		max_tokens: MAX_TOKENS,
		messages: [{ role: 'user', content: prompt }],
	};
	// Anthropic has no native JSON-schema response format, so structured
	// output is forced via a single tool call: the schema becomes the tool's
	// input, and tool_choice forces the model to call it.
	if (schema) {
		body.tools = [{ name: 'respond', description: 'Return the requested structured data.', input_schema: schema }];
		body.tool_choice = { type: 'tool', name: 'respond' };
	}

	const res = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-api-key': env.ANTHROPIC_API_KEY,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`Anthropic ${model} error ${res.status}`);

	const data = await res.json();
	// Anthropic can return HTTP 200 with no usable content on a refusal.
	if (data.stop_reason === 'refusal') throw new Error(`Anthropic ${model} refused the request`);

	if (schema) {
		const block = (data.content ?? []).find((b) => b.type === 'tool_use' && b.name === 'respond');
		if (!block) throw new Error(`Anthropic ${model} did not return a tool_use block`);
		return { text: JSON.stringify(block.input) };
	}
	const text = (data.content ?? [])
		.filter((b) => b.type === 'text')
		.map((b) => b.text)
		.join('');
	if (!text) throw new Error(`Anthropic ${model} returned no text`);
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
