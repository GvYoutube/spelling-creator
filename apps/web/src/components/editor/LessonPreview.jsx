// What the editor's document column holds while Preview is on: the lesson as a
// reader sees it, and nothing else.
//
// It is only the column's *contents*. The page wrapper, the section outline and
// the column itself stay in EditorPage and are the same elements in both modes,
// which is the point — an earlier version of this had preview build its own
// wrapper and column beside the editing one, and the two immediately disagreed:
// the copy here was left unconstrained where the editing column caps at
// max-w-6xl, so on a page column past ~1400px toggling preview silently made
// the lesson wider than the thing it was previewing. Two class strings meant to
// stay equal will not stay equal. One element can't drift from itself.
//
// No outline of its own for the same reason (EditorPage passes `readOnly` to the
// one that is already there), and nothing here is editable: no drag handles, no
// move buttons, no add-section FAB — see the FAB's own guard in EditorPage.

import { useTranslation } from "react-i18next";
import { PencilIcon } from "lucide-react";
import { Button } from "../ui/button.jsx";
import LessonView from "../LessonView.jsx";

/**
 * @param {object} props
 * @param {object} props.doc     The working lesson, rendered read-only.
 * @param {() => void} props.onExit  Leave preview. Wired to the same toggle the
 *   bar's Preview button calls, so there is one way out and one state machine.
 */
export default function LessonPreview({ doc, onExit }) {
  const { t } = useTranslation("editor");

  return (
    <>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t("preview.eyebrow")}
        </p>
        {/* The narrow-screen copy of the bar's toggle. Below `md` the labelled
            cluster is inside the overflow menu, and a mode whose only exit is
            behind a hidden menu is a trap. From `md` up the bar has it. */}
        <Button
          variant="outline"
          size="sm"
          onClick={onExit}
          className="md:hidden"
        >
          <PencilIcon data-icon="inline-start" />
          {t("header.backToEditing")}
        </Button>
      </div>

      <p className="mb-4 text-sm text-muted-foreground">{t("preview.note")}</p>

      {/* LessonView draws the lesson in the current theme; the wrapper supplies
          only the panel frame. */}
      <div className="rounded-panel border border-border bg-card shadow-(--shadow-panel)">
        <LessonView doc={doc} />
      </div>
    </>
  );
}
