(function() {
  "use strict";

  if (window.webOmniPageTranslatorInjected) return;
  window.webOmniPageTranslatorInjected = true;

  const SKIP_SELECTOR = [
    "script",
    "style",
    "noscript",
    "textarea",
    "input",
    "select",
    "option",
    "button",
    "code",
    "pre",
    "kbd",
    "samp",
    "svg",
    "math",
    "canvas",
    "iframe",
    "object",
    "embed",
    "template",
    "[translate='no']",
    ".notranslate",
    "[data-wo-translate-ignore='true']",
    "[contenteditable='true']",
  ].join(",");

  const state = {
    active: false,
    sourceLang: "",
    targetLang: "",
    items: new Map(),
    nextId: 1,
    lastRunAt: 0,
  };

  syncWindowState();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === "WO_ACTION_STATE_SYNC") return false;
    if (!message || typeof message.action !== "string") return;

    try {
      switch (message.action) {
        case "WO_PAGE_TRANSLATE_COLLECT":
          sendResponse({
            ok: true,
            ...collectSegments(Boolean(message.onlyUntranslated)),
          });
          return true;
        case "WO_PAGE_TRANSLATE_APPLY":
          sendResponse(applyTranslations(message.translations, message.meta || {}));
          return true;
        case "WO_PAGE_TRANSLATE_RESTORE":
          sendResponse(restoreTranslations());
          return true;
        case "WO_PAGE_TRANSLATE_STATE":
          sendResponse(buildPublicState());
          return true;
        default:
          return;
      }
    } catch (error) {
      console.warn("[WO PageTranslator] Action failed:", message.action, error);
      sendResponse({
        ok: false,
        error: error && error.message ? error.message : "unknown-error",
      });
      return true;
    }
  });

  function buildPublicState() {
    pruneDisconnectedItems();
    return {
      ok: true,
      active: state.active,
      sourceLang: state.sourceLang,
      targetLang: state.targetLang,
      translatedCount: state.items.size,
      lastRunAt: state.lastRunAt,
    };
  }

  function syncWindowState() {
    window.webOmniPageTranslatorState = {
      active: state.active,
      sourceLang: state.sourceLang,
      targetLang: state.targetLang,
      translatedCount: state.items.size,
      lastRunAt: state.lastRunAt,
    };

    if (document.documentElement) {
      if (state.active) {
        document.documentElement.setAttribute("data-wo-page-translated", "true");
      } else {
        document.documentElement.removeAttribute("data-wo-page-translated");
      }
    }

    const actionState = {
      active: state.active,
      phase: state.active ? "recoverable" : "inactive",
      scope: "page",
      count: state.items.size,
      reversibleCount: state.active ? state.items.size : 0,
      sourceLang: state.sourceLang,
      targetLang: state.targetLang,
      updatedAt: Date.now(),
    };
    if (window.webOmniActionState && typeof window.webOmniActionState.set === "function") {
      window.webOmniActionState.set("WO_PAGE_TRANSLATE_RESTORE", actionState);
    } else if (typeof chrome !== "undefined" && chrome.runtime) {
      chrome.runtime.sendMessage({
        type: "WO_ACTION_STATE_CHANGED",
        action: "WO_PAGE_TRANSLATE_RESTORE",
        state: actionState,
      }).catch(() => {});
    }
  }

  function collectSegments(onlyUntranslated) {
    pruneDisconnectedItems();

    const segments = [];
    const root = document.body || document.documentElement;
    if (!root) {
      return { segments, total: 0 };
    }

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          return isEligibleTextNode(node)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      }
    );

    let currentNode = walker.nextNode();
    while (currentNode) {
      const existingId = currentNode.__woTranslateId;
      const existingRecord = existingId ? state.items.get(existingId) : null;
      const hasAppliedTranslation = Boolean(existingRecord && existingRecord.translatedText);

      if (!onlyUntranslated || !hasAppliedTranslation) {
        if (existingRecord && !hasAppliedTranslation) {
          existingRecord.originalText = currentNode.nodeValue;
          existingRecord.normalizedText = normalizeSegment(currentNode.nodeValue);
          segments.push({ id: existingId, text: existingRecord.normalizedText });
          currentNode = walker.nextNode();
          continue;
        }

        const id = state.nextId++;
        const normalizedText = normalizeSegment(currentNode.nodeValue);
        currentNode.__woTranslateId = id;

        state.items.set(id, {
          node: currentNode,
          originalText: currentNode.nodeValue,
          normalizedText,
          translatedText: "",
        });

        segments.push({ id, text: normalizedText });
      }

      currentNode = walker.nextNode();
    }

    syncWindowState();
    return {
      segments,
      total: segments.length,
    };
  }

  function applyTranslations(translations, meta) {
    pruneDisconnectedItems();

    let applied = 0;
    const list = Array.isArray(translations) ? translations : [];
    for (const entry of list) {
      const record = state.items.get(entry && entry.id);
      if (!record || !record.node || !record.node.isConnected) continue;

      const translated = normalizeSegment(entry.text);
      if (!translated) continue;

      record.translatedText = translated;
      record.node.nodeValue = preserveOuterWhitespace(record.originalText, translated);
      applied += 1;
    }

    if (applied > 0) {
      state.active = true;
      state.sourceLang = String(meta.sourceLang || state.sourceLang || "");
      state.targetLang = String(meta.targetLang || state.targetLang || "");
      state.lastRunAt = Date.now();
    } else if (state.items.size === 0) {
      state.active = false;
    }

    syncWindowState();
    return {
      ok: true,
      applied,
      translatedCount: state.items.size,
      active: state.active,
      sourceLang: state.sourceLang,
      targetLang: state.targetLang,
    };
  }

  function restoreTranslations() {
    pruneDisconnectedItems();

    let restored = 0;
    for (const [id, record] of state.items.entries()) {
      if (record.node && record.node.isConnected) {
        record.node.nodeValue = record.originalText;
        restored += 1;
      }

      if (record.node) {
        try {
          delete record.node.__woTranslateId;
        } catch (error) {}
      }

      state.items.delete(id);
    }

    state.active = false;
    state.sourceLang = "";
    state.targetLang = "";
    state.lastRunAt = Date.now();
    syncWindowState();

    return {
      ok: true,
      restored,
      active: false,
      translatedCount: 0,
    };
  }

  function pruneDisconnectedItems() {
    for (const [id, record] of state.items.entries()) {
      if (!record.node || !record.node.isConnected) {
        state.items.delete(id);
      }
    }

    if (state.items.size === 0 && state.active) {
      state.active = false;
      state.sourceLang = "";
      state.targetLang = "";
    }

    syncWindowState();
  }

  function isEligibleTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return false;
    if (!node.parentElement) return false;

    const parent = node.parentElement;
    if (shouldSkipElement(parent)) return false;

    const text = normalizeSegment(node.nodeValue);
    if (!text) return false;
    if (!hasMeaningfulText(text)) return false;
    if (text.length === 1 && !/[\u3400-\u9fff]/.test(text)) return false;

    return true;
  }

  function shouldSkipElement(element) {
    if (!element || !(element instanceof Element)) return true;
    if (element.closest(SKIP_SELECTOR)) return true;
    if (element.closest("[hidden], [aria-hidden='true']")) return true;
    if (element.isContentEditable) return true;

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return true;
    }

    return false;
  }

  function normalizeSegment(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function hasMeaningfulText(value) {
    return /[A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff\u0900-\u097f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(value);
  }

  function preserveOuterWhitespace(originalText, translatedText) {
    const source = String(originalText || "");
    const leading = (source.match(/^\s*/) || [""])[0];
    const trailing = (source.match(/\s*$/) || [""])[0];
    return leading + translatedText + trailing;
  }
})();
