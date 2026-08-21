---
title: Mobile layout & touch targets
---

# Mobile layout & touch targets

The editor is the one part of the app that was built desktop-first, and it
shows most on a phone. This page records the conventions that keep it usable
there, so new blocks and controls follow the same rules instead of
re-introducing the same problems.

## The problem being solved

Every content block is _content plus a stack of controls_ (drag, move up, move
down, delete, and a couple of block-specific extras). Those controls used to sit
in a fixed column down the right-hand side at every viewport width. The column
costs the same number of pixels whatever the screen, and on a 360px phone
there aren't many to spare:

|                             | width   |
| --------------------------- | ------- |
| viewport                    | 360     |
| less `EditorPage`'s `px-4`  | 328     |
| less `SectionCard`'s `p-4`  | 296     |
| less the block card's `p-4` | **264** |

Out of that 264px the control stack took 128px (text, image, question blocks)
or 164px (spelling blocks, which have two extra buttons). Subtract the `gap-2`
between the content and the controls and what remained was a ~128px box for
typing a 60–110 word lesson paragraph. A spelling word is worse than the 92px
that leaves suggests: each word sits in its own row with a delete button beside
it (`gap-1` + 32px), so the field itself came out at a **~56px box for typing a
6–9 letter word**.

## Rule 1 — controls become a footer below `sm`

`ContentBlock.jsx` defines one shared layout class and uses it for every block
type:

```js
const BLOCK_LAYOUT = "flex flex-col gap-2 sm:flex-row sm:items-start";
```

Below `sm` the row becomes a column: content takes the full width and the
controls wrap underneath, right-aligned, with a hairline (`border-t … sm:border-t-0`)
that makes the row read as a footer rather than as more content. From `sm` up
it's the original corner column, unchanged.

`SectionCard`'s section header splits the same way: the section number and name
keep the first row and the move/delete buttons drop below them. It does this by
rendering the control group twice — once inside the header row (`hidden sm:flex`)
and once beneath it (`sm:hidden`) — rather than by wrapping, because the header
row is sticky and the controls must **not** be pinned with it. Pinning them cost
113px, 13% of an 844px screen. See
[Navigating large lessons](./navigating-large-lessons.md#only-the-identity-is-pinned).

**If you add a new block type, use `BLOCK_LAYOUT`** rather than a bare
`flex items-start gap-2`.

## Rule 2 — 40px touch targets, shrinking to 32px only for a mouse

The editor's icon buttons were `size="icon-sm"` (32px) and its inline buttons
`size="sm"` (h-8, 32px). Both are under Apple's 44pt and Material's 48dp
minimums, and they sit in rows of three to five with 4px between them.

- `IconActionButton` now applies `size-10 sm:pointer-fine:size-8` itself, so
  every block and section control gets this for free.
- Inline `size="sm"` buttons use the `TOUCH_SM_BUTTON` constant
  (`h-10 sm:pointer-fine:h-8`), defined in both `ContentBlock.jsx` and
  `SectionCard.jsx`.
- `ToggleGroup` passes no sizing down to its items, so the image block's
  alignment/size toggles use `TOUCH_TOGGLES`, which reaches them by their
  `data-slot`.

**The shrink is gated on the pointer, not only on the width.** A tablet is
`sm` and up and still driven by a finger, so keying off the breakpoint alone
handed every tablet exactly the 32px targets this rule exists to avoid. The
variants are stacked — shrink only where the screen is wide _and_ the pointer
is fine — rather than written as a `pointer-coarse:` override competing with
`sm:`, because those two are equally specific and which one wins would come
down to the order Tailwind emits the media queries in.

This is the same signal that hides the drag handle (see
[Drag-and-drop is desktop-only](#drag-and-drop-is-desktop-only));
`pointer-coarse` and `pointer-fine` are the two halves of it.

## Rule 3 — `tooltip` is also the accessible name

`IconActionButton` takes a `tooltip` prop and now forwards it as `aria-label`
too. A tooltip labels these buttons for a mouse user and nobody else: touch
devices have no hover, so on a phone each control was an unlabelled icon, and
assistive technology got nothing either. Pass `aria-label` explicitly only when
you want a longer spoken name than the tooltip's text.

## Drag-and-drop is desktop-only

Block reordering uses the HTML5 Drag and Drop API (`draggable` plus
`dragstart`/`dragover`/`drop`, see [Overview & features](./overview.md)).
Android Chrome never synthesises drag events from touch, and iOS Safari only
does so for a long-press in some cases — so on a phone the grab handle was a
control that mostly did nothing, and its `touch-none` meant touching it
swallowed the page scroll as well.

The handle is therefore hidden on coarse pointers
(`pointer-coarse:hidden` in `SectionCard.jsx`). Nothing is lost: the move
up/down buttons sitting next to it reorder blocks without a drag, and they work
across the whole lesson the same way. `useDragAutoScroll` is likewise inert on
touch, which is fine — it only runs while a drag is in flight.

## Safe areas and the home indicator

`index.html`'s viewport meta sets `viewport-fit=cover`, which is what makes
`env(safe-area-inset-*)` resolve to anything other than zero.

`globals.css` defines two utilities on top of it:

```css
@utility mb-safe {
  margin-bottom: env(safe-area-inset-bottom);
}

@utility pt-safe {
  padding-top: env(safe-area-inset-top);
}
```

`mb-safe` is a **margin**, not a `bottom-safe` replacement for `bottom-*`, so it
composes with whatever offset an element already has (the add-section FAB is
`bottom-4 sm:bottom-8`) instead of having to restate it. Every bottom-anchored
floating element uses it — the FAB, the collapsed collab-chat launcher, and the
first-lesson wizard — because 1rem of clearance puts their lower half inside the
~34px iOS home-indicator swipe strip, where the gesture wins and the tap
doesn't land.

`pt-safe` is the top half of the same problem, and only bites in the
[installed app](./pwa-and-offline.md). iOS in standalone mode draws the page
under the status bar — which is what
`apple-mobile-web-app-status-bar-style: black-translucent` asks for, so that
the app bar fills the notch area instead of leaving a mismatched
strip above it. Without padding, the header's title and buttons would sit behind
the clock. It's a **padding** on `PageBar` rather than a margin so the
background still reaches the top edge while its contents drop below the status
bar. In a browser tab the inset is zero, so nothing changes there.

## The sidebar is a sheet below `md`

`AppSidebar` docks beside the page on desktop and becomes a `Sheet` over it on a
phone, opened from `PageBar`'s toggle. Two consequences worth knowing:

- **Following a link has to close it.** A docked sidebar sits beside the page
  and can stay put; a sheet covers the page you just navigated to. `AppSidebar`
  binds that to its header and content regions only — toggling the theme or
  opening the account menu isn't navigation and shouldn't dismiss the panel.
- **The sheet carries the glass treatment; the docked sidebar doesn't need it.**
  `--sidebar` is translucent, which is right beside the page (only the
  background is behind it) and unreadable over it. The mobile branch of
  `ui/sidebar.jsx` adds `backdrop-blur-(--glass-blur)` and the panel shadow, the
  same as `Dialog`, `Popover` and `DropdownMenu`.

This also retired a duplication that used to run through every page: the old
header couldn't fit text buttons on a narrow screen, so most controls existed
twice — an icon-only copy under `md:hidden` and a labelled copy under
`hidden md:inline-flex` — and the lesson page kept a whole second copy of its
actions in an overflow menu. The sidebar holds one copy at any width.

## `dvh`, not `vh`

`100vh` is the _large_ viewport: it ignores the browser's retractable address
bar, so a `max-h-[90vh]` dialog can be taller than what's actually on screen.
Page wrappers use `min-h-dvh` and the tall dialogs (history, merge,
collaborate) use `max-h-[85dvh]`/`max-h-[90dvh]`.

`HomePage`'s hero deliberately keeps `min-h-[70vh] md:min-h-[78vh]`: `dvh` there
would resize the hero as the address bar hides and shows during scroll, which
is visible jank on a marketing page and worse than the problem it fixes.

## The collab chat is a bottom sheet on mobile

`CollabChat`'s expanded panel used to be a 420px-tall floating window inset 16px
from the bottom-left at `w-[calc(100vw-32px)]` — which on a phone covered most
of the screen _and_ sat on top of the editor's add-section FAB, while still
looking like a window that wasn't meant to.

Below `sm` it's now a proper bottom sheet: flush to the bottom edge, full width,
rounded at the top only, `h-[60dvh] max-h-[70dvh]`, with
`pb-[env(safe-area-inset-bottom)]` so the composer clears the home indicator.
From `sm` up every one of those is reverted and it's the original corner panel.

## Known gaps

- **Initial JS payload.** Routes are code-split and the export/import libraries
  (`docx`, `mammoth`, `html2pdf.js`) load on demand behind
  `src/lib/exports/load.js`, so a phone that only reads lessons never downloads
  them — previewing and viewing a lesson render through `LessonView` instead.
  What's left to watch is the editor chunk itself; see
  [How the export pipeline works](./export-pipeline.md).

## Installing to a Home Screen

The app ships a web app manifest and a service worker, so on a phone it can be
installed and opened in its own full-screen window, and the editor — already
local-first, see [Version history](../monorepo/version-history.md) — keeps
working with no network. The header's install button and the iOS Share → "Add to
Home Screen" instructions are covered in
[Installable app & offline use](./pwa-and-offline.md).
