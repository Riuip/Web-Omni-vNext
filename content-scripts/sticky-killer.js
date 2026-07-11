// Web-Omni: 悬浮膏药清理器 (Sticky-UI Killer)
// 一键清除所有 position:fixed / position:sticky 的悬浮元素
(function() {
  if (window.webOmniStickyKillerInjected) return;
  window.webOmniStickyKillerInjected = true;

  let killed = [];
  let isActive = false;

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req && req.type === 'WO_ACTION_STATE_SYNC') return false;
    if (req.action === 'STICKY_KILL') {
      const payload = req.payload || req;
      const mode = payload.mode;
      if (mode === 'enable') killSticky();
      else if (mode === 'disable' || mode === 'restoreAll') restoreAll();
      else if (mode !== 'status') toggleKill();
      sendResponse?.(actionResult(mode === 'restoreAll' ? 'restored' : (isActive ? 'active' : 'inactive')));
      return true;
    }
    if (req.action === 'STICKY_RESTORE') {
      restoreAll();
      sendResponse?.(actionResult('restored'));
      return true;
    }
  });

  function stateData() {
    return {
      active: isActive,
      phase: isActive ? 'recoverable' : 'inactive',
      scope: 'page',
      count: killed.length,
      reversibleCount: killed.length,
      updatedAt: Date.now(),
    };
  }

  function publishState() {
    const state = stateData();
    if (window.webOmniActionState && typeof window.webOmniActionState.set === 'function') {
      window.webOmniActionState.set('STICKY_KILL', state);
    } else {
      chrome.runtime.sendMessage({ type: 'WO_ACTION_STATE_CHANGED', action: 'STICKY_KILL', state }).catch(() => {});
    }
    return state;
  }

  function actionResult(status) {
    return { ok: true, action: 'STICKY_KILL', status, data: publishState() };
  }

  function toggleKill() {
    if (isActive) {
      restoreAll();
    } else {
      killSticky();
    }
  }

  function killSticky() {
    if (isActive) return;
    killed = [];
    const all = document.querySelectorAll('*');
    let count = 0;

    all.forEach(el => {
      // 排除 Web-Omni 自己注入的元素
      if (el.id && el.id.startsWith('web-omni')) return;
      if (el.id && el.id.startsWith('wo-')) return;
      if (el.closest('[id^="web-omni"]')) return;

      const style = getComputedStyle(el);
      const pos = style.position;

      if (pos === 'fixed' || pos === 'sticky') {
        // 排除整个页面的容器元素（body/html）
        if (el === document.body || el === document.documentElement) return;
        // 排除特别大的元素（可能是主内容）
        const rect = el.getBoundingClientRect();
        if (rect.height > window.innerHeight * 0.7 && rect.width > window.innerWidth * 0.7) return;

        killed.push({
          el: el,
          position: captureInlineProperty(el, 'position'),
          display: captureInlineProperty(el, 'display'),
          displayChanged: rect.height < 80 && rect.width < 80,
          computedPos: pos,
        });

        el.style.setProperty('position', 'static', 'important');
        // 对于极小的浮窗（客服按钮、分享按钮等），直接隐藏
        if (rect.height < 80 && rect.width < 80) {
          el.style.setProperty('display', 'none', 'important');
        }
        count++;
      }
    });

    isActive = count > 0;
    publishState();

    if (count > 0) {
      if (!window.webOmniActionState) showBar(count);
      if (window.webOmniShowToast) window.webOmniShowToast('已清理 ' + count + ' 个悬浮元素', 'success');
    } else {
      if (window.webOmniShowToast) window.webOmniShowToast('当前页面没有悬浮元素', 'info');
    }
  }

  function restoreAll() {
    killed.forEach(item => {
      restoreInlineProperty(item.el, 'position', item.position, 'static', 'important');
      if (item.displayChanged) restoreInlineProperty(item.el, 'display', item.display, 'none', 'important');
    });
    killed = [];
    isActive = false;
    hideBar();
    publishState();
    if (window.webOmniShowToast) window.webOmniShowToast('悬浮元素已恢复', 'info');
  }

  function captureInlineProperty(element, name) {
    return {
      value: element.style.getPropertyValue(name),
      priority: element.style.getPropertyPriority(name),
    };
  }

  function restoreInlineProperty(element, name, record, appliedValue, appliedPriority) {
    if (!element || !record) return;
    if (
      element.style.getPropertyValue(name) !== appliedValue ||
      element.style.getPropertyPriority(name) !== appliedPriority
    ) return;
    if (record.value) element.style.setProperty(name, record.value, record.priority || '');
    else element.style.removeProperty(name);
  }

  // 底部状态条
  let bar = null;
  function showBar(count) {
    hideBar();
    bar = document.createElement('div');
    bar.id = 'wo-sticky-bar';
    bar.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483647;background:#161b22;border:1px solid #30363d;border-radius:6px;padding:8px 14px;font-family:-apple-system,sans-serif;font-size:12px;color:#c9d1d9;display:flex;align-items:center;gap:8px;box-shadow:0 4px 16px rgba(0,0,0,0.3);';
    bar.innerHTML = '<span>已清理 ' + count + ' 个悬浮元素</span>'
      + '<button id="wo-sticky-restore" style="background:#21262d;border:1px solid #30363d;color:#58a6ff;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px;font-family:inherit;">恢复</button>';
    document.body.appendChild(bar);
    document.getElementById('wo-sticky-restore').addEventListener('click', restoreAll);
  }
  function hideBar() {
    if (bar && bar.parentElement) bar.remove();
    bar = null;
  }

  // Alt+S 全局快捷键
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key.toLowerCase() === 's' && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      toggleKill();
    }
  });
})();
