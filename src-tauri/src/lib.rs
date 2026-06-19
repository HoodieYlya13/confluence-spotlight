#![allow(clippy::unused_unit)]

mod mcp;

pub use mcp::{ask, McpConfig};

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{ActivationPolicy, AppHandle, Emitter, Manager};
use tauri_nspanel::{
    tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

tauri_panel! {
    panel!(SpotlightPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })

    panel_event!(SpotlightPanelEvents {
        window_did_resign_key(notification: &NSNotification) -> ()
    })
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct Session {
    role: Option<String>,
    hotkey: Option<String>,
}

struct AppState {
    config: McpConfig,
    session: Mutex<Session>,
    session_path: PathBuf,
}

#[derive(Serialize)]
struct RoleOption {
    key: String,
    label: String,
    available: bool,
}

#[derive(Serialize)]
struct SessionView {
    role: Option<String>,
    role_label: Option<String>,
    hotkey: String,
    roles: Vec<RoleOption>,
}

#[derive(Serialize)]
struct AnswerPayload {
    answer: String,
    role: String,
}

fn load_session(path: &PathBuf) -> Session {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_session(path: &PathBuf, session: &Session) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(raw) = serde_json::to_string_pretty(session) {
        let _ = std::fs::write(path, raw);
    }
}

fn session_view(state: &AppState) -> SessionView {
    let session = state.session.lock().unwrap();
    let hotkey = session
        .hotkey
        .clone()
        .unwrap_or_else(|| state.config.default_hotkey.clone());
    let role = session.role.clone();
    let role_label = role
        .as_deref()
        .and_then(mcp::role_label)
        .map(|label| label.to_string());
    let roles = mcp::ROLES
        .iter()
        .map(|(key, label)| RoleOption {
            key: key.to_string(),
            label: label.to_string(),
            available: state.config.has_token(key),
        })
        .collect();

    SessionView {
        role,
        role_label,
        hotkey,
        roles,
    }
}

#[tauri::command]
fn get_session(state: tauri::State<'_, AppState>) -> SessionView {
    session_view(state.inner())
}

#[tauri::command]
fn login(state: tauri::State<'_, AppState>, role: String) -> Result<SessionView, String> {
    if mcp::role_label(&role).is_none() {
        return Err(format!("Unknown role '{role}'."));
    }
    if !state.config.has_token(&role) {
        return Err(format!(
            "No token is configured for {role}. Set its MCP_TOKEN_… value in .env."
        ));
    }

    {
        let mut session = state.session.lock().unwrap();
        session.role = Some(role);
        save_session(&state.session_path, &session);
    }

    Ok(session_view(state.inner()))
}

#[tauri::command]
fn logout(state: tauri::State<'_, AppState>) -> SessionView {
    {
        let mut session = state.session.lock().unwrap();
        session.role = None;
        save_session(&state.session_path, &session);
    }

    session_view(state.inner())
}

#[tauri::command]
fn set_hotkey(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    hotkey: String,
) -> Result<String, String> {
    let trimmed = hotkey.trim().to_string();
    if trimmed.is_empty() {
        return Err("Empty shortcut.".to_string());
    }

    let current = {
        let session = state.session.lock().unwrap();
        session
            .hotkey
            .clone()
            .unwrap_or_else(|| state.config.default_hotkey.clone())
    };

    let _ = app.global_shortcut().unregister(current.as_str());
    if let Err(error) = register_hotkey(&app, &trimmed) {
        let _ = register_hotkey(&app, &current);
        return Err(format!("Could not register '{trimmed}': {error}"));
    }

    {
        let mut session = state.session.lock().unwrap();
        session.hotkey = Some(trimmed.clone());
        save_session(&state.session_path, &session);
    }

    Ok(trimmed)
}

#[tauri::command]
async fn ask_question(
    state: tauri::State<'_, AppState>,
    question: String,
) -> Result<AnswerPayload, String> {
    let trimmed = question.trim().to_string();
    if trimmed.is_empty() {
        return Err("Type a question first.".to_string());
    }

    let (server_url, token, role_label) = {
        let session = state.session.lock().unwrap();
        let Some(role) = session.role.clone() else {
            return Err("Not connected. Open the spotlight and sign in first.".to_string());
        };
        let Some(token) = state.config.token_for(&role) else {
            return Err(format!("No token is configured for {role}."));
        };
        let label = mcp::role_label(&role).unwrap_or(&role).to_string();
        (state.config.server_url.clone(), token.to_string(), label)
    };

    let answer = mcp::ask(&server_url, &token, &trimmed)
        .await
        .map_err(|error| error.to_string())?;

    Ok(AnswerPayload {
        answer,
        role: role_label,
    })
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Ok(panel) = app.get_webview_panel("main") {
        panel.hide();
    }
}

fn toggle_window(app: &AppHandle) {
    let Ok(panel) = app.get_webview_panel("main") else {
        return;
    };

    if panel.is_visible() {
        panel.hide();
        return;
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.center();
    }
    panel.show_and_make_key();
    let _ = app.emit("spotlight-open", ());
}

fn register_hotkey(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(accelerator, move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                toggle_window(app);
            }
        })
        .map_err(|error| error.to_string())
}

fn install_panel(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let Ok(panel) = window.to_panel::<SpotlightPanel>() else {
        return;
    };

    panel.set_level(PanelLevel::Floating.value());
    panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());
    panel.set_collection_behavior(
        CollectionBehavior::new()
            .full_screen_auxiliary()
            .can_join_all_spaces()
            .into(),
    );

    let handler = SpotlightPanelEvents::new();
    let handle = app.clone();
    handler.window_did_resign_key(move |_notification| {
        if let Ok(panel) = handle.get_webview_panel("main") {
            panel.hide();
        }
    });
    panel.set_event_handler(Some(handler.as_ref()));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = McpConfig::from_env();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_nspanel::init())
        .invoke_handler(tauri::generate_handler![
            ask_question,
            get_session,
            login,
            logout,
            set_hotkey,
            hide_window
        ])
        .setup(move |app| {
            app.set_activation_policy(ActivationPolicy::Accessory);

            install_panel(app.handle());

            let session_path = app
                .path()
                .app_config_dir()
                .map(|dir| dir.join("session.json"))
                .unwrap_or_else(|_| PathBuf::from("session.json"));
            let mut session = load_session(&session_path);
            if session.hotkey.is_none() {
                session.hotkey = Some(config.default_hotkey.clone());
            }
            let hotkey = session
                .hotkey
                .clone()
                .unwrap_or_else(|| config.default_hotkey.clone());

            app.manage(AppState {
                config: config.clone(),
                session: Mutex::new(session),
                session_path,
            });

            if let Err(error) = register_hotkey(app.handle(), &hotkey) {
                eprintln!("Failed to register global shortcut '{hotkey}': {error}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
