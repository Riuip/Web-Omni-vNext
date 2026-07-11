"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const bridgeSource = fs.readFileSync(
  path.resolve(__dirname, "../content-scripts/main-world-bridge.js"),
  "utf8"
);

function createBridge({ hostname, href, playerResponse, playInfo }) {
  const player = playerResponse ? { getPlayerResponse: () => playerResponse } : null;
  const document = {
    documentElement: {},
    body: {},
    head: {},
    querySelector(selector) {
      return selector === "#movie_player" ? player : null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const context = vm.createContext({
    console,
    crypto: webcrypto,
    URL,
    Date,
    Math,
    document,
    location: { hostname, href },
    navigator: {},
    addEventListener() {},
    dispatchEvent() {},
    CustomEvent: class CustomEvent {},
    __playinfo__: playInfo,
  });
  vm.runInContext(bridgeSource, context, { filename: "main-world-bridge.js" });
  return context.__webOmniMainWorld;
}

function byGroup(result, groupId) {
  assert.equal(result.ok, true);
  const candidate = result.data.candidates.find((item) => item.groupId === groupId);
  assert.ok(candidate, `missing media candidate ${groupId}`);
  return candidate;
}

(async () => {
  const youtube = createBridge({
    hostname: "www.youtube.com",
    href: "https://www.youtube.com/watch?v=test",
    playerResponse: {
      streamingData: {
        formats: [{
          itag: 18,
          url: "https://r1.googlevideo.com/videoplayback?itag=18&expire=1999999999",
          mimeType: "video/mp4; codecs=\"avc1.42001E, mp4a.40.2\"",
          width: 640,
          height: 360,
        }],
        adaptiveFormats: [
          {
            itag: 140,
            url: "https://r1.googlevideo.com/videoplayback?itag=140&expire=1999999999",
            mimeType: "audio/mp4; codecs=\"mp4a.40.2\"",
          },
          {
            itag: 137,
            signatureCipher: "url=https%3A%2F%2Fr1.googlevideo.com%2Fvideoplayback%3Fitag%3D137&s=secret",
            mimeType: "video/mp4; codecs=\"avc1.640028\"",
          },
          {
            itag: 399,
            url: "https://r1.googlevideo.com/videoplayback?itag=399&expire=1999999999",
            mimeType: "video/mp4; codecs=\"av01.0.08M.08\"",
            drmFamilies: ["WIDEVINE"],
          },
        ],
        hlsManifestUrl: "https://manifest.googlevideo.com/api/manifest/hls_playlist/test.m3u8",
      },
    },
  });
  const youtubeResult = await youtube.run("WO_MEDIA_SNIFFER", { mode: "enable", sessionId: "yt-test" });
  assert.equal(byGroup(youtubeResult, "youtube:18:progressive").downloadable, true);
  assert.equal(byGroup(youtubeResult, "youtube:140:adaptive").downloadable, false);
  assert.equal(byGroup(youtubeResult, "youtube:137:adaptive").ciphered, true);
  assert.equal(byGroup(youtubeResult, "youtube:137:adaptive").downloadable, false);
  assert.equal(byGroup(youtubeResult, "youtube:399:adaptive").encrypted, true);
  assert.equal(byGroup(youtubeResult, "youtube:399:adaptive").downloadable, false);
  assert.equal(
    youtubeResult.data.candidates.some((item) => item.kind === "manifest" && item.downloadable === false),
    true
  );
  youtube.dispose();

  const bilibili = createBridge({
    hostname: "www.bilibili.com",
    href: "https://www.bilibili.com/video/BV1test",
    playInfo: {
      data: {
        dash: {
          video: [{ id: 80, baseUrl: "https://v1.bilivideo.com/video.m4s", mimeType: "video/mp4", codecs: "avc1" }],
          audio: [{ id: 30280, baseUrl: "https://v1.bilivideo.com/audio.m4s", mimeType: "audio/mp4", codecs: "mp4a" }],
        },
        durl: [{ url: "https://v1.bilivideo.com/progressive.mp4", size: 1024 }],
      },
    },
  });
  const bilibiliResult = await bilibili.run("WO_MEDIA_SNIFFER", { mode: "enable", sessionId: "bili-test" });
  assert.equal(byGroup(bilibiliResult, "bilibili:video:80").separateTrack, true);
  assert.equal(byGroup(bilibiliResult, "bilibili:video:80").downloadable, false);
  assert.equal(byGroup(bilibiliResult, "bilibili:audio:30280").downloadable, false);
  assert.equal(byGroup(bilibiliResult, "bilibili:durl:0:https://v1.bilivideo.com/progressive.mp4").downloadable, true);
  bilibili.dispose();

  const segmented = createBridge({
    hostname: "www.bilibili.com",
    href: "https://www.bilibili.com/video/BV1parts",
    playInfo: {
      data: {
        durl: [
          { url: "https://v1.bilivideo.com/part-1.mp4" },
          { url: "https://v1.bilivideo.com/part-2.mp4" },
        ],
      },
    },
  });
  const segmentedResult = await segmented.run("WO_MEDIA_SNIFFER", { mode: "enable", sessionId: "bili-parts" });
  const segmentedCandidates = segmentedResult.data.candidates.filter((item) => item.site === "bilibili");
  assert.equal(segmentedCandidates.length, 2);
  assert.equal(segmentedCandidates.every((item) => item.fragmented && !item.downloadable), true);
  segmented.dispose();

  console.log("Media adapter behavior passed: YouTube and Bilibili download boundaries are enforced.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
