import { Input } from "./ui/input.jsx";
import { Textarea } from "./ui/textarea.jsx";
import { useLiveField } from "../lib/useLiveField.js";

// Debounced/committed text fields built on the shared useLiveField buffering
// (see that file) and shadcn's Input/Textarea. onCommit receives the new
// string; all other props forward to the underlying input/textarea.
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
