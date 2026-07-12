import { x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";

const VERSION = 2;
const HANDSHAKE_TIMEOUT_MS = 12000;
const FEATURES_TIMEOUT_MS = 300;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const FALLBACK_FEATURES = Object.freeze({
  binaryEnvelope: false,
  aeadChunkIntegrity: false,
  receiverReady: false,
});
const DEFAULT_CAPABILITIES = Object.freeze({
  maxMessageBytes: 256 * 1024,
  chunkSize: 64 * 1024,
  hash: Object.freeze(["sha256"]),
  resume: true,
});
const TRANSFER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return encoder.encode(String(value == null ? "" : value));
}

function concat(...values) {
  const arrays = values.map(bytes);
  const output = new Uint8Array(arrays.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of arrays) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

function toBase64(value) {
  const data = bytes(value);
  let binary = "";
  for (let offset = 0; offset < data.length; offset += 0x8000) {
    binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
  return output;
}

function equal(left, right) {
  const a = bytes(left);
  const b = bytes(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function uint64(value) {
  const output = new Uint8Array(8);
  const view = new DataView(output.buffer);
  const high = Math.floor(value / 0x100000000);
  const low = value >>> 0;
  view.setUint32(0, high, false);
  view.setUint32(4, low, false);
  return output;
}

function encodePayload(message) {
  const source = message && typeof message === "object" ? message : { value: message };
  const binaryValue = source.chunk instanceof ArrayBuffer || ArrayBuffer.isView(source.chunk)
    ? bytes(source.chunk)
    : null;
  const header = { ...source };
  if (binaryValue) delete header.chunk;
  const headerBytes = encoder.encode(JSON.stringify({ header, binary: binaryValue ? "chunk" : null }));
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, headerBytes.length, false);
  return binaryValue ? concat(prefix, headerBytes, binaryValue) : concat(prefix, headerBytes);
}

function decodePayload(value) {
  const data = bytes(value);
  if (data.length < 4) throw new Error("encrypted payload is truncated");
  const headerLength = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, false);
  if (headerLength < 2 || headerLength > data.length - 4 || headerLength > 1024 * 1024) {
    throw new Error("encrypted payload header is invalid");
  }
  const parsed = JSON.parse(decoder.decode(data.subarray(4, 4 + headerLength)));
  const message = parsed && parsed.header && typeof parsed.header === "object" ? parsed.header : {};
  if (parsed.binary === "chunk") {
    const binary = data.slice(4 + headerLength);
    message.chunk = binary.buffer;
  }
  return message;
}

function deriveMaterial(privateKey, remotePublicKey, pairingSecret, sessionId) {
  const shared = x25519.getSharedSecret(privateKey, remotePublicKey);
  const salt = sha256(concat("web-omni-lan-v2/psk/", pairingSecret));
  const info = concat("web-omni-lan-v2/session/", sessionId);
  return hkdf(sha256, shared, salt, info, 96);
}

function splitMaterial(material, role) {
  const desktopToMobile = material.slice(0, 32);
  const mobileToDesktop = material.slice(32, 64);
  const proofKey = material.slice(64, 96);
  return {
    sendKey: role === "desktop" ? desktopToMobile : mobileToDesktop,
    receiveKey: role === "desktop" ? mobileToDesktop : desktopToMobile,
    proofKey,
  };
}

function normalizeCapabilities(value) {
  const source = value && typeof value === "object" ? value : DEFAULT_CAPABILITIES;
  const maxMessageBytes = Math.max(
    64 * 1024,
    Math.min(2 * 1024 * 1024, Number(source.maxMessageBytes) || DEFAULT_CAPABILITIES.maxMessageBytes)
  );
  const chunkSize = Math.max(
    16 * 1024,
    Math.min(maxMessageBytes - 8192, Number(source.chunkSize) || DEFAULT_CAPABILITIES.chunkSize)
  );
  const hashes = Array.isArray(source.hash) ? source.hash : DEFAULT_CAPABILITIES.hash;
  const hash = Array.from(new Set(hashes.map((item) => String(item).toLowerCase())))
    .filter((item) => item === "sha256");
  if (!hash.length) throw new Error("secure peer does not support SHA-256");
  return Object.freeze({
    maxMessageBytes: Math.floor(maxMessageBytes),
    chunkSize: Math.floor(chunkSize),
    hash: Object.freeze(hash),
    resume: source.resume !== false,
  });
}

function negotiateCapabilities(local, remote) {
  const hash = local.hash.filter((algorithm) => remote.hash.includes(algorithm));
  if (!hash.includes("sha256")) throw new Error("secure peers have no common hash algorithm");
  const maxMessageBytes = Math.min(local.maxMessageBytes, remote.maxMessageBytes);
  return Object.freeze({
    maxMessageBytes,
    chunkSize: Math.min(local.chunkSize, remote.chunkSize, maxMessageBytes - 8192),
    hash: Object.freeze(["sha256"]),
    resume: Boolean(local.resume && remote.resume),
  });
}

function sameCapabilities(left, right) {
  return Boolean(left && right)
    && left.maxMessageBytes === right.maxMessageBytes
    && left.chunkSize === right.chunkSize
    && left.resume === right.resume
    && JSON.stringify(left.hash) === JSON.stringify(right.hash);
}

function proof(
  proofKey,
  label,
  sessionId,
  desktopPublicKey,
  mobilePublicKey,
  desktopNoncePrefix,
  mobileNoncePrefix,
  desktopCapabilities,
  mobileCapabilities
) {
  const transcript = JSON.stringify({
    protocol: "web-omni-lan-v2",
    label,
    sessionId,
    desktopPublicKey: toBase64(desktopPublicKey),
    mobilePublicKey: toBase64(mobilePublicKey),
    desktopNoncePrefix: toBase64(desktopNoncePrefix),
    mobileNoncePrefix: toBase64(mobileNoncePrefix),
    desktopCapabilities,
    mobileCapabilities,
  });
  return hmac(sha256, proofKey, encoder.encode(transcript));
}

function checkedFixedBytes(value, expectedLength, label) {
  const encoded = String(value || "");
  if (!encoded || encoded.length > Math.ceil(expectedLength * 4 / 3) + 4) {
    throw new Error(`secure ${label} is invalid`);
  }
  const decoded = fromBase64(encoded);
  if (decoded.length !== expectedLength) throw new Error(`secure ${label} is invalid`);
  return decoded;
}

function checkedNoncePrefix(value) {
  return checkedFixedBytes(value, 16, "nonce prefix");
}

function nonceFor(prefix, sequence) {
  return concat(prefix, uint64(sequence));
}

function transferIdForPayload(message) {
  if (!message || typeof message.type !== "string" || !message.type.startsWith("file-")) return "";
  const transferId = String(message.id || "");
  if (!TRANSFER_ID_PATTERN.test(transferId)) throw new Error("secure transfer ID is invalid");
  return transferId;
}

function checkedEnvelopeTransferId(value) {
  const transferId = String(value || "");
  if (transferId && !TRANSFER_ID_PATTERN.test(transferId)) {
    throw new Error("secure envelope transfer ID is invalid");
  }
  return transferId;
}

function aadFor(sessionId, direction, sequence, transferId) {
  return encoder.encode(JSON.stringify([VERSION, sessionId, direction, sequence, transferId]));
}

function featureOffer(supportsBinaryEnvelope) {
  return Object.freeze({
    binaryEnvelope: supportsBinaryEnvelope === true,
    aeadChunkIntegrity: true,
    receiverReady: true,
  });
}

function normalizeFeatures(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.freeze({
    binaryEnvelope: source.binaryEnvelope === true,
    aeadChunkIntegrity: source.aeadChunkIntegrity === true,
    receiverReady: source.receiverReady === true,
  });
}

function negotiateFeatures(local, remote) {
  return Object.freeze({
    binaryEnvelope: local.binaryEnvelope && remote.binaryEnvelope,
    aeadChunkIntegrity: local.aeadChunkIntegrity && remote.aeadChunkIntegrity,
    receiverReady: local.receiverReady && remote.receiverReady,
  });
}

function createSecureTransport(connection, config) {
  if (!connection || typeof connection.send !== "function") throw new TypeError("connection is required");
  const role = config && config.role === "mobile" ? "mobile" : "desktop";
  const sessionId = String(config && config.sessionId || "");
  let sessionBytes;
  let pairingSecret;
  try {
    sessionBytes = fromBase64(sessionId);
    pairingSecret = fromBase64(config && config.pairingSecret || "");
  } catch (_) {
    throw new Error("secure session parameters are invalid");
  }
  if (
    sessionBytes.length !== 16
    || toBase64(sessionBytes) !== sessionId
    || pairingSecret.length !== 32
    || toBase64(pairingSecret) !== String(config && config.pairingSecret || "")
  ) throw new Error("secure session parameters are invalid");
  const localCapabilities = normalizeCapabilities(config && config.capabilities);
  const localFeatures = featureOffer(config && config.supportsBinaryEnvelope);

  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const sendPrefix = randomBytes(16);
  const sendDirection = role === "desktop" ? "desktop-to-mobile" : "mobile-to-desktop";
  const receiveDirection = role === "desktop" ? "mobile-to-desktop" : "desktop-to-mobile";
  let sendSequence = 0;
  let receiveSequence = -1;
  let ready = false;
  let closed = false;
  let keys = null;
  let desktopPublicKey = role === "desktop" ? publicKey : null;
  let mobilePublicKey = role === "mobile" ? publicKey : null;
  let desktopCapabilities = role === "desktop" ? localCapabilities : null;
  let mobileCapabilities = role === "mobile" ? localCapabilities : null;
  let negotiatedCapabilities = null;
  let negotiatedFeatures = null;
  let featuresStarted = false;
  let featuresTimer = null;
  let resolveReady;
  let rejectReady;
  let resolveFeatures;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const featuresPromise = new Promise((resolve) => {
    resolveFeatures = resolve;
  });
  const timeout = setTimeout(() => fail(new Error("secure handshake timed out")), HANDSHAKE_TIMEOUT_MS);

  function rawSend(message) {
    if (closed) throw new Error("secure transport is closed");
    connection.send(message);
  }

  function finish() {
    if (ready || closed) return;
    if (!negotiatedCapabilities) throw new Error("secure capabilities were not negotiated");
    ready = true;
    clearTimeout(timeout);
    resolveReady(api);
    startFeatureNegotiation();
  }

  function finishFeatureNegotiation(features) {
    if (negotiatedFeatures) return;
    if (featuresTimer) clearTimeout(featuresTimer);
    featuresTimer = null;
    negotiatedFeatures = features;
    resolveFeatures(features);
  }

  function startFeatureNegotiation() {
    if (featuresStarted || closed) return;
    featuresStarted = true;
    featuresTimer = setTimeout(() => {
      finishFeatureNegotiation(FALLBACK_FEATURES);
    }, FEATURES_TIMEOUT_MS);
    try {
      sendEncrypted({ type: "wo-v2-features", ...localFeatures }, true);
    } catch (error) {
      fail(error);
    }
  }

  function dispose(error, closeConnection) {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    if (featuresTimer) clearTimeout(featuresTimer);
    featuresTimer = null;
    finishFeatureNegotiation(FALLBACK_FEATURES);
    privateKey.fill(0);
    pairingSecret.fill(0);
    if (keys) {
      keys.sendKey.fill(0);
      keys.receiveKey.fill(0);
      keys.proofKey.fill(0);
    }
    rejectReady(error instanceof Error ? error : new Error(String(error || "secure transport failed")));
    if (closeConnection) {
      try { connection.close(); } catch (_) {}
    }
  }

  function fail(error) {
    dispose(error, true);
  }

  async function handleHandshake(message) {
    if (!message || message.v !== VERSION || message.sessionId !== sessionId) {
      throw new Error("secure handshake session mismatch");
    }
    if (role === "mobile" && message.type === "wo-v2-hello") {
      desktopPublicKey = checkedFixedBytes(message.publicKey, 32, "desktop public key");
      desktopCapabilities = normalizeCapabilities(message.capabilities);
      api.remoteNoncePrefix = checkedNoncePrefix(message.noncePrefix);
      keys = splitMaterial(deriveMaterial(privateKey, desktopPublicKey, pairingSecret, sessionId), role);
      negotiatedCapabilities = negotiateCapabilities(localCapabilities, desktopCapabilities);
      const responseProof = proof(
        keys.proofKey, "mobile", sessionId, desktopPublicKey, mobilePublicKey,
        api.remoteNoncePrefix, sendPrefix, desktopCapabilities, mobileCapabilities
      );
      rawSend({
        type: "wo-v2-response",
        v: VERSION,
        sessionId,
        publicKey: toBase64(mobilePublicKey),
        noncePrefix: toBase64(sendPrefix),
        capabilities: mobileCapabilities,
        proof: toBase64(responseProof),
      });
      return true;
    }
    if (role === "desktop" && message.type === "wo-v2-response") {
      mobilePublicKey = checkedFixedBytes(message.publicKey, 32, "mobile public key");
      mobileCapabilities = normalizeCapabilities(message.capabilities);
      const mobileNoncePrefix = checkedNoncePrefix(message.noncePrefix);
      keys = splitMaterial(deriveMaterial(privateKey, mobilePublicKey, pairingSecret, sessionId), role);
      negotiatedCapabilities = negotiateCapabilities(localCapabilities, mobileCapabilities);
      const expected = proof(
        keys.proofKey, "mobile", sessionId, desktopPublicKey, mobilePublicKey,
        sendPrefix, mobileNoncePrefix, desktopCapabilities, mobileCapabilities
      );
      if (!equal(expected, checkedFixedBytes(message.proof, 32, "handshake proof"))) throw new Error("secure handshake authentication failed");
      api.remoteNoncePrefix = mobileNoncePrefix;
      rawSend({
        type: "wo-v2-ready",
        v: VERSION,
        sessionId,
        noncePrefix: toBase64(sendPrefix),
        capabilities: negotiatedCapabilities,
        proof: toBase64(proof(
          keys.proofKey, "desktop", sessionId, desktopPublicKey, mobilePublicKey,
          sendPrefix, mobileNoncePrefix, desktopCapabilities, mobileCapabilities
        )),
      });
      finish();
      return true;
    }
    if (role === "mobile" && message.type === "wo-v2-ready") {
      const desktopNoncePrefix = checkedNoncePrefix(message.noncePrefix);
      if (!equal(desktopNoncePrefix, api.remoteNoncePrefix)) {
        throw new Error("secure nonce prefix changed during handshake");
      }
      const expected = proof(
        keys.proofKey, "desktop", sessionId, desktopPublicKey, mobilePublicKey,
        desktopNoncePrefix, sendPrefix, desktopCapabilities, mobileCapabilities
      );
      if (!equal(expected, checkedFixedBytes(message.proof, 32, "handshake proof"))) throw new Error("secure handshake authentication failed");
      const confirmedCapabilities = normalizeCapabilities(message.capabilities);
      if (!sameCapabilities(negotiatedCapabilities, confirmedCapabilities)) {
        throw new Error("secure capability negotiation mismatch");
      }
      finish();
      return true;
    }
    return false;
  }

  async function handle(message) {
    try {
      if (!ready) return { handshake: await handleHandshake(message), message: null };
      const isBase64Envelope = Boolean(message && message.type === "wo-v2-secure");
      const isBinaryEnvelope = Boolean(message && message.type === "wo-v2-secure-bin");
      if (!message || (!isBase64Envelope && !isBinaryEnvelope) || message.v !== VERSION) {
        throw new Error("unencrypted application message rejected");
      }
      if (isBinaryEnvelope && !(negotiatedFeatures && negotiatedFeatures.binaryEnvelope)) {
        throw new Error("binary secure envelope was not negotiated");
      }
      const sequence = Number(message.sequence);
      if (!Number.isSafeInteger(sequence) || sequence <= receiveSequence || sequence > MAX_SEQUENCE) {
        throw new Error("encrypted message sequence is invalid");
      }
      const transferId = checkedEnvelopeTransferId(message.transferId);
      let ciphertext;
      if (isBinaryEnvelope) {
        if (!(message.ciphertext instanceof ArrayBuffer)) {
          throw new Error("binary secure ciphertext is invalid");
        }
        ciphertext = new Uint8Array(message.ciphertext);
      } else {
        const encodedCiphertext = String(message.ciphertext || "");
        if (encodedCiphertext.length > Math.ceil((negotiatedCapabilities.maxMessageBytes + 16) * 4 / 3) + 4) {
          throw new Error("encrypted message exceeds the negotiated size");
        }
        ciphertext = fromBase64(encodedCiphertext);
      }
      if (ciphertext.byteLength > negotiatedCapabilities.maxMessageBytes + 16) {
        throw new Error("encrypted message exceeds the negotiated size");
      }
      const nonce = nonceFor(api.remoteNoncePrefix, sequence);
      const aad = aadFor(sessionId, receiveDirection, sequence, transferId);
      const cipher = xchacha20poly1305(keys.receiveKey, nonce, aad);
      const plaintext = cipher.decrypt(ciphertext);
      if (plaintext.byteLength > negotiatedCapabilities.maxMessageBytes) {
        throw new Error("decrypted message exceeds the negotiated size");
      }
      const payload = decodePayload(plaintext);
      if (transferIdForPayload(payload) !== transferId) {
        throw new Error("secure envelope transfer ID mismatch");
      }
      receiveSequence = sequence;
      if (payload.type === "wo-v2-features") {
        if (!negotiatedFeatures) {
          finishFeatureNegotiation(negotiateFeatures(localFeatures, normalizeFeatures(payload)));
        }
        return { handshake: false, message: null };
      }
      return { handshake: false, message: payload };
    } catch (error) {
      fail(error);
      throw error;
    }
  }

  function sendEncrypted(message, forceBase64) {
    const transferId = transferIdForPayload(message);
    const plaintext = encodePayload(message);
    if (plaintext.byteLength > negotiatedCapabilities.maxMessageBytes) {
      throw new Error("message exceeds the negotiated secure size");
    }
    if (++sendSequence > MAX_SEQUENCE) throw new Error("encrypted message sequence exhausted");
    const nonce = nonceFor(sendPrefix, sendSequence);
    const aad = aadFor(sessionId, sendDirection, sendSequence, transferId);
    const cipher = xchacha20poly1305(keys.sendKey, nonce, aad);
    const ciphertext = cipher.encrypt(plaintext);
    if (!forceBase64 && negotiatedFeatures && negotiatedFeatures.binaryEnvelope) {
      const ciphertextBuffer = ciphertext.buffer.slice(
        ciphertext.byteOffset,
        ciphertext.byteOffset + ciphertext.byteLength
      );
      rawSend({
        type: "wo-v2-secure-bin",
        v: VERSION,
        sequence: sendSequence,
        transferId,
        ciphertext: ciphertextBuffer,
      });
      return;
    }
    rawSend({
      type: "wo-v2-secure",
      v: VERSION,
      sequence: sendSequence,
      transferId,
      ciphertext: toBase64(ciphertext),
    });
  }

  async function send(message) {
    await readyPromise;
    await featuresPromise;
    sendEncrypted(message, false);
  }

  const api = {
    version: VERSION,
    role,
    ready: readyPromise,
    featuresReady: featuresPromise,
    remoteNoncePrefix: null,
    handle,
    send,
    close: fail,
    abandon(error) {
      dispose(error || new Error("secure transport abandoned"), false);
    },
    get authenticated() { return ready; },
    get negotiatedCapabilities() { return negotiatedCapabilities; },
    get negotiatedFeatures() { return negotiatedFeatures; },
  };

  if (role === "desktop") {
    rawSend({
      type: "wo-v2-hello",
      v: VERSION,
      sessionId,
      publicKey: toBase64(publicKey),
      noncePrefix: toBase64(sendPrefix),
      capabilities: desktopCapabilities,
    });
  }
  return api;
}

function createSession() {
  return {
    sessionId: toBase64(randomBytes(16)),
    pairingSecret: toBase64(randomBytes(32)),
  };
}

function createSha256() {
  const state = sha256.create();
  let finished = false;
  return Object.freeze({
    update(value) {
      if (finished) throw new Error("SHA-256 state is already finalized");
      state.update(bytes(value));
    },
    digestHex() {
      if (finished) throw new Error("SHA-256 state is already finalized");
      finished = true;
      const digest = state.digest();
      let output = "";
      for (const byte of digest) output += byte.toString(16).padStart(2, "0");
      return output;
    },
    destroy() {
      if (finished) return;
      finished = true;
      state.destroy();
    },
  });
}

export {
  VERSION,
  createSha256,
  createSecureTransport,
  createSession,
  fromBase64,
  toBase64,
};
