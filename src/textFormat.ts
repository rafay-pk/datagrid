import type { TextBlock, TextRun } from "./types";

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
