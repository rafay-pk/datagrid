import { useEffect, useRef, useState } from "react";

interface ImageCardLabelProps {
  label: string;
  editing: boolean;
  onEdit: () => void;
  onCommit: (label: string) => void;
  onDone: () => void;
}

export function ImageCardLabel({ label, editing, onEdit, onCommit, onDone }: ImageCardLabelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(false);
  const [draft, setDraft] = useState(label);

  useEffect(() => {
    if (!editing) setDraft(label);
  }, [editing, label]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    if (editing) {
      input.focus({ preventScroll: true });
      const end = input.value.length;
      input.setSelectionRange(end, end);
    } else {
      input.setSelectionRange(0, 0);
      if (document.activeElement === input) input.blur();
    }
  }, [editing]);

  const finishEditing = () => {
    if (cancelRef.current) {
      cancelRef.current = false;
      setDraft(label);
    } else {
      const next = draft.trim();
      setDraft(next);
      if (next !== label) onCommit(next);
    }
    onDone();
  };

  return (
    <input
      ref={inputRef}
      className={`image-label${editing ? " is-editing" : ""}`}
      aria-label="Image label"
      title={editing ? "Press Enter to finish or Escape to cancel" : "Click to edit image label"}
      value={draft}
      placeholder="Add label"
      maxLength={120}
      readOnly={!editing}
      tabIndex={editing ? 0 : -1}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (!editing) onEdit();
      }}
      onFocus={() => {
        if (!editing) onEdit();
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => {
        event.currentTarget.setSelectionRange(0, 0);
        finishEditing();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelRef.current = true;
          event.currentTarget.blur();
        }
      }}
    />
  );
}
