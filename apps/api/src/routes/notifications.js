// Notification endpoints, backed by Supabase Postgres. A user sees notifications
// addressed to their auth id OR to their email (the email match lets a "send
// link" reach someone before we know their id). Writes go through the
// service-role key like the rest of the API.

import { supabaseHeaders, verifySupabaseUser } from '../lib/supabase.js';
import { authorFromUser } from '../lib/auth.js';
import { profanityFilter } from '../lib/profanity.js';
import { textResponse, jsonResponse } from '../lib/http.js';

// The longest "send link" message we accept.
const MAX_NOTIFICATION_MESSAGE_LENGTH = 1000;

// A minimal email shape check for the "send link" recipient. Real delivery is to
// whoever signs in with this email, so this only guards obviously-invalid input.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Map a Supabase `notifications` row to the camelCase shape the frontend expects.
 */
function rowToNotification(row) {
	return {
		id: row.id,
		type: row.type,
		title: row.title,
		body: row.body,
		link: row.link,
		read: row.read,
		createdAt: row.created_at,
	};
}

/**
 * Insert a notification row via the service-role REST API and return the fetch
 * Response (with the created row when Prefer: return=representation succeeds).
 * `recipient` is { userId?, email? }: at least one identifies who receives it —
 * `userId` when we know the auth id (e.g. a lesson's author), `email` when we
 * only have an address (e.g. a link sent to someone who may not have signed in
 * yet). Callers that create notifications as a side effect wrap this in try/catch
 * so a notification failure never fails the primary action.
 */
export async function createNotification(env, base, { userId, email, type, title, body, link }) {
	const insert = {
		user_id: userId || null,
		recipient_email: email ? email.trim().toLowerCase() : null,
		type,
		title,
		body: body || null,
		link: link || null,
	};
	return fetch(`${base}/rest/v1/notifications?select=id,type,title,body,link,read,created_at`, {
		method: 'POST',
		headers: {
			...supabaseHeaders(env),
			'Content-Type': 'application/json',
			Prefer: 'return=representation',
		},
		body: JSON.stringify(insert),
	});
}

/**
 * Notification endpoints, backed by Supabase Postgres. Every route requires a
 * verified Supabase session. A user sees notifications addressed to their auth id
 * OR to their email — the email match lets a "send link" reach someone before we
 * know their id. Writes go through the service-role key like the rest of the API.
 *
 *   GET  /notifications            Bearer -> { notifications: Notification[] }   (newest first)
 *   POST /notifications/read       Bearer -> { ok: true }            (body { id? }: one, or all)
 *   POST /notifications/send-link  Bearer -> { notification }        (body { email, link, message? })
 *
 * Errors are short plain-text reasons so the frontend can surface res.text().
 */
export async function handleNotifications(request, env, url, cors) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
		return textResponse('Server misconfiguration: Supabase is not configured', 500, cors);
	}

	const auth = request.headers.get('Authorization') || '';
	const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
	const user = await verifySupabaseUser(env, token);
	if (!user) return textResponse('Please sign in to view notifications.', 401, cors);

	const base = env.SUPABASE_URL.replace(/\/$/, '');
	const email = (user.email || '').trim().toLowerCase();
	// A notification reaches the user if it targets their id or their email.
	const audience = `or=(user_id.eq.${user.id},recipient_email.eq.${email})`;
	const path = url.pathname.replace(/\/$/, '');

	// GET /notifications — the signed-in user's notifications, newest first.
	if (request.method === 'GET' && path === '/notifications') {
		let res;
		try {
			res = await fetch(
				`${base}/rest/v1/notifications?${audience}&select=id,type,title,body,link,read,created_at&order=created_at.desc&limit=100`,
				{ headers: supabaseHeaders(env) },
			);
		} catch (e) {
			return textResponse('Could not reach the notification store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not load notifications.', 502, cors);
		const rows = await res.json().catch(() => []);
		const notifications = (Array.isArray(rows) ? rows : []).map(rowToNotification);
		return jsonResponse({ notifications }, 200, cors);
	}

	// POST /notifications/read — mark one (body.id) or all of the user's unread
	// notifications as read. The audience filter scopes the update to the caller's
	// own notifications, so an id they don't own matches nothing.
	if (request.method === 'POST' && path === '/notifications/read') {
		let body;
		try {
			body = await request.json();
		} catch (e) {
			body = {};
		}
		const id = body && body.id ? String(body.id) : '';
		const idFilter = id ? `&id=eq.${encodeURIComponent(id)}` : '';
		let res;
		try {
			res = await fetch(`${base}/rest/v1/notifications?${audience}${idFilter}&read=eq.false`, {
				method: 'PATCH',
				headers: { ...supabaseHeaders(env), 'Content-Type': 'application/json' },
				body: JSON.stringify({ read: true }),
			});
		} catch (e) {
			return textResponse('Could not reach the notification store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not update notifications.', 502, cors);
		return jsonResponse({ ok: true }, 200, cors);
	}

	// POST /notifications/send-link — send a link to a user identified by email.
	// It appears in that user's notifications the next time they load them. The
	// sender is taken from the verified session, never from the request body.
	if (request.method === 'POST' && path === '/notifications/send-link') {
		let body;
		try {
			body = await request.json();
		} catch (e) {
			return textResponse('Invalid JSON body', 400, cors);
		}
		const recipient = (body && body.email ? String(body.email) : '').trim().toLowerCase();
		const link = (body && body.link ? String(body.link) : '').trim();
		const message = (body && body.message ? String(body.message) : '').trim();

		if (!EMAIL_RE.test(recipient)) {
			return textResponse('Enter a valid email address.', 400, cors);
		}
		if (!link) return textResponse('Enter a link to send.', 400, cors);
		let linkUrl;
		try {
			linkUrl = new URL(link);
		} catch (e) {
			return textResponse('Enter a valid link (including http:// or https://).', 400, cors);
		}
		if (linkUrl.protocol !== 'http:' && linkUrl.protocol !== 'https:') {
			return textResponse('Links must start with http:// or https://.', 400, cors);
		}
		if (message.length > MAX_NOTIFICATION_MESSAGE_LENGTH) {
			return textResponse(`Messages are limited to ${MAX_NOTIFICATION_MESSAGE_LENGTH} characters.`, 400, cors);
		}
		// Moderate the optional message like comments — done server-side so it
		// can't be bypassed by a crafted client request.
		if (message && profanityFilter.checkProfanity(message).containsProfanity) {
			return textResponse('This message contains language that isn’t allowed. Please revise it and try again.', 422, cors);
		}

		let res;
		try {
			res = await createNotification(env, base, {
				email: recipient,
				type: 'link',
				title: `${authorFromUser(user)} sent you a link`,
				body: message || null,
				link: linkUrl.toString(),
			});
		} catch (e) {
			return textResponse('Could not reach the notification store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not send the link.', 502, cors);
		const rows = await res.json().catch(() => []);
		if (!Array.isArray(rows) || rows.length === 0) {
			return textResponse('Could not send the link.', 502, cors);
		}
		return jsonResponse({ notification: rowToNotification(rows[0]) }, 201, cors);
	}

	return textResponse('Method not allowed.', 405, cors);
}
