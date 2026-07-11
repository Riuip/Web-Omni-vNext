// Web-Omni: LAN transfer
(function() {
  "use strict";

  const CHUNK_SIZE = 64 * 1024;
  const DEVICE_MEMORY_GB = typeof navigator !== "undefined" && typeof navigator.deviceMemory === "number"
    ? navigator.deviceMemory
    : 4;
  const RESEND_BATCH_SIZE = DEVICE_MEMORY_GB <= 2 ? 32 : 64;
  const BUFFER_HIGH_WATER_MARK = (DEVICE_MEMORY_GB <= 2 ? 12 : DEVICE_MEMORY_GB <= 4 ? 20 : 28) * CHUNK_SIZE;
  const PROGRESS_UPDATE_INTERVAL_MS = 120;
  const DEFAULT_HASH_ALGORITHM = "sha256";
  const TEXT_LIMIT_BYTES = 32 * 1024;
  const TEXT_ACK_TIMEOUT_MS = 15000;
  const PEER_OPEN_TIMEOUT_MS = 10000;
  const RECONNECT_BASE_DELAY_MS = 500;
  const RECONNECT_MAX_DELAY_MS = 4000;
  const MAX_RECONNECT_ATTEMPTS = 4;
  const DATA_CHANNEL_STALL_TIMEOUT_MS = 15000;
  const MAX_SEND_ATTEMPTS = 3;
  const FILE_COMPLETE_RETRY_MS = 2000;
  const FILE_COMPLETE_MAX_ATTEMPTS = 5;
  const MISSING_CHUNK_RETRY_MS = 1200;
  const MISSING_CHUNK_MAX_ATTEMPTS = 10;
  const COMPLETED_TRANSFER_CACHE_MS = 60000;
  const URL_PATTERN = /\b((?:https?:\/\/|www\.)[^\s<]+[^\s<.,:;"')\]\}])/gi;
  const RECEIVE_DB_NAME = "wo-lan-transfer-vnext";
  const RECEIVE_STORE_NAME = "chunks";
  const MOBILE_KIT_PORT = 8787;
  const PAGES_VERIFY_TIMEOUT_MS = 8000;
  const PAGES_VERIFY_MAX_BYTES = 256 * 1024;
  const PAGES_CLIENT_MARKER = "web-omni-lan-client";
  const CONFIG_STORAGE_KEY = "woLanTransferConfigV2";
  const LEGACY_CONFIG_STORAGE_KEY = "woLanTransferConfig";
  const LAN_MODE_STORAGE_KEY = "woLanTransferMode";
  const SIDEBAR_COLLAPSE_STORAGE_KEY = "woLanTransferSidebarCollapsed";
  const DEFAULT_SIGNAL_SERVERS = [
    { host: "0.peerjs.com", port: 443, secure: true, path: "/" },
  ];
  const DEFAULT_ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
  ];

  const $ = (id) => document.getElementById(id);
  const encoder = new TextEncoder();

  let roomCode = generateRoomCode();
  let peerId = buildPeerId(roomCode);
  let peer = null;
  let activeConn = null;
  let activeSecureTransport = null;
  let activeChunkSize = CHUNK_SIZE;
  let pendingConn = null;
  let pendingConnectionGeneration = 0;
  let peerOpenTimeout = null;
  let reconnectTimer = null;
  let peerGeneration = 0;
  let connectionGeneration = 0;
  let isPageClosing = false;
  let isGeneratingMobilePage = false;
  let isGeneratingMobileKit = false;
  let uiEventsBound = false;
  let nativeHelperAcquired = false;
  let nativeHelperWanted = false;
  let nativeHelperDescriptor = null;
  let nativeHelperStartPromise = null;
  let sidebarCollapsed = false;
  let lanMode = loadStoredLanMode();
  let secureSession = createSecureSession();
  let runtimeConfig = createRuntimeConfig(null);
  let runtimeConfigSaveQueue = Promise.resolve();

  const outgoingTransfers = new Map();
  const incomingTransfers = new Map();
  const completedIncomingTransfers = new Map();
  const pendingTextMessages = new Map();
  const receivedTextMessages = new Set();
  const sendQueue = [];
  let sendQueueRunning = false;
  const dbPromise = openTransferDb(RECEIVE_DB_NAME);
  const memoryChunkStore = new Map();
  const chunkWriteQueues = new WeakMap();
  const activeChunkWriteQueues = new Set();
  const activeObjectUrls = new Set();
  const CHUNK_WRITE_BATCH_SIZE = 8;
  const CHUNK_WRITE_BATCH_DELAY = 35;
  const ACK_BATCH_SIZE = 8;
  const ACK_MAX_DELAY = 100;

  init().catch((error) => {
    console.error("[WO Transfer] Init failed:", error);
    runtimeConfig = createRuntimeConfig(null);
    bindUiEvents();
    renderLanModeUi();
    initSidebarCollapse();
    updateRoomCodeUi();
    updateChatComposerState();
    startLanConnection();
  });

  async function init() {
    runtimeConfig = await loadRuntimeConfig();
    lanMode = runtimeConfig.preferredMode || lanMode;
    bindUiEvents();
    await initLanModeUi();
    initSidebarCollapse();
    updateRoomCodeUi();
    updateChatComposerState();
    startLanConnection();
  }

  function bindUiEvents() {
    if (uiEventsBound) return;
    uiEventsBound = true;
    $("copyCode").addEventListener("click", copyRoomCode);
    $("reconnectBtn").addEventListener("click", reconnectLanSession);
    $("downloadMobile").addEventListener("click", downloadMobilePage);
    $("downloadMobileKit").addEventListener("click", downloadMobileKit);

    document.querySelectorAll(".lan-mode-btn[data-lan-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        setLanMode(button.dataset.lanMode).catch((error) => {
          console.warn("[WO Transfer] Mode switch failed:", error);
          setStatus("连接模式切换失败。", "");
        });
      });
    });
    $("saveLanPagesUrl").addEventListener("click", saveLanPagesUrl);
    $("allowLegacyProtocol").addEventListener("change", handleLegacyProtocolChange);

    const sidebarToggle = $("sidebarToggle");
    if (sidebarToggle) {
      sidebarToggle.addEventListener("click", toggleSidebarCollapse);
    }

    const conversationSurface = $("conversationSurface");
    const fileInput = $("fileInput");
    const pickFileBtn = $("pickFileBtn");
    const chatInput = $("chatInput");
    const sendChatBtn = $("sendChatBtn");

    pickFileBtn.addEventListener("click", () => fileInput.click());

    ["dragenter", "dragover"].forEach((eventName) => {
      conversationSurface.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
        conversationSurface.classList.add("drag-over");
      });
    });

    ["dragleave", "drop"].forEach((eventName) => {
      conversationSurface.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
        conversationSurface.classList.remove("drag-over");
      });
    });

    conversationSurface.addEventListener("drop", (event) => {
      queueFiles(event.dataTransfer.files);
    });

    fileInput.addEventListener("change", (event) => {
      queueFiles(event.target.files);
      fileInput.value = "";
    });

    chatInput.addEventListener("input", updateChatComposerState);
    chatInput.addEventListener("paste", handleComposerPaste);
    chatInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendTextMessage().catch((error) => {
          console.error("[WO Transfer] Send text failed:", error);
        });
      }
    });
    sendChatBtn.addEventListener("click", () => {
      sendTextMessage().catch((error) => {
        console.error("[WO Transfer] Send text failed:", error);
      });
    });

    document.body.addEventListener("dragover", (event) => event.preventDefault());
    document.body.addEventListener("drop", (event) => {
      event.preventDefault();
      queueFiles(event.dataTransfer.files);
    });

    window.addEventListener("pagehide", cleanupRuntime, { once: true });
    window.addEventListener("beforeunload", cleanupRuntime, { once: true });
  }

  function handleComposerPaste(event) {
    const clipboardData = event.clipboardData;
    const files = extractClipboardFiles(clipboardData);
    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    queueFiles(files);
  }

  function extractClipboardFiles(clipboardData) {
    if (!clipboardData) return [];

    const results = [];
    const seenKeys = new Set();

    const pushFile = (file) => {
      if (!file) return;
      const normalized = normalizeClipboardFile(file, results.length);
      const key = [
        normalized.name,
        normalized.size,
        normalized.type,
        normalized.lastModified || 0,
      ].join("::");
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      results.push(normalized);
    };

    if (clipboardData.files && clipboardData.files.length) {
      for (const file of Array.from(clipboardData.files)) {
        pushFile(file);
      }
    }

    if (clipboardData.items && clipboardData.items.length) {
      for (const item of Array.from(clipboardData.items)) {
        if (item.kind !== "file") continue;
        pushFile(item.getAsFile());
      }
    }

    return results;
  }

  function normalizeClipboardFile(file, index) {
    if (!file) return file;
    if (file.name) return file;

    const extension = guessExtensionFromMime(file.type);
    const name = "clipboard-" + buildTimestampToken() + "-" + String(index + 1) + extension;

    try {
      return new File([file], name, {
        type: file.type || "application/octet-stream",
        lastModified: Date.now(),
      });
    } catch (error) {
      try {
        Object.defineProperty(file, "name", { value: name, configurable: true });
        Object.defineProperty(file, "lastModified", { value: Date.now(), configurable: true });
      } catch (defineError) {}
      return file;
    }
  }

  function guessExtensionFromMime(type) {
    const mime = String(type || "").toLowerCase();
    if (!mime) return ".bin";
    if (mime === "image/jpeg") return ".jpg";
    if (mime === "image/png") return ".png";
    if (mime === "image/gif") return ".gif";
    if (mime === "image/webp") return ".webp";
    if (mime === "image/bmp") return ".bmp";
    if (mime === "image/svg+xml") return ".svg";
    if (mime === "text/plain") return ".txt";
    if (mime === "text/html") return ".html";
    if (mime === "application/pdf") return ".pdf";
    const slashIndex = mime.indexOf("/");
    if (slashIndex === -1 || slashIndex === mime.length - 1) return ".bin";
    return "." + mime.slice(slashIndex + 1).replace(/[^a-z0-9.+-]/g, "");
  }

  function buildTimestampToken() {
    const now = new Date();
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      "-",
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join("");
  }

  function initSidebarCollapse() {
    applySidebarCollapse(loadStoredSidebarCollapsed());
  }

  function createSecureSession() {
    const secure = globalThis.WebOmniLanSecure;
    if (!secure || typeof secure.createSession !== "function") {
      throw new Error("LAN secure runtime is unavailable");
    }
    return secure.createSession();
  }

  function loadStoredLanMode() {
    try {
      const value = localStorage.getItem(LAN_MODE_STORAGE_KEY);
      return value === "online" || value === "local" ? value : "auto";
    } catch (_) {
      return "auto";
    }
  }

  async function initLanModeUi() {
    const input = $("lanPagesUrl");
    if (input) input.value = runtimeConfig.pagesUrl || "";
    $("allowLegacyProtocol").checked = runtimeConfig.allowLegacyProtocol;
    renderLanModeUi();
    if (lanMode === "auto" || lanMode === "local") {
      const descriptor = await requestNativeHelper().catch(() => null);
      if (descriptor) {
        applyNativeDescriptor(descriptor);
        if (lanMode === "auto" && descriptor.mobileReachable === false) releaseNativeHelper();
      }
    }
  }

  async function setLanMode(value) {
    lanMode = value === "online" || value === "local" ? value : "auto";
    try { localStorage.setItem(LAN_MODE_STORAGE_KEY, lanMode); } catch (_) {}
    await saveRuntimeConfigPatch({ preferredMode: lanMode }).catch(() => {});
    destroyPeer();

    if (lanMode === "online") {
      releaseNativeHelper();
    } else {
      const descriptor = await requestNativeHelper().catch(() => null);
      if (descriptor) {
        applyNativeDescriptor(descriptor);
        if (lanMode === "auto" && descriptor.mobileReachable === false) releaseNativeHelper();
      }
    }

    renderLanModeUi();
    updateRoomCodeUi();
    startLanConnection();
  }

  function startLanConnection() {
    const resolvedMode = resolveLanMode();
    if (resolvedMode === "unavailable") {
      setStatus("请配置在线手机入口，或安装本地助手。", "");
      updateChatComposerState();
      return;
    }
    createPeer(0);
  }

  async function reconnectLanSession() {
    regenerateRoomCode();
    if (lanMode === "auto" || lanMode === "local") {
      const descriptor = await requestNativeHelper().catch(() => null);
      if (descriptor) {
        applyNativeDescriptor(descriptor);
        if (lanMode === "auto" && descriptor.mobileReachable === false) releaseNativeHelper();
      } else {
        releaseNativeHelper();
      }
    }
    startLanConnection();
  }

  function ensureRemoteConsent() {
    if (runtimeConfig.remoteConsentAt > 0) return true;
    const allowed = confirm(
      "在线连接会访问已配置的 Pages 页面、PeerJS 信令和 STUN 服务。"
      + "Pages 主机会看到 IP 地址、User-Agent 与请求时间；PeerJS 会接收 Peer ID、SDP/ICE 协商信息和网络地址。"
      + "文件与消息内容保持端到端密文。是否允许？"
    );
    if (!allowed) return false;
    runtimeConfig.remoteConsentAt = Date.now();
    saveRuntimeConfigPatch({ remoteConsentAt: runtimeConfig.remoteConsentAt }).catch(() => {});
    return true;
  }

  function renderLanModeUi() {
    document.querySelectorAll(".lan-mode-btn[data-lan-mode]").forEach((button) => {
      const selected = button.dataset.lanMode === lanMode;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    });
    const hint = $("lanModeHint");
    const legacyInput = $("allowLegacyProtocol");
    const legacyWarning = $("lanLegacyWarning");
    if (legacyInput) legacyInput.checked = runtimeConfig.allowLegacyProtocol;
    if (legacyWarning) legacyWarning.hidden = !runtimeConfig.allowLegacyProtocol;
    if (!hint) return;
    const resolved = resolveLanMode();
    if (resolved === "local") {
      hint.textContent = runtimeConfig.localMobileReachable === false
        ? (runtimeConfig.localNotice || "本机缺少可用私网地址，手机暂时无法访问本地入口。")
        : "手机页通过私网 HTTP 加载，页面完整性依赖可信私网；传输内容仍使用应用层端到端加密。";
    } else if (resolved === "online") {
      hint.textContent = "二维码将打开已配置的 HTTPS 手机入口；会话密钥只放在 URL fragment 中。";
    } else if (lanMode === "local") {
      hint.textContent = "本地助手不可用。安装并允许浏览器启动 Native Messaging helper 后重试。";
    } else {
      hint.textContent = "请配置 Pages HTTPS 地址，或安装本地助手；当前二维码仅包含房间码。";
    }
  }

  async function handleLegacyProtocolChange(event) {
    const input = event.currentTarget;
    const requested = Boolean(input.checked);
    if (requested) {
      const confirmed = confirm(
        "旧版兼容会允许未经过 v2 加密握手的手机页连接，传输内容可能在局域网内暴露。仅在确实需要时开启。是否继续？"
      );
      if (!confirmed) {
        input.checked = false;
        return;
      }
    }
    runtimeConfig.allowLegacyProtocol = requested;
    await saveRuntimeConfigPatch({ allowLegacyProtocol: requested });
    renderLanModeUi();
    destroyPeer();
    startLanConnection();
  }

  function resolveLanMode() {
    if (lanMode === "local") return runtimeConfig.localPageUrl ? "local" : "unavailable";
    if (lanMode === "online") return runtimeConfig.pagesUrl ? "online" : "unavailable";
    if (runtimeConfig.localPageUrl) return "local";
    if (runtimeConfig.pagesUrl) return "online";
    return "unavailable";
  }

  async function saveLanPagesUrl() {
    const input = $("lanPagesUrl");
    const button = $("saveLanPagesUrl");
    const value = normalizePagesUrl(input && input.value);
    if (input && input.value.trim() && !value) {
      alert("Pages 手机入口必须是有效的 HTTPS 地址。");
      return;
    }
    if (value && !ensureRemoteConsent()) {
      setStatus("Pages 入口尚未验证：远程服务授权已取消。", "");
      return;
    }

    if (button) {
      button.disabled = true;
      button.textContent = value ? "验证中…" : "保存中…";
    }
    try {
      if (value) await verifyPagesClient(value);
    } catch (error) {
      const message = error && error.message ? error.message : "无法验证 Pages 手机入口。";
      setStatus(message, "");
      alert(message);
      return;
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "保存";
      }
    }

    runtimeConfig.pagesUrl = value;
    try {
      await saveRuntimeConfigPatch({
        pagesUrl: value,
      });
    } catch (error) {
      console.warn("[WO Transfer] Failed to save Pages URL:", error);
    }
    if (input) input.value = value;
    renderLanModeUi();
    updateRoomCodeUi();
    if (value && resolveLanMode() === "online" && !(activeConn && activeConn.open)) {
      createPeer(0);
    }
  }

  async function verifyPagesClient(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PAGES_VERIFY_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "follow",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error("Pages 手机入口验证失败：HTTP " + response.status + "。");
      }
      if (!response.url || new URL(response.url).protocol !== "https:") {
        throw new Error("Pages 手机入口跳转到了非 HTTPS 地址。");
      }
      const html = await readResponsePrefix(response, PAGES_VERIFY_MAX_BYTES);
      const documentSnapshot = new DOMParser().parseFromString(html, "text/html");
      const marker = documentSnapshot.querySelector(
        'meta[name="' + PAGES_CLIENT_MARKER + '"][content="v2"]'
      );
      if (!marker) {
        throw new Error("该地址未检测到 Web-Omni 手机客户端 v2 标记。");
      }
      return true;
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new Error("Pages 手机入口验证超时，请检查地址或网络。");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function readResponsePrefix(response, limit) {
    if (!response.body || typeof response.body.getReader !== "function") {
      return (await response.text()).slice(0, limit);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let output = "";
    let bytesRead = 0;
    try {
      while (bytesRead < limit) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = result.value || new Uint8Array();
        const remaining = Math.max(0, limit - bytesRead);
        const selected = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
        bytesRead += selected.byteLength;
        output += decoder.decode(selected, { stream: bytesRead < limit });
        if (output.includes(PAGES_CLIENT_MARKER)) break;
      }
      output += decoder.decode();
      return output;
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  function normalizePagesUrl(value) {
    try {
      const url = new URL(String(value || "").trim());
      if (url.protocol !== "https:") return "";
      url.hash = "";
      url.search = "";
      if (!url.pathname.endsWith("/")) url.pathname += "/";
      return url.href;
    } catch (_) {
      return "";
    }
  }

  function requestNativeHelper() {
    nativeHelperWanted = true;
    if (nativeHelperStartPromise) return nativeHelperStartPromise;
    nativeHelperStartPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const descriptor = value && value.ok && Number(value.version) === 2 ? value : null;
        nativeHelperAcquired = Boolean(descriptor);
        nativeHelperDescriptor = descriptor;
        if (descriptor && !nativeHelperWanted) {
          releaseNativeHelper();
          resolve(null);
          return;
        }
        resolve(descriptor);
      };
      const timer = setTimeout(() => {
        nativeHelperWanted = false;
        try { chrome.runtime.sendMessage({ type: "WO_LAN_NATIVE_STOP" }, () => void chrome.runtime.lastError); } catch (_) {}
        finish(null);
      }, 4500);
      try {
        chrome.runtime.sendMessage({ type: "WO_LAN_NATIVE_START" }, (response) => {
          if (chrome.runtime.lastError) finish(null);
          else finish(response);
        });
      } catch (_) {
        finish(null);
      }
    }).finally(() => {
      nativeHelperStartPromise = null;
    });
    return nativeHelperStartPromise;
  }

  function applyNativeDescriptor(descriptor) {
    runtimeConfig.localPageUrl = descriptor.pageUrl || "";
    runtimeConfig.localRelayUrl = descriptor.relayUrl || "";
    runtimeConfig.localMobileReachable = descriptor.mobileReachable !== false;
    runtimeConfig.localNotice = descriptor.notice || "";
    saveRuntimeConfigPatch({ localAuthorizedAt: Date.now() }).catch(() => {});
    renderLanModeUi();
    updateRoomCodeUi();
  }

  function releaseNativeHelper() {
    nativeHelperWanted = false;
    nativeHelperAcquired = false;
    nativeHelperDescriptor = null;
    runtimeConfig.localPageUrl = "";
    runtimeConfig.localRelayUrl = "";
    runtimeConfig.localMobileReachable = null;
    runtimeConfig.localNotice = "";
    try {
      chrome.runtime.sendMessage({ type: "WO_LAN_NATIVE_STOP" }, () => void chrome.runtime.lastError);
    } catch (_) {}
    if (!isPageClosing) {
      renderLanModeUi();
      updateRoomCodeUi();
    }
  }

  function buildMobileLaunchUrl() {
    const resolvedMode = resolveLanMode();
    const baseUrl = resolvedMode === "local" ? runtimeConfig.localPageUrl : runtimeConfig.pagesUrl;
    if (!baseUrl) return "";
    try {
      const url = new URL(baseUrl);
      const fragment = new URLSearchParams({
        v: "2",
        room: roomCode,
        peer: peerId,
        s: secureSession.sessionId,
        k: secureSession.pairingSecret,
      });
      if (resolvedMode === "local" && runtimeConfig.localRelayUrl) {
        fragment.set("relay", runtimeConfig.localRelayUrl);
      }
      fragment.set("config", btoa(JSON.stringify({
        signalServers: runtimeConfig.signalServers,
        iceServers: runtimeConfig.iceServers,
        hashAlgorithm: DEFAULT_HASH_ALGORITHM,
        allowLegacyProtocol: runtimeConfig.allowLegacyProtocol,
      })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""));
      url.hash = fragment.toString();
      return url.href;
    } catch (_) {
      return "";
    }
  }

  function loadStoredSidebarCollapsed() {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSE_STORAGE_KEY) === "1";
    } catch (error) {
      return false;
    }
  }

  function toggleSidebarCollapse() {
    applySidebarCollapse(!sidebarCollapsed);
  }

  function applySidebarCollapse(collapsed) {
    const layout = document.querySelector(".lan-chat-layout");
    const toggle = $("sidebarToggle");
    const isCollapsed = Boolean(collapsed);
    sidebarCollapsed = isCollapsed;

    try {
      localStorage.setItem(SIDEBAR_COLLAPSE_STORAGE_KEY, isCollapsed ? "1" : "0");
    } catch (error) {}

    if (layout) {
      layout.classList.toggle("sidebar-collapsed", isCollapsed);
      layout.dataset.sidebarState = isCollapsed ? "collapsed" : "expanded";
    }

    if (toggle) {
      toggle.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
      toggle.setAttribute("aria-label", isCollapsed ? "展开侧栏" : "折叠侧栏");
      toggle.title = isCollapsed ? "展开侧栏" : "折叠侧栏";
      const arrow = toggle.querySelector(".sidebar-toggle-arrow");
      if (arrow) {
        arrow.textContent = "←";
      }
    }
  }


  function updateChatComposerState() {
    const input = $("chatInput");
    const sendButton = $("sendChatBtn");
    const counter = $("chatCounter");
    const hint = $("chatHint");
    if (!input || !sendButton || !counter || !hint) return;

    const text = input.value || "";
    const bytes = encoder.encode(text).byteLength;
    const connected = Boolean(activeConn && activeConn.open);
    const hasText = Boolean(text.trim());

    syncChatInputHeight(input);

    counter.textContent = bytes + " / " + TEXT_LIMIT_BYTES + " 字节";
    counter.classList.toggle("over-limit", bytes > TEXT_LIMIT_BYTES);
    sendButton.disabled = !connected || !hasText || bytes > TEXT_LIMIT_BYTES;

    if (!connected) {
      hint.textContent = "连接后即可发送，也支持直接粘贴图片。";
    } else if (bytes > TEXT_LIMIT_BYTES) {
      hint.textContent = "单条消息请控制在 32 KB 内。";
    } else {
      hint.textContent = "Enter 发送，Shift + Enter 换行。";
    }
  }

  function syncChatInputHeight(input) {
    if (!input) return;

    const minHeight = 48;
    const maxHeight = 132;
    input.style.height = "0px";
    const nextHeight = Math.min(Math.max(input.scrollHeight, minHeight), maxHeight);
    input.style.height = nextHeight + "px";
    input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
  }
  function createPeer(serverIndex, retryAttempt) {
    destroyPeer();
    if (isPageClosing) return;

    const resolvedMode = resolveLanMode();
    if (resolvedMode === "unavailable") {
      setStatus("当前连接模式尚未配置。", "");
      updateChatComposerState();
      return;
    }
    if (resolvedMode === "online" && !ensureRemoteConsent()) {
      setStatus("在线模式等待远程服务授权。", "");
      updateChatComposerState();
      return;
    }

    if (resolvedMode === "local" && runtimeConfig.localRelayUrl) {
      setStatus("正在连接本地加密中继...", "connecting");
      try {
        const relayConnection = createRelayConnection(runtimeConfig.localRelayUrl, "desktop", secureSession.sessionId);
        attachConnection(relayConnection, "incoming");
      } catch (error) {
        setStatus("本地助手连接失败。", "");
        console.warn("[WO Transfer] Local relay failed:", error);
      }
      return;
    }

    const signalServers = runtimeConfig.signalServers;
    const normalizedServerIndex = Math.max(0, Math.min(serverIndex || 0, signalServers.length - 1));
    const normalizedRetryAttempt = Math.max(0, Number(retryAttempt) || 0);
    const server = signalServers[normalizedServerIndex];
    const options = {
      host: server.host,
      port: server.port,
      secure: server.secure,
      path: server.path,
      config: { iceServers: runtimeConfig.iceServers },
      debug: 1,
    };

    setStatus("正在连接信令服务...", "connecting");
    const generation = peerGeneration;
    const currentPeer = new Peer(peerId, options);
    let opened = false;
    peer = currentPeer;

    peerOpenTimeout = setTimeout(() => {
      if (!isCurrentPeer(currentPeer, generation)) return;
      schedulePeerRecreate(normalizedServerIndex, normalizedRetryAttempt, "连接信令服务超时");
    }, PEER_OPEN_TIMEOUT_MS);

    currentPeer.on("open", () => {
      if (!isCurrentPeer(currentPeer, generation)) return;
      opened = true;
      clearPeerOpenTimeout();
      clearReconnectTimer();
      updateRoomCodeUi();
      setStatus(activeConn && activeConn.open ? "设备已连接" : "等待设备连接...", activeConn && activeConn.open ? "connected" : "connecting");
      updateChatComposerState();
    });

    currentPeer.on("connection", (conn) => {
      if (!isCurrentPeer(currentPeer, generation)) {
        try { conn.close(); } catch (error) {}
        return;
      }
      attachConnection(conn, "incoming");
    });

    currentPeer.on("error", (error) => {
      if (!isCurrentPeer(currentPeer, generation)) return;
      clearPeerOpenTimeout();
      console.error("[WO Transfer] Peer error:", error);

      if (error && error.type === "unavailable-id" && normalizedRetryAttempt === 0) {
        regenerateRoomCode();
        createPeer(0);
        return;
      }

      if (opened && currentPeer.disconnected) {
        scheduleSignalReconnect(currentPeer, generation, 0);
      } else {
        schedulePeerRecreate(normalizedServerIndex, normalizedRetryAttempt, "连接错误：" + readablePeerError(error));
      }
    });

    currentPeer.on("disconnected", () => {
      if (!isCurrentPeer(currentPeer, generation)) return;
      scheduleSignalReconnect(currentPeer, generation, 0);
    });
  }

  function createRelayConnection(baseUrl, role, sessionId) {
    const url = new URL(baseUrl);
    url.searchParams.set("session", sessionId);
    url.searchParams.set("role", role);
    const socket = new WebSocket(url.href);
    const listeners = new Map();
    const emit = (type, value) => {
      const callbacks = listeners.get(type);
      if (!callbacks) return;
      callbacks.slice().forEach((callback) => callback(value));
    };
    const connection = {
      open: false,
      dataChannel: {
        get bufferedAmount() { return socket.bufferedAmount; },
      },
      on(type, callback) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(callback);
      },
      send(message) {
        if (socket.readyState !== WebSocket.OPEN) throw new Error("local relay is not open");
        socket.send(JSON.stringify(message));
      },
      close() {
        socket.close(1000, "closed");
      },
    };
    socket.addEventListener("open", () => {
      connection.open = true;
      emit("open");
    });
    socket.addEventListener("message", (event) => {
      try { emit("data", JSON.parse(String(event.data || "null"))); }
      catch (error) { emit("error", error); }
    });
    socket.addEventListener("close", () => {
      connection.open = false;
      emit("close");
    });
    socket.addEventListener("error", () => emit("error", new Error("local relay socket error")));
    return connection;
  }

  function schedulePeerRecreate(serverIndex, retryAttempt, reason) {
    clearPeerOpenTimeout();
    if (retryAttempt >= MAX_RECONNECT_ATTEMPTS || isPageClosing) {
      setStatus(reason + "，自动重连已停止。", "");
      updateChatComposerState();
      return;
    }

    const nextAttempt = retryAttempt + 1;
    const delay = getReconnectDelay(nextAttempt);
    const signalServerCount = Math.max(1, runtimeConfig.signalServers.length);
    const nextServerIndex = (serverIndex + 1) % signalServerCount;
    destroyPeer();
    setStatus(reason + "，正在重连（" + nextAttempt + "/" + MAX_RECONNECT_ATTEMPTS + "）...", "connecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      createPeer(nextServerIndex, nextAttempt);
    }, delay);
  }

  function scheduleSignalReconnect(currentPeer, generation, retryAttempt) {
    if (!isCurrentPeer(currentPeer, generation) || reconnectTimer || isPageClosing) return;
    if (retryAttempt >= MAX_RECONNECT_ATTEMPTS) {
      setStatus(activeConn && activeConn.open ? "设备已连接，信令服务暂时不可用。" : "信令服务连接已断开。", activeConn && activeConn.open ? "connected" : "");
      return;
    }

    const nextAttempt = retryAttempt + 1;
    setStatus(activeConn && activeConn.open ? "设备已连接，正在恢复信令服务..." : "连接已断开，正在重连（" + nextAttempt + "/" + MAX_RECONNECT_ATTEMPTS + "）...", activeConn && activeConn.open ? "connected" : "connecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!isCurrentPeer(currentPeer, generation)) return;
      try {
        currentPeer.reconnect();
      } catch (error) {
        console.warn("[WO Transfer] Reconnect failed:", error);
      }
      peerOpenTimeout = setTimeout(() => {
        if (!isCurrentPeer(currentPeer, generation) || !currentPeer.disconnected) return;
        scheduleSignalReconnect(currentPeer, generation, nextAttempt);
      }, PEER_OPEN_TIMEOUT_MS);
    }, getReconnectDelay(nextAttempt));
  }

  function attachConnection(conn, direction) {
    if (pendingConn && pendingConn !== conn) {
      try { pendingConn.close(); } catch (_) {}
    }
    const candidateGeneration = ++pendingConnectionGeneration;
    let promotedGeneration = 0;
    let secureTransport = null;
    pendingConn = conn;
    setStatus("正在建立设备连接...", "connecting");
    updateChatComposerState();

    const promoteConnection = (transport, legacy) => {
      if (pendingConn !== conn || pendingConnectionGeneration !== candidateGeneration || isPageClosing) return;
      const previous = activeConn;
      if (previous && previous !== conn) {
        markPendingTextMessagesFailed("发送中断");
        try { previous.close(); } catch (_) {}
      }
      activeConn = conn;
      activeSecureTransport = transport;
      activeChunkSize = transport.negotiatedCapabilities.chunkSize;
      pendingConn = null;
      promotedGeneration = ++connectionGeneration;
      setStatus(
        legacy
          ? "旧协议连接：内容未受 v2 端到端保护"
          : (direction === "incoming" ? "设备已安全连接" : "已安全连接到电脑"),
        legacy ? "" : "connected"
      );
      updateChatComposerState();
      resumePendingTransfers(conn);
      runSendQueue();
    };

    conn.on("open", () => {
      if (pendingConn !== conn || pendingConnectionGeneration !== candidateGeneration || isPageClosing) return;
      setStatus("正在验证加密会话...", "connecting");
      secureTransport = globalThis.WebOmniLanSecure.createSecureTransport(conn, {
        role: "desktop",
        sessionId: secureSession.sessionId,
        pairingSecret: secureSession.pairingSecret,
      });
      const v2Transport = secureTransport;
      v2Transport.ready.then(() => {
        if (secureTransport !== v2Transport) return;
        if (pendingConn !== conn || pendingConnectionGeneration !== candidateGeneration || isPageClosing) {
          v2Transport.close(new Error("connection superseded"));
          return;
        }
        promoteConnection(v2Transport, false);
      }).catch((error) => {
        if (secureTransport !== v2Transport) return;
        if (pendingConn === conn) pendingConn = null;
        setStatus("安全验证失败，连接已拒绝。", "");
        console.warn("[WO Transfer] Secure handshake failed:", error);
      });
    });

    conn.on("data", (message) => {
      if (!secureTransport || isPageClosing) return;
      if (
        !secureTransport.authenticated
        && runtimeConfig.allowLegacyProtocol
        && isLegacyProtocolMessage(message)
      ) {
        secureTransport.abandon(new Error("v2 handshake replaced by explicit legacy mode"));
        secureTransport = createLegacyTransport(conn);
        promoteConnection(secureTransport, true);
        Promise.resolve(handleProtocolMessage(conn, message)).catch((error) => {
          console.error("[WO Transfer] Legacy message handling failed:", error);
        });
        return;
      }
      if (secureTransport.legacy) {
        Promise.resolve(handleProtocolMessage(conn, message)).catch((error) => {
          console.error("[WO Transfer] Legacy message handling failed:", error);
        });
        return;
      }
      Promise.resolve(secureTransport.handle(message)).then((result) => {
        if (!result || !result.message) return;
        if (!isCurrentConnection(conn, promotedGeneration)) return;
        return handleProtocolMessage(conn, result.message);
      }).catch((error) => {
        console.error("[WO Transfer] Message handling failed:", error);
      });
    });

    conn.on("close", () => {
      if (pendingConn === conn) pendingConn = null;
      if (!isCurrentConnection(conn, promotedGeneration)) return;
      activeConn = null;
      activeSecureTransport = null;
      activeChunkSize = CHUNK_SIZE;
      connectionGeneration++;
      pauseIncomingTransferTimers();
      markPendingTextMessagesFailed("发送失败");
      setStatus("连接已关闭，等待重新连接...", "connecting");
      updateChatComposerState();
      if (resolveLanMode() === "local" && !reconnectTimer && !isPageClosing) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          requestNativeHelper().then((descriptor) => {
            if (!descriptor || isPageClosing) {
              releaseNativeHelper();
              startLanConnection();
              return;
            }
            applyNativeDescriptor(descriptor);
            createPeer(0);
          }).catch(() => {
            releaseNativeHelper();
            startLanConnection();
          });
        }, RECONNECT_BASE_DELAY_MS);
      }
    });

    conn.on("error", (error) => {
      if (activeConn !== conn && pendingConn !== conn) return;
      console.error("[WO Transfer] Connection error:", error);
      setStatus("连接出错：" + readablePeerError(error), "");
      updateChatComposerState();
    });
  }
  async function handleProtocolMessage(conn, message) {
    if (!message || typeof message !== "object") return;

    switch (message.type) {
      case "file-meta":
        await beginIncomingTransfer(conn, message);
        break;
      case "file-chunk":
        await receiveChunk(conn, message);
        break;
      case "file-done":
        await markIncomingDone(conn, message);
        break;
      case "file-resend-request":
        await resendMissingChunks(conn, message);
        break;
      case "file-ack":
        markOutgoingAcknowledged(message);
        break;
      case "file-complete":
        markOutgoingComplete(message);
        break;
      case "text-message":
        handleIncomingTextMessage(conn, message);
        break;
      case "text-ack":
        markTextDelivered(message);
        break;
      default:
        break;
    }
  }

  function handleIncomingTextMessage(conn, message) {
    const id = String(message.id || "");
    const text = String(message.text || "");
    if (!id || !text) return;

    if (receivedTextMessages.has(id)) {
      safeSend(conn, { type: "text-ack", id });
      return;
    }

    if (encoder.encode(text).byteLength > TEXT_LIMIT_BYTES) {
      safeSend(conn, { type: "text-ack", id });
      return;
    }

    receivedTextMessages.add(id);
    addChatMessage({
      id,
      text,
      timestamp: Number(message.timestamp || Date.now()),
      statusText: "已接收",
      direction: "incoming",
    });
    safeSend(conn, { type: "text-ack", id });
  }
  function markTextDelivered(message) {
    const id = String(message.id || "");
    const pending = pendingTextMessages.get(id);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    pendingTextMessages.delete(id);
    updateChatMessageStatus(id, "已送达", "done");
  }
  async function sendTextMessage() {
    const input = $("chatInput");
    if (!input) return;

    const text = input.value.trim();
    if (!text) {
      updateChatComposerState();
      return;
    }

    if (!activeConn || !activeConn.open) {
      updateChatComposerState();
      return;
    }

    const bytes = encoder.encode(text).byteLength;
    if (bytes > TEXT_LIMIT_BYTES) {
      updateChatComposerState();
      return;
    }

    const id = "text-" + randomId();
    const timestamp = Date.now();

    addChatMessage({
      id,
      text,
      timestamp,
      statusText: "发送中",
      direction: "outgoing",
    });

    input.value = "";
    updateChatComposerState();

    try {
      await waitForDataChannel(activeConn);
      await sendSecure(activeConn, {
        type: "text-message",
        id,
        text,
        timestamp,
        sender: "desktop",
      });

      const timeoutId = setTimeout(() => {
        pendingTextMessages.delete(id);
        updateChatMessageStatus(id, "发送失败", "error");
      }, TEXT_ACK_TIMEOUT_MS);

      pendingTextMessages.set(id, { timeoutId });
    } catch (error) {
      console.error("[WO Transfer] Text send error:", error);
      updateChatMessageStatus(id, "发送失败", "error");
    }
  }
  function ensureConversationStarted() {
    const empty = $("conversationEmpty");
    if (empty) empty.remove();
  }

  function createMessageShell(direction, kind) {
    const item = document.createElement("article");
    item.className = "conversation-item " + kind + " " + direction;

    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.textContent = direction === "outgoing" ? "我" : "设";
    avatar.title = direction === "outgoing" ? "我发送的消息" : "已连接设备";

    const stack = document.createElement("div");
    stack.className = "message-stack";

    const label = document.createElement("div");
    label.className = "message-label";
    label.textContent = direction === "outgoing" ? "我" : "文件传输助手";

    stack.appendChild(label);

    if (direction === "outgoing") {
      item.appendChild(stack);
      item.appendChild(avatar);
    } else {
      item.appendChild(avatar);
      item.appendChild(stack);
    }

    return { item, stack };
  }

  function addChatMessage(message) {
    const list = $("conversationStream");
    if (!list) return;

    ensureConversationStarted();

    const shell = createMessageShell(message.direction, "text-message");
    const item = shell.item;
    item.dataset.id = message.id;

    const bubble = document.createElement("div");
    bubble.className = "text-bubble";

    const text = document.createElement("p");
    text.className = "text-body";
    renderRichMessageText(text, message.text);

    const meta = document.createElement("div");
    meta.className = "message-meta";

    const stamp = document.createElement("span");
    stamp.textContent = (message.direction === "outgoing" ? "我" : "对方") + " · " + formatChatTime(message.timestamp);

    const actionWrap = document.createElement("div");
    actionWrap.className = "message-meta-actions";

    const status = document.createElement("span");
    status.className = "text-status";
    status.textContent = message.statusText || "";

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "chat-copy";
    copyButton.textContent = "复制";
    copyButton.addEventListener("click", () => copyChatMessage(message.text, copyButton));

    actionWrap.appendChild(status);
    actionWrap.appendChild(copyButton);
    meta.appendChild(stamp);
    meta.appendChild(actionWrap);

    bubble.appendChild(text);
    bubble.appendChild(meta);
    shell.stack.appendChild(bubble);
    list.appendChild(item);

    scrollConversationToBottom();
  }
  function renderRichMessageText(container, value) {
    container.textContent = "";
    const text = String(value || "");
    const lines = text.replace(/\r\n?/g, "\n").split("\n");

    lines.forEach((line, lineIndex) => {
      appendLinkifiedLine(container, line);
      if (lineIndex < lines.length - 1) {
        container.appendChild(document.createElement("br"));
      }
    });
  }

  function isLegacyProtocolMessage(message) {
    return Boolean(
      message
      && typeof message === "object"
      && typeof message.type === "string"
      && [
        "file-meta",
        "file-chunk",
        "file-done",
        "file-resend-request",
        "file-ack",
        "file-complete",
        "text-message",
        "text-ack",
      ].includes(message.type)
    );
  }

  function createLegacyTransport(connection) {
    return Object.freeze({
      authenticated: true,
      legacy: true,
      negotiatedCapabilities: Object.freeze({
        maxMessageBytes: 2 * 1024 * 1024,
        chunkSize: CHUNK_SIZE,
        hash: Object.freeze(["fnv1a32"]),
        resume: true,
      }),
      send(message) {
        if (!connection.open) return Promise.reject(new Error("legacy connection is closed"));
        connection.send(message);
        return Promise.resolve();
      },
    });
  }

  function appendLinkifiedLine(container, line) {
    URL_PATTERN.lastIndex = 0;
    let lastIndex = 0;
    let match;

    while ((match = URL_PATTERN.exec(line)) !== null) {
      const rawUrl = match[0];
      const href = normalizeMessageHref(rawUrl);
      const start = match.index;

      if (start > lastIndex) {
        container.appendChild(document.createTextNode(line.slice(lastIndex, start)));
      }

      if (href) {
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noreferrer noopener";
        link.textContent = rawUrl;
        container.appendChild(link);
      } else {
        container.appendChild(document.createTextNode(rawUrl));
      }

      lastIndex = start + rawUrl.length;
    }

    if (lastIndex < line.length) {
      container.appendChild(document.createTextNode(line.slice(lastIndex)));
    }
  }

  function normalizeMessageHref(rawUrl) {
    const trimmed = String(rawUrl || "").trim();
    if (!trimmed) return "";

    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : "https://" + trimmed;
    try {
      const url = new URL(candidate);
      return /^https?:$/i.test(url.protocol) ? url.href : "";
    } catch (error) {
      return "";
    }
  }

  function addSystemMessage(text) {
    if (!text) return;
    const list = $("conversationStream");
    if (!list) return;

    ensureConversationStarted();

    const item = document.createElement("article");
    item.className = "conversation-item system-note";

    const bubble = document.createElement("div");
    bubble.className = "system-bubble";
    bubble.textContent = text;

    item.appendChild(bubble);
    list.appendChild(item);
    scrollConversationToBottom();
  }

  function updateChatMessageStatus(id, text, cls) {
    const item = document.querySelector('.text-message[data-id="' + cssEscape(id) + '"]');
    if (!item) return;
    const status = item.querySelector(".text-status");
    if (!status) return;
    status.className = "text-status" + (cls ? " " + cls : "");
    status.textContent = text;
  }

  function copyChatMessage(text, button) {
    navigator.clipboard.writeText(text).then(() => {
      const original = button.textContent;
      button.textContent = "已复制";
      setTimeout(() => {
        button.textContent = original;
      }, 1500);
    }).catch(() => {
      button.textContent = "复制失败";
      setTimeout(() => {
        button.textContent = "复制";
      }, 1500);
    });
  }
  function markPendingTextMessagesFailed(statusText) {
    pendingTextMessages.forEach((pending, id) => {
      clearTimeout(pending.timeoutId);
      updateChatMessageStatus(id, statusText || "发送失败", "error");
    });
    pendingTextMessages.clear();
  }
  function scrollConversationToBottom() {
    const list = $("conversationStream");
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }

  function formatChatTime(timestamp) {
    try {
      return new Date(timestamp).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (error) {
      return "--:--";
    }
  }

  function maybeUpdateTransferProgress(transfer, pct, speedText, force) {
    const now = Date.now();
    if (!force && transfer.lastUiUpdateAt && now - transfer.lastUiUpdateAt < PROGRESS_UPDATE_INTERVAL_MS && pct < 100) {
      return;
    }
    transfer.lastUiUpdateAt = now;
    updateFileProgress(transfer.id, pct, speedText);
  }

  async function beginIncomingTransfer(conn, meta) {
    const transferId = String(meta.id || "");
    if (!transferId) return;

    const completed = completedIncomingTransfers.get(transferId);
    if (completed) {
      safeSend(conn, {
        type: "file-complete",
        id: transferId,
        receivedBytes: completed.receivedBytes,
        fileHash: completed.fileHash,
      });
      return;
    }

    const size = Number(meta.size);
    const totalChunks = Number(meta.totalChunks);
    const chunkSize = Number(meta.chunkSize || activeChunkSize);
    const expectedChunks = Math.ceil(size / chunkSize) || 1;
    const legacy = Boolean(activeSecureTransport && activeSecureTransport.legacy);
    let hashAlgorithm;
    try {
      hashAlgorithm = pickHashAlgorithm(meta.hashAlgorithm || (legacy ? "fnv1a32" : DEFAULT_HASH_ALGORITHM), legacy);
    } catch (_) {
      return;
    }
    if (
      !Number.isSafeInteger(size)
      || size < 0
      || !Number.isSafeInteger(chunkSize)
      || chunkSize < 16 * 1024
      || chunkSize > activeChunkSize
      || (!activeSecureTransport.legacy && chunkSize !== activeChunkSize)
      || !Number.isSafeInteger(totalChunks)
      || totalChunks !== expectedChunks
    ) return;

    const existing = incomingTransfers.get(transferId);
    if (existing) {
      if (
        existing.size === size
        && existing.totalChunks === totalChunks
        && existing.chunkSize === chunkSize
        && existing.legacy === legacy
        && existing.hashAlgorithm === hashAlgorithm
      ) {
        existing.missingRetryAttempts = 0;
        scheduleFileAck(conn, existing, true);
        return;
      }
      clearIncomingTransferTimers(existing);
      incomingTransfers.delete(transferId);
      await clearStoredChunks(dbPromise, transferId).catch(() => {});
    }

    const transfer = {
      id: transferId,
      name: sanitizeFileName(meta.name || "download.bin"),
      size,
      totalChunks,
      chunkSize,
      legacy,
      hashAlgorithm,
      receivedChunks: new Set(),
      pendingChunks: new Set(),
      receivedBytes: 0,
      startTime: Date.now(),
      doneReceived: false,
      finalizing: false,
      lastUiUpdateAt: 0,
      lastAckSentCount: 0,
      lastAckSentAt: 0,
      ackTimer: null,
      missingRetryTimer: null,
      missingRetryAttempts: 0,
      finalizePromise: null,
      expectedFileHash: null,
      integrityFailed: false,
    };

    incomingTransfers.set(transferId, transfer);
    addFileItem(transferId, transfer.name, transfer.size, "recv", "接收中...");
  }

  async function receiveChunk(conn, payload) {
    const transferId = String(payload.id || "");
    const completed = completedIncomingTransfers.get(transferId);
    if (completed) {
      safeSend(conn, {
        type: "file-complete",
        id: transferId,
        receivedBytes: completed.receivedBytes,
        fileHash: completed.fileHash,
      });
      return;
    }

    const transfer = incomingTransfers.get(transferId);
    if (!transfer) return;

    const seq = Number(payload.seq);
    if (!Number.isInteger(seq) || seq < 0 || seq >= transfer.totalChunks) return;
    if (transfer.receivedChunks.has(seq)) {
      scheduleFileAck(conn, transfer, true);
      return;
    }
    if (transfer.pendingChunks.has(seq)) return;
    transfer.pendingChunks.add(seq);

    try {
      const arrayBuffer = normalizeArrayBuffer(payload.chunk);
      const expectedSize = seq === transfer.totalChunks - 1
        ? Math.max(0, transfer.size - (seq * transfer.chunkSize))
        : transfer.chunkSize;
      const chunkHashAlgorithm = pickHashAlgorithm(getHashAlgorithm(payload.hash), transfer.legacy);
      if (chunkHashAlgorithm !== transfer.hashAlgorithm) throw new Error("Chunk hash policy changed during transfer");
      const hash = await createChunkHash(arrayBuffer, chunkHashAlgorithm, transfer.legacy);
      if (arrayBuffer.byteLength !== expectedSize || (payload.hash && payload.hash !== hash)) {
        updateFileStatus(transfer.id, "数据校验失败，正在请求重传...", "error");
        safeSend(conn, { type: "file-resend-request", id: transfer.id, seqs: [seq] });
        return;
      }

      await storeChunk(dbPromise, transfer.id, seq, new Blob([arrayBuffer]));
      if (incomingTransfers.get(transfer.id) !== transfer || transfer.receivedChunks.has(seq)) return;
      transfer.receivedChunks.add(seq);
      transfer.receivedBytes += arrayBuffer.byteLength;
      transfer.missingRetryAttempts = 0;

      const pct = transfer.size > 0 ? Math.min(100, Math.round((transfer.receivedBytes / transfer.size) * 100)) : 100;
      const elapsedSeconds = Math.max(1, (Date.now() - transfer.startTime) / 1000);
      maybeUpdateTransferProgress(
        transfer,
        pct,
        formatSize(Math.round(transfer.receivedBytes / elapsedSeconds)) + "/s",
        transfer.receivedChunks.size === transfer.totalChunks
      );

      scheduleFileAck(conn, transfer, transfer.receivedChunks.size === transfer.totalChunks);

      if (transfer.doneReceived && transfer.receivedChunks.size === transfer.totalChunks) {
        await finalizeAndConfirmIncoming(conn, transfer);
      } else if (transfer.doneReceived) {
        scheduleMissingChunkRetry(conn, transfer);
      }
    } catch (error) {
      console.warn("[WO Transfer] Chunk validation failed:", error);
      updateFileStatus(transfer.id, "分片校验算法不受支持，正在请求重传...", "error");
      safeSend(conn, { type: "file-resend-request", id: transfer.id, seqs: [seq] });
    } finally {
      transfer.pendingChunks.delete(seq);
    }
  }

  function scheduleFileAck(conn, transfer, force) {
    const sendAck = () => {
      if (transfer.ackTimer) clearTimeout(transfer.ackTimer);
      transfer.ackTimer = null;
      transfer.lastAckSentCount = transfer.receivedChunks.size;
      transfer.lastAckSentAt = Date.now();
      safeSend(conn, {
        type: "file-ack",
        id: transfer.id,
        receivedCount: transfer.receivedChunks.size,
        receivedBytes: transfer.receivedBytes,
      });
    };

    const countDelta = transfer.receivedChunks.size - transfer.lastAckSentCount;
    const elapsed = Date.now() - transfer.lastAckSentAt;
    if (force || countDelta >= ACK_BATCH_SIZE || elapsed >= ACK_MAX_DELAY) {
      sendAck();
      return;
    }
    if (!transfer.ackTimer) {
      transfer.ackTimer = setTimeout(sendAck, Math.max(0, ACK_MAX_DELAY - elapsed));
    }
  }

  async function markIncomingDone(conn, payload) {
    const transferId = String(payload.id || "");
    const completed = completedIncomingTransfers.get(transferId);
    if (completed) {
      safeSend(conn, {
        type: "file-complete",
        id: transferId,
        receivedBytes: completed.receivedBytes,
        fileHash: completed.fileHash,
      });
      return;
    }

    const transfer = incomingTransfers.get(transferId);
    if (!transfer) return;

    let expectedFileHash;
    try {
      expectedFileHash = normalizeExpectedFileHash(payload.fileHash, transfer.legacy, transfer.hashAlgorithm);
    } catch (error) {
      updateFileStatus(transfer.id, error.message, "error");
      return;
    }
    if (transfer.expectedFileHash && transfer.expectedFileHash !== expectedFileHash) {
      updateFileStatus(transfer.id, "发送端的完整文件摘要发生变化，已拒绝保存。", "error");
      return;
    }
    transfer.expectedFileHash = expectedFileHash;

    transfer.doneReceived = true;
    if (transfer.receivedChunks.size === transfer.totalChunks) {
      await finalizeAndConfirmIncoming(conn, transfer);
      return;
    }

    requestMissingChunks(conn, transfer);
  }

  function requestMissingChunks(conn, transfer) {
    clearTimeout(transfer.missingRetryTimer);
    transfer.missingRetryTimer = null;
    const missingSeqs = getMissingSeqs(transfer, RESEND_BATCH_SIZE);
    if (!missingSeqs.length) return;
    if (transfer.missingRetryAttempts >= MISSING_CHUNK_MAX_ATTEMPTS) {
      updateFileStatus(transfer.id, "缺少分片，等待连接恢复。", "error");
      return;
    }

    transfer.missingRetryAttempts++;
    updateFileStatus(transfer.id, "缺少分片，正在请求重传...", "");
    safeSend(conn, { type: "file-resend-request", id: transfer.id, seqs: missingSeqs });
    transfer.missingRetryTimer = setTimeout(() => requestMissingChunks(conn, transfer), MISSING_CHUNK_RETRY_MS);
  }

  function scheduleMissingChunkRetry(conn, transfer) {
    if (transfer.missingRetryTimer) return;
    transfer.missingRetryTimer = setTimeout(() => requestMissingChunks(conn, transfer), MISSING_CHUNK_RETRY_MS);
  }

  async function finalizeAndConfirmIncoming(conn, transfer) {
    const saved = await finalizeIncomingTransfer(dbPromise, transfer, updateFileStatus);
    if (!saved) {
      if (transfer.integrityFailed) {
        transfer.integrityFailed = false;
        transfer.receivedChunks.clear();
        transfer.pendingChunks.clear();
        transfer.receivedBytes = 0;
        transfer.missingRetryAttempts = 0;
        requestMissingChunks(conn, transfer);
      }
      return;
    }
    clearIncomingTransferTimers(transfer);
    incomingTransfers.delete(transfer.id);
    completedIncomingTransfers.set(transfer.id, {
      receivedBytes: transfer.receivedBytes,
      fileHash: transfer.expectedFileHash,
    });
    setTimeout(() => completedIncomingTransfers.delete(transfer.id), COMPLETED_TRANSFER_CACHE_MS);
    safeSend(conn, {
      type: "file-complete",
      id: transfer.id,
      receivedBytes: transfer.receivedBytes,
      fileHash: transfer.expectedFileHash,
    });
  }

  function markOutgoingAcknowledged(message) {
    const transfer = outgoingTransfers.get(String(message.id || ""));
    if (!transfer) return;
    transfer.lastAckCount = Math.max(transfer.lastAckCount, Number(message.receivedCount || 0));
    transfer.lastAckBytes = Math.max(transfer.lastAckBytes, Number(message.receivedBytes || 0));
    transfer.lastAckAt = Date.now();
  }

  function markOutgoingComplete(message) {
    const transfer = outgoingTransfers.get(String(message.id || ""));
    if (!transfer) return;
    if (
      transfer.fileHash
      && ((!transfer.legacy && message.fileHash !== transfer.fileHash)
        || (message.fileHash && message.fileHash !== transfer.fileHash))
    ) {
      transfer.state = "failed";
      updateFileStatus(transfer.id, "接收端完整性确认不一致。", "error");
      scheduleOutgoingCleanup(transfer);
      return;
    }
    transfer.completed = true;
    transfer.state = "completed";
    clearTimeout(transfer.completionTimer);
    transfer.completionTimer = null;
    const durationSeconds = transfer.startTime ? ((Date.now() - transfer.startTime) / 1000).toFixed(1) : "0.0";
    updateFileStatus(transfer.id, "已送达（" + durationSeconds + " 秒）", "done");
    scheduleOutgoingCleanup(transfer);
  }

  async function resendMissingChunks(conn, message) {
    const transfer = outgoingTransfers.get(String(message.id || ""));
    if (!transfer || !conn || !conn.open) return;

    const seqs = Array.isArray(message.seqs)
      ? Array.from(new Set(message.seqs.filter((seq) => Number.isInteger(seq) && seq >= 0 && seq < transfer.totalChunks))).slice(0, RESEND_BATCH_SIZE)
      : [];

    for (const seq of seqs) {
      const start = seq * transfer.chunkSize;
      const end = Math.min(start + transfer.chunkSize, transfer.file.size);
      const arrayBuffer = await transfer.file.slice(start, end).arrayBuffer();
      const hash = await createChunkHash(arrayBuffer, transfer.hashAlgorithm, transfer.legacy);
      await waitForDataChannel(conn);
      await sendSecure(conn, {
        type: "file-chunk",
        id: transfer.id,
        seq,
        totalChunks: transfer.totalChunks,
        hash,
        chunk: arrayBuffer,
      });
    }
  }

  function queueFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    if (!activeConn || !activeConn.open) {
      alert("请先连接一台设备。");
      return;
    }

    for (const file of files) {
      const transfer = {
        id: "send-" + randomId(),
        file,
        totalChunks: Math.ceil(file.size / activeChunkSize) || 1,
        chunkSize: activeChunkSize,
        startTime: 0,
        sentBytes: 0,
        lastAckCount: 0,
        lastAckBytes: 0,
        lastUiUpdateAt: 0,
        sendAttempts: 0,
        state: "queued",
        completed: false,
        completionAttempts: 0,
        completionTimer: null,
        cleanupTimer: null,
        fileHash: null,
      };
      outgoingTransfers.set(transfer.id, transfer);
      sendQueue.push(transfer);
      addFileItem(transfer.id, file.name, file.size, "send", "等待发送");
    }

    runSendQueue();
  }

  async function runSendQueue() {
    if (sendQueueRunning) return;
    sendQueueRunning = true;

    while (sendQueue.length > 0) {
      if (!activeConn || !activeConn.open) break;
      const transfer = sendQueue.shift();
      if (!transfer || transfer.completed) continue;
      const connection = activeConn;
      try {
        transfer.sendAttempts++;
        transfer.state = "sending";
        await sendTransfer(connection, transfer);
        transfer.state = "awaiting-complete";
        armCompletionProbe(connection, transfer);
      } catch (error) {
        console.error("[WO Transfer] Send failed:", error);
        if (!isPageClosing && transfer.sendAttempts < MAX_SEND_ATTEMPTS) {
          transfer.state = "queued";
          sendQueue.unshift(transfer);
          updateFileStatus(transfer.id, activeConn && activeConn.open ? "发送受阻，正在重试..." : "连接中断，等待恢复...", "");
          if (activeConn && activeConn.open) await sleep(getReconnectDelay(transfer.sendAttempts));
          else break;
        } else {
          transfer.state = "failed";
          updateFileStatus(transfer.id, "发送失败", "error");
          scheduleOutgoingCleanup(transfer);
        }
      }
    }

    sendQueueRunning = false;
  }

  async function sendTransfer(conn, transfer) {
    if (!isUsableConnection(conn)) throw new Error("connection unavailable");

    updateFileStatus(transfer.id, "发送中...", "");
    transfer.startTime = Date.now();
    transfer.sentBytes = 0;
    transfer.chunkSize = activeChunkSize;
    transfer.totalChunks = Math.ceil(transfer.file.size / transfer.chunkSize) || 1;
    transfer.fileHash = null;
    transfer.hashAlgorithm = activeSecureTransport.legacy ? "fnv1a32" : DEFAULT_HASH_ALGORITHM;
    transfer.legacy = Boolean(activeSecureTransport.legacy);
    const fileHasher = createFileHasher(transfer.hashAlgorithm, transfer.legacy);

    await sendSecure(conn, {
      type: "file-meta",
      id: transfer.id,
      name: transfer.file.name,
      size: transfer.file.size,
      totalChunks: transfer.totalChunks,
      chunkSize: transfer.chunkSize,
      lastModified: transfer.file.lastModified || Date.now(),
      hashAlgorithm: transfer.hashAlgorithm,
    });

    for (let seq = 0; seq < transfer.totalChunks; seq++) {
      const start = seq * transfer.chunkSize;
      const end = Math.min(start + transfer.chunkSize, transfer.file.size);
      const arrayBuffer = await transfer.file.slice(start, end).arrayBuffer();
      const hash = await createChunkHash(arrayBuffer, transfer.hashAlgorithm, transfer.legacy);
      fileHasher.update(arrayBuffer);

      await waitForDataChannel(conn);
      await sendSecure(conn, {
        type: "file-chunk",
        id: transfer.id,
        seq,
        totalChunks: transfer.totalChunks,
        chunkSize: transfer.chunkSize,
        hash,
        chunk: arrayBuffer,
      });

      transfer.sentBytes += arrayBuffer.byteLength;
      const pct = transfer.file.size > 0
        ? Math.min(100, Math.round((transfer.sentBytes / transfer.file.size) * 100))
        : 100;
      const elapsedSeconds = Math.max(1, (Date.now() - transfer.startTime) / 1000);
      maybeUpdateTransferProgress(
        transfer,
        pct,
        formatSize(Math.round(transfer.sentBytes / elapsedSeconds)) + "/s",
        seq === transfer.totalChunks - 1
      );
    }

    transfer.fileHash = fileHasher.digest();
    await sendSecure(conn, {
      type: "file-done",
      id: transfer.id,
      totalChunks: transfer.totalChunks,
      fileHash: transfer.fileHash,
    });
    updateFileStatus(transfer.id, "等待对方确认...", "");
  }

  function armCompletionProbe(conn, transfer) {
    clearTimeout(transfer.completionTimer);
    if (transfer.completed) return;
    transfer.completionAttempts = 0;

    const probe = () => {
      if (transfer.completed || transfer.state !== "awaiting-complete") return;
      if (!isUsableConnection(conn)) return;
      if (transfer.completionAttempts >= FILE_COMPLETE_MAX_ATTEMPTS) {
        updateFileStatus(transfer.id, "确认超时，等待连接恢复。", "error");
        return;
      }
      transfer.completionAttempts++;
      safeSend(conn, {
        type: "file-done",
        id: transfer.id,
        totalChunks: transfer.totalChunks,
        fileHash: transfer.fileHash,
      });
      transfer.completionTimer = setTimeout(probe, FILE_COMPLETE_RETRY_MS);
    };

    transfer.completionTimer = setTimeout(probe, FILE_COMPLETE_RETRY_MS);
  }

  function resumePendingTransfers(conn) {
    outgoingTransfers.forEach((transfer) => {
      if (transfer.completed || transfer.state !== "awaiting-complete") return;
      if (transfer.chunkSize !== activeChunkSize || transfer.legacy !== Boolean(activeSecureTransport.legacy)) {
        clearTimeout(transfer.completionTimer);
        transfer.completionTimer = null;
        transfer.state = "queued";
        if (!sendQueue.includes(transfer)) sendQueue.unshift(transfer);
        updateFileStatus(transfer.id, "连接能力已变化，正在重新发送...", "");
        return;
      }
      safeSend(conn, {
        type: "file-meta",
        id: transfer.id,
        name: transfer.file.name,
        size: transfer.file.size,
        totalChunks: transfer.totalChunks,
        chunkSize: transfer.chunkSize,
        lastModified: transfer.file.lastModified || Date.now(),
        hashAlgorithm: transfer.hashAlgorithm,
      });
      safeSend(conn, {
        type: "file-done",
        id: transfer.id,
        totalChunks: transfer.totalChunks,
        fileHash: transfer.fileHash,
      });
      armCompletionProbe(conn, transfer);
    });
  }

  async function waitForDataChannel(conn) {
    if (!isUsableConnection(conn)) throw new Error("connection closed");

    const dataChannel = conn.dataChannel || conn._dc;
    if (!dataChannel) return;

    const deadline = Date.now() + DATA_CHANNEL_STALL_TIMEOUT_MS;
    while (dataChannel.bufferedAmount > BUFFER_HIGH_WATER_MARK) {
      if (!isUsableConnection(conn)) throw new Error("connection replaced or closed");
      if (Date.now() >= deadline) throw new Error("data channel backpressure timeout");
      await sleep(30);
    }
  }

  function addFileItem(id, name, size, direction, statusText) {
    const list = $("conversationStream");
    const emptyState = $("conversationEmpty");
    if (emptyState) emptyState.remove();
    const previousItem = document.querySelector('.file-message[data-id="' + cssEscape(id) + '"]');
    if (previousItem) previousItem.remove();

    const messageDirection = direction === "recv" ? "incoming" : "outgoing";
    const shell = createMessageShell(messageDirection, "file-message");
    const item = shell.item;
    item.dataset.id = id;

    const bubble = document.createElement("div");
    bubble.className = "file-bubble";

    const icon = document.createElement("div");
    icon.className = "file-icon";
    icon.title = direction === "recv" ? "接收文件" : "发送文件";
    icon.textContent = direction === "recv" ? "收" : "发";

    const info = document.createElement("div");
    info.className = "file-info";

    const nameEl = document.createElement("div");
    nameEl.className = "file-name";
    nameEl.textContent = name;

    const meta = document.createElement("div");
    meta.className = "file-meta";
    meta.appendChild(document.createTextNode(formatSize(size)));
    const speed = document.createElement("span");
    speed.className = "file-speed";
    meta.appendChild(speed);

    const progress = document.createElement("div");
    progress.className = "file-progress";
    const progressBar = document.createElement("div");
    progressBar.className = "file-progress-bar";
    progressBar.style.width = "0%";
    progress.appendChild(progressBar);

    info.appendChild(nameEl);
    info.appendChild(meta);
    info.appendChild(progress);

    const status = document.createElement("div");
    status.className = "file-status";
    status.textContent = statusText;

    bubble.appendChild(icon);
    bubble.appendChild(info);
    bubble.appendChild(status);
    shell.stack.appendChild(bubble);
    list.appendChild(item);
    scrollConversationToBottom();
  }

  function updateFileProgress(id, pct, speedText) {
    const item = document.querySelector('.file-message[data-id="' + cssEscape(id) + '"]');
    if (!item) return;

    item.querySelector(".file-progress-bar").style.width = pct + "%";
    item.querySelector(".file-speed").textContent = speedText ? " · " + speedText : "";
  }

  function updateFileStatus(id, text, cls) {
    const item = document.querySelector('.file-message[data-id="' + cssEscape(id) + '"]');
    if (!item) return;

    const progressBar = item.querySelector(".file-progress-bar");
    const status = item.querySelector(".file-status");

    if (cls === "done") {
      progressBar.style.width = "100%";
      progressBar.style.background = "#7bd88f";
    } else if (cls === "error") {
      progressBar.style.background = "#ff7d7d";
    }

    status.className = "file-status" + (cls ? " " + cls : "");
    status.textContent = text;
  }

  function setStatus(text, state) {
    $("connText").textContent = text;
    $("connStatus").className = "status-pill lan-status-pill" + (state ? " " + state : "");
  }

  function updateRoomCodeUi() {
    $("roomCodeDisplay").textContent = roomCode;
    renderQRCode(buildMobileLaunchUrl() || roomCode, $("qrTarget"));
  }

  function copyRoomCode() {
    navigator.clipboard.writeText(roomCode).then(() => {
      const button = $("copyCode");
      const original = button.textContent;
      button.textContent = "已复制";
      setTimeout(() => {
        button.textContent = original;
      }, 1800);
    }).catch(() => {
      alert("复制失败，请手动复制房间码。");
    });
  }

  async function downloadMobilePage() {
    if (isGeneratingMobilePage) return;
    isGeneratingMobilePage = true;

    const button = $("downloadMobile");
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "生成中...";

    try {
      const html = await buildGeneratedMobileHtml();
      await downloadGeneratedFile("web-omni-mobile.html", html, "text/html;charset=utf-8");
    } catch (error) {
      console.error("[WO Transfer] Failed to build mobile page:", error);
      alert("生成手机页面失败。");
    } finally {
      isGeneratingMobilePage = false;
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  async function downloadMobileKit() {
    if (isGeneratingMobileKit) return;
    isGeneratingMobileKit = true;

    const button = $("downloadMobileKit");
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "打包中...";

    try {
      const html = await buildGeneratedMobileHtml();
      const files = [
        {
          filename: "web-omni-mobile-kit/index.html",
          content: html,
        },
        {
          filename: "web-omni-mobile-kit/serve-mobile.ps1",
          content: buildLanKitServerScript(MOBILE_KIT_PORT),
        },
        {
          filename: "web-omni-mobile-kit/start-mobile-server.cmd",
          content: buildLanKitLauncherScript(),
        },
        {
          filename: "web-omni-mobile-kit/README.txt",
          content: buildLanKitReadme(MOBILE_KIT_PORT),
        },
      ];
      const zipBytes = buildZipArchive(files);
      await downloadGeneratedBinary("web-omni-mobile-kit.zip", zipBytes, "application/zip");
      alert("局域网页包 ZIP 已下载。解压后双击 start-mobile-server.cmd，再用手机浏览器打开终端窗口里显示的地址。");
    } catch (error) {
      console.error("[WO Transfer] Failed to export LAN kit:", error);
      alert("导出局域网页包失败。");
    } finally {
      isGeneratingMobileKit = false;
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  async function buildGeneratedMobileHtml() {
    const [peerJsSource, secureChannelSource, htmlTemplate, runtimeTemplate] = await Promise.all([
      loadPackageText("lan-transfer/peerjs.min.js"),
      loadPackageText("lan-transfer/secure-channel.js"),
      loadPackageText("lan-transfer/mobile-template.html"),
      loadPackageText("lan-transfer/mobile-runtime.template.js"),
    ]);

    const runtimeSource = runtimeTemplate
      .split("__WO_ROOM_CODE__").join(JSON.stringify(roomCode))
      .split("__WO_SECURE_SESSION__").join(JSON.stringify({
        sessionId: secureSession.sessionId,
        pairingSecret: secureSession.pairingSecret,
        targetPeerId: peerId,
      }))
      .split("__WO_RUNTIME_CONFIG__").join(JSON.stringify(runtimeConfig))
      .split("__WO_TEXT_LIMIT__").join(String(TEXT_LIMIT_BYTES));

    const html = replaceInlineMarker(
      replaceInlineMarker(
        replaceInlineMarker(htmlTemplate, "__WO_PEER_JS__", peerJsSource),
        "__WO_SECURE_CHANNEL__",
        secureChannelSource
      ),
      "__WO_MOBILE_RUNTIME__",
      runtimeSource
    );
    const unresolvedMarker = ["__WO_PEER_JS__", "__WO_SECURE_CHANNEL__", "__WO_MOBILE_RUNTIME__"]
      .find((marker) => html.includes(marker));
    if (unresolvedMarker) {
      throw new Error("Generated mobile page contains unresolved marker: " + unresolvedMarker);
    }
    return html;
  }

  async function loadPackageText(path) {
    const response = await fetch(chrome.runtime.getURL(path));
    return response.text();
  }

  function sanitizeInlineScript(source) {
    return String(source || "").replace(/<\/script/gi, "<\\/script");
  }

  function replaceInlineMarker(source, marker, script) {
    if (!source.includes(marker)) {
      throw new Error("Mobile page template is missing marker: " + marker);
    }
    return source.replace(marker, () => sanitizeInlineScript(script));
  }

  async function downloadGeneratedFile(filename, content, mimeType) {
    const data = typeof content === "string" ? encoder.encode(content) : content;
    return downloadGeneratedBinary(filename, data, mimeType || "text/plain;charset=utf-8");
  }

  async function downloadGeneratedBinary(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType || "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    activeObjectUrls.add(url);

    try {
      if (typeof chrome !== "undefined" && chrome.downloads && typeof chrome.downloads.download === "function") {
        await chrome.downloads.download({
          url,
          filename,
          saveAs: false,
          conflictAction: "uniquify",
        });
        return;
      }

      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename.split("/").pop();
      anchor.click();
    } finally {
      setTimeout(() => releaseObjectUrl(url), 5000);
    }
  }

  function buildZipArchive(files) {
    const localChunks = [];
    const centralChunks = [];
    let localOffset = 0;

    files.forEach((file) => {
      const nameBytes = encoder.encode(file.filename);
      const dataBytes = normalizeBinaryContent(file.content);
      const crc = crc32(dataBytes);
      const dosTimeDate = getDosDateTime(new Date());

      const localHeader = new Uint8Array(30 + nameBytes.length);
      const localView = new DataView(localHeader.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0x0800, true);
      localView.setUint16(8, 0, true);
      localView.setUint16(10, dosTimeDate.time, true);
      localView.setUint16(12, dosTimeDate.date, true);
      localView.setUint32(14, crc, true);
      localView.setUint32(18, dataBytes.length, true);
      localView.setUint32(22, dataBytes.length, true);
      localView.setUint16(26, nameBytes.length, true);
      localView.setUint16(28, 0, true);
      localHeader.set(nameBytes, 30);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const centralView = new DataView(centralHeader.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint16(12, dosTimeDate.time, true);
      centralView.setUint16(14, dosTimeDate.date, true);
      centralView.setUint32(16, crc, true);
      centralView.setUint32(20, dataBytes.length, true);
      centralView.setUint32(24, dataBytes.length, true);
      centralView.setUint16(28, nameBytes.length, true);
      centralView.setUint16(30, 0, true);
      centralView.setUint16(32, 0, true);
      centralView.setUint16(34, 0, true);
      centralView.setUint16(36, 0, true);
      centralView.setUint32(38, 0, true);
      centralView.setUint32(42, localOffset, true);
      centralHeader.set(nameBytes, 46);

      localChunks.push(localHeader, dataBytes);
      centralChunks.push(centralHeader);
      localOffset += localHeader.length + dataBytes.length;
    });

    const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const endRecord = new Uint8Array(22);
    const endView = new DataView(endRecord.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, files.length, true);
    endView.setUint16(10, files.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, localOffset, true);
    endView.setUint16(20, 0, true);

    return concatUint8Arrays([...localChunks, ...centralChunks, endRecord]);
  }

  function normalizeBinaryContent(content) {
    if (content instanceof Uint8Array) return content;
    if (content instanceof ArrayBuffer) return new Uint8Array(content);
    if (ArrayBuffer.isView(content)) {
      return new Uint8Array(content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength));
    }
    return encoder.encode(String(content || ""));
  }

  function concatUint8Arrays(chunks) {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    chunks.forEach((chunk) => {
      merged.set(chunk, offset);
      offset += chunk.length;
    });
    return merged;
  }

  function getDosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = Math.floor(date.getSeconds() / 2);

    return {
      time: (hours << 11) | (minutes << 5) | seconds,
      date: ((year - 1980) << 9) | (month << 5) | day,
    };
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let index = 0; index < bytes.length; index++) {
      crc ^= bytes[index];
      for (let bit = 0; bit < 8; bit++) {
        const mask = -(crc & 1);
        crc = (crc >>> 1) ^ (0xedb88320 & mask);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function buildLanKitLauncherScript() {
    return [
      "@echo off",
      "setlocal",
      "powershell -ExecutionPolicy Bypass -NoLogo -File \"%~dp0serve-mobile.ps1\" %*",
    ].join("\r\n");
  }

  function buildLanKitReadme(port) {
    return [
      "Web-Omni 局域网页包",
      "",
      "压缩包内容：",
      "- index.html：手机端页面，已预填当前房间码，支持文件和文本聊天。",
      "- start-mobile-server.cmd：Windows 启动脚本，双击即可启动本地网页服务。",
      "- serve-mobile.ps1：本地网页服务脚本。",
      "",
      "使用方法：",
      "1. 解压 ZIP，并保持文件在同一个文件夹里。",
      "2. 在电脑上双击 start-mobile-server.cmd。",
      "3. 如果 Windows 防火墙弹窗，请允许专用网络访问。",
      "4. PowerShell 窗口会打印一个或多个地址，例如 http://192.168.1.23:" + port + "/index.html",
      "5. 用手机浏览器打开能访问的那个地址。",
      "6. 传输过程中保持 PowerShell 窗口打开。",
      "",
      "注意：",
      "- 手机和电脑需要连接同一个 Wi-Fi。",
      "- 手机页仍需要信令 / STUN 网络可用。",
      "- 如果电脑上的房间码变化，请重新导出网页包，或者在手机端手动输入新的房间码。",
    ].join("\r\n");
  }

  function buildLanKitServerScript(port) {
    return [
      "$ErrorActionPreference = 'Stop'",
      "$port = " + String(port),
      "$root = Split-Path -Parent $MyInvocation.MyCommand.Path",
      "",
      "function Get-ContentType([string] $path) {",
      "  switch ([System.IO.Path]::GetExtension($path).ToLowerInvariant()) {",
      "    '.html' { return 'text/html; charset=utf-8' }",
      "    '.js' { return 'application/javascript; charset=utf-8' }",
      "    '.css' { return 'text/css; charset=utf-8' }",
      "    '.json' { return 'application/json; charset=utf-8' }",
      "    '.txt' { return 'text/plain; charset=utf-8' }",
      "    '.png' { return 'image/png' }",
      "    '.jpg' { return 'image/jpeg' }",
      "    '.jpeg' { return 'image/jpeg' }",
      "    default { return 'application/octet-stream' }",
      "  }",
      "}",
      "",
      "function Get-LanAddresses {",
      "  try {",
      "    $addresses = Get-NetIPAddress -AddressFamily IPv4 |",
      "      Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254*' } |",
      "      Select-Object -ExpandProperty IPAddress -Unique",
      "    if ($addresses) { return $addresses }",
      "  } catch {}",
      "",
      "  return [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |",
      "    Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and $_.IPAddressToString -ne '127.0.0.1' } |",
      "    ForEach-Object { $_.IPAddressToString } |",
      "    Select-Object -Unique",
      "}",
      "",
      "function Write-Response {",
      "  param(",
      "    [Parameter(Mandatory = $true)] [System.IO.Stream] $Stream,",
      "    [Parameter(Mandatory = $true)] [string] $StatusLine,",
      "    [Parameter(Mandatory = $true)] [string] $ContentType,",
      "    [Parameter(Mandatory = $true)] [byte[]] $BodyBytes",
      "  )",
      "",
      "  $writer = New-Object System.IO.StreamWriter($Stream, [System.Text.Encoding]::ASCII, 1024, $true)",
      "  $writer.NewLine = \"`r`n\"",
      "  $writer.WriteLine($StatusLine)",
      "  $writer.WriteLine('Content-Type: ' + $ContentType)",
      "  $writer.WriteLine('Content-Length: ' + $BodyBytes.Length)",
      "  $writer.WriteLine('Connection: close')",
      "  $writer.WriteLine('Cache-Control: no-store')",
      "  $writer.WriteLine('')",
      "  $writer.Flush()",
      "  $Stream.Write($BodyBytes, 0, $BodyBytes.Length)",
      "  $Stream.Flush()",
      "}",
      "",
      "$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $port)",
      "$listener.Start()",
      "",
      "Write-Host ''",
      "Write-Host 'Web-Omni mobile server is running.' -ForegroundColor Green",
      "Write-Host 'Open one of these URLs on your phone browser:' -ForegroundColor Cyan",
      "$addresses = Get-LanAddresses",
      "if (-not $addresses) {",
      "  Write-Host ('  http://localhost:{0}/index.html' -f $port) -ForegroundColor Yellow",
      "} else {",
      "  foreach ($address in $addresses) {",
      "    Write-Host ('  http://{0}:{1}/index.html' -f $address, $port) -ForegroundColor Yellow",
      "  }",
      "}",
      "Write-Host ''",
      "Write-Host 'Press Ctrl+C to stop.' -ForegroundColor DarkGray",
      "Write-Host ''",
      "",
      "try {",
      "  while ($true) {",
      "    $client = $listener.AcceptTcpClient()",
      "    try {",
      "      $stream = $client.GetStream()",
      "      $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII, $false, 8192, $true)",
      "      $requestLine = $reader.ReadLine()",
      "      if ([string]::IsNullOrWhiteSpace($requestLine)) {",
      "        continue",
      "      }",
      "",
      "      while (($line = $reader.ReadLine()) -ne '') {",
      "        if ($null -eq $line) { break }",
      "      }",
      "",
      "      $parts = $requestLine.Split(' ')",
      "      $rawPath = if ($parts.Length -ge 2) { $parts[1] } else { '/' }",
      "      $requestPath = [System.Uri]::UnescapeDataString($rawPath.TrimStart('/').Split('?')[0])",
      "      if ([string]::IsNullOrWhiteSpace($requestPath)) {",
      "        $requestPath = 'index.html'",
      "      }",
      "",
      "      $relativePath = $requestPath -replace '/', '\\'",
      "      $candidatePath = [System.IO.Path]::GetFullPath((Join-Path $root $relativePath))",
      "      $rootPath = [System.IO.Path]::GetFullPath($root)",
      "",
      "      if (-not $candidatePath.StartsWith($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {",
      "        Write-Response -Stream $stream -StatusLine 'HTTP/1.1 403 Forbidden' -ContentType 'text/plain; charset=utf-8' -BodyBytes ([System.Text.Encoding]::UTF8.GetBytes('Forbidden'))",
      "        continue",
      "      }",
      "",
      "      if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {",
      "        Write-Response -Stream $stream -StatusLine 'HTTP/1.1 404 Not Found' -ContentType 'text/plain; charset=utf-8' -BodyBytes ([System.Text.Encoding]::UTF8.GetBytes('Not found'))",
      "        continue",
      "      }",
      "",
      "      $bytes = [System.IO.File]::ReadAllBytes($candidatePath)",
      "      Write-Response -Stream $stream -StatusLine 'HTTP/1.1 200 OK' -ContentType (Get-ContentType $candidatePath) -BodyBytes $bytes",
      "    } finally {",
      "      if ($reader) { $reader.Dispose() }",
      "      if ($stream) { $stream.Dispose() }",
      "      $client.Close()",
      "      $reader = $null",
      "      $stream = $null",
      "    }",
      "  }",
      "} finally {",
      "  $listener.Stop()",
      "  $listener.Close()",
      "}",
    ].join("\r\n");
  }

  async function loadRuntimeConfig() {
    try {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
        return createRuntimeConfig(null);
      }
      const stored = await chrome.storage.local.get([CONFIG_STORAGE_KEY, LEGACY_CONFIG_STORAGE_KEY]);
      const source = stored[CONFIG_STORAGE_KEY] || stored[LEGACY_CONFIG_STORAGE_KEY] || null;
      const normalized = createRuntimeConfig(source);
      const persisted = persistedRuntimeConfig(normalized);
      if (JSON.stringify(stored[CONFIG_STORAGE_KEY] || null) !== JSON.stringify(persisted)) {
        await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: persisted });
      }
      return normalized;
    } catch (error) {
      console.warn("[WO Transfer] Failed to load runtime config:", error);
      return createRuntimeConfig(null);
    }
  }

  function saveRuntimeConfigPatch(patch) {
    const operation = async () => {
      const stored = await chrome.storage.local.get([CONFIG_STORAGE_KEY]);
      const next = createRuntimeConfig({
        ...(stored[CONFIG_STORAGE_KEY] || persistedRuntimeConfig(runtimeConfig)),
        ...(patch || {}),
      });
      runtimeConfig = {
        ...runtimeConfig,
        ...next,
        localPageUrl: runtimeConfig.localPageUrl || "",
        localRelayUrl: runtimeConfig.localRelayUrl || "",
      };
      await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: persistedRuntimeConfig(next) });
      return next;
    };
    runtimeConfigSaveQueue = runtimeConfigSaveQueue.then(operation, operation);
    return runtimeConfigSaveQueue;
  }

  function persistedRuntimeConfig(config) {
    return {
      version: 2,
      preferredMode: config.preferredMode,
      pagesUrl: config.pagesUrl,
      remoteConsentAt: config.remoteConsentAt,
      localAuthorizedAt: config.localAuthorizedAt,
      signalServers: config.signalServers,
      iceServers: config.iceServers,
      hashAlgorithm: "sha256",
      allowLegacyProtocol: Boolean(config.allowLegacyProtocol),
    };
  }

  function createRuntimeConfig(override) {
    const preferredMode = override && override.preferredMode;
    const legacyPreferredMode = loadStoredLanMode();
    return {
      version: 2,
      preferredMode: preferredMode === "online" || preferredMode === "local" || preferredMode === "auto"
        ? preferredMode
        : legacyPreferredMode,
      signalServers: normalizeSignalServers(override && override.signalServers),
      iceServers: normalizeIceServers(override && override.iceServers),
      pagesUrl: normalizePagesUrl(override && override.pagesUrl),
      remoteConsentAt: Math.max(
        0,
        Number(override && (override.remoteConsentAt || override.onlineAuthorizedAt)) || 0
      ),
      localAuthorizedAt: Math.max(0, Number(override && override.localAuthorizedAt) || 0),
      allowLegacyProtocol: Boolean(override && override.allowLegacyProtocol),
      localPageUrl: "",
      localRelayUrl: "",
      localMobileReachable: null,
      localNotice: "",
    };
  }

  function normalizeSignalServers(servers) {
    if (!Array.isArray(servers) || servers.length === 0) {
      return DEFAULT_SIGNAL_SERVERS.map(cloneSignalServer);
    }

    const normalized = servers
      .map((server) => normalizeSignalServer(server))
      .filter(Boolean);

    return normalized.length > 0 ? normalized : DEFAULT_SIGNAL_SERVERS.map(cloneSignalServer);
  }

  function normalizeSignalServer(server) {
    if (!server || typeof server.host !== "string" || !server.host.trim()) {
      return null;
    }

    const port = Number(server.port);
    return {
      host: server.host.trim(),
      port: Number.isInteger(port) && port > 0 ? port : 443,
      secure: server.secure !== false,
      path: normalizeSignalPath(server.path),
    };
  }

  function cloneSignalServer(server) {
    return {
      host: server.host,
      port: server.port,
      secure: server.secure,
      path: server.path,
    };
  }

  function normalizeSignalPath(path) {
    if (typeof path !== "string" || !path.trim()) return "/";
    return path.startsWith("/") ? path : "/" + path;
  }

  function normalizeIceServers(servers) {
    if (!Array.isArray(servers) || servers.length === 0) {
      return DEFAULT_ICE_SERVERS.map(cloneIceServer);
    }

    const normalized = servers
      .map((server) => normalizeIceServer(server))
      .filter(Boolean);

    return normalized.length > 0 ? normalized : DEFAULT_ICE_SERVERS.map(cloneIceServer);
  }

  function normalizeIceServer(server) {
    if (!server || (!server.urls && !server.url)) {
      return null;
    }

    const urls = Array.isArray(server.urls)
      ? server.urls.filter((item) => typeof item === "string" && item.trim())
      : [server.urls || server.url].filter((item) => typeof item === "string" && item.trim());

    if (urls.length === 0) {
      return null;
    }

    const normalized = { urls: urls.length === 1 ? urls[0] : urls };
    if (typeof server.username === "string" && server.username) {
      normalized.username = server.username;
    }
    if (typeof server.credential === "string" && server.credential) {
      normalized.credential = server.credential;
    }
    return normalized;
  }

  function cloneIceServer(server) {
    const clone = {
      urls: Array.isArray(server.urls) ? server.urls.slice() : server.urls,
    };
    if (server.username) clone.username = server.username;
    if (server.credential) clone.credential = server.credential;
    return clone;
  }

  function sendSecure(conn, message) {
    if (!isUsableConnection(conn) || !activeSecureTransport) {
      return Promise.reject(new Error("secure connection is unavailable"));
    }
    return activeSecureTransport.send(message);
  }

  function safeSend(conn, message) {
    sendSecure(conn, message).catch((error) => {
      console.warn("[WO Transfer] Send skipped:", error);
    });
  }

  function buildChunkKey(transferId, seq) {
    return transferId + ":" + String(seq).padStart(12, "0");
  }

  function getTransferChunkKeys(transferId) {
    const prefix = transferId + ":";
    return Array.from(memoryChunkStore.keys())
      .filter((key) => key.startsWith(prefix))
      .sort();
  }

  function openTransferDb(dbName) {
    return new Promise((resolve) => {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }

      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(RECEIVE_STORE_NAME)) {
          const store = db.createObjectStore(RECEIVE_STORE_NAME, { keyPath: "key" });
          store.createIndex("byTransfer", "transferId", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        console.warn("[WO Transfer] IndexedDB unavailable, falling back to memory:", request.error);
        resolve(null);
      };
    });
  }

  async function storeChunk(dbPromise, transferId, seq, blob) {
    const db = await dbPromise;
    const key = buildChunkKey(transferId, seq);
    if (!db) {
      memoryChunkStore.set(key, blob);
      return;
    }

    return new Promise((resolve, reject) => {
      let queue = chunkWriteQueues.get(db);
      if (!queue) {
        queue = { db, items: [], timer: null, flushing: false };
        chunkWriteQueues.set(db, queue);
        activeChunkWriteQueues.add(queue);
      }
      queue.items.push({ key, transferId, seq, blob, resolve, reject });
      if (queue.items.length >= CHUNK_WRITE_BATCH_SIZE) {
        flushChunkWriteQueue(db, queue);
      } else if (!queue.timer) {
        queue.timer = setTimeout(() => flushChunkWriteQueue(db, queue), CHUNK_WRITE_BATCH_DELAY);
      }
    });
  }

  function flushChunkWriteQueue(db, queue) {
    if (queue.flushing || !queue.items.length) return;
    if (queue.timer) clearTimeout(queue.timer);
    queue.timer = null;
    queue.flushing = true;
    const items = queue.items.splice(0, CHUNK_WRITE_BATCH_SIZE);
    const tx = db.transaction(RECEIVE_STORE_NAME, "readwrite");
    const store = tx.objectStore(RECEIVE_STORE_NAME);
    items.forEach((item) => store.put({
      key: item.key,
      transferId: item.transferId,
      seq: item.seq,
      blob: item.blob,
    }));
    tx.oncomplete = () => items.forEach((item) => item.resolve());
    tx.onerror = () => items.forEach((item) => item.reject(tx.error));
    tx.onabort = () => items.forEach((item) => item.reject(tx.error));
    tx.addEventListener("complete", () => {
      queue.flushing = false;
      if (queue.items.length) flushChunkWriteQueue(db, queue);
    }, { once: true });
    tx.addEventListener("error", () => { queue.flushing = false; }, { once: true });
    tx.addEventListener("abort", () => { queue.flushing = false; }, { once: true });
  }

  async function loadStoredChunks(dbPromise, transferId) {
    const db = await dbPromise;
    if (!db) {
      return getTransferChunkKeys(transferId).map((key) => memoryChunkStore.get(key));
    }

    return new Promise((resolve, reject) => {
      const chunks = [];
      const tx = db.transaction(RECEIVE_STORE_NAME, "readonly");
      const store = tx.objectStore(RECEIVE_STORE_NAME);
      const range = IDBKeyRange.bound(buildChunkKey(transferId, 0), buildChunkKey(transferId, 999999999999));
      const request = store.openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(chunks);
          return;
        }
        chunks.push(cursor.value.blob);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function clearStoredChunks(dbPromise, transferId) {
    const db = await dbPromise;
    if (!db) {
      getTransferChunkKeys(transferId).forEach((key) => memoryChunkStore.delete(key));
      return;
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(RECEIVE_STORE_NAME, "readwrite");
      const store = tx.objectStore(RECEIVE_STORE_NAME);
      const range = IDBKeyRange.bound(buildChunkKey(transferId, 0), buildChunkKey(transferId, 999999999999));
      const request = store.openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function finalizeIncomingTransfer(dbPromise, transfer, updateStatus) {
    if (transfer.finalizePromise) return transfer.finalizePromise;
    transfer.finalizing = true;
    transfer.finalizePromise = (async () => {
      try {
        const blobParts = await loadStoredChunks(dbPromise, transfer.id);
        if (blobParts.length !== transfer.totalChunks) {
          throw new Error("Stored chunk count does not match file metadata");
        }
        if (transfer.expectedFileHash) {
          updateStatus(transfer.id, "正在验证完整文件...", "");
          const hasher = createFileHasher(getHashAlgorithm(transfer.expectedFileHash), transfer.legacy);
          for (const part of blobParts) {
            hasher.update(await part.arrayBuffer());
          }
          const actualFileHash = hasher.digest();
          if (actualFileHash !== transfer.expectedFileHash) {
            transfer.integrityFailed = true;
            transfer.finalizing = false;
            transfer.finalizePromise = null;
            await clearStoredChunks(dbPromise, transfer.id);
            updateStatus(transfer.id, "完整文件校验失败，正在重新接收...", "error");
            return false;
          }
        } else if (!transfer.legacy) {
          throw new Error("The complete SHA-256 digest is missing");
        }
        const blob = new Blob(blobParts);
        const url = URL.createObjectURL(blob);
        activeObjectUrls.add(url);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = transfer.name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => releaseObjectUrl(url), 5000);

        updateStatus(
          transfer.id,
          "已保存（" + ((Date.now() - transfer.startTime) / 1000).toFixed(1) + " 秒）",
          "done"
        );
        await clearStoredChunks(dbPromise, transfer.id);
        return true;
      } catch (error) {
        console.error("[WO Transfer] Finalize failed:", error);
        updateStatus(transfer.id, "保存失败", "error");
        transfer.finalizing = false;
        transfer.finalizePromise = null;
        return false;
      }
    })();
    return transfer.finalizePromise;
  }

  function normalizeArrayBuffer(value) {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    throw new Error("Unsupported chunk type");
  }

  async function createChunkHash(arrayBuffer, preferredAlgorithm, legacy) {
    const hasher = createFileHasher(preferredAlgorithm || DEFAULT_HASH_ALGORITHM, legacy);
    hasher.update(arrayBuffer);
    return hasher.digest();
  }

  function pickHashAlgorithm(preferredAlgorithm, legacy) {
    const normalized = String(preferredAlgorithm || DEFAULT_HASH_ALGORITHM).toLowerCase().replace("sha-256", "sha256");
    if (normalized === "sha256") return normalized;
    if (
      normalized === "fnv1a32"
      && runtimeConfig.allowLegacyProtocol
      && legacy === true
    ) return normalized;
    throw new Error("Unsupported or unsafe file hash algorithm: " + normalized);
  }

  function getHashAlgorithm(hashValue) {
    if (typeof hashValue !== "string") return null;
    const separatorIndex = hashValue.indexOf(":");
    return separatorIndex > 0 ? hashValue.slice(0, separatorIndex) : null;
  }

  function normalizeExpectedFileHash(value, legacy, expectedAlgorithm) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) {
      if (runtimeConfig.allowLegacyProtocol && legacy) return null;
      throw new Error("发送端缺少完整文件 SHA-256 摘要，已拒绝保存。");
    }
    const algorithm = pickHashAlgorithm(getHashAlgorithm(raw), legacy);
    if (expectedAlgorithm && algorithm !== expectedAlgorithm) {
      throw new Error("发送端的完整文件摘要算法与元数据不一致。");
    }
    const pattern = algorithm === "sha256" ? /^sha256:[0-9a-f]{64}$/ : /^fnv1a32:[0-9a-f]{8}$/;
    if (!pattern.test(raw)) throw new Error("发送端的完整文件摘要格式无效。");
    return raw;
  }

  function createFileHasher(preferredAlgorithm, legacy) {
    const algorithm = pickHashAlgorithm(preferredAlgorithm, legacy);
    if (algorithm === "sha256") {
      const secureRuntime = globalThis.WebOmniLanSecure;
      if (!secureRuntime || typeof secureRuntime.createSha256 !== "function") {
        throw new Error("SHA-256 runtime is unavailable");
      }
      const state = secureRuntime.createSha256();
      return Object.freeze({
        update(value) { state.update(value); },
        digest() { return "sha256:" + state.digestHex(); },
      });
    }

    let hash = 0x811c9dc5;
    let finished = false;
    return Object.freeze({
      update(value) {
        if (finished) throw new Error("FNV state is already finalized");
        const view = value instanceof Uint8Array ? value : new Uint8Array(value);
        for (let index = 0; index < view.length; index++) {
          hash ^= view[index];
          hash = Math.imul(hash, 0x01000193) >>> 0;
        }
      },
      digest() {
        if (finished) throw new Error("FNV state is already finalized");
        finished = true;
        return "fnv1a32:" + hash.toString(16).padStart(8, "0");
      },
    });
  }

  function getMissingSeqs(transfer, limit) {
    const missing = [];
    for (let seq = 0; seq < transfer.totalChunks; seq++) {
      if (!transfer.receivedChunks.has(seq)) {
        missing.push(seq);
        if (missing.length >= limit) break;
      }
    }
    return missing;
  }

  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  function renderQRCode(text, container) {
    container.innerHTML = "";
    try {
      const qr = qrcode(0, "M");
      qr.addData(text);
      qr.make();
      const image = document.createElement("img");
      image.src = qr.createDataURL(4, 0);
      image.style.cssText = "width:100%;height:100%;display:block;image-rendering:pixelated;";
      container.appendChild(image);
    } catch (error) {
      container.textContent = text;
      container.style.cssText = "font-family:ui-monospace,SFMono-Regular,monospace;color:#0d1117;";
    }
  }

  function generateRoomCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 6; i++) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return code;
  }

  function regenerateRoomCode() {
    roomCode = generateRoomCode();
    peerId = buildPeerId(roomCode);
    secureSession = createSecureSession();
    updateRoomCodeUi();
  }

  function buildPeerId(code) {
    return "wo-" + String(code || "").toLowerCase();
  }

  function readablePeerError(error) {
    if (!error) return "unknown error";
    return error.type || error.message || String(error);
  }

  function getReconnectDelay(attempt) {
    return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1)));
  }

  function isCurrentPeer(candidate, generation) {
    return !isPageClosing && peer === candidate && peerGeneration === generation;
  }

  function isCurrentConnection(candidate, generation) {
    return !isPageClosing && activeConn === candidate && connectionGeneration === generation;
  }

  function isUsableConnection(candidate) {
    return !isPageClosing
      && activeConn === candidate
      && Boolean(candidate && candidate.open)
      && Boolean(activeSecureTransport && activeSecureTransport.authenticated);
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function clearIncomingTransferTimers(transfer) {
    clearTimeout(transfer.ackTimer);
    clearTimeout(transfer.missingRetryTimer);
    transfer.ackTimer = null;
    transfer.missingRetryTimer = null;
  }

  function pauseIncomingTransferTimers() {
    incomingTransfers.forEach(clearIncomingTransferTimers);
  }

  function scheduleOutgoingCleanup(transfer) {
    clearTimeout(transfer.cleanupTimer);
    transfer.cleanupTimer = setTimeout(() => {
      clearTimeout(transfer.completionTimer);
      if (outgoingTransfers.get(transfer.id) === transfer) outgoingTransfers.delete(transfer.id);
    }, COMPLETED_TRANSFER_CACHE_MS);
  }

  function releaseObjectUrl(url) {
    if (!activeObjectUrls.has(url)) return;
    activeObjectUrls.delete(url);
    try { URL.revokeObjectURL(url); } catch (error) {}
  }

  function destroyPeer() {
    clearPeerOpenTimeout();
    clearReconnectTimer();
    peerGeneration++;
    connectionGeneration++;
    const previousConnection = activeConn;
    const previousPendingConnection = pendingConn;
    const previousPeer = peer;
    peer = null;
    activeConn = null;
    activeSecureTransport = null;
    activeChunkSize = CHUNK_SIZE;
    pendingConn = null;
    pendingConnectionGeneration++;
    pauseIncomingTransferTimers();
    if (previousConnection) {
      try { previousConnection.close(); } catch (error) {}
    }
    if (previousPendingConnection && previousPendingConnection !== previousConnection) {
      try { previousPendingConnection.close(); } catch (_) {}
    }
    if (previousPeer) {
      try { previousPeer.destroy(); } catch (error) {}
    }
  }

  function clearPeerOpenTimeout() {
    if (peerOpenTimeout) {
      clearTimeout(peerOpenTimeout);
      peerOpenTimeout = null;
    }
  }

  function cleanupRuntime() {
    if (isPageClosing) return;
    isPageClosing = true;
    releaseNativeHelper();
    clearPeerOpenTimeout();
    clearReconnectTimer();
    markPendingTextMessagesFailed("页面已关闭");
    sendQueue.length = 0;
    outgoingTransfers.forEach((transfer) => {
      clearTimeout(transfer.completionTimer);
      clearTimeout(transfer.cleanupTimer);
    });
    incomingTransfers.forEach(clearIncomingTransferTimers);
    activeChunkWriteQueues.forEach((queue) => {
      clearTimeout(queue.timer);
      queue.timer = null;
    });
    Array.from(activeObjectUrls).forEach(releaseObjectUrl);
    completedIncomingTransfers.clear();
    destroyPeer();
    dbPromise.then((db) => {
      if (db) db.close();
    }).catch(() => {});
  }

  function sanitizeFileName(name) {
    const sanitized = String(name || "")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/[\u0000-\u001f\u007f]+/g, "")
      .trim();
    return sanitized || "download.bin";
  }

  function randomId() {
    return Math.random().toString(36).slice(2, 10);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(String(value));
    }
    return String(value).replace(/"/g, '\\"');
  }
})();

