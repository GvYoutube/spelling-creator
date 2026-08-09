// Interactive mode — working through a published lesson one step at a time
// instead of reading it as a page.
//
// A section's material pops up as its own step, then that section's questions
// pop up one at a time, each with a text field. The walkthrough is derived from
// the lesson document by buildInteractiveSteps — nothing is stored in a lesson to
// make it playable, so every lesson ever published works here, including ones
// written before this existed and ones with no questions at all.
//
// It takes over the whole viewport. A lesson step is one thing to read or one
// question to answer, and a dialog floating over the page you just left keeps
// that page in the corner of the eye competing for attention.
//
// The blocks are re-rendered here in the app's own theme rather than reusing
// LessonView. LessonView reproduces the docx/PDF page — a white sheet, Roboto,
// the export's blue section rules — which is exactly right for a page you are
// about to print and exactly wrong for a full-screen reading and answering
// surface that should look like the rest of the app, in light or dark mode. So
// this file draws text, images and spelling words itself, from the same block
// shapes; only the *presentation* differs, never the content.
//
// What the learner types is theirs. It is held in memory while they work and
// sent once, at the end, to their own account (see core/lessonResponses.js and
// the privacy note in the Worker's routes/lessonResponses.js). The lesson's
// author never sees it.
//
// Two things this deliberately does NOT do:
//
//   Mark answers. A question block carries the author's answer, and it is never
//   shown or compared against — not while answering, not on the summary. Spelling
//   lessons are about the learner producing the response, and a right/wrong
//   verdict from a string comparison would be both wrong a lot of the time and
//   the wrong shape of feedback.
//
//   Save partial work. Nothing is stored until the last step is done, so a
//   half-finished run-through never shows up as a completed one.
//
// Speech is optional and off until asked for; see lib/useSpeech.js.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  CircleCheckIcon,
  PlayIcon,
  RotateCcwIcon,
  SettingsIcon,
  Volume2Icon,
  VolumeXIcon,
  XIcon,
} from "lucide-react";
import { Button } from "./ui/button.jsx";
import { Alert, AlertDescription } from "./ui/alert.jsx";
import { Field, FieldLabel } from "./ui/field.jsx";
import { Progress } from "./ui/progress.jsx";
import { Skeleton } from "./ui/skeleton.jsx";
import { Spinner } from "./ui/spinner.jsx";
import { Textarea } from "./ui/textarea.jsx";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.jsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.jsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.jsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.jsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.jsx";
import { fitWithin } from "@spelling-creator/core/image";
import {
  MAX_RESPONSE_LENGTH,
  answerKey,
  buildInteractiveSteps,
  collectResponses,
  stepSpeechText,
} from "@spelling-creator/core/interactive";
import { questionMeta } from "@spelling-creator/core/questions";
import { saveLessonResponses } from "@spelling-creator/core/lessonResponses";
import { hasApi } from "@spelling-creator/core/config";
import { useImageSrc } from "../lib/useImageSrc.js";
import { SPEECH_RATES, useSpeech } from "../lib/useSpeech.js";
import { useAuth } from "../lib/auth.jsx";

// The speaker toggle, a replay button, and a popover for voice and pace. Renders
// nothing at all when the browser has no speech synthesis — a reader on a browser
// without it never learns the feature exists, which beats a dead button.
function SpeechControls({ speech, onReplay }) {
  const { t } = useTranslation("interactive");
  if (!speech.supported) return null;

  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={speech.enabled ? "secondary" : "ghost"}
            size="icon-sm"
            aria-pressed={speech.enabled}
            aria-label={
              speech.enabled ? t("speech.turnOff") : t("speech.turnOn")
            }
            onClick={() => speech.setEnabled(!speech.enabled)}
          >
            {speech.enabled ? <Volume2Icon /> : <VolumeXIcon />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {speech.enabled ? t("speech.turnOff") : t("speech.turnOn")}
        </TooltipContent>
      </Tooltip>

      {speech.enabled && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={
                  speech.speaking ? t("speech.stop") : t("speech.readAgain")
                }
                onClick={speech.speaking ? speech.stop : onReplay}
              >
                {speech.speaking ? <VolumeXIcon /> : <PlayIcon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {speech.speaking ? t("speech.stop") : t("speech.readAgain")}
            </TooltipContent>
          </Tooltip>

          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("speech.settings")}
                  >
                    <SettingsIcon />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>{t("speech.settings")}</TooltipContent>
            </Tooltip>
            <PopoverContent align="end" className="w-72">
              <div className="flex flex-col gap-3">
                <Field>
                  <FieldLabel htmlFor="tts-voice">
                    {t("speech.voice")}
                  </FieldLabel>
                  <Select
                    value={speech.voiceURI || "default"}
                    onValueChange={(next) =>
                      speech.setVoiceURI(next === "default" ? "" : next)
                    }
                  >
                    <SelectTrigger id="tts-voice" className="w-full">
                      <SelectValue placeholder={t("speech.defaultVoice")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">
                        {t("speech.defaultVoice")}
                      </SelectItem>
                      {speech.voices.map((voice) => (
                        <SelectItem key={voice.voiceURI} value={voice.voiceURI}>
                          {voice.name} ({voice.lang})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel>{t("speech.pace")}</FieldLabel>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    value={String(speech.rate)}
                    onValueChange={(next) =>
                      next && speech.setRate(Number(next))
                    }
                  >
                    {SPEECH_RATES.map((rate) => (
                      <ToggleGroupItem
                        key={rate}
                        value={String(rate)}
                        // `count` picks the plural form, so 1× reads "Normal
                        // speed" rather than "1 times normal speed".
                        aria-label={t("speech.paceOption", {
                          count: rate,
                          rate,
                        })}
                      >
                        {rate}×
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </Field>
              </div>
            </PopoverContent>
          </Popover>
        </>
      )}
    </div>
  );
}

// A text block, at reading size. Each newline is its own paragraph, matching how
// the lesson page and the export both treat a text block.
function TextBlock({ block }) {
  return (block.text || "").split("\n").map((line, index) => (
    <p key={index} className="mb-4 text-lg leading-relaxed last:mb-0">
      {line || " "}
    </p>
  ));
}

// An image block, sized from the picture's own aspect ratio so nothing jumps as
// it loads, and framed in the app's border/radius rather than the export's.
function ImageBlock({ block }) {
  const { t } = useTranslation("interactive");
  const src = useImageSrc(block);
  // The stored intrinsic size only decides the shape of the box here — the width
  // comes from the column, so a picture fills the reading width on a phone.
  const { width, height } = fitWithin(block.width, block.height, 1000);

  return (
    <figure className="mb-4 last:mb-0">
      {src ? (
        <img
          src={src}
          alt={block.caption || t("step.imageAlt")}
          width={Math.round(width)}
          height={Math.round(height)}
          loading="lazy"
          decoding="async"
          className="mx-auto max-h-[50vh] w-auto max-w-full rounded-panel border border-border object-contain"
        />
      ) : (
        <Skeleton
          className="mx-auto w-full rounded-panel"
          style={{ aspectRatio: `${width} / ${height}` }}
        />
      )}
      {block.caption && (
        <figcaption className="mt-2 text-center text-sm text-muted-foreground">
          {block.caption}
        </figcaption>
      )}
    </figure>
  );
}

// The spelling words a section teaches, as cards rather than a numbered list:
// they are the point of the lesson, and at this size they can be read across a
// room. With speech on, each word gets its own button — hearing one word is a
// different job from hearing the whole step, and the commonest thing a learner
// wants to replay.
function SpellingBlock({ block, speech }) {
  const { t } = useTranslation("interactive");
  const words = (block.words || [])
    .map((word) => (word.text || "").trim())
    .filter(Boolean);

  if (words.length === 0) return null;

  return (
    <div className="mb-4 last:mb-0">
      <p className="mb-3 text-sm font-medium tracking-wide text-muted-foreground uppercase">
        {t("step.spellingWords")}
      </p>
      <ul className="grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2">
        {words.map((word, index) => (
          <li
            key={index}
            className="flex items-center justify-between gap-2 rounded-panel border border-border bg-muted/40 px-4 py-3"
          >
            <span className="text-xl font-semibold tracking-wide">{word}</span>
            {speech.supported && speech.enabled && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("step.speakWord", { word })}
                onClick={() => speech.speak(word)}
              >
                <Volume2Icon />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// A section's material for one step.
function ContentStep({ step, speech }) {
  return (
    <div>
      {step.blocks.map((block, index) => {
        const key = block.id || index;
        if (block.type === "text") return <TextBlock key={key} block={block} />;
        if (block.type === "image" && (block.image || block.src)) {
          return <ImageBlock key={key} block={block} />;
        }
        if (block.type === "spelling") {
          return <SpellingBlock key={key} block={block} speech={speech} />;
        }
        return null;
      })}
    </div>
  );
}

// One question, with the field the learner types into. The author's own answer
// is never rendered here — see the note at the top of this file.
function QuestionStep({ step, value, onChange }) {
  const { t } = useTranslation("interactive");
  const meta = questionMeta(step.block.questionType);
  const fieldId = `interactive-answer-${answerKey(step)}`;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <span
          className="text-xs font-semibold tracking-wide uppercase"
          style={{ color: meta.color }}
        >
          {meta.label}
        </span>
        <p className="mt-2 text-2xl leading-snug font-semibold">
          {step.block.prompt || t("step.noQuestionText")}
        </p>
      </div>
      <Field>
        <FieldLabel htmlFor={fieldId} className="sr-only">
          {t("step.yourAnswer")}
        </FieldLabel>
        <Textarea
          id={fieldId}
          autoFocus
          value={value}
          maxLength={MAX_RESPONSE_LENGTH}
          placeholder={t("step.answerPlaceholder")}
          className="min-h-32 text-lg md:text-lg"
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
    </div>
  );
}

// The end of a run-through: everything the learner wrote, and what happened to it.
function SummaryStep({ responses, saveState, error, onRetry, signedIn }) {
  const { t } = useTranslation("interactive");
  const answered = responses.filter((response) =>
    response.answer.trim(),
  ).length;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <CircleCheckIcon className="size-6 text-primary" />
        <p className="text-lg font-medium">
          {responses.length === 0
            ? t("summary.readThrough")
            : t("summary.answered", { answered, total: responses.length })}
        </p>
      </div>

      {responses.length > 0 && (
        <div className="flex flex-col divide-y divide-border rounded-panel border border-border">
          {responses.map((response, index) => (
            <div key={response.blockId || index} className="px-4 py-3">
              <p className="text-sm text-muted-foreground">
                {response.prompt || t("step.noQuestionText")}
              </p>
              <p className="mt-1 whitespace-pre-wrap">
                {response.answer.trim() || (
                  <span className="text-muted-foreground italic">
                    {t("summary.skipped")}
                  </span>
                )}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* What became of the answers. Saving is only possible with an account and
          a backend — without either, the run-through still worked, and saying so
          plainly beats a failure the learner can't act on. */}
      {responses.length > 0 && (
        <>
          {saveState === "saving" && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              {t("summary.saving")}
            </p>
          )}
          {saveState === "saved" && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckIcon className="size-4" />
              {t("summary.saved")}
            </p>
          )}
          {saveState === "error" && (
            <Alert variant="destructive">
              <AlertDescription className="flex items-center justify-between gap-2">
                {error}
                <Button variant="ghost" size="sm" onClick={onRetry}>
                  {t("summary.retry")}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {saveState === "unavailable" && (
            <Alert>
              <AlertDescription>
                {signedIn
                  ? t("summary.notConfigured")
                  : t("summary.signInToSave")}
              </AlertDescription>
            </Alert>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The interactive-mode surface for one lesson.
 *
 * @param {object}   props.lesson        The full lesson ({ id, title, doc, … }).
 * @param {boolean}  props.open
 * @param {Function} props.onOpenChange
 * @param {Function} [props.onSaved]     Called once a run-through is stored, so the
 *                                       page can refresh the learner's saved answers.
 */
export default function InteractiveLesson({
  lesson,
  open,
  onOpenChange,
  onSaved,
}) {
  const { t } = useTranslation("interactive");
  const { user, accessToken } = useAuth();
  const speech = useSpeech();

  const steps = useMemo(
    () => buildInteractiveSteps(lesson?.doc),
    [lesson?.doc],
  );

  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState({});
  // "running" — working through the steps
  // "summary" — finished, showing what was written and where it went
  // "quit"    — confirming that leaving means losing the answers
  const [phase, setPhase] = useState("running");
  const [saveState, setSaveState] = useState("idle");
  const [saveError, setSaveError] = useState("");

  const step = steps[index] || null;
  const questionSteps = steps.filter((s) => s.kind === "question");
  const questionsAnswered = questionSteps.filter((s) =>
    (answers[answerKey(s)] || "").trim(),
  ).length;
  const isLastStep = index >= steps.length - 1;
  const dirty = Object.values(answers).some((answer) => answer.trim());

  // Start clean every time it opens, so a second run-through never begins
  // pre-filled with the first one's answers.
  useEffect(() => {
    if (!open) return;
    setIndex(0);
    setAnswers({});
    setPhase("running");
    setSaveState("idle");
    setSaveError("");
    savedFingerprint.current = null;
  }, [open]);

  // Read the current step aloud when speech is on. Keyed on which step was last
  // spoken rather than on the effect's inputs: changing voice or pace mid-step
  // should take effect on the *next* thing said, not restart the sentence the
  // learner is listening to.
  const spokenKey = useRef(null);
  useEffect(() => {
    if (!open || !speech.enabled || phase !== "running" || !step) return;
    if (spokenKey.current === step.key) return;
    spokenKey.current = step.key;
    speech.speak(stepSpeechText(step));
  }, [open, phase, speech, step]);

  // Nothing should still be talking once it's closed.
  useEffect(() => {
    if (open) return;
    spokenKey.current = null;
    speech.stop();
  }, [open, speech]);

  const responses = useMemo(
    () => collectResponses(steps, answers),
    [steps, answers],
  );

  // What has actually been stored, so finishing twice doesn't file the same
  // run-through twice. Reaching the summary, going Back to fix nothing, and
  // pressing Finish again is a normal thing to do, and it would otherwise spend
  // the learner's saved-run-through allowance on duplicates. Written only on a
  // successful save, so a failed or impossible one leaves the next Finish free
  // to try again.
  const savedFingerprint = useRef(null);

  // Store the finished run-through. Called on reaching the summary, and again by
  // the retry button. Requires a signed-in session and a configured hub; without
  // either, the summary says so rather than failing.
  const save = async (payload) => {
    if (!hasApi() || !accessToken || !lesson?.id) {
      setSaveState("unavailable");
      return;
    }
    setSaveState("saving");
    setSaveError("");
    try {
      await saveLessonResponses(lesson.id, payload, accessToken);
      savedFingerprint.current = JSON.stringify(payload);
      setSaveState("saved");
      onSaved?.();
    } catch (err) {
      setSaveState("error");
      setSaveError(err.message || t("summary.couldNotSave"));
    }
  };

  const finish = () => {
    speech.stop();
    spokenKey.current = null;
    setPhase("summary");
    // A read-through of a lesson with no questions has nothing to store, and
    // answers already stored unchanged have nothing to store again.
    if (responses.length === 0) return;
    if (savedFingerprint.current === JSON.stringify(responses)) return;
    save(responses);
  };

  const goNext = () => {
    if (isLastStep) finish();
    else setIndex((current) => current + 1);
  };

  const goBack = () => {
    if (phase === "summary") {
      setPhase("running");
      setIndex(steps.length - 1);
      return;
    }
    setIndex((current) => Math.max(0, current - 1));
  };

  const restart = () => {
    setIndex(0);
    setAnswers({});
    setPhase("running");
    setSaveState("idle");
    setSaveError("");
    spokenKey.current = null;
    savedFingerprint.current = null;
  };

  const close = () => {
    speech.stop();
    onOpenChange(false);
  };

  // Leaving mid-run throws away answers that were never sent anywhere, so ask
  // first. Once the summary is up there is nothing left to lose, so it closes
  // straight away.
  const requestClose = () => {
    if (phase === "running" && dirty) setPhase("quit");
    else close();
  };

  const empty = steps.length === 0;
  const progress =
    empty || phase === "summary" ? 100 : ((index + 1) / steps.length) * 100;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && requestClose()}>
      <DialogContent
        // Full-bleed: the walkthrough is the whole screen, not a card floating
        // over the page the learner just left. Every class here overrides one of
        // DialogContent's centred-card defaults (position, size, radius, the
        // translucent glass surface), so it reads as a place rather than a popup.
        // (`rounded-none!` / `shadow-none!` are marked important on purpose:
        // DialogContent's own radius and its two-layer glass shadow are custom
        // theme values that tailwind-merge won't reconcile away, and left alone
        // they draw a rounded card outline around a full-bleed screen.)
        className="top-0 left-0 flex h-dvh max-h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none! border-0 bg-background p-0 shadow-none! backdrop-blur-none sm:max-w-none"
        // Esc and a stray click are the two easiest ways to lose a half-typed
        // run-through by accident, so both route through the same confirmation
        // as the close button rather than discarding it outright.
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          requestClose();
        }}
        onInteractOutside={(event) => event.preventDefault()}
        showCloseButton={false}
      >
        <header className="shrink-0 border-b border-border bg-card/60">
          <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-3 sm:px-6">
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-base">
                {lesson?.title || t("untitledLesson")}
              </DialogTitle>
              <p className="mt-0.5 truncate text-sm text-muted-foreground">
                {phase === "quit"
                  ? t("quit.title")
                  : phase === "summary"
                    ? t("progress.finished")
                    : step?.sectionName || t("untitledSection")}
              </p>
            </div>
            <SpeechControls
              speech={speech}
              onReplay={() => step && speech.speak(stepSpeechText(step))}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("close")}
                  onClick={requestClose}
                >
                  <XIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("close")}</TooltipContent>
            </Tooltip>
          </div>
          {!empty && phase !== "quit" && (
            <div className="mx-auto w-full max-w-3xl px-4 pb-3 sm:px-6">
              <Progress value={progress} />
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t("progress.stepCount", {
                  current: phase === "summary" ? steps.length : index + 1,
                  total: steps.length,
                })}
                {questionSteps.length > 0 &&
                  ` · ${t("progress.questionsAnswered", {
                    answered: questionsAnswered,
                    total: questionSteps.length,
                  })}`}
              </p>
            </div>
          )}
        </header>

        {/* A step is usually a paragraph or a single question, which would sit in
            the top strip of a full-screen page and look abandoned there. `m-auto`
            centres it — and unlike `items-center`, it still scrolls from the top
            when a step is taller than the viewport instead of clipping its head. */}
        <div className="flex min-h-0 flex-1 overflow-y-auto">
          <div className="m-auto w-full max-w-3xl px-4 py-8 sm:px-6">
            {empty ? (
              <p className="text-muted-foreground">{t("emptyLesson")}</p>
            ) : phase === "quit" ? (
              <p className="text-muted-foreground">{t("quit.body")}</p>
            ) : phase === "summary" ? (
              <SummaryStep
                responses={responses}
                saveState={saveState}
                error={saveError}
                onRetry={() => save(responses)}
                signedIn={Boolean(user)}
              />
            ) : step.kind === "content" ? (
              <ContentStep step={step} speech={speech} />
            ) : (
              <QuestionStep
                step={step}
                value={answers[answerKey(step)] || ""}
                onChange={(value) =>
                  setAnswers((current) => ({
                    ...current,
                    [answerKey(step)]: value,
                  }))
                }
              />
            )}
          </div>
        </div>

        <footer className="shrink-0 border-t border-border bg-card/60">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-2 px-4 py-3 sm:px-6">
            {empty ? (
              <Button variant="outline" onClick={close}>
                {t("close")}
              </Button>
            ) : phase === "quit" ? (
              <>
                <Button variant="outline" onClick={() => setPhase("running")}>
                  {t("quit.keepGoing")}
                </Button>
                <Button variant="destructive" onClick={close}>
                  {t("quit.discard")}
                </Button>
              </>
            ) : phase === "summary" ? (
              <>
                <Button variant="outline" onClick={goBack}>
                  <ArrowLeftIcon data-icon="inline-start" />
                  {t("nav.back")}
                </Button>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={restart}>
                    <RotateCcwIcon data-icon="inline-start" />
                    {t("summary.startAgain")}
                  </Button>
                  <Button onClick={close}>{t("summary.done")}</Button>
                </div>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={goBack}
                  disabled={index === 0}
                >
                  <ArrowLeftIcon data-icon="inline-start" />
                  {t("nav.back")}
                </Button>
                <Button size="lg" onClick={goNext}>
                  {isLastStep ? t("nav.finish") : t("nav.next")}
                  {isLastStep ? <CheckIcon /> : <ArrowRightIcon />}
                </Button>
              </>
            )}
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
