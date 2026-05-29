import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Paper from "@mui/material/Paper";
import Chip from "@mui/material/Chip";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import AddIcon from "@mui/icons-material/Add";
import { fitWithin } from "../lib/image.js";
import { newId } from "../lib/id.js";
import { questionMeta } from "../lib/questions.js";

export default function ContentBlock({
  block,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
}) {
  const controls = (
    <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
      <Tooltip title="Move up">
        <span>
          <IconButton size="small" onClick={onMoveUp} disabled={isFirst}>
            <ArrowUpwardIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Move down">
        <span>
          <IconButton size="small" onClick={onMoveDown} disabled={isLast}>
            <ArrowDownwardIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Delete block">
        <IconButton size="small" color="error" onClick={onDelete}>
          <DeleteOutlineIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  );

  if (block.type === "question") {
    return (
      <QuestionBlock block={block} onChange={onChange} controls={controls} />
    );
  }

  if (block.type === "image") {
    const preview = fitWithin(block.width, block.height, 360);
    return (
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="flex-start"
          spacing={1}
        >
          <Box sx={{ flexGrow: 1 }}>
            <Box
              component="img"
              src={block.src}
              alt={block.caption || "lesson image"}
              sx={{
                display: "block",
                maxWidth: "100%",
                width: preview.width,
                height: "auto",
                borderRadius: 1,
                border: "1px solid",
                borderColor: "divider",
                mb: 1.5,
              }}
            />
            <TextField
              fullWidth
              size="small"
              label="Caption (optional)"
              value={block.caption || ""}
              onChange={(e) => onChange({ ...block, caption: e.target.value })}
            />
          </Box>
          {controls}
        </Stack>
      </Paper>
    );
  }

  // text block
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" alignItems="flex-start" spacing={1}>
        <TextField
          fullWidth
          multiline
          minRows={2}
          placeholder="Type lesson text here…"
          value={block.text || ""}
          onChange={(e) => onChange({ ...block, text: e.target.value })}
        />
        {controls}
      </Stack>
    </Paper>
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
    <Paper
      variant="outlined"
      sx={{ p: 2, borderLeft: `5px solid ${meta.color}` }}
    >
      <Stack direction="row" alignItems="flex-start" spacing={1}>
        <Box sx={{ flexGrow: 1 }}>
          <Chip
            label={meta.label}
            size="small"
            sx={{
              bgcolor: meta.color,
              color: "#fff",
              fontWeight: 600,
              mb: 1.5,
            }}
          />
          <TextField
            fullWidth
            multiline
            minRows={1}
            label="Question"
            placeholder="Type the question…"
            value={block.prompt || ""}
            onChange={(e) => onChange({ ...block, prompt: e.target.value })}
          />

          {block.questionType === "number" && (
            <TextField
              type="number"
              size="small"
              label="Answer"
              value={block.answer ?? ""}
              onChange={(e) => onChange({ ...block, answer: e.target.value })}
              sx={{ mt: 1.5, maxWidth: 200 }}
            />
          )}

          {block.questionType === "single" && (
            <TextField
              fullWidth
              size="small"
              label="Answer"
              placeholder="The correct answer…"
              value={block.answer ?? ""}
              onChange={(e) => onChange({ ...block, answer: e.target.value })}
              sx={{ mt: 1.5 }}
            />
          )}

          {block.questionType === "multiple" && (
            <Stack spacing={1} sx={{ mt: 1.5 }}>
              {answers.map((ans, i) => (
                <Stack
                  key={ans.id}
                  direction="row"
                  alignItems="center"
                  spacing={0.5}
                >
                  <TextField
                    fullWidth
                    size="small"
                    placeholder={`Answer ${i + 1}`}
                    value={ans.text}
                    onChange={(e) => setAnswer(ans.id, e.target.value)}
                  />
                  <Tooltip title="Remove answer">
                    <span>
                      <IconButton
                        size="small"
                        onClick={() => removeAnswer(ans.id)}
                        disabled={answers.length <= 1}
                      >
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                </Stack>
              ))}
              <Box>
                <Button size="small" startIcon={<AddIcon />} onClick={addAnswer}>
                  Add answer
                </Button>
              </Box>
              <Typography variant="caption" color="text.secondary">
                Type every accepted answer.
              </Typography>
            </Stack>
          )}

          {block.questionType === "open" && (
            <TextField
              type="number"
              size="small"
              label="Answer lines"
              value={block.answerLines ?? 3}
              onChange={(e) =>
                onChange({
                  ...block,
                  answerLines: Math.max(0, Number(e.target.value) || 0),
                })
              }
              sx={{ mt: 1.5, maxWidth: 160 }}
              helperText="Blank lines for the response"
            />
          )}

          {block.questionType === "background" && (
            <TextField
              fullWidth
              multiline
              minRows={2}
              label="Background knowledge"
              placeholder="Knowledge the student needs to answer this…"
              value={block.background || ""}
              onChange={(e) =>
                onChange({ ...block, background: e.target.value })
              }
              sx={{ mt: 1.5 }}
            />
          )}
        </Box>
        {controls}
      </Stack>
    </Paper>
  );
}
