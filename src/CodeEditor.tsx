import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { CodeIcon } from "./icons";
import { trimTrailingEmptyLines } from "./textFormat";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

const LANGUAGE_OPTIONS = [
  ["plaintext", "Plain text"],
  ["javascript", "JavaScript / JSX"],
  ["typescript", "TypeScript / TSX"],
  ["python", "Python"],
  ["rust", "Rust"],
  ["java", "Java"],
  ["csharp", "C#"],
  ["cpp", "C / C++"],
  ["css", "CSS"],
  ["xml", "HTML / XML"],
  ["json", "JSON"],
  ["bash", "Shell"],
  ["sql", "SQL"],
  ["markdown", "Markdown"],
  ["yaml", "YAML"],
] as const;

const AUTO_LANGUAGES = LANGUAGE_OPTIONS
  .map(([value]) => value)
  .filter((value) => value !== "plaintext");

interface CodeEditorProps {
  code: string;
  language: string;
  onChange: (code: string) => void;
  onLanguageChange: (language: string) => void;
  onFocus: () => void;
  onActiveChange?: (active: boolean) => void;
  onMeasure: (metrics: {
    contentWidth: number;
    contentHeight: number;
  }) => void;
}

export function CodeEditor({
  code,
  language,
  onChange,
  onLanguageChange,
  onFocus,
  onActiveChange,
  onMeasure,
}: CodeEditorProps) {
  const highlightRef = useRef<HTMLElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const measureFrameRef = useRef<number | null>(null);
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;
  const highlighted = useMemo(() => {
    if (language === "auto") {
      const result = hljs.highlightAuto(code, AUTO_LANGUAGES);
      return { html: result.value, detected: result.language ?? "plaintext" };
    }
    const selected = hljs.getLanguage(language) ? language : "plaintext";
    return { html: hljs.highlight(code, { language: selected }).value, detected: selected };
  }, [code, language]);
  const detectedLabel = LANGUAGE_OPTIONS.find(([value]) => value === highlighted.detected)?.[1] ?? highlighted.detected;

  const measure = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const lines = editor.value.split(/\r?\n/);
    const style = window.getComputedStyle(editor);
    const fontSize = Number.parseFloat(style.fontSize) || 13;
    const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.55;
    const horizontalPadding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    const verticalPadding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (context) context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const longestLineWidth = Math.max(0, ...lines.map((line) =>
      context?.measureText(line.replace(/\t/g, "  ")).width ?? line.length * fontSize * 0.62,
    ));
    onMeasureRef.current({
      contentWidth: Math.ceil(longestLineWidth + horizontalPadding),
      contentHeight: Math.ceil(lines.length * lineHeight + verticalPadding),
    });
  };

  const scheduleMeasure = () => {
    if (measureFrameRef.current !== null) cancelAnimationFrame(measureFrameRef.current);
    measureFrameRef.current = requestAnimationFrame(() => {
      measureFrameRef.current = null;
      measure();
    });
  };

  useLayoutEffect(() => {
    measure();
  }, [code]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const observer = new ResizeObserver(measure);
    observer.observe(editor);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    if (measureFrameRef.current !== null) cancelAnimationFrame(measureFrameRef.current);
  }, []);

  return (
    <div className="code-card-content">
      <div className="card-header code-card-toolbar">
        <CodeIcon size={15}/>
        <select
          value={language}
          aria-label="Code language"
          title="Syntax language"
          onChange={(event) => onLanguageChange(event.currentTarget.value)}
        >
          <option value="auto">Auto · {detectedLabel}</option>
          {LANGUAGE_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select>
        <span className="card-header-drag-region" aria-hidden="true" />
      </div>
      <div className="code-editor-wrap">
        <pre aria-hidden="true"><code ref={highlightRef} className="hljs" dangerouslySetInnerHTML={{ __html: `${highlighted.html}\n` }}/></pre>
        <textarea
          ref={editorRef}
          value={code}
          aria-label="Code"
          placeholder="Write or paste code…"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onFocus={() => { onFocus(); onActiveChange?.(true); }}
          onBlur={() => onActiveChange?.(false)}
          onChange={(event) => { onChange(event.currentTarget.value); scheduleMeasure(); }}
          onScroll={(event) => {
            const pre = highlightRef.current?.parentElement;
            if (!pre) return;
            pre.scrollTop = event.currentTarget.scrollTop;
            pre.scrollLeft = event.currentTarget.scrollLeft;
          }}
          onPointerDown={(event) => {
            if (event.button === 0) event.stopPropagation();
          }}
          onPaste={(event) => {
            event.preventDefault();
            const input = event.currentTarget;
            const start = input.selectionStart;
            const pasted = trimTrailingEmptyLines(event.clipboardData.getData("text/plain"));
            onChange(`${code.slice(0, start)}${pasted}${code.slice(input.selectionEnd)}`);
            requestAnimationFrame(() => {
              input.selectionStart = input.selectionEnd = start + pasted.length;
            });
          }}
          onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            event.preventDefault();
            const input = event.currentTarget;
            const start = input.selectionStart;
            const end = input.selectionEnd;
            onChange(`${code.slice(0, start)}  ${code.slice(end)}`);
            requestAnimationFrame(() => {
              input.selectionStart = input.selectionEnd = start + 2;
            });
          }}
        />
      </div>
    </div>
  );
}
