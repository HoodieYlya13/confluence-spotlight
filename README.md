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
| `MCP_TOKEN_JUNIOR_OP` | Bearer token mapped to the Junior Operator role (held in Rust only) |
| `MCP_TOKEN_ATS_CORE_LEAD` | Bearer token mapped to the ATS Core Lead role (held in Rust only) |
| `SPOTLIGHT_HOTKEY` | Default global shortcut, e.g. `CmdOrCtrl+Shift+Space` (customizable in Settings) |

`.env` is gitignored — never commit the tokens. A role with no configured token simply appears greyed-out in the login picker.

## Run

```bash
bun install
bun run tauri dev
```

The window starts hidden. Press the hotkey (default **Cmd+Shift+Space**) to summon it.

On first run it shows a **connect** screen: "Connect with CERN SSO" simulates a browser sign-in and returns a role picker — choose **Junior Operator** or **ATS Core Lead** to continue as that identity (a demo stand-in for a real SSO flow). Once connected, type a question and press Enter; click a source link to open the Confluence page in your system browser; press **Esc** or click away to dismiss. Your choice is remembered across restarts.

The **gear** in the bar opens **Settings**, where you can:
- **Log out** to return to the connect screen and switch roles for the demo.
- **Change the global hotkey** — click the shortcut, press a new key combination, and Save (the new shortcut is registered immediately and persisted).

On macOS the bar is an `NSPanel`, so it floats over whatever you are doing — including apps in fullscreen — and across all Spaces, without pulling you out of the app underneath. It runs as an accessory (no Dock icon and no Cmd-Tab entry, like Raycast); under `bun run tauri dev` you quit it from the terminal. See [`TAD.md`](./TAD.md) for the rationale.

## Verify the data path (no GUI)

```bash
cd src-tauri
MCP_TOKEN_JUNIOR_OP=… MCP_SERVER_URL=… cargo run --example probe "your question here"
# or target the lead role:
SPOTLIGHT_ROLE=ATS_CORE_LEAD MCP_TOKEN_ATS_CORE_LEAD=… MCP_SERVER_URL=… cargo run --example probe "…"
```

Prints the grounded answer and its source links straight from the server, proving the Rust MCP client works without launching the window.

## Build

```bash
bun run tauri build
```
