// Lesson star-rating helpers, backed by the Supabase `ratings` table (see
// schema.sql). A rating is 1–5 stars, one row per user per lesson. Ratings are
// submitted alongside a comment (see routes/comments.js) and their per-lesson
// average is surfaced on the single-lesson read (see routes/lessons.js).

import { supabaseHeaders } from './supabase.js';

/**
 * Average star rating (1–5) for a lesson and how many ratings it has, read from
 * the ratings table. Returns { average: number|null, count: number } — average
 * is null when the lesson has no ratings yet, otherwise rounded to two decimals.
 * Any store error degrades to "no ratings" rather than failing the caller, since
 * this only decorates a lesson read.
 */
export async function fetchRatingStats(env, base, lessonId) {
	const query = `lesson_id=eq.${encodeURIComponent(lessonId)}&select=stars`;
	let res;
	try {
		res = await fetch(`${base}/rest/v1/ratings?${query}`, { headers: supabaseHeaders(env) });
	} catch (e) {
		return { average: null, count: 0 };
	}
	if (!res.ok) return { average: null, count: 0 };
	const rows = await res.json().catch(() => []);
	const stars = (Array.isArray(rows) ? rows : []).map((r) => r.stars).filter((n) => typeof n === 'number');
	if (stars.length === 0) return { average: null, count: 0 };
	const sum = stars.reduce((a, b) => a + b, 0);
	return { average: Math.round((sum / stars.length) * 100) / 100, count: stars.length };
}

/**
 * Upsert the caller's rating for a lesson: one row per (lesson_id, author_id), so
 * re-rating updates the star count rather than adding a second vote. `stars` must
 * be an integer 1–5 (validated by the caller). Returns true on success; a failure
 * is non-fatal to the comment it accompanied, so the caller can ignore it.
 */
export async function upsertRating(env, base, lessonId, userId, stars) {
	let res;
	try {
		res = await fetch(`${base}/rest/v1/ratings?on_conflict=lesson_id,author_id`, {
			method: 'POST',
			headers: {
				...supabaseHeaders(env),
				'Content-Type': 'application/json',
				// Merge onto the composite PK: an existing rating is overwritten.
				Prefer: 'resolution=merge-duplicates',
			},
			body: JSON.stringify({ lesson_id: lessonId, author_id: userId, stars }),
		});
	} catch (e) {
		return false;
	}
	return res.ok;
}
