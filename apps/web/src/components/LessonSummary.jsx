// "Summarise this lesson" card on the lesson page, powered by the browser's
// built-in Summarizer API (see lib/summarizer.js). The model runs on the reader's
// own device: no Worker call, no Turnstile, no cost, and the lesson text never
// leaves the machine.
//
// The API is Chromium-only and gated behind hardware minimums, so the card is
// strictly opt-in on capability: we probe availability once on mount and render
// NOTHING — no button, no "unsupported" notice — unless the browser can actually
// run it. A reader on Firefox or an old laptop never learns the feature exists,
// which is better than showing them a button that can't work.
//
// Creating a session needs transient activation, so summarising is always driven
// by the button click, never by an effect.

import { useEffect, useMemo, useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import CheckIcon from "@mui/icons-material/Check";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { SummarySkeleton } from "./Skeletons.jsx";
import {
  DEFAULT_SUMMARY_LENGTH,
  DEFAULT_SUMMARY_TYPE,
  MIN_SUMMARY_CHARS,
  SUMMARY_LENGTHS,
  SUMMARY_TYPES,
  createSummarizer,
  fitToQuota,
  lessonSummaryText,
  summarizeStream,
  summarizerAvailability,
  summarizerErrorMessage,
} from "../lib/summarizer.js";

// Bold/italic runs inside one line of the model's markdown.
const INLINE_MARKDOWN = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;

function renderInline(text) {
  const nodes = [];
  let last = 0;
  let match;
  INLINE_MARKDOWN.lastIndex = 0;
  while ((match = INLINE_MARKDOWN.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1]) nodes.push(<strong key={match.index}>{match[1]}</strong>);
    else nodes.push(<em key={match.index}>{match[2]}</em>);
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// The summary is requested as markdown, and "key points" comes back as a bullet
// list. Rather than pull in a markdown library for the handful of constructs a
// summary can contain, render the subset we actually get — bullets, headings,
// paragraphs, bold/italic — and let anything else fall through as plain text. That
// also means a model that ignores `format` and returns plain prose still renders
// correctly.
function SummaryMarkdown({ text }) {
  const nodes = [];
  let bullets = [];

  const flushBullets = () => {
    if (!bullets.length) return;
    const items = bullets;
    bullets = [];
    nodes.push(
      <Box
        key={`ul-${nodes.length}`}
        component="ul"
        sx={{ pl: 3, my: 0.5, "& li": { mb: 0.5 } }}
      >
        {items.map((item, i) => (
          <Typography component="li" variant="body2" key={i}>
            {renderInline(item)}
          </Typography>
        ))}
      </Box>,
    );
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      flushBullets();
      continue;
    }

    const bullet = line.match(/^[-*•]\s+(.*)$/);
    if (bullet) {
      bullets.push(bullet[1]);
      continue;
    }

    flushBullets();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    nodes.push(
      heading ? (
        <Typography
          key={nodes.length}
          variant="subtitle2"
          sx={{ mt: 1, mb: 0.5 }}
        >
          {renderInline(heading[1])}
        </Typography>
      ) : (
        <Typography key={nodes.length} variant="body2" sx={{ mb: 1 }}>
          {renderInline(line)}
        </Typography>
      ),
    );
  }
  flushBullets();

  return nodes;
}

export default function LessonSummary({ doc }) {
  const [type, setType] = useState(DEFAULT_SUMMARY_TYPE);
  const [length, setLength] = useState(DEFAULT_SUMMARY_LENGTH);

  // Starts "unavailable" so the card is hidden until the probe says otherwise —
  // it fades in when supported rather than flashing in and disappearing when not.
  const [availability, setAvailability] = useState("unavailable");

  // "idle" → "downloading" (first run only) → "summarizing" → "done".
  const [phase, setPhase] = useState("idle");
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const abortRef = useRef(null);
  const sessionRef = useRef(null);

  const text = useMemo(() => lessonSummaryText(doc), [doc]);
  const worthSummarizing = text.length >= MIN_SUMMARY_CHARS;

  // Probe once, with the default options. Availability turns on the browser and
  // its hardware, not on the type/length the reader picks, so re-probing on every
  // dropdown change would only risk yanking the card out from under them; if a
  // particular combination really is unsupported, create() throws and we say so.
  useEffect(() => {
    if (!worthSummarizing) return;
    let cancelled = false;
    (async () => {
      const state = await summarizerAvailability({
        type: DEFAULT_SUMMARY_TYPE,
        length: DEFAULT_SUMMARY_LENGTH,
      });
      if (!cancelled) setAvailability(state);
    })();
    return () => {
      cancelled = true;
    };
  }, [worthSummarizing]);

  // Drop any in-flight run and free the model session when we leave the page.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      sessionRef.current?.destroy();
    },
    [],
  );

  const running = phase === "downloading" || phase === "summarizing";

  const summarize = async () => {
    // Supersede whatever was running, and free the previous session — each run
    // gets a session built for its own type/length.
    abortRef.current?.abort();
    sessionRef.current?.destroy();
    sessionRef.current = null;

    const controller = new AbortController();
    abortRef.current = controller;

    setError("");
    setSummary("");
    setTruncated(false);
    setProgress(0);
    // A first run on a machine that hasn't got the model yet downloads it; say so
    // up front, because that wait is much longer than the summary itself.
    setPhase(availability === "available" ? "summarizing" : "downloading");

    try {
      const session = await createSummarizer(
        { type, length },
        {
          signal: controller.signal,
          onDownloadProgress: (loaded) => setProgress(loaded),
        },
      );
      if (controller.signal.aborted) {
        session.destroy();
        return;
      }
      sessionRef.current = session;
      setPhase("summarizing");

      // A long lesson can overrun the model's input budget; trim it rather than
      // fail, and tell the reader below when we did.
      const { text: input, truncated: wasCut } = await fitToQuota(
        session,
        text,
      );
      if (controller.signal.aborted) return;
      setTruncated(wasCut);

      let out = "";
      for await (const chunk of summarizeStream(session, input, {
        signal: controller.signal,
      })) {
        out += chunk;
        setSummary(out);
      }
      if (controller.signal.aborted) return;
      setPhase("done");
      // The model is downloaded now, so a re-run goes straight to summarising.
      setAvailability("available");
    } catch (err) {
      // An abort is us superseding or unmounting the run, not a failure.
      if (controller.signal.aborted || err?.name === "AbortError") return;
      setError(summarizerErrorMessage(err));
      setPhase("idle");
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    setPhase("idle");
  };

  // Changing the shape of the summary invalidates the one on screen, so clear it
  // and let the reader ask again — the button is also what gives us the transient
  // activation the next create() needs.
  const changeOption = (setter) => (event) => {
    abortRef.current?.abort();
    setter(event.target.value);
    setSummary("");
    setError("");
    setPhase("idle");
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the text is selectable on screen anyway */
    }
  };

  if (!worthSummarizing || availability === "unavailable") return null;

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={1}
        alignItems={{ xs: "stretch", sm: "center" }}
        sx={{ mb: summary || running || error ? 1.5 : 0 }}
      >
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ flexGrow: 1, minWidth: 0 }}
        >
          <AutoAwesomeIcon fontSize="small" color="primary" />
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            Summary
          </Typography>
          <Chip size="small" variant="outlined" label="On-device AI" />
        </Stack>

        <TextField
          select
          size="small"
          label="Style"
          value={type}
          onChange={changeOption(setType)}
          disabled={running}
          sx={{ minWidth: 130 }}
        >
          {SUMMARY_TYPES.map((option) => (
            <MenuItem key={option.value} value={option.value}>
              {option.label}
            </MenuItem>
          ))}
        </TextField>

        <TextField
          select
          size="small"
          label="Length"
          value={length}
          onChange={changeOption(setLength)}
          disabled={running}
          sx={{ minWidth: 110 }}
        >
          {SUMMARY_LENGTHS.map((option) => (
            <MenuItem key={option.value} value={option.value}>
              {option.label}
            </MenuItem>
          ))}
        </TextField>

        {running ? (
          <Button onClick={cancel} color="inherit">
            Cancel
          </Button>
        ) : (
          <Button
            variant="contained"
            startIcon={<AutoAwesomeIcon />}
            onClick={summarize}
          >
            {summary ? "Regenerate" : "Summarise"}
          </Button>
        )}
      </Stack>

      {/* First run on this device: the model has to be fetched before it can
          summarise. `loaded` is a 0–1 fraction, so show real progress. */}
      {phase === "downloading" && (
        <Box sx={{ mb: 1.5 }}>
          <Typography variant="caption" color="text.secondary">
            Downloading the on-device model (one time)…{" "}
            {Math.round(progress * 100)}%
          </Typography>
          <LinearProgress
            variant={progress > 0 ? "determinate" : "indeterminate"}
            value={progress * 100}
            sx={{ mt: 0.5, borderRadius: 1 }}
          />
        </Box>
      )}

      {/* Between the click and the model's first chunk. Once chunks arrive we
          render them as they stream, so the skeleton only covers the gap. */}
      {phase === "summarizing" && !summary && <SummarySkeleton />}

      {summary && <SummaryMarkdown text={summary} />}

      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}

      {(summary || truncated) && phase !== "summarizing" && (
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ mt: 1, pt: 1, borderTop: 1, borderColor: "divider" }}
        >
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ flexGrow: 1 }}
          >
            {truncated
              ? "Summarised the first part of this lesson (it's too long for the on-device model) — AI summaries can be wrong."
              : "Generated on your device by your browser's built-in AI — it can be wrong. Read the lesson before using it."}
          </Typography>
          {summary && (
            <Tooltip title={copied ? "Copied" : "Copy summary"}>
              <IconButton size="small" onClick={copy} aria-label="copy summary">
                {copied ? (
                  <CheckIcon fontSize="small" color="success" />
                ) : (
                  <ContentCopyIcon fontSize="small" />
                )}
              </IconButton>
            </Tooltip>
          )}
        </Stack>
      )}

      {/* Nothing generated yet, and the model isn't on this machine — warn before
          the click, not after it starts a large download. */}
      {phase === "idle" &&
        !summary &&
        !error &&
        availability !== "available" && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", mt: 1 }}
          >
            The first summary downloads your browser’s on-device model, which
            can take a while. Nothing is sent to a server.
          </Typography>
        )}
    </Paper>
  );
}
