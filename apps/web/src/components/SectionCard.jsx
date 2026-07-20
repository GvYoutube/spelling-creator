import { memo, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  TypeIcon,
  ImageIcon,
  SearchIcon,
  CircleHelpIcon,
  SpellCheckIcon,
  SparklesIcon,
  Trash2Icon,
  ArrowUpIcon,
  ArrowDownIcon,
  GripVerticalIcon,
} from "lucide-react";
import { Button } from "./ui/button.jsx";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip.jsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu.jsx";
import ContentBlock from "./ContentBlock.jsx";
import { LiveInput } from "./LiveField.jsx";
import IconActionButton from "./IconActionButton.jsx";
import AiTextDialog from "./AiTextDialog.jsx";
import AiQuestionDialog from "./AiQuestionDialog.jsx";
import ImageSearchDialog from "./ImageSearchDialog.jsx";
import { cn } from "../lib/utils.js";
import { newId } from "../lib/id.js";
import { readImageFile } from "../lib/image.js";
import { storeImageBytes } from "../lib/imageRef.js";
import {
  QUESTION_TYPE_LIST,
  createQuestionBlock,
  buildQuestionBlock,
} from "../lib/questions.js";
import { createSpellingBlock } from "../lib/spelling.js";

function SectionCard({
  section,
  documentName,
  index,
  onChange,
  onDelete,
  onMove,
  isFirst,
  isLast,
  onError,
  capitalizedWords = [],
  // Block drag-and-drop is owned by the editor page (a block can be dragged from
  // one section into another, so no single card can hold the in-flight drag).
  // This card only measures the pointer against its own rows and reports where
  // the block would land. `dragBlockId` is the block in flight anywhere in the
  // document; `overId`/`overPos` are non-null only while it hovers *this*
  // section, and `isDropSection` covers an empty section, which has no row for
  // the insertion line to sit against.
  dragBlockId = null,
  overId = null,
  overPos = null,
  isDropSection = false,
  onBlockDragStart,
  onBlockDragOver,
  onBlockDragLeave,
  onBlockDrop,
  onBlockDragEnd,
}) {
  const { t } = useTranslation("editorSections");
  const fileInputRef = useRef(null);
  // The element wrapping this section's block rows; drop targeting measures the
  // rows inside it against the pointer.
  const listRef = useRef(null);
  // Mirror the latest section into a ref so the stable callbacks below can read
  // current blocks without being re-created on every edit (which would defeat
  // the memoized <BlockRow>s). Assigning during render is fine for a mirror ref.
  const sectionRef = useRef(section);
  // eslint-disable-next-line react-hooks/refs -- intentional mirror ref, read only in stable callbacks below
  sectionRef.current = section;
  const [aiOpen, setAiOpen] = useState(false);
  const [aiQuestionOpen, setAiQuestionOpen] = useState(false);
  const [imageSearchOpen, setImageSearchOpen] = useState(false);
  // When set, the image search dialog replaces this existing image block in
  // place rather than inserting a new one. Null = the dialog adds a new block.
  const [replaceTarget, setReplaceTarget] = useState(null);
  // The block this user is currently editing, so the "add block" toolbar can sit
  // directly beneath it (and new blocks insert there). Purely local UI state —
  // deliberately NOT broadcast to collaborators, so each peer's toolbar follows
  // their own cursor, not everyone else's.
  const [activeBlockId, setActiveBlockId] = useState(null);
  // Mirror the id of the block in flight (and this section's id) so the drag
  // handlers below stay stable — re-creating them on every dragover would hand
  // every <BlockRow> new props mid-drag.
  const dragRef = useRef({ dragBlockId: null, sectionId: null });
  // eslint-disable-next-line react-hooks/refs -- intentional mirror ref, read only in stable drag handlers
  dragRef.current.dragBlockId = dragBlockId;
  // eslint-disable-next-line react-hooks/refs -- intentional mirror ref, read only in stable drag handlers
  dragRef.current.sectionId = section.id;

  // Replace the whole block list. Reads the current section from the ref and
  // routes through the (stable) parent onChange(id, next).
  const updateBlocks = useCallback(
    (blocks) => {
      const s = sectionRef.current;
      onChange(s.id, { ...s, blocks });
    },
    [onChange],
  );

  // Insert new block(s) immediately after the block being edited (or append when
  // nothing is active), then keep the toolbar with the freshly added content so
  // successive adds stack in order.
  const insertBlocks = (newBlocks) => {
    if (!newBlocks.length) return;
    const blocks = [...section.blocks];
    const activeIndex = blocks.findIndex((b) => b.id === activeBlockId);
    const at = activeIndex === -1 ? blocks.length : activeIndex + 1;
    blocks.splice(at, 0, ...newBlocks);
    updateBlocks(blocks);
    setActiveBlockId(newBlocks[newBlocks.length - 1].id);
  };

  // The section's existing text, used to ground AI question suggestions.
  const sectionText = section.blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n\n");

  // Prompts of the questions already in this section, sent to the AI so a newly
  // suggested question doesn't repeat one the user already has.
  const existingQuestions = section.blocks
    .filter((b) => b.type === "question" && b.prompt)
    .map((b) => b.prompt);

  const addTextBlock = () => {
    insertBlocks([{ id: newId(), type: "text", text: "" }]);
  };

  const addSuggestedTextBlock = (text) => {
    insertBlocks([{ id: newId(), type: "text", text }]);
  };

  const addQuestionBlock = (questionType) => {
    insertBlocks([createQuestionBlock(newId, questionType)]);
  };

  const addSpellingBlock = () => {
    insertBlocks([createSpellingBlock(newId)]);
  };

  const addSuggestedQuestionBlock = (questionType, data) => {
    insertBlocks([buildQuestionBlock(newId, questionType, data)]);
  };

  const handleImageFiles = async (files) => {
    const newBlocks = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      try {
        const img = await readImageFile(file);
        const image = await storeImageBytes(img.bytes, img.mime);
        newBlocks.push({
          id: newId(),
          type: "image",
          image,
          width: img.width,
          height: img.height,
          caption: "",
        });
      } catch (err) {
        onError?.(err.message || t("sectionCard.errors.addImageFailed"));
      }
    }
    insertBlocks(newBlocks);
  };

  const onPickImages = (e) => {
    if (e.target.files?.length) handleImageFiles(e.target.files);
    e.target.value = ""; // allow re-selecting the same file
  };

  const addSearchedImage = ({ image, width, height, caption = "" }) => {
    // Replacing an existing block: swap its image bytes (and the searched
    // image's attribution caption) while keeping the block where it is, along
    // with its alignment and size.
    if (replaceTarget) {
      const blocks = sectionRef.current.blocks;
      updateBlocks(
        blocks.map((b) =>
          b.id === replaceTarget ? { ...b, image, width, height, caption } : b,
        ),
      );
      return;
    }
    insertBlocks([
      { id: newId(), type: "image", image, width, height, caption },
    ]);
  };

  // Replace an image block's bytes from a freshly picked file, in place: the
  // block keeps its id, position, alignment, size, and caption.
  const replaceImageFile = useCallback(
    async (blockId, file) => {
      if (!file || !file.type.startsWith("image/")) return;
      try {
        const img = await readImageFile(file);
        const image = await storeImageBytes(img.bytes, img.mime);
        const blocks = sectionRef.current.blocks;
        updateBlocks(
          blocks.map((b) =>
            b.id === blockId
              ? { ...b, image, width: img.width, height: img.height }
              : b,
          ),
        );
      } catch (err) {
        onError?.(err.message || t("sectionCard.errors.replaceImageFailed"));
      }
    },
    [updateBlocks, onError, t],
  );

  // Open the image search dialog aimed at replacing an existing block.
  const startReplaceSearch = useCallback((blockId) => {
    setReplaceTarget(blockId);
    setImageSearchOpen(true);
  }, []);

  // Per-block callbacks handed to memoized <BlockRow>s — all stable (read the
  // live section from sectionRef), so editing one block never re-renders its
  // siblings. `dir` is -1 (up) / +1 (down).
  const updateBlock = useCallback(
    (blockId, next) => {
      const blocks = sectionRef.current.blocks;
      updateBlocks(blocks.map((b) => (b.id === blockId ? next : b)));
    },
    [updateBlocks],
  );

  const deleteBlock = useCallback(
    (blockId) => {
      const blocks = sectionRef.current.blocks;
      updateBlocks(blocks.filter((b) => b.id !== blockId));
    },
    [updateBlocks],
  );

  const moveBlock = useCallback(
    (blockId, dir) => {
      const blocks = [...sectionRef.current.blocks];
      const from = blocks.findIndex((b) => b.id === blockId);
      const to = from + dir;
      if (from === -1 || to < 0 || to >= blocks.length) return;
      const [moved] = blocks.splice(from, 1);
      blocks.splice(to, 0, moved);
      updateBlocks(blocks);
    },
    [updateBlocks],
  );

  const activateBlock = useCallback((blockId) => setActiveBlockId(blockId), []);

  // Drag starts from a block's grab handle (not the whole block, so text
  // selection and field editing never trigger a drag). The drag image is the
  // whole block element, and we anchor it to the cursor's real position within
  // the block so the ghost stays exactly under the pointer where it was grabbed
  // (rather than pinned to a fixed top-left offset, which left the cursor
  // floating in a corner of these wide blocks).
  const handleDragStart = useCallback(
    (e, blockId) => {
      const wrapper = e.currentTarget.closest("[data-block-id]");
      if (wrapper) {
        const rect = wrapper.getBoundingClientRect();
        e.dataTransfer.setDragImage(
          wrapper,
          e.clientX - rect.left,
          e.clientY - rect.top,
        );
      }
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", blockId); // Firefox needs some payload
      onBlockDragStart(dragRef.current.sectionId, blockId);
    },
    [onBlockDragStart],
  );

  // Dragging anywhere over this section — whether the block came from here or
  // from another section: work out where it would land from the pointer's height
  // alone, rather than only reacting when it happens to be over another block.
  // The gaps between blocks, the section header, and the card's padding all
  // resolve to a real insertion point, so a drop never silently fails just
  // because the pointer landed a few pixels off a row. A section with no blocks
  // to measure against (an empty one) reports a null target: land at the end.
  const handleDragOver = useCallback(
    (e) => {
      const { dragBlockId, sectionId } = dragRef.current;
      if (!dragBlockId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const target = dropTargetAt(listRef.current, e.clientY, dragBlockId);
      onBlockDragOver(sectionId, target?.id ?? null, target?.pos ?? null);
    },
    [onBlockDragOver],
  );

  // Drop: the editor page holds the in-flight drag and applies the move, since
  // it may span two sections.
  const handleDrop = useCallback(
    (e) => {
      if (!dragRef.current.dragBlockId) return;
      e.preventDefault();
      onBlockDrop();
    },
    [onBlockDrop],
  );

  // The pointer left this card entirely (not just moved between its children):
  // hide the insertion line, since releasing out here shouldn't move anything.
  const handleDragLeave = useCallback(
    (e) => {
      if (e.currentTarget.contains(e.relatedTarget)) return;
      onBlockDragLeave(dragRef.current.sectionId);
    },
    [onBlockDragLeave],
  );

  // Where the "add block" toolbar sits: directly under the block being edited,
  // or — when nothing is active (or the active block was deleted/lives in
  // another section) — at the bottom of the section.
  const activeIndex = section.blocks.findIndex((b) => b.id === activeBlockId);

  const addToolbar = (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={addTextBlock}>
        <TypeIcon data-icon="inline-start" />
        {t("sectionCard.toolbar.addText")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => fileInputRef.current?.click()}
      >
        <ImageIcon data-icon="inline-start" />
        {t("sectionCard.toolbar.addImage")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setImageSearchOpen(true)}
      >
        <SearchIcon data-icon="inline-start" />
        {t("sectionCard.toolbar.searchImages")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <CircleHelpIcon data-icon="inline-start" />
            {t("sectionCard.toolbar.addQuestion")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {QUESTION_TYPE_LIST.map((q) => (
            <DropdownMenuItem
              key={q.key}
              onSelect={() => addQuestionBlock(q.key)}
            >
              <span
                className="inline-block size-3 shrink-0 rounded-full"
                style={{ backgroundColor: q.color }}
              />
              <div className="flex flex-col gap-0.5">
                <span>{q.label}</span>
                <span className="text-xs text-muted-foreground">
                  {q.description}
                </span>
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="outline" size="sm" onClick={addSpellingBlock}>
        <SpellCheckIcon data-icon="inline-start" />
        {t("sectionCard.toolbar.spellingWords")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <SparklesIcon data-icon="inline-start" />
            {t("sectionCard.toolbar.generateWithAi")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => setAiOpen(true)}>
            <div className="flex flex-col gap-0.5">
              <span>{t("sectionCard.toolbar.aiText.label")}</span>
              <span className="text-xs text-muted-foreground">
                {t("sectionCard.toolbar.aiText.description")}
              </span>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAiQuestionOpen(true)}>
            <div className="flex flex-col gap-0.5">
              <span>{t("sectionCard.toolbar.aiQuestion.label")}</span>
              <span className="text-xs text-muted-foreground">
                {t("sectionCard.toolbar.aiQuestion.description")}
              </span>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={onPickImages}
      />
    </div>
  );

  return (
    <div className="rounded-panel border border-border bg-card text-card-foreground shadow-(--shadow-panel)">
      <div
        className="p-4"
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragLeave={handleDragLeave}
      >
        <div className="mb-3 flex items-center gap-2">
          <div className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
            {index + 1}
          </div>
          <LiveInput
            placeholder={t("sectionCard.sectionNamePlaceholder")}
            value={section.name}
            onCommit={(name) => onChange(section.id, { ...section, name })}
            data-collab-field={`section:${section.id}:name`}
            className="border-0 border-b border-transparent bg-transparent px-0 text-xl font-semibold shadow-none focus-visible:border-b-ring focus-visible:ring-0"
          />
          <IconActionButton
            tooltip={t("sectionCard.moveUp")}
            onClick={() => onMove(section.id, -1)}
            disabled={isFirst}
          >
            <ArrowUpIcon />
          </IconActionButton>
          <IconActionButton
            tooltip={t("sectionCard.moveDown")}
            onClick={() => onMove(section.id, 1)}
            disabled={isLast}
          >
            <ArrowDownIcon />
          </IconActionButton>
          <IconActionButton
            tooltip={t("sectionCard.delete")}
            onClick={() => onDelete(section.id)}
            destructive
          >
            <Trash2Icon />
          </IconActionButton>
        </div>

        <hr className="mb-3 border-border" />

        {section.blocks.length === 0 ? (
          // An empty section has no row for the insertion line to sit against,
          // so while a block is in flight the placeholder text becomes the drop
          // zone itself — otherwise there'd be nothing telling the user that an
          // empty section will happily take the block.
          <div
            className={cn(
              "mb-3",
              dragBlockId &&
                cn(
                  "rounded-md border-2 border-dashed p-4 transition-colors",
                  isDropSection
                    ? "border-primary bg-accent"
                    : "border-border bg-transparent",
                ),
            )}
          >
            <p
              className={cn(
                "text-sm",
                isDropSection ? "text-primary" : "text-muted-foreground",
              )}
            >
              {dragBlockId
                ? t("sectionCard.emptyDropHint")
                : t("sectionCard.emptyState")}
            </p>
          </div>
        ) : (
          <div ref={listRef} className="mb-3 flex flex-col gap-3">
            {section.blocks.map((block, i) => [
              <BlockRow
                key={block.id}
                block={block}
                isFirst={i === 0}
                isLast={i === section.blocks.length - 1}
                // Drag state is passed as plain booleans so a block that isn't
                // involved in the current drag keeps identical props (and stays
                // memoized) while another block is being dragged over.
                isDragging={dragBlockId === block.id}
                dropBefore={overId === block.id && overPos === "before"}
                dropAfter={overId === block.id && overPos === "after"}
                capitalizedWords={capitalizedWords}
                onActivate={activateBlock}
                onUpdate={updateBlock}
                onDelete={deleteBlock}
                onMove={moveBlock}
                onReplaceImageFile={replaceImageFile}
                onReplaceImageSearch={startReplaceSearch}
                onDragStart={handleDragStart}
                onDragEnd={onBlockDragEnd}
              />,
              // The toolbar sits directly beneath the block being edited.
              i === activeIndex ? (
                <div key={`${block.id}-toolbar`}>{addToolbar}</div>
              ) : null,
            ])}
          </div>
        )}

        {/* When no block in this section is active, the toolbar stays at the
            bottom (its original home). */}
        {activeIndex === -1 && addToolbar}

        <AiTextDialog
          open={aiOpen}
          sectionTitle={section.name}
          documentName={documentName}
          onInsert={addSuggestedTextBlock}
          onClose={() => setAiOpen(false)}
        />

        <AiQuestionDialog
          open={aiQuestionOpen}
          sectionTitle={section.name}
          documentName={documentName}
          sectionText={sectionText}
          existingQuestions={existingQuestions}
          onInsert={addSuggestedQuestionBlock}
          onClose={() => setAiQuestionOpen(false)}
        />

        <ImageSearchDialog
          open={imageSearchOpen}
          replacing={Boolean(replaceTarget)}
          onInsert={addSearchedImage}
          onClose={() => {
            setImageSearchOpen(false);
            setReplaceTarget(null);
          }}
        />
      </div>
    </div>
  );
}

// Which insertion point a pointer at `clientY` is asking for: the first block
// whose bottom edge is still below the pointer, dropping before or after it
// depending on the half the pointer is in. The block being dragged is skipped —
// it's a hole in the list, not somewhere to land. A pointer above the first
// block resolves to "before the first"; one past the last block, to "after the
// last". Returns null for a section whose only block is the one in flight.
function dropTargetAt(list, clientY, dragId) {
  if (!list) return null;
  const rows = Array.from(list.querySelectorAll("[data-block-id]")).filter(
    (el) => el.dataset.blockId !== dragId,
  );
  if (!rows.length) return null;
  for (const el of rows) {
    const rect = el.getBoundingClientRect();
    if (clientY < rect.bottom) {
      return {
        id: el.dataset.blockId,
        pos: clientY < rect.top + rect.height / 2 ? "before" : "after",
      };
    }
  }
  return { id: rows[rows.length - 1].dataset.blockId, pos: "after" };
}

// Memoized so typing in one block doesn't re-render every other block in the
// section (each block is a deep component tree, the dominant cost on large
// lessons). All callback props it receives are stable and id-based, and drag
// state arrives as plain booleans, so an unedited, undragged block keeps
// identical props and skips re-rendering. The parameterless handlers it
// builds here are recreated per BlockRow render — fine, since a BlockRow
// only renders when its own block (or drag state) actually changes.
const BlockRow = memo(function BlockRow({
  block,
  isFirst,
  isLast,
  isDragging,
  dropBefore,
  dropAfter,
  capitalizedWords,
  onActivate,
  onUpdate,
  onDelete,
  onMove,
  onReplaceImageFile,
  onReplaceImageSearch,
  onDragStart,
  onDragEnd,
}) {
  const { t } = useTranslation("editorSections");
  return (
    // Focusing any field inside a block makes it the active block, so the
    // toolbar follows the user's edit point. onFocus bubbles from the inner
    // inputs. `data-block-id` is what the section's drop targeting measures
    // against the pointer while a block is in flight. The insertion bars
    // (before/after) are drawn via the before:/after: pseudo-element
    // utilities, fading in only on the side the drop would land.
    <div
      data-block-id={block.id}
      onFocus={() => onActivate(block.id)}
      className={cn(
        "relative rounded-md transition-[opacity,box-shadow,transform] duration-150",
        "before:pointer-events-none before:absolute before:inset-x-0 before:top-[-5px] before:h-1 before:rounded-full before:bg-primary before:transition-opacity before:duration-100",
        "after:pointer-events-none after:absolute after:inset-x-0 after:bottom-[-5px] after:h-1 after:rounded-full after:bg-primary after:transition-opacity after:duration-100",
        dropBefore ? "before:opacity-100" : "before:opacity-0",
        dropAfter ? "after:opacity-100" : "after:opacity-0",
        // The block being dragged collapses to a faint, dashed placeholder so
        // the gap it leaves behind reads as "this is moving" rather than just
        // dimming in place.
        isDragging &&
          "scale-[0.99] opacity-50 outline-2 outline-dashed outline-primary/60 outline-offset-2 *:shadow-none",
      )}
    >
      <ContentBlock
        block={block}
        onChange={(next) => onUpdate(block.id, next)}
        onDelete={() => onDelete(block.id)}
        onMoveUp={() => onMove(block.id, -1)}
        onMoveDown={() => onMove(block.id, 1)}
        onReplaceImageFile={(file) => onReplaceImageFile(block.id, file)}
        onReplaceImageSearch={() => onReplaceImageSearch(block.id)}
        isFirst={isFirst}
        isLast={isLast}
        capitalizedWords={capitalizedWords}
        // The grab handle lives inside the block (in its controls row), so it
        // reads as part of the card rather than a bar above it. Drag must start
        // here so editing fields never drags by accident.
        dragHandle={
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                draggable
                onDragStart={(e) => onDragStart(e, block.id)}
                onDragEnd={onDragEnd}
                role="button"
                aria-label={t("sectionCard.dragHandle.ariaLabel")}
                className="inline-flex cursor-grab touch-none items-center justify-center rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:cursor-grabbing active:bg-accent"
              >
                <GripVerticalIcon className="size-4" />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t("sectionCard.dragHandle.tooltip")}
            </TooltipContent>
          </Tooltip>
        }
      />
    </div>
  );
});

export default memo(SectionCard);
