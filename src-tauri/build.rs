fn main() {
    let _ = dotenvy::from_path("../.env");

    for key in &[
        "SSO_CLIENT_ID",
        "SSO_ISSUER",
        "MCP_SERVER_URL",
        "SPOTLIGHT_AUTH_URL",
        "SPOTLIGHT_USE_SSO",
        "SPOTLIGHT_HOTKEY",
    ] {
        if let Ok(value) = std::env::var(key) {
            println!("cargo:rustc-env={}={}", key, value);
        }
    }

    tauri_build::build();
}
