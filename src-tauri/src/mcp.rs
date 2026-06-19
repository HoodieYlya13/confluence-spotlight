use anyhow::{anyhow, Result};
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::ServiceExt;

const DEFAULT_SERVER_URL: &str = "https://hoodieylya13-mcp-confluence-documentation-rag.hf.space";
const DEFAULT_ROLE_LABEL: &str = "JUNIOR_OP";
const DEFAULT_HOTKEY: &str = "CmdOrCtrl+Shift+Space";
const ASK_TOOL: &str = "ask_accelerator_operations";

#[derive(Clone)]
pub struct McpConfig {
    pub server_url: String,
    pub token: String,
    pub role_label: String,
    pub hotkey: String,
}

impl McpConfig {
    pub fn from_env() -> Self {
        let _ = dotenvy::dotenv();
        Self {
            server_url: env_or("MCP_SERVER_URL", DEFAULT_SERVER_URL),
            token: std::env::var("SPOTLIGHT_TOKEN").unwrap_or_default(),
            role_label: env_or("SPOTLIGHT_ROLE_LABEL", DEFAULT_ROLE_LABEL),
            hotkey: env_or("SPOTLIGHT_HOTKEY", DEFAULT_HOTKEY),
        }
    }

    fn endpoint(&self) -> String {
        format!("{}/mcp", self.server_url.trim_end_matches('/'))
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    match std::env::var(key) {
        Ok(value) if !value.trim().is_empty() => value,
        _ => fallback.to_string(),
    }
}

pub async fn ask(cfg: &McpConfig, question: &str) -> Result<String> {
    if cfg.token.trim().is_empty() {
        return Err(anyhow!(
            "SPOTLIGHT_TOKEN is not configured; the spotlight cannot authenticate to the server."
        ));
    }

    let transport_config = StreamableHttpClientTransportConfig::with_uri(cfg.endpoint())
        .auth_header(cfg.token.clone());
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
