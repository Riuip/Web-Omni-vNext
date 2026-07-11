// 神经末梢：沉浸式阅读与魔改 (Immersive Modding)
// 强行暗黑模式、极简阅读器、解除封印反反复制

(function() {
  if (window.webOmniImmersiveModdingInjected) return;
  window.webOmniImmersiveModdingInjected = true;

  let isDarkMode = false;
  let isReaderMode = false;
  const readerRecords = new Map();

  const actionHandlers = {
    TOGGLE_DARK_MODE: (request) => setDarkMode(request.payload || request),
    TOGGLE_READER_MODE: (request) => setReaderMode(request.payload || request),
    BREAK_SEALS: (request) => breakSeals(request.payload || request),
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

  function runMainWorldAction(action, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "WO_RUN_MAIN_WORLD", action, payload: payload || {} }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          resolve({ ok: false, action, status: "failed", error: { code: "MODULE_LOAD_FAILED", message: runtimeError.message } });
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

  function requestedEnabled(payload, current) {
    if (payload && payload.mode === "enable") return true;
    if (payload && payload.mode === "disable") return false;
    if (payload && payload.mode === "status") return current;
    return !current;
  }

  function publishState(action, active, extra) {
    const state = {
      active,
      phase: active ? "active" : "inactive",
      scope: "page",
      count: active ? 1 : 0,
      reversibleCount: active ? 1 : 0,
      updatedAt: Date.now(),
      ...(extra || {}),
    };
    if (window.webOmniActionState && typeof window.webOmniActionState.set === "function") {
      window.webOmniActionState.set(action, state);
    } else {
      chrome.runtime.sendMessage({ type: "WO_ACTION_STATE_CHANGED", action, state }).catch(() => {});
    }
    return state;
  }

  function setDarkMode(payload) {
    const next = requestedEnabled(payload, isDarkMode);
    isDarkMode = next;
    document.documentElement.classList.toggle("web-omni-force-dark", isDarkMode);
    if ((!payload || payload.mode !== "status") && window.webOmniShowToast) {
      window.webOmniShowToast(isDarkMode ? "🌙 暗黑模式已开启" : "☀️ 暗黑模式已关闭", "success");
    }
    return {
      ok: true,
      action: "TOGGLE_DARK_MODE",
      status: isDarkMode ? "active" : "inactive",
      data: publishState("TOGGLE_DARK_MODE", isDarkMode),
    };
  }

  function setReaderMode(payload) {
    const next = requestedEnabled(payload, isReaderMode);
    if (next === isReaderMode && payload && payload.mode === "status") {
      return {
        ok: true,
        action: "TOGGLE_READER_MODE",
        status: isReaderMode ? "active" : "inactive",
        data: publishState("TOGGLE_READER_MODE", isReaderMode, { count: readerRecords.size }),
      };
    }
    isReaderMode = next;
    if (isReaderMode) {
      // 隐藏非正文元素
      document.querySelectorAll("nav, aside, footer, header, .sidebar, .ad, .ads, .advertisement, [role='banner'], [role='navigation'], [role='complementary']").forEach(el => {
        if (!el.closest("article, main, [role='main']")) {
          if (!readerRecords.has(el)) {
            readerRecords.set(el, {
              value: el.style.getPropertyValue("display"),
              priority: el.style.getPropertyPriority("display"),
            });
          }
          el.dataset.webOmniHidden = "true";
          el.style.setProperty("display", "none", "important");
        }
      });
      document.body.classList.add("web-omni-reader-mode");
      if (window.webOmniShowToast) window.webOmniShowToast("📖 阅读器模式已开启", "success");
    } else {
      readerRecords.forEach((record, el) => {
        if (
          el.style.getPropertyValue("display") === "none" &&
          el.style.getPropertyPriority("display") === "important"
        ) {
          if (record.value) el.style.setProperty("display", record.value, record.priority || "");
          else el.style.removeProperty("display");
        }
        delete el.dataset.webOmniHidden;
      });
      readerRecords.clear();
      document.body.classList.remove("web-omni-reader-mode");
      if (window.webOmniShowToast) window.webOmniShowToast("📖 阅读器模式已关闭", "info");
    }
    return {
      ok: true,
      action: "TOGGLE_READER_MODE",
      status: isReaderMode ? "active" : "inactive",
      data: publishState("TOGGLE_READER_MODE", isReaderMode, { count: readerRecords.size }),
    };
  }

  async function breakSeals(payload) {
    const result = await runMainWorldAction("BREAK_SEALS", payload);
    if (window.webOmniShowToast) {
      if (result.ok) {
        window.webOmniShowToast(result.data.enabled ? "页面复制、选择与右键限制已解除" : "页面限制处理已恢复", result.data.enabled ? "success" : "info");
      } else {
        window.webOmniShowToast(`${result.error && result.error.code ? result.error.code : "ACTION_FAILED"}: ${result.error && result.error.message ? result.error.message : "操作失败"}`, "error");
      }
    }
    if (result.ok && result.data) {
      publishState("BREAK_SEALS", Boolean(result.data.enabled), {
        limitations: result.limitations || [],
      });
    }
    return result;
  }
})();
