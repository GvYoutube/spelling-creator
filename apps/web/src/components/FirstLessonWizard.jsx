// A dismissable, step-by-step welcome guide that walks a newcomer through
// building their first lesson. It auto-shows once (gated by a localStorage flag
// the editor sets on dismiss) and can be reopened any time from the editor's
// help button.
//
// Deliberately NOT a modal Dialog: it's a floating corner panel with no
// backdrop and no focus trap, so the user can read each step and act on it in
// the real editor at the same time. Purely informational — it never touches the
// working document.

import { useState } from "react";
import {
  XIcon,
  TypeIcon,
  PlusIcon,
  SpellCheckIcon,
  Share2Icon,
  CheckIcon,
} from "lucide-react";
import { Button } from "./ui/button.jsx";
import { cn } from "../lib/utils.js";

// Each step pairs a short heading with a one-paragraph explanation and the icon
// the matching control uses elsewhere in the editor, so the guide reads as a
// map of the real interface.
const STEPS = [
  {
    label: "Name your lesson",
    icon: TypeIcon,
    body: (
      <>
        Start at the top of the page and type a title for your lesson — for
        example <em>“The Life of Albert Einstein”</em>. You can change it any
        time.
      </>
    ),
  },
  {
    label: "Add a section",
    icon: PlusIcon,
    body: (
      <>
        Press the round <strong>+</strong> button (bottom-right) or{" "}
        <strong>Add section</strong> to create your first section, such as a
        word list or a practice exercise. Lessons are built from one or more
        sections.
      </>
    ),
  },
  {
    label: "Fill in content",
    icon: SpellCheckIcon,
    body: (
      <>
        Inside a section, add content blocks: spelling words, instructions,
        images, and questions. Reorder or remove blocks until the section reads
        the way you want.
      </>
    ),
  },
  {
    label: "Preview & share",
    icon: Share2Icon,
    body: (
      <>
        When you’re happy, use <strong>Preview</strong> to see the printable
        result, <strong>Export</strong> to download a Word doc or PDF, or{" "}
        <strong>Publish to hub</strong> to share it with others.
      </>
    ),
  },
];

// A compact horizontal step indicator — shadcn has no Stepper component, so
// this is hand-built: a dot per step (numbered, or checked once passed),
// connected by a line, with the step's label underneath. Hidden below sm,
// matching the original's alternativeLabel-on-desktop-only behavior.
function StepIndicator({ activeStep }) {
  return (
    <ol className="my-4 hidden items-start sm:flex">
      {STEPS.map((s, i) => (
        <li key={s.label} className="flex flex-1 flex-col items-center gap-1.5">
          <div className="flex w-full items-center">
            <div
              className={cn(
                "h-px flex-1",
                i === 0
                  ? "invisible"
                  : i <= activeStep
                    ? "bg-primary"
                    : "bg-border",
              )}
            />
            <div
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium",
                i < activeStep
                  ? "bg-primary text-primary-foreground"
                  : i === activeStep
                    ? "border-2 border-primary text-primary"
                    : "border border-border text-muted-foreground",
              )}
            >
              {i < activeStep ? <CheckIcon className="size-3.5" /> : i + 1}
            </div>
            <div
              className={cn(
                "h-px flex-1",
                i === STEPS.length - 1
                  ? "invisible"
                  : i < activeStep
                    ? "bg-primary"
                    : "bg-border",
              )}
            />
          </div>
          <span className="text-center text-[11px] text-muted-foreground">
            {s.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

export default function FirstLessonWizard({ open, onClose }) {
  const [activeStep, setActiveStep] = useState(0);

  const lastStep = activeStep === STEPS.length - 1;

  // Always start fresh at step one when the panel closes, so reopening it from
  // the help button doesn't drop the user back at the final step.
  const handleClose = () => {
    setActiveStep(0);
    onClose();
  };

  const handleNext = () => {
    if (lastStep) handleClose();
    else setActiveStep((s) => s + 1);
  };

  const handleBack = () => setActiveStep((s) => Math.max(0, s - 1));

  if (!open) return null;

  const step = STEPS[activeStep];
  const StepIcon = step.icon;

  return (
    // No Modal/Backdrop wrapper — the panel floats above the editor without
    // dimming it or stealing focus, so the editor stays fully usable. Sits above
    // the add-section FAB; on small screens it stretches to the side margins.
    <div
      role="complementary"
      aria-label="How to create a lesson"
      className={cn(
        // Glass surface, same recipe as dialog.jsx — see the note there. This
        // one genuinely has something to blur: unlike an isolated one-off
        // page, it floats over the real editor content behind it.
        "fixed right-4 bottom-4 left-4 z-[1202] w-auto rounded-panel border border-border bg-card p-4 text-card-foreground shadow-[var(--shadow-panel),0_0_0_1px_var(--glass-border-outer)] backdrop-blur-(--glass-blur) backdrop-saturate-[1.4]",
        "sm:right-6 sm:bottom-6 sm:left-auto sm:w-[380px]",
        "max-w-[calc(100vw-32px)]",
        "animate-in slide-in-from-bottom-4 fade-in duration-300",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-bold">Create your first lesson</p>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="close"
          onClick={handleClose}
          className="-mt-1 -mr-1"
        >
          <XIcon className="size-4" />
        </Button>
      </div>

      <StepIndicator activeStep={activeStep} />
      <hr className="mt-1 mb-3 border-border sm:hidden" />

      <div className="flex items-start gap-3">
        <StepIcon className="mt-0.5 size-5 shrink-0 text-primary" />
        <div>
          <p className="mb-1 text-sm font-medium">{step.label}</p>
          <p className="text-sm text-muted-foreground">{step.body}</p>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          Step {activeStep + 1} of {STEPS.length}
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleBack}
            disabled={activeStep === 0}
          >
            Back
          </Button>
          <Button type="button" size="sm" onClick={handleNext}>
            {lastStep ? "Done" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}
