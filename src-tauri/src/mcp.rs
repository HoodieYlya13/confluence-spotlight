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
const DEFAULT_SSO_ISSUER: &str = "https://auth.hy13dev.com";
const DEFAULT_SSO_CLIENT_ID: &str = "confluence-spotlight-gjOtqPBt";
const DEFAULT_SSO_SCOPE: &str = "openid profile email offline_access";
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
    pub sso_issuer: String,
    pub sso_client_id: String,
    pub sso_client_secret: Option<String>,
    pub sso_scope: Option<String>,
    pub default_hotkey: String,
}

impl McpConfig {
    pub fn from_env() -> Self {
        let _ = dotenvy::dotenv();

        let server_url = non_empty_env("MCP_SERVER_URL")
            .or_else(|| non_empty_str(option_env!("MCP_SERVER_URL")))
            .unwrap_or_else(|| DEFAULT_SERVER_URL.to_string());

        let sso_issuer = non_empty_env("SSO_ISSUER")
            .or_else(|| non_empty_str(option_env!("SSO_ISSUER")))
            .unwrap_or_else(|| DEFAULT_SSO_ISSUER.to_string());

        let sso_client_id = non_empty_env("SSO_CLIENT_ID")
            .or_else(|| non_empty_str(option_env!("SSO_CLIENT_ID")))
            .unwrap_or_else(|| DEFAULT_SSO_CLIENT_ID.to_string());

        let sso_client_secret =
            non_empty_env("CLIENT_SECRET").or_else(|| non_empty_str(option_env!("CLIENT_SECRET")));

        let sso_scope =
            non_empty_env("SSO_SCOPE").or_else(|| non_empty_str(option_env!("SSO_SCOPE")));

        let default_hotkey = non_empty_env("SPOTLIGHT_HOTKEY")
            .or_else(|| non_empty_str(option_env!("SPOTLIGHT_HOTKEY")))
            .unwrap_or_else(|| DEFAULT_HOTKEY.to_string());

        Self {
            server_url,
            sso_issuer,
            sso_client_id,
            sso_client_secret,
            sso_scope,
            default_hotkey,
        }
    }
}

fn non_empty_env(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(value) if !value.trim().is_empty() => Some(value),
        _ => None,
    }
}

fn non_empty_str(value: Option<&str>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
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

fn urlencode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

pub async fn sso_authorize_url(
    issuer: &str,
    client_id: &str,
    scope: Option<&str>,
    state: &str,
    challenge: &str,
    nonce: &str,
    redirect_uri: &str,
) -> Result<String> {
    let issuer = issuer.trim_end_matches('/');
    let client = reqwest::Client::new();
    let config = discover_openid_configuration(&client, issuer)
        .await
        .ok_or_else(|| discovery_error(issuer))?;
    let scope = resolve_scope(scope, &config);

    Ok(format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}&nonce={}",
        config.authorization_endpoint,
        urlencode(client_id),
        urlencode(redirect_uri),
        urlencode(&scope),
        urlencode(challenge),
        urlencode(state),
        urlencode(nonce),
    ))
}

/// Resolve the OAuth scope: explicit `SSO_SCOPE` wins, otherwise fall back to
/// what the server advertises in its discovery document, then a sane default.
fn resolve_scope(scope: Option<&str>, config: &OpenIdConfiguration) -> String {
    scope
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let advertised = config.scopes_supported.join(" ");
            (!advertised.is_empty()).then_some(advertised)
        })
        .unwrap_or_else(|| DEFAULT_SSO_SCOPE.to_string())
}

#[derive(Deserialize)]
pub struct SsoTokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_in: Option<i64>,
}

#[derive(Deserialize)]
struct OpenIdConfiguration {
    authorization_endpoint: String,
    token_endpoint: String,
    #[serde(default)]
    scopes_supported: Vec<String>,
}

fn discovery_error(issuer: &str) -> anyhow::Error {
    anyhow!("Could not load OIDC discovery document from {issuer}/.well-known/openid-configuration")
}

async fn discover_openid_configuration(
    client: &reqwest::Client,
    issuer: &str,
) -> Option<OpenIdConfiguration> {
    let discovery_url = format!("{issuer}/.well-known/openid-configuration");
    let resp = client.get(&discovery_url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<OpenIdConfiguration>().await.ok()
}

async fn sso_token_request(issuer: &str, form: &[(&str, &str)]) -> Result<SsoTokens> {
    let client = reqwest::Client::new();
    let issuer = issuer.trim_end_matches('/');

    let token_endpoint = discover_openid_configuration(&client, issuer)
        .await
        .ok_or_else(|| discovery_error(issuer))?
        .token_endpoint;

    let response = client.post(token_endpoint).form(form).send().await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!("Sign-in failed ({status}): {body}"));
    }

    Ok(response.json::<SsoTokens>().await?)
}

pub async fn sso_exchange_code(
    issuer: &str,
    client_id: &str,
    client_secret: Option<&str>,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<SsoTokens> {
    let mut params = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("code_verifier", verifier),
        ("client_id", client_id),
    ];
    if let Some(secret) = client_secret {
        params.push(("client_secret", secret));
    }
    sso_token_request(issuer, &params).await
}

pub async fn sso_refresh(
    issuer: &str,
    client_id: &str,
    client_secret: Option<&str>,
    refresh_token: &str,
) -> Result<SsoTokens> {
    let mut params = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
    ];
    if let Some(secret) = client_secret {
        params.push(("client_secret", secret));
    }
    sso_token_request(issuer, &params).await
}

pub fn role_from_access_token(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let roles: Vec<&str> = claims
        .get("roles")?
        .as_array()?
        .iter()
        .filter_map(|value| value.as_str())
        .collect();

    if roles.contains(&"ATS_CORE_LEAD")
        || roles.contains(&"ADMIN")
        || roles.contains(&"ADMIN_DURNAL")
    {
        Some("ATS_CORE_LEAD".to_string())
    } else if roles.contains(&"JUNIOR_OP") {
        Some("JUNIOR_OP".to_string())
    } else {
        None
    }
}

#[derive(Clone, Default)]
pub struct Profile {
    pub username: Option<String>,
    pub given_name: Option<String>,
    pub account_url: Option<String>,
}

pub fn profile_from_access_token(token: &str) -> Profile {
    let Some(payload) = token.split('.').nth(1) else {
        return Profile::default();
    };
    let Ok(bytes) = URL_SAFE_NO_PAD.decode(payload) else {
        return Profile::default();
    };
    let Ok(claims) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Profile::default();
    };
    let string_claim = |key: &str| {
        claims
            .get(key)
            .and_then(|value| value.as_str())
            .map(str::to_string)
    };
    Profile {
        username: string_claim("preferred_username"),
        given_name: string_claim("given_name"),
        account_url: string_claim("iss")
            .map(|iss| format!("{}/en/account", iss.trim_end_matches('/'))),
    }
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
