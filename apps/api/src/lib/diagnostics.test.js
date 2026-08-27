// The dependency checks, driven through the failures that actually happened.
//
// Each case below is a real deployment failure from getting the first
// self-hosted instance running, and the assertion is not that the check fails —
// it is that the check says which failure it was. That is the whole value: four
// different causes previously produced one identical opaque 502, and every one
// of them cost a round trip to guess at.
//
// Diagnostic code is also the code most likely to be wrong when it runs, since
// by definition it only runs when something else is broken. So it is tested
// against each state rather than only against a healthy one.

import { describe, expect, it } from 'vitest';

import { formatDiagnostics, runDiagnostics } from './diagnostics.js';

const BASE = 'https://db.test';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A blob store that answers list() however the test says. */
function blobStore(onList) {
	return {
		list: onList,
		head: async () => null,
		get: async () => null,
		put: async () => {},
		delete: async () => {},
	};
}

/** A key-value store backed by a Map. */
function kvStore() {
	const values = new Map();
	return {
		get: async (k) => values.get(k) ?? null,
		put: async (k, v) => void values.set(k, v),
		delete: async (k) => void values.delete(k),
	};
}

/**
 * An env whose upstreams answer per `routes`, and whose platform is healthy
 * unless overridden. Each route is matched by substring, first match wins.
 */
function envWith(routes, platformOverrides = {}) {
	const env = {
		SUPABASE_URL: BASE,
		SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
		PLATFORM: {
			images: blobStore(async () => ({ objects: [], cursor: '', truncated: false })),
			lessonGit: blobStore(async () => ({ objects: [], cursor: '', truncated: false })),
			rateLimit: kvStore(),
			oauthState: kvStore(),
			cache: { match: async () => null, put: async () => {}, delete: async () => {} },
			clientIp: () => '',
			...platformOverrides,
		},
	};
	globalThis.fetch = async (url) => {
		for (const [fragment, answer] of Object.entries(routes)) {
			if (String(url).includes(fragment)) return typeof answer === 'function' ? answer() : answer;
		}
		return json({ message: 'unexpected request in test: ' + url }, 500);
	};
	return env;
}

/** Everything upstream working. */
const HEALTHY_ROUTES = {
	'/rest/v1/lessons': json([]),
	'/rest/v1/': json({}),
	'/auth/v1/health': json({ name: 'GoTrue' }),
	'/auth/v1/admin/users': json({ users: [] }),
};

const find = (result, name) => result.checks.find((c) => c.name === name);

function withFetch(run) {
	const original = globalThis.fetch;
	return (async () => {
		try {
			return await run();
		} finally {
			globalThis.fetch = original;
		}
	})();
}

describe('runDiagnostics — everything working', () => {
	it('reports ok, and covers every dependency', async () => {
		await withFetch(async () => {
			const result = await runDiagnostics(envWith(HEALTHY_ROUTES));
			expect(result.ok).toBe(true);
			expect(result.checks.map((c) => c.name)).toEqual([
				'configuration',
				'database',
				'schema',
				'identity',
				'identity-admin',
				'images',
				'lesson-history',
				'key-value',
			]);
			expect(result.checks.every((c) => c.state === 'ok')).toBe(true);
		});
	});
});

describe('runDiagnostics — the failures that actually happened', () => {
	it('names an unapplied schema, and does not blame the connection', async () => {
		// Round four: schema.sql silently failed every statement, so PostgREST
		// reported "0 Relations" and the app answered 502 with no clue why.
		await withFetch(async () => {
			const result = await runDiagnostics(
				envWith({
					...HEALTHY_ROUTES,
					'/rest/v1/lessons': json({ code: 'PGRST205', message: "Could not find the table 'public.lessons' in the schema cache" }, 404),
				}),
			);
			expect(result.ok).toBe(false);
			expect(find(result, 'database').state).toBe('ok');
			const schema = find(result, 'schema');
			expect(schema.state).toBe('failed');
			// The upstream's own code, because that is the searchable string.
			expect(schema.detail).toContain('PGRST205');
			expect(schema.fix).toMatch(/schema\.sql was never applied|stale cache/);
		});
	});

	it('does not blame the key for a privilege error', async () => {
		// A real instance answered exactly this. PostgREST reports Postgres's
		// 42501 as a 401, so it reads as a rejected key — but the key was
		// accepted and the role it named simply has no grant. Sending someone to
		// check their JWT over this is a wasted evening.
		await withFetch(async () => {
			const result = await runDiagnostics(
				envWith({
					...HEALTHY_ROUTES,
					'/rest/v1/lessons': json({ code: '42501', message: 'permission denied for table lessons' }, 401),
				}),
			);
			const schema = find(result, 'schema');
			expect(schema.state).toBe('failed');
			expect(schema.detail).toContain('privileges, not credentials');
			expect(schema.fix).toContain('GRANT ALL ON ALL TABLES');
			// Specifically must NOT send them to the JWT.
			expect(schema.fix).not.toMatch(/signed with the same secret/);
		});
	});

	it('distinguishes a refused key from a missing table', async () => {
		await withFetch(async () => {
			const result = await runDiagnostics(envWith({ ...HEALTHY_ROUTES, '/rest/v1/lessons': json({ message: 'JWSError' }, 401) }));
			const schema = find(result, 'schema');
			expect(schema.state).toBe('failed');
			expect(schema.fix).toContain('service_role');
		});
	});

	it('separates an unreachable database from a broken schema', async () => {
		await withFetch(async () => {
			const result = await runDiagnostics(
				envWith({
					'/rest/v1/': () => {
						throw new TypeError('fetch failed');
					},
					'/rest/v1/lessons': () => {
						throw new TypeError('fetch failed');
					},
					'/auth/v1/health': json({}),
					'/auth/v1/admin/users': json({ users: [] }),
				}),
			);
			const database = find(result, 'database');
			expect(database.state).toBe('failed');
			expect(database.fix).toContain('SUPABASE_URL');
		});
	});

	it('catches an admin API that refuses the service role while auth is healthy', async () => {
		// The GOTRUE_JWT_ADMIN_ROLES case: everything looks fine until somebody
		// opens a profile, because that is the first read through /admin.
		await withFetch(async () => {
			const result = await runDiagnostics(envWith({ ...HEALTHY_ROUTES, '/auth/v1/admin/users': json({ msg: 'User not allowed' }, 403) }));
			expect(find(result, 'identity').state).toBe('ok');
			const admin = find(result, 'identity-admin');
			expect(admin.state).toBe('failed');
			expect(admin.fix).toContain('GOTRUE_JWT_ADMIN_ROLES');
		});
	});

	it('tells a missing bucket from bad credentials', async () => {
		await withFetch(async () => {
			const missing = await runDiagnostics(
				envWith(HEALTHY_ROUTES, {
					images: blobStore(async () => {
						throw new Error('S3 LIST failed: 404 <Error><Code>NoSuchBucket</Code></Error>');
					}),
				}),
			);
			expect(find(missing, 'images').fix).toMatch(/Create it/);

			const rejected = await runDiagnostics(
				envWith(HEALTHY_ROUTES, {
					images: blobStore(async () => {
						throw new Error('S3 LIST failed: 403 <Error><Code>SignatureDoesNotMatch</Code></Error>');
					}),
				}),
			);
			expect(find(rejected, 'images').fix).toMatch(/access key/);
		});
	});

	it('reports an unconfigured store as skipped, not broken', async () => {
		// A hub with no object storage still serves lessons. That is a different
		// thing from a bucket that is misconfigured, and should read differently.
		await withFetch(async () => {
			const result = await runDiagnostics(envWith(HEALTHY_ROUTES, { images: null }));
			expect(find(result, 'images').state).toBe('skipped');
			expect(result.ok).toBe(true);
		});
	});

	it('catches a key-value store that accepts writes but loses them', async () => {
		await withFetch(async () => {
			const result = await runDiagnostics(
				envWith(HEALTHY_ROUTES, {
					rateLimit: { get: async () => null, put: async () => {}, delete: async () => {} },
				}),
			);
			const kv = find(result, 'key-value');
			expect(kv.state).toBe('failed');
			expect(kv.detail).toContain('read back');
		});
	});

	it('skips the upstream checks when there is nothing to check with', async () => {
		await withFetch(async () => {
			const result = await runDiagnostics({ PLATFORM: envWith({}).PLATFORM });
			expect(find(result, 'configuration').state).toBe('failed');
			expect(find(result, 'schema').state).toBe('skipped');
			// Still reports the stores, which need no database credentials.
			expect(find(result, 'images').state).toBe('ok');
		});
	});

	it('never puts a credential in a result', async () => {
		await withFetch(async () => {
			const result = await runDiagnostics(envWith({ ...HEALTHY_ROUTES, '/rest/v1/lessons': json({ message: 'nope' }, 401) }));
			expect(JSON.stringify(result)).not.toContain('service-role-key');
		});
	});
});

describe('formatDiagnostics', () => {
	it('reads as a report, with the fix under the failure', async () => {
		await withFetch(async () => {
			const result = await runDiagnostics(
				envWith({ ...HEALTHY_ROUTES, '/rest/v1/lessons': json({ code: 'PGRST205', message: 'no table' }, 404) }),
			);
			const text = formatDiagnostics(result);
			expect(text).toContain('[FAIL] schema:');
			expect(text).toContain('[ok  ] database:');
			expect(text).toContain('PGRST205');
			expect(text).toContain('will not work correctly');
		});
	});
});
