// Web-Omni v4.2 Background Service Worker
importScripts("shared/action-registry.js");

"use strict";

const actionRegistry = globalThis.WebOmniActionRegistry;
if (!actionRegistry) throw new Error("Web-Omni action registry failed to load.");

const { ERROR_CODES } = actionRegistry;
const WO_VERSION = "4.2.0";
const WO_RECORDER_PORT = "wo-screen-recorder";
const WO_RECORDER_PAGE = "screen-recorder/index.html";
const WO_VAULT_PORT = "wo-vault-service";
const WO_VAULT_PAGE = "vault/index.html";
const WO_VAULT_QUICK_PAGE = "vault/quick.html";
const WO_LAN_NATIVE_HOST = "com.webomni.lan";
const WO_LAN_NATIVE_PAGE = "lan-transfer/index.html";
const WO_LAN_NATIVE_READY_TIMEOUT_MS = 4000;
const MAIN_WORLD_BRIDGE = "content-scripts/main-world-bridge.js";
const MODULE_STATE = new Map();
const ACTIVE_ACTIONS_STORAGE_KEY = "woActiveActionsByTab";
const GLOBAL_PRIVACY_SETTINGS_KEY = "woGlobalPrivacySettings";
const GLOBAL_PRIVACY_ACTION = "GLOBAL_PRIVACY_MODE";
const MEDIA_CAPTURE_TTL_MS = 10 * 60 * 1000;
const MEDIA_CAPTURE_LIMIT = 500;
const MEDIA_CAPTURE_SESSIONS = new Map();
const GLOBAL_PRIVACY_DEFAULT_OPTIONS = Object.freeze({
  blockTrackers: true,
  fingerprintProtection: true,
  webrtcProtection: false,
  stripReferrer: true,
  pageShield: false,
  adBlocking: true,
  youtubeCompatibility: true,
  customAdSelectors: Object.freeze([]),
});
const ACTION_STATE_SCRIPTS = Object.freeze([
  "shared/action-registry.js",
  "content-scripts/action-state.js",
]);
const ACTION_STATE_STYLES = Object.freeze([
  "styles/command-surface.css",
  "styles/action-dock.css",
]);
const ACTIVE_ACTION_STATE = new Map();
const VAULT_REQUEST_TIMEOUT_MS = 15000;
let activeActionStateReady = null;
let globalPrivacyLatestRevision = 0;
let woLanNativePort = null;
let woLanNativeDescriptor = null;
let woLanNativeConnectPromise = null;
let woLanNativeConnectResolve = null;
let woLanNativeConnectReject = null;
let woLanNativeReadyTimer = null;
const woLanNativeOwners = new Set();

console.log(`Web-Omni v${WO_VERSION} Background Worker started`);

class ActionDispatchError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "ActionDispatchError";
    this.code = code || ERROR_CODES.ACTION_FAILED;
    this.details = details || null;
  }
}

function errorMessage(error) {
  return error && error.message ? error.message : String(error || "Unknown error");
}

function actionSuccess(action, tabId, status, data) {
  const response = { ok: true, action, tabId, status };
  if (data !== undefined) response.data = data;
  return response;
}

function actionFailure(action, tabId, code, message, details) {
  const error = { code: code || ERROR_CODES.ACTION_FAILED, message: String(message || "Action failed.") };
  if (details) error.details = details;
  return { ok: false, action: action || null, tabId: Number.isInteger(tabId) ? tabId : null, status: "failed", error };
}

function responseFromError(action, tabId, error, fallbackCode) {
  return actionFailure(
    action,
    tabId,
    error && error.code ? error.code : (fallbackCode || ERROR_CODES.ACTION_FAILED),
    errorMessage(error),
    error && error.details ? error.details : null
  );
}

function actionResponseFromResult(action, tabId, result, fallbackStatus) {
  if (!result || typeof result !== "object") {
    return actionSuccess(action, tabId, fallbackStatus || "dispatched", result);
  }

  const status = typeof result.status === "string" ? result.status : (fallbackStatus || "completed");
  const response = { ok: true, action, tabId, status };
  if (result.data !== undefined) {
    response.data = result.data;
  } else {
    const data = {};
    for (const [key, value] of Object.entries(result)) {
      if (!["ok", "action", "tabId", "status", "error", "limitations"].includes(key)) data[key] = value;
    }
    if (Object.keys(data).length) response.data = data;
  }
  if (Array.isArray(result.limitations) && result.limitations.length) {
    response.limitations = result.limitations.slice();
  }
  return response;
}

function mediaCandidateKind(url, mimeType) {
  const raw = String(url || "").toLowerCase();
  const mime = String(mimeType || "").toLowerCase();
  if (/\.m3u8(?:$|[?#])|application\/(?:vnd\.apple\.mpegurl|x-mpegurl)/i.test(`${raw} ${mime}`)) return "manifest";
  if (/\.mpd(?:$|[?#])|application\/dash\+xml/i.test(`${raw} ${mime}`)) return "manifest";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (/\.(?:m4s|ts|cmfv|cmfa)(?:$|[?#])/i.test(raw)) return "segment";
  if (/\.(?:m4a|aac|mp3|opus|ogg|flac)(?:$|[?#])/i.test(raw)) return "audio";
  if (/\.(?:mp4|webm|flv|mov|mkv)(?:$|[?#])/i.test(raw)) return "video";
  return "media";
}

function mediaSegmentTrackPath(pathname) {
  const value = String(pathname || "");
  if (!/\.(?:m4s|ts|cmfv|cmfa)$/i.test(value)) return value;
  return value
    .replace(/(^|\/)\d+(?=\.(?:m4s|ts|cmfv|cmfa)$)/i, "$1*")
    .replace(/((?:segment|seg|fragment|frag|chunk|part)[-_.]?)\d+(?=\.(?:m4s|ts|cmfv|cmfa)$)/i, "$1*");
}

function mediaMimeFromUrl(url) {
  try {
    const raw = new URL(url).searchParams.get("mime");
    return raw ? decodeURIComponent(raw).split(";")[0].toLowerCase() : "";
  } catch (_) {
    return "";
  }
}

function isMediaRequest(details) {
  const url = String(details && details.url || "");
  return details && details.tabId >= 0 && (
    details.type === "media" ||
    /googlevideo\.com|bilivideo\.com|videoplayback|\.(?:m3u8|mpd|mp4|m4s|webm|flv|ts|m4a|aac|mp3|opus)(?:$|[?#])/i.test(url)
  );
}

function mediaRequestGroupId(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.includes("googlevideo.com") || parsed.pathname.includes("videoplayback")) {
      return `youtube:${parsed.searchParams.get("itag") || parsed.pathname}`;
    }
    if (host.includes("bilivideo.com")) return `bilibili:${parsed.pathname}`;
    ["range", "rn", "rbuf", "sq", "bytestart", "byteend"].forEach((key) => parsed.searchParams.delete(key));
    if (/\.(?:m4s|ts|cmfv|cmfa)$/i.test(parsed.pathname)) {
      parsed.pathname = mediaSegmentTrackPath(parsed.pathname);
      ["segment", "seg", "fragment", "frag", "chunk", "part", "start", "end"].forEach((key) => parsed.searchParams.delete(key));
    }
    return `${parsed.origin}${parsed.pathname}?${parsed.searchParams.toString()}`.slice(0, 800);
  } catch (_) {
    return String(url || "").slice(0, 800);
  }
}

function mediaRequestSite(url) {
  const value = String(url || "").toLowerCase();
  if (value.includes("googlevideo.com") || value.includes("videoplayback")) return "youtube";
  if (value.includes("bilivideo.com") || value.includes("bilibili.com")) return "bilibili";
  return "generic";
}

function purgeExpiredMediaSessions() {
  const cutoff = Date.now() - MEDIA_CAPTURE_TTL_MS;
  for (const [tabId, session] of MEDIA_CAPTURE_SESSIONS) {
    if (session.updatedAt < cutoff) MEDIA_CAPTURE_SESSIONS.delete(tabId);
  }
}

function createMediaCaptureSession(tabId, pageUrl, filter) {
  purgeExpiredMediaSessions();
  const session = {
    tabId,
    sessionId: typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    pageUrl: String(pageUrl || ""),
    filter: filter === "audio" ? "audio" : "all",
    revision: 1,
    candidates: new Map(),
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  MEDIA_CAPTURE_SESSIONS.set(tabId, session);
  return session;
}

function recordMediaRequest(details, responseHeaders) {
  const session = MEDIA_CAPTURE_SESSIONS.get(details && details.tabId);
  if (!session || !isMediaRequest(details)) return;
  const url = String(details.url || "").slice(0, 8192);
  const headers = Array.isArray(responseHeaders) ? responseHeaders : [];
  const isResponse = headers.length > 0;
  const headerValue = (name) => {
    const item = headers.find((header) => String(header.name || "").toLowerCase() === name);
    return item ? String(item.value || "") : "";
  };
  const responseMime = headerValue("content-type").split(";")[0].trim().toLowerCase();
  const mimeType = responseMime || mediaMimeFromUrl(url);
  let kind = mediaCandidateKind(url, mimeType);
  const contentRange = headerValue("content-range");
  const fragmented = kind === "segment" || /\.(?:m4s|ts|cmfv|cmfa)(?:$|[?#])/i.test(url) || Boolean(contentRange) || /[?&]range=/i.test(url);
  if (kind === "media" && mimeType.startsWith("audio/")) kind = "audio";
  if (kind === "media" && mimeType.startsWith("video/")) kind = "video";
  const groupId = mediaRequestGroupId(url);
  const previous = session.candidates.get(groupId);
  if (kind === "segment") {
    if (mimeType.startsWith("audio/") || (previous && previous.kind === "audio")) kind = "audio";
    else kind = "video";
  }
  const site = mediaRequestSite(url);
  const separateTrack = site === "youtube" || kind === "audio" || fragmented;
  const candidate = {
    id: groupId,
    groupId,
    url,
    kind,
    source: "network",
    sources: ["network"],
    site,
    mimeType: mimeType || (previous && previous.mimeType) || "",
    codecs: "",
    width: 0,
    height: 0,
    fps: "",
    bitrate: 0,
    contentLength: headerValue("content-length") || (previous && previous.contentLength) || "",
    quality: "",
    title: "",
    fragmented,
    separateTrack,
    ciphered: false,
    encrypted: false,
    downloadable: /^https?:/i.test(url) && ["video", "audio"].includes(kind) && !fragmented && !separateTrack,
    reason: fragmented
      ? "网络分片已按轨道聚合，不作为完整文件下载。"
      : (kind === "manifest"
        ? "流媒体清单可复制到兼容工具。"
        : (separateTrack ? "独立音频或视频网络轨道，仅提供信息。" : "标签页媒体网络请求。")),
    expiresAt: null,
    observations: (Number(previous && previous.observations) || 0) + (isResponse && previous ? 0 : 1),
    bytesObserved: (Number(previous && previous.bytesObserved) || 0) + (isResponse ? (Number(headerValue("content-length")) || 0) : 0),
    requestId: details.requestId,
    frameId: Number(details.frameId) || 0,
    updatedAt: Date.now(),
  };
  if (previous && Array.isArray(previous.sources)) candidate.sources = Array.from(new Set([...previous.sources, "network"]));
  session.candidates.set(groupId, candidate);
  while (session.candidates.size > MEDIA_CAPTURE_LIMIT) {
    session.candidates.delete(session.candidates.keys().next().value);
  }
  session.revision += 1;
  session.updatedAt = Date.now();
}

function mediaCaptureSnapshot(session) {
  const candidates = Array.from(session.candidates.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  const counts = candidates.reduce((result, item) => {
    result[item.kind] = (result[item.kind] || 0) + 1;
    return result;
  }, {});
  return {
    active: true,
    phase: "monitoring",
    scope: "tab",
    sessionId: session.sessionId,
    pageUrl: session.pageUrl,
    revision: session.revision,
    count: candidates.length,
    reversibleCount: 1,
    counts,
    candidates,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
  };
}

function resetMediaCaptureForSpa(tabId, pageUrl) {
  const session = MEDIA_CAPTURE_SESSIONS.get(tabId);
  if (!session) return;
  session.pageUrl = String(pageUrl || "");
  session.candidates.clear();
  session.revision += 1;
  session.updatedAt = Date.now();
}

function sanitizeMediaFilename(value, fallback) {
  const name = String(value || fallback || "media")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 180);
  return name || "media";
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => recordMediaRequest(details),
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => recordMediaRequest(details, details.responseHeaders),
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"]
);

function createTabActivityState() {
  return { revision: 0, updatedAt: 0, actions: new Map() };
}

function serializeActiveActionState() {
  const serialized = {};
  for (const [tabId, tabState] of ACTIVE_ACTION_STATE) {
    serialized[String(tabId)] = {
      revision: tabState.revision,
      updatedAt: tabState.updatedAt,
      actions: Object.fromEntries(
        Array.from(tabState.actions, ([action, state]) => [action, { ...state }])
      ),
    };
  }
  return serialized;
}

function ensureActiveActionStateLoaded() {
  if (activeActionStateReady) return activeActionStateReady;
  activeActionStateReady = chrome.storage.session.get([ACTIVE_ACTIONS_STORAGE_KEY])
    .then((stored) => {
      const saved = stored && stored[ACTIVE_ACTIONS_STORAGE_KEY];
      if (!saved || typeof saved !== "object") return;
      for (const [tabIdValue, rawTabState] of Object.entries(saved)) {
        const tabId = Number(tabIdValue);
        if (!Number.isInteger(tabId) || !rawTabState || typeof rawTabState !== "object") continue;
        const tabState = createTabActivityState();
        tabState.revision = Number(rawTabState.revision) || 0;
        tabState.updatedAt = Number(rawTabState.updatedAt) || 0;
        const rawActions = rawTabState.actions && typeof rawTabState.actions === "object"
          ? rawTabState.actions
          : {};
        for (const [action, rawState] of Object.entries(rawActions)) {
          const entry = actionRegistry.getAction(action);
          if (!entry || !entry.stateful) continue;
          if (!rawState || typeof rawState !== "object") continue;
          tabState.actions.set(action, {
            action,
            active: Boolean(rawState.active),
            phase: String(rawState.phase || (rawState.active ? "active" : "inactive")),
            scope: String(rawState.scope || entry.scope),
            count: Math.max(0, Number(rawState.count) || 0),
            reversibleCount: Math.max(0, Number(rawState.reversibleCount) || 0),
            revision: Math.max(0, Number(rawState.revision) || 0),
            updatedAt: Math.max(0, Number(rawState.updatedAt) || 0),
            error: rawState.error ? String(rawState.error) : null,
          });
        }
        if (tabState.actions.size || tabState.revision || tabState.updatedAt) {
          ACTIVE_ACTION_STATE.set(tabId, tabState);
        }
      }
    })
    .catch((error) => {
      console.warn("[WO] Unable to restore active action state:", errorMessage(error));
    });
  return activeActionStateReady;
}

async function persistActiveActionState() {
  await chrome.storage.session.set({
    [ACTIVE_ACTIONS_STORAGE_KEY]: serializeActiveActionState(),
  });
}

function getTabActivityState(tabId, create) {
  let state = ACTIVE_ACTION_STATE.get(tabId);
  if (!state && create) {
    state = createTabActivityState();
    ACTIVE_ACTION_STATE.set(tabId, state);
  }
  return state || null;
}

function normalizeReportedActionState(action, reported, previous, revision) {
  const entry = actionRegistry.getAction(action);
  const source = reported && typeof reported === "object" ? reported : {};
  const prior = previous || {};
  const active = source.active === undefined ? Boolean(prior.active) : Boolean(source.active);
  const allowedScopes = new Set(Object.values(actionRegistry.SCOPES || {}));
  const requestedScope = source.scope || prior.scope;
  return {
    action,
    active,
    phase: String(source.phase || prior.phase || (active ? "active" : "inactive")),
    scope: typeof requestedScope === "string" && allowedScopes.has(requestedScope)
      ? requestedScope
      : ((entry && entry.scope) || "page"),
    count: Math.max(0, Number(source.count === undefined ? prior.count : source.count) || 0),
    reversibleCount: Math.max(
      0,
      Number(source.reversibleCount === undefined ? prior.reversibleCount : source.reversibleCount) || 0
    ),
    revision,
    updatedAt: Math.max(0, Number(source.updatedAt) || 0) || Date.now(),
    error: source.error ? String(source.error) : null,
  };
}

function baseActiveActionsSnapshot(tabId) {
  const tabState = getTabActivityState(tabId, false);
  return {
    tabId,
    revision: tabState ? tabState.revision : 0,
    updatedAt: tabState ? tabState.updatedAt : 0,
    actions: tabState ? Array.from(tabState.actions.values(), (state) => ({ ...state })) : [],
  };
}

async function getActiveActionsSnapshot(tabId) {
  await ensureActiveActionStateLoaded();
  const snapshot = baseActiveActionsSnapshot(tabId);

  if (recorderState.status !== "idle") {
    snapshot.actions.push({
      action: "OPEN_SCREEN_RECORDER",
      active: true,
      phase: recorderState.status,
      scope: "system",
      count: 1,
      reversibleCount: 0,
      revision: snapshot.revision,
      updatedAt: recorderState.startedAt || snapshot.updatedAt || Date.now(),
      error: null,
    });
  }

  try {
    const stored = await chrome.storage.local.get([
      "woDomMonitors",
      "woInputTMEnabled",
      GLOBAL_PRIVACY_SETTINGS_KEY,
    ]);
    const monitors = Array.isArray(stored.woDomMonitors) ? stored.woDomMonitors : [];
    if (monitors.length) {
      const existingIndex = snapshot.actions.findIndex((state) => state.action === "DOM_MONITOR_ADD");
      const existing = existingIndex >= 0 ? snapshot.actions[existingIndex] : null;
      const monitorState = {
        ...(existing || {}),
        action: "DOM_MONITOR_ADD",
        active: true,
        phase: existing && existing.phase === "selecting" ? "selecting" : "monitoring",
        scope: "durable",
        count: monitors.length,
        reversibleCount: existing ? existing.reversibleCount : 0,
        revision: existing ? existing.revision : snapshot.revision,
        updatedAt: existing ? existing.updatedAt : (snapshot.updatedAt || Date.now()),
        error: existing ? existing.error : null,
      };
      if (existingIndex >= 0) snapshot.actions[existingIndex] = monitorState;
      else snapshot.actions.push(monitorState);
    }
    if (stored.woInputTMEnabled === true) {
      const existingIndex = snapshot.actions.findIndex((state) => state.action === "INPUT_TM_TOGGLE");
      const existing = existingIndex >= 0 ? snapshot.actions[existingIndex] : null;
      const inputState = {
        ...(existing || {}),
        action: "INPUT_TM_TOGGLE",
        active: true,
        phase: "active",
        scope: "global",
        count: existing ? existing.count : 0,
        reversibleCount: existing ? existing.reversibleCount : 0,
        revision: existing ? existing.revision : snapshot.revision,
        updatedAt: existing ? existing.updatedAt : (snapshot.updatedAt || Date.now()),
        error: existing ? existing.error : null,
      };
      if (existingIndex >= 0) snapshot.actions[existingIndex] = inputState;
      else snapshot.actions.push(inputState);
    }
    const globalPrivacy = stored[GLOBAL_PRIVACY_SETTINGS_KEY];
    const privacyIndex = snapshot.actions.findIndex((state) => state.action === GLOBAL_PRIVACY_ACTION);
    if (globalPrivacy && globalPrivacy.enabled === true) {
      const existing = privacyIndex >= 0 ? snapshot.actions[privacyIndex] : null;
      const options = normalizeGlobalPrivacyOptions(globalPrivacy.options, GLOBAL_PRIVACY_DEFAULT_OPTIONS);
      const enabledOptionCount = [
        "blockTrackers",
        "fingerprintProtection",
        "webrtcProtection",
        "stripReferrer",
        "pageShield",
        "adBlocking",
      ].filter((key) => options[key]).length;
      const privacyState = {
        ...(existing || {}),
        action: GLOBAL_PRIVACY_ACTION,
        active: true,
        phase: "active",
        scope: "global",
        count: enabledOptionCount,
        reversibleCount: 1,
        revision: existing ? existing.revision : snapshot.revision,
        updatedAt: Math.max(0, Number(globalPrivacy.updatedAt) || 0) || Date.now(),
        error: existing ? existing.error : null,
      };
      if (privacyIndex >= 0) snapshot.actions[privacyIndex] = privacyState;
      else snapshot.actions.push(privacyState);
    } else if (privacyIndex >= 0) {
      snapshot.actions.splice(privacyIndex, 1);
    }
  } catch (_) {}

  return snapshot;
}

async function broadcastActiveActions(tabId, providedSnapshot) {
  if (!Number.isInteger(tabId)) return;
  const snapshot = providedSnapshot || await getActiveActionsSnapshot(tabId);
  const message = { type: "WO_ACTIVE_ACTIONS_UPDATED", tabId, snapshot };
  await Promise.all([
    chrome.tabs.sendMessage(tabId, message).catch(() => {}),
    chrome.runtime.sendMessage(message).catch(() => {}),
  ]);
}

async function updateActiveAction(tabId, action, reportedState) {
  if (!Number.isInteger(tabId)) return null;
  const entry = actionRegistry.getAction(action);
  if (!entry || !entry.stateful) return null;
  await ensureActiveActionStateLoaded();

  const tabState = getTabActivityState(tabId, true);
  const previous = tabState.actions.get(action);
  const reportedUpdatedAt = reportedState && typeof reportedState === "object"
    ? Math.max(0, Number(reportedState.updatedAt) || 0)
    : 0;
  if (previous && reportedUpdatedAt && reportedUpdatedAt < previous.updatedAt) {
    return getActiveActionsSnapshot(tabId);
  }
  const revision = tabState.revision + 1;
  if (reportedState === null) {
    if (!previous) return getActiveActionsSnapshot(tabId);
    tabState.actions.delete(action);
  } else {
    const next = normalizeReportedActionState(action, reportedState, previous, revision);
    const inactive = !next.active
      && next.reversibleCount === 0
      && ["inactive", "disabled", "stopped", "closed", "restored", "completed"].includes(next.phase);
    if (inactive) {
      if (!previous) return getActiveActionsSnapshot(tabId);
      tabState.actions.delete(action);
    } else {
      if (sameActiveActionState(previous, next)) return getActiveActionsSnapshot(tabId);
      tabState.actions.set(action, next);
    }
  }
  tabState.revision = revision;
  tabState.updatedAt = Date.now();
  await persistActiveActionState();
  const snapshot = await getActiveActionsSnapshot(tabId);
  await broadcastActiveActions(tabId, snapshot);
  return snapshot;
}

async function clearTabActiveActions(tabId, options) {
  await ensureActiveActionStateLoaded();
  const discard = Boolean(options && options.discard);
  if (discard) {
    if (!ACTIVE_ACTION_STATE.delete(tabId)) return;
    await persistActiveActionState();
    return;
  }
  const previous = getTabActivityState(tabId, false);
  const cleared = createTabActivityState();
  cleared.revision = (previous ? previous.revision : 0) + 1;
  cleared.updatedAt = Date.now();
  ACTIVE_ACTION_STATE.set(tabId, cleared);
  await persistActiveActionState();
  await broadcastActiveActions(tabId, await getActiveActionsSnapshot(tabId));
}

function explicitBoolean(source, keys) {
  if (!source || typeof source !== "object") return undefined;
  for (const key of keys) {
    if (typeof source[key] === "boolean") return source[key];
  }
  return undefined;
}

function sameActiveActionState(left, right) {
  if (!left || !right) return false;
  return left.active === right.active
    && left.phase === right.phase
    && left.scope === right.scope
    && left.count === right.count
    && left.reversibleCount === right.reversibleCount
    && left.error === right.error;
}

async function updateActionStateFromResponse(tabId, entry, payload, response) {
  if (!entry || !entry.stateful || !response || !response.ok) return;
  const mode = payload && typeof payload.mode === "string" ? payload.mode : null;
  const data = response.data && typeof response.data === "object" ? response.data : {};
  let active = explicitBoolean(data, ["active", "enabled", "isActive", "open"]);
  const responseStatus = String(response.status || "").toLowerCase();
  if (active === undefined) {
    if (["active", "enabled", "started", "starting", "opened", "picking", "monitoring"].includes(responseStatus)) {
      active = true;
    } else if (["inactive", "disabled", "stopped", "closed", "restored"].includes(responseStatus)) {
      active = false;
    }
  }
  if (active === undefined && mode === "enable") active = true;
  if (active === undefined && ["disable", "stop", "restoreAll"].includes(mode)) active = false;

  await ensureActiveActionStateLoaded();
  const previous = getTabActivityState(tabId, false)?.actions.get(entry.action);
  if (active === undefined && mode === "status") return;
  if (active === undefined) active = !Boolean(previous && previous.active);

  let reversibleCount = Number(data.reversibleCount);
  if (!Number.isFinite(reversibleCount)) {
    reversibleCount = previous ? previous.reversibleCount : 0;
    if (mode === "restoreAll") reversibleCount = 0;
    if (mode === "undo") reversibleCount = Math.max(0, reversibleCount - 1);
  }
  const count = Number.isFinite(Number(data.count)) ? Number(data.count) : (previous ? previous.count : 0);
  const reportedPhase = typeof data.phase === "string" && data.phase ? data.phase : null;
  const phase = reportedPhase || (active
    ? (responseStatus === "picking" ? "picking" : (responseStatus === "monitoring" ? "monitoring" : "active"))
    : (mode === "restoreAll" ? "restored" : "disabled"));
  const allowedScopes = new Set(Object.values(actionRegistry.SCOPES || {}));
  const scope = typeof data.scope === "string" && allowedScopes.has(data.scope)
    ? data.scope
    : entry.scope;
  await updateActiveAction(tabId, entry.action, {
    active,
    phase,
    count,
    reversibleCount,
    scope,
    updatedAt: Math.max(0, Number(data.updatedAt) || 0) || Date.now(),
  });
}

function normalizeCustomAdSelectors(value) {
  if (!Array.isArray(value)) return [];
  const normalized = [];
  const seen = new Set();
  for (const rawRule of value) {
    let rule;
    if (typeof rawRule === "string") {
      const selector = rawRule.trim();
      if (!selector || selector.length > 240) continue;
      rule = selector;
    } else if (rawRule && typeof rawRule === "object") {
      const selector = String(rawRule.selector || "").trim();
      const domain = String(rawRule.domain || "*").trim().toLowerCase();
      if (!selector || selector.length > 240 || domain.length > 253) continue;
      rule = { domain, selector };
    } else {
      continue;
    }
    const key = typeof rule === "string" ? `*\n${rule}` : `${rule.domain}\n${rule.selector}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(rule);
    if (normalized.length >= 32) break;
  }
  return normalized;
}

function normalizeGlobalPrivacyOptions(value, fallback) {
  const source = value && typeof value === "object" ? value : {};
  const prior = fallback && typeof fallback === "object" ? fallback : GLOBAL_PRIVACY_DEFAULT_OPTIONS;
  const output = {};
  for (const key of [
    "blockTrackers",
    "fingerprintProtection",
    "webrtcProtection",
    "stripReferrer",
    "pageShield",
    "adBlocking",
    "youtubeCompatibility",
  ]) {
    const aliasValue = key === "adBlocking" && typeof source.adCleanup === "boolean"
      ? source.adCleanup
      : undefined;
    output[key] = typeof source[key] === "boolean"
      ? source[key]
      : (aliasValue === undefined ? Boolean(prior[key]) : aliasValue);
  }
  output.customAdSelectors = Object.prototype.hasOwnProperty.call(source, "customAdSelectors")
    ? normalizeCustomAdSelectors(source.customAdSelectors)
    : normalizeCustomAdSelectors(prior.customAdSelectors);
  return output;
}

async function getGlobalPrivacySettings() {
  const stored = await chrome.storage.local.get([GLOBAL_PRIVACY_SETTINGS_KEY]);
  const raw = stored && stored[GLOBAL_PRIVACY_SETTINGS_KEY];
  const settings = {
    version: 2,
    enabled: Boolean(raw && raw.enabled),
    options: normalizeGlobalPrivacyOptions(raw && raw.options, GLOBAL_PRIVACY_DEFAULT_OPTIONS),
    updatedAt: Math.max(0, Number(raw && raw.updatedAt) || 0),
  };
  globalPrivacyLatestRevision = Math.max(globalPrivacyLatestRevision, settings.updatedAt);
  return settings;
}

function globalPrivacyResponseData(settings, summary) {
  const report = summary && typeof summary === "object" ? summary : {};
  return {
    active: settings.enabled,
    enabled: settings.enabled,
    phase: settings.enabled ? "active" : "disabled",
    scope: "global",
    count: Math.max(0, Number(report.appliedCount) || 0),
    reversibleCount: settings.enabled ? 1 : 0,
    revision: settings.updatedAt,
    updatedAt: settings.updatedAt,
    options: settings.options,
    appliedTabs: Array.isArray(report.appliedTabs) ? report.appliedTabs : [],
    failedTabs: Array.isArray(report.failedTabs) ? report.failedTabs : [],
    ignoredTabs: Math.max(0, Number(report.ignoredTabs) || 0),
  };
}

async function dispatchGlobalPrivacyToTab(tabId, mode, settings) {
  const entry = actionRegistry.getAction(GLOBAL_PRIVACY_ACTION);
  if (!entry) {
    return actionFailure(GLOBAL_PRIVACY_ACTION, tabId, ERROR_CODES.UNKNOWN_ACTION, "Global privacy action is not registered.");
  }

  try {
    const tab = await getTab(tabId);
    validateActionContext(entry, tab);
    const modulePresent = await confirmModule(tabId, entry.marker).catch(() => false);
    if ((mode === "disable" || mode === "status") && !modulePresent) {
      if (mode === "disable") await updateActiveAction(tabId, GLOBAL_PRIVACY_ACTION, null).catch(() => {});
      return actionSuccess(GLOBAL_PRIVACY_ACTION, tabId, mode === "status" ? "inactive" : "disabled", {
        active: false,
        enabled: false,
        phase: "inactive",
        scope: "global",
        count: 0,
        reversibleCount: 0,
        revision: settings.updatedAt,
        updatedAt: settings.updatedAt,
        options: settings.options,
        skipped: true,
      });
    }

    await ensureActionStateRuntime(tabId);
    await ensureActionModule(tabId, entry);
    const actionPayload = {
      mode,
      options: settings.options,
      revision: settings.updatedAt,
      source: "global-privacy",
    };
    const result = await chrome.tabs.sendMessage(tabId, {
      ...actionPayload,
      action: GLOBAL_PRIVACY_ACTION,
      payload: actionPayload,
    });
    if (result && result.ok === false) {
      const contentError = result.error || {};
      throw new ActionDispatchError(
        contentError.code || ERROR_CODES.ACTION_FAILED,
        contentError.message || "Global privacy mode failed on this page."
      );
    }
    const response = actionResponseFromResult(
      GLOBAL_PRIVACY_ACTION,
      tabId,
      result,
      mode === "disable" ? "disabled" : "active"
    );
    await updateActionStateFromResponse(tabId, entry, actionPayload, response).catch(() => {});
    return response;
  } catch (error) {
    return responseFromError(GLOBAL_PRIVACY_ACTION, tabId, error);
  }
}

async function syncGlobalPrivacyAcrossTabs(settings, tabIds) {
  const selectedIds = Array.isArray(tabIds) ? new Set(tabIds.filter(Number.isInteger)) : null;
  const tabs = (await chrome.tabs.query({})).filter((tab) => (
    Number.isInteger(tab.id) && (!selectedIds || selectedIds.has(tab.id))
  ));
  const eligible = tabs.filter((tab) => !actionRegistry.isRestrictedUrl(tab.url));
  const summary = {
    appliedCount: 0,
    appliedTabs: [],
    failedTabs: [],
    ignoredTabs: tabs.length - eligible.length,
  };
  let cursor = 0;
  const mode = settings.enabled ? "enable" : "disable";
  const workers = Array.from({ length: Math.min(4, eligible.length) }, async () => {
    while (cursor < eligible.length) {
      const index = cursor++;
      const tab = eligible[index];
      if (settings.updatedAt < globalPrivacyLatestRevision) return;
      const response = await dispatchGlobalPrivacyToTab(tab.id, mode, settings);
      if (response && response.ok) {
        summary.appliedCount += 1;
        summary.appliedTabs.push(tab.id);
      } else {
        summary.failedTabs.push({
          tabId: tab.id,
          code: response && response.error ? response.error.code : ERROR_CODES.ACTION_FAILED,
        });
      }
    }
  });
  await Promise.all(workers);
  return summary;
}

async function executeGlobalPrivacyAction(tabId, payload) {
  const previous = await getGlobalPrivacySettings();
  const requestedMode = payload && typeof payload.mode === "string" ? payload.mode : null;
  if (requestedMode === "status") {
    return actionSuccess(
      GLOBAL_PRIVACY_ACTION,
      tabId,
      previous.enabled ? "active" : "disabled",
      globalPrivacyResponseData(previous)
    );
  }

  const enabled = requestedMode === "enable"
    ? true
    : (requestedMode === "disable" ? false : !previous.enabled);
  const rawOptions = payload && typeof payload === "object"
    ? (payload.options || payload.config)
    : null;
  const updatedAt = Math.max(Date.now(), previous.updatedAt + 1, globalPrivacyLatestRevision + 1);
  const settings = {
    version: 2,
    enabled,
    options: normalizeGlobalPrivacyOptions(rawOptions, previous.options),
    updatedAt,
  };
  globalPrivacyLatestRevision = updatedAt;
  await chrome.storage.local.set({ [GLOBAL_PRIVACY_SETTINGS_KEY]: settings });
  const summary = await syncGlobalPrivacyAcrossTabs(settings);
  const data = globalPrivacyResponseData(settings, summary);
  await broadcastActiveActions(tabId).catch(() => {});
  return actionSuccess(GLOBAL_PRIVACY_ACTION, tabId, enabled ? "active" : "disabled", data);
}

function createIdleRecorderState() {
  return {
    status: "idle",
    startedAt: null,
    pauseStartedAt: null,
    pausedDurationMs: 0,
    recorderTabId: null,
    microphoneEnabled: false,
    filename: null,
    hasRecorderPage: false,
  };
}

let recorderState = createIdleRecorderState();
let recorderPort = null;
let vaultPort = null;
const vaultPendingRequests = new Map();

function getRecorderPageUrl() {
  return chrome.runtime.getURL(WO_RECORDER_PAGE);
}

function cloneRecorderState() {
  return { ...recorderState, hasRecorderPage: Boolean(recorderPort) };
}

function normalizeRecorderState(nextState) {
  const state = {
    ...createIdleRecorderState(),
    ...nextState,
    hasRecorderPage: Boolean(recorderPort),
  };
  if (state.status === "idle") {
    state.startedAt = null;
    state.pauseStartedAt = null;
    state.pausedDurationMs = 0;
    state.filename = null;
  }
  return state;
}

async function broadcastRecorderState() {
  const message = { type: "WO_RECORDER_STATE", state: cloneRecorderState() };
  const tabs = await chrome.tabs.query({});
  const validTabs = tabs.filter((tab) => Number.isInteger(tab.id));
  await Promise.all(validTabs.map((tab) => chrome.tabs.sendMessage(tab.id, message).catch(() => {})));
  await Promise.all(validTabs.map((tab) => broadcastActiveActions(tab.id).catch(() => {})));
}

function stripHash(url) {
  return String(url || "").split("#")[0];
}

function stripQueryAndHash(url) {
  return String(url || "").split(/[?#]/)[0];
}

async function openOrFocusInternalPage(page) {
  const targetUrl = chrome.runtime.getURL(page);
  const targetBase = stripHash(targetUrl);
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => Number.isInteger(tab.id) && stripHash(tab.url) === targetBase);

  if (existing) {
    const tab = await chrome.tabs.update(existing.id, { active: true, url: targetUrl });
    if (Number.isInteger(existing.windowId)) {
      await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    }
    return { tabId: tab.id, url: targetUrl, reused: true };
  }

  const tab = await chrome.tabs.create({ url: targetUrl });
  return { tabId: Number.isInteger(tab.id) ? tab.id : null, url: targetUrl, reused: false };
}

async function openOrFocusVaultQuick(sourceTabId) {
  const baseUrl = chrome.runtime.getURL(WO_VAULT_QUICK_PAGE);
  const targetUrl = `${baseUrl}?tabId=${encodeURIComponent(sourceTabId)}`;
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => (
    Number.isInteger(tab.id) && stripQueryAndHash(tab.url) === stripQueryAndHash(baseUrl)
  ));

  if (existing) {
    const tab = await chrome.tabs.update(existing.id, { active: true, url: targetUrl });
    if (Number.isInteger(existing.windowId)) {
      await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    }
    return {
      tabId: Number.isInteger(tab.id) ? tab.id : existing.id,
      windowId: existing.windowId,
      url: targetUrl,
      reused: true,
      quick: true,
    };
  }

  const popup = await chrome.windows.create({
    url: targetUrl,
    type: "popup",
    width: 390,
    height: 580,
    focused: true,
  });
  const tab = popup && Array.isArray(popup.tabs) ? popup.tabs[0] : null;
  return {
    tabId: tab && Number.isInteger(tab.id) ? tab.id : null,
    windowId: popup && Number.isInteger(popup.id) ? popup.id : null,
    url: targetUrl,
    reused: false,
    quick: true,
  };
}

async function openRecorderPage() {
  const result = await openOrFocusInternalPage(WO_RECORDER_PAGE);
  if (Number.isInteger(result.tabId)) {
    recorderState = normalizeRecorderState({ ...recorderState, recorderTabId: result.tabId });
  }
  return result;
}

function forwardRecorderCommand(command, payload) {
  if (!recorderPort) return false;
  recorderPort.postMessage({ type: "COMMAND", command, payload: payload || null });
  return true;
}

async function handleRecorderCommand(command, payload) {
  if (command === "OPEN_RECORDER") {
    const page = await openRecorderPage();
    return { state: cloneRecorderState(), tabId: page.tabId };
  }
  if (command === "TOGGLE_PAUSE") {
    forwardRecorderCommand("TOGGLE_PAUSE", payload);
    return { state: cloneRecorderState() };
  }
  if (command === "STOP") {
    if (!forwardRecorderCommand("STOP", payload)) {
      recorderState = normalizeRecorderState(createIdleRecorderState());
      await broadcastRecorderState();
    }
    return { state: cloneRecorderState() };
  }
  throw new ActionDispatchError(ERROR_CODES.ACTION_FAILED, `Unknown recorder command: ${command}`);
}

function getTabModuleState(tabId) {
  let state = MODULE_STATE.get(tabId);
  if (!state) {
    state = new Set();
    MODULE_STATE.set(tabId, state);
  }
  return state;
}

function moduleKey(entry) {
  return [entry.world, ...entry.styles, ...entry.scripts].join("|");
}

async function confirmModule(tabId, marker) {
  if (!marker) return true;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (name) => Boolean(globalThis[name]),
    args: [marker],
    world: "ISOLATED",
  });
  return Boolean(results[0] && results[0].result);
}

async function ensureActionStateRuntime(tabId) {
  const state = getTabModuleState(tabId);
  const key = "web-omni-action-state-runtime";
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: (currentTabId) => {
      globalThis.__webOmniTabId = currentTabId;
    },
    args: [tabId],
  });
  if (state.has(key)) return;
  if (await confirmModule(tabId, "webOmniActionStateInjected").catch(() => false)) {
    state.add(key);
    return;
  }

  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ACTION_STATE_STYLES });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ACTION_STATE_SCRIPTS,
      world: "ISOLATED",
    });
    if (!(await confirmModule(tabId, "webOmniActionStateInjected"))) {
      throw new Error("Action state runtime marker was not found after injection.");
    }
    state.add(key);
  } catch (error) {
    state.delete(key);
    throw new ActionDispatchError(
      ERROR_CODES.MODULE_LOAD_FAILED,
      `Unable to load the action state runtime: ${errorMessage(error)}`
    );
  }
}

async function ensureActionModule(tabId, entry) {
  if (!entry.scripts.length && !entry.styles.length) return;
  if (entry.scripts.includes("content-scripts/command-hub.js")) {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: (currentTabId) => {
        globalThis.__webOmniTabId = currentTabId;
      },
      args: [tabId],
    });
  }
  const key = moduleKey(entry);
  const state = getTabModuleState(tabId);
  if (state.has(key)) return;

  try {
    if (entry.styles.length) {
      await chrome.scripting.insertCSS({ target: { tabId }, files: entry.styles });
    }
    if (entry.scripts.length) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: entry.scripts,
        world: entry.world || "ISOLATED",
      });
    }
    if (!(await confirmModule(tabId, entry.marker))) {
      throw new Error(`Module marker ${entry.marker} was not found after injection.`);
    }
    state.add(key);
  } catch (error) {
    state.delete(key);
    throw new ActionDispatchError(
      ERROR_CODES.MODULE_LOAD_FAILED,
      `Unable to load ${entry.action}: ${errorMessage(error)}`
    );
  }
}

async function getTab(tabId) {
  if (!Number.isInteger(tabId)) {
    throw new ActionDispatchError(ERROR_CODES.INVALID_REQUEST, "WO_EXECUTE_ACTION requires a numeric tabId.");
  }
  try {
    return await chrome.tabs.get(tabId);
  } catch (error) {
    throw new ActionDispatchError(ERROR_CODES.INVALID_REQUEST, `Tab ${tabId} is unavailable: ${errorMessage(error)}`);
  }
}

function validateActionContext(entry, tab) {
  if (entry.internalPage) return;
  if (actionRegistry.isRestrictedUrl(tab.url)) {
    throw new ActionDispatchError(
      ERROR_CODES.RESTRICTED_URL,
      "This page does not allow extension content scripts.",
      { url: String(tab.url || "") }
    );
  }
  if (!actionRegistry.matchesContext(entry, tab.url)) {
    throw new ActionDispatchError(
      ERROR_CODES.UNSUPPORTED_CONTEXT,
      `${entry.action} is unavailable on the current page.`,
      { url: String(tab.url || ""), contexts: entry.contexts }
    );
  }
}

async function runMainWorldAction(tabId, entry, payload) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [MAIN_WORLD_BRIDGE],
      world: "MAIN",
    });
  } catch (error) {
    throw new ActionDispatchError(
      ERROR_CODES.MODULE_LOAD_FAILED,
      `Unable to load the MAIN world bridge: ${errorMessage(error)}`
    );
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async (action, actionPayload) => {
        const bridge = globalThis.__webOmniMainWorld;
        if (!bridge || typeof bridge.run !== "function") {
          return { ok: false, error: { code: "MODULE_LOAD_FAILED", message: "MAIN world bridge is unavailable." } };
        }
        return bridge.run(action, actionPayload || {});
      },
      args: [entry.action, payload || {}],
    });
    const result = results[0] ? results[0].result : undefined;
    if (result && result.ok === false) {
      const bridgeError = result.error || {};
      throw new ActionDispatchError(
        bridgeError.code || ERROR_CODES.ACTION_FAILED,
        bridgeError.message || `${entry.action} failed in the MAIN world.`,
        bridgeError.details
      );
    }
    return result;
  } catch (error) {
    if (error instanceof ActionDispatchError) throw error;
    const code = /user gesture|user activation|not allowed/i.test(errorMessage(error))
      ? ERROR_CODES.USER_GESTURE_REQUIRED
      : ERROR_CODES.ACTION_FAILED;
    throw new ActionDispatchError(code, `${entry.action} failed in the MAIN world: ${errorMessage(error)}`);
  }
}

async function executeRegisteredAction(action, tabId, payload) {
  const entry = actionRegistry.getAction(action);
  if (!entry) {
    return actionFailure(action, tabId, ERROR_CODES.UNKNOWN_ACTION, `Unknown action: ${String(action || "")}`);
  }
  if (!Number.isInteger(tabId)) {
    return actionFailure(action, tabId, ERROR_CODES.INVALID_REQUEST, "WO_EXECUTE_ACTION requires a numeric tabId.");
  }
  if (action === "WO_ACTIVE_ACTIONS_GET") {
    try {
      return actionSuccess(action, tabId, "completed", await getActiveActionsSnapshot(tabId));
    } catch (error) {
      return responseFromError(action, tabId, error);
    }
  }
  if (action === GLOBAL_PRIVACY_ACTION) {
    try {
      return await executeGlobalPrivacyAction(tabId, payload);
    } catch (error) {
      return responseFromError(action, tabId, error);
    }
  }
  if (entry.disabled) {
    return actionFailure(
      action,
      tabId,
      entry.errorCode || ERROR_CODES.ACTION_FAILED,
      entry.disabledReason || `${action} is disabled.`
    );
  }

  try {
    const tab = await getTab(tabId);
    validateActionContext(entry, tab);

    if (entry.internalPage) {
      const page = entry.action === "OPEN_SCREEN_RECORDER"
        ? await openRecorderPage()
        : (entry.action === "OPEN_VAULT"
          ? await openOrFocusVaultQuick(tabId)
          : await openOrFocusInternalPage(entry.internalPage));
      return actionSuccess(action, tabId, "opened", page);
    }

    if (entry.stateful || entry.category === "translation" || action === "TOGGLE_COMMAND_HUB") {
      await ensureActionStateRuntime(tabId);
    }

    if (action === "YT_EXTRACT_AUDIO") {
      const mediaEntry = actionRegistry.getAction("EXTRACT_MEDIA");
      await ensureActionStateRuntime(tabId);
      await ensureActionModule(tabId, mediaEntry);
      const result = await chrome.tabs.sendMessage(tabId, {
        action: "WO_MEDIA_SNIFFER_OPEN",
        payload: { mode: "enable", filter: "audio", requestedAction: action },
      });
      if (result && result.ok === false) {
        const contentError = result.error || {};
        throw new ActionDispatchError(
          contentError.code || ERROR_CODES.ACTION_FAILED,
          contentError.message || "Unable to open the media sniffer."
        );
      }
      return actionResponseFromResult(action, tabId, result, "opened");
    }

    if (entry.mainWorld) {
      const result = await runMainWorldAction(tabId, entry, payload);
      const response = actionResponseFromResult(action, tabId, result, "completed");
      await updateActionStateFromResponse(tabId, entry, payload, response).catch((error) => {
        console.warn(`[WO] Unable to update ${action} activity:`, errorMessage(error));
      });
      return response;
    }

    await ensureActionModule(tabId, entry);
    const message = {
      ...(payload && typeof payload === "object" ? payload : {}),
      action,
      payload: payload && typeof payload === "object" ? payload : undefined,
    };
    const result = await chrome.tabs.sendMessage(tabId, message);
    if (result && result.ok === false) {
      const contentError = result.error || {};
      throw new ActionDispatchError(
        contentError.code || ERROR_CODES.ACTION_FAILED,
        contentError.message || String(contentError || `${action} failed.`)
      );
    }
    const response = actionResponseFromResult(
      action,
      tabId,
      result,
      result === undefined ? "dispatched" : "completed"
    );
    await updateActionStateFromResponse(tabId, entry, payload, response).catch((error) => {
      console.warn(`[WO] Unable to update ${action} activity:`, errorMessage(error));
    });
    return response;
  } catch (error) {
    const code = /user gesture|user activation/i.test(errorMessage(error))
      ? ERROR_CODES.USER_GESTURE_REQUIRED
      : undefined;
    return responseFromError(action, tabId, error, code);
  }
}

async function executeMainWorldRequest(request, sender) {
  const action = request && request.action;
  const entry = actionRegistry.getAction(action);
  const tabId = sender && sender.tab && Number.isInteger(sender.tab.id)
    ? sender.tab.id
    : request && request.tabId;

  if (!entry) {
    return actionFailure(action, tabId, ERROR_CODES.UNKNOWN_ACTION, `Unknown action: ${String(action || "")}`);
  }
  if (!entry.mainWorld) {
    return actionFailure(
      action,
      tabId,
      ERROR_CODES.UNSUPPORTED_CONTEXT,
      `${action} is not registered for MAIN world execution.`
    );
  }
  if (!Number.isInteger(tabId)) {
    return actionFailure(action, tabId, ERROR_CODES.INVALID_REQUEST, "WO_RUN_MAIN_WORLD requires a tabId.");
  }

  try {
    const tab = await getTab(tabId);
    validateActionContext(entry, tab);
    if (entry.stateful) await ensureActionStateRuntime(tabId);
    const result = await runMainWorldAction(tabId, entry, request.payload);
    const response = actionResponseFromResult(action, tabId, result, "completed");
    if (request.suppressActivity !== true) {
      await updateActionStateFromResponse(tabId, entry, request.payload, response).catch((error) => {
        console.warn(`[WO] Unable to update ${action} activity:`, errorMessage(error));
      });
    }
    return response;
  } catch (error) {
    return responseFromError(action, tabId, error);
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function executeOnActiveTab(action, payload) {
  const tab = await getActiveTab();
  if (!tab || !Number.isInteger(tab.id)) {
    return actionFailure(action, null, ERROR_CODES.INVALID_REQUEST, "No active tab is available.");
  }
  return executeRegisteredAction(action, tab.id, payload);
}

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "wo-root", title: "Web-Omni", contexts: ["all"] });
    const menus = [
      { id: "wo-dictator", title: "元素消除" },
      { id: "wo-sticky", title: "清除悬浮膏药 (Alt+S)" },
      { id: "wo-dark", title: "暗黑模式" },
      { id: "wo-reader", title: "阅读器模式" },
      { id: "wo-seals", title: "解除复制限制" },
      { type: "separator", id: "wo-sep1" },
      { id: "wo-media", title: "提取图片/视频" },
      { id: "wo-harvest", title: "框选提取" },
      { id: "wo-markdown", title: "剪藏 Markdown" },
      { id: "wo-ecommerce", title: "电商图片爬取" },
      { id: "wo-price", title: "跨平台比价" },
      { type: "separator", id: "wo-sep2" },
      { id: "wo-clean-url", title: "复制干净链接" },
      { id: "wo-screen-recorder", title: "屏幕录制" },
      { id: "wo-pip", title: "提取为画中画" },
      { id: "wo-audio", title: "音频均衡 (护耳)" },
      { id: "wo-input-tm", title: "输入框保护 开/关" },
      { type: "separator", id: "wo-sep3" },
      { id: "wo-vault", title: "密码金库" },
      { id: "wo-privacy", title: "隐私评分扫描" },
      { id: "wo-transfer", title: "局域网传输" },
    ];
    menus.forEach((item) => {
      chrome.contextMenus.create({
        id: item.id,
        parentId: "wo-root",
        title: item.title,
        type: item.type || "normal",
        contexts: ["all"],
      });
    });
  });
}

const CONTEXT_MENU_ACTIONS = Object.freeze({
  "wo-dictator": "ACTIVATE_VISUAL_DICTATOR",
  "wo-sticky": "STICKY_KILL",
  "wo-dark": "TOGGLE_DARK_MODE",
  "wo-reader": "TOGGLE_READER_MODE",
  "wo-seals": "BREAK_SEALS",
  "wo-media": "EXTRACT_MEDIA",
  "wo-harvest": "ACTIVATE_DATA_HARVESTER",
  "wo-markdown": "EXTRACT_MARKDOWN",
  "wo-ecommerce": "ECOMMERCE_SCRAPE",
  "wo-price": "PRICE_COMPARE",
  "wo-clean-url": "CLEAN_URL_COPY",
  "wo-screen-recorder": "OPEN_SCREEN_RECORDER",
  "wo-pip": "ELEMENT_PIP",
  "wo-audio": "AUDIO_NORMALIZE_TOGGLE",
  "wo-input-tm": "INPUT_TM_TOGGLE",
  "wo-vault": "OPEN_VAULT",
  "wo-privacy": "PRIVACY_SCAN",
  "wo-transfer": "LAN_TRANSFER",
});

function nextVaultRequestId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `wo-vault-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function failVaultPendingRequests() {
  for (const pending of vaultPendingRequests.values()) {
    clearTimeout(pending.timeoutId);
    pending.resolve({
      ok: false,
      error: { code: ERROR_CODES.VAULT_LOCKED, message: "The password vault is locked or unavailable." },
      openPage: WO_VAULT_PAGE,
    });
  }
  vaultPendingRequests.clear();
}

async function relayVaultRequest(request, sender) {
  if (!vaultPort) {
    return {
      ok: false,
      error: { code: ERROR_CODES.VAULT_LOCKED, message: "Unlock the password vault before using this action." },
      openPage: WO_VAULT_PAGE,
    };
  }

  const requestId = nextVaultRequestId();
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      vaultPendingRequests.delete(requestId);
      resolve({
        ok: false,
        error: { code: ERROR_CODES.ACTION_FAILED, message: "The password vault did not respond in time." },
        openPage: WO_VAULT_PAGE,
      });
    }, VAULT_REQUEST_TIMEOUT_MS);

    vaultPendingRequests.set(requestId, { resolve, timeoutId });
    try {
      vaultPort.postMessage({
        type: "WO_VAULT_REQUEST",
        requestId,
        command: request.command,
        payload: request.payload || null,
        tabId: sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null,
        frameId: Number.isInteger(sender && sender.frameId) ? sender.frameId : 0,
        origin: sender && sender.origin ? sender.origin : null,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      vaultPendingRequests.delete(requestId);
      resolve({
        ok: false,
        error: { code: ERROR_CODES.VAULT_LOCKED, message: errorMessage(error) },
        openPage: WO_VAULT_PAGE,
      });
    }
  });
}

async function proxyDownload(request) {
  try {
    const headers = new Headers({ Accept: "image/webp,image/apng,image/*,*/*;q=0.8" });
    if (request.referer) headers.append("Referer", request.referer);
    const response = await fetch(request.url, {
      headers,
      referrerPolicy: "no-referrer",
      mode: "cors",
      credentials: "omit",
    });
    if (!response.ok) throw new Error(`fetch failed ${response.status}`);
    const blob = await response.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Unable to read download."));
      reader.readAsDataURL(blob);
    });
    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename: request.filename || "image.jpg",
      saveAs: false,
    });
    return { ok: true, downloadId };
  } catch (_) {
    const downloadId = await chrome.downloads.download({
      url: request.url,
      filename: request.filename || undefined,
      saveAs: false,
    });
    return { ok: true, downloadId, fallback: true };
  }
}

async function runDomMonitorChecks() {
  const stored = await chrome.storage.local.get(["woDomMonitors"]);
  const monitors = Array.isArray(stored.woDomMonitors) ? stored.woDomMonitors : [];
  if (!monitors.length) return;

  const tabs = await chrome.tabs.query({});
  const matching = tabs.filter((tab) => {
    if (!Number.isInteger(tab.id) || actionRegistry.isRestrictedUrl(tab.url)) return false;
    return monitors.some((monitor) => {
      if (!monitor) return false;
      if (monitor.url && monitor.url === tab.url) return true;
      try {
        return monitor.domain && new URL(tab.url).hostname === monitor.domain;
      } catch (_) {
        return false;
      }
    });
  });
  await Promise.all(matching.map((tab) => executeRegisteredAction("DOM_MONITOR_CHECK", tab.id).catch(() => {})));
}

async function syncInputTimeMachineAcrossTabs(enabled, tabIds) {
  const targetIds = Array.isArray(tabIds)
    ? tabIds.filter(Number.isInteger)
    : (await chrome.tabs.query({})).filter((tab) => (
      Number.isInteger(tab.id) && !actionRegistry.isRestrictedUrl(tab.url)
    )).map((tab) => tab.id);
  await Promise.all(targetIds.map(async (tabId) => {
    if (!enabled && !(await confirmModule(tabId, "webOmniInputTMInjected").catch(() => false))) return;
    await executeRegisteredAction("INPUT_TM_TOGGLE", tabId, { mode: enabled ? "enable" : "disable" }).catch(() => {});
  }));
}

/* ---------- WO_LAN_NATIVE_* bridge ---------- */
function woLanNativeSenderTabId(sender) {
  const tabId = sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
  const senderUrl = String(sender && (sender.url || sender.tab && sender.tab.url) || "").split(/[?#]/)[0];
  const expectedUrl = chrome.runtime.getURL(WO_LAN_NATIVE_PAGE).split(/[?#]/)[0];
  return Number.isInteger(tabId) && senderUrl === expectedUrl ? tabId : null;
}

function woLanNativeIsPrivateHost(hostname) {
  if (hostname === "127.0.0.1" || hostname === "localhost") return true;
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function normalizeWoLanNativeDescriptor(message) {
  if (!message || message.ok !== true || Number(message.version) !== 2 || message.host !== WO_LAN_NATIVE_HOST) {
    throw new Error(message && message.error ? message.error : "LAN native helper returned an invalid descriptor.");
  }
  const pageUrl = new URL(String(message.pageUrl || ""));
  const relayUrl = new URL(String(message.relayUrl || ""));
  if (
    pageUrl.protocol !== "http:"
    || relayUrl.protocol !== "ws:"
    || !woLanNativeIsPrivateHost(pageUrl.hostname)
    || relayUrl.hostname !== pageUrl.hostname
    || relayUrl.port !== pageUrl.port
    || relayUrl.pathname !== "/v2/ws"
    || !relayUrl.searchParams.get("token")
  ) throw new Error("LAN native helper returned unsafe local endpoints.");
  return {
    type: "ready",
    ok: true,
    version: 2,
    host: WO_LAN_NATIVE_HOST,
    pageUrl: pageUrl.href,
    relayUrl: relayUrl.href,
    privateIps: Array.isArray(message.privateIps) ? message.privateIps.slice(0, 16) : [],
    bindAddress: String(message.bindAddress || pageUrl.hostname),
    mobileReachable: message.mobileReachable !== false,
    notice: String(message.notice || ""),
    idleTimeoutSeconds: Math.max(0, Number(message.idleTimeoutSeconds) || 0),
  };
}

function resetWoLanNativePort(port, error) {
  if (port && woLanNativePort !== port) return;
  clearTimeout(woLanNativeReadyTimer);
  woLanNativeReadyTimer = null;
  woLanNativePort = null;
  woLanNativeDescriptor = null;
  const reject = woLanNativeConnectReject;
  woLanNativeConnectPromise = null;
  woLanNativeConnectResolve = null;
  woLanNativeConnectReject = null;
  if (reject) reject(error instanceof Error ? error : new Error(String(error || "LAN native helper disconnected.")));
}

function connectWoLanNative() {
  if (woLanNativePort && woLanNativeDescriptor) return Promise.resolve(woLanNativeDescriptor);
  if (woLanNativeConnectPromise) return woLanNativeConnectPromise;

  woLanNativeConnectPromise = new Promise((resolve, reject) => {
    woLanNativeConnectResolve = resolve;
    woLanNativeConnectReject = reject;
  });
  const pendingConnection = woLanNativeConnectPromise;

  let port;
  try {
    port = chrome.runtime.connectNative(WO_LAN_NATIVE_HOST);
    woLanNativePort = port;
  } catch (error) {
    resetWoLanNativePort(null, error);
    return pendingConnection;
  }

  port.onMessage.addListener((message) => {
    if (woLanNativePort !== port) return;
    if (message && message.type === "stopped") {
      resetWoLanNativePort(port, new Error("LAN native helper stopped."));
      return;
    }
    try {
      const descriptor = normalizeWoLanNativeDescriptor(message);
      woLanNativeDescriptor = descriptor;
      clearTimeout(woLanNativeReadyTimer);
      woLanNativeReadyTimer = null;
      const resolve = woLanNativeConnectResolve;
      woLanNativeConnectPromise = null;
      woLanNativeConnectResolve = null;
      woLanNativeConnectReject = null;
      if (resolve) resolve(descriptor);
    } catch (error) {
      if (message && message.ok === false) resetWoLanNativePort(port, error);
    }
  });
  port.onDisconnect.addListener(() => {
    const runtimeError = chrome.runtime.lastError;
    resetWoLanNativePort(port, new Error(runtimeError ? runtimeError.message : "LAN native helper disconnected."));
  });
  woLanNativeReadyTimer = setTimeout(() => {
    if (woLanNativePort !== port || woLanNativeDescriptor) return;
    try { port.disconnect(); } catch (_) {}
    resetWoLanNativePort(port, new Error("LAN native helper did not become ready in time."));
  }, WO_LAN_NATIVE_READY_TIMEOUT_MS);
  try {
    port.postMessage({ type: "start", protocol: 2 });
  } catch (error) {
    resetWoLanNativePort(port, error);
  }
  return pendingConnection;
}

async function acquireWoLanNative(sender) {
  const tabId = woLanNativeSenderTabId(sender);
  if (!Number.isInteger(tabId)) throw new Error("LAN native helper requests are limited to the LAN transfer page.");
  woLanNativeOwners.add(tabId);
  try {
    return await connectWoLanNative();
  } catch (error) {
    woLanNativeOwners.delete(tabId);
    throw error;
  }
}

function releaseWoLanNativeOwner(tabId) {
  if (Number.isInteger(tabId)) woLanNativeOwners.delete(tabId);
  if (woLanNativeOwners.size || !woLanNativePort) return;
  const port = woLanNativePort;
  const pendingReject = woLanNativeConnectReject;
  clearTimeout(woLanNativeReadyTimer);
  woLanNativeReadyTimer = null;
  woLanNativePort = null;
  woLanNativeDescriptor = null;
  woLanNativeConnectPromise = null;
  woLanNativeConnectResolve = null;
  woLanNativeConnectReject = null;
  if (pendingReject) pendingReject(new Error("LAN native helper request was released."));
  try { port.postMessage({ type: "stop", protocol: 2 }); } catch (_) {}
  setTimeout(() => {
    try { port.disconnect(); } catch (_) {}
  }, 300);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || typeof request !== "object") return false;

  if (request.type === "WO_LAN_NATIVE_START") {
    acquireWoLanNative(sender)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        version: 2,
        host: WO_LAN_NATIVE_HOST,
        error: errorMessage(error),
      }));
    return true;
  }

  if (request.type === "WO_LAN_NATIVE_STOP") {
    const tabId = woLanNativeSenderTabId(sender);
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, version: 2, host: WO_LAN_NATIVE_HOST, error: "Invalid LAN native helper sender." });
      return false;
    }
    releaseWoLanNativeOwner(tabId);
    sendResponse({ ok: true, version: 2, host: WO_LAN_NATIVE_HOST, stopped: woLanNativeOwners.size === 0 });
    return false;
  }

  if (request.type === "WO_EXECUTE_ACTION") {
    executeRegisteredAction(request.action, request.tabId, request.payload).then(sendResponse);
    return true;
  }

  if (request.type === "WO_ACTIVE_ACTIONS_GET") {
    const tabId = Number.isInteger(request.tabId)
      ? request.tabId
      : (sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null);
    if (!Number.isInteger(tabId)) {
      sendResponse(actionFailure(
        "WO_ACTIVE_ACTIONS_GET",
        tabId,
        ERROR_CODES.INVALID_REQUEST,
        "WO_ACTIVE_ACTIONS_GET requires a numeric tabId."
      ));
      return false;
    }
    getActiveActionsSnapshot(tabId)
      .then((snapshot) => sendResponse(actionSuccess("WO_ACTIVE_ACTIONS_GET", tabId, "completed", snapshot)))
      .catch((error) => sendResponse(responseFromError("WO_ACTIVE_ACTIONS_GET", tabId, error)));
    return true;
  }

  if (request.type === "WO_ACTION_STATE_CHANGED") {
    const tabId = sender.tab && Number.isInteger(sender.tab.id)
      ? sender.tab.id
      : request.tabId;
    const entry = actionRegistry.getAction(request.action);
    if (!Number.isInteger(tabId) || !entry || !entry.stateful) {
      sendResponse(actionFailure(
        request.action,
        tabId,
        !entry ? ERROR_CODES.UNKNOWN_ACTION : ERROR_CODES.INVALID_REQUEST,
        !entry ? "The reported action is not registered." : "The action state report is invalid."
      ));
      return false;
    }
    updateActiveAction(tabId, request.action, request.state === null ? null : request.state)
      .then((snapshot) => sendResponse(actionSuccess(request.action, tabId, "updated", snapshot)))
      .catch((error) => sendResponse(responseFromError(request.action, tabId, error)));
    return true;
  }

  if (request.type === "WO_RUN_MAIN_WORLD") {
    executeMainWorldRequest(request, sender).then(sendResponse);
    return true;
  }

  const mediaSessionMode = request.type === "WO_MEDIA_SESSION"
    ? request.mode
    : (request.type === "WO_MEDIA_CAPTURE_START"
      ? "start"
      : (request.type === "WO_MEDIA_CAPTURE_GET"
        ? "snapshot"
        : (request.type === "WO_MEDIA_CAPTURE_STOP" ? "stop" : null)));

  if (request.type === "WO_MEDIA_SESSION" && !["start", "snapshot", "stop"].includes(mediaSessionMode)) {
    const tabId = sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
    sendResponse(actionFailure("EXTRACT_MEDIA", tabId, ERROR_CODES.INVALID_REQUEST, "WO_MEDIA_SESSION requires mode start, snapshot, or stop."));
    return false;
  }

  if (mediaSessionMode === "start") {
    const tabId = sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
    if (!Number.isInteger(tabId)) {
      sendResponse(actionFailure("EXTRACT_MEDIA", tabId, ERROR_CODES.INVALID_REQUEST, "Media capture requires a source tab."));
      return false;
    }
    const session = createMediaCaptureSession(tabId, request.pageUrl || sender.tab.url, request.filter);
    sendResponse(actionSuccess("EXTRACT_MEDIA", tabId, "monitoring", mediaCaptureSnapshot(session)));
    return false;
  }

  if (mediaSessionMode === "snapshot") {
    const tabId = sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
    purgeExpiredMediaSessions();
    const session = Number.isInteger(tabId) ? MEDIA_CAPTURE_SESSIONS.get(tabId) : null;
    if (!session) {
      sendResponse(actionSuccess("EXTRACT_MEDIA", tabId, "inactive", {
        active: false,
        phase: "inactive",
        scope: "tab",
        count: 0,
        reversibleCount: 0,
        candidates: [],
        revision: 0,
        updatedAt: Date.now(),
      }));
      return false;
    }
    sendResponse(actionSuccess("EXTRACT_MEDIA", tabId, "monitoring", mediaCaptureSnapshot(session)));
    return false;
  }

  if (mediaSessionMode === "stop") {
    const tabId = sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
    if (Number.isInteger(tabId)) MEDIA_CAPTURE_SESSIONS.delete(tabId);
    sendResponse(actionSuccess("EXTRACT_MEDIA", tabId, "inactive", {
      active: false,
      phase: "inactive",
      scope: "tab",
      count: 0,
      reversibleCount: 0,
      candidates: [],
      updatedAt: Date.now(),
    }));
    return false;
  }

  if (request.type === "WO_MEDIA_DOWNLOAD") {
    const tabId = sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
    const candidate = request.candidate && typeof request.candidate === "object" ? request.candidate : {};
    const url = String(candidate.url || "");
    const safe = candidate.downloadable === true
      && ["video", "audio"].includes(candidate.kind)
      && !candidate.fragmented
      && !candidate.separateTrack
      && !candidate.ciphered
      && !candidate.encrypted
      && /^https?:\/\//i.test(url);
    if (!safe) {
      sendResponse(actionFailure("EXTRACT_MEDIA", tabId, ERROR_CODES.UNSUPPORTED_CONTEXT, "This media candidate is not a complete direct-download file."));
      return false;
    }
    let fallbackName = "media";
    try { fallbackName = new URL(url).pathname.split("/").pop() || fallbackName; } catch (_) {}
    chrome.downloads.download({
      url,
      filename: sanitizeMediaFilename(request.filename, fallbackName),
      saveAs: false,
    }).then((downloadId) => sendResponse(actionSuccess("EXTRACT_MEDIA", tabId, "downloading", { downloadId })))
      .catch((error) => sendResponse(responseFromError("EXTRACT_MEDIA", tabId, error)));
    return true;
  }

  if (request.type === "WO_TOGGLE_COMMAND_HUB") {
    const tabId = Number.isInteger(request.tabId)
      ? request.tabId
      : (sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null);
    executeRegisteredAction("TOGGLE_COMMAND_HUB", tabId, request.payload).then(sendResponse);
    return true;
  }

  if (request.type === "WO_COMMAND_HUB_SAMPLE_TONES") {
    sendResponse({
      ok: false,
      cached: false,
      status: "disabled",
      error: "Backdrop screenshot sampling is disabled in Web-Omni 4.2.",
    });
    return false;
  }

  if (request.type === "WO_VAULT_REQUEST") {
    relayVaultRequest(request, sender).then(sendResponse);
    return true;
  }

  if (request.type === "WO_OPEN_INTERNAL_PAGE") {
    const action = actionRegistry.findActionByInternalPage(request.page);
    const sourceTabId = sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
    if (!action) {
      sendResponse(actionFailure(
        null,
        sourceTabId,
        ERROR_CODES.INVALID_REQUEST,
        "The requested extension page is not registered."
      ));
      return false;
    }
    openOrFocusInternalPage(actionRegistry.getAction(action).internalPage)
      .then((page) => sendResponse(actionSuccess(action, sourceTabId, "opened", page)))
      .catch((error) => sendResponse(responseFromError(action, sourceTabId, error)));
    return true;
  }

  if (request.type === "DOM_MONITOR_START") {
    chrome.alarms.create("wo-dom-monitor", { periodInMinutes: 5 });
    sendResponse({ ok: true });
    return false;
  }

  if (request.type === "DOWNLOAD_FILE") {
    chrome.downloads.download({
      url: request.url,
      filename: request.filename || undefined,
      saveAs: false,
    }).then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }

  if (request.type === "PROXY_DOWNLOAD") {
    proxyDownload(request).then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }

  if (request.type === "WO_RECORDER_GET_STATE") {
    sendResponse({ state: cloneRecorderState() });
    return false;
  }

  if (request.type === "WO_RECORDER_COMMAND") {
    handleRecorderCommand(request.command, request.payload)
      .then((result) => sendResponse({ ok: true, ...(result || {}) }))
      .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }

  if (typeof request.action === "string" && sender.tab && Number.isInteger(sender.tab.id)) {
    const entry = actionRegistry.getAction(request.action);
    if (!entry) return false;
    const { action, ...payload } = request;
    executeRegisteredAction(action, sender.tab.id, payload).then(sendResponse);
    return true;
  }

  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === WO_VAULT_PORT) {
    if (vaultPort && vaultPort !== port) {
      try { vaultPort.disconnect(); } catch (_) {}
    }
    vaultPort = port;
    port.onMessage.addListener((message) => {
      if (!message || message.type !== "WO_VAULT_RESPONSE" || !message.requestId) return;
      const pending = vaultPendingRequests.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timeoutId);
      vaultPendingRequests.delete(message.requestId);
      pending.resolve(message.result === undefined ? { ok: true } : message.result);
    });
    port.onDisconnect.addListener(() => {
      if (vaultPort !== port) return;
      vaultPort = null;
      failVaultPendingRequests();
    });
    return;
  }

  if (port.name !== WO_RECORDER_PORT) return;
  const readOnly = Boolean(recorderPort && recorderPort !== port && recorderState.status !== "idle");
  if (readOnly) {
    port.postMessage({ type: "STATE_SYNC", state: cloneRecorderState(), readOnly: true });
    return;
  }
  if (recorderPort && recorderPort !== port) {
    try { recorderPort.disconnect(); } catch (_) {}
  }
  recorderPort = port;
  recorderState = normalizeRecorderState({
    ...recorderState,
    recorderTabId: port.sender && port.sender.tab ? port.sender.tab.id : recorderState.recorderTabId,
  });
  port.postMessage({ type: "STATE_SYNC", state: cloneRecorderState(), readOnly: false });
  broadcastRecorderState().catch(() => {});

  port.onMessage.addListener((message) => {
    if (!message || message.type !== "STATE_UPDATE") return;
    recorderState = normalizeRecorderState({
      ...recorderState,
      ...message.state,
      recorderTabId: port.sender && port.sender.tab ? port.sender.tab.id : recorderState.recorderTabId,
    });
    broadcastRecorderState().catch(() => {});
  });
  port.onDisconnect.addListener(() => {
    if (recorderPort !== port) return;
    recorderPort = null;
    recorderState = normalizeRecorderState(createIdleRecorderState());
    broadcastRecorderState().catch(() => {});
  });
});

chrome.commands.onCommand.addListener((command) => {
  const action = command === "toggle-command-hub"
    ? "TOGGLE_COMMAND_HUB"
    : (command === "sticky-kill" ? "STICKY_KILL" : null);
  if (!action) return;
  executeOnActiveTab(action).then((result) => {
    if (!result.ok) console.warn(`[WO] ${action} failed:`, result.error);
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const action = CONTEXT_MENU_ACTIONS[info.menuItemId];
  if (!action || !tab || !Number.isInteger(tab.id)) return;
  executeRegisteredAction(action, tab.id).then((result) => {
    if (!result.ok) console.warn(`[WO] ${action} failed:`, result.error);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "wo-dom-monitor") runDomMonitorChecks().catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (!changes.woInputTMEnabled && !changes.woDomMonitors && !changes[GLOBAL_PRIVACY_SETTINGS_KEY]) return;
  if (
    changes.woInputTMEnabled &&
    changes.woInputTMEnabled.oldValue !== changes.woInputTMEnabled.newValue
  ) {
    syncInputTimeMachineAcrossTabs(changes.woInputTMEnabled.newValue === true).catch(() => {});
  }
  chrome.tabs.query({})
    .then((tabs) => Promise.all(
      tabs
        .filter((tab) => Number.isInteger(tab.id))
        .map((tab) => broadcastActiveActions(tab.id).catch(() => {}))
    ))
    .catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A History API or hash update keeps the same document and its active tools alive.
  // Only a real document navigation invalidates injected modules and page-scoped state.
  if (changeInfo.status === "loading") {
    releaseWoLanNativeOwner(tabId);
    MODULE_STATE.delete(tabId);
    MEDIA_CAPTURE_SESSIONS.delete(tabId);
    clearTabActiveActions(tabId).catch(() => {});
  } else if (changeInfo.url) {
    resetMediaCaptureForSpa(tabId, changeInfo.url);
  }
  if (changeInfo.status === "complete") {
    Promise.all([
      chrome.storage.local.get(["woInputTMEnabled"])
        .then((stored) => (
          stored.woInputTMEnabled === true ? syncInputTimeMachineAcrossTabs(true, [tabId]) : null
        )),
      getGlobalPrivacySettings()
        .then((settings) => (
          settings.enabled ? syncGlobalPrivacyAcrossTabs(settings, [tabId]) : null
        )),
    ]).catch(() => {});
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  releaseWoLanNativeOwner(tabId);
  MODULE_STATE.delete(tabId);
  MEDIA_CAPTURE_SESSIONS.delete(tabId);
  clearTabActiveActions(tabId, { discard: true }).catch(() => {});
});
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  releaseWoLanNativeOwner(removedTabId);
  MODULE_STATE.delete(addedTabId);
  MODULE_STATE.delete(removedTabId);
  MEDIA_CAPTURE_SESSIONS.delete(addedTabId);
  MEDIA_CAPTURE_SESSIONS.delete(removedTabId);
  clearTabActiveActions(addedTabId, { discard: true }).catch(() => {});
  clearTabActiveActions(removedTabId, { discard: true }).catch(() => {});
});

chrome.runtime.onInstalled.addListener((details) => {
  if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === "function") {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
      console.warn("[WO] setPanelBehavior failed:", error);
    });
  }
  if (details.reason === "install") {
    chrome.storage.local.set({ woFirstRun: true, woVersion: WO_VERSION });
  } else if (details.reason === "update") {
    chrome.storage.local.set({ woVersion: WO_VERSION, woUpdated: true });
  }
  setupContextMenus();
  getGlobalPrivacySettings()
    .then((settings) => (settings.enabled ? syncGlobalPrivacyAcrossTabs(settings) : null))
    .catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  setupContextMenus();
  getGlobalPrivacySettings()
    .then((settings) => (settings.enabled ? syncGlobalPrivacyAcrossTabs(settings) : null))
    .catch(() => {});
});
