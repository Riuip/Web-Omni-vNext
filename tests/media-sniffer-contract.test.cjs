"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const manifest = JSON.parse(read("manifest.json"));
const background = read("background.js");
const bridge = read("content-scripts/main-world-bridge.js");
const harvester = read("content-scripts/data-harvester.js");

assert.ok(manifest.permissions.includes("webRequest"), "media capture requires webRequest");
assert.match(background, /MEDIA_CAPTURE_SESSIONS\.delete\(tabId\)/, "tab cleanup must discard media sessions");
assert.match(background, /resetMediaCaptureForSpa\(tabId, changeInfo\.url\)/, "SPA URL changes must reset candidates");
assert.match(background, /request\.type === "WO_MEDIA_SESSION"/, "background must expose the unified media session interface");
assert.match(background, /request\.type === "WO_MEDIA_CAPTURE_START"/, "legacy media start messages must remain compatible");
assert.match(background, /request\.type === "WO_MEDIA_CAPTURE_GET"/, "legacy media snapshot messages must remain compatible");
assert.match(background, /request\.type === "WO_MEDIA_CAPTURE_STOP"/, "legacy media stop messages must remain compatible");
assert.match(background, /candidate\.downloadable === true/, "downloads must require an explicit safe candidate");
assert.match(background, /!candidate\.fragmented/, "fragment downloads must be rejected");
assert.match(background, /!candidate\.separateTrack/, "separate tracks must be rejected by the download boundary");
assert.match(background, /!candidate\.encrypted/, "encrypted candidates must be rejected by the download boundary");
assert.match(background, /const MEDIA_CAPTURE_LIMIT = 500/, "background capture must retain at most 500 candidates");
assert.match(background, /const separateTrack = site === "youtube"/, "YouTube network requests must remain informational separate tracks");
assert.match(background, /function mediaSegmentTrackPath/, "numbered fragments must share a stable track grouping key");

assert.match(bridge, /PerformanceObserver/, "MAIN world capture must observe Resource Timing");
assert.match(bridge, /globalThis\.__playinfo__/, "Bilibili player snapshots must be supported");
assert.match(bridge, /getPlayerResponse/, "YouTube player snapshots must be supported");
assert.match(bridge, /MediaSource\.prototype\.addSourceBuffer/, "MSE source buffers must be observed");
assert.match(bridge, /restoreMseHooks\(\)/, "MSE wrappers must expose cleanup");
assert.match(bridge, /MAX_MEDIA_PERFORMANCE_KEYS = 2000/, "Resource Timing deduplication must be bounded");
assert.match(bridge, /catch \(_\) \{\s*restoreMseHooks\(\);\s*\}/, "partial MSE hook failures must restore native APIs");
assert.match(bridge, /&& !separateTrack\s*&& !fragmented\s*&& !ciphered\s*&& !encrypted/, "MAIN world candidates must reject unsafe downloads");
assert.match(bridge, /drmFamilies/, "player DRM family metadata must be recognized");
assert.match(bridge, /licenseInfos/, "player license metadata must be recognized");
assert.match(bridge, /contentProtection/, "format content protection metadata must be recognized");
assert.match(bridge, /raw\.downloadable !== false/, "explicit download flags must not bypass normalized candidate checks");
assert.match(bridge, /if \(previous && !metadataChanged && !observation\) return previous;/, "repeated static MAIN world candidates must not advance state");
assert.match(bridge, /source === "performance" \|\| source === "mse"/, "network and MSE events must remain real observations");
assert.match(bridge, /dispose,/, "bridge upgrades must expose disposal");

const domScanner = harvester.slice(
  harvester.indexOf("function domMediaCandidates()"),
  harvester.indexOf("function visibleMediaCandidates()")
);
assert.doesNotMatch(domScanner, /querySelectorAll\(["']\*["']\)/, "media scanning must not traverse every element");
assert.doesNotMatch(domScanner, /getComputedStyle/, "media scanning must not calculate styles for the full document");
assert.doesNotMatch(domScanner, /updatedAt:\s*Date\.now\(\)/, "repeated DOM scans must not refresh static candidate timestamps");
assert.match(harvester, /querySelectorAll\("video,audio"\)/, "DOM media scanning must be targeted");
assert.match(domScanner, /element\.poster/, "video poster images must be included");
assert.match(domScanner, /meta\[property='og:image'\]/, "Open Graph media metadata must be included");
assert.match(domScanner, /meta\[name='twitter:image'\]/, "Twitter media metadata must be included");
assert.ok(domScanner.indexOf("meta[property='og:image']") < domScanner.indexOf('querySelectorAll("img,picture source")'), "page media metadata must be scanned before bulk image candidates");
assert.match(harvester, /createMediaCandidateNode/, "candidate rows must use DOM construction");
assert.match(harvester, /title\.textContent = candidate\.title \|\| mediaUrlLabel\(candidate\)/, "signed URLs must render through textContent");
assert.match(harvester, /type: "WO_MEDIA_SESSION",\s*mode: "start"/, "the media panel must start through the unified session interface");
assert.match(harvester, /type: "WO_MEDIA_SESSION", mode: "snapshot"/, "the media panel must refresh through the unified session interface");
assert.match(harvester, /type: "WO_MEDIA_SESSION", mode: "stop"/, "closing the panel must stop the unified media session");
assert.match(harvester, /&& !raw\.separateTrack/, "content UI must reject separate-track downloads");
assert.match(harvester, /candidate\.encrypted \? "DRM\/加密"/, "encrypted candidates must be visibly labeled");
assert.match(harvester, /const kinds = \["all", "video", "audio", "manifest", "image"\]/, "the panel must expose four focused media categories plus all");
assert.doesNotMatch(harvester, /const kinds = \[[^\n]*"segment"/, "fragments must not create a separate panel category");
assert.match(harvester, /backgroundData && backgroundData\.active === false/, "an active panel must recover a lost service-worker session");
assert.match(harvester, /if \(changed \|\| sessionChanged\) \{[\s\S]*?renderMediaPanel/, "polling must redraw only after a candidate or session change");
assert.match(harvester, /mediaRevision \+= 1;\s*mediaActionState\(\);\s*renderMediaPanel\(\);/, "DOM observer discoveries must publish their updated count");
assert.match(harvester, /download\.textContent = "下载文件"/, "complete downloads must use file wording");

console.log("Media sniffer contract passed: scoped capture, MSE cleanup, safe UI, and guarded downloads.");
