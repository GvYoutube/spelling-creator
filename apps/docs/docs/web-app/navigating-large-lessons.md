---
title: Navigating large lessons
sidebar_position: 15.6
---

# Navigating large lessons

A finished lesson is long. The editor is a single scrolling column, and past a
certain size that column stops being navigable: you scroll, you lose track of
which section you're in, and the block you were fixing becomes unfindable.

This page records what that costs, measured, and the mechanisms that answer it.

## How long "long" actually is

Measured against a lesson built to the standard shape the MCP server documents —
6 sections × (2 text paragraphs + 4 spelling words + 15 questions), 108 blocks:

|                 | desktop 1280×800 | phone 390×844 |
| --------------- | ---------------- | ------------- |
| Page height     | ~29,700px        | ~45,700px     |
| In screenfuls   | **37**           | **54**        |
| One section     | ~4,900px         | ~8.9 screens  |
| Scrollbar thumb | 21px             | 16px          |

Where the height goes, by block type (desktop):

| Block type            | Count | Each      | Total    | Share   |
| --------------------- | ----- | --------- | -------- | ------- |
| Questions (all types) | 90    | 159–359px | 23,094px | **77%** |
| Text                  | 12    | 192px     | 2,304px  | 8%      |
| Spelling              | 6     | 278px     | 1,668px  | 6%      |

Question blocks are three quarters of the scroll. Anything that compresses them
buys more than anything else can — see [What isn't solved yet](#what-isnt-solved-yet).

## Sticky section headers

Each section's header row — number, name, block count — is `sticky` and pins
directly below the app bar, so the section you're in is named on screen the
whole time you're inside it. It hands off to the next section's header the way
any sticky list does.

Two details make it work:

- **It pins to `--header-h`, not to `0`.** `globals.css` publishes the app bar's
  height as a pair of tokens: `--header-row-h` (the bar itself — `AppHeader`
  applies it as `h-(--header-row-h)`, so it's the single source of truth) and
  `--header-h`, which adds `env(safe-area-inset-top)` for the
  [installed app](./pwa-and-offline.md), where the header pads itself by the iOS
  status bar. `--header-h` is the real distance from the top of the viewport to
  the first pixel of page content. Use it for anything that has to sit clear of
  the bar, including `scroll-mt-(--header-h)` on anything scrolled to
  programmatically.
- **The row bleeds out of the card's padding.** It lives inside `SectionCard`'s
  `p-4`, so it carries `-mx-4 -mt-4 px-4 pt-4` to reach the card's edges;
  otherwise blocks would scroll visibly through the gap beside it. `bg-card` is
  translucent by design, so it also takes `backdrop-blur-(--glass-blur)` — the
  same glass treatment as `AppHeader`, for the same reason. `z-30` keeps it
  under the app bar's `z-40`.

Nothing between the header and `<body>` sets `overflow` to anything but
`visible`, which is the usual thing that silently breaks `position: sticky`. Keep
it that way.

### Only the identity is pinned

The section header holds two things: identity (number, name, size) and controls
(move up, move down, delete). Below `sm` the controls wrap onto a second row —
see [Mobile layout & touch targets](./mobile-layout.md) for why they can't share
the first — and pinning that second row made the sticky header **113px, 13% of
an 844px screen**, on top of the app bar's own 64px.

So only the identity row is sticky. The controls are rendered twice, once inside
the identity row (`hidden sm:flex`) and once below it (`sm:hidden`), with a
breakpoint hiding whichever copy doesn't apply — `display: none` takes the
hidden copy out of the accessibility tree too, so only one is ever exposed. On a
phone the sticky header is 65px (8%) and the controls scroll away with the top
of the section.

The rule this encodes: **permanent screen space is for knowing where you are,
not for controls you go looking for when you want them.**

## Question numbering

A question block used to show its type badge and nothing else, so ten "Open
ended" cards in a row were visually interchangeable and scrolling back to the
one you were fixing was a guess. Each now shows its 1-based position among its
section's questions — `Q7` — which makes it nameable.

Numbered **per section, not per lesson**, because that's how questions are
authored and read (the MCP authoring standard specifies fifteen per section, in
a fixed order). `SectionCard` computes the numbering and passes it down as a
plain number; it stays a stable prop, so inserting a question mid-section
re-renders only the blocks whose number actually changed.

The section header shows `18 blocks` alongside the name for the same reason —
it gives the section a length that isn't just a scrollbar. Desktop only; on a
phone the name needs that row.

## Collapsing sections

Every section folds to its header, from the chevron at the left of that header
or all at once from **Collapse all** next to the lesson's section/block counts.
Measured on the same 108-block lesson:

| State                         | Page height | Screens (800px) |
| ----------------------------- | ----------- | --------------- |
| Everything expanded           | 29,667px    | 37              |
| One section open, five folded | 5,933px     | 7.4             |
| Everything folded             | **1,186px** | **1.5**         |

A folded card keeps its number, name, block count and move/delete controls, and
shows what's inside — `2 paragraphs · 1 spelling list · 15 questions` — because
a section reduced to a name alone says nothing about what it holds or how far
along it is.

### The state is local, and per tab

Collapsed state lives in `EditorPage`, **not** in the document. It isn't
content, it must never reach the exporters, and it is never sent to
collaborators — the same reasoning as `SectionCard`'s `activeBlockId`. What one
person folds away to get some screen back is theirs, not everyone's.

It's held there rather than per-card so that "collapse all" is possible, and
reaches each card as a plain boolean so folding one section doesn't re-render
the others. It persists to `sessionStorage`, per tab, like the focus position
above.

### Find-in-page still works

A folded body is hidden with **`hidden="until-found"`**, not unmounted, so the
browser can still search it; when Cmd-F lands on a match inside, the browser
reveals the content and fires `beforematch`, which the card listens for and
adopts into React state.

The attribute is set imperatively from a `useLayoutEffect`, deliberately not
through JSX, because **React 18 treats `hidden` as a boolean attribute**:
`hidden="until-found"` renders as a plain `hidden=""`, which is `display: none`
and not searchable at all. This was verified in the browser — it is not a
one-line prop. Since React never renders the attribute, the two can't disagree,
including when the browser removes it on a match.

Browsers without `until-found` support fall back to hiding the content
outright, which is what unmounting it would have given us anyway.

### Consequences of `content-visibility: hidden`

`hidden="until-found"` is `content-visibility: hidden` underneath, and its
descendants **still report a full-size `getBoundingClientRect()`**. Anything
that measures elements has to account for that — measuring alone will not tell
you the content is hidden.

`CollabCursors` is the case in the codebase today: it pins a caret and avatar to
`[data-collab-field]` elements, and a field inside a folded section measured
perfectly reasonably, so a collaborator's avatar would be drawn floating over
the collapsed card. It now skips fields that fail `Element.checkVisibility()`,
falling back to `closest("[hidden]")` where that API is missing. A collaborator
editing inside a section you've folded is simply not shown; their edits still
arrive as normal.

### Folding never loses your place

Three interactions would otherwise leave the user somewhere arbitrary:

- **Folding a section you're inside** pulls thousands of pixels out from under
  the viewport. If the card's header has already scrolled past, the card is
  scrolled back to just under the app bar first. Verified: collapsing from
  3,000px deep inside a section leaves that card's top at exactly the app bar's
  bottom edge.
- **Collapse all / expand all** changes the page height by ~25x, which on the
  way down means the browser clamps you to the bottom of a suddenly-short
  document. The section you were in is pinned to the top of the viewport
  instead, in both directions.
- **Restoring a position** into a section you'd folded scrolls to the section's
  card rather than expanding it behind your back. A collapsed section is a
  decision; its header still gets you to the right place.

### Dragging into a folded section

Cross-section drag-and-drop still reaches a collapsed section: dwell over one
with a block in flight and it **springs open** after 500ms, on a dwell rather
than on the first `dragover` so that dragging _past_ a folded card on the way
somewhere else doesn't keep re-flowing the page under the pointer. While it's
still folded, its summary line becomes the drop zone, and dropping there before
the spring fires expands the card and appends the block — the same thing an
empty section does, rather than swallowing the block into a card you can't see.

## Position is preserved across edits

Three things used to throw away the user's place.

**Reordering.** `moveSection` and `moveBlock` reorder elements that are
screenfuls tall. Under a fixed `scrollY` that flings the thing you just moved —
and the button you just pressed — far off screen: "move section down" landed you
in the middle of a _different_ section.

`lib/useScrollAnchor.js` fixes this. Call the returned `anchor(selector)`
immediately **before** the state update that reorders the DOM; after React
commits, the hook re-measures that element and scrolls by the difference, so it
ends up back under the same pixel. It anchors the _moved_ element rather than
the page, which is what makes the move buttons repeatable — they stay under the
pointer, so a block can be walked up a section one click at a time. Measured
drift after a section move: **0px** (previously ~4,900px).

The correction runs in `useLayoutEffect`, not `useEffect`, so it lands in the
same frame as the reorder; otherwise the page paints once at the wrong offset
and visibly jumps.

It's bounded by the scroll range: reordering inside a document only a screen or
two tall — every section collapsed, say — can leave some drift (measured: 131px,
with the page already clamped at its maximum scroll) because there is nowhere
left to scroll. Unavoidable rather than a defect, and in a document that short
whatever moved is still on screen.

**Deletes deliberately don't use it.** Deleting only changes layout _below_ the
deleted element, and you can only delete something you can see, so nothing above
the viewport shifts and there's nothing to correct.

**Adding a section.** A new section is appended to the end of the document,
which in a six-section lesson is ~30,000px below wherever the user is standing —
the dialog closed and, as far as the screen showed, nothing happened. The editor
now scrolls to the new card and puts the cursor in its name field. The focus
call passes `preventScroll: true`, or it would jump the viewport there instantly
and cancel the smooth scroll that had just started.

**Leaving and coming back.** The editor records the last block that held focus
and returns there on the next mount, so a reload or a trip to the hub doesn't
drop you at the top of a 54-screen document.

It stores a **block id, not a scroll offset**: block heights change as the
lesson is edited and as images load, so a pixel position points at something
else by the time it's used, while an id still means the thing you were working
on. It's written by a `focusin` listener straight to `sessionStorage`, entirely
outside React — lifting `SectionCard`'s local `activeBlockId` up to `EditorPage`
would re-render every section on each focus change, the exact cost keeping it
local avoids on a 108-block document.

`sessionStorage`, not the IndexedDB draft store, because this should expire with
the tab: coming back to a lesson tomorrow ought to start at the beginning;
coming back from the hub five minutes later ought not to. Restore runs once per
mount, so it can never yank the page from someone who has already started
scrolling, and it scrolls instantly rather than smoothly — this is where you
already were, so it shouldn't play as a journey.

## Scrolling to something, generally

`lib/useScrollAnchor.js` exports two helpers alongside the hook:

- `scrollToElement(el, { block, smooth })` honours the OS "reduce motion"
  setting. A smooth scroll is worth it for a deliberate jump — you see where
  you're being taken — but never for restoring a position on load. Restores pass
  `smooth: false`.
- `idSelector(attr, id)` builds `[data-block-id=…]` through `CSS.escape`. Ids
  are not always ours: `jsonImport`'s `keepId()` passes any string in a lesson
  file through verbatim, and one containing a quote would make `querySelector`
  throw.

Scroll targets align with `block: "center"` when the target is a block —
aligning a block to the top of the page would put it underneath its own
section's sticky header.

## What isn't solved yet

One further step the measurements point at, not built:

- **Collapsing inactive question blocks** to a single line, expanding on focus.
  This is where the 77% lives: measured at **10,354px** (−65%) _with every
  section still expanded_, so it compounds with section collapse rather than
  competing with it, and it needs no navigation UI at all. It's also the most
  invasive change to how editing feels, which is why section collapse came
  first — that may well be enough.

Also unbuilt, and worth considering only if collapsing turns out not to be
enough: a jump-to-section control (an outline sidebar, or a dropdown on the
sticky header). Collapse-all already answers most of what it would be for —
it turns the lesson into a 1.5-screen list of its sections that you can click
into.

Two approaches were considered and rejected: rendering one section at a time
(`Tabs`) and virtualizing the block list. Both break cross-section
drag-and-drop, which [Overview & features](./overview.md) documents as a
headline feature, and both break find-in-page.
