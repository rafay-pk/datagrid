import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { CanvasWorkspace } from "./CanvasWorkspace";
import bindersIcon from "./assets/binders.svg";
import {
  chooseLibraryFolder,
  connectRepository,
  createCanvas,
  deleteCanvas,
  duplicateCanvas,
  getGitEnvironment,
  getRepositoryStatus,
  listCanvases,
  loadCanvas,
  openGitHubNewRepository,
  pushPendingCommits,
  renameCanvas,
  revealLibrary,
  saveCanvas,
  syncRepository,
  type GitEnvironment,
  type RepositoryStatus,
} from "./api";
import {
  ChevronIcon,
  CopyIcon,
  EditIcon,
  FolderIcon,
  GridIcon,
  MoreIcon,
  MoonIcon,
  PlusIcon,
  RedoIcon,
  SearchIcon,
  SunIcon,
  TransparencyIcon,
  TrashIcon,
  UndoIcon,
  XIcon,
} from "./icons";
import {
  CARD_COLORS,
  FONT_OPTIONS,
  type CanvasDocument,
  type CanvasFile,
  type OpenCanvas,
  type SessionState,
  type Theme,
  type Tool,
} from "./types";
import "./styles.css";

const SESSION_KEY = "datagrid-session-v1";
const GITHUB_SYNC_INTERVAL_MS = 120_000;
const CANVAS_EMOJIS = ["🗂️", "📝", "💡", "🎯", "📚", "🧠", "🧪", "🎨", "🚀", "🌱", "⭐", "❤️", "🔥", "📌", "🏠", "💼"];
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function firstGrapheme(value: string): string {
  return graphemeSegmenter.segment(value.trim())[Symbol.iterator]().next().value?.segment ?? "";
}

const defaultSession: SessionState = {
  libraryFolder: "",
  openPaths: [],
  activePath: null,
  theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  font: "Figtree Variable",
  uiScale: 1,
  sidebarCollapsed: false,
  randomColors: false,
  showTransparencyGrid: true,
};

function loadSession(): SessionState {
  try {
    return { ...defaultSession, ...JSON.parse(localStorage.getItem(SESSION_KEY) ?? "{}") };
  } catch {
    return defaultSession;
  }
}

function fileTime(value: string): string {
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && numeric > 1_000_000
    ? new Date(numeric * 1000)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently edited";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return `Today, ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function savedContentKey(document: CanvasDocument): string {
  return JSON.stringify([document.name, document.emoji, document.accent, document.font, document.cards]);
}

interface HistoryState {
  past: CanvasDocument[];
  future: CanvasDocument[];
}

function repositoryDisplayName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "Repository";
}

interface CanvasDetailsDialogProps {
  mode: "new" | "edit";
  icon: ReactNode;
  name: string;
  emoji: string;
  submitting: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  onNameChange: (name: string) => void;
  onEmojiChange: (emoji: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

function CanvasDetailsDialog({
  mode,
  icon,
  name,
  emoji,
  submitting,
  inputRef,
  onNameChange,
  onEmojiChange,
  onCancel,
  onSubmit,
}: CanvasDetailsDialogProps) {
  const titleId = `${mode}-canvas-dialog-title`;
  return (
    <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <form
        className="small-dialog canvas-details-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
        onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}
      >
        <span className="dialog-icon">{icon}</span>
        <h2 id={titleId}>{mode === "new" ? "New canvas" : "Edit canvas"}</h2>
        <p>Set the title and icon for this canvas.</p>
        <label className="dialog-field-label" htmlFor={`${mode}-canvas-name`}>Title</label>
        <input
          id={`${mode}-canvas-name`}
          ref={inputRef}
          autoFocus
          value={name}
          onChange={(event) => onNameChange(event.currentTarget.value)}
          placeholder="Canvas name"
          aria-label="Canvas name"
          maxLength={100}
          disabled={submitting}
        />
        <span className="dialog-field-label">Icon</span>
        <div className="canvas-emoji-options" aria-label="Canvas icon">
          {CANVAS_EMOJIS.map((option) => (
            <button
              type="button"
              key={option}
              className={emoji === option ? "active" : ""}
              aria-label={`Use ${option} icon`}
              aria-pressed={emoji === option}
              onClick={() => onEmojiChange(option)}
              disabled={submitting}
            >
              {option}
            </button>
          ))}
        </div>
        <label className="custom-emoji-field">
          <span>Custom icon</span>
          <input
            value={emoji}
            onChange={(event) => onEmojiChange(firstGrapheme(event.currentTarget.value))}
            aria-label="Custom canvas icon"
            disabled={submitting}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={submitting}>Cancel</button>
          <button type="submit" className="primary-action compact" disabled={!name.trim() || submitting}>
            {submitting ? "Saving…" : mode === "new" ? "Create canvas" : "Save changes"}
          </button>
        </div>
      </form>
    </div>
  );
}

type FileSyncPhase = "saving" | "queued" | "uploading" | "synced" | "error";

interface FileSyncItem {
  path: string;
  name: string;
  phase: FileSyncPhase;
}

function fileSyncLabel(phase: FileSyncPhase): string {
  if (phase === "saving") return "Saving locally";
  if (phase === "queued") return "Queued";
  if (phase === "uploading") return "Uploading";
  if (phase === "synced") return "Synced";
  return "Retry needed";
}

export default function App() {
  const initialSession = useMemo(loadSession, []);
  const [libraryFolder, setLibraryFolder] = useState(initialSession.libraryFolder);
  const [files, setFiles] = useState<CanvasFile[]>([]);
  const [openCanvases, setOpenCanvases] = useState<OpenCanvas[]>([]);
  const [activePath, setActivePath] = useState<string | null>(initialSession.activePath);
  const [theme, setTheme] = useState<Theme>(initialSession.theme);
  const [font, setFont] = useState(initialSession.font);
  const [uiScale, setUiScale] = useState(initialSession.uiScale);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSession.sidebarCollapsed);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState<string>(CARD_COLORS[0]);
  const [randomColors, setRandomColors] = useState(Boolean(initialSession.randomColors));
  const [showTransparencyGrid, setShowTransparencyGrid] = useState(initialSession.showTransparencyGrid !== false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [newCanvasOpen, setNewCanvasOpen] = useState(false);
  const [newCanvasName, setNewCanvasName] = useState("");
  const [newCanvasEmoji, setNewCanvasEmoji] = useState("🗂️");
  const [newCanvasSubmitting, setNewCanvasSubmitting] = useState(false);
  const [renamingFile, setRenamingFile] = useState<CanvasFile | null>(null);
  const [renameCanvasName, setRenameCanvasName] = useState("");
  const [renameCanvasEmoji, setRenameCanvasEmoji] = useState("🗂️");
  const [renameSubmitting, setRenameSubmitting] = useState(false);
  const [loading, setLoading] = useState(Boolean(libraryFolder));
  const [error, setError] = useState<string | null>(null);
  const [gitEnvironment, setGitEnvironment] = useState<GitEnvironment | null>(null);
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [connectingRepository, setConnectingRepository] = useState(false);
  const [repositorySetupFolder, setRepositorySetupFolder] = useState<string | null>(null);
  const [repositorySetupFolderEmpty, setRepositorySetupFolderEmpty] = useState(true);
  const [repositoryStatus, setRepositoryStatus] = useState<RepositoryStatus | null>(null);
  const [repositoryMenuOpen, setRepositoryMenuOpen] = useState(false);
  const [fileSyncItems, setFileSyncItems] = useState<FileSyncItem[]>([]);
  const repositoryStatusRef = useRef<RepositoryStatus | null>(null);
  const syncInFlightRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const tabStripRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const [canScrollTabsLeft, setCanScrollTabsLeft] = useState(false);
  const [canScrollTabsRight, setCanScrollTabsRight] = useState(false);

  useEffect(() => {
    void getGitEnvironment()
      .then(setGitEnvironment)
      .catch(() => setGitEnvironment({ available: false }));
  }, []);

  useEffect(() => {
    repositoryStatusRef.current = repositoryStatus;
  }, [repositoryStatus]);

  const updateTabScrollState = useCallback(() => {
    const strip = tabStripRef.current;
    if (!strip) return;
    setCanScrollTabsLeft(strip.scrollLeft > 2);
    setCanScrollTabsRight(strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2);
  }, []);

  const tabLayoutKey = openCanvases.map((canvas) => `${canvas.path}:${canvas.document.name}`).join("|");

  useEffect(() => {
    const strip = tabStripRef.current;
    if (!strip) return;
    const frame = window.requestAnimationFrame(updateTabScrollState);
    const observer = new ResizeObserver(updateTabScrollState);
    observer.observe(strip);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [tabLayoutKey, updateTabScrollState]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      activeTabRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      updateTabScrollState();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activePath, updateTabScrollState]);

  const scrollTabs = (direction: -1 | 1) => {
    const strip = tabStripRef.current;
    if (!strip) return;
    strip.scrollBy({ left: direction * Math.max(180, strip.clientWidth * 0.7), behavior: "smooth" });
  };

  useEffect(() => {
    setFileSyncItems([]);
  }, [libraryFolder]);

  useEffect(() => {
    if (!renamingFile) return;
    const frame = window.requestAnimationFrame(() => renameInputRef.current?.select());
    return () => window.cancelAnimationFrame(frame);
  }, [renamingFile]);

  const histories = useRef(new Map<string, HistoryState>());
  const canvasesRef = useRef(openCanvases);

  useEffect(() => {
    canvasesRef.current = openCanvases;
  }, [openCanvases]);

  const refreshFiles = useCallback(async () => {
    if (!libraryFolder) return;
    try {
      setFiles(await listCanvases(libraryFolder));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [libraryFolder]);

  const markFileSync = useCallback((path: string, name: string, phase: FileSyncPhase) => {
    setFileSyncItems((current) => [
      ...current.filter((item) => item.path !== path),
      { path, name, phase },
    ].slice(-5));
  }, []);

  const showQueuedSync = useCallback(() => {
    setRepositoryStatus((current) => ({
      state: "local",
      message: "Changes queued — GitHub sync runs every 2 minutes",
      ahead: current?.ahead ?? 0,
      behind: current?.behind ?? 0,
      latestCommit: current?.latestCommit,
      latestCommitAt: current?.latestCommitAt,
    }));
  }, []);

  const openFile = useCallback(async (file: CanvasFile | string) => {
    const path = typeof file === "string" ? file : file.path;
    if (canvasesRef.current.some((canvas) => canvas.path === path)) {
      setActivePath(path);
      return;
    }
    try {
      const document = await loadCanvas(path);
      const openCanvas: OpenCanvas = { path, document, dirty: false, saving: false };
      setOpenCanvases((current) => [...current, openCanvas]);
      canvasesRef.current = [...canvasesRef.current, openCanvas];
      histories.current.set(path, { past: [], future: [] });
      setActivePath(path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    if (!libraryFolder) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const connection = await connectRepository(libraryFolder);
        if (connection.needsSetup) {
          if (!cancelled) {
            setRepositorySetupFolder(connection.folder);
            setRepositorySetupFolderEmpty(connection.folderEmpty);
            setLibraryFolder("");
            setOpenCanvases([]);
            canvasesRef.current = [];
            setActivePath(null);
          }
          return;
        }
        const nextFiles = await listCanvases(libraryFolder);
        if (cancelled) return;
        setFiles(nextFiles);
        const available = new Set(nextFiles.map((file) => file.path));
        const restored = initialSession.openPaths.filter((path) => available.has(path));
        for (const path of restored) await openFile(path);
        if (!restored.length && nextFiles[0]) await openFile(nextFiles[0]);
        if (cancelled) return;
        setLoading(false);

        void (async () => {
          setRepositoryStatus((current) => ({
            state: "syncing",
            message: "Checking GitHub for updates…",
            ahead: current?.ahead ?? 0,
            behind: current?.behind ?? 0,
            latestCommit: current?.latestCommit,
            latestCommitAt: current?.latestCommitAt,
          }));
          try {
            const status = await syncRepository(libraryFolder);
            if (cancelled) return;
            setRepositoryStatus(status);

            const syncedFiles = await listCanvases(libraryFolder);
            if (cancelled) return;
            setFiles(syncedFiles);
            const syncedPaths = new Set(syncedFiles.map((file) => file.path));
            const cleanCanvases = canvasesRef.current.filter((canvas) => !canvas.dirty && !canvas.saving && syncedPaths.has(canvas.path));
            const refreshedDocuments = new Map<string, CanvasDocument>();
            for (const canvas of cleanCanvases) {
              refreshedDocuments.set(canvas.path, await loadCanvas(canvas.path));
            }
            if (cancelled) return;
            const refreshedPaths: string[] = [];
            const refreshedCanvases = canvasesRef.current
              .filter((canvas) => syncedPaths.has(canvas.path) || canvas.dirty || canvas.saving)
              .map((canvas) => {
                const document = refreshedDocuments.get(canvas.path);
                if (!document || canvas.dirty || canvas.saving) return canvas;
                refreshedPaths.push(canvas.path);
                return { ...canvas, document };
              });
            for (const path of refreshedPaths) histories.current.set(path, { past: [], future: [] });
            canvasesRef.current = refreshedCanvases;
            setOpenCanvases(refreshedCanvases);
            setActivePath((current) => current && refreshedCanvases.some((canvas) => canvas.path === current)
              ? current
              : refreshedCanvases[0]?.path ?? null);
            if (!refreshedCanvases.length && syncedFiles[0]) await openFile(syncedFiles[0]);
          } catch (reason) {
            if (cancelled) return;
            try {
              const local = await getRepositoryStatus(libraryFolder);
              setRepositoryStatus(local.state === "local" ? local : {
                ...local,
                state: "error",
                message: "GitHub unavailable — working from the local repository",
              });
            } catch {
              setRepositoryStatus({
                state: "error",
                message: "GitHub unavailable — local status could not be read",
                ahead: 0,
                behind: 0,
              });
            }
            setError(`Couldn’t sync the repository; the local copy remains open. ${reason instanceof Error ? reason.message : String(reason)}`);
          }
        })();
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [initialSession.openPaths, libraryFolder, openFile]);

  const retryPendingPush = useCallback(async (showErrors = true) => {
    if (!libraryFolder || syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    const current = repositoryStatusRef.current;
    setRepositoryStatus({
      state: "syncing",
      message: "Uploading queued canvas changes…",
      ahead: current?.ahead ?? 0,
      behind: current?.behind ?? 0,
      latestCommit: current?.latestCommit,
      latestCommitAt: current?.latestCommitAt,
    });
    setFileSyncItems((items) => items.map((item) => item.phase === "synced" ? item : { ...item, phase: "uploading" }));
    try {
      const nextStatus = await pushPendingCommits(libraryFolder);
      setRepositoryStatus(nextStatus);
      const completed = nextStatus.state === "synced" || nextStatus.state === "ready";
      setFileSyncItems((items) => items.map((item) => item.phase === "uploading"
        ? { ...item, phase: completed ? "synced" : "error" }
        : item));
    } catch (reason) {
      setFileSyncItems((items) => items.map((item) => item.phase === "uploading" ? { ...item, phase: "error" } : item));
      try {
        const local = await getRepositoryStatus(libraryFolder);
        setRepositoryStatus(local.state === "local" ? local : {
          ...local,
          state: "error",
          message: "GitHub is unreachable — changes remain safe locally",
        });
      } catch {
        setRepositoryStatus({
          state: "error",
          message: "GitHub is unreachable — changes remain safe locally",
          ahead: current?.ahead ?? 0,
          behind: current?.behind ?? 0,
          latestCommit: current?.latestCommit,
          latestCommitAt: current?.latestCommitAt,
        });
      }
      if (showErrors) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      syncInFlightRef.current = false;
    }
  }, [libraryFolder]);

  useEffect(() => {
    if (!libraryFolder) return;
    const hasPendingFiles = fileSyncItems.some((item) => item.phase === "queued" || item.phase === "error");
    if (!hasPendingFiles) return;
    const timer = window.setTimeout(() => {
      const localSaveInProgress = canvasesRef.current.some((canvas) => canvas.dirty || canvas.saving);
      if (!localSaveInProgress) void retryPendingPush(false);
    }, GITHUB_SYNC_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [fileSyncItems, libraryFolder, retryPendingPush]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.transparencyGrid = showTransparencyGrid ? "visible" : "hidden";
    document.documentElement.style.setProperty("--ui-scale", String(uiScale));
    document.documentElement.style.setProperty("--app-font", `"${font}", sans-serif`);
    const session: SessionState = {
      libraryFolder,
      openPaths: openCanvases.map((canvas) => canvas.path),
      activePath,
      theme,
      font,
      uiScale,
      sidebarCollapsed,
      randomColors,
      showTransparencyGrid,
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }, [activePath, font, libraryFolder, openCanvases, randomColors, showTransparencyGrid, sidebarCollapsed, theme, uiScale]);

  const saveCanvasNow = useCallback(async (path: string) => {
    const canvas = canvasesRef.current.find((item) => item.path === path);
    if (!canvas?.dirty || canvas.saving) return;
    markFileSync(path, canvas.document.name, "saving");
    const documentToSave = structuredClone(canvas.document);
    const contentKeyToSave = savedContentKey(documentToSave);
    const savingState = canvasesRef.current.map((item) => item.path === path ? { ...item, saving: true } : item);
    canvasesRef.current = savingState;
    setOpenCanvases(savingState);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      const result = await saveCanvas(path, documentToSave);
      const latest = canvasesRef.current.find((item) => item.path === path);
      const stillDirty = latest ? savedContentKey(latest.document) !== contentKeyToSave : false;
      const savedAt = new Date().toISOString();
      const savedState = canvasesRef.current.map((item) => item.path === path
        ? { ...item, dirty: stillDirty, saving: false, lastSavedAt: savedAt }
        : item);
      canvasesRef.current = savedState;
      setOpenCanvases(savedState);
      setRepositoryStatus((current) => ({
        ...result.status,
        message: "Changes queued — GitHub sync runs every 2 minutes",
        latestCommit: result.status.latestCommit ?? current?.latestCommit,
        latestCommitAt: result.status.latestCommitAt ?? current?.latestCommitAt,
      }));
      markFileSync(path, documentToSave.name, "queued");
      if (result.warning) setError(result.warning);
      setFiles((current) => current.map((file) => file.path === path
        ? { ...file, name: documentToSave.name, modifiedAt: savedAt, emoji: documentToSave.emoji }
        : file));
    } catch (reason) {
      const failedState = canvasesRef.current.map((item) => item.path === path ? { ...item, saving: false } : item);
      canvasesRef.current = failedState;
      setOpenCanvases(failedState);
      markFileSync(path, canvas.document.name, "error");
      setError(`Couldn’t save ${canvas.document.name}: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }, [markFileSync]);

  useEffect(() => {
    if (!openCanvases.some((canvas) => canvas.dirty && !canvas.saving)) return;
    const timer = window.setTimeout(() => {
      for (const canvas of canvasesRef.current) {
        if (canvas.dirty && !canvas.saving) void saveCanvasNow(canvas.path);
      }
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [openCanvases, saveCanvasNow]);

  const activeCanvas = openCanvases.find((canvas) => canvas.path === activePath) ?? null;
  const history = activePath ? histories.current.get(activePath) : undefined;
  const canUndo = Boolean(history?.past.length);
  const canRedo = Boolean(history?.future.length);

  const updateActiveDocument = (next: CanvasDocument, recordHistory = true, markDirty = true) => {
    if (!activePath) return;
    const currentActive = canvasesRef.current.find((canvas) => canvas.path === activePath);
    if (!currentActive) return;
    if (recordHistory) {
      const state = histories.current.get(activePath) ?? { past: [], future: [] };
      state.past.push(structuredClone(currentActive.document));
      if (state.past.length > 100) state.past.shift();
      state.future = [];
      histories.current.set(activePath, state);
    }
    const changed = canvasesRef.current.map((canvas) => canvas.path === activePath
      ? { ...canvas, document: next, dirty: markDirty ? true : canvas.dirty }
      : canvas);
    canvasesRef.current = changed;
    setOpenCanvases(changed);
    if (markDirty) {
      markFileSync(activePath, next.name, "saving");
      showQueuedSync();
    }
  };

  const undo = () => {
    if (!activePath || !activeCanvas) return;
    const state = histories.current.get(activePath);
    const previous = state?.past.pop();
    if (!state || !previous) return;
    state.future.push(structuredClone(activeCanvas.document));
    histories.current.set(activePath, state);
    updateActiveDocument(previous, false);
  };

  const redo = () => {
    if (!activePath || !activeCanvas) return;
    const state = histories.current.get(activePath);
    const next = state?.future.pop();
    if (!state || !next) return;
    state.past.push(structuredClone(activeCanvas.document));
    histories.current.set(activePath, state);
    updateActiveDocument(next, false);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        setNewCanvasOpen(true);
      } else if (event.key.toLowerCase() === "w") {
        event.preventDefault();
        if (activePath) closeTab(activePath);
      } else if (event.key === "Tab") {
        event.preventDefault();
        const tabs = canvasesRef.current;
        if (!tabs.length) return;
        const currentIndex = Math.max(0, tabs.findIndex((canvas) => canvas.path === activePath));
        const direction = event.shiftKey ? -1 : 1;
        const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
        setActivePath(tabs[nextIndex].path);
      } else if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (activePath) void saveCanvasNow(activePath);
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setUiScale((value) => Math.min(1.4, Math.round((value + 0.1) * 10) / 10));
      } else if (event.key === "-") {
        event.preventDefault();
        setUiScale((value) => Math.max(0.8, Math.round((value - 0.1) * 10) / 10));
      } else if (event.key === "0") {
        event.preventDefault();
        setUiScale(1);
      } else if (event.key.toLowerCase() === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey)) {
        event.preventDefault();
        redo();
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const activateRepository = async (folder: string, remoteUrl?: string) => {
    setConnectingRepository(true);
    try {
      const connected = await connectRepository(folder, remoteUrl);
      if (connected.needsSetup) {
        setLibraryFolder("");
        setRepositorySetupFolder(connected.folder);
        setRepositorySetupFolderEmpty(connected.folderEmpty);
        setOpenCanvases([]);
        canvasesRef.current = [];
        setActivePath(null);
        setError(null);
        return;
      }
      setLibraryFolder(connected.folder);
      setRepositorySetupFolder(null);
      setRepositoryStatus(null);
      setOpenCanvases([]);
      canvasesRef.current = [];
      setActivePath(null);
      if (connected.warning) setError(connected.warning);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setConnectingRepository(false);
    }
  };

  const selectFolder = async () => {
    const selected = await chooseLibraryFolder();
    if (!selected) return;
    await activateRepository(selected);
  };

  const cloneRepository = async () => {
    const remote = repositoryUrl.trim();
    if (!remote) {
      setError("Enter the URL of your private GitHub repository.");
      return;
    }
    const selected = repositorySetupFolder && repositorySetupFolderEmpty
      ? repositorySetupFolder
      : await chooseLibraryFolder();
    if (!selected) return;
    await activateRepository(selected, remote);
  };

  const createPrivateRepository = async () => {
    try {
      await openGitHubNewRepository();
    } catch (reason) {
      setError(`Couldn’t open GitHub: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  };

  const addCanvas = async () => {
    const name = newCanvasName.trim() || "Untitled canvas";
    const emoji = firstGrapheme(newCanvasEmoji) || "🗂️";
    setNewCanvasSubmitting(true);
    try {
      const file = await createCanvas(libraryFolder, name, emoji);
      if (file.warning) setError(file.warning);
      setNewCanvasName("");
      setNewCanvasEmoji("🗂️");
      setNewCanvasOpen(false);
      markFileSync(file.path, file.name, "queued");
      showQueuedSync();
      await refreshFiles();
      await openFile(file);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setNewCanvasSubmitting(false);
    }
  };

  const copyRepositoryPath = async () => {
    try {
      await navigator.clipboard.writeText(libraryFolder);
      setRepositoryMenuOpen(false);
    } catch (reason) {
      setError(`Couldn’t copy the repository path: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  };

  const closeNewCanvasDialog = () => {
    if (newCanvasSubmitting) return;
    setNewCanvasOpen(false);
    setNewCanvasName("");
    setNewCanvasEmoji("🗂️");
  };

  const closeTab = (path: string) => {
    const closing = openCanvases.find((canvas) => canvas.path === path);
    if (closing?.dirty && !window.confirm(`Close “${closing.document.name}” without saving?`)) return;
    const index = openCanvases.findIndex((canvas) => canvas.path === path);
    const next = openCanvases.filter((canvas) => canvas.path !== path);
    setOpenCanvases(next);
    canvasesRef.current = next;
    if (activePath === path) setActivePath(next[Math.max(0, index - 1)]?.path ?? next[0]?.path ?? null);
  };

  const openRenameDialog = (file: CanvasFile) => {
    const openCanvas = canvasesRef.current.find((canvas) => canvas.path === file.path);
    setRenamingFile(file);
    setRenameCanvasName(file.name);
    setRenameCanvasEmoji(openCanvas?.document.emoji || file.emoji || "🗂️");
  };

  const closeRenameDialog = () => {
    if (renameSubmitting) return;
    setRenamingFile(null);
    setRenameCanvasName("");
    setRenameCanvasEmoji("🗂️");
  };

  const handleRename = async () => {
    const file = renamingFile;
    const name = renameCanvasName.trim();
    if (!file || !name) return;
    const openCanvas = canvasesRef.current.find((canvas) => canvas.path === file.path);
    const currentEmoji = openCanvas?.document.emoji || file.emoji || "🗂️";
    const emoji = firstGrapheme(renameCanvasEmoji) || "🗂️";
    const nameChanged = name !== file.name;
    const emojiChanged = emoji !== currentEmoji;
    if (!nameChanged && !emojiChanged) {
      closeRenameDialog();
      return;
    }
    setRenameSubmitting(true);
    try {
      const renamed = nameChanged ? await renameCanvas(file.path, name) : file;
      if (renamed.warning) setError(renamed.warning);
      const updatedCanvases = canvasesRef.current.map((canvas) => canvas.path === file.path ? {
        ...canvas,
        path: renamed.path,
        dirty: emojiChanged ? true : canvas.dirty,
        document: {
          ...canvas.document,
          name: renamed.name,
          emoji,
          updatedAt: new Date().toISOString(),
        },
      } : canvas);
      canvasesRef.current = updatedCanvases;
      setOpenCanvases(updatedCanvases);

      if (!openCanvas && emojiChanged) {
        const document = await loadCanvas(renamed.path);
        const result = await saveCanvas(renamed.path, {
          ...document,
          name: renamed.name,
          emoji,
          updatedAt: new Date().toISOString(),
        });
        setRepositoryStatus(result.status);
        if (result.warning) setError(result.warning);
      }
      if (renamed.path !== file.path) {
        histories.current.set(renamed.path, histories.current.get(file.path) ?? { past: [], future: [] });
        histories.current.delete(file.path);
        setFileSyncItems((items) => items.filter((item) => item.path !== file.path));
      }
      if (activePath === file.path) setActivePath(renamed.path);
      setRenamingFile(null);
      setRenameCanvasName("");
      setRenameCanvasEmoji("🗂️");
      markFileSync(renamed.path, renamed.name, emojiChanged && openCanvas ? "saving" : "queued");
      showQueuedSync();
      await refreshFiles();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRenameSubmitting(false);
    }
  };

  const handleDuplicate = async (file: CanvasFile) => {
    try {
      const copy = await duplicateCanvas(file.path);
      if (copy.warning) setError(copy.warning);
      markFileSync(copy.path, copy.name, "queued");
      showQueuedSync();
      await refreshFiles();
      await openFile(copy);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const handleDelete = async (file: CanvasFile) => {
    if (!window.confirm(`Move “${file.name}” to Datagrid’s recovery folder?`)) return;
    try {
      const result = await deleteCanvas(file.path);
      setRepositoryStatus((current) => ({
        ...result.status,
        message: "Changes queued — GitHub sync runs every 2 minutes",
        latestCommit: result.status.latestCommit ?? current?.latestCommit,
        latestCommitAt: result.status.latestCommitAt ?? current?.latestCommitAt,
      }));
      markFileSync(file.path, file.name, "queued");
      if (result.warning) setError(result.warning);
      closeTab(file.path);
      await refreshFiles();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const applyFont = (nextFont: string) => {
    setFont(nextFont);
    const changed = canvasesRef.current.map((canvas) => ({
      ...canvas,
      document: { ...canvas.document, font: nextFont, updatedAt: new Date().toISOString() },
      dirty: true,
    }));
    canvasesRef.current = changed;
    setOpenCanvases(changed);
    for (const canvas of changed) markFileSync(canvas.path, canvas.document.name, "saving");
    showQueuedSync();
  };

  if (!libraryFolder) {
    return (
      <main className="onboarding-shell">
        <div className="onboarding-glow glow-one"/>
        <div className="onboarding-glow glow-two"/>
        <section className={`onboarding-card${gitEnvironment?.available ? " setup-ready" : ""}`}>
          <div className="onboarding-intro">
            <div className="brand-mark large-mark"><img src={bindersIcon} alt=""/></div>
            <span className="eyebrow">Welcome to Datagrid</span>
            <h1>Your private canvas<br/>repository.</h1>
          {gitEnvironment === null ? (
            <p>Checking for Git…</p>
          ) : !gitEnvironment.available ? (
            <div className="git-required">
              <p>Datagrid uses Git to keep your canvases in a private GitHub repository. Install Git, then restart Datagrid.</p>
              <a className="primary-action" href="https://git-scm.com/downloads" target="_blank" rel="noreferrer">Install Git</a>
            </div>
          ) : (
            <>
              <p>{repositorySetupFolder
                ? "This folder is not a Git repository yet. Create a private repository on GitHub, then Datagrid will connect it for you."
                : "Create a private repository in GitHub, then connect Datagrid to its local clone."}</p>
              {repositorySetupFolder && (
                <div className={`setup-folder${repositorySetupFolderEmpty ? "" : " has-files"}`}>
                  <FolderIcon size={16}/>
                  <div>
                    <strong>Selected folder</strong>
                    <span title={repositorySetupFolder}>{repositorySetupFolder}</span>
                    {!repositorySetupFolderEmpty && <em>This folder contains files, so choose an empty folder when cloning.</em>}
                  </div>
                </div>
              )}
            </>
          )}
          </div>
          {gitEnvironment?.available && (
            <>
              <div className="repository-steps">
                <section className="repository-step">
                  <span className="step-number">1</span>
                  <div>
                    <strong>Create the repository</strong>
                    <span>GitHub opens with private visibility already selected.</span>
                    <button className="secondary-action" type="button" onClick={() => void createPrivateRepository()}>
                      Create private repository on GitHub
                    </button>
                  </div>
                </section>
                <section className="repository-step">
                  <span className="step-number">2</span>
                  <div>
                    <strong>Clone and use it</strong>
                    <span>{repositorySetupFolder && repositorySetupFolderEmpty
                      ? "Copy the repository’s HTTPS URL. Datagrid will clone it into the selected folder."
                      : "Copy the repository’s HTTPS URL from GitHub and paste it below."}</span>
                    <form className="repository-connect" onSubmit={(event) => { event.preventDefault(); void cloneRepository(); }}>
                      <input
                        value={repositoryUrl}
                        onChange={(event) => setRepositoryUrl(event.currentTarget.value)}
                        placeholder="https://github.com/you/datagrid-canvases.git"
                        aria-label="Private GitHub repository URL"
                      />
                      <button className="primary-action" type="submit" disabled={connectingRepository}>
                        <GridIcon/> {connectingRepository
                          ? "Connecting…"
                          : repositorySetupFolder && repositorySetupFolderEmpty
                            ? "Clone into selected folder"
                            : "Choose empty folder and clone"}
                      </button>
                    </form>
                  </div>
                </section>
              </div>
              <div className="onboarding-alternative">
                <span className="repository-divider">or</span>
                <button className="secondary-action" disabled={connectingRepository} onClick={() => void selectFolder()}>
                  <FolderIcon/> {repositorySetupFolder ? "Choose another folder" : "Open an existing clone"}
                </button>
                <span className="privacy-note">Markdown, CSV, and original images—versioned in your repository.</span>
              </div>
            </>
          )}
        </section>
        {error && <div className="error-toast"><span>{error}</span><button onClick={() => setError(null)}><XIcon size={16}/></button></div>}
      </main>
    );
  }

  return (
    <main className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <header className="topbar">
        <div className="brand-zone">
          <button className="brand-button" title={sidebarCollapsed ? "Show canvas library" : "Hide canvas library"} onClick={() => setSidebarCollapsed((value) => !value)}>
            <span className="brand-mark"><img src={bindersIcon} alt=""/></span>
            {!sidebarCollapsed && <strong>Datagrid</strong>}
          </button>
        </div>

        <div className="tab-region">
          {canScrollTabsLeft && (
            <button className="tab-scroll-button left" title="Scroll tabs left" onClick={() => scrollTabs(-1)}>
              <ChevronIcon size={15}/>
            </button>
          )}
          <div
            ref={tabStripRef}
            className="tab-strip"
            role="tablist"
            onScroll={updateTabScrollState}
            onWheel={(event) => {
              if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
              event.currentTarget.scrollLeft += event.deltaY;
            }}
          >
            {openCanvases.map((canvas) => (
              <button
                ref={canvas.path === activePath ? activeTabRef : undefined}
                key={canvas.path}
                role="tab"
                aria-selected={canvas.path === activePath}
                className={`canvas-tab${canvas.path === activePath ? " active" : ""}`}
                onClick={() => setActivePath(canvas.path)}
              >
                <span className="tab-emoji">{canvas.document.emoji || "🗂️"}</span>
                <span className="tab-name">{canvas.document.name}</span>
                <span className={`tab-save-state${canvas.saving || canvas.dirty ? " unsaved" : " saved"}`}/>
                {canvas.saving && <span className="saving-spinner"/>}
                <span className="tab-close" role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); closeTab(canvas.path); }}><XIcon size={13}/></span>
              </button>
            ))}
            <button className="new-tab-button" title="New canvas" onClick={() => setNewCanvasOpen(true)}><PlusIcon size={17}/></button>
          </div>
          {canScrollTabsRight && (
            <button className="tab-scroll-button right" title="Scroll tabs right" onClick={() => scrollTabs(1)}>
              <ChevronIcon size={15}/>
            </button>
          )}
        </div>

        <div className="topbar-actions">
          <button className="top-icon-button" disabled={!canUndo} title="Undo (Ctrl+Z)" onClick={undo}><UndoIcon size={18}/></button>
          <button className="top-icon-button" disabled={!canRedo} title="Redo (Ctrl+Y)" onClick={redo}><RedoIcon size={18}/></button>
          <div className={`search-control${searchOpen ? " open" : ""}`}>
            <button className="top-icon-button" title="Search canvas (Ctrl+F)" onClick={() => setSearchOpen((value) => !value)}><SearchIcon size={18}/></button>
            {searchOpen && <input autoFocus value={search} onChange={(event) => setSearch(event.currentTarget.value)} onBlur={() => { if (!search) setSearchOpen(false); }} placeholder="Find in canvas"/>}
          </div>
          <select className="font-select" value={font} onChange={(event) => applyFont(event.currentTarget.value)} title="Application and document font">
            {FONT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <button
            className={`top-icon-button${showTransparencyGrid ? " active" : ""}`}
            title={`${showTransparencyGrid ? "Hide" : "Show"} transparency grid`}
            aria-label={`${showTransparencyGrid ? "Hide" : "Show"} transparency grid`}
            aria-pressed={showTransparencyGrid}
            onClick={() => setShowTransparencyGrid((visible) => !visible)}
          >
            <TransparencyIcon size={18}/>
          </button>
          <button className="theme-toggle" title={`Use ${theme === "light" ? "dark" : "light"} theme`} onClick={() => setTheme((value) => value === "light" ? "dark" : "light")}>
            <span className={`theme-toggle-thumb ${theme}`}><SunIcon size={14}/><MoonIcon size={14}/></span>
          </button>
        </div>
      </header>

      <aside className="library-sidebar">
        <div className="library-heading">
          <div><strong>Canvas</strong></div>
          <button className="sidebar-add" title="New canvas" onClick={() => setNewCanvasOpen(true)}><PlusIcon size={17}/></button>
        </div>
        <div className="canvas-list">
          {files.map((file) => (
            <div className={`canvas-list-item${file.path === activePath ? " active" : ""}`} key={file.path}>
              <button className="canvas-list-main" onClick={() => void openFile(file)}>
                <span className="file-glyph canvas-emoji-glyph">
                  {openCanvases.find((canvas) => canvas.path === file.path)?.document.emoji || file.emoji || "🗂️"}
                </span>
                <span className="file-copy"><strong>{file.name}</strong><span>{fileTime(file.modifiedAt)}</span></span>
              </button>
              <div className="file-actions">
                <button title="Duplicate" onClick={() => void handleDuplicate(file)}><CopyIcon size={14}/></button>
                <button title="Rename" onClick={() => openRenameDialog(file)}><EditIcon size={15}/></button>
                <button title="Delete" onClick={() => void handleDelete(file)}><TrashIcon size={14}/></button>
              </div>
            </div>
          ))}
          {!files.length && !loading && <div className="empty-library"><GridIcon size={24}/><span>No canvases yet</span></div>}
        </div>
        <div className="library-footer">
          <div className={`repository-status ${repositoryStatus?.state ?? "syncing"}`} aria-live="polite">
            <div className="repository-status-summary">
              <span className="repository-status-dot"/>
              <div className="repository-status-copy">
                <strong>{repositoryStatus?.message ?? "Reading Git status…"}</strong>
                {repositoryStatus?.latestCommit && (
                  <span title={repositoryStatus.latestCommit}>
                    Latest: {repositoryStatus.latestCommit}
                    {repositoryStatus.latestCommitAt ? ` · ${fileTime(repositoryStatus.latestCommitAt)}` : ""}
                  </span>
                )}
              </div>
              {repositoryStatus && (repositoryStatus.state === "local" || repositoryStatus.state === "error") && (
                <button type="button" title="Sync with GitHub now" onClick={() => void retryPendingPush()}>
                  Sync now
                </button>
              )}
            </div>
            {fileSyncItems.length > 0 && (
              <div className="repository-file-list">
                {fileSyncItems.map((item) => (
                  <div className={`repository-file-row ${item.phase}`} key={item.path}>
                    <div className="repository-file-meta">
                      <span title={item.name}>{item.name}</span>
                      <small>{fileSyncLabel(item.phase)}</small>
                    </div>
                    <div className="repository-file-track" aria-label={`${item.name}: ${fileSyncLabel(item.phase)}`}>
                      <span/>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <span className="repository-section-label">Current repository</span>
          <div
            className="repository-card-shell"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setRepositoryMenuOpen(false);
            }}
          >
            <button
              type="button"
              className="repository-card-main"
              title="Open repository folder"
              onClick={() => {
                setRepositoryMenuOpen(false);
                void revealLibrary(libraryFolder);
              }}
            >
              <span className="repository-card-icon"><FolderIcon size={17}/></span>
              <span className="repository-card-copy">
                <strong>{repositoryDisplayName(libraryFolder)}</strong>
                <span title={libraryFolder}>{libraryFolder}</span>
              </span>
            </button>
            <button
              type="button"
              className="repository-menu-trigger"
              title="Repository actions"
              aria-label="Repository actions"
              aria-haspopup="menu"
              aria-expanded={repositoryMenuOpen}
              onClick={() => setRepositoryMenuOpen((open) => !open)}
            >
              <MoreIcon size={17}/>
            </button>
            {repositoryMenuOpen && (
              <div className="repository-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => void copyRepositoryPath()}>
                  <CopyIcon size={14}/> Copy path
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setRepositoryMenuOpen(false);
                    void selectFolder();
                  }}
                >
                  <ChevronIcon size={14}/> Switch repository
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>

      <section className="workspace-area">
        {activeCanvas ? (
          <CanvasWorkspace
            canvasPath={activeCanvas.path}
            document={activeCanvas.document}
            onChange={updateActiveDocument}
            tool={tool}
            onToolChange={setTool}
            color={color}
            onColorChange={setColor}
            randomColors={randomColors}
            onRandomColorsChange={setRandomColors}
            search={search}
          />
        ) : (
          <div className="no-canvas-view">
            <div className="no-canvas-art"><GridIcon size={36}/></div>
            <h2>Open a canvas from your repository</h2>
            <p>Or begin with a fresh grid.</p>
            <button className="primary-action compact" onClick={() => setNewCanvasOpen(true)}><PlusIcon/> New canvas</button>
          </div>
        )}
      </section>

      {newCanvasOpen && (
        <CanvasDetailsDialog
          mode="new"
          icon={<GridIcon/>}
          name={newCanvasName}
          emoji={newCanvasEmoji}
          submitting={newCanvasSubmitting}
          onNameChange={setNewCanvasName}
          onEmojiChange={setNewCanvasEmoji}
          onCancel={closeNewCanvasDialog}
          onSubmit={() => void addCanvas()}
        />
      )}

      {renamingFile && (
        <CanvasDetailsDialog
          mode="edit"
          icon={<EditIcon/>}
          name={renameCanvasName}
          emoji={renameCanvasEmoji}
          submitting={renameSubmitting}
          inputRef={renameInputRef}
          onNameChange={setRenameCanvasName}
          onEmojiChange={setRenameCanvasEmoji}
          onCancel={closeRenameDialog}
          onSubmit={() => void handleRename()}
        />
      )}

      {error && <div className="error-toast"><span>{error}</span><button onClick={() => setError(null)}><XIcon size={16}/></button></div>}
    </main>
  );
}
