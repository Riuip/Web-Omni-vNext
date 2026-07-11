(function() {
  "use strict";

  const CHUNK_SIZE = 64 * 1024;
  const DEVICE_MEMORY_GB = typeof navigator !== "undefined" && typeof navigator.deviceMemory === "number"
    ? navigator.deviceMemory
    : 4;
  const RESEND_BATCH_SIZE = DEVICE_MEMORY_GB <= 2 ? 32 : 64;
  const BUFFER_HIGH_WATER_MARK = (DEVICE_MEMORY_GB <= 2 ? 12 : DEVICE_MEMORY_GB <= 4 ? 20 : 28) * CHUNK_SIZE;
  const PROGRESS_UPDATE_INTERVAL_MS = 120;
  const DEFAULT_HASH_ALGORITHM = "fnv1a32";
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
  const URL_PATTERN = /\b((?:https?:\/\/|www\.)[^\s<]+[^\s<.,:;"')\]\}])/gi;
  const RECEIVE_DB_NAME = "wo-lan-transfer-vnext-mobile";
  const RECEIVE_STORE_NAME = "chunks";
  const SIGNAL_SERVER = (__WO_RUNTIME_CONFIG__.signalServers && __WO_RUNTIME_CONFIG__.signalServers[0]) || { host: "0.peerjs.com", port: 443, secure: true, path: "/" };
  const ICE_SERVERS = (__WO_RUNTIME_CONFIG__.iceServers) || [];
  const PREFILLED_ROOM_CODE = __WO_ROOM_CODE__;
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
  const CHUNK_WRITE_BATCH_SIZE = 8;
  const CHUNK_WRITE_BATCH_DELAY = 35;
  const ACK_BATCH_SIZE = 8;
  const ACK_MAX_DELAY = 100;

  init();

  function init() {
    $("roomCodeInput").value = PREFILLED_ROOM_CODE;
    initThemeMode();
    Array.prototype.forEach.call(document.querySelectorAll(".theme-btn[data-theme-mode]"), function(button) {
      button.addEventListener("click", function() {
        setThemeMode(String(button.dataset.themeMode || "auto"));
      });
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
    const connected = Boolean(conn && conn.open);
    const hasText = Boolean(text.trim());
    $("chatCounter").textContent = bytes + " / " + TEXT_LIMIT_BYTES + " 字节";
    $("chatCounter").classList.toggle("over-limit", bytes > TEXT_LIMIT_BYTES);
    $("sendChatBtn").disabled = !connected || !hasText || bytes > TEXT_LIMIT_BYTES;

    if (!connected) {
      $("chatHint").textContent = "请先连接电脑后再发送，也支持直接粘贴图片或截图。";
    } else if (bytes > TEXT_LIMIT_BYTES) {
      $("chatHint").textContent = "单条文本不能超过 32 KB，请删减后再发送。";
    } else {
      $("chatHint").textContent = "消息会直接发到当前连接的电脑，链接可点击打开，聊天记录不会本地持久化。";
    }
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
    const generation = peerGeneration;
    const currentPeer = new Peer(undefined, {
      host: SIGNAL_SERVER.host,
      port: SIGNAL_SERVER.port,
      secure: SIGNAL_SERVER.secure,
      path: SIGNAL_SERVER.path,
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

    connection.on("open", function() {
      if (!isCurrentConnection(connection, generation)) return;
      clearConnectionTimeout();
      clearReconnectTimer();
      $("connectBtn").disabled = false;
      $("connectBtn").textContent = "已连接";
      setStatus("已连接到电脑", "connected");
      updateChatComposerState();
      resumePendingTransfers(connection);
      runSendQueue();
    });

    connection.on("data", function(message) {
      if (!isCurrentConnection(connection, generation)) return;
      Promise.resolve(handleProtocolMessage(connection, message)).catch(function(error) {
        console.error("[WO Mobile] Message handling failed:", error);
      });
    });

    connection.on("close", function() {
      if (!isCurrentConnection(connection, generation)) return;
      conn = null;
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
      conn.send({
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

  async function beginIncomingTransfer(connection, meta) {
    const transferId = String(meta.id || "");
    if (!transferId) return;

    const completed = completedIncomingTransfers.get(transferId);
    if (completed) {
      safeSend(connection, { type: "file-complete", id: transferId, receivedBytes: completed.receivedBytes });
      return;
    }

    const size = Number(meta.size);
    const totalChunks = Number(meta.totalChunks);
    const expectedChunks = Math.ceil(size / CHUNK_SIZE) || 1;
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(totalChunks) || totalChunks !== expectedChunks) return;

    const existing = incomingTransfers.get(transferId);
    if (existing) {
      if (existing.size === size && existing.totalChunks === totalChunks) {
        existing.missingRetryAttempts = 0;
        scheduleFileAck(connection, existing, true);
      }
      return;
    }

    const transfer = {
      id: transferId,
      name: sanitizeFileName(meta.name || "download.bin"),
      size: size,
      totalChunks: totalChunks,
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
      finalizePromise: null
    };

    incomingTransfers.set(transferId, transfer);
    addFileItem(transferId, transfer.name, transfer.size, "recv", "接收中...");
  }

  async function receiveChunk(connection, payload) {
    const transferId = String(payload.id || "");
    const completed = completedIncomingTransfers.get(transferId);
    if (completed) {
      safeSend(connection, { type: "file-complete", id: transferId, receivedBytes: completed.receivedBytes });
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
      const arrayBuffer = normalizeArrayBuffer(payload.chunk);
      const expectedSize = seq === transfer.totalChunks - 1 ? Math.max(0, transfer.size - (seq * CHUNK_SIZE)) : CHUNK_SIZE;
      const hash = await createChunkHash(arrayBuffer, getHashAlgorithm(payload.hash));
      if (arrayBuffer.byteLength !== expectedSize || (payload.hash && payload.hash !== hash)) {
        updateFileStatus(transfer.id, "数据校验失败，正在请求重传...", "error");
        safeSend(connection, { type: "file-resend-request", id: transfer.id, seqs: [seq] });
        return;
      }

      await storeChunk(dbPromise, transfer.id, seq, new Blob([arrayBuffer]));
      if (incomingTransfers.get(transfer.id) !== transfer || transfer.receivedChunks.has(seq)) return;
      transfer.receivedChunks.add(seq);
      transfer.receivedBytes += arrayBuffer.byteLength;
      transfer.missingRetryAttempts = 0;

      const pct = transfer.size > 0 ? Math.min(100, Math.round((transfer.receivedBytes / transfer.size) * 100)) : 100;
      const elapsedSeconds = Math.max(1, (Date.now() - transfer.startTime) / 1000);
      maybeUpdateTransferProgress(transfer, pct, formatSize(Math.round(transfer.receivedBytes / elapsedSeconds)) + "/s", transfer.receivedChunks.size === transfer.totalChunks);

      scheduleFileAck(connection, transfer, transfer.receivedChunks.size === transfer.totalChunks);

      if (transfer.doneReceived && transfer.receivedChunks.size === transfer.totalChunks) {
        await finalizeAndConfirmIncoming(connection, transfer);
      } else if (transfer.doneReceived) {
        scheduleMissingChunkRetry(connection, transfer);
      }
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
      safeSend(connection, { type: "file-complete", id: transferId, receivedBytes: completed.receivedBytes });
      return;
    }
    const transfer = incomingTransfers.get(transferId);
    if (!transfer) return;

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
    const saved = await finalizeIncomingTransfer(dbPromise, transfer, updateFileStatus);
    if (!saved) return;
    clearIncomingTransferTimers(transfer);
    incomingTransfers.delete(transfer.id);
    completedIncomingTransfers.set(transfer.id, { receivedBytes: transfer.receivedBytes });
    setTimeout(function() { completedIncomingTransfers.delete(transfer.id); }, COMPLETED_TRANSFER_CACHE_MS);
    safeSend(connection, { type: "file-complete", id: transfer.id, receivedBytes: transfer.receivedBytes });
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

    if (!conn || !conn.open) {
      alert("请先连接电脑。");
      return;
    }

    files.forEach(function(file) {
      const transfer = {
        id: "send-" + randomId(),
        file: file,
        totalChunks: Math.ceil(file.size / CHUNK_SIZE) || 1,
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
        cleanupTimer: null
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
        if (!isPageClosing && transfer.sendAttempts < MAX_SEND_ATTEMPTS) {
          transfer.state = "queued";
          sendQueue.unshift(transfer);
          updateFileStatus(transfer.id, conn && conn.open ? "发送受阻，正在重试..." : "连接中断，等待恢复...", "");
          if (conn && conn.open) await sleep(getReconnectDelay(transfer.sendAttempts));
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

  async function sendTransfer(connection, transfer) {
    if (!isUsableConnection(connection)) throw new Error("connection unavailable");

    updateFileStatus(transfer.id, "发送中...", "");
    transfer.startTime = Date.now();
    transfer.sentBytes = 0;

    connection.send({
      type: "file-meta",
      id: transfer.id,
      name: transfer.file.name,
      size: transfer.file.size,
      totalChunks: transfer.totalChunks,
      lastModified: transfer.file.lastModified || Date.now()
    });

    for (let seq = 0; seq < transfer.totalChunks; seq++) {
      const start = seq * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, transfer.file.size);
      const arrayBuffer = await transfer.file.slice(start, end).arrayBuffer();
      const hash = await createChunkHash(arrayBuffer);

      await waitForDataChannel(connection);
      connection.send({
        type: "file-chunk",
        id: transfer.id,
        seq: seq,
        totalChunks: transfer.totalChunks,
        hash: hash,
        chunk: arrayBuffer
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

    connection.send({ type: "file-done", id: transfer.id, totalChunks: transfer.totalChunks });
    updateFileStatus(transfer.id, "等待接收端确认...", "");
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
      safeSend(connection, { type: "file-done", id: transfer.id, totalChunks: transfer.totalChunks });
      transfer.completionTimer = setTimeout(probe, FILE_COMPLETE_RETRY_MS);
    }
    transfer.completionTimer = setTimeout(probe, FILE_COMPLETE_RETRY_MS);
  }

  function resumePendingTransfers(connection) {
    outgoingTransfers.forEach(function(transfer) {
      if (transfer.completed || transfer.state !== "awaiting-complete") return;
      safeSend(connection, { type: "file-meta", id: transfer.id, name: transfer.file.name, size: transfer.file.size, totalChunks: transfer.totalChunks, lastModified: transfer.file.lastModified || Date.now() });
      safeSend(connection, { type: "file-done", id: transfer.id, totalChunks: transfer.totalChunks });
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
      const start = seq * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, transfer.file.size);
      const arrayBuffer = await transfer.file.slice(start, end).arrayBuffer();
      const hash = await createChunkHash(arrayBuffer);
      await waitForDataChannel(connection);
      connection.send({
        type: "file-chunk",
        id: transfer.id,
        seq: seq,
        totalChunks: transfer.totalChunks,
        hash: hash,
        chunk: arrayBuffer
      });
    }
  }

  async function waitForDataChannel(connection) {
    if (!isUsableConnection(connection)) throw new Error("connection closed");

    const dataChannel = connection.dataChannel || connection._dc;
    if (!dataChannel) return;

    const deadline = Date.now() + DATA_CHANNEL_STALL_TIMEOUT_MS;
    while (dataChannel.bufferedAmount > BUFFER_HIGH_WATER_MARK) {
      if (!isUsableConnection(connection)) throw new Error("connection replaced or closed");
      if (Date.now() >= deadline) throw new Error("data channel backpressure timeout");
      await sleep(30);
    }
  }

  function addFileItem(id, name, size, direction, statusText) {
    const list = $("conversationStream");
    const empty = $("conversationEmpty");
    if (empty) empty.remove();

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
    item.querySelector(".file-speed").textContent = speedText ? " 路 " + speedText : "";
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
    $("statusText").textContent = text;
    $("statusBar").className = "status" + (state ? " " + state : "");
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

  async function finalizeIncomingTransfer(dbPromise, transfer, updateStatus) {
    if (transfer.finalizePromise) return transfer.finalizePromise;
    transfer.finalizing = true;
    transfer.finalizePromise = (async function() {
      try {
        const blobParts = await loadStoredChunks(dbPromise, transfer.id);
        const blob = new Blob(blobParts);
        const url = URL.createObjectURL(blob);
        activeObjectUrls.add(url);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = transfer.name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(function() { releaseObjectUrl(url); }, 5000);
        updateStatus(transfer.id, "已保存（" + ((Date.now() - transfer.startTime) / 1000).toFixed(1) + " 秒）", "done");
        await clearStoredChunks(dbPromise, transfer.id);
        return true;
      } catch (error) {
        console.error("[WO Mobile] Finalize failed:", error);
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

  async function createChunkHash(arrayBuffer, preferredAlgorithm) {
    const algorithm = pickHashAlgorithm(preferredAlgorithm);
    if (algorithm === "sha256" && hasSubtleCrypto()) {
      return "sha256:" + await sha256DigestHex(arrayBuffer);
    }
    return "fnv1a32:" + fnv1a32Hex(arrayBuffer);
  }

  function pickHashAlgorithm(preferredAlgorithm) {
    if (preferredAlgorithm === "sha256" && hasSubtleCrypto()) return "sha256";
    if (preferredAlgorithm === "fnv1a32") return "fnv1a32";
    return DEFAULT_HASH_ALGORITHM;
  }

  function getHashAlgorithm(hashValue) {
    if (typeof hashValue !== "string") return null;
    const separatorIndex = hashValue.indexOf(":");
    return separatorIndex > 0 ? hashValue.slice(0, separatorIndex) : null;
  }

  function hasSubtleCrypto() {
    return !!(globalThis.crypto && globalThis.crypto.subtle && typeof globalThis.crypto.subtle.digest === "function");
  }

  async function sha256DigestHex(arrayBuffer) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", arrayBuffer);
    return Array.from(new Uint8Array(digest)).map(function(byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
  }

  function fnv1a32Hex(arrayBuffer) {
    const view = new Uint8Array(arrayBuffer);
    let hash = 0x811c9dc5;
    for (let index = 0; index < view.length; index++) {
      hash ^= view[index];
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
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
    return !isPageClosing && conn === candidate && Boolean(candidate && candidate.open);
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

  function safeSend(connection, message) {
    if (!connection || !connection.open) return;
    try {
      connection.send(message);
    } catch (error) {
      console.warn("[WO Mobile] Send skipped:", error);
    }
  }
})();
