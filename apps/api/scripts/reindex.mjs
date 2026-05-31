// One-time (and repeatable) Algolia backfill for the lesson hub.
//
// The Worker keeps the search index in step with Supabase as a side effect of
// the lesson routes — but only going forward: a lesson is indexed when it is
// published, edited, or deleted. Lessons that predate indexing (or any window
// where indexing was misconfigured) are never written, so the index can be
// empty even though the code path is correct. This script closes that gap: it
// reads every lesson from Supabase and pushes them to Algolia in one batch,
// using the SAME record shape the Worker writes (see `algoliaRecord` in
// src/index.js), so a backfilled record is byte-for-byte what a fresh publish
// would produce. It also applies the index settings (search title + author,
// rank ties newest-first) the hub relies on.
//
// It is safe to re-run: every record is addressed by its lesson id (objectID),
// so each run upserts rather than duplicates.
//
// Usage (from apps/api):
//   SUPABASE_URL=... \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//   ALGOLIA_APP_ID=... \
//   ALGOLIA_ADMIN_KEY=... \
//   ALGOLIA_INDEX_NAME=lessons \
//   node scripts/reindex.mjs
//
// SUPABASE_URL / ALGOLIA_APP_ID / ALGOLIA_INDEX_NAME match the Worker's
// wrangler.jsonc vars; SUPABASE_SERVICE_ROLE_KEY and ALGOLIA_ADMIN_KEY are the
// Worker's secrets — pass them in the environment, never commit them.

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY, ALGOLIA_INDEX_NAME = 'lessons' } = process.env;

function requireEnv(name, value) {
	if (!value) {
		console.error(`Missing required env var: ${name}`);
		process.exit(1);
	}
}

requireEnv('SUPABASE_URL', SUPABASE_URL);
requireEnv('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY);
requireEnv('ALGOLIA_APP_ID', ALGOLIA_APP_ID);
requireEnv('ALGOLIA_ADMIN_KEY', ALGOLIA_ADMIN_KEY);

const supabaseBase = SUPABASE_URL.replace(/\/$/, '');
const algoliaHeaders = {
	'X-Algolia-Application-Id': ALGOLIA_APP_ID,
	'X-Algolia-API-Key': ALGOLIA_ADMIN_KEY,
	'Content-Type': 'application/json',
};

// Mirror of the Worker's `algoliaRecord` (src/index.js): objectID is the lesson
// id so this upserts the same record a live publish/edit would, and createdAtTs
// is a numeric mirror of createdAt for custom ranking (Algolia can't sort on an
// ISO string).
function algoliaRecord(row) {
	return {
		objectID: row.id,
		title: row.title || 'Untitled Lesson',
		author: row.author || 'Anonymous',
		authorId: row.author_id,
		sectionCount: row.section_count ?? 0,
		createdAt: row.created_at,
		createdAtTs: row.created_at ? Date.parse(row.created_at) || 0 : 0,
	};
}

// Read every lesson summary from Supabase, paging through in case the hub has
// grown past PostgREST's default cap.
async function fetchAllLessons() {
	const PAGE = 1000;
	const rows = [];
	for (let offset = 0; ; offset += PAGE) {
		const query = `select=id,author_id,title,author,section_count,created_at&order=created_at.desc&limit=${PAGE}&offset=${offset}`;
		const res = await fetch(`${supabaseBase}/rest/v1/lessons?${query}`, {
			headers: {
				apikey: SUPABASE_SERVICE_ROLE_KEY,
				Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
			},
		});
		if (!res.ok) {
			throw new Error(`Supabase read failed: ${res.status} ${await res.text().catch(() => '')}`);
		}
		const page = await res.json();
		rows.push(...page);
		if (page.length < PAGE) break;
	}
	return rows;
}

// Apply the index settings the hub relies on: only title + author are matched,
// and ties are ranked newest-first. These mirror the README's one-time setup.
async function applySettings() {
	const res = await fetch(`https://${ALGOLIA_APP_ID}.algolia.net/1/indexes/${encodeURIComponent(ALGOLIA_INDEX_NAME)}/settings`, {
		method: 'PUT',
		headers: algoliaHeaders,
		body: JSON.stringify({
			searchableAttributes: ['title', 'author'],
			customRanking: ['desc(createdAtTs)'],
		}),
	});
	if (!res.ok) {
		throw new Error(`Algolia settings update failed: ${res.status} ${await res.text().catch(() => '')}`);
	}
}

// Upsert the records with a single batch call (chunked to stay well within
// Algolia's per-request limits). `updateObject` adds or replaces by objectID.
async function batchUpsert(records) {
	const CHUNK = 1000;
	for (let i = 0; i < records.length; i += CHUNK) {
		const slice = records.slice(i, i + CHUNK);
		const res = await fetch(`https://${ALGOLIA_APP_ID}.algolia.net/1/indexes/${encodeURIComponent(ALGOLIA_INDEX_NAME)}/batch`, {
			method: 'POST',
			headers: algoliaHeaders,
			body: JSON.stringify({
				requests: slice.map((body) => ({ action: 'updateObject', body })),
			}),
		});
		if (!res.ok) {
			throw new Error(`Algolia batch failed: ${res.status} ${await res.text().catch(() => '')}`);
		}
		console.log(`Upserted ${Math.min(i + CHUNK, records.length)}/${records.length}`);
	}
}

async function main() {
	console.log(`Reindexing "${ALGOLIA_INDEX_NAME}" (app ${ALGOLIA_APP_ID})…`);
	const rows = await fetchAllLessons();
	console.log(`Read ${rows.length} lesson(s) from Supabase.`);

	await applySettings();
	console.log('Applied index settings (searchableAttributes: title, author; customRanking: desc(createdAtTs)).');

	if (rows.length === 0) {
		console.log('No lessons to index — done.');
		return;
	}
	await batchUpsert(rows.map(algoliaRecord));
	console.log('Done.');
}

main().catch((err) => {
	console.error(err.message || err);
	process.exit(1);
});
