// The editor's left-hand section outline.
//
// docs/web-app/navigating-large-lessons.md measured the problem this answers: a
// lesson built to the shape the MCP server documents is ~37 screenfuls on a
// desktop, one section is ~4,900px, and the scrollbar thumb is 21px tall. The
// sticky section headers tell you where you are; this tells you where
// everything else is, and gets you there in one click.
//
// It navigates and nothing else. Reordering sections stays on the cards
// themselves, where the move buttons and the drag targets already live — an
// outline you can also drag would be a second, subtly different way to do the
// same thing, and the cards' way is the one that keeps the scroll position
// stable (see useScrollAnchor).
//
// Navigating and nothing else is also what lets it stand beside the editor's
// preview unchanged. `readOnly` drops the two controls that edit — collapse-all
// and add-section — and what is left already works, because it addresses
// sections by `data-section-id` and LessonView publishes the same attribute the
// section cards do. A long lesson is exactly as hard to move around in when you
// are reading it back as when you are writing it, so the preview would need an
// outline of its own otherwise; this is that outline, not a copy of it.
//
// It appears once the editor's page column passes 52rem — AppShell's
// @container/page, not the viewport, so collapsing the sidebar can bring it in
// without the window changing size. Below that the editor is a single column
// and the outline would be spending width the document needs; "collapse all"
// (the cheap way to see a lesson's shape on any screen) therefore stays on the
// document panel as well as in this header.

import { useTranslation } from "react-i18next";
import { ChevronsDownUpIcon, ChevronsUpDownIcon, PlusIcon } from "lucide-react";
import { Button } from "../ui/button.jsx";
import { cn } from "../../lib/utils.js";
import { idSelector, scrollToElement } from "../../lib/useScrollAnchor.js";

/** How many blocks a section holds, for the count beside its name. */
function blockCount(section) {
  return Array.isArray(section?.blocks) ? section.blocks.length : 0;
}

export default function SectionOutline({
  sections = [],
  collapsedIds,
  allCollapsed,
  onToggleAll,
  onAddSection,
  readOnly = false,
}) {
  const { t } = useTranslation("editor");

  const goTo = (id) => {
    const el = document.querySelector(idSelector("data-section-id", id));
    // Whichever surface is mounted answers to the same attribute: SectionCard
    // in the editor, <section> in LessonView under preview. Both set
    // scroll-mt-(--header-h) on themselves, so "start" already lands clear of
    // the sticky bar — no offset arithmetic here.
    scrollToElement(el, { block: "start" });
  };

  return (
    <aside className="sticky top-[calc(var(--header-h)+1.5rem)] hidden w-56 shrink-0 @min-[52rem]/page:block">
      <div className="mb-2 flex items-center justify-between gap-1">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t("outline.heading")}
        </p>
        {!readOnly && sections.length > 0 && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onToggleAll}
            aria-label={
              allCollapsed
                ? t("documentPanel.expandAll")
                : t("documentPanel.collapseAll")
            }
          >
            {allCollapsed ? (
              <ChevronsUpDownIcon className="size-4" />
            ) : (
              <ChevronsDownUpIcon className="size-4" />
            )}
          </Button>
        )}
      </div>

      {sections.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("outline.empty")}</p>
      ) : (
        <ol className="m-0 flex max-h-[calc(100dvh-var(--header-h)-9rem)] list-none flex-col gap-0.5 overflow-y-auto p-0">
          {sections.map((section, i) => (
            <li key={section.id}>
              <button
                type="button"
                onClick={() => goTo(section.id)}
                className={cn(
                  "flex w-full cursor-pointer items-baseline gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-sm",
                  "text-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <span className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {section.name || t("outline.untitledSection", { n: i + 1 })}
                </span>
                {/* A collapsed section is folded away in the document, so the
                    outline is the only place it's visible at all — worth
                    saying which ones those are. */}
                <span className="shrink-0 text-xs text-muted-foreground">
                  {collapsedIds?.has(section.id)
                    ? t("outline.collapsed")
                    : blockCount(section)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}

      {!readOnly && (
        <Button
          variant="outline"
          size="sm"
          className="mt-3 w-full justify-start"
          onClick={onAddSection}
        >
          <PlusIcon data-icon="inline-start" />
          {t("emptyState.addSection")}
        </Button>
      )}
    </aside>
  );
}
