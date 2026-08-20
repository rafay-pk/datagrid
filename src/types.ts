export type Theme = "light" | "dark";

export type CardType = "text" | "code" | "image" | "spreadsheet" | "link";

export interface GridRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  href?: string;
}

export interface TextBlock {
  kind: "paragraph" | "heading" | "unordered-item" | "ordered-item" | "checklist-item";
  level?: number;
  checked?: boolean;
  runs: TextRun[];
}

interface CardBase extends GridRect {
  id: string;
  type: CardType;
  color: string;
  createdAt: string;
}

export interface TextCard extends CardBase {
  type: "text";
  title?: string;
  html: string;
  blocks: TextBlock[];
}

export interface CodeCard extends CardBase {
  type: "code";
  code: string;
  language: string;
}

export interface ImageCard extends CardBase {
  type: "image";
  label?: string;
  assetPath?: string;
  dataUrl?: string;
  mimeType: string;
  fileName: string;
  naturalWidth: number;
  naturalHeight: number;
}

export interface SpreadsheetCard extends CardBase {
  type: "spreadsheet";
  cells: string[][];
  rows: number;
  columns: number;
}

export interface LinkPreview {
  title: string;
  description: string;
  siteName: string;
  domain: string;
  imageUrl?: string;
  imageDataUrl?: string;
  faviconUrl?: string;
  faviconDataUrl?: string;
}

export interface LinkCard extends CardBase {
  type: "link";
  url: string;
  preview: LinkPreview;
}

export type CanvasCard = TextCard | CodeCard | ImageCard | SpreadsheetCard | LinkCard;

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasDocument {
  version: 1;
  id: string;
  name: string;
  emoji?: string;
  accent: string;
  font: string;
  cards: CanvasCard[];
  viewport: CanvasViewport;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasFile {
  path: string;
  name: string;
  modifiedAt: string;
  size: number;
  emoji?: string;
  warning?: string;
}

export interface OpenCanvas {
  path: string;
  document: CanvasDocument;
  dirty: boolean;
  saving: boolean;
  lastSavedAt?: string;
}

export type Tool = "select" | CardType;

export interface SessionState {
  libraryFolder: string;
  openPaths: string[];
  activePath: string | null;
  theme: Theme;
  font: string;
  uiScale: number;
  sidebarCollapsed: boolean;
  randomColors: boolean;
  showTransparencyGrid: boolean;
}

export const CARD_COLORS = [
  "#FF4D4D",
  "#FF6B6B",
  "#FF84BA",
  "#F72585",
  "#B11226",
  "#8338EC",
  "#E056FD",
  "#3A86FF",
  "#FBBC04",
  "#F4A261",
  "#EBD5AB",
  "#FB8500",
  "#5C2A1D",
  "#6C63FF",
  "#836ca7",
  "#38BDF8",
  "#00A896",
  "#219EBC",
  "#99DDCC",
  "#8AC926",
  "#063B00",
  "#3949AB",
  "#8C9097",
  "#1C262B",
] as const;

export const FONT_OPTIONS = [
  { label: "Figtree", value: "Figtree Variable" },
  { label: "DM Sans", value: "DM Sans Variable" },
  { label: "Manrope", value: "Manrope Variable" },
  { label: "Work Sans", value: "Work Sans Variable" },
] as const;

export const GRID_UNIT = 240;
export const GRID_GAP = 16;

export function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function createEmptyDocument(name: string): CanvasDocument {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: createId("canvas"),
    name,
    emoji: "🗂️",
    accent: CARD_COLORS[0],
    font: "Figtree Variable",
    cards: [],
    viewport: { x: 0, y: 0, zoom: 0.82 },
    createdAt: now,
    updatedAt: now,
  };
}
