#!/bin/sh
#
# Write a .env the compose stack can actually start with.
#
#   ./scripts/generate-env.sh           # writes .env, refusing to clobber
#   ./scripts/generate-env.sh --force   # mints new credentials into an existing .env
#   ./scripts/generate-env.sh --print   # writes nothing, prints a fresh set
#
# POSIX sh and openssl, deliberately: somebody self-hosting this has Docker and
# nothing else, and asking them to install a Node toolchain to produce a config
# file is a silly thing to ask. openssl ships with macOS and every Linux, and is
# already inside the containers if it somehow isn't on the host.
#
# It exists because .env.example previously asked the reader to mint two JWTs by
# pasting a one-liner out of a comment, and getting that wrong is silent: the
# stack starts, every service looks healthy, and the app answers 502 because the
# value in SERVICE_ROLE_KEY has no dots in it. PostgREST calls that a signing
# error and GoTrue calls it a permissions error; neither says "that is not a
# token".
#
# The two keys are not decorative. PostgREST reads the `role` claim to decide
# what the caller may do:
#
#   ANON_KEY          ships to the browser; public by design.
#   SERVICE_ROLE_KEY  bypasses RLS. Anyone holding it can read and write every
#                     row, including other people's private lesson answers.
#
# Both must be signed with the same JWT_SECRET that PostgREST and GoTrue verify
# against, which is why they are generated together, here, rather than by hand.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TARGET="$ROOT/.env"
TEMPLATE="$ROOT/.env.example"

FORCE=0
PRINT=0
for arg in "$@"; do
	case "$arg" in
		--force) FORCE=1 ;;
		--print) PRINT=1 ;;
		-h | --help)
			sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*)
			printf 'unknown option: %s\n' "$arg" >&2
			exit 2
			;;
	esac
done

if ! command -v openssl >/dev/null 2>&1; then
	cat >&2 <<-'MISSING'
		openssl is required and was not found.

		If you would rather not install it, any container with it will do:
		  docker run --rm -v "$PWD:/w" -w /w --entrypoint sh \
		    alpine/openssl:latest scripts/generate-env.sh

		(--entrypoint sh matters: that image's entrypoint is openssl, so
		without it Docker runs "openssl sh scripts/generate-env.sh".)
	MISSING
	exit 1
fi

if [ ! -f "$TEMPLATE" ]; then
	printf 'Cannot find %s\n' "$TEMPLATE" >&2
	exit 1
fi

# base64url: base64, then the two substituted characters and no padding.
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# Hex rather than base64 for the plain secrets. POSTGRES_PASSWORD is
# interpolated into connection URLs, and an @ or a # there splits the URL and
# produces an error about hosts and ports rather than about the password.
JWT_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
ADMIN_TOKEN=$(openssl rand -hex 24)
S3_ACCESS_KEY=$(openssl rand -hex 12)
S3_SECRET_KEY=$(openssl rand -hex 24)

# Ten years. These are long-lived service credentials, not sessions — an expiry
# short enough to be a security control would just be an outage waiting to
# happen, and rotating them means regenerating both together anyway.
NOW=$(date +%s)
EXPIRES=$((NOW + 315360000))

# The secret reaches openssl as an argument, so it is briefly visible in this
# machine's process list. That is acceptable here and only here: it is a local
# one-shot, run by the person who owns the machine, writing the same secret to a
# file in the same directory a moment later.
sign_jwt() {
	_header=$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)
	_payload=$(printf '{"role":"%s","iss":"supabase","iat":%s,"exp":%s}' "$1" "$NOW" "$EXPIRES" | b64url)
	_signature=$(printf '%s.%s' "$_header" "$_payload" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | b64url)
	printf '%s.%s.%s' "$_header" "$_payload" "$_signature"
}

ANON_KEY=$(sign_jwt anon)
SERVICE_ROLE_KEY=$(sign_jwt service_role)

GENERATED='POSTGRES_PASSWORD JWT_SECRET ANON_KEY SERVICE_ROLE_KEY ADMIN_TOKEN S3_ACCESS_KEY S3_SECRET_KEY'

# Fails for any name not in GENERATED, which is what the rewrite below uses to
# decide whether a line is ours to replace.
value_for() {
	case "$1" in
		POSTGRES_PASSWORD) printf '%s' "$POSTGRES_PASSWORD" ;;
		JWT_SECRET) printf '%s' "$JWT_SECRET" ;;
		ANON_KEY) printf '%s' "$ANON_KEY" ;;
		SERVICE_ROLE_KEY) printf '%s' "$SERVICE_ROLE_KEY" ;;
		ADMIN_TOKEN) printf '%s' "$ADMIN_TOKEN" ;;
		S3_ACCESS_KEY) printf '%s' "$S3_ACCESS_KEY" ;;
		S3_SECRET_KEY) printf '%s' "$S3_SECRET_KEY" ;;
		*) return 1 ;;
	esac
}

# Rewrite line by line rather than with `sed -i`, whose spelling differs between
# BSD and GNU and which would need a temp file here anyway. Everything that is
# not a generated key — the comments, PUBLIC_URL, the SMTP block — passes
# through untouched, which is the whole point.
rewrite() {
	_seen=''
	while IFS= read -r _line || [ -n "$_line" ]; do
		_key=${_line%%=*}
		if [ "$_key" != "$_line" ] && value_for "$_key" >/dev/null 2>&1; then
			printf '%s=%s\n' "$_key" "$(value_for "$_key")"
			_seen="$_seen $_key"
		else
			printf '%s\n' "$_line"
		fi
	done <"$1"

	# A .env written before a setting existed gets it appended rather than being
	# rejected, since the alternative is asking somebody to hand-merge.
	for _key in $GENERATED; do
		case " $_seen " in
			*" $_key "*) ;;
			*) printf '%s=%s\n' "$_key" "$(value_for "$_key")" ;;
		esac
	done
}

if [ "$PRINT" -eq 1 ]; then
	rewrite "$TEMPLATE"
	exit 0
fi

if [ -f "$TARGET" ] && [ "$FORCE" -eq 0 ]; then
	printf '%s already exists. Pass --force to mint new credentials into it, or --print to see a fresh set.\n' "$TARGET" >&2
	exit 1
fi

# Regenerating rewrites the credentials in the .env that is already there rather
# than starting from the example again. That is the difference between "mint me
# new keys" and "throw away the PUBLIC_URL and SMTP settings I spent time
# getting right", and only the first is ever what somebody means.
REWRITING=0
[ -f "$TARGET" ] && REWRITING=1

SOURCE="$TEMPLATE"
[ "$REWRITING" -eq 1 ] && SOURCE="$TARGET"

# Written through a temp file so an interrupted run cannot leave a half-written
# .env, and created with a restrictive umask because it holds the service-role
# key from the moment it exists.
TMP="$TARGET.tmp.$$"
trap 'rm -f "$TMP"' EXIT INT TERM
(
	umask 077
	rewrite "$SOURCE" >"$TMP"
)
mv "$TMP" "$TARGET"

printf 'Wrote %s\n\n' "$TARGET"
if [ "$REWRITING" -eq 1 ]; then
	printf 'Credentials replaced; everything else in the file was left as it was.\n'
else
	printf 'Still to fill in by hand:\n'
	printf '  PUBLIC_URL / PUBLIC_HOSTNAME  where this instance is reachable from a browser\n'
	printf '\nSign-in is by username and password (AUTH_MODE=password), so no mail server is\n'
	printf 'needed. Fill in SMTP_* only for AUTH_MODE=magic-link or both, or to let people\n'
	printf 'reset their own passwords by email — otherwise an admin does that from the\n'
	printf 'moderation page.\n'
fi
printf '\nPUBLIC_URL is baked into the SPA at build time, so set it before `docker compose up -d --build`.\n'
