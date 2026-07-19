// Structured-output schemas for the question suggester, one per question type.
// They mirror the block shapes the editor builds in src/lib/questions.js:
// buildQuestionBlock maps this JSON onto the editable block (e.g. wrapping each
// "multiple" answer string in an { id, text } row). Plain JSON Schema — each
// provider adapter converts it to whatever shape its own API expects.
export const QUESTION_SCHEMAS = {
	number: {
		type: 'object',
		properties: {
			prompt: { type: 'string' },
			answer: { type: 'number' },
			steps: { type: 'array', items: { type: 'string' } },
		},
		required: ['prompt', 'answer'],
		additionalProperties: false,
	},
	single: {
		type: 'object',
		properties: { prompt: { type: 'string' }, answer: { type: 'string' } },
		required: ['prompt', 'answer'],
		additionalProperties: false,
	},
	multiple: {
		type: 'object',
		properties: {
			prompt: { type: 'string' },
			answers: { type: 'array', items: { type: 'string' } },
		},
		required: ['prompt', 'answers'],
		additionalProperties: false,
	},
	open: {
		type: 'object',
		properties: { prompt: { type: 'string' } },
		required: ['prompt'],
		additionalProperties: false,
	},
	background: {
		type: 'object',
		properties: { prompt: { type: 'string' }, answer: { type: 'string' } },
		required: ['prompt', 'answer'],
		additionalProperties: false,
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
	number:
		'The question must have a single numeric answer. Put that number in the "answer" field. Break the working-out into short steps a student could follow and put them, in order, in the "steps" array (use an empty array if the problem is too simple to need steps).',
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
	type: 'object',
	properties: {
		ideas: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					title: { type: 'string' },
					description: { type: 'string' },
				},
				required: ['title', 'description'],
				additionalProperties: false,
			},
		},
	},
	required: ['ideas'],
	additionalProperties: false,
};
