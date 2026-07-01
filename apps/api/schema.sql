-- Supabase schema for the Spelling Lesson Maker lesson hub.
--
-- Run this once in the Supabase SQL editor (or via `supabase db` / psql) against
-- your project. The Worker (src/index.js) connects with the service-role key,
-- which bypasses RLS, so it is the only writer. The browser only ever uses
-- Supabase for authentication (magic-link sign-in); all lesson reads/writes go
-- through the Worker's /lessons endpoints.

create table if not exists public.lessons (
  id            uuid primary key default gen_random_uuid(),
  author_id     uuid not null references auth.users (id) on delete cascade,
  author        text,                       -- display name / email, denormalised for listing
  title         text not null,
  doc           jsonb not null,             -- the editor document { title, sections }
  -- Maintained by Postgres so the public listing can show a section count without
  -- the Worker having to download every (potentially large, image-laden) doc.
  section_count int generated always as (jsonb_array_length(doc -> 'sections')) stored,
  -- Whether this lesson is shared on the public hub. A draft (published = false) is
  -- backed up to the database but kept out of the public listing; only its author
  -- sees it (GET /lessons/mine). Defaults to true so every pre-draft row — all of
  -- which were published — keeps showing in the hub.
  published     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- Migration for databases created before the draft feature: add the column with a
-- default of true so existing rows stay published. Safe to re-run.
alter table public.lessons add column if not exists published boolean not null default true;

-- Listing is ordered newest-first; index the sort key.
create index if not exists lessons_created_at_idx on public.lessons (created_at desc);

-- The Worker connects with the service-role key, which bypasses RLS. RLS is still
-- worth enabling as defence-in-depth in case the anon key is ever used directly:
alter table public.lessons enable row level security;

drop policy if exists "lessons are public to read" on public.lessons;
create policy "lessons are public to read"
  on public.lessons for select using (true);
-- (No insert/update/delete policy for anon/authenticated roles: only the
-- service-role Worker writes.)


-- Comments on published lessons. Reads are public (anyone browsing the hub sees
-- them); writes go through the Worker's POST /lessons/:id/comments, which verifies
-- a Supabase session JWT and rejects the comment outright if it contains profanity
-- (glin-profanity) before it ever reaches this table.
create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  lesson_id   uuid not null references public.lessons (id) on delete cascade,
  -- The comment this one replies to, or null for a top-level comment. Self-
  -- referential FK; cascading so deleting a comment also removes its replies.
  -- Posting a reply notifies the parent comment's author and the lesson author
  -- (see the Worker's handleComments).
  parent_id   uuid references public.comments (id) on delete cascade,
  author_id   uuid not null references auth.users (id) on delete cascade,
  author      text,                       -- display name / email, denormalised for listing
  body        text not null,
  created_at  timestamptz not null default now()
);

-- Comments are listed per lesson, oldest-first; index the lookup + sort key.
create index if not exists comments_lesson_id_idx on public.comments (lesson_id, created_at);

-- Index the self-referential FK so the on-delete cascade (and any reply lookups)
-- don't sequential-scan the table.
create index if not exists comments_parent_id_idx on public.comments (parent_id);

-- Same posture as lessons: service-role Worker is the only writer; enable RLS as
-- defence-in-depth and allow public reads.
alter table public.comments enable row level security;

drop policy if exists "comments are public to read" on public.comments;
create policy "comments are public to read"
  on public.comments for select using (true);
-- (No insert/update/delete policy for anon/authenticated roles: only the
-- service-role Worker writes.)


-- Notifications delivered to a user. A notification reaches its recipient by their
-- auth user id (`user_id`, e.g. "someone commented on your lesson") or by their
-- email (`recipient_email`, used by "send link to user" so a link can be sent
-- before that person's id is known). Reads and writes go through the Worker's
-- /notifications endpoints (service role), which scope every query to the
-- signed-in caller.
create table if not exists public.notifications (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users (id) on delete cascade,
  recipient_email text,
  type            text not null,            -- 'comment' | 'link' | 'follow'
  title           text not null,
  body            text,
  link            text,
  read            boolean not null default false,
  created_at      timestamptz not null default now()
);

-- Notifications are fetched per recipient, newest-first; index both addressing keys.
create index if not exists notifications_user_id_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_recipient_email_idx on public.notifications (recipient_email, created_at desc);

-- Only the service-role Worker reads/writes these, so no anon/authenticated policies.
alter table public.notifications enable row level security;


-- Follows: one row per "follower_id follows following_id" edge. Keyed by the
-- Supabase user id on both sides (the same `author_id` carried on lessons and
-- comments), so a follow survives a display-name change. A user's follower and
-- following counts, and whether the signed-in caller follows a given profile, are
-- derived from this table; the "activity from people you follow" feed reads the
-- following_ids here and merges those users' lessons and comments. Creating a
-- follow notifies the followed user (a `follow` notification). Reads and writes go
-- through the Worker's /profiles/:id/follow and /following endpoints (service role).
create table if not exists public.follows (
  -- Composite primary key makes a follow idempotent: re-following is a no-op
  -- (ON CONFLICT DO NOTHING) rather than a duplicate row, so we don't re-notify.
  follower_id  uuid not null references auth.users (id) on delete cascade,
  following_id uuid not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, following_id)
);

-- Two lookup directions: "who does X follow" (the following feed, follower_id ->)
-- and "who follows X" (a profile's follower count, following_id ->). The PK covers
-- the first prefix; add an index for the reverse lookup.
create index if not exists follows_following_id_idx on public.follows (following_id);

-- Same posture as notifications: only the service-role Worker reads/writes, so
-- enable RLS with no anon/authenticated policies.
alter table public.follows enable row level security;


-- ============================================================================
-- Moderation: roles, bans, shadowbanning and lesson-deletion requests.
--
-- A signed-in user is normally a plain author (can only touch their own
-- content). On top of that sit two privilege tiers, stored in user_roles:
--
--   moderator — delete any comment, shadowban a lesson (hide it from the public
--               hub while its author still sees it), ban users by name, and
--               *request* that a lesson be fully deleted.
--   admin     — everything a moderator can do, plus: add moderators, approve a
--               moderator's lesson-deletion request, fully delete a lesson, and
--               ban users by IP.
--
-- As with everything else, only the service-role Worker writes these tables; the
-- browser asks the Worker (GET /moderation/whoami) what it's allowed to do. The
-- Worker re-derives the caller's role from user_roles on every privileged
-- request, so a tampered client can never grant itself a role.
-- ============================================================================

-- One row per privileged user. Admins are seeded by hand (see the snippet at the
-- bottom of this file) — the app deliberately offers no way to create an admin,
-- only moderators (POST /moderation/moderators, admin-only). granted_by records
-- which admin added a moderator (null for hand-seeded admins).
create table if not exists public.user_roles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  role       text not null check (role in ('moderator','admin')),
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- Shadowban flag: a shadowbanned lesson is dropped from the public hub listing
-- and from public single-lesson reads (404 to everyone but its author and
-- mods/admins), so its author still sees it as normal and doesn't realise it's
-- hidden. Defaults to false so every existing row stays visible.
alter table public.lessons add column if not exists shadowbanned boolean not null default false;

-- The IP the content was created from, captured server-side (cf-connecting-ip).
-- Needed so an admin can "ban this user by IP" from a piece of their content. Only
-- ever surfaced to the browser on mod/admin reads, never in public responses.
alter table public.lessons  add column if not exists author_ip text;
alter table public.comments add column if not exists author_ip text;

-- Name bans (created by moderators): block any account whose display name matches
-- from posting comments or publishing/editing lessons. Stored normalised
-- (lower-cased, trimmed) as the primary key so the lookup is exact and case-
-- insensitive; display_name keeps the original casing for the moderation UI.
create table if not exists public.banned_names (
  name_lower   text primary key,
  display_name text,
  banned_by    uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now()
);

-- IP bans (created by admins): block any request from the address. Checked at the
-- top of the content-creating Worker routes against cf-connecting-ip.
create table if not exists public.banned_ips (
  ip         text primary key,
  reason     text,
  banned_by  uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- A moderator can't fully delete a lesson; they file a request here and an admin
-- approves (which deletes the lesson) or denies it. status starts 'pending'.
create table if not exists public.lesson_delete_requests (
  id           uuid primary key default gen_random_uuid(),
  lesson_id    uuid not null references public.lessons (id) on delete cascade,
  requested_by uuid not null references auth.users (id) on delete cascade,
  reason       text,
  status       text not null default 'pending' check (status in ('pending','approved','denied')),
  resolved_by  uuid references auth.users (id) on delete set null,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now()
);

-- The admin queue reads pending requests newest-first; index the filter+sort key.
create index if not exists lesson_delete_requests_status_idx on public.lesson_delete_requests (status, created_at desc);

-- Same posture as notifications: only the service-role Worker reads/writes these,
-- so enable RLS with no anon/authenticated policies. The browser never queries
-- them directly — it goes through the Worker's /moderation endpoints.
alter table public.user_roles            enable row level security;
alter table public.banned_names          enable row level security;
alter table public.banned_ips            enable row level security;
alter table public.lesson_delete_requests enable row level security;


-- ----------------------------------------------------------------------------
-- Seed an admin. There is no in-app way to create an admin (admins can only add
-- moderators), so run this once per admin in the Supabase SQL editor. The person
-- must have signed in at least once so a row exists in auth.users for their email.
-- ----------------------------------------------------------------------------
-- insert into public.user_roles (user_id, role)
-- select id, 'admin' from auth.users where email = 'you@example.com'
-- on conflict (user_id) do update set role = 'admin';
