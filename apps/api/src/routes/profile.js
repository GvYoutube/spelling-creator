// Profile endpoint — lets a signed-in user set the display name (shown in place
// of their email) and bio. Both are written to user_metadata via the Admin API
// (service-role), so the browser can't smuggle in an unvalidated value: this is
// the only path that sets them, and it validates length, profanity and name bans.

import { supabaseHeaders, verifySupabaseUser } from '../lib/supabase.js';
import { bearerToken } from '../lib/auth.js';
import { isNameBanned } from '../lib/bans.js';
import { profanityFilter } from '../lib/profanity.js';
import { textResponse, jsonResponse } from '../lib/http.js';
import { richTextToPlain, sanitizeRichText } from '../lib/richtext.js';

// Display names are the only identity shown to other users (we never expose an
// email). Bounded so a name stays readable in a comment header or hub card.
const DISPLAY_NAME_MIN = 2;
const DISPLAY_NAME_MAX = 40;

// A user's "about me", stored in user_metadata.bio (no DB column). It is rich text
// — HTML written in the browser with mui-tiptap — and, exactly as with comments, the
// stored value is only ever what sanitizeRichText allows through (see lib/richtext.js).
// Empty is allowed and clears the bio.
//
// The cap counts the text the user wrote, not the markup around it, so formatting a
// bio doesn't eat into their word budget. MAX_BIO_HTML is the crude ceiling on the
// raw submission, checked before parsing so a markup bomb never gets that far.
const BIO_MAX = 500;
const MAX_BIO_HTML = 8000;

/**
 * Profile endpoint — lets a signed-in user set the display name that the rest of
 * the hub shows in place of their email. The name is written to user_metadata via
 * the Admin API (service-role), so the browser can't smuggle in an unvalidated
 * name by calling supabase.auth.updateUser directly — this is the only path that
 * sets it, and it validates length, profanity and name bans first.
 *
 *   POST /profile/display-name   Bearer  { displayName }  -> { displayName }
 *   POST /profile/bio            Bearer  { bio }          -> { bio }
 *
 * On success the display-name route also backfills the caller's existing
 * lessons/comments so any name they posted under previously (including an email
 * captured before this feature) is overwritten with the chosen display name. The
 * bio is profile-only (not denormalised onto rows), so it needs no backfill.
 */
export async function handleProfile(request, env, url, cors) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
		return textResponse('Server misconfiguration: Supabase is not configured', 500, cors);
	}
	const base = env.SUPABASE_URL.replace(/\/$/, '');
	const path = url.pathname.replace(/\/$/, '');

	if (request.method === 'POST' && path === '/profile/display-name') {
		const user = await verifySupabaseUser(env, bearerToken(request));
		if (!user) return textResponse('Please sign in.', 401, cors);

		let body;
		try {
			body = await request.json();
		} catch (e) {
			return textResponse('Invalid JSON body', 400, cors);
		}
		const name = (body && typeof body.displayName === 'string' ? body.displayName : '').replace(/\s+/g, ' ').trim();
		if (name.length < DISPLAY_NAME_MIN) {
			return textResponse(`Please use at least ${DISPLAY_NAME_MIN} characters.`, 400, cors);
		}
		if (name.length > DISPLAY_NAME_MAX) {
			return textResponse(`Display names are limited to ${DISPLAY_NAME_MAX} characters.`, 400, cors);
		}
		if (profanityFilter.checkProfanity(name).containsProfanity) {
			return textResponse('That display name isn’t allowed. Please choose another.', 422, cors);
		}
		if (await isNameBanned(env, base, name)) {
			return textResponse('That display name isn’t available. Please choose another.', 409, cors);
		}

		// Write the name into user_metadata, preserving any other metadata keys.
		const merged = { ...(user.user_metadata || {}), display_name: name };
		let res;
		try {
			res = await fetch(`${base}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, {
				method: 'PUT',
				headers: { ...supabaseHeaders(env), 'Content-Type': 'application/json' },
				body: JSON.stringify({ user_metadata: merged }),
			});
		} catch (e) {
			return textResponse('Could not save your display name.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not save your display name.', 502, cors);

		// Backfill the denormalised author label on the caller's own past content so
		// an older email (or previous name) is replaced everywhere it was shown.
		// Best-effort: the metadata update above is what actually matters.
		const patch = JSON.stringify({ author: name });
		for (const table of ['lessons', 'comments']) {
			try {
				await fetch(`${base}/rest/v1/${table}?author_id=eq.${encodeURIComponent(user.id)}`, {
					method: 'PATCH',
					headers: { ...supabaseHeaders(env), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
					body: patch,
				});
			} catch (e) {
				// Ignore — the name is set; the backfill can be retried by re-saving.
			}
		}

		return jsonResponse({ displayName: name }, 200, cors);
	}

	// POST /profile/bio — set (or clear) the caller's public "about me", shown on
	// their profile page. Like the display name, it's written to user_metadata via
	// the Admin API so the browser can't store an unvalidated bio: we cap the length
	// and run it through the same profanity filter. An empty string clears it.
	if (request.method === 'POST' && path === '/profile/bio') {
		const user = await verifySupabaseUser(env, bearerToken(request));
		if (!user) return textResponse('Please sign in.', 401, cors);

		let body;
		try {
			body = await request.json();
		} catch (e) {
			return textResponse('Invalid JSON body', 400, cors);
		}
		const raw = (body && typeof body.bio === 'string' ? body.bio : '').trim();
		if (raw.length > MAX_BIO_HTML) {
			return textResponse(`Bios are limited to ${BIO_MAX} characters.`, 400, cors);
		}

		// Sanitize first, then judge the result: length and profanity are checked
		// against the words the user wrote, not the markup they wrote them in (which
		// would otherwise let tag names pad the length and confuse the filter).
		const bio = await sanitizeRichText(raw);
		const text = richTextToPlain(bio);
		if (text.length > BIO_MAX) {
			return textResponse(`Bios are limited to ${BIO_MAX} characters.`, 400, cors);
		}
		if (text && profanityFilter.checkProfanity(text).containsProfanity) {
			return textResponse('That bio isn’t allowed. Please remove any inappropriate language.', 422, cors);
		}

		// Write the bio into user_metadata, preserving any other metadata keys. A bio
		// with no words left after sanitizing (say, nothing but an image) stores as ''
		// — i.e. it clears the bio, rather than leaving stray empty markup behind.
		const merged = { ...(user.user_metadata || {}), bio: text ? bio : '' };
		let res;
		try {
			res = await fetch(`${base}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, {
				method: 'PUT',
				headers: { ...supabaseHeaders(env), 'Content-Type': 'application/json' },
				body: JSON.stringify({ user_metadata: merged }),
			});
		} catch (e) {
			return textResponse('Could not save your bio.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not save your bio.', 502, cors);

		// Hand back exactly what was stored — the sanitized HTML, which may differ from
		// what was sent — so the profile page renders the truth without a refetch.
		return jsonResponse({ bio: merged.bio }, 200, cors);
	}

	return textResponse('Not found.', 404, cors);
}
