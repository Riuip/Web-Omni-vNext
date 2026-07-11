(function () {
  "use strict";

  const PASSWORD_SETS = Object.freeze([
    "abcdefghijkmnopqrstuvwxyz",
    "ABCDEFGHJKLMNPQRSTUVWXYZ",
    "23456789",
    "!@#$%^&*_+-=?",
  ]);
  const PASSWORD_CHARACTERS = PASSWORD_SETS.join("");

  const elements = {};
  let sourceTab = null;
  let sourceTabId = null;
  let sourceSupported = false;
  let vaultUnlocked = false;
  let vaultStatusKnown = false;
  let autoSaveEnabled = false;
  let fillBusy = false;
  let autoSaveBusy = false;
  let moreBusy = false;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    collectElements();
    bindEvents();
    generateAndRenderPassword();

    try {
      await loadSourceTab();
    } catch (error) {
      renderUnavailableTab(error);
      return;
    }

    await Promise.allSettled([
      refreshVaultStatus(),
      refreshAutoSaveState(),
    ]);
    syncControls();
  }

  function collectElements() {
    [
      "siteLabel",
      "vaultState",
      "vaultStateText",
      "closeButton",
      "fillButton",
      "autoSaveLabel",
      "autoSaveSwitch",
      "passwordLength",
      "passwordOutput",
      "generateButton",
      "copyButton",
      "notice",
      "moreButton",
    ].forEach((id) => {
      elements[id] = document.getElementById(id);
    });
  }

  function bindEvents() {
    elements.closeButton.addEventListener("click", () => window.close());
    elements.fillButton.addEventListener("click", handleFill);
    elements.autoSaveSwitch.addEventListener("click", handleAutoSaveToggle);
    elements.passwordLength.addEventListener("change", generateAndRenderPassword);
    elements.generateButton.addEventListener("click", generateAndRenderPassword);
    elements.copyButton.addEventListener("click", copyGeneratedPassword);
    elements.moreButton.addEventListener("click", openFullVault);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") window.close();
    });

    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== "WO_ACTIVE_ACTIONS_UPDATED") return;
      if (Number(message.tabId) !== sourceTabId) return;
      applyAutoSaveSnapshot(message.snapshot || message.data || message);
    });

    chrome.tabs.onRemoved.addListener((tabId) => {
      if (tabId !== sourceTabId) return;
      sourceTab = null;
      sourceSupported = false;
      renderUnavailableTab(new Error("来源标签页已关闭。"));
    });
  }

  async function loadSourceTab() {
    const rawTabId = new URL(window.location.href).searchParams.get("tabId");
    const parsedTabId = Number(rawTabId);
    if (!rawTabId || !Number.isInteger(parsedTabId) || parsedTabId < 0) {
      throw new Error("缺少有效的来源标签页。请从 Command Hub 重新打开。" );
    }

    sourceTab = await chrome.tabs.get(parsedTabId);
    if (!sourceTab || !Number.isInteger(sourceTab.id)) {
      throw new Error("来源标签页不可用。请从 Command Hub 重新打开。" );
    }

    sourceTabId = sourceTab.id;
    const parsedUrl = parseUrl(sourceTab.url);
    sourceSupported = Boolean(parsedUrl && ["http:", "https:"].includes(parsedUrl.protocol));
    elements.siteLabel.textContent = parsedUrl && parsedUrl.hostname
      ? parsedUrl.hostname
      : "当前页面";
    elements.siteLabel.title = String(sourceTab.url || "");

    if (!sourceSupported) {
      setNotice("当前页面不支持密码填充或自动保存。", "error");
    }
    syncControls();
  }

  function parseUrl(value) {
    try {
      return new URL(String(value || ""));
    } catch (error) {
      return null;
    }
  }

  function renderUnavailableTab(error) {
    elements.siteLabel.textContent = "来源标签不可用";
    vaultStatusKnown = false;
    vaultUnlocked = false;
    elements.vaultState.dataset.state = "error";
    elements.vaultStateText.textContent = "不可用";
    setNotice(errorMessage(error, "无法读取来源标签页。"), "error");
    syncControls();
  }

  async function refreshVaultStatus(options) {
    const quiet = Boolean(options && options.quiet);
    if (!quiet) {
      elements.vaultState.dataset.state = "loading";
      elements.vaultStateText.textContent = "正在检查";
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: "WO_VAULT_REQUEST",
        command: "GET_STATUS",
      });
      const data = response && response.data && typeof response.data === "object"
        ? response.data
        : {};
      if (!response || response.ok === false) {
        const code = response && response.error && response.error.code;
        if (code === "VAULT_LOCKED") {
          applyVaultStatus(false, data.count);
          return false;
        }
        throw new Error(errorMessage(response && response.error, "无法读取密码库状态。"));
      }

      applyVaultStatus(Boolean(data.unlocked), data.count);
      return vaultUnlocked;
    } catch (error) {
      vaultStatusKnown = false;
      vaultUnlocked = false;
      elements.vaultState.dataset.state = "error";
      elements.vaultStateText.textContent = "状态不可用";
      if (!quiet) setNotice(errorMessage(error, "无法读取密码库状态。"), "error");
      return false;
    } finally {
      syncControls();
    }
  }

  function applyVaultStatus(unlocked, countValue) {
    vaultStatusKnown = true;
    vaultUnlocked = Boolean(unlocked);
    const count = Number(countValue);
    const hasCount = Number.isFinite(count) && count >= 0;
    elements.vaultState.dataset.state = vaultUnlocked ? "unlocked" : "locked";
    elements.vaultStateText.textContent = vaultUnlocked
      ? `已解锁${hasCount ? ` · ${count} 条` : ""}`
      : `已锁定${hasCount ? ` · ${count} 条` : ""}`;
  }

  async function refreshAutoSaveState() {
    if (!Number.isInteger(sourceTabId)) return false;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "WO_ACTIVE_ACTIONS_GET",
        tabId: sourceTabId,
      });
      if (!response || response.ok === false) {
        throw new Error(errorMessage(response && response.error, "无法读取自动保存状态。"));
      }
      applyAutoSaveSnapshot(response.data || response);
      return true;
    } catch (error) {
      autoSaveEnabled = false;
      renderAutoSaveState("状态不可用");
      setNotice(errorMessage(error, "无法读取自动保存状态。"), "error");
      return false;
    } finally {
      syncControls();
    }
  }

  function applyAutoSaveSnapshot(source) {
    const actions = extractActions(source);
    const state = actions.find((item) => item && item.action === "VAULT_AUTO_SAVE");
    autoSaveEnabled = Boolean(state && state.active);
    renderAutoSaveState();
    syncControls();
  }

  function extractActions(source) {
    if (Array.isArray(source)) return source;
    if (!source || typeof source !== "object") return [];
    if (Array.isArray(source.actions)) return source.actions;
    if (Array.isArray(source.activeActions)) return source.activeActions;
    if (source.snapshot) return extractActions(source.snapshot);
    if (source.data) return extractActions(source.data);
    if (source.actions && typeof source.actions === "object") {
      return Object.entries(source.actions).map(([action, state]) => ({
        action,
        ...(state && typeof state === "object" ? state : { active: Boolean(state) }),
      }));
    }
    return [];
  }

  function renderAutoSaveState(overrideText) {
    elements.autoSaveSwitch.setAttribute("aria-checked", String(autoSaveEnabled));
    elements.autoSaveSwitch.setAttribute("aria-label", autoSaveEnabled ? "关闭自动保存" : "开启自动保存");
    elements.autoSaveLabel.textContent = overrideText || (autoSaveEnabled
      ? "已开启，监听当前标签页的登录提交"
      : "已关闭，点击开关后监听当前标签页");
  }

  async function handleFill() {
    if (fillBusy || !sourceSupported || !Number.isInteger(sourceTabId)) return;
    fillBusy = true;
    syncControls();
    setNotice("正在检查密码库状态...", "busy");

    try {
      await refreshVaultStatus({ quiet: true });
      if (!vaultStatusKnown || !vaultUnlocked) {
        throw new Error("密码库已锁定，请点击“更多”打开并解锁。" );
      }

      setNotice("正在填充当前站点...", "busy");
      const response = await chrome.runtime.sendMessage({
        type: "WO_EXECUTE_ACTION",
        action: "VAULT_AUTO_FILL",
        tabId: sourceTabId,
        payload: { source: "vault-quick" },
      });
      if (!response || response.ok === false) {
        const code = response && response.error && response.error.code;
        if (code === "VAULT_LOCKED") applyVaultStatus(false);
        throw new Error(errorMessage(response && response.error, "一键填充失败。"));
      }

      const count = Number(response.data && response.data.count);
      const message = response.status === "selection-required"
        ? "请在当前网页选择要填充的账号。"
        : (Number.isFinite(count) && count > 0 ? "已填充当前站点凭据。" : "填充命令已执行。");
      setNotice(message, "success");
    } catch (error) {
      setNotice(errorMessage(error, "一键填充失败。"), "error");
    } finally {
      fillBusy = false;
      syncControls();
    }
  }

  async function handleAutoSaveToggle() {
    if (autoSaveBusy || !sourceSupported || !Number.isInteger(sourceTabId)) return;
    const nextEnabled = !autoSaveEnabled;
    autoSaveBusy = true;
    syncControls();
    setNotice(nextEnabled ? "正在开启自动保存..." : "正在关闭自动保存...", "busy");

    try {
      const response = await chrome.runtime.sendMessage({
        type: "WO_EXECUTE_ACTION",
        action: "VAULT_AUTO_SAVE",
        tabId: sourceTabId,
        payload: {
          mode: nextEnabled ? "enable" : "disable",
          source: "vault-quick",
        },
      });
      if (!response || response.ok === false) {
        throw new Error(errorMessage(response && response.error, "自动保存状态更新失败。"));
      }

      autoSaveEnabled = nextEnabled;
      renderAutoSaveState();
      await refreshAutoSaveState();
      setNotice(autoSaveEnabled ? "自动保存已开启。" : "自动保存已关闭。", "success");
    } catch (error) {
      setNotice(errorMessage(error, "自动保存状态更新失败。"), "error");
    } finally {
      autoSaveBusy = false;
      syncControls();
    }
  }

  function secureRandomIndex(max) {
    const size = Math.max(1, Number(max) || 1);
    const range = 0x100000000;
    const limit = Math.floor(range / size) * size;
    const buffer = new Uint32Array(1);
    do {
      crypto.getRandomValues(buffer);
    } while (buffer[0] >= limit);
    return buffer[0] % size;
  }

  function createPassword(lengthValue) {
    const length = Math.max(PASSWORD_SETS.length, Number(lengthValue) || 16);
    const characters = PASSWORD_SETS.map((set) => set[secureRandomIndex(set.length)]);
    while (characters.length < length) {
      characters.push(PASSWORD_CHARACTERS[secureRandomIndex(PASSWORD_CHARACTERS.length)]);
    }
    for (let index = characters.length - 1; index > 0; index -= 1) {
      const swapIndex = secureRandomIndex(index + 1);
      [characters[index], characters[swapIndex]] = [characters[swapIndex], characters[index]];
    }
    return characters.join("");
  }

  function generateAndRenderPassword() {
    elements.passwordOutput.textContent = createPassword(elements.passwordLength.value);
    setNotice("已生成新密码。", "success");
  }

  async function copyGeneratedPassword() {
    const password = elements.passwordOutput.textContent;
    if (!password) return;
    elements.copyButton.disabled = true;
    try {
      await navigator.clipboard.writeText(password);
      setNotice("密码已复制。", "success");
    } catch (error) {
      setNotice(errorMessage(error, "复制失败。"), "error");
    } finally {
      elements.copyButton.disabled = false;
    }
  }

  async function openFullVault() {
    if (moreBusy) return;
    moreBusy = true;
    syncControls();
    setNotice("正在打开完整密码库...", "busy");
    try {
      const response = await chrome.runtime.sendMessage({
        type: "WO_OPEN_INTERNAL_PAGE",
        page: "vault/index.html",
      });
      if (!response || response.ok === false) {
        throw new Error(errorMessage(response && response.error, "无法打开完整密码库。"));
      }
      window.close();
    } catch (error) {
      moreBusy = false;
      syncControls();
      setNotice(errorMessage(error, "无法打开完整密码库。"), "error");
    }
  }

  function syncControls() {
    const hasUsableTab = sourceSupported && Number.isInteger(sourceTabId);
    elements.fillButton.disabled = !hasUsableTab || fillBusy;
    elements.fillButton.classList.toggle("is-busy", fillBusy);
    elements.fillButton.setAttribute("aria-busy", String(fillBusy));
    elements.autoSaveSwitch.disabled = !hasUsableTab || autoSaveBusy;
    elements.autoSaveSwitch.setAttribute("aria-busy", String(autoSaveBusy));
    elements.moreButton.disabled = moreBusy;
    elements.moreButton.setAttribute("aria-busy", String(moreBusy));
  }

  function setNotice(message, tone) {
    elements.notice.textContent = String(message || "");
    elements.notice.dataset.tone = tone || "idle";
  }

  function errorMessage(error, fallback) {
    if (error && typeof error.message === "string" && error.message) return error.message;
    if (typeof error === "string" && error) return error;
    return fallback;
  }
})();
