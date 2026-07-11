// Web-Omni: Password Vault page integration
(function() {
  "use strict";

  if (window.webOmniPasswordVaultInjected) return;
  window.webOmniPasswordVaultInjected = true;
  let autoSaveEnabled = false;
  let autoSaveObserver = null;
  let autoSaveScanFrame = 0;
  let pendingAutoSaveRoots = [];
  const autoSaveHandlers = new Map();

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.type === "WO_ACTION_STATE_SYNC") return false;
    if (!request || typeof request.action !== "string") return;

    if (request.action === "VAULT_AUTO_FILL") {
      vaultAutoFill(request.payload || request)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse(failure(error)));
      return true;
    }

    if (request.action === "VAULT_AUTO_SAVE") {
      sendResponse(setAutoSave(request.payload || request));
      return true;
    }

    if (request.action === "OPEN_VAULT" || request.action === "PASSWORD_GENERATOR") {
      chrome.runtime.sendMessage({
        type: "WO_OPEN_INTERNAL_PAGE",
        page: request.action === "PASSWORD_GENERATOR" ? "vault/index.html#generator" : "vault/index.html",
      }).then((result) => sendResponse(result)).catch((error) => sendResponse(failure(error)));
      return true;
    }
  });

  async function vaultAutoFill(payload) {
    const passwordFields = visibleElements("input[type='password']");
    if (!passwordFields.length) {
      showToast("当前页面没有可填写的密码框", "warn");
      return {
        ok: false,
        status: "unsupported",
        error: { code: "UNSUPPORTED_CONTEXT", message: "当前页面没有可填写的密码框。" },
      };
    }

    const result = await chrome.runtime.sendMessage({
      type: "WO_VAULT_REQUEST",
      command: "FIND_CREDENTIALS",
      payload: { hostname: location.hostname },
    });
    if (!result || !result.ok) {
      showVaultLockedPrompt(
        result && result.error && result.error.message,
        { openVault: !(payload && payload.source === "vault-quick") }
      );
      return result || failure("密码库尚未解锁。", "VAULT_LOCKED");
    }

    const credentials = result.data && Array.isArray(result.data.entries) ? result.data.entries : [];
    if (!credentials.length) {
      showToast("密码库中没有当前站点的凭据", "warn");
      return {
        ok: false,
        status: "empty",
        error: { code: "UNSUPPORTED_CONTEXT", message: "密码库中没有当前站点的凭据。" },
      };
    }

    if (credentials.length === 1) {
      fillCredential(credentials[0]);
      return { ok: true, status: "filled", data: { count: 1 } };
    }

    showCredentialChooser(credentials);
    return { ok: true, status: "selection-required", data: { count: credentials.length } };
  }

  function fillCredential(credential) {
    const passwordField = visibleElements("input[type='password']")[0];
    const usernameField = findUsernameField(passwordField);
    if (usernameField && credential.username) setNativeValue(usernameField, credential.username);
    if (passwordField) setNativeValue(passwordField, credential.password || "");
    showToast("已填充当前站点凭据", "success");
  }

  function showCredentialChooser(credentials) {
    document.getElementById("wo-vault-credential-chooser")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "wo-vault-credential-chooser";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(1,4,9,.58);display:flex;align-items:center;justify-content:center;padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;";
    const panel = document.createElement("div");
    panel.style.cssText = "width:min(380px,100%);max-height:70vh;overflow:auto;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;color:#e6edf3;box-shadow:0 16px 48px rgba(0,0,0,.45);";
    const title = document.createElement("h3");
    title.textContent = "选择要填充的账号";
    title.style.cssText = "margin:0 0 12px;font-size:15px;";
    panel.appendChild(title);
    credentials.forEach((credential) => {
      const button = document.createElement("button");
      button.type = "button";
      button.style.cssText = "display:block;width:100%;text-align:left;padding:10px;margin:0 0 6px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;cursor:pointer;";
      const name = document.createElement("strong");
      name.textContent = credential.username || "无用户名";
      const site = document.createElement("small");
      site.textContent = credential.site || location.hostname;
      site.style.cssText = "display:block;color:#8b949e;margin-top:3px;";
      button.append(name, site);
      button.addEventListener("click", () => {
        fillCredential(credential);
        overlay.remove();
      });
      panel.appendChild(button);
    });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.style.cssText = "width:100%;padding:8px;margin-top:6px;background:#21262d;border:1px solid #30363d;border-radius:6px;color:#8b949e;cursor:pointer;";
    cancel.addEventListener("click", () => overlay.remove());
    panel.appendChild(cancel);
    overlay.appendChild(panel);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
  }

  function autoSaveState(status) {
    const state = {
      active: autoSaveEnabled,
      phase: autoSaveEnabled ? "active" : "inactive",
      scope: "tab",
      count: autoSaveHandlers.size,
      reversibleCount: autoSaveEnabled ? 1 : 0,
      updatedAt: Date.now(),
    };
    if (window.webOmniActionState && typeof window.webOmniActionState.set === "function") {
      window.webOmniActionState.set("VAULT_AUTO_SAVE", state);
    } else {
      chrome.runtime.sendMessage({ type: "WO_ACTION_STATE_CHANGED", action: "VAULT_AUTO_SAVE", state }).catch(() => {});
    }
    return { ok: true, action: "VAULT_AUTO_SAVE", status, data: state };
  }

  function setAutoSave(payload) {
    const mode = payload && payload.mode;
    if (mode === "status") return autoSaveState(autoSaveEnabled ? "active" : "inactive");
    const enable = mode === "enable" || (mode !== "disable" && !autoSaveEnabled);
    if (!enable) {
      disableAutoSave();
      showToast("登录保存检测已关闭", "info");
      return autoSaveState("inactive");
    }
    autoSaveEnabled = true;
    const attached = enableAutoSave(document);
    if (!autoSaveObserver && document.documentElement) {
      autoSaveObserver = new MutationObserver((records) => {
        records.forEach((record) => record.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) pendingAutoSaveRoots.push(node);
        }));
        if (autoSaveScanFrame) return;
        autoSaveScanFrame = requestAnimationFrame(() => {
          autoSaveScanFrame = 0;
          const previousCount = autoSaveHandlers.size;
          pruneAutoSaveHandlers();
          const roots = pendingAutoSaveRoots;
          pendingAutoSaveRoots = [];
          roots.forEach(enableAutoSave);
          if (autoSaveHandlers.size !== previousCount) autoSaveState("active");
        });
      });
      autoSaveObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    showToast(attached ? "登录保存检测已开启" : "登录保存检测已开启，等待登录表单", attached ? "success" : "info");
    return autoSaveState("active");
  }

  function enableAutoSave(root) {
    let attached = 0;
    const forms = [];
    if (root instanceof HTMLFormElement) forms.push(root);
    if (root && typeof root.querySelectorAll === "function") forms.push(...root.querySelectorAll("form"));
    forms.forEach((form) => {
      if (autoSaveHandlers.has(form)) return;
      form.dataset.woVaultSaveAttached = "true";
      attached += 1;
      const handler = () => {
        if (!autoSaveEnabled) return;
        const passwordField = form.querySelector("input[type='password']");
        if (!passwordField || !passwordField.value) return;
        const usernameField = findUsernameField(passwordField, form);
        showSavePrompt({
          site: location.hostname,
          username: usernameField ? usernameField.value : "",
          password: passwordField.value,
        });
      };
      autoSaveHandlers.set(form, handler);
      form.addEventListener("submit", handler, true);
    });
    return attached;
  }

  function disableAutoSave() {
    autoSaveEnabled = false;
    if (autoSaveObserver) autoSaveObserver.disconnect();
    autoSaveObserver = null;
    if (autoSaveScanFrame) cancelAnimationFrame(autoSaveScanFrame);
    autoSaveScanFrame = 0;
    pendingAutoSaveRoots = [];
    autoSaveHandlers.forEach((handler, form) => {
      form.removeEventListener("submit", handler, true);
      delete form.dataset.woVaultSaveAttached;
    });
    autoSaveHandlers.clear();
    document.getElementById("wo-vault-save-prompt")?.remove();
  }

  function pruneAutoSaveHandlers() {
    autoSaveHandlers.forEach((handler, form) => {
      if (form.isConnected) return;
      form.removeEventListener("submit", handler, true);
      delete form.dataset.woVaultSaveAttached;
      autoSaveHandlers.delete(form);
    });
  }

  function showSavePrompt(credential) {
    document.getElementById("wo-vault-save-prompt")?.remove();
    const bar = document.createElement("div");
    bar.id = "wo-vault-save-prompt";
    bar.style.cssText = "position:fixed;top:12px;right:12px;z-index:2147483647;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px 16px;font-family:-apple-system,sans-serif;color:#c9d1d9;width:min(320px,calc(100vw - 24px));box-shadow:0 8px 32px rgba(0,0,0,.4);";
    const title = document.createElement("strong");
    title.textContent = "保存本次登录凭据？";
    const detail = document.createElement("div");
    detail.textContent = location.hostname + " · " + (credential.username || "未知账号");
    detail.style.cssText = "font-size:12px;color:#8b949e;margin:6px 0 10px;overflow-wrap:anywhere;";
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:6px;";
    const save = document.createElement("button");
    save.textContent = "保存";
    save.style.cssText = "flex:1;padding:7px;background:#238636;border:1px solid #2ea043;color:#fff;border-radius:6px;cursor:pointer;";
    const cancel = document.createElement("button");
    cancel.textContent = "忽略";
    cancel.style.cssText = "padding:7px 12px;background:#21262d;border:1px solid #30363d;color:#8b949e;border-radius:6px;cursor:pointer;";
    save.addEventListener("click", async () => {
      save.disabled = true;
      const result = await chrome.runtime.sendMessage({
        type: "WO_VAULT_REQUEST",
        command: "SAVE_CREDENTIAL",
        payload: credential,
      }).catch((error) => failure(error));
      if (result && result.ok) {
        showToast("凭据已加密保存", "success");
        bar.remove();
      } else {
        save.disabled = false;
        showVaultLockedPrompt(result && result.error && result.error.message);
      }
    });
    cancel.addEventListener("click", () => bar.remove());
    actions.append(save, cancel);
    bar.append(title, detail, actions);
    document.body.appendChild(bar);
    setTimeout(() => bar.remove(), 15000);
  }

  function showVaultLockedPrompt(message, options) {
    showToast(message || "请打开并解锁密码库", "warn");
    if (!options || options.openVault !== false) {
      chrome.runtime.sendMessage({ type: "WO_OPEN_INTERNAL_PAGE", page: "vault/index.html" }).catch(() => {});
    }
  }

  function visibleElements(selector) {
    return Array.from(document.querySelectorAll(selector)).filter((element) => {
      if (element.disabled || element.readOnly) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1 && getComputedStyle(element).visibility !== "hidden";
    });
  }

  function findUsernameField(passwordField, scope) {
    const root = scope || passwordField?.form || document;
    const candidates = Array.from(root.querySelectorAll("input[type='email'],input[autocomplete='username'],input[type='text'],input:not([type])"));
    return candidates.find((input) => {
      const hint = [input.name, input.id, input.autocomplete, input.placeholder].join(" ").toLowerCase();
      return /user|email|login|account|用户|邮箱|账号/.test(hint);
    }) || candidates[0] || null;
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : Object.getPrototypeOf(element);
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function showToast(message, type) {
    if (window.webOmniShowToast) window.webOmniShowToast(message, type);
  }

  function failure(error, code = "ACTION_FAILED") {
    const message = error && error.message ? error.message : String(error || "操作失败");
    return { ok: false, status: "failed", error: { code, message } };
  }
})();
