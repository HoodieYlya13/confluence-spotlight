mod mcp;

pub use mcp::{ask, McpConfig};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[derive(Serialize)]
struct AnswerPayload {
    answer: String,
    role: String,
}

#[tauri::command]
async fn ask_question(
    state: tauri::State<'_, McpConfig>,
    question: String,
) -> Result<AnswerPayload, String> {
    let config = state.inner().clone();
    let trimmed = question.trim();
    if trimmed.is_empty() {
        return Err("Type a question first.".to_string());
    }

    let answer = mcp::ask(&config, trimmed)
        .await
        .map_err(|error| error.to_string())?;

    Ok(AnswerPayload {
        answer,
        role: config.role_label,
    })
}

#[tauri::command]
fn role_label(state: tauri::State<'_, McpConfig>) -> String {
    state.inner().role_label.clone()
}

#[tauri::command]
fn hide_window(window: tauri::Window) {
    let _ = window.hide();
}

fn toggle_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }

    let _ = window.center();
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit("spotlight-open", ());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = McpConfig::from_env();
    let hotkey = config.hotkey.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(config)
        .invoke_handler(tauri::generate_handler![
            ask_question,
            role_label,
            hide_window
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let registration = handle.global_shortcut().on_shortcut(
                hotkey.as_str(),
                move |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        toggle_window(app);
                    }
                },
            );
            if let Err(error) = registration {
                eprintln!("Failed to register global shortcut '{hotkey}': {error}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(false) = event {
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
