# Confluence Spotlight

A desktop **spotlight** client for the [accelerator-operations MCP server](https://github.com/HoodieYlya13/mcp-confluence-documentation-rag). Press a global hotkey, ask an operations question, get a short grounded answer with links straight to the source Confluence pages — without leaving what you're doing.

It is a thin, security-conscious window over the same RBAC-governed server the web console fronts: the bearer token lives only in the Rust process and is never exposed to the webview (the desktop analog of the web app's `server-only` tokens). Sign-in is a real **deep-link OAuth round trip** (Authorization Code + PKCE) through the web console, so the shipped app contains no secrets — it fetches a token at sign-in and never persists it. The MCP call uses the official Rust SDK (`rmcp`) — so the project drives one server from clients in Python, TypeScript, and Rust.

Design rationale lives in [`TAD.md`](./TAD.md).

## Prerequisites

- Rust (stable) + the platform toolchain Tauri needs — see https://tauri.app/start/prerequisites/
- [bun](https://bun.sh)

## Configure

The app ships with baked-in defaults, so a built `.app` needs no `.env`. For local dev, copy `.env.example` to `.env` to override:

| Variable | Meaning |
|---|---|
| `MCP_SERVER_URL` | Base URL of the deployed MCP server |
| `SPOTLIGHT_AUTH_URL` | Base URL of the deployed web console — where sign-in and token exchange happen |
| `SPOTLIGHT_HOTKEY` | Default global shortcut, e.g. `CmdOrCtrl+Shift+Space` (customizable in Settings) |

These are all public URLs — there are **no tokens here**. The bearer tokens live on the web console (its `MCP_TOKEN_*`); the app obtains one through the sign-in flow below. The `DEFAULT_AUTH_URL` constant in `src-tauri/src/mcp.rs` must point at your deployed console (or set `SPOTLIGHT_AUTH_URL` at build time). The `MCP_TOKEN_*` vars are only read by the `probe` example.

## Run

```bash
bun install
bun run tauri dev
```

The window starts hidden. Press the hotkey (default **Cmd+Shift+Space**) to summon it.

On launch it shows a **connect** screen. "Connect with CERN SSO" opens your browser to the web console; pick **Junior Operator** or **ATS Core Lead** there, approve the **"Open Confluence Spotlight?"** prompt, and the app returns signed in as that persona. Then type a question and press Enter; click a source link to open the Confluence page in your system browser; press **Esc** or click away to dismiss. The access token is session-scoped (not persisted), so you reconnect each launch.

The **gear** in the bar opens **Settings**, where you can:
- **Log out** to return to the connect screen and sign in as the other persona.
- **Change the global hotkey** — click the shortcut, press a new key combination, and Save (registered immediately and persisted).

> **macOS:** the deep-link sign-in only works in a **built, installed** app (custom URL schemes can't be registered under `bun run tauri dev` on macOS). Build it, drag the `.app` to `/Applications`, and run it from there. Under `tauri dev` everything else works, but **Connect** won't round-trip back.

### Signing in during `tauri dev`

Because the deep-link round-trip can't complete in dev, debug builds show a **Dev sign-in** row under the Connect button with one button per persona. Each reads `MCP_TOKEN_<ROLE>` from `.env` and connects directly — the same token source the `probe` example uses. This row is compiled in only under `debug_assertions`; a released (`tauri build`) binary has no token-reading path and shows only the real browser sign-in.

On macOS the bar is an `NSPanel`, so it floats over whatever you are doing — including apps in fullscreen — and across all Spaces, without pulling you out of the app underneath. It runs as an accessory (no Dock icon and no Cmd-Tab entry, like Raycast). See [`TAD.md`](./TAD.md) for the rationale.

## Verify the data path (no GUI)

```bash
cd src-tauri
MCP_TOKEN_JUNIOR_OP=… MCP_SERVER_URL=… cargo run --example probe "your question here"
# or target the lead role:
SPOTLIGHT_ROLE=ATS_CORE_LEAD MCP_TOKEN_ATS_CORE_LEAD=… MCP_SERVER_URL=… cargo run --example probe "…"
```

Prints the grounded answer and its source links straight from the server, proving the Rust MCP client works without launching the window.

## Build & distribute

```bash
bun run tauri build
```

Produces a `.app` and a `.dmg` under `src-tauri/target/release/bundle/`; the `.dmg` is the downloadable artifact. Make sure `DEFAULT_AUTH_URL` (in `src-tauri/src/mcp.rs`) points at your deployed console first — or build with `SPOTLIGHT_AUTH_URL=… MCP_SERVER_URL=… bun run tauri build`.

The build is **unsigned** (this is a demo), so the first launch is blocked by Gatekeeper. Either right-click the app → **Open**, or clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine "/Applications/confluence-spotlight.app"
```

Install the `.app` into `/Applications` so the `confluence-spotlight://` deep link resolves. A GitHub Actions `tauri-apps/tauri-action` workflow can attach the `.dmg` to a Release for one-click download.
