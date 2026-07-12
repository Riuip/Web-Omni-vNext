import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createSecureTransport,
  createSession,
  createSha256,
  fromBase64,
  toBase64,
} from "./secure-channel-source.js";

{
  const digest = createSha256();
  digest.update(new TextEncoder().encode("web-"));
  digest.update(new TextEncoder().encode("omni"));
  assert.equal(
    digest.digestHex(),
    "2d9f0e50542cddc1ef33ad9b5bcd17fbff29fdb0f4b21e91886a90d610c7f3fe"
  );
}

{
  const block = new Uint8Array(64 * 1024);
  for (let index = 0; index < block.length; index++) block[index] = index & 0xff;
  const incremental = createSha256();
  const reference = createHash("sha256");
  for (let index = 0; index < 1600; index++) {
    incremental.update(block);
    reference.update(block);
  }
  assert.equal(incremental.digestHex(), reference.digest("hex"), "100 MiB incremental SHA-256 mismatch");
}

async function connectedPair(desktopCapabilities, mobileCapabilities, options = {}) {
  const session = createSession();
  let desktop;
  let mobile;
  let desktopEnvelope = null;
  let mobileEnvelope = null;
  let deliverDesktop = true;
  let deliverMobile = true;
  let desktopSecureCount = 0;
  let mobileSecureCount = 0;
  const desktopEnvelopes = [];
  const mobileEnvelopes = [];
  const desktopConnection = {
    open: true,
    send(message) {
      desktopEnvelope = structuredClone(message);
      desktopEnvelopes.push(desktopEnvelope);
      if (message.type === "wo-v2-secure" && desktopSecureCount++ === 0 && options.dropFeatureOffers) return;
      if (deliverDesktop) queueMicrotask(() => mobile.handle(structuredClone(message)).catch(() => {}));
    },
    close() { this.open = false; },
  };
  const mobileConnection = {
    open: true,
    send(message) {
      mobileEnvelope = structuredClone(message);
      mobileEnvelopes.push(mobileEnvelope);
      if (message.type === "wo-v2-secure" && mobileSecureCount++ === 0 && options.dropFeatureOffers) return;
      if (deliverMobile) queueMicrotask(() => desktop.handle(structuredClone(message)).catch(() => {}));
    },
    close() { this.open = false; },
  };
  mobile = createSecureTransport(mobileConnection, {
    role: "mobile",
    ...session,
    capabilities: mobileCapabilities,
    supportsBinaryEnvelope: options.mobileSupportsBinary === true,
  });
  desktop = createSecureTransport(desktopConnection, {
    role: "desktop",
    ...session,
    capabilities: desktopCapabilities,
    supportsBinaryEnvelope: options.desktopSupportsBinary === true,
  });
  await Promise.all([desktop.ready, mobile.ready]);
  await Promise.all([desktop.featuresReady, mobile.featuresReady]);
  deliverDesktop = false;
  deliverMobile = false;
  return {
    desktop,
    mobile,
    getDesktopEnvelope: () => desktopEnvelope,
    getMobileEnvelope: () => mobileEnvelope,
    getDesktopEnvelopes: () => desktopEnvelopes,
    getMobileEnvelopes: () => mobileEnvelopes,
  };
}

{
  const session = createSession();
  const connection = { send() {}, close() {} };
  assert.throws(() => createSecureTransport(connection, {
    role: "desktop",
    sessionId: session.sessionId.slice(1),
    pairingSecret: session.pairingSecret,
  }), /parameters/i);
  assert.throws(() => createSecureTransport(connection, {
    role: "desktop",
    sessionId: session.sessionId,
    pairingSecret: session.pairingSecret.slice(2),
  }), /parameters/i);
}

{
  const pair = await connectedPair(
    { maxMessageBytes: 128 * 1024, chunkSize: 64 * 1024, hash: ["sha256"], resume: true },
    { maxMessageBytes: 96 * 1024, chunkSize: 32 * 1024, hash: ["sha256"], resume: true }
  );
  assert.equal(pair.desktop.negotiatedCapabilities.maxMessageBytes, 96 * 1024);
  assert.equal(pair.desktop.negotiatedCapabilities.chunkSize, 32 * 1024);
  await assert.rejects(() => pair.desktop.send({ type: "text-message", text: "x".repeat(100 * 1024) }), /size/i);
}

{
  const pair = await connectedPair();
  assert.equal(pair.desktop.negotiatedCapabilities.chunkSize, 64 * 1024);
  assert.deepEqual(pair.desktop.negotiatedCapabilities.hash, ["sha256"]);
  const chunk = new Uint8Array([1, 2, 3, 4]).buffer;
  await pair.desktop.send({ type: "file-chunk", id: "a", seq: 0, chunk });
  const result = await pair.mobile.handle(pair.getDesktopEnvelope());
  assert.equal(result.message.type, "file-chunk");
  assert.deepEqual(Array.from(new Uint8Array(result.message.chunk)), [1, 2, 3, 4]);
}

{
  const pair = await connectedPair(undefined, undefined, {
    desktopSupportsBinary: true,
    mobileSupportsBinary: true,
  });
  const expectedFeatures = {
    binaryEnvelope: true,
    aeadChunkIntegrity: true,
    receiverReady: true,
  };
  assert.deepEqual(pair.desktop.negotiatedFeatures, expectedFeatures);
  assert.deepEqual(pair.mobile.negotiatedFeatures, expectedFeatures);
  assert.equal(
    pair.getDesktopEnvelopes().find((message) => message.type === "wo-v2-secure")?.type,
    "wo-v2-secure",
    "feature offer must use the Base64 envelope"
  );
  await pair.desktop.send({
    type: "file-chunk",
    id: "binary-transfer",
    seq: 0,
    chunk: new Uint8Array([9, 8, 7]).buffer,
  });
  const envelope = pair.getDesktopEnvelope();
  assert.equal(envelope.type, "wo-v2-secure-bin");
  assert.ok(envelope.ciphertext instanceof ArrayBuffer);
  const result = await pair.mobile.handle({
    ...envelope,
    ciphertext: new Uint8Array(envelope.ciphertext),
  });
  assert.deepEqual(Array.from(new Uint8Array(result.message.chunk)), [9, 8, 7]);
}

{
  const chunkSize = 512 * 1024;
  const totalBytes = 100 * 1024 * 1024;
  const capabilities = {
    maxMessageBytes: 2 * 1024 * 1024,
    chunkSize,
    hash: ["sha256"],
    resume: true,
  };
  const pair = await connectedPair(capabilities, capabilities, {
    desktopSupportsBinary: true,
    mobileSupportsBinary: true,
  });
  const sentDigest = createSha256();
  const receivedDigest = createSha256();
  const chunk = new Uint8Array(chunkSize);
  let receivedBytes = 0;

  for (let offset = 0, sequence = 0; offset < totalBytes; offset += chunkSize, sequence += 1) {
    new DataView(chunk.buffer).setUint32(0, sequence, false);
    sentDigest.update(chunk);
    await pair.desktop.send({
      type: "file-chunk",
      id: "binary-100mib",
      seq: sequence,
      chunk: chunk.buffer,
    });
    const envelope = pair.getDesktopEnvelope();
    assert.equal(envelope.type, "wo-v2-secure-bin");
    const result = await pair.mobile.handle({
      ...envelope,
      ciphertext: new Uint8Array(envelope.ciphertext),
    });
    const receivedChunk = new Uint8Array(result.message.chunk);
    receivedDigest.update(receivedChunk);
    receivedBytes += receivedChunk.byteLength;
  }

  assert.equal(receivedBytes, totalBytes, "100 MiB binary transfer length mismatch");
  assert.equal(receivedDigest.digestHex(), sentDigest.digestHex(), "100 MiB binary transfer digest mismatch");
}

{
  const pair = await connectedPair(undefined, undefined, {
    desktopSupportsBinary: true,
    mobileSupportsBinary: false,
  });
  assert.deepEqual(pair.desktop.negotiatedFeatures, {
    binaryEnvelope: false,
    aeadChunkIntegrity: true,
    receiverReady: true,
  });
  await pair.desktop.send({ type: "text-message", text: "compatible" });
  assert.equal(pair.getDesktopEnvelope().type, "wo-v2-secure");
}

{
  const startedAt = Date.now();
  const pair = await connectedPair(undefined, undefined, {
    desktopSupportsBinary: true,
    mobileSupportsBinary: true,
    dropFeatureOffers: true,
  });
  assert.ok(Date.now() - startedAt >= 250, "legacy feature fallback resolved too early");
  assert.deepEqual(pair.desktop.negotiatedFeatures, {
    binaryEnvelope: false,
    aeadChunkIntegrity: false,
    receiverReady: false,
  });
  assert.deepEqual(pair.mobile.negotiatedFeatures, pair.desktop.negotiatedFeatures);
  await pair.desktop.send({ type: "text-message", text: "legacy" });
  assert.equal(pair.getDesktopEnvelope().type, "wo-v2-secure");
}

{
  const pair = await connectedPair();
  await pair.desktop.send({ type: "file-meta", id: "transfer-a", size: 0, totalChunks: 1 });
  const envelope = structuredClone(pair.getDesktopEnvelope());
  assert.equal(envelope.transferId, "transfer-a");
  envelope.transferId = "transfer-b";
  await assert.rejects(() => pair.mobile.handle(envelope));
}

{
  const pair = await connectedPair(undefined, undefined, {
    desktopSupportsBinary: true,
    mobileSupportsBinary: true,
  });
  await pair.desktop.send({ type: "text-message", text: "binary-auth" });
  const envelope = structuredClone(pair.getDesktopEnvelope());
  const tampered = new Uint8Array(envelope.ciphertext.slice(0));
  tampered[tampered.length - 1] ^= 1;
  envelope.ciphertext = tampered.buffer;
  await assert.rejects(() => pair.mobile.handle(envelope));
}

{
  const pair = await connectedPair(undefined, undefined, {
    desktopSupportsBinary: true,
    mobileSupportsBinary: true,
  });
  await pair.desktop.send({ type: "text-message", text: "binary-replay" });
  const envelope = pair.getDesktopEnvelope();
  const first = await pair.mobile.handle(envelope);
  assert.equal(first.message.text, "binary-replay");
  await assert.rejects(() => pair.mobile.handle(envelope), /sequence/i);
}

{
  const pair = await connectedPair();
  await pair.desktop.send({ type: "text-message", text: "private" });
  const envelope = pair.getDesktopEnvelope();
  const first = await pair.mobile.handle(envelope);
  assert.equal(first.message.text, "private");
  await assert.rejects(() => pair.mobile.handle(envelope), /sequence/i);
}

{
  const pair = await connectedPair();
  await pair.desktop.send({ type: "text-message", text: "auth" });
  const envelope = structuredClone(pair.getDesktopEnvelope());
  const tampered = fromBase64(envelope.ciphertext);
  tampered[tampered.length - 1] ^= 1;
  envelope.ciphertext = toBase64(tampered);
  await assert.rejects(() => pair.mobile.handle(envelope));
}

{
  const desktopSession = createSession();
  const mobileSession = { ...desktopSession, pairingSecret: createSession().pairingSecret };
  let desktop;
  let mobile;
  const desktopConnection = {
    open: true,
    send(message) { queueMicrotask(() => mobile.handle(structuredClone(message)).catch(() => {})); },
    close() { this.open = false; },
  };
  const mobileConnection = {
    open: true,
    send(message) { queueMicrotask(() => desktop.handle(structuredClone(message)).catch(() => {})); },
    close() { this.open = false; },
  };
  mobile = createSecureTransport(mobileConnection, { role: "mobile", ...mobileSession });
  mobile.ready.catch(() => {});
  desktop = createSecureTransport(desktopConnection, { role: "desktop", ...desktopSession });
  await assert.rejects(desktop.ready, /authentication/i);
  mobile.close(new Error("test complete"));
}

console.log("secure-channel v2: handshake, feature fallback, binary, replay, tamper and wrong-secret checks passed");
