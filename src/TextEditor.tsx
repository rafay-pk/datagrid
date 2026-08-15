import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { blocksFromHtml, normalizeUrl } from "./textFormat";
import type { TextBlock } from "./types";
import { BoldIcon, BulletListIcon, ChecklistIcon, ItalicIcon, NumberedListIcon, UnderlineIcon } from "./icons";

interface TextEditorProps {
  html: string;
  onChange: (html: string, blocks: TextBlock[]) => void;
  onFocus: () => void;
  onActiveChange?: (active: boolean) => void;
  onMeasure: (metrics: {
    scrollHeight: number;
    clientHeight: number;
    maxLineLength: number;
    lineCount: number;
  }) => void;
}

function selectionBlock(): HTMLElement | null {
  const selection = window.getSelection();
  let node = selection?.anchorNode ?? null;
  if (node?.nodeType === Node.TEXT_NODE) node = node.parentNode;
  return node instanceof HTMLElement ? node.closest("div, p, h2, li") : null;
}

function placeCursorAtEnd(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function splitListItemAtSelection(listItem: HTMLLIElement, isChecklist: boolean): void {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;

  const activeRange = selection.getRangeAt(0);
  if (!activeRange.collapsed) activeRange.deleteContents();

  const trailingRange = document.createRange();
  trailingRange.setStart(activeRange.startContainer, activeRange.startOffset);
  trailingRange.setEnd(listItem, listItem.childNodes.length);
  const trailingContent = trailingRange.extractContents();
  trailingContent.querySelectorAll(".checklist-marker").forEach((marker) => marker.remove());

  const nextItem = isChecklist ? createChecklistItem() : document.createElement("li");
  if (isChecklist) nextItem.lastChild?.remove();
  nextItem.appendChild(trailingContent);
  if (!nextItem.textContent && !nextItem.querySelector("img, br")) nextItem.appendChild(document.createElement("br"));
  if (!listItem.textContent && !listItem.querySelector("img, br")) listItem.appendChild(document.createElement("br"));
  listItem.insertAdjacentElement("afterend", nextItem);

  const cursorRange = document.createRange();
  const marker = isChecklist ? nextItem.querySelector(".checklist-marker") : null;
  if (marker) cursorRange.setStartAfter(marker);
  else cursorRange.selectNodeContents(nextItem);
  cursorRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(cursorRange);
}

function createChecklistMarker(): HTMLSpanElement {
  const marker = document.createElement("span");
  marker.className = "checklist-marker";
  marker.setAttribute("contenteditable", "false");
  return marker;
}

function createChecklistItem(): HTMLLIElement {
  const item = document.createElement("li");
  item.dataset.checked = "false";
  item.appendChild(createChecklistMarker());
  item.appendChild(document.createElement("br"));
  return item;
}

function maybeTransformMarker(editor: HTMLElement): void {
  let block = selectionBlock();
  if (!block || !editor.contains(block)) return;
  if (block === editor) {
    const wrapper = document.createElement("div");
    while (editor.firstChild) wrapper.appendChild(editor.firstChild);
    editor.appendChild(wrapper);
    block = wrapper;
    placeCursorAtEnd(block);
  }
  const text = (block.textContent ?? "").replace(/\u00a0/g, " ");
  if (text === "# ") {
    const heading = document.createElement("h2");
    heading.innerHTML = "<br>";
    block.replaceWith(heading);
    placeCursorAtEnd(heading);
  } else if (text === "- ") {
    const list = document.createElement("ul");
    const item = document.createElement("li");
    item.innerHTML = "<br>";
    list.appendChild(item);
    block.replaceWith(list);
    placeCursorAtEnd(item);
  } else if (text === "1. ") {
    const list = document.createElement("ol");
    const item = document.createElement("li");
    item.innerHTML = "<br>";
    list.appendChild(item);
    block.replaceWith(list);
    placeCursorAtEnd(item);
  } else if (text === "[] " || text === "[ ] ") {
    const list = document.createElement("ul");
    list.className = "checklist";
    const item = createChecklistItem();
    list.appendChild(item);
    block.replaceWith(list);
    placeCursorAtEnd(item);
  }
}

function toggleChecklist(editor: HTMLElement): void {
  let block = selectionBlock();
  if (!block || !editor.contains(block)) return;

  const currentList = block.closest("ul, ol");
  if (currentList?.classList.contains("checklist")) {
    block.closest("li")?.querySelector(".checklist-marker")?.remove();
    document.execCommand("insertUnorderedList");
    return;
  }
  if (currentList) document.execCommand(currentList.tagName === "OL" ? "insertOrderedList" : "insertUnorderedList");
  document.execCommand("insertUnorderedList");

  block = selectionBlock();
  const list = block?.closest("ul");
  if (!list) return;
  list.classList.add("checklist");
  for (const item of Array.from(list.children)) {
    if (item instanceof HTMLLIElement && !item.querySelector(".checklist-marker")) {
      item.dataset.checked = item.dataset.checked ?? "false";
      item.insertBefore(createChecklistMarker(), item.firstChild);
    }
  }
}

function sanitizeClipboardHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const allowed = new Set(["DIV", "P", "BR", "STRONG", "B", "EM", "I", "U", "A", "UL", "OL", "LI", "H1", "H2"]);
  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    if (!allowed.has(element.tagName)) {
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      if (!(element.tagName === "A" && attribute.name.toLowerCase() === "href")) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  return template.innerHTML;
}

export function TextEditor({ html, onChange, onFocus, onActiveChange, onMeasure }: TextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const measureFrameRef = useRef<number | null>(null);
  const [toolbarVisible, setToolbarVisible] = useState(false);
  const [activeFormats, setActiveFormats] = useState({ heading: false, bold: false, italic: false, underline: false });

  const syncActiveFormats = () => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    if (!editor || !anchor || (anchor !== editor && !editor.contains(anchor))) return;
    const block = selectionBlock();
    setActiveFormats({
      heading: block?.tagName === "H2",
      bold: document.queryCommandState("bold"),
      italic: document.queryCommandState("italic"),
      underline: document.queryCommandState("underline"),
    });
  };

  const measure = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const lines = editor.innerText.replace(/\u00a0/g, " ").split(/\r?\n/);
    const previousHeight = editor.style.height;
    editor.style.height = "0px";
    const contentHeight = editor.scrollHeight;
    editor.style.height = previousHeight;
    onMeasure({
      scrollHeight: contentHeight,
      clientHeight: editor.clientHeight,
      maxLineLength: Math.max(0, ...lines.map((line) => line.length)),
      lineCount: lines.length,
    });
  };

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.innerHTML !== html && document.activeElement !== editor) {
      editor.innerHTML = html;
    }
  }, [html]);

  useEffect(() => () => {
    if (measureFrameRef.current !== null) cancelAnimationFrame(measureFrameRef.current);
  }, []);

  useEffect(() => {
    document.addEventListener("selectionchange", syncActiveFormats);
    return () => document.removeEventListener("selectionchange", syncActiveFormats);
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [html]);

  const emitChange = () => {
    const editor = editorRef.current;
    if (!editor) return;
    maybeTransformMarker(editor);
    onChange(editor.innerHTML, blocksFromHtml(editor.innerHTML));
    if (measureFrameRef.current !== null) cancelAnimationFrame(measureFrameRef.current);
    measureFrameRef.current = requestAnimationFrame(() => {
      measureFrameRef.current = null;
      measure();
    });
  };

  const runCommand = (command: string) => {
    editorRef.current?.focus({ preventScroll: true });
    document.execCommand(command);
    emitChange();
    syncActiveFormats();
  };

  const runChecklistToggle = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus({ preventScroll: true });
    toggleChecklist(editor);
    emitChange();
  };

  const runHeadingToggle = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus({ preventScroll: true });
    const block = selectionBlock();
    document.execCommand("formatBlock", false, block?.tagName === "H2" ? "div" : "h2");
    emitChange();
    syncActiveFormats();
  };

  return (
    <>
      {toolbarVisible && (
        <div className="text-toolbar" role="toolbar" aria-label="Text formatting" onMouseDown={(event) => event.preventDefault()}>
          <button type="button" className={activeFormats.heading ? "active" : ""} aria-label="Heading" aria-pressed={activeFormats.heading} title="Heading (# )" onClick={runHeadingToggle}><span className="text-toolbar-glyph" aria-hidden="true">#</span></button>
          <span className="text-toolbar-divider"/>
          <button type="button" className={activeFormats.bold ? "active" : ""} aria-pressed={activeFormats.bold} title="Bold (Ctrl+B)" onClick={() => runCommand("bold")}><BoldIcon size={14}/></button>
          <button type="button" className={activeFormats.italic ? "active" : ""} aria-pressed={activeFormats.italic} title="Italic (Ctrl+I)" onClick={() => runCommand("italic")}><ItalicIcon size={14}/></button>
          <button type="button" className={activeFormats.underline ? "active" : ""} aria-pressed={activeFormats.underline} title="Underline (Ctrl+U)" onClick={() => runCommand("underline")}><UnderlineIcon size={14}/></button>
          <span className="text-toolbar-divider"/>
          <button type="button" title="Bulleted list" onClick={() => runCommand("insertUnorderedList")}><BulletListIcon size={14}/></button>
          <button type="button" title="Numbered list" onClick={() => runCommand("insertOrderedList")}><NumberedListIcon size={14}/></button>
          <button type="button" title="Checklist" onClick={runChecklistToggle}><ChecklistIcon size={14}/></button>
        </div>
      )}
      <div
        ref={editorRef}
        className="text-editor"
        contentEditable
        role="textbox"
        tabIndex={0}
        suppressContentEditableWarning
        data-placeholder="Write something…"
        spellCheck
        onFocus={() => { setToolbarVisible(true); onActiveChange?.(true); onFocus(); requestAnimationFrame(syncActiveFormats); }}
        onBlur={() => { setToolbarVisible(false); onActiveChange?.(false); }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          editorRef.current?.focus({ preventScroll: true });
          onFocus();
        }}
        onInput={() => { emitChange(); syncActiveFormats(); }}
        onKeyUp={syncActiveFormats}
        onMouseUp={syncActiveFormats}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && ["b", "i", "u"].includes(event.key.toLowerCase())) {
            event.preventDefault();
            const commands = { b: "bold", i: "italic", u: "underline" } as const;
            document.execCommand(commands[event.key.toLowerCase() as keyof typeof commands]);
            emitChange();
            syncActiveFormats();
            return;
          }
          if (event.key === "Tab" && !(event.ctrlKey || event.metaKey) && selectionBlock()?.closest("li")) {
            event.preventDefault();
            document.execCommand(event.shiftKey ? "outdent" : "indent");
            emitChange();
          }
          if (event.key === "Enter") {
            const block = selectionBlock();
            const listItem = block?.closest("li");
            if (listItem) {
              event.preventDefault();
              const isChecklist = Boolean(listItem.closest("ul")?.classList.contains("checklist"));
              if (!(listItem.textContent ?? "").trim()) {
                const paragraph = document.createElement("div");
                paragraph.innerHTML = "<br>";
                listItem.closest("ul, ol")!.insertAdjacentElement("afterend", paragraph);
                listItem.remove();
                placeCursorAtEnd(paragraph);
              } else {
                splitListItemAtSelection(listItem, isChecklist);
              }
              emitChange();
              return;
            }
            if (block?.closest("h2")) {
              event.preventDefault();
              const paragraph = document.createElement("div");
              paragraph.innerHTML = "<br>";
              block.closest("h2")!.insertAdjacentElement("afterend", paragraph);
              placeCursorAtEnd(paragraph);
              emitChange();
            }
          }
        }}
        onPaste={(event) => {
          event.stopPropagation();
          const text = event.clipboardData.getData("text/plain");
          const url = normalizeUrl(text);
          event.preventDefault();
          if (url) {
            document.execCommand(
              "insertHTML",
              false,
              `<a href="${url.replace(/"/g, "&quot;")}" target="_blank" rel="noreferrer">${text}</a>`,
            );
          } else {
            const rich = event.clipboardData.getData("text/html");
            if (rich) document.execCommand("insertHTML", false, sanitizeClipboardHtml(rich));
            else document.execCommand("insertText", false, text);
          }
          emitChange();
        }}
        onClick={(event) => {
          const marker = (event.target as HTMLElement).closest(".checklist-marker");
          if (marker) {
            const item = marker.closest("li");
            if (item instanceof HTMLElement) {
              item.dataset.checked = item.dataset.checked === "true" ? "false" : "true";
              emitChange();
            }
            return;
          }
          if (
            event.target instanceof HTMLAnchorElement &&
            (event.ctrlKey || event.metaKey)
          ) {
            event.preventDefault();
            window.open(event.target.href, "_blank", "noopener,noreferrer");
          }
        }}
      />
    </>
  );
}
