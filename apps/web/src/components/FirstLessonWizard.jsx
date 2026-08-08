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
import { Trans, useTranslation } from "react-i18next";
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
// map of the real interface. Labels/bodies are translated (see the "steps"
// key of the aiDialogs namespace); this array only pins the key + icon order.
const STEP_KEYS_AND_ICONS = [
  { key: "nameLesson", icon: TypeIcon },
  { key: "addSection", icon: PlusIcon },
  { key: "fillContent", icon: SpellCheckIcon },
  { key: "previewShare", icon: Share2Icon },
];

// A compact horizontal step indicator — shadcn has no Stepper component, so
// this is hand-built: a dot per step (numbered, or checked once passed),
// connected by a line, with the step's label underneath. Hidden below sm,
// matching the original's alternativeLabel-on-desktop-only behavior.
function StepIndicator({ activeStep, steps }) {
  return (
    <ol className="my-4 hidden items-start sm:flex">
      {steps.map((s, i) => (
        <li key={s.key} className="flex flex-1 flex-col items-center gap-1.5">
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
                i === steps.length - 1
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
  const { t } = useTranslation("aiDialogs");
  const [activeStep, setActiveStep] = useState(0);

  const steps = STEP_KEYS_AND_ICONS.map(({ key, icon }) => ({
    key,
    icon,
    label: t(`firstLessonWizard.steps.${key}.label`),
  }));

  const lastStep = activeStep === steps.length - 1;

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

  const step = steps[activeStep];
  const StepIcon = step.icon;

  return (
    // No Modal/Backdrop wrapper — the panel floats above the editor without
    // dimming it or stealing focus, so the editor stays fully usable. Sits above
    // the add-section FAB; on small screens it stretches to the side margins.
    <div
      role="complementary"
      aria-label={t("firstLessonWizard.panelAriaLabel")}
      className={cn(
        // Glass surface, same recipe as dialog.jsx — see the note there. This
        // one genuinely has something to blur: unlike an isolated one-off
        // page, it floats over the real editor content behind it.
        "mb-safe fixed right-4 bottom-4 left-4 z-40 w-auto rounded-panel border border-border bg-card p-4 text-card-foreground shadow-[var(--shadow-panel),0_0_0_1px_var(--glass-border-outer)] backdrop-blur-(--glass-blur) backdrop-saturate-[1.4]",
        "sm:right-6 sm:bottom-6 sm:left-auto sm:w-[380px]",
        "max-w-[calc(100vw-32px)]",
        "animate-in slide-in-from-bottom-4 fade-in duration-300",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-bold">{t("firstLessonWizard.title")}</p>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("firstLessonWizard.closeAriaLabel")}
          onClick={handleClose}
          className="-mt-1 -mr-1"
        >
          <XIcon className="size-4" />
        </Button>
      </div>

      <StepIndicator activeStep={activeStep} steps={steps} />
      <hr className="mt-1 mb-3 border-border sm:hidden" />

      <div className="flex items-start gap-3">
        <StepIcon className="mt-0.5 size-5 shrink-0 text-primary" />
        <div>
          <p className="mb-1 text-sm font-medium">{step.label}</p>
          <p className="text-sm text-muted-foreground">
            <Trans
              i18nKey={`firstLessonWizard.steps.${step.key}.body`}
              ns="aiDialogs"
              components={{
                em: <em />,
                strong: <strong />,
                strong2: <strong />,
                strong3: <strong />,
              }}
            />
          </p>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {t("firstLessonWizard.stepCounter", {
            current: activeStep + 1,
            total: steps.length,
          })}
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleBack}
            disabled={activeStep === 0}
          >
            {t("firstLessonWizard.back")}
          </Button>
          <Button type="button" size="sm" onClick={handleNext}>
            {lastStep
              ? t("firstLessonWizard.done")
              : t("firstLessonWizard.next")}
          </Button>
        </div>
      </div>
    </div>
  );
}
