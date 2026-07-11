import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSecureTransport, createSession, createSha256 } from "./secure-channel-source.js";

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

async function connectedPair(desktopCapabilities, mobileCapabilities) {
  const session = createSession();
  let desktop;
  let mobile;
  let desktopEnvelope = null;
  let mobileEnvelope = null;
  let deliverDesktop = true;
  let deliverMobile = true;
  const desktopConnection = {
    open: true,
    send(message) {
      desktopEnvelope = structuredClone(message);
      if (deliverDesktop) queueMicrotask(() => mobile.handle(structuredClone(message)).catch(() => {}));
    },
    close() { this.open = false; },
  };
  const mobileConnection = {
    open: true,
    send(message) {
      mobileEnvelope = structuredClone(message);
      if (deliverMobile) queueMicrotask(() => desktop.handle(structuredClone(message)).catch(() => {}));
    },
    close() { this.open = false; },
  };
  mobile = createSecureTransport(mobileConnection, { role: "mobile", ...session, capabilities: mobileCapabilities });
  desktop = createSecureTransport(desktopConnection, { role: "desktop", ...session, capabilities: desktopCapabilities });
  await Promise.all([desktop.ready, mobile.ready]);
  deliverDesktop = false;
  deliverMobile = false;
  return {
    desktop,
    mobile,
    getDesktopEnvelope: () => desktopEnvelope,
    getMobileEnvelope: () => mobileEnvelope,
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
  const pair = await connectedPair();
  await pair.desktop.send({ type: "file-meta", id: "transfer-a", size: 0, totalChunks: 1 });
  const envelope = structuredClone(pair.getDesktopEnvelope());
  assert.equal(envelope.transferId, "transfer-a");
  envelope.transferId = "transfer-b";
  await assert.rejects(() => pair.mobile.handle(envelope));
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
  const tail = envelope.ciphertext.slice(-1);
  envelope.ciphertext = envelope.ciphertext.slice(0, -1) + (tail === "A" ? "B" : "A");
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

console.log("secure-channel v2: handshake, binary, replay, tamper and wrong-secret checks passed");
