import { chatCompletion, firstModelThatAnswers, modelList } from './chatCompletions.js';

// gpt-oss-20b is Groq's current recommended fast/cheap default (llama-3.1-8b
// and llama-3.3-70b were deprecated 2026-06-17) — re-check
// https://console.groq.com/docs/models if this ever starts erroring.
const DEFAULT_MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'];

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

export const id = 'groq';

export function isConfigured(env) {
	return Boolean(env.GROQ_API_KEY);
}

export async function generate({ prompt, schema, env }) {
	return await firstModelThatAnswers(modelList(env.GROQ_MODELS, DEFAULT_MODELS), (model) =>
		chatCompletion({
			endpoint: ENDPOINT,
			apiKey: env.GROQ_API_KEY,
			model,
			prompt,
			schema,
			// Groq's structured `json_schema` support is inconsistent across its
			// hosted models, so rather than trust strict enforcement we use plain
			// json_object mode and describe the exact shape in the prompt.
			jsonMode: 'object',
			label: 'Groq',
		}),
	);
}
