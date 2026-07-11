"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const youtube = read("content-scripts/youtube-enhancer.js");
const privacy = read("content-scripts/global-privacy-mode.js");
const background = read("background.js");
const sideHtml = read("side-panel/index.html");
const sideJs = read("side-panel/side-panel.js");
const adSection = youtube.slice(
  youtube.indexOf("// ========== 1."),
  youtube.indexOf("// ========== 2.")
);

assert.match(adSection, /woYouTubeAdSkipSettingsV1/, "YouTube skip preference must be durable");
assert.match(adSection, /clickedSkipButtons = new WeakSet/, "skip controls must be deduplicated per ad episode");
assert.match(adSection, /getAdEpisodeIdentity/, "consecutive ads must have independent click episodes");
assert.match(adSection, /YOUTUBE_ANTI_ADBLOCK_NOTICE/, "anti-adblock notices must pause compatible skipping");
assert.match(adSection, /observeEnforcementTree/, "existing enforcement prompts must be observed for visibility changes");
assert.match(adSection, /attributeFilter:\s*\[[^\]]*['"]disabled['"]/, "disabled skip buttons must be rescanned when enabled");
assert.match(adSection, /yt-navigate-start/, "SPA navigation must clean up the skipper runtime");
assert.match(adSection, /yt-navigate-finish/, "SPA navigation must restore the configured runtime");
assert.match(adSection, /pageshow/, "BFCache restores must rebind the configured runtime");
assert.doesNotMatch(adSection, /setInterval\s*\(/, "the ad skipper must not poll continuously");
assert.doesNotMatch(adSection, /playbackRate\s*=\s*16/, "the ad skipper must not accelerate ads");
assert.doesNotMatch(adSection, /\.muted\s*=\s*true/, "the ad skipper must not force mute media");
assert.doesNotMatch(adSection, /\[class\*=["']skip/, "broad skip-class selectors are not allowed");
assert.doesNotMatch(adSection, /ytp-ad-overlay-close/, "compatibility mode must only click official skip controls");
assert.match(adSection, /reversibleCount:\s*0/, "already clicked skip controls are not reversible");
assert.match(adSection, /clickedCount:\s*skippedButtonCount/, "state must expose the number of official skip clicks");
assert.match(adSection, /stored\.ok\s*&&\s*!stored\.exists/, "storage read failures must not overwrite the saved preference");
assert.match(youtube, /action:\s*['"]YT_EXTRACT_AUDIO['"][\s\S]*filter:\s*['"]audio['"]/, "YouTube audio shortcuts must open the shared media session");
assert.doesNotMatch(youtube, /playerData\?\.streamingData\?\.adaptiveFormats/, "the content script must not maintain a second player-response parser");

assert.match(privacy, /youtubeCompatibility:\s*true/, "YouTube compatibility must default to enabled");
assert.match(privacy, /key === "blockTrackers" \|\| key === "adBlocking"/, "compatibility must suppress tracker and DOM ad blocking");
assert.match(privacy, /youtube-nocookie\.com/, "embedded privacy-enhanced YouTube must be covered");
assert.match(sideHtml, /data-privacy-option="youtubeCompatibility"/, "the side panel must expose YouTube compatibility");
assert.match(sideJs, /youtubeCompatibility:\s*true/, "the side panel must preserve the compatibility default");
assert.match(background, /GLOBAL_PRIVACY_DEFAULT_OPTIONS[\s\S]*youtubeCompatibility:\s*true/, "the background must preserve the compatibility default");
assert.match(background, /function normalizeGlobalPrivacyOptions[\s\S]*["']youtubeCompatibility["']/, "the background must round-trip the compatibility option");
assert.match(background, /version:\s*2,[\s\S]*options:\s*normalizeGlobalPrivacyOptions/, "global privacy settings must migrate to version 2");
assert.match(sideJs, /version:\s*2,[\s\S]*enabled:\s*globalPrivacyState\.enabled/, "side-panel saves must use the version 2 settings shape");

const isYouTubeHost = (hostname) => hostname === "youtube.com"
  || hostname.endsWith(".youtube.com")
  || hostname === "youtu.be"
  || hostname === "youtube-nocookie.com"
  || hostname.endsWith(".youtube-nocookie.com");
assert.equal(isYouTubeHost("www.youtube.com"), true);
assert.equal(isYouTubeHost("music.youtube.com"), true);
assert.equal(isYouTubeHost("www.youtube-nocookie.com"), true);
assert.equal(isYouTubeHost("notyoutube.com"), false);

console.log("YouTube compatibility contract passed.");
