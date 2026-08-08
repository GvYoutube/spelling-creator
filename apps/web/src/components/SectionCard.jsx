import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
  ChevronDownIcon,
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
import {
  idSelector,
  scrollToElement,
  useScrollAnchor,
} from "../lib/useScrollAnchor.js";
import { newId } from "@spelling-creator/core/id";
import { readImageFile } from "@spelling-creator/core/browser/imageFile";
import { storeImageBytes } from "@spelling-creator/core/browser/imageRef";
import {
  QUESTION_TYPE_LIST,
  createQuestionBlock,
  buildQuestionBlock,
} from "@spelling-creator/core/questions";
import { createSpellingBlock } from "@spelling-creator/core/spelling";

// The add-block toolbar's buttons are `size="sm"` — 32px tall, under the touch
// target minimum, and there are six of them wrapping across a phone screen.
// Matches the constant of the same name in ContentBlock.jsx.
const TOUCH_SM_BUTTON = "h-10 sm:pointer-fine:h-8";

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
  // Folded to just this card's header. Owned by EditorPage (so "collapse all"
  // is possible) and passed down as a plain boolean. onToggleCollapse(id, next)
  // takes an optional forced state; omitted, it toggles.
  collapsed = false,
  onToggleCollapse,
  springOpenMs = 500,
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
  // Keeps a block still on screen while the move buttons reorder it past its
  // (tall) neighbours — see moveBlock.
  const anchorScroll = useScrollAnchor();
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
  // every <BlockRow> new props mid-drag. `collapsed` rides along for the
  // spring-open path, which runs from inside those same stable handlers.
  const dragRef = useRef({
    dragBlockId: null,
    sectionId: null,
    collapsed: false,
  });
  // eslint-disable-next-line react-hooks/refs -- intentional mirror ref, read only in stable drag handlers
  dragRef.current.dragBlockId = dragBlockId;
  // eslint-disable-next-line react-hooks/refs -- intentional mirror ref, read only in stable drag handlers
  dragRef.current.sectionId = section.id;
  // eslint-disable-next-line react-hooks/refs -- intentional mirror ref, read only in stable drag handlers
  dragRef.current.collapsed = collapsed;

  // The card's root and its foldable body. The root is what a collapse scrolls
  // to; the body is what carries hidden="until-found".
  const cardRef = useRef(null);
  const bodyRef = useRef(null);
  // Ties the collapse button to what it actually collapses, so a screen reader
  // announcing "expanded"/"collapsed" can also point at the region. Whitespace
  // is stripped because `aria-controls` is a space-separated *list* of ids, and
  // section ids aren't always ours — jsonImport's keepId() passes any string in
  // a lesson file through verbatim (the same reason idSelector uses CSS.escape).
  const bodyId = `section-body-${section.id}`.replace(/\s+/g, "-");
  // Pending spring-open timer while a dragged block hovers this collapsed card.
  const springRef = useRef(null);

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
      // Ride with the block being moved: blocks here run 160-360px tall, so
      // without this each press slides the block (and the button that was just
      // pressed) out from under the pointer, and walking one up a section means
      // re-finding the button every click.
      anchorScroll(idSelector("data-block-id", blockId));
      updateBlocks(blocks);
    },
    [updateBlocks, anchorScroll],
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
      const { dragBlockId, sectionId, collapsed } = dragRef.current;
      if (!dragBlockId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      // Dwell over a collapsed section and it springs open, so a block can be
      // carried into a section that's currently folded away. On a dwell rather
      // than on the first dragover event because dragging *past* a collapsed
      // card on the way somewhere else would otherwise keep re-flowing the page
      // under the pointer.
      if (collapsed) {
        if (springRef.current === null) {
          springRef.current = setTimeout(() => {
            springRef.current = null;
            onToggleCollapse?.(sectionId, false);
          }, springOpenMs);
        }
        // No rows to measure against while it's still folded: report the
        // section with no insertion point, which lands the block at the end —
        // the same thing an empty section does.
        onBlockDragOver(sectionId, null, null);
        return;
      }
      const target = dropTargetAt(listRef.current, e.clientY, dragBlockId);
      onBlockDragOver(sectionId, target?.id ?? null, target?.pos ?? null);
    },
    [onBlockDragOver, onToggleCollapse, springOpenMs],
  );

  // Cancel a pending spring-open: the pointer left, the drop happened, or this
  // card is going away.
  const cancelSpring = useCallback(() => {
    if (springRef.current !== null) {
      clearTimeout(springRef.current);
      springRef.current = null;
    }
  }, []);

  useEffect(() => cancelSpring, [cancelSpring]);

  // The drag ended without this card hearing about it. `drop` and `dragleave`
  // cover the ordinary paths, but a cancelled drag (Escape, or a release over
  // something that won't take it) only reliably fires `dragend` on the *source*
  // element — the card the pointer happens to be resting over isn't guaranteed
  // a matching `dragleave`, and Safari in particular doesn't send one. Without
  // this, a pending timer springs a collapsed section open seconds after the
  // drag it belonged to is over.
  useEffect(() => {
    if (!dragBlockId) cancelSpring();
  }, [dragBlockId, cancelSpring]);

  // Drop: the editor page holds the in-flight drag and applies the move, since
  // it may span two sections.
  const handleDrop = useCallback(
    (e) => {
      if (!dragRef.current.dragBlockId) return;
      e.preventDefault();
      cancelSpring();
      // Dropped before the spring-open fired: expand, or the block the user
      // just carried here would vanish into a folded card.
      if (dragRef.current.collapsed) {
        onToggleCollapse?.(dragRef.current.sectionId, false);
      }
      onBlockDrop();
    },
    [onBlockDrop, cancelSpring, onToggleCollapse],
  );

  // The pointer left this card entirely (not just moved between its children):
  // hide the insertion line, since releasing out here shouldn't move anything.
  const handleDragLeave = useCallback(
    (e) => {
      if (e.currentTarget.contains(e.relatedTarget)) return;
      cancelSpring();
      onBlockDragLeave(dragRef.current.sectionId);
    },
    [onBlockDragLeave, cancelSpring],
  );

  // Where the "add block" toolbar sits: directly under the block being edited,
  // or — when nothing is active (or the active block was deleted/lives in
  // another section) — at the bottom of the section.
  const activeIndex = section.blocks.findIndex((b) => b.id === activeBlockId);

  // 1-based position among *this section's* question blocks. A section in a
  // standard lesson holds fifteen of them, and a question block otherwise shows
  // nothing but its type badge — so ten "Open ended" cards in a row are
  // visually interchangeable and scrolling back to the one you were fixing is a
  // guess. Numbering them makes each one nameable ("Q7"). Counted per section,
  // not per lesson, because that's how the questions are authored and read.
  const questionNumbers = new Map();
  for (const b of section.blocks) {
    if (b.type === "question")
      questionNumbers.set(b.id, questionNumbers.size + 1);
  }

  const addToolbar = (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={addTextBlock}
        className={TOUCH_SM_BUTTON}
      >
        <TypeIcon data-icon="inline-start" />
        {t("sectionCard.toolbar.addText")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => fileInputRef.current?.click()}
        className={TOUCH_SM_BUTTON}
      >
        <ImageIcon data-icon="inline-start" />
        {t("sectionCard.toolbar.addImage")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setImageSearchOpen(true)}
        className={TOUCH_SM_BUTTON}
      >
        <SearchIcon data-icon="inline-start" />
        {t("sectionCard.toolbar.searchImages")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className={TOUCH_SM_BUTTON}>
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
      <Button
        variant="outline"
        size="sm"
        onClick={addSpellingBlock}
        className={TOUCH_SM_BUTTON}
      >
        <SpellCheckIcon data-icon="inline-start" />
        {t("sectionCard.toolbar.spellingWords")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className={TOUCH_SM_BUTTON}>
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

  // Fold the body away with `hidden="until-found"`, which hides it while
  // leaving it searchable: Cmd-F still finds text inside a collapsed section,
  // and the browser reveals it itself (see the `beforematch` handler below).
  //
  // Set imperatively rather than through JSX because React treats `hidden`
  // as a *boolean* attribute — `hidden="until-found"` renders as a plain
  // `hidden=""`, which is `display: none` and not searchable at all (verified
  // in the browser, and still true on React 19; it's the whole reason this isn't
  // a one-line prop). Since
  // React never renders the attribute, the two can't fight over it, including
  // when the browser removes it on a match.
  //
  // Browsers without `until-found` fall back to hiding it outright, which is
  // what unmounting the content would have given us anyway.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (collapsed) el.setAttribute("hidden", "until-found");
    else el.removeAttribute("hidden");
  }, [collapsed]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return undefined;
    const onBeforeMatch = () => onToggleCollapse?.(section.id, false);
    el.addEventListener("beforematch", onBeforeMatch);
    return () => el.removeEventListener("beforematch", onBeforeMatch);
  }, [onToggleCollapse, section.id]);

  const handleToggleCollapse = () => {
    // Folding a section you're *inside* pulls thousands of pixels out from
    // under the viewport, leaving you somewhere arbitrary further down the
    // lesson. If its header has already scrolled past, come back to it.
    if (!collapsed) {
      const rect = cardRef.current?.getBoundingClientRect();
      if (rect && rect.top < 0) {
        scrollToElement(cardRef.current, { smooth: false });
      }
    }
    onToggleCollapse?.(section.id);
  };

  // What's inside, for the folded card — a section reduced to its name alone
  // gives no sense of what it holds or how finished it is.
  const counts = section.blocks.reduce((acc, b) => {
    acc[b.type] = (acc[b.type] || 0) + 1;
    return acc;
  }, {});
  const summary = ["text", "image", "spelling", "question"]
    .filter((type) => counts[type])
    .map((type) =>
      t(`sectionCard.collapsedSummary.${type}`, { count: counts[type] }),
    )
    .join(" · ");

  // Move/delete for the whole section. Rendered twice — once inside the sticky
  // identity row for `sm` and up, once below it on a phone — with a breakpoint
  // hiding whichever copy doesn't apply. See the header markup for why.
  const sectionControls = (
    <>
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
    </>
  );

  return (
    // data-section-id is how the editor page finds this card in the DOM — to
    // scroll a newly added section into view, and to hold it still while it's
    // being moved (see useScrollAnchor). scroll-mt keeps the card's top clear
    // of the app bar when it's scrolled to.
    <div
      ref={cardRef}
      data-section-id={section.id}
      className="scroll-mt-(--header-h) rounded-panel border border-border bg-card text-card-foreground shadow-(--shadow-panel)"
    >
      <div
        className="p-4"
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragLeave={handleDragLeave}
      >
        {/* Sticky, pinned directly below the app bar. A section in a full
            six-section lesson is ~6 screens tall on a desktop and ~9 on a
            phone, so without this the only thing naming the section you're
            editing scrolls away within the first flick and there is nothing on
            screen telling you where you are for the next several thousand
            pixels.

            The negative margins bleed the row out to the card's edges so the
            pinned background covers blocks passing underneath (the card's own
            bg-card is translucent, hence the backdrop blur as well — same glass
            treatment as AppHeader). z-30 stays below the app bar's z-40. The
            border-b replaces what used to be a separate <hr>, so the divider
            travels with the header and it reads as a bar rather than a row
            floating over the content.

            Only the *identity* — number, name, size — is in here. The move and
            delete buttons wrap onto a second row on a phone (see below), and
            pinning that row too made the sticky header 113px, 13% of a 844px
            screen, on top of the app bar's own 64px. Knowing which section
            you're in is worth permanent screen space; three buttons you go
            looking for when you want them is not. */}
        <div className="sticky top-(--header-h) z-30 -mx-4 -mt-4 mb-3 flex items-center gap-2 rounded-t-panel border-b border-border bg-card px-4 pt-4 pb-3 backdrop-blur-(--glass-blur)">
          <IconActionButton
            tooltip={
              collapsed
                ? t("sectionCard.expand")
                : t("sectionCard.collapse", { name: section.name })
            }
            onClick={handleToggleCollapse}
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            className="-ml-1"
          >
            <ChevronDownIcon
              className={cn(
                "transition-transform duration-150",
                collapsed && "-rotate-90",
              )}
            />
          </IconActionButton>
          <div className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
            {index + 1}
          </div>
          <LiveInput
            placeholder={t("sectionCard.sectionNamePlaceholder")}
            value={section.name}
            onCommit={(name) => onChange(section.id, { ...section, name })}
            data-collab-field={`section:${section.id}:name`}
            className="min-w-0 flex-1 border-0 border-b border-transparent bg-transparent px-0 text-xl font-semibold shadow-none focus-visible:border-b-ring focus-visible:ring-0"
          />
          {/* How much section is under you, so its length is at least a number
              rather than only a scrollbar. Desktop only — on a phone the name
              needs every pixel of this row. */}
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
            {t("sectionCard.blockCount", { count: section.blocks.length })}
          </span>
          <div className="hidden shrink-0 items-center gap-1 sm:flex">
            {sectionControls}
          </div>
        </div>

        {/* The same controls on a phone, where they don't fit on the identity
            row (three 40px touch targets and the badge left ~130px of a 360px
            screen for the section name). Out here they scroll away with the top
            of the section instead of being pinned — one of these two copies is
            always display:none, so only one is ever in the a11y tree. */}
        <div className="mb-3 flex items-center gap-1 sm:hidden">
          {sectionControls}
        </div>

        {/* What the folded card shows in place of its content: what's inside,
            and — while a block is in flight — that dwelling here will open it.
            The section's own name is already in the header above. */}
        {collapsed && (
          <div
            className={cn(
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
                ? t("sectionCard.collapsedDropHint")
                : summary || t("sectionCard.emptyState")}
            </p>
          </div>
        )}

        {/* Folded away with hidden="until-found" rather than unmounted, so the
            browser can still search it — see the effect that sets the
            attribute, which is deliberately not done through JSX. */}
        <div ref={bodyRef} id={bodyId}>
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
                  // A plain number (null for non-questions), so it stays a stable
                  // prop and only the blocks whose numbering actually shifted
                  // re-render when a question is inserted mid-section.
                  questionNumber={questionNumbers.get(block.id) ?? null}
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
        </div>

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
  questionNumber,
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
        questionNumber={questionNumber}
        capitalizedWords={capitalizedWords}
        // The grab handle lives inside the block (in its controls row), so it
        // reads as part of the card rather than a bar above it. Drag must start
        // here so editing fields never drags by accident.
        //
        // Hidden on coarse pointers, because this is HTML5 drag-and-drop:
        // Android Chrome never synthesises drag events from touch, and iOS
        // Safari only does so for a long-press in some cases — so on a phone
        // the handle was a control that mostly did nothing, and `touch-none`
        // meant touching it swallowed the scroll gesture too. The move up/down
        // buttons next to it reorder blocks without a drag, so nothing is lost.
        dragHandle={
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                draggable
                onDragStart={(e) => onDragStart(e, block.id)}
                onDragEnd={onDragEnd}
                role="button"
                aria-label={t("sectionCard.dragHandle.ariaLabel")}
                className="inline-flex cursor-grab touch-none items-center justify-center rounded-md p-0.5 text-muted-foreground transition-colors pointer-coarse:hidden hover:bg-accent hover:text-foreground active:cursor-grabbing active:bg-accent"
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
