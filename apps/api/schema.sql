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
  created_at    timestamptz not null default now()
);

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
  author_id   uuid not null references auth.users (id) on delete cascade,
  author      text,                       -- display name / email, denormalised for listing
  body        text not null,
  created_at  timestamptz not null default now()
);

-- Comments are listed per lesson, oldest-first; index the lookup + sort key.
create index if not exists comments_lesson_id_idx on public.comments (lesson_id, created_at);

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
  type            text not null,            -- 'comment' | 'link'
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
