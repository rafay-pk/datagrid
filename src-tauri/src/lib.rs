use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use regex::Regex;
use reqwest::blocking::Client;
use reqwest::header::CONTENT_TYPE;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;
use uuid::Uuid;

const CANVASES_FOLDER: &str = "canvases";
const METADATA_FILE: &str = ".datagrid.json";
const MARKDOWN_FILE: &str = "canvas.md";
static GIT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanvasFile {
    path: String,
    name: String,
    modified_at: String,
    size: u64,
    emoji: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitEnvironment {
    available: bool,
    version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryConnection {
    folder: String,
    remote_url: String,
    needs_setup: bool,
    folder_empty: bool,
    warning: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryStatus {
    state: String,
    message: String,
    ahead: u64,
    behind: u64,
    latest_commit: Option<String>,
    latest_commit_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveResult {
    commit_message: Option<String>,
    warning: Option<String>,
    status: RepositoryStatus,
}

fn sanitize_file_name(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .filter(|character| !matches!(character, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.').trim();
    if cleaned.is_empty() {
        "Untitled canvas".to_string()
    } else {
        cleaned.chars().take(100).collect()
    }
}

fn sanitize_asset_name(value: &str) -> String {
    let cleaned = sanitize_file_name(value);
    if cleaned == "Untitled canvas" {
        "image".to_string()
    } else {
        cleaned
    }
}

fn timestamp(value: SystemTime) -> String {
    value
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

fn directory_size(path: &Path) -> u64 {
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                directory_size(&path)
            } else {
                entry.metadata().map(|metadata| metadata.len()).unwrap_or(0)
            }
        })
        .sum()
}

fn canvas_file(path: &Path) -> Result<CanvasFile, String> {
    let document = read_stored_document(path)?;
    let markdown = path.join(MARKDOWN_FILE);
    let metadata = fs::metadata(&markdown).map_err(|error| error.to_string())?;
    Ok(CanvasFile {
        path: path.to_string_lossy().to_string(),
        name: document
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Untitled canvas")
            .to_string(),
        modified_at: timestamp(metadata.modified().unwrap_or(UNIX_EPOCH)),
        size: directory_size(path),
        emoji: document.get("emoji").and_then(Value::as_str).map(str::to_string),
        warning: None,
    })
}

fn unique_canvas_path(repository: &Path, requested_name: &str) -> PathBuf {
    let folder = repository.join(CANVASES_FOLDER);
    let name = sanitize_file_name(requested_name);
    let first = folder.join(&name);
    if !first.exists() {
        return first;
    }
    for suffix in 2..10_000 {
        let candidate = folder.join(format!("{name} {suffix}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    folder.join(format!("{name} {}", Uuid::new_v4()))
}

fn data_url_parts(data_url: &str) -> Option<(&str, Vec<u8>)> {
    let (header, payload) = data_url.split_once(',')?;
    let mime = header.strip_prefix("data:")?.split(';').next()?;
    let bytes = BASE64.decode(payload).ok()?;
    Some((mime, bytes))
}

fn extension_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/svg+xml" => "svg",
        "image/x-icon" | "image/vnd.microsoft.icon" => "ico",
        _ => "bin",
    }
}

fn mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

fn csv_escape(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn write_csv(path: &Path, cells: &[Value]) -> Result<(), String> {
    let contents = cells
        .iter()
        .map(|row| {
            row.as_array()
                .map(|values| {
                    values
                        .iter()
                        .map(|cell| csv_escape(cell.as_str().unwrap_or("")))
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join("\r\n");
    fs::write(path, format!("{contents}\r\n")).map_err(|error| error.to_string())
}

fn parse_csv(contents: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut cell = String::new();
    let mut characters = contents.chars().peekable();
    let mut quoted = false;
    while let Some(character) = characters.next() {
        match character {
            '"' if quoted && characters.peek() == Some(&'"') => {
                cell.push('"');
                characters.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => row.push(std::mem::take(&mut cell)),
            '\n' if !quoted => {
                if cell.ends_with('\r') {
                    cell.pop();
                }
                row.push(std::mem::take(&mut cell));
                rows.push(std::mem::take(&mut row));
            }
            _ => cell.push(character),
        }
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        rows.push(row);
    }
    rows
}

fn markdown_for_document(document: &Value, cards: &[Value]) -> String {
    let name = document
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Untitled canvas");
    let mut output = format!(
        "# {name}\n\n> Managed by Datagrid. Layout metadata is stored in `{METADATA_FILE}`.\n"
    );
    for card in cards {
        let id = card.get("id").and_then(Value::as_str).unwrap_or("card");
        match card.get("type").and_then(Value::as_str).unwrap_or("text") {
            "text" => {
                output.push_str(&format!("\n<!-- card:{id} type:text -->\n\n"));
                let html = card.get("html").and_then(Value::as_str).unwrap_or("");
                output.push_str(html);
                output.push('\n');
            }
            "code" => {
                let language = card.get("language").and_then(Value::as_str).unwrap_or("");
                let code = card.get("code").and_then(Value::as_str).unwrap_or("");
                let longest_fence = code
                    .split('\n')
                    .map(|line| line.chars().take_while(|character| *character == '`').count())
                    .max()
                    .unwrap_or(0);
                let fence = "`".repeat(3.max(longest_fence + 1));
                output.push_str(&format!(
                    "\n<!-- card:{id} type:code -->\n\n{fence}{language}\n{code}\n{fence}\n"
                ));
            }
            "link" => {
                let url = card.get("url").and_then(Value::as_str).unwrap_or("");
                let preview = card.get("preview").unwrap_or(&Value::Null);
                let title = preview.get("title").and_then(Value::as_str).unwrap_or(url);
                let description = preview.get("description").and_then(Value::as_str).unwrap_or("");
                output.push_str(&format!(
                    "\n<!-- card:{id} type:link -->\n\n## [{title}]({url})\n\n{description}\n"
                ));
            }
            "image" => {
                let label = card
                    .get("label")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .or_else(|| card.get("fileName").and_then(Value::as_str))
                    .unwrap_or("Image");
                let asset = card.get("assetPath").and_then(Value::as_str).unwrap_or("");
                output.push_str(&format!(
                    "\n<!-- card:{id} type:image -->\n\n![{label}]({asset})\n"
                ));
            }
            "spreadsheet" => {
                let asset = card.get("csvPath").and_then(Value::as_str).unwrap_or("");
                output.push_str(&format!(
                    "\n<!-- card:{id} type:spreadsheet -->\n\n[Spreadsheet data]({asset})\n"
                ));
            }
            _ => {}
        }
    }
    output
}

fn save_document(path: &Path, document: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or("Canvas path has no parent folder.")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!(".datagrid-tmp-{}", Uuid::new_v4()));
    let backup = parent.join(format!(".datagrid-backup-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join("images")).map_err(|error| error.to_string())?;
    fs::create_dir_all(temp.join("spreadsheets")).map_err(|error| error.to_string())?;

    let mut stored_document = document.clone();
    let cards = stored_document
        .get_mut("cards")
        .and_then(Value::as_array_mut)
        .ok_or("Canvas document has no cards array.")?;

    for card in cards.iter_mut() {
        let card_type = card.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        let id = sanitize_asset_name(card.get("id").and_then(Value::as_str).unwrap_or("card"));
        match card_type.as_str() {
            "image" => {
                let file_name = sanitize_asset_name(
                    card.get("fileName").and_then(Value::as_str).unwrap_or("image"),
                );
                let data_url = card.get("dataUrl").and_then(Value::as_str).unwrap_or("");
                let (mime, bytes) = data_url_parts(data_url)
                    .ok_or_else(|| format!("Image card {id} does not contain valid image data."))?;
                let file_name = if Path::new(&file_name).extension().is_some() {
                    file_name
                } else {
                    format!("{file_name}.{}", extension_for_mime(mime))
                };
                let relative = format!("images/{id}-{file_name}");
                fs::write(temp.join(&relative), bytes).map_err(|error| error.to_string())?;
                if let Some(object) = card.as_object_mut() {
                    object.remove("dataUrl");
                    object.insert("assetPath".into(), Value::String(relative));
                }
            }
            "spreadsheet" => {
                let relative = format!("spreadsheets/{id}.csv");
                let cells = card
                    .get("cells")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                write_csv(&temp.join(&relative), &cells)?;
                if let Some(object) = card.as_object_mut() {
                    object.remove("cells");
                    object.insert("csvPath".into(), Value::String(relative));
                }
            }
            "link" => {
                if let Some(preview) = card.get_mut("preview").and_then(Value::as_object_mut) {
                    for (data_key, path_key, suffix) in [
                        ("imageDataUrl", "imageAssetPath", "preview"),
                        ("faviconDataUrl", "faviconAssetPath", "favicon"),
                    ] {
                        let Some(data_url) = preview.remove(data_key).and_then(|value| value.as_str().map(str::to_string)) else {
                            continue;
                        };
                        if let Some((mime, bytes)) = data_url_parts(&data_url) {
                            let relative = format!("images/{id}-{suffix}.{}", extension_for_mime(mime));
                            fs::write(temp.join(&relative), bytes).map_err(|error| error.to_string())?;
                            preview.insert(path_key.into(), Value::String(relative));
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let mut markdown_cards = cards.clone();
    markdown_cards.sort_by_key(|card| {
        (
            card.get("y").and_then(Value::as_i64).unwrap_or(0),
            card.get("x").and_then(Value::as_i64).unwrap_or(0),
        )
    });
    let markdown = markdown_for_document(&stored_document, &markdown_cards);
    fs::write(temp.join(MARKDOWN_FILE), markdown).map_err(|error| error.to_string())?;
    fs::write(
        temp.join(METADATA_FILE),
        serde_json::to_string_pretty(&stored_document).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    if path.exists() {
        fs::rename(path, &backup).map_err(|error| error.to_string())?;
    }
    if let Err(error) = fs::rename(&temp, path) {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err(error.to_string());
    }
    if backup.exists() {
        fs::remove_dir_all(backup).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn canvas_asset_path(canvas: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Canvas asset path is not a safe relative path.".to_string());
    }
    Ok(canvas.join(relative))
}

fn read_asset_data_url(canvas: &Path, relative: &str, preferred_mime: Option<&str>) -> Result<String, String> {
    let path = canvas_asset_path(canvas, relative)?;
    let bytes = fs::read(&path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let mime = preferred_mime.unwrap_or_else(|| mime_for_path(&path));
    Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

fn read_stored_document(path: &Path) -> Result<Value, String> {
    let metadata_path = path.join(METADATA_FILE);
    serde_json::from_str(
        &fs::read_to_string(&metadata_path)
            .map_err(|error| format!("Could not read {}: {error}", metadata_path.display()))?,
    )
    .map_err(|error| error.to_string())
}

fn read_document(path: &Path) -> Result<Value, String> {
    let mut document = read_stored_document(path)?;
    let cards = document
        .get_mut("cards")
        .and_then(Value::as_array_mut)
        .ok_or("Canvas metadata has no cards array.")?;
    for card in cards {
        match card.get("type").and_then(Value::as_str).unwrap_or("") {
            "image" => {
                let relative = card
                    .get("assetPath")
                    .and_then(Value::as_str)
                    .ok_or("Image card has no asset path.")?
                    .to_string();
                let mime = card.get("mimeType").and_then(Value::as_str);
                let data_url = read_asset_data_url(path, &relative, mime)?;
                if let Some(object) = card.as_object_mut() {
                    object.remove("assetPath");
                    object.insert("dataUrl".into(), Value::String(data_url));
                }
            }
            "spreadsheet" => {
                let relative = card
                    .get("csvPath")
                    .and_then(Value::as_str)
                    .ok_or("Spreadsheet card has no CSV path.")?
                    .to_string();
                let contents = fs::read_to_string(canvas_asset_path(path, &relative)?)
                    .map_err(|error| error.to_string())?;
                let cells = parse_csv(&contents);
                if let Some(object) = card.as_object_mut() {
                    object.remove("csvPath");
                    object.insert("cells".into(), json!(cells));
                }
            }
            "link" => {
                if let Some(preview) = card.get_mut("preview").and_then(Value::as_object_mut) {
                    for (path_key, data_key) in [
                        ("imageAssetPath", "imageDataUrl"),
                        ("faviconAssetPath", "faviconDataUrl"),
                    ] {
                        let Some(relative) = preview.remove(path_key).and_then(|value| value.as_str().map(str::to_string)) else {
                            continue;
                        };
                        let data_url = read_asset_data_url(path, &relative, None)?;
                        preview.insert(data_key.into(), Value::String(data_url));
                    }
                }
            }
            _ => {}
        }
    }
    Ok(document)
}

fn output_message(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stderr.is_empty() { stderr } else { stdout }
}

fn run_git(repository: &Path, arguments: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(arguments)
        .current_dir(repository)
        .output()
        .map_err(|error| format!("Could not start Git: {error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(output_message(&output))
    }
}

fn is_github_remote(remote: &str) -> bool {
    Url::parse(remote)
        .ok()
        .and_then(|url| url.host_str().map(|host| host.eq_ignore_ascii_case("github.com")))
        .unwrap_or_else(|| {
            remote
                .trim()
                .to_ascii_lowercase()
                .starts_with("git@github.com:")
        })
}

fn git_status(repository: &Path, arguments: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .args(arguments)
        .current_dir(repository)
        .output()
        .map_err(|error| format!("Could not start Git: {error}"))
}

fn validate_repository(repository: &Path) -> Result<String, String> {
    let top_level = run_git(repository, &["rev-parse", "--show-toplevel"])
        .map_err(|_| "That folder is not a Git repository.".to_string())?;
    let selected = fs::canonicalize(repository).map_err(|error| error.to_string())?;
    let top_level = fs::canonicalize(top_level).map_err(|error| error.to_string())?;
    #[cfg(target_os = "windows")]
    let is_root = selected
        .to_string_lossy()
        .eq_ignore_ascii_case(&top_level.to_string_lossy());
    #[cfg(not(target_os = "windows"))]
    let is_root = selected == top_level;
    if !is_root {
        return Err("Choose the root folder of the Git repository.".to_string());
    }
    let remote = run_git(repository, &["remote", "get-url", "origin"])
        .map_err(|_| "The repository needs an `origin` remote.".to_string())?;
    if !is_github_remote(&remote) {
        return Err("Datagrid currently requires a GitHub repository.".to_string());
    }
    Ok(remote)
}

fn ensure_local_git_excludes(repository: &Path) -> Result<(), String> {
    let exclude_path = run_git(repository, &["rev-parse", "--git-path", "info/exclude"])?;
    let exclude_path = PathBuf::from(exclude_path);
    let exclude_path = if exclude_path.is_absolute() {
        exclude_path
    } else {
        repository.join(exclude_path)
    };
    if let Some(parent) = exclude_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut contents = fs::read_to_string(&exclude_path).unwrap_or_default();
    for pattern in ["/.datagrid-trash/", "/canvases/.datagrid-tmp-*", "/canvases/.datagrid-backup-*"] {
        if !contents.lines().any(|line| line.trim() == pattern) {
            if !contents.is_empty() && !contents.ends_with('\n') {
                contents.push('\n');
            }
            contents.push_str(pattern);
            contents.push('\n');
        }
    }
    fs::write(exclude_path, contents).map_err(|error| error.to_string())
}

fn has_head(repository: &Path) -> bool {
    git_status(repository, &["rev-parse", "--verify", "HEAD"])
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn sync_repository_blocking(repository: &Path) -> Result<RepositoryStatus, String> {
    let _git_guard = GIT_LOCK
        .lock()
        .map_err(|_| "Git synchronization lock is unavailable.".to_string())?;
    validate_repository(repository)?;
    ensure_local_git_excludes(repository)?;
    commit_paths(
        repository,
        &[CANVASES_FOLDER],
        "Saved pending Datagrid changes",
        "Recovered canvas changes that were saved before background Git synchronization completed.",
    )?;
    run_git(repository, &["fetch", "origin"])?;
    if !has_head(repository) {
        return repository_status_blocking(repository);
    }
    let upstream = git_status(
        repository,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    )?;
    if upstream.status.success() {
        run_git(repository, &["pull", "--rebase", "--autostash"])?;
    } else {
        let branch = run_git(repository, &["branch", "--show-current"])?;
        let remote_branch = git_status(repository, &["ls-remote", "--exit-code", "--heads", "origin", &branch])?;
        if remote_branch.status.success() {
            run_git(repository, &["pull", "--rebase", "origin", &branch])?;
        }
    }
    push_repository(repository)?;
    repository_status_blocking(repository)
}

fn repository_for_canvas(path: &Path) -> Result<PathBuf, String> {
    let canvases = path.parent().ok_or("Canvas has no parent folder.")?;
    let repository = canvases.parent().ok_or("Canvas is not inside a repository.")?;
    validate_repository(repository)?;
    Ok(repository.to_path_buf())
}

fn relative_path<'a>(repository: &'a Path, path: &'a Path) -> Result<String, String> {
    path.strip_prefix(repository)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .map_err(|_| "Canvas is outside the repository.".to_string())
}

fn push_repository(repository: &Path) -> Result<(), String> {
    let upstream = git_status(
        repository,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    )?;
    if upstream.status.success() {
        return run_git(repository, &["push"]).map(|_| ());
    }
    let branch = run_git(repository, &["branch", "--show-current"])?;
    if branch.is_empty() {
        return Err("Git could not determine the current branch.".to_string());
    }
    run_git(repository, &["push", "--set-upstream", "origin", &branch]).map(|_| ())
}

fn repository_status_blocking(repository: &Path) -> Result<RepositoryStatus, String> {
    validate_repository(repository)?;
    if !has_head(repository) {
        return Ok(RepositoryStatus {
            state: "ready".to_string(),
            message: "Ready for the first canvas commit".to_string(),
            ahead: 0,
            behind: 0,
            latest_commit: None,
            latest_commit_at: None,
        });
    }

    let latest = run_git(repository, &["log", "-1", "--format=%s%x1f%cI"])?;
    let (latest_commit, latest_commit_at) = latest
        .split_once('\u{1f}')
        .map(|(subject, date)| (Some(subject.to_string()), Some(date.to_string())))
        .unwrap_or_else(|| (Some(latest), None));
    let upstream = git_status(
        repository,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    )?;
    let (ahead, behind) = if upstream.status.success() {
        let counts = run_git(repository, &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])?;
        let mut values = counts.split_whitespace().filter_map(|value| value.parse::<u64>().ok());
        (values.next().unwrap_or(0), values.next().unwrap_or(0))
    } else {
        let count = run_git(repository, &["rev-list", "--count", "HEAD"])
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        (count, 0)
    };
    let local_changes = run_git(repository, &["status", "--porcelain", "--untracked-files=normal", "--", CANVASES_FOLDER])?;

    let (state, message) = if !local_changes.is_empty() {
        (
            "local".to_string(),
            "Canvas files are saved locally and waiting for a Git commit".to_string(),
        )
    } else if ahead > 0 && behind > 0 {
        (
            "behind".to_string(),
            format!("{ahead} local and {behind} GitHub commit{} need sync — reopen the repository", if behind == 1 { "" } else { "s" }),
        )
    } else if ahead > 0 {
        (
            "local".to_string(),
            format!("{ahead} commit{} saved locally — waiting to push", if ahead == 1 { "" } else { "s" }),
        )
    } else if behind > 0 {
        (
            "behind".to_string(),
            format!("{behind} GitHub update{} available on next open", if behind == 1 { "" } else { "s" }),
        )
    } else {
        ("synced".to_string(), "Synced with GitHub".to_string())
    };
    Ok(RepositoryStatus {
        state,
        message,
        ahead,
        behind,
        latest_commit,
        latest_commit_at,
    })
}

fn unavailable_repository_status(message: &str) -> RepositoryStatus {
    RepositoryStatus {
        state: "error".to_string(),
        message: message.to_string(),
        ahead: 0,
        behind: 0,
        latest_commit: None,
        latest_commit_at: None,
    }
}

fn current_repository_status(repository: &Path) -> RepositoryStatus {
    repository_status_blocking(repository)
        .unwrap_or_else(|error| unavailable_repository_status(&format!("Git status unavailable: {error}")))
}

fn git_status_owned(repository: &Path, arguments: &[String]) -> Result<Output, String> {
    Command::new("git")
        .args(arguments)
        .current_dir(repository)
        .output()
        .map_err(|error| format!("Could not start Git: {error}"))
}

fn commit_paths(repository: &Path, pathspecs: &[&str], title: &str, body: &str) -> Result<bool, String> {
    let mut add = ["add", "--all", "--"].into_iter().map(str::to_string).collect::<Vec<_>>();
    add.extend(pathspecs.iter().map(|value| value.to_string()));
    let output = git_status_owned(repository, &add)?;
    if !output.status.success() {
        return Err(output_message(&output));
    }
    let mut diff_arguments = ["diff", "--cached", "--quiet", "--"]
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
    diff_arguments.extend(pathspecs.iter().map(|value| value.to_string()));
    let diff = git_status_owned(repository, &diff_arguments)?;
    if diff.status.success() {
        return Ok(false);
    }
    if diff.status.code() != Some(1) {
        return Err(output_message(&diff));
    }
    let mut arguments = vec!["commit".to_string(), "--only".to_string(), "-m".to_string(), title.to_string()];
    if !body.is_empty() {
        arguments.extend(["-m".to_string(), body.to_string()]);
    }
    arguments.push("--".to_string());
    arguments.extend(pathspecs.iter().map(|value| value.to_string()));
    let output = git_status_owned(repository, &arguments)?;
    if !output.status.success() {
        return Err(output_message(&output));
    }
    Ok(true)
}

fn words(value: &str) -> String {
    let html = Regex::new(r"(?s)<[^>]+>").unwrap().replace_all(value, " ");
    let compact = html.split_whitespace().take(8).collect::<Vec<_>>().join(" ");
    if compact.is_empty() { "Untitled card".to_string() } else { compact }
}

fn card_excerpt(card: &Value) -> String {
    match card.get("type").and_then(Value::as_str).unwrap_or("") {
        "text" => words(card.get("html").and_then(Value::as_str).unwrap_or("")),
        "code" => words(card.get("code").and_then(Value::as_str).unwrap_or("")),
        "image" => card
            .get("label")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .or_else(|| card.get("fileName").and_then(Value::as_str))
            .unwrap_or("Image")
            .to_string(),
        "spreadsheet" => "Spreadsheet".to_string(),
        "link" => card
            .get("preview")
            .and_then(|preview| preview.get("title"))
            .and_then(Value::as_str)
            .or_else(|| card.get("url").and_then(Value::as_str))
            .unwrap_or("Link")
            .to_string(),
        _ => "Card".to_string(),
    }
}

fn card_map(document: &Value) -> HashMap<String, Value> {
    document
        .get("cards")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|card| card.get("id").and_then(Value::as_str).map(|id| (id.to_string(), card.clone())))
        .collect()
}

fn change_description(previous: Option<&Value>, next: &Value) -> (String, String) {
    let before = previous.map(card_map).unwrap_or_default();
    let after = card_map(next);
    let added = after
        .iter()
        .filter(|(id, _)| !before.contains_key(*id))
        .map(|(_, card)| card_excerpt(card))
        .collect::<Vec<_>>();
    let removed = before
        .iter()
        .filter(|(id, _)| !after.contains_key(*id))
        .map(|(_, card)| card_excerpt(card))
        .collect::<Vec<_>>();
    let edited = after
        .iter()
        .filter(|(id, card)| before.get(*id).map(|old| old != *card).unwrap_or(false))
        .map(|(_, card)| card_excerpt(card))
        .collect::<Vec<_>>();
    let name = next.get("name").and_then(Value::as_str).unwrap_or("canvas");
    let groups = [
        ("Edited", &edited),
        ("Added", &added),
        ("Removed", &removed),
    ]
    .into_iter()
    .filter(|(_, cards)| !cards.is_empty())
    .collect::<Vec<_>>();
    if groups.is_empty() {
        return (format!("Updated {name}"), String::new());
    }
    let title = if groups.len() == 1 {
        let (verb, cards) = groups[0];
        format!("{verb} {} Card{} in {name}", cards.len(), if cards.len() == 1 { "" } else { "s" })
    } else {
        let count = added.len() + edited.len() + removed.len();
        format!("Updated {count} Cards in {name}")
    };
    let body = groups
        .into_iter()
        .map(|(verb, cards)| {
            let details = cards.iter().take(3).cloned().collect::<Vec<_>>().join("; ");
            format!("{verb} {} Card{}: {details}", cards.len(), if cards.len() == 1 { "" } else { "s" })
        })
        .collect::<Vec<_>>()
        .join("\n");
    (title, body)
}

fn finish_git_change(repository: &Path, pathspecs: &[&str], title: &str, body: &str) -> SaveResult {
    let Ok(_git_guard) = GIT_LOCK.lock() else {
        return SaveResult {
            commit_message: None,
            warning: Some("Saved locally, but the Git synchronization lock is unavailable.".to_string()),
            status: current_repository_status(repository),
        };
    };
    match commit_paths(repository, pathspecs, title, body) {
        Ok(committed) => match push_repository(repository) {
            Ok(()) => SaveResult {
                commit_message: committed.then(|| title.to_string()),
                warning: None,
                status: current_repository_status(repository),
            },
            Err(error) => SaveResult {
                commit_message: committed.then(|| title.to_string()),
                warning: Some(format!("Saved and committed locally, but Git could not push: {error}")),
                status: current_repository_status(repository),
            },
        },
        Err(error) => SaveResult {
            commit_message: None,
            warning: Some(format!("Saved locally, but Git could not create a commit: {error}")),
            status: current_repository_status(repository),
        },
    }
}

fn background_sync_status() -> RepositoryStatus {
    RepositoryStatus {
        state: "syncing".to_string(),
        message: "Saved locally — syncing with GitHub…".to_string(),
        ahead: 0,
        behind: 0,
        latest_commit: None,
        latest_commit_at: None,
    }
}

fn queue_git_change(repository: PathBuf, pathspecs: Vec<String>, title: String, body: String) {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = pathspecs.iter().map(String::as_str).collect::<Vec<_>>();
        let _ = finish_git_change(&repository, &paths, &title, &body);
    });
}

#[tauri::command]
fn git_environment() -> GitEnvironment {
    match Command::new("git").arg("--version").output() {
        Ok(output) if output.status.success() => GitEnvironment {
            available: true,
            version: Some(String::from_utf8_lossy(&output.stdout).trim().to_string()),
        },
        _ => GitEnvironment { available: false, version: None },
    }
}

#[tauri::command]
async fn connect_repository(folder: String, remote_url: Option<String>) -> Result<RepositoryConnection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repository = PathBuf::from(&folder);
        if remote_url.as_ref().map(|value| value.trim().is_empty()).unwrap_or(true) {
            let probe = git_status(&repository, &["rev-parse", "--show-toplevel"])?;
            if !probe.status.success() {
                let folder_empty = fs::read_dir(&repository)
                    .map_err(|error| error.to_string())?
                    .next()
                    .is_none();
                return Ok(RepositoryConnection {
                    folder,
                    remote_url: String::new(),
                    needs_setup: true,
                    folder_empty,
                    warning: None,
                });
            }
        }
        if let Some(remote) = remote_url.filter(|value| !value.trim().is_empty()) {
            if !is_github_remote(&remote) {
                return Err("Enter a GitHub repository URL.".to_string());
            }
            fs::create_dir_all(&repository).map_err(|error| error.to_string())?;
            let has_entries = fs::read_dir(&repository)
                .map_err(|error| error.to_string())?
                .next()
                .is_some();
            if has_entries {
                return Err("Choose an empty folder for a new clone.".to_string());
            }
            let output = Command::new("git")
                .args(["clone", remote.trim(), "."])
                .current_dir(&repository)
                .output()
                .map_err(|error| format!("Could not start Git: {error}"))?;
            if !output.status.success() {
                return Err(format!(
                    "Git could not clone the repository. Its GitHub sign-in may need attention: {}",
                    output_message(&output)
                ));
            }
        }
        let remote = validate_repository(&repository)?;
        ensure_local_git_excludes(&repository)?;
        fs::create_dir_all(repository.join(CANVASES_FOLDER)).map_err(|error| error.to_string())?;
        Ok(RepositoryConnection {
            folder,
            remote_url: remote,
            needs_setup: false,
            folder_empty: false,
            warning: None,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn sync_repository(folder: String) -> Result<RepositoryStatus, String> {
    tauri::async_runtime::spawn_blocking(move || sync_repository_blocking(Path::new(&folder)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn repository_status(folder: String) -> Result<RepositoryStatus, String> {
    tauri::async_runtime::spawn_blocking(move || repository_status_blocking(Path::new(&folder)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn push_pending_commits(folder: String) -> Result<RepositoryStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repository = PathBuf::from(folder);
        let _git_guard = GIT_LOCK
            .lock()
            .map_err(|_| "Git synchronization lock is unavailable.".to_string())?;
        validate_repository(&repository)?;
        commit_paths(
            &repository,
            &[CANVASES_FOLDER],
            "Saved pending Datagrid changes",
            "Committed canvas changes that were already saved locally.",
        )?;
        run_git(&repository, &["fetch", "origin"])?;
        let fetched_status = repository_status_blocking(&repository)?;
        if fetched_status.behind > 0 {
            return Ok(fetched_status);
        }
        if has_head(&repository) {
            push_repository(&repository)?;
        }
        repository_status_blocking(&repository)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn list_canvases(folder: String) -> Result<Vec<CanvasFile>, String> {
    let repository = PathBuf::from(folder);
    validate_repository(&repository)?;
    let folder = repository.join(CANVASES_FOLDER);
    fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let mut files = fs::read_dir(folder)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir() && path.join(METADATA_FILE).is_file())
        .filter_map(|path| canvas_file(&path).ok())
        .collect::<Vec<_>>();
    files.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(files)
}

#[tauri::command]
fn load_canvas(path: String) -> Result<Value, String> {
    read_document(Path::new(&path))
}

#[tauri::command]
async fn save_canvas(path: String, document: Value) -> Result<SaveResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        let previous = path.exists().then(|| read_document(&path)).transpose()?;
        let repository = repository_for_canvas(&path)?;
        let pathspec = relative_path(&repository, &path)?;
        let (title, body) = change_description(previous.as_ref(), &document);
        save_document(&path, &document)?;
        queue_git_change(repository, vec![pathspec], title, body);
        Ok(SaveResult {
            commit_message: None,
            warning: None,
            status: background_sync_status(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn create_canvas_blocking(folder: String, name: String) -> Result<CanvasFile, String> {
    let repository = PathBuf::from(folder);
    validate_repository(&repository)?;
    fs::create_dir_all(repository.join(CANVASES_FOLDER)).map_err(|error| error.to_string())?;
    let path = unique_canvas_path(&repository, &name);
    let actual_name = path.file_name().and_then(|value| value.to_str()).unwrap_or("Untitled canvas");
    let now = timestamp(SystemTime::now());
    let document = json!({
        "version": 1,
        "id": format!("canvas-{}", Uuid::new_v4()),
        "name": actual_name,
        "emoji": "🗂️",
        "accent": "#FF4D4D",
        "font": "Figtree Variable",
        "cards": [],
        "viewport": { "x": 0, "y": 0, "zoom": 0.82 },
        "createdAt": now,
        "updatedAt": now
    });
    save_document(&path, &document)?;
    let pathspec = relative_path(&repository, &path)?;
    let title = format!("Added Canvas: {actual_name}");
    queue_git_change(
        repository,
        vec![pathspec],
        title,
        "Created a new Datagrid canvas.".to_string(),
    );
    canvas_file(&path)
}

fn rename_canvas_blocking(path: String, name: String) -> Result<CanvasFile, String> {
    let old_path = PathBuf::from(path);
    let repository = repository_for_canvas(&old_path)?;
    let old_pathspec = relative_path(&repository, &old_path)?;
    let new_path = unique_canvas_path(&repository, &name);
    let mut document = read_document(&old_path)?;
    let actual_name = new_path.file_name().and_then(|value| value.to_str()).unwrap_or("Untitled canvas");
    let old_name = document.get("name").and_then(Value::as_str).unwrap_or("Untitled canvas").to_string();
    document["name"] = Value::String(actual_name.to_string());
    document["updatedAt"] = Value::String(timestamp(SystemTime::now()));
    save_document(&new_path, &document)?;
    fs::remove_dir_all(&old_path).map_err(|error| error.to_string())?;
    let new_pathspec = relative_path(&repository, &new_path)?;
    let title = format!("Renamed Canvas: {old_name} to {actual_name}");
    queue_git_change(
        repository,
        vec![old_pathspec, new_pathspec],
        title,
        "Renamed the canvas folder and updated its Markdown title.".to_string(),
    );
    canvas_file(&new_path)
}

fn duplicate_canvas_blocking(path: String) -> Result<CanvasFile, String> {
    let source_path = PathBuf::from(path);
    let repository = repository_for_canvas(&source_path)?;
    let mut document = read_document(&source_path)?;
    let source_name = document.get("name").and_then(Value::as_str).unwrap_or("Untitled canvas");
    let new_path = unique_canvas_path(&repository, &format!("{source_name} copy"));
    let actual_name = new_path.file_name().and_then(|value| value.to_str()).unwrap_or("Untitled canvas");
    document["id"] = Value::String(format!("canvas-{}", Uuid::new_v4()));
    document["name"] = Value::String(actual_name.to_string());
    document["updatedAt"] = Value::String(timestamp(SystemTime::now()));
    save_document(&new_path, &document)?;
    let pathspec = relative_path(&repository, &new_path)?;
    let title = format!("Added Canvas: {actual_name}");
    queue_git_change(
        repository,
        vec![pathspec],
        title,
        "Duplicated an existing Datagrid canvas.".to_string(),
    );
    canvas_file(&new_path)
}

fn delete_canvas_blocking(path: String) -> Result<SaveResult, String> {
    let source = PathBuf::from(path);
    let repository = repository_for_canvas(&source)?;
    let name = read_document(&source)
        .ok()
        .and_then(|document| document.get("name").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| "Untitled canvas".to_string());
    let pathspec = relative_path(&repository, &source)?;
    let trash = repository.join(".datagrid-trash");
    fs::create_dir_all(&trash).map_err(|error| error.to_string())?;
    let file_name = source.file_name().ok_or("Canvas path has no file name.")?;
    let mut destination = trash.join(file_name);
    if destination.exists() {
        destination = trash.join(format!("{}-{}", timestamp(SystemTime::now()), file_name.to_string_lossy()));
    }
    fs::rename(&source, destination).map_err(|error| error.to_string())?;
    let title = format!("Removed Canvas: {name}");
    queue_git_change(
        repository,
        vec![pathspec],
        title,
        "Moved the canvas to Datagrid's local recovery folder.".to_string(),
    );
    Ok(SaveResult {
        commit_message: None,
        warning: None,
        status: background_sync_status(),
    })
}

#[tauri::command]
async fn create_canvas(folder: String, name: String) -> Result<CanvasFile, String> {
    tauri::async_runtime::spawn_blocking(move || create_canvas_blocking(folder, name))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn rename_canvas(path: String, name: String) -> Result<CanvasFile, String> {
    tauri::async_runtime::spawn_blocking(move || rename_canvas_blocking(path, name))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn duplicate_canvas(path: String) -> Result<CanvasFile, String> {
    tauri::async_runtime::spawn_blocking(move || duplicate_canvas_blocking(path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn delete_canvas(path: String) -> Result<SaveResult, String> {
    tauri::async_runtime::spawn_blocking(move || delete_canvas_blocking(path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn reveal_library(folder: String) -> Result<(), String> {
    let path = PathBuf::from(folder);
    if !path.is_dir() {
        return Err("The Datagrid repository folder could not be found.".to_string());
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer.exe");
        command.arg(&path);
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(&path);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(&path);
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open the Datagrid repository folder: {error}"))
}

fn meta_content(html: &str, property: &str) -> Option<String> {
    let pattern = format!(r#"(?is)<meta[^>]+(?:property|name)=["']{}["'][^>]+content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']{}["']"#, regex::escape(property), regex::escape(property));
    let regex = Regex::new(&pattern).ok()?;
    let captures = regex.captures(html)?;
    captures.get(1).or_else(|| captures.get(2)).map(|value| decode_html(value.as_str()))
}

fn decode_html(value: &str) -> String {
    value.replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">")
}

fn download_image_data_url(client: &Client, url: &str) -> Option<String> {
    let response = client.get(url).send().ok()?;
    let mime = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .filter(|value| value.starts_with("image/"))
        .unwrap_or("image/x-icon")
        .to_string();
    let bytes = response.bytes().ok()?;
    if bytes.len() > 5_000_000 {
        return None;
    }
    Some(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

fn fetch_link_preview_blocking(url: String) -> Result<Value, String> {
    let parsed = Url::parse(&url).map_err(|error| error.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only HTTP and HTTPS links are supported.".to_string());
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("Datagrid/1.4 link preview")
        .build()
        .map_err(|error| error.to_string())?;
    let response = client.get(parsed.clone()).send().map_err(|error| error.to_string())?;
    let final_url = response.url().clone();
    let html = response.text().map_err(|error| error.to_string())?;
    let title_regex = Regex::new(r"(?is)<title[^>]*>(.*?)</title>").unwrap();
    let title = meta_content(&html, "og:title")
        .or_else(|| title_regex.captures(&html).and_then(|captures| captures.get(1)).map(|value| decode_html(value.as_str().trim())))
        .unwrap_or_else(|| final_url.host_str().unwrap_or("Saved link").to_string());
    let description = meta_content(&html, "og:description")
        .or_else(|| meta_content(&html, "description"))
        .unwrap_or_default();
    let site_name = meta_content(&html, "og:site_name").unwrap_or_else(|| final_url.host_str().unwrap_or("").trim_start_matches("www.").to_string());
    let image_url = meta_content(&html, "og:image").and_then(|value| final_url.join(&value).ok()).map(|value| value.to_string());
    let image_data_url = image_url.as_ref().and_then(|image| download_image_data_url(&client, image));
    let domain = final_url.host_str().unwrap_or("").trim_start_matches("www.").to_string();
    let favicon_url = final_url.join("/favicon.ico").ok().map(|value| value.to_string());
    let favicon_data_url = favicon_url.as_ref().and_then(|favicon| download_image_data_url(&client, favicon));
    Ok(json!({
        "title": title,
        "description": description,
        "siteName": site_name,
        "domain": domain,
        "imageUrl": image_url,
        "imageDataUrl": image_data_url,
        "faviconUrl": favicon_url,
        "faviconDataUrl": favicon_data_url
    }))
}

#[tauri::command]
async fn fetch_link_preview(url: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_link_preview_blocking(url))
        .await
        .map_err(|error| error.to_string())?
}

fn fetch_image_data_url_blocking(url: String) -> Result<String, String> {
    let parsed = Url::parse(&url).map_err(|error| error.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only HTTP and HTTPS image sources are supported.".to_string());
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("Datagrid/1.4 pasted image")
        .build()
        .map_err(|error| error.to_string())?;
    download_image_data_url(&client, parsed.as_str())
        .ok_or_else(|| "Could not download the pasted image.".to_string())
}

#[tauri::command]
async fn fetch_image_data_url(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_image_data_url_blocking(url))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            git_environment,
            connect_repository,
            sync_repository,
            repository_status,
            push_pending_commits,
            list_canvases,
            load_canvas,
            save_canvas,
            create_canvas,
            rename_canvas,
            duplicate_canvas,
            delete_canvas,
            reveal_library,
            fetch_link_preview,
            fetch_image_data_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running Datagrid");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canvas_directory_round_trip_preserves_external_assets() {
        let test_root = std::env::temp_dir().join(format!("datagrid-files-test-{}", Uuid::new_v4()));
        let path = test_root.join("canvases").join("Portable canvas");
        let document = json!({
            "version": 1,
            "id": "canvas-test",
            "name": "Portable canvas",
            "accent": "#6c63ff",
            "font": "Figtree Variable",
            "viewport": { "x": 0, "y": 0, "zoom": 1 },
            "createdAt": "0",
            "updatedAt": "0",
            "cards": [
                {
                    "id": "note-one", "type": "text", "x": 0, "y": 0, "w": 1, "h": 2,
                    "color": "#6c63ff", "createdAt": "0", "html": "<h2>Heading</h2>", "blocks": []
                },
                {
                    "id": "image-one", "type": "image", "x": 1, "y": 0, "w": 1, "h": 1,
                    "color": "#ff5d73", "createdAt": "0", "fileName": "pixel.png", "mimeType": "image/png",
                    "label": "Tiny pixel", "naturalWidth": 1, "naturalHeight": 1,
                    "dataUrl": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
                },
                {
                    "id": "sheet-one", "type": "spreadsheet", "x": 0, "y": 2, "w": 2, "h": 2,
                    "color": "#00a995", "createdAt": "0", "rows": 2, "columns": 2,
                    "cells": [["Item", "Value"], ["Total", "=SUM(B1:B1)"]]
                }
            ]
        });

        save_document(&path, &document).unwrap();
        let reopened = read_document(&path).unwrap();
        assert_eq!(reopened, document);
        assert!(path.join("canvas.md").is_file());
        assert!(path.join("images/image-one-pixel.png").is_file());
        assert!(path.join("spreadsheets/sheet-one.csv").is_file());

        fs::remove_dir_all(test_root).unwrap();
    }
}
