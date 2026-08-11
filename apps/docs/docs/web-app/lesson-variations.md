---
title: Variations (trying something without breaking the lesson)
---

# Variations (trying something without breaking the lesson)

A **variation** is a separate copy of a lesson you can change freely. The lesson
everybody else reads doesn't move while you work on one, and nothing you do to a
variation reaches it until you say so.

It exists for the thing authors were doing the hard way: rewriting half a lesson
to see whether the rewrite is better. Before this, the only way to do that
without risking the original was to fork it into a whole second lesson and open a
proposal against yourself. A variation is the same idea at the right size.

## What it looks like

The editor shows which copy you're on, next to the "Version saved" chip:

```
  Version saved 2 minutes ago     Main lesson  ▾
  Version saved just now          Simpler for Year 3  ▾   <- on a variation
```

Clicking it opens the list. From there you can start one, switch between them,
rename one, delete one, and — the point of the whole thing — **bring one into the
main lesson**.

Each variation says how much work is sitting on it ("3 changes that aren't in the
main lesson"), which is the only number an author needs before deciding whether
to open it.

### Bringing one in

This runs the same block-by-block merge as everything else in
[Version history](/monorepo/version-history): the main lesson and the variation
are lined up against the commit they last agreed on, and only a block both sides
changed _in the same field_ reaches a dialog. Usually nothing does, and the merge
summary just says what it settled.

The order matters and is fixed: the editor **switches to the main lesson first**,
then merges the variation into it. That is what makes the result the lesson with
your changes folded in, rather than the variation with the lesson folded in —
which is the same commit and the opposite meaning. Anything you had unsaved is
committed to the variation on the way out, so nothing in flight is carried across
by accident.

Afterwards the variation is still there, now reading "0 changes that aren't in the
main lesson". Keep it and carry on, or delete it.

## Variations are as public as the lesson

They travel with the lesson, so a variation you start on your laptop is there when
you open the lesson on your phone. That is the point — but it means a variation
lives in the same packfile as the lesson, and **a published lesson's packfile is
public**, because that is what makes forking work.

So: anyone who can open the lesson can read its variations. On a private draft
that's you (and anyone you trust); on a published lesson that's everyone. The
dialog says so, in those words, where an author will see it.

If you want to try something genuinely privately, fork the lesson into a new
private draft instead — see [Pull requests](./pull-requests.md).

## What it is underneath

A variation is a **branch** of the lesson's git repository, and switching between
them is a checkout. None of that vocabulary appears in the app, deliberately: an
author isn't doing version control, they're trying something and keeping the
original safe while they do.

The mapping is exact, though, and everything on this page falls out of it.

| In the app                  | In the repository                                   |
| --------------------------- | --------------------------------------------------- |
| The main lesson             | `refs/heads/main` — the default branch              |
| A variation                 | `refs/heads/<name>`                                 |
| Which one you're editing    | `HEAD`, a symbolic ref                              |
| Switching                   | Writing `HEAD`, and adopting the doc at the new tip |
| Bringing one in             | A merge commit on `main`, with two parents          |
| "3 changes that aren't in…" | Commits on the branch not reachable from `main`     |

Recording the current variation in `HEAD` rather than beside the repository is
what makes it survive a reload, a second tab, and the two places a repository gets
copied wholesale — publishing a draft (`adoptDraftRepo`) and forking a lesson
locally (`copyRepo`), neither of which knows branches exist.

### Names

Git bounds what a branch may be called, so what an author types is converted:
spaces become hyphens, anything git reserves is dropped, and the result is capped
at 32 characters. It is read back the other way for display, so "Simpler for Year
3" round-trips. The rules live in `@spelling-creator/core/git/refs` and are
imported by both the editor and the Worker, so what the app offers and what the
server accepts can't drift apart.

A lesson may have at most **12 branches**. That ceiling isn't taste: the branch
map rides in the R2 object's `customMetadata` alongside the pack it belongs to
(so a reader can never pair one moment's bytes with another moment's refs), and R2
caps that metadata at 2 KB.

## How they travel

The lesson's stored `refs.json` gained a map, and kept `head` meaning exactly what
it always did — the default branch, which is what a reader, a forker and the
lesson's own page ask for:

```json
{
  "head": "<oid>",
  "refs": {
    "main": "<oid>",
    "Simpler-for-Year-3": "<oid>"
  },
  "size": 41203,
  "updatedAt": "..."
}
```

The pack holds every object reachable from _any_ branch. That costs almost
nothing: branches of one lesson share nearly all of their objects, and the packer
dedupes by oid, so a second variation adds only the commits unique to it.

A **fork** takes the default branch alone. Somebody else's half-finished ideas
aren't part of what was forked, and adopting them as branches of the fork would
claim they were. A **proposal** likewise carries only the lesson — see
[Pull requests](./pull-requests.md).

### Pushing more than one branch

The compare-and-swap that has always guarded a push now runs per branch. Three
headers describe what a push wants, and the Worker applies all of it or none:

```
X-Git-Refs      the branches to set, { "<name>": "<oid>" }
X-Git-Expected  what the client believes the hub holds for each name it touches,
                with "" meaning "I believe this one does not exist yet"
X-Git-Deletes   the branches to remove, comma-separated
```

Atomicity is free: `refs.json` is a single R2 object and already the commit point,
so every branch advances or none does.

The rule that makes this safe with two devices is that **a branch a push doesn't
mention is left exactly as it is**. Otherwise a device that had never heard of a
variation would delete it simply by not knowing about it. A client sending neither
`X-Git-Refs` nor `X-Git-Expected` — one written before any of this — therefore
still means "move the lesson, leave everything else alone", and keeps working.

### Deleting has to be asked for

Which leaves a gap: if a push only ever _adds_, how does a deletion travel? It
can't be inferred, for the reason above — "I don't have it" and "I deleted it"
look identical from a ref map.

So a delete leaves a marker in the repository (`refs/deleted/<name>`, holding the
tip it pointed at), the next push turns that into an explicit `X-Git-Deletes`
instruction compare-and-swapped against that tip, and only a push that actually
landed clears the marker. Cleared any earlier and the variation would be gone
locally, alive on the hub, and back on the next device that opened the lesson.

The same marker is why fetching doesn't undo a delete: a branch on the hub that we
hold a marker for is not adopted back.

## Where it lives

| Piece                                          | What it does                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `@spelling-creator/core/git/refs`              | Name rules, limits, and the ref map's wire format. No git.         |
| `@spelling-creator/core/git/repo`              | `currentBranch`, create / checkout / rename / delete, `aheadCount` |
| `@spelling-creator/core/git/pack`              | Packing every branch; a clone writing them back                    |
| `@spelling-creator/core/browser/git/sync`      | Per-branch push, adopting the hub's branches, `prepareBranchMerge` |
| `apps/api/src/routes/git.js`                   | The per-branch compare-and-swap (`applyRefs`)                      |
| `apps/web/src/lib/git/useLessonGit.js`         | The editor's variation state and actions                           |
| `apps/web/src/components/VariationsDialog.jsx` | The list, and everything you can do from it                        |
