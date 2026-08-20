import type { TextBlock, TextRun } from "./types";

export function extractTextTitle(html: string): { title: string; html: string } {
  const template = document.createElement("template");
  template.innerHTML = html;
  const firstElement = template.content.firstElementChild;
  if (!firstElement || !/^H[12]$/.test(firstElement.tagName)) return { title: "", html };
  const title = (firstElement.textContent ?? "").replace(/\u00a0/g, " ").trim();
  while (template.content.firstChild !== firstElement && !template.content.firstChild?.textContent?.trim()) {
    template.content.firstChild?.remove();
  }
  firstElement.remove();
  while (template.content.firstChild?.nodeType === Node.TEXT_NODE && !template.content.firstChild.textContent?.trim()) {
    template.content.firstChild.remove();
  }
  return { title, html: template.innerHTML };
}

function runsFromNode(node: Node, inherited: Omit<TextRun, "text"> = {}): TextRun[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    return text ? [{ text, ...inherited }] : [];
  }

  if (!(node instanceof HTMLElement)) return [];
  const tag = node.tagName.toLowerCase();
  const formatting = {
    ...inherited,
    ...(tag === "strong" || tag === "b" ? { bold: true } : {}),
    ...(tag === "em" || tag === "i" ? { italic: true } : {}),
    ...(tag === "u" ? { underline: true } : {}),
    ...(tag === "a" && node.getAttribute("href")
      ? { href: node.getAttribute("href")! }
      : {}),
  };
  const runs = Array.from(node.childNodes).flatMap((child) =>
    runsFromNode(child, formatting),
  );
  if (tag === "br") runs.push({ text: "\n", ...formatting });
  return runs;
}

export function blocksFromHtml(html: string): TextBlock[] {
  const template = document.createElement("template");
  template.innerHTML = html;
  const blocks: TextBlock[] = [];

  const addBlock = (element: Element, kind: TextBlock["kind"], level?: number, checked?: boolean) => {
    blocks.push({ kind, level, checked, runs: runsFromNode(element) });
  };

  for (const node of Array.from(template.content.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
      blocks.push({ kind: "paragraph", runs: [{ text: node.textContent }] });
      continue;
    }
    if (!(node instanceof HTMLElement)) continue;
    const tag = node.tagName.toLowerCase();
    const isChecklist = tag === "ul" && node.classList.contains("checklist");
    if (tag === "h1" || tag === "h2") addBlock(node, "heading");
    else if (tag === "ul" || tag === "ol") {
      for (const child of Array.from(node.children)) {
        if (child.tagName.toLowerCase() !== "li") continue;
        if (isChecklist) addBlock(child, "checklist-item", 0, (child as HTMLElement).dataset.checked === "true");
        else addBlock(child, tag === "ul" ? "unordered-item" : "ordered-item", 0);
      }
    } else addBlock(node, "paragraph");
  }

  return blocks.length ? blocks : [{ kind: "paragraph", runs: [] }];
}

export function plainTextFromBlocks(blocks: TextBlock[]): string {
  return blocks.map((block) => block.runs.map((run) => run.text).join("")).join("\n");
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/([`*_[\]<>])/g, "\\$1")
    .replace(/^([#>])/gm, "\\$1")
    .replace(/^(\s*)([-+])(?=\s)/gm, "$1\\$2")
    .replace(/^(\s*)(\d+)\.(?=\s)/gm, "$1$2\\.")
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, "  \n");
}

function wrapMarkdown(value: string, before: string, after: string): string {
  const content = value.match(/^(\s*)([\s\S]*?\S)(\s*)$/);
  return content ? `${content[1]}${before}${content[2]}${after}${content[3]}` : value;
}

function markdownFromRun(run: TextRun): string {
  let value = escapeMarkdownText(run.text);
  if (run.bold) value = wrapMarkdown(value, "**", "**");
  if (run.italic) value = wrapMarkdown(value, "*", "*");
  if (run.underline) value = wrapMarkdown(value, "<u>", "</u>");
  if (run.href) {
    const destination = run.href.replace(/([\\()])/g, "\\$1");
    value = wrapMarkdown(value, "[", `](${destination})`);
  }
  return value;
}

function markdownListType(kind: TextBlock["kind"]): "unordered" | "ordered" | null {
  if (kind === "unordered-item" || kind === "checklist-item") return "unordered";
  return kind === "ordered-item" ? "ordered" : null;
}

export function markdownFromTextBlocks(blocks: TextBlock[], title = ""): string {
  const sections: Array<{ value: string; listType: "unordered" | "ordered" | null }> = [];
  let orderedIndex = 0;
  let previousListType: "unordered" | "ordered" | null = null;

  if (title.trim()) {
    sections.push({ value: `# ${escapeMarkdownText(title.trim())}`, listType: null });
  }

  for (const block of blocks) {
    const listType = markdownListType(block.kind);
    if (listType !== "ordered" || previousListType !== "ordered") orderedIndex = 0;
    if (listType === "ordered") orderedIndex += 1;

    const content = block.runs.map(markdownFromRun).join("");
    const indentation = "  ".repeat(Math.max(0, block.level ?? 0));
    const continuationIndent = listType ? `${indentation}  ` : "";
    const multilineContent = continuationIndent
      ? content.replace(/\n/g, `\n${continuationIndent}`)
      : content;
    let value: string;
    if (block.kind === "heading") value = `## ${multilineContent}`;
    else if (block.kind === "unordered-item") value = `${indentation}- ${multilineContent}`;
    else if (block.kind === "ordered-item") value = `${indentation}${orderedIndex}. ${multilineContent}`;
    else if (block.kind === "checklist-item") value = `${indentation}- [${block.checked ? "x" : " "}] ${multilineContent}`;
    else value = multilineContent;

    sections.push({ value, listType });
    previousListType = listType;
  }

  return sections.reduce((markdown, section, index) => {
    if (index === 0) return section.value;
    const previous = sections[index - 1];
    const separator = previous.listType && previous.listType === section.listType ? "\n" : "\n\n";
    return `${markdown}${separator}${section.value}`;
  }, "").replace(/(?:\s*\n)+$/, "");
}

export function trimTrailingEmptyLines(value: string): string {
  return value.replace(/(?:\r?\n[\t ]*)+$/, "");
}

export function normalizeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  try {
    const hasScheme = /^https?:\/\//i.test(trimmed);
    const candidate = hasScheme ? trimmed : `https://${trimmed}`;
    const url = new URL(candidate);
    const looksLikeHost = url.hostname === "localhost" || url.hostname.includes(".") || /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname);
    return (url.protocol === "http:" || url.protocol === "https:") && (hasScheme || looksLikeHost)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function looksTabular(value: string): boolean {
  const lines = value.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return false;
  const delimiters = ["\t", ","];
  return delimiters.some((delimiter) => {
    const counts = lines.map((line) => line.split(delimiter).length);
    return counts[0] > 1 && counts.every((count) => count === counts[0]);
  });
}

export function parseTable(value: string): string[][] {
  const delimiter = value.includes("\t") ? "\t" : ",";
  return value
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(delimiter).map((cell) => cell.trim()));
}
