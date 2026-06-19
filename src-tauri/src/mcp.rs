use anyhow::{anyhow, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::ServiceExt;
use serde::Deserialize;
use sha2::{Digest, Sha256};

const DEFAULT_SERVER_URL: &str = "https://hoodieylya13-mcp-confluence-documentation-rag.hf.space";
const DEFAULT_AUTH_URL: &str = "https://confluence-bot.hy13dev.com";
const DEFAULT_HOTKEY: &str = "CmdOrCtrl+Shift+Space";
const ASK_TOOL: &str = "ask_accelerator_operations";

pub const ROLES: &[(&str, &str)] = &[
    ("JUNIOR_OP", "Junior Operator"),
    ("ATS_CORE_LEAD", "ATS Core Lead"),
];

pub fn role_label(key: &str) -> Option<&'static str> {
    ROLES
        .iter()
        .find(|(role_key, _)| *role_key == key)
        .map(|(_, label)| *label)
}

#[derive(Clone)]
pub struct McpConfig {
    pub server_url: String,
    pub auth_url: String,
    pub default_hotkey: String,
}

impl McpConfig {
    pub fn from_env() -> Self {
        let _ = dotenvy::dotenv();

        Self {
            server_url: env_or("MCP_SERVER_URL", DEFAULT_SERVER_URL),
            auth_url: env_or("SPOTLIGHT_AUTH_URL", DEFAULT_AUTH_URL),
            default_hotkey: env_or("SPOTLIGHT_HOTKEY", DEFAULT_HOTKEY),
        }
    }
}

fn non_empty_env(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(value) if !value.trim().is_empty() => Some(value),
        _ => None,
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    non_empty_env(key).unwrap_or_else(|| fallback.to_string())
}

fn endpoint(server_url: &str) -> String {
    format!("{}/mcp", server_url.trim_end_matches('/'))
}

pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("system RNG unavailable");
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn pkce_challenge(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hasher.finalize())
}

pub fn authorize_url(auth_url: &str, state: &str, challenge: &str, redirect_uri: &str) -> String {
    format!(
        "{}/spotlight-login?state={}&code_challenge={}&redirect_uri={}",
        auth_url.trim_end_matches('/'),
        urlencode(state),
        urlencode(challenge),
        urlencode(redirect_uri),
    )
}

fn urlencode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

#[derive(Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub role: String,
    pub role_label: String,
}

pub async fn exchange_code(auth_url: &str, code: &str, verifier: &str) -> Result<TokenResponse> {
    let url = format!("{}/api/spotlight/token", auth_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .post(url)
        .json(&serde_json::json!({ "code": code, "code_verifier": verifier }))
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!("Sign-in failed ({status}): {body}"));
    }

    Ok(response.json::<TokenResponse>().await?)
}

pub async fn ask(server_url: &str, token: &str, question: &str) -> Result<String> {
    if token.trim().is_empty() {
        return Err(anyhow!(
            "No token is configured for this role; the spotlight cannot authenticate to the server."
        ));
    }

    let transport_config = StreamableHttpClientTransportConfig::with_uri(endpoint(server_url))
        .auth_header(token.to_string());
    let transport = StreamableHttpClientTransport::from_config(transport_config);
    let service = ().serve(transport).await?;

    let mut params = CallToolRequestParams::default();
    params.name = ASK_TOOL.into();
    let mut arguments = serde_json::Map::new();
    arguments.insert(
        "question".to_string(),
        serde_json::Value::String(question.to_string()),
    );
    params.arguments = Some(arguments);

    let outcome = service.call_tool(params).await;
    let _ = service.cancel().await;

    let result = outcome?;
    if result.is_error.unwrap_or(false) {
        return Err(anyhow!(
            answer_text(&result).unwrap_or_else(|| "The server reported a tool error.".to_string())
        ));
    }

    answer_text(&result).ok_or_else(|| anyhow!("The assistant returned no answer."))
}

fn answer_text(result: &CallToolResult) -> Option<String> {
    if let Some(structured) = &result.structured_content {
        if let Some(text) = structured.get("result").and_then(|value| value.as_str()) {
            return Some(text.to_string());
        }
    }

    let joined = result
        .content
        .iter()
        .filter_map(|item| item.as_text().map(|text| text.text.clone()))
        .collect::<Vec<_>>()
        .join("\n");

    if joined.trim().is_empty() {
        None
    } else {
        Some(joined)
    }
}
