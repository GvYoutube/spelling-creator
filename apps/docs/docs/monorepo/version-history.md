---
title: Version history (git, by content block)
---

# Version history (git, by content block)

Every lesson is a **real git repository**, kept in the browser. Edits are
committed automatically as you work, forking a lesson **clones** its repository,
and merging compares **block ids**.

The whole design falls out of one decision about how a lesson is laid out on
disk.

## The layout: one file per block

A lesson document is `{ title, sections: [{ id, name, blocks: [...] }] }`, and
every block already carries a stable id (`@spelling-creator/core/id`). The repository stores it
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
(`@spelling-creator/core/git/ops`):

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

## Restoring, and undoing

Restoring an old version is an ordinary **forward** commit whose tree happens to
equal an older one. History is never rewritten: the version you restored _away
from_ stays in the timeline, so the restore itself can be undone by restoring
again.

Restoring is the blunt instrument, though — it takes the whole document back and
drops everything since. **Undo** is the precise one: put back what _that one
version_ changed, and keep the rest. It is the same three-way merge as everything
else here, with the sides pointed backwards:

| Merge argument | Undoing commit C                  |
| -------------- | --------------------------------- |
| base           | the document as C left it         |
| ours           | the document now                  |
| theirs         | the document immediately before C |

Every rule then falls out without a line of new logic, including the field-level
one: a block C changed differs between base and theirs, so theirs wins and it goes
back; a block changed since differs between base and ours, so ours wins and is
kept; a block in both _but in different fields_ merges field by field, with both
surviving. Only a block where the same field was changed on both sides is a genuine
conflict — the change being undone has been built on in the very place it touched,
and only the author can say what they meant — so that is what reaches the dialog. The result is a forward
commit with one parent, so an undo can itself be undone.

The history view asks two questions about a selected version, because they have
different answers the moment anything has happened since: _what changed here_
(history) and _difference from now_ (the decision you are about to make).

## More than one branch

A lesson's repository holds a branch per **variation** — an alternative version of
the lesson its author is trying out, kept apart from the one people are reading.
The default branch (`main`) is the lesson; the rest are drafts of what it might
become.

Which one is being edited is `HEAD`, a symbolic ref, exactly as in git. That is
not just tidiness: `HEAD` lives inside the gitdir, so it survives the two places a
repository is copied wholesale — publishing a draft (`adoptDraftRepo`) and forking
a lesson locally (`copyRepo`) — neither of which knows branches exist.

Everything on this page is per branch as a result. A commit moves whatever `HEAD`
points at; the history view reads the branch being edited unless given a ref; the
pack carries every branch, and the push compare-and-swaps each one separately.
What doesn't change is what "the lesson" means: `main`, and only `main`, is what a
reader sees, what a fork clones, and what a proposal is offered against.

See [Variations](/web-app/lesson-variations) for what an author sees, why a
variation is as public as its lesson, and how a deletion travels.

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
GET /git/:lessonId/refs   public*  -> { head, refs, updatedAt }   (404 = no history)
GET /git/:lessonId/pack   public*  -> the packfile (X-Git-Head names its tip,
                                      X-Git-Refs every branch it holds)
PUT /git/:lessonId/pack   Bearer   -> store it (the author, or a trusted collaborator)
```

Stored as two R2 objects per lesson, in the `LESSON_GIT` bucket — plus one per
open [pull request](/web-app/pull-requests), which is a packfile too:

```
git/<lessonId>/pack           the packfile bytes
git/<lessonId>/refs.json      { head, refs, size, updatedAt }
git/pulls/<pullId>/pack       a proposal's snapshot (no refs.json: its tip is fixed)
```

The pack carries its own tip **and its branch map** in R2 `customMetadata`, echoed
in the `X-Git-Head` and `X-Git-Refs` response headers — so a clone reads the bytes
and the refs they belong to from the _same object_, and can never pair a fresh ref
with a stale pack.

`GET` is public because forking a published lesson is public; a private draft's
history (like the draft itself) 404s to everyone but its author, a trusted
collaborator, and moderators — same as a shadowbanned lesson, and mirroring
`GET /lessons/:id`. `PUT` verifies the caller may write (below), caps the pack at
10 MB, and rejects anything that doesn't begin with the `PACK` magic bytes.

### Setup

```bash
# Create the R2 bucket the LESSON_GIT binding points at (see apps/api/wrangler.jsonc).
wrangler r2 bucket create spelling-creator-git
```

The `forked_from` column is added by `apps/api/schema.sql` (safe to re-run).

## Merging is comparing block ids

When a fork and its original have both moved on, the editor lines the three
documents up **by block id** — base (their common ancestor), ours, theirs — and
decides each block independently (`@spelling-creator/core/git/merge`):

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

Unless it needn't be. When our side _is_ the merge base — their history already
contains ours and we have added nothing to it, neither commits nor uncommitted
edits — the merge is a **fast-forward**: our branch moves to their commit and no
merge commit is written. There is nothing for one to record, and manufacturing it
would put an entry in the lesson's timeline saying a decision was made when none
was.

## Merging a fork back in (pull requests)

Anyone can fork a lesson and pull the original's later changes in. Going the other
way — landing your work in the original, for everyone — is a **pull request**: you
propose your history, and the lesson's author (or a trusted collaborator) reviews
and merges it. A fork never writes the lesson it came from.

The mechanics are the ones on this page, pointed the other way. The proposal
travels as a packfile, exactly as a fork does; the reviewer indexes it into the
lesson's own repository, where its objects meet the commits the two already share;
and the merge is the same three-way, block-by-block merge against their true merge
base. What's different is only _who_ runs it and _when_ — in the reviewer's editor,
after they've read it.

The order the reviewer's side runs in is fixed:

1. Merge the proposal into the lesson, settling any conflicts in the usual dialog.
2. **Push** the merged history to the lesson.
3. **Then** write the lesson's document row.
4. **Then** record the proposal as merged — which the Worker will only accept if
   the merge commit really is what the lesson's stored history now points at.

Step 3 is after step 2 on purpose: if the push is rejected, the lesson's document
must be left exactly as it was. Step 4 is after both for the same reason — a
proposal must never read as merged when its changes weren't landed.

See [Pull requests](/web-app/pull-requests) for the endpoints, the permission
rules, and what a proposal is made of.

### Nobody can overwrite anybody

The moment a lesson has two possible writers, "last write wins" would silently
destroy work: whoever saved second would replace the other's commits with a
history that never contained them. So **a push is a compare-and-swap**.

The client sends `X-Git-Parent`: the head it believes the lesson is on. If that
isn't the head the Worker holds, the push is rejected with **409**, and the client
must fetch, merge, and retry. So an accepted push always contains what it replaced.

This guards **both** writers, symmetrically:

- A collaborator saving from an editor that hasn't caught up → 409. Their push
  would have erased the author's newer commits.
- The **author**, saving from a stale editor after a collaborator saved (or merged
  a pull request in) → also 409. Their save would have erased that work.

In both cases the editor responds the same way: it merges the other side in and
asks the user to save again. Nothing is overwritten, and the merge is by block id
as usual — so two people who touched different blocks (or different fields of the
same block) never even see a dialog.

The same rule is what makes a merged pull request safe: the reviewer's push is
compare-and-swapped like any other, and the Worker won't record the proposal as
merged unless that push actually landed.

### What a trusted collaborator may _not_ do

Their write is deliberately narrow. The Worker allows them the lesson's **title,
document and history**, and nothing else:

- they cannot **publish or unpublish** it (visibility stays the author's call), and
- they cannot change the **trusted list itself** — the Worker takes that from the
  row as it stands and ignores whatever the incoming document says.

That last one matters: otherwise a trusted collaborator could add themselves to
another lesson, or hand the privilege to someone else. Nobody can widen their own
access, whether they're saving an edit or landing someone else's proposal.

They also can't delete the lesson — `DELETE /lessons/:id` is still author-only.

And nobody _outside_ that pair writes a lesson at all. A forker with a hundred
commits of improvements still can't push them: they open a
[pull request](/web-app/pull-requests) and one of these two merges it.

## What is deliberately not versioned — or shared at all

`doc.trustedCollaborators` holds collaborator **email addresses** (see
[Live collaboration](/web-app/live-collaboration)), and it lives inside the
lesson document, which otherwise goes everywhere. The rule is that the field
never leaves the browser it was typed into, and it is enforced at each of the
three places the document travels:

| It travels as               | What stops the emails going with it                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| a **git packfile**          | Excluded from the tree — a pack is uploaded so anyone can clone it                                                        |
| the **collaboration Y.Doc** | Stripped before reconciling (`stripLocalFields`) — the room is mirrored to everyone the host admits, not only the trusted |
| the **lesson API**          | Stripped by the Worker (`stripCollaborators`) — `GET /lessons/:id` is public, and server-rendered into the page           |

It comes back from the live document on the way in: a restore, a merge, or a
host adopting the room's document all run `preserveLocalFields`
(`@spelling-creator/core/git/doc`), so the list survives round trips it was never
part of. And because a document can now legitimately arrive without the field,
`PUT /lessons/:id` treats **absent** as "leave the stored list alone" — only an
explicit array replaces it, so an ordinary save can't quietly wipe it.

The two callers who do get the list from the API are the lesson's author (who
manages it) and the collaborators on it (whose browsers need it to auto-admit
each other). Not the public, and not moderators.

## Where it lives

Portable (`@spelling-creator/core/git/*`) — no filesystem of its own, so it runs
in the browser, in Node and inside the Worker:

| Module   | Purpose                                                            |
| -------- | ------------------------------------------------------------------ |
| `doc`    | Pure doc helpers: canonical JSON, manifest, block map. No git.     |
| `refs`   | Branch names, limits, and the ref map's wire format. No git.       |
| `ops`    | Diff two docs into operations; render commit messages. No git.     |
| `merge`  | Three-way merge by block id, field-level. No git.                  |
| `layout` | Document ⇄ git tree (one file per block).                          |
| `repo`   | Commit, history, diff two commits, restore.                        |
| `pack`   | Pack for upload; clone/fetch from a pack; merge base; ancestry.    |
| `remote` | The `/git/:lessonId` Worker calls (incl. the 409 on a stale push). |
| `memfs`  | An in-memory filesystem, for the hosts with no other.              |

`remote` reads the API's base URL through `@spelling-creator/core/config` rather
than the bundler's env, which is what lets it sit on this side of the line.

Browser-bound (`@spelling-creator/core/browser/git/*`) — framework-agnostic, but
needs a real browser:

| Module | Purpose                                                      |
| ------ | ------------------------------------------------------------ |
| `fs`   | LightningFS — the IndexedDB filesystem the repos live on.    |
| `sync` | Fork (clone), merge, push, and both sides of a pull request. |

Server-side (`apps/mcp/src/git.js`) — the fork-and-propose flow for an AI
assistant, which is `browser/git/sync`'s two outbound steps built on `memfs`
instead of LightningFS. It keeps no repository between calls: a fork is a real
hub lesson with its own stored pack, so each call clones that pack, does one
thing to it and uploads the result. See
[Pull requests](/web-app/pull-requests) and [MCP tools](/mcp-server/tools).

App-bound (`apps/web/src/lib/git/`) — what cannot leave the bundle:

| File                    | Purpose                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `engine.js` + `load.js` | The git engine, behind one dynamic import.                             |
| `useLessonGit.js`       | The editor's controller: setup, periodic commits, history, variations. |

`repo` and friends take their filesystem through `repoCtx` rather than opening
one, which is exactly what lets the same commit/merge/restore logic run against
LightningFS in the browser, and `memfs` in Node, in the Worker and in tests.

A repo tracks remotes in git's own vocabulary: `origin` (this lesson's own
published history, which a trusted collaborator may have moved on without us —
one `refs/remotes/origin/<branch>` per branch the hub holds), `upstream` (the
lesson it was forked from), and, while one is being reviewed,
`refs/remotes/pull/<id>` — one ref per proposal, so two open ones can't overwrite
each other's tip.

Worker: `apps/api/src/routes/git.js` and `apps/api/src/routes/pulls.js`, with the
trusted-collaborator check in `apps/api/src/lib/lesson.js`
(`isTrustedCollaborator`).

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

`engine.js` also installs the `Buffer` polyfill (from the `buffer` package) —
isomorphic-git writes git objects through Node's `Buffer`, which browsers don't
have. It is imported and assigned to `globalThis` at the top of that module
rather than injected by the bundler, so it lands in the git chunk alongside the
code that needs it, not in the main bundle.

Keeping it there depends on the `codeSplitting` groups in
`apps/web/vite.config.js` being tagged `$initial`: without that tag the vendor
group captures dependencies reached only through a dynamic import, and
isomorphic-git ends up back in the bundle every visitor downloads.

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
