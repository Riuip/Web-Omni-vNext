"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function functionSource(source, name) {
  const signature = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(signature, `function ${name} is missing`);
  const openingBrace = source.indexOf("{", signature.index + signature[0].length);
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
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
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
    if (character === "}" && --depth === 0) return source.slice(signature.index, index + 1);
  }
  assert.fail(`function ${name} has an unterminated body`);
}

function buildFlowRuntime(source, stallTimeout = 500) {
  const functions = [
    "getConnectionChunkSize",
    "getConnectionBufferedBytes",
    "waitForBufferedQueueChange",
    "waitForDataChannel",
  ].map((name) => functionSource(source, name)).join("\n");
  return new Function("options", `
    const CHUNK_SIZE = options.chunkSize;
    const DIRECT_CHUNK_LIMIT_BYTES = options.directLimit;
    const RELAY_CHUNK_LIMIT_BYTES = options.relayLimit;
    const PEERJS_BUFFERED_CHUNK_BYTES = options.peerChunkBytes;
    const BUFFER_POLL_INTERVAL_MS = options.pollInterval;
    const BUFFER_HIGH_WATER_MARK = options.highWaterMark;
    const DATA_CHANNEL_STALL_TIMEOUT_MS = options.stallTimeout;
    let activeChunkSize = options.activeChunkSize;
    const isUsableConnection = options.isUsableConnection;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    ${functions}
    return { getConnectionChunkSize, getConnectionBufferedBytes, waitForDataChannel };
  `)({
    chunkSize: 512 * 1024,
    directLimit: 256 * 1024,
    relayLimit: 128 * 1024,
    peerChunkBytes: 17 * 1024,
    pollInterval: 10,
    highWaterMark: 8 * 1024 * 1024,
    stallTimeout,
    activeChunkSize: 256 * 1024,
    isUsableConnection: (connection) => Boolean(connection && connection.open),
  });
}

class FakeDataChannel extends EventTarget {
  constructor() {
    super();
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
  }

  setBufferedAmount(value) {
    const previous = this.bufferedAmount;
    this.bufferedAmount = Math.max(0, value);
    if (previous > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
      this.dispatchEvent(new Event("bufferedamountlow"));
    }
  }
}

async function exerciseRuntime(source, label) {
  const runtime = buildFlowRuntime(source);
  assert.equal(runtime.getConnectionChunkSize({ supportsBinaryEnvelope: false }), 128 * 1024, `${label} relay chunk limit`);
  assert.equal(runtime.getConnectionChunkSize({}), 256 * 1024, `${label} direct chunk limit`);
  const sctpChunk = runtime.getConnectionChunkSize({ peerConnection: { sctp: { maxMessageSize: 256 * 1024 } } });
  assert.equal(sctpChunk, 224 * 1024, `${label} SCTP-aware chunk limit`);
  assert.equal(
    runtime.getConnectionChunkSize({ peerConnection: { sctp: { maxMessageSize: 64 * 1024 } } }),
    64 * 1024,
    `${label} low SCTP limit`
  );

  const channel = new FakeDataChannel();
  const connection = { open: true, bufferSize: 0, dataChannel: channel };
  channel.setBufferedAmount(1024 * 1024);
  connection.bufferSize = 100;
  assert.equal(
    runtime.getConnectionBufferedBytes(connection, channel),
    1024 * 1024 + 100 * 17 * 1024,
    `${label} must include the PeerJS internal queue`
  );

  channel.setBufferedAmount(0);
  connection.bufferSize = 0;
  const highWaterMark = 8 * 1024 * 1024;
  const peerChunkBytes = 17 * 1024;
  const appChunkBytes = 256 * 1024;
  let maxQueuedBytes = 0;
  const drain = setInterval(() => {
    channel.setBufferedAmount(channel.bufferedAmount - 128 * 1024);
    if (connection.bufferSize > 0 && channel.bufferedAmount < highWaterMark) {
      const capacityItems = Math.max(0, Math.floor((highWaterMark - channel.bufferedAmount) / peerChunkBytes));
      const movedItems = Math.min(connection.bufferSize, capacityItems, 16);
      connection.bufferSize -= movedItems;
      channel.setBufferedAmount(channel.bufferedAmount + movedItems * peerChunkBytes);
    }
  }, 2);

  try {
    for (let sent = 0; sent < 12 * 1024 * 1024; sent += appChunkBytes) {
      await runtime.waitForDataChannel(connection);
      const channelCapacity = Math.max(0, highWaterMark - channel.bufferedAmount);
      const directBytes = Math.min(channelCapacity, appChunkBytes);
      channel.setBufferedAmount(channel.bufferedAmount + directBytes);
      const peerBytes = appChunkBytes - directBytes;
      connection.bufferSize += Math.ceil(peerBytes / peerChunkBytes);
      maxQueuedBytes = Math.max(maxQueuedBytes, runtime.getConnectionBufferedBytes(connection, channel));
    }
  } finally {
    clearInterval(drain);
  }
  assert.ok(
    maxQueuedBytes <= highWaterMark + appChunkBytes + peerChunkBytes,
    `${label} 12 MiB producer exceeded the bounded queue: ${maxQueuedBytes}`
  );

  const stalledRuntime = buildFlowRuntime(source, 80);
  const stalledChannel = new FakeDataChannel();
  const stalledConnection = { open: true, bufferSize: 80, dataChannel: stalledChannel };
  stalledChannel.setBufferedAmount(8 * 1024 * 1024);
  await assert.rejects(
    stalledRuntime.waitForDataChannel(stalledConnection),
    (error) => error && error.code === "DATA_CHANNEL_STALLED",
    `${label} must surface a stalled PeerJS queue`
  );
}

function createChromeDownloadsMock() {
  const listeners = new Set();
  const records = new Map();
  const attempts = [];
  let nextId = 1;

  const downloads = {
    download(options, callback) {
      const id = nextId++;
      attempts.push({ id, options });
      records.set(id, { id, state: "in_progress" });
      queueMicrotask(() => callback(id));
    },
    search(query, callback) {
      const record = records.get(query.id);
      const result = record ? [{ ...record }] : [];
      queueMicrotask(() => callback(result));
    },
    onChanged: {
      addListener(listener) { listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); },
      hasListener(listener) { return listeners.has(listener); },
    },
  };

  return {
    chrome: { runtime: { lastError: null }, downloads },
    attempts,
    listenerCount: () => listeners.size,
    emit(id, state, errorCode) {
      const record = records.get(id);
      assert.ok(record, `download ${id} is unknown`);
      if (state) record.state = state;
      if (errorCode) record.error = errorCode;
      const delta = { id };
      if (state) delta.state = { current: state };
      if (errorCode) delta.error = { current: errorCode };
      Array.from(listeners).forEach((listener) => listener(delta));
    },
  };
}

function buildDownloadRuntime(source, downloadsMock, events) {
  const functions = [
    "downloadReceivedFile",
    "beginChromeDownload",
    "waitForChromeDownload",
    "inspectChromeDownload",
    "createDownloadError",
    "isRetryableDownloadError",
  ].map((name) => functionSource(source, name)).join("\n");
  let nextObjectUrl = 1;

  return new Function("options", `
    const DOWNLOAD_COMPLETION_TIMEOUT_MS = options.completionTimeout;
    const DOWNLOAD_FALLBACK_RETENTION_MS = options.fallbackRetention;
    const DOWNLOAD_RETRY_DELAY_MS = options.retryDelay;
    const chrome = options.chrome;
    const URL = options.URL;
    const document = options.document;
    const activeObjectUrls = new Set();
    const releaseObjectUrl = (url) => {
      activeObjectUrls.delete(url);
      options.onRelease(url);
    };
    ${functions}
    return { downloadReceivedFile, activeObjectUrls };
  `)({
    completionTimeout: 2000,
    fallbackRetention: 2000,
    retryDelay: 0,
    chrome: downloadsMock.chrome,
    URL: {
      createObjectURL() { return `blob:lan-test-${nextObjectUrl++}`; },
    },
    document: {
      createElement() { throw new Error("downloads API fallback was not expected"); },
      body: { appendChild() { throw new Error("downloads API fallback was not expected"); } },
    },
    onRelease(url) { events.push(`revoke:${url}`); },
  });
}

async function waitUntil(predicate, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function createDownloadCase(source) {
  const events = [];
  const mock = createChromeDownloadsMock();
  const runtime = buildDownloadRuntime(source, mock, events);
  const cleanup = async () => { events.push("cleanup"); };
  const pending = runtime.downloadReceivedFile({ size: 1024 }, "payload.bin", cleanup);
  return { events, mock, runtime, pending };
}

async function waitForDownloadAttempt(testCase, count) {
  await waitUntil(
    () => testCase.mock.attempts.length === count && testCase.mock.listenerCount() === 1,
    `download attempt ${count} did not begin`
  );
  return testCase.mock.attempts[count - 1].id;
}

function assertDownloadCleanup(testCase, label) {
  assert.equal(testCase.runtime.activeObjectUrls.size, 0, `${label} Blob URL remained active`);
  assert.equal(testCase.mock.listenerCount(), 0, `${label} download listener remained active`);
  assert.equal(testCase.events.length, 2, `${label} cleanup count`);
  assert.match(testCase.events[0], /^revoke:blob:lan-test-\d+$/, `${label} must revoke the Blob URL first`);
  assert.equal(testCase.events[1], "cleanup", `${label} must remove the OPFS temporary file`);
}

async function exerciseDownloadLifecycle(source) {
  {
    const testCase = createDownloadCase(source);
    const downloadId = await waitForDownloadAttempt(testCase, 1);
    assert.equal(testCase.runtime.activeObjectUrls.size, 1, "Blob URL must remain active while downloading");
    assert.deepEqual(testCase.events, [], "download cleanup ran before complete");

    testCase.mock.emit(downloadId, "complete");
    await testCase.pending;
    assertDownloadCleanup(testCase, "completed download");
  }

  {
    const testCase = createDownloadCase(source);
    const firstId = await waitForDownloadAttempt(testCase, 1);
    testCase.mock.emit(firstId, "interrupted", "NETWORK_FAILED");
    const secondId = await waitForDownloadAttempt(testCase, 2);
    assert.deepEqual(testCase.events, [], "NETWORK_FAILED cleaned resources before retry completion");
    assert.equal(testCase.mock.attempts.length, 2, "NETWORK_FAILED must retry exactly once");

    testCase.mock.emit(secondId, "complete");
    await testCase.pending;
    assert.equal(testCase.mock.attempts.length, 2, "completed retry started an extra download");
    assertDownloadCleanup(testCase, "retried download");
  }

  {
    const testCase = createDownloadCase(source);
    const downloadId = await waitForDownloadAttempt(testCase, 1);
    testCase.mock.emit(downloadId, "interrupted", "USER_CANCELED");
    await assert.rejects(
      testCase.pending,
      (error) => error && error.downloadError === "USER_CANCELED",
      "USER_CANCELED must reject the receive commit"
    );
    assert.equal(testCase.mock.attempts.length, 1, "USER_CANCELED must not retry");
    assertDownloadCleanup(testCase, "canceled download");
  }
}

(async () => {
  const desktopSource = read("lan-transfer/transfer.js");
  await exerciseRuntime(desktopSource, "desktop");
  await exerciseRuntime(read("lan-transfer/mobile-runtime.template.js"), "mobile");
  await exerciseDownloadLifecycle(desktopSource);
  console.log("LAN large-transfer flow passed: queues bounded, stalls surfaced, and browser download cleanup follows terminal state.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
