// Talking to Supabase: REST (PostgREST) + Auth (GoTrue) with the service-role
// key, which bypasses RLS and so lives only on the Worker, never in the browser.

/**
 * The Supabase project URL with any trailing slash trimmed — the base every REST
 * and Auth call is built on.
 */
export function supabaseBase(env) {
	return env.SUPABASE_URL.replace(/\/$/, '');
}

/** Whether the Supabase service-role credentials are configured. */
export function supabaseConfigured(env) {
	return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Headers for talking to Supabase's REST (PostgREST) and Auth APIs with the
 * service-role key. The service-role key bypasses RLS, so it lives only on the
 * Worker and is never shipped to the browser.
 */
export function supabaseHeaders(env) {
	return {
		apikey: env.SUPABASE_SERVICE_ROLE_KEY,
		Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
	};
}

/**
 * Verify a Supabase session JWT by asking Supabase Auth who it belongs to.
 *
 * We call GET /auth/v1/user with the client-supplied token rather than checking
 * an HS256 signature ourselves: it needs no JWT secret, and it keeps working if
 * the project switches to asymmetric (RS256/ES256) signing keys. Returns the
 * verified user object on success, or null if the token is missing/invalid.
 */
export async function verifySupabaseUser(env, token) {
	if (!token) return null;
	let res;
	try {
		res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
			headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
		});
	} catch (e) {
		return null;
	}
	if (!res.ok) return null;
	const user = await res.json().catch(() => null);
	return user && user.id ? user : null;
}

/**
 * Look up an auth user by email via the Supabase Admin API (service-role). GoTrue
 * offers no email filter, so page the admin user list and match. Bounded so a huge
 * user base can't spin forever. Returns the user object or null.
 */
export async function findAuthUserByEmail(env, email) {
	const target = (email || '').trim().toLowerCase();
	if (!target) return null;
	const baseUrl = supabaseBase(env);
	const perPage = 200;
	for (let page = 1; page <= 20; page++) {
		let res;
		try {
			res = await fetch(`${baseUrl}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, { headers: supabaseHeaders(env) });
		} catch (e) {
			return null;
		}
		if (!res.ok) return null;
		const data = await res.json().catch(() => null);
		const users = Array.isArray(data) ? data : data && Array.isArray(data.users) ? data.users : [];
		const match = users.find((u) => (u.email || '').toLowerCase() === target);
		if (match) return match;
		if (users.length < perPage) return null; // reached the last page
	}
	return null;
}

/**
 * Fetch a single auth user by id via the Admin API. Used to attach emails to the
 * moderator list. Returns the user object or null.
 */
export async function getAuthUserById(env, id) {
	const baseUrl = supabaseBase(env);
	let res;
	try {
		res = await fetch(`${baseUrl}/auth/v1/admin/users/${encodeURIComponent(id)}`, { headers: supabaseHeaders(env) });
	} catch (e) {
		return null;
	}
	if (!res.ok) return null;
	return await res.json().catch(() => null);
}

/**
 * Look up a user's public profile fields by id via the Admin API (service-role).
 * Returns { id, displayName, bio } or null if there's no such user. We never
 * expose the email — only the chosen display name and bio.
 */
export async function fetchPublicUser(env, base, userId) {
	let res;
	try {
		res = await fetch(`${base}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
			headers: supabaseHeaders(env),
		});
	} catch (e) {
		return null;
	}
	if (!res.ok) return null;
	const user = await res.json().catch(() => null);
	if (!user || !user.id) return null;
	const meta = user.user_metadata || {};
	return {
		id: user.id,
		displayName: (meta.display_name || '').toString().trim() || 'Anonymous',
		bio: (meta.bio || '').toString().trim(),
	};
}
