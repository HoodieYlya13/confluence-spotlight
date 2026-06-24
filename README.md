<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" alt="Confluence Spotlight" width="96" height="96" />
</p>

# Confluence Spotlight

A desktop **spotlight** client for the [accelerator-operations MCP server](https://github.com/HoodieYlya13/mcp-confluence-documentation-rag). Press a global hotkey, ask an operations question, get a short grounded answer with links straight to the source Confluence pages — without leaving what you're doing.

It is a thin, security-conscious window over the same RBAC-governed server the web console fronts: the bearer token lives only in the Rust process and is never exposed to the webview (the desktop analog of the web app's `server-only` tokens). Sign-in is a real **deep-link OAuth Authorization Code + PKCE round trip**, redeemed by the Rust process (never the webview), so the shipped app contains no secrets. A **released build** signs in against the self-hosted **OpenID Connect identity provider** ([`auth.hy13dev.com`](https://auth.hy13dev.com)) and receives **access + refresh tokens** whose role is fixed by the user's account — no role picker. A **dev build** instead signs in through the web console's demo persona picker (or the in-app Dev sign-in) for a hardcoded role token. The MCP server accepts both kinds of token. The MCP call uses the official Rust SDK (`rmcp`) — so the project drives one server from clients in Python, TypeScript, and Rust.

Design rationale lives in [`TAD.md`](./TAD.md).

## Download

Prebuilt installers for **macOS, Windows, and Linux** are available on the [GitHub Releases](https://github.com/HoodieYlya13/confluence-spotlight/releases) page, built automatically by the cross-platform [`release` workflow](.github/workflows/release.yml):

| Platform | Artifact                                   |
| -------- | ------------------------------------------ |
| macOS    | `.dmg` (universal — Apple Silicon + Intel) |
| Windows  | `.exe` / `.msi` installer                  |
| Linux    | `.AppImage` / `.deb`                       |

The builds are **unsigned** (this is a demo); see [First launch (unsigned)](#first-launch-unsigned) below for the bypass steps on each OS.

## Updating

Once installed, the app keeps itself current — no re-downloading from this page. On launch (release builds only — not `tauri dev`, not the Beta build) it checks the GitHub releases feed and, when a newer version has been **published**, shows an **Update & restart** banner in the bar. Clicking it downloads the new build, **verifies its signature** against the public key baked into the app, installs it, and relaunches. This uses Tauri's [updater plugin](https://v2.tauri.app/plugin/updater/) reading [`latest.json`](https://github.com/HoodieYlya13/confluence-spotlight/releases/latest/download/latest.json) (the manifest `tauri-action` attaches to each release).

You can also trigger a check on demand from **Settings → Updates → Check for updates** (the gear in the bar). Unlike the launch check, the manual button runs in any build — it reports "you're on the latest version", surfaces the same banner if one is available, or shows the error if the feed can't be verified (e.g. before the signing pubkey is wired in).

An update is only offered when the latest **published** release's `version` is higher than the running one — a draft or pre-release is invisible to the `releases/latest` feed. See [Shipping an update](#shipping-an-update) for the release-side steps (signing keys, version bump, publish).

## Prerequisites

- Rust (stable) + the platform toolchain Tauri needs — see https://tauri.app/start/prerequisites/
- [bun](https://bun.sh)

## Configure

The app ships with baked-in defaults, so a built `.app` needs no `.env`. For local dev, copy `.env.example` to `.env` to override:

| Variable             | Meaning                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `MCP_SERVER_URL`     | Base URL of the deployed MCP server                                                                                  |
| `SSO_ISSUER`         | OIDC identity provider issuer (production sign-in), e.g. `https://auth.hy13dev.com`                                  |
| `SSO_CLIENT_ID`      | This app's **public** OIDC client_id (PKCE; redirect `confluence-spotlight://auth`)                                  |
| `SPOTLIGHT_AUTH_URL` | Base URL of the web console — the demo/dev sign-in (hardcoded role tokens)                                           |
| `SPOTLIGHT_USE_SSO`  | Force the sign-in mode: `true` → SSO, `false` → console demo. Defaults to SSO in release builds, demo in dev builds. |
| `SPOTLIGHT_HOTKEY`   | Default global shortcut, e.g. `CmdOrCtrl+Shift+Space` (customizable in Settings)                                     |

These are all public values — there are **no secrets here**. In production the app obtains its token from the OIDC provider over PKCE (no client secret — it is a _public_ client). In dev, the bearer tokens live on the web console (its `MCP_TOKEN_*`) and the app obtains one through the demo sign-in. The `DEFAULT_*` constants in `src-tauri/src/mcp.rs` (and the `option_env!` build-time overrides) must point at your deployed provider/console. The `MCP_TOKEN_*` vars are only read by the `probe` example and the dev sign-in.

## Run

```bash
bun install
bun run tauri dev
```

The window opens automatically every time the app launches — after boot, a manual open, a quit-and-reopen, or an update restart. Once you dismiss it (**Esc** or click away), press the hotkey (default **Cmd+Shift+Space**) to summon it again. On a multi-monitor setup it opens on whichever screen the mouse is on; turn this off with Settings → **Follow the cursor** (on by default) to keep it on the last screen it used.

On launch it shows a **connect** screen. **Connect** opens your browser to sign in:

- **Released build →** the OIDC identity provider (`SSO_ISSUER`). Authenticate (passkey / magic link) and approve the consent prompt; the app returns signed in with the role assigned to your account — there is no role picker. It receives an access + refresh token, and the access token carries the role.
- **Dev build →** the web console's demo persona picker; choose **Junior Operator** or **ATS Core Lead** and approve the **"Open Confluence Spotlight?"** prompt to return with that hardcoded role token.

Then type a question and press Enter; click a source link to open the Confluence page in your system browser; press **Esc** or click away to dismiss. Tokens are held in memory only (not persisted), so you reconnect each launch; in production the refresh token renews an expired access token in place.

The bar is keyboard-first — defaults below, and the modifier-based ones are remappable in Settings:

| Keys | Action |
|---|---|
| `↑` / `↓` | Step through your questions from the last 24 h (in-memory) and tweak them |
| `⌘/Ctrl + ↑/↓` | Scroll the answer (also scrolls the Settings screen) |
| Hold `⌘/Ctrl + Shift` | After ~300 ms (so it doesn't clash with `⌘/Ctrl+Shift+Space`), scroll to the source links — first link kept visible — and number them. The numbers stay while `⌘/Ctrl` is held (Shift optional); releasing `⌘/Ctrl` removes them; hold again to re-scroll |
| `⌘/Ctrl + Shift + ↓` / `↑` | Page through link overflow (the `↓` form also jumps to the links immediately, no wait) |
| `⌘/Ctrl + (Shift) + <digit>` | Open a numbered link — type more digits for ≥ 10 links; release `⌘/Ctrl` to open the shorter number. Shift is optional once numbers show, so for `3/4/5/6` release Shift (macOS reserves `⌘⇧3/4/5/6` for screenshots) |
| `⌘/Ctrl + ,` | Open / close Settings |
| In Settings: `Esc` / `←` / `⌘/Ctrl + ,` | Back to the conversation |
| In Settings: `Shift + Q` ×2 | Log out (press twice within ~2.5 s to confirm) |
| `Ctrl + C` while a request runs | Cancel the in-flight question (shown as `⌃C to cancel` beside the status) |
| `Esc` | Leave link mode, then dismiss the window |

The search box keeps the caret while you click around the bar, so you can start typing the next question at any moment. Source links stay on a single line (truncated with an ellipsis) rather than wrapping. Holding `⌘/Ctrl+Shift` over the **Settings** screen numbers its buttons too (`Log out` = 0 … `Check for updates`), so any control is reachable by number — same as the links.

### Neovim mode

Settings → **Neovim mode** turns on a modal (Normal/Insert/Visual) keymap layered over the bar; it's off by default and the base `⌘/Ctrl` shortcuts keep working either way. A `NORMAL`/`INSERT`/`VISUAL` badge shows the mode, the Normal-mode cursor is a real block (and stays on the last character, like Neovim), and **Open in** chooses which mode each summon starts in (Insert by default). The **leader** key (default `Space`) is remappable in Settings; entering Normal mode (`Esc`, `Ctrl+[`, `Ctrl+C`, or `jj`) and the motions are fixed vim conventions.

| Keys | Action |
|---|---|
| `Esc` / `Ctrl+C` / `Ctrl+[` / `jj` | Enter Normal mode (also after every `Enter`) |
| `i` / `a` / `I` / `A` | Enter Insert at caret / after / line start / line end |
| `h` / `l` / `Backspace` | Move the cursor left / right (`Backspace` = left, never deletes; clamped to the last char) |
| `k` / `j` | Step history older / newer |
| `0` / `$` | Cursor to line start / end |
| `x` | Delete the character under the cursor |
| `dd` / `D` | Delete the whole line / to end of line |
| `y` / `yy` / `Y` / `p` / `P` | Yank line / yank line / yank line / paste after / paste before (paste pulls from the system clipboard) |
| `u` / `Ctrl+R` | Undo / redo |
| `v` (or select with mouse/keyboard) | Visual mode — `h`/`l`/`0`/`$` extend, `y` yank, `d`/`x` delete, `c` change, `Esc` back |
| Hold `Space` + `Shift` | Same as `⌘/Ctrl+Shift`: number the links (or Settings buttons). Once numbered, `Space + <digit>` opens (Shift optional); releasing `Space` commits |
| `Space` + `j` / `k` | Scroll the answer |
| `Space` + `,` | Toggle Settings |
| `Space` + `q` or `qq` | Close the window |
| In Settings: `h` / `Esc` / `Backspace` | Back to the conversation (`j` / `k` scroll) |
| In Settings: `Space` + `Shift` + `Q` ×2 | Log out (confirm within ~2.5 s) |

(`jj` to leave Insert means you can't quickly type a literal "jj" — the usual vim trade-off.)

The **gear** in the bar opens **Settings**, where you can:

- **Log out** to return to the connect screen (in a dev build, to switch persona; in a released build, to sign in as a different account).
- **Change the global hotkey** — click the shortcut, press a new key combination, and Save (registered immediately and persisted).
- **Remap the in-window shortcuts** — Scroll answer, Jump to links, and Open settings use the same record-a-shortcut control and persist alongside the hotkey. (The `↑`/`↓` history keys are a fixed terminal-style convention.)

> **macOS:** the deep-link sign-in only works in a **built, installed** app (custom URL schemes can't be registered under `bun run tauri dev` on macOS). Build it, drag the `.app` to `/Applications`, and run it from there. Under `tauri dev` everything else works, but **Connect** won't round-trip back — use the **Dev sign-in** row below.

### Signing in during `tauri dev`

Because the deep-link round-trip can't complete in dev, debug builds show a **Dev sign-in** row under the Connect button with one button per persona. Each reads `MCP_TOKEN_<ROLE>` from `.env` and connects directly — the same token source the `probe` example uses. This row is compiled in only under `debug_assertions`; a released (`tauri build`) binary has no token-reading path and shows only the real browser sign-in.

On macOS the bar is an `NSPanel`, so it floats over whatever you are doing — including apps in fullscreen — and across all Spaces, without pulling you out of the app underneath. It runs as an accessory (no Dock icon and no Cmd-Tab entry, like Raycast). On **Windows and Linux** the same bar is a frameless, always-on-top, transparent window that dismisses on blur, **Esc**, or click-away — the cross-platform analog of the panel. See [`TAD.md`](./TAD.md) for the rationale.

## Verify the data path (no GUI)

```bash
cd src-tauri
MCP_TOKEN_JUNIOR_OP=… MCP_SERVER_URL=… cargo run --example probe "your question here"
# or target the lead role:
SPOTLIGHT_ROLE=ATS_CORE_LEAD MCP_TOKEN_ATS_CORE_LEAD=… MCP_SERVER_URL=… cargo run --example probe "…"
```

Prints the grounded answer and its source links straight from the server, proving the Rust MCP client works without launching the window.

## Build & distribute

Cross-platform installers are produced by the GitHub Actions [`release` workflow](.github/workflows/release.yml) (`tauri-apps/tauri-action`) on every `v*` tag — macOS (universal `.dmg`), Windows (`.exe`/`.msi`), Linux (`.AppImage`/`.deb`) — and attached to a draft GitHub release. Cut one by pushing a tag:

```bash
git tag v0.1.2 && git push origin v0.1.2
```

To build locally for your own platform:

```bash
bun install
bun run tauri build
```

Artifacts land under `src-tauri/target/release/bundle/`. A release build signs in via SSO, so make sure `SSO_ISSUER` + `SSO_CLIENT_ID` (and `DEFAULT_SERVER_URL`) are set — bake them in via the `option_env!` constants in `src-tauri/src/mcp.rs`, or override at build time: `SSO_ISSUER=… SSO_CLIENT_ID=… MCP_SERVER_URL=… bun run tauri build`. (`SPOTLIGHT_AUTH_URL` only matters for the demo/dev sign-in.)

> Because the base config sets `bundle.createUpdaterArtifacts: true`, a release `bun run tauri build` (and CI) **must** have the updater signing key available — `TAURI_SIGNING_PRIVATE_KEY` (+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) in the environment — or the build fails. The Beta build below turns those artifacts off, so it needs no key. `bun run tauri dev` never signs.

### Shipping an update

The self-updater (see [Updating](#updating)) needs three things wired once, then a small ritual per release.

**One-time setup**

1. Generate an updater key pair (separate from any OS code-signing identity):
   ```bash
   bun run tauri signer generate -w ~/.tauri/confluence-spotlight.key
   ```
2. Put the **public** key in [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json) → `plugins.updater.pubkey`, replacing the `REPLACE_WITH_TAURI_SIGNER_PUBLIC_KEY` placeholder. (Safe to commit — it only verifies signatures.)
3. Add the **private** key + its password as GitHub repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (the [`release` workflow](.github/workflows/release.yml) passes them to `tauri-action`). Keep the private key out of the repo.

**Per release**

1. Bump the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `package.json` (the updater compares the published `version` against the running one).
2. Tag and push (`git tag vX.Y.Z && git push origin vX.Y.Z`) — `tauri-action` builds every OS, signs the bundles, and uploads them plus `latest.json` to a **draft** release.
3. **Publish** the draft release on GitHub. Only then does `releases/latest` resolve to it and installed apps start offering the update.

### Local "Beta" build, side by side with the released app

```bash
bun run tauri:beta
```

This builds **Confluence Spotlight Beta** — a distinct product name, bundle identifier, and deep-link scheme (`confluence-spotlight-beta://`), all defined in [`src-tauri/tauri.beta.conf.json`](src-tauri/tauri.beta.conf.json). It installs alongside the released **Confluence Spotlight** without colliding, and its sign-in still round-trips because the identity provider (and the console) allowlist both schemes — register `confluence-spotlight-beta://auth` as an extra redirect URI on the SSO client. Use it to keep your own up-to-date local build while still running the downloaded release.

### First launch (unsigned)

Because the app is built on GitHub Actions and is unsigned, operating systems and antivirus software will flag it on first launch:

- **macOS**
  1. Move the app from the `.dmg` into your `/Applications` directory (required for the `confluence-spotlight://` deep link to resolve).
  2. To bypass Gatekeeper, clear the quarantine flag manually in the Terminal:
     ```bash
     xattr -dr com.apple.quarantine "/Applications/Confluence Spotlight.app"
     ```
- **Windows**
  - **SmartScreen (Standard):** Click **More info** (Informations complémentaires) then **Run anyway** (Exécuter quand même).
  - **Enterprise EDR (Cortex XDR / work environments):** If your workplace antivirus (like Cortex XDR) blocks the installer with a "Suspect executable detected" (Exécutable suspect détecté) alert, this is because the installer is an unsigned binary with a new/unknown signature.
    - _To bypass:_ Either request your IT department whitelist the binary, or run the app directly from source on your local machine using the development environment commands below (as local compilation is typically permitted by EDR software).
- **Linux** — `chmod +x` the `.AppImage`, or install the `.deb`.
