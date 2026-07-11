// Web-Omni: Input Time Machine
(function() {
  "use strict";

  if (window.webOmniInputTMInjected) return;
  window.webOmniInputTMInjected = true;

  const SAVE_DELAY = 1200;
  const FLUSH_DELAY = 350;
  const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
  const MAX_PAGE_BYTES = 512 * 1024;
  const LEGACY_STORAGE_KEY = "woInputTM";
  const ENABLED_KEY = "woInputTMEnabled";
  const INDEX_KEY = "woInputTMIndex";
  const PAGE_KEY_PREFIX = "woInputTMPage:";

  let enabled = false;
  let observer = null;
  let pageEntries = null;
  let pageLoadPromise = null;
  let flushTimer = null;
  const timers = new WeakMap();
  const restoreBtns = new WeakMap();

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.type === "WO_ACTION_STATE_SYNC") return false;
    if (!request || typeof request.action !== "string") return;

    if (request.action === "INPUT_TM_TOGGLE") {
      setTM(request.payload || request)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
      return true;
    }

    if (request.action === "INPUT_TM_SHOW_HISTORY") {
      showHistory()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
      return true;
    }
  });

  chrome.storage.local.get([ENABLED_KEY]).then((result) => {
    if (!result[ENABLED_KEY]) return;
    enabled = true;
    startMonitoring().then(() => publishState()).catch(() => {});
  }).catch(() => {});

  function publishState() {
    const state = {
      active: enabled,
      phase: enabled ? "active" : "inactive",
      scope: "global",
      count: enabled ? 1 : 0,
      reversibleCount: enabled ? 1 : 0,
      updatedAt: Date.now(),
    };
    if (window.webOmniActionState && typeof window.webOmniActionState.set === "function") {
      window.webOmniActionState.set("INPUT_TM_TOGGLE", state);
    } else {
      chrome.runtime.sendMessage({ type: "WO_ACTION_STATE_CHANGED", action: "INPUT_TM_TOGGLE", state }).catch(() => {});
    }
    return state;
  }

  async function setTM(payload) {
    const mode = payload && payload.mode;
    if (mode === "enable") enabled = true;
    else if (mode === "disable") enabled = false;
    else if (mode !== "status") enabled = !enabled;
    await chrome.storage.local.set({ [ENABLED_KEY]: enabled });
    if (enabled) {
      await startMonitoring();
      if (mode !== "status") showToast("输入框保护已开启", "success");
    } else {
      stopMonitoring();
      if (mode !== "status") showToast("输入框保护已关闭", "info");
    }
    return {
      ok: true,
      action: "INPUT_TM_TOGGLE",
      status: enabled ? "active" : "inactive",
      data: publishState(),
    };
  }

  function getElementKey(element) {
    if (element.id) return "id:" + element.id;
    if (element.name) return "name:" + element.name;

    const parts = [];
    let node = element;
    while (node && node !== document.body) {
      const tag = node.tagName.toLowerCase();
      const index = Array.from(node.parentElement ? node.parentElement.children : []).indexOf(node);
      parts.unshift(tag + ":" + index);
      node = node.parentElement;
    }
    return "path:" + parts.join(">");
  }

  function getPageKey() {
    return location.origin + location.pathname;
  }

  function hashPageKey(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function getPageStorageKey(pageKey = getPageKey()) {
    return PAGE_KEY_PREFIX + hashPageKey(pageKey);
  }

  async function loadCurrentPage() {
    if (pageEntries) return pageEntries;
    if (pageLoadPromise) return pageLoadPromise;

    pageLoadPromise = (async () => {
      const pageKey = getPageKey();
      const storageKey = getPageStorageKey(pageKey);
      const stored = await chrome.storage.local.get([storageKey, LEGACY_STORAGE_KEY, INDEX_KEY]);
      const index = stored[INDEX_KEY] && typeof stored[INDEX_KEY] === "object" ? stored[INDEX_KEY] : {};
      let entries = stored[storageKey] && typeof stored[storageKey] === "object" ? stored[storageKey] : null;

      const legacy = stored[LEGACY_STORAGE_KEY] && typeof stored[LEGACY_STORAGE_KEY] === "object"
        ? stored[LEGACY_STORAGE_KEY]
        : null;
      if (!entries && legacy && legacy[pageKey]) {
        entries = legacy[pageKey];
        delete legacy[pageKey];
        index[storageKey] = { pageKey, updatedAt: newestEntryTime(entries) || Date.now() };
        const updates = { [storageKey]: entries, [INDEX_KEY]: index };
        if (Object.keys(legacy).length) updates[LEGACY_STORAGE_KEY] = legacy;
        await chrome.storage.local.set(updates);
        if (!Object.keys(legacy).length) await chrome.storage.local.remove([LEGACY_STORAGE_KEY]);
      }

      pageEntries = pruneEntries(entries || {});
      return pageEntries;
    })().finally(() => {
      pageLoadPromise = null;
    });

    return pageLoadPromise;
  }

  function pruneEntries(entries) {
    const now = Date.now();
    const next = {};
    Object.entries(entries || {}).forEach(([key, entry]) => {
      if (!entry || typeof entry.text !== "string" || !Number.isFinite(Number(entry.time))) return;
      if (now - Number(entry.time) > MAX_AGE) return;
      next[key] = { text: entry.text, time: Number(entry.time) };
    });

    let json = JSON.stringify(next);
    if (json.length <= MAX_PAGE_BYTES) return next;

    const ordered = Object.entries(next).sort((left, right) => left[1].time - right[1].time);
    while (ordered.length && json.length > MAX_PAGE_BYTES * 0.8) {
      delete next[ordered.shift()[0]];
      json = JSON.stringify(next);
    }
    return next;
  }

  function newestEntryTime(entries) {
    const times = Object.values(entries || {}).map((entry) => Number(entry && entry.time) || 0);
    return times.length ? Math.max(...times) : 0;
  }

  async function saveEntry(elementKey, text) {
    const normalized = String(text || "");
    if (normalized.trim().length < 5) return;

    const entries = await loadCurrentPage();
    entries[elementKey] = { text: normalized, time: Date.now() };
    pageEntries = pruneEntries(entries);
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushCurrentPage().catch(() => {});
    }, FLUSH_DELAY);
  }

  async function flushCurrentPage() {
    if (!pageEntries) return;
    const pageKey = getPageKey();
    const storageKey = getPageStorageKey(pageKey);
    const stored = await chrome.storage.local.get([INDEX_KEY]);
    const index = stored[INDEX_KEY] && typeof stored[INDEX_KEY] === "object" ? stored[INDEX_KEY] : {};
    index[storageKey] = { pageKey, updatedAt: newestEntryTime(pageEntries) || Date.now() };
    await chrome.storage.local.set({ [storageKey]: pageEntries, [INDEX_KEY]: index });
    await cleanupExpiredPages(index);
  }

  async function cleanupExpiredPages(index) {
    const cutoff = Date.now() - MAX_AGE;
    const expired = Object.entries(index)
      .filter(([, meta]) => !meta || Number(meta.updatedAt) < cutoff)
      .map(([key]) => key);
    if (!expired.length) return;
    expired.forEach((key) => delete index[key]);
    await chrome.storage.local.remove(expired);
    await chrome.storage.local.set({ [INDEX_KEY]: index });
  }

  async function startMonitoring() {
    if (!document.body) {
      await new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
    }
    await loadCurrentPage();
    scanNode(document.body);

    if (!observer) {
      let pendingNodes = [];
      let frameId = 0;
      observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) pendingNodes.push(node);
          });
        });
        if (frameId || !pendingNodes.length) return;
        frameId = requestAnimationFrame(() => {
          const nodes = pendingNodes;
          pendingNodes = [];
          frameId = 0;
          nodes.forEach(scanNode);
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    checkRestore();
  }

  function stopMonitoring() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    document.querySelectorAll(".wo-tm-restore").forEach((button) => button.remove());
  }

  function scanNode(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    if (matchesInput(root)) attachTo(root);
    root.querySelectorAll("textarea,[contenteditable='true'],[contenteditable=''],input[type='text'],input:not([type])")
      .forEach((element) => {
        if (matchesInput(element)) attachTo(element);
      });
  }

  function matchesInput(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (element.matches("textarea,[contenteditable='true'],[contenteditable='']")) return true;
    if (!element.matches("input[type='text'],input:not([type])")) return false;
    return element.maxLength > 100 || element.maxLength < 0;
  }

  function attachTo(element) {
    if (element.dataset.woInputTmAttached === "true") return;
    element.dataset.woInputTmAttached = "true";
    element.addEventListener("input", () => {
      if (!enabled) return;
      const existing = timers.get(element);
      if (existing) clearTimeout(existing);
      timers.set(element, setTimeout(() => {
        const text = element.isContentEditable ? element.innerText : element.value;
        saveEntry(getElementKey(element), text).catch(() => {});
      }, SAVE_DELAY));
    }, { passive: true });
  }

  async function checkRestore() {
    const entries = await loadCurrentPage();
    setTimeout(() => {
      Object.entries(entries).forEach(([elementKey, entry]) => {
        const element = findElement(elementKey);
        if (!element) return;
        const currentText = element.isContentEditable ? element.innerText : element.value;
        if (entry.text.length > 10 && currentText.length < entry.text.length * 0.5) {
          showRestoreButton(element, entry);
        }
      });
    }, 800);
  }

  function findElement(key) {
    if (key.startsWith("id:")) return document.getElementById(key.slice(3));
    if (key.startsWith("name:")) return document.querySelector("[name='" + CSS.escape(key.slice(5)) + "']");
    if (!key.startsWith("path:")) return null;

    let node = document.body;
    for (const part of key.slice(5).split(">")) {
      const separator = part.lastIndexOf(":");
      const tag = part.slice(0, separator);
      const index = Number(part.slice(separator + 1));
      if (!node || !node.children[index] || node.children[index].tagName.toLowerCase() !== tag) return null;
      node = node.children[index];
    }
    return node;
  }

  function showRestoreButton(element, entry) {
    if (restoreBtns.has(element)) return;
    const button = document.createElement("button");
    button.className = "wo-tm-restore";
    button.textContent = "恢复上一版本 (" + new Date(entry.time).toLocaleTimeString() + ")";
    button.style.cssText = "position:absolute;z-index:2147483647;background:#238636;color:#fff;border:1px solid #2ea043;padding:3px 10px;border-radius:4px;font-size:11px;cursor:pointer;font-family:-apple-system,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.3);white-space:nowrap;";
    const rect = element.getBoundingClientRect();
    button.style.top = window.scrollY + rect.top - 4 + "px";
    button.style.left = Math.max(4, window.scrollX + rect.right - 180) + "px";

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (element.isContentEditable) {
        element.innerText = entry.text;
      } else {
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter) setter.call(element, entry.text);
        else element.value = entry.text;
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      button.remove();
      restoreBtns.delete(element);
      showToast("内容已恢复 (" + entry.text.length + " 字符)", "success");
    });

    document.body.appendChild(button);
    restoreBtns.set(element, button);
    setTimeout(() => {
      if (!button.isConnected) return;
      button.style.opacity = "0.5";
      setTimeout(() => {
        button.remove();
        restoreBtns.delete(element);
      }, 5000);
    }, 10000);
  }

  async function loadAllPages() {
    const storedIndex = await chrome.storage.local.get([INDEX_KEY, LEGACY_STORAGE_KEY]);
    const index = storedIndex[INDEX_KEY] && typeof storedIndex[INDEX_KEY] === "object" ? storedIndex[INDEX_KEY] : {};
    const keys = Object.keys(index);
    const values = keys.length ? await chrome.storage.local.get(keys) : {};
    const pages = {};

    keys.forEach((key) => {
      const meta = index[key];
      if (!meta || !meta.pageKey || !values[key]) return;
      pages[meta.pageKey] = pruneEntries(values[key]);
    });

    const legacy = storedIndex[LEGACY_STORAGE_KEY];
    if (legacy && typeof legacy === "object") {
      Object.entries(legacy).forEach(([pageKey, entries]) => {
        if (!pages[pageKey]) pages[pageKey] = pruneEntries(entries);
      });
    }
    return { pages, storageKeys: keys };
  }

  async function showHistory() {
    const { pages, storageKeys } = await loadAllPages();
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(1,4,9,0.6);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;font-family:-apple-system,sans-serif;";

    const panel = document.createElement("div");
    panel.style.cssText = "background:#161b22;border:1px solid #30363d;border-radius:8px;padding:20px;width:min(500px,100%);max-height:70vh;overflow-y:auto;color:#e6edf3;";
    const header = document.createElement("div");
    header.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;";
    const title = document.createElement("h3");
    title.textContent = "输入框时光机 · 历史";
    title.style.cssText = "font-size:15px;font-weight:600;margin:0;";
    const state = document.createElement("span");
    state.textContent = enabled ? "已开启" : "已关闭";
    state.style.cssText = "font-size:11px;color:#8b949e;";
    header.append(title, state);
    panel.appendChild(header);

    const pageKeys = Object.keys(pages).filter((pageKey) => Object.keys(pages[pageKey]).length);
    if (!pageKeys.length) {
      const empty = document.createElement("p");
      empty.textContent = "暂无保存的记录";
      empty.style.cssText = "color:#8b949e;font-size:13px;text-align:center;padding:20px;";
      panel.appendChild(empty);
    } else {
      pageKeys.forEach((pageKey) => {
        const section = document.createElement("section");
        section.style.marginBottom = "12px";
        const domain = document.createElement("div");
        domain.textContent = pageKey.replace(/^https?:\/\//, "").split("/")[0];
        domain.style.cssText = "font-size:12px;color:#58a6ff;margin-bottom:4px;";
        section.appendChild(domain);
        Object.values(pages[pageKey]).forEach((entry) => {
          const card = document.createElement("div");
          card.style.cssText = "background:#0d1117;border:1px solid #21262d;border-radius:4px;padding:8px 10px;margin-bottom:4px;font-size:12px;";
          const meta = document.createElement("div");
          meta.textContent = new Date(entry.time).toLocaleString() + " · " + entry.text.length + " 字符";
          meta.style.cssText = "color:#8b949e;margin-bottom:2px;";
          const preview = document.createElement("div");
          preview.textContent = entry.text.slice(0, 80) + (entry.text.length > 80 ? "..." : "");
          preview.style.color = "#c9d1d9";
          card.append(meta, preview);
          section.appendChild(card);
        });
        panel.appendChild(section);
      });

      const clearButton = createPanelButton("清空所有历史", "#f85149");
      clearButton.addEventListener("click", async () => {
        await chrome.storage.local.remove([...storageKeys, LEGACY_STORAGE_KEY, INDEX_KEY]);
        pageEntries = {};
        overlay.remove();
        showToast("历史已清空", "info");
      });
      panel.appendChild(clearButton);
    }

    const closeButton = createPanelButton("关闭", "#c9d1d9");
    closeButton.addEventListener("click", () => overlay.remove());
    panel.appendChild(closeButton);
    overlay.appendChild(panel);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
  }

  function createPanelButton(label, color) {
    const button = document.createElement("button");
    button.textContent = label;
    button.style.cssText = "width:100%;padding:8px;background:#21262d;border:1px solid #30363d;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit;margin-top:6px;";
    button.style.color = color;
    return button;
  }

  function showToast(message, type) {
    if (window.webOmniShowToast) window.webOmniShowToast(message, type);
  }

  function readableError(error) {
    return error && error.message ? error.message : String(error || "unknown-error");
  }
})();
