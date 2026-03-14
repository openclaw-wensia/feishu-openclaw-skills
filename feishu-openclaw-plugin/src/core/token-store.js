/**
 * UAT (User Access Token) persistent storage with cross-platform support.
 *
 * Stores OAuth token data using OS-native credential services so that tokens
 * survive process restarts without introducing plain-text local files.
 *
 * Platform backends:
 *   macOS   – Keychain Access via `security` CLI
 *   Linux   – AES-256-GCM encrypted files (XDG_DATA_HOME)
 *   Windows – DPAPI-encrypted files in %LOCALAPPDATA%
 *
 * Storage layout:
 *   Service  = "openclaw-feishu-uat"
 *   Account  = "{appId}:{userOpenId}"
 *   Password = JSON-serialised StoredUAToken
 */
import { execFile as execFileCb, exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, unlink, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { trace } from "./trace.js";
const execFile = promisify(execFileCb);
const exec = promisify(execCb);
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const KEYCHAIN_SERVICE = "openclaw-feishu-uat";
/** Refresh proactively when access_token expires within this window. */
const REFRESH_AHEAD_MS = 5 * 60 * 1000; // 5 minutes
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function accountKey(appId, userOpenId) {
    return `${appId}:${userOpenId}`;
}
/** Mask a token for safe logging: only the last 4 chars are visible. */
export function maskToken(token) {
    if (token.length <= 8)
        return "****";
    return `****${token.slice(-4)}`;
}
// ---------------------------------------------------------------------------
// macOS backend – Keychain Access via `security` CLI
// ---------------------------------------------------------------------------
const darwinBackend = {
    async get(service, account) {
        try {
            const { stdout } = await execFile("security", [
                "find-generic-password",
                "-s", service,
                "-a", account,
                "-w",
            ]);
            return stdout.trim() || null;
        }
        catch {
            return null;
        }
    },
    async set(service, account, data) {
        // Delete first – `add-generic-password` fails if the item already exists.
        try {
            await execFile("security", [
                "delete-generic-password",
                "-s", service,
                "-a", account,
            ]);
        }
        catch {
            // Not found – fine.
        }
        await execFile("security", [
            "add-generic-password",
            "-s", service,
            "-a", account,
            "-w", data,
        ]);
    },
    async remove(service, account) {
        try {
            await execFile("security", [
                "delete-generic-password",
                "-s", service,
                "-a", account,
            ]);
        }
        catch {
            // Already absent – fine.
        }
    },
};
// ---------------------------------------------------------------------------
// Linux backend – AES-256-GCM encrypted files (XDG Base Directory)
//
// Headless Linux servers typically lack D-Bus / GNOME Keyring, so we store
// tokens as AES-256-GCM encrypted files instead of using `secret-tool`.
//
// Storage path: ${XDG_DATA_HOME:-~/.local/share}/openclaw-feishu-uat/
// ---------------------------------------------------------------------------
const LINUX_UAT_DIR = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "openclaw-feishu-uat");
const MASTER_KEY_PATH = join(LINUX_UAT_DIR, "master.key");
const MASTER_KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM recommended
const TAG_BYTES = 16; // GCM auth tag
/** Convert account key to a filesystem-safe filename. */
function linuxSafeFileName(account) {
    return account.replace(/[^a-zA-Z0-9._-]/g, "_") + ".enc";
}
/** Ensure the credentials directory exists with mode 0700. */
async function ensureLinuxCredDir() {
    await mkdir(LINUX_UAT_DIR, { recursive: true, mode: 0o700 });
}
/**
 * Load or create the 32-byte master key.
 *
 * On first run, generates a random key and writes it to disk (mode 0600).
 * On subsequent runs, reads the existing key file.
 */
async function getMasterKey() {
    try {
        const key = await readFile(MASTER_KEY_PATH);
        if (key.length === MASTER_KEY_BYTES)
            return key;
        trace.warn("token-store: master key has unexpected length, regenerating");
    }
    catch (err) {
        if (!(err instanceof Error) ||
            err.code !== "ENOENT") {
            trace.warn(`token-store: failed to read master key: ${err instanceof Error ? err.message : err}`);
        }
    }
    await ensureLinuxCredDir();
    const key = randomBytes(MASTER_KEY_BYTES);
    await writeFile(MASTER_KEY_PATH, key, { mode: 0o600 });
    await chmod(MASTER_KEY_PATH, 0o600);
    trace.info("token-store: generated new master key for encrypted file storage");
    return key;
}
/** AES-256-GCM encrypt. Returns [12-byte IV][16-byte tag][ciphertext]. */
function encryptData(plaintext, key) {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}
/** AES-256-GCM decrypt. Returns plaintext or `null` on failure. */
function decryptData(data, key) {
    if (data.length < IV_BYTES + TAG_BYTES)
        return null;
    try {
        const iv = data.subarray(0, IV_BYTES);
        const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
        const enc = data.subarray(IV_BYTES + TAG_BYTES);
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
    }
    catch {
        return null;
    }
}
const linuxBackend = {
    async get(_service, account) {
        try {
            const key = await getMasterKey();
            const data = await readFile(join(LINUX_UAT_DIR, linuxSafeFileName(account)));
            return decryptData(data, key);
        }
        catch {
            return null;
        }
    },
    async set(_service, account, data) {
        const key = await getMasterKey();
        await ensureLinuxCredDir();
        const filePath = join(LINUX_UAT_DIR, linuxSafeFileName(account));
        const encrypted = encryptData(data, key);
        await writeFile(filePath, encrypted, { mode: 0o600 });
        await chmod(filePath, 0o600);
    },
    async remove(_service, account) {
        try {
            await unlink(join(LINUX_UAT_DIR, linuxSafeFileName(account)));
        }
        catch {
            // Already absent – fine.
        }
    },
};
// ---------------------------------------------------------------------------
// Windows backend – DPAPI-encrypted files via PowerShell
//
// Windows Credential Manager has a 2560-byte limit on credential blobs,
// which token JSON can exceed.  DPAPI files provide OS-level encryption
// (bound to the current Windows user session) with no size limit.
//
// Storage path: %LOCALAPPDATA%\openclaw-feishu-uat\{key}.enc
// ---------------------------------------------------------------------------
function win32StorageDir() {
    const localAppData = process.env.LOCALAPPDATA ??
        join(process.env.USERPROFILE ?? "", "AppData", "Local");
    return join(localAppData, KEYCHAIN_SERVICE);
}
/** Convert account key to a safe filename (`:` is illegal on Windows). */
function win32FileName(account) {
    return account.replace(/:/g, "_") + ".enc";
}
const win32Backend = {
    async get(_service, account) {
        const filePath = join(win32StorageDir(), win32FileName(account));
        // PowerShell: read encrypted file → DPAPI decrypt → output UTF-8 string
        const psScript = `
      Add-Type -AssemblyName System.Security
      try {
        $enc = [IO.File]::ReadAllBytes('${filePath.replace(/'/g, "''")}')
        $bytes = [Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'CurrentUser')
        [Console]::OutputEncoding = [Text.Encoding]::UTF8
        [Console]::Write([Text.Encoding]::UTF8.GetString($bytes))
      } catch {
        # File not found or decryption failed
      }
    `.trim();
        try {
            const { stdout } = await exec(`powershell -NoProfile -NonInteractive -Command "${psScript.replace(/"/g, '\\"')}"`);
            return stdout || null;
        }
        catch {
            return null;
        }
    },
    async set(_service, account, data) {
        const dir = win32StorageDir();
        await mkdir(dir, { recursive: true });
        const filePath = join(dir, win32FileName(account));
        // PowerShell: DPAPI encrypt → write to file
        // Pass data via stdin to avoid command-line length limits and escaping issues.
        const psScript = `
      Add-Type -AssemblyName System.Security
      $input_data = [Console]::In.ReadToEnd()
      $bytes = [Text.Encoding]::UTF8.GetBytes($input_data)
      $enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
      [IO.File]::WriteAllBytes('${filePath.replace(/'/g, "''")}', $enc)
    `.trim();
        await new Promise((resolve, reject) => {
            const child = execCb(`powershell -NoProfile -NonInteractive -Command "${psScript.replace(/"/g, '\\"')}"`, (err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
            child.stdin.end(data);
        });
    },
    async remove(_service, account) {
        const filePath = join(win32StorageDir(), win32FileName(account));
        try {
            await unlink(filePath);
        }
        catch {
            // Already absent – fine.
        }
    },
};
// ---------------------------------------------------------------------------
// Platform selection
// ---------------------------------------------------------------------------
function createBackend() {
    switch (process.platform) {
        case "darwin":
            return darwinBackend;
        case "linux":
            return linuxBackend;
        case "win32":
            return win32Backend;
        default:
            trace.warn(`token-store: unsupported platform "${process.platform}", falling back to macOS backend`);
            return darwinBackend;
    }
}
const backend = createBackend();
// ---------------------------------------------------------------------------
// Public API – Credential operations
// ---------------------------------------------------------------------------
/**
 * Read the stored UAT for a given (appId, userOpenId) pair.
 * Returns `null` when no entry exists or the payload is unparseable.
 */
export async function getStoredToken(appId, userOpenId) {
    try {
        const json = await backend.get(KEYCHAIN_SERVICE, accountKey(appId, userOpenId));
        if (!json)
            return null;
        return JSON.parse(json);
    }
    catch {
        return null;
    }
}
/**
 * Persist a UAT using the platform credential store.
 *
 * Overwrites any existing entry for the same (appId, userOpenId).
 */
export async function setStoredToken(token) {
    const key = accountKey(token.appId, token.userOpenId);
    const payload = JSON.stringify(token);
    await backend.set(KEYCHAIN_SERVICE, key, payload);
    trace.info(`token-store: saved UAT for ${token.userOpenId} (at:${maskToken(token.accessToken)})`);
}
/**
 * Remove a stored UAT from the credential store.
 */
export async function removeStoredToken(appId, userOpenId) {
    await backend.remove(KEYCHAIN_SERVICE, accountKey(appId, userOpenId));
    trace.info(`token-store: removed UAT for ${userOpenId}`);
}
// ---------------------------------------------------------------------------
// Token validity check
// ---------------------------------------------------------------------------
/**
 * Determine the freshness of a stored token.
 *
 * - `"valid"`         – access_token is still good (expires > 5 min from now)
 * - `"needs_refresh"` – access_token expired/expiring but refresh_token is valid
 * - `"expired"`       – both tokens are expired; re-authorization required
 */
export function tokenStatus(token) {
    const now = Date.now();
    if (now < token.expiresAt - REFRESH_AHEAD_MS) {
        return "valid";
    }
    if (now < token.refreshExpiresAt) {
        return "needs_refresh";
    }
    return "expired";
}
//# sourceMappingURL=token-store.js.map