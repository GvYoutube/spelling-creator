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
import Paper from "@mui/material/Paper";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Stepper from "@mui/material/Stepper";
import Step from "@mui/material/Step";
import StepLabel from "@mui/material/StepLabel";
import Typography from "@mui/material/Typography";
import Divider from "@mui/material/Divider";
import Slide from "@mui/material/Slide";
import CloseIcon from "@mui/icons-material/Close";
import TitleIcon from "@mui/icons-material/Title";
import AddIcon from "@mui/icons-material/Add";
import SpellcheckIcon from "@mui/icons-material/Spellcheck";
import IosShareIcon from "@mui/icons-material/IosShare";

// Each step pairs a short heading with a one-paragraph explanation and the icon
// the matching control uses elsewhere in the editor, so the guide reads as a
// map of the real interface.
const STEPS = [
  {
    label: "Name your lesson",
    icon: <TitleIcon color="primary" />,
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
    icon: <AddIcon color="primary" />,
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
    icon: <SpellcheckIcon color="primary" />,
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
    icon: <IosShareIcon color="primary" />,
    body: (
      <>
        When you’re happy, use <strong>Preview</strong> to see the printable
        result, <strong>Export</strong> to download a Word doc or PDF, or{" "}
        <strong>Publish to hub</strong> to share it with others.
      </>
    ),
  },
];

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

  const step = STEPS[activeStep];

  return (
    // No Modal/Backdrop wrapper — the panel floats above the editor without
    // dimming it or stealing focus, so the editor stays fully usable. Sits above
    // the add-section FAB; on small screens it stretches to the side margins.
    <Slide direction="up" in={open} mountOnEnter unmountOnExit>
      <Paper
        elevation={8}
        role="complementary"
        aria-label="How to create a lesson"
        sx={{
          position: "fixed",
          zIndex: (t) => t.zIndex.drawer + 2,
          bottom: { xs: 16, sm: 24 },
          right: { xs: 16, sm: 24 },
          left: { xs: 16, sm: "auto" },
          width: { xs: "auto", sm: 380 },
          maxWidth: "calc(100vw - 32px)",
          p: 2,
          borderRadius: 2,
        }}
      >
        <Stack
          direction="row"
          alignItems="flex-start"
          justifyContent="space-between"
          spacing={1}
        >
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            Create your first lesson
          </Typography>
          <IconButton
            size="small"
            aria-label="close"
            onClick={handleClose}
            sx={{ mt: -0.5, mr: -0.5 }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>

        <Stepper
          activeStep={activeStep}
          alternativeLabel
          sx={{ my: 2, display: { xs: "none", sm: "flex" } }}
        >
          {STEPS.map((s) => (
            <Step key={s.label}>
              <StepLabel>{s.label}</StepLabel>
            </Step>
          ))}
        </Stepper>

        <Divider sx={{ display: { sm: "none" }, mb: 1.5, mt: 1 }} />

        <Stack direction="row" spacing={1.5} alignItems="flex-start">
          <Box sx={{ fontSize: 0, mt: 0.25 }}>{step.icon}</Box>
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              {step.label}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {step.body}
            </Typography>
          </Box>
        </Stack>

        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          sx={{ mt: 2 }}
        >
          <Typography variant="caption" color="text.secondary">
            Step {activeStep + 1} of {STEPS.length}
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              onClick={handleBack}
              disabled={activeStep === 0}
            >
              Back
            </Button>
            <Button size="small" variant="contained" onClick={handleNext}>
              {lastStep ? "Done" : "Next"}
            </Button>
          </Stack>
        </Stack>
      </Paper>
    </Slide>
  );
}
