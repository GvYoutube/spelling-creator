import { Input } from "./ui/input.jsx";
import { Textarea } from "./ui/textarea.jsx";
import { useLiveField } from "../lib/useLiveField.js";

// shadcn-flavored equivalents of LiveTextField.jsx, sharing the same
// debounce/commit buffering (useLiveField) but composing Input/Textarea
// directly rather than MUI's TextField — MUI's `slotProps`/`variant`/`sx`
// props have no shadcn equivalent, so callers migrated to shadcn use these
// instead. onCommit receives the new string; all other props forward to the
// underlying input/textarea.
export function LiveInput({ value, onCommit, commitDelay = 200, ...rest }) {
  const { local, handleChange, handleFocus, handleBlur } = useLiveField(
    value,
    onCommit,
    commitDelay,
  );

  return (
    <Input
      {...rest}
      value={local}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
    />
  );
}

export function LiveTextarea({ value, onCommit, commitDelay = 200, ...rest }) {
  const { local, handleChange, handleFocus, handleBlur } = useLiveField(
    value,
    onCommit,
    commitDelay,
  );

  return (
    <Textarea
      {...rest}
      value={local}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
    />
  );
}
