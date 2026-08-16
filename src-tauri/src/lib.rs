use std::{process::Command, sync::Arc};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone)]
struct Runtime(Arc<std::sync::Mutex<Option<std::process::Child>>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunRequest { file: String, urls: Vec<String>, one: bool }

#[tauri::command]
fn run_test(app: AppHandle, runtime: State<'_, Runtime>, request: RunRequest) -> Result<(), String> {
    if request.file.trim().is_empty() || request.urls.is_empty() {
        return Err("请选择测试文件并至少填写一个 URL。".into());
    }
    let launcher = app.path().resource_dir().map_err(|e| e.to_string())?.join("Auto-Test.cmd");
    let mut args = vec!["run".to_string(), "--file".into(), request.file];
    for url in request.urls.into_iter().filter(|u| !u.trim().is_empty()) {
        args.extend(["--url".into(), url]);
    }
    if request.one { args.push("--one".into()); }
    let mut command = Command::new("cmd");
    command.args(["/c", launcher.to_string_lossy().as_ref()]).args(args).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *runtime.0.lock().unwrap() = Some(child);
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        for stream in [stdout, stderr].into_iter().flatten() {
            for line in BufReader::new(stream).lines().flatten() { let _ = app.emit("run-output", line); }
        }
        let _ = app.emit("run-finished", true);
    });
    Ok(())
}

#[tauri::command]
fn stop_test(runtime: State<'_, Runtime>) -> Result<(), String> {
    if let Some(mut child) = runtime.0.lock().unwrap().take() { child.kill().map_err(|e| e.to_string())?; }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Runtime(Arc::new(std::sync::Mutex::new(None))))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![run_test, stop_test])
        .run(tauri::generate_context!())
        .expect("error while running Auto-Test");
}
