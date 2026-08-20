<p align="center">
  <img
    src="docs/datagrid-cover.webp"
    alt="Datagrid showing a sample canvas"
    width="100%"
  />
</p>

<h1 align="center">Data Grid</h1>

<p align="center">
  A private, local-first note-taking app built around an infinite snapping grid.
</p>

<p align="center">
  Arrange text, images, spreadsheets, and links as portable cards without giving up ownership of your files.
</p>

---

## Overview

Datagrid replaces the freeform "sticky notes on a canvas" model with a structured two-dimensional grid. Cards snap into evenly spaced slots, reflow around one another as you add and move content, and stay directly editable on the canvas — no separate editor window.

Every canvas is saved in a private GitHub repository as readable Markdown, CSV, and original image files. Git keeps a complete history of the edits while the repository remains usable outside Datagrid.

## Features

**Canvas**
- Infinite panning and zooming grid canvas
- Cards snap into a grid and reflow automatically as the layout changes
- Multiple canvases open at once, each in its own tab
- Per-canvas emoji labels
- In-canvas search (`Ctrl+F`)
- Full undo and redo history (`Ctrl+Z` / `Ctrl+Y`)

**Cards**
- Text cards with headings, bold, italic, and lists, plus syntax-highlighted code cards
- Image cards
- Spreadsheet cards with formulas and calculated columns
- Link cards with automatically fetched previews and accent colors
- Quick-switch tool shortcuts: select (`H`), text (`T`), code (`C`), image (`M`), spreadsheet (`S`), link (`L`)

**Appearance**
- Light and dark themes
- Adjustable interface scale and font, with four bundled variable typefaces (DM Sans, Figtree, Manrope, Work Sans)

**Storage & privacy**
- Connect an existing private GitHub repository or clone one from the welcome screen
- Create a private repository through Datagrid's pre-filled GitHub browser link, then paste its HTTPS clone URL
- Text, code, and links are collected in `canvas.md`; every spreadsheet and image remains a separate CSV or original-format image file
- Datagrid applies edits immediately, saves them locally after a short debounce, and commits and pushes card-level summaries in the background
- If GitHub is unreachable, commits remain safely stored in the local repository and Datagrid retries them in the background
- Link-preview metadata and images are cached in the canvas for offline use

## Installation

### Windows installer

1. Open the repository's [Releases](https://github.com/rafay-pk/datagrid/releases) page.
2. Download the latest Datagrid installer.
3. Run the installer.
4. Launch Datagrid from the Start menu.

Windows may display a warning for unsigned applications. Review the downloaded file and repository before continuing.

macOS and Linux users can run Datagrid from source using the development instructions below.

## Connect a repository

On first launch, Datagrid can open GitHub's new-repository form with private visibility selected. Create the repository, copy its HTTPS URL, paste it into Datagrid, and choose an empty local folder for the clone. If you select a folder that is not yet a Git repository, Datagrid keeps that choice and guides you through these setup steps instead of stopping at an error. If the repository is already cloned, choose **Open an existing clone** instead.

The repository status strip in the sidebar shows the latest commit and whether GitHub is synced. Datagrid opens the local canvases immediately at launch, then checks GitHub in the background and refreshes clean tabs after synchronization. Saving never waits for GitHub: changes are written locally first, then committed and pushed in the background. Work remains available offline, and Datagrid retries pending commits and pushes while it is running or when the repository is next opened.

## Development

Datagrid is built with [Tauri 2](https://tauri.app), React 19, TypeScript, and Vite on the frontend, with a Rust backend that handles Git synchronization, portable canvas files, and link preview fetching.

### Requirements

All platforms need:

- [Node.js](https://nodejs.org/) 18 or later
- [Rust](https://www.rust-lang.org/tools/install) (via `rustup`)
- [Git](https://git-scm.com/downloads), with a credential helper capable of GitHub's browser sign-in for private repositories

Plus the platform-specific toolchain below, matching [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/).

<details>
<summary><strong>Windows</strong></summary>

- Rust with the MSVC toolchain (the default target when installing via `rustup` on Windows)
- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) — install the "Desktop development with C++" workload
- WebView2 Runtime (preinstalled on Windows 11; installable separately on Windows 10)

</details>

<details>
<summary><strong>macOS</strong></summary>

- Xcode Command Line Tools:

  ```bash
  xcode-select --install
  ```

- Rust via `rustup` (the default toolchain works)

</details>

<details>
<summary><strong>Linux</strong></summary>

Install WebKitGTK and the standard build toolchain for your distribution.

**Debian / Ubuntu**

```bash
sudo apt update && sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

**Fedora**

```bash
sudo dnf install -y webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel libxdo-devel && sudo dnf group install -y "c-development"
```

**Arch**

```bash
sudo pacman -Syu --needed webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
```

</details>

### Run locally

```bash
git clone https://github.com/rafay-pk/datagrid.git
cd datagrid
npm install
npm run tauri dev
```

This launches Datagrid in development mode with hot reload on every supported platform.

### Create a release build

```bash
npm run tauri build
```

On Windows, `release.ps1` wraps this into a single versioned command:

```powershell
.\release.ps1 0.1.0
```

Installers are generated under `src-tauri/target/release/bundle/`.

> **Note:** `src-tauri/tauri.conf.json` currently restricts `bundle.targets` to `nsis`, so `npm run tauri build` only produces a Windows installer today. To package a `.dmg`/`.app` on macOS or a `.deb`/`.rpm`/AppImage on Linux, update the `targets` array for your platform before building. That gap is a great first pull request if you're set up on macOS or Linux.

## Data and privacy

Datagrid does not use a Datagrid account or service. Canvas files remain in the local repository selected by the user and are synchronized only with its configured GitHub remote through the system Git installation.

Link previews require a network connection when first collected. Their metadata and preview images are then stored inside the canvas for offline use.

## Repository layout

Each directory below `canvases/` contains a `canvas.md`, a small `.datagrid.json` layout file, CSV files below `spreadsheets/`, and original image assets below `images/`. The Markdown and CSV content is readable without Datagrid; `.datagrid.json` preserves coordinates and card presentation details.

## Contributing

Contributions are very welcome, including pull requests — bug fixes, features, and documentation improvements are all appreciated. For larger changes, opening an issue first is a good way to check direction before you invest time, but small fixes are welcome as a PR directly.

## License

Datagrid is released under the [PolyForm Noncommercial License 1.0.0](LICENSE.md).
