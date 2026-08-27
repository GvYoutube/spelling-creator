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
  -- The lesson this one was forked from, or null for an original.
  --
  -- Forking clones the source lesson's git repository (its history lives in R2 as
  -- a packfile — see the Worker's src/routes/git.js), so a fork shares ancestry
  -- with its original. This column is the pointer home: it tells the editor whose
  -- history to fetch when the user asks to pull the original's later changes in,
  -- which is then a true three-way merge against the commit they diverged from.
  -- `on delete set null`: deleting the original orphans its forks, it doesn't
  -- delete them.
  forked_from   uuid references public.lessons (id) on delete set null,
  created_at    timestamptz not null default now()
);

-- Migration for databases created before the draft feature: add the column with a
-- default of true so existing rows stay published. Safe to re-run.
alter table public.lessons add column if not exists published boolean not null default true;

-- Migration for databases created before lesson version history. Existing lessons
-- were not forked (or were forked before we tracked it), so null is correct.
alter table public.lessons add column if not exists forked_from uuid references public.lessons (id) on delete set null;

-- Forks are looked up by their origin ("what was forked from this lesson?").
create index if not exists lessons_forked_from_idx on public.lessons (forked_from);

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


-- Star ratings on published lessons (1–5). A rating is submitted alongside a
-- comment through the Worker's POST /lessons/:id/comments, which upserts the row
-- (one rating per user per lesson, keyed by the composite primary key) so
-- re-rating updates the existing star count rather than adding a second vote. The
-- lesson page shows the average and how many ratings a lesson has. Reads are
-- public, like comments.
create table if not exists public.ratings (
  lesson_id  uuid not null references public.lessons (id) on delete cascade,
  author_id  uuid not null references auth.users (id) on delete cascade,
  stars      smallint not null check (stars between 1 and 5),
  created_at timestamptz not null default now(),
  -- One rating per user per lesson: the upsert (POST … on_conflict) merges onto
  -- this key so a user can change their rating but never double-count.
  primary key (lesson_id, author_id)
);

-- Averages are computed per lesson; index the group/lookup key.
create index if not exists ratings_lesson_id_idx on public.ratings (lesson_id);

-- Same posture as lessons/comments: service-role Worker is the only writer;
-- enable RLS as defence-in-depth and allow public reads.
alter table public.ratings enable row level security;

drop policy if exists "ratings are public to read" on public.ratings;
create policy "ratings are public to read"
  on public.ratings for select using (true);
-- (No insert/update/delete policy for anon/authenticated roles: only the
-- service-role Worker writes.)


-- A learner's answers from one run-through of a lesson in interactive mode (see
-- the web app's InteractiveLesson): the lesson is presented a step at a time and
-- each question is typed into a text field, then the whole set is saved here once
-- the run-through finishes.
--
-- These rows are PRIVATE to the user who wrote them. The Worker's
-- /lessons/:id/responses endpoints scope every read and every delete to the
-- verified caller's own user_id, and there is no endpoint — moderator, admin or
-- otherwise — that returns anyone else's. The lesson's author cannot see who has
-- worked through their lesson or what they wrote. Treat that as a load-bearing
-- property of this table, not an oversight: a child's attempts at a spelling
-- exercise are exactly the kind of thing that should not become a teacher-facing
-- dashboard by accident.
--
-- `answers` is the array the browser builds in core/src/interactive.js: one entry
-- per question, each carrying { blockId, sectionId, sectionName, questionType,
-- prompt, answer }. The prompt is snapshotted deliberately — the lesson may be
-- edited or re-ordered later, and a saved run-through has to stay readable.
create table if not exists public.lesson_responses (
  id           uuid primary key default gen_random_uuid(),
  lesson_id    uuid not null references public.lessons (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  answers      jsonb not null,
  completed_at timestamptz not null default now()
);

-- The only query shape there is: "my run-throughs of this lesson, newest first".
-- The user_id prefix is what makes the privacy scoping cheap as well as correct.
create index if not exists lesson_responses_user_lesson_idx
  on public.lesson_responses (user_id, lesson_id, completed_at desc);

-- Same posture as notifications: only the service-role Worker reads/writes, so
-- enable RLS with no anon/authenticated policies. Note there is deliberately NO
-- public read policy here — unlike lessons, comments and ratings, this data is
-- never public.
alter table public.lesson_responses enable row level security;


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
  type            text not null,            -- 'comment' | 'link' | 'follow' | 'lesson_update' | 'pull_request'
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


-- Pull requests: "please make this change to your lesson".
--
-- Anyone may fork a lesson, but nobody may write someone else's lesson from
-- their fork. To offer work back, a forker opens a pull request against the
-- lesson; its author — or one of the trusted collaborators they named — reviews
-- it and merges it in. That review step is the whole point: an unreviewed write
-- into another person's published lesson is exactly what this replaces.
--
-- What a pull request actually *contains* is a git packfile, stored in R2 beside
-- the lessons' own packs (see lib/lessonGit.js):
--
--   git/pulls/<pullRequestId>/pack
--
-- The pack is a snapshot of the proposer's repository at the moment they opened
-- the request, which is what makes a pull request stable: the proposer can carry
-- on editing their fork afterwards and what the reviewer is looking at does not
-- move under them. `head` names the commit that pack points at; `base` is the
-- lesson's tip when it was opened (informational — the merge finds its own base
-- from the shared ancestry, which is real, because a fork is a genuine clone).
create table if not exists public.lesson_pull_requests (
  id            uuid primary key default gen_random_uuid(),
  -- The lesson being proposed to.
  lesson_id     uuid not null references public.lessons (id) on delete cascade,
  -- The fork the proposal came from, when it is itself a saved lesson. Nullable
  -- and `on delete set null`: a proposal may be opened from an unsaved local
  -- fork, and deleting the fork afterwards must not delete the proposal — the
  -- packfile is what carries the changes, not the row this points at.
  source_lesson_id uuid references public.lessons (id) on delete set null,
  author_id     uuid not null references auth.users (id) on delete cascade,
  author        text,                       -- display name, denormalised for listing
  title         text not null,
  body          text,                       -- plain text; profanity-checked like a comment
  head          text not null,              -- the commit the stored pack points at
  base          text,                       -- the lesson's tip when this was opened
  -- False until the packfile has actually landed in R2 (opening a request is two
  -- steps: insert the row, then upload the pack against its id). A request that
  -- never became ready has nothing to review, so it is shown only to the person
  -- who opened it, who can withdraw and try again.
  ready         boolean not null default false,
  status        text not null default 'open' check (status in ('open','merged','closed')),
  -- The merge commit in the lesson's own history, once merged. Two parents: the
  -- lesson's tip and this request's head.
  merge_commit  text,
  resolved_by   uuid references auth.users (id) on delete set null,
  resolved_at   timestamptz,
  -- Recorded so an admin can later ban the address, as for lessons and comments.
  author_ip     text,
  created_at    timestamptz not null default now(),
  -- The branch of the fork this was proposed from, for display. A proposer can
  -- work on a variation of their fork (see /web-app/lesson-variations) and offer
  -- that, so "which one is this?" is a question the queue has to be able to
  -- answer. Null on a proposal opened before this, and on one from the default
  -- branch, where naming it would say nothing.
  head_ref      text,
  -- A proposal can be updated while it is open, and each upload is a revision.
  -- `revision` counts them from 1; `previous_head` is the commit the proposal
  -- pointed at before the most recent one, which is what makes "what changed in
  -- this update" answerable — both commits are in the stored pack, because an
  -- update may only move the proposer's branch forward.
  revision      integer not null default 1,
  previous_head text,
  updated_at    timestamptz
);

-- Columns added after the table shipped. Safe to re-run, and safe on a database
-- that already has them.
alter table public.lesson_pull_requests add column if not exists head_ref text;
alter table public.lesson_pull_requests add column if not exists revision integer not null default 1;
alter table public.lesson_pull_requests add column if not exists previous_head text;
alter table public.lesson_pull_requests add column if not exists updated_at timestamptz;

-- The lesson page and the editor both ask "the open proposals on this lesson,
-- newest first"; index the filter + sort key.
create index if not exists lesson_pull_requests_lesson_idx
  on public.lesson_pull_requests (lesson_id, status, created_at desc);

-- "The proposals I have opened", for the author's own view of them.
create index if not exists lesson_pull_requests_author_idx
  on public.lesson_pull_requests (author_id, created_at desc);

-- Same posture as notifications and lesson_responses: only the service-role
-- Worker reads and writes this table, so RLS is enabled with no anon or
-- authenticated policies at all. The browser reaches proposals exclusively
-- through the Worker's /lessons/:id/pulls endpoints, which is what applies the
-- "may this person merge?" rule — Postgres has no way to know who is trusted,
-- since the trusted list lives inside the lesson's document.
alter table public.lesson_pull_requests enable row level security;


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

-- When the author last edited their comment, or null if they never have. Comments
-- are rich text (HTML, authored with mui-tiptap) and their author may edit them
-- after posting, so the thread shows an "edited" marker rather than letting a
-- comment change under a reader silently. Only the author edits; a moderator's power
-- over a comment is to delete it, not to rewrite it. See routes/comments.js.
alter table public.comments add column if not exists edited_at timestamptz;

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


-- ============================================================================
-- Expiring key-value store.
--
-- Only needed when self-hosting. The Cloudflare deployment keeps rate-limit
-- buckets, cached AI answers and MCP OAuth state in a KV namespace; an instance
-- without one puts them here instead, reached over PostgREST with the same
-- service-role key as everything else (see apps/api/src/platform/postgrestKv.js
-- and /monorepo/platform-seam). Creating the table on the hosted instance too is
-- harmless — nothing writes to it there.
--
-- Nothing in here is authoritative. Every row is small, short-lived, and has an
-- expiry past which its absence is the correct answer: a spent rate-limit
-- bucket, a stale suggestion, an abandoned consent flow. That is why this can be
-- an ordinary table with no locking and no transactions — the rate limiters are
-- read-modify-write token buckets that tolerate a lost update, and the worst a
-- lost one costs is one extra request served.
-- ============================================================================
create table if not exists public.kv_store (
  key        text primary key,
  value      text not null,
  -- Null means "never expires". The store treats a row past this as absent and
  -- deletes it on the way past, so correctness does not depend on the sweep
  -- below ever running — that only reclaims rows nobody asks for again.
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

-- The sweep's only access path.
create index if not exists kv_store_expires_idx on public.kv_store (expires_at)
  where expires_at is not null;

-- Same posture as notifications and the moderation tables: only the
-- service-role Worker touches this, so RLS is on with no anon/authenticated
-- policies. It holds OAuth authorization state, so a readable row here would
-- matter.
alter table public.kv_store enable row level security;

-- ----------------------------------------------------------------------------
-- Reclaim expired rows. Expiry is enforced on read, so this is housekeeping
-- rather than correctness — it collects the entries nobody comes back for. Run
-- it from pg_cron if the instance has it:
--
--   select cron.schedule('kv-store-sweep', '17 * * * *',
--     $$delete from public.kv_store where expires_at is not null and expires_at < now()$$);
--
-- ...or from anything else that can reach the database on a timer. An instance
-- that never runs it works correctly and grows slowly.
-- ----------------------------------------------------------------------------


-- ----------------------------------------------------------------------------
-- Seed an admin. There is no in-app way to create an admin (admins can only add
-- moderators), so run this once per admin in the Supabase SQL editor. The person
-- must have signed in at least once so a row exists in auth.users for their email.
-- ----------------------------------------------------------------------------
-- insert into public.user_roles (user_id, role)
-- select id, 'admin' from auth.users where email = 'you@example.com'
-- on conflict (user_id) do update set role = 'admin';
