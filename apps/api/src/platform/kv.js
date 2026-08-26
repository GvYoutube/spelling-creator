// KvStore — the expiring key-value interface behind the rate limiters, the AI
// answer cache, and the MCP OAuth pending-authorization state.
//
// Three methods, string values, one option. Every value this API keeps in KV is
// small, JSON-or-number, and has a TTL after which its absence is the correct
// answer — a spent rate-limit bucket, a cached suggestion, an abandoned consent
// flow. Nothing here is authoritative, which is why it can live in Cloudflare KV
// (eventually consistent) at all, and equally why a `(key, value, expires_at)`
// table in the Postgres the instance already runs is a complete replacement.
//
// Deliberately absent: list, atomic increment, compare-and-set. The rate limiters
// are read-modify-write token buckets that tolerate a lost update (the worst case
// is one extra request served), and nothing else mutates a shared key. An adapter
// therefore never needs a transaction.
//
// This file is types and documentation only; the implementations live beside it.

/**
 * @typedef {object} KvStore
 * @property {(key: string) => Promise<string | null>} get
 *   The stored value, or null when the key is absent or expired.
 * @property {(key: string, value: string, opts?: { expirationTtl?: number }) => Promise<void>} put
 *   Store a value, replacing whatever was there. `expirationTtl` is in seconds;
 *   without it the entry does not expire on its own.
 * @property {(key: string) => Promise<void>} delete
 *   Remove a key. Deleting an absent key is not an error.
 */

/**
 * Whether a stored entry with this absolute expiry (epoch seconds, or 0/undefined
 * for "never") has expired as of `now`.
 *
 * Adapters over a store with no native TTL — a Postgres table, an in-memory Map —
 * use this so an entry that is past its expiry but not yet swept still reads as
 * absent, which is the behaviour every caller here assumes.
 *
 * @param {number | undefined} expiresAt
 * @param {number} [now] Epoch seconds; defaults to the current time.
 * @returns {boolean}
 */
export function isExpired(expiresAt, now = Math.floor(Date.now() / 1000)) {
	return Boolean(expiresAt) && expiresAt <= now;
}

/**
 * The absolute expiry (epoch seconds) for a put() with this `expirationTtl`, or
 * 0 when the entry should not expire. The counterpart to isExpired above.
 *
 * @param {{ expirationTtl?: number } | undefined} opts
 * @param {number} [now] Epoch seconds; defaults to the current time.
 * @returns {number}
 */
export function expiryFrom(opts, now = Math.floor(Date.now() / 1000)) {
	const ttl = opts && Number(opts.expirationTtl);
	return Number.isFinite(ttl) && ttl > 0 ? now + Math.floor(ttl) : 0;
}
