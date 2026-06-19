#![allow(clippy::unused_unit)]

mod mcp;

pub use mcp::{ask, McpConfig};

use serde::Serialize;
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
    let hotkey = config.hotkey.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_nspanel::init())
        .manage(config)
        .invoke_handler(tauri::generate_handler![
            ask_question,
            role_label,
            hide_window
        ])
        .setup(move |app| {
            app.set_activation_policy(ActivationPolicy::Accessory);

            install_panel(app.handle());

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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
