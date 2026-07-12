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
  for (let index = openingBrace; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index++;
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
      index++;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index++;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth++;
    if (character === "}" && --depth === 0) return source.slice(signature.index, index + 1);
  }
  assert.fail(`function ${name} has an unterminated body`);
}

function helperBlock(source, firstFunction, nextFunction) {
  const start = source.indexOf(`function ${firstFunction}`);
  const end = source.indexOf(`function ${nextFunction}`, start + 1);
  assert.ok(start >= 0 && end > start, `${firstFunction} helper block is missing`);
  return source.slice(start, end);
}

function buildMetadataRuntime(source, label) {
  const sanitize = `
    function sanitizeFileName(name) {
      const value = String(name || "").replace(/[\\\\/:*?"<>|]+/g, "_").trim();
      return value || "download.bin";
    }
  `;
  if (label === "desktop") {
    const functions = helperBlock(source, "guessExtensionFromMime", "buildTimestampToken");
    return new Function(`${sanitize}\n${functions}\nreturn { resolveTransferFileMetadata };`)();
  }

  const functions = helperBlock(source, "guessExtensionFromMime", "buildTimestampToken");
  return new Function(`${sanitize}\n${functions}\nreturn {
    resolveTransferFileMetadata: resolveOutgoingFileMetadata
  };`)();
}

function makeFtypFile(name, type, brand) {
  const bytes = new Uint8Array(32);
  bytes.set(Buffer.from("ftyp", "ascii"), 4);
  bytes.set(Buffer.from(brand, "ascii"), 8);
  return new File([bytes], name, { type });
}

async function exerciseRuntime(source, label) {
  const runtime = buildMetadataRuntime(source, label);

  assert.deepEqual(
    await runtime.resolveTransferFileMetadata(makeFtypFile("holiday.txt", "video/mp4", "isom"), "holiday.txt", "video/mp4"),
    { name: "holiday.mp4", mimeType: "video/mp4" },
    `${label} must repair a text suffix using the declared video type`
  );
  assert.deepEqual(
    await runtime.resolveTransferFileMetadata(makeFtypFile("IMG_1001", "video/quicktime", "qt  "), "IMG_1001", "video/quicktime"),
    { name: "IMG_1001.mov", mimeType: "video/quicktime" },
    `${label} must add a MOV suffix`
  );
  assert.deepEqual(
    await runtime.resolveTransferFileMetadata(makeFtypFile("camera.txt", "text/plain", "isom"), "camera.txt", "text/plain"),
    { name: "camera.mp4", mimeType: "video/mp4" },
    `${label} must recover MP4 metadata from the file header`
  );
  assert.deepEqual(
    await runtime.resolveTransferFileMetadata(makeFtypFile("clip.bin", "application/octet-stream", "qt  "), "clip.bin", "application/octet-stream"),
    { name: "clip.mov", mimeType: "video/quicktime" },
    `${label} must recover MOV metadata from the file header`
  );
  assert.deepEqual(
    await runtime.resolveTransferFileMetadata(makeFtypFile("original.MOV", "video/quicktime", "qt  "), "original.MOV", "video/quicktime"),
    { name: "original.MOV", mimeType: "video/quicktime" },
    `${label} must preserve an existing media extension`
  );

  const sendTransfer = functionSource(source, "sendTransfer");
  assert.match(sendTransfer, /mimeType\s*:/, `${label} file metadata must carry MIME type`);
  const finalize = functionSource(source, "finalizeIncomingTransfer");
  if (label === "desktop") {
    assert.match(finalize, /resolveTransferFileMetadata/, `${label} must inspect metadata before saving`);
  } else {
    assert.match(source, /new Blob\(parts, \{ type: transfer\.mimeType \}\)/, `${label} saved Blob must retain MIME type`);
  }
}

(async () => {
  await exerciseRuntime(read("lan-transfer/transfer.js"), "desktop");
  await exerciseRuntime(read("lan-transfer/mobile-runtime.template.js"), "mobile");
  console.log("LAN file metadata passed: media MIME and MP4/MOV extensions survive both directions.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
