"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function assertTokens(source, tokens, label) {
  for (const token of tokens) {
    assert.ok(source.includes(token), `${label} is missing ${token}`);
  }
}

function numericConstant(source, name) {
  const match = new RegExp(`\\bconst\\s+${name}\\s*=\\s*([0-9*\\s]+);`).exec(source);
  assert.ok(match, `numeric constant ${name} is missing`);
  const factors = match[1].split("*").map((value) => value.trim()).filter(Boolean);
  assert.ok(factors.length > 0 && factors.every((value) => /^\d+$/.test(value)), `${name} must be a numeric product`);
  return factors.reduce((value, factor) => value * Number(factor), 1);
}

function functionSource(source, name) {
  const signature = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(signature, `function ${name} is missing`);
  const openingBrace = source.indexOf("{", signature.index + signature[0].length);
  assert.notEqual(openingBrace, -1, `function ${name} has no body`);

  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(signature.index, index + 1);
    }
  }
  assert.fail(`function ${name} has an unterminated body`);
}

function assertOrdered(source, patterns, label) {
  let cursor = 0;
  for (const pattern of patterns) {
    const flags = pattern.flags.replace(/g/g, "");
    const match = new RegExp(pattern.source, flags).exec(source.slice(cursor));
    assert.ok(match, `${label} is missing ordered step ${pattern}`);
    cursor += match.index + match[0].length;
  }
}

function assertAdaptiveProfile(source, chunkKiB, bufferMiB, ackMiB, label) {
  const profile = new RegExp(
    `chunkSize\\s*:\\s*${chunkKiB}\\s*\\*\\s*1024`
      + `[\\s\\S]{0,180}bufferHighWaterMark\\s*:\\s*${bufferMiB}\\s*\\*\\s*1024\\s*\\*\\s*1024`
      + `[\\s\\S]{0,180}ackWindowBytes\\s*:\\s*${ackMiB}\\s*\\*\\s*1024\\s*\\*\\s*1024`
  );
  assert.match(source, profile, `${label} adaptive profile ${chunkKiB} KiB/${bufferMiB} MiB/${ackMiB} MiB is missing`);
}

function assertFastTransferRuntime(source, label) {
  assertTokens(source, [
    "navigator.deviceMemory",
    "DEVICE_TRANSFER_PROFILE",
    "BUFFER_HIGH_WATER_MARK",
    "DEFAULT_ACK_WINDOW_BYTES",
    "SPEED_SAMPLE_WINDOW_MS",
    "DATA_CHANNEL_STALL_TIMEOUT_MS",
    "featuresReady",
    "negotiatedFeatures",
    "binaryEnvelope",
    "aeadChunkIntegrity",
    "receiverReady",
    "file-ready",
    "file-ack",
    "maxInFlightBytes",
    "createFileHasher",
    "expectedFileHash",
    "bufferedamountlow",
    "bufferedAmountLowThreshold",
    "connection.bufferSize",
    "waitForFinalAcknowledgement",
  ], label);

  assertAdaptiveProfile(source, 512, 8, 32, label);
  assertAdaptiveProfile(source, 256, 4, 16, label);
  assertAdaptiveProfile(source, 128, 2, 8, label);
  assert.equal(numericConstant(source, "MEMORY_RECEIVE_LIMIT_BYTES"), 32 * 1024 * 1024, `${label} memory threshold changed`);
  assert.equal(numericConstant(source, "SPEED_SAMPLE_WINDOW_MS"), 1500, `${label} speed window must be 1.5 seconds`);
  assert.equal(numericConstant(source, "DATA_CHANNEL_STALL_TIMEOUT_MS"), 15000, `${label} stall timeout must be 15 seconds`);
  assert.equal(numericConstant(source, "DIRECT_CHUNK_LIMIT_BYTES"), 256 * 1024, `${label} direct chunks must be capped at 256 KiB`);
  assert.equal(numericConstant(source, "RELAY_CHUNK_LIMIT_BYTES"), 128 * 1024, `${label} relay chunks must be capped at 128 KiB`);
  assert.ok(numericConstant(source, "FILE_COMPLETE_MAX_ATTEMPTS") >= 30, `${label} completion probes end too early`);

  const sendTransfer = functionSource(source, "sendTransfer");
  assertOrdered(sendTransfer, [
    /featuresReady|waitForTransportFeatures/,
    /type\s*:\s*["']file-meta["']/,
    /receiverReadyPromise|waitForReceiverReady/,
    /nextChunkPromise/,
    /waitForAckWindow/,
    /waitForDataChannel/,
    /type\s*:\s*["']file-chunk["']/,
    /fileHasher\.digest\s*\(/,
    /waitForFinalAcknowledgement/,
    /type\s*:\s*["']file-done["']/,
  ], `${label} send pipeline`);
  assert.match(
    sendTransfer,
    /nextChunkPromise\s*=\s*[^;]+0[\s\S]+arrayBuffer\s*=\s*await\s+nextChunkPromise[\s\S]+nextChunkPromise\s*=/,
    `${label} must prefetch one file chunk`
  );
  assert.match(
    sendTransfer,
    /aeadChunkIntegrity\s*\?\s*null\s*:\s*await\s+createChunkHash/,
    `${label} must omit duplicate per-chunk hashing on the AEAD path`
  );
  assert.match(sendTransfer, /fileHasher\.update\s*\(arrayBuffer\)/, `${label} must retain incremental full-file hashing`);

  const ackWindow = functionSource(source, "waitForAckWindow");
  assert.match(
    ackWindow,
    /sentBytes\s*-\s*transfer\.lastAckBytes\s*\+\s*[A-Za-z_$][\w$]*\s*>\s*[A-Za-z_$][\w$]*/,
    `${label} sender must cap unacknowledged bytes`
  );
  assert.match(ackWindow, /maxInFlightBytes/, `${label} ACK window must use the negotiated byte limit`);
  assert.match(ackWindow, /DATA_CHANNEL_STALL_TIMEOUT_MS/, `${label} ACK wait must have a stall timeout`);

  const ackScheduler = functionSource(source, "scheduleFileAck");
  assert.match(ackScheduler, /receivedBytes\s*:\s*transfer\.receivedBytes/, `${label} ACK must report received bytes`);
  assert.match(ackScheduler, /ACK_BATCH_SIZE/, `${label} ACKs must be batched by count`);
  assert.match(ackScheduler, /ACK_MAX_DELAY/, `${label} ACKs must be batched by time`);

  assert.match(source, /type\s*:\s*["']file-ready["'][\s\S]{0,220}accepted\s*:\s*true[\s\S]{0,220}maxInFlightBytes/, `${label} must acknowledge receiver readiness with a byte window`);
  assert.match(source, /type\s*:\s*["']file-ready["'][\s\S]{0,220}accepted\s*:\s*false[\s\S]{0,220}error/, `${label} must reject files when storage preparation fails`);
  assert.match(source, /waitForBufferedQueueChange/, `${label} backpressure needs an event and polling fallback`);
  assert.match(functionSource(source, "getConnectionBufferedBytes"), /connection\s*&&\s*connection\.bufferSize/, `${label} must observe the PeerJS internal queue`);
  assertTokens(functionSource(source, "getConnectionChunkSize"), [
    "DIRECT_CHUNK_LIMIT_BYTES",
    "RELAY_CHUNK_LIMIT_BYTES",
  ], `${label} conservative chunk negotiation`);
  assert.match(functionSource(source, "markOutgoingAcknowledged"), /maybeUpdateTransferProgress[\s\S]+lastAckBytes/, `${label} progress must follow receiver acknowledgements`);
  assert.match(source, /actualFileHash[\s\S]{0,160}expectedFileHash/, `${label} must compare the complete file digest before completion`);
  assert.match(source, /完整文件|SHA-256/, `${label} must expose full-file verification failures`);
}

function compactCss(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\s+/g, " ");
}

const manifest = JSON.parse(read("manifest.json"));
const background = read("background.js");
const transfer = read("lan-transfer/transfer.js");
const transferHtml = read("lan-transfer/index.html");
const transferCss = read("lan-transfer/transfer.css");
const secureSource = read("lan-transfer/secure-channel-source.js");
const secureBundle = read("lan-transfer/secure-channel.js");
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

assertTokens(secureSource, [
  "wo-v2-features",
  "wo-v2-secure-bin",
  "binaryEnvelope",
  "aeadChunkIntegrity",
  "receiverReady",
  "featuresReady",
  "negotiatedFeatures",
  "supportsBinaryEnvelope",
  "ArrayBuffer.isView(message.ciphertext)",
], "secure channel source");
assert.equal(numericConstant(secureSource, "FEATURES_TIMEOUT_MS"), 300, "feature negotiation timeout must remain 300 ms");
assert.match(
  secureSource,
  /FALLBACK_FEATURES\s*=\s*Object\.freeze\s*\(\s*\{[\s\S]{0,220}binaryEnvelope\s*:\s*false[\s\S]{0,120}aeadChunkIntegrity\s*:\s*false[\s\S]{0,120}receiverReady\s*:\s*false/,
  "feature timeout must return the compatible Base64 profile"
);
assert.match(
  functionSource(secureSource, "startFeatureNegotiation"),
  /sendEncrypted\s*\(\s*\{\s*type\s*:\s*["']wo-v2-features["'][\s\S]{0,100}\}\s*,\s*true\s*\)/,
  "feature offers must use the Base64-compatible secure envelope"
);
assert.match(functionSource(secureSource, "sendEncrypted"), /type\s*:\s*["']wo-v2-secure-bin["']/, "negotiated sends must support binary envelopes");
assert.match(functionSource(secureSource, "handle"), /sequence[\s\S]+receiveSequence/, "binary and text envelopes must share replay protection");
assertTokens(secureBundle, ["wo-v2-features", "wo-v2-secure-bin", "featuresReady", "negotiatedFeatures"], "built secure channel");

assert.match(transfer, /CONFIG_STORAGE_KEY\s*=\s*["']woLanTransferConfigV2["']/, "LAN settings must use the v2 key");
assert.match(transfer, /LEGACY_CONFIG_STORAGE_KEY\s*=\s*["']woLanTransferConfig["']/, "legacy settings must be migrated");
assert.match(transfer, /legacyPreferredMode\s*=\s*loadStoredLanMode\(\)/, "legacy mode preference must survive migration");
assert.match(transfer, /verifyPagesClient/, "Pages URLs must be verified before use");
assert.match(transfer, /remoteConsentAt/, "online signaling requires durable consent metadata");
assert.match(transfer, /allowLegacyProtocol/, "legacy protocol support must be explicit");
assert.match(transfer, /supportsBinaryEnvelope\s*:\s*false/, "JSON/native relays must stay on the compatible text envelope");
assert.match(transfer, /supportsBinaryEnvelope\s*:\s*[A-Za-z_$][\w$]*\.supportsBinaryEnvelope\s*!==\s*false/, "desktop peer connections must offer binary envelopes");
assertFastTransferRuntime(transfer, "desktop runtime");
assert.equal(numericConstant(transfer, "MAX_RECEIVE_WRITE_QUEUE_BYTES"), 64 * 1024 * 1024, "desktop receive queue must be capped at 64 MiB");

assertTokens(transfer, [
  "showDirectoryPicker",
  "chooseReceiveFolder",
  "receiveFolderStatus",
  "queryPermission",
  "putTransferSetting",
  "createReceiveSink",
  "createMemoryReceiveSink",
  "createIndexedDbReceiveSink",
  "createDirectoryReceiveSink",
  "createOpfsReceiveSink",
  "createFileSystemReceiveSink",
  "navigator.storage.getDirectory",
  "discardReceiveSink",
  "resetReceiveSink",
  "activeReceiveSinks",
  "QuotaExceededError",
], "desktop receive storage");
assertOrdered(functionSource(transfer, "createReceiveSink"), [
  /createDirectoryReceiveSink/,
  /MEMORY_RECEIVE_LIMIT_BYTES/,
  /createMemoryReceiveSink/,
  /createOpfsReceiveSink/,
  /createIndexedDbReceiveSink/,
], "desktop receive storage fallback");
assert.match(functionSource(transfer, "receiveChunk"), /isStorageWriteError[\s\S]+discardReceiveSink[\s\S]+accepted\s*:\s*false/, "desktop storage failures must cancel and remove partial data");
assert.match(functionSource(transfer, "cleanupRuntime"), /activeReceiveSinks[\s\S]+discard/, "desktop shutdown must discard unfinished receive sinks");
assert.match(transferHtml, /id=["']chooseReceiveFolder["']/, "desktop toolbar needs a save-folder control");
assert.match(transferHtml, /id=["']receiveFolderStatus["']/, "desktop toolbar needs folder permission status");

assert.match(mobile, /SIGNAL_SERVERS\[normalizedAttempt\s*%\s*SIGNAL_SERVERS\.length\]/, "mobile signaling must rotate configured servers");
assert.match(mobile, /params\.get\(["']s["']\)\s*\|\|\s*params\.get\(["']session["']\)/, "mobile launch parser must support v2 and compatibility session keys");
assert.match(mobile, /supportsBinaryEnvelope\s*:\s*false/, "mobile JSON relay must identify itself as text-only");
assert.match(mobile, /supportsBinaryEnvelope\s*:\s*connection\.supportsBinaryEnvelope\s*!==\s*false\s*&&\s*!LOCAL_RELAY_URL/, "mobile must disable binary envelopes for the JSON relay");
assertFastTransferRuntime(mobile, "mobile runtime");
assertTokens(mobile, [
  "createReceiveStore",
  "createMemoryReceiveStore",
  "createOpfsReceiveStore",
  "createIndexedDbReceiveStore",
  "navigator.storage.estimate",
  "navigator.storage.getDirectory",
  "disposeReceiveStore",
  "activeReceiveStores",
  "writable.abort",
  "removeEntry",
  "addFileSaveButton",
  "保存文件",
], "mobile receive storage");
assertOrdered(functionSource(mobile, "createReceiveStore"), [
  /MEMORY_RECEIVE_LIMIT_BYTES/,
  /createMemoryReceiveStore/,
  /createOpfsReceiveStore/,
  /createIndexedDbReceiveStore/,
], "mobile receive storage fallback");
assert.match(functionSource(mobile, "receiveChunk"), /isReceiveStorageFailure[\s\S]+accepted\s*:\s*false[\s\S]+disposeReceiveStore/, "mobile storage failures must stop the sender and clear partial data");
assert.match(functionSource(mobile, "finalizeIncomingTransfer"), /addFileSaveButton/, "mobile receives must retain an explicit save action");
assert.match(functionSource(mobile, "cleanupRuntime"), /activeReceiveStores[\s\S]+clear/, "mobile shutdown must clear unfinished receive stores");

assert.match(mobileTemplate, /name="web-omni-lan-client"\s+content="v2"/, "Pages verification marker is missing");
assert.match(mobileTemplate, /Content-Security-Policy/, "mobile page requires a CSP");
assert.match(mobileTemplate, /name="referrer"\s+content="no-referrer"/, "mobile page must suppress referrers");

const desktopCss = compactCss(transferCss);
const mobileCss = compactCss(mobileTemplate);
for (const [css, label] of [[desktopCss, "desktop UI"], [mobileCss, "mobile UI"]]) {
  assert.match(css, /\.conversation-item[^{}]*\{[^{}]*animation[^{}]*380ms/, `${label} messages need a 380 ms entrance`);
  assert.match(css, /(?:translateX\(\s*-6px\s*\)|--message-enter-x\s*:\s*-6px)/, `${label} incoming messages need a directional entrance`);
  assert.match(css, /(?:translateX\(\s*6px\s*\)|--message-enter-x\s*:\s*6px)/, `${label} outgoing messages need a directional entrance`);
  assert.match(css, /translateX\([^)]*\)[^{}]*scale\(\s*\.994\s*\)/, `${label} message entrance scale is missing`);
  assert.match(css, /filter\s*:\s*blur\(\s*\.8px\s*\)/, `${label} message blur is missing`);
  assert.match(css, /\.file-progress-bar[^{}]*\{[^{}]*transition[^{}]*width\s+320ms/, `${label} progress transitions must be interruptible and 320 ms`);
  assert.match(css, /\.file-progress-bar[^{}]*\{[^{}]*background[^{}]*transition[^{}]*(?:background|background-color)[^{}]*(?:360ms|380ms|420ms)/, `${label} progress states need a soft color transition`);
  assert.match(css, /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/, `${label} must honor reduced motion`);
}
assert.match(desktopCss, /border-radius\s*:\s*3px\s+8px\s+8px\s+8px/, "desktop incoming bubble corner is missing");
assert.match(desktopCss, /border-radius\s*:\s*8px\s+3px\s+8px\s+8px/, "desktop outgoing bubble corner is missing");
assert.match(mobileCss, /border-top-left-radius\s*:\s*3px/, "mobile incoming bubble corner is missing");
assert.match(mobileCss, /border-top-right-radius\s*:\s*3px/, "mobile outgoing bubble corner is missing");

assert.match(nativeMain, /hostName\s*=\s*"com\.webomni\.lan"/, "Go helper host name must match the extension");
assert.match(nativeMain, /selectBindAddress/, "Go helper must choose a private bind address");
assert.doesNotMatch(nativeMain, /0\.0\.0\.0:0/, "Go helper must not bind every interface");
assert.match(nativeInstall, /HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts/, "Chrome HKCU registration is missing");
assert.match(nativeInstall, /HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts/, "Edge HKCU registration is missing");
assert.match(nativeInstall, /-Profile Private/, "firewall access must be limited to Private networks");
assert.match(pagesWorkflow, /actions\/deploy-pages@v4/, "Pages deployment workflow is missing");

assert.equal(mobileDist, nativeWeb, "Pages and native helper mobile clients must come from the same build");
assertTokens(mobileDist, [
  "web-omni-lan-client",
  "createFileHasher",
  "wo-v2-features",
  "wo-v2-secure-bin",
  "file-ready",
  "DEVICE_TRANSFER_PROFILE",
  "addFileSaveButton",
], "generated mobile client");
const nativeExe = path.join(root, "native-host/web-omni-lan-helper.exe");
assert.ok(fs.statSync(nativeExe).size > 1024 * 1024, "Windows x64 native helper binary is missing");

console.log("LAN v2 contract passed: binary negotiation, adaptive flow control, streaming storage, full-file integrity, and chat motion are aligned.");
