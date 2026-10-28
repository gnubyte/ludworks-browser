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

* Tabs (pinning, drag to reorder, mute, reopen closed), private windows (separate in-memory session), session restore,
  address bar with history/bookmark/open-tab/search suggestions (Google, DuckDuckGo, Bing, Brave, Startpage, Ecosia,
  Kagi or custom), history (90 days, searchable), downloads (dangerous-type warnings),
  find in page, zoom (remembered per site), print, save page, PDF viewer, picture-in-picture, dev tools, spell check,
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
  TOTP codes, strong-password generation for sign-up forms, "save / update password" prompts.
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
* Main-process warnings and errors are kept in `<profile>/logs/main.log` (1 MB, rotated) — attach it to bug reports.

## Layout

```
desktop/
  electron.lock.json      pinned engine (castlabs ECS) + SHA-256 per platform
  build.mjs               stage | fetch | package | installer | linux-packages | all   (Node built-ins only)
  src/main/               main process: browser.js (windows, commands, IPC), window.js, tab.js, protocols.js,
                          account/ (sign-in, vault, browser sync, TLS pinning), autofill.js, passkeys.js, cbor.js,
                          import/ (Bitwarden/KeePass/CSV, other browsers), blocker/ (content blocker),
                          privacy/ (tracking cookies, clear history), webrequest.js (one webRequest dispatcher per
                          session), install-win.js, profile/ (SQLite stores)
  src/preload/            shell.cjs (browser UI), content-base.cjs + features/ (blocker, autofill, WebAuthn shim)
  src/shell/              tab strip/toolbar, popup overlay, error panel (lwshell://)
  src/pages/              ludworks:// pages: newtab, welcome, settings, passwords, bookmarks, history, downloads, sync, about
  src/vendor/vault/       verbatim copy of the web app's vault import/export library (check-vendor.mjs)
  ../src/lib/             vault crypto, URL matching, PSL, TOTP, generator, field detection (shared with the extension)
  tools/                  Go (stdlib only): winres (exe icon/version), setup (Windows installer), mkdeb (.deb)
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
