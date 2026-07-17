import TextField from "@mui/material/TextField";
import { useLiveField } from "../lib/useLiveField.js";

// A controlled MUI TextField that keeps the value it's displaying in *local*
// state while the user is typing, and only commits up to the parent (via
// onCommit) once typing pauses or the field loses focus.
//
// Why: the editor's whole document lives in one React state object. If every
// keystroke wrote straight to that object, the entire EditorPage tree would
// re-render per character — fine on a small lesson, janky on a large one and on
// low-end machines. By buffering keystrokes here, typing re-renders only this
// one input; the lesson document (and therefore the editor shell, the section
// list, autosave and the collaboration broadcast) updates at most a few times a
// second instead of once per character.
//
// onCommit receives the new string. All other props are forwarded to TextField,
// so callers keep using `slotProps`, `multiline`, `label`, etc. as before.
//
// This MUI-backed component still has two callers not yet migrated to
// shadcn (SectionCard.jsx, EditorPage.jsx). Migrated callers use the
// shadcn-flavored LiveInput/LiveTextarea below instead, which share the same
// buffering logic via useLiveField.
export default function LiveTextField({
  value,
  onCommit,
  onFocus,
  onBlur,
  commitDelay = 200,
  ...rest
}) {
  const { local, handleChange, handleFocus, handleBlur } = useLiveField(
    value,
    onCommit,
    commitDelay,
  );

  return (
    <TextField
      {...rest}
      value={local}
      onChange={handleChange}
      onFocus={(e) => {
        handleFocus();
        onFocus?.(e);
      }}
      onBlur={(e) => {
        handleBlur();
        onBlur?.(e);
      }}
    />
  );
}
