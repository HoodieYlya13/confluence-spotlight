# Technical Architecture Decisions — confluence-spotlight

House convention: no code comments or docstrings. Every design decision and its rationale lives here.

## Purpose

A desktop **spotlight** client for the same [mcp-confluence-documentation-rag](https://github.com/HoodieYlya13/mcp-confluence-documentation-rag) server that the web console fronts. A global hotkey (`Cmd+Shift+Space` by default) summons a frameless, always-on-top command bar; you type an operations question, and the server's `ask_accelerator_operations` agent returns a short grounded answer with links straight to the source Confluence pages. It is the "ask in two seconds without leaving what you're doing" surface, where the web console is the "explore the RBAC story in a browser" surface.

This is a third client over one server — Python server, TypeScript web console, Rust desktop app — exercising the MCP protocol from a third language.

## Decisions

### The bearer token never leaves the Rust process — desktop `server-only`

This is the load-bearing decision and the direct analog of the web app's `server-only` token handling. The web console keeps tokens out of the browser; here the equivalent boundary is process-internal. `MCP_SERVER_URL`, `MCP_TOKEN_JUNIOR_OP`, `MCP_TOKEN_ATS_CORE_LEAD` and `SPOTLIGHT_HOTKEY` are read **only** in Rust (`mcp.rs`, `McpConfig::from_env`, via `dotenvy`), and the per-role tokens are held in a private `HashMap` on `McpConfig` — there is no command that returns a token. The webview is a thin renderer: it calls `ask_question` and receives back only `{ answer, role }` — rendered text and a cosmetic label. The token is never sent into the webview, never embedded in JS, never reachable from the page context.

The login flow (below) does not weaken this: the webview sends a **role choice** (`login(role)`), never a token. Rust maps the chosen role to the matching pre-provisioned token. That is exactly the OAuth shape — the browser hands the trusted process an identity; the secret stays on the trusted side. This also mirrors the server's own model: the client never sends its own role to the *MCP server*; the server resolves it from the bearer token, as everywhere else in the system.

### A real Rust MCP client (`rmcp`), not a REST shim

`mcp.rs` uses the official Rust SDK `rmcp` with its streamable-HTTP client transport (`StreamableHttpClientTransport::from_config`), performing the full initialize → `call_tool("ask_accelerator_operations") → cancel` handshake per request. The bearer token is supplied through the transport config's `auth_header` (token without the `Bearer ` prefix; the transport adds it). A raw `reqwest` POST would have been fewer lines, but using the real SDK keeps this consistent with the web app's "real MCP client, not a REST shim" stance and means the project now demonstrates an MCP server plus clients in two different languages. Connections are per-request, matching the low-traffic, summon-on-demand usage.

The answer is extracted preferring the tool's `structured_content.result` (the string the agent returns) and falling back to concatenated text content — the same precedence the TypeScript client uses.

### Simulated SSO login, with logout to switch roles

The spotlight runs as **one** role at a time (a personal tool, not the web console's side-by-side RBAC diff), but *which* role is chosen at runtime through a login flow rather than baked into a single env var. On first summon — or after logout — the webview shows a connect screen. "Connect with CERN SSO" simulates a browser round-trip (a short delay, no real redirect) and returns to a **role picker** listing the roles that have a configured token. Picking one calls `login(role)`; the bar then operates as that identity, shown in the badge. A gear opens **Settings**, which carries a **Log out** action that returns to the connect screen so a demo can switch between Junior Operator and ATS Core Lead live.

This is deliberately a **simulation**: there is no real identity provider and the two tokens are pre-provisioned locally. The login picks *which* pre-provisioned token Rust uses; it does not mint or fetch one. The honest framing for a real deployment — a true IdP/OAuth flow returning a per-session minted token — is the future fix and is deliberately deferred. What the simulation faithfully demonstrates is the token boundary: the webview only ever names a role; the secret never crosses into the page.

The chosen role and the custom hotkey are persisted to `session.json` in the app config dir (`app_config_dir()`), written by Rust (`save_session`). So "first run prompts to connect" holds only until the first login; the app reopens already signed in until the user logs out. The file holds a role *name* and an accelerator string — never a token.

The badge label is still configuration-derived, not server truth: the MCP tools resolve role server-side from the token and there is no `whoami` tool, so the app maps the chosen role key to a display label (`mcp::role_label`) rather than deriving it from the token. Adding a `whoami` tool server-side remains the clean future fix.

### Customizable global hotkey, validated by re-registration

Settings lets the user record a new summon shortcut: the webview captures one `keydown`, builds a Tauri accelerator string from the modifiers + `event.code` (`toAccelerator`), and requires at least one non-Shift modifier so a bare key cannot be captured. The candidate is only persisted on explicit Save. Validation is not duplicated in the frontend — `set_hotkey` unregisters the current shortcut, attempts to register the candidate, and on failure re-registers the old one and returns the error to the UI. So the global-shortcut plugin's own parser is the single source of truth for what is a valid accelerator; an unparseable or unavailable combination surfaces as an inline error and nothing is saved. The accepted hotkey is persisted alongside the role in `session.json` and re-registered on next launch.

### Frameless NSPanel that floats over fullscreen apps, dismiss-on-blur

`tauri.conf.json` starts the window hidden (`visible: false`) and frameless (`decorations: false`, `transparent: true`, `skipTaskbar: true`, `resizable: false`, `center: true`). The global shortcut (registered in Rust via `tauri-plugin-global-shortcut`, `on_shortcut`) toggles the panel, centers it, and emits `spotlight-open` so the webview focuses and selects the input. Pressing Esc (a `hide_window` command) hides it. Transparency requires `macOSPrivateApi: true` plus the `macos-private-api` cargo feature on the `tauri` dependency.

A plain always-on-top window only floats over *ordinary* windows: macOS gives each fullscreen app its own Space, and a regular window cannot appear in it — and even if forced to, activating a regular app to give it keyboard focus yanks the user out of the fullscreen Space. The standard fix, and what every Raycast/Spotlight-style app uses, is an `NSPanel`. So in `setup` the window is converted with `tauri-nspanel`'s `to_panel` (the `tauri_panel!` macro declares the panel class as `can_become_key_window` + `is_floating_panel`), then configured for the overlay contract:

- `set_collection_behavior(full_screen_auxiliary | can_join_all_spaces)` — the panel is allowed *into* the active fullscreen Space and onto every Space, instead of being confined to its own.
- `set_style_mask(nonactivating_panel)` — the panel can become key and take keystrokes **without activating the app**, so summoning it never switches Spaces or steals focus from the app underneath.
- `set_level(Floating)` — sits above normal window content.
- `set_activation_policy(Accessory)` — no Dock icon and no Cmd-Tab entry, matching a summon-on-hotkey utility. (Trade-off: a packaged build has no Dock icon to quit from; under `tauri dev` the terminal owns the process. Removing this one line restores the Dock icon.)

Dismiss-on-blur is handled by the panel's own `window_did_resign_key` delegate (registered via the macro's `panel_event!` and `set_event_handler`) rather than Tauri's `WindowEvent::Focused`, which a non-activating panel does not emit reliably.

Because the window is `transparent`, the OS clips everything to the window bounds — including the card's CSS drop shadow. The card therefore does not fill the window: the `body` reserves padding (`36px 48px 72px`, more at the bottom to match the shadow's downward offset) and the card is height-bounded to `calc(100vh - 108px)`, so the `0 18px 48px` shadow fades out inside the transparent window instead of being cut off at the edges.

### Links open in the system browser, not the webview

Confluence pages must open in the user's real browser, not the tiny always-on-top webview. The Markdown renderer emits `<a data-href="…">`, and a delegated click handler in `main.ts` calls `tauri-plugin-opener`'s `openUrl`. The capability set therefore adds `opener:allow-open-url`.

### Vanilla TS + a ported Markdown renderer

No React/Tailwind: the hover window must be tiny and instant, so the frontend is vanilla TS + Vite. `markdown.ts` is a dependency-free port of the web app's `parseMarkdown` (headings, lists, tables, code, and the inline pass for `**bold**`, `` `code` ``, `[text](url)`, `0x…` hex). It differs in two ways: it emits **escaped** HTML strings (the agent answer is treated as untrusted input, consistent with the server's prompt-injection stance — escape first, then re-introduce only the known constructs), and the `0x…` hex highlight is purely cosmetic here because there is no second role to diff against.

### No client-side rate limiting

The web console fronts the server with Upstash because it is a public web face. The spotlight is a single-user desktop tool, so it has no limiter of its own; the server remains the shared, protected resource. If the desktop app were ever distributed widely this would need revisiting.

## Verification

- **Core data path:** `cargo run --example probe` (with `MCP_TOKEN_JUNIOR_OP`/`MCP_SERVER_URL` set; `SPOTLIGHT_ROLE` selects which role's token to use, default `JUNIOR_OP`) calls `mcp::ask` against the live server and prints the grounded answer + source links — the GUI-free proof the client works.
- **Compiles:** `cargo check --examples`, `cargo clippy`, `cargo fmt --check`; frontend `bun run build` (runs `tsc`).
- **Manual:** `bun run tauri dev`, press the hotkey, ask, click a link (opens in the system browser), Esc/blur to dismiss.
