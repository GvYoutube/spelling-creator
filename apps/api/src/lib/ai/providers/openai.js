import { chatCompletion, firstModelThatAnswers, modelList } from './chatCompletions.js';

// Models to try, newest/cheapest-capable first. Verified against OpenAI's
// docs as of 2026-07 — re-check https://platform.openai.com/docs/models if
// this ever starts erroring, as the lineup moves fast.
const DEFAULT_MODELS = ['gpt-5.4-mini', 'gpt-5-mini'];

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export const id = 'openai';

export function isConfigured(env) {
	return Boolean(env.OPENAI_API_KEY);
}

export async function generate({ prompt, schema, env }) {
	return await firstModelThatAnswers(modelList(env.OPENAI_MODELS, DEFAULT_MODELS), (model) =>
		chatCompletion({
			endpoint: ENDPOINT,
			apiKey: env.OPENAI_API_KEY,
			model,
			prompt,
			schema,
			// OpenAI enforces a supplied schema properly, so ask it to.
			jsonMode: 'schema',
			label: 'OpenAI',
		}),
	);
}
