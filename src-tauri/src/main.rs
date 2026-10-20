// Acervo: biblioteca de B-roll que arrasta arquivos direto pro editor de vídeo.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

const VIDEO: &[&str] = &[
    "mp4", "mov", "m4v", "webm", "mkv", "avi", "mts", "m2ts", "mxf", "wmv", "flv", "3gp", "mpg",
    "mpeg",
];
const IMAGE: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif", "svg",
];
const AUDIO: &[&str] = &[
    "mp3", "wav", "aac", "m4a", "flac", "ogg", "opus", "aif", "aiff", "wma",
];
const SEARCH_LIMIT: usize = 1500;

/// Pastas do app: cache de miniaturas e arquivo de estado.
struct AppPaths {
    thumbs: PathBuf,
    state_file: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaFile {
    name: String,
    path: String,
    kind: &'static str,
    ext: String,
    size: u64,
    modified: u64,
    key: String,
    thumb: Option<String>,
    meta: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderInfo {
    name: String,
    path: String,
    has_children: bool,
}

#[derive(Serialize)]
struct Listing {
    folders: Vec<FolderInfo>,
    files: Vec<MediaFile>,
}

#[derive(Serialize)]
struct TransferResult {
    done: Vec<String>,
    failed: Vec<String>,
    skipped: usize,
}

#[derive(Serialize, Clone)]
struct TransferProgress {
    done: usize,
    total: usize,
    name: String,
}

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn paths(app: &AppHandle) -> (PathBuf, PathBuf) {
    let p = app.state::<AppPaths>();
    (p.thumbs.clone(), p.state_file.clone())
}

fn kind_of(path: &Path) -> Option<(&'static str, String)> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    let kind = if VIDEO.contains(&ext.as_str()) {
        "video"
    } else if IMAGE.contains(&ext.as_str()) {
        "image"
    } else if AUDIO.contains(&ext.as_str()) {
        "audio"
    } else {
        return None;
    };
    Some((kind, ext))
}

fn is_hidden(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.starts_with('.') || name.starts_with('$') || name.starts_with("~$") {
        return true;
    }
    if name == "System Volume Information" || name == "desktop.ini" || name == "Thumbs.db" {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        if let Ok(m) = fs::symlink_metadata(path) {
            if m.file_attributes() & (HIDDEN | SYSTEM) != 0 {
                return true;
            }
        }
    }
    false
}

/// FNV-1a de 64 bits: chave estável da miniatura (muda se o arquivo mudar).
fn thumb_key(path: &str, size: u64, modified: u64) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in format!("{path}|{size}|{modified}").bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn modified_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn media_file(path: &Path, meta: &fs::Metadata, thumbs: &Path) -> Option<MediaFile> {
    let (kind, ext) = kind_of(path)?;
    let path_str = path.to_string_lossy().to_string();
    let size = meta.len();
    let modified = modified_ms(meta);
    let key = thumb_key(&path_str, size, modified);
    let jpg = thumbs.join(format!("{key}.jpg"));
    let thumb = jpg.exists().then(|| jpg.to_string_lossy().to_string());
    let meta_json = fs::read_to_string(thumbs.join(format!("{key}.json")))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    Some(MediaFile {
        name: path.file_name()?.to_string_lossy().to_string(),
        path: path_str,
        kind,
        ext,
        size,
        modified,
        key,
        thumb,
        meta: meta_json,
    })
}

fn has_subfolder(path: &Path) -> bool {
    fs::read_dir(path)
        .map(|rd| {
            rd.flatten()
                .any(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false) && !is_hidden(&e.path()))
        })
        .unwrap_or(false)
}

fn folder_info(path: &Path) -> FolderInfo {
    FolderInfo {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string()),
        path: path.to_string_lossy().to_string(),
        has_children: has_subfolder(path),
    }
}

fn read_listing(dir: &Path, thumbs: &Path) -> CmdResult<Listing> {
    let mut folders = Vec::new();
    let mut files = Vec::new();
    for entry in fs::read_dir(dir).map_err(err)?.flatten() {
        let path = entry.path();
        if is_hidden(&path) {
            continue;
        }
        let Ok(meta) = fs::metadata(&path) else { continue };
        if meta.is_dir() {
            folders.push(folder_info(&path));
        } else if let Some(f) = media_file(&path, &meta, thumbs) {
            files.push(f);
        }
    }
    folders.sort_by_key(|f| f.name.to_lowercase());
    Ok(Listing { folders, files })
}

/// Minúsculas e sem acento, pra busca achar "acao" em "Ação".
fn normalize(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            'ñ' => 'n',
            '_' | '-' | '.' => ' ',
            other => other,
        })
        .collect()
}

fn walk_media<F: FnMut(&Path, &Path, &fs::Metadata) -> bool>(roots: &[String], mut visit: F) {
    for root in roots {
        let root_path = Path::new(root);
        let walker = walkdir::WalkDir::new(root_path)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || !is_hidden(e.path()));
        for entry in walker.flatten() {
            if !entry.file_type().is_file() || kind_of(entry.path()).is_none() {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if !visit(entry.path(), root_path, &meta) {
                return;
            }
        }
    }
}

fn unique_target(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(name);
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

fn valid_name(name: &str) -> CmdResult<String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." {
        return Err("Nome inválido".into());
    }
    if name.chars().any(|c| "/\\:*?\"<>|".contains(c) || c.is_control()) {
        return Err("O nome não pode ter / \\ : * ? \" < > |".into());
    }
    Ok(name.to_string())
}

fn count_files(path: &Path) -> usize {
    if path.is_dir() {
        walkdir::WalkDir::new(path).into_iter().flatten().filter(|e| e.file_type().is_file()).count()
    } else {
        1
    }
}

fn copy_recursive(src: &Path, dest: &Path, progress: &mut dyn FnMut(&Path)) -> std::io::Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dest)?;
        for entry in fs::read_dir(src)?.flatten() {
            copy_recursive(&entry.path(), &dest.join(entry.file_name()), progress)?;
        }
    } else {
        fs::copy(src, dest)?;
        progress(src);
    }
    Ok(())
}

// ---------- comandos ----------

#[tauri::command]
async fn list_dir(app: AppHandle, path: String) -> CmdResult<Listing> {
    let (thumbs, _) = paths(&app);
    tauri::async_runtime::spawn_blocking(move || read_listing(Path::new(&path), &thumbs))
        .await
        .map_err(err)?
}

#[tauri::command]
async fn subfolders(path: String) -> CmdResult<Vec<FolderInfo>> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut list: Vec<FolderInfo> = fs::read_dir(&path)
            .map_err(err)?
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir() && !is_hidden(p))
            .map(|p| folder_info(&p))
            .collect();
        list.sort_by_key(|f| f.name.to_lowercase());
        Ok(list)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn search(app: AppHandle, roots: Vec<String>, query: String) -> CmdResult<Vec<MediaFile>> {
    let (thumbs, _) = paths(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let terms: Vec<String> = normalize(&query).split_whitespace().map(String::from).collect();
        let mut out = Vec::new();
        if terms.is_empty() {
            return out;
        }
        walk_media(&roots, |path, root, meta| {
            let rel = path.strip_prefix(root).unwrap_or(path).to_string_lossy();
            let hay = normalize(&rel);
            if terms.iter().all(|t| hay.contains(t.as_str())) {
                if let Some(f) = media_file(path, meta, &thumbs) {
                    out.push(f);
                }
            }
            out.len() < SEARCH_LIMIT
        });
        out
    })
    .await
    .map_err(err)
}

#[tauri::command]
async fn recent(app: AppHandle, roots: Vec<String>, limit: usize) -> CmdResult<Vec<MediaFile>> {
    let (thumbs, _) = paths(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let mut found: Vec<(u64, PathBuf)> = Vec::new();
        walk_media(&roots, |path, _, meta| {
            found.push((modified_ms(meta), path.to_path_buf()));
            true
        });
        found.sort_by(|a, b| b.0.cmp(&a.0));
        found
            .into_iter()
            .take(limit)
            .filter_map(|(_, p)| fs::metadata(&p).ok().and_then(|m| media_file(&p, &m, &thumbs)))
            .collect()
    })
    .await
    .map_err(err)
}

#[tauri::command]
async fn files_info(app: AppHandle, paths_list: Vec<String>) -> CmdResult<Vec<MediaFile>> {
    let (thumbs, _) = paths(&app);
    tauri::async_runtime::spawn_blocking(move || {
        paths_list
            .iter()
            .map(PathBuf::from)
            .filter_map(|p| fs::metadata(&p).ok().filter(|m| m.is_file()).and_then(|m| media_file(&p, &m, &thumbs)))
            .collect()
    })
    .await
    .map_err(err)
}

#[tauri::command]
async fn create_folder(parent: String, name: String) -> CmdResult<String> {
    let name = valid_name(&name)?;
    let target = unique_target(Path::new(&parent), &name);
    fs::create_dir_all(&target).map_err(err)?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
async fn rename_path(path: String, new_name: String) -> CmdResult<String> {
    let name = valid_name(&new_name)?;
    let src = PathBuf::from(&path);
    let parent = src.parent().ok_or("Caminho inválido")?;
    let target = parent.join(&name);
    // No Windows/macOS o nome não diferencia maiúsculas: deixa trocar só a caixa.
    let same_file = target.to_string_lossy().to_lowercase() == src.to_string_lossy().to_lowercase();
    if target.exists() && !same_file {
        return Err("Já existe um item com esse nome aqui".into());
    }
    fs::rename(&src, &target).map_err(err)?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
async fn trash_paths(paths_list: Vec<String>) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || trash::delete_all(&paths_list).map_err(err))
        .await
        .map_err(err)?
}

/// Copia ou move arquivos/pastas para `dest`, avisando o progresso por evento.
#[tauri::command]
async fn transfer(app: AppHandle, paths_list: Vec<String>, dest: String, mode: String) -> CmdResult<TransferResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest = PathBuf::from(&dest);
        if !dest.is_dir() {
            return Err("A pasta de destino não existe".to_string());
        }
        let moving = mode == "move";
        let total: usize = paths_list.iter().map(|p| count_files(Path::new(p))).sum();
        let mut done_count = 0usize;
        let mut result = TransferResult { done: vec![], failed: vec![], skipped: 0 };

        for src_str in &paths_list {
            let src = PathBuf::from(src_str);
            let Some(name) = src.file_name().map(|n| n.to_string_lossy().to_string()) else { continue };
            // Soltar na mesma pasta de onde saiu, ou uma pasta dentro dela mesma: ignora.
            if src.parent() == Some(dest.as_path()) || dest.starts_with(&src) {
                result.skipped += 1;
                continue;
            }
            let target = unique_target(&dest, &name);
            let mut report = |file: &Path| {
                done_count += 1;
                let _ = app.emit(
                    "transfer-progress",
                    TransferProgress {
                        done: done_count,
                        total,
                        name: file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                    },
                );
            };
            let outcome = if moving {
                match fs::rename(&src, &target) {
                    Ok(()) => {
                        report(&src);
                        Ok(())
                    }
                    // Outro disco: copia e depois apaga a origem.
                    Err(_) => copy_recursive(&src, &target, &mut report).and_then(|_| {
                        if src.is_dir() {
                            fs::remove_dir_all(&src)
                        } else {
                            fs::remove_file(&src)
                        }
                    }),
                }
            } else {
                copy_recursive(&src, &target, &mut report)
            };
            match outcome {
                Ok(()) => result.done.push(target.to_string_lossy().to_string()),
                Err(e) => result.failed.push(format!("{name}: {e}")),
            }
        }
        Ok(result)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> CmdResult<Option<String>> {
    let picked = app
        .dialog()
        .file()
        .set_title("Escolha a pasta dos seus B-rolls")
        .blocking_pick_folder();
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
async fn pick_files(app: AppHandle) -> CmdResult<Vec<String>> {
    let exts: Vec<&str> = VIDEO.iter().chain(IMAGE).chain(AUDIO).copied().collect();
    let picked = app
        .dialog()
        .file()
        .set_title("Importar arquivos")
        .add_filter("Vídeos, imagens e áudios", &exts)
        .blocking_pick_files()
        .unwrap_or_default();
    Ok(picked
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
        .collect())
}

/// Cria "Acervo B-roll" dentro da pasta Vídeos (Windows) ou Filmes (Mac).
#[tauri::command]
async fn create_default_library(app: AppHandle) -> CmdResult<String> {
    let base = app
        .path()
        .video_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(err)?;
    let dir = base.join("Acervo B-roll");
    for sub in ["Vídeos", "Imagens", "Áudios"] {
        fs::create_dir_all(dir.join(sub)).map_err(err)?;
    }
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
async fn save_thumb(app: AppHandle, key: String, data: Option<String>, meta: Value) -> CmdResult<Option<String>> {
    if key.len() != 16 || !key.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Chave inválida".into());
    }
    let (thumbs, _) = paths(&app);
    fs::create_dir_all(&thumbs).map_err(err)?;
    fs::write(thumbs.join(format!("{key}.json")), meta.to_string()).map_err(err)?;
    let Some(data) = data else { return Ok(None) };
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(err)?;
    let jpg = thumbs.join(format!("{key}.jpg"));
    fs::write(&jpg, bytes).map_err(err)?;
    Ok(Some(jpg.to_string_lossy().to_string()))
}

#[tauri::command]
async fn load_state(app: AppHandle) -> CmdResult<Value> {
    let (_, state_file) = paths(&app);
    Ok(fs::read_to_string(state_file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null))
}

#[tauri::command]
async fn save_state(app: AppHandle, state: Value) -> CmdResult<()> {
    let (_, state_file) = paths(&app);
    if let Some(dir) = state_file.parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    let tmp = state_file.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(&state).map_err(err)?).map_err(err)?;
    fs::rename(&tmp, &state_file).map_err(err)
}

#[tauri::command]
async fn path_kinds(paths_list: Vec<String>) -> Vec<bool> {
    paths_list.iter().map(|p| Path::new(p).is_dir()).collect()
}

/// Abre o Explorer/Finder com o item selecionado.
#[tauri::command]
async fn reveal(path: String) -> CmdResult<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        Command::new("explorer").raw_arg(format!("/select,\"{path}\"")).spawn().map_err(err)?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg("-R").arg(&path).spawn().map_err(err)?;
    }
    #[cfg(target_os = "linux")]
    {
        let dir = Path::new(&path).parent().unwrap_or(Path::new("/"));
        Command::new("xdg-open").arg(dir).spawn().map_err(err)?;
    }
    Ok(())
}

/// Abre no programa padrão do sistema.
#[tauri::command]
async fn open_default(path: String) -> CmdResult<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        Command::new("explorer").raw_arg(format!("\"{path}\"")).spawn().map_err(err)?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(&path).spawn().map_err(err)?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open").arg(&path).spawn().map_err(err)?;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let cache = app.path().app_cache_dir()?;
            let config = app.path().app_config_dir()?;
            app.manage(AppPaths {
                thumbs: cache.join("thumbs"),
                state_file: config.join("state.json"),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_dir,
            subfolders,
            search,
            recent,
            files_info,
            create_folder,
            rename_path,
            trash_paths,
            transfer,
            pick_folder,
            pick_files,
            create_default_library,
            save_thumb,
            load_state,
            save_state,
            path_kinds,
            reveal,
            open_default
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Acervo");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifica_extensoes() {
        assert_eq!(kind_of(Path::new("a/B.MP4")).unwrap().0, "video");
        assert_eq!(kind_of(Path::new("foto.HEIC")).unwrap().0, "image");
        assert_eq!(kind_of(Path::new("trilha.wav")).unwrap().0, "audio");
        assert!(kind_of(Path::new("projeto.psd")).is_none());
        assert!(kind_of(Path::new("sem_extensao")).is_none());
    }

    #[test]
    fn normaliza_busca() {
        assert_eq!(normalize("Ação_Drone-01.MP4"), "acao drone 01 mp4");
    }

    #[test]
    fn nome_unico_nao_sobrescreve() {
        let dir = std::env::temp_dir().join(format!("acervo-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("clipe.mp4"), b"x").unwrap();
        fs::write(dir.join("clipe (2).mp4"), b"x").unwrap();
        assert_eq!(unique_target(&dir, "clipe.mp4"), dir.join("clipe (3).mp4"));
        assert_eq!(unique_target(&dir, "novo.mp4"), dir.join("novo.mp4"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn valida_nomes() {
        assert!(valid_name("Praia 2024").is_ok());
        assert!(valid_name("a/b").is_err());
        assert!(valid_name("  ").is_err());
    }

    #[test]
    fn chave_muda_com_arquivo() {
        assert_ne!(thumb_key("a.mp4", 1, 1), thumb_key("a.mp4", 2, 1));
        assert_eq!(thumb_key("a.mp4", 1, 1).len(), 16);
    }
}
