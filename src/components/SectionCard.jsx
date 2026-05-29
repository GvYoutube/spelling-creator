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
import QuizIcon from "@mui/icons-material/Quiz";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ContentBlock from "./ContentBlock.jsx";
import AiTextDialog from "./AiTextDialog.jsx";
import { newId } from "../lib/id.js";
import { readImageFile } from "../lib/image.js";
import { QUESTION_TYPE_LIST, createQuestionBlock } from "../lib/questions.js";

export default function SectionCard({
  section,
  index,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
  onError,
}) {
  const fileInputRef = useRef(null);
  const [questionMenuAnchor, setQuestionMenuAnchor] = useState(null);
  const [aiOpen, setAiOpen] = useState(false);

  const updateBlocks = (blocks) => onChange({ ...section, blocks });

  const addTextBlock = () => {
    updateBlocks([...section.blocks, { id: newId(), type: "text", text: "" }]);
  };

  const addSuggestedTextBlock = (text) => {
    updateBlocks([...section.blocks, { id: newId(), type: "text", text }]);
  };

  const addQuestionBlock = (questionType) => {
    setQuestionMenuAnchor(null);
    updateBlocks([...section.blocks, createQuestionBlock(newId, questionType)]);
  };

  const handleImageFiles = async (files) => {
    const newBlocks = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      try {
        const img = await readImageFile(file);
        newBlocks.push({
          id: newId(),
          type: "image",
          src: img.src,
          width: img.width,
          height: img.height,
          caption: "",
        });
      } catch (err) {
        onError?.(err.message || "Failed to add image.");
      }
    }
    if (newBlocks.length) updateBlocks([...section.blocks, ...newBlocks]);
  };

  const onPickImages = (e) => {
    if (e.target.files?.length) handleImageFiles(e.target.files);
    e.target.value = ""; // allow re-selecting the same file
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
            slotProps={{ input: { sx: { fontSize: 20, fontWeight: 600 } } }}
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
            {section.blocks.map((block, i) => (
              <ContentBlock
                key={block.id}
                block={block}
                onChange={(next) => updateBlock(block.id, next)}
                onDelete={() => deleteBlock(block.id)}
                onMoveUp={() => moveBlock(i, i - 1)}
                onMoveDown={() => moveBlock(i, i + 1)}
                isFirst={i === 0}
                isLast={i === section.blocks.length - 1}
              />
            ))}
          </Stack>
        )}

        <Stack direction="row" spacing={1}>
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
            startIcon={<QuizIcon />}
            onClick={(e) => setQuestionMenuAnchor(e.currentTarget)}
            variant="outlined"
            size="small"
          >
            Add question
          </Button>
          <Button
            startIcon={<AutoAwesomeIcon />}
            onClick={() => setAiOpen(true)}
            variant="outlined"
            size="small"
          >
            AI text
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

        <AiTextDialog
          open={aiOpen}
          defaultSubject={section.name}
          onInsert={addSuggestedTextBlock}
          onClose={() => setAiOpen(false)}
        />
      </CardContent>
    </Card>
  );
}
