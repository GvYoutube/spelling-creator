// Provider-agnostic AI text generation with fallback. Each provider in
// PROVIDERS is tried in order, skipping any without an API key configured;
// within a provider, its own model list is tried in order (see
// providers/*.js). Add a new provider by writing providers/<id>.js (id,
// isConfigured(env), generate({ prompt, schema, env }) -> { text }) and
// registering it below — no other call site needs to change.

import * as gemini from './providers/gemini.js';
import * as openai from './providers/openai.js';
import * as anthropic from './providers/anthropic.js';
import * as groq from './providers/groq.js';
import * as openaiCompatible from './providers/openai-compatible.js';
import * as workersAi from './providers/workers-ai.js';

const PROVIDERS = {
	[gemini.id]: gemini,
	[openai.id]: openai,
	[anthropic.id]: anthropic,
	[groq.id]: groq,
	[openaiCompatible.id]: openaiCompatible,
	[workersAi.id]: workersAi,
};
// The two that need no hosted API key go last, so they act as fallbacks rather
// than competing for priority with the higher-quality hosted models:
// openai-compatible is configured by a URL (a local Ollama or vLLM), and
// workers-ai is always "configured" once the AI binding exists.
//
// A self-hosted instance that would rather use its local model first — for
// privacy, or because it has no hosted keys worth spending — reorders this with
// AI_PROVIDER_ORDER rather than being told what it wants.
const DEFAULT_ORDER = ['gemini', 'openai', 'anthropic', 'groq', 'openai-compatible', 'workers-ai'];

function resolveOrder(env) {
	const raw = env.AI_PROVIDER_ORDER;
	const ids = raw
		? raw
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		: DEFAULT_ORDER;
	return [...new Set(ids)].filter((id) => PROVIDERS[id]);
}

// { prompt, schema?, env } -> { text }. `schema` is a plain JSON Schema
// object (see schemas.js); `text` is plain prose when schema is omitted, or a
// JSON string matching schema when it's given.
export async function generateWithFallback({ prompt, schema, env }) {
	let lastErr;
	for (const id of resolveOrder(env)) {
		const provider = PROVIDERS[id];
		if (!provider.isConfigured(env)) continue;
		try {
			return await provider.generate({ prompt, schema, env });
		} catch (err) {
			lastErr = err;
		}
	}
	throw (
		lastErr ??
		new Error(
			'No AI provider is configured (set at least one of GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY, or OPENAI_COMPATIBLE_URL + OPENAI_COMPATIBLE_MODELS)',
		)
	);
}

export { QUESTION_SCHEMAS, QUESTION_LABELS, QUESTION_INSTRUCTIONS, LESSON_IDEA_SCHEMA } from './schemas.js';
