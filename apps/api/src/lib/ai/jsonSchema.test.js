import { describe, it, expect } from 'vitest';
import { toGeminiSchema, toOpenAiStrictSchema, schemaToExampleShape } from './jsonSchema.js';

describe('toGeminiSchema', () => {
	it('uppercases nested object/array types and drops additionalProperties', () => {
		const schema = {
			type: 'object',
			properties: {
				name: { type: 'string' },
				tags: { type: 'array', items: { type: 'string' } },
			},
			required: ['name'],
			additionalProperties: false,
		};
		expect(toGeminiSchema(schema)).toEqual({
			type: 'OBJECT',
			properties: {
				name: { type: 'STRING' },
				tags: { type: 'ARRAY', items: { type: 'STRING' } },
			},
			required: ['name'],
		});
	});
});

describe('toOpenAiStrictSchema', () => {
	it('makes every property required and sets additionalProperties: false, including nested objects', () => {
		const schema = {
			type: 'object',
			properties: {
				name: { type: 'string' },
				address: {
					type: 'object',
					properties: { city: { type: 'string' } },
					required: [],
				},
			},
			required: ['name'], // "address" deliberately left optional in the input
		};
		expect(toOpenAiStrictSchema(schema)).toEqual({
			type: 'object',
			properties: {
				name: { type: 'string' },
				address: {
					type: 'object',
					properties: { city: { type: 'string' } },
					required: ['city'],
					additionalProperties: false,
				},
			},
			required: ['name', 'address'],
			additionalProperties: false,
		});
	});
});

describe('schemaToExampleShape', () => {
	it('renders a placeholder-value skeleton for object/array/primitive shapes', () => {
		const schema = {
			type: 'object',
			properties: {
				prompt: { type: 'string' },
				answers: { type: 'array', items: { type: 'string' } },
			},
		};
		expect(schemaToExampleShape(schema)).toEqual({ prompt: 'string', answers: ['string'] });
	});
});
