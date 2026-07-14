---
title: Version history (git, by content block)
sidebar_position: 4
---

# Version history (git, by content block)

Every lesson is a **real git repository**, kept in the browser. Edits are
committed automatically as you work, forking a lesson **clones** its repository,
and merging compares **block ids**.

The whole design falls out of one decision about how a lesson is laid out on
disk.

## The layout: one file per block

A lesson document is `{ title, sections: [{ id, name, blocks: [...] }] }`, and
every block already carries a stable id (`lib/id.js`). The repository stores it
like this:

```
lesson.json            { title, ageRange, sections: [{ id, name, blocks: ["<blockId>", ...] }] }
blocks/<blockId>.json  { id, type: "text" | "spelling" | "question" | "image", ... }
```

`lesson.json` is a **manifest**: it holds the structure — which sections exist,
what they're called, which blocks they contain and in what order — but no block
content. Content lives one-block-per-file under `blocks/`, named by block id.

This is what makes git do the work:

| The user does this               | What changes in the repo                           |
| -------------------------------- | -------------------------------------------------- |
| Edits a block                    | Exactly one file under `blocks/`                   |
| Drags a block to another section | Only `lesson.json` — the block's blob is untouched |
| Adds or deletes a block          | A file named by its id appears or disappears       |
| Renames a section                | Only `lesson.json`                                 |

So a plain git tree diff **is** a block-id diff, with no content parsing. Two
blocks are identical exactly when their blob oids are equal, because git
addresses content by hash. Unchanged blocks cost nothing: they hash to the blob
that's already stored, however many commits reference them.

That single fact is what the diff, the history view and the merge are all built
on.

## Edits as operations

The editor doesn't tell us what the user did — `setDoc` just replaces the
document. So the intent is **recovered** by diffing the previous document against
the next one, keyed by block id, and expressing the difference as operations
(`lib/git/ops.js`):

```
title.set / ageRange.set
section.add | section.remove | section.rename | section.move
block.add   | block.remove   | block.edit     | block.move
```

Because blocks have stable ids, this is exact where a textual diff could only
guess. A block dragged between sections is a `block.move`, not a delete plus an
unrelated add. A block that was both retyped and dragged emits both ops.

Those ops become the commit message, and what the history view shows:

```
Add 1 image, edit 2 questions, remove 1 text block

- add image 8f3c1a2e...
- edit question 4b7d... (prompt, answer)
- edit question 91ce... (prompt)
- remove text block c40a...
```

## Periodic commits

A commit per keystroke would be unreadable history and would thrash IndexedDB.
Instead (`lib/git/useLessonGit.js`):

- a commit is taken when the user **pauses** (4s), and
- at least every **60s** during an unbroken stretch of typing, and
- when the tab is hidden, so closing it mid-edit still checkpoints.

A commit whose tree matches `HEAD` is skipped entirely, so an idle editor never
accretes empty commits. The check is exact and nearly free: write the document's
tree (unchanged blocks resolve to oids git already has) and compare its oid with
`HEAD`'s.

The editor shows this as a chip — _"Version saved 2 minutes ago"_, or _"3 unsaved
changes"_ — which opens the history.

## Restoring

Restoring an old version is an ordinary **forward** commit whose tree happens to
equal an older one. History is never rewritten: the version you restored _away
from_ stays in the timeline, so the restore itself can be undone by restoring
again.

## Forking is cloning

For someone else to fork a lesson, its repository has to travel. It travels the
way git itself moves history: as a **packfile** — every object reachable from the
lesson's branch — plus the commit its branch points at.

- On save, the author packs the repo (`git.packObjects`) and uploads it.
- Forking downloads the pack, indexes it (`git.indexPack`) and checks it out.

The result is a genuine clone: the same commits, under the **same oids**, with
the full history. That shared ancestry is the entire payoff — because the fork
and the original descend from commits with identical oids, git can find their
**merge base**, which is what lets the merge below be a true _three_-way merge.

A fork records where it came from in two places: `lessons.forked_from` in
Postgres (the pointer home) and `refs/remotes/upstream/main` in its own repo.

Lesson images are **not** in the pack. Blocks reference images by content hash
and the bytes already live in R2 (see [Lesson images](/monorepo/lesson-images)),
so a pack is pure JSON and stays small — a few KB for a typical lesson.

### Worker endpoints

```
GET /git/:lessonId/refs   public  -> { head, size, updatedAt }   (404 = no history)
GET /git/:lessonId/pack   public  -> the packfile (X-Git-Head names its tip)
PUT /git/:lessonId/pack   Bearer  -> store it (the lesson's author only)
```

Stored as two R2 objects per lesson, in the `LESSON_GIT` bucket:

```
git/<lessonId>/pack        the packfile bytes
git/<lessonId>/refs.json   { head, size, updatedAt }
```

The pack carries its own tip in R2 `customMetadata`, echoed in the `X-Git-Head`
response header — so a clone reads the bytes and the ref they belong to from the
_same object_, and can never pair a fresh ref with a stale pack.

`GET` is public because forking a published lesson is public; a shadowbanned
lesson's history 404s to everyone but its author and moderators, mirroring
`GET /lessons/:id`. `PUT` verifies the caller is the lesson's author, caps the
pack at 10 MB, and rejects anything that doesn't begin with the `PACK` magic
bytes.

### Setup

```bash
# Create the R2 bucket the LESSON_GIT binding points at (see apps/api/wrangler.jsonc).
wrangler r2 bucket create spelling-creator-git
```

The `forked_from` column is added by `apps/api/schema.sql` (safe to re-run).

## Merging is comparing block ids

When a fork and its original have both moved on, the editor lines the three
documents up **by block id** — base (their common ancestor), ours, theirs — and
decides each block independently (`lib/git/merge.js`):

| Situation                                     | Outcome                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| Changed on one side only                      | Take that side                                                                   |
| Changed on both, identically                  | Take it — they agree                                                             |
| Changed on both, in **different fields**      | **Merge the fields** — one edited the caption, the other the width; both survive |
| Changed on both, same field, different values | **Conflict** — ask the user                                                      |
| Deleted on one side, edited on the other      | **Conflict** — ask the user                                                      |

Only the last two reach a dialog. Everything else resolves silently and is
reported as a summary ("12 blocks merged automatically").

A conflict offers three ways out, per block:

- **Mine** — keep our value for the contested fields
- **Theirs** — take the original's
- **Keep both** — keep ours _and_ add theirs as a second block, under a fresh id,
  so nothing is lost

Structure (which section a block sits in, and in what order) is merged separately
and never raises a dialog: order is cheap for a human to fix and expensive for
one to adjudicate, so a reorder on both sides resolves to ours.

The result is committed with **two parents**, which genuinely joins the two
histories — so the next merge can find _this_ commit as its base.

## What is deliberately not versioned

`doc.trustedCollaborators` holds collaborator **email addresses** (see
[Live collaboration](/web-app/live-collaboration)). A lesson's repository is
packed and uploaded so other people can clone it, so anything committed is
readable by anyone who forks the lesson. Emails must not travel with it: the
field is excluded from the tree and carried across a restore or merge from the
live document instead (`preserveLocalFields` in `lib/git/doc.js`).

## Where it lives

Browser (`apps/web/src/lib/git/`):

| File                    | Purpose                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `doc.js`                | Pure doc helpers: canonical JSON, manifest, block map. No git. |
| `ops.js`                | Diff two docs into operations; render commit messages. No git. |
| `merge.js`              | Three-way merge by block id, field-level. No git.              |
| `layout.js`             | Document ⇄ git tree (one file per block).                      |
| `repo.js`               | Commit, history, diff two commits, restore.                    |
| `pack.js`               | Pack for upload; clone/fetch from a pack; find the merge base. |
| `remote.js`             | The `/git/:lessonId` Worker calls.                             |
| `sync.js`               | Fork (clone) and merge (upstream) flows.                       |
| `fs.js`                 | LightningFS — the IndexedDB filesystem the repos live on.      |
| `engine.js` + `load.js` | The git engine, behind one dynamic import.                     |
| `useLessonGit.js`       | The editor's controller: setup, periodic commits, history.     |

Worker: `apps/api/src/routes/git.js`.

Repositories are **bare** — no working tree, no index. The editor's document
lives in React state and IndexedDB, so checked-out files would be dead weight;
everything goes straight through plumbing (`writeBlob` → `writeTree` →
`writeCommit` → `writeRef`).

### Bundle cost

isomorphic-git and LightningFS are ~185 KB that only the editor needs, so they're
split into their own chunk (`engine.js`) and fetched on demand when the editor
mounts (`load.js`). Nobody reading the homepage or browsing the hub downloads a
git implementation. The pure parts (`doc.js`, `ops.js`, `merge.js`) have no git
dependency, so the history and merge dialogs render without it.

`rsbuild.config.mjs` provides a `Buffer` polyfill (from the `buffer` package) —
isomorphic-git writes git objects through Node's `Buffer`, which browsers don't
have. `ProvidePlugin` only injects it into modules that reference it, so it lands
in the git chunk, not the main bundle.

## It really is git

The repositories are ordinary git repositories, not a git-shaped format. A repo
produced by the editor can be read by the `git` binary directly — `git log`,
`git ls-tree`, `git fsck` and `git show` all work on it, and a merge shows up in
`git log --graph` exactly as you'd expect:

```
*   0c6aa3d Merge the original lesson
|\
| * effcdb9 Edit 1 question, edit 1 image, remove 1 spelling list   <- upstream
* | 4cfbb94 Add 1 text block, edit 1 question, edit 1 image         <- the fork
|/
* 4321521 Restore the version from d7d6eb4
* a820c04 Add 1 text block, remove 1 image
* ff32461 Edit 1 text block
```
