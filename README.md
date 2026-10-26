# Ludworks Passwords — browser extension

The password-manager extension for **Ludworks**, the self-hosted, security-first NAS "multitool".
It talks to your own Ludworks server and gives you your **end-to-end encrypted** vault in Chrome and
Firefox: search, copy, TOTP codes, a password generator and safe on-demand autofill.

* One source tree, two builds: **Chrome (Manifest V3, service worker)** and **Firefox (Manifest V3,
  event page, `passwords@ludworks.app`, Firefox ≥ 128)**.
* **Zero runtime dependencies.** No npm packages, no bundler, no CDN, no remote code. The build script,
  ZIP writer, PNG encoder and content-script bundler use Node built-ins only.
* Crypto implements `ludworks-server/docs/spec/VAULT-CRYPTO.md` exactly and reproduces the shared
  `vault-test-vectors.json`, plus independent vectors generated with Python `cryptography`.

## Features

| Area | What you get |
|---|---|
| Sign-in | Server address + username/password, two-step verification (authenticator or recovery code). Uses `token_mode` login: the extension holds a revocable **device session** token (`lws_…`, shown as "Chrome extension"/"Firefox extension" in your server's session list). |
| Server identity | HTTPS required (plain HTTP only for `localhost`/`127.0.0.1`). Trust-on-first-use confirmation of the server's SHA-256 certificate fingerprint before any credential is sent; certificate changes block the extension until you re-confirm. On Firefox the fingerprint is read from the TLS connection itself and **every** response is checked against the pin. |
| Unlock | Master password → PBKDF2-SHA256 (≥ 600 000 iterations) → HKDF → AES-256-GCM key unwrap, all local. Works offline from the encrypted cache. |
| Vault | Tabs **This site** / **All** / **Favorites**, instant search, letter avatars (no favicon fetching), logins, secure notes, cards and identities, folders, custom fields, password history. |
| Item detail | Reveal + copy for every secret, live TOTP code with countdown ring (RFC 6238, SHA-1/256/512, 6–8 digits, custom periods, Steam Guard), open websites, notes. |
| Edit | Add/edit any item type; new logins are pre-filled with the current site and a generated password; strength meter; URI match rules (domain, host, starts with, exact, regex, never); delete with confirmation. Unknown JSON keys are preserved on edit. |
| Generator | Passwords (8–128 chars, character sets, avoid ambiguous `Il1O0`) and passphrases (3–12 words from a bundled 3 321-word list, separator, capitalisation, number) with entropy display. CSPRNG with rejection sampling. |
| Autofill | **Fill** button or `Ctrl+Shift+F` fills the best match into the active tab — only on user action, only HTTPS (localhost HTTP after an explicit confirmation), only into visible fields, only when the page matches the login's URI rules, never into cross-origin frames, never when the form posts to plain HTTP. Handles React/Vue/Angular forms, multi-step logins and TOTP steps. |
| Offer to save (optional) | When enabled in Settings (grants HTTPS host access at that moment), Ludworks notices submitted logins and asks — in a closed shadow-root prompt — to save a new login or update a changed password, or never ask for that site. |
| Locking | Auto-lock after inactivity (1 min – 4 h, default 15 min), when the computer locks or goes idle, and on browser restart. "Lock now" in one click. |
| Clipboard | Copied secrets are cleared after 30 seconds. |
| Settings | Lock timeout, offer-to-save, certificate pin status, sync, open web app, log out, clear all local data. |
| UI | Clean 380 × 560 popup, light/dark via `prefers-color-scheme`, keyboard friendly (`/` search, arrows, Enter, Esc), screen-reader labels and live regions. |

Shortcuts: `Ctrl+Shift+L` opens the popup, `Ctrl+Shift+F` fills the best match (`⌘⇧L` / `⌘⇧F` on macOS).
Change them at `chrome://extensions/shortcuts` or Firefox *about:addons → ⚙ → Manage Extension Shortcuts*.

## Install

Release packages are produced by `node build.mjs` (and by CI as artifacts):
`dist/ludworks-passwords-chrome-<version>.zip` and `dist/ludworks-passwords-firefox-<version>.zip`.

**Chrome / Edge / Brave (developer install)**: build, open `chrome://extensions`, enable *Developer mode*,
*Load unpacked* → select `dist/chrome`. For distribution, upload the Chrome zip to the Chrome Web Store
(or your enterprise policy store).

**Firefox**: build, open `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* → select
`dist/firefox/manifest.json`. Permanent installs need the package signed by AMO (listed or unlisted
self-distribution): upload `ludworks-passwords-firefox-<version>.zip`.

Then click the toolbar icon, enter your server address (e.g. `https://nas.example.com`), sign in, compare the
certificate fingerprint with **Admin → System** in the Ludworks web UI (or the server's startup log), and
unlock with your **master password**. If your vault has not been created yet, the popup links you to the web
app to set it up (the master password is chosen there).

### Self-signed certificates

A fresh Ludworks server uses a self-signed certificate. Browser extensions cannot bypass certificate
validation (by design), so **first open the server address in a normal tab and trust the certificate**
(or import it into your OS / browser trust store), or give the server a certificate from a trusted CA
(ACME mode, your own CA, or a reverse proxy). Afterwards the extension pins the fingerprint as described above.

## Build & test

Requirements: Node ≥ 22 (CI uses 24). Optional: Python 3 with `cryptography` for the independent crypto
cross-check (tests skip it gracefully when unavailable).

```sh
node build.mjs                    # dist/chrome, dist/firefox + reproducible zips (validates manifests, scans output)
node build.mjs --target=firefox --no-zip
node --test "tests/*.test.mjs"    # all unit/integration tests (npm test does the same)
node scripts/make-icons.mjs       # regenerate src/icons/*.png (deterministic); --check verifies them
python3 -I scripts/vectors/make_vectors.py generate > tests/fixtures/crypto-vectors.json
node scripts/dev/preview.mjs      # dev-only popup preview at http://127.0.0.1:18097 (see below)
```

On the Ludworks dev machine the toolchain lives in WSL:
`bash /c/Users/phsta/code/ludworks/.dev/wsl.sh ludworks-browser 'node --test "tests/*.test.mjs" && node build.mjs'`.

### What the tests cover

* **vault-crypto** — base64 strictness, KDF/HKDF/AES-GCM known answers (own Python vectors and the shared
  `ludworks-server/docs/spec/vault-test-vectors.json` when that repo sits next to this one), NFC
  normalisation, AAD binding (records cannot be swapped between ids/types), tampering, wrong password,
  unlock hardening, create/rewrap, and a live round-trip verified by Python `cryptography`.
* **totp** — RFC 6238 Appendix B, spec vectors, otpauth parsing (canonical result shape), Steam codes.
* **generator** — rejection sampling, uniformity (χ²), sets/length rules, passphrases, spec determinism
  vectors (passwords; passphrases with the canonical word list when available), strength estimator.
* **url-match** — registrable domains (`co.uk`, `com.au`, …), IPs/localhost/ports, subdomains, downgrade
  protection, every match mode, ReDoS refusal.
* **field-detect** — login/username-only/password-only/TOTP steps, sign-up and change-password forms, search
  boxes, hidden/honeypot/off-screen/zero-size/disabled fields, same- vs cross-origin iframes, insecure form
  actions, credential extraction, React-style value setting — all against a small fake DOM.
* **core** — the whole background flow against a mock Ludworks server: TOFU pinning, login + TOTP,
  unlock/lock/offline unlock, sync (full + incremental), CRUD with conflicts, malicious-server record swaps,
  revoked sessions, certificate changes, auto-lock deadlines, offer-to-save, and *what is (not) persisted where*.
* **autofill / handlers / background glue** — injection targets, the bundled content script executed in a VM
  against fake pages, sender + schema validation, Firefox certificate observer, clipboard clearing,
  capture-script registration.
* **build / packaging / lint** — both manifests validated (MV3 rules, minimal permissions, CSP), content
  scripts are self-contained classic scripts, ZIPs verified by `python3 -m zipfile -t` and byte-for-byte
  reproducible, PNG icons decode and match a fresh render, bundler edge cases, no `innerHTML`/`eval`/remote code.
* **crypto-interop / lib-interop** — this repo's `vault-crypto.js`, `url-match.js` and `totp.js` against the web
  app's canonical copies (`ludworks-server/web/assets/js/lib/vault/`): byte-identical results on the shared
  vectors, random item/folder/raw-seal round trips in both directions, vaults created or re-keyed by one
  library unlocking in the other, identical failures on malformed/tampered input and weak KDF parameters, the
  same URL-match answers for every mode (except the documented, stricter `starts_with`) and the same TOTP codes.
  The only deliberate crypto difference: the web lib also accepts *unpadded* base64; the extension accepts only
  the canonical padded form the server enforces for everything it stores.

### Integration tests (live server)

`tests/integration/` runs the **built** extension (`build.mjs` output, fresh copy per service-worker start)
inside a faithful fake browser (`browser-env.mjs`: storage.local/session with quotas and change events,
alarms on a virtual clock, runtime messaging with real sender objects and Chrome/Firefox reply semantics,
permissions with user-gesture checks and match-pattern subsumption, scripting/tabs/activeTab, idle,
commands, Chrome offscreen documents, Firefox `webRequest` + `getSecurityInfo`) against a **live** Ludworks
server. Its network stack sends the extension `Origin`, bypasses CORS only for hosts the extension holds a
host permission for and otherwise performs real CORS (preflights, `Access-Control-*` checks, filtered
headers), never sends cookies unless asked, and validates TLS against the profile's trust store while exposing
the presented certificate to the Firefox pin. The real web app code (`core/api.js` + the Passwords app's
`session.js`, with a cookie + CSRF session) acts as the other device, so every item and vault is checked
across clients.

```sh
# a server with TLS off (and optionally a second one with --tls self-signed for the pinning tests)
export LUDWORKS_IT_URL=http://127.0.0.1:18104 LUDWORKS_IT_ADMIN=admin LUDWORKS_IT_ADMIN_PASSWORD='…'
export LUDWORKS_IT_SETUP_TOKEN_FILE=<data>/setup-token.txt          # only if the server is not set up yet
export LUDWORKS_IT_TLS_URL=https://127.0.0.1:18204 LUDWORKS_IT_TLS_SETUP_TOKEN_FILE=<tls data>/setup-token.txt
npm run test:integration   # = node --test --test-concurrency=1 "tests/integration/*.test.mjs"
```

Without `LUDWORKS_IT_URL` (or without the `ludworks-server` checkout next to this repo) every integration test
skips. Coverage: sign-in (`token_mode`, device session, TOTP, recovery codes, lockout → `rate_limited` with
`Retry-After`), unlock, full/incremental/410 sync, list + URL matching, create/edit/move/delete with password
history and unknown keys preserved both ways, conflicts, autofill into a page, offer-to-save through content
messages, clipboard clearing via the offscreen document, lock/auto-lock/idle/worker and browser restarts,
offline unlock, master-password change and vault reset on another device, log-out and remote revocation, a
2 500-item vault; CORS for `chrome-extension://` and `moz-extension://` origins, `allowed_extension_origins`,
cookie refusal; TLS pinning on Firefox (presented certificate, interception through a MITM front) and Chrome
(server-reported fingerprint, certificate change), and setup-required servers.

`node scripts/dev/live-preview.mjs --server=http://127.0.0.1:18104` serves the built popup (`dist/chrome`) in a
normal tab with the real background core running in the page and the server's API forwarded (extension
`Origin`, no cookies), so the UI can be clicked through against a live server.

### Dev preview

`node scripts/dev/preview.mjs` serves the real popup with a fake `chrome` API whose messages go through the
real background handler and core, backed by the mock server (seeded vault, master password
`correct horse battery staple`). Open `http://127.0.0.1:18097/src/popup/popup.html?scenario=unlocked`
(`login` | `locked` | `unlocked`, optional `&url=` for the active tab). It is never packaged.

## Usage notes

* **Fill** appears on rows/detail pages that match the active tab. The shortcut picks the most specific match
  (exact > starts with > host/regex > same hostname > same domain), then the most recently used, then favourites.
  If nothing matches, the toolbar badge shows `?`; if filling is refused it shows `!` (open the popup for details).
* On `http://localhost` pages Fill asks for confirmation first; other plain-HTTP pages are never filled.
* "Offer to save" needs the optional host permission for `https://*/*` (+ localhost); turning it off releases it.

## Security notes

**Threat model.** The server is trusted to store data but not to read it: it only ever receives ciphertext and
KDF parameters. Web pages are untrusted. Other extensions are untrusted.

* **Keys.** The master password, master key and wrap key exist only transiently in memory. The decrypted
  vault key is kept **only in `storage.session`** (memory, cleared on browser restart, not exposed to content
  scripts — `setAccessLevel(TRUSTED_CONTEXTS)`) and dropped on lock/idle/screen lock.
* **What is on disk** (`storage.local`): server URL, the revocable device-session token, user display info,
  pinned fingerprints, settings, vault KDF parameters + wrapped key, and the **encrypted** sync payload (for
  offline listing). "Never save" sites are stored as SHA-256 hashes. A 401 from the server (revoked device)
  wipes account data and the cache. Log out revokes the token server-side.
* **Unlock hardening.** Refuses KDFs other than `pbkdf2-sha256`, iteration counts outside
  [600 000, 10 000 000] and salts outside 16–64 bytes before deriving, so a malicious server cannot downgrade
  the KDF. Item/folder ids must be lowercase UUIDs and are bound into the AES-GCM AAD, so ciphertexts cannot be
  swapped between records; undecryptable records are hidden and counted.
* **Network.** `fetch` with `credentials: 'omit'`, `redirect: 'error'`, `cache: 'no-store'`,
  `referrerPolicy: 'no-referrer'`, Bearer auth only, 30 s timeouts. Extension CSP:
  `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src https: http://localhost:* http://127.0.0.1:*`.
* **TLS pinning.** *Firefox*: a blocking `webRequest.onHeadersReceived` listener (scoped to the server
  origin only) reads the presented certificate via `getSecurityInfo` and cancels any response whose SHA-256
  fingerprint differs from the pin. *Chrome*: extensions cannot read certificates, so the extension relies on
  the browser's certificate validation and compares the fingerprint the server reports in
  `/api/v1/setup/status` against the pin at sign-in, unlock and every sync — this detects certificate changes
  (e.g. renewals) but cannot stop an active man-in-the-middle that the browser already trusts. On both, once a
  mismatch is seen nothing authenticated is sent (no token, no ciphertext — log out wipes locally only) until
  you re-confirm a fingerprint.
* **Vault key changes elsewhere.** The session vault key is tied to the wrapped key it was unwrapped from.
  When another device changes the master password, or resets and re-creates the vault (a new vault key), the
  next sync or save locks the extension, so items are never encrypted under a key the other clients no longer
  use; unlock again with the current master password.
* **Permissions** (all justified, nothing broad at install time):
  `storage`, `unlimitedStorage` (large encrypted caches), `alarms` (auto-lock, clipboard timer), `idle`
  (lock on idle/screen lock), `activeTab` + `scripting` (inject the filler only into the tab you act on),
  `clipboardWrite` (clearing), Chrome `offscreen` (clipboard clearing from a service worker), Firefox
  `webRequest` + `webRequestBlocking` (certificate pinning, effective only for the granted server origin).
  Optional host permissions: `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*` — the server origin is
  requested at sign-in; all three only when you enable "Offer to save". No `tabs`, no `<all_urls>`, no static
  content scripts, no web-accessible resources (pages cannot fingerprint the extension).
* **Messaging.** Every message is schema-validated (types, lengths, no unknown fields). Popup messages are
  accepted only from this extension's own pages; content-script messages only from the top frame of the
  active tab and only the three `capture.*` types; the page URL/tab are taken from the browser-supplied
  sender, never from the message. No `onMessageExternal`.
* **Autofill.** The filler is injected on demand into the top frame and re-checks origin, HTTPS and the item's
  URI rules inside the page right before filling (so a navigation in between cannot redirect credentials).
  Only visible, enabled, non-readonly fields are filled (display/visibility/opacity/size/off-page checks on
  the element and its ancestors); same-origin iframes only; forms posting to plain HTTP are refused.
* **Save prompt.** Rendered in a closed shadow root with CSSOM styles (no inline `<style>`, CSP-safe); buttons
  ignore untrusted (script-generated) clicks; only user-initiated (`isTrusted`) submissions are captured.
* **No `innerHTML`, `eval`, `new Function`, remote scripts or inline handlers** anywhere — enforced by the
  build's output scan and a lint test.

### Known limitations

* Chrome cannot pin certificates (see above). Firefox pinning relies on `webRequest` seeing the extension's own
  background requests; Settings shows whether a verification has been observed.
* The clipboard is cleared unconditionally after 30 s (we deliberately do not request `clipboardRead` to check
  whether it still holds our value); if the browser closes first the value remains on the OS clipboard.
  Chrome's alarm granularity is ≥ 30 s.
* Fields inside cross-origin iframes (e.g. some embedded SSO widgets) are never filled — use Copy.
* Vault creation, master-password change, folder management and KeePass/Bitwarden import/export live in the
  Ludworks web app; the extension links there.
* In Firefox the permission prompt may close the popup; reopen it and click Sign in again (the address and
  username are remembered, the password is not).

## Contract interpretations

Where the contracts left room, the most secure simple reading was chosen:

* `starts_with` URI rules additionally require the same origin as the item URI, so `https://bank.com` never
  matches `https://bank.com.evil.net/` (the canonical web matcher compares raw strings only).
* Pinning uses the TLS-observed fingerprint on Firefox and the server-reported `tls_fingerprint_sha256` on
  Chrome; a pinned server that suddenly reports no fingerprint is treated as changed.
* "Offer to save" requests `https://*/*` (+ localhost) instead of `<all_urls>` — nothing on plain HTTP is ever
  captured, so the narrower grant suffices.
* The passphrase word list is this repo's own (3 321 words); the shared determinism vectors are reproduced by
  passing the canonical web word list to the same algorithm.

## Repository layout

```
build.mjs                 build both browsers, validate, scan, zip
src/manifest.base.json    shared manifest; manifest.chrome.json / manifest.firefox.json overrides
src/lib/                  vault-crypto, totp, generator (+ wordlist), url-match, api, field-detect,
                          messages (schemas + sender checks), item-model, fingerprint, errors, browser shim
src/background/           main (wiring), core (state/auth/vault/sync/CRUD/capture), handlers (routing),
                          autofill, capture (registration), clipboard, certpin (Firefox)
src/content/              fill.js (on-demand filler), capture.js (offer to save) — bundled to classic scripts
src/popup/                popup.html/css/js, ui.js, rpc.js, views/ (auth, vault, edit, generator, settings)
src/offscreen/            Chrome-only clipboard helper
src/icons/                generated PNG icons (committed)
scripts/                  make-icons, lib/ (zip, png, crc32, bundle, manifest), vectors/ (Python), dev/ (preview)
tests/                    node:test suites, fixtures, fakes (mock server, fake DOM)
```

## License

Proprietary — Copyright (c) 2026 Ludworks. All rights reserved. See [LICENSE](LICENSE).
