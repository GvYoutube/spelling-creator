// Dynamic SEO endpoints: a sitemap covering the static pages plus one URL per
// published lesson (and one per distinct author), and a robots.txt that points
// crawlers at it.

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
