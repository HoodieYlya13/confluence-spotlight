use confluence_spotlight_lib::{ask, McpConfig};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = McpConfig::from_env();
    let role = std::env::var("SPOTLIGHT_ROLE").unwrap_or_else(|_| "JUNIOR_OP".to_string());
    let question = std::env::args().nth(1).unwrap_or_else(|| {
        "What is the warning pressure threshold for the LHC cryo interlock?".to_string()
    });

    let token_var = format!("MCP_TOKEN_{role}");
    let token = std::env::var(&token_var)
        .ok()
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("Set {token_var} to probe role '{role}'."))?;

    let answer = ask(&config.server_url, &token, &question).await?;

    println!("--- role: {role} ---");
    println!("{answer}");
    Ok(())
}
