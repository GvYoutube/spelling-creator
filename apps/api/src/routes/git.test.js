// The per-branch compare-and-swap.
//
// This is the rule that decides whether a push loses somebody's work, and it is
// pure — so it is worth testing directly rather than through R2. The cases below
// are the ones that actually happen: two of the author's devices, an old client
// that knows nothing about variations, and a delete racing a rename.

import { describe, expect, it } from 'vitest';
import { applyRefs } from './git.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

const push = (current, instructions) => applyRefs(current, { refs: {}, deletes: [], expected: {}, ...instructions });

describe('applyRefs', () => {
	it('moves a branch the client had seen the current state of', () => {
		const result = push({ main: A }, { refs: { main: B }, expected: { main: A } });
		expect(result.refs).toEqual({ main: B });
	});

	it('refuses to move a branch the client is out of date on', () => {
		const result = push({ main: B }, { refs: { main: C }, expected: { main: A } });
		expect(result.status).toBe(409);
	});

	it('refuses to move a branch the client says nothing about', () => {
		// Silence means "I believe this is new". It is not, so the push would
		// overwrite whatever moved it.
		const result = push({ main: A }, { refs: { main: B } });
		expect(result.status).toBe(409);
	});

	it('accepts a branch the client correctly believes is new', () => {
		const result = push({ main: A }, { refs: { main: A, 'Year-3': B }, expected: { main: A, 'Year-3': '' } });
		expect(result.refs).toEqual({ main: A, 'Year-3': B });
	});

	it('refuses a new branch whose name somebody else has already used', () => {
		const result = push({ main: A, 'Year-3': B }, { refs: { main: A, 'Year-3': C }, expected: { main: A, 'Year-3': '' } });
		expect(result.status).toBe(409);
	});

	it('leaves branches the push never mentions exactly as they were', () => {
		// The case this exists for: one device saves without ever having heard of a
		// variation another device made. It must not disappear.
		const result = push({ main: A, 'Year-3': B }, { refs: { main: C }, expected: { main: A } });
		expect(result.refs).toEqual({ main: C, 'Year-3': B });
	});

	it('removes a branch when asked by name, and only at the tip it was asked for', () => {
		expect(push({ main: A, 'Year-3': B }, { refs: { main: A }, deletes: ['Year-3'], expected: { main: A, 'Year-3': B } }).refs).toEqual({
			main: A,
		});

		// Somebody added to the variation after we decided to delete it.
		expect(push({ main: A, 'Year-3': C }, { refs: { main: A }, deletes: ['Year-3'], expected: { main: A, 'Year-3': B } }).status).toBe(409);
	});

	it('will not delete the lesson itself', () => {
		const result = push({ main: A }, { deletes: ['main'], expected: { main: A } });
		expect(result.status).toBe(400);
	});

	it('rejects a delete that is not a branch name at all', () => {
		const result = push({ main: A }, { refs: { main: A }, deletes: ['../evil'], expected: { main: A } });
		expect(result.status).toBe(400);
	});

	it('caps how many branches a lesson can end up with', () => {
		const current = { main: A };
		const refs = { main: A };
		const expected = { main: A };
		for (let i = 0; i < 20; i++) {
			refs[`v${i}`] = B;
			expected[`v${i}`] = '';
		}
		expect(push(current, { refs, expected }).status).toBe(400);
	});
});
