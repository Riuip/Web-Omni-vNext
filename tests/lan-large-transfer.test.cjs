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

(async () => {
  await exerciseRuntime(read("lan-transfer/transfer.js"), "desktop");
  await exerciseRuntime(read("lan-transfer/mobile-runtime.template.js"), "mobile");
  console.log("LAN large-transfer flow passed: 12 MiB queue bounded, PeerJS buffering observed, and stalls surfaced.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
