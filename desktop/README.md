# Ludworks Browser (desktop: Windows, macOS, Linux)

A fast Chromium browser that signs in to your **Ludworks** server and keeps your **passwords, passkeys, bookmarks,
history, open tabs and settings** in sync — end-to-end encrypted with your vault master password. Imports and
exports **Bitwarden** vaults (JSON, password-protected JSON, CSV — passkeys included), KeePass and Chrome/Edge/Firefox
password CSVs. The Android version is the `:browser` module of `ludworks-android`.

## Why this engine

| Requirement | How |
|---|---|
| Works with streaming | Chromium 152 with H.264/AAC/HEVC/AV1/VP9 and **Widevine DRM** (castlabs "Electron for Content Security"); WebRTC, WebCodecs, WebTransport, Gamepad, Keyboard Lock, WebGPU for game streaming |
| Our own browser, not Edge | Ships its own Chromium; no WebView2/Edge runtime, no Microsoft or Google account, no telemetry |
| Regular security updates | The engine is one pinned download (`electron.lock.json`: version + SHA-256 per platform). `scripts/bump-electron.mjs` re-pins to castlabs' newest build (Chromium security fixes, usually within days of Chrome); `.github/workflows/engine-update.yml` opens that PR twice a week |
| Small and fast | Zero npm packages; the browser UI is a few hundred KB of vanilla JS/CSS; Windows install is ~305 MB (Edge ≈ 600 MB+), one renderer process per site, instant start |
| Minimal supply chain | Node built-ins only for build scripts, stdlib-only Go for the Windows installer/resource tools and the `.deb` builder |

## Features

* Tabs (pinning, drag to reorder, drag out of the strip into a window of their own or onto another window's strip,
  "Move to new window / Move to window" in the tab menu, mute, reopen closed), private windows (separate in-memory
  session), session restore,
  address bar with history/bookmark/open-tab/search suggestions (Google, DuckDuckGo, Bing, Brave, Startpage, Ecosia,
  Kagi or custom), history (90 days, searchable), downloads (dangerous-type warnings),
  find in page, zoom (remembered per site), print, save page, PDF viewer, dev tools, spell check,
  per-site permissions (camera, mic, location, notifications, screen sharing picker, external apps), certificate
  error interstitials, HTTP auth, light/dark themes, Windows 11 snap layouts / native title-bar buttons.
* **Ludworks sign-in** (server URL + account password + two-step code). The browser keeps only a **vault-scoped device
  token** (`vault:read vault:write`, 180 days); the full session is revoked at once. Self-signed servers are pinned by
  certificate fingerprint after you confirm it (trust on first use); nothing is sent to an unconfirmed certificate.
* **Vault** (shared with the web app, extension, Android and desktop apps): unlock with your master password
  (optionally kept unlocked with DPAPI / Keychain / Secret Service), auto-lock on idle and screen lock, key identity
  (`key_id`/`key_check`) and rollback checks per `VAULT-CRYPTO.md` §2.2/§2.5.
* **Autofill**: a browser-drawn dropdown under login fields (pages cannot see, overlay or click-jack it), fills only
  after you pick, same URI rules as the extension (registrable domain via the Public Suffix List, host/exact/regex…),
  TOTP codes (also split one-time-code boxes), strong-password generation for sign-up forms, "save / update password"
  prompts. Works in open shadow DOM (web components), cross-site login iframes, pages and popups opened by
  window.open / target=_blank (the content preload is registered on the session), zoomed pages, keyboard selection.
* **Passkeys**: the browser is a WebAuthn authenticator backed by passkeys stored in your vault (`VAULT-CRYPTO.md` §10):
  create, sign in, conditional ("autofill") passkey sign-in; "Use another device or security key" falls back to
  Windows Hello / security keys. Passkeys sync to every device and to Bitwarden-compatible exports.
* **Browser sync** (`API.md` §16): bookmarks, history, open tabs ("tabs from your other devices") and settings, sealed
  with keys derived from your vault key; the server only stores ciphertext.
* **Bookmarks**: two-pane manager (folder tree + contents, search, drag and drop of bookmarks and folders, Shift/Ctrl
  multi-select, cut/copy/paste, undo, bulk move); bookmarks bar with drag to reorder or into folders, drop links to add,
  right-click menu (edit, delete, open in new tab/window/private window) and an overflow menu.
* **Content blocker** (`src/main/blocker/`): our own engine for the Adblock Plus / uBlock Origin filter syntax (network
  filters, element hiding incl. procedural, a clean-room set of scriptlets) running uBlock's default lists, EasyList,
  EasyPrivacy, Peter Lowe's and URLhaus (downloaded and updated at runtime, compiled in a worker, cached). Shield button
  with the per-page count, what was blocked, a per-site switch and an element picker; lists, own filters and the
  allowlist in Settings. No uBlock Origin code is used (it is GPL; this app is proprietary).
* **Privacy buttons** (`src/main/privacy/`): a cookie button counting third-party sites on the page that have followed
  you from other sites (cookies seen under two or more sites), listing them and wiping their cookies, with an optional
  "block all third-party cookies"; an eraser button that clears the last hour / 24 / 48 / 72 hours / 7 days / all
  history (deletions sync), optionally downloads list, cache and cookies.
* **Import**: Bitwarden at full fidelity — JSON (individual and organization), password-protected JSON (PBKDF2 or
  Argon2id), .zip with attachments, CSV — keeping TOTP keys, passkeys, custom fields (incl. linked), password history,
  cards, identities, SSH keys and Bitwarden's newer item types, with a preview, duplicate handling and progress;
  KeePass (.kdbx, XML), Chrome/Edge/Firefox password CSV; bookmarks + history straight from Edge, Chrome, Brave,
  Vivaldi, Opera, Arc, Chromium, Yandex, Firefox, LibreWolf, Waterfox and Zen (every profile), bookmark HTML files.
  **Export**: Bitwarden JSON (password-protected recommended, round-trips everything above), Bitwarden CSV, KeePass
  .kdbx; bookmarks HTML.
* **Chrome extensions** (`src/main/extensions/`): install from the Chrome Web Store (its own "Add to Chrome" button, or
  "Add to Ludworks Browser"), from a .crx/.zip file or unpacked (Developer mode); CRX3 signatures and the store ID are
  verified, every install shows a permission prompt, Web Store extensions update daily. Toolbar puzzle menu, pinned
  action buttons with popups and badges, context-menu items, keyboard commands, `ludworks://extensions`. Electron's
  extension support is completed with action, tabs and windows events, contextMenus, notifications, cookies, alarms,
  permissions, commands, storage.sync and webNavigation; APIs Electron lacks (declarativeNetRequest, blocking
  webRequest, identity, native messaging, side panel, userScripts…) are left undefined and listed per extension.
  Extensions cannot script or open ludworks:// pages and are not loaded in private windows.
* **Separate process** (`src/main/separate.js`): "Move to separate process" in the tab menu opens the page in a second
  browser instance with its own GPU process, so two heavy pages (a WebGL game and a live stream) stop slowing each
  other down. Chromium draws all of a browser's windows through one GPU process, Chrome and Edge included. That
  instance runs on its own profile (`<profile>/Separate Process`), so sites there keep their own sign-ins; its windows
  show a "Separate process" chip, and "Move to main process" goes back.
* **Picture in picture** (`src/main/pip.js`): toolbar button when the page has a video, Ctrl+Shift+P, right-click a
  video (also inside iframes); optional automatic picture in picture when you switch away from a playing video.
* **Image and video saver** (`src/main/media/`): toolbar badge counting the page's images and videos; a popup with
  thumbnails, checkboxes and type filters (JPEG, PNG, GIF, WebP, AVIF, SVG, WebM, MP4…) saves the chosen files to a
  folder through the tab's session, with safe names and Mark-of-the-Web. Streams (MediaSource, DRM, HLS/DASH) are
  listed as not saveable.
* **AI agents** (`src/main/agent/`, `tools/lwb/`): coding agents — Claude Code and any MCP client, Vision through its
  plugins, scripts — use the browser (below).
* Main-process warnings and errors are kept in `<profile>/logs/main.log` (1 MB, rotated) — attach it to bug reports.

## AI agents (Claude Code, Vision, any MCP client)

Off until you turn it on in **Settings → AI agents**, or allow the first agent that asks. Then an agent works in **a
window of its own** — framed in violet, labelled "Claude Code is working in this window…", with **Stop** and
**Disconnect** — opened without taking the keyboard from you, and kept out of session restore, history and tab sync.

* **Tools** (MCP names; the same with `lwb`): `browser_navigate`, `browser_snapshot` (the page's accessibility tree as
  a compact outline; actionable elements carry stable refs such as `[ref=e12]`, iframes and cross-site frames
  included), `browser_find`, `browser_read` (readable text), `browser_click` / `browser_type` / `browser_fill_form` /
  `browser_select_option` / `browser_press_key` / `browser_hover` / `browser_scroll` / `browser_drag` /
  `browser_file_upload` (real mouse and keyboard input through the DevTools protocol; a click on something covered
  says what covers it), `browser_screenshot` (CSS-pixel coordinates for x/y clicks; `annotate` labels every
  interactive element with its ref), `browser_wait_for`, `browser_evaluate`, `browser_console_messages`,
  `browser_network_requests`, `browser_handle_dialog`, `browser_fill_login`, `browser_tabs`, `browser_downloads`,
  `browser_resize` and `browser_batch` (several steps in one call). Each action reports what it caused: a navigation,
  a new tab (which becomes the agent's), a dialog, a download.
* **lwb** (next to the browser executable; Go stdlib only): `lwb mcp` is a stdio MCP server — it answers `initialize`
  and `tools/list` itself and starts the browser only when a tool is called; `lwb navigate https://…`,
  `lwb snapshot --filter=interactive`, `lwb click e12`… run one tool (screenshots are saved as files). It finds the
  browser through `<profile>/agent-endpoint.json` (port + access key, readable by you only) and, when agent access is
  off or the browser is closed, starts it with `--agent-request=<client>` so you can allow that agent.
* **Connecting**: *Connect Claude Code* runs `claude mcp add --scope user ludworks-browser -- "<lwb>" mcp` — or, with
  no `claude` command, adds the server to the Claude desktop app's `claude_desktop_config.json` (read by its Code tab
  and its chat; `%LOCALAPPDATA%\Claude-Data\claude_<id>` or `%APPDATA%\Claude` on Windows) — writes a skill to
  `~/.claude/skills/ludworks-browser` and (optional) allows the tools in `~/.claude/settings.json`. *Add to
  Vision* writes `%APPDATA%\Vision\plugins\ludworks-browser.json` (`~/Library/Application Support/Vision/plugins` on
  macOS) — a plugin whose tools run `lwb` in Vision's agent shell; PowerShell gets the arguments as JSON on stdin,
  since Windows PowerShell 5.1 garbles native arguments containing quotes — and the same skill. Other MCP clients:
  the JSON shown in Settings (or an HTTP endpoint at `http://127.0.0.1:47821/mcp` with the access key).
* **What agents may do**: each client is approved once ("Always allow" or "this time"). They use the tabs they open,
  tabs you share with them (`browser_tabs action=share` asks for the one you are looking at) or, if you choose, all
  your tabs — never private windows or `ludworks://` pages. `browser_fill_login` fills a saved login after you pick the
  account in the browser; the agent never sees the password, and password values are masked in snapshots. Running
  JavaScript (`browser_evaluate`) can be switched off. The server listens on 127.0.0.1 only and refuses requests
  without the key, with an `Origin` header (web pages) or with another `Host` (DNS rebinding).

## Layout

```
desktop/
  electron.lock.json      pinned engine (castlabs ECS) + SHA-256 per platform
  build.mjs               stage | fetch | package | installer | linux-packages | all   (Node built-ins only)
  src/main/               main process: browser.js (windows, commands, IPC), window.js, tab.js, protocols.js,
                          account/ (sign-in, vault, browser sync, TLS pinning), autofill.js, passkeys.js, cbor.js,
                          import/ (Bitwarden/KeePass/CSV, other browsers), blocker/ (content blocker),
                          privacy/ (tracking cookies, clear history), webrequest.js (one webRequest dispatcher per
                          session), install-win.js, profile/ (SQLite stores), agent/ (AI agents: tool registry,
                          MCP, local server, DevTools-protocol driver, accessibility snapshots, harness setup)
  src/preload/            shell.cjs (browser UI), content-base.cjs + features/ (blocker, autofill, WebAuthn shim)
  src/shell/              tab strip/toolbar, popup overlay, error panel (lwshell://)
  src/pages/              ludworks:// pages: newtab, welcome, settings, passwords, bookmarks, history, downloads, sync, about
  src/vendor/vault/       verbatim copy of the web app's vault import/export library (check-vendor.mjs)
  ../src/lib/             vault crypto, URL matching, PSL, TOTP, generator, field detection (shared with the extension)
  tools/                  Go (stdlib only): winres (exe icon/version), setup (Windows installer), mkdeb (.deb),
                          lwb (AI agents' CLI and MCP bridge; tools.json is generated from src/main/agent/tools.js)
  packaging/linux/        control, maintainer scripts, AppArmor profile (user-namespace sandbox on Ubuntu 24.04+)
  scripts/                make-logo.mjs, make-browser-vectors.mjs, bump-electron.mjs, check-vendor.mjs
  tests/                  node --test unit tests (+ fixtures: shared vectors, a WebAuthn test relying party)
```

## Build

Node ≥ 24 and Go ≥ 1.27 (only for the Windows installer and the .deb).

```sh
node desktop/build.mjs stage                         # assemble desktop/build/app
node --test desktop/tests/*.test.mjs                 # unit tests (run after stage)
node desktop/build.mjs all --target=win32-x64        # dist/LudworksBrowserSetup-<v>-win-x64.exe (icon via winres: run on Windows)
node desktop/build.mjs all --target=linux-x64        # dist/ludworks-browser_<v>_amd64.deb + .tar.gz
node desktop/build.mjs package --target=darwin-arm64 # dist/darwin-arm64/Ludworks Browser.app (sign + dmg in CI)
```

Run the staged app without packaging: `.cache/electron/<version>/win32-x64/electron.exe desktop/build/app
--user-data-dir=<test profile>` (remote debugging is honoured only with a non-default profile).

### Windows installer

`LudworksBrowserSetup-<v>-win-x64.exe` installs per user (no admin rights) to `%LOCALAPPDATA%\Programs\Ludworks
Browser`, registers Default-apps capabilities, Start menu/desktop shortcuts and an uninstall entry; your profile lives in
`%LOCALAPPDATA%\Ludworks Browser\User Data`. Re-running a newer installer upgrades in place. `--silent`,
`--no-desktop-shortcut`, `--no-launch`, `--dir=` are supported. Uninstall from Settings → Apps.

### DRM (Netflix-class services)

Widevine L3 works out of the box (the CDM is fetched by the engine on first start). Services that require a
**VMP-signed** browser (Netflix, Disney+, Max…) additionally need the packaged app signed with castlabs EVS
(free account): `python3 -m pip install castlabs-evs`, `python3 -m castlabs_evs.account signup`, then after packaging
(and after Authenticode signing on Windows, before codesign on macOS):
`python3 -m castlabs_evs.vmp sign-pkg "desktop/dist/win32-x64/Ludworks Browser"`.

## Security model (summary)

* Tabs: sandboxed renderers, context isolation, site isolation, no Node in web content; fuses disable
  `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, the inspector and extra `file://` privileges; cookies are encrypted at rest.
* Pages talk to the browser only through narrow IPC; every request is checked against the sending frame (origin from
  the browser, never from the page). Internal pages (`ludworks://`) cannot be opened or framed by websites.
* Vault keys never leave the main process; the master password is never stored; autofill and passkey prompts are
  browser UI, not page DOM.
