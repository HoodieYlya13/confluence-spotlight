fn main() {
    println!("cargo:rerun-if-changed=../.env");
    for key in &[
        "SSO_CLIENT_ID",
        "SSO_ISSUER",
        "MCP_SERVER_URL",
        "SPOTLIGHT_HOTKEY",
        "SSO_SCOPE",
        "CLIENT_SECRET",
    ] {
        println!("cargo:rerun-if-env-changed={}", key);
    }

    let _ = dotenvy::from_path("../.env");

    for key in &[
        "SSO_CLIENT_ID",
        "SSO_ISSUER",
        "MCP_SERVER_URL",
        "SPOTLIGHT_HOTKEY",
        "SSO_SCOPE",
        "CLIENT_SECRET",
    ] {
        if let Ok(value) = std::env::var(key) {
            println!("cargo:rustc-env={}={}", key, value);
        }
    }

    tauri_build::build();
}
