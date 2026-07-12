(function() {
  "use strict";

  const DEVICE_MEMORY_GB = typeof navigator !== "undefined" && typeof navigator.deviceMemory === "number"
    ? navigator.deviceMemory
    : 0;
  const DEVICE_TRANSFER_PROFILE = DEVICE_MEMORY_GB > 4
    ? Object.freeze({ chunkSize: 512 * 1024, bufferHighWaterMark: 8 * 1024 * 1024, ackWindowBytes: 32 * 1024 * 1024 })
    : DEVICE_MEMORY_GB > 2
      ? Object.freeze({ chunkSize: 256 * 1024, bufferHighWaterMark: 4 * 1024 * 1024, ackWindowBytes: 16 * 1024 * 1024 })
      : Object.freeze({ chunkSize: 128 * 1024, bufferHighWaterMark: 2 * 1024 * 1024, ackWindowBytes: 8 * 1024 * 1024 });
  const CHUNK_SIZE = DEVICE_TRANSFER_PROFILE.chunkSize;
  const LEGACY_CHUNK_SIZE = 64 * 1024;
  const RESEND_BATCH_SIZE = DEVICE_MEMORY_GB > 2 ? 64 : 32;
  const BUFFER_HIGH_WATER_MARK = DEVICE_TRANSFER_PROFILE.bufferHighWaterMark;
  const DEFAULT_ACK_WINDOW_BYTES = DEVICE_TRANSFER_PROFILE.ackWindowBytes;
  const MEMORY_RECEIVE_LIMIT_BYTES = 32 * 1024 * 1024;
  const SPEED_SAMPLE_WINDOW_MS = 1500;
  const PROGRESS_UPDATE_INTERVAL_MS = 120;
  const DEFAULT_HASH_ALGORITHM = "sha256";
  const TEXT_LIMIT_BYTES = __WO_TEXT_LIMIT__;
  const TEXT_ACK_TIMEOUT_MS = 15000;
  const CONNECTION_TIMEOUT_MS = 12000;
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
  const COMPLETED_STORE_RETENTION_MS = 10 * 60 * 1000;
  const URL_PATTERN = /\b((?:https?:\/\/|www\.)[^\s<]+[^\s<.,:;"')\]\}])/gi;
  const RECEIVE_DB_NAME = "wo-lan-transfer-vnext-mobile";
  const RECEIVE_STORE_NAME = "chunks";
  const EXPORTED_RUNTIME_CONFIG = __WO_RUNTIME_CONFIG__;
  const EXPORTED_SECURE_SESSION = __WO_SECURE_SESSION__;
  const LAUNCH_CONFIG = readLaunchConfig();
  const ACTIVE_RUNTIME_CONFIG = LAUNCH_CONFIG.runtimeConfig || EXPORTED_RUNTIME_CONFIG;
  const SIGNAL_SERVERS = Array.isArray(ACTIVE_RUNTIME_CONFIG.signalServers) && ACTIVE_RUNTIME_CONFIG.signalServers.length
    ? ACTIVE_RUNTIME_CONFIG.signalServers
    : [{ host: "0.peerjs.com", port: 443, secure: true, path: "/" }];
  const ICE_SERVERS = ACTIVE_RUNTIME_CONFIG.iceServers || [];
  const PREFILLED_ROOM_CODE = LAUNCH_CONFIG.roomCode || __WO_ROOM_CODE__;
  const SECURE_SESSION = LAUNCH_CONFIG.secureSession || EXPORTED_SECURE_SESSION;
  const LOCAL_RELAY_URL = LAUNCH_CONFIG.relayUrl || "";
  const ALLOW_LEGACY_PROTOCOL = Boolean(ACTIVE_RUNTIME_CONFIG.allowLegacyProtocol);
  const THEME_STORAGE_KEY = "woLanTransferThemeMode";

  const $ = function(id) { return document.getElementById(id); };
  const encoder = new TextEncoder();
  const outgoingTransfers = new Map();
  const incomingTransfers = new Map();
  const completedIncomingTransfers = new Map();
  const pendingTextMessages = new Map();
  const receivedTextMessages = new Set();
  const sendQueue = [];
  let sendQueueRunning = false;
  let peer = null;
  let conn = null;
  let secureTransport = null;
  let activeChunkSize = CHUNK_SIZE;
  let peerGeneration = 0;
  let connectionGeneration = 0;
  let connectionTimeout = null;
  let reconnectTimer = null;
  let targetPeerId = "";
  let isPageClosing = false;
  const dbPromise = openTransferDb(RECEIVE_DB_NAME);
  const memoryChunkStore = new Map();
  const chunkWriteQueues = new WeakMap();
  const activeChunkWriteQueues = new Set();
  const activeObjectUrls = new Set();
  const activeReceiveStores = new Set();
  const CHUNK_WRITE_BATCH_SIZE = 8;
  const CHUNK_WRITE_BATCH_DELAY = 35;
  const ACK_BATCH_SIZE = 8;
  const ACK_MAX_DELAY = 100;

  init();

  function readLaunchConfig() {
    try {
      const params = new URLSearchParams(location.hash.replace(/^#/, ""));
      if (params.get("v") !== "2") return {};
      const sessionId = params.get("s") || params.get("session") || "";
      const pairingSecret = params.get("k") || params.get("key") || "";
      let runtimeConfig = null;
      const encodedConfig = params.get("config");
      if (encodedConfig) {
        const normalized = encodedConfig.replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
        runtimeConfig = JSON.parse(atob(padded));
      }
      return {
        roomCode: String(params.get("room") || "").toUpperCase(),
        relayUrl: params.get("relay") || "",
        runtimeConfig,
        secureSession: sessionId && pairingSecret ? {
          sessionId,
          pairingSecret,
          targetPeerId: params.get("peer") || "",
        } : null,
      };
    } catch (_) {
      return {};
    }
  }

  function init() {
    $("roomCodeInput").value = PREFILLED_ROOM_CODE;
    initThemeMode();
    Array.prototype.forEach.call(document.querySelectorAll(".theme-btn[data-theme-mode]"), function(button) {
      button.addEventListener("click", function() {
        setThemeMode(String(button.dataset.themeMode || "auto"));
      });
    });
    $("statusBar").addEventListener("click", function() {
      const drawer = $("connectionDrawer");
      setConnectionDrawerCollapsed(!drawer.classList.contains("collapsed"));
    });
    $("connectBtn").addEventListener("click", function() { connectToDesktop(0); });
    $("pickFileBtn").addEventListener("click", function() { $("fileInput").click(); });
    $("fileInput").addEventListener("change", function(event) {
      queueFiles(event.target.files);
      event.target.value = "";
    });
    $("chatInput").addEventListener("input", updateChatComposerState);
    $("chatInput").addEventListener("paste", handleComposerPaste);
    $("chatInput").addEventListener("keydown", function(event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendTextMessage().catch(function(error) {
          console.error("[WO Mobile] Send text failed:", error);
        });
      }
    });
    $("sendChatBtn").addEventListener("click", function() {
      sendTextMessage().catch(function(error) {
        console.error("[WO Mobile] Send text failed:", error);
      });
    });
    ["dragenter", "dragover"].forEach(function(eventName) {
      $("conversationSurface").addEventListener(eventName, function(event) {
        event.preventDefault();
        event.stopPropagation();
        $("conversationSurface").classList.add("drag-over");
      });
    });
    ["dragleave", "drop"].forEach(function(eventName) {
      $("conversationSurface").addEventListener(eventName, function(event) {
        event.preventDefault();
        event.stopPropagation();
        $("conversationSurface").classList.remove("drag-over");
      });
    });
    $("conversationSurface").addEventListener("drop", function(event) {
      queueFiles(event.dataTransfer.files);
    });
    window.addEventListener("pagehide", cleanupRuntime, { once: true });
    window.addEventListener("beforeunload", cleanupRuntime, { once: true });
    updateChatComposerState();
    if (SECURE_SESSION && SECURE_SESSION.sessionId && SECURE_SESSION.pairingSecret) {
      setTimeout(function() { connectToDesktop(0, SECURE_SESSION.targetPeerId); }, 0);
    }
  }

  function handleComposerPaste(event) {
    var files = extractClipboardFiles(event.clipboardData);
    if (!files.length) {
      return;
    }

    event.preventDefault();
    queueFiles(files);
  }

  function extractClipboardFiles(clipboardData) {
    if (!clipboardData) return [];

    var results = [];
    var seenKeys = new Set();

    function pushFile(file) {
      if (!file) return;
      var normalized = normalizeClipboardFile(file, results.length);
      var key = [
        normalized.name,
        normalized.size,
        normalized.type,
        normalized.lastModified || 0
      ].join("::");
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      results.push(normalized);
    }

    if (clipboardData.files && clipboardData.files.length) {
      Array.prototype.forEach.call(clipboardData.files, function(file) {
        pushFile(file);
      });
    }

    if (clipboardData.items && clipboardData.items.length) {
      Array.prototype.forEach.call(clipboardData.items, function(item) {
        if (item.kind !== "file") return;
        pushFile(item.getAsFile());
      });
    }

    return results;
  }

  function normalizeClipboardFile(file, index) {
    if (!file) return file;
    if (file.name) return file;

    var extension = guessExtensionFromMime(file.type);
    var name = "clipboard-" + buildTimestampToken() + "-" + String(index + 1) + extension;

    try {
      return new File([file], name, {
        type: file.type || "application/octet-stream",
        lastModified: Date.now()
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
    var mime = String(type || "").toLowerCase();
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
    var slashIndex = mime.indexOf("/");
    if (slashIndex === -1 || slashIndex === mime.length - 1) return ".bin";
    return "." + mime.slice(slashIndex + 1).replace(/[^a-z0-9.+-]/g, "");
  }

  function buildTimestampToken() {
    var now = new Date();
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      "-",
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0")
    ].join("");
  }

  function initThemeMode() {
    applyThemeMode(loadStoredThemeMode());
    if (!window.matchMedia) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    var handleChange = function() {
      if (loadStoredThemeMode() === "auto") {
        applyThemeMode("auto");
      }
    };
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", handleChange);
    } else if (typeof media.addListener === "function") {
      media.addListener(handleChange);
    }
  }

  function loadStoredThemeMode() {
    try {
      var value = localStorage.getItem(THEME_STORAGE_KEY);
      return value === "dark" || value === "light" || value === "auto" ? value : "auto";
    } catch (error) {
      return "auto";
    }
  }

  function setThemeMode(mode) {
    var nextMode = mode === "dark" || mode === "light" || mode === "auto" ? mode : "auto";
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextMode);
    } catch (error) {}
    applyThemeMode(nextMode);
  }

  function applyThemeMode(mode) {
    var nextMode = mode === "dark" || mode === "light" || mode === "auto" ? mode : "auto";
    var resolvedTheme = resolveThemeMode(nextMode);
    document.documentElement.dataset.woThemeMode = nextMode;
    document.documentElement.dataset.woTheme = resolvedTheme;
    Array.prototype.forEach.call(document.querySelectorAll(".theme-btn[data-theme-mode]"), function(button) {
      var active = String(button.dataset.themeMode || "") === nextMode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function resolveThemeMode(mode) {
    if (mode === "dark" || mode === "light") return mode;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function updateChatComposerState() {
    const text = $("chatInput").value || "";
    const bytes = encoder.encode(text).byteLength;
    const connected = Boolean(conn && isUsableConnection(conn));
    const hasText = Boolean(text.trim());
    $("chatCounter").textContent = bytes + " / " + TEXT_LIMIT_BYTES;
    $("chatCounter").classList.toggle("over-limit", bytes > TEXT_LIMIT_BYTES);
    $("pickFileBtn").disabled = !connected;
    $("sendChatBtn").disabled = !connected || !hasText || bytes > TEXT_LIMIT_BYTES;
    syncChatInputHeight($("chatInput"));

    if (!connected) {
      $("chatHint").textContent = "等待安全连接";
    } else if (bytes > TEXT_LIMIT_BYTES) {
      $("chatHint").textContent = "内容超过 32 KB";
    } else {
      $("chatHint").textContent = "端到端加密";
    }
  }

  function syncChatInputHeight(input) {
    if (!input) return;
    const minHeight = 34;
    const maxHeight = 112;
    input.style.height = "0px";
    const nextHeight = Math.min(Math.max(input.scrollHeight, minHeight), maxHeight);
    input.style.height = nextHeight + "px";
    input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  function connectToDesktop(retryAttempt, requestedTarget) {
    const roomCode = $("roomCodeInput").value.trim().toUpperCase();
    if (!requestedTarget && roomCode.length < 4) {
      alert("请输入电脑端显示的房间码。");
      return;
    }

    const peerTargetId = requestedTarget || ("wo-" + roomCode.toLowerCase());
    const normalizedAttempt = Math.max(0, Number(retryAttempt) || 0);
    targetPeerId = peerTargetId;
    $("connectBtn").disabled = true;
    $("connectBtn").textContent = "连接中...";
    setStatus("正在连接电脑...", "connecting");
    updateChatComposerState();

    destroyPeer();
    if (isPageClosing) return;
    if (LOCAL_RELAY_URL) {
      try {
        const relayConnection = createRelayConnection(LOCAL_RELAY_URL, "mobile", SECURE_SESSION.sessionId);
        conn = relayConnection;
        attachConnection(relayConnection, peerTargetId);
      } catch (error) {
        setStatus("本地助手连接失败", "");
        $("connectBtn").disabled = false;
      }
      return;
    }
    const signalServer = SIGNAL_SERVERS[normalizedAttempt % SIGNAL_SERVERS.length];
    const generation = peerGeneration;
    const currentPeer = new Peer(undefined, {
      host: signalServer.host,
      port: signalServer.port,
      secure: signalServer.secure,
      path: signalServer.path,
      config: { iceServers: ICE_SERVERS },
      debug: 1
    });
    peer = currentPeer;

    connectionTimeout = setTimeout(function() {
      if (!isCurrentPeer(currentPeer, generation)) return;
      scheduleReconnect(peerTargetId, normalizedAttempt, "连接超时");
    }, CONNECTION_TIMEOUT_MS);

    currentPeer.on("open", function() {
      if (!isCurrentPeer(currentPeer, generation)) return;
      const connection = currentPeer.connect(peerTargetId, {
        reliable: true,
        serialization: "binary"
      });
      attachConnection(connection, peerTargetId);
    });

    currentPeer.on("error", function(error) {
      if (!isCurrentPeer(currentPeer, generation)) return;
      console.error("[WO Mobile] Peer error:", error);
      if (conn && conn.open) return;
      scheduleReconnect(peerTargetId, normalizedAttempt, "连接错误：" + readablePeerError(error));
    });

    currentPeer.on("disconnected", function() {
      if (!isCurrentPeer(currentPeer, generation) || (conn && conn.open)) return;
      scheduleReconnect(peerTargetId, normalizedAttempt, "信令连接已断开");
    });
  }

  function createRelayConnection(baseUrl, role, sessionId) {
    const url = new URL(baseUrl);
    url.searchParams.set("session", sessionId);
    url.searchParams.set("role", role);
    const socket = new WebSocket(url.href);
    const listeners = new Map();
    function emit(type, value) {
      const callbacks = listeners.get(type) || [];
      callbacks.slice().forEach(function(callback) { callback(value); });
    }
    const connection = {
      open: false,
      dataChannel: {
        get bufferedAmount() { return socket.bufferedAmount; }
      },
      on: function(type, callback) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(callback);
      },
      send: function(message) {
        if (socket.readyState !== WebSocket.OPEN) throw new Error("local relay is not open");
        socket.send(JSON.stringify(message));
      },
      close: function() { socket.close(1000, "closed"); }
    };
    socket.addEventListener("open", function() { connection.open = true; emit("open"); });
    socket.addEventListener("message", function(event) {
      try { emit("data", JSON.parse(String(event.data || "null"))); }
      catch (error) { emit("error", error); }
    });
    socket.addEventListener("close", function() { connection.open = false; emit("close"); });
    socket.addEventListener("error", function() { emit("error", new Error("local relay socket error")); });
    return connection;
  }

  function scheduleReconnect(peerTargetId, retryAttempt, reason) {
    clearConnectionTimeout();
    destroyPeer();
    if (retryAttempt >= MAX_RECONNECT_ATTEMPTS || isPageClosing) {
      setStatus(reason + "，自动重连已停止。", "");
      $("connectBtn").disabled = false;
      $("connectBtn").textContent = "连接";
      updateChatComposerState();
      return;
    }

    const nextAttempt = retryAttempt + 1;
    setStatus(reason + "，正在重连（" + nextAttempt + "/" + MAX_RECONNECT_ATTEMPTS + "）...", "connecting");
    reconnectTimer = setTimeout(function() {
      reconnectTimer = null;
      connectToDesktop(nextAttempt, peerTargetId);
    }, getReconnectDelay(nextAttempt));
  }

  function attachConnection(connection, peerTargetId) {
    if (conn && conn !== connection) {
      markPendingTextMessagesFailed("发送中断");
      try { conn.close(); } catch (error) {}
    }

    const generation = ++connectionGeneration;
    conn = connection;

    function promoteConnection(transport, legacy) {
      if (!isCurrentConnection(connection, generation)) return;
      clearConnectionTimeout();
      clearReconnectTimer();
      secureTransport = transport;
      activeChunkSize = transport.negotiatedCapabilities.chunkSize;
      $("connectBtn").disabled = false;
      $("connectBtn").textContent = "已连接";
      setStatus(legacy ? "旧协议连接：内容未受 v2 端到端保护" : "已安全连接到电脑", legacy ? "" : "connected");
      updateChatComposerState();
      resumePendingTransfers(connection);
      runSendQueue();
    }

    connection.on("open", function() {
      if (!isCurrentConnection(connection, generation)) return;
      clearConnectionTimeout();
      clearReconnectTimer();
      setStatus("正在验证加密会话...", "connecting");
      if (!SECURE_SESSION || !SECURE_SESSION.sessionId || !SECURE_SESSION.pairingSecret) {
        if (ALLOW_LEGACY_PROTOCOL) {
          promoteConnection(createLegacyTransport(connection), true);
        } else {
          setStatus("缺少 v2 安全会话参数，连接已拒绝", "");
          connection.close();
        }
        return;
      }
      secureTransport = globalThis.WebOmniLanSecure.createSecureTransport(connection, {
        role: "mobile",
        sessionId: SECURE_SESSION.sessionId,
        pairingSecret: SECURE_SESSION.pairingSecret,
        capabilities: {
          maxMessageBytes: Math.max(2 * 1024 * 1024, CHUNK_SIZE + 64 * 1024),
          chunkSize: CHUNK_SIZE,
          hash: [DEFAULT_HASH_ALGORITHM],
          resume: true
        },
        supportsBinaryEnvelope: !LOCAL_RELAY_URL,
      });
      const v2Transport = secureTransport;
      v2Transport.ready.then(function() {
        if (secureTransport !== v2Transport || !isCurrentConnection(connection, generation)) return;
        promoteConnection(v2Transport, false);
      }).catch(function(error) {
        if (secureTransport !== v2Transport) return;
        setStatus("安全验证失败，连接已关闭", "");
        console.warn("[WO Mobile] Secure handshake failed:", error);
      });
    });

    connection.on("data", function(message) {
      if (!isCurrentConnection(connection, generation) || !secureTransport) return;
      if (!secureTransport.authenticated && ALLOW_LEGACY_PROTOCOL && isLegacyProtocolMessage(message)) {
        secureTransport.abandon(new Error("v2 handshake replaced by explicit legacy mode"));
        promoteConnection(createLegacyTransport(connection), true);
        Promise.resolve(handleProtocolMessage(connection, message)).catch(function(error) {
          console.error("[WO Mobile] Legacy message handling failed:", error);
        });
        return;
      }
      if (secureTransport.legacy) {
        Promise.resolve(handleProtocolMessage(connection, message)).catch(function(error) {
          console.error("[WO Mobile] Legacy message handling failed:", error);
        });
        return;
      }
      Promise.resolve(secureTransport.handle(message)).then(function(result) {
        if (!result || !result.message) return;
        return handleProtocolMessage(connection, result.message);
      }).catch(function(error) {
        console.error("[WO Mobile] Message handling failed:", error);
      });
    });

    connection.on("close", function() {
      if (!isCurrentConnection(connection, generation)) return;
      conn = null;
      secureTransport = null;
      activeChunkSize = CHUNK_SIZE;
      connectionGeneration++;
      pauseIncomingTransferTimers();
      markPendingTextMessagesFailed("发送失败");
      updateChatComposerState();
      scheduleReconnect(peerTargetId, 0, "连接已关闭");
    });

    connection.on("error", function(error) {
      if (!isCurrentConnection(connection, generation)) return;
      console.error("[WO Mobile] Connection error:", error);
      setStatus("连接出错：" + readablePeerError(error), "");
      updateChatComposerState();
    });
  }

  function isLegacyProtocolMessage(message) {
    return Boolean(message && typeof message === "object" && [
      "file-meta",
      "file-chunk",
      "file-done",
      "file-resend-request",
      "file-ack",
      "file-complete",
      "text-message",
      "text-ack"
    ].includes(message.type));
  }

  function createLegacyTransport(connection) {
    return Object.freeze({
      authenticated: true,
      legacy: true,
      negotiatedCapabilities: Object.freeze({
        maxMessageBytes: 2 * 1024 * 1024,
        chunkSize: LEGACY_CHUNK_SIZE,
        hash: Object.freeze(["fnv1a32"]),
        resume: true
      }),
      featuresReady: Promise.resolve(),
      get negotiatedFeatures() {
        return Object.freeze({ binaryEnvelope: false, aeadChunkIntegrity: false, receiverReady: false });
      },
      send(message) {
        if (!connection.open) return Promise.reject(new Error("legacy connection is closed"));
        connection.send(message);
        return Promise.resolve();
      }
    });
  }
  async function handleProtocolMessage(connection, message) {
    if (!message || typeof message !== "object") return;

    switch (message.type) {
      case "file-meta":
        await beginIncomingTransfer(connection, message);
        break;
      case "file-chunk":
        await receiveChunk(connection, message);
        break;
      case "file-done":
        await markIncomingDone(connection, message);
        break;
      case "file-resend-request":
        await resendMissingChunks(connection, message);
        break;
      case "file-ack":
        markOutgoingAcknowledged(message);
        break;
      case "file-ready":
        markOutgoingReady(message);
        break;
      case "file-complete":
        markOutgoingComplete(message);
        break;
      case "text-message":
        handleIncomingTextMessage(connection, message);
        break;
      case "text-ack":
        markTextDelivered(message);
        break;
      default:
        break;
    }
  }

  function handleIncomingTextMessage(connection, message) {
    const id = String(message.id || "");
    const text = String(message.text || "");
    if (!id || !text) return;

    if (receivedTextMessages.has(id)) {
      safeSend(connection, { type: "text-ack", id: id });
      return;
    }

    if (encoder.encode(text).byteLength > TEXT_LIMIT_BYTES) {
      safeSend(connection, { type: "text-ack", id: id });
      return;
    }

    receivedTextMessages.add(id);
    addChatMessage({
      id: id,
      text: text,
      timestamp: Number(message.timestamp || Date.now()),
      statusText: "已接收",
      direction: "incoming"
    });
    safeSend(connection, { type: "text-ack", id: id });
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
    const text = $("chatInput").value.trim();
    if (!text) {
      updateChatComposerState();
      return;
    }

    if (!conn || !conn.open) {
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
      id: id,
      text: text,
      timestamp: timestamp,
      statusText: "发送中",
      direction: "outgoing"
    });

    $("chatInput").value = "";
    updateChatComposerState();

    try {
      await waitForDataChannel(conn);
      await sendSecure(conn, {
        type: "text-message",
        id: id,
        text: text,
        timestamp: timestamp,
        sender: "mobile"
      });

      const timeoutId = setTimeout(function() {
        pendingTextMessages.delete(id);
        updateChatMessageStatus(id, "发送失败", "error");
      }, TEXT_ACK_TIMEOUT_MS);

      pendingTextMessages.set(id, { timeoutId: timeoutId });
    } catch (error) {
      console.error("[WO Mobile] Text send error:", error);
      updateChatMessageStatus(id, "发送失败", "error");
    }
  }

  function ensureConversationStarted() {
    const empty = $("conversationEmpty");
    if (empty) empty.remove();
  }

  function addChatMessage(message) {
    const list = $("conversationStream");
    ensureConversationStarted();

    const item = document.createElement("article");
    item.className = "conversation-item text-message " + message.direction;
    item.dataset.id = message.id;

    const bubble = document.createElement("div");
    bubble.className = "text-bubble";

    const text = document.createElement("p");
    text.className = "text-body";
    renderRichMessageText(text, message.text);

    const meta = document.createElement("div");
    meta.className = "message-meta";

    const stamp = document.createElement("span");
    stamp.textContent = (message.direction === "outgoing" ? "我" : "电脑") + " · " + formatChatTime(message.timestamp);

    const actionWrap = document.createElement("div");
    actionWrap.className = "message-meta-actions";

    const status = document.createElement("span");
    status.className = "text-status";
    status.textContent = message.statusText || "";

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "chat-copy";
    copyButton.textContent = "复制";
    copyButton.addEventListener("click", function() {
      copyChatMessage(message.text, copyButton);
    });

    actionWrap.appendChild(status);
    actionWrap.appendChild(copyButton);
    meta.appendChild(stamp);
    meta.appendChild(actionWrap);

    bubble.appendChild(text);
    bubble.appendChild(meta);
    item.appendChild(bubble);
    list.appendChild(item);
    scrollConversationToBottom();
  }

  function renderRichMessageText(container, value) {
    container.textContent = "";
    var text = String(value || "");
    var lines = text.replace(/\r\n?/g, "\n").split("\n");

    lines.forEach(function(line, lineIndex) {
      appendLinkifiedLine(container, line);
      if (lineIndex < lines.length - 1) {
        container.appendChild(document.createElement("br"));
      }
    });
  }

  function appendLinkifiedLine(container, line) {
    URL_PATTERN.lastIndex = 0;
    var lastIndex = 0;
    var match;

    while ((match = URL_PATTERN.exec(line)) !== null) {
      var rawUrl = match[0];
      var href = normalizeMessageHref(rawUrl);
      var start = match.index;

      if (start > lastIndex) {
        container.appendChild(document.createTextNode(line.slice(lastIndex, start)));
      }

      if (href) {
        var link = document.createElement("a");
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
    var trimmed = String(rawUrl || "").trim();
    if (!trimmed) return "";

    var candidate = /^https?:\/\//i.test(trimmed) ? trimmed : "https://" + trimmed;
    try {
      var url = new URL(candidate);
      return /^https?:$/i.test(url.protocol) ? url.href : "";
    } catch (error) {
      return "";
    }
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
    navigator.clipboard.writeText(text).then(function() {
      const original = button.textContent;
      button.textContent = "已复制";
      setTimeout(function() {
        button.textContent = original;
      }, 1500);
    }).catch(function() {
      button.textContent = "复制失败";
      setTimeout(function() {
        button.textContent = "复制";
      }, 1500);
    });
  }

  function markPendingTextMessagesFailed(statusText) {
    pendingTextMessages.forEach(function(pending, id) {
      clearTimeout(pending.timeoutId);
      updateChatMessageStatus(id, statusText || "发送失败", "error");
    });
    pendingTextMessages.clear();
  }

  function scrollConversationToBottom() {
    const list = $("conversationStream");
    list.scrollTop = list.scrollHeight;
  }

  function formatChatTime(timestamp) {
    try {
      return new Date(timestamp).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit"
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

  function getNegotiatedFeatures() {
    const features = secureTransport && secureTransport.negotiatedFeatures;
    return {
      binaryEnvelope: Boolean(features && features.binaryEnvelope),
      aeadChunkIntegrity: Boolean(features && features.aeadChunkIntegrity),
      receiverReady: Boolean(features && features.receiverReady)
    };
  }

  async function waitForTransportFeatures(transport) {
    if (transport && transport.featuresReady && typeof transport.featuresReady.then === "function") {
      await transport.featuresReady;
    }
    return getNegotiatedFeatures();
  }

  function formatTransferSpeed(transfer, completedBytes) {
    const now = performance.now();
    if (!Array.isArray(transfer.speedSamples)) transfer.speedSamples = [];
    const samples = transfer.speedSamples;
    const last = samples[samples.length - 1];
    if (!last || completedBytes !== last.bytes || now - last.at >= 100) {
      samples.push({ at: now, bytes: completedBytes });
    }
    while (samples.length > 2 && samples[1].at < now - SPEED_SAMPLE_WINDOW_MS) samples.shift();
    if (samples.length < 2) return "准备中";
    const first = samples[0];
    const elapsedSeconds = Math.max(.1, (now - first.at) / 1000);
    return formatSize(Math.max(0, Math.round((completedBytes - first.bytes) / elapsedSeconds))) + "/s";
  }

  async function beginIncomingTransfer(connection, meta) {
    const transferId = String(meta.id || "");
    if (!transferId) return;
    const features = getNegotiatedFeatures();

    const completed = completedIncomingTransfers.get(transferId);
    if (completed) {
      safeSend(connection, { type: "file-complete", id: transferId, receivedBytes: completed.receivedBytes, fileHash: completed.fileHash });
      return;
    }

    const size = Number(meta.size);
    const totalChunks = Number(meta.totalChunks);
    const chunkSize = Number(meta.chunkSize || activeChunkSize);
    const expectedChunks = Math.ceil(size / chunkSize) || 1;
    const legacy = Boolean(secureTransport && secureTransport.legacy);
    let hashAlgorithm;
    try {
      hashAlgorithm = pickHashAlgorithm(meta.hashAlgorithm || (legacy ? "fnv1a32" : DEFAULT_HASH_ALGORITHM), legacy);
    } catch (error) {
      rejectIncomingTransfer(connection, transferId, "文件摘要算法不受支持");
      return;
    }
    if (!Number.isSafeInteger(size) || size < 0
      || !Number.isSafeInteger(chunkSize) || chunkSize < 16 * 1024 || chunkSize > activeChunkSize
      || (!secureTransport.legacy && chunkSize !== activeChunkSize)
      || !Number.isSafeInteger(totalChunks) || totalChunks !== expectedChunks) {
      rejectIncomingTransfer(connection, transferId, "文件元数据无效");
      return;
    }

    const existing = incomingTransfers.get(transferId);
    if (existing) {
      if (existing.size === size && existing.totalChunks === totalChunks && existing.chunkSize === chunkSize
        && existing.legacy === legacy && existing.hashAlgorithm === hashAlgorithm) {
        existing.missingRetryAttempts = 0;
        if (features.receiverReady && existing.storageReady) {
          safeSend(connection, {
            type: "file-ready",
            id: transferId,
            accepted: true,
            maxInFlightBytes: existing.maxInFlightBytes
          });
        }
        scheduleFileAck(connection, existing, true);
        return;
      }
      clearIncomingTransferTimers(existing);
      incomingTransfers.delete(transferId);
      await disposeReceiveStore(existing.receiveStore).catch(function() {});
    }

    const transfer = {
      id: transferId,
      name: sanitizeFileName(meta.name || "download.bin"),
      size: size,
      totalChunks: totalChunks,
      chunkSize: chunkSize,
      legacy: legacy,
      hashAlgorithm: hashAlgorithm,
      aeadChunkIntegrity: features.aeadChunkIntegrity,
      maxInFlightBytes: DEFAULT_ACK_WINDOW_BYTES,
      receiveStore: null,
      storageReadyPromise: null,
      storageReady: false,
      rejected: false,
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
      storageFailed: false,
      storageError: "",
      speedSamples: []
    };

    incomingTransfers.set(transferId, transfer);
    addFileItem(transferId, transfer.name, transfer.size, "recv", "正在准备存储...");
    try {
      transfer.storageReadyPromise = createReceiveStore(transfer);
      transfer.receiveStore = await transfer.storageReadyPromise;
      if (incomingTransfers.get(transferId) !== transfer) {
        await disposeReceiveStore(transfer.receiveStore);
        return;
      }
      transfer.storageReady = true;
      updateFileStatus(transfer.id, "写入中", "");
      if (features.receiverReady) {
        await sendSecure(connection, {
          type: "file-ready",
          id: transfer.id,
          accepted: true,
          maxInFlightBytes: transfer.maxInFlightBytes
        });
      }
    } catch (error) {
      transfer.rejected = true;
      incomingTransfers.delete(transferId);
      const message = readableStorageError(error);
      updateFileStatus(transfer.id, message, "error");
      if (features.receiverReady) {
        safeSend(connection, { type: "file-ready", id: transfer.id, accepted: false, error: message });
      }
    }
  }

  function rejectIncomingTransfer(connection, transferId, message) {
    if (getNegotiatedFeatures().receiverReady) {
      safeSend(connection, { type: "file-ready", id: transferId, accepted: false, error: message });
    }
  }

  async function receiveChunk(connection, payload) {
    const transferId = String(payload.id || "");
    const completed = completedIncomingTransfers.get(transferId);
    if (completed) {
      safeSend(connection, { type: "file-complete", id: transferId, receivedBytes: completed.receivedBytes, fileHash: completed.fileHash });
      return;
    }
    const transfer = incomingTransfers.get(transferId);
    if (!transfer) return;

    const seq = Number(payload.seq);
    if (!Number.isInteger(seq) || seq < 0 || seq >= transfer.totalChunks) return;
    if (transfer.receivedChunks.has(seq)) {
      scheduleFileAck(connection, transfer, true);
      return;
    }
    if (transfer.pendingChunks.has(seq)) return;
    transfer.pendingChunks.add(seq);

    try {
      if (!transfer.storageReady) {
        await transfer.storageReadyPromise;
      }
      if (incomingTransfers.get(transfer.id) !== transfer || !transfer.receiveStore) return;
      const arrayBuffer = normalizeArrayBuffer(payload.chunk);
      const expectedSize = seq === transfer.totalChunks - 1 ? Math.max(0, transfer.size - (seq * transfer.chunkSize)) : transfer.chunkSize;
      let chunkHashValid = true;
      if (!transfer.aeadChunkIntegrity || payload.hash) {
        if (!payload.hash) throw new Error("Chunk digest is missing");
        const chunkHashAlgorithm = pickHashAlgorithm(getHashAlgorithm(payload.hash), transfer.legacy);
        if (chunkHashAlgorithm !== transfer.hashAlgorithm) throw new Error("Chunk hash policy changed during transfer");
        const hash = await createChunkHash(arrayBuffer, chunkHashAlgorithm, transfer.legacy);
        chunkHashValid = payload.hash === hash;
      }
      if (arrayBuffer.byteLength !== expectedSize || !chunkHashValid) {
        updateFileStatus(transfer.id, "数据校验失败，正在请求重传...", "error");
        safeSend(connection, { type: "file-resend-request", id: transfer.id, seqs: [seq] });
        return;
      }

      await transfer.receiveStore.write(seq, arrayBuffer);
      if (incomingTransfers.get(transfer.id) !== transfer || transfer.receivedChunks.has(seq)) return;
      transfer.receivedChunks.add(seq);
      transfer.receivedBytes += arrayBuffer.byteLength;
      transfer.missingRetryAttempts = 0;
      const statusElement = document.querySelector('.file-message[data-id="' + cssEscape(transfer.id) + '"] .file-status.error');
      if (statusElement) updateFileStatus(transfer.id, "写入中", "");

      const pct = transfer.size > 0 ? Math.min(100, Math.round((transfer.receivedBytes / transfer.size) * 100)) : 100;
      maybeUpdateTransferProgress(transfer, pct, formatTransferSpeed(transfer, transfer.receivedBytes), transfer.receivedChunks.size === transfer.totalChunks);

      scheduleFileAck(connection, transfer, transfer.receivedChunks.size === transfer.totalChunks);

      if (transfer.doneReceived && transfer.receivedChunks.size === transfer.totalChunks) {
        await finalizeAndConfirmIncoming(connection, transfer);
      } else if (transfer.doneReceived) {
        scheduleMissingChunkRetry(connection, transfer);
      }
    } catch (error) {
      console.warn("[WO Mobile] Chunk validation failed:", error);
      if (isReceiveStorageFailure(error)) {
        const message = readableStorageError(error);
        incomingTransfers.delete(transfer.id);
        updateFileStatus(transfer.id, message, "error");
        if (getNegotiatedFeatures().receiverReady) {
          safeSend(connection, { type: "file-ready", id: transfer.id, accepted: false, error: message });
        }
        await disposeReceiveStore(transfer.receiveStore).catch(function() {});
        transfer.receiveStore = null;
        return;
      }
      updateFileStatus(transfer.id, "分片处理失败，正在请求重传...", "error");
      safeSend(connection, { type: "file-resend-request", id: transfer.id, seqs: [seq] });
    } finally {
      transfer.pendingChunks.delete(seq);
    }
  }

  function scheduleFileAck(connection, transfer, force) {
    function sendAck() {
      if (transfer.ackTimer) clearTimeout(transfer.ackTimer);
      transfer.ackTimer = null;
      transfer.lastAckSentCount = transfer.receivedChunks.size;
      transfer.lastAckSentAt = Date.now();
      safeSend(connection, {
        type: "file-ack",
        id: transfer.id,
        receivedCount: transfer.receivedChunks.size,
        receivedBytes: transfer.receivedBytes
      });
    }

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

  async function markIncomingDone(connection, payload) {
    const transferId = String(payload.id || "");
    const completed = completedIncomingTransfers.get(transferId);
    if (completed) {
      safeSend(connection, { type: "file-complete", id: transferId, receivedBytes: completed.receivedBytes, fileHash: completed.fileHash });
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
      await finalizeAndConfirmIncoming(connection, transfer);
      return;
    }

    requestMissingChunks(connection, transfer);
  }

  function requestMissingChunks(connection, transfer) {
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
    safeSend(connection, { type: "file-resend-request", id: transfer.id, seqs: missingSeqs });
    transfer.missingRetryTimer = setTimeout(function() { requestMissingChunks(connection, transfer); }, MISSING_CHUNK_RETRY_MS);
  }

  function scheduleMissingChunkRetry(connection, transfer) {
    if (transfer.missingRetryTimer) return;
    transfer.missingRetryTimer = setTimeout(function() { requestMissingChunks(connection, transfer); }, MISSING_CHUNK_RETRY_MS);
  }

  async function finalizeAndConfirmIncoming(connection, transfer) {
    const saved = await finalizeIncomingTransfer(transfer, updateFileStatus);
    if (!saved) {
      if (transfer.integrityFailed) {
        transfer.integrityFailed = false;
        transfer.receivedChunks.clear();
        transfer.pendingChunks.clear();
        transfer.receivedBytes = 0;
        transfer.missingRetryAttempts = 0;
        requestMissingChunks(connection, transfer);
      }
      if (transfer.storageFailed) {
        incomingTransfers.delete(transfer.id);
        safeSend(connection, {
          type: "file-ready",
          id: transfer.id,
          accepted: false,
          error: transfer.storageError || "文件保存失败"
        });
      }
      return;
    }
    clearIncomingTransferTimers(transfer);
    incomingTransfers.delete(transfer.id);
    completedIncomingTransfers.set(transfer.id, { receivedBytes: transfer.receivedBytes, fileHash: transfer.expectedFileHash });
    setTimeout(function() { completedIncomingTransfers.delete(transfer.id); }, COMPLETED_TRANSFER_CACHE_MS);
    safeSend(connection, { type: "file-complete", id: transfer.id, receivedBytes: transfer.receivedBytes, fileHash: transfer.expectedFileHash });
  }

  function markOutgoingAcknowledged(message) {
    const transfer = outgoingTransfers.get(String(message.id || ""));
    if (!transfer) return;
    transfer.lastAckCount = Math.max(transfer.lastAckCount, Number(message.receivedCount || 0));
    transfer.lastAckBytes = Math.max(transfer.lastAckBytes, Number(message.receivedBytes || 0));
    transfer.lastAckAt = Date.now();
    if (transfer.ackWaiters) {
      Array.from(transfer.ackWaiters).forEach(function(resolve) { resolve(); });
      transfer.ackWaiters.clear();
    }
  }

  function markOutgoingReady(message) {
    const transfer = outgoingTransfers.get(String(message.id || ""));
    if (!transfer || !transfer.receiverReadyExpected) return;
    if (!transfer.receiverReadyResolve) {
      if (message.accepted === false) {
        const error = new Error(String(message.error || "接收端已停止文件接收"));
        error.code = "RECEIVER_REJECTED";
        transfer.abortError = error;
        Array.from(transfer.ackWaiters || []).forEach(function(resolve) { resolve(); });
      }
      return;
    }
    const resolve = transfer.receiverReadyResolve;
    const reject = transfer.receiverReadyReject;
    transfer.receiverReadyResolve = null;
    transfer.receiverReadyReject = null;
    if (message.accepted === false) {
      const error = new Error(String(message.error || "接收端无法准备文件存储"));
      error.code = "RECEIVER_REJECTED";
      reject(error);
      return;
    }
    const remoteWindow = Number(message.maxInFlightBytes);
    if (Number.isSafeInteger(remoteWindow) && remoteWindow >= transfer.chunkSize) {
      transfer.maxInFlightBytes = Math.min(DEFAULT_ACK_WINDOW_BYTES, remoteWindow);
    }
    resolve();
  }

  function markOutgoingComplete(message) {
    const transfer = outgoingTransfers.get(String(message.id || ""));
    if (!transfer) return;
    if (transfer.fileHash && ((!transfer.legacy && message.fileHash !== transfer.fileHash)
      || (message.fileHash && message.fileHash !== transfer.fileHash))) {
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

  function queueFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    if (!conn || !isUsableConnection(conn)) {
      alert("请先连接电脑。");
      return;
    }

    files.forEach(function(file) {
      const transfer = {
        id: "send-" + randomId(),
        file: file,
        totalChunks: Math.ceil(file.size / activeChunkSize) || 1,
        chunkSize: activeChunkSize,
        startTime: 0,
        sentBytes: 0,
        lastAckCount: 0,
        lastAckBytes: 0,
        lastAckAt: 0,
        maxInFlightBytes: DEFAULT_ACK_WINDOW_BYTES,
        ackWaiters: new Set(),
        receiverReadyExpected: false,
        receiverReadyPromise: null,
        receiverReadyResolve: null,
        receiverReadyReject: null,
        abortError: null,
        lastUiUpdateAt: 0,
        sendAttempts: 0,
        state: "queued",
        completed: false,
        completionAttempts: 0,
        completionTimer: null,
        cleanupTimer: null,
        fileHash: null,
        hashAlgorithm: null,
        speedSamples: []
      };
      outgoingTransfers.set(transfer.id, transfer);
      sendQueue.push(transfer);
      addFileItem(transfer.id, file.name, file.size, "send", "等待发送");
    });

    runSendQueue();
  }

  async function runSendQueue() {
    if (sendQueueRunning) return;
    sendQueueRunning = true;

    while (sendQueue.length > 0) {
      if (!conn || !conn.open) break;
      const transfer = sendQueue.shift();
      if (!transfer || transfer.completed) continue;
      const connection = conn;
      try {
        transfer.sendAttempts++;
        transfer.state = "sending";
        await sendTransfer(connection, transfer);
        transfer.state = "awaiting-complete";
        armCompletionProbe(connection, transfer);
      } catch (error) {
        console.error("[WO Mobile] Send failed:", error);
        if (!isPageClosing && error.code !== "RECEIVER_REJECTED" && transfer.sendAttempts < MAX_SEND_ATTEMPTS) {
          transfer.state = "queued";
          sendQueue.unshift(transfer);
          updateFileStatus(transfer.id, conn && conn.open ? "发送受阻，正在重试..." : "连接中断，等待恢复...", "");
          if (conn && conn.open) await sleep(getReconnectDelay(transfer.sendAttempts));
          else break;
        } else {
          transfer.state = "failed";
          updateFileStatus(transfer.id, error.code === "RECEIVER_REJECTED" ? error.message : "发送失败", "error");
          scheduleOutgoingCleanup(transfer);
        }
      }
    }

    sendQueueRunning = false;
  }

  async function sendTransfer(connection, transfer) {
    if (!isUsableConnection(connection)) throw new Error("connection unavailable");

    const transport = secureTransport;
    const features = await waitForTransportFeatures(transport);
    if (secureTransport !== transport || !isUsableConnection(connection)) throw new Error("connection capabilities changed");
    updateFileStatus(transfer.id, "传输中", "");
    transfer.startTime = Date.now();
    transfer.sentBytes = 0;
    transfer.lastAckBytes = 0;
    transfer.lastAckCount = 0;
    transfer.lastAckAt = Date.now();
    transfer.speedSamples = [];
    transfer.abortError = null;
    transfer.chunkSize = activeChunkSize;
    transfer.totalChunks = Math.ceil(transfer.file.size / transfer.chunkSize) || 1;
    transfer.hashAlgorithm = secureTransport.legacy ? "fnv1a32" : DEFAULT_HASH_ALGORITHM;
    transfer.legacy = Boolean(secureTransport.legacy);
    transfer.aeadChunkIntegrity = features.aeadChunkIntegrity;
    transfer.receiverReadyExpected = features.receiverReady;
    transfer.maxInFlightBytes = DEFAULT_ACK_WINDOW_BYTES;
    transfer.fileHash = null;
    const fileHasher = createFileHasher(transfer.hashAlgorithm, transfer.legacy);

    if (transfer.receiverReadyExpected) prepareReceiverReadyWait(transfer);

    await sendSecure(connection, {
      type: "file-meta",
      id: transfer.id,
      name: transfer.file.name,
      size: transfer.file.size,
      totalChunks: transfer.totalChunks,
      chunkSize: transfer.chunkSize,
      lastModified: transfer.file.lastModified || Date.now(),
      hashAlgorithm: transfer.hashAlgorithm
    });

    if (transfer.receiverReadyExpected) {
      updateFileStatus(transfer.id, "等待接收端准备...", "");
      await waitForReceiverReady(transfer);
      updateFileStatus(transfer.id, "传输中", "");
    }

    let nextChunkPromise = readFileChunk(transfer, 0);
    for (let seq = 0; seq < transfer.totalChunks; seq++) {
      if (transfer.abortError) throw transfer.abortError;
      const arrayBuffer = await nextChunkPromise;
      nextChunkPromise = seq + 1 < transfer.totalChunks ? readFileChunk(transfer, seq + 1) : null;
      const hash = transfer.aeadChunkIntegrity
        ? null
        : await createChunkHash(arrayBuffer, transfer.hashAlgorithm, transfer.legacy);
      fileHasher.update(arrayBuffer);

      await waitForAckWindow(connection, transfer, arrayBuffer.byteLength);
      await waitForDataChannel(connection);
      const chunkMessage = {
        type: "file-chunk",
        id: transfer.id,
        seq: seq,
        totalChunks: transfer.totalChunks,
        chunkSize: transfer.chunkSize,
        chunk: arrayBuffer
      };
      if (hash) chunkMessage.hash = hash;
      await sendSecure(connection, chunkMessage);

      transfer.sentBytes += arrayBuffer.byteLength;
      const pct = transfer.file.size > 0
        ? Math.min(100, Math.round((transfer.sentBytes / transfer.file.size) * 100))
        : 100;
      maybeUpdateTransferProgress(
        transfer,
        pct,
        formatTransferSpeed(transfer, transfer.sentBytes),
        seq === transfer.totalChunks - 1
      );
    }

    transfer.fileHash = fileHasher.digest();
    await sendSecure(connection, { type: "file-done", id: transfer.id, totalChunks: transfer.totalChunks, fileHash: transfer.fileHash });
    updateFileStatus(transfer.id, "等待接收端校验...", "");
  }

  function readFileChunk(transfer, seq) {
    const start = seq * transfer.chunkSize;
    const end = Math.min(start + transfer.chunkSize, transfer.file.size);
    return transfer.file.slice(start, end).arrayBuffer();
  }

  function prepareReceiverReadyWait(transfer) {
    transfer.receiverReadyPromise = new Promise(function(resolve, reject) {
      transfer.receiverReadyResolve = resolve;
      transfer.receiverReadyReject = reject;
    });
  }

  async function waitForReceiverReady(transfer) {
    let timeoutId;
    try {
      await Promise.race([
        transfer.receiverReadyPromise,
        new Promise(function(_, reject) {
          timeoutId = setTimeout(function() { reject(new Error("接收端存储准备超时")); }, DATA_CHANNEL_STALL_TIMEOUT_MS);
        })
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function waitForAckWindow(connection, transfer, nextBytes) {
    const deadline = Date.now() + DATA_CHANNEL_STALL_TIMEOUT_MS;
    while (transfer.sentBytes - transfer.lastAckBytes + nextBytes > transfer.maxInFlightBytes) {
      if (transfer.abortError) throw transfer.abortError;
      if (!isUsableConnection(connection)) throw new Error("connection replaced or closed");
      if (Date.now() >= deadline) throw new Error("receiver acknowledgement timeout");
      await new Promise(function(resolve) {
        let settled = false;
        const finish = function() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          transfer.ackWaiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, Math.min(250, Math.max(1, deadline - Date.now())));
        transfer.ackWaiters.add(finish);
      });
    }
  }

  function armCompletionProbe(connection, transfer) {
    clearTimeout(transfer.completionTimer);
    if (transfer.completed) return;
    transfer.completionAttempts = 0;
    function probe() {
      if (transfer.completed || transfer.state !== "awaiting-complete" || !isUsableConnection(connection)) return;
      if (transfer.completionAttempts >= FILE_COMPLETE_MAX_ATTEMPTS) {
        updateFileStatus(transfer.id, "确认超时，等待连接恢复。", "error");
        return;
      }
      transfer.completionAttempts++;
      safeSend(connection, { type: "file-done", id: transfer.id, totalChunks: transfer.totalChunks, fileHash: transfer.fileHash });
      transfer.completionTimer = setTimeout(probe, FILE_COMPLETE_RETRY_MS);
    }
    transfer.completionTimer = setTimeout(probe, FILE_COMPLETE_RETRY_MS);
  }

  function resumePendingTransfers(connection) {
    outgoingTransfers.forEach(function(transfer) {
      if (transfer.completed || transfer.state !== "awaiting-complete") return;
      if (transfer.chunkSize !== activeChunkSize || transfer.legacy !== Boolean(secureTransport.legacy)) {
        clearTimeout(transfer.completionTimer);
        transfer.completionTimer = null;
        transfer.state = "queued";
        if (!sendQueue.includes(transfer)) sendQueue.unshift(transfer);
        updateFileStatus(transfer.id, "连接能力已变化，正在重新发送...", "");
        return;
      }
      safeSend(connection, { type: "file-meta", id: transfer.id, name: transfer.file.name, size: transfer.file.size, totalChunks: transfer.totalChunks, chunkSize: transfer.chunkSize, lastModified: transfer.file.lastModified || Date.now(), hashAlgorithm: transfer.hashAlgorithm });
      safeSend(connection, { type: "file-done", id: transfer.id, totalChunks: transfer.totalChunks, fileHash: transfer.fileHash });
      armCompletionProbe(connection, transfer);
    });
  }

  async function resendMissingChunks(connection, message) {
    const transfer = outgoingTransfers.get(String(message.id || ""));
    if (!transfer || !connection || !connection.open) return;

    const seqs = Array.isArray(message.seqs)
      ? Array.from(new Set(message.seqs.filter(function(seq) { return Number.isInteger(seq) && seq >= 0 && seq < transfer.totalChunks; }))).slice(0, RESEND_BATCH_SIZE)
      : [];

    for (const seq of seqs) {
      const arrayBuffer = await readFileChunk(transfer, seq);
      const hash = transfer.aeadChunkIntegrity
        ? null
        : await createChunkHash(arrayBuffer, transfer.hashAlgorithm, transfer.legacy);
      await waitForDataChannel(connection);
      const chunkMessage = {
        type: "file-chunk",
        id: transfer.id,
        seq: seq,
        totalChunks: transfer.totalChunks,
        chunkSize: transfer.chunkSize,
        chunk: arrayBuffer
      };
      if (hash) chunkMessage.hash = hash;
      await sendSecure(connection, chunkMessage);
    }
  }

  async function waitForDataChannel(connection) {
    if (!isUsableConnection(connection)) throw new Error("connection closed");

    const dataChannel = connection.dataChannel || connection._dc;
    if (!dataChannel) return;

    if (dataChannel.bufferedAmount <= BUFFER_HIGH_WATER_MARK) return;
    const deadline = Date.now() + DATA_CHANNEL_STALL_TIMEOUT_MS;
    if (typeof dataChannel.addEventListener !== "function") {
      while (dataChannel.bufferedAmount > BUFFER_HIGH_WATER_MARK) {
        if (!isUsableConnection(connection)) throw new Error("connection replaced or closed");
        if (Date.now() >= deadline) throw new Error("data channel backpressure timeout");
        await sleep(50);
      }
      return;
    }

    const previousThreshold = dataChannel.bufferedAmountLowThreshold;
    dataChannel.bufferedAmountLowThreshold = BUFFER_HIGH_WATER_MARK;
    try {
      await new Promise(function(resolve, reject) {
        let timer = null;
        let pollTimer = null;
        const cleanup = function() {
          clearTimeout(timer);
          clearInterval(pollTimer);
          dataChannel.removeEventListener("bufferedamountlow", check);
        };
        const check = function() {
          if (!isUsableConnection(connection)) {
            cleanup();
            reject(new Error("connection replaced or closed"));
          } else if (dataChannel.bufferedAmount <= BUFFER_HIGH_WATER_MARK) {
            cleanup();
            resolve();
          }
        };
        dataChannel.addEventListener("bufferedamountlow", check);
        pollTimer = setInterval(check, 100);
        timer = setTimeout(function() {
          cleanup();
          reject(new Error("data channel backpressure timeout"));
        }, DATA_CHANNEL_STALL_TIMEOUT_MS);
        check();
      });
    } finally {
      dataChannel.bufferedAmountLowThreshold = previousThreshold;
    }
  }

  function addFileItem(id, name, size, direction, statusText) {
    const list = $("conversationStream");
    const empty = $("conversationEmpty");
    if (empty) empty.remove();
    const previousItem = document.querySelector('.file-message[data-id="' + cssEscape(id) + '"]');
    if (previousItem) previousItem.remove();

    const item = document.createElement("article");
    item.className = "conversation-item file-message " + (direction === "recv" ? "incoming" : "outgoing");
    item.dataset.id = id;

    const bubble = document.createElement("div");
    bubble.className = "file-bubble";

    const icon = document.createElement("div");
    icon.className = "file-icon";
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
    item.appendChild(bubble);
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
    } else {
      progressBar.style.background = "";
    }

    status.className = "file-status" + (cls ? " " + cls : "");
    status.textContent = text;
  }

  function setStatus(text, state) {
    $("statusText").textContent = text;
    $("statusBar").className = "status" + (state ? " " + state : "");
    document.body.dataset.connectionState = state || "idle";
    if (state === "connected") {
      setConnectionDrawerCollapsed(true);
    } else if (!state) {
      setConnectionDrawerCollapsed(false);
    }
  }

  function setConnectionDrawerCollapsed(collapsed) {
    const drawer = $("connectionDrawer");
    const statusBar = $("statusBar");
    if (!drawer || !statusBar) return;
    drawer.classList.toggle("collapsed", Boolean(collapsed));
    statusBar.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }

  async function createReceiveStore(transfer) {
    await ensureReceiveCapacity(transfer.size);
    let store;
    if (transfer.size <= MEMORY_RECEIVE_LIMIT_BYTES) {
      store = createMemoryReceiveStore(transfer);
    } else {
      try {
        store = await createOpfsReceiveStore(transfer);
      } catch (error) {
        console.warn("[WO Mobile] OPFS unavailable, using IndexedDB:", error);
        store = await createIndexedDbReceiveStore(transfer);
      }
    }
    activeReceiveStores.add(store);
    return store;
  }

  async function ensureReceiveCapacity(size) {
    if (size <= MEMORY_RECEIVE_LIMIT_BYTES || !navigator.storage || typeof navigator.storage.estimate !== "function") return;
    const estimate = await navigator.storage.estimate().catch(function() { return null; });
    if (!estimate || !Number.isFinite(estimate.quota) || !Number.isFinite(estimate.usage)) return;
    const reserve = Math.min(64 * 1024 * 1024, Math.max(8 * 1024 * 1024, Math.ceil(size * .02)));
    if (estimate.quota - estimate.usage < size + reserve) {
      throw new Error("存储空间不足，已拒绝接收文件");
    }
  }

  function createMemoryReceiveStore(transfer) {
    const chunks = new Map();
    return {
      kind: "memory",
      async write(seq, arrayBuffer) { chunks.set(seq, new Blob([arrayBuffer])); },
      async forEachChunk(callback) {
        if (chunks.size !== transfer.totalChunks) throw new Error("内存分片数量与文件元数据不一致");
        for (let seq = 0; seq < transfer.totalChunks; seq++) {
          const part = chunks.get(seq);
          if (!part) throw new Error("内存分片缺失");
          await callback(await part.arrayBuffer());
        }
      },
      async getDownloadBlob() {
        const parts = [];
        for (let seq = 0; seq < transfer.totalChunks; seq++) parts.push(chunks.get(seq));
        return new Blob(parts);
      },
      async clear() { chunks.clear(); }
    };
  }

  async function createIndexedDbReceiveStore(transfer) {
    const db = await dbPromise;
    if (!db) throw new Error("浏览器缺少可用的大文件存储能力");
    await clearStoredChunks(Promise.resolve(db), transfer.id);
    return {
      kind: "indexeddb",
      async write(seq, arrayBuffer) {
        await storeChunk(Promise.resolve(db), transfer.id, seq, new Blob([arrayBuffer]));
      },
      async forEachChunk(callback) {
        const parts = await loadStoredChunks(Promise.resolve(db), transfer.id);
        if (parts.length !== transfer.totalChunks) throw new Error("IndexedDB 分片数量与文件元数据不一致");
        for (const part of parts) await callback(await part.arrayBuffer());
      },
      async getDownloadBlob() {
        const parts = await loadStoredChunks(Promise.resolve(db), transfer.id);
        if (parts.length !== transfer.totalChunks) throw new Error("IndexedDB 分片缺失");
        return new Blob(parts);
      },
      async clear() { await clearStoredChunks(Promise.resolve(db), transfer.id); }
    };
  }

  async function createOpfsReceiveStore(transfer) {
    if (!navigator.storage || typeof navigator.storage.getDirectory !== "function") {
      throw new Error("OPFS is unavailable");
    }
    const root = await navigator.storage.getDirectory();
    const entryName = ".web-omni-" + transfer.id.replace(/[^a-z0-9_-]/gi, "_") + ".part";
    await root.removeEntry(entryName).catch(function() {});
    const handle = await root.getFileHandle(entryName, { create: true });
    let writable;
    try {
      writable = await handle.createWritable({ keepExistingData: false });
    } catch (error) {
      await root.removeEntry(entryName).catch(function() {});
      throw error;
    }
    let writeQueue = Promise.resolve();
    let closed = false;

    async function finishWrites() {
      await writeQueue;
      if (!closed) {
        closed = true;
        await writable.close();
      }
      return handle.getFile();
    }

    return {
      kind: "opfs",
      async write(seq, arrayBuffer) {
        if (closed) throw new Error("OPFS writer is closed");
        writeQueue = writeQueue.then(function() {
          return writable.write({ type: "write", position: seq * transfer.chunkSize, data: arrayBuffer });
        });
        await writeQueue;
      },
      async forEachChunk(callback) {
        const file = await finishWrites();
        if (file.size !== transfer.size) throw new Error("OPFS 文件大小与元数据不一致");
        for (let offset = 0; offset < file.size || (file.size === 0 && offset === 0); offset += transfer.chunkSize) {
          await callback(await file.slice(offset, Math.min(offset + transfer.chunkSize, file.size)).arrayBuffer());
          if (file.size === 0) break;
        }
      },
      async getDownloadBlob() { return finishWrites(); },
      async clear() {
        await writeQueue.catch(function() {});
        if (!closed) {
          closed = true;
          await writable.abort().catch(function() {});
        }
        await root.removeEntry(entryName).catch(function() {});
      }
    };
  }

  async function disposeReceiveStore(store) {
    if (!store) return;
    clearTimeout(store.cleanupTimer);
    activeReceiveStores.delete(store);
    await store.clear();
  }

  function retainCompletedReceiveStore(store) {
    clearTimeout(store.cleanupTimer);
    store.cleanupTimer = setTimeout(function() {
      disposeReceiveStore(store).catch(function() {});
    }, COMPLETED_STORE_RETENTION_MS);
  }

  function readableStorageError(error) {
    if (error && (error.name === "QuotaExceededError" || /quota|space|存储空间/i.test(String(error.message || "")))) {
      return "存储空间不足，文件接收已停止";
    }
    return String(error && error.message || "无法准备文件存储");
  }

  function isReceiveStorageFailure(error) {
    const text = String(error && (error.name + " " + error.message) || "");
    return /QuotaExceeded|InvalidState|AbortError|OPFS|IndexedDB|storage|writer|存储/i.test(text);
  }

  function buildChunkKey(transferId, seq) {
    return transferId + ":" + String(seq).padStart(12, "0");
  }

  function getTransferChunkKeys(transferId) {
    const prefix = transferId + ":";
    return Array.from(memoryChunkStore.keys())
      .filter(function(key) { return key.indexOf(prefix) === 0; })
      .sort();
  }

  function openTransferDb(dbName) {
    return new Promise(function(resolve) {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }

      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = function() {
        const db = request.result;
        if (!db.objectStoreNames.contains(RECEIVE_STORE_NAME)) {
          const store = db.createObjectStore(RECEIVE_STORE_NAME, { keyPath: "key" });
          store.createIndex("byTransfer", "transferId", { unique: false });
        }
      };
      request.onsuccess = function() { resolve(request.result); };
      request.onerror = function() {
        console.warn("[WO Mobile] IndexedDB unavailable, falling back to memory:", request.error);
        resolve(null);
      };
    });
  }

  async function storeChunk(dbPromise, transferId, seq, blob) {
    const key = buildChunkKey(transferId, seq);
    const db = await dbPromise;
    if (!db) {
      memoryChunkStore.set(key, blob);
      return;
    }

    return new Promise(function(resolve, reject) {
      let queue = chunkWriteQueues.get(db);
      if (!queue) {
        queue = { db: db, items: [], timer: null, flushing: false };
        chunkWriteQueues.set(db, queue);
        activeChunkWriteQueues.add(queue);
      }
      queue.items.push({ key: key, transferId: transferId, seq: seq, blob: blob, resolve: resolve, reject: reject });
      if (queue.items.length >= CHUNK_WRITE_BATCH_SIZE) {
        flushChunkWriteQueue(db, queue);
      } else if (!queue.timer) {
        queue.timer = setTimeout(function() { flushChunkWriteQueue(db, queue); }, CHUNK_WRITE_BATCH_DELAY);
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
    items.forEach(function(item) {
      store.put({ key: item.key, transferId: item.transferId, seq: item.seq, blob: item.blob });
    });
    tx.oncomplete = function() { items.forEach(function(item) { item.resolve(); }); };
    tx.onerror = function() { items.forEach(function(item) { item.reject(tx.error); }); };
    tx.onabort = function() { items.forEach(function(item) { item.reject(tx.error); }); };
    tx.addEventListener("complete", function() {
      queue.flushing = false;
      if (queue.items.length) flushChunkWriteQueue(db, queue);
    }, { once: true });
    tx.addEventListener("error", function() { queue.flushing = false; }, { once: true });
    tx.addEventListener("abort", function() { queue.flushing = false; }, { once: true });
  }

  async function loadStoredChunks(dbPromise, transferId) {
    const db = await dbPromise;
    if (!db) {
      return getTransferChunkKeys(transferId).map(function(key) { return memoryChunkStore.get(key); });
    }

    return new Promise(function(resolve, reject) {
      const chunks = [];
      const tx = db.transaction(RECEIVE_STORE_NAME, "readonly");
      const store = tx.objectStore(RECEIVE_STORE_NAME);
      const range = IDBKeyRange.bound(buildChunkKey(transferId, 0), buildChunkKey(transferId, 999999999999));
      const request = store.openCursor(range);
      request.onsuccess = function() {
        const cursor = request.result;
        if (!cursor) {
          resolve(chunks);
          return;
        }
        chunks.push(cursor.value.blob);
        cursor.continue();
      };
      request.onerror = function() { reject(request.error); };
    });
  }

  async function clearStoredChunks(dbPromise, transferId) {
    const db = await dbPromise;
    if (!db) {
      getTransferChunkKeys(transferId).forEach(function(key) { memoryChunkStore.delete(key); });
      return;
    }

    return new Promise(function(resolve, reject) {
      const tx = db.transaction(RECEIVE_STORE_NAME, "readwrite");
      const store = tx.objectStore(RECEIVE_STORE_NAME);
      const range = IDBKeyRange.bound(buildChunkKey(transferId, 0), buildChunkKey(transferId, 999999999999));
      const request = store.openCursor(range);
      request.onsuccess = function() {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { reject(tx.error); };
      tx.onabort = function() { reject(tx.error); };
    });
  }

  async function finalizeIncomingTransfer(transfer, updateStatus) {
    if (transfer.finalizePromise) return transfer.finalizePromise;
    transfer.finalizing = true;
    transfer.finalizePromise = (async function() {
      try {
        if (!transfer.receiveStore) throw new Error("接收存储不可用");
        if (transfer.expectedFileHash) {
          updateStatus(transfer.id, "校验中", "");
          const hasher = createFileHasher(getHashAlgorithm(transfer.expectedFileHash), transfer.legacy);
          await transfer.receiveStore.forEachChunk(function(arrayBuffer) { hasher.update(arrayBuffer); });
          const actualFileHash = hasher.digest();
          if (actualFileHash !== transfer.expectedFileHash) {
            transfer.integrityFailed = true;
            transfer.finalizing = false;
            transfer.finalizePromise = null;
            await disposeReceiveStore(transfer.receiveStore);
            transfer.receiveStore = await createReceiveStore(transfer);
            updateStatus(transfer.id, "完整文件校验失败，正在重新接收...", "error");
            return false;
          }
        } else if (!transfer.legacy) {
          throw new Error("The complete SHA-256 digest is missing");
        }
        updateStatus(transfer.id, "正在准备保存...", "");
        const blob = await transfer.receiveStore.getDownloadBlob();
        updateStatus(transfer.id, "完成（" + ((Date.now() - transfer.startTime) / 1000).toFixed(1) + " 秒）", "done");
        addFileSaveButton(transfer.id, blob, transfer.name);
        try {
          offerFileDownload(transfer.id, blob, transfer.name, true);
        } catch (error) {
          console.warn("[WO Mobile] Automatic save requires user action:", error);
        }
        if (transfer.receiveStore.kind === "opfs") retainCompletedReceiveStore(transfer.receiveStore);
        else await disposeReceiveStore(transfer.receiveStore);
        transfer.receiveStore = null;
        return true;
      } catch (error) {
        console.error("[WO Mobile] Finalize failed:", error);
        transfer.storageFailed = true;
        transfer.storageError = readableStorageError(error);
        await disposeReceiveStore(transfer.receiveStore).catch(function() {});
        transfer.receiveStore = null;
        updateStatus(transfer.id, "保存失败：" + transfer.storageError, "error");
        transfer.finalizing = false;
        transfer.finalizePromise = null;
        return false;
      }
    })();
    return transfer.finalizePromise;
  }

  function offerFileDownload(id, blob, name, automatic) {
    const url = URL.createObjectURL(blob);
    activeObjectUrls.add(url);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function() { releaseObjectUrl(url); }, automatic ? 5000 : 15000);
  }

  function addFileSaveButton(id, blob, name) {
    const item = document.querySelector('.file-message[data-id="' + cssEscape(id) + '"]');
    const status = item && item.querySelector(".file-status");
    if (!status) return;
    const previous = status.querySelector(".file-save");
    if (previous) previous.remove();
    const button = document.createElement("button");
    button.type = "button";
    button.className = "file-save";
    button.textContent = "保存文件";
    button.addEventListener("click", function() {
      try {
        offerFileDownload(id, blob, name, false);
        button.textContent = "已请求保存";
      } catch (error) {
        button.textContent = "保存失败，请重试";
      }
      setTimeout(function() { button.textContent = "再次保存"; }, 1600);
    });
    status.appendChild(button);
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
    if (normalized === "fnv1a32" && ALLOW_LEGACY_PROTOCOL && legacy === true) return normalized;
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
      if (ALLOW_LEGACY_PROTOCOL && legacy) return null;
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
        digest() { return "sha256:" + state.digestHex(); }
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
      }
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

  function getReconnectDelay(attempt) {
    return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1)));
  }

  function isCurrentPeer(candidate, generation) {
    return !isPageClosing && peer === candidate && peerGeneration === generation;
  }

  function isCurrentConnection(candidate, generation) {
    return !isPageClosing && conn === candidate && connectionGeneration === generation;
  }

  function isUsableConnection(candidate) {
    return !isPageClosing
      && conn === candidate
      && Boolean(candidate && candidate.open)
      && Boolean(secureTransport && secureTransport.authenticated);
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function clearConnectionTimeout() {
    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
      connectionTimeout = null;
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
    transfer.cleanupTimer = setTimeout(function() {
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
    clearConnectionTimeout();
    clearReconnectTimer();
    peerGeneration++;
    connectionGeneration++;
    const previousConnection = conn;
    const previousPeer = peer;
    conn = null;
    peer = null;
    secureTransport = null;
    activeChunkSize = CHUNK_SIZE;
    pauseIncomingTransferTimers();
    if (previousConnection) {
      try { previousConnection.close(); } catch (error) {}
    }
    if (previousPeer) {
      try { previousPeer.destroy(); } catch (error) {}
    }
  }

  function cleanupRuntime() {
    if (isPageClosing) return;
    isPageClosing = true;
    clearConnectionTimeout();
    clearReconnectTimer();
    markPendingTextMessagesFailed("页面已关闭");
    sendQueue.length = 0;
    outgoingTransfers.forEach(function(transfer) {
      clearTimeout(transfer.completionTimer);
      clearTimeout(transfer.cleanupTimer);
    });
    incomingTransfers.forEach(clearIncomingTransferTimers);
    activeChunkWriteQueues.forEach(function(queue) {
      clearTimeout(queue.timer);
      queue.timer = null;
    });
    activeReceiveStores.forEach(function(store) {
      clearTimeout(store.cleanupTimer);
      Promise.resolve(store.clear()).catch(function() {});
    });
    activeReceiveStores.clear();
    Array.from(activeObjectUrls).forEach(releaseObjectUrl);
    completedIncomingTransfers.clear();
    memoryChunkStore.clear();
    destroyPeer();
    dbPromise.then(function(db) {
      if (db) db.close();
    }).catch(function() {});
  }

  function readablePeerError(error) {
    if (!error) return "unknown error";
    return error.type || error.message || String(error);
  }

  function randomId() {
    return Math.random().toString(36).slice(2, 10);
  }

  function sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(String(value));
    }
    return String(value).replace(/"/g, '\\"');
  }

  function sanitizeFileName(name) {
    const sanitized = String(name || "")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/[\u0000-\u001f\u007f]+/g, "")
      .trim();
    return sanitized || "download.bin";
  }

  function sendSecure(connection, message) {
    if (!isUsableConnection(connection) || !secureTransport) {
      return Promise.reject(new Error("secure connection is unavailable"));
    }
    return secureTransport.send(message);
  }

  function safeSend(connection, message) {
    sendSecure(connection, message).catch(function(error) {
      console.warn("[WO Mobile] Send skipped:", error);
    });
  }
})();
