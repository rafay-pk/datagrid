import { normalizeUrl, trimTrailingEmptyLines } from "./textFormat";

export interface ClipboardConversion {
  kind: "text" | "code";
  html: string;
  code: string;
  language: string;
  links: string[];
  images: ClipboardImage[];
}

export interface ClipboardImage {
  src: string;
  alt: string;
}

function plainTextToHtml(value: string): string {
  const container = document.createElement("div");
  const block = document.createElement("div");
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  for (const [index, line] of lines.entries()) {
    if (index > 0) block.appendChild(document.createElement("br"));
    if (line) block.appendChild(document.createTextNode(line));
  }
  if (!block.childNodes.length) block.appendChild(document.createElement("br"));
  container.appendChild(block);
  return container.innerHTML;
}

function isBold(element: HTMLElement): boolean {
  const weight = element.style.fontWeight.trim().toLowerCase();
  if (weight === "normal" || weight === "400") return false;
  const numericWeight = Number.parseInt(weight, 10);
  return element.matches("b, strong") || weight === "bold" || weight === "bolder" || numericWeight >= 600;
}

function isItalic(element: HTMLElement): boolean {
  const style = element.style.fontStyle.trim().toLowerCase();
  if (style === "normal") return false;
  return element.matches("i, em") || style === "italic" || style === "oblique";
}

function isUnderlined(element: HTMLElement): boolean {
  const decoration = `${element.style.textDecoration} ${element.style.textDecorationLine}`.toLowerCase();
  if (decoration.includes("none")) return false;
  return element.matches("u") || decoration.includes("underline");
}

function wrapFormatting(content: DocumentFragment, element: HTMLElement): DocumentFragment {
  let current: Node = content;
  for (const [enabled, tag] of [
    [isBold(element), "strong"],
    [isItalic(element), "em"],
    [isUnderlined(element), "u"],
  ] as const) {
    if (!enabled) continue;
    const wrapper = document.createElement(tag);
    wrapper.appendChild(current);
    current = wrapper;
  }
  const result = document.createDocumentFragment();
  result.appendChild(current);
  return result;
}

function semanticNode(node: Node, links: Set<string>, images: ClipboardImage[]): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return document.createTextNode((node.textContent ?? "").replace(/\u00a0/g, " "));
  if (!(node instanceof HTMLElement) || node.matches("script, style, meta, title")) return null;
  if (node.tagName === "BR") return document.createElement("br");
  if (node instanceof HTMLImageElement) {
    const src = node.getAttribute("src") ?? "";
    if (/^(?:data:image\/|https?:\/\/)/i.test(src)) images.push({ src, alt: node.alt.trim() });
    return null;
  }

  const children = document.createDocumentFragment();
  for (const child of Array.from(node.childNodes)) {
    const converted = semanticNode(child, links, images);
    if (converted) children.appendChild(converted);
  }
  let content = wrapFormatting(children, node);
  const tag = node.tagName;

  if (tag === "A") {
    const href = normalizeUrl(node.getAttribute("href") ?? "");
    if (!href) return content;
    links.add(href);
    const underline = document.createElement("u");
    underline.appendChild(content);
    return underline;
  }

  let output: HTMLElement | null = null;
  if (tag === "H1" || tag === "H2") output = document.createElement("h2");
  else if (/^H[3-6]$/.test(tag)) {
    output = document.createElement("div");
    const strong = document.createElement("strong");
    strong.appendChild(content);
    content = document.createDocumentFragment();
    content.appendChild(strong);
  } else if (tag === "UL") output = document.createElement("ul");
  else if (tag === "OL") output = document.createElement("ol");
  else if (tag === "LI") output = document.createElement("li");
  else if (tag === "DIV" || tag === "P") output = document.createElement("div");

  if (!output) return content;
  output.appendChild(content);
  return output;
}

function semanticHtml(source: string): { html: string; links: string[]; images: ClipboardImage[] } {
  const template = document.createElement("template");
  template.innerHTML = source;
  const links = new Set<string>();
  const images: ClipboardImage[] = [];
  const container = document.createElement("div");
  for (const child of Array.from(template.content.childNodes)) {
    const converted = semanticNode(child, links, images);
    if (converted) container.appendChild(converted);
  }
  while (container.firstChild && !container.firstChild.textContent?.trim()) container.firstChild.remove();
  while (container.lastChild && !container.lastChild.textContent?.trim()) container.lastChild.remove();
  for (const textNode of Array.from(container.childNodes)) {
    if (textNode.nodeType === Node.TEXT_NODE && !textNode.textContent?.trim()) textNode.remove();
  }
  return { html: container.innerHTML, links: Array.from(links), images };
}

function appendInlineMarkdown(parent: HTMLElement, value: string, links: Set<string>): void {
  const token = /(\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_)/g;
  let cursor = 0;
  for (const match of value.matchAll(token)) {
    const index = match.index ?? 0;
    if (index > cursor) parent.appendChild(document.createTextNode(value.slice(cursor, index)));
    if (match[2] !== undefined && match[3] !== undefined) {
      const href = normalizeUrl(match[3]);
      if (href) {
        const underline = document.createElement("u");
        underline.textContent = match[2];
        parent.appendChild(underline);
        links.add(href);
      } else parent.appendChild(document.createTextNode(match[0]));
    } else if (match[4] !== undefined || match[5] !== undefined) {
      const strong = document.createElement("strong");
      strong.textContent = match[4] ?? match[5];
      parent.appendChild(strong);
    } else {
      const emphasis = document.createElement("em");
      emphasis.textContent = match[6] ?? match[7];
      parent.appendChild(emphasis);
    }
    cursor = index + match[0].length;
  }
  if (cursor < value.length) parent.appendChild(document.createTextNode(value.slice(cursor)));
}

function looksLikeMarkdown(value: string): boolean {
  return /(^|\n)\s{0,3}#{1,6}\s+\S/.test(value)
    || /(^|\n)\s*[-+*]\s+\S/.test(value)
    || /(^|\n)\s*\d+[.)]\s+\S/.test(value)
    || /\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]]+\]\([^)]+\)/.test(value);
}

function markdownHtml(value: string): { html: string; links: string[]; images: ClipboardImage[] } {
  const container = document.createElement("div");
  const links = new Set<string>();
  let activeList: HTMLUListElement | HTMLOListElement | null = null;
  let activeListType = "";

  for (const rawLine of value.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = rawLine.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    const unordered = rawLine.match(/^\s*[-+*]\s+(.*)$/);
    const ordered = rawLine.match(/^\s*\d+[.)]\s+(.*)$/);
    if (!unordered && !ordered) {
      activeList = null;
      activeListType = "";
    }
    if (heading) {
      const block = document.createElement(heading[1].length <= 2 ? "h2" : "div");
      if (heading[1].length > 2) {
        const strong = document.createElement("strong");
        appendInlineMarkdown(strong, heading[2], links);
        block.appendChild(strong);
      } else appendInlineMarkdown(block, heading[2], links);
      container.appendChild(block);
      continue;
    }
    if (unordered || ordered) {
      const listType = unordered ? "ul" : "ol";
      if (!activeList || activeListType !== listType) {
        activeList = document.createElement(listType);
        activeListType = listType;
        container.appendChild(activeList);
      }
      const item = document.createElement("li");
      appendInlineMarkdown(item, (unordered ?? ordered)![1], links);
      activeList.appendChild(item);
      continue;
    }
    const block = document.createElement("div");
    if (rawLine) appendInlineMarkdown(block, rawLine, links);
    else block.appendChild(document.createElement("br"));
    container.appendChild(block);
  }
  return { html: container.innerHTML, links: Array.from(links), images: [] };
}

function normalizedLanguage(value: string): string {
  const aliases: Record<string, string> = {
    c: "cpp", cs: "csharp", csharp: "csharp", htm: "xml", html: "xml", js: "javascript",
    jsx: "javascript", md: "markdown", py: "python", rs: "rust", sh: "bash", shell: "bash",
    ts: "typescript", tsx: "typescript", yml: "yaml",
  };
  const normalized = value.trim().toLowerCase();
  return aliases[normalized] ?? (normalized || "auto");
}

function codeContent(html: string, text: string): { code: string; language: string } | null {
  const fenced = text.trim().match(/^```([\w+#.-]*)\s*\n([\s\S]*?)\n```$/);
  if (fenced) return { code: fenced[2], language: normalizedLanguage(fenced[1]) };
  if (html) {
    const template = document.createElement("template");
    template.innerHTML = html;
    const code = template.content.querySelector("pre code, pre");
    if (code) {
      const languageClass = Array.from(code.classList).find((name) => /^(?:language|lang)-/.test(name));
      return {
        code: trimTrailingEmptyLines(code.textContent ?? text),
        language: languageClass ? normalizedLanguage(languageClass.replace(/^(?:language|lang)-/, "")) : "auto",
      };
    }
  }
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length < 2) return null;
  let score = 0;
  if (lines.some((line) => /^\s*(?:import|export|function|class|interface|type|const|let|var|fn|def|use|package|public|private|protected|#include)\b/.test(line))) score += 2;
  if (lines.filter((line) => /[{};]\s*$/.test(line)).length >= 2) score += 2;
  if (lines.filter((line) => /^\s{2,}\S/.test(line)).length >= Math.max(2, Math.floor(lines.length / 4))) score += 1;
  if (/[=!<>]=|=>|\?\?|&&|\|\|/.test(text)) score += 1;
  return score >= 3 ? { code: text, language: "auto" } : null;
}

export function convertClipboardContent(html: string, text: string): ClipboardConversion {
  const normalizedText = trimTrailingEmptyLines(text);
  const code = codeContent(html, normalizedText);
  if (code) return { kind: "code", html: "", code: code.code, language: code.language, links: [], images: [] };
  const richHasDocumentStructure = /<(?:h[1-6]|ul|ol|li|strong|b|a)\b/i.test(html);
  const converted = looksLikeMarkdown(normalizedText) && !richHasDocumentStructure
    ? markdownHtml(normalizedText)
    : html.trim()
      ? semanticHtml(html)
      : { html: plainTextToHtml(normalizedText), links: [], images: [] };
  return { kind: "text", html: converted.html, code: "", language: "auto", links: converted.links, images: converted.images };
}
