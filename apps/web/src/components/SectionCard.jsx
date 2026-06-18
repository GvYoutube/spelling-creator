import { useRef, useState } from "react";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Box from "@mui/material/Box";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import Divider from "@mui/material/Divider";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import ListItemText from "@mui/material/ListItemText";
import TextFieldsIcon from "@mui/icons-material/TextFields";
import ImageIcon from "@mui/icons-material/Image";
import ImageSearchIcon from "@mui/icons-material/ImageSearch";
import QuizIcon from "@mui/icons-material/Quiz";
import SpellcheckIcon from "@mui/icons-material/Spellcheck";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import ContentBlock from "./ContentBlock.jsx";
import AiTextDialog from "./AiTextDialog.jsx";
import AiQuestionDialog from "./AiQuestionDialog.jsx";
import ImageSearchDialog from "./ImageSearchDialog.jsx";
import { newId } from "../lib/id.js";
import { readImageFile } from "../lib/image.js";
import { storeImageBytes } from "../lib/imageRef.js";
import {
  QUESTION_TYPE_LIST,
  createQuestionBlock,
  buildQuestionBlock,
} from "../lib/questions.js";
import { createSpellingBlock } from "../lib/spelling.js";

export default function SectionCard({
  section,
  documentName,
  index,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
  onError,
  capitalizedWords = [],
}) {
  const fileInputRef = useRef(null);
  const [questionMenuAnchor, setQuestionMenuAnchor] = useState(null);
  const [aiMenuAnchor, setAiMenuAnchor] = useState(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiQuestionOpen, setAiQuestionOpen] = useState(false);
  const [imageSearchOpen, setImageSearchOpen] = useState(false);
  // The block this user is currently editing, so the "add block" toolbar can sit
  // directly beneath it (and new blocks insert there). Purely local UI state —
  // deliberately NOT broadcast to collaborators, so each peer's toolbar follows
  // their own cursor, not everyone else's.
  const [activeBlockId, setActiveBlockId] = useState(null);
  // Drag-to-reorder state (all local, never broadcast). `dragId` is the block
  // being dragged; `overId`/`overPos` mark where it would drop so we can draw an
  // insertion line above or below the hovered block.
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const [overPos, setOverPos] = useState(null); // "before" | "after"

  const updateBlocks = (blocks) => onChange({ ...section, blocks });

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
    setQuestionMenuAnchor(null);
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
        onError?.(err.message || "Failed to add image.");
      }
    }
    insertBlocks(newBlocks);
  };

  const onPickImages = (e) => {
    if (e.target.files?.length) handleImageFiles(e.target.files);
    e.target.value = ""; // allow re-selecting the same file
  };

  const addSearchedImage = ({ image, width, height, caption = "" }) => {
    insertBlocks([
      { id: newId(), type: "image", image, width, height, caption },
    ]);
  };

  const updateBlock = (blockId, next) =>
    updateBlocks(section.blocks.map((b) => (b.id === blockId ? next : b)));

  const deleteBlock = (blockId) =>
    updateBlocks(section.blocks.filter((b) => b.id !== blockId));

  const moveBlock = (from, to) => {
    if (to < 0 || to >= section.blocks.length) return;
    const blocks = [...section.blocks];
    const [moved] = blocks.splice(from, 1);
    blocks.splice(to, 0, moved);
    updateBlocks(blocks);
  };

  const clearDrag = () => {
    setDragId(null);
    setOverId(null);
    setOverPos(null);
  };

  // Drag starts from a block's grab handle (not the whole block, so text
  // selection and field editing never trigger a drag). The drag image is the
  // whole block element, and we anchor it to the cursor's real position within
  // the block so the ghost stays exactly under the pointer where it was grabbed
  // (rather than pinned to a fixed top-left offset, which left the cursor
  // floating in a corner of these wide blocks).
  const handleDragStart = (e, block) => {
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
    e.dataTransfer.setData("text/plain", block.id); // Firefox needs some payload
    setDragId(block.id);
  };

  // Hovering a block while dragging: mark whether we'd drop above or below it,
  // based on which half of the block the cursor is over.
  const handleDragOver = (e, block) => {
    if (!dragId || block.id === dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const pos = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    setOverId(block.id);
    setOverPos(pos);
  };

  // Drop onto a block: move the dragged block to just before/after it.
  const handleDrop = (e, block) => {
    if (!dragId || block.id === dragId) return clearDrag();
    e.preventDefault();
    const blocks = [...section.blocks];
    const from = blocks.findIndex((b) => b.id === dragId);
    if (from === -1) return clearDrag();
    const [moved] = blocks.splice(from, 1);
    // Recompute the target index on the array with the dragged block removed.
    let to = blocks.findIndex((b) => b.id === block.id);
    if (to === -1) to = blocks.length;
    else if (overPos === "after") to += 1;
    blocks.splice(to, 0, moved);
    updateBlocks(blocks);
    clearDrag();
  };

  // Where the "add block" toolbar sits: directly under the block being edited,
  // or — when nothing is active (or the active block was deleted/lives in
  // another section) — at the bottom of the section.
  const activeIndex = section.blocks.findIndex((b) => b.id === activeBlockId);

  const addToolbar = (
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
      <Button
        startIcon={<TextFieldsIcon />}
        onClick={addTextBlock}
        variant="outlined"
        size="small"
      >
        Add text
      </Button>
      <Button
        startIcon={<ImageIcon />}
        onClick={() => fileInputRef.current?.click()}
        variant="outlined"
        size="small"
      >
        Add image
      </Button>
      <Button
        startIcon={<ImageSearchIcon />}
        onClick={() => setImageSearchOpen(true)}
        variant="outlined"
        size="small"
      >
        Search images
      </Button>
      <Button
        startIcon={<QuizIcon />}
        onClick={(e) => setQuestionMenuAnchor(e.currentTarget)}
        variant="outlined"
        size="small"
      >
        Add question
      </Button>
      <Button
        startIcon={<SpellcheckIcon />}
        onClick={addSpellingBlock}
        variant="outlined"
        size="small"
      >
        Spelling words
      </Button>
      <Button
        startIcon={<AutoAwesomeIcon />}
        onClick={(e) => setAiMenuAnchor(e.currentTarget)}
        variant="outlined"
        size="small"
      >
        Generate with AI
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={onPickImages}
      />
    </Stack>
  );

  return (
    <Card elevation={2}>
      <CardContent>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
          <Box
            sx={{
              width: 30,
              height: 30,
              borderRadius: "50%",
              bgcolor: "primary.main",
              color: "primary.contrastText",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: 14,
              flexShrink: 0,
            }}
          >
            {index + 1}
          </Box>
          <TextField
            fullWidth
            variant="standard"
            placeholder="Section name"
            value={section.name}
            onChange={(e) => onChange({ ...section, name: e.target.value })}
            slotProps={{
              input: { sx: { fontSize: 20, fontWeight: 600 } },
              htmlInput: { "data-collab-field": `section:${section.id}:name` },
            }}
          />
          <Tooltip title="Move section up">
            <span>
              <IconButton size="small" onClick={onMoveUp} disabled={isFirst}>
                <ArrowUpwardIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Move section down">
            <span>
              <IconButton size="small" onClick={onMoveDown} disabled={isLast}>
                <ArrowDownwardIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Delete section">
            <IconButton size="small" color="error" onClick={onDelete}>
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>

        <Divider sx={{ mb: 2 }} />

        {section.blocks.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            No content yet. Add a text block or an image below.
          </Typography>
        ) : (
          <Stack spacing={1.5} sx={{ mb: 2 }}>
            {section.blocks.map((block, i) => [
              // Focusing any field inside a block makes it the active block, so
              // the toolbar follows the user's edit point. onFocus bubbles from
              // the inner inputs. The same wrapper is the drop target while a
              // block is being dragged.
              <Box
                key={block.id}
                data-block-id={block.id}
                onFocus={() => setActiveBlockId(block.id)}
                onDragOver={(e) => handleDragOver(e, block)}
                onDrop={(e) => handleDrop(e, block)}
                sx={{
                  position: "relative",
                  borderRadius: 1,
                  transition:
                    "opacity 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease",
                  // The block being dragged collapses to a faint, dashed
                  // placeholder so the gap it leaves behind reads as "this is
                  // moving" rather than just dimming in place.
                  ...(dragId === block.id && {
                    opacity: 0.5,
                    transform: "scale(0.99)",
                    outline: "2px dashed",
                    outlineColor: "primary.light",
                    outlineOffset: 2,
                    "& > *": { boxShadow: "none" },
                  }),
                  // A rounded insertion bar sits above/below the hovered block
                  // (via ::before / ::after), fading in only on the side the
                  // drop would land, marking exactly where the block goes.
                  "&::before, &::after": {
                    content: '""',
                    position: "absolute",
                    left: 0,
                    right: 0,
                    height: 4,
                    borderRadius: 2,
                    bgcolor: "primary.main",
                    transition: "opacity 0.1s ease",
                    pointerEvents: "none",
                  },
                  "&::before": {
                    top: -5,
                    opacity:
                      overId === block.id && overPos === "before" ? 1 : 0,
                  },
                  "&::after": {
                    bottom: -5,
                    opacity: overId === block.id && overPos === "after" ? 1 : 0,
                  },
                }}
              >
                <ContentBlock
                  block={block}
                  onChange={(next) => updateBlock(block.id, next)}
                  onDelete={() => deleteBlock(block.id)}
                  onMoveUp={() => moveBlock(i, i - 1)}
                  onMoveDown={() => moveBlock(i, i + 1)}
                  isFirst={i === 0}
                  isLast={i === section.blocks.length - 1}
                  capitalizedWords={capitalizedWords}
                  // The grab handle lives inside the block (in its controls row),
                  // so it reads as part of the card rather than a bar above it.
                  // Drag must start here so editing fields never drags by accident.
                  dragHandle={
                    <Tooltip title="Drag to reorder">
                      <Box
                        component="span"
                        draggable
                        onDragStart={(e) => handleDragStart(e, block)}
                        onDragEnd={clearDrag}
                        role="button"
                        aria-label="Drag to reorder block"
                        sx={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          borderRadius: 1,
                          p: 0.25,
                          color: "text.disabled",
                          cursor: "grab",
                          touchAction: "none",
                          transition:
                            "color 0.12s ease, background-color 0.12s ease",
                          "&:active": {
                            cursor: "grabbing",
                            bgcolor: "action.selected",
                          },
                          "&:hover": {
                            color: "text.primary",
                            bgcolor: "action.hover",
                          },
                        }}
                      >
                        <DragIndicatorIcon fontSize="small" />
                      </Box>
                    </Tooltip>
                  }
                />
              </Box>,
              // The toolbar sits directly beneath the block being edited.
              i === activeIndex ? (
                <Box key={`${block.id}-toolbar`}>{addToolbar}</Box>
              ) : null,
            ])}
          </Stack>
        )}

        {/* When no block in this section is active, the toolbar stays at the
            bottom (its original home). */}
        {activeIndex === -1 && addToolbar}

        <Menu
          anchorEl={questionMenuAnchor}
          open={Boolean(questionMenuAnchor)}
          onClose={() => setQuestionMenuAnchor(null)}
        >
          {QUESTION_TYPE_LIST.map((q) => (
            <MenuItem key={q.key} onClick={() => addQuestionBlock(q.key)}>
              <Box
                sx={{
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  bgcolor: q.color,
                  mr: 1.5,
                  flexShrink: 0,
                }}
              />
              <ListItemText primary={q.label} secondary={q.description} />
            </MenuItem>
          ))}
        </Menu>

        <Menu
          anchorEl={aiMenuAnchor}
          open={Boolean(aiMenuAnchor)}
          onClose={() => setAiMenuAnchor(null)}
        >
          <MenuItem
            onClick={() => {
              setAiMenuAnchor(null);
              setAiOpen(true);
            }}
          >
            <ListItemText
              primary="Text"
              secondary="Generate a text block with AI"
            />
          </MenuItem>
          <MenuItem
            onClick={() => {
              setAiMenuAnchor(null);
              setAiQuestionOpen(true);
            }}
          >
            <ListItemText
              primary="Question"
              secondary="Generate a question with AI"
            />
          </MenuItem>
        </Menu>

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
          onInsert={addSearchedImage}
          onClose={() => setImageSearchOpen(false)}
        />
      </CardContent>
    </Card>
  );
}
