// A dismissable, step-by-step welcome wizard that walks a newcomer through
// building their first lesson. It auto-shows once (gated by a localStorage flag
// the editor sets on dismiss) and can be reopened any time from the editor's
// help button. Purely informational — it doesn't touch the working document.

import { useState } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import DialogContentText from "@mui/material/DialogContentText";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Stepper from "@mui/material/Stepper";
import Step from "@mui/material/Step";
import StepLabel from "@mui/material/StepLabel";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import CloseIcon from "@mui/icons-material/Close";
import TitleIcon from "@mui/icons-material/Title";
import AddIcon from "@mui/icons-material/Add";
import SpellcheckIcon from "@mui/icons-material/Spellcheck";
import IosShareIcon from "@mui/icons-material/IosShare";

// Each step pairs a short heading with a one-paragraph explanation and the icon
// the matching control uses elsewhere in the editor, so the wizard reads as a
// map of the real interface.
const STEPS = [
  {
    label: "Name your lesson",
    icon: <TitleIcon color="primary" />,
    body: (
      <>
        Start at the top of the page and type a title for your lesson — for
        example <em>“The Life of Albert Einstein”</em>. You can change it any time.
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
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const [activeStep, setActiveStep] = useState(0);

  const lastStep = activeStep === STEPS.length - 1;

  // Always start fresh at step one when the dialog closes, so reopening it from
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
    <Dialog
      open={open}
      onClose={handleClose}
      fullWidth
      maxWidth="sm"
      fullScreen={isMobile}
      aria-labelledby="first-lesson-wizard-title"
    >
      <DialogTitle id="first-lesson-wizard-title" sx={{ pr: 6 }}>
        Create your first lesson
        <IconButton
          aria-label="close"
          onClick={handleClose}
          sx={{ position: "absolute", right: 8, top: 8 }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stepper
          activeStep={activeStep}
          alternativeLabel
          sx={{ mb: 3, display: { xs: "none", sm: "flex" } }}
        >
          {STEPS.map((s) => (
            <Step key={s.label}>
              <StepLabel>{s.label}</StepLabel>
            </Step>
          ))}
        </Stepper>

        <Stack direction="row" spacing={2} alignItems="flex-start">
          <Box sx={{ fontSize: 0, mt: 0.25 }}>{step.icon}</Box>
          <Box>
            <Typography variant="h6" gutterBottom>
              {step.label}
            </Typography>
            <DialogContentText component="div">{step.body}</DialogContentText>
          </Box>
        </Stack>

        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", mt: 3 }}
        >
          Step {activeStep + 1} of {STEPS.length} · You can reopen this guide
          any time from the help button.
        </Typography>
      </DialogContent>
      <DialogActions sx={{ justifyContent: "space-between" }}>
        <Button onClick={handleClose} color="inherit">
          Skip
        </Button>
        <Stack direction="row" spacing={1}>
          <Button onClick={handleBack} disabled={activeStep === 0}>
            Back
          </Button>
          <Button variant="contained" onClick={handleNext}>
            {lastStep ? "Get started" : "Next"}
          </Button>
        </Stack>
      </DialogActions>
    </Dialog>
  );
}
