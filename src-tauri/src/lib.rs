use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use regex::Regex;
use reqwest::blocking::Client;
use reqwest::header::CONTENT_TYPE;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const ODT_MIMETYPE: &str = "application/vnd.oasis.opendocument.text";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanvasFile {
    path: String,
    name: String,
    modified_at: String,
    size: u64,
    emoji: Option<String>,
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
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

fn timestamp(value: SystemTime) -> String {
    value
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

fn canvas_emoji(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut archive = ZipArchive::new(file).ok()?;
    let mut entry = archive.by_name("META-INF/datagrid.json").ok()?;
    let mut contents = String::new();
    entry.read_to_string(&mut contents).ok()?;
    serde_json::from_str::<Value>(&contents)
        .ok()?
        .get("emoji")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn canvas_file(path: &Path) -> Result<CanvasFile, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    Ok(CanvasFile {
        path: path.to_string_lossy().to_string(),
        name: path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Untitled canvas")
            .to_string(),
        modified_at: timestamp(metadata.modified().unwrap_or(UNIX_EPOCH)),
        size: metadata.len(),
        emoji: canvas_emoji(path),
    })
}

fn unique_canvas_path(folder: &Path, requested_name: &str) -> PathBuf {
    let name = sanitize_file_name(requested_name);
    let first = folder.join(format!("{name}.odt"));
    if !first.exists() {
        return first;
    }
    for suffix in 2..10_000 {
        let candidate = folder.join(format!("{name} {suffix}.odt"));
        if !candidate.exists() {
            return candidate;
        }
    }
    folder.join(format!("{name} {}.odt", Uuid::new_v4()))
}

fn write_entry(
    zip: &mut ZipWriter<Cursor<Vec<u8>>>,
    path: &str,
    contents: &[u8],
    stored: bool,
) -> Result<(), String> {
    let method = if stored {
        CompressionMethod::Stored
    } else {
        CompressionMethod::Deflated
    };
    zip.start_file(path, SimpleFileOptions::default().compression_method(method))
        .map_err(|error| error.to_string())?;
    zip.write_all(contents).map_err(|error| error.to_string())
}

fn render_runs(runs: &[Value]) -> String {
    runs.iter()
        .map(|run| {
            let text = escape_xml(run.get("text").and_then(Value::as_str).unwrap_or(""));
            let bold = run.get("bold").and_then(Value::as_bool).unwrap_or(false);
            let italic = run.get("italic").and_then(Value::as_bool).unwrap_or(false);
            let underline = run.get("underline").and_then(Value::as_bool).unwrap_or(false);
            let href = run.get("href").and_then(Value::as_str);
            let mut value = text;
            if bold || italic {
                let style = match (bold, italic) {
                    (true, true) => "BoldItalic",
                    (true, false) => "Bold",
                    _ => "Italic",
                };
                value = format!("<text:span text:style-name=\"{style}\">{value}</text:span>");
            }
            if underline {
                value = format!("<text:span text:style-name=\"Underline\">{value}</text:span>");
            }
            if let Some(link) = href {
                value = format!(
                    "<text:a xlink:type=\"simple\" xlink:href=\"{}\">{value}</text:a>",
                    escape_xml(link)
                );
            }
            value
        })
        .collect::<Vec<_>>()
        .join("")
}

fn render_text_card(card: &Value) -> String {
    let blocks = card.get("blocks").and_then(Value::as_array);
    let Some(blocks) = blocks else {
        return "<text:p/>".to_string();
    };
    let mut output = String::new();
    let mut list_kind: Option<&str> = None;
    for block in blocks {
        let kind = block.get("kind").and_then(Value::as_str).unwrap_or("paragraph");
        let runs = block
            .get("runs")
            .and_then(Value::as_array)
            .map(|value| value.as_slice())
            .unwrap_or(&[]);
        let rendered = render_runs(runs);
        let desired_list = match kind {
            "unordered-item" => Some("BulletList"),
            "ordered-item" => Some("NumberList"),
            _ => None,
        };
        if list_kind != desired_list {
            if list_kind.is_some() {
                output.push_str("</text:list>");
            }
            if let Some(style) = desired_list {
                output.push_str(&format!("<text:list text:style-name=\"{style}\">"));
            }
            list_kind = desired_list;
        }
        match kind {
            "heading" => output.push_str(&format!("<text:h text:outline-level=\"1\">{rendered}</text:h>")),
            "unordered-item" | "ordered-item" => {
                output.push_str(&format!("<text:list-item><text:p>{rendered}</text:p></text:list-item>"));
            }
            "checklist-item" => {
                let checked = block.get("checked").and_then(Value::as_bool).unwrap_or(false);
                let mark = if checked { "\u{2611}" } else { "\u{2610}" };
                output.push_str(&format!("<text:p>{mark} {rendered}</text:p>"));
            }
            _ => output.push_str(&format!("<text:p>{rendered}</text:p>")),
        }
    }
    if list_kind.is_some() {
        output.push_str("</text:list>");
    }
    output
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

fn spreadsheet_content(card: &Value) -> String {
    let cells = card.get("cells").and_then(Value::as_array).cloned().unwrap_or_default();
    let rows = cells
        .iter()
        .map(|row| {
            let columns = row
                .as_array()
                .map(|values| {
                    values.iter()
                        .map(|cell| {
                            let value = cell.as_str().unwrap_or("");
                            if let Some(formula) = value.strip_prefix('=') {
                                format!("<table:table-cell table:formula=\"of:={}\" office:value-type=\"string\"><text:p>{}</text:p></table:table-cell>", escape_xml(formula), escape_xml(value))
                            } else {
                                format!("<table:table-cell office:value-type=\"string\"><text:p>{}</text:p></table:table-cell>", escape_xml(value))
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default();
            format!("<table:table-row>{columns}</table:table-row>")
        })
        .collect::<Vec<_>>()
        .join("");
    format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" office:version="1.3"><office:body><office:spreadsheet><table:table table:name="Sheet 1">{rows}</table:table></office:spreadsheet></office:body></office:document-content>"#)
}

fn basic_styles(font: &str) -> String {
    format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.3"><office:font-face-decls><style:font-face style:name="DatagridFont" svg:font-family="{}"/></office:font-face-decls><office:styles><style:default-style style:family="paragraph"><style:text-properties style:font-name="DatagridFont"/></style:default-style><style:style style:name="ImageLabel" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/></style:style><style:style style:name="Bold" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style><style:style style:name="Italic" style:family="text"><style:text-properties fo:font-style="italic"/></style:style><style:style style:name="BoldItalic" style:family="text"><style:text-properties fo:font-weight="bold" fo:font-style="italic"/></style:style><style:style style:name="Underline" style:family="text"><style:text-properties style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"/></style:style><text:list-style style:name="BulletList"><text:list-level-style-bullet text:level="1" text:bullet-char="•"/></text:list-style><text:list-style style:name="NumberList"><text:list-level-style-number text:level="1" style:num-format="1"/></text:list-style></office:styles></office:document-styles>"#, escape_xml(font))
}

fn build_odt(document: &Value) -> Result<Vec<u8>, String> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    write_entry(&mut zip, "mimetype", ODT_MIMETYPE.as_bytes(), true)?;

    let mut body = String::new();
    let mut assets: Vec<(String, String, Vec<u8>)> = Vec::new();
    let mut objects: Vec<(String, String)> = Vec::new();
    let mut cards = document.get("cards").and_then(Value::as_array).cloned().unwrap_or_default();
    cards.sort_by_key(|card| {
        (
            card.get("y").and_then(Value::as_i64).unwrap_or(0),
            card.get("x").and_then(Value::as_i64).unwrap_or(0),
        )
    });

    for card in &cards {
        let card_type = card.get("type").and_then(Value::as_str).unwrap_or("text");
        let id = sanitize_file_name(card.get("id").and_then(Value::as_str).unwrap_or("card"));
        match card_type {
            "text" => body.push_str(&render_text_card(card)),
            "image" => {
                if let Some((mime, bytes)) = card.get("dataUrl").and_then(Value::as_str).and_then(data_url_parts) {
                    let path = format!("Pictures/{id}.{}", extension_for_mime(mime));
                    assets.push((path.clone(), mime.to_string(), bytes));
                    body.push_str(&format!("<text:p><draw:frame draw:name=\"{}\" text:anchor-type=\"paragraph\" svg:width=\"14cm\" svg:height=\"9cm\"><draw:image xlink:href=\"{}\" xlink:type=\"simple\" xlink:show=\"embed\" xlink:actuate=\"onLoad\"/></draw:frame></text:p>", escape_xml(card.get("fileName").and_then(Value::as_str).unwrap_or("Image")), escape_xml(&path)));
                    if let Some(label) = card
                        .get("label")
                        .and_then(Value::as_str)
                        .filter(|label| !label.trim().is_empty())
                    {
                        body.push_str(&format!(
                            "<text:p text:style-name=\"ImageLabel\">{}</text:p>",
                            escape_xml(label.trim())
                        ));
                    }
                }
            }
            "spreadsheet" => {
                let object_path = format!("Objects/{id}");
                objects.push((object_path.clone(), spreadsheet_content(card)));
                body.push_str(&format!("<text:p><draw:frame draw:name=\"Spreadsheet\" text:anchor-type=\"paragraph\" svg:width=\"16cm\" svg:height=\"9cm\"><draw:object xlink:href=\"./{}\" xlink:type=\"simple\" xlink:show=\"embed\" xlink:actuate=\"onLoad\"/></draw:frame></text:p>", escape_xml(&object_path)));
            }
            "link" => {
                let url = card.get("url").and_then(Value::as_str).unwrap_or("");
                let preview = card.get("preview").unwrap_or(&Value::Null);
                let title = preview.get("title").and_then(Value::as_str).unwrap_or(url);
                let description = preview.get("description").and_then(Value::as_str).unwrap_or("");
                body.push_str(&format!("<text:h text:outline-level=\"2\"><text:a xlink:type=\"simple\" xlink:href=\"{}\">{}</text:a></text:h><text:p>{}</text:p><text:p>{}</text:p>", escape_xml(url), escape_xml(title), escape_xml(description), escape_xml(url)));
                if let Some((mime, bytes)) = preview.get("imageDataUrl").and_then(Value::as_str).and_then(data_url_parts) {
                    let path = format!("Pictures/{id}-preview.{}", extension_for_mime(mime));
                    assets.push((path, mime.to_string(), bytes));
                }
            }
            _ => {}
        }
    }

    let content = format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3"><office:body><office:text><text:h text:outline-level="1">{}</text:h>{body}</office:text></office:body></office:document-content>"#, escape_xml(document.get("name").and_then(Value::as_str).unwrap_or("Datagrid canvas")));

    write_entry(&mut zip, "content.xml", content.as_bytes(), false)?;
    let font = document.get("font").and_then(Value::as_str).unwrap_or("Figtree");
    let styles = basic_styles(font);
    write_entry(&mut zip, "styles.xml", styles.as_bytes(), false)?;
    write_entry(&mut zip, "meta.xml", br#"<?xml version="1.0" encoding="UTF-8"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.3"><office:meta><meta:generator>Datagrid</meta:generator></office:meta></office:document-meta>"#, false)?;
    write_entry(&mut zip, "settings.xml", br#"<?xml version="1.0" encoding="UTF-8"?><office:document-settings xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.3"><office:settings/></office:document-settings>"#, false)?;
    write_entry(&mut zip, "datagrid/layout.json", serde_json::to_string_pretty(document).map_err(|error| error.to_string())?.as_bytes(), false)?;

    for (path, _, bytes) in &assets {
        write_entry(&mut zip, path, bytes, false)?;
    }
    for (path, content) in &objects {
        write_entry(&mut zip, &format!("{path}/content.xml"), content.as_bytes(), false)?;
        write_entry(&mut zip, &format!("{path}/styles.xml"), styles.as_bytes(), false)?;
        write_entry(&mut zip, &format!("{path}/mimetype"), b"application/vnd.oasis.opendocument.spreadsheet", true)?;
    }

    let mut manifest = String::from(r#"<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="settings.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="datagrid/layout.json" manifest:media-type="application/json"/>"#);
    for (path, mime, _) in &assets {
        manifest.push_str(&format!("<manifest:file-entry manifest:full-path=\"{}\" manifest:media-type=\"{}\"/>", escape_xml(path), escape_xml(mime)));
    }
    for (path, _) in &objects {
        manifest.push_str(&format!("<manifest:file-entry manifest:full-path=\"{}/\" manifest:media-type=\"application/vnd.oasis.opendocument.spreadsheet\"/><manifest:file-entry manifest:full-path=\"{}/content.xml\" manifest:media-type=\"text/xml\"/><manifest:file-entry manifest:full-path=\"{}/styles.xml\" manifest:media-type=\"text/xml\"/><manifest:file-entry manifest:full-path=\"{}/mimetype\" manifest:media-type=\"text/plain\"/>", escape_xml(path), escape_xml(path), escape_xml(path), escape_xml(path)));
    }
    manifest.push_str("</manifest:manifest>");
    write_entry(&mut zip, "META-INF/manifest.xml", manifest.as_bytes(), false)?;

    zip.finish().map(|cursor| cursor.into_inner()).map_err(|error| error.to_string())
}

fn save_document(path: &Path, document: &Value) -> Result<(), String> {
    let bytes = build_odt(document)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temp = path.with_extension("odt.datagrid-tmp");
    let backup = path.with_extension("odt.datagrid-backup");
    fs::write(&temp, bytes).map_err(|error| error.to_string())?;
    if path.exists() {
        if backup.exists() {
            let _ = fs::remove_file(&backup);
        }
        fs::rename(path, &backup).map_err(|error| error.to_string())?;
    }
    if let Err(error) = fs::rename(&temp, path) {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err(error.to_string());
    }
    if backup.exists() {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

fn read_document(path: &Path) -> Result<Value, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
    let mut layout = String::new();
    archive
        .by_name("datagrid/layout.json")
        .map_err(|_| "This ODT is not a Datagrid canvas.".to_string())?
        .read_to_string(&mut layout)
        .map_err(|error| error.to_string())?;
    serde_json::from_str(&layout).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_canvases(folder: String) -> Result<Vec<CanvasFile>, String> {
    let folder = PathBuf::from(folder);
    fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let mut files = fs::read_dir(folder)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()).map(|value| value.eq_ignore_ascii_case("odt")).unwrap_or(false))
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
async fn save_canvas(path: String, document: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_document(Path::new(&path), &document))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn create_canvas(folder: String, name: String) -> Result<CanvasFile, String> {
    let folder = PathBuf::from(folder);
    fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let path = unique_canvas_path(&folder, &name);
    let actual_name = path.file_stem().and_then(|value| value.to_str()).unwrap_or("Untitled canvas");
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
    canvas_file(&path)
}

#[tauri::command]
fn rename_canvas(path: String, name: String) -> Result<CanvasFile, String> {
    let old_path = PathBuf::from(path);
    let parent = old_path.parent().ok_or("Canvas path has no parent folder.")?;
    let new_path = unique_canvas_path(parent, &name);
    let mut document = read_document(&old_path)?;
    let actual_name = new_path.file_stem().and_then(|value| value.to_str()).unwrap_or("Untitled canvas");
    document["name"] = Value::String(actual_name.to_string());
    document["updatedAt"] = Value::String(timestamp(SystemTime::now()));
    save_document(&new_path, &document)?;
    fs::remove_file(old_path).map_err(|error| error.to_string())?;
    canvas_file(&new_path)
}

#[tauri::command]
fn duplicate_canvas(path: String) -> Result<CanvasFile, String> {
    let source_path = PathBuf::from(path);
    let parent = source_path.parent().ok_or("Canvas path has no parent folder.")?;
    let mut document = read_document(&source_path)?;
    let source_name = document.get("name").and_then(Value::as_str).unwrap_or("Untitled canvas");
    let new_path = unique_canvas_path(parent, &format!("{source_name} copy"));
    let actual_name = new_path.file_stem().and_then(|value| value.to_str()).unwrap_or("Untitled canvas");
    document["id"] = Value::String(format!("canvas-{}", Uuid::new_v4()));
    document["name"] = Value::String(actual_name.to_string());
    document["updatedAt"] = Value::String(timestamp(SystemTime::now()));
    save_document(&new_path, &document)?;
    canvas_file(&new_path)
}

#[tauri::command]
fn delete_canvas(path: String) -> Result<(), String> {
    let source = PathBuf::from(path);
    let parent = source.parent().ok_or("Canvas path has no parent folder.")?;
    let trash = parent.join(".datagrid-trash");
    fs::create_dir_all(&trash).map_err(|error| error.to_string())?;
    let file_name = source.file_name().ok_or("Canvas path has no file name.")?;
    let mut destination = trash.join(file_name);
    if destination.exists() {
        destination = trash.join(format!("{}-{}", timestamp(SystemTime::now()), file_name.to_string_lossy()));
    }
    fs::rename(source, destination).map_err(|error| error.to_string())
}

#[tauri::command]
fn reveal_library(folder: String) -> Result<(), String> {
    let path = PathBuf::from(folder);
    if !path.is_dir() {
        return Err("The Datagrid library folder could not be found.".to_string());
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
        .map_err(|error| format!("Could not open the Datagrid library folder: {error}"))
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

#[tauri::command]
fn fetch_link_preview(url: String) -> Result<Value, String> {
    let parsed = Url::parse(&url).map_err(|error| error.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only HTTP and HTTPS links are supported.".to_string());
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("Datagrid/0.1 link preview")
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_canvases,
            load_canvas,
            save_canvas,
            create_canvas,
            rename_canvas,
            duplicate_canvas,
            delete_canvas,
            reveal_library,
            fetch_link_preview
        ])
        .run(tauri::generate_context!())
        .expect("error while running Datagrid");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_canvas_round_trip_contains_odf_assets() {
        let test_root = std::env::temp_dir().join(format!("datagrid-odt-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&test_root).unwrap();
        let path = test_root.join("Portable canvas.odt");
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
                    "color": "#6c63ff", "createdAt": "0", "html": "<h2>Heading</h2>",
                    "blocks": [{ "kind": "heading", "runs": [{ "text": "Heading", "bold": true }] }]
                },
                {
                    "id": "image-one", "type": "image", "x": 1, "y": 0, "w": 1, "h": 1,
                    "color": "#ff5d73", "createdAt": "0", "fileName": "pixel.png", "mimeType": "image/png",
                    "label": "Tiny pixel",
                    "naturalWidth": 1, "naturalHeight": 1,
                    "dataUrl": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
                },
                {
                    "id": "sheet-one", "type": "spreadsheet", "x": 0, "y": 2, "w": 2, "h": 2,
                    "color": "#00a995", "createdAt": "0", "rows": 2, "columns": 2,
                    "cells": [["Item", "Value"], ["Total", "=SUM(B1:B1)"]]
                },
                {
                    "id": "link-one", "type": "link", "x": 2, "y": 0, "w": 2, "h": 1,
                    "color": "#3485f7", "createdAt": "0", "url": "https://example.com",
                    "preview": { "title": "Example", "description": "Portable link", "siteName": "Example", "domain": "example.com" }
                }
            ]
        });

        save_document(&path, &document).unwrap();
        let reopened = read_document(&path).unwrap();
        assert_eq!(reopened["name"], "Portable canvas");
        assert_eq!(reopened["cards"].as_array().unwrap().len(), 4);
        assert_eq!(reopened["cards"][1]["label"], "Tiny pixel");

        let file = File::open(&path).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        assert_eq!(archive.by_index(0).unwrap().name(), "mimetype");
        assert!(archive.by_name("content.xml").is_ok());
        assert!(archive.by_name("datagrid/layout.json").is_ok());
        assert!(archive.by_name("Pictures/image-one.png").is_ok());
        assert!(archive.by_name("Objects/sheet-one/content.xml").is_ok());
        assert!(archive.by_name("META-INF/manifest.xml").is_ok());
        let mut content_xml = String::new();
        archive
            .by_name("content.xml")
            .unwrap()
            .read_to_string(&mut content_xml)
            .unwrap();
        assert!(content_xml.contains("Tiny pixel"));

        drop(archive);
        fs::remove_dir_all(test_root).unwrap();
    }
}
