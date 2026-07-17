import { memo, useRef } from "react";
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
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip.jsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.jsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu.jsx";
import { LiveInput, LiveTextarea } from "./LiveField.jsx";
import { cn } from "../lib/utils.js";
import {
  fitWithin,
  imageSizeScale,
  IMAGE_SIZES,
  DEFAULT_IMAGE_SIZE,
  DEFAULT_IMAGE_ALIGN,
} from "../lib/image.js";
import { newId } from "../lib/id.js";
import { useImageSrc } from "../lib/useImageSrc.js";
import { questionMeta } from "../lib/questions.js";
import { SPELLING_COLOR } from "../lib/spelling.js";

// Small icon-button + tooltip, used throughout for the move/delete row —
// wrapped in a <span> so the tooltip still shows while the button is
// disabled (a plain disabled <button> doesn't fire pointer events at all).
function ControlButton({ tooltip, disabled, destructive, ...props }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            className={cn(
              destructive &&
                "text-destructive hover:bg-destructive/10 hover:text-destructive",
            )}
            {...props}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

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
  const controls = (
    <div className="flex shrink-0 items-center gap-1">
      {dragHandle}
      <ControlButton tooltip="Move up" onClick={onMoveUp} disabled={isFirst}>
        <ArrowUpIcon />
      </ControlButton>
      <ControlButton tooltip="Move down" onClick={onMoveDown} disabled={isLast}>
        <ArrowDownIcon />
      </ControlButton>
      <ControlButton tooltip="Delete block" onClick={onDelete} destructive>
        <Trash2Icon />
      </ControlButton>
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
      <div className="flex items-start gap-2">
        <LiveTextarea
          placeholder="Type lesson text here…"
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
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 grow">
          {src ? (
            <img
              src={src}
              alt={block.caption || "lesson image"}
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
              aria-label="image alignment"
            >
              <ToggleGroupItem value="left" aria-label="align left">
                <AlignLeftIcon />
              </ToggleGroupItem>
              <ToggleGroupItem value="center" aria-label="align center">
                <AlignCenterIcon />
              </ToggleGroupItem>
              <ToggleGroupItem value="right" aria-label="align right">
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
              aria-label="image size"
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
                    <Button type="button" variant="outline" size="sm">
                      <ArrowLeftRightIcon data-icon="inline-start" />
                      Replace
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {onReplaceFile && (
                      <DropdownMenuItem
                        onSelect={() => fileRef.current?.click()}
                      >
                        <div className="flex flex-col gap-0.5">
                          <span>Upload file</span>
                          <span className="text-xs text-muted-foreground">
                            Swap in an image from your device
                          </span>
                        </div>
                      </DropdownMenuItem>
                    )}
                    {onReplaceSearch && (
                      <DropdownMenuItem onSelect={() => onReplaceSearch()}>
                        <div className="flex flex-col gap-0.5">
                          <span>Search online</span>
                          <span className="text-xs text-muted-foreground">
                            Find a replacement from Pixabay or Wikimedia
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
              Caption (optional)
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
      <div className="flex items-start gap-2">
        <div className="grow">
          <Badge
            style={{ backgroundColor: SPELLING_COLOR, color: "#fff" }}
            className="mb-3"
          >
            Spelling words
          </Badge>
          <div className="flex flex-col gap-2">
            {words.map((w, i) => (
              <div key={w.id} className="flex items-center gap-1">
                <LiveInput
                  placeholder={`Word ${i + 1}`}
                  value={w.text}
                  onCommit={(text) => setWord(w.id, text)}
                  data-collab-field={`block:${block.id}:word:${w.id}`}
                />
                <ControlButton
                  tooltip="Remove word"
                  onClick={() => removeWord(w.id)}
                  disabled={words.length <= 1}
                >
                  <Trash2Icon />
                </ControlButton>
              </div>
            ))}
            <div>
              <Button type="button" variant="ghost" size="sm" onClick={addWord}>
                <PlusIcon data-icon="inline-start" />
                Add word
              </Button>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {dragHandle}
          <ControlButton
            tooltip="Move up"
            onClick={onMoveUp}
            disabled={isFirst}
          >
            <ArrowUpIcon />
          </ControlButton>
          <ControlButton
            tooltip="Move down"
            onClick={onMoveDown}
            disabled={isLast}
          >
            <ArrowDownIcon />
          </ControlButton>
          <ControlButton
            tooltip={
              capitalizedWords.length
                ? "Fill in every ALL-CAPS word from the lesson text"
                : "No ALL-CAPS words in the lesson text yet"
            }
            onClick={fillCapitalized}
            disabled={!capitalizedWords.length}
            className="text-primary"
          >
            <WandSparklesIcon />
          </ControlButton>
          <ControlButton tooltip="Delete block" onClick={onDelete} destructive>
            <Trash2Icon />
          </ControlButton>
        </div>
      </div>
    </div>
  );
}

function QuestionBlock({ block, onChange, controls }) {
  const meta = questionMeta(block.questionType);
  const answers = block.answers || [];

  const setAnswer = (id, text) =>
    onChange({
      ...block,
      answers: answers.map((a) => (a.id === id ? { ...a, text } : a)),
    });

  const addAnswer = () =>
    onChange({ ...block, answers: [...answers, { id: newId(), text: "" }] });

  const removeAnswer = (id) =>
    onChange({ ...block, answers: answers.filter((a) => a.id !== id) });

  return (
    <div
      className="rounded-md border border-border bg-card p-4 text-card-foreground"
      style={{ borderLeftWidth: 5, borderLeftColor: meta.color }}
    >
      <div className="flex items-start gap-2">
        <div className="grow">
          <Badge
            style={{ backgroundColor: meta.color, color: "#fff" }}
            className="mb-3"
          >
            {meta.label}
          </Badge>
          <Field>
            <FieldLabel htmlFor={`${block.id}-prompt`}>Question</FieldLabel>
            <LiveTextarea
              id={`${block.id}-prompt`}
              placeholder="Type the question…"
              value={block.prompt || ""}
              onCommit={(prompt) => onChange({ ...block, prompt })}
              data-collab-field={`block:${block.id}:prompt`}
              className="min-h-9"
            />
          </Field>

          {block.questionType === "number" && (
            <Field className="mt-3 max-w-[200px]">
              <FieldLabel htmlFor={`${block.id}-answer`}>Answer</FieldLabel>
              <LiveInput
                id={`${block.id}-answer`}
                type="number"
                value={block.answer ?? ""}
                onCommit={(answer) => onChange({ ...block, answer })}
                data-collab-field={`block:${block.id}:answer`}
              />
            </Field>
          )}

          {block.questionType === "single" && (
            <Field className="mt-3">
              <FieldLabel htmlFor={`${block.id}-answer`}>Answer</FieldLabel>
              <LiveInput
                id={`${block.id}-answer`}
                placeholder="The correct answer…"
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
                    placeholder={`Answer ${i + 1}`}
                    value={ans.text}
                    onCommit={(text) => setAnswer(ans.id, text)}
                    data-collab-field={`block:${block.id}:answer:${ans.id}`}
                  />
                  <ControlButton
                    tooltip="Remove answer"
                    onClick={() => removeAnswer(ans.id)}
                    disabled={answers.length <= 1}
                  >
                    <Trash2Icon />
                  </ControlButton>
                </div>
              ))}
              <div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={addAnswer}
                >
                  <PlusIcon data-icon="inline-start" />
                  Add answer
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Type every accepted answer. The student only needs to give one
                of them to be correct.
              </p>
            </div>
          )}

          {block.questionType === "background" && (
            <Field className="mt-3">
              <FieldLabel htmlFor={`${block.id}-answer`}>Answer</FieldLabel>
              <LiveInput
                id={`${block.id}-answer`}
                placeholder="The correct answer…"
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
