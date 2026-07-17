import { useEffect, useRef, useState } from "react";

// Shared debounce/commit logic behind LiveTextField (MUI) and the shadcn
// LiveInput/LiveTextarea — see the note in LiveTextField.jsx for why this
// buffering exists at all. Returns the value the input should display plus
// change/focus/blur handlers; callers wire those onto whatever input element
// they're using.
export function useLiveField(value, onCommit, commitDelay = 200) {
  const [local, setLocal] = useState(value ?? "");
  const focusedRef = useRef(false);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!focusedRef.current) setLocal(value ?? "");
  }, [value]);

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

  const handleFocus = () => {
    focusedRef.current = true;
  };

  const handleBlur = () => {
    focusedRef.current = false;
    commit(local);
  };

  return { local, handleChange, handleFocus, handleBlur };
}
