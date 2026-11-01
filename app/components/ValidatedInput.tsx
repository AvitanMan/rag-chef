"use client";

import { useId, useState, type InputHTMLAttributes } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string | number;
  onCommit: (value: string) => void;
  validate?: (value: string) => string;
  allowEmpty?: boolean;
};

/** Invalid and intermediate drafts never enter the shared, autosaved kitchen. */
export function ValidatedInput({ value, onCommit, validate, allowEmpty = false, ...props }: Props) {
  const saved = String(value);
  const [edit, setEdit] = useState({ source: saved, draft: saved });
  const id = useId();
  if (edit.source !== saved) {
    setEdit({ source: saved, draft: edit.draft === edit.source || edit.draft === saved ? saved : edit.draft });
  }
  function problem(text: string) {
    if (validate) return validate(text);
    if (props.type !== "number") return "";
    if (!text.trim()) return allowEmpty ? "" : "Enter a number.";
    const number = Number(text), min = Number(props.min ?? 0), max = Number(props.max ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isFinite(number) || number < min || number > max) return `Enter a number from ${min} to ${max}.`;
    const step = Number(props.step ?? 1), steps = (number - min) / step;
    return Number.isFinite(step) && Math.abs(steps - Math.round(steps)) > 0.000001 ? `Use increments of ${step}.` : "";
  }
  const error = problem(edit.draft);
  return <span className="validated-field">
    <input {...props} value={edit.draft} aria-invalid={Boolean(error)} aria-describedby={error ? id : props["aria-describedby"]}
      onChange={(event) => {
        const draft = event.target.value;
        setEdit({ source: saved, draft });
        if (!problem(draft)) onCommit(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); setEdit({ source: saved, draft: saved }); }
        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        props.onKeyDown?.(event);
      }} />
    {error && <small id={id} className="field-error" role="alert">Not saved: {error} Press Escape to restore the saved value.</small>}
  </span>;
}
