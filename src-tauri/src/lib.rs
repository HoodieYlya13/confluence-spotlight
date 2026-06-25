#![allow(clippy::unused_unit)]

mod mcp;

pub use mcp::{ask, McpConfig};

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;
use tauri::{AppHandle, Emitter, Manager};
#[cfg(target_os = "macos")]
use tauri_nspanel::{
    tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_opener::OpenerExt;
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;

#[cfg(target_os = "macos")]
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

const DEFAULT_SCROLL_KEYS: &str = "CmdOrCtrl+Down";
const DEFAULT_LINK_KEYS: &str = "CmdOrCtrl+Shift+Down";
const DEFAULT_SETTINGS_KEYS: &str = "CmdOrCtrl+,";
const DEFAULT_NVIM_OPEN_MODE: &str = "insert";
const DEFAULT_NVIM_LEADER: &str = "Space";

#[derive(Serialize, Deserialize, Clone, Default)]
struct Settings {
    hotkey: Option<String>,
    scroll_keys: Option<String>,
    link_keys: Option<String>,
    settings_keys: Option<String>,
    nvim_mode: Option<bool>,
    nvim_open_mode: Option<String>,
    nvim_leader: Option<String>,
    follow_mouse: Option<bool>,
}

#[derive(Clone)]
struct Auth {
    role: String,
    token: String,
    refresh_token: Option<String>,
    expires_at: Option<u64>,
    username: Option<String>,
    given_name: Option<String>,
    account_url: Option<String>,
}

struct PendingAuth {
    state: String,
    verifier: String,
    redirect_uri: String,
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

struct AppState {
    config: McpConfig,
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    hotkey_registered: Mutex<bool>,
    auth: Mutex<Option<Auth>>,
    pending_auth: Mutex<Option<PendingAuth>>,
    cancel: Arc<tokio::sync::Notify>,
}

#[derive(Serialize)]
struct SessionView {
    role: Option<String>,
    role_label: Option<String>,
    username: Option<String>,
    given_name: Option<String>,
    account_url: Option<String>,
    hotkey: String,
    scroll_keys: String,
    link_keys: String,
    settings_keys: String,
    nvim_mode: bool,
    nvim_open_mode: String,
    nvim_leader: String,
    follow_mouse: bool,
    app_version: String,
}

#[derive(Serialize)]
struct AnswerPayload {
    answer: String,
    role: String,
}

#[derive(Clone, Serialize)]
struct AuthEvent {
    ok: bool,
    role_label: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
struct UpdateCheck {
    available: bool,
    version: Option<String>,
    notes: Option<String>,
}

#[cfg(all(desktop, not(debug_assertions)))]
#[derive(Clone, Serialize)]
struct UpdateAvailable {
    version: String,
    current_version: String,
    notes: Option<String>,
}

fn load_settings(path: &PathBuf) -> Settings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_settings(path: &PathBuf, settings: &Settings) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(raw) = serde_json::to_string_pretty(settings) {
        let _ = std::fs::write(path, raw);
    }
}

fn current_hotkey(state: &AppState) -> String {
    let settings = state.settings.lock().unwrap();
    settings
        .hotkey
        .clone()
        .unwrap_or_else(|| state.config.default_hotkey.clone())
}

fn session_view(state: &AppState) -> SessionView {
    let hotkey = current_hotkey(state);
    let (scroll_keys, link_keys, settings_keys) = {
        let settings = state.settings.lock().unwrap();
        (
            settings
                .scroll_keys
                .clone()
                .unwrap_or_else(|| DEFAULT_SCROLL_KEYS.to_string()),
            settings
                .link_keys
                .clone()
                .unwrap_or_else(|| DEFAULT_LINK_KEYS.to_string()),
            settings
                .settings_keys
                .clone()
                .unwrap_or_else(|| DEFAULT_SETTINGS_KEYS.to_string()),
        )
    };
    let (nvim_mode, nvim_open_mode, nvim_leader) = {
        let settings = state.settings.lock().unwrap();
        (
            settings.nvim_mode.unwrap_or(false),
            settings
                .nvim_open_mode
                .clone()
                .unwrap_or_else(|| DEFAULT_NVIM_OPEN_MODE.to_string()),
            settings
                .nvim_leader
                .clone()
                .unwrap_or_else(|| DEFAULT_NVIM_LEADER.to_string()),
        )
    };
    let follow_mouse = state.settings.lock().unwrap().follow_mouse.unwrap_or(true);
    let auth = state.auth.lock().unwrap();
    let role = auth.as_ref().map(|auth| auth.role.clone());
    let role_label = role
        .as_deref()
        .and_then(mcp::role_label)
        .map(|label| label.to_string());
    let username = auth.as_ref().and_then(|auth| auth.username.clone());
    let given_name = auth.as_ref().and_then(|auth| auth.given_name.clone());
    let account_url = auth.as_ref().and_then(|auth| auth.account_url.clone());

    SessionView {
        role,
        role_label,
        username,
        given_name,
        account_url,
        hotkey,
        scroll_keys,
        link_keys,
        settings_keys,
        nvim_mode,
        nvim_open_mode,
        nvim_leader,
        follow_mouse,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

#[tauri::command]
fn get_session(state: tauri::State<'_, AppState>) -> SessionView {
    session_view(state.inner())
}

#[tauri::command]
fn begin_login(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let verifier = mcp::random_token();
    let challenge = mcp::pkce_challenge(&verifier);
    let csrf = mcp::random_token();
    let redirect_uri = deep_link_redirect_uri(&app);

    if state.config.sso_client_id.trim().is_empty() {
        return Err("SSO_CLIENT_ID is not configured.".to_string());
    }
    let nonce = mcp::random_token();
    let url = mcp::sso_authorize_url(
        &state.config.sso_issuer,
        &state.config.sso_client_id,
        &csrf,
        &challenge,
        &nonce,
        &redirect_uri,
    );

    {
        let mut pending = state.pending_auth.lock().unwrap();
        *pending = Some(PendingAuth {
            state: csrf,
            verifier,
            redirect_uri,
        });
    }

    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn logout(state: tauri::State<'_, AppState>) -> SessionView {
    {
        *state.auth.lock().unwrap() = None;
    }
    session_view(state.inner())
}

#[cfg(debug_assertions)]
fn dev_token(role: &str) -> Option<String> {
    std::env::var(format!("MCP_TOKEN_{role}"))
        .ok()
        .filter(|value| !value.trim().is_empty())
}

#[tauri::command]
fn dev_login(role: String, state: tauri::State<'_, AppState>) -> Result<SessionView, String> {
    #[cfg(debug_assertions)]
    {
        if mcp::role_label(&role).is_none() {
            return Err(format!("Unknown role '{role}'."));
        }
        match dev_token(&role) {
            Some(token) => {
                let profile = mcp::profile_from_access_token(&token);
                *state.auth.lock().unwrap() = Some(Auth {
                    role,
                    token,
                    refresh_token: None,
                    expires_at: None,
                    username: profile.username,
                    given_name: profile.given_name,
                    account_url: profile.account_url,
                });
                Ok(session_view(state.inner()))
            }
            None => Err(format!(
                "Set MCP_TOKEN_{role} in confluence-spotlight/.env to use dev sign-in."
            )),
        }
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (role, state);
        Err("Dev sign-in is disabled in release builds.".to_string())
    }
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

    let current = current_hotkey(state.inner());

    let _ = app.global_shortcut().unregister(current.as_str());
    if let Err(error) = register_hotkey(&app, &trimmed) {
        let _ = register_hotkey(&app, &current);
        return Err(format!("Could not register '{trimmed}': {error}"));
    }

    {
        let mut settings = state.settings.lock().unwrap();
        settings.hotkey = Some(trimmed.clone());
        save_settings(&state.settings_path, &settings);
    }

    {
        let mut registered = state.hotkey_registered.lock().unwrap();
        *registered = true;
    }

    Ok(trimmed)
}

#[tauri::command]
fn set_binding(
    state: tauri::State<'_, AppState>,
    name: String,
    accelerator: String,
) -> Result<SessionView, String> {
    let trimmed = accelerator.trim().to_string();
    if trimmed.is_empty() {
        return Err("Empty shortcut.".to_string());
    }

    {
        let mut settings = state.settings.lock().unwrap();
        match name.as_str() {
            "scroll" => settings.scroll_keys = Some(trimmed),
            "links" => settings.link_keys = Some(trimmed),
            "settings" => settings.settings_keys = Some(trimmed),
            "leader" => settings.nvim_leader = Some(trimmed),
            _ => return Err(format!("Unknown binding '{name}'.")),
        }
        save_settings(&state.settings_path, &settings);
    }

    Ok(session_view(state.inner()))
}

#[tauri::command]
fn set_nvim_mode(state: tauri::State<'_, AppState>, enabled: bool) -> Result<SessionView, String> {
    {
        let mut settings = state.settings.lock().unwrap();
        settings.nvim_mode = Some(enabled);
        save_settings(&state.settings_path, &settings);
    }
    Ok(session_view(state.inner()))
}

#[tauri::command]
fn set_nvim_open_mode(
    state: tauri::State<'_, AppState>,
    mode: String,
) -> Result<SessionView, String> {
    if mode != "insert" && mode != "normal" {
        return Err(format!("Unknown open mode '{mode}'."));
    }
    {
        let mut settings = state.settings.lock().unwrap();
        settings.nvim_open_mode = Some(mode);
        save_settings(&state.settings_path, &settings);
    }
    Ok(session_view(state.inner()))
}

#[tauri::command]
fn set_follow_mouse(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<SessionView, String> {
    {
        let mut settings = state.settings.lock().unwrap();
        settings.follow_mouse = Some(enabled);
        save_settings(&state.settings_path, &settings);
    }
    Ok(session_view(state.inner()))
}

#[tauri::command]
async fn ask_question(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    question: String,
) -> Result<AnswerPayload, String> {
    let trimmed = question.trim().to_string();
    if trimmed.is_empty() {
        return Err("Type a question first.".to_string());
    }

    refresh_if_needed(&app).await;

    let (server_url, token, role_label) = {
        let auth = state.auth.lock().unwrap();
        let Some(auth) = auth.as_ref() else {
            return Err("Not connected. Open the spotlight and sign in first.".to_string());
        };
        let label = mcp::role_label(&auth.role)
            .unwrap_or(&auth.role)
            .to_string();
        (state.config.server_url.clone(), auth.token.clone(), label)
    };

    let cancel = state.cancel.clone();
    let answer = tokio::select! {
        result = mcp::ask(&server_url, &token, &trimmed) => {
            result.map_err(|error| error.to_string())?
        }
        _ = cancel.notified() => {
            return Err("__cancelled__".to_string());
        }
    };

    Ok(AnswerPayload {
        answer,
        role: role_label,
    })
}

#[tauri::command]
fn cancel_ask(state: tauri::State<'_, AppState>) {
    state.cancel.notify_waiters();
}

fn register_current_hotkey_internal(app: &AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<AppState>() {
        let mut registered = state.hotkey_registered.lock().unwrap();
        if !*registered {
            let current = current_hotkey(state.inner());
            let _ = app.global_shortcut().unregister(current.as_str());
            register_hotkey(app, &current)?;
            *registered = true;
        }
    }
    Ok(())
}

fn unregister_current_hotkey_internal(app: &AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<AppState>() {
        let mut registered = state.hotkey_registered.lock().unwrap();
        if *registered {
            let current = current_hotkey(state.inner());
            let _ = app.global_shortcut().unregister(current.as_str());
            *registered = false;
        }
    }
    Ok(())
}

#[tauri::command]
fn register_current_hotkey(app: AppHandle) -> Result<(), String> {
    register_current_hotkey_internal(&app)
}

#[tauri::command]
fn unregister_current_hotkey(app: AppHandle) -> Result<(), String> {
    unregister_current_hotkey_internal(&app)
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    hide_window_impl(&app);
}

#[tauri::command]
fn show_window_command(app: AppHandle) {
    show_window(&app);
}

fn deep_link_redirect_uri(app: &AppHandle) -> String {
    let scheme = app
        .config()
        .plugins
        .0
        .get("deep-link")
        .and_then(|value| value.get("desktop"))
        .and_then(|value| value.get("schemes"))
        .and_then(|value| value.as_array())
        .and_then(|schemes| schemes.first())
        .and_then(|value| value.as_str())
        .unwrap_or("confluence-spotlight");
    format!("{scheme}://auth")
}

fn follow_mouse_enabled(app: &AppHandle) -> bool {
    app.try_state::<AppState>()
        .map(|state| state.settings.lock().unwrap().follow_mouse.unwrap_or(true))
        .unwrap_or(true)
}

fn fill_active_monitor(window: &tauri::WebviewWindow, follow_mouse: bool) {
    let monitor = if follow_mouse {
        window
            .cursor_position()
            .ok()
            .and_then(|pos| window.monitor_from_point(pos.x, pos.y).ok().flatten())
            .or_else(|| window.current_monitor().ok().flatten())
    } else {
        window.current_monitor().ok().flatten()
    };
    if let Some(monitor) = monitor {
        let size = monitor.size();
        let pos = monitor.position();
        let _ = window.set_size(tauri::Size::Physical(*size));
        let _ = window.set_position(tauri::Position::Physical(*pos));
    } else {
        let _ = window.center();
    }
}

#[cfg(target_os = "macos")]
fn show_window(app: &AppHandle) {
    let Ok(panel) = app.get_webview_panel("main") else {
        return;
    };

    if let Some(window) = app.get_webview_window("main") {
        fill_active_monitor(&window, follow_mouse_enabled(app));
    }

    panel.show_and_make_key();
    let _ = app.emit("spotlight-open", ());
}

#[cfg(not(target_os = "macos"))]
fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        fill_active_monitor(&window, follow_mouse_enabled(app));
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit("spotlight-open", ());
}

#[cfg(target_os = "macos")]
fn hide_window_impl(app: &AppHandle) {
    if let Ok(panel) = app.get_webview_panel("main") {
        panel.hide();
    }
}

#[cfg(not(target_os = "macos"))]
fn hide_window_impl(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[cfg(target_os = "macos")]
fn toggle_window(app: &AppHandle) {
    let Ok(panel) = app.get_webview_panel("main") else {
        return;
    };

    if panel.is_visible() {
        panel.hide();
        return;
    }

    show_window(app);
}

#[cfg(not(target_os = "macos"))]
fn toggle_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            return;
        }
    }
    show_window(app);
}

fn handle_auth_url(app: &AppHandle, url: &url::Url) {
    let mut code = None;
    let mut returned_state = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => returned_state = Some(value.into_owned()),
            _ => {}
        }
    }

    let (Some(code), Some(returned_state)) = (code, returned_state) else {
        return;
    };

    {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || show_window(&handle));
    }

    let Some(state) = app.try_state::<AppState>() else {
        return;
    };

    let pending = state.pending_auth.lock().unwrap().take();
    let Some(pending) = pending else {
        emit_auth_error(app, "No sign-in is in progress.");
        return;
    };
    if pending.state != returned_state {
        emit_auth_error(app, "Sign-in state mismatch; please try again.");
        return;
    }

    let config = state.config.clone();
    let verifier = pending.verifier;
    let redirect_uri = pending.redirect_uri;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match mcp::sso_exchange_code(
            &config.sso_issuer,
            &config.sso_client_id,
            &code,
            &verifier,
            &redirect_uri,
        )
        .await
        {
            Ok(tokens) => match mcp::role_from_access_token(&tokens.access_token) {
                Some(role) => {
                    let role_label = mcp::role_label(&role).unwrap_or(&role).to_string();
                    let expires_at = expiry_from_now(tokens.expires_in);
                    let profile = mcp::profile_from_access_token(&tokens.access_token);
                    if let Some(state) = app.try_state::<AppState>() {
                        *state.auth.lock().unwrap() = Some(Auth {
                            role,
                            token: tokens.access_token,
                            refresh_token: tokens.refresh_token,
                            expires_at,
                            username: profile.username,
                            given_name: profile.given_name,
                            account_url: profile.account_url,
                        });
                    }
                    finish_login(&app, role_label);
                }
                None => emit_auth_error(&app, "Your account has no authorized role for this app."),
            },
            Err(error) => emit_auth_error(&app, &error.to_string()),
        }
    });
}

fn expiry_from_now(expires_in: Option<i64>) -> Option<u64> {
    expires_in.map(|seconds| now_unix().saturating_add((seconds.max(0) as u64).saturating_sub(30)))
}

fn finish_login(app: &AppHandle, role_label: String) {
    let _ = app.emit(
        "spotlight-auth",
        AuthEvent {
            ok: true,
            role_label: Some(role_label),
            error: None,
        },
    );
}

async fn refresh_if_needed(app: &AppHandle) {
    let (config, refresh_token) = {
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        let auth = state.auth.lock().unwrap();
        match auth.as_ref() {
            Some(auth) => {
                let expired = auth.expires_at.map(|at| now_unix() >= at).unwrap_or(false);
                if !expired {
                    return;
                }
                (state.config.clone(), auth.refresh_token.clone())
            }
            None => return,
        }
    };

    let Some(refresh_token) = refresh_token else {
        return;
    };

    if let Ok(tokens) =
        mcp::sso_refresh(&config.sso_issuer, &config.sso_client_id, &refresh_token).await
    {
        if let Some(role) = mcp::role_from_access_token(&tokens.access_token) {
            let expires_at = expiry_from_now(tokens.expires_in);
            let profile = mcp::profile_from_access_token(&tokens.access_token);
            if let Some(state) = app.try_state::<AppState>() {
                *state.auth.lock().unwrap() = Some(Auth {
                    role,
                    token: tokens.access_token,
                    refresh_token: tokens.refresh_token.or(Some(refresh_token)),
                    expires_at,
                    username: profile.username,
                    given_name: profile.given_name,
                    account_url: profile.account_url,
                });
            }
        }
    }
}

fn emit_auth_error(app: &AppHandle, message: &str) {
    let _ = app.emit(
        "spotlight-auth",
        AuthEvent {
            ok: false,
            role_label: None,
            error: Some(message.to_string()),
        },
    );
}

#[cfg(all(desktop, not(debug_assertions)))]
async fn check_for_update(app: AppHandle) {
    let Ok(updater) = app.updater() else {
        return;
    };
    if let Ok(Some(update)) = updater.check().await {
        let _ = app.emit(
            "spotlight-update-available",
            UpdateAvailable {
                version: update.version.clone(),
                current_version: update.current_version.clone(),
                notes: update.body.clone(),
            },
        );
    }
}

fn restart_app(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        if let Ok(current_exe) = std::env::current_exe() {
            if let Some(contents_dir) = current_exe.parent() {
                if let Some(app_dir) = contents_dir.parent().and_then(|p| p.parent()) {
                    if app_dir.extension().is_some_and(|ext| ext == "app") {
                        let _ = std::process::Command::new("open")
                            .arg("-n")
                            .arg(app_dir)
                            .spawn();
                        app.exit(0);
                        return;
                    }
                }
            }
        }
    }

    app.restart();
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    #[cfg(not(desktop))]
    {
        let _ = &app;
        return Err("Updates are not supported on this platform.".to_string());
    }
    #[cfg(desktop)]
    {
        let updater = app.updater().map_err(|error| error.to_string())?;
        let update = updater
            .check()
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "No update is available.".to_string())?;
        update
            .download_and_install(|_chunk, _total| {}, || {})
            .await
            .map_err(|error| error.to_string())?;
        restart_app(&app);
    }
    #[allow(unreachable_code)]
    Ok(())
}

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<UpdateCheck, String> {
    #[cfg(desktop)]
    {
        let updater = app.updater().map_err(|error| error.to_string())?;
        match updater.check().await.map_err(|error| error.to_string())? {
            Some(update) => Ok(UpdateCheck {
                available: true,
                version: Some(update.version.clone()),
                notes: update.body.clone(),
            }),
            None => Ok(UpdateCheck {
                available: false,
                version: None,
                notes: None,
            }),
        }
    }
    #[cfg(not(desktop))]
    {
        let _ = &app;
        Err("Updates are not supported on this platform.".to_string())
    }
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

#[cfg(target_os = "macos")]
fn setup_window(app: &AppHandle) {
    install_panel(app);
}

#[cfg(not(target_os = "macos"))]
fn setup_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.set_always_on_top(true);

    let handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            hide_window_impl(&handle);
            let needs_restore = handle
                .try_state::<AppState>()
                .map(|state| !*state.hotkey_registered.lock().unwrap())
                .unwrap_or(false);
            if needs_restore {
                let _ = register_current_hotkey_internal(&handle);
            }
        }
    });
}

#[cfg(target_os = "macos")]
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
            let needs_restore = if let Some(state) = handle.try_state::<AppState>() {
                !*state.hotkey_registered.lock().unwrap()
            } else {
                false
            };
            if needs_restore {
                let _ = register_current_hotkey_internal(&handle);
            }
        }
    });
    panel.set_event_handler(Some(handler.as_ref()));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = McpConfig::from_env();

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                show_window(&handle);
            });
        }));
    }

    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .invoke_handler(tauri::generate_handler![
            ask_question,
            cancel_ask,
            get_session,
            begin_login,
            logout,
            dev_login,
            set_hotkey,
            set_binding,
            set_nvim_mode,
            set_nvim_open_mode,
            set_follow_mouse,
            hide_window,
            show_window_command,
            install_update,
            check_update,
            register_current_hotkey,
            unregister_current_hotkey
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(ActivationPolicy::Accessory);

            setup_window(app.handle());

            let settings_path = app
                .path()
                .app_config_dir()
                .map(|dir| dir.join("session.json"))
                .unwrap_or_else(|_| PathBuf::from("session.json"));
            let mut settings = load_settings(&settings_path);

            if settings.hotkey.is_none() {
                settings.hotkey = Some(config.default_hotkey.clone());
            }
            let hotkey = settings
                .hotkey
                .clone()
                .unwrap_or_else(|| config.default_hotkey.clone());

            let mut hotkey_registered = false;
            if let Err(error) = register_hotkey(app.handle(), &hotkey) {
                eprintln!("Failed to register global shortcut '{hotkey}': {error}");
            } else {
                hotkey_registered = true;
            }

            app.manage(AppState {
                config: config.clone(),
                settings: Mutex::new(settings),
                settings_path,
                hotkey_registered: Mutex::new(hotkey_registered),
                auth: Mutex::new(None),
                pending_auth: Mutex::new(None),
                cancel: Arc::new(tokio::sync::Notify::new()),
            });

            #[cfg(any(target_os = "windows", target_os = "linux"))]
            {
                let _ = app.deep_link().register_all();
            }

            let auth_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    handle_auth_url(&auth_handle, &url);
                }
            });

            #[cfg(all(desktop, not(debug_assertions)))]
            if !app.config().identifier.ends_with("-beta") {
                let update_handle = app.handle().clone();
                tauri::async_runtime::spawn(check_for_update(update_handle));
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
