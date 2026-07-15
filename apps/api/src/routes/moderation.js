// Moderation endpoints — the privileged layer on top of the lesson hub. Every
// route re-derives the caller's role from public.user_roles server-side (the
// client's claim of being a mod/admin is never trusted), then gates on it.

import { supabaseHeaders, getAuthUserById, findAuthUserByEmail } from '../lib/supabase.js';
import { getUserRole, isModeratorRole, verifyUserAndRole } from '../lib/auth.js';
import { rowToLesson, fullyDeleteLesson } from '../lib/lesson.js';
import { textResponse, jsonResponse } from '../lib/http.js';

/**
 * Moderation endpoints — the privileged layer on top of the lesson hub. Every
 * route re-derives the caller's role from public.user_roles server-side (the
 * client's claim of being a mod/admin is never trusted), then gates on it:
 * "mod+" routes need moderator or admin; "admin" routes need admin.
 *
 *   GET    /mod/whoami                            any signed-in -> { role }
 *   DELETE /mod/comments/:id                      mod+   delete a comment (replies cascade)
 *   POST   /mod/lessons/:id/shadowban             mod+   { shadowbanned } hide/show a lesson
 *   POST   /mod/lessons/:id/delete-request        mod+   { reason } ask an admin to delete
 *   GET    /mod/lessons/shadowbanned              mod+   list shadowbanned lessons
 *   DELETE /mod/lessons/:id                       admin  fully delete a lesson
 *   GET    /mod/delete-requests                   admin  pending deletion requests
 *   POST   /mod/delete-requests/:id/approve       admin  delete the lesson + resolve
 *   POST   /mod/delete-requests/:id/deny          admin  resolve without deleting
 *   GET    /mod/bans                              mod+   name bans (+ ip bans for admin)
 *   POST   /mod/bans/name                         mod+   { name } ban a display name
 *   DELETE /mod/bans/name/:nameLower              mod+   lift a name ban
 *   POST   /mod/bans/ip                           admin  { ip, reason? } ban an address
 *   DELETE /mod/bans/ip/:ip                       admin  lift an ip ban
 *   GET    /mod/moderators                        admin  list moderators
 *   POST   /mod/moderators                        admin  { email } add a moderator
 *   DELETE /mod/moderators/:userId                admin  remove a moderator
 *
 * Named "/mod", not "/moderation", so it can't collide with the SPA's own
 * "/moderation" page route — see the registration comment in index.js.
 *
 * Errors are short plain-text reasons, matching the rest of the API.
 */
export async function handleModeration(request, env, url, cors) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
		return textResponse('Server misconfiguration: Supabase is not configured', 500, cors);
	}
	const base = env.SUPABASE_URL.replace(/\/$/, '');
	const method = request.method;

	// Path under "/mod", split into decoded segments.
	const rest = url.pathname.replace(/\/$/, '').slice('/mod'.length);
	const seg = rest
		.split('/')
		.filter(Boolean)
		.map((s) => decodeURIComponent(s));

	// Every route needs a verified caller; derive their role once up front.
	const { user, role } = await verifyUserAndRole(env, base, request);
	if (!user) return textResponse('Please sign in.', 401, cors);

	// Tier gates: return a Response on failure, null when the caller may proceed.
	const denyMod = () => (isModeratorRole(role) ? null : textResponse('Moderator access required.', 403, cors));
	const denyAdmin = () => (role === 'admin' ? null : textResponse('Admin access required.', 403, cors));
	const readJson = async () => {
		try {
			return await request.json();
		} catch (e) {
			return null;
		}
	};
	const nowIso = () => new Date().toISOString();

	// GET /mod/whoami — any signed-in user learns their own tier.
	if (method === 'GET' && seg.length === 1 && seg[0] === 'whoami') {
		return jsonResponse({ role: role || null }, 200, cors);
	}

	// DELETE /mod/comments/:id — mod+ removes any comment; its replies go
	// with it via the comments.parent_id ON DELETE CASCADE.
	if (method === 'DELETE' && seg.length === 2 && seg[0] === 'comments') {
		const denied = denyMod();
		if (denied) return denied;
		let res;
		try {
			res = await fetch(`${base}/rest/v1/comments?id=eq.${encodeURIComponent(seg[1])}&select=id`, {
				method: 'DELETE',
				headers: { ...supabaseHeaders(env), Prefer: 'return=representation' },
			});
		} catch (e) {
			return textResponse('Could not reach the comment store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not delete the comment.', 502, cors);
		const rows = await res.json().catch(() => []);
		if (!Array.isArray(rows) || rows.length === 0) return textResponse('Comment not found.', 404, cors);
		return jsonResponse({ ok: true }, 200, cors);
	}

	// GET /mod/lessons/shadowbanned — mod+ lists currently hidden lessons.
	if (method === 'GET' && seg.length === 2 && seg[0] === 'lessons' && seg[1] === 'shadowbanned') {
		const denied = denyMod();
		if (denied) return denied;
		let res;
		try {
			res = await fetch(
				`${base}/rest/v1/lessons?shadowbanned=eq.true&select=id,author_id,title,author,section_count,published,shadowbanned,created_at&order=created_at.desc`,
				{ headers: supabaseHeaders(env) },
			);
		} catch (e) {
			return textResponse('Could not reach the lesson store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not load lessons.', 502, cors);
		const rows = await res.json().catch(() => []);
		const lessons = (Array.isArray(rows) ? rows : []).map((r) => rowToLesson(r, false));
		return jsonResponse({ lessons }, 200, cors);
	}

	// POST /mod/lessons/:id/shadowban — mod+ toggles a lesson's visibility.
	if (method === 'POST' && seg.length === 3 && seg[0] === 'lessons' && seg[2] === 'shadowban') {
		const denied = denyMod();
		if (denied) return denied;
		const body = await readJson();
		if (!body || typeof body.shadowbanned !== 'boolean') {
			return textResponse('Provide a boolean "shadowbanned".', 400, cors);
		}
		let res;
		try {
			res = await fetch(
				`${base}/rest/v1/lessons?id=eq.${encodeURIComponent(seg[1])}&select=id,author_id,title,author,section_count,published,shadowbanned,author_ip,created_at`,
				{
					method: 'PATCH',
					headers: { ...supabaseHeaders(env), 'Content-Type': 'application/json', Prefer: 'return=representation' },
					body: JSON.stringify({ shadowbanned: body.shadowbanned }),
				},
			);
		} catch (e) {
			return textResponse('Could not reach the lesson store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not update the lesson.', 502, cors);
		const rows = await res.json().catch(() => []);
		if (!Array.isArray(rows) || rows.length === 0) return textResponse('Lesson not found.', 404, cors);
		return jsonResponse({ lesson: rowToLesson(rows[0], false, true) }, 200, cors);
	}

	// POST /mod/lessons/:id/delete-request — a moderator asks an admin to
	// fully delete a lesson (mods can't delete lessons themselves).
	if (method === 'POST' && seg.length === 3 && seg[0] === 'lessons' && seg[2] === 'delete-request') {
		const denied = denyMod();
		if (denied) return denied;
		const body = await readJson();
		const reason = body && typeof body.reason === 'string' ? body.reason.trim().slice(0, 1000) : '';
		const insert = { lesson_id: seg[1], requested_by: user.id, reason: reason || null };
		let res;
		try {
			res = await fetch(`${base}/rest/v1/lesson_delete_requests?select=id,lesson_id,reason,status,created_at`, {
				method: 'POST',
				headers: { ...supabaseHeaders(env), 'Content-Type': 'application/json', Prefer: 'return=representation' },
				body: JSON.stringify(insert),
			});
		} catch (e) {
			return textResponse('Could not reach the lesson store.', 502, cors);
		}
		// A bad lesson id violates the FK — surface it as a 404 rather than a 502.
		if (res.status === 409 || res.status === 400) return textResponse('Lesson not found.', 404, cors);
		if (!res.ok) return textResponse('Could not file the request.', 502, cors);
		const rows = await res.json().catch(() => []);
		return jsonResponse({ request: Array.isArray(rows) ? rows[0] : null }, 201, cors);
	}

	// DELETE /mod/lessons/:id — admin fully deletes any lesson.
	if (method === 'DELETE' && seg.length === 2 && seg[0] === 'lessons') {
		const denied = denyAdmin();
		if (denied) return denied;
		const ok = await fullyDeleteLesson(env, base, seg[1]);
		if (!ok) return textResponse('Lesson not found.', 404, cors);
		return jsonResponse({ ok: true }, 200, cors);
	}

	// GET /mod/delete-requests — admin reviews pending deletion requests,
	// each embedded with its lesson's title/author for context.
	if (method === 'GET' && seg.length === 1 && seg[0] === 'delete-requests') {
		const denied = denyAdmin();
		if (denied) return denied;
		let res;
		try {
			res = await fetch(
				`${base}/rest/v1/lesson_delete_requests?status=eq.pending&select=id,lesson_id,reason,status,created_at,lesson:lessons(title,author)&order=created_at.desc`,
				{ headers: supabaseHeaders(env) },
			);
		} catch (e) {
			return textResponse('Could not reach the lesson store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not load requests.', 502, cors);
		const rows = await res.json().catch(() => []);
		const requests = (Array.isArray(rows) ? rows : []).map((r) => ({
			id: r.id,
			lessonId: r.lesson_id,
			reason: r.reason || '',
			status: r.status,
			createdAt: r.created_at,
			lessonTitle: r.lesson ? r.lesson.title : null,
			lessonAuthor: r.lesson ? r.lesson.author : null,
		}));
		return jsonResponse({ requests }, 200, cors);
	}

	// POST /mod/delete-requests/:id/approve | /deny — admin resolves a
	// request. Approving deletes the lesson; either way the request is marked
	// resolved with the admin's id and timestamp.
	if (method === 'POST' && seg.length === 3 && seg[0] === 'delete-requests' && (seg[2] === 'approve' || seg[2] === 'deny')) {
		const denied = denyAdmin();
		if (denied) return denied;
		const reqId = seg[1];
		// Read the pending request so we know which lesson to delete on approve.
		let lookRes;
		try {
			lookRes = await fetch(
				`${base}/rest/v1/lesson_delete_requests?id=eq.${encodeURIComponent(reqId)}&status=eq.pending&select=id,lesson_id&limit=1`,
				{ headers: supabaseHeaders(env) },
			);
		} catch (e) {
			return textResponse('Could not reach the lesson store.', 502, cors);
		}
		const lookRows = lookRes.ok ? await lookRes.json().catch(() => []) : [];
		if (!Array.isArray(lookRows) || lookRows.length === 0) {
			return textResponse('Request not found or already resolved.', 404, cors);
		}
		if (seg[2] === 'approve') {
			await fullyDeleteLesson(env, base, lookRows[0].lesson_id);
		}
		const patch = { status: seg[2] === 'approve' ? 'approved' : 'denied', resolved_by: user.id, resolved_at: nowIso() };
		try {
			await fetch(`${base}/rest/v1/lesson_delete_requests?id=eq.${encodeURIComponent(reqId)}`, {
				method: 'PATCH',
				headers: { ...supabaseHeaders(env), 'Content-Type': 'application/json' },
				body: JSON.stringify(patch),
			});
		} catch (e) {
			return textResponse('Could not resolve the request.', 502, cors);
		}
		return jsonResponse({ ok: true }, 200, cors);
	}

	// GET /mod/bans — name bans for any mod; admins also see ip bans.
	if (method === 'GET' && seg.length === 1 && seg[0] === 'bans') {
		const denied = denyMod();
		if (denied) return denied;
		let names = [];
		try {
			const r = await fetch(`${base}/rest/v1/banned_names?select=name_lower,display_name,created_at&order=created_at.desc`, {
				headers: supabaseHeaders(env),
			});
			if (r.ok) names = await r.json().catch(() => []);
		} catch (e) {
			return textResponse('Could not load bans.', 502, cors);
		}
		let ips = [];
		if (role === 'admin') {
			try {
				const r = await fetch(`${base}/rest/v1/banned_ips?select=ip,reason,created_at&order=created_at.desc`, {
					headers: supabaseHeaders(env),
				});
				if (r.ok) ips = await r.json().catch(() => []);
			} catch (e) {
				return textResponse('Could not load bans.', 502, cors);
			}
		}
		return jsonResponse({ names, ips }, 200, cors);
	}

	// POST /mod/bans/name — mod+ bans a display name (stored normalised).
	if (method === 'POST' && seg.length === 2 && seg[0] === 'bans' && seg[1] === 'name') {
		const denied = denyMod();
		if (denied) return denied;
		const body = await readJson();
		const display = body && typeof body.name === 'string' ? body.name.trim() : '';
		const nameLower = display.toLowerCase();
		if (!nameLower) return textResponse('Provide a name to ban.', 400, cors);
		try {
			const r = await fetch(`${base}/rest/v1/banned_names?on_conflict=name_lower`, {
				method: 'POST',
				headers: { ...supabaseHeaders(env), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
				body: JSON.stringify({ name_lower: nameLower, display_name: display, banned_by: user.id }),
			});
			if (!r.ok) return textResponse('Could not ban the name.', 502, cors);
		} catch (e) {
			return textResponse('Could not reach the store.', 502, cors);
		}
		return jsonResponse({ ok: true }, 200, cors);
	}

	// DELETE /mod/bans/name/:nameLower — mod+ lifts a name ban.
	if (method === 'DELETE' && seg.length === 3 && seg[0] === 'bans' && seg[1] === 'name') {
		const denied = denyMod();
		if (denied) return denied;
		try {
			await fetch(`${base}/rest/v1/banned_names?name_lower=eq.${encodeURIComponent(seg[2].toLowerCase())}`, {
				method: 'DELETE',
				headers: supabaseHeaders(env),
			});
		} catch (e) {
			return textResponse('Could not lift the ban.', 502, cors);
		}
		return jsonResponse({ ok: true }, 200, cors);
	}

	// POST /mod/bans/ip — admin bans an IP address.
	if (method === 'POST' && seg.length === 2 && seg[0] === 'bans' && seg[1] === 'ip') {
		const denied = denyAdmin();
		if (denied) return denied;
		const body = await readJson();
		const ip = body && typeof body.ip === 'string' ? body.ip.trim() : '';
		const reason = body && typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
		if (!ip) return textResponse('Provide an IP to ban.', 400, cors);
		try {
			const r = await fetch(`${base}/rest/v1/banned_ips?on_conflict=ip`, {
				method: 'POST',
				headers: { ...supabaseHeaders(env), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
				body: JSON.stringify({ ip, reason: reason || null, banned_by: user.id }),
			});
			if (!r.ok) return textResponse('Could not ban the IP.', 502, cors);
		} catch (e) {
			return textResponse('Could not reach the store.', 502, cors);
		}
		return jsonResponse({ ok: true }, 200, cors);
	}

	// DELETE /mod/bans/ip/:ip — admin lifts an IP ban.
	if (method === 'DELETE' && seg.length === 3 && seg[0] === 'bans' && seg[1] === 'ip') {
		const denied = denyAdmin();
		if (denied) return denied;
		try {
			await fetch(`${base}/rest/v1/banned_ips?ip=eq.${encodeURIComponent(seg[2])}`, {
				method: 'DELETE',
				headers: supabaseHeaders(env),
			});
		} catch (e) {
			return textResponse('Could not lift the ban.', 502, cors);
		}
		return jsonResponse({ ok: true }, 200, cors);
	}

	// GET /mod/moderators — admin lists moderators with their emails.
	if (method === 'GET' && seg.length === 1 && seg[0] === 'moderators') {
		const denied = denyAdmin();
		if (denied) return denied;
		let rows = [];
		try {
			const r = await fetch(`${base}/rest/v1/user_roles?role=eq.moderator&select=user_id,granted_by,created_at&order=created_at.desc`, {
				headers: supabaseHeaders(env),
			});
			if (r.ok) rows = await r.json().catch(() => []);
		} catch (e) {
			return textResponse('Could not load moderators.', 502, cors);
		}
		const moderators = await Promise.all(
			(Array.isArray(rows) ? rows : []).map(async (row) => {
				const u = await getAuthUserById(env, row.user_id);
				return { userId: row.user_id, email: u ? u.email : null, createdAt: row.created_at };
			}),
		);
		return jsonResponse({ moderators }, 200, cors);
	}

	// POST /mod/moderators — admin grants moderator to a user by email.
	if (method === 'POST' && seg.length === 1 && seg[0] === 'moderators') {
		const denied = denyAdmin();
		if (denied) return denied;
		const body = await readJson();
		const email = body && typeof body.email === 'string' ? body.email.trim() : '';
		if (!email) return textResponse('Provide an email.', 400, cors);
		const target = await findAuthUserByEmail(env, email);
		if (!target) return textResponse('No signed-in user with that email was found. Ask them to sign in once first.', 404, cors);
		// Never touch an admin's role: don't demote and don't re-grant.
		const existing = await getUserRole(env, base, target.id);
		if (existing === 'admin') return textResponse('That user is an admin.', 409, cors);
		try {
			const r = await fetch(`${base}/rest/v1/user_roles?on_conflict=user_id`, {
				method: 'POST',
				headers: { ...supabaseHeaders(env), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
				body: JSON.stringify({ user_id: target.id, role: 'moderator', granted_by: user.id }),
			});
			if (!r.ok) return textResponse('Could not add the moderator.', 502, cors);
		} catch (e) {
			return textResponse('Could not reach the store.', 502, cors);
		}
		return jsonResponse({ moderator: { userId: target.id, email: target.email } }, 201, cors);
	}

	// DELETE /mod/moderators/:userId — admin revokes moderator. Filtered to
	// role='moderator' so it can never remove an admin.
	if (method === 'DELETE' && seg.length === 2 && seg[0] === 'moderators') {
		const denied = denyAdmin();
		if (denied) return denied;
		try {
			await fetch(`${base}/rest/v1/user_roles?user_id=eq.${encodeURIComponent(seg[1])}&role=eq.moderator`, {
				method: 'DELETE',
				headers: supabaseHeaders(env),
			});
		} catch (e) {
			return textResponse('Could not remove the moderator.', 502, cors);
		}
		return jsonResponse({ ok: true }, 200, cors);
	}

	return textResponse('Not found.', 404, cors);
}
