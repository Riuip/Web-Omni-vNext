// 神经末梢：实用工具集 (Page Tools)
// 页面二维码、性能速查、页面标注

(function() {
  if (window.webOmniPageToolsInjected) return;
  window.webOmniPageToolsInjected = true;

  const actionHandlers = {
    PAGE_QR_CODE: () => generateQRCode(),
    PAGE_PERFORMANCE: () => showPerformance(),
    PAGE_ANNOTATE: (request) => handleAnnotation(request.payload || request),
  };

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

  // ========== 页面二维码 ==========
  function generateQRCode() {
    const existing = document.getElementById("web-omni-qr-panel");
    if (existing) {
      existing.remove();
      return { ok: true, action: "PAGE_QR_CODE", status: "closed", data: {} };
    }

    const url = window.location.href;
    const qrFactory = globalThis.qrcode;
    if (typeof qrFactory !== "function") {
      const result = {
        ok: false,
        action: "PAGE_QR_CODE",
        status: "failed",
        error: { code: "MODULE_LOAD_FAILED", message: "本地二维码模块未加载。" },
      };
      if (window.webOmniShowToast) window.webOmniShowToast(result.error.message, "error");
      return result;
    }

    let qrDataUrl;
    try {
      const qr = qrFactory(0, "M");
      qr.addData(url);
      qr.make();
      qrDataUrl = qr.createDataURL(5, 20);
    } catch (error) {
      const result = {
        ok: false,
        action: "PAGE_QR_CODE",
        status: "failed",
        error: { code: "ACTION_FAILED", message: error && error.message ? error.message : String(error) },
      };
      if (window.webOmniShowToast) window.webOmniShowToast("当前网址无法生成二维码", "error");
      return result;
    }

    const panel = document.createElement("div");
    panel.id = "web-omni-qr-panel";
    panel.style.cssText = `
      position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(0.9);
      z-index:2147483646;background:rgba(22,22,22,0.95);backdrop-filter:blur(24px);
      border:1px solid rgba(255,255,255,0.1);border-radius:20px;padding:32px;
      box-shadow:0 24px 60px rgba(0,0,0,0.5);text-align:center;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#fff;
      opacity:0;transition:all 0.3s cubic-bezier(0.2,0,0,1);
    `;
    panel.innerHTML = `
      <div style="font-size:15px;font-weight:700;margin-bottom:16px;">📱 扫码访问当前页面</div>
      <div style="background:#fff;padding:16px;border-radius:12px;display:inline-block;">
        <img src="${qrDataUrl}" style="width:180px;height:180px;display:block;image-rendering:pixelated;" alt="当前页面二维码">
      </div>
      <div style="margin-top:14px;font-size:12px;color:#aaa;max-width:250px;word-break:break-all;line-height:1.4;">${escapeHtml(url.length > 60 ? url.substring(0,60)+'...' : url)}</div>
      <div style="margin-top:16px;display:flex;gap:8px;justify-content:center;">
        <button id="wo-qr-copy" style="background:rgba(0,122,255,0.8);border:none;color:#fff;padding:8px 16px;border-radius:8px;cursor:pointer;font-size:13px;">📋 复制链接</button>
        <button id="wo-qr-close" style="background:rgba(255,255,255,0.08);border:none;color:#ccc;padding:8px 16px;border-radius:8px;cursor:pointer;font-size:13px;">关闭</button>
      </div>
    `;
    document.body.appendChild(panel);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      panel.style.opacity = "1";
      panel.style.transform = "translate(-50%,-50%) scale(1)";
    }));

    panel.querySelector("#wo-qr-close").addEventListener("click", () => {
      panel.style.opacity = "0";
      panel.style.transform = "translate(-50%,-50%) scale(0.9)";
      setTimeout(() => panel.remove(), 300);
    });
    panel.querySelector("#wo-qr-copy").addEventListener("click", () => {
      navigator.clipboard.writeText(url).then(() => {
        if (window.webOmniShowToast) window.webOmniShowToast("📋 链接已复制", "success");
      });
    });
    return { ok: true, action: "PAGE_QR_CODE", status: "opened", data: { local: true, length: url.length } };
  }

  // ========== 页面性能速查 ==========
  function showPerformance() {
    const existing = document.getElementById("web-omni-perf-panel");
    if (existing) { existing.remove(); return; }

    const perf = performance.getEntriesByType("navigation")[0] || {};
    const resources = performance.getEntriesByType("resource");
    const timing = performance.timing || {};

    const domNodes = document.querySelectorAll("*").length;
    const imgCount = document.querySelectorAll("img").length;
    const scriptCount = document.querySelectorAll("script").length;
    const styleCount = document.querySelectorAll("link[rel='stylesheet'], style").length;

    const loadTime = perf.loadEventEnd ? Math.round(perf.loadEventEnd - perf.startTime) : (timing.loadEventEnd ? timing.loadEventEnd - timing.navigationStart : "N/A");
    const domReady = perf.domContentLoadedEventEnd ? Math.round(perf.domContentLoadedEventEnd - perf.startTime) : "N/A";
    const ttfb = perf.responseStart ? Math.round(perf.responseStart - perf.startTime) : "N/A";

    const totalSize = resources.reduce((s, r) => s + (r.transferSize || 0), 0);
    const sizeMB = (totalSize / 1024 / 1024).toFixed(2);

    function ratingColor(val, good, bad) {
      if (typeof val !== "number") return "#888";
      return val <= good ? "#4ade80" : val <= bad ? "#f59e0b" : "#f87171";
    }

    const panel = document.createElement("div");
    panel.id = "web-omni-perf-panel";
    panel.style.cssText = `
      position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(0.9);
      z-index:2147483646;background:rgba(18,18,18,0.96);backdrop-filter:blur(24px);
      border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:28px;
      box-shadow:0 24px 60px rgba(0,0,0,0.5);min-width:360px;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#fff;
      opacity:0;transition:all 0.3s cubic-bezier(0.2,0,0,1);
    `;

    const metrics = [
      { label: "首字节 (TTFB)", value: ttfb, unit: "ms", color: ratingColor(ttfb, 200, 600) },
      { label: "DOM Ready", value: domReady, unit: "ms", color: ratingColor(domReady, 1000, 3000) },
      { label: "完全加载", value: loadTime, unit: "ms", color: ratingColor(loadTime, 2000, 5000) },
    ];

    let metricsHTML = metrics.map(m => `
      <div style="flex:1;text-align:center;padding:12px 8px;background:rgba(255,255,255,0.03);border-radius:10px;">
        <div style="font-size:24px;font-weight:800;color:${m.color};">${m.value}</div>
        <div style="font-size:10px;color:#888;margin-top:2px;">${m.unit}</div>
        <div style="font-size:11px;color:#aaa;margin-top:4px;">${m.label}</div>
      </div>
    `).join("");

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
        <h3 style="margin:0;font-size:17px;font-weight:700;">📊 页面性能速查</h3>
        <button id="wo-perf-close" style="background:rgba(255,255,255,0.08);border:none;color:#ccc;width:30px;height:30px;border-radius:8px;cursor:pointer;font-size:14px;">✕</button>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:16px;">${metricsHTML}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div style="padding:12px;background:rgba(255,255,255,0.03);border-radius:10px;">
          <div style="font-size:20px;font-weight:700;color:#60a5fa;">${domNodes}</div>
          <div style="font-size:11px;color:#888;margin-top:2px;">DOM 节点</div>
        </div>
        <div style="padding:12px;background:rgba(255,255,255,0.03);border-radius:10px;">
          <div style="font-size:20px;font-weight:700;color:#c084fc;">${resources.length}</div>
          <div style="font-size:11px;color:#888;margin-top:2px;">资源请求</div>
        </div>
        <div style="padding:12px;background:rgba(255,255,255,0.03);border-radius:10px;">
          <div style="font-size:20px;font-weight:700;color:#fb923c;">${sizeMB} MB</div>
          <div style="font-size:11px;color:#888;margin-top:2px;">传输大小</div>
        </div>
        <div style="padding:12px;background:rgba(255,255,255,0.03);border-radius:10px;">
          <div style="font-size:20px;font-weight:700;color:#4ade80;">${imgCount}/${scriptCount}/${styleCount}</div>
          <div style="font-size:11px;color:#888;margin-top:2px;">图/脚本/样式</div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      panel.style.opacity = "1";
      panel.style.transform = "translate(-50%,-50%) scale(1)";
    }));

    panel.querySelector("#wo-perf-close").addEventListener("click", () => {
      panel.style.opacity = "0";
      panel.style.transform = "translate(-50%,-50%) scale(0.9)";
      setTimeout(() => panel.remove(), 300);
    });
  }

  // ========== 页面标注模式 ==========
  let annotateCanvas = null;
  let isAnnotating = false;
  let annotateEscHandler = null;

  function annotationResult(status) {
    const state = {
      active: isAnnotating,
      phase: isAnnotating ? "active" : "inactive",
      scope: "page",
      count: isAnnotating ? 1 : 0,
      reversibleCount: isAnnotating ? 1 : 0,
      updatedAt: Date.now(),
    };
    if (window.webOmniActionState && typeof window.webOmniActionState.set === "function") {
      window.webOmniActionState.set("PAGE_ANNOTATE", state);
    } else {
      chrome.runtime.sendMessage({ type: "WO_ACTION_STATE_CHANGED", action: "PAGE_ANNOTATE", state }).catch(() => {});
    }
    return { ok: true, action: "PAGE_ANNOTATE", status, data: state };
  }

  function handleAnnotation(payload) {
    const mode = payload && payload.mode;
    if (mode === "status") return annotationResult(isAnnotating ? "active" : "inactive");
    if (mode === "disable") return stopAnnotation();
    if (mode === "enable") {
      if (!isAnnotating) activateAnnotation();
    } else if (isAnnotating) return stopAnnotation();
    else activateAnnotation();
    return annotationResult(isAnnotating ? "active" : "inactive");
  }

  function activateAnnotation() {
    if (isAnnotating) return annotationResult("active");
    isAnnotating = true;

    annotateCanvas = document.createElement("canvas");
    annotateCanvas.id = "web-omni-annotate-canvas";
    annotateCanvas.width = window.innerWidth;
    annotateCanvas.height = window.innerHeight;
    annotateCanvas.style.cssText = `
      position:fixed;top:0;left:0;width:100vw;height:100vh;
      z-index:2147483645;cursor:crosshair;
    `;
    document.body.appendChild(annotateCanvas);

    const ctx = annotateCanvas.getContext("2d");
    ctx.strokeStyle = "#ff4757";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    let drawing = false;
    let lastX = 0, lastY = 0;

    // 工具栏
    const toolbar = document.createElement("div");
    toolbar.id = "web-omni-annotate-toolbar";
    toolbar.style.cssText = `
      position:fixed;top:12px;left:50%;transform:translateX(-50%);max-width:calc(100vw - 24px);
      z-index:2147483646;background:rgba(18,18,18,0.92);backdrop-filter:blur(16px);
      border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:8px 10px;
      display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:8px;box-shadow:0 8px 32px rgba(0,0,0,0.3);
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    `;
    const colors = ["#ff4757","#ffa502","#2ed573","#1e90ff","#fff"];
    let colorBtns = colors.map(c => `<button class="wo-ann-color" data-color="${c}" style="width:24px;height:24px;border-radius:50%;border:2px solid ${c==='#fff'?'rgba(255,255,255,0.3)':'transparent'};background:${c};cursor:pointer;transition:transform 0.15s;" title="${c}"></button>`).join("");
    toolbar.innerHTML = `
      <span style="color:#fff;font-size:13px;font-weight:600;">✏️ 标注</span>
      ${colorBtns}
      <input type="range" id="wo-ann-size" min="1" max="10" value="3" style="width:60px;accent-color:#007aff;">
      <button id="wo-ann-clear" style="background:rgba(255,255,255,0.08);border:none;color:#ccc;padding:6px 12px;border-radius:16px;cursor:pointer;font-size:12px;">🗑️ 清除</button>
      <button id="wo-ann-save" style="background:rgba(0,122,255,0.8);border:none;color:#fff;padding:6px 12px;border-radius:16px;cursor:pointer;font-size:12px;">💾 保存</button>
      <button id="wo-ann-exit" style="background:rgba(255,255,255,0.08);border:none;color:#ccc;padding:6px 12px;border-radius:16px;cursor:pointer;font-size:12px;">✕ 退出</button>
    `;
    document.body.appendChild(toolbar);

    // 颜色切换
    toolbar.querySelectorAll(".wo-ann-color").forEach(btn => {
      btn.addEventListener("click", () => {
        ctx.strokeStyle = btn.dataset.color;
        toolbar.querySelectorAll(".wo-ann-color").forEach(b => b.style.transform = "scale(1)");
        btn.style.transform = "scale(1.3)";
      });
    });
    toolbar.querySelector("#wo-ann-size").addEventListener("input", (e) => {
      ctx.lineWidth = parseInt(e.target.value);
    });
    toolbar.querySelector("#wo-ann-clear").addEventListener("click", () => {
      ctx.clearRect(0, 0, annotateCanvas.width, annotateCanvas.height);
    });
    toolbar.querySelector("#wo-ann-save").addEventListener("click", () => {
      annotateCanvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `annotation_${Date.now()}.png`;
        a.click(); URL.revokeObjectURL(url);
        if (window.webOmniShowToast) window.webOmniShowToast("💾 标注已保存为图片", "success");
      });
    });
    toolbar.querySelector("#wo-ann-exit").addEventListener("click", stopAnnotation);

    // 绘制
    annotateCanvas.addEventListener("mousedown", (e) => {
      drawing = true; lastX = e.clientX; lastY = e.clientY;
    });
    annotateCanvas.addEventListener("mousemove", (e) => {
      if (!drawing) return;
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(e.clientX, e.clientY);
      ctx.stroke();
      lastX = e.clientX; lastY = e.clientY;
    });
    annotateCanvas.addEventListener("mouseup", () => drawing = false);
    annotateCanvas.addEventListener("mouseleave", () => drawing = false);

    // Esc 退出
    annotateEscHandler = function onEsc(e) {
      if (e.key === "Escape") stopAnnotation();
    };
    document.addEventListener("keydown", annotateEscHandler);

    if (window.webOmniShowToast) window.webOmniShowToast("✏️ 标注模式已激活，在页面上画画吧！", "info");
    return annotationResult("active");
  }

  function stopAnnotation() {
    const wasActive = isAnnotating;
    isAnnotating = false;
    const canvas = document.getElementById("web-omni-annotate-canvas");
    const toolbar = document.getElementById("web-omni-annotate-toolbar");
    if (canvas) canvas.remove();
    if (toolbar) toolbar.remove();
    if (annotateEscHandler) document.removeEventListener("keydown", annotateEscHandler);
    annotateEscHandler = null;
    annotateCanvas = null;
    if (wasActive && window.webOmniShowToast) window.webOmniShowToast("✏️ 标注模式已退出", "info");
    return annotationResult("inactive");
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

})();
