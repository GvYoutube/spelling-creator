// What an upload to a proposal is allowed to do.
//
// A proposal used to be write-once, which made this decision trivial and made
// changing a proposal impossible. Now it has three outcomes — complete the open,
// record a new revision, or refuse — and getting the refusals wrong is how a
// reviewer ends up reading one thing and merging another. Pure, so tested here
// rather than through R2.

import { describe, expect, it } from 'vitest';
import { planPullUpload } from './pulls.js';
import { MAX_PULL_REVISIONS } from '@spelling-creator/core/pulls';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const opened = (over = {}) => ({ head: A, ready: false, revision: 1, ...over });
const live = (over = {}) => ({ head: A, ready: true, revision: 1, ...over });

describe('planPullUpload', () => {
	it('completes the two-step open when the tip is the one the row was created with', () => {
		const plan = planPullUpload(opened(), A);
		expect(plan.updating).toBe(false);
		expect(plan.patch).toEqual({ ready: true });
		// The row must still be open, still unready, and still where we read it.
		expect(plan.expect).toEqual({ status: 'open', ready: false, head: A });
	});

	it('refuses a first upload that does not match the proposal it belongs to', () => {
		expect(planPullUpload(opened(), B).status).toBe(409);
	});

	it('records a revision when an open proposal is given something new', () => {
		const plan = planPullUpload(live(), B, 'NOW');
		expect(plan.updating).toBe(true);
		expect(plan.patch).toEqual({
			head: B,
			previous_head: A,
			revision: 2,
			updated_at: 'NOW',
		});
		// Conditional on the head we read: two of the proposer's own uploads racing
		// must not both win.
		expect(plan.expect).toEqual({ status: 'open', ready: true, head: A });
	});

	it('keeps the commit it moved from, which is what makes the update readable', () => {
		expect(planPullUpload(live({ head: A, revision: 3 }), B).patch).toMatchObject({
			previous_head: A,
			revision: 4,
		});
	});

	it('refuses an update that changes nothing', () => {
		expect(planPullUpload(live(), A).status).toBe(409);
	});

	it('stops once a proposal has been rewritten enough times', () => {
		expect(planPullUpload(live({ revision: MAX_PULL_REVISIONS - 1 }), B).updating).toBe(true);
		expect(planPullUpload(live({ revision: MAX_PULL_REVISIONS }), B).status).toBe(409);
	});

	it('treats a row with no revision recorded as the first one', () => {
		const plan = planPullUpload({ head: A, ready: true }, B);
		expect(plan.patch.revision).toBe(2);
	});
});
