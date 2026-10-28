# Vendored: Ludworks web vault library

Verbatim copies of `ludworks-server/web/assets/js/lib/vault/` (commit 04694e4): Bitwarden JSON/CSV/password-protected
JSON, KeePass KDBX 3.1/4.x and KeePass XML import/export, Argon2 (pure JS — Electron's BoringSSL has no Argon2),
BLAKE2b, ChaCha20/Salsa20, TOTP. Ludworks Browser adds passkey mapping on top (`src/main/import/vault-io.js`);
these files are not edited here. Refresh them together with the server copy:

    node desktop/scripts/check-vendor.mjs          # compare with ../ludworks-server (fails on drift)
    node desktop/scripts/check-vendor.mjs --update # copy the server versions in
