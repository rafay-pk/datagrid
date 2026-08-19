import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fetchLinkPreview } from "./api";
import { averageImageAccent } from "./color";
import { clampZoom, firstFreePosition, overlaps, reflowCardGroup, reflowCards } from "./grid";
import {
  CheckIcon,
  CodeIcon,
  CopyIcon,
  DiceIcon,
  DuplicateIcon,
  ExternalIcon,
  ImageIcon,
  LinkIcon,
  PointerIcon,
  SheetIcon,
  TextIcon,
  TrashIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "./icons";
import { SpreadsheetCard, spreadsheetToCsv } from "./SpreadsheetCard";
import { ImageCardLabel } from "./ImageCardLabel";
import { TextEditor } from "./TextEditor";
import { CodeEditor } from "./CodeEditor";
import { blocksFromHtml, looksTabular, normalizeUrl, parseTable, plainTextFromBlocks } from "./textFormat";
import {
  CARD_COLORS,
  GRID_GAP,
  GRID_UNIT,
  createId,
  type CanvasCard,
  type CanvasDocument,
  type CodeCard,
  type GridRect,
  type ImageCard,
  type LinkCard,
  type SpreadsheetCard as SpreadsheetCardType,
  type TextCard,
  type Tool,
} from "./types";

interface CanvasWorkspaceProps {
  document: CanvasDocument;
  onChange: (document: CanvasDocument, recordHistory?: boolean, markDirty?: boolean) => void;
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  color: string;
  onColorChange: (color: string) => void;
  randomColors: boolean;
  onRandomColorsChange: (enabled: boolean) => void;
  search: string;
}

type Interaction =
  | {
      type: "pan";
      button: number;
      startX: number;
      startY: number;
      originX: number;
      originY: number;
    }
  | {
      type: "box-select";
      button: number;
      startX: number;
      startY: number;
    }
  | {
      type: "drag";
      button: number;
      cardId: string;
      startX: number;
      startY: number;
      origin: GridRect;
      groupOrigins: Map<string, GridRect>;
    }
  | {
      type: "resize";
      button: number;
      cardId: string;
      startX: number;
      startY: number;
      origin: GridRect;
    };

const stride = GRID_UNIT + GRID_GAP;
const FOCUS_PADDING = 96;

function cardSize(card: CanvasCard): React.CSSProperties {
  return {
    left: card.x * stride + GRID_GAP / 2,
    top: card.y * stride + GRID_GAP / 2,
    width: card.w * GRID_UNIT + (card.w - 1) * GRID_GAP,
    height: card.h * GRID_UNIT + (card.h - 1) * GRID_GAP,
    "--card-accent": card.color,
  } as React.CSSProperties;
}

function readImage(file: File): Promise<Omit<ImageCard, "id" | "x" | "y" | "color" | "createdAt">> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const image = new Image();
      image.onerror = () => reject(new Error(`${file.name} is not a supported image.`));
      image.onload = () => {
        const ratio = image.naturalWidth / Math.max(1, image.naturalHeight);
        const size = ratio > 1.18 ? { w: 2, h: 1 } : ratio < 0.85 ? { w: 1, h: 2 } : { w: 1, h: 1 };
        resolve({
          type: "image",
          dataUrl,
          mimeType: file.type || (file.name.toLowerCase().endsWith(".ico") ? "image/x-icon" : "application/octet-stream"),
          fileName: file.name,
          label: "",
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          ...size,
        });
      };
      image.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

function imageDataUrlToPngBlob(dataUrl: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error("Could not decode image."));
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) { reject(new Error("Canvas unavailable.")); return; }
      context.drawImage(image, 0, 0);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode PNG."))), "image/png");
    };
    image.src = dataUrl;
  });
}

function cardMatchesSearch(card: CanvasCard, query: string): boolean {
  if (!query.trim()) return true;
  const needle = query.toLowerCase();
  if (card.type === "text") return plainTextFromBlocks(card.blocks).toLowerCase().includes(needle);
  if (card.type === "code") return `${card.language} ${card.code}`.toLowerCase().includes(needle);
  if (card.type === "spreadsheet") return card.cells.flat().join(" ").toLowerCase().includes(needle);
  if (card.type === "image") return `${card.label ?? ""} ${card.fileName}`.toLowerCase().includes(needle);
  return `${card.url} ${card.preview.title} ${card.preview.description}`.toLowerCase().includes(needle);
}

function htmlFromPlainText(value: string): string {
  if (!value) return "";
  const escaped = value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
  return `<div>${escaped}</div>`;
}

export function CanvasWorkspace({
  document,
  onChange,
  tool,
  onToolChange,
  color,
  onColorChange,
  randomColors,
  onRandomColorsChange,
  search,
}: CanvasWorkspaceProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const documentRef = useRef(document);
  const interactionRef = useRef<Interaction | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const [viewport, setViewport] = useState(document.viewport);
  const [previewCards, setPreviewCards] = useState<CanvasCard[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [marqueeSelection, setMarqueeSelection] = useState(false);
  const [selectionRect, setSelectionRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [focusedSheetId, setFocusedSheetId] = useState<string | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [editingImageLabelId, setEditingImageLabelId] = useState<string | null>(null);
  const [linkInputOpen, setLinkInputOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const [sheetConfigOpen, setSheetConfigOpen] = useState(false);
  const [sheetRows, setSheetRows] = useState(4);
  const [sheetColumns, setSheetColumns] = useState(3);
  const [sheetOrigin, setSheetOrigin] = useState<{ x: number; y: number } | undefined>();
  const [notice, setNotice] = useState<string | null>(null);
  const [isFocusing, setIsFocusing] = useState(false);
  const [copiedCardId, setCopiedCardId] = useState<string | null>(null);
  const lastRandomColorRef = useRef<string | null>(null);
  const contentMinimumsRef = useRef(new Map<string, { w: number; h: number }>());
  const focusTimeoutRef = useRef<number | null>(null);
  const copiedTimeoutRef = useRef<number | null>(null);
  const suppressContextMenuRef = useRef(false);
  const suppressCanvasClickRef = useRef(false);
  const contextMenuTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    documentRef.current = document;
  }, [document]);

  useEffect(() => () => {
    if (focusTimeoutRef.current !== null) window.clearTimeout(focusTimeoutRef.current);
    if (contextMenuTimeoutRef.current !== null) window.clearTimeout(contextMenuTimeoutRef.current);
  }, []);

  useEffect(() => {
    setViewport(document.viewport);
  }, [document.id, document.viewport.x, document.viewport.y, document.viewport.zoom]);

  useEffect(() => {
    if (tool !== "link") {
      setLinkInputOpen(false);
      setLinkValue("");
    }
    if (tool !== "spreadsheet") {
      setSheetConfigOpen(false);
      setSheetOrigin(undefined);
    }
  }, [tool]);

  const cards = previewCards ?? document.cards;

  const nextCardColor = () => {
    if (!randomColors) return color;
    const choices = CARD_COLORS.filter((candidate) => candidate !== lastRandomColorRef.current);
    const next = choices[Math.floor(Math.random() * choices.length)] ?? CARD_COLORS[0];
    lastRandomColorRef.current = next;
    return next;
  };

  const commitCards = (nextCards: CanvasCard[], recordHistory = true) => {
    const next = {
      ...documentRef.current,
      cards: nextCards,
      updatedAt: new Date().toISOString(),
    };
    documentRef.current = next;
    onChange(next, recordHistory);
  };

  const updateCard = (id: string, update: (card: CanvasCard) => CanvasCard, recordHistory = true) => {
    commitCards(documentRef.current.cards.map((card) => (card.id === id ? update(card) : card)), recordHistory);
  };

  const viewportCenterGrid = (): { x: number; y: number } => {
    const surface = surfaceRef.current;
    if (!surface) return { x: 0, y: 0 };
    const point = lastPointerRef.current ?? { x: surface.clientWidth / 2, y: surface.clientHeight / 2 };
    return {
      x: Math.floor((point.x - surface.clientWidth / 2 - viewport.x) / viewport.zoom / stride),
      y: Math.floor((point.y - surface.clientHeight / 2 - viewport.y) / viewport.zoom / stride),
    };
  };

  const focusCard = (card: CanvasCard) => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const bounds = surface.getBoundingClientRect();
    const width = card.w * GRID_UNIT + (card.w - 1) * GRID_GAP;
    const height = card.h * GRID_UNIT + (card.h - 1) * GRID_GAP;
    const centerX = card.x * stride + GRID_GAP / 2 + width / 2;
    const centerY = card.y * stride + GRID_GAP / 2 + height / 2;
    const zoom = clampZoom(Math.min(
      (bounds.width - FOCUS_PADDING * 2) / width,
      (bounds.height - FOCUS_PADDING * 2) / height,
    ));
    if (focusTimeoutRef.current !== null) window.clearTimeout(focusTimeoutRef.current);
    setIsFocusing(true);
    setViewport({ x: -centerX * zoom, y: -centerY * zoom, zoom });
    focusTimeoutRef.current = window.setTimeout(() => {
      setIsFocusing(false);
      focusTimeoutRef.current = null;
    }, 340);
  };

  const placeCard = <T extends CanvasCard>(card: Omit<T, "x" | "y">, origin = viewportCenterGrid()) => {
    const position = firstFreePosition(documentRef.current.cards, origin, { w: card.w, h: card.h });
    const next = { ...card, ...position } as T;
    commitCards([...documentRef.current.cards, next]);
    setSelectedId(next.id);
    onToolChange("select");
    return next;
  };

  const addText = (origin?: { x: number; y: number }, html = "") => {
    const card: Omit<TextCard, "x" | "y"> = {
      id: createId("text"),
      type: "text",
      w: 1,
      h: 1,
      color: nextCardColor(),
      createdAt: new Date().toISOString(),
      html,
      blocks: blocksFromHtml(html),
    };
    placeCard<TextCard>(card, origin);
  };

  const addCode = (origin?: { x: number; y: number }, code = "") => {
    const card: Omit<CodeCard, "x" | "y"> = {
      id: createId("code"),
      type: "code",
      w: 1,
      h: 1,
      color: nextCardColor(),
      createdAt: new Date().toISOString(),
      code,
      language: "auto",
    };
    placeCard<CodeCard>(card, origin);
  };

  const addSpreadsheet = (
    origin?: { x: number; y: number },
    values?: string[][],
    dataSize = { rows: sheetRows, columns: sheetColumns },
  ) => {
    const cells = values ?? Array.from(
      { length: dataSize.rows + 1 },
      () => Array.from({ length: dataSize.columns + 1 }, () => ""),
    );
    const columns = Math.max(1, ...cells.map((row) => row.length));
    const normalized = cells.map((row) => [...row, ...Array.from({ length: columns - row.length }, () => "")]);
    const card: Omit<SpreadsheetCardType, "x" | "y"> = {
      id: createId("sheet"),
      type: "spreadsheet",
      w: 2,
      h: 2,
      color: nextCardColor(),
      createdAt: new Date().toISOString(),
      rows: normalized.length,
      columns,
      cells: normalized,
    };
    const placed = placeCard<SpreadsheetCardType>(card, origin);
    setFocusedSheetId(placed.id);
    setSheetConfigOpen(false);
    setSheetOrigin(undefined);
  };

  const addLink = async (rawUrl: string, origin?: { x: number; y: number }) => {
    const url = normalizeUrl(rawUrl);
    if (!url) {
      setNotice("That doesn’t look like a web link.");
      return;
    }
    const parsed = new URL(url);
    const card: Omit<LinkCard, "x" | "y"> = {
      id: createId("link"),
      type: "link",
      w: 2,
      h: 1,
      color: nextCardColor(),
      createdAt: new Date().toISOString(),
      url,
      preview: {
        title: "Gathering preview…",
        description: "",
        siteName: parsed.hostname.replace(/^www\./, ""),
        domain: parsed.hostname.replace(/^www\./, ""),
      },
    };
    const placed = placeCard<LinkCard>(card, origin);
    setLinkInputOpen(false);
    setLinkValue("");
    try {
      const preview = await fetchLinkPreview(url);
      const accentSource = preview.imageDataUrl ?? preview.faviconDataUrl;
      const averageAccent = accentSource ? await averageImageAccent(accentSource) : null;
      updateCard(placed.id, (current) => current.type === "link" ? {
        ...current,
        preview,
        color: averageAccent ?? current.color,
      } : current, false);
    } catch {
      updateCard(placed.id, (current) => current.type === "link" ? {
        ...current,
        preview: { ...current.preview, title: current.preview.domain, description: "Preview unavailable. The link is still saved." },
      } : current, false);
    }
  };

  const addImageFiles = async (files: FileList | File[], origin?: { x: number; y: number }) => {
    const supported = Array.from(files).filter((file) =>
      file.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|svg|ico)$/i.test(file.name),
    );
    let position = origin ?? viewportCenterGrid();
    for (const file of supported) {
      try {
        const image = await readImage(file);
        const averageAccent = await averageImageAccent(image.dataUrl);
        placeCard<ImageCard>({
          ...image,
          id: createId("image"),
          color: averageAccent ?? nextCardColor(),
          createdAt: new Date().toISOString(),
        }, position);
        position = { x: position.x + image.w, y: position.y };
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Could not add that image.");
      }
    }
  };

  const duplicateCard = (card: CanvasCard) => {
    const next = {
      ...structuredClone(card),
      id: createId(card.type),
      x: card.x + card.w,
      createdAt: new Date().toISOString(),
    } as CanvasCard;
    const position = firstFreePosition(documentRef.current.cards, { x: next.x, y: next.y }, next);
    Object.assign(next, position);
    commitCards([...documentRef.current.cards, next]);
    setSelectedId(next.id);
  };

  const deleteCard = (id: string) => {
    commitCards(documentRef.current.cards.filter((card) => card.id !== id));
    setSelectedId((selected) => (selected === id ? null : selected));
    setFocusedSheetId((focused) => (focused === id ? null : focused));
    setEditingImageLabelId((editing) => (editing === id ? null : editing));
    setEditingTextId((editing) => (editing === id ? null : editing));
  };

  const convertTextToCode = (card: TextCard) => {
    const code = plainTextFromBlocks(card.blocks.length ? card.blocks : blocksFromHtml(card.html));
    const next: CodeCard = {
      id: card.id,
      type: "code",
      x: card.x,
      y: card.y,
      w: card.w,
      h: card.h,
      color: card.color,
      createdAt: card.createdAt,
      code,
      language: "auto",
    };
    updateCard(card.id, () => next);
    setEditingTextId(null);
  };

  const convertCodeToText = (card: CodeCard) => {
    const html = htmlFromPlainText(card.code);
    const next: TextCard = {
      id: card.id,
      type: "text",
      x: card.x,
      y: card.y,
      w: card.w,
      h: card.h,
      color: card.color,
      createdAt: card.createdAt,
      html,
      blocks: blocksFromHtml(html),
    };
    updateCard(card.id, () => next);
    setEditingTextId(null);
  };

  const copyCardToClipboard = async (card: CanvasCard) => {
    try {
      if (card.type === "text") {
        await navigator.clipboard.writeText(plainTextFromBlocks(card.blocks));
      } else if (card.type === "code") {
        await navigator.clipboard.writeText(card.code);
      } else if (card.type === "link") {
        await navigator.clipboard.writeText(card.url);
      } else if (card.type === "spreadsheet") {
        await navigator.clipboard.writeText(spreadsheetToCsv(card));
      } else if (card.type === "image") {
        const blob = await imageDataUrlToPngBlob(card.dataUrl);
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      }
      setCopiedCardId(card.id);
      if (copiedTimeoutRef.current !== null) window.clearTimeout(copiedTimeoutRef.current);
      copiedTimeoutRef.current = window.setTimeout(() => {
        setCopiedCardId(null);
        copiedTimeoutRef.current = null;
      }, 1200);
    } catch {
      setNotice("Couldn't copy to clipboard.");
    }
  };

  const startCardInteraction = (event: React.PointerEvent, card: CanvasCard, type: "drag" | "resize") => {
    event.preventDefault();
    event.stopPropagation();
    const movingIds = type === "drag" && selectedIds.has(card.id) ? selectedIds : new Set([card.id]);
    setSelectedId(card.id);
    setSelectedIds(movingIds);
    if (type === "drag") setFocusedSheetId(null);
    const interactionBase = {
      button: event.button,
      cardId: card.id,
      startX: event.clientX,
      startY: event.clientY,
      origin: { x: card.x, y: card.y, w: card.w, h: card.h },
    };
    interactionRef.current = type === "drag"
      ? {
        ...interactionBase,
        type: "drag",
        groupOrigins: new Map(documentRef.current.cards
          .filter((candidate) => movingIds.has(candidate.id))
          .map((candidate) => [candidate.id, { x: candidate.x, y: candidate.y, w: candidate.w, h: candidate.h }])),
      }
      : { ...interactionBase, type: "resize" };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const finishViewport = (nextViewport: typeof viewport) => {
    const next = { ...documentRef.current, viewport: nextViewport, updatedAt: new Date().toISOString() };
    documentRef.current = next;
    onChange(next, false, false);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && (event.target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName))) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
        const card = documentRef.current.cards.find((candidate) => candidate.id === selectedId);
        if (card) {
          event.preventDefault();
          void copyCardToClipboard(card);
          return;
        }
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const shortcutTools: Partial<Record<string, Tool>> = {
        h: "select",
        t: "text",
        c: "code",
        m: "image",
        s: "spreadsheet",
        l: "link",
      };
      const shortcutTool = shortcutTools[event.key.toLowerCase()];
      if (shortcutTool) {
        event.preventDefault();
        onToolChange(shortcutTool);
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedId) deleteCard(selectedId);
      if (event.key === "Escape") {
        setFocusedSheetId(null);
        setSelectedId(null);
        setSelectedIds(new Set());
        setMarqueeSelection(false);
        onToolChange("select");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const selectedCard = document.cards.find((card) => card.id === selectedId);
  const matchingIds = useMemo(
    () => new Set(document.cards.filter((card) => cardMatchesSearch(card, search)).map((card) => card.id)),
    [document.cards, search],
  );

  const handleTextMeasure = (
    cardId: string,
    metrics: { scrollHeight: number; clientHeight: number; maxLineLength: number; lineCount: number },
  ) => {
    const card = documentRef.current.cards.find((item) => item.id === cardId);
    if (!card || card.type !== "text") return;

    const rightSlot = { x: card.x + card.w, y: card.y, w: 1, h: card.h };
    const rightIsFree = !documentRef.current.cards.some(
      (other) => other.id !== card.id && overlaps(rightSlot, other),
    );
    const lineCapacity = 34 * card.w;
    const shouldWiden = card.w < 2 && rightIsFree && metrics.maxLineLength > lineCapacity;
    const contentHeightRows = Math.ceil((metrics.scrollHeight + GRID_GAP + 32) / stride);
    const contentRows = Math.ceil(metrics.lineCount / 8);
    const targetHeight = Math.max(contentHeightRows, contentRows, card.h);
    contentMinimumsRef.current.set(card.id, {
      w: metrics.maxLineLength > 34 ? 2 : 1,
      h: Math.max(contentHeightRows, contentRows, 1),
    });
    const shouldGrowDown = targetHeight > card.h;
    if (!shouldWiden && !shouldGrowDown) return;

    const target = shouldWiden
      ? { ...card, w: card.w + 1 }
      : { ...card, h: targetHeight };
    commitCards(
      reflowCards(documentRef.current.cards, card.id, target, shouldWiden ? { x: 1, y: 0 } : { x: 0, y: 1 }),
      false,
    );
  };

  const handleCodeMeasure = (
    cardId: string,
    metrics: { contentWidth: number; contentHeight: number },
  ) => {
    const card = documentRef.current.cards.find((item) => item.id === cardId);
    if (!card || card.type !== "code") return;

    const minimumWidth = Math.max(1, Math.ceil((metrics.contentWidth + GRID_GAP) / stride));
    const minimumHeight = Math.max(1, Math.ceil((metrics.contentHeight + GRID_GAP + 42) / stride));
    contentMinimumsRef.current.set(card.id, {
      w: minimumWidth,
      h: minimumHeight,
    });
    const targetWidth = Math.max(card.w, minimumWidth);
    const targetHeight = Math.max(card.h, minimumHeight);
    if (targetWidth === card.w && targetHeight === card.h) return;

    const target = { ...card, w: targetWidth, h: targetHeight };
    commitCards(
      reflowCards(documentRef.current.cards, card.id, target, { x: targetWidth - card.w, y: targetHeight - card.h }),
      false,
    );
  };

  return (
    <div
      ref={surfaceRef}
      className={`canvas-surface tool-${tool}${interactionRef.current?.type === "pan" ? " is-panning" : ""}`}
      tabIndex={0}
      onPointerMove={(event) => {
        const surface = surfaceRef.current;
        if (!surface) return;
        const bounds = surface.getBoundingClientRect();
        lastPointerRef.current = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
        const interaction = interactionRef.current;
        if (!interaction) return;
        if (interaction.button === 2 && Math.hypot(event.clientX - interaction.startX, event.clientY - interaction.startY) >= 5) {
          suppressContextMenuRef.current = true;
        }
        if (interaction.type === "pan") {
          setViewport((current) => ({
            ...current,
            x: interaction.originX + event.clientX - interaction.startX,
            y: interaction.originY + event.clientY - interaction.startY,
          }));
          return;
        }
        if (interaction.type === "box-select") {
          if (Math.hypot(event.clientX - interaction.startX, event.clientY - interaction.startY) >= 5) {
            suppressCanvasClickRef.current = true;
          }
          const left = Math.min(interaction.startX, event.clientX) - bounds.left;
          const top = Math.min(interaction.startY, event.clientY) - bounds.top;
          const right = Math.max(interaction.startX, event.clientX) - bounds.left;
          const bottom = Math.max(interaction.startY, event.clientY) - bounds.top;
          setSelectionRect({ left, top, width: right - left, height: bottom - top });
          const worldLeft = (left - bounds.width / 2 - viewport.x) / viewport.zoom;
          const worldTop = (top - bounds.height / 2 - viewport.y) / viewport.zoom;
          const worldRight = (right - bounds.width / 2 - viewport.x) / viewport.zoom;
          const worldBottom = (bottom - bounds.height / 2 - viewport.y) / viewport.zoom;
          const nextSelection = new Set(documentRef.current.cards.filter((card) => {
            const cardLeft = card.x * stride + GRID_GAP / 2;
            const cardTop = card.y * stride + GRID_GAP / 2;
            const cardRight = cardLeft + card.w * stride - GRID_GAP;
            const cardBottom = cardTop + card.h * stride - GRID_GAP;
            return cardLeft < worldRight && cardRight > worldLeft && cardTop < worldBottom && cardBottom > worldTop;
          }).map((card) => card.id));
          setSelectedIds(nextSelection);
          setSelectedId(nextSelection.values().next().value ?? null);
          return;
        }
        const dx = Math.round((event.clientX - interaction.startX) / viewport.zoom / stride);
        const dy = Math.round((event.clientY - interaction.startY) / viewport.zoom / stride);
        let target: GridRect;
        if (interaction.type === "drag") {
          if (interaction.groupOrigins.size > 1) {
            const targets = new Map(Array.from(interaction.groupOrigins, ([id, origin]) => [
              id,
              { ...origin, x: origin.x + dx, y: origin.y + dy },
            ]));
            setPreviewCards(reflowCardGroup(documentRef.current.cards, targets, { x: dx, y: dy }));
            return;
          }
          target = { ...interaction.origin, x: interaction.origin.x + dx, y: interaction.origin.y + dy };
        } else {
          const source = documentRef.current.cards.find((card) => card.id === interaction.cardId);
          const contentMinimum = source && (source.type === "text" || source.type === "code")
            ? contentMinimumsRef.current.get(source.id)
            : undefined;
          target = {
            ...interaction.origin,
            w: Math.max(contentMinimum?.w ?? 1, interaction.origin.w + dx),
            h: Math.max(contentMinimum?.h ?? 1, interaction.origin.h + dy),
          };
        }
        setPreviewCards(reflowCards(documentRef.current.cards, interaction.cardId, target, { x: dx, y: dy }));
      }}
      onPointerUp={(event) => {
        const interaction = interactionRef.current;
        if (!interaction) return;
        if (interaction.type === "pan") finishViewport(viewport);
        else if (interaction.type !== "box-select" && previewCards && JSON.stringify(previewCards) !== JSON.stringify(documentRef.current.cards)) commitCards(previewCards);
        interactionRef.current = null;
        setPreviewCards(null);
        setSelectionRect(null);
        if (interaction.button === 2) {
          if (contextMenuTimeoutRef.current !== null) window.clearTimeout(contextMenuTimeoutRef.current);
          contextMenuTimeoutRef.current = window.setTimeout(() => { suppressContextMenuRef.current = false; }, 500);
        }
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer capture may belong to a child */ }
      }}
      onPointerCancel={() => {
        interactionRef.current = null;
        setPreviewCards(null);
        setSelectionRect(null);
      }}
      onPointerDown={(event) => {
        if (event.button === 1 || event.button === 2) {
          interactionRef.current = {
            type: "pan",
            button: event.button,
            startX: event.clientX,
            startY: event.clientY,
            originX: viewport.x,
            originY: viewport.y,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          return;
        }
        if (event.target !== event.currentTarget && !(event.target as HTMLElement).classList.contains("canvas-world")) return;
        if (tool !== "select") return;
        if (event.button === 0) {
          interactionRef.current = { type: "box-select", button: event.button, startX: event.clientX, startY: event.clientY };
          setSelectedId(null);
          setSelectedIds(new Set());
          setMarqueeSelection(true);
          setFocusedSheetId(null);
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      }}
      onContextMenu={(event) => {
        if (!suppressContextMenuRef.current) return;
        event.preventDefault();
        suppressContextMenuRef.current = false;
      }}
      onClick={(event) => {
        if (suppressCanvasClickRef.current) {
          suppressCanvasClickRef.current = false;
          return;
        }
        if (event.target !== event.currentTarget && !(event.target as HTMLElement).classList.contains("canvas-world")) return;
        if (tool === "select") {
          setSelectedId(null);
          setSelectedIds(new Set());
          setMarqueeSelection(false);
          setFocusedSheetId(null);
          return;
        }
        const bounds = event.currentTarget.getBoundingClientRect();
        const origin = {
          x: Math.floor((event.clientX - bounds.left - bounds.width / 2 - viewport.x) / viewport.zoom / stride),
          y: Math.floor((event.clientY - bounds.top - bounds.height / 2 - viewport.y) / viewport.zoom / stride),
        };
        if (tool === "text") addText(origin);
        if (tool === "code") addCode(origin);
        if (tool === "spreadsheet") {
          setSheetOrigin(origin);
          setSheetConfigOpen(true);
        }
        if (tool === "image") imageInputRef.current?.click();
        if (tool === "link") setLinkInputOpen(true);
      }}
      onWheel={(event) => {
        event.preventDefault();
        const wheelDelta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
        if (event.altKey) {
          setViewport((current) => ({ ...current, x: current.x - wheelDelta }));
        } else if (event.shiftKey) {
          setViewport((current) => ({ ...current, y: current.y - wheelDelta }));
        } else {
          const bounds = event.currentTarget.getBoundingClientRect();
          const pointerX = event.clientX - bounds.left - bounds.width / 2;
          const pointerY = event.clientY - bounds.top - bounds.height / 2;
          setViewport((current) => {
            const nextZoom = clampZoom(current.zoom * Math.exp(-wheelDelta * 0.0015));
            const ratio = nextZoom / current.zoom;
            return {
              ...current,
              zoom: nextZoom,
              x: pointerX - (pointerX - current.x) * ratio,
              y: pointerY - (pointerY - current.y) * ratio,
            };
          });
        }
      }}
      onPaste={(event) => {
        if (
          event.target instanceof HTMLElement &&
          (event.target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName))
        ) return;
        const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/") || /\.ico$/i.test(file.name));
        if (imageFiles.length) {
          event.preventDefault();
          void addImageFiles(imageFiles);
          return;
        }
        const text = event.clipboardData.getData("text/plain");
        if (!text) return;
        event.preventDefault();
        if (looksTabular(text)) addSpreadsheet(undefined, parseTable(text));
        else if (normalizeUrl(text)) void addLink(text);
        else addText(undefined, `<div>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</div>`);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        const origin = {
          x: Math.floor((event.clientX - bounds.left - bounds.width / 2 - viewport.x) / viewport.zoom / stride),
          y: Math.floor((event.clientY - bounds.top - bounds.height / 2 - viewport.y) / viewport.zoom / stride),
        };
        void addImageFiles(event.dataTransfer.files, origin);
      }}
      style={{
        "--grid-step": `${stride * viewport.zoom}px`,
        "--grid-cell": `${GRID_UNIT * viewport.zoom}px`,
        "--grid-x": `calc(50% + ${viewport.x + stride * viewport.zoom / 2}px)`,
        "--grid-y": `calc(50% + ${viewport.y + stride * viewport.zoom / 2}px)`,
      } as React.CSSProperties}
    >
      {selectionRect && <div className="canvas-selection-box" style={selectionRect} />}
      <div
        className={`canvas-world${isFocusing ? " is-focusing" : ""}${editingTextId ? " is-text-editing" : ""}`}
        style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}
      >
        {cards.map((card) => {
          const selected = selectedIds.has(card.id) || card.id === selectedId;
          const marqueeSelected = marqueeSelection && selectedIds.has(card.id);
          const sheetFocused = card.id === focusedSheetId;
          const textEditing = card.id === editingTextId;
          const imageLabelEditing = card.id === editingImageLabelId;
          const dimmed = Boolean(search.trim()) && !matchingIds.has(card.id);
          return (
            <article
              className={`grid-card card-${card.type}${selected && !marqueeSelected && !sheetFocused ? " is-selected" : ""}${marqueeSelected ? " is-group-selected" : ""}${sheetFocused ? " sheet-focused-card" : ""}${dimmed ? " is-search-dimmed" : ""}`}
              style={cardSize(card)}
              key={card.id}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                const target = event.target as HTMLElement;
                const interactive = target.closest("button, a, input, textarea, select, [contenteditable='true'], .resize-handle, .text-toolbar");
                const readOnlySheetCell = card.type === "spreadsheet" && !sheetFocused && target.closest(".sheet-cell");
                if (interactive && !readOnlySheetCell) return;
                event.stopPropagation();
                setEditingImageLabelId(null);
                setMarqueeSelection(false);
                startCardInteraction(event, card, "drag");
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                setEditingImageLabelId(null);
                if (card.type === "spreadsheet") setFocusedSheetId(card.id);
                focusCard(card);
              }}
            >
              {marqueeSelected && (
                <div
                  className="group-drag-shield"
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    setEditingImageLabelId(null);
                    startCardInteraction(event, card, "drag");
                  }}
                />
              )}
              <div className={`card-hover-tools${sheetFocused || textEditing ? " hidden" : ""}`}>
                <button className="card-tool" title="Copy" onClick={(event) => { event.stopPropagation(); void copyCardToClipboard(card); }}>{copiedCardId === card.id ? <CheckIcon size={16}/> : <CopyIcon size={16}/>}</button>
                <button className="card-tool" title="Duplicate card" onClick={(event) => { event.stopPropagation(); duplicateCard(card); }}><DuplicateIcon size={16}/></button>
                <button className="card-tool danger-tool" title="Delete card" onClick={(event) => { event.stopPropagation(); deleteCard(card.id); }}><TrashIcon size={16}/></button>
              </div>

              {card.type === "text" && (
                <TextEditor
                  html={card.html}
                  onFocus={() => setSelectedId(card.id)}
                  onActiveChange={(active) => setEditingTextId(active ? card.id : null)}
                  onConvertToCode={() => convertTextToCode(card)}
                  onChange={(html, blocks) => updateCard(card.id, (current) => current.type === "text" ? { ...current, html, blocks } : current)}
                  onMeasure={(metrics) => handleTextMeasure(card.id, metrics)}
                />
              )}
              {card.type === "code" && (
                <CodeEditor
                  code={card.code}
                  language={card.language}
                  onFocus={() => setSelectedId(card.id)}
                  onActiveChange={(active) => setEditingTextId(active ? card.id : null)}
                  onChange={(code) => updateCard(card.id, (current) => current.type === "code" ? { ...current, code } : current)}
                  onLanguageChange={(language) => updateCard(card.id, (current) => current.type === "code" ? { ...current, language } : current)}
                  onConvertToText={() => convertCodeToText(card)}
                  onMeasure={(metrics) => handleCodeMeasure(card.id, metrics)}
                />
              )}
              {card.type === "image" && (
                <div className="image-card-media">
                  <img className="image-content" src={card.dataUrl} alt={card.label || card.fileName} draggable={false} />
                  <ImageCardLabel
                    label={card.label ?? ""}
                    editing={imageLabelEditing}
                    onEdit={() => {
                      setSelectedId(card.id);
                      setEditingImageLabelId(card.id);
                    }}
                    onCommit={(label) => updateCard(card.id, (current) => current.type === "image" ? { ...current, label } : current)}
                    onDone={() => setEditingImageLabelId((editing) => editing === card.id ? null : editing)}
                  />
                </div>
              )}
              {card.type === "spreadsheet" && (
                <SpreadsheetCard card={card} focused={sheetFocused} onChange={(next) => updateCard(card.id, () => next)} />
              )}
              {card.type === "link" && (
                <div className="link-preview">
                  {card.preview.imageDataUrl && <img src={card.preview.imageDataUrl} alt="" className="link-preview-image" />}
                  <span className="link-preview-copy">
                    <span className="link-domain">{card.preview.siteName || card.preview.domain}</span>
                    <strong>{card.preview.title}</strong>
                    {card.preview.description && <span className="link-description">{card.preview.description}</span>}
                    <span className="link-url">{card.preview.domain}</span>
                  </span>
                  <button className="open-link-button" onClick={(event) => { event.stopPropagation(); void openUrl(card.url); }}>
                    Open link <ExternalIcon size={14}/>
                  </button>
                </div>
              )}

              {!sheetFocused && <button
                className="resize-handle"
                title="Resize card"
                aria-label="Resize card"
                onPointerDown={(event) => startCardInteraction(event, card, "resize")}
              />}
            </article>
          );
        })}
      </div>

      {document.cards.length === 0 && (
        <div className="empty-canvas-hint">
          <span className="empty-spark">✦</span>
          <strong>Your canvas is wide open</strong>
          <span>Choose a card below, click anywhere, or simply paste.</span>
        </div>
      )}

      <div className="canvas-zoom-controls">
        <button title="Zoom out" onClick={() => setViewport((current) => ({ ...current, zoom: clampZoom(current.zoom - 0.1) }))}><ZoomOutIcon size={16}/></button>
        <button className="zoom-value" title="Reset zoom" onClick={() => setViewport((current) => ({ ...current, zoom: 1 }))}>{Math.round(viewport.zoom * 100)}%</button>
        <button title="Zoom in" onClick={() => setViewport((current) => ({ ...current, zoom: clampZoom(current.zoom + 0.1) }))}><ZoomInIcon size={16}/></button>
      </div>

      <div className="tool-dock" role="toolbar" aria-label="Card tools">
        <button className={`dock-tool has-shortcut${tool === "select" ? " active" : ""}`} title="Select and pan (H)" onClick={() => onToolChange("select")}><PointerIcon/><span className="dock-shortcut">H</span></button>
        <span className="dock-divider"/>
        <button className={`dock-tool has-shortcut text-tool${tool === "text" ? " active" : ""}`} title="Text card (T)" onClick={() => onToolChange("text")}><TextIcon/><span className="dock-shortcut">T</span></button>
        <button className={`dock-tool has-shortcut code-tool${tool === "code" ? " active" : ""}`} title="Code card (C)" onClick={() => onToolChange("code")}><CodeIcon/><span className="dock-shortcut">C</span></button>
        <button className={`dock-tool has-shortcut image-tool${tool === "image" ? " active" : ""}`} title="Image card (M)" onClick={() => { onToolChange("image"); imageInputRef.current?.click(); }}><ImageIcon/><span className="dock-shortcut">M</span></button>
        <button className={`dock-tool has-shortcut sheet-tool${tool === "spreadsheet" ? " active" : ""}`} title="Spreadsheet card (S)" onClick={() => { onToolChange("spreadsheet"); setSheetConfigOpen(true); }}><SheetIcon/><span className="dock-shortcut">S</span></button>
        <button className={`dock-tool has-shortcut link-tool${tool === "link" ? " active" : ""}`} title="Link card (L)" onClick={() => { onToolChange("link"); setLinkInputOpen(true); }}><LinkIcon/><span className="dock-shortcut">L</span></button>
        <span className="dock-divider"/>
        <div className="dock-colors">
          {CARD_COLORS.map((cardColor) => (
            <button
              key={cardColor}
              className={`color-dot${color === cardColor ? " active" : ""}`}
              style={{ backgroundColor: cardColor }}
              title={`Use ${cardColor}`}
              onClick={() => {
                onColorChange(cardColor);
                if (selectedCard) updateCard(selectedCard.id, (card) => ({ ...card, color: cardColor } as CanvasCard));
              }}
            >
              {color === cardColor && <CheckIcon size={13}/>} 
            </button>
          ))}
        </div>
        <span className="dock-divider"/>
        <button
          className={`dock-tool random-color-toggle${randomColors ? " active" : ""}`}
          title={randomColors ? "Use the selected color for new cards" : "Use a random color for every new card"}
          aria-pressed={randomColors}
          onClick={() => onRandomColorsChange(!randomColors)}
        ><DiceIcon size={18}/></button>
      </div>

      {linkInputOpen && (
        <form className="link-entry-popover" onSubmit={(event) => { event.preventDefault(); void addLink(linkValue); }}>
          <LinkIcon size={18}/>
          <input autoFocus value={linkValue} onChange={(event) => setLinkValue(event.currentTarget.value)} placeholder="Paste a web address…" />
          <button type="submit">Add link</button>
        </form>
      )}

      {sheetConfigOpen && (
        <form className="sheet-create-popover" onSubmit={(event) => { event.preventDefault(); addSpreadsheet(sheetOrigin); }}>
          <SheetIcon size={18}/>
          <label>Rows<input type="number" min="1" max="50" value={sheetRows} onChange={(event) => setSheetRows(Math.max(1, Math.min(50, Number(event.currentTarget.value) || 1)))}/></label>
          <label>Columns<input type="number" min="1" max="26" value={sheetColumns} onChange={(event) => setSheetColumns(Math.max(1, Math.min(26, Number(event.currentTarget.value) || 1)))}/></label>
          <button type="submit">Create sheet</button>
        </form>
      )}

      {notice && <button className="canvas-notice" onClick={() => setNotice(null)}>{notice}</button>}
      <input
        ref={imageInputRef}
        type="file"
        hidden
        multiple
        accept=".jpg,.jpeg,.png,.webp,.gif,.svg,.ico,image/jpeg,image/png,image/webp,image/gif,image/svg+xml,image/x-icon"
        onChange={(event) => {
          if (event.currentTarget.files) void addImageFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
    </div>
  );
}
