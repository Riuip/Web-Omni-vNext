// 神经末梢：绝对视觉掌控 (Visual Dictator)
// 元素消除狙击枪 + 规则数据库管理面板

(function() {
  if (window.webOmniVisualDictatorInjected) return;
  window.webOmniVisualDictatorInjected = true;

  const ACTION = "ACTIVATE_VISUAL_DICTATOR";
  const RULES_KEY = "dictatorRules";
  const HIDDEN_CLASS = "web-omni-dictator-hidden";
  let isDictatorActive = false;
  let hoveredElement = null;
  let operationStack = [];
  let domainRules = [];
  const appliedRuleIds = new Map();
  let ruleWriteQueue = Promise.resolve();

  // 注入样式
  const highlightStyle = document.createElement("style");
  highlightStyle.textContent = `
    .web-omni-dictator-highlight {
      outline: 3px solid #ff4757 !important;
      outline-offset: -3px !important;
      cursor: crosshair !important;
      box-shadow: 0 0 15px rgba(255, 71, 87, 0.5) inset !important;
      transition: outline 0.1s, box-shadow 0.1s !important;
    }
    .web-omni-dictator-hidden { display: none !important; }
    #web-omni-dictator-bar {
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      z-index: 2147483646; background: rgba(255, 71, 87, 0.9);
      backdrop-filter: blur(16px); color: #fff; padding: 12px 28px;
      border-radius: 50px; font-size: 14px; font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 8px 32px rgba(255, 71, 87, 0.4);
      display: flex; align-items: center; gap: 16px;
    }
    #web-omni-dictator-bar button {
      background: rgba(255,255,255,0.2); border: 1px solid rgba(255,255,255,0.3);
      color: #fff; padding: 6px 14px; border-radius: 20px; cursor: pointer;
      font-size: 13px; font-weight: 500; transition: background 0.2s;
    }
    #web-omni-dictator-bar button:hover { background: rgba(255,255,255,0.35); }

    /* 规则数据库面板 */
    #web-omni-dictator-db {
      position: fixed; top: 0; right: 0; width: 440px; height: 100vh;
      z-index: 2147483646; background: rgba(18, 18, 18, 0.96);
      backdrop-filter: blur(24px); border-left: 1px solid rgba(255,255,255,0.08);
      box-shadow: -10px 0 40px rgba(0,0,0,0.4);
      overflow-y: auto; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #fff; transform: translateX(100%);
      transition: transform 0.35s cubic-bezier(0.2, 0, 0, 1);
    }
    #web-omni-dictator-db.open { transform: translateX(0); }
    .wo-db-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 20px; border-bottom: 1px solid rgba(255,255,255,0.06);
      position: sticky; top: 0; background: rgba(18,18,18,0.98); z-index: 2;
    }
    .wo-db-header h3 { margin: 0; font-size: 17px; font-weight: 700; }
    .wo-db-actions { display: flex; gap: 8px; }
    .wo-db-actions button {
      background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.1);
      color: #ccc; padding: 6px 12px; border-radius: 8px; cursor: pointer;
      font-size: 12px; transition: background 0.2s;
    }
    .wo-db-actions button:hover { background: rgba(255,255,255,0.15); color: #fff; }
    .wo-db-actions button.danger:hover { background: rgba(239,68,68,0.3); color: #ff6b6b; }
    .wo-db-domain-group {
      border-bottom: 1px solid rgba(255,255,255,0.04); padding: 0;
    }
    .wo-db-domain-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 14px 20px; cursor: pointer; transition: background 0.15s;
    }
    .wo-db-domain-header:hover { background: rgba(255,255,255,0.04); }
    .wo-db-domain-name {
      font-size: 14px; font-weight: 600; color: #007aff;
      display: flex; align-items: center; gap: 8px;
    }
    .wo-db-domain-count {
      font-size: 11px; background: rgba(0,122,255,0.2); color: #4da3ff;
      padding: 2px 8px; border-radius: 10px;
    }
    .wo-db-domain-actions button {
      background: none; border: none; color: #888; cursor: pointer;
      font-size: 12px; padding: 4px 8px; border-radius: 4px; transition: all 0.15s;
    }
    .wo-db-domain-actions button:hover { background: rgba(255,255,255,0.08); color: #fff; }
    .wo-db-rule-list { padding: 0 12px 8px; }
    .wo-db-rule-item {
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 12px; margin: 3px 0; border-radius: 8px;
      background: rgba(255,255,255,0.03); transition: background 0.15s;
    }
    .wo-db-rule-item:hover { background: rgba(255,255,255,0.06); }
    .wo-db-rule-info { flex: 1; min-width: 0; }
    .wo-db-rule-tag {
      font-size: 12px; font-weight: 600; color: #f59e0b;
      font-family: "SF Mono", "Fira Code", monospace;
    }
    .wo-db-rule-selector {
      font-size: 11px; color: #666; font-family: "SF Mono", "Fira Code", monospace;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px;
    }
    .wo-db-rule-text {
      font-size: 11px; color: #555; margin-top: 2px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .wo-db-rule-time { font-size: 10px; color: #444; margin-top: 3px; }
    .wo-db-rule-actions { display: flex; gap: 4px; flex-shrink: 0; }
    .wo-db-rule-actions button {
      background: rgba(255,255,255,0.06); border: none; color: #999;
      width: 28px; height: 28px; border-radius: 6px; cursor: pointer;
      font-size: 13px; display: flex; align-items: center; justify-content: center;
      transition: all 0.15s;
    }
    .wo-db-rule-actions button:hover { background: rgba(255,255,255,0.12); color: #fff; }
    .wo-db-rule-actions button.restore:hover { background: rgba(34,197,94,0.2); color: #4ade80; }
    .wo-db-rule-actions button.delete:hover { background: rgba(239,68,68,0.2); color: #f87171; }
    .wo-db-empty {
      text-align: center; color: #555; padding: 60px 20px; font-size: 14px;
    }
    .wo-db-empty-icon { font-size: 40px; margin-bottom: 12px; display: block; }
  `;
  document.head.appendChild(highlightStyle);

  let statusBar = null;

  function createStatusBar() {
    statusBar = document.createElement("div");
    statusBar.id = "web-omni-dictator-bar";
    statusBar.innerHTML = `
      <span>🎯 狙击模式 — 点击消除元素</span>
      <button id="web-omni-dictator-undo">↩ 撤销</button>
      <button id="web-omni-dictator-exit">✕ 退出 (Esc)</button>
    `;
    document.body.appendChild(statusBar);
    statusBar.querySelector("#web-omni-dictator-undo").addEventListener("click", e => {
      e.stopPropagation(); undoRemove();
    });
    statusBar.querySelector("#web-omni-dictator-exit").addEventListener("click", e => {
      e.stopPropagation(); deactivateDictator();
    });
  }
  function removeStatusBar() { if (statusBar) { statusBar.remove(); statusBar = null; } }

  // 监听指令
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.type === "WO_ACTION_STATE_SYNC") return false;
    if (request.action === ACTION) {
      Promise.resolve(handleDictatorAction(request.payload || request))
        .then(sendResponse)
        .catch((error) => sendResponse?.({
          ok: false,
          action: ACTION,
          status: "failed",
          error: { code: "ACTION_FAILED", message: error && error.message ? error.message : String(error) },
        }));
      return true;
    }
    if (request.action === "OPEN_DICTATOR_DB") {
      openDictatorDB();
      sendResponse?.({ ok: true, open: true });
      return true;
    }
  });

  function ruleMatchesCurrentPage(rule) {
    return Boolean(rule && (!rule.url || rule.url === location.pathname));
  }

  function stateData(phase) {
    const reversibleCount = domainRules.filter(ruleMatchesCurrentPage).length;
    return {
      active: isDictatorActive,
      phase: phase || (isDictatorActive ? "selecting" : (reversibleCount ? "recoverable" : "inactive")),
      scope: "page",
      count: reversibleCount,
      reversibleCount,
      updatedAt: Date.now(),
    };
  }

  function publishState(phase) {
    const data = stateData(phase);
    const api = window.webOmniActionState;
    if (api && typeof api.set === "function") api.set(ACTION, data);
    else {
      chrome.runtime.sendMessage({ type: "WO_ACTION_STATE_CHANGED", action: ACTION, state: data }).catch(() => {});
    }
    return data;
  }

  function result(status, phase) {
    return { ok: true, action: ACTION, status, data: publishState(phase) };
  }

  async function handleDictatorAction(payload) {
    const mode = payload && payload.mode;
    if (mode === "status") return result(isDictatorActive ? "active" : "inactive");
    if (mode === "undo") {
      const restored = await undoRemove();
      return {
        ok: true,
        action: ACTION,
        status: restored ? "restored" : "unchanged",
        data: { ...publishState(isDictatorActive ? "selecting" : undefined), restored: restored ? 1 : 0 },
      };
    }
    if (mode === "restoreAll") {
      const restored = await restoreCurrentPage();
      return { ok: true, action: ACTION, status: "restored", data: { ...publishState(), restored } };
    }
    if (mode === "enable") activateDictator();
    else if (mode === "disable") deactivateDictator();
    else toggleDictatorMode();
    return result(isDictatorActive ? "active" : "inactive");
  }

  function toggleDictatorMode() {
    isDictatorActive ? deactivateDictator() : activateDictator();
  }

  function activateDictator() {
    if (isDictatorActive) return;
    isDictatorActive = true;
    document.addEventListener("mouseover", onMouseOver, true);
    document.addEventListener("mouseout", onMouseOut, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    if (!window.webOmniActionState) createStatusBar();
    publishState("selecting");
    if (window.webOmniShowToast) window.webOmniShowToast("🎯 狙击模式激活！点击消除，Ctrl+Z 撤销，Esc 退出", "info");
  }

  function deactivateDictator() {
    if (!isDictatorActive) return;
    isDictatorActive = false;
    document.removeEventListener("mouseover", onMouseOver, true);
    document.removeEventListener("mouseout", onMouseOut, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    if (hoveredElement) { hoveredElement.classList.remove("web-omni-dictator-highlight"); hoveredElement = null; }
    removeStatusBar();
    publishState();
    if (window.webOmniShowToast) window.webOmniShowToast("🎯 狙击模式关闭，已隐藏 " + operationStack.length + " 个元素", "success");
  }

  function onMouseOver(e) {
    if (!isDictatorActive) return;
    if (e.target.closest("#web-omni-dictator-bar, #web-omni-command-hub-overlay, #web-omni-toast-container, #web-omni-dictator-db, #web-omni-action-dock")) return;
    e.stopPropagation();
    if (hoveredElement && hoveredElement !== e.target) hoveredElement.classList.remove("web-omni-dictator-highlight");
    hoveredElement = e.target;
    hoveredElement.classList.add("web-omni-dictator-highlight");
  }

  function onMouseOut(e) {
    if (!isDictatorActive) return;
    e.stopPropagation();
    if (e.target) e.target.classList.remove("web-omni-dictator-highlight");
  }

  function onClick(e) {
    if (!isDictatorActive) return;
    if (e.target.closest("#web-omni-dictator-bar, #web-omni-command-hub-overlay, #web-omni-toast-container, #web-omni-dictator-db, #web-omni-action-dock")) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.target;
    target.classList.remove("web-omni-dictator-highlight");
    const record = createRuleRecord(target);
    operationStack.push({ ruleId: record.ruleId, element: target, url: record.url });
    applyRuleToElement(target, record.ruleId);
    domainRules.push(record);
    ruleWriteQueue = ruleWriteQueue
      .then(() => saveRule(record))
      .catch((error) => console.warn("Web-Omni: 规则保存失败", error));
    publishState("selecting");
  }

  function onKeyDown(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); deactivateDictator(); }
    else if (e.ctrlKey && e.key === "z") { e.preventDefault(); undoRemove(); }
  }

  async function undoRemove() {
    await ruleWriteQueue;
    let ruleId = null;
    for (let index = operationStack.length - 1; index >= 0; index -= 1) {
      const entry = operationStack[index];
      const rule = domainRules.find(item => item && item.ruleId === entry.ruleId);
      if (!ruleMatchesCurrentPage(rule)) continue;
      ruleId = entry.ruleId;
      operationStack.splice(index, 1);
      break;
    }
    if (!ruleId) {
      const storedRule = domainRules.slice().reverse().find(ruleMatchesCurrentPage);
      ruleId = storedRule && storedRule.ruleId;
    }
    if (!ruleId) {
      if (window.webOmniShowToast) window.webOmniShowToast("没有可撤销的操作", "warn");
      return false;
    }
    ruleWriteQueue = ruleWriteQueue.then(() => removeStoredRules(new Set([ruleId])));
    await ruleWriteQueue;
    operationStack = operationStack.filter(item => item.ruleId !== ruleId);
    removeRuleEverywhere(ruleId);
    if (window.webOmniShowToast) window.webOmniShowToast("↩ 已撤销", "info");
    publishState(isDictatorActive ? "selecting" : undefined);
    return true;
  }

  // ========== 详细规则保存 ==========
  function createRuleId() {
    if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return `wo-rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function createRuleRecord(element) {
    let selector = "";
    if (element.id) selector = "#" + CSS.escape(element.id);
    else if (element.className && typeof element.className === "string" && element.className.trim()) {
      const classes = element.className.trim().split(/\s+/).filter(c => !c.startsWith("web-omni"));
      selector = element.tagName.toLowerCase() + classes.map(c => "." + CSS.escape(c)).join("");
    } else selector = element.tagName.toLowerCase();
    return {
      ruleId: createRuleId(),
      selector,
      tag: element.tagName.toLowerCase(),
      text: (element.innerText || "").substring(0, 50).replace(/\n/g, " ").trim(),
      id: element.id || "",
      className: (typeof element.className === "string" ? element.className : "").substring(0, 80),
      time: new Date().toLocaleString(),
      timestamp: Date.now(),
      url: location.pathname,
    };
  }

  async function saveRule(record) {
    const stored = await chrome.storage.local.get([RULES_KEY]);
    const rules = stored[RULES_KEY] && typeof stored[RULES_KEY] === "object" ? stored[RULES_KEY] : {};
    const list = Array.isArray(rules[location.hostname]) ? rules[location.hostname] : [];
    if (!list.some(item => item && item.ruleId === record.ruleId)) list.push(record);
    rules[location.hostname] = list;
    await chrome.storage.local.set({ [RULES_KEY]: rules });
  }

  async function removeStoredRules(ruleIds) {
    if (!ruleIds.size) return 0;
    const stored = await chrome.storage.local.get([RULES_KEY]);
    const rules = stored[RULES_KEY] && typeof stored[RULES_KEY] === "object" ? stored[RULES_KEY] : {};
    const list = Array.isArray(rules[location.hostname]) ? rules[location.hostname] : [];
    const next = list.filter(rule => !rule || !ruleIds.has(rule.ruleId));
    const removed = list.length - next.length;
    if (next.length) rules[location.hostname] = next;
    else delete rules[location.hostname];
    domainRules = next;
    await chrome.storage.local.set({ [RULES_KEY]: rules });
    return removed;
  }

  function applyRuleToElement(element, ruleId) {
    if (!element || !ruleId) return false;
    let ids = appliedRuleIds.get(element);
    if (!ids) {
      ids = new Set();
      appliedRuleIds.set(element, ids);
    }
    ids.add(ruleId);
    element.classList.add(HIDDEN_CLASS);
    return true;
  }

  function removeRuleEverywhere(ruleId) {
    appliedRuleIds.forEach((ids, element) => {
      ids.delete(ruleId);
      if (!ids.size) {
        element.classList.remove(HIDDEN_CLASS);
        appliedRuleIds.delete(element);
      }
    });
  }

  async function restoreCurrentPage() {
    await ruleWriteQueue;
    const ids = new Set(domainRules
      .filter(ruleMatchesCurrentPage)
      .map(rule => rule.ruleId));
    ruleWriteQueue = ruleWriteQueue.then(() => removeStoredRules(ids));
    await ruleWriteQueue;
    ids.forEach(removeRuleEverywhere);
    operationStack = operationStack.filter(item => !ids.has(item.ruleId));
    publishState(isDictatorActive ? "selecting" : "inactive");
    return ids.size;
  }

  // ========== 规则数据库面板 ==========
  function openDictatorDB() {
    let panel = document.getElementById("web-omni-dictator-db");
    if (panel) { panel.classList.toggle("open"); return; }

    panel = document.createElement("div");
    panel.id = "web-omni-dictator-db";
    document.body.appendChild(panel);

    renderDBPanel(panel);
    requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.add("open")));
  }

  function renderDBPanel(panel) {
    chrome.storage.local.get(["dictatorRules"], (result) => {
      const rules = result.dictatorRules || {};
      const domains = Object.keys(rules).filter(d => rules[d].length > 0);
      const totalCount = domains.reduce((s, d) => s + rules[d].length, 0);

      let html = `
        <div class="wo-db-header">
          <h3>🗄️ 消除规则数据库 <span style="font-size:12px;color:#888;font-weight:400;">(${totalCount})</span></h3>
          <div class="wo-db-actions">
            <button id="wo-db-export" title="导出">📤 导出</button>
            <button id="wo-db-clear-all" class="danger" title="清空全部">🗑️ 全部清空</button>
            <button id="wo-db-close" style="font-size:16px;padding:4px 10px;">✕</button>
          </div>
        </div>
      `;

      if (domains.length === 0) {
        html += `<div class="wo-db-empty"><span class="wo-db-empty-icon">📭</span>暂无消除记录<br><span style="font-size:12px;color:#444;margin-top:8px;display:block;">使用狙击枪消除元素后，记录会自动保存在这里</span></div>`;
      } else {
        const currentDomain = location.hostname;
        const sortedDomains = domains.sort((a, b) => a === currentDomain ? -1 : b === currentDomain ? 1 : 0);

        sortedDomains.forEach(domain => {
          const domainRules = rules[domain];
          const isCurrent = domain === currentDomain;
          html += `
            <div class="wo-db-domain-group" data-domain="${domain}">
              <div class="wo-db-domain-header">
                <span class="wo-db-domain-name">
                  ${isCurrent ? '📍' : '🌐'} ${domain}
                  <span class="wo-db-domain-count">${domainRules.length}</span>
                  ${isCurrent ? '<span style="font-size:10px;color:#4ade80;background:rgba(34,197,94,0.15);padding:1px 6px;border-radius:4px;">当前</span>' : ''}
                </span>
                <span class="wo-db-domain-actions">
                  ${isCurrent ? '<button class="wo-db-restore-domain" data-domain="'+domain+'" title="恢复当前页面全部">↩ 全部恢复</button>' : ''}
                  <button class="wo-db-clear-domain" data-domain="${domain}" title="清空该域名规则">🗑️</button>
                </span>
              </div>
              <div class="wo-db-rule-list">`;

          domainRules.slice().reverse().forEach((rule, idx) => {
            const realIdx = domainRules.length - 1 - idx;
            html += `
                <div class="wo-db-rule-item">
                  <div class="wo-db-rule-info">
                    <div class="wo-db-rule-tag">&lt;${rule.tag}&gt;${rule.id ? ' #'+rule.id : ''}</div>
                    <div class="wo-db-rule-selector" title="${rule.selector}">${rule.selector}</div>
                    ${rule.text ? '<div class="wo-db-rule-text">"'+rule.text+'"</div>' : ''}
                    <div class="wo-db-rule-time">🕐 ${rule.time} · ${rule.url || '/'}</div>
                  </div>
                  <div class="wo-db-rule-actions">
                    ${domain === currentDomain ? '<button class="restore" data-domain="'+domain+'" data-idx="'+realIdx+'" title="恢复此元素">↩</button>' : ''}
                    <button class="delete" data-domain="${domain}" data-idx="${realIdx}" title="删除此条规则">✕</button>
                  </div>
                </div>`;
          });

          html += `</div></div>`;
        });
      }

      panel.innerHTML = html;
      bindDBEvents(panel);
    });
  }

  function bindDBEvents(panel) {
    panel.querySelector("#wo-db-close").addEventListener("click", () => {
      panel.classList.remove("open");
    });

    panel.querySelector("#wo-db-export")?.addEventListener("click", () => {
      chrome.storage.local.get(["dictatorRules"], (result) => {
        const json = JSON.stringify(result.dictatorRules || {}, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "web-omni-rules-" + Date.now() + ".json";
        a.click(); URL.revokeObjectURL(url);
        if (window.webOmniShowToast) window.webOmniShowToast("📤 规则已导出为 JSON", "success");
      });
    });

    panel.querySelector("#wo-db-clear-all")?.addEventListener("click", () => {
      if (confirm("确定清空所有域名的消除规则吗？此操作不可撤销！")) {
        chrome.storage.local.set({ dictatorRules: {} }, () => {
          renderDBPanel(panel);
          if (window.webOmniShowToast) window.webOmniShowToast("🗑️ 全部规则已清空", "success");
        });
      }
    });

    panel.querySelectorAll(".wo-db-clear-domain").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const domain = btn.dataset.domain;
        chrome.storage.local.get(["dictatorRules"], (result) => {
          let rules = result.dictatorRules || {};
          delete rules[domain];
          chrome.storage.local.set({ dictatorRules: rules }, () => {
            renderDBPanel(panel);
            if (window.webOmniShowToast) window.webOmniShowToast("已清空 " + domain + " 的规则", "info");
          });
        });
      });
    });

    panel.querySelectorAll(".wo-db-restore-domain").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const restored = await restoreCurrentPage();
        renderDBPanel(panel);
        if (window.webOmniShowToast) {
          window.webOmniShowToast(restored ? `↩ 已恢复当前页面 ${restored} 个元素` : "当前页面没有可恢复元素", restored ? "success" : "info");
        }
      });
    });

    panel.querySelectorAll(".wo-db-rule-actions .restore").forEach(btn => {
      btn.addEventListener("click", async () => {
        const domain = btn.dataset.domain;
        const idx = parseInt(btn.dataset.idx);
        await ruleWriteQueue;
        let result = await chrome.storage.local.get([RULES_KEY]);
        let rules = result[RULES_KEY] || {};
        let rule = rules[domain] && rules[domain][idx];
        if (rule && !rule.ruleId) {
          await loadDomainRules();
          result = await chrome.storage.local.get([RULES_KEY]);
          rules = result[RULES_KEY] || {};
          rule = rules[domain] && rules[domain][idx];
        }
        if (!rule || !rule.ruleId) return;
        const ruleId = rule.ruleId;
        ruleWriteQueue = ruleWriteQueue.then(() => removeStoredRules(new Set([ruleId])));
        await ruleWriteQueue;
        operationStack = operationStack.filter(item => item.ruleId !== ruleId);
        removeRuleEverywhere(ruleId);
        publishState();
        renderDBPanel(panel);
        if (window.webOmniShowToast) window.webOmniShowToast("↩ 元素已恢复", "success");
      });
    });

    panel.querySelectorAll(".wo-db-rule-actions .delete").forEach(btn => {
      btn.addEventListener("click", () => {
        const domain = btn.dataset.domain;
        const idx = parseInt(btn.dataset.idx);
        chrome.storage.local.get(["dictatorRules"], (result) => {
          let rules = result.dictatorRules || {};
          if (rules[domain]) {
            rules[domain].splice(idx, 1);
            if (rules[domain].length === 0) delete rules[domain];
            chrome.storage.local.set({ dictatorRules: rules }, () => {
              renderDBPanel(panel);
              if (window.webOmniShowToast) window.webOmniShowToast("已删除一条规则", "info");
            });
          }
        });
      });
    });
  }

  async function loadDomainRules() {
    const result = await chrome.storage.local.get([RULES_KEY]);
    const rules = result[RULES_KEY] && typeof result[RULES_KEY] === "object" ? result[RULES_KEY] : {};
    const list = Array.isArray(rules[location.hostname]) ? rules[location.hostname] : [];
    let migrated = false;
    domainRules = list.map((rule) => {
      if (!rule || rule.ruleId) return rule;
      migrated = true;
      return { ...rule, ruleId: createRuleId() };
    }).filter(Boolean);
    if (migrated) {
      rules[location.hostname] = domainRules;
      await chrome.storage.local.set({ [RULES_KEY]: rules });
    }
    return domainRules;
  }

  function applyRulesToRoot(root) {
    if (!root || !domainRules.length) return 0;
    let applied = 0;
    domainRules.forEach((rule) => {
      if (!ruleMatchesCurrentPage(rule) || !rule.selector) return;
      try {
        if (root.nodeType === Node.ELEMENT_NODE && root.matches(rule.selector)) {
          if (applyRuleToElement(root, rule.ruleId)) applied += 1;
        }
        if (typeof root.querySelectorAll === "function") {
          root.querySelectorAll(rule.selector).forEach((element) => {
            if (applyRuleToElement(element, rule.ruleId)) applied += 1;
          });
        }
      } catch (error) {}
    });
    return applied;
  }

  setTimeout(() => {
    loadDomainRules().then(() => {
      const applied = applyRulesToRoot(document);
      if (applied > 0) console.log(`【Web-Omni】自动隐藏了 ${applied} 个已标记元素`);
      publishState(domainRules.some(ruleMatchesCurrentPage) ? "recoverable" : "inactive");
    }).catch(() => {});
  }, 300);

  let observedPath = location.pathname;
  let pendingRuleNodes = [];
  let ruleFrame = 0;
  function syncRuleRoute() {
    if (observedPath === location.pathname) return false;
    observedPath = location.pathname;
    const validIds = new Set(domainRules.filter(ruleMatchesCurrentPage).map(rule => rule.ruleId));
    appliedRuleIds.forEach((ids, element) => {
      Array.from(ids).forEach((id) => {
        if (!validIds.has(id)) ids.delete(id);
      });
      if (!ids.size) {
        element.classList.remove(HIDDEN_CLASS);
        appliedRuleIds.delete(element);
      }
    });
    applyRulesToRoot(document);
    publishState();
    return true;
  }

  const observer = new MutationObserver((mutations) => {
    syncRuleRoute();
    if (!domainRules.length) return;
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) pendingRuleNodes.push(node);
      });
    });
    if (ruleFrame || !pendingRuleNodes.length) return;
    ruleFrame = requestAnimationFrame(() => {
      const nodes = pendingRuleNodes;
      pendingRuleNodes = [];
      ruleFrame = 0;
      nodes.forEach(applyRulesToRoot);
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  const scheduleRuleRouteSync = () => setTimeout(syncRuleRoute, 0);
  window.addEventListener("popstate", scheduleRuleRouteSync);
  window.addEventListener("hashchange", scheduleRuleRouteSync);
  if (globalThis.navigation && typeof globalThis.navigation.addEventListener === "function") {
    globalThis.navigation.addEventListener("navigate", scheduleRuleRouteSync);
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[RULES_KEY]) return;
    const rules = changes[RULES_KEY].newValue || {};
    domainRules = Array.isArray(rules[location.hostname]) ? rules[location.hostname] : [];
    const validIds = new Set(domainRules.filter(ruleMatchesCurrentPage).map(rule => rule.ruleId).filter(Boolean));
    const storedIds = new Set(domainRules.map(rule => rule && rule.ruleId).filter(Boolean));
    appliedRuleIds.forEach((ids, element) => {
      Array.from(ids).forEach((id) => {
        if (!validIds.has(id)) ids.delete(id);
      });
      if (!ids.size) {
        element.classList.remove(HIDDEN_CLASS);
        appliedRuleIds.delete(element);
      }
    });
    operationStack = operationStack.filter(item => storedIds.has(item.ruleId));
    applyRulesToRoot(document);
    publishState();
  });

})();
