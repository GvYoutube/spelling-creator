// Dynamic SEO / discovery endpoints: a sitemap covering the static pages plus one
// URL per published lesson (and one per distinct author), a robots.txt that points
// crawlers at it, and an Atom feed of the latest published lessons ("RSS" in the UI).

import { supabaseHeaders } from '../lib/supabase.js';
import { xmlEscape } from '../lib/xml.js';

/**
 * GET /sitemap.xml — a dynamically generated sitemap covering the static pages
 * (root and /hub) plus one URL per published lesson (/hub/:id). The lesson list
 * comes from the same Supabase query as the public hub listing, so unpublished
 * drafts never leak into the sitemap. Lesson `created_at` becomes <lastmod>.
 *
 * URLs are built from the request's own origin so the sitemap is correct on any
 * host (custom domain or workers.dev). If Supabase is unreachable we still serve
 * the static entries rather than failing the whole sitemap.
 */
export async function handleSitemap(request, env, url) {
	const origin = url.origin;
	const urls = [
		{ loc: `${origin}/`, changefreq: 'weekly', priority: '1.0' },
		{ loc: `${origin}/hub`, changefreq: 'daily', priority: '0.8' },
	];

	if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
		const base = env.SUPABASE_URL.replace(/\/$/, '');
		const query = 'published=eq.true&select=id,author_id,created_at&order=created_at.desc';
		try {
			const res = await fetch(`${base}/rest/v1/lessons?${query}`, { headers: supabaseHeaders(env) });
			if (res.ok) {
				const rows = await res.json().catch(() => []);
				// One entry per published lesson, plus one profile entry per distinct
				// author so user pages are crawlable too.
				const seenAuthors = new Set();
				for (const row of Array.isArray(rows) ? rows : []) {
					if (!row || !row.id) continue;
					const entry = { loc: `${origin}/hub/${encodeURIComponent(row.id)}`, changefreq: 'weekly', priority: '0.6' };
					if (row.created_at) entry.lastmod = new Date(row.created_at).toISOString().slice(0, 10);
					urls.push(entry);
					if (row.author_id && !seenAuthors.has(row.author_id)) {
						seenAuthors.add(row.author_id);
						urls.push({ loc: `${origin}/users/${encodeURIComponent(row.author_id)}`, changefreq: 'weekly', priority: '0.4' });
					}
				}
			}
		} catch (e) {
			// Supabase unreachable: fall back to the static entries already queued.
		}
	}

	const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
	.map((u) => {
		const lines = [`\t\t<loc>${xmlEscape(u.loc)}</loc>`];
		if (u.lastmod) lines.push(`\t\t<lastmod>${u.lastmod}</lastmod>`);
		if (u.changefreq) lines.push(`\t\t<changefreq>${u.changefreq}</changefreq>`);
		if (u.priority) lines.push(`\t\t<priority>${u.priority}</priority>`);
		return `\t<url>\n${lines.join('\n')}\n\t</url>`;
	})
	.join('\n')}
</urlset>`;

	return new Response(body, {
		status: 200,
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
			'Cache-Control': 'public, max-age=3600',
		},
	});
}

/**
 * GET /feed.xml — an Atom 1.0 feed of the most recently published lessons across
 * the whole hub (newest first, capped). Built and escaped exactly like the sitemap
 * and the per-user activity feed in routes/users.js; surfaced in the UI as "RSS"
 * (the terms are used interchangeably here). Visibility matches the public hub
 * listing: published, non-shadowbanned lessons only. The <alternate> links point at
 * the human /hub page and each lesson's /hub/:id page. On a Supabase hiccup we still
 * return a valid, empty-ish feed rather than failing, matching handleSitemap.
 */
export async function handleLessonsFeed(request, env, url, cors) {
	const origin = url.origin;
	const selfUrl = `${origin}/feed.xml`;
	const hubUrl = `${origin}/hub`;
	const entries = [];

	if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
		const base = env.SUPABASE_URL.replace(/\/$/, '');
		const query = 'published=eq.true&shadowbanned=eq.false&select=id,title,author,created_at&order=created_at.desc&limit=50';
		try {
			const res = await fetch(`${base}/rest/v1/lessons?${query}`, { headers: supabaseHeaders(env) });
			if (res.ok) {
				for (const row of (await res.json().catch(() => [])) || []) {
					if (!row || !row.id) continue;
					const title = row.title || 'Untitled Lesson';
					const author = (row.author || '').toString().trim() || 'Anonymous';
					entries.push({
						id: `urn:s2c:lesson:${row.id}`,
						title,
						author,
						link: `${origin}/hub/${encodeURIComponent(row.id)}`,
						summary: `${author} published the lesson “${title}”.`,
						createdAt: row.created_at,
					});
				}
			}
		} catch (e) {
			// Supabase unreachable: serve a valid empty feed rather than failing.
		}
	}

	// The feed's <updated> is the newest entry's timestamp (or epoch if empty).
	const updated = new Date(entries.length && entries[0].createdAt ? entries[0].createdAt : 0).toISOString();

	const body = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
	<title>Spelling Creator — latest lessons</title>
	<subtitle>The most recently published lessons on the hub</subtitle>
	<id>${xmlEscape(hubUrl)}</id>
	<link rel="self" type="application/atom+xml" href="${xmlEscape(selfUrl)}"/>
	<link rel="alternate" type="text/html" href="${xmlEscape(hubUrl)}"/>
	<updated>${updated}</updated>
${entries
	.map((e) => {
		const ts = new Date(e.createdAt || 0).toISOString();
		return `	<entry>
		<id>${xmlEscape(e.id)}</id>
		<title>${xmlEscape(e.title)}</title>
		<link rel="alternate" type="text/html" href="${xmlEscape(e.link)}"/>
		<updated>${ts}</updated>
		<published>${ts}</published>
		<author><name>${xmlEscape(e.author)}</name></author>
		<summary>${xmlEscape(e.summary)}</summary>
	</entry>`;
	})
	.join('\n')}
</feed>`;

	const headers = new Headers(cors);
	headers.set('Content-Type', 'application/atom+xml; charset=utf-8');
	headers.set('Cache-Control', 'public, max-age=3600');
	return new Response(body, { status: 200, headers });
}

/**
 * GET /robots.txt — allow all crawlers and advertise the dynamic sitemap. The
 * Sitemap URL is built from the request's own origin so it stays correct on any
 * host (custom domain or workers.dev).
 */
export function handleRobots(request, env, url) {
	const body = `User-agent: *\nAllow: /\n\nSitemap: ${url.origin}/sitemap.xml\nDisallow: /moderation\n`;
	return new Response(body, {
		status: 200,
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'public, max-age=86400',
		},
	});
}
