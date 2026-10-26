#!/usr/bin/env python3
"""Independent reference for Ludworks vault crypto v1 (VAULT-CRYPTO.md), using the `cryptography` package.

  generate : print deterministic known-answer vectors (fixed salt / keys / nonces) as JSON.
             Output is committed as tests/fixtures/crypto-vectors.json and must be reproduced by
             src/lib/vault-crypto.js and src/lib/totp.js.
  verify   : read JSON produced by the JavaScript implementation on stdin (random nonces/salts) and
             check every value with Python. Exit status 0 = all good.

Run with `python3 -I` (isolated mode).
"""
import base64
import hashlib
import hmac
import json
import struct
import sys
import unicodedata

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

AAD_KEY = "ludworks/vault/key/v1"
AAD_ITEM = "ludworks/vault/item/v1:"
AAD_FOLDER = "ludworks/vault/folder/v1:"
HKDF_INFO = b"ludworks/vault/wrap/v1"


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def unb64(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"), validate=True)


def master_key(password: str, salt: bytes, iterations: int) -> bytes:
    pw = unicodedata.normalize("NFC", password).encode("utf-8")
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations)
    return kdf.derive(pw)


def wrap_key(mk: bytes) -> bytes:
    # salt=None == RFC 5869 default (HashLen zero bytes) == WebCrypto empty salt
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=HKDF_INFO).derive(mk)


def seal(key: bytes, nonce: bytes, plaintext: bytes, aad: str) -> str:
    ct = AESGCM(key).encrypt(nonce, plaintext, aad.encode("utf-8"))
    return "v1." + b64(nonce) + "." + b64(ct)


def open_sealed(key: bytes, sealed: str, aad: str) -> bytes:
    version, nonce_b64, ct_b64 = sealed.split(".")
    if version != "v1":
        raise ValueError("bad version")
    return AESGCM(key).decrypt(unb64(nonce_b64), unb64(ct_b64), aad.encode("utf-8"))


def totp(secret: bytes, t: int, algorithm: str = "SHA1", digits: int = 6, period: int = 30) -> str:
    counter = t // period
    digest = {"SHA1": hashlib.sha1, "SHA256": hashlib.sha256, "SHA512": hashlib.sha512}[algorithm]
    mac = hmac.new(secret, struct.pack(">Q", counter), digest).digest()
    off = mac[-1] & 0x0F
    code = (struct.unpack(">I", mac[off:off + 4])[0] & 0x7FFFFFFF) % (10 ** digits)
    return str(code).zfill(digits)


def b32(data: bytes) -> str:
    return base64.b32encode(data).decode("ascii").rstrip("=")


def generate() -> dict:
    kdf_cases = [
        {"name": "ascii-600k", "password": "correct horse battery staple", "salt": bytes(range(16)),
         "iterations": 600000, "vault_key": bytes(range(32, 64)), "nonce": bytes(range(100, 112))},
        {"name": "unicode-nfc-600k", "password": "pässwörd ñ \U0001F511 café",
         "salt": bytes(range(200, 216)), "iterations": 600000, "vault_key": bytes(range(64, 96)),
         "nonce": bytes(range(1, 13))},
    ]
    out_kdf = []
    for c in kdf_cases:
        mk = master_key(c["password"], c["salt"], c["iterations"])
        wk = wrap_key(mk)
        out_kdf.append({
            "name": c["name"],
            "password": c["password"],
            "kdf": "pbkdf2-sha256",
            "kdf_salt": b64(c["salt"]),
            "kdf_iterations": c["iterations"],
            "master_key": b64(mk),
            "wrap_key": b64(wk),
            "vault_key": b64(c["vault_key"]),
            "wrap_nonce": b64(c["nonce"]),
            "wrapped_key": seal(wk, c["nonce"], c["vault_key"], AAD_KEY),
        })

    vk = kdf_cases[0]["vault_key"]
    item_objs = [
        ("3b241101-e2bb-4255-8caf-4136c566a962", {
            "type": "login", "name": "GitHub", "favorite": True, "notes": "work account — café",
            "login": {"username": "me@example.com", "password": "hunter2!é",
                      "uris": [{"uri": "https://github.com/login", "match": "domain"}],
                      "totp": "otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"},
            "x_future_field": {"keep": [1, 2, 3]},
            "created_at": "2026-10-26T12:00:00Z", "updated_at": "2026-10-26T12:00:00Z"}),
        ("8f0c2a4e-1d3b-4c5a-9e6f-7a8b9c0d1e2f", {
            "type": "note", "name": "Wi-Fi", "notes": "SSID: home\nKey: \U0001F510 secret", "favorite": False}),
    ]
    items = []
    for i, (item_id, obj) in enumerate(item_objs):
        pt = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
        nonce = bytes(range(20 + i, 32 + i))
        items.append({"id": item_id, "plaintext_json": pt, "nonce": b64(nonce),
                      "data": seal(vk, nonce, pt.encode("utf-8"), AAD_ITEM + item_id)})

    folders = []
    for i, (fid, name) in enumerate([("a1b2c3d4-0000-4000-8000-000000000001", "Work / Équipe")]):
        pt = json.dumps({"name": name}, separators=(",", ":"), ensure_ascii=False)
        nonce = bytes(range(40 + i, 52 + i))
        folders.append({"id": fid, "name": name, "plaintext_json": pt, "nonce": b64(nonce),
                        "sealed": seal(vk, nonce, pt.encode("utf-8"), AAD_FOLDER + fid)})

    totp_cases = []
    secret = base64.b32decode("JBSWY3DPEHPK3PXP")
    for t in (0, 59, 1111111109, 1234567890, 2000000000, 1761480000):
        totp_cases.append({"uri": "JBSWY3DPEHPK3PXP", "time": t, "code": totp(secret, t)})
    s256 = bytes(range(1, 33))
    for t in (59, 1700000000):
        totp_cases.append({"uri": f"otpauth://totp/Ex:me?secret={b32(s256)}&algorithm=SHA256&digits=8&period=60",
                           "time": t, "code": totp(s256, t, "SHA256", 8, 60)})
    s512 = bytes(range(64))
    totp_cases.append({"uri": f"otpauth://totp/Ex:me?secret={b32(s512).lower()}&algorithm=SHA512&digits=7",
                       "time": 1234567890, "code": totp(s512, 1234567890, "SHA512", 7, 30)})

    return {"generator": "ludworks-browser/scripts/vectors/make_vectors.py (python cryptography)",
            "kdf": out_kdf, "vault_key": b64(vk), "items": items, "folders": folders, "totp": totp_cases}


def verify(doc: dict) -> list:
    errors = []
    for c in doc.get("kdf", []):
        mk = master_key(c["password"], unb64(c["kdf_salt"]), c["kdf_iterations"])
        if b64(mk) != c["master_key"]:
            errors.append(f"kdf {c.get('name')}: master_key mismatch")
        wk = wrap_key(mk)
        if b64(wk) != c["wrap_key"]:
            errors.append(f"kdf {c.get('name')}: wrap_key mismatch")
        if "wrapped_key" in c:
            try:
                vk = open_sealed(wk, c["wrapped_key"], AAD_KEY)
                if b64(vk) != c["vault_key"]:
                    errors.append(f"kdf {c.get('name')}: unwrapped vault key mismatch")
            except Exception as e:  # noqa: BLE001
                errors.append(f"kdf {c.get('name')}: cannot open wrapped key: {e}")
    for s in doc.get("sealed", []):
        try:
            pt = open_sealed(unb64(s["key"]), s["sealed"], s["aad"])
            if b64(pt) != s["plaintext"]:
                errors.append(f"sealed {s.get('name')}: plaintext mismatch")
        except Exception as e:  # noqa: BLE001
            errors.append(f"sealed {s.get('name')}: {e}")
    return errors


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "generate"
    if mode == "generate":
        json.dump(generate(), sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0
    if mode == "verify":
        errors = verify(json.load(sys.stdin))
        for e in errors:
            print(e, file=sys.stderr)
        print(json.dumps({"ok": not errors, "errors": errors}))
        return 0 if not errors else 1
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
