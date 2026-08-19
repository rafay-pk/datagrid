import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { CanvasDocument, CanvasFile, LinkPreview } from "./types";
import { CARD_COLORS, createEmptyDocument, createId } from "./types";

const isTauri = "__TAURI_INTERNALS__" in window;
const MOCK_FOLDER = "Datagrid Demo Library";

function seedDocument(): CanvasDocument {
  const doc = createEmptyDocument("Product garden");
  doc.cards = [
    {
      id: createId("text"),
      type: "text",
      x: -1,
      y: -1,
      w: 2,
      h: 1,
      color: CARD_COLORS[0],
      createdAt: new Date().toISOString(),
      html: "<h2>A calmer place for ideas</h2><div>Everything lands on the grid, stays portable, and remains yours.</div>",
      blocks: [],
    },
    {
      id: createId("text"),
      type: "text",
      x: 1,
      y: -1,
      w: 1,
      h: 2,
      color: CARD_COLORS[1],
      createdAt: new Date().toISOString(),
      html: "<div><strong>Today</strong></div><ul><li>Collect references</li><li>Shape the first canvas</li><li>Keep it delightfully simple</li></ul>",
      blocks: [],
    },
    {
      id: createId("sheet"),
      type: "spreadsheet",
      x: -1,
      y: 0,
      w: 2,
      h: 2,
      color: CARD_COLORS[2],
      createdAt: new Date().toISOString(),
      rows: 5,
      columns: 5,
      cells: [
        ["", "Task", "Owner", "Status", "Hours"],
        ["Discovery", "Research", "Maya", "Done", "3"],
        ["Build", "Prototype", "Ari", "Active", "6"],
        ["Polish", "Review", "Team", "Next", "2"],
        ["Total", "", "", "", "=SUM(D1:D3)"],
      ],
    },
    {
      id: createId("link"),
      type: "link",
      x: 1,
      y: 1,
      w: 2,
      h: 1,
      color: CARD_COLORS[4],
      createdAt: new Date().toISOString(),
      url: "https://www.openoffice.org/why/why_odf.html",
      preview: {
        title: "OpenDocument Format",
        description: "An open standard for documents that keeps your work portable.",
        siteName: "OpenOffice",
        domain: "openoffice.org",
      },
    },
  ];
  return doc;
}

function mockDocuments(): Record<string, CanvasDocument> {
  const stored = localStorage.getItem("datagrid-mock-documents");
  if (stored) return JSON.parse(stored) as Record<string, CanvasDocument>;
  const doc = seedDocument();
  const documents = { [`${MOCK_FOLDER}\\${doc.name}.odt`]: doc };
  localStorage.setItem("datagrid-mock-documents", JSON.stringify(documents));
  return documents;
}

function saveMockDocuments(documents: Record<string, CanvasDocument>): void {
  localStorage.setItem("datagrid-mock-documents", JSON.stringify(documents));
}

export async function chooseLibraryFolder(): Promise<string | null> {
  if (!isTauri) return MOCK_FOLDER;
  const selected = await open({ directory: true, multiple: false, title: "Choose your Datagrid library" });
  return typeof selected === "string" ? selected : null;
}

export async function listCanvases(folder: string): Promise<CanvasFile[]> {
  if (isTauri) return invoke("list_canvases", { folder });
  return Object.entries(mockDocuments()).map(([path, document]) => ({
    path,
    name: document.name,
    modifiedAt: document.updatedAt,
    size: JSON.stringify(document).length,
    emoji: document.emoji,
  }));
}

export async function loadCanvas(path: string): Promise<CanvasDocument> {
  if (isTauri) return invoke("load_canvas", { path });
  const document = mockDocuments()[path];
  if (!document) throw new Error("Canvas not found.");
  return structuredClone(document);
}

export async function saveCanvas(path: string, document: CanvasDocument): Promise<void> {
  if (isTauri) return invoke("save_canvas", { path, document });
  const documents = mockDocuments();
  documents[path] = structuredClone(document);
  saveMockDocuments(documents);
}

export async function createCanvas(folder: string, name: string): Promise<CanvasFile> {
  if (isTauri) return invoke("create_canvas", { folder, name });
  const document = createEmptyDocument(name);
  const path = `${folder}\\${name}.odt`;
  const documents = mockDocuments();
  documents[path] = document;
  saveMockDocuments(documents);
  return { path, name, modifiedAt: document.updatedAt, size: 0, emoji: document.emoji };
}

export async function renameCanvas(path: string, name: string): Promise<CanvasFile> {
  if (isTauri) return invoke("rename_canvas", { path, name });
  const documents = mockDocuments();
  const document = documents[path];
  const separator = path.includes("\\") ? "\\" : "/";
  const nextPath = `${path.slice(0, path.lastIndexOf(separator))}${separator}${name}.odt`;
  delete documents[path];
  document.name = name;
  document.updatedAt = new Date().toISOString();
  documents[nextPath] = document;
  saveMockDocuments(documents);
  return { path: nextPath, name, modifiedAt: document.updatedAt, size: 0, emoji: document.emoji };
}

export async function duplicateCanvas(path: string): Promise<CanvasFile> {
  if (isTauri) return invoke("duplicate_canvas", { path });
  const documents = mockDocuments();
  const source = structuredClone(documents[path]);
  source.id = createId("canvas");
  source.name = `${source.name} copy`;
  const nextPath = `${MOCK_FOLDER}\\${source.name}.odt`;
  documents[nextPath] = source;
  saveMockDocuments(documents);
  return { path: nextPath, name: source.name, modifiedAt: source.updatedAt, size: 0, emoji: source.emoji };
}

export async function deleteCanvas(path: string): Promise<void> {
  if (isTauri) return invoke("delete_canvas", { path });
  const documents = mockDocuments();
  delete documents[path];
  saveMockDocuments(documents);
}

export async function revealLibrary(folder: string): Promise<void> {
  if (isTauri) await invoke("reveal_library", { folder });
}

export async function fetchLinkPreview(url: string): Promise<LinkPreview> {
  if (isTauri) return invoke("fetch_link_preview", { url });
  const parsed = new URL(url);
  return {
    title: parsed.hostname.replace(/^www\./, ""),
    description: "A saved link preview. Its metadata will be cached inside this canvas for offline use.",
    siteName: parsed.hostname.replace(/^www\./, ""),
    domain: parsed.hostname.replace(/^www\./, ""),
  };
}

export async function fetchImageDataUrl(url: string): Promise<string> {
  if (url.startsWith("data:image/")) return url;
  if (isTauri) return invoke<string>("fetch_image_data_url", { url });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch pasted image (${response.status}).`);
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("The pasted image source did not return an image.");
  if (blob.size > 5_000_000) throw new Error("The pasted image is larger than 5 MB.");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the pasted image."));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

export { isTauri };
