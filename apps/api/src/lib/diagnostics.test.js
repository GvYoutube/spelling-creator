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

/** base64url, for building the fixture tokens below. */
const b64u = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * A structurally valid JWT with the given claims. The signature is not real —
 * nothing here verifies one, and the checks under test deliberately only read
 * the token's shape, because the secret belongs to PostgREST and GoTrue.
 */
const jwt = (claims) => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u(claims)}.not-a-real-signature`;

const SERVICE_ROLE_KEY = jwt({ role: 'service_role', iss: 'supabase' });

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
		SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
		ALLOWED_HOSTNAMES: 'app.test',
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
				'cross-origin',
				'credentials',
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

	it('reports an unset ALLOWED_HOSTNAMES without calling the instance broken', async () => {
		// It was a startup warning before the report existed, and it earns its
		// place: the app loads, every API call is refused by the browser, and the
		// console blames CORS rather than the variable that caused it. Same-origin
		// deployments are fine without it, so it is not a failure.
		await withFetch(async () => {
			const env = envWith(HEALTHY_ROUTES);
			delete env.ALLOWED_HOSTNAMES;
			const result = await runDiagnostics(env);
			expect(result.ok).toBe(true);
			expect(find(result, 'cross-origin').state).toBe('skipped');
			expect(find(result, 'cross-origin').detail).toContain('ALLOWED_HOSTNAMES');
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

	it('catches a service-role key that is not a token at all', async () => {
		// The real one: .env still held the placeholder from .env.example, so both
		// upstreams answered with errors about signatures and roles, and neither
		// said the plain truth — that the value has no dots in it.
		await withFetch(async () => {
			const env = envWith({
				...HEALTHY_ROUTES,
				'/rest/v1/lessons': json(
					{ code: 'PGRST301', message: 'JWSError (CompactDecodeError Invalid number of parts: Expected 3 parts; got 1)' },
					401,
				),
				'/auth/v1/admin/users': json({ msg: 'invalid JWT: unable to parse or verify signature, token is malformed' }, 403),
			});
			env.SUPABASE_SERVICE_ROLE_KEY = 'replace-with-a-jwt-whose-role-claim-is-service_role';
			const result = await runDiagnostics(env);

			const credentials = find(result, 'credentials');
			expect(credentials.state).toBe('failed');
			expect(credentials.detail).toContain('has 1 part where a token has 3');

			// And the two downstream checks defer rather than each offering their own
			// wrong remedy — a signing mismatch and a missing admin role.
			expect(find(result, 'schema').fix).toContain('credentials check above');
			expect(find(result, 'identity-admin').fix).toContain('credentials check above');
			expect(find(result, 'identity-admin').fix).not.toContain('GOTRUE_JWT_ADMIN_ROLES');
		});
	});

	it('catches the anon key used where the service-role key belongs', async () => {
		await withFetch(async () => {
			const b = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
			const env = envWith(HEALTHY_ROUTES);
			env.SUPABASE_SERVICE_ROLE_KEY = `${b({ alg: 'HS256' })}.${b({ role: 'anon' })}.sig`;
			const credentials = find(await runDiagnostics(env), 'credentials');
			expect(credentials.state).toBe('failed');
			expect(credentials.detail).toContain('"anon"');
			expect(credentials.fix).toContain('not interchangeable');
		});
	});

	it('accepts a well-formed service-role key', async () => {
		await withFetch(async () => {
			const b = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
			const env = envWith(HEALTHY_ROUTES);
			env.SUPABASE_SERVICE_ROLE_KEY = `${b({ alg: 'HS256' })}.${b({ role: 'service_role' })}.sig`;
			expect(find(await runDiagnostics(env), 'credentials').state).toBe('ok');
		});
	});

	it('never puts the key itself in a credentials result', async () => {
		await withFetch(async () => {
			const env = envWith(HEALTHY_ROUTES);
			env.SUPABASE_SERVICE_ROLE_KEY = 'not-a-token-but-secret-looking';
			const result = await runDiagnostics(env);
			expect(JSON.stringify(result)).not.toContain('not-a-token-but-secret-looking');
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
			expect(JSON.stringify(result)).not.toContain(SERVICE_ROLE_KEY);
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
