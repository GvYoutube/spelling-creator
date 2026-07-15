---
title: Lesson hub & accounts
sidebar_position: 9
---

# Lesson hub & accounts

The **Lesson hub** (`/hub`) is a public gallery of lessons users have shared.
Anyone can browse and preview; saving to the cloud **and commenting** require a
signed-in account. The editor's **Save to cloud** button is a dropdown with two
choices: **Publish to hub** (shared publicly) or **Save as draft** (backed up to
the database but kept private — only the author sees it, in a "Your drafts"
section on the hub). A draft can be published later, or a published lesson pulled
back to a draft; both go through the same `POST`/`PUT` with a `published` flag.
Signed-in users see an **Edit** action on lessons they published — it
opens the lesson back in the editor (warning first before it replaces any
in-progress work), and saving sends a `PUT` that the Worker accepts only from the
lesson's author. Clicking a lesson opens its own page at `/hub/:id`, where
**comments** (including threaded replies) appear beneath it. Comments are
**moderated server-side**: a comment containing profanity (detected with
[`glin-profanity`](https://www.npmjs.com/package/glin-profanity)) is blocked
entirely by the Worker — it is never stored, and the user is shown why. Posting a
reply sends a [notification](./notifications.md) to the parent commenter and the
lesson author.

**Comments are rich text.** They're written with
[mui-tiptap](https://github.com/sjdemartini/mui-tiptap) (`RichTextInput.jsx`) and
stored as sanitized HTML: bold, italic, underline, strikethrough, inline code,
lists, blockquotes and links. **Media cannot be embedded** — no images, video,
audio or frames — and that rule is enforced by the Worker's sanitizer rather than
by the toolbar, so it holds even against a hand-crafted request. See
[Rich text](./rich-text.md) for how that works and what survives sanitizing.

**Editing a comment.** An author can edit their own comment after posting; the
comment then shows an **"edited"** marker next to its timestamp, so it never
changes silently under someone who already read (or replied to) it. Editing runs
the same sanitizing, length and profanity checks as posting, so it can't be used
to launder content past the rules. Moderators can _delete_ a comment but not
rewrite one — see [Moderation](./moderation.md).

A commenter can also leave a **1–5 star rating** for the lesson (a MUI Rating in
the comment box). Ratings are one-per-user-per-lesson — re-rating updates your
existing star count rather than adding a second vote — and the lesson page shows
the **average** rating and how many ratings it has.

**Forking.** Any lesson can be forked into a new lesson of your own — the
original row is never touched, so this needs no special permission. A fork is a
**clone of the lesson's git repository**: it carries the original's full version
history and, because git addresses commits by content, shares its ancestry. The
new lesson records what it was forked from (`lessons.forked_from`), which lets it
later **pull the original's changes in**: the two histories are merged against the
commit they diverged from, block by block. See
[Version history](/monorepo/version-history).

**Merging a fork back in.** A **trusted collaborator** — someone the author added
to the lesson's collaboration list — can also merge their fork _back into_ the
original lesson. That makes them the one kind of non-author who may write a
lesson: its title, document and history, but never its published/draft state, the
trusted list itself, or its existence (no delete). Pushes are compare-and-swapped
on the history's head, so neither the author nor a collaborator can overwrite work
they haven't seen — whoever is stale is told to merge and try again. The author is
notified when a collaborator merges into their lesson.

**Where the data lives.** Lessons are stored in **Supabase Postgres**, but — like
the AI and Pixabay features — the browser never talks to the database directly.
All lesson reads/writes go through the companion Worker (`apps/api` in this
monorepo), which holds the privileged Supabase credentials server-side. The only
thing the browser does directly with Supabase is **authentication**.

**How sign-in works.** The login page (`/login`) uses
[Supabase Auth](https://supabase.com/docs/guides/auth) magic links: enter an
email, receive a one-time link, and the Supabase JS client (in `src/lib/supabase.js`)
exchanges the callback for a session. We use the **PKCE** flow so the callback
returns a `?code=` in the query string rather than access tokens in the URL
fragment (hash). The session JWT is what authorises a
publish: the app sends it to the Worker as a `Bearer` token, and the Worker
verifies it (and derives the author) before inserting the row.

```
 Browser ──magic link / session (Supabase JS)──▶ Supabase Auth
 Browser ──GET /lessons, GET /lessons/:id───────▶ Worker ──▶ Supabase Postgres   (public reads; published only in listing; a draft's GET /lessons/:id needs Bearer JWT as owner/trusted collaborator/mod)
 Browser ──GET /lessons/mine (Bearer JWT)────────▶ Worker ──verify JWT──▶ Postgres (own lessons + drafts)
 Browser ──POST /lessons  (Bearer JWT)──────────▶ Worker ──verify JWT──▶ Postgres (publish or save draft)
 Browser ──PUT  /lessons/:id (Bearer JWT)────────▶ Worker ──verify JWT + author──▶ Postgres (edit own; may flip draft↔hub)
 Browser ──GET /lessons/:id/comments────────────▶ Worker ──▶ Supabase Postgres   (public reads; a draft's comments need the same auth as the lesson)
 Browser ──POST /lessons/:id/comments (Bearer)──▶ Worker ──verify JWT, sanitize, profanity check──▶ Postgres
 Browser ──PATCH /lessons/:id/comments/:cid ────▶ Worker ──verify JWT + author, same checks──▶ Postgres (edit own)
```

## Worker endpoints (contract)

These live in the Worker (`apps/api`). The frontend
(`src/lib/lessons.js`) expects them at paths under `VITE_API_URL`. (The Worker
also exposes the profile, notification, and moderation endpoints documented on
their own pages.)

| Method & path                            | Auth                    | Response                                                                                                              |
| ---------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GET /lessons`                           | none (public)           | `{ "lessons": [{ id, authorId, title, author, sectionCount, published, createdAt }] }` (published only, newest first) |
| `GET /lessons/mine`                      | `Bearer <Supabase JWT>` | `{ "lessons": [{ id, authorId, title, author, sectionCount, published, createdAt }] }` (caller's own, incl. drafts)   |
| `GET /lessons/:id`                       | none, unless a draft\*  | `{ "lesson": { id, authorId, title, author, sectionCount, published, createdAt, doc, avgRating, ratingCount } }`      |
| `POST /lessons`                          | `Bearer <Supabase JWT>` | `{ "lesson": { id, authorId, title, author, sectionCount, published, createdAt } }`                                   |
| `PUT /lessons/:id`                       | `Bearer <Supabase JWT>` | `{ "lesson": { id, authorId, title, author, sectionCount, published, createdAt } }` (author only; else `403`)         |
| `GET /lessons/:id/comments`              | none, unless a draft\*  | `{ "comments": [{ id, parentId, authorId, author, body, createdAt, editedAt }] }` (oldest first)                      |
| `POST /lessons/:id/comments`             | `Bearer <Supabase JWT>` | `{ "comment": { id, ..., body, createdAt, editedAt }, "rating": { average, count } \| null }`                         |
| `PATCH /lessons/:id/comments/:commentId` | `Bearer <Supabase JWT>` | `{ "comment": { ... } }` — edit your own comment (author only; else `403`)                                            |
| `POST /ai-text/dislike`                  | `Bearer <Supabase JWT>` | `{ "ok": true }` — evicts the cached text for `{ subject, documentName }`                                             |

\* A published lesson's `GET /lessons/:id` and `GET /lessons/:id/comments` need
no auth. A **draft** (`published: false`) is private — having the id/URL is not
enough — so those two reads 404 unless the request carries a `Bearer <Supabase
JWT>` for the lesson's author, a trusted collaborator (`doc.trustedCollaborators`),
or a moderator/admin. The frontend (`src/lib/lessons.js`'s `fetchLesson`,
`src/lib/comments.js`'s `fetchComments`) always sends the signed-in user's token
when one is available, so this is transparent to an author viewing or editing
their own draft.

- `doc` is the editor document shape used throughout the app:
  `{ title, sections: [{ id, name, blocks: [...] }] }`. Store it as `jsonb`.
- `POST /lessons` body is `{ title, doc, published }`. The Worker should
  **verify the JWT** (e.g. validate the HS256 signature with the Supabase JWT
  secret, or call `GET {SUPABASE_URL}/auth/v1/user` with the token), reject if
  invalid, take the author from the verified user (never trust a client-supplied
  author), and insert with the service-role key. `published` (default `true` when
  omitted) decides whether the lesson is shared on the hub or saved as a private
  draft. The response includes `authorId` (the publisher's Supabase user id) so the
  hub can tell which lessons belong to the signed-in user and offer **Edit**.
- `GET /lessons/mine` verifies the JWT and returns the caller's own lessons
  (drafts and published), scoped to `author_id = <verified user>`. It backs the
  hub's "Your drafts" section, since drafts are filtered out of `GET /lessons`.
- `PUT /lessons/:id` body is `{ title, doc, published? }`. The Worker verifies the
  JWT the same way, then updates the row **only if the verified user is its author**
  (the update is filtered on both `id` and `author_id`, so a non-author's request
  matches no rows and is rejected with `403`). When `published` is present it is
  updated too, so a draft can be published or a published lesson pulled back to a
  draft; omitting it leaves the current state alone. `author` and `created_at` are
  left unchanged. This backs the editor's **Save to cloud** actions when editing a
  lesson loaded from the hub.
- `POST /lessons/:id/comments` body is `{ body, parentId?, rating? }`, where `body`
  is rich-text HTML. The Worker verifies the JWT the same way, derives the author
  from the verified user, then **sanitizes the HTML** against an allow-list
  ([Rich text](./rich-text.md)) — dropping media and anything else not permitted —
  and runs the _resulting text_ through
  [`glin-profanity`](https://www.npmjs.com/package/glin-profanity);
  if any profanity is found it **rejects the whole comment with `422`** (nothing is
  stored). Otherwise it inserts the **sanitized** HTML with the service-role key.
  Both checks run on the Worker so neither can be bypassed by a crafted client
  request. The 2000-character limit counts the comment's _text_, not the markup. An
  optional `rating` (integer 1–5) rates the lesson alongside the comment: the Worker
  upserts it into the `ratings` table keyed by `(lesson_id, author_id)` — one rating
  per user, re-rating updates it — and returns the lesson's new `{ average, count }`
  as `rating` (or `null` when no rating was sent). A `rating` outside 1–5 is `400`.
- `PATCH /lessons/:id/comments/:commentId` body is `{ body }`. Edits one comment,
  and **only its author may do so**: ownership is decided by comparing the stored
  `author_id` against the verified JWT (a non-author gets `403`, a missing comment
  `404`). The new body runs through the same sanitize/length/profanity pipeline as a
  fresh post, so an edit can't launder content past the rules that applied when it
  was written. A successful edit stamps `edited_at`, which the UI shows as an
  "edited" marker. Moderators cannot edit — only delete.
- `POST /ai-text/dislike` body is `{ subject, documentName }`. The Worker
  verifies the JWT the same way (sign-in required), then rebuilds the cache key
  for that text suggestion and deletes it, so the next request for the same
  subject is regenerated instead of served from cache.
- On 4xx/5xx, return a short **plain-text** reason — the frontend surfaces it
  directly (matching the existing AI/Pixabay error convention).

## Supabase schema

The canonical, ready-to-run schema lives in the monorepo at
[`apps/api/schema.sql`](https://github.com/playforge-coding/spelling-creator/blob/master/apps/api/schema.sql).
Run it once in the Supabase SQL editor. Besides the `lessons` and `comments`
tables shown below, that file also defines the `ratings` table (1–5 stars, one
row per `(lesson_id, author_id)`), the `notifications` table (see
[Notifications](./notifications.md)) and the moderation tables — `user_roles`,
`banned_names`, `banned_ips`, and `lesson_delete_requests` — plus the
`shadowbanned` / `author_ip` columns (see [Moderation](./moderation.md)). The two
core tables, for reference:

```sql
create table public.lessons (
  id            uuid primary key default gen_random_uuid(),
  author_id     uuid not null references auth.users (id) on delete cascade,
  author        text,                       -- display name / email, denormalised for listing
  title         text not null,
  doc           jsonb not null,             -- the editor document { title, sections }
  -- Maintained by Postgres so the public listing can return a section count
  -- without the Worker downloading every (image-laden) doc.
  section_count int generated always as (jsonb_array_length(doc -> 'sections')) stored,
  -- false = a private draft, backed up but kept out of the public listing.
  -- Defaults true so pre-draft rows (all of which were published) stay visible.
  published     boolean not null default true,
  -- The lesson this one was forked from, or null for an original. Forking clones
  -- the source lesson's git repository, so a fork shares ancestry with it; this
  -- is the pointer home that lets the fork later merge the original's changes in
  -- (see /monorepo/version-history). Deleting the original orphans its forks
  -- rather than deleting them.
  forked_from   uuid references public.lessons (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index lessons_created_at_idx on public.lessons (created_at desc);

-- The Worker connects with the service-role key, which bypasses RLS. RLS is
-- still worth enabling as defence-in-depth in case the anon key is ever used:
alter table public.lessons enable row level security;
create policy "lessons are public to read"
  on public.lessons for select using (true);
-- (No insert policy for anon/auth roles: only the service-role Worker writes.)

-- Comments on a lesson. Public to read; written only by the service-role Worker
-- after it verifies the JWT and the profanity check passes. parent_id threads a
-- reply under another comment (null for a top-level comment); posting a reply
-- notifies the parent comment's author and the lesson author.
--
-- body holds sanitized rich-text HTML (comments written before rich text are plain
-- strings, and still render as such). edited_at is when the author last edited the
-- comment, or null if they never have — the thread shows an "edited" marker when it
-- is set. Only the author can edit; a moderator's power is to delete.
create table public.comments (
  id          uuid primary key default gen_random_uuid(),
  lesson_id   uuid not null references public.lessons (id) on delete cascade,
  parent_id   uuid references public.comments (id) on delete cascade,
  author_id   uuid not null references auth.users (id) on delete cascade,
  author      text,
  body        text not null,
  created_at  timestamptz not null default now(),
  edited_at   timestamptz
);
create index comments_lesson_id_idx on public.comments (lesson_id, created_at);
alter table public.comments enable row level security;
create policy "comments are public to read"
  on public.comments for select using (true);
```
