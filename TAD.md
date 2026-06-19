# Technical Architecture Decisions — confluence-spotlight

House convention: no code comments or docstrings. Every design decision and its rationale lives here.

## Purpose

A desktop **spotlight** client for the same [mcp-confluence-documentation-rag](https://github.com/HoodieYlya13/mcp-confluence-documentation-rag) server that the web console fronts. A global hotkey (`Cmd+Shift+Space` by default) summons a frameless, always-on-top command bar; you type an operations question, and the server's `ask_accelerator_operations` agent returns a short grounded answer with links straight to the source Confluence pages. It is the "ask in two seconds without leaving what you're doing" surface, where the web console is the "explore the RBAC story in a browser" surface.

This is a third client over one server — Python server, TypeScript web console, Rust desktop app — exercising the MCP protocol from a third language.

## Decisions

### The bearer token never leaves the Rust process — desktop `server-only`

This is the load-bearing decision and the direct analog of the web app's `server-only` token handling. The web console keeps tokens out of the browser; here the equivalent boundary is process-internal. The token is acquired by Rust (via the sign-in flow below), held in memory on the managed `AppState` (`auth: Mutex<Option<Auth>>`), and used only inside `ask_question`/`mcp::ask`. There is no command that returns a token. The webview is a thin renderer: it calls `ask_question` and receives back only `{ answer, role }` — rendered text and a cosmetic label. The token is never sent into the webview, never embedded in JS, never reachable from the page context.

The shipped build contains **no secrets at all**. `mcp.rs` (`McpConfig::from_env`, via `dotenvy`) reads only `MCP_SERVER_URL`, `SPOTLIGHT_AUTH_URL` and `SPOTLIGHT_HOTKEY` — all public URLs/strings, with baked-in defaults so a distributed `.app` works with no `.env`. The bearer tokens live on the Next.js console (the same `MCP_TOKEN_*` that power its playground); the desktop app fetches one at sign-in time and never persists it. The login flow does not weaken the boundary: the webview triggers `begin_login` and later receives a success/failure event — it never names a token and never sees one. This mirrors the server's own model, where the client never sends its own role; identity is resolved from the bearer token everywhere in the system.

### A real Rust MCP client (`rmcp`), not a REST shim

`mcp.rs` uses the official Rust SDK `rmcp` with its streamable-HTTP client transport (`StreamableHttpClientTransport::from_config`), performing the full initialize → `call_tool("ask_accelerator_operations") → cancel` handshake per request. The bearer token is supplied through the transport config's `auth_header` (token without the `Bearer ` prefix; the transport adds it). A raw `reqwest` POST would have been fewer lines, but using the real SDK keeps this consistent with the web app's "real MCP client, not a REST shim" stance and means the project now demonstrates an MCP server plus clients in two different languages. Connections are per-request, matching the low-traffic, summon-on-demand usage.

The answer is extracted preferring the tool's `structured_content.result` (the string the agent returns) and falling back to concatenated text content — the same precedence the TypeScript client uses.

### Deep-link OAuth sign-in (Authorization Code + PKCE), with logout to switch roles

The spotlight runs as **one** role at a time (a personal tool, not the web console's side-by-side RBAC diff), and *which* role is chosen at runtime through a real browser sign-in rather than baked into an env var. This is the Authorization-Code-with-PKCE shape that a desktop app — a *public* client that cannot hold a client secret — is supposed to use:

1. **Connect** invokes `begin_login` (Rust). Rust generates a random `state` (CSRF) and a PKCE `verifier`, derives `challenge = base64url(sha256(verifier))`, stores `{state, verifier}` in `pending_auth`, and opens the system browser to the console's `/spotlight-login?state=…&code_challenge=…&redirect_uri=confluence-spotlight://auth` (`tauri-plugin-opener`).
2. The console page (the IdP/login surface — role selection belongs there, not in the app) validates the `redirect_uri` against an allowlist and renders a persona button per configured role. Picking one runs a server action that mints a single-use authorization `code` (60 s TTL, keyed to the role + `challenge` + `state` in Upstash) and `redirect`s the browser to `confluence-spotlight://auth?code=…&state=…`.
3. macOS hands that custom scheme to the app; `tauri-plugin-deep-link`'s `on_open_url` fires in the running process. Rust verifies the returned `state` matches `pending_auth`, then `POST`s the `code` + `verifier` to the console's `/api/spotlight/token`, which re-verifies PKCE and returns the bearer token. Rust stores it in `auth` and emits `spotlight-auth` so the webview switches to the search view.

A gear opens **Settings** with a **Log out** action that clears `auth` and returns to the connect screen, so a demo can switch between Junior Operator and ATS Core Lead live (sign in again as the other persona).

**Honest framing.** The console's token endpoint vends a *pre-provisioned demo token* — it stands in for an IdP's token endpoint rather than minting a per-user credential against a real directory. But the protocol around it is the genuine article: state/CSRF, PKCE S256, a single-use short-TTL code, a redirect-URI allowlist, and the secret crossing only server→Rust. This is the real version of what an earlier iteration only simulated.

**Tokens are ephemeral and never written to disk.** `auth` lives only in memory; the access token is never persisted. Only the custom hotkey is saved to `session.json` (`app_config_dir()`, written by `save_settings`) — a single accelerator string, no role and no token. Consequence: the app prompts to connect on every launch, which is faithful to how short-lived access tokens behave and keeps the on-disk file secret-free. (A real deployment would persist a refresh token in the OS keychain — the deferred next step.)

The badge label is server-truth-adjacent: the token endpoint returns the role + label alongside the access token (`role_label`), and `mcp::role_label` maps the role key for display. A server-side `whoami` MCP tool remains the clean future fix for deriving the badge purely from the token.

### Customizable global hotkey, validated by re-registration

Settings lets the user record a new summon shortcut: the webview captures one `keydown`, builds a Tauri accelerator string from the modifiers + `event.code` (`toAccelerator`), and requires at least one non-Shift modifier so a bare key cannot be captured. The candidate is only persisted on explicit Save. Validation is not duplicated in the frontend — `set_hotkey` unregisters the current shortcut, attempts to register the candidate, and on failure re-registers the old one and returns the error to the UI. So the global-shortcut plugin's own parser is the single source of truth for what is a valid accelerator; an unparseable or unavailable combination surfaces as an inline error and nothing is saved. The accepted hotkey is the only thing persisted to `session.json` and is re-registered on next launch.

### Frameless NSPanel that floats over fullscreen apps, dismiss-on-blur

`tauri.conf.json` starts the window hidden (`visible: false`) and frameless (`decorations: false`, `transparent: true`, `skipTaskbar: true`, `resizable: false`, `center: true`). The global shortcut (registered in Rust via `tauri-plugin-global-shortcut`, `on_shortcut`) toggles the panel, centers it, and emits `spotlight-open` so the webview focuses and selects the input. Pressing Esc (a `hide_window` command) hides it. Transparency requires `macOSPrivateApi: true` plus the `macos-private-api` cargo feature on the `tauri` dependency.

A plain always-on-top window only floats over *ordinary* windows: macOS gives each fullscreen app its own Space, and a regular window cannot appear in it — and even if forced to, activating a regular app to give it keyboard focus yanks the user out of the fullscreen Space. The standard fix, and what every Raycast/Spotlight-style app uses, is an `NSPanel`. So in `setup` the window is converted with `tauri-nspanel`'s `to_panel` (the `tauri_panel!` macro declares the panel class as `can_become_key_window` + `is_floating_panel`), then configured for the overlay contract:

- `set_collection_behavior(full_screen_auxiliary | can_join_all_spaces)` — the panel is allowed *into* the active fullscreen Space and onto every Space, instead of being confined to its own.
- `set_style_mask(nonactivating_panel)` — the panel can become key and take keystrokes **without activating the app**, so summoning it never switches Spaces or steals focus from the app underneath.
- `set_level(Floating)` — sits above normal window content.
- `set_activation_policy(Accessory)` — no Dock icon and no Cmd-Tab entry, matching a summon-on-hotkey utility. (Trade-off: a packaged build has no Dock icon to quit from; under `tauri dev` the terminal owns the process. Removing this one line restores the Dock icon.)

Dismiss-on-blur is handled by the panel's own `window_did_resign_key` delegate (registered via the macro's `panel_event!` and `set_event_handler`) rather than Tauri's `WindowEvent::Focused`, which a non-activating panel does not emit reliably.

Because the window is `transparent`, the OS clips everything to the window bounds — including the card's CSS drop shadow. The card therefore does not fill the window: the `body` reserves padding (`36px 48px 72px`, more at the bottom to match the shadow's downward offset) and the card is height-bounded to `calc(100vh - 108px)`, so the `0 18px 48px` shadow fades out inside the transparent window instead of being cut off at the edges.

**Cross-platform fallback.** The `NSPanel` machinery is macOS-only, so `tauri-nspanel` (and everything that touches it — the `tauri_panel!` macro, `to_panel`, `set_collection_behavior`, `set_style_mask`, `set_activation_policy`, the panel show/hide/toggle paths) lives behind `#[cfg(target_os = "macos")]`, and the crate is declared under `[target.'cfg(target_os = "macos")'.dependencies]` so it never compiles on Windows/Linux. There, `show_window`/`hide_window_impl`/`toggle_window` operate on the ordinary `WebviewWindow` (still frameless, `transparent`, `alwaysOnTop`, `skipTaskbar`), and dismiss-on-blur is wired through Tauri's `WindowEvent::Focused(false)` — which a normal window *does* emit, unlike the non-activating panel. The window contract is otherwise identical, so one `tauri.conf.json` drives all three platforms; only the focus/overlay mechanism is conditional. (`macos-private-api` stays a plain feature on the base `tauri` dependency — it is inert off macOS, and keeping it in `[dependencies]` satisfies `tauri-build`'s check that the feature matches `macOSPrivateApi: true` in the config.)

### Links open in the system browser, not the webview

Confluence pages must open in the user's real browser, not the tiny always-on-top webview. The Markdown renderer emits `<a data-href="…">`, and a delegated click handler in `main.ts` calls `tauri-plugin-opener`'s `openUrl`. The capability set therefore adds `opener:allow-open-url`.

### Vanilla TS + a ported Markdown renderer

No React/Tailwind: the hover window must be tiny and instant, so the frontend is vanilla TS + Vite. `markdown.ts` is a dependency-free port of the web app's `parseMarkdown` (headings, lists, tables, code, and the inline pass for `**bold**`, `` `code` ``, `[text](url)`, `0x…` hex). It differs in two ways: it emits **escaped** HTML strings (the agent answer is treated as untrusted input, consistent with the server's prompt-injection stance — escape first, then re-introduce only the known constructs), and the `0x…` hex highlight is purely cosmetic here because there is no second role to diff against.

### No client-side rate limiting

The spotlight is a single-user desktop tool, so it has no limiter of its own; the server remains the shared, protected resource. The two console endpoints it now depends on (the authorize action and the token exchange) *are* fronted by the console's existing Upstash limiter, so distributing the app does not open an unmetered path to the bearer tokens.

### Custom URL scheme and the macOS development caveat

The deep link uses a private scheme, `confluence-spotlight://auth`, declared under `plugins.deep-link.desktop.schemes` in `tauri.conf.json` and registered with LaunchServices via the bundle's generated `Info.plist`. **On macOS this means the round trip only works in a bundled app installed in `/Applications` — not under `tauri dev`** (the deep-link plugin cannot register a scheme at runtime on macOS). So the full sign-in is verified on the installed build; the scheme handler itself can be exercised in isolation with `open "confluence-spotlight://auth?code=…&state=…"`. `register_all()` is called only on Windows/Linux (where runtime registration *is* supported) to keep `tauri dev` working there. The redirect URI the app sends is derived from its **own** config at runtime — `deep_link_redirect_uri` reads `plugins.deep-link.desktop.schemes` from the embedded `tauri.conf.json` — so a build configured with a different scheme (the Beta build, below) sends a matching `redirect_uri` with no code change, and the console allowlists both.

Since that round trip dead-ends under `tauri dev`, a **dev-only sign-in fallback** keeps the app usable while iterating: the `dev_login` command reads `MCP_TOKEN_<role>` from `.env` and sets `auth` directly, and the login view exposes one persona button per role. Both halves are gated so the production posture is unchanged — the command body and its `dev_token` helper are compiled only under `#[cfg(debug_assertions)]` (a release build's `dev_login` is an inert `Err`, with no token-reading code in the binary), and the webview reveals the buttons only when `import.meta.env.DEV` (false in a `vite build`). The fallback deliberately bypasses the browser/PKCE exchange — it is a dev shortcut to a token, not a second auth path — so the shipped build still has exactly one way in.

## Deployment

Releases are cut by a GitHub Actions matrix (`.github/workflows/release.yml`, `tauri-apps/tauri-action`) that builds on `macos-latest` (universal `aarch64`+`x86_64` `.dmg`), `ubuntu-22.04` (`.AppImage`/`.deb`), and `windows-latest` (`.exe`/`.msi`) on every `v*` tag, attaching every artifact to a draft GitHub release — the "downloadable on every OS" story. The builds are intentionally **unsigned/un-notarized** (this is a demo), so first launch needs the per-OS bypass (Gatekeeper right-click → Open or `xattr -dr com.apple.quarantine`; SmartScreen → Run anyway; `chmod +x` the AppImage). Because the shipped binary holds no secrets, the only build-time configuration is the two public URLs — `DEFAULT_SERVER_URL` / `DEFAULT_AUTH_URL` in `mcp.rs`, overridable via `MCP_SERVER_URL` / `SPOTLIGHT_AUTH_URL`; `DEFAULT_AUTH_URL` **must** point at the deployed console.

### A "Beta" build that coexists with the release

`bun run tauri:beta` builds with a config overlay (`tauri.beta.conf.json`, merged over the base via `tauri build --config`) that changes exactly three things: the product name (**Confluence Spotlight Beta**), the bundle identifier (`…confluence-spotlight-beta`), and the deep-link scheme (`confluence-spotlight-beta://`). The distinct identifier gives Beta its own install slot and its own `session.json`; the distinct scheme means its sign-in deep link routes to *it* rather than to an installed release — so a locally-built Beta and the downloaded release can be installed and used at the same time without LaunchServices ambiguity. This works only because the redirect URI is read from config (above) and the console allowlists both schemes, so no Rust or console code branches on "beta". The base `tauri.conf.json` stays the canonical published identity, so CI releases are unaffected.

## Verification

- **Console half (no GUI):** drive `/spotlight-login`'s authorize action to mint a `code`, then `POST /api/spotlight/token` with the matching PKCE `code_verifier` — asserts a valid exchange returns the token and that replay (single-use), wrong verifier, and expired/unknown codes are all rejected.
- **Core data path:** `cargo run --example probe` (with `MCP_TOKEN_JUNIOR_OP`/`MCP_SERVER_URL` set; `SPOTLIGHT_ROLE` selects which role's token, default `JUNIOR_OP`) calls `mcp::ask` against the live server and prints the grounded answer + source links — the GUI-free proof the client works.
- **Compiles:** `cargo check --examples`, `cargo clippy --examples`, `cargo fmt --check`; frontend `bun run build` (runs `tsc`).
- **Manual (installed build, macOS):** install the `.app` to `/Applications`, summon, **Connect** → pick a persona in the browser → approve the "Open Confluence Spotlight?" prompt → returns signed in → ask, click a source link, Esc/blur to dismiss, gear → Log out to switch personas.
