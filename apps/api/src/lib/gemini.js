import { env } from 'cloudflare:workers';
import { GoogleGenAI, Type } from '@google/genai';

const GEMINI_API_KEY = env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Models to try, newest first. If a model is unavailable or errors (e.g. not yet
// rolled out to this key), we fall back to the next one in order.
const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-3-flash', 'gemini-2.5-flash'];

// Run generateContent against GEMINI_MODELS in order, returning the first success.
// Throws the last error only if every model fails.
export async function generateContentWithFallback(request) {
	let lastErr;
	for (const model of GEMINI_MODELS) {
		try {
			return await ai.models.generateContent({ ...request, model });
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr;
}

// Structured-output schemas for the question suggester, one per question type.
// They mirror the block shapes the editor builds in src/lib/questions.js:
// buildQuestionBlock maps this JSON onto the editable block (e.g. wrapping each
// "multiple" answer string in an { id, text } row).
export const QUESTION_SCHEMAS = {
	number: {
		type: Type.OBJECT,
		properties: { prompt: { type: Type.STRING }, answer: { type: Type.NUMBER } },
		required: ['prompt', 'answer'],
	},
	single: {
		type: Type.OBJECT,
		properties: {
			prompt: { type: Type.STRING },
			answer: { type: Type.STRING },
		},
		required: ['prompt', 'answer'],
	},
	multiple: {
		type: Type.OBJECT,
		properties: {
			prompt: { type: Type.STRING },
			answers: { type: Type.ARRAY, items: { type: Type.STRING } },
		},
		required: ['prompt', 'answers'],
	},
	open: {
		type: Type.OBJECT,
		properties: { prompt: { type: Type.STRING } },
		required: ['prompt'],
	},
	background: {
		type: Type.OBJECT,
		properties: {
			prompt: { type: Type.STRING },
			answer: { type: Type.STRING },
		},
		required: ['prompt', 'answer'],
	},
};

// How to describe each question type in the prompt, and the type-specific rules
// the model must follow so its JSON matches the schema above.
export const QUESTION_LABELS = {
	number: 'number-answer',
	single: 'single-answer',
	multiple: 'multiple-answer',
	open: 'open-ended',
	background: 'background-knowledge',
};

export const QUESTION_INSTRUCTIONS = {
	number: 'The question must have a single numeric answer. Put that number in the "answer" field.',
	single:
		'The question must have a single short typed answer (a word or brief phrase). Do not make the answer a number under any circumstances. Do not provide answer options. Put the correct answer in "answer".',
	multiple:
		'The question must have several distinct correct answers, any one of which a student could type to be marked correct (the student only needs to give one). If you generate a single answer, consider that a failure. Do not provide answer options. Put each accepted answer as a separate string in "answers".',
	open: 'Write a question that invites a free, written response. Do not provide answer options or a model answer. Put the question in "prompt".',
	background:
		'The question must test prior knowledge that is NOT explained anywhere in the lesson text — the student is expected to already know it. Do not ask about anything the lesson text covers. Put the question in "prompt" and the correct answer (a word or brief phrase) in "answer".',
};

// Structured-output schema for the lesson-idea suggester: a short list of lesson
// topic ideas pitched at an age range, each with a title the user can adopt as
// their lesson title and a one-line description of what it would cover.
export const LESSON_IDEA_SCHEMA = {
	type: Type.OBJECT,
	properties: {
		ideas: {
			type: Type.ARRAY,
			items: {
				type: Type.OBJECT,
				properties: {
					title: { type: Type.STRING },
					description: { type: Type.STRING },
				},
				required: ['title', 'description'],
			},
		},
	},
	required: ['ideas'],
};
