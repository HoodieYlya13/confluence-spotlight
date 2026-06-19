use anyhow::{anyhow, Result};
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::ServiceExt;
use std::collections::HashMap;

const DEFAULT_SERVER_URL: &str = "https://hoodieylya13-mcp-confluence-documentation-rag.hf.space";
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
    pub default_hotkey: String,
    tokens: HashMap<String, String>,
}

impl McpConfig {
    pub fn from_env() -> Self {
        let _ = dotenvy::dotenv();

        let mut tokens = HashMap::new();
        if let Some(token) = non_empty_env("MCP_TOKEN_JUNIOR_OP") {
            tokens.insert("JUNIOR_OP".to_string(), token);
        }
        if let Some(token) = non_empty_env("MCP_TOKEN_ATS_CORE_LEAD") {
            tokens.insert("ATS_CORE_LEAD".to_string(), token);
        }
        if !tokens.contains_key("JUNIOR_OP") {
            if let Some(token) = non_empty_env("SPOTLIGHT_TOKEN") {
                tokens.insert("JUNIOR_OP".to_string(), token);
            }
        }

        Self {
            server_url: env_or("MCP_SERVER_URL", DEFAULT_SERVER_URL),
            default_hotkey: env_or("SPOTLIGHT_HOTKEY", DEFAULT_HOTKEY),
            tokens,
        }
    }

    pub fn token_for(&self, role: &str) -> Option<&str> {
        self.tokens
            .get(role)
            .map(|token| token.as_str())
            .filter(|token| !token.trim().is_empty())
    }

    pub fn has_token(&self, role: &str) -> bool {
        self.token_for(role).is_some()
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
