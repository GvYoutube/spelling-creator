---
title: Pull requests (proposing changes)
---

# Pull requests (proposing changes)

Anyone can **fork** a published lesson and do what they like with their copy. But
nobody can write somebody else's lesson. To offer work back, you open a **pull
request** against the original, and its author — or one of the trusted
collaborators they named — reviews it and merges it in.

That review step is the whole feature. There used to be a direct route: a trusted
collaborator could merge their fork straight into the original, writing its
document and its history in one action. That's gone. A lesson now only ever
changes because someone with authority over it chose to change it, and every
change from outside arrives as something they can read first.

## The shape of it

```
        fork                    propose                     review & merge
lesson ───────▶ your copy ──────────────────▶ pull request ────────────────▶ lesson
                (edit freely)                 (a snapshot)                   (+ merge commit)
```

1. **Fork** the lesson from its page. You get a genuine clone of its git
   repository — full history, shared ancestry (see
   [Version history](/monorepo/version-history)).
2. **Edit** your copy. It's yours; publish it, keep it as a draft, whatever.
3. **Propose changes to _lesson_** in the editor. This packs your repository and
   uploads it with a title and an optional note. Nothing in the original changes.
4. The lesson's author sees it on the lesson's **Proposals** tab
   (`/hub/:id/proposals`), and gets a notification. Each proposal also has a page
   of its own at `/hub/:id/proposals/:prId`, which shows **what it changes** and
   whether it would merge cleanly (see below). They (or a trusted collaborator)
   hit **Review & merge**.
5. That opens the lesson in _their_ editor (`?pull=<id>&lesson=<lessonId>` — the
   link names both, so the review waits for the lesson it belongs to rather than
   running against whatever the reviewer already had open) and runs the usual
   block-by-block merge. The merge dialog opens with a summary of everything that
   settled on its own, and a choice to make for each genuine clash — often none.
   Nothing is written until they confirm. A proposal the lesson already contains
   skips all this and is simply recorded as merged.
6. On confirm: the merge is pushed to the lesson's history, the lesson's document
   is saved, and the proposal is marked merged. You get a notification.

Either side can also **close** it — you withdraw yours, the author declines it, a
moderator removes it. A closed proposal keeps its row (the conversation stays
visible); only its stored changes are dropped.

## A proposal is a snapshot

What a pull request actually contains is a **git packfile** — your fork's lesson
as it stood the moment you opened the request — stored in R2 under
`git/pulls/<id>/pack`, beside the lessons' own packs.

The lesson, and not your [variations](./lesson-variations.md) of it: a variation is
an idea you are still turning over, and offering one to somebody else to merge,
unasked and unmentioned, is not what "propose changes" means.

Which version of your fork? **The one you were working on.** If you developed the
idea on a [variation](./lesson-variations.md), that is what gets proposed — and
only that one, so the rest of your variations stay yours. The proposal records
which branch it came from, and the review queue says so.

Snapshotting is deliberate. You carry on editing your fork after proposing, and a
request that silently tracked your branch would mean the reviewer reading one
thing and merging another.

## Updating a proposal

The pack used to be written once and never rewritten, which made "silently" moot
by making _any_ change impossible — so being asked for a tweak meant closing the
proposal and opening another, throwing away the discussion attached to it.

Proposing again from the same fork now **updates** the proposal you already have
open, and records that it happened: the version number goes up, the commit it used
to point at is kept, and the page shows _"Version 3 · updated 4 March"_ along with
what that last update changed. Nothing moves silently; what was actually being
protected was never immutability, it was that nothing changes without saying so.

A proposal may only move **forward** — the new tip has to contain the one the
proposal already points at. That is what keeps one pack per proposal honest: the
previous version's commit is still reachable in the new pack, which is how "what
the last update changed" is answerable without storing a pack per version. It is
checked by the client, because the Worker holds a proposal's history as an opaque
packfile it cannot walk — the same limit that stops the merge endpoint verifying
ancestry, bounded the same way, since the only proposal you can rewrite is your
own and you could always have closed and reopened it.

There is a ceiling of **20 updates**. Past a couple of dozen rewrites it is a
different change, and the thread attached to it has stopped being about what the
proposal now contains.

An assistant working over MCP follows the same rule: `propose_changes` from a fork
that already has one open updates it rather than stacking a second one beside it.

Because a fork is a real clone, that pack shares object ids with the lesson's own
history. The reviewer indexes it into the lesson's repository, where its objects
meet the commits the two already share, and git finds their true **merge base**.
So merging a proposal is the same three-way, block-by-block merge as pulling an
original's changes into a fork — just pointed the other way.

Opening a request is therefore two steps: insert the row, then upload the pack
against its id. A row is `ready` only once the pack has landed, and an unready row
is listed **only to the person who opened it** — there's nothing to review, and a
reviewer shouldn't have to tell a half-finished submission from a real one. If the
upload fails, the client withdraws the empty request rather than leaving it in the
author's queue.

## Reading one without merging it

A proposal's own page shows its changes — block by block, in the same summary the
history view renders — and whether merging it would ask the reviewer for anything:

- _"This merges cleanly — there's nothing to decide."_
- _"2 blocks have been changed here and in the lesson, so merging will ask you
  which to keep."_
- _"These changes are already part of the lesson."_

That is computed on the page, from the git objects themselves. Both packs are
public exactly as far as the lesson is, so the browser indexes the proposal's pack
beside the lesson's, finds the commit the two diverged at, and diffs against
**that** — not against the lesson's current tip, which would show the author's own
later edits as though the proposer had made them, reversed.

Merging still happens in the editor, and that split is deliberate rather than a
limitation: merging commits to the lesson's history and pushes it under the
reviewer's credentials, which needs the editor's repository. Reading needs none of
it. What changed is that nobody has to start a merge to find out whether they want
one.

The git engine is ~200 KB and is fetched on demand when this page opens, so the
proposal's title, author and note render first and the diff arrives after. If it
can't be read at all, the page says so and the rest of it still works.

## Trying it before deciding

Reading a diff tells you what changed. It doesn't tell you whether the lesson
still works with the change in it — whether the new question fits where it was
put, whether the rewritten section still reads in order.

So there is a third answer between merging and declining: **try it in a
variation**. That lands the proposal on a [variation](./lesson-variations.md) of
the reviewer's own, where they can click through the whole lesson with the change
in place. The lesson everyone reads is untouched, and the proposal stays open —
nothing about it is recorded, because nothing has been decided.

Mechanically it is the two features meeting and needing almost nothing new: a
merge commits to whatever branch is checked out, so the editor starts a variation
named after the proposal and checks it out _before_ preparing the merge. What it
must not do is record the proposal as being reviewed, since that is what makes the
confirm push and mark it merged — a try-out deliberately does neither.

Trying the same proposal twice returns to the variation the first attempt made,
rather than refusing on the name, so whatever the reviewer did to it last time is
still there.

## Landing it without a merge commit

When the lesson hasn't moved since the proposal was opened, the merge is a
**fast-forward**: the lesson's branch simply moves to the proposal's commit. No
merge commit is written, because there is nothing for one to record — no decision
was made and no content changed that the proposal's own commits don't already
describe.

Two conditions, and both are needed. The lesson's tip must be the merge base (the
commit-graph half), and the reviewer must have nothing uncommitted in their editor
(the half the graph can't see — skipping it would drop whatever they had typed but
not yet paused long enough to commit).

The proposal is still recorded as merged against the commit the lesson now points
at, which is the proposal's own head. If anything that is easier to verify than
before.

## Who can do what

| You are                    | Open | Merge | Close                      |
| -------------------------- | ---- | ----- | -------------------------- |
| Anyone signed in           | ✅   | ❌    | ❌                         |
| The person who opened it   | ✅   | ❌    | ✅ (withdraw)              |
| The lesson's author        | ✅\* | ✅    | ✅ (decline)               |
| A **trusted collaborator** | ✅   | ✅    | ✅                         |
| A moderator/admin          | ✅   | ❌    | ✅ (as with any user text) |

\* Only from a fork they own — see below.

### Proposing to your own lesson

Out of nowhere, this is a mistake: you can just save, so the Worker refuses a
proposal against your own lesson rather than creating a request nobody needs.

It's allowed when it **carries a fork of that lesson which you own** — that is,
`sourceLessonId` names one of your lessons whose `forked_from` is this one.
Ownership alone isn't enough, since any other lesson of yours would satisfy it and
turn the rule off entirely. Then it means something specific: _here is a copy with
changes in it, let me read the diff before it lands._ Two things use that:

- An **AI assistant over MCP** acts as the account it's signed in with, so
  changes it proposes to your lesson arrive from your own id. Holding them in the
  review queue is the entire point — the lesson is untouched until you read the
  diff and merge it. See [MCP tools](/mcp-server/tools).
- **"Fork into a new lesson"** in the editor gives a human the same route for
  work they want to look over before committing to it.

You can then merge it yourself, since you're the author. The notification you get
reads "Changes are waiting for your review" rather than naming a proposer, because
the account is yours; the proposal's body says what opened it.

"Trusted collaborator" is not a new concept: it's the email list the author
already manages in the collaboration dialog (`doc.trustedCollaborators`, the same
list that auto-admits someone to a live session). See
[Live collaboration](./live-collaboration.md).

Moderators can **close** a proposal — the same power they have over any other
user-submitted text — but not merge one. Merging is authorship, and a moderator's
job is removal, not writing under someone else's name. That mirrors comments,
where a moderator can delete but not edit.

Every one of these rules is re-derived server-side on every request. The frontend
checks are only about which buttons to draw — and even those come from the
server: the listing endpoint answers `canReview` for the caller, rather than
having the browser work it out from a trusted list it shouldn't need to read.

## "Merged" has to be true

A reviewer's merge happens in their editor and is pushed to the lesson's history
through `PUT /git/:lessonId/pack`, under their own credentials. Only then is the
request marked merged.

The merge endpoint doesn't take the client's word for that. `mergeCommit` must be
the commit the lesson's stored history now actually points at, or the request is
refused with a 409 telling the reviewer to save first — and a lesson with no
stored history at all can't have been merged into, so that's refused too. A
proposal therefore can't be recorded as merged while its changes are quietly
dropped, which is the failure that matters: a lesson whose record of what
happened to it is fiction.

What the endpoint **can't** check is that the commit it's given descends from
_this_ proposal. That means walking the commit graph, and the Worker holds a
lesson's history as an opaque packfile — it has no filesystem to index one into,
so the ancestry isn't readable there. A reviewer could merge proposal A and
record proposal B against it.

That gap is bounded by who can reach it. Only the lesson's author and the
collaborators they trust can call it, and they can already rewrite the lesson
however they like, or simply close a proposal they don't want — so the exposure
is a mislabelled record, not a way in. And nothing is destroyed by it: a merged
proposal keeps its packfile, so a merge recorded in error can be read back and
settled properly.

The order is therefore fixed, and it's the only one that works:

1. push the merged history,
2. save the lesson's document,
3. mark the proposal merged.

If the lesson moved on beneath the reviewer while they were reading (its author,
or another collaborator, saved), step 1 is refused by the same compare-and-swap
that guards every push. Nothing is overwritten, the proposal stays open, and the
reviewer merges that in first.

## Moderation and limits

A proposal's title and body are **plain text**, and both go through the same
`glin-profanity` check a comment does — the whole thing is rejected, not censored
and kept. Banned users (by name or IP) can't open one, and everyone needs a
display name first, so an author never sees a raw email in their review queue.

One person may have at most **5 open proposals** against one lesson at a time.
Titles are capped at 200 characters and descriptions at 4,000 — the limits live in
`@spelling-creator/core/pulls` and are imported by both the form and the Worker, so
the counter and the validation can't drift apart.

## Visibility

A proposal is as public as the lesson it targets. On a published lesson, the
proposals list and the proposed changes themselves are public — a proposal is part
of that lesson's public conversation, like a comment on it. On a private draft,
they're as private as the draft.

That means what you propose is readable by anyone who can read the target lesson,
which is why the submission dialog says so plainly before you send it.

## Worker endpoints

| Method & path                         | Auth                    | What it does                                                                                              |
| ------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /lessons/:id/pulls`              | none, unless a draft\*  | `{ "pulls": [...], "canReview": bool }` — newest first; unready rows only for their own author            |
| `POST /lessons/:id/pulls`             | `Bearer <Supabase JWT>` | Opens a proposal (`{ title, body, head, headRef, base, sourceLessonId }`); the author only from a fork    |
| `PUT /lessons/:id/pulls/:prId/pack`   | `Bearer <Supabase JWT>` | Uploads its packfile. The proposer's; the first must match the row's head, a later one records a revision |
| `GET /lessons/:id/pulls/:prId/pack`   | none, unless a draft\*  | The packfile; `X-Git-Head` names its tip                                                                  |
| `POST /lessons/:id/pulls/:prId/merge` | `Bearer <Supabase JWT>` | Records the merge (`{ mergeCommit }`); author or trusted collaborator only                                |
| `POST /lessons/:id/pulls/:prId/close` | `Bearer <Supabase JWT>` | Closes it; proposer, author, trusted collaborator, or moderator                                           |

\* Reads follow the target lesson's own visibility — the single `canReadLesson`
rule in `apps/api/src/lib/lesson.js` that also gates `GET /lessons/:id`, its
comments and its history.

Errors are short plain-text reasons, as everywhere else in this API, so the
frontend can surface `res.text()` directly.

## Where it lives

| Piece                                              | What it does                                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `apps/api/src/routes/pulls.js`                     | The endpoints above, and every permission rule                                            |
| `apps/api/schema.sql`                              | `lesson_pull_requests`                                                                    |
| `apps/api/src/lib/lessonGit.js`                    | R2 key layout (`git/pulls/<id>/pack`) and the sweeps that delete it                       |
| `@spelling-creator/core/pulls`                     | The browser client, and the shared length limits                                          |
| `@spelling-creator/core/browser/git/sync`          | `submitPullRequest` (propose), `prepareProposalReview` (read), `preparePullMerge` (merge) |
| `apps/mcp/src/git.js`                              | The same two steps for an AI assistant — fork, then propose                               |
| `apps/web/src/components/ProposeChangesDialog.jsx` | The submission form                                                                       |
| `apps/web/src/pages/lesson/LessonProposals.jsx`    | The Proposals tab                                                                         |
| `apps/web/src/pages/lesson/LessonProposal.jsx`     | One proposal: its changes, its mergeability, and the hand-off into the editor             |
| `apps/web/src/components/ChangeSummary.jsx`        | The change chips and operation list, shared with the history view                         |
| `apps/web/src/components/PullRequestsSection.jsx`  | The list on a lesson's page                                                               |
| `apps/web/src/pages/EditorPage.jsx`                | `?pull=<id>&lesson=<id>` — the review + merge flow                                        |
| `apps/web/src/components/MergeDialog.jsx`          | Settling conflicts, shared with the fork-sync direction                                   |

A pack is swept when its proposal is **closed** — nothing there will ever be
merged — and when the lesson is deleted, before the row goes, since the cascade
would take the ids with it. A **merged** proposal keeps its pack. Its objects are
in the lesson's history by then and so redundant, but only if the merge really
did contain them, which is the one thing the endpoint can't check; deleting it
would make a mistake unrecoverable to save a few KB.
