// Ask every dependency whether it is actually working, and say precisely what
// is wrong when it isn't.
//
// This exists because of how the first self-hosted deployment went. Every
// failure surfaced far from its cause and looked like every other failure: a
// stale PostgREST schema cache, an unapplied schema, a missing bucket and a
// misconfigured admin role all present to a user as one identical opaque 502,
// and to an operator as an app that starts fine and then doesn't work. Each one
// took a round trip to guess at.
//
// The checks below are written against the failures that actually happened, and
// each is chosen to distinguish causes rather than to confirm health. Reaching
// PostgREST is not the same as PostgREST being able to see the tables; reaching
// GoTrue is not the same as being allowed to call its admin API; a bucket that
// answers is not the same as a bucket that exists.
//
// Two rules for what goes in a result. It never contains a credential, and it
// always contains the upstream's own words — a status code and, where there is
// one, the error code the upstream uses for that condition (PostgREST's PGRST205
// or S3's NoSuchBucket). Those are the strings worth searching for, and
// paraphrasing them helps nobody.

import { platform } from '../platform/index.js';
import { supabaseBase, supabaseHeaders } from './supabase.js';

// Long enough for a container that is still starting, short enough that a whole
// run answers while somebody is watching it.
const TIMEOUT_MS = 5000;

/** A key no real object will occupy, used to prove a store answers at all. */
const PROBE_PREFIX = '_diagnostics-probe';

/**
 * @typedef {object} Check
 * @property {string} name    Stable identifier, e.g. 'schema'.
 * @property {'ok' | 'failed' | 'skipped'} state
 * @property {string} detail  One line a human can act on.
 * @property {string} [fix]   What to do about it, when we know.
 */

const ok = (name, detail) => ({ name, state: 'ok', detail });
const failed = (name, detail, fix) => ({ name, state: 'failed', detail, ...(fix ? { fix } : {}) });
const skipped = (name, detail) => ({ name, state: 'skipped', detail });

/** Fetch with a timeout, returning the error rather than throwing. */
async function probe(url, options) {
	try {
		return { response: await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) }) };
	} catch (e) {
		return { error: e };
	}
}

/**
 * PostgREST and GoTrue both answer errors as JSON with their own code field.
 * Pull out whatever is there without assuming a shape.
 */
async function upstreamError(response) {
	const text = await response.text().catch(() => '');
	let body = null;
	try {
		body = JSON.parse(text);
	} catch (e) {
		body = null;
	}
	const code = body?.code ?? body?.error_code ?? '';
	const message = body?.message ?? body?.msg ?? body?.error_description ?? text.slice(0, 200);
	return { code: String(code || ''), message: String(message || '').trim() };
}

/**
 * Read a JWT's payload without verifying it, reporting how it failed.
 *
 * Structure only — we cannot check the signature, since the secret belongs to
 * PostgREST and GoTrue rather than to us. That is fine: the failure this exists
 * to catch is a value that is not a token at all, which no amount of upstream
 * round-tripping diagnoses as clearly as counting the dots.
 */
function readJwt(token) {
	const parts = String(token || '').split('.');
	if (parts.length !== 3) return { parts: parts.length, payload: null };
	try {
		const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
		const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
		return { parts: 3, payload: JSON.parse(atob(padded)) };
	} catch (e) {
		return { parts: 3, payload: null };
	}
}

/**
 * Is the service-role key even shaped like the thing it is supposed to be?
 *
 * Checked locally and before anything is sent anywhere, because a malformed key
 * produces upstream errors that read as something else entirely: PostgREST
 * answers PGRST301 with a 401, which looks like a wrong secret, and GoTrue
 * answers 403, which looks like a permissions problem. Both are really "that
 * value is not a token", and the quickest way to know is to count its parts.
 */
function checkCredentials(env) {
	const { parts, payload } = readJwt(env.SUPABASE_SERVICE_ROLE_KEY);

	if (parts !== 3) {
		return failed(
			'credentials',
			`SUPABASE_SERVICE_ROLE_KEY is not a JWT — it has ${parts} part${parts === 1 ? '' : 's'} where a token has 3`,
			'It should be a signed token, not a password. If it still reads like the placeholder from .env.example, ' +
				'generate a real one — `./scripts/generate-env.sh` writes a matching set.',
		);
	}
	if (!payload) {
		return failed('credentials', 'SUPABASE_SERVICE_ROLE_KEY has three parts but its payload is not readable JSON');
	}
	if (payload.role !== 'service_role') {
		return failed(
			'credentials',
			`SUPABASE_SERVICE_ROLE_KEY carries role ${JSON.stringify(payload.role ?? null)}, not "service_role"`,
			'The anon key and the service-role key are both JWTs and are not interchangeable — this looks like the wrong one of the pair.',
		);
	}
	// Structure only. A key that is well-formed but signed with the wrong secret
	// still fails upstream, and the schema check below is what catches that.
	return ok('credentials', 'the service-role key is a JWT whose role claim is service_role');
}

/** Whether the configuration this host needs is even present. */
function checkConfiguration(env) {
	const missing = [];
	if (!env.SUPABASE_URL) missing.push('SUPABASE_URL');
	if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
	if (missing.length > 0) {
		return failed('configuration', `not set: ${missing.join(', ')}`, 'Set them in the environment; see /monorepo/self-hosting.');
	}
	// Deliberately reports only that a value exists, never any part of it.
	return ok('configuration', 'database and identity credentials are set');
}

/** Can we reach PostgREST at all? Separated from the schema check below. */
async function checkDatabase(env, base) {
	const { response, error } = await probe(`${base}/rest/v1/`, { headers: supabaseHeaders(env) });
	if (error) {
		return failed(
			'database',
			`cannot reach ${base}/rest/v1/ — ${error.name === 'TimeoutError' ? `no answer in ${TIMEOUT_MS}ms` : error.message}`,
			'Check SUPABASE_URL, and that the PostgREST service is running and routable from here.',
		);
	}
	// PostgREST answers the root with the OpenAPI description, but a gateway or a
	// restrictive config can make that 404 while the API itself is fine — so any
	// answer at all counts as reachable, and the schema check decides the rest.
	return ok('database', `PostgREST answered (HTTP ${response.status})`);
}

/**
 * Can PostgREST actually see the application's tables?
 *
 * The check that matters most, and the one whose absence cost the most time. It
 * separates three states that look identical from the app: the schema has never
 * been applied, PostgREST's cache predates it, and the role cannot read it.
 */
async function checkSchema(env, base) {
	const { response, error } = await probe(`${base}/rest/v1/lessons?select=id&limit=1`, { headers: supabaseHeaders(env) });
	if (error) return failed('schema', `could not query the lessons table — ${error.message}`);

	if (response.ok) {
		await response.text().catch(() => '');
		return ok('schema', 'the lessons table is queryable');
	}

	const { code, message } = await upstreamError(response);
	// PGRST205 is "did not find the table in the schema cache", which means
	// either the schema was never applied or PostgREST has not re-read it. They
	// are different problems with the same error, so name both.
	if (code === 'PGRST205' || /schema cache/i.test(message)) {
		return failed(
			'schema',
			`PostgREST cannot see public.lessons (HTTP ${response.status} ${code}: ${message})`,
			'Either apps/api/schema.sql was never applied, or PostgREST has a stale cache. ' +
				'Check the tables exist, then restart PostgREST if they do.',
		);
	}
	// 42501 is Postgres's own insufficient_privilege. PostgREST reports it as a
	// 401, which makes it look like the key was rejected — it was not. The key
	// was accepted, the role it named was assumed, and that role cannot read the
	// table. Sending someone to check their JWT over this is a wasted evening,
	// so it is separated out and checked before the status codes below.
	if (code === '42501' || /permission denied/i.test(message)) {
		return failed(
			'schema',
			`the database refused the query on privileges, not credentials (HTTP ${response.status} ${code}: ${message})`,
			'The service-role key was accepted; the role it names has no grant on the table. ' +
				'Grant it: GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role.',
		);
	}
	// A key that isn't a token at all lands here as PGRST301, which reads as a
	// signing mismatch. The credentials check above has already said what is
	// really wrong, so defer to it rather than offering a second, wronger answer.
	if (/number of parts|CompactDecodeError|malformed/i.test(message)) {
		return failed(
			'schema',
			`PostgREST could not parse the service-role key as a token (HTTP ${response.status} ${code}: ${message})`,
			'See the credentials check above — the value is not a JWT, so its signature never came into it.',
		);
	}
	if (response.status === 401 || response.status === 403) {
		return failed(
			'schema',
			`PostgREST refused the service-role key (HTTP ${response.status} ${code}: ${message})`,
			'The key must be a JWT signed with the same secret PostgREST verifies, carrying "role": "service_role".',
		);
	}
	return failed('schema', `querying public.lessons failed (HTTP ${response.status} ${code}: ${message})`);
}

/** Is the identity service up? */
async function checkIdentity(env, base) {
	const { response, error } = await probe(`${base}/auth/v1/health`, { headers: supabaseHeaders(env) });
	if (error) {
		return failed(
			'identity',
			`cannot reach ${base}/auth/v1/health — ${error.message}`,
			'Check the auth service is running, and that the gateway routes /auth/v1/* to it.',
		);
	}
	if (!response.ok) {
		const { code, message } = await upstreamError(response);
		return failed('identity', `auth health check failed (HTTP ${response.status} ${code}: ${message})`);
	}
	await response.text().catch(() => '');
	return ok('identity', 'the auth service is healthy');
}

/**
 * May we call the identity admin API?
 *
 * Separate from the check above because it fails separately: the service can be
 * perfectly healthy while refusing every admin call, and the app reads every
 * display name and bio through those endpoints. That combination looks like a
 * working instance until somebody opens a profile.
 */
async function checkIdentityAdmin(env, base) {
	const { response, error } = await probe(`${base}/auth/v1/admin/users?page=1&per_page=1`, { headers: supabaseHeaders(env) });
	if (error) return failed('identity-admin', `cannot reach the admin API — ${error.message}`);
	if (response.ok) {
		await response.text().catch(() => '');
		return ok('identity-admin', 'the admin API accepts the service-role key');
	}
	const { code, message } = await upstreamError(response);
	// Same trap as the schema check: an unparseable token comes back as a 403,
	// which reads as "this role may not call /admin". It is not a role problem.
	if (/invalid number of segments|malformed|unable to parse/i.test(message)) {
		return failed(
			'identity-admin',
			`the auth service could not parse the service-role key as a token (HTTP ${response.status}: ${message})`,
			'See the credentials check above — the value is not a JWT, so no role was ever read from it.',
		);
	}
	if (response.status === 401 || response.status === 403) {
		return failed(
			'identity-admin',
			`the admin API refused the service-role key (HTTP ${response.status} ${code}: ${message})`,
			'The auth service must allow the "service_role" claim to call /admin — on GoTrue that is GOTRUE_JWT_ADMIN_ROLES. ' +
				'Profiles and moderation read display names through this.',
		);
	}
	return failed('identity-admin', `admin API call failed (HTTP ${response.status} ${code}: ${message})`);
}

/**
 * Does this blob store exist and answer?
 *
 * Uses list() rather than head(), which matters: a `head` of a missing key and a
 * `head` of a missing *bucket* are both 404, so head cannot tell "empty" from
 * "not there". Listing a bucket that does not exist is an error, which is the
 * distinction worth having.
 */
async function checkBlobStore(name, store, hint) {
	if (!store) return skipped(name, `not configured — ${hint}`);
	try {
		await store.list({ limit: 1 });
		return ok(name, 'the bucket exists and is readable');
	} catch (e) {
		const detail = String(e?.message || e);
		if (/NoSuchBucket/i.test(detail)) {
			return failed(
				name,
				`the bucket does not exist (${detail.slice(0, 200)})`,
				'Create it, or point the bucket variable at one that exists.',
			);
		}
		if (/SignatureDoesNotMatch|InvalidAccessKeyId|AccessDenied/i.test(detail)) {
			return failed(
				name,
				`the object store rejected the credentials (${detail.slice(0, 200)})`,
				'Check the access key and secret, and that the region matches.',
			);
		}
		return failed(name, `listing the bucket failed — ${detail.slice(0, 300)}`);
	}
}

/** Round-trip a value through the key-value store. */
async function checkKeyValue(env) {
	const store = platform(env).rateLimit;
	if (!store) return skipped('key-value', 'not configured — rate limiting and the AI answer cache are unavailable');
	const key = `${PROBE_PREFIX}:kv`;
	try {
		await store.put(key, 'ok', { expirationTtl: 60 });
		const read = await store.get(key);
		await store.delete(key).catch(() => {});
		if (read !== 'ok') {
			return failed(
				'key-value',
				`wrote a value and read back ${JSON.stringify(read)}`,
				'The store is reachable but not durable; check the kv_store table exists.',
			);
		}
		return ok('key-value', 'a value round-tripped');
	} catch (e) {
		return failed(
			'key-value',
			`could not write to the store — ${String(e?.message || e).slice(0, 300)}`,
			'On Postgres this is the kv_store table from apps/api/schema.sql.',
		);
	}
}

/**
 * Run every check.
 *
 * Sequential rather than parallel on purpose: the checks build on each other, a
 * failing dependency usually fails several of them, and reading them in order
 * tells a story. Nothing here is slow enough for the difference to matter.
 *
 * @param {object} env
 * @returns {Promise<{ ok: boolean, checks: Check[] }>}
 */
export async function runDiagnostics(env) {
	const configuration = checkConfiguration(env);
	const checks = [configuration];
	// Only worth asking about the key's shape once we know there is one.
	if (configuration.state === 'ok') checks.push(checkCredentials(env));

	if (configuration.state === 'ok') {
		const base = supabaseBase(env);
		checks.push(await checkDatabase(env, base));
		checks.push(await checkSchema(env, base));
		checks.push(await checkIdentity(env, base));
		checks.push(await checkIdentityAdmin(env, base));
	} else {
		for (const name of ['credentials', 'database', 'schema', 'identity', 'identity-admin']) {
			checks.push(skipped(name, 'no database or identity credentials to check with'));
		}
	}

	const services = platform(env);
	checks.push(await checkBlobStore('images', services.images, 'lesson images cannot be uploaded or served'));
	checks.push(await checkBlobStore('lesson-history', services.lessonGit, 'version history and forking are unavailable'));
	checks.push(await checkKeyValue(env));

	return { ok: checks.every((c) => c.state !== 'failed'), checks };
}

/**
 * The same result as something to read in a log.
 *
 * Plain text rather than JSON because its first audience is whoever is staring
 * at `docker compose logs app` wondering why the hub is empty.
 *
 * @param {{ ok: boolean, checks: Check[] }} result
 */
export function formatDiagnostics(result) {
	const mark = { ok: 'ok  ', failed: 'FAIL', skipped: '--  ' };
	const lines = ['', 'Dependency check:'];
	for (const check of result.checks) {
		lines.push(`  [${mark[check.state]}] ${check.name}: ${check.detail}`);
		if (check.fix) lines.push(`         ${check.fix}`);
	}
	lines.push(
		result.ok
			? '  Everything this instance needs is working.'
			: '  Something above is broken; the app will not work correctly until it is fixed.',
	);
	lines.push('');
	return lines.join('\n');
}
