import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CanvasWorkspace } from "./CanvasWorkspace";
import bindersIcon from "./assets/binders.svg";
import {
  chooseLibraryFolder,
  createCanvas,
  deleteCanvas,
  duplicateCanvas,
  listCanvases,
  loadCanvas,
  renameCanvas,
  revealLibrary,
  saveCanvas,
} from "./api";
import {
  ChevronIcon,
  CopyIcon,
  FolderIcon,
  GridIcon,
  MoonIcon,
  MoreIcon,
  PlusIcon,
  RedoIcon,
  SearchIcon,
  SunIcon,
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
const CANVAS_EMOJIS = ["🗂️", "📝", "💡", "🎯", "📚", "🧠", "🧪", "🎨", "🚀", "🌱", "⭐", "❤️", "🔥", "📌", "🏠", "💼"];

const defaultSession: SessionState = {
  libraryFolder: "",
  openPaths: [],
  activePath: null,
  theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  font: "Figtree Variable",
  uiScale: 1,
  sidebarCollapsed: false,
  randomColors: false,
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [newCanvasOpen, setNewCanvasOpen] = useState(false);
  const [newCanvasName, setNewCanvasName] = useState("");
  const [loading, setLoading] = useState(Boolean(libraryFolder));
  const [error, setError] = useState<string | null>(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [customEmoji, setCustomEmoji] = useState("");

  useEffect(() => {
    setEmojiPickerOpen(false);
    setCustomEmoji("");
  }, [activePath]);
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
        const nextFiles = await listCanvases(libraryFolder);
        if (cancelled) return;
        setFiles(nextFiles);
        const available = new Set(nextFiles.map((file) => file.path));
        const restored = initialSession.openPaths.filter((path) => available.has(path));
        for (const path of restored) await openFile(path);
        if (!restored.length && nextFiles[0]) await openFile(nextFiles[0]);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [initialSession.openPaths, libraryFolder, openFile]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
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
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }, [activePath, font, libraryFolder, openCanvases, randomColors, sidebarCollapsed, theme, uiScale]);

  const saveCanvasNow = useCallback(async (path: string) => {
    const canvas = canvasesRef.current.find((item) => item.path === path);
    if (!canvas?.dirty || canvas.saving) return;
    const documentToSave = structuredClone(canvas.document);
    const contentKeyToSave = savedContentKey(documentToSave);
    const savingState = canvasesRef.current.map((item) => item.path === path ? { ...item, saving: true } : item);
    canvasesRef.current = savingState;
    setOpenCanvases(savingState);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      await saveCanvas(path, documentToSave);
      const latest = canvasesRef.current.find((item) => item.path === path);
      const stillDirty = latest ? savedContentKey(latest.document) !== contentKeyToSave : false;
      const savedAt = new Date().toISOString();
      const savedState = canvasesRef.current.map((item) => item.path === path
        ? { ...item, dirty: stillDirty, saving: false, lastSavedAt: savedAt }
        : item);
      canvasesRef.current = savedState;
      setOpenCanvases(savedState);
      void refreshFiles();
    } catch (reason) {
      const failedState = canvasesRef.current.map((item) => item.path === path ? { ...item, saving: false } : item);
      canvasesRef.current = failedState;
      setOpenCanvases(failedState);
      setError(`Couldn’t save ${canvas.document.name}: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }, [refreshFiles]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      for (const canvas of canvasesRef.current) {
        if (canvas.dirty && !canvas.saving) void saveCanvasNow(canvas.path);
      }
    }, 25_000);
    return () => window.clearInterval(timer);
  }, [saveCanvasNow]);

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

  const selectFolder = async () => {
    const selected = await chooseLibraryFolder();
    if (!selected) return;
    setLibraryFolder(selected);
    setOpenCanvases([]);
    canvasesRef.current = [];
    setActivePath(null);
  };

  const addCanvas = async () => {
    const name = newCanvasName.trim() || "Untitled canvas";
    try {
      const file = await createCanvas(libraryFolder, name);
      setNewCanvasName("");
      setNewCanvasOpen(false);
      await refreshFiles();
      await openFile(file);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
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

  const handleRename = async (file: CanvasFile) => {
    const name = window.prompt("Rename canvas", file.name)?.trim();
    if (!name || name === file.name) return;
    try {
      const renamed = await renameCanvas(file.path, name);
      setOpenCanvases((current) => current.map((canvas) => canvas.path === file.path ? { ...canvas, path: renamed.path, document: { ...canvas.document, name: renamed.name } } : canvas));
      canvasesRef.current = canvasesRef.current.map((canvas) => canvas.path === file.path ? { ...canvas, path: renamed.path, document: { ...canvas.document, name: renamed.name } } : canvas);
      histories.current.set(renamed.path, histories.current.get(file.path) ?? { past: [], future: [] });
      histories.current.delete(file.path);
      if (activePath === file.path) setActivePath(renamed.path);
      await refreshFiles();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const handleDuplicate = async (file: CanvasFile) => {
    try {
      const copy = await duplicateCanvas(file.path);
      await refreshFiles();
      await openFile(copy);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const handleDelete = async (file: CanvasFile) => {
    if (!window.confirm(`Move “${file.name}” to Datagrid’s recovery folder?`)) return;
    try {
      await deleteCanvas(file.path);
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
  };

  const applyCanvasEmoji = (emoji: string) => {
    if (!activeCanvas || !emoji.trim()) return;
    updateActiveDocument({
      ...activeCanvas.document,
      emoji: emoji.trim(),
      updatedAt: new Date().toISOString(),
    });
    setCustomEmoji("");
    setEmojiPickerOpen(false);
  };

  if (!libraryFolder) {
    return (
      <main className="onboarding-shell">
        <div className="onboarding-glow glow-one"/>
        <div className="onboarding-glow glow-two"/>
        <section className="onboarding-card">
          <div className="brand-mark large-mark"><img src={bindersIcon} alt=""/></div>
          <span className="eyebrow">Welcome to Datagrid</span>
          <h1>A place for everything<br/>you’re thinking about.</h1>
          <p>Choose a folder for your canvas library. Every canvas remains a portable OpenDocument file that belongs entirely to you.</p>
          <button className="primary-action" onClick={() => void selectFolder()}><FolderIcon/> Choose library folder</button>
          <span className="privacy-note">No account. No cloud. No lock-in.</span>
        </section>
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

        <div className="tab-strip" role="tablist">
          {openCanvases.map((canvas) => (
            <button
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
                <button title="Rename" onClick={() => void handleRename(file)}><MoreIcon size={15}/></button>
                <button title="Delete" onClick={() => void handleDelete(file)}><TrashIcon size={14}/></button>
              </div>
            </div>
          ))}
          {!files.length && !loading && <div className="empty-library"><GridIcon size={24}/><span>No canvases yet</span></div>}
        </div>
        <div className="library-footer">
          <button onClick={() => void revealLibrary(libraryFolder)}><FolderIcon size={17}/><span>Open library folder</span><ChevronIcon size={14}/></button>
          <button className="folder-path" title={libraryFolder} onClick={() => void selectFolder()}>{libraryFolder}</button>
        </div>
      </aside>

      <section className="workspace-area">
        {activeCanvas ? (
          <>
            <div className="canvas-context-bar">
              <div>
                <button className="canvas-emoji-button" title="Choose canvas emoji" onClick={() => setEmojiPickerOpen((value) => !value)}>
                  {activeCanvas.document.emoji || "🗂️"}
                </button>
                <strong>{activeCanvas.document.name}</strong>
                <span className={activeCanvas.saving || activeCanvas.dirty ? "save-label unsaved" : "save-label saved"}>
                  {activeCanvas.saving ? "Saving…" : activeCanvas.dirty ? "Unsaved changes" : "Saved"}
                </span>
              </div>
            </div>
            {emojiPickerOpen && (
              <div className="emoji-picker-popover">
                <div className="emoji-options">
                  {CANVAS_EMOJIS.map((emoji) => (
                    <button type="button" key={emoji} className={activeCanvas.document.emoji === emoji ? "active" : ""} onClick={() => applyCanvasEmoji(emoji)}>{emoji}</button>
                  ))}
                </div>
                <form onSubmit={(event) => { event.preventDefault(); applyCanvasEmoji(customEmoji); }}>
                  <input value={customEmoji} onChange={(event) => setCustomEmoji(event.currentTarget.value)} placeholder="Custom emoji" maxLength={12}/>
                  <button type="submit" disabled={!customEmoji.trim()}>Use</button>
                </form>
              </div>
            )}
            <CanvasWorkspace
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
          </>
        ) : (
          <div className="no-canvas-view">
            <div className="no-canvas-art"><GridIcon size={36}/></div>
            <h2>Open a canvas from your library</h2>
            <p>Or begin with a fresh grid.</p>
            <button className="primary-action compact" onClick={() => setNewCanvasOpen(true)}><PlusIcon/> New canvas</button>
          </div>
        )}
      </section>

      {newCanvasOpen && (
        <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setNewCanvasOpen(false); }}>
          <form className="small-dialog" onSubmit={(event) => { event.preventDefault(); void addCanvas(); }}>
            <span className="dialog-icon"><GridIcon/></span>
            <h2>New canvas</h2>
            <p>Give this corner of your library a name.</p>
            <input autoFocus value={newCanvasName} onChange={(event) => setNewCanvasName(event.currentTarget.value)} placeholder="Canvas name" maxLength={100}/>
            <div className="dialog-actions"><button type="button" onClick={() => setNewCanvasOpen(false)}>Cancel</button><button type="submit" className="primary-action compact">Create canvas</button></div>
          </form>
        </div>
      )}

      {error && <div className="error-toast"><span>{error}</span><button onClick={() => setError(null)}><XIcon size={16}/></button></div>}
    </main>
  );
}
