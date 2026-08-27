// The shared chat-completions call, and the three providers built on it.
//
// These went in when `openai-compatible` was added, because that would otherwise
// have been a third copy of the same forty lines. The providers had no tests
// before, so the shared call is asserted through each of them rather than only
// on its own: what matters is that OpenAI still asks for strict schemas and Groq
// still doesn't, which is a fact about the providers, not about the helper.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { chatCompletion, firstModelThatAnswers, modelList } from './chatCompletions.js';
import * as openai from './openai.js';
import * as groq from './groq.js';
import * as openaiCompatible from './openai-compatible.js';

/** A fetch that records what it was asked and replies with `text`. */
function recordingFetch(text = 'answer', status = 200) {
	const calls = [];
	const doFetch = async (url, init) => {
		calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
		if (status !== 200) return new Response('nope', { status });
		return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	};
	return { fetch: doFetch, calls };
}

const SCHEMA = {
	type: 'object',
	properties: { question: { type: 'string' } },
	required: ['question'],
};

describe('modelList', () => {
	it('falls back to the defaults when unset', () => {
		expect(modelList(undefined, ['a', 'b'])).toEqual(['a', 'b']);
	});

	it('splits and trims a configured list', () => {
		expect(modelList(' x , y ,', ['a'])).toEqual(['x', 'y']);
	});

	it('falls back when the configured list is all blanks', () => {
		// An operator who sets the variable to an empty string means "I did not
		// configure this", not "try no models and fail".
		expect(modelList(' , ', ['a'])).toEqual(['a']);
	});
});

describe('firstModelThatAnswers', () => {
	it('returns the first success', async () => {
		const tried = [];
		const result = await firstModelThatAnswers(['a', 'b'], async (model) => {
			tried.push(model);
			return { text: model };
		});
		expect(result.text).toBe('a');
		expect(tried).toEqual(['a']);
	});

	it('moves on after a failure and re-throws the last one', async () => {
		const result = await firstModelThatAnswers(['a', 'b'], async (model) => {
			if (model === 'a') throw new Error('a is down');
			return { text: model };
		});
		expect(result.text).toBe('b');

		await expect(
			firstModelThatAnswers(['a', 'b'], async (model) => {
				throw new Error(`${model} is down`);
			}),
		).rejects.toThrow('b is down');
	});

	it('throws rather than hanging when no models are configured', async () => {
		await expect(firstModelThatAnswers([], async () => ({ text: 'x' }))).rejects.toThrow(/No models configured/);
	});
});

describe('chatCompletion', () => {
	it('sends a bare prompt with no response_format when no schema is asked for', async () => {
		const server = recordingFetch();
		const result = await chatCompletion({
			endpoint: 'https://api.test/v1/chat/completions',
			apiKey: 'k',
			model: 'm',
			prompt: 'hello',
			label: 'Test',
			fetch: server.fetch,
		});
		expect(result.text).toBe('answer');
		expect(server.calls[0].body.response_format).toBeUndefined();
		expect(server.calls[0].body.messages).toEqual([{ role: 'user', content: 'hello' }]);
	});

	it('sends the schema for the server to enforce in schema mode', async () => {
		const server = recordingFetch();
		await chatCompletion({
			endpoint: 'https://api.test/v1/chat/completions',
			model: 'm',
			prompt: 'hello',
			schema: SCHEMA,
			jsonMode: 'schema',
			label: 'Test',
			fetch: server.fetch,
		});
		const { response_format: format, messages } = server.calls[0].body;
		expect(format.type).toBe('json_schema');
		expect(format.json_schema.strict).toBe(true);
		expect(format.json_schema.schema.properties.question).toBeTruthy();
		// The prompt is left alone — the server is doing the enforcing.
		expect(messages[0].content).toBe('hello');
	});

	it('describes the shape in the prompt in object mode', async () => {
		const server = recordingFetch();
		await chatCompletion({
			endpoint: 'https://api.test/v1/chat/completions',
			model: 'm',
			prompt: 'hello',
			schema: SCHEMA,
			jsonMode: 'object',
			label: 'Test',
			fetch: server.fetch,
		});
		const { response_format: format, messages } = server.calls[0].body;
		expect(format).toEqual({ type: 'json_object' });
		expect(messages[0].content).toContain('hello');
		expect(messages[0].content).toContain('question');
	});

	it('omits the Authorization header when there is no key', async () => {
		// A local runtime normally has no auth, and sending `Bearer undefined`
		// makes some of them reject the request outright.
		const server = recordingFetch();
		await chatCompletion({
			endpoint: 'http://ollama.test/v1/chat/completions',
			model: 'm',
			prompt: 'hi',
			label: 'Test',
			fetch: server.fetch,
		});
		expect(server.calls[0].headers.Authorization).toBeUndefined();
	});

	it('reports the status on a failed call', async () => {
		const server = recordingFetch('', 429);
		await expect(
			chatCompletion({
				endpoint: 'https://api.test/v1/chat/completions',
				model: 'm',
				prompt: 'hi',
				label: 'Test',
				fetch: server.fetch,
			}),
		).rejects.toThrow(/Test m error 429/);
	});

	it('treats an empty completion as a failure', async () => {
		const empty = async () =>
			new Response(JSON.stringify({ choices: [{ message: {} }] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		await expect(
			chatCompletion({
				endpoint: 'https://api.test/v1/chat/completions',
				model: 'm',
				prompt: 'hi',
				label: 'Test',
				fetch: empty,
			}),
		).rejects.toThrow(/returned no text/);
	});
});

describe('provider wiring', () => {
	// The providers reach for the global `fetch` when they aren't handed one, so
	// these tests replace it — and put it back. Deleting it instead would leave
	// every test that runs after them in this runtime with no fetch at all, which
	// surfaces as a ReferenceError a long way from the cause.
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('openai asks for strict schema enforcement', async () => {
		const server = recordingFetch();
		vi.stubGlobal('fetch', server.fetch);
		await openai.generate({ prompt: 'p', schema: SCHEMA, env: { OPENAI_API_KEY: 'k', OPENAI_MODELS: 'gpt-test' } });
		expect(server.calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
		expect(server.calls[0].body.response_format.type).toBe('json_schema');
		expect(server.calls[0].headers.Authorization).toBe('Bearer k');
	});

	it('groq asks for json_object, not a schema', async () => {
		const server = recordingFetch();
		vi.stubGlobal('fetch', server.fetch);
		await groq.generate({ prompt: 'p', schema: SCHEMA, env: { GROQ_API_KEY: 'k', GROQ_MODELS: 'gpt-oss-test' } });
		// Groq's json_schema support varies by model; this is the behaviour that
		// was there before the shared helper and has to stay.
		expect(server.calls[0].body.response_format).toEqual({ type: 'json_object' });
	});

	it('openai-compatible defaults to json_object and honours the override', async () => {
		const base = { OPENAI_COMPATIBLE_URL: 'http://ollama.test:11434/v1', OPENAI_COMPATIBLE_MODELS: 'llama' };

		let server = recordingFetch();
		vi.stubGlobal('fetch', server.fetch);
		await openaiCompatible.generate({ prompt: 'p', schema: SCHEMA, env: base });
		expect(server.calls[0].body.response_format).toEqual({ type: 'json_object' });

		server = recordingFetch();
		vi.stubGlobal('fetch', server.fetch);
		await openaiCompatible.generate({ prompt: 'p', schema: SCHEMA, env: { ...base, OPENAI_COMPATIBLE_JSON: 'schema' } });
		expect(server.calls[0].body.response_format.type).toBe('json_schema');
	});
});

describe('openai-compatible configuration', () => {
	it('is configured by a URL and models, not by a key', () => {
		// Local runtimes have no auth, so requiring a key would make the provider
		// permanently unavailable exactly where it is most wanted.
		expect(openaiCompatible.isConfigured({ OPENAI_COMPATIBLE_URL: 'http://x/v1', OPENAI_COMPATIBLE_MODELS: 'm' })).toBe(true);
		expect(openaiCompatible.isConfigured({ OPENAI_COMPATIBLE_URL: 'http://x/v1' })).toBe(false);
		expect(openaiCompatible.isConfigured({})).toBe(false);
	});

	it('is not configured by a model list that is only separators', () => {
		// generate() would read this as an empty list and fail every suggestion
		// with "No models configured", where the honest answer is that this
		// provider was never set up.
		expect(openaiCompatible.isConfigured({ OPENAI_COMPATIBLE_URL: 'http://x/v1', OPENAI_COMPATIBLE_MODELS: ' , ' })).toBe(false);
	});

	it('accepts a base URL with or without /v1', () => {
		// Operators supply it about half the time; the difference should not be a
		// 404 to debug.
		const expected = 'http://ollama:11434/v1/chat/completions';
		expect(openaiCompatible.endpointFor('http://ollama:11434')).toBe(expected);
		expect(openaiCompatible.endpointFor('http://ollama:11434/')).toBe(expected);
		expect(openaiCompatible.endpointFor('http://ollama:11434/v1')).toBe(expected);
		expect(openaiCompatible.endpointFor('http://ollama:11434/v1/')).toBe(expected);
		expect(openaiCompatible.endpointFor('http://ollama:11434/v1/chat/completions')).toBe(expected);
	});
});
