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
