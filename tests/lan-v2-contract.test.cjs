"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const manifest = JSON.parse(read("manifest.json"));
const background = read("background.js");
const transfer = read("lan-transfer/transfer.js");
const mobile = read("lan-transfer/mobile-runtime.template.js");
const mobileTemplate = read("lan-transfer/mobile-template.html");
const nativeMain = read("native-host/main.go");
const nativeInstall = read("native-host/install.ps1");
const pagesWorkflow = read(".github/workflows/lan-mobile-pages.yml");
const mobileDist = read("lan-mobile/dist/index.html");
const nativeWeb = read("native-host/web/index.html");

assert.ok(manifest.permissions.includes("nativeMessaging"), "LAN local mode requires nativeMessaging");
assert.ok(manifest.permissions.includes("webRequest"), "media capture requires webRequest");
assert.equal(manifest.permissions.includes("webRequestBlocking"), false, "blocking webRequest permission is forbidden");
assert.equal(manifest.permissions.includes("debugger"), false, "debugger permission is forbidden");

assert.match(background, /WO_LAN_NATIVE_HOST\s*=\s*["']com\.webomni\.lan["']/, "native host name must be fixed");
assert.match(background, /senderUrl\s*===\s*expectedUrl/, "native messages must be limited to the LAN page");
assert.match(background, /request\.type\s*===\s*["']WO_LAN_NATIVE_START["']/, "LAN page must be able to acquire the helper");
assert.match(background, /request\.type\s*===\s*["']WO_LAN_NATIVE_STOP["']/, "LAN page must release the helper");
assert.match(background, /woLanNativeIsPrivateHost/, "native endpoints must be restricted to private hosts");

assert.match(transfer, /CONFIG_STORAGE_KEY\s*=\s*["']woLanTransferConfigV2["']/, "LAN settings must use the v2 key");
assert.match(transfer, /LEGACY_CONFIG_STORAGE_KEY\s*=\s*["']woLanTransferConfig["']/, "legacy settings must be migrated");
assert.match(transfer, /legacyPreferredMode\s*=\s*loadStoredLanMode\(\)/, "legacy mode preference must survive migration");
assert.match(transfer, /verifyPagesClient/, "Pages URLs must be verified before use");
assert.match(transfer, /remoteConsentAt/, "online signaling requires durable consent metadata");
assert.match(transfer, /allowLegacyProtocol/, "legacy protocol support must be explicit");
assert.match(transfer, /createFileHasher/, "desktop transfers must stream a complete file digest");
assert.match(transfer, /transfer\.expectedFileHash/, "desktop receives must verify the complete digest");
assert.match(transfer, /transfer\.chunkSize/, "desktop transfers must use negotiated chunk sizes");

assert.match(mobile, /SIGNAL_SERVERS\[normalizedAttempt\s*%\s*SIGNAL_SERVERS\.length\]/, "mobile signaling must rotate configured servers");
assert.match(mobile, /createFileHasher/, "mobile transfers must stream a complete file digest");
assert.match(mobile, /transfer\.expectedFileHash/, "mobile receives must verify the complete digest");
assert.match(mobile, /params\.get\(["']s["']\)\s*\|\|\s*params\.get\(["']session["']\)/, "mobile launch parser must support v2 and compatibility session keys");
assert.match(mobileTemplate, /name="web-omni-lan-client"\s+content="v2"/, "Pages verification marker is missing");
assert.match(mobileTemplate, /Content-Security-Policy/, "mobile page requires a CSP");
assert.match(mobileTemplate, /name="referrer"\s+content="no-referrer"/, "mobile page must suppress referrers");

assert.match(nativeMain, /hostName\s*=\s*"com\.webomni\.lan"/, "Go helper host name must match the extension");
assert.match(nativeMain, /selectBindAddress/, "Go helper must choose a private bind address");
assert.doesNotMatch(nativeMain, /0\.0\.0\.0:0/, "Go helper must not bind every interface");
assert.match(nativeInstall, /HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts/, "Chrome HKCU registration is missing");
assert.match(nativeInstall, /HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts/, "Edge HKCU registration is missing");
assert.match(nativeInstall, /-Profile Private/, "firewall access must be limited to Private networks");
assert.match(pagesWorkflow, /actions\/deploy-pages@v4/, "Pages deployment workflow is missing");

assert.equal(mobileDist, nativeWeb, "Pages and native helper mobile clients must come from the same build");
assert.match(mobileDist, /web-omni-lan-client/, "generated mobile page is stale");
assert.match(mobileDist, /createFileHasher/, "generated mobile page lacks full-file SHA-256 support");
const nativeExe = path.join(root, "native-host/web-omni-lan-helper.exe");
assert.ok(fs.statSync(nativeExe).size > 1024 * 1024, "Windows x64 native helper binary is missing");

console.log("LAN v2 contract passed: consent, private native bridge, E2E runtime, and generated clients are aligned.");
