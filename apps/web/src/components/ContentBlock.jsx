import { memo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Trash2Icon,
  ArrowUpIcon,
  ArrowDownIcon,
  PlusIcon,
  AlignLeftIcon,
  AlignCenterIcon,
  AlignRightIcon,
  ArrowLeftRightIcon,
  WandSparklesIcon,
} from "lucide-react";
import { Button } from "./ui/button.jsx";
import { Badge } from "./ui/badge.jsx";
import { Field, FieldLabel } from "./ui/field.jsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.jsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu.jsx";
import { LiveInput, LiveTextarea } from "./LiveField.jsx";
import IconActionButton from "./IconActionButton.jsx";
import {
  fitWithin,
  imageSizeScale,
  IMAGE_SIZES,
  DEFAULT_IMAGE_SIZE,
  DEFAULT_IMAGE_ALIGN,
} from "@spelling-creator/core/image";
import { newId } from "@spelling-creator/core/id";
import { cn } from "../lib/utils.js";
import { useImageSrc } from "../lib/useImageSrc.js";
import { questionMeta } from "@spelling-creator/core/questions";
import { SPELLING_COLOR } from "@spelling-creator/core/spelling";

// Every block is content + a stack of controls (drag/move/delete, plus a couple
// of block-specific extras). On a wide screen those controls sit in a fixed
// column down the right-hand side; on a phone that column was eating the block.
// The control stack costs the same ~130-165px whatever the viewport, and a
// 360px phone only has 264px inside the block's padding to begin with — which
// left a spelling word being typed into a ~56px box and a lesson paragraph into
// a ~128px one.
//
// So below `sm` the row becomes a column: content gets the full width and the
// controls wrap underneath as a footer (`controls` in ContentBlock adds the
// hairline that separates them).
//
// That footer is left-aligned, not right-. The add-section FAB is pinned to the
// bottom-right of the viewport, so right-aligning put every block's delete
// button in exactly the ~72px corner the FAB floats over — whichever block
// happened to sit at that scroll position had its controls covered by it.
const BLOCK_LAYOUT = "flex flex-col gap-2 sm:flex-row sm:items-start";

// The image block's alignment/size toggles are `size="sm"` — 32px tall, under
// the touch-target minimum. Grow them to 40px on a phone. ToggleGroup's own
// className lands on the group root and can't reach the items, so this selects
// them by the data-slot ToggleGroupItem sets.
const TOUCH_TOGGLES =
  "[&_[data-slot=toggle-group-item]]:h-10 sm:[&_[data-slot=toggle-group-item]]:h-8";

// Same bump for the compact `size="sm"` buttons inside block bodies (replace
// image, add word/answer/step).
const TOUCH_SM_BUTTON = "h-10 sm:h-8";

function ContentBlock({
  block,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
  capitalizedWords = [],
  dragHandle = null,
  onReplaceImageFile = null,
  onReplaceImageSearch = null,
}) {
  const { t } = useTranslation("editorSections");
  // Below `sm` the controls drop out of the right-hand column and become a
  // footer row under the block's content — see BLOCK_LAYOUT. The hairline is
  // what makes that row read as a footer rather than as more content; from
  // `sm` up the controls are back in the corner and it disappears.
  const controls = (
    <div className="flex shrink-0 items-center gap-1 border-t border-border pt-2 sm:border-t-0 sm:pt-0">
      {dragHandle}
      <IconActionButton
        tooltip={t("contentBlock.controls.moveUp")}
        onClick={onMoveUp}
        disabled={isFirst}
      >
        <ArrowUpIcon />
      </IconActionButton>
      <IconActionButton
        tooltip={t("contentBlock.controls.moveDown")}
        onClick={onMoveDown}
        disabled={isLast}
      >
        <ArrowDownIcon />
      </IconActionButton>
      <IconActionButton
        tooltip={t("contentBlock.controls.delete")}
        onClick={onDelete}
        destructive
      >
        <Trash2Icon />
      </IconActionButton>
    </div>
  );

  if (block.type === "question") {
    return (
      <QuestionBlock block={block} onChange={onChange} controls={controls} />
    );
  }

  if (block.type === "spelling") {
    return (
      <SpellingBlock
        block={block}
        onChange={onChange}
        onDelete={onDelete}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        isFirst={isFirst}
        isLast={isLast}
        capitalizedWords={capitalizedWords}
        dragHandle={dragHandle}
      />
    );
  }

  if (block.type === "image") {
    return (
      <ImageBlock
        block={block}
        onChange={onChange}
        controls={controls}
        onReplaceFile={onReplaceImageFile}
        onReplaceSearch={onReplaceImageSearch}
      />
    );
  }

  // text block
  return (
    <div className="rounded-md border border-border bg-card p-4 text-card-foreground">
      <div className={BLOCK_LAYOUT}>
        <LiveTextarea
          placeholder={t("contentBlock.text.placeholder")}
          value={block.text || ""}
          onCommit={(text) => onChange({ ...block, text })}
          data-collab-field={`block:${block.id}:text`}
          className="min-h-16"
        />
        {controls}
      </div>
    </div>
  );
}

// Image blocks reference their bytes by content hash; useImageSrc resolves that
// to a usable URL (a local blob URL, or the public R2 URL once uploaded). It's
// its own component so the hook is always called for an image block, never
// conditionally inside ContentBlock.
function ImageBlock({
  block,
  onChange,
  controls,
  onReplaceFile = null,
  onReplaceSearch = null,
}) {
  const { t } = useTranslation("editorSections");
  const src = useImageSrc(block);
  const fileRef = useRef(null);
  const canReplace = Boolean(onReplaceFile || onReplaceSearch);

  const onPickReplacement = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (file) onReplaceFile?.(file);
  };

  const align = block.align || DEFAULT_IMAGE_ALIGN;
  const size = block.size || DEFAULT_IMAGE_SIZE;
  const preview = fitWithin(
    block.width,
    block.height,
    360 * imageSizeScale(size),
  );
  // The preview image is display:block, so margins decide its alignment.
  const imgMargin =
    align === "left"
      ? "0 auto 0 0"
      : align === "right"
        ? "0 0 0 auto"
        : "0 auto";
  return (
    <div className="rounded-md border border-border bg-card p-4 text-card-foreground">
      <div className={cn(BLOCK_LAYOUT, "sm:justify-between")}>
        <div className="min-w-0 grow">
          {src ? (
            <img
              src={src}
              alt={block.caption || t("contentBlock.image.altFallback")}
              className="mb-3 block max-w-full rounded-md border border-border"
              style={{
                width: preview.width,
                height: "auto",
                margin: imgMargin,
              }}
            />
          ) : (
            <div
              className="mb-3 rounded-md border border-border bg-muted"
              style={{
                width: preview.width,
                maxWidth: "100%",
                height: preview.height,
                margin: imgMargin,
              }}
            />
          )}
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <ToggleGroup
              type="single"
              size="sm"
              value={align}
              onValueChange={(next) =>
                next && onChange({ ...block, align: next })
              }
              aria-label={t("contentBlock.image.alignmentAriaLabel")}
              className={TOUCH_TOGGLES}
            >
              <ToggleGroupItem
                value="left"
                aria-label={t("contentBlock.image.alignLeft")}
              >
                <AlignLeftIcon />
              </ToggleGroupItem>
              <ToggleGroupItem
                value="center"
                aria-label={t("contentBlock.image.alignCenter")}
              >
                <AlignCenterIcon />
              </ToggleGroupItem>
              <ToggleGroupItem
                value="right"
                aria-label={t("contentBlock.image.alignRight")}
              >
                <AlignRightIcon />
              </ToggleGroupItem>
            </ToggleGroup>
            <ToggleGroup
              type="single"
              size="sm"
              value={size}
              onValueChange={(next) =>
                next && onChange({ ...block, size: next })
              }
              aria-label={t("contentBlock.image.sizeAriaLabel")}
              className={TOUCH_TOGGLES}
            >
              {IMAGE_SIZES.map((s) => (
                <ToggleGroupItem key={s.key} value={s.key}>
                  {s.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {canReplace && (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className={TOUCH_SM_BUTTON}
                    >
                      <ArrowLeftRightIcon data-icon="inline-start" />
                      {t("contentBlock.image.replace")}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {onReplaceFile && (
                      <DropdownMenuItem
                        onSelect={() => fileRef.current?.click()}
                      >
                        <div className="flex flex-col gap-0.5">
                          <span>
                            {t("contentBlock.image.uploadFile.label")}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {t("contentBlock.image.uploadFile.description")}
                          </span>
                        </div>
                      </DropdownMenuItem>
                    )}
                    {onReplaceSearch && (
                      <DropdownMenuItem onSelect={() => onReplaceSearch()}>
                        <div className="flex flex-col gap-0.5">
                          <span>
                            {t("contentBlock.image.searchOnline.label")}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {t("contentBlock.image.searchOnline.description")}
                          </span>
                        </div>
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={onPickReplacement}
                />
              </>
            )}
          </div>
          <Field>
            <FieldLabel htmlFor={`${block.id}-caption`}>
              {t("contentBlock.image.captionLabel")}
            </FieldLabel>
            <LiveInput
              id={`${block.id}-caption`}
              value={block.caption || ""}
              onCommit={(caption) => onChange({ ...block, caption })}
              data-collab-field={`block:${block.id}:caption`}
            />
          </Field>
        </div>
        {controls}
      </div>
    </div>
  );
}

function SpellingBlock({
  block,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
  capitalizedWords = [],
  dragHandle = null,
}) {
  const { t } = useTranslation("editorSections");
  const words = block.words || [];

  const setWord = (id, text) =>
    onChange({
      ...block,
      words: words.map((w) => (w.id === id ? { ...w, text } : w)),
    });

  const addWord = () =>
    onChange({ ...block, words: [...words, { id: newId(), text: "" }] });

  const removeWord = (id) =>
    onChange({ ...block, words: words.filter((w) => w.id !== id) });

  // Replace the list with every capitalized word found in the lesson's text.
  // Falls back to a single empty row if the lesson has none yet, so the block
  // never collapses to zero editable rows.
  const fillCapitalized = () =>
    onChange({
      ...block,
      words: capitalizedWords.length
        ? capitalizedWords.map((text) => ({ id: newId(), text }))
        : [{ id: newId(), text: "" }],
    });

  return (
    <div
      className="rounded-md border border-border bg-card p-4 text-card-foreground"
      style={{ borderLeftWidth: 5, borderLeftColor: SPELLING_COLOR }}
    >
      <div className={BLOCK_LAYOUT}>
        <div className="min-w-0 grow">
          <Badge
            style={{ backgroundColor: SPELLING_COLOR, color: "#fff" }}
            className="mb-3"
          >
            {t("contentBlock.spelling.badge")}
          </Badge>
          <div className="flex flex-col gap-2">
            {words.map((w, i) => (
              <div key={w.id} className="flex items-center gap-1">
                <LiveInput
                  placeholder={t("contentBlock.spelling.wordPlaceholder", {
                    number: i + 1,
                  })}
                  value={w.text}
                  onCommit={(text) => setWord(w.id, text)}
                  data-collab-field={`block:${block.id}:word:${w.id}`}
                />
                <IconActionButton
                  tooltip={t("contentBlock.spelling.removeWord")}
                  onClick={() => removeWord(w.id)}
                  disabled={words.length <= 1}
                >
                  <Trash2Icon />
                </IconActionButton>
              </div>
            ))}
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={addWord}
                className={TOUCH_SM_BUTTON}
              >
                <PlusIcon data-icon="inline-start" />
                {t("contentBlock.spelling.addWord")}
              </Button>
            </div>
          </div>
        </div>
        {/* Mirrors ContentBlock's shared `controls` (this block has two extra
            buttons of its own), including its mobile footer treatment. */}
        <div className="flex shrink-0 items-center gap-1 border-t border-border pt-2 sm:border-t-0 sm:pt-0">
          {dragHandle}
          <IconActionButton
            tooltip={t("contentBlock.controls.moveUp")}
            onClick={onMoveUp}
            disabled={isFirst}
          >
            <ArrowUpIcon />
          </IconActionButton>
          <IconActionButton
            tooltip={t("contentBlock.controls.moveDown")}
            onClick={onMoveDown}
            disabled={isLast}
          >
            <ArrowDownIcon />
          </IconActionButton>
          <IconActionButton
            tooltip={
              capitalizedWords.length
                ? t("contentBlock.spelling.fillCapitalizedAvailable")
                : t("contentBlock.spelling.fillCapitalizedEmpty")
            }
            onClick={fillCapitalized}
            disabled={!capitalizedWords.length}
            className="text-primary"
          >
            <WandSparklesIcon />
          </IconActionButton>
          <IconActionButton
            tooltip={t("contentBlock.controls.delete")}
            onClick={onDelete}
            destructive
          >
            <Trash2Icon />
          </IconActionButton>
        </div>
      </div>
    </div>
  );
}

function QuestionBlock({ block, onChange, controls }) {
  const { t } = useTranslation("editorSections");
  const meta = questionMeta(block.questionType);
  const answers = block.answers || [];
  const steps = block.steps || [];

  const setAnswer = (id, text) =>
    onChange({
      ...block,
      answers: answers.map((a) => (a.id === id ? { ...a, text } : a)),
    });

  const addAnswer = () =>
    onChange({ ...block, answers: [...answers, { id: newId(), text: "" }] });

  const removeAnswer = (id) =>
    onChange({ ...block, answers: answers.filter((a) => a.id !== id) });

  const setStep = (id, text) =>
    onChange({
      ...block,
      steps: steps.map((s) => (s.id === id ? { ...s, text } : s)),
    });

  const addStep = () =>
    onChange({ ...block, steps: [...steps, { id: newId(), text: "" }] });

  const removeStep = (id) =>
    onChange({ ...block, steps: steps.filter((s) => s.id !== id) });

  return (
    <div
      className="rounded-md border border-border bg-card p-4 text-card-foreground"
      style={{ borderLeftWidth: 5, borderLeftColor: meta.color }}
    >
      <div className={BLOCK_LAYOUT}>
        <div className="min-w-0 grow">
          <Badge
            style={{ backgroundColor: meta.color, color: "#fff" }}
            className="mb-3"
          >
            {meta.label}
          </Badge>
          <Field>
            <FieldLabel htmlFor={`${block.id}-prompt`}>
              {t("contentBlock.question.label")}
            </FieldLabel>
            <LiveTextarea
              id={`${block.id}-prompt`}
              placeholder={t("contentBlock.question.promptPlaceholder")}
              value={block.prompt || ""}
              onCommit={(prompt) => onChange({ ...block, prompt })}
              data-collab-field={`block:${block.id}:prompt`}
              className="min-h-9"
            />
          </Field>

          {block.questionType === "number" && (
            <>
              <Field className="mt-3 max-w-[200px]">
                <FieldLabel htmlFor={`${block.id}-answer`}>
                  {t("contentBlock.question.answerLabel")}
                </FieldLabel>
                <LiveInput
                  id={`${block.id}-answer`}
                  type="number"
                  value={block.answer ?? ""}
                  onCommit={(answer) => onChange({ ...block, answer })}
                  data-collab-field={`block:${block.id}:answer`}
                />
              </Field>

              <div className="mt-3 flex flex-col gap-2">
                {steps.map((step, i) => (
                  <div key={step.id} className="flex items-center gap-1">
                    <LiveInput
                      placeholder={t("contentBlock.question.stepPlaceholder", {
                        number: i + 1,
                      })}
                      value={step.text}
                      onCommit={(text) => setStep(step.id, text)}
                      data-collab-field={`block:${block.id}:step:${step.id}`}
                    />
                    <IconActionButton
                      tooltip={t("contentBlock.question.removeStep")}
                      onClick={() => removeStep(step.id)}
                    >
                      <Trash2Icon />
                    </IconActionButton>
                  </div>
                ))}
                <div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={addStep}
                    className={TOUCH_SM_BUTTON}
                  >
                    <PlusIcon data-icon="inline-start" />
                    {t("contentBlock.question.addStep")}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("contentBlock.question.stepsHelp")}
                </p>
              </div>
            </>
          )}

          {block.questionType === "single" && (
            <Field className="mt-3">
              <FieldLabel htmlFor={`${block.id}-answer`}>
                {t("contentBlock.question.answerLabel")}
              </FieldLabel>
              <LiveInput
                id={`${block.id}-answer`}
                placeholder={t("contentBlock.question.answerPlaceholder")}
                value={block.answer ?? ""}
                onCommit={(answer) => onChange({ ...block, answer })}
                data-collab-field={`block:${block.id}:answer`}
              />
            </Field>
          )}

          {block.questionType === "multiple" && (
            <div className="mt-3 flex flex-col gap-2">
              {answers.map((ans, i) => (
                <div key={ans.id} className="flex items-center gap-1">
                  <LiveInput
                    placeholder={t(
                      "contentBlock.question.answerPlaceholderMultiple",
                      { number: i + 1 },
                    )}
                    value={ans.text}
                    onCommit={(text) => setAnswer(ans.id, text)}
                    data-collab-field={`block:${block.id}:answer:${ans.id}`}
                  />
                  <IconActionButton
                    tooltip={t("contentBlock.question.removeAnswer")}
                    onClick={() => removeAnswer(ans.id)}
                    disabled={answers.length <= 1}
                  >
                    <Trash2Icon />
                  </IconActionButton>
                </div>
              ))}
              <div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={addAnswer}
                  className={TOUCH_SM_BUTTON}
                >
                  <PlusIcon data-icon="inline-start" />
                  {t("contentBlock.question.addAnswer")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("contentBlock.question.answersHelp")}
              </p>
            </div>
          )}

          {block.questionType === "background" && (
            <Field className="mt-3">
              <FieldLabel htmlFor={`${block.id}-answer`}>
                {t("contentBlock.question.answerLabel")}
              </FieldLabel>
              <LiveInput
                id={`${block.id}-answer`}
                placeholder={t("contentBlock.question.answerPlaceholder")}
                value={block.answer ?? ""}
                onCommit={(answer) => onChange({ ...block, answer })}
                data-collab-field={`block:${block.id}:answer`}
              />
            </Field>
          )}
        </div>
        {controls}
      </div>
    </div>
  );
}

// Memoized so an unedited block skips re-rendering when a sibling block (or the
// rest of the lesson) changes. SectionCard hands each block stable, id-based
// callbacks, so only the block whose data actually changed re-renders.
export default memo(ContentBlock);
