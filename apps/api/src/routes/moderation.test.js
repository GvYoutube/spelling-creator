// The admin password reset, and specifically who is allowed to use it.
//
// This is the one moderation action that hands somebody another person's
// account, so the rules around it are worth pinning down rather than trusting to
// a reading of the handler: moderators cannot reach it, admins cannot use it on
// each other, and an admin can still use it on themselves.
//
// Driven through handleModeration against a stubbed identity service and
// database. The upstreams here are HTTP, so a fetch stub is a faithful stand-in
// for them — what is under test is the gate, not PostgREST.

import { describe, expect, it } from 'vitest';

import { handleModeration } from './moderation.js';

const BASE = 'https://db.test';
const ADMIN_ID = 'admin-1';
const OTHER_ADMIN_ID = 'admin-2';
const MOD_ID = 'mod-1';
const USER_ID = 'user-1';

const env = { SUPABASE_URL: BASE, SUPABASE_SERVICE_ROLE_KEY: 'service-key' };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Stand in for GoTrue and PostgREST.
 *
 * `caller` decides who the bearer token belongs to; `roles` maps a user id to
 * what public.user_roles says about them. Records the password writes so a test
 * can assert one did or did not happen.
 */
function stub({ caller, roles = {}, accounts = {} }) {
	const passwordWrites = [];
	globalThis.fetch = async (url, init = {}) => {
		const target = String(url);
		const method = (init.method || 'GET').toUpperCase();

		// Who is calling.
		if (target.includes('/auth/v1/user')) return json(caller ? { id: caller, email: `${caller}@test.com` } : null, caller ? 200 : 401);

		// Their role, and the target's.
		const roleMatch = target.match(/user_roles\?user_id=eq\.([^&]+)/);
		if (roleMatch) {
			const role = roles[decodeURIComponent(roleMatch[1])];
			return json(role ? [{ role }] : []);
		}

		// Looking the target account up by address.
		if (target.includes('/auth/v1/admin/users?')) {
			return json({ users: Object.entries(accounts).map(([email, id]) => ({ id, email })) });
		}

		// The write itself.
		const writeMatch = target.match(/\/auth\/v1\/admin\/users\/([^?]+)$/);
		if (writeMatch && method === 'PUT') {
			passwordWrites.push({ id: decodeURIComponent(writeMatch[1]), body: JSON.parse(init.body) });
			return json({ id: decodeURIComponent(writeMatch[1]) });
		}

		return json({ message: `unexpected request: ${method} ${target}` }, 500);
	};
	return { passwordWrites };
}

const reset = (body) =>
	handleModeration(
		new Request('https://api.test/mod/password', {
			method: 'POST',
			headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}),
		env,
		new URL('https://api.test/mod/password'),
		{},
	);

/** Restores the real fetch however the body exits. */
function withStub(run) {
	const original = globalThis.fetch;
	return (async () => {
		try {
			return await run();
		} finally {
			globalThis.fetch = original;
		}
	})();
}

describe('POST /mod/password — who may use it', () => {
	it('refuses a moderator', async () => {
		await withStub(async () => {
			// Setting a password is taking an account, which is a different kind of
			// power from hiding a lesson. Moderators do not get it.
			stub({ caller: MOD_ID, roles: { [MOD_ID]: 'moderator' }, accounts: { 'someone@test.com': USER_ID } });
			const res = await reset({ identifier: 'someone@test.com', password: 'longenough1' });
			expect(res.status).toBe(403);
		});
	});

	it('refuses somebody with no role at all', async () => {
		await withStub(async () => {
			stub({ caller: USER_ID, accounts: { 'someone@test.com': USER_ID } });
			expect((await reset({ identifier: 'someone@test.com', password: 'longenough1' })).status).toBe(403);
		});
	});

	it('refuses when not signed in', async () => {
		await withStub(async () => {
			stub({ caller: null });
			expect((await reset({ identifier: 'someone@test.com', password: 'longenough1' })).status).toBe(401);
		});
	});

	it('lets an admin set an ordinary user’s password', async () => {
		await withStub(async () => {
			const { passwordWrites } = stub({
				caller: ADMIN_ID,
				roles: { [ADMIN_ID]: 'admin' },
				accounts: { 'someone@test.com': USER_ID },
			});
			const res = await reset({ identifier: 'someone@test.com', password: 'longenough1' });
			expect(res.status).toBe(200);
			expect(passwordWrites).toEqual([{ id: USER_ID, body: { password: 'longenough1' } }]);
		});
	});

	it('refuses one admin resetting another admin', async () => {
		await withStub(async () => {
			// Admins are peers. Taking a peer's account is an escalation the tier
			// was never meant to allow.
			const { passwordWrites } = stub({
				caller: ADMIN_ID,
				roles: { [ADMIN_ID]: 'admin', [OTHER_ADMIN_ID]: 'admin' },
				accounts: { 'other@test.com': OTHER_ADMIN_ID },
			});
			const res = await reset({ identifier: 'other@test.com', password: 'longenough1' });
			expect(res.status).toBe(409);
			expect(passwordWrites).toEqual([]);
		});
	});

	it('lets an admin reset their own password', async () => {
		await withStub(async () => {
			// The peer rule must not lock an admin out of their own account.
			const { passwordWrites } = stub({
				caller: ADMIN_ID,
				roles: { [ADMIN_ID]: 'admin' },
				accounts: { 'admin-1@test.com': ADMIN_ID },
			});
			expect((await reset({ identifier: 'admin-1@test.com', password: 'longenough1' })).status).toBe(200);
			expect(passwordWrites).toHaveLength(1);
		});
	});
});

describe('POST /mod/password — what it accepts', () => {
	const asAdmin = (accounts) => stub({ caller: ADMIN_ID, roles: { [ADMIN_ID]: 'admin' }, accounts });

	it('resolves a username to the address it registered under', async () => {
		await withStub(async () => {
			// An admin types whichever of the two they know the person by.
			const { passwordWrites } = asAdmin({ 'oliver@users.noreply.invalid': USER_ID });
			expect((await reset({ identifier: 'oliver', password: 'longenough1' })).status).toBe(200);
			expect(passwordWrites[0].id).toBe(USER_ID);
		});
	});

	it('rejects a password shorter than the minimum', async () => {
		await withStub(async () => {
			const { passwordWrites } = asAdmin({ 'someone@test.com': USER_ID });
			const res = await reset({ identifier: 'someone@test.com', password: 'short' });
			expect(res.status).toBe(400);
			expect(await res.text()).toContain('at least 8');
			expect(passwordWrites).toEqual([]);
		});
	});

	it('rejects an identifier that is neither a username nor an address', async () => {
		await withStub(async () => {
			asAdmin({});
			expect((await reset({ identifier: 'not a username', password: 'longenough1' })).status).toBe(400);
		});
	});

	it('reports an unknown account as not found', async () => {
		await withStub(async () => {
			asAdmin({});
			expect((await reset({ identifier: 'nobody', password: 'longenough1' })).status).toBe(404);
		});
	});

	it('never echoes the password back', async () => {
		await withStub(async () => {
			asAdmin({ 'someone@test.com': USER_ID });
			const res = await reset({ identifier: 'someone@test.com', password: 'longenough1' });
			expect(await res.text()).not.toContain('longenough1');
		});
	});
});
