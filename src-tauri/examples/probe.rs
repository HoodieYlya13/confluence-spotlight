use confluence_spotlight_lib::{ask, McpConfig};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = McpConfig::from_env();
    let question = std::env::args().nth(1).unwrap_or_else(|| {
        "What is the warning pressure threshold for the LHC cryo interlock?".to_string()
    });

    let answer = ask(&config, &question).await?;

    println!("--- role: {} ---", config.role_label);
    println!("{answer}");
    Ok(())
}
