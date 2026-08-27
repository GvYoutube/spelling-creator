// Build the platform services (src/platform/) for a Node process, from ordinary
// environment variables.
//
// This is the whole of "adding a host" as the seam describes it: one function
// returning the shape `platform(env)` expects, put on `env.PLATFORM` before the
// first request. There is no detection and no registry — a host knows what it is.
//
// Each store is null when unconfigured, which is the same thing an absent
// Cloudflare binding means, and the routes already handle it: an instance with no
// object storage serves the hub and refuses image uploads with a clear 500,
// rather than failing to start.

import { noopCache } from '../platform/cache.js';
import { postgrestKv } from '../platform/postgrestKv.js';
import { s3Blobs } from '../platform/s3.js';

/**
 * Read the S3 credentials shared by both buckets, or null when object storage
 * isn't configured.
 */
function s3Config(env) {
	const endpoint = env.S3_ENDPOINT;
	const accessKeyId = env.S3_ACCESS_KEY_ID;
	const secretAccessKey = env.S3_SECRET_ACCESS_KEY;
	if (!endpoint || !accessKeyId || !secretAccessKey) return null;
	return {
		endpoint,
		accessKeyId,
		secretAccessKey,
		sessionToken: env.S3_SESSION_TOKEN || undefined,
		// us-east-1 is what MinIO and Garage expect when they don't care, and is
		// the conventional placeholder for S3 implementations without regions.
		region: env.S3_REGION || 'us-east-1',
		// Path style by default: MinIO and Garage serve it without wildcard DNS.
		// AWS wants the other one.
		forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
	};
}

/**
 * The IP a request arrived from, according to this deployment's proxy.
 *
 * `x-forwarded-for` is a list, appended to by each hop, and the *client* can put
 * anything at the front — so the trustworthy entry is the one the nearest proxy
 * added, counting from the right. `TRUSTED_PROXY_COUNT` says how many hops sit
 * in front of this process; with the default of 1 (one reverse proxy) that is the
 * last entry. Set it higher behind a CDN plus a proxy.
 *
 * This matters because the IP is used for bans and rate limits. Reading the
 * leftmost entry — the usual mistake — lets any caller forge both.
 *
 * `TRUSTED_PROXY_COUNT=0` means what it says: nothing in front of this process,
 * so *every* entry in the header was written by the caller and none of it may be
 * believed. The answer is then no IP at all, which the callers already handle —
 * IP bans stop matching and the rate limiter shares one bucket. That is the
 * honest reading of a directly-exposed process, and much better than the
 * alternative it replaces, where flooring the count at 1 quietly trusted a
 * header a client had just made up.
 */
function clientIpFrom(env) {
	const header = (env.CLIENT_IP_HEADER || 'x-forwarded-for').toLowerCase();
	// Read without `||`, which would fold an explicit 0 into the default. An unset
	// or blank value is the default of 1; anything that isn't a whole number of
	// hops falls back to it too, since a typo should not quietly turn the header
	// off — only the literal 0 does that, and only on purpose.
	const setting = String(env.TRUSTED_PROXY_COUNT ?? '').trim();
	const configured = setting === '' ? 1 : Number(setting);
	const hops = Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : 1;
	return (request) => {
		if (hops === 0) return '';
		const raw = request.headers.get(header) || '';
		if (!raw) return '';
		// A single-value header (Cloudflare's cf-connecting-ip, nginx's
		// x-real-ip) has no list to index into.
		if (header !== 'x-forwarded-for') return raw.trim();
		const parts = raw
			.split(',')
			.map((part) => part.trim())
			.filter(Boolean);
		return parts[Math.max(0, parts.length - hops)] || '';
	};
}

/**
 * The platform services for a Node deployment.
 *
 * @param {Record<string, string | undefined>} env Usually `process.env`.
 */
export function nodePlatform(env) {
	const s3 = s3Config(env);
	// Both buckets share credentials and endpoint; only the bucket name differs.
	// Two buckets rather than prefixes in one because that is how the Cloudflare
	// deployment is arranged, and keeping them the same shape means a migration
	// between hosts is a copy rather than a rename.
	const bucket = (name) => (s3 && name ? s3Blobs({ ...s3, bucket: name }) : null);

	const kv =
		env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
			? postgrestKv({ url: env.SUPABASE_URL, apiKey: env.SUPABASE_SERVICE_ROLE_KEY })
			: null;

	return {
		images: bucket(env.S3_BUCKET_IMAGES),
		lessonGit: bucket(env.S3_BUCKET_GIT),
		// One table serves both roles, as one KV namespace could have: the keys are
		// prefixed and the lifetimes are similar. They stay separate names in the
		// seam because a host that wanted to split them should be able to.
		rateLimit: kv,
		oauthState: kv,
		// Nothing in-process: a reverse proxy in front of this does the job
		// properly, with a shared store and eviction, where a Map here would hold
		// a copy per worker process and grow without bound. See platform/cache.js.
		cache: noopCache,
		clientIp: clientIpFrom(env),
	};
}
