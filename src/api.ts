import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { CanvasDocument, CanvasFile, LinkPreview } from "./types";
import { CARD_COLORS, createEmptyDocument, createId } from "./types";

const isTauri = "__TAURI_INTERNALS__" in window;
const MOCK_FOLDER = "Datagrid Demo Library";
const MOCK_ASSETS_KEY = "datagrid-mock-assets";

export interface GitEnvironment {
  available: boolean;
  version?: string;
}

export interface RepositoryConnection {
  folder: string;
  remoteUrl: string;
  needsSetup: boolean;
  folderEmpty: boolean;
  warning?: string;
}

export interface SaveResult {
  commitMessage?: string;
  warning?: string;
  status: RepositoryStatus;
}

export interface RepositoryStatus {
  state: "ready" | "syncing" | "synced" | "local" | "behind" | "error";
  message: string;
  ahead: number;
  behind: number;
  latestCommit?: string;
  latestCommitAt?: string;
}

export interface ImportedCanvasImage {
  assetPath: string;
}

const MOCK_REPOSITORY_STATUS: RepositoryStatus = {
  state: "synced",
  message: "Synced with GitHub",
  ahead: 0,
  behind: 0,
  latestCommit: "Updated Product garden",
  latestCommitAt: new Date().toISOString(),
};

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
      url: "https://docs.github.com/en/repositories",
      preview: {
        title: "GitHub repositories",
        description: "A private, versioned home for portable canvas files.",
        siteName: "GitHub Docs",
        domain: "docs.github.com",
      },
    },
  ];
  return doc;
}

function mockDocuments(): Record<string, CanvasDocument> {
  const stored = localStorage.getItem("datagrid-mock-documents");
  if (stored) return JSON.parse(stored) as Record<string, CanvasDocument>;
  const doc = seedDocument();
  const documents = { [`${MOCK_FOLDER}\\canvases\\${doc.name}`]: doc };
  localStorage.setItem("datagrid-mock-documents", JSON.stringify(documents));
  return documents;
}

function saveMockDocuments(documents: Record<string, CanvasDocument>): void {
  localStorage.setItem("datagrid-mock-documents", JSON.stringify(documents));
}

function mockAssets(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(MOCK_ASSETS_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function mockAssetKey(canvasPath: string, assetPath: string): string {
  return `${canvasPath}::${assetPath}`;
}

export async function chooseLibraryFolder(): Promise<string | null> {
  if (!isTauri) return MOCK_FOLDER;
  const selected = await open({ directory: true, multiple: false, title: "Choose a GitHub repository folder" });
  return typeof selected === "string" ? selected : null;
}

export async function getGitEnvironment(): Promise<GitEnvironment> {
  if (isTauri) return invoke("git_environment");
  return { available: true, version: "Git (browser demo)" };
}

export async function openGitHubNewRepository(): Promise<void> {
  const url = "https://github.com/new?name=datagrid-canvases&description=Private%20Datagrid%20canvas%20repository&visibility=private";
  if (isTauri) await openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

export async function connectRepository(folder: string, remoteUrl?: string): Promise<RepositoryConnection> {
  if (isTauri) return invoke("connect_repository", { folder, remoteUrl });
  return {
    folder,
    remoteUrl: remoteUrl || "https://github.com/example/datagrid-library.git",
    needsSetup: false,
    folderEmpty: false,
  };
}

export async function syncRepository(folder: string): Promise<RepositoryStatus> {
  if (isTauri) return invoke("sync_repository", { folder });
  return MOCK_REPOSITORY_STATUS;
}

export async function getRepositoryStatus(folder: string): Promise<RepositoryStatus> {
  if (isTauri) return invoke("repository_status", { folder });
  return MOCK_REPOSITORY_STATUS;
}

export async function pushPendingCommits(folder: string): Promise<RepositoryStatus> {
  if (isTauri) return invoke("push_pending_commits", { folder });
  return MOCK_REPOSITORY_STATUS;
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

export async function saveCanvas(path: string, document: CanvasDocument): Promise<SaveResult> {
  if (isTauri) return invoke("save_canvas", { path, document });
  const documents = mockDocuments();
  documents[path] = structuredClone(document);
  saveMockDocuments(documents);
  return { commitMessage: `Updated ${document.name}`, status: MOCK_REPOSITORY_STATUS };
}

export async function importCanvasImage(
  path: string,
  cardId: string,
  fileName: string,
  dataUrl: string,
): Promise<ImportedCanvasImage> {
  if (isTauri) return invoke("import_canvas_image", { path, cardId, fileName, dataUrl });
  const extension = fileName.includes(".") ? "" : ".png";
  const assetPath = `images/${cardId}-${fileName}${extension}`;
  const assets = mockAssets();
  assets[mockAssetKey(path, assetPath)] = dataUrl;
  localStorage.setItem(MOCK_ASSETS_KEY, JSON.stringify(assets));
  return { assetPath };
}

export async function readCanvasAssetDataUrl(path: string, assetPath: string, mimeType?: string): Promise<string> {
  if (isTauri) return invoke("read_canvas_asset_data_url", { path, assetPath, mimeType });
  const dataUrl = mockAssets()[mockAssetKey(path, assetPath)];
  if (!dataUrl) throw new Error("Canvas image asset was not found.");
  return dataUrl;
}

export async function createCanvas(folder: string, name: string, emoji = "🗂️"): Promise<CanvasFile> {
  if (isTauri) return invoke("create_canvas", { folder, name, emoji });
  const document = createEmptyDocument(name);
  document.emoji = emoji;
  const path = `${folder}\\canvases\\${name}`;
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
  const nextPath = `${path.slice(0, path.lastIndexOf(separator))}${separator}${name}`;
  delete documents[path];
  document.name = name;
  document.updatedAt = new Date().toISOString();
  documents[nextPath] = document;
  saveMockDocuments(documents);
  const assets = mockAssets();
  for (const [key, value] of Object.entries(assets)) {
    if (!key.startsWith(`${path}::`)) continue;
    assets[`${nextPath}::${key.slice(path.length + 2)}`] = value;
    delete assets[key];
  }
  localStorage.setItem(MOCK_ASSETS_KEY, JSON.stringify(assets));
  return { path: nextPath, name, modifiedAt: document.updatedAt, size: 0, emoji: document.emoji };
}

export async function duplicateCanvas(path: string): Promise<CanvasFile> {
  if (isTauri) return invoke("duplicate_canvas", { path });
  const documents = mockDocuments();
  const source = structuredClone(documents[path]);
  source.id = createId("canvas");
  source.name = `${source.name} copy`;
  const nextPath = `${MOCK_FOLDER}\\canvases\\${source.name}`;
  documents[nextPath] = source;
  saveMockDocuments(documents);
  const assets = mockAssets();
  for (const [key, value] of Object.entries(assets)) {
    if (key.startsWith(`${path}::`)) assets[`${nextPath}::${key.slice(path.length + 2)}`] = value;
  }
  localStorage.setItem(MOCK_ASSETS_KEY, JSON.stringify(assets));
  return { path: nextPath, name: source.name, modifiedAt: source.updatedAt, size: 0, emoji: source.emoji };
}

export async function deleteCanvas(path: string): Promise<SaveResult> {
  if (isTauri) return invoke("delete_canvas", { path });
  const documents = mockDocuments();
  delete documents[path];
  saveMockDocuments(documents);
  const assets = mockAssets();
  for (const key of Object.keys(assets)) {
    if (key.startsWith(`${path}::`)) delete assets[key];
  }
  localStorage.setItem(MOCK_ASSETS_KEY, JSON.stringify(assets));
  return { commitMessage: "Removed Canvas", status: MOCK_REPOSITORY_STATUS };
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
