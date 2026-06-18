import { useEffect, useRef, useState } from "react";
import TextField from "@mui/material/TextField";

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
export default function LiveTextField({
  value,
  onCommit,
  onFocus,
  onBlur,
  commitDelay = 200,
  ...rest
}) {
  const [local, setLocal] = useState(value ?? "");
  const focusedRef = useRef(false);
  const timerRef = useRef(null);

  // Adopt upstream changes (a remote collaborator's edit, the spelling "fill"
  // button, a fork/import) — but not while we're mid-edit, so the caret never
  // jumps and our own in-flight keystrokes aren't clobbered by the value we just
  // committed echoing back.
  useEffect(() => {
    if (!focusedRef.current) setLocal(value ?? "");
  }, [value]);

  // Flush any pending commit if the field unmounts while focused (e.g. the block
  // is deleted or reordered mid-edit) so the last keystrokes aren't lost.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const commit = (next) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (next !== (value ?? "")) onCommit(next);
  };

  const handleChange = (e) => {
    const next = e.target.value;
    setLocal(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (next !== (value ?? "")) onCommit(next);
    }, commitDelay);
  };

  const handleFocus = (e) => {
    focusedRef.current = true;
    onFocus?.(e);
  };

  const handleBlur = (e) => {
    focusedRef.current = false;
    commit(local);
    onBlur?.(e);
  };

  return (
    <TextField
      {...rest}
      value={local}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
    />
  );
}
