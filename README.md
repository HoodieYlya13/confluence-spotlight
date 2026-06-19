# Confluence Spotlight

A desktop **spotlight** client for the [accelerator-operations MCP server](https://github.com/HoodieYlya13/mcp-confluence-documentation-rag). Press a global hotkey, ask an operations question, get a short grounded answer with links straight to the source Confluence pages — without leaving what you're doing.

It is a thin, security-conscious window over the same RBAC-governed server the web console fronts: the bearer token lives only in the Rust process and is never exposed to the webview (the desktop analog of the web app's `server-only` tokens). The MCP call uses the official Rust SDK (`rmcp`) — so the project now drives one server from clients in Python, TypeScript, and Rust.

Design rationale lives in [`TAD.md`](./TAD.md).

## Prerequisites

- Rust (stable) + the platform toolchain Tauri needs — see https://tauri.app/start/prerequisites/
- [bun](https://bun.sh)

## Configure

Copy `.env.example` to `.env` and fill in real values:

| Variable | Meaning |
|---|---|
| `MCP_SERVER_URL` | Base URL of the deployed MCP server |
| `SPOTLIGHT_TOKEN` | Bearer token for the role this instance runs as (held in Rust only) |
| `SPOTLIGHT_ROLE_LABEL` | Cosmetic badge text, e.g. `JUNIOR_OP` |
| `SPOTLIGHT_HOTKEY` | Global shortcut, default `CmdOrCtrl+Shift+Space` |

`.env` is gitignored — never commit the token.

## Run

```bash
bun install
bun run tauri dev
```

The window starts hidden. Press the hotkey (default **Cmd+Shift+Space**) to summon the bar, type a question, and press Enter. Click a source link to open the Confluence page in your system browser. Press **Esc** or click away to dismiss.

On macOS the bar is an `NSPanel`, so it floats over whatever you are doing — including apps in fullscreen — and across all Spaces, without pulling you out of the app underneath. It runs as an accessory (no Dock icon and no Cmd-Tab entry, like Raycast); under `bun run tauri dev` you quit it from the terminal. See [`TAD.md`](./TAD.md) for the rationale.

## Verify the data path (no GUI)

```bash
cd src-tauri
SPOTLIGHT_TOKEN=… MCP_SERVER_URL=… cargo run --example probe "your question here"
```

Prints the grounded answer and its source links straight from the server, proving the Rust MCP client works without launching the window.

## Build

```bash
bun run tauri build
```
