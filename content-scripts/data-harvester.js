// 神经末梢：数据收割机 (Data Harvester)
// 智能框选提取、媒体嗅探与扒取、Markdown 一键剪藏、高级爬虫

(function() {
  if (window.webOmniDataHarvesterInjected) return;
  window.webOmniDataHarvesterInjected = true;

  const actionHandlers = {
    ACTIVATE_DATA_HARVESTER: (request) => handleSmartSelection(request.payload || request),
    EXTRACT_MEDIA: (request) => handleMediaSniffer(request.payload || request),
    WO_MEDIA_SNIFFER_OPEN: (request) => handleMediaSniffer(request.payload || request),
    EXTRACT_MARKDOWN: () => extractMarkdown(),
    EXTRACT_LINKS: () => extractLinks(),
    EXTRACT_STRUCTURED_DATA: () => extractStructuredData(),
    EXTRACT_CSS_SELECTOR: () => promptCssExtraction(),
    EXTRACT_EMAIL_PHONE: () => extractEmailPhone(),
    EXTRACT_PAGE_SNAPSHOT: () => extractPageSnapshot(),
    EXTRACT_PAGE_SOURCE: () => extractPageSource(),
    EXTRACT_COOKIES: () => extractCookies(),
    EXTRACT_HIDDEN_FIELDS: () => extractHiddenFields(),
    EXTRACT_AJAX_URLS: () => extractAjaxUrls(),
    DUMP_STORAGE: () => dumpStorage(),
    REVEAL_PASSWORDS: (request) => revealPasswords(request.payload || request),
    DUMP_JS_GLOBALS: (request) => dumpJsGlobals(request.payload),
    HIJACK_EVENTS: (request) => hijackEvents(request.payload),
    INTERCEPT_REQUESTS: (request) => interceptRequests(request.payload),
    BROWSER_FINGERPRINT: (request) => browserFingerprint(request.payload),
    WEBSOCKET_MONITOR: (request) => websocketMonitor(request.payload),
    JS_INJECTOR: () => jsInjector(),
    CANVAS_SPOOF: (request) => canvasSpoof(request.payload),
  };

  function publishState(action, state) {
    const next = { scope: "page", updatedAt: Date.now(), ...state };
    if (window.webOmniActionState && typeof window.webOmniActionState.set === "function") {
      window.webOmniActionState.set(action, next);
    } else {
      chrome.runtime.sendMessage({ type: "WO_ACTION_STATE_CHANGED", action, state: next }).catch(() => {});
    }
    return next;
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.type === "WO_ACTION_STATE_SYNC") return false;
    const handler = request && actionHandlers[request.action];
    if (!handler) return false;

    Promise.resolve()
      .then(() => handler(request))
      .then((result) => sendResponse(result && typeof result.ok === "boolean" ? result : {
        ok: true,
        action: request.action,
        status: "completed",
        data: {},
      }))
      .catch((error) => sendResponse({
        ok: false,
        action: request.action,
        status: "failed",
        error: { code: "ACTION_FAILED", message: error && error.message ? error.message : String(error) },
      }));
    return true;
  });

  function runMainWorldAction(action, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "WO_RUN_MAIN_WORLD", action, payload: payload || {} }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          resolve({
            ok: false,
            action,
            status: "failed",
            error: { code: "MODULE_LOAD_FAILED", message: runtimeError.message },
          });
          return;
        }
        const result = response && response.result ? response.result : response;
        resolve(result && typeof result.ok === "boolean" ? result : {
          ok: false,
          action,
          status: "failed",
          error: { code: "MODULE_LOAD_FAILED", message: "MAIN world bridge returned no result." },
        });
      });
    });
  }

  function showMainWorldError(title, result) {
    const error = result && result.error ? result.error : {};
    const code = error.code || "ACTION_FAILED";
    const message = error.message || "Action failed.";
    showResultPanel(title, `<div style="color:#ef9a9a;font-size:13px;"><b>${escHtml(code)}</b><br>${escHtml(message)}</div>`);
  }

  // =============== 通用侧栏结果面板 ===============
  function showResultPanel(title, bodyHTML) {
    let existing = document.getElementById('wo-result-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'wo-result-panel';
    panel.style.cssText = `
      position:fixed;top:0;right:0;width:420px;height:100vh;z-index:2147483646;
      background:#1a1a1a;border-left:1px solid #333;
      overflow-y:auto;font-family:system-ui,-apple-system,sans-serif;
      color:#ccc;transform:translateX(100%);transition:transform 0.25s ease;
    `;

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid #2a2a2a;position:sticky;top:0;background:#1a1a1a;z-index:2;">
        <b style="font-size:14px;color:#eee;">${title}</b>
        <div style="display:flex;gap:8px;">
          <button id="wo-rp-copy" style="background:#252525;border:1px solid #3a3a3a;color:#aaa;padding:4px 10px;border-radius:5px;cursor:pointer;font-size:12px;">复制全部</button>
          <button id="wo-rp-close" style="background:#252525;border:1px solid #3a3a3a;color:#aaa;padding:4px 8px;border-radius:5px;cursor:pointer;font-size:12px;">✕</button>
        </div>
      </div>
      <div id="wo-rp-body" style="padding:12px 16px;font-size:13px;line-height:1.7;">${bodyHTML}</div>
    `;

    document.body.appendChild(panel);
    requestAnimationFrame(() => requestAnimationFrame(() => panel.style.transform = 'translateX(0)'));

    panel.querySelector('#wo-rp-close').onclick = () => {
      panel.style.transform = 'translateX(100%)';
      setTimeout(() => panel.remove(), 250);
    };
    panel.querySelector('#wo-rp-copy').onclick = () => {
      const text = panel.querySelector('#wo-rp-body').innerText;
      navigator.clipboard.writeText(text).then(() => {
        if (window.webOmniShowToast) window.webOmniShowToast("已复制到剪贴板", "success");
      });
    };
  }

  // ========== 智能框选提取 ==========
  let isSelecting = false;
  let selectionBox = null;
  let selectionOverlay = null;
  let selectionEscHandler = null;
  let startX = 0, startY = 0;

  function selectionResult(status) {
    return {
      ok: true,
      action: "ACTIVATE_DATA_HARVESTER",
      status,
      data: publishState("ACTIVATE_DATA_HARVESTER", {
        active: isSelecting,
        phase: isSelecting ? "selecting" : "inactive",
        count: isSelecting ? 1 : 0,
        reversibleCount: 0,
      }),
    };
  }

  function handleSmartSelection(payload) {
    const mode = payload && payload.mode;
    if (mode === "status") return selectionResult(isSelecting ? "active" : "inactive");
    if (mode === "disable") {
      stopSmartSelection();
      return selectionResult("inactive");
    }
    if (mode === "enable") activateSmartSelection();
    else if (isSelecting) stopSmartSelection();
    else activateSmartSelection();
    return selectionResult(isSelecting ? "active" : "inactive");
  }

  function activateSmartSelection() {
    if (isSelecting) return;
    isSelecting = true;

    if (window.webOmniShowToast) window.webOmniShowToast("框选模式已激活，拖动鼠标框选区域", "info");

    const overlay = document.createElement("div");
    selectionOverlay = overlay;
    overlay.id = "web-omni-selection-overlay";
    overlay.style.cssText = `position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483645;cursor:crosshair;background:transparent;`;
    document.body.appendChild(overlay);

    selectionBox = document.createElement("div");
    selectionBox.style.cssText = `position:fixed;border:2px dashed #888;background:rgba(128,128,128,0.08);z-index:2147483646;pointer-events:none;display:none;`;
    document.body.appendChild(selectionBox);

    overlay.addEventListener("mousedown", (e) => {
      startX = e.clientX; startY = e.clientY;
      selectionBox.style.display = "block";
      selectionBox.style.left = startX + "px"; selectionBox.style.top = startY + "px";
      selectionBox.style.width = "0"; selectionBox.style.height = "0";
    });

    overlay.addEventListener("mousemove", (e) => {
      if (selectionBox.style.display === "none") return;
      selectionBox.style.left = Math.min(e.clientX, startX) + "px";
      selectionBox.style.top = Math.min(e.clientY, startY) + "px";
      selectionBox.style.width = Math.abs(e.clientX - startX) + "px";
      selectionBox.style.height = Math.abs(e.clientY - startY) + "px";
    });

    overlay.addEventListener("mouseup", (e) => {
      const rect = {
        left: Math.min(e.clientX, startX), top: Math.min(e.clientY, startY),
        right: Math.max(e.clientX, startX), bottom: Math.max(e.clientY, startY)
      };

      let texts = [];
      document.querySelectorAll("p, span, td, th, li, h1, h2, h3, h4, h5, h6, a, div").forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.left >= rect.left && r.right <= rect.right && r.top >= rect.top && r.bottom <= rect.bottom) {
          const text = el.innerText.trim();
          if (text && !texts.includes(text)) texts.push(text);
        }
      });

      let csvData = "";
      document.querySelectorAll("table").forEach(table => {
        const tr = table.getBoundingClientRect();
        if (tr.left < rect.right && tr.right > rect.left && tr.top < rect.bottom && tr.bottom > rect.top) {
          table.querySelectorAll("tr").forEach(row => {
            const cells = Array.from(row.querySelectorAll("td, th")).map(c => `"${c.innerText.trim().replace(/"/g, '""')}"`).join(",");
            csvData += cells + "\n";
          });
        }
      });

      stopSmartSelection();

      if (csvData) {
        showResultPanel(`框选表格 (CSV)`, `<pre style="white-space:pre-wrap;color:#aaa;font-size:12px;">${escHtml(csvData)}</pre>`);
      } else if (texts.length > 0) {
        showResultPanel(`框选文本 (${texts.length}条)`, texts.map(t => `<div style="padding:4px 0;border-bottom:1px solid #252525;">${escHtml(t)}</div>`).join(''));
      } else {
        if (window.webOmniShowToast) window.webOmniShowToast("框选区域内未找到文本", "warn");
      }
    });

    selectionEscHandler = function onEsc(e) {
      if (e.key === "Escape") {
        stopSmartSelection();
      }
    };
    document.addEventListener("keydown", selectionEscHandler);
    selectionResult("active");
  }

  function stopSmartSelection() {
    if (selectionOverlay) selectionOverlay.remove();
    if (selectionBox) selectionBox.remove();
    if (selectionEscHandler) document.removeEventListener("keydown", selectionEscHandler);
    selectionOverlay = null;
    selectionBox = null;
    selectionEscHandler = null;
    isSelecting = false;
    selectionResult("inactive");
  }

  // ========== 媒体嗅探 ==========
  const MEDIA_POLL_MS = 900;
  const MEDIA_DOM_LIMIT = 180;
  const mediaCandidates = new Map();
  let mediaActive = false;
  let mediaFilter = "all";
  let mediaSessionId = "";
  let mediaRevision = 0;
  let mediaPollTimer = null;
  let mediaDomObserver = null;
  let mediaDomScanTimer = null;
  let mediaSelectedKind = "all";
  let mediaRunGeneration = 0;
  let mediaRefreshInFlight = false;

  function mediaActionState() {
    const visible = visibleMediaCandidates();
    return publishState("EXTRACT_MEDIA", {
      active: mediaActive,
      phase: mediaActive ? "monitoring" : "inactive",
      scope: "tab",
      count: visible.length,
      reversibleCount: mediaActive ? 1 : 0,
      sessionId: mediaSessionId,
      revision: mediaRevision,
    });
  }

  function mediaResult(status, requestedAction) {
    const candidates = visibleMediaCandidates();
    return {
      ok: true,
      action: requestedAction || "EXTRACT_MEDIA",
      status,
      data: {
        ...mediaActionState(),
        sessionId: mediaSessionId,
        candidates: candidates.slice(0, 120),
        limitations: [
          "blob 地址仅是 MSE 播放句柄。",
          "加密、密文和分片资源不会作为完整文件下载。",
        ],
      },
    };
  }

  function mediaCandidateCategory(candidate) {
    const kind = String(candidate && candidate.kind || "media").toLowerCase();
    if (["video", "audio", "manifest", "image"].includes(kind)) return kind;
    const mimeType = String(candidate && candidate.mimeType || "").toLowerCase();
    const hint = `${candidate && candidate.groupId || ""} ${candidate && candidate.title || ""} ${candidate && candidate.url || ""}`.toLowerCase();
    if (mimeType.startsWith("audio/") || /(?:^|[:/_-])audio(?:[:/_.-]|$)|\.cmfa(?:$|[?#])/i.test(hint)) return "audio";
    if (/\.m3u8(?:$|[?#])|\.mpd(?:$|[?#])|mpegurl|dash\+xml/i.test(`${hint} ${mimeType}`)) return "manifest";
    if (mimeType.startsWith("image/") || /\.(?:png|jpe?g|gif|webp|avif)(?:$|[?#])/i.test(hint)) return "image";
    return "video";
  }

  function normalizeMediaCandidate(raw) {
    if (!raw || typeof raw !== "object") return null;
    const url = typeof raw.url === "string" ? raw.url.slice(0, 8192) : null;
    const kind = String(raw.kind || "media").toLowerCase();
    const groupId = String(raw.groupId || raw.id || url || `${kind}:${raw.mimeType || raw.title || mediaCandidates.size}`).slice(0, 1000);
    const expired = Number(raw.expiresAt) > 0 && Number(raw.expiresAt) <= Date.now();
    const downloadable = raw.downloadable === true
      && /^https?:\/\//i.test(url || "")
      && ["video", "audio"].includes(kind)
      && !raw.fragmented
      && !raw.separateTrack
      && !raw.ciphered
      && !raw.encrypted
      && !expired;
    return {
      id: groupId,
      groupId,
      url,
      kind,
      source: String(raw.source || "page").slice(0, 40),
      sources: Array.isArray(raw.sources) ? raw.sources.map(String).slice(0, 8) : [String(raw.source || "page")],
      site: String(raw.site || "generic").slice(0, 40),
      mimeType: String(raw.mimeType || "").slice(0, 180),
      codecs: String(raw.codecs || "").slice(0, 180),
      width: Math.max(0, Number(raw.width) || 0),
      height: Math.max(0, Number(raw.height) || 0),
      fps: String(raw.fps || "").slice(0, 40),
      bitrate: Math.max(0, Number(raw.bitrate) || 0),
      contentLength: String(raw.contentLength || "").slice(0, 40),
      quality: String(raw.quality || "").slice(0, 100),
      title: String(raw.title || "").slice(0, 180),
      fragmented: Boolean(raw.fragmented || kind === "segment"),
      separateTrack: Boolean(raw.separateTrack),
      ciphered: Boolean(raw.ciphered),
      encrypted: Boolean(raw.encrypted),
      downloadable,
      expired,
      reason: String(raw.reason || (expired ? "临时 URL 已过期。" : "")).slice(0, 260),
      expiresAt: Number(raw.expiresAt) || null,
      observations: Math.max(1, Number(raw.observations) || 1),
      bytesObserved: Math.max(0, Number(raw.bytesObserved) || 0),
      updatedAt: Math.max(0, Number(raw.updatedAt) || 0),
    };
  }

  function mergeMediaCandidates(items) {
    if (!Array.isArray(items)) return false;
    let changed = false;
    items.forEach((raw) => {
      const next = normalizeMediaCandidate(raw);
      if (!next) return;
      const previous = mediaCandidates.get(next.groupId);
      const preferNext = !previous
        || next.updatedAt > (previous.updatedAt || 0)
        || (next.updatedAt === 0 && next.source === previous.source);
      const primary = previous
        ? (preferNext ? { ...previous, ...next } : { ...next, ...previous })
        : next;
      const merged = previous ? {
        ...primary,
        url: primary.url || previous.url || next.url,
        site: primary.site || previous.site || next.site,
        mimeType: primary.mimeType || previous.mimeType || next.mimeType,
        codecs: primary.codecs || previous.codecs || next.codecs,
        width: primary.width || previous.width || next.width,
        height: primary.height || previous.height || next.height,
        fps: primary.fps || previous.fps || next.fps,
        bitrate: primary.bitrate || previous.bitrate || next.bitrate,
        contentLength: primary.contentLength || previous.contentLength || next.contentLength,
        quality: primary.quality || previous.quality || next.quality,
        title: primary.title || previous.title || next.title,
        reason: primary.reason || previous.reason || next.reason,
        sources: Array.from(new Set([...(previous.sources || []), ...(next.sources || [])])),
        fragmented: Boolean(previous.fragmented || next.fragmented),
        separateTrack: Boolean(previous.separateTrack || next.separateTrack),
        ciphered: Boolean(previous.ciphered || next.ciphered),
        encrypted: Boolean(previous.encrypted || next.encrypted),
        observations: Math.max(previous.observations || 1, next.observations || 1),
        bytesObserved: Math.max(previous.bytesObserved || 0, next.bytesObserved || 0),
        updatedAt: Math.max(previous.updatedAt || 0, next.updatedAt || 0),
      } : { ...next, updatedAt: next.updatedAt || Date.now() };
      merged.downloadable = Boolean(
        merged.downloadable
        && !merged.fragmented
        && !merged.separateTrack
        && !merged.ciphered
        && !merged.encrypted
      );
      const before = previous ? JSON.stringify(previous) : "";
      let after = JSON.stringify(merged);
      if (previous && before !== after && next.updatedAt === 0 && merged.updatedAt === previous.updatedAt) {
        merged.updatedAt = Date.now();
        after = JSON.stringify(merged);
      }
      if (before !== after) changed = true;
      if (!previous || before !== after) mediaCandidates.set(next.groupId, merged);
    });
    return changed;
  }

  function domMediaCandidates() {
    const output = [];
    const seen = new Set();
    const absoluteUrl = (value) => {
      const raw = String(value || "").trim();
      if (!raw) return "";
      try { return new URL(raw, location.href).href; } catch (_) { return ""; }
    };
    const push = (raw) => {
      const key = raw.groupId || raw.url;
      if (!key || seen.has(key) || output.length >= MEDIA_DOM_LIMIT) return;
      seen.add(key);
      output.push(raw);
    };

    document.querySelectorAll("video,audio").forEach((element) => {
      const kind = element.tagName === "AUDIO" ? "audio" : "video";
      const urls = [element.currentSrc, element.src, ...Array.from(element.querySelectorAll("source"), (source) => source.src)].filter(Boolean);
      urls.forEach((url) => push({
        groupId: `${url.startsWith("blob:") ? "blob" : "dom"}:${url}`,
        url,
        kind: url.startsWith("blob:") ? "blob" : kind,
        source: "dom",
        width: element.videoWidth || 0,
        height: element.videoHeight || 0,
        downloadable: /^https?:/i.test(url),
        reason: url.startsWith("blob:") ? "MSE/blob 播放句柄不可直接下载。" : "媒体元素当前资源。",
      }));
      if (!urls.length && element.srcObject) push({ groupId: `stream:${kind}`, kind: "stream", source: "dom", downloadable: false, reason: "MediaStream 没有可下载 URL。" });
      if (mediaFilter !== "audio" && element.tagName === "VIDEO" && element.poster) {
        const poster = absoluteUrl(element.poster);
        if (poster) push({ groupId: `image:${poster}`, url: poster, kind: "image", source: "poster", downloadable: false, reason: "视频 Poster（封面）图片。" });
      }
    });

    document.querySelectorAll([
      "meta[property='og:image']", "meta[property='og:image:url']", "meta[property='og:image:secure_url']",
      "meta[property='og:video']", "meta[property='og:video:url']", "meta[property='og:video:secure_url']",
      "meta[property='og:audio']", "meta[property='og:audio:url']", "meta[property='og:audio:secure_url']",
      "meta[name='twitter:image']", "meta[name='twitter:image:src']", "meta[name='twitter:player:stream']",
    ].join(",")).forEach((element) => {
      const key = String(element.getAttribute("property") || element.getAttribute("name") || "").toLowerCase();
      const url = absoluteUrl(element.content);
      if (!url) return;
      const kind = /image/.test(key)
        ? "image"
        : (/audio/.test(key) ? "audio" : (/\.(?:m3u8|mpd)(?:$|[?#])/i.test(url) ? "manifest" : "video"));
      if (mediaFilter === "audio" && kind !== "audio") return;
      push({
        groupId: kind === "image" ? `image:${url}` : `dom:${url}`,
        url,
        kind,
        source: "meta",
        downloadable: false,
        reason: `${key || "media"} 页面媒体 Meta。`,
      });
    });

    if (mediaFilter !== "audio") {
      document.querySelectorAll("img,picture source").forEach((element) => {
        const url = element.currentSrc || element.src || element.dataset && (element.dataset.src || element.dataset.original);
        if (!url || String(url).startsWith("data:image/svg")) return;
        push({
          groupId: `image:${url}`,
          url,
          kind: "image",
          source: "dom",
          width: element.naturalWidth || 0,
          height: element.naturalHeight || 0,
          downloadable: false,
          reason: "图片可复制或在新标签页打开。",
        });
      });
      Array.from(document.querySelectorAll("[style*='background']")).slice(0, 120).forEach((element) => {
        const value = element.style.backgroundImage || "";
        const match = value.match(/url\(["']?(.*?)["']?\)/i);
        if (match && match[1]) push({ groupId: `image:${match[1]}`, url: match[1], kind: "image", source: "dom", downloadable: false, reason: "内联背景图片。" });
      });
    }
    return output;
  }

  function visibleMediaCandidates() {
    return Array.from(mediaCandidates.values())
      .filter((item) => mediaFilter !== "audio" || mediaCandidateCategory(item) === "audio")
      .sort((a, b) => {
        const order = { video: 0, audio: 1, manifest: 2, image: 3 };
        return order[mediaCandidateCategory(a)] - order[mediaCandidateCategory(b)] || b.updatedAt - a.updatedAt;
      });
  }

  function snapshotData(response) {
    return response && response.ok !== false && response.data && typeof response.data === "object"
      ? response.data
      : null;
  }

  async function refreshMediaSniffer(options) {
    if (!mediaActive || mediaRefreshInFlight) return;
    mediaRefreshInFlight = true;
    const config = options || {};
    const refreshGeneration = mediaRunGeneration;
    try {
      let changed = mergeMediaCandidates(domMediaCandidates());
      let sessionChanged = false;
      let [backgroundResult, mainResult] = await Promise.all([
        chrome.runtime.sendMessage({ type: "WO_MEDIA_SESSION", mode: "snapshot" }).catch(() => null),
        runMainWorldAction("WO_MEDIA_SNIFFER", { mode: "status", sessionId: mediaSessionId }),
      ]);
      let backgroundData = snapshotData(backgroundResult);
      if (backgroundData && backgroundData.active === false && mediaActive && refreshGeneration === mediaRunGeneration) {
        const restarted = await chrome.runtime.sendMessage({
          type: "WO_MEDIA_SESSION",
          mode: "start",
          pageUrl: location.href,
          filter: mediaFilter,
        }).catch(() => null);
        if (!mediaActive || refreshGeneration !== mediaRunGeneration) {
          await chrome.runtime.sendMessage({ type: "WO_MEDIA_SESSION", mode: "stop" }).catch(() => null);
          return;
        }
        const restartedData = snapshotData(restarted);
        if (restartedData && restartedData.active !== false && restartedData.sessionId) {
          sessionChanged = restartedData.sessionId !== mediaSessionId;
          mediaSessionId = restartedData.sessionId;
          backgroundData = restartedData;
          mainResult = await runMainWorldAction("WO_MEDIA_SNIFFER", { mode: "enable", sessionId: mediaSessionId });
        }
      }
      if (!mediaActive || refreshGeneration !== mediaRunGeneration) return;
      const mainData = snapshotData(mainResult);
      let remoteRevision = mediaRevision;
      if (backgroundData && backgroundData.active !== false) {
        remoteRevision = Math.max(remoteRevision, Number(backgroundData.revision) || 0);
        changed = mergeMediaCandidates(backgroundData.candidates) || changed;
      }
      if (mainData) {
        remoteRevision = Math.max(remoteRevision, Number(mainData.revision) || 0);
        changed = mergeMediaCandidates(mainData.candidates) || changed;
      }
      if (changed || sessionChanged) {
        mediaRevision = Math.max(mediaRevision + 1, remoteRevision);
        mediaActionState();
        renderMediaPanel(config.announce ? "已刷新当前页面媒体。" : "");
      } else if (config.announce) {
        updateMediaPanelStatus("已刷新，当前结果没有变化。");
      }
    } finally {
      mediaRefreshInFlight = false;
    }
  }

  function startMediaDomObserver() {
    if (mediaDomObserver || !document.documentElement) return;
    mediaDomObserver = new MutationObserver((records) => {
      if (!records.some((record) => record.addedNodes && record.addedNodes.length)) return;
      if (mediaDomScanTimer) return;
      mediaDomScanTimer = setTimeout(() => {
        mediaDomScanTimer = null;
        if (mediaActive && mergeMediaCandidates(domMediaCandidates())) {
          mediaRevision += 1;
          mediaActionState();
          renderMediaPanel();
        }
      }, 420);
    });
    mediaDomObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  async function startMediaSniffer(payload) {
    const runGeneration = ++mediaRunGeneration;
    mediaFilter = payload && payload.filter === "audio" ? "audio" : "all";
    mediaSelectedKind = mediaFilter === "audio" ? "audio" : "all";
    mediaCandidates.clear();
    mediaRevision = 0;
    mediaActive = true;
    showMediaPanel();
    mergeMediaCandidates(domMediaCandidates());
    renderMediaPanel("正在读取播放器和网络资源…");

    const started = await chrome.runtime.sendMessage({
      type: "WO_MEDIA_SESSION",
      mode: "start",
      pageUrl: location.href,
      filter: mediaFilter,
    }).catch(() => null);
    const startedData = snapshotData(started);
    if (!mediaActive || runGeneration !== mediaRunGeneration) return mediaResult("inactive", payload && payload.requestedAction);
    if (startedData && startedData.sessionId) mediaSessionId = startedData.sessionId;
    else mediaSessionId = `${Date.now()}`;
    if (startedData) mergeMediaCandidates(startedData.candidates);

    const mainResult = await runMainWorldAction("WO_MEDIA_SNIFFER", {
      mode: "enable",
      sessionId: mediaSessionId,
    });
    if (!mediaActive || runGeneration !== mediaRunGeneration) {
      await Promise.all([
        chrome.runtime.sendMessage({ type: "WO_MEDIA_SESSION", mode: "stop" }).catch(() => null),
        runMainWorldAction("WO_MEDIA_SNIFFER", { mode: "disable", sessionId: mediaSessionId }),
      ]);
      return mediaResult("inactive", payload && payload.requestedAction);
    }
    const mainData = snapshotData(mainResult);
    if (mainData) mergeMediaCandidates(mainData.candidates);
    startMediaDomObserver();
    if (mediaPollTimer) clearInterval(mediaPollTimer);
    mediaPollTimer = setInterval(() => refreshMediaSniffer(), MEDIA_POLL_MS);
    mediaActionState();
    renderMediaPanel();
    return mediaResult("opened", payload && payload.requestedAction);
  }

  async function stopMediaSniffer(options) {
    const config = options || {};
    mediaRunGeneration += 1;
    mediaActive = false;
    if (mediaPollTimer) clearInterval(mediaPollTimer);
    mediaPollTimer = null;
    if (mediaDomScanTimer) clearTimeout(mediaDomScanTimer);
    mediaDomScanTimer = null;
    if (mediaDomObserver) mediaDomObserver.disconnect();
    mediaDomObserver = null;
    await Promise.all([
      chrome.runtime.sendMessage({ type: "WO_MEDIA_SESSION", mode: "stop" }).catch(() => null),
      runMainWorldAction("WO_MEDIA_SNIFFER", { mode: "disable", sessionId: mediaSessionId }),
    ]);
    mediaActionState();
    const panel = document.getElementById("web-omni-media-panel");
    if (panel && config.removePanel !== false) {
      panel.classList.remove("is-open");
      setTimeout(() => panel.remove(), 260);
    } else if (panel) renderMediaPanel("监听已停止。", true);
    return mediaResult("inactive", config.requestedAction);
  }

  function handleMediaSniffer(payload) {
    const config = payload && typeof payload === "object" ? payload : {};
    if (config.mode === "status") return Promise.resolve(mediaResult(mediaActive ? "monitoring" : "inactive", config.requestedAction));
    if (config.mode === "disable") return stopMediaSniffer({ requestedAction: config.requestedAction });
    const existing = document.getElementById("web-omni-media-panel");
    if (mediaActive && existing) {
      mediaFilter = config.filter === "audio" ? "audio" : mediaFilter;
      existing.classList.add("is-open");
      renderMediaPanel("媒体监听仍在运行。", true);
      return refreshMediaSniffer().then(() => mediaResult("monitoring", config.requestedAction));
    }
    return startMediaSniffer(config);
  }

  function mediaKindLabel(kind) {
    return ({ video: "视频", audio: "音频", manifest: "清单", image: "图片" })[kind] || "媒体";
  }

  function mediaUrlLabel(candidate) {
    if (!candidate.url) return candidate.mimeType || candidate.title || "没有直接 URL";
    try {
      const url = new URL(candidate.url, location.href);
      const name = url.pathname.split("/").filter(Boolean).pop() || url.hostname;
      return `${url.hostname} / ${decodeURIComponent(name).slice(0, 90)}`;
    } catch (_) {
      return candidate.url.slice(0, 120);
    }
  }

  function mediaMeta(candidate) {
    const parts = [];
    if (candidate.quality) parts.push(candidate.quality);
    if (candidate.width && candidate.height) parts.push(`${candidate.width}×${candidate.height}`);
    if (candidate.bitrate) parts.push(`${Math.round(candidate.bitrate / 1000)} kbps`);
    if (candidate.mimeType) parts.push(candidate.mimeType);
    if (candidate.codecs) parts.push(candidate.codecs);
    if (candidate.observations > 1) parts.push(`${candidate.observations} 次请求`);
    if (candidate.bytesObserved) parts.push(`${(candidate.bytesObserved / 1024 / 1024).toFixed(1)} MiB 已观察`);
    return parts.join(" · ") || candidate.sources.join(" + ");
  }

  function updateMediaPanelStatus(message) {
    const status = document.querySelector("#web-omni-media-panel [data-media-message]");
    if (status) status.textContent = message;
  }

  function renderMediaPanel(message, forceMessage) {
    const panel = document.getElementById("web-omni-media-panel");
    if (!panel) return;
    const all = visibleMediaCandidates();
    const kinds = ["all", "video", "audio", "manifest", "image"];
    const filtered = mediaSelectedKind === "all" ? all : all.filter((item) => mediaCandidateCategory(item) === mediaSelectedKind);
    const countFor = (kind) => kind === "all" ? all.length : all.filter((item) => mediaCandidateCategory(item) === kind).length;
    panel.querySelector("[data-media-count]").textContent = String(all.length);
    panel.querySelector("[data-media-state]").textContent = mediaActive ? "监听中" : "已停止";
    panel.querySelector("[data-media-state]").classList.toggle("is-active", mediaActive);
    const tabs = panel.querySelector("[data-media-tabs]");
    const tabNodes = kinds.map((kind) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.mediaKind = kind;
      button.classList.toggle("is-selected", mediaSelectedKind === kind);
      button.append(document.createTextNode(`${kind === "all" ? "全部" : mediaKindLabel(kind)} `));
      const count = document.createElement("span");
      count.textContent = String(countFor(kind));
      button.appendChild(count);
      return button;
    });
    tabs.replaceChildren(...tabNodes);

    const list = panel.querySelector("[data-media-list]");
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "wo-media-empty";
      const title = document.createElement("strong");
      title.textContent = `暂未捕获到${mediaSelectedKind === "all" ? "媒体" : mediaKindLabel(mediaSelectedKind)}`;
      const hint = document.createElement("span");
      hint.textContent = "开始播放、拖动进度条或切换清晰度，面板会继续监听。";
      empty.append(title, hint);
      list.replaceChildren(empty);
    } else {
      list.replaceChildren(...filtered.map(createMediaCandidateNode));
    }
    const status = panel.querySelector("[data-media-message]");
    if (message || forceMessage) status.textContent = message || (mediaActive ? "签名 URL 只保存在本次标签页内存中。" : "监听已停止。");
    else status.textContent = mediaActive ? "播放或拖动进度条可捕获更多分片；结果每秒更新。" : "监听已停止。";
  }

  function createMediaCandidateNode(candidate) {
    const item = document.createElement("article");
    item.className = "wo-media-item";
    item.dataset.kind = mediaCandidateCategory(candidate);

    const head = document.createElement("div");
    head.className = "wo-media-item-head";
    const badges = document.createElement("span");
    badges.className = "wo-media-badges";
    [
      mediaKindLabel(mediaCandidateCategory(candidate)),
      candidate.site !== "generic" ? candidate.site : "",
      candidate.separateTrack ? "独立轨道" : "",
      candidate.fragmented ? "分片" : "",
      candidate.ciphered ? "密文" : "",
      candidate.encrypted ? "DRM/加密" : "",
      candidate.expired ? "已过期" : "",
    ].filter(Boolean).forEach((label) => {
      const badge = document.createElement("em");
      badge.textContent = label;
      badges.appendChild(badge);
    });
    const source = document.createElement("span");
    source.textContent = candidate.source;
    head.append(badges, source);

    const title = document.createElement("strong");
    title.textContent = candidate.title || mediaUrlLabel(candidate);
    title.title = candidate.url || candidate.title || "";
    const meta = document.createElement("small");
    meta.textContent = mediaMeta(candidate);
    const reason = document.createElement("p");
    reason.textContent = candidate.reason || "已识别媒体候选。";
    const actions = document.createElement("div");
    actions.className = "wo-media-actions";

    if (candidate.url) {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.dataset.mediaCopy = candidate.groupId;
      copy.textContent = "复制 URL";
      actions.appendChild(copy);
    }
    if (candidate.kind === "image" && candidate.url) {
      const open = document.createElement("button");
      open.type = "button";
      open.dataset.mediaOpen = candidate.groupId;
      open.textContent = "打开";
      actions.appendChild(open);
    }
    if (candidate.downloadable) {
      const download = document.createElement("button");
      download.type = "button";
      download.className = "is-primary";
      download.dataset.mediaDownload = candidate.groupId;
      download.textContent = "下载文件";
      actions.appendChild(download);
    } else {
      const unavailable = document.createElement("span");
      unavailable.textContent = "不可直接下载";
      actions.appendChild(unavailable);
    }
    item.append(head, title, meta, reason, actions);
    return item;
  }

  function showMediaPanel() {
    let panel = document.getElementById("web-omni-media-panel");
    if (panel) {
      panel.classList.add("is-open");
      return panel;
    }
    panel = document.createElement("aside");
    panel.id = "web-omni-media-panel";
    panel.setAttribute("data-wo-command-surface", "");
    panel.setAttribute("aria-label", "媒体嗅探结果");
    panel.innerHTML = `<header class="wo-media-header">
      <span class="wo-media-mark" aria-hidden="true">WO</span>
      <span class="wo-media-heading"><strong>媒体嗅探</strong><small><i data-media-state>监听中</i> · <b data-media-count>0</b> 项</small></span>
      <button type="button" data-media-refresh title="刷新" aria-label="刷新媒体结果">↻</button>
      <button type="button" data-media-stop title="停止监听" aria-label="停止媒体监听">■</button>
      <button type="button" data-media-close title="关闭" aria-label="关闭媒体面板">×</button>
    </header>
    <nav class="wo-media-tabs" data-media-tabs aria-label="媒体类型"></nav>
    <div class="wo-media-list" data-media-list></div>
    <footer class="wo-media-footer" data-media-message role="status" aria-live="polite"></footer>`;
    document.body.appendChild(panel);
    panel.addEventListener("click", async (event) => {
      const kindButton = event.target.closest("[data-media-kind]");
      if (kindButton) {
        mediaSelectedKind = kindButton.getAttribute("data-media-kind") || "all";
        renderMediaPanel();
        return;
      }
      if (event.target.closest("[data-media-refresh]")) {
        await refreshMediaSniffer({ announce: true });
        return;
      }
      if (event.target.closest("[data-media-stop]")) {
        await stopMediaSniffer({ removePanel: false });
        return;
      }
      if (event.target.closest("[data-media-close]")) {
        await stopMediaSniffer();
        return;
      }
      const copy = event.target.closest("[data-media-copy]");
      if (copy) {
        const candidate = mediaCandidates.get(copy.getAttribute("data-media-copy"));
        if (!candidate || !candidate.url) return;
        try {
          await navigator.clipboard.writeText(candidate.url);
          renderMediaPanel("完整 URL 已复制；其中可能包含短期签名，请谨慎分享。", true);
        } catch (_) {
          renderMediaPanel("复制失败，请重试。", true);
        }
        return;
      }
      const open = event.target.closest("[data-media-open]");
      if (open) {
        const candidate = mediaCandidates.get(open.getAttribute("data-media-open"));
        if (candidate && candidate.url) window.open(candidate.url, "_blank", "noopener");
        return;
      }
      const download = event.target.closest("[data-media-download]");
      if (download) {
        const candidate = mediaCandidates.get(download.getAttribute("data-media-download"));
        if (!candidate) return;
        download.disabled = true;
        const response = await chrome.runtime.sendMessage({ type: "WO_MEDIA_DOWNLOAD", candidate }).catch(() => null);
        download.disabled = false;
        renderMediaPanel(response && response.ok ? "下载任务已创建。" : ((response && response.error && response.error.message) || "下载失败。"), true);
      }
    });
    requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.add("is-open")));
    return panel;
  }

  // ========== Markdown 剪藏 ==========
  function extractMarkdown() {
    let title = document.title, url = window.location.href;
    let md = `# ${title}\n> 来源: ${url}\n> 时间: ${new Date().toLocaleString()}\n\n`;
    const article = document.querySelector("article") || document.querySelector("[role='main']") || document.querySelector("main") || document.querySelector(".post-content") || document.querySelector("#content") || document.body;

    function ex(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent.trim();
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const tag = node.tagName.toLowerCase();
      if (["script","style","nav","footer","header","aside","iframe","noscript"].includes(tag)) return "";
      if (node.id && node.id.startsWith("web-omni")) return "";
      if (node.id && node.id.startsWith("wo-")) return "";
      const ch = Array.from(node.childNodes).map(ex).filter(t => t).join("");
      switch(tag) {
        case "h1": return `# ${ch}\n\n`; case "h2": return `## ${ch}\n\n`;
        case "h3": return `### ${ch}\n\n`; case "h4": return `#### ${ch}\n\n`;
        case "p": return ch ? `${ch}\n\n` : ""; case "br": return "\n";
        case "strong": case "b": return `**${ch}**`;
        case "em": case "i": return `*${ch}*`;
        case "a": return `[${ch}](${node.href || ""})`; case "img": return `![${node.alt || ""}](${node.src || ""})\n\n`;
        case "li": return `- ${ch}\n`; case "ul": case "ol": return `\n${ch}\n`;
        case "blockquote": return `> ${ch.replace(/\n/g, "\n> ")}\n\n`;
        case "code": return `\`${ch}\``; case "pre": return `\n\`\`\`\n${node.innerText}\n\`\`\`\n\n`;
        default: return ch;
      }
    }
    md += ex(article);
    showResultPanel("Markdown 剪藏", `<pre style="white-space:pre-wrap;font-size:12px;color:#aaa;">${escHtml(md)}</pre>`);
  }

  // ========== 链接提取 → 面板展示 ==========
  function extractLinks() {
    const links = Array.from(document.querySelectorAll("a[href]"));
    const domains = {};
    let total = 0;
    links.forEach(a => {
      try {
        const u = new URL(a.href);
        if (u.protocol !== "http:" && u.protocol !== "https:") return;
        const d = u.hostname;
        const t = (a.innerText || a.title || "无标题").trim().replace(/\n/g, ' ').substring(0, 80);
        if (!domains[d]) domains[d] = [];
        if (!domains[d].find(i => i.href === a.href)) { domains[d].push({ text: t, href: a.href }); total++; }
      } catch(e) {}
    });
    if (total === 0) { if (window.webOmniShowToast) window.webOmniShowToast("未找到有效链接", "warn"); return; }

    let html = '';
    Object.keys(domains).sort((a,b) => domains[b].length - domains[a].length).forEach(d => {
      html += `<div style="margin-bottom:12px;"><b style="color:#888;font-size:12px;">${escHtml(d)} (${domains[d].length})</b>`;
      domains[d].forEach(l => {
        html += `<div style="padding:3px 0;font-size:12px;border-bottom:1px solid #222;"><a href="${l.href}" target="_blank" style="color:#7ab;text-decoration:none;">${escHtml(l.text)}</a></div>`;
      });
      html += `</div>`;
    });
    showResultPanel(`链接提取 (${total})`, html);
  }

  // ========== 结构化数据 → 面板展示 ==========
  function extractStructuredData() {
    const data = { meta: {}, openGraph: {}, twitter: {}, jsonLd: [] };
    document.querySelectorAll("meta[name]").forEach(m => { const n = m.getAttribute("name"); if (n && !n.startsWith("twitter:")) data.meta[n] = m.content; });
    document.querySelectorAll("meta[property^='og:']").forEach(m => { data.openGraph[m.getAttribute("property").replace("og:", "")] = m.content; });
    document.querySelectorAll("meta[name^='twitter:']").forEach(m => { data.twitter[m.getAttribute("name").replace("twitter:", "")] = m.content; });
    document.querySelectorAll('script[type="application/ld+json"]').forEach(s => { try { data.jsonLd.push(JSON.parse(s.textContent)); } catch(e) {} });

    let html = '';
    const sections = [['Meta', data.meta], ['Open Graph', data.openGraph], ['Twitter', data.twitter]];
    sections.forEach(([name, obj]) => {
      const keys = Object.keys(obj);
      if (keys.length === 0) return;
      html += `<div style="margin-bottom:12px;"><b style="color:#888;font-size:12px;">${name}</b>`;
      keys.forEach(k => { html += `<div style="padding:2px 0;font-size:12px;"><span style="color:#999;">${escHtml(k)}:</span> ${escHtml(obj[k])}</div>`; });
      html += `</div>`;
    });
    if (data.jsonLd.length > 0) {
      html += `<div style="margin-bottom:12px;"><b style="color:#888;font-size:12px;">JSON-LD (${data.jsonLd.length})</b><pre style="white-space:pre-wrap;font-size:11px;color:#aaa;background:#111;padding:8px;border-radius:4px;max-height:300px;overflow:auto;">${escHtml(JSON.stringify(data.jsonLd, null, 2))}</pre></div>`;
    }
    showResultPanel("结构化数据", html || '<span style="color:#666;">未找到</span>');
  }

  // ========== CSS选择器爬取 → 面板展示 ==========
  function promptCssExtraction() {
    const selector = prompt("输入 CSS 选择器 (如 .article p, h2):");
    if (!selector) return;
    try {
      const els = document.querySelectorAll(selector);
      if (els.length === 0) { if (window.webOmniShowToast) window.webOmniShowToast("未找到匹配元素", "warn"); return; }
      let html = '';
      els.forEach((el, i) => {
        html += `<div style="padding:6px 0;border-bottom:1px solid #252525;"><span style="color:#666;font-size:11px;">[${i+1}]</span> <span style="font-size:12px;">${escHtml(el.innerText.trim().substring(0, 200))}</span></div>`;
      });
      showResultPanel(`CSS提取 "${selector}" (${els.length})`, html);
    } catch(e) {
      if (window.webOmniShowToast) window.webOmniShowToast("无效的选择器", "error");
    }
  }

  // ========== 邮箱/电话嗅探 → 面板展示 ==========
  function extractEmailPhone() {
    const text = document.body.innerText || "";
    const emails = [...new Set((text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []))];
    const phonesRaw = text.match(/(?:\+?86)?1[3-9]\d{9}|(?:\d{3,4}-)?\d{7,8}/g) || [];
    const phones = [...new Set(phonesRaw.filter(p => !p.match(/^20\d{2}$/) && p.length >= 7))];

    if (emails.length === 0 && phones.length === 0) {
      if (window.webOmniShowToast) window.webOmniShowToast("未嗅探到邮箱或电话", "warn"); return;
    }
    let html = '';
    if (emails.length > 0) {
      html += `<b style="color:#888;font-size:12px;">📧 邮箱 (${emails.length})</b>`;
      emails.forEach(e => { html += `<div style="padding:3px 0;font-size:13px;">${escHtml(e)}</div>`; });
      html += '<br>';
    }
    if (phones.length > 0) {
      html += `<b style="color:#888;font-size:12px;">📞 电话 (${phones.length})</b>`;
      phones.forEach(p => { html += `<div style="padding:3px 0;font-size:13px;">${escHtml(p)}</div>`; });
    }
    showResultPanel(`联系方式嗅探`, html);
  }

  // ========== 页面快照 → 面板展示 ==========
  function extractPageSnapshot() {
    const textLen = (document.body.innerText || "").replace(/\s/g, '').length;
    const items = [
      ["标题", document.title],
      ["网址", location.href],
      ["描述", document.querySelector('meta[name="description"]')?.content || "无"],
      ["关键词", document.querySelector('meta[name="keywords"]')?.content || "无"],
      ["纯文本字数", `约 ${textLen} 字`],
      ["图片数量", document.querySelectorAll('img').length],
      ["链接数量", document.querySelectorAll('a').length],
      ["脚本数量", document.querySelectorAll('script').length],
      ["Cookie数量", document.cookie.split(';').filter(c => c.trim()).length],
      ["DOM节点数", document.querySelectorAll('*').length],
    ];
    try {
      const timing = performance.timing;
      items.push(["加载耗时", ((timing.loadEventEnd - timing.navigationStart) / 1000).toFixed(2) + 's']);
    } catch(e) {}

    let html = items.map(([k, v]) => `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #252525;font-size:13px;"><span style="color:#888;">${k}</span><span>${escHtml(String(v))}</span></div>`).join('');
    showResultPanel("页面快照", html);
  }

  // ========== 新增：页面源码提取 ==========
  function extractPageSource() {
    const source = document.documentElement.outerHTML;
    showResultPanel("页面源码", `<div style="margin-bottom:8px;font-size:12px;color:#888;">共 ${source.length} 字符</div><pre style="white-space:pre-wrap;word-break:break-all;font-size:11px;color:#aaa;max-height:80vh;overflow:auto;">${escHtml(source.substring(0, 50000))}${source.length > 50000 ? '\n\n... (已截断)' : ''}</pre>`);
  }

  // ========== 新增：Cookie 提取 ==========
  function extractCookies() {
    const cookies = document.cookie.split(';').map(c => c.trim()).filter(c => c);
    if (cookies.length === 0) {
      if (window.webOmniShowToast) window.webOmniShowToast("当前页面无可读Cookie", "warn"); return;
    }
    let html = '';
    cookies.forEach(c => {
      const [name, ...rest] = c.split('=');
      const val = rest.join('=');
      html += `<div style="padding:4px 0;border-bottom:1px solid #252525;font-size:12px;word-break:break-all;"><b style="color:#999;">${escHtml(name.trim())}</b> = <span style="color:#7ab;">${escHtml(val)}</span></div>`;
    });
    showResultPanel(`Cookie (${cookies.length})`, html);
  }

  // ========== 新增：隐藏表单字段提取 ==========
  function extractHiddenFields() {
    const hiddens = document.querySelectorAll('input[type="hidden"]');
    const tokens = [];
    hiddens.forEach(h => {
      tokens.push({ name: h.name || h.id || '(unnamed)', value: h.value });
    });
    // 也提取 CSRF tokens
    document.querySelectorAll('meta[name*="csrf"], meta[name*="token"]').forEach(m => {
      tokens.push({ name: `meta:${m.getAttribute('name')}`, value: m.content });
    });

    if (tokens.length === 0) {
      if (window.webOmniShowToast) window.webOmniShowToast("未找到隐藏字段", "warn"); return;
    }
    let html = tokens.map(t =>
      `<div style="padding:4px 0;border-bottom:1px solid #252525;font-size:12px;word-break:break-all;"><b style="color:#999;">${escHtml(t.name)}</b> = <span style="color:#c97;">${escHtml(t.value)}</span></div>`
    ).join('');
    showResultPanel(`隐藏字段/Token (${tokens.length})`, html);
  }

  // ========== 新增：AJAX/API端点嗅探 ==========
  function extractAjaxUrls() {
    const urls = new Set();
    // 从 script 标签中正则提取 API/fetch/xhr 地址
    document.querySelectorAll('script:not([src])').forEach(s => {
      const text = s.textContent || "";
      // 匹配 fetch/axios/$.ajax/XMLHttpRequest 中的URL
      const patterns = [
        /fetch\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]/gi,
        /(?:url|endpoint|api|baseURL|baseUrl)\s*[:=]\s*["'`](https?:\/\/[^"'`]+)["'`]/gi,
        /["'`](\/api\/[^"'`]+)["'`]/gi,
        /["'`](https?:\/\/[^"'`]*\/api\/[^"'`]+)["'`]/gi,
        /\.(?:get|post|put|delete|patch)\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]/gi,
        /\.(?:get|post|put|delete|patch)\s*\(\s*["'`](\/[^"'`]+)["'`]/gi,
      ];
      patterns.forEach(reg => {
        let m;
        while ((m = reg.exec(text)) !== null) {
          if (m[1] && m[1].length < 500) urls.add(m[1]);
        }
      });
    });

    // 从 script[src] 提取外部脚本地址
    document.querySelectorAll('script[src]').forEach(s => {
      if (s.src) urls.add(s.src);
    });

    if (urls.size === 0) {
      if (window.webOmniShowToast) window.webOmniShowToast("未嗅探到API端点", "warn"); return;
    }

    const arr = [...urls].sort();
    let html = arr.map(u => `<div style="padding:3px 0;border-bottom:1px solid #252525;font-size:12px;word-break:break-all;"><a href="${u}" target="_blank" style="color:#7ab;text-decoration:none;">${escHtml(u)}</a></div>`).join('');
    showResultPanel(`API/脚本端点 (${arr.length})`, html);
  }

  // ========== 新增：localStorage/sessionStorage 转储 ==========
  function dumpStorage() {
    let html = '';
    const storages = [['localStorage', localStorage], ['sessionStorage', sessionStorage]];
    storages.forEach(([name, store]) => {
      try {
        const keys = Object.keys(store);
        if (keys.length === 0) { html += `<b style="color:#888;font-size:12px;">${name} (空)</b><br><br>`; return; }
        html += `<b style="color:#888;font-size:12px;">${name} (${keys.length})</b>`;
        keys.forEach(k => {
          let v = store.getItem(k);
          if (v && v.length > 200) v = v.substring(0, 200) + '...';
          html += `<div style="padding:3px 0;border-bottom:1px solid #252525;font-size:12px;word-break:break-all;"><b style="color:#c97;">${escHtml(k)}</b> = <span style="color:#aaa;">${escHtml(v)}</span></div>`;
        });
        html += '<br>';
      } catch(e) { html += `<b>${name}</b>: 访问被拒绝<br>`; }
    });
    showResultPanel('Storage 转储', html);
  }

  // ========== 新增：密码框明文显示 ==========
  const revealedPasswordFields = new Map();

  function passwordState(status) {
    const active = revealedPasswordFields.size > 0;
    return {
      ok: true,
      action: "REVEAL_PASSWORDS",
      status: status || (active ? "active" : "inactive"),
      data: publishState("REVEAL_PASSWORDS", {
        active,
        phase: active ? "recoverable" : "inactive",
        count: revealedPasswordFields.size,
        reversibleCount: revealedPasswordFields.size,
      }),
    };
  }

  function restorePasswords() {
    revealedPasswordFields.forEach((record, input) => {
      if (!input) return;
      if (record.hadType) input.setAttribute("type", record.typeValue);
      else input.removeAttribute("type");
      restoreInline(input, "outline", record.outline);
      restoreInline(input, "outline-offset", record.outlineOffset);
    });
    revealedPasswordFields.clear();
    if (window.webOmniShowToast) window.webOmniShowToast("密码框已恢复", "info");
    return passwordState("restored");
  }

  function restoreInline(element, name, record) {
    if (record.value) element.style.setProperty(name, record.value, record.priority || "");
    else element.style.removeProperty(name);
  }

  function revealPasswords(payload) {
    const mode = payload && payload.mode;
    if (mode === "status") return passwordState();
    if (mode === "disable" || mode === "restoreAll" || (revealedPasswordFields.size && mode !== "enable")) {
      return restorePasswords();
    }
    const pwFields = document.querySelectorAll('input[type="password"]');
    if (pwFields.length === 0) {
      if (window.webOmniShowToast) window.webOmniShowToast('页面中没有密码框', 'warn');
      return passwordState("inactive");
    }
    let html = '';
    pwFields.forEach((input, i) => {
      const name = input.name || input.id || input.placeholder || `密码框${i+1}`;
      const val = input.value;
      revealedPasswordFields.set(input, {
        hadType: input.hasAttribute("type"),
        typeValue: input.getAttribute("type") || "password",
        outline: {
          value: input.style.getPropertyValue("outline"),
          priority: input.style.getPropertyPriority("outline"),
        },
        outlineOffset: {
          value: input.style.getPropertyValue("outline-offset"),
          priority: input.style.getPropertyPriority("outline-offset"),
        },
      });
      input.setAttribute("type", "text");
      // 视觉标记
      input.style.outline = '2px solid #c97';
      input.style.outlineOffset = '1px';
      html += `<div style="padding:4px 0;border-bottom:1px solid #252525;font-size:13px;"><b style="color:#999;">${escHtml(name)}</b>: <span style="color:#e95;font-family:monospace;">${val ? escHtml(val) : '(空)'}</span></div>`;
    });
    showResultPanel(`密码框 (${pwFields.length})`, html + '<br><small style="color:#666;">密码框已显示明文，可从活动功能恢复。</small>');
    return passwordState("active");
  }

  function resultLimitations(result) {
    if (!result || !Array.isArray(result.limitations) || result.limitations.length === 0) return '';
    return `<div style="margin-top:10px;padding-top:8px;border-top:1px solid #2a2a2a;color:#777;font-size:11px;">${result.limitations.map(escHtml).join('<br>')}</div>`;
  }

  // ========== 页面主环境能力 ==========
  async function dumpJsGlobals(payload) {
    const result = await runMainWorldAction('DUMP_JS_GLOBALS', payload);
    if (!result.ok) { showMainWorldError('全局 JS 变量', result); return result; }
    const globals = result.data.globals || [];
    const html = globals.length ? globals.map(item =>
      `<div style="padding:3px 0;border-bottom:1px solid #252525;font-size:12px;word-break:break-all;"><b style="color:#7ab;">${escHtml(item.name)}</b> <span style="color:#666;">[${escHtml(item.type)}]</span> = <span style="color:#aaa;">${escHtml(item.preview)}</span></div>`
    ).join('') : '<div style="color:#777;">未发现自定义全局变量</div>';
    showResultPanel(`全局 JS 变量 (${globals.length})`, html + resultLimitations(result));
    return result;
  }

  async function hijackEvents(payload) {
    const result = await runMainWorldAction('HIJACK_EVENTS', payload);
    if (!result.ok) { showMainWorldError('事件监听', result); return result; }
    const events = result.data.recent || [];
    const html = events.length ? events.map(item =>
      `<div style="padding:3px 0;border-bottom:1px solid #252525;font-size:11px;"><span style="color:#7ab;">${escHtml(item.target)}</span>.<span style="color:#c97;">${escHtml(item.type)}</span> <span style="color:#666;">${item.capture ? 'capture' : 'bubble'}</span></div>`
    ).join('') : '<div style="color:#777;">监听已启用，尚未记录新的事件注册</div>';
    showResultPanel(`事件监听 (${result.data.count || 0})`, html + resultLimitations(result));
    return result;
  }

  async function interceptRequests(payload) {
    const result = await runMainWorldAction('INTERCEPT_REQUESTS', payload);
    if (!result.ok) { showMainWorldError('网络请求监听', result); return result; }
    const requests = result.data.recent || [];
    const html = requests.length ? requests.map(item =>
      `<div style="padding:3px 0;border-bottom:1px solid #252525;font-size:11px;word-break:break-all;"><span style="color:${item.blocked ? '#ef9a9a' : item.method === 'POST' ? '#e9a66b' : '#7ab'};font-weight:bold;">${escHtml(item.method)}</span> <span style="color:#777;">${escHtml(item.transport)}</span> <a href="${escHtml(item.url)}" target="_blank" rel="noreferrer" style="color:#aaa;text-decoration:none;">${escHtml(item.url)}</a></div>`
    ).join('') : '<div style="color:#777;">监听已启用，尚未记录新的请求</div>';
    showResultPanel(`网络请求 (${result.data.count || 0})`, html + resultLimitations(result));
    return result;
  }

  async function browserFingerprint(payload) {
    const result = await runMainWorldAction('BROWSER_FINGERPRINT', payload);
    if (!result.ok) { showMainWorldError('浏览器指纹', result); return result; }
    const html = Object.entries(result.data || {}).map(([key, value]) => {
      const display = value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
      return `<div style="display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid #252525;font-size:12px;word-break:break-all;"><span style="color:#888;flex-shrink:0;">${escHtml(key)}</span><span style="color:#7ab;text-align:right;">${escHtml(display)}</span></div>`;
    }).join('');
    showResultPanel('浏览器指纹', html + resultLimitations(result));
    return result;
  }

  async function websocketMonitor(payload) {
    const result = await runMainWorldAction('WEBSOCKET_MONITOR', payload);
    if (!result.ok) { showMainWorldError('WebSocket 监听', result); return result; }
    const logs = result.data.recent || [];
    const html = logs.length ? logs.map(item =>
      `<div style="padding:3px 0;border-bottom:1px solid #252525;font-size:11px;word-break:break-all;"><span style="color:${item.direction === 'send' ? '#e9a66b' : '#7ab'};font-weight:bold;">${item.direction === 'send' ? 'SEND' : 'RECV'}</span> <span style="color:#666;">[${new Date(item.time).toLocaleTimeString()}]</span> <span style="color:#aaa;">${escHtml(item.data)}</span></div>`
    ).join('') : '<div style="color:#777;">监听已启用，尚未记录新的 WebSocket 消息</div>';
    showResultPanel(`WebSocket 消息 (${result.data.count || 0})`, html + resultLimitations(result));
    return result;
  }

  function jsInjector() {
    const result = {
      ok: false,
      action: 'JS_INJECTOR',
      status: 'unsupported',
      error: {
        code: 'UNSUPPORTED_MV3_CSP',
        message: 'Manifest V3 不允许此扩展执行用户输入的任意 JavaScript。本版本未申请 userScripts 或 debugger 权限。',
      },
    };
    showMainWorldError('JS 代码注入', result);
    return result;
  }

  async function canvasSpoof(payload) {
    const result = await runMainWorldAction('CANVAS_SPOOF', payload);
    if (!result.ok) { showMainWorldError('Canvas 伪装', result); return result; }
    if (window.webOmniShowToast) {
      window.webOmniShowToast(result.data.enabled ? 'Canvas 指纹伪装已启用' : 'Canvas 指纹伪装已恢复', result.data.enabled ? 'success' : 'info');
    }
    return result;
  }

  // ========== 工具函数 ==========
  function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

})();
