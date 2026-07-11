import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const transfer = join(root, "lan-transfer");
const defaults = {
  signalServers: [{ host: "0.peerjs.com", port: 443, secure: true, path: "/" }],
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
  ],
  hashAlgorithm: "sha256",
  allowLegacyProtocol: false,
};

const [template, runtime, peerjs, secureChannel] = await Promise.all([
  readFile(join(transfer, "mobile-template.html"), "utf8"),
  readFile(join(transfer, "mobile-runtime.template.js"), "utf8"),
  readFile(join(transfer, "peerjs.min.js"), "utf8"),
  readFile(join(transfer, "secure-channel.js"), "utf8"),
]);

const runtimeSource = runtime
  .split("__WO_ROOM_CODE__").join(JSON.stringify(""))
  .split("__WO_SECURE_SESSION__").join("null")
  .split("__WO_RUNTIME_CONFIG__").join(JSON.stringify(defaults))
  .split("__WO_TEXT_LIMIT__").join(String(32 * 1024));

const html = injectInlineScript(
  injectInlineScript(
    injectInlineScript(template, "__WO_PEER_JS__", peerjs),
    "__WO_SECURE_CHANNEL__",
    secureChannel,
  ),
  "__WO_MOBILE_RUNTIME__",
  runtimeSource,
);

const unresolvedMarker = ["__WO_PEER_JS__", "__WO_SECURE_CHANNEL__", "__WO_MOBILE_RUNTIME__"]
  .find((marker) => html.includes(marker));
if (unresolvedMarker) {
  throw new Error(`Generated mobile page contains unresolved marker: ${unresolvedMarker}`);
}

for (const output of [
  join(here, "dist", "index.html"),
  join(root, "native-host", "web", "index.html"),
]) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, html, "utf8");
}

function sanitize(source) {
  return String(source || "").replace(/<\/script/gi, "<\\/script");
}

function injectInlineScript(source, marker, script) {
  if (!source.includes(marker)) {
    throw new Error(`Mobile page template is missing marker: ${marker}`);
  }
  return source.replace(marker, () => sanitize(script));
}
