// Web-Omni: DOM 微监控 (Micro DOM Monitor)
// 框选网页元素，后台定期监听变化，支持阈值通知
(function() {
  if (window.webOmniDomMonitorInjected) return;
  window.webOmniDomMonitorInjected = true;

  const STORAGE_KEY = 'woDomMonitors';
  const STALE_AFTER_MS = 120000;
  let pickMode = false, hoverTarget = null, hlBox = null;

  const actionHandlers = {
    DOM_MONITOR_ADD: (request) => handleMonitorAction(request.payload || request),
    DOM_MONITOR_PANEL: () => showDashboard(),
    DOM_MONITOR_CHECK: () => checkCurrentPage(),
  };

  async function publishMonitorState() {
    const monitors = await loadMonitors();
    const state = {
      active: pickMode || monitors.length > 0,
      phase: pickMode ? 'selecting' : (monitors.length ? 'monitoring' : 'inactive'),
      scope: 'durable',
      count: monitors.length,
      reversibleCount: 0,
      updatedAt: Date.now(),
    };
    if (window.webOmniActionState && typeof window.webOmniActionState.set === 'function') {
      window.webOmniActionState.set('DOM_MONITOR_ADD', state);
    } else {
      chrome.runtime.sendMessage({ type: 'WO_ACTION_STATE_CHANGED', action: 'DOM_MONITOR_ADD', state }).catch(() => {});
    }
    return state;
  }

  async function handleMonitorAction(payload) {
    const mode = payload && payload.mode;
    if (mode === 'disable') cancelPick();
    else if (mode === 'enable') { if (!pickMode) startPick(); }
    else if (mode !== 'status') { if (pickMode) cancelPick(); else startPick(); }
    const state = await publishMonitorState();
    return { ok: true, action: 'DOM_MONITOR_ADD', status: state.active ? 'active' : 'inactive', data: state };
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.type === 'WO_ACTION_STATE_SYNC') return false;
    const handler = request && actionHandlers[request.action];
    if (!handler) return false;
    Promise.resolve()
      .then(() => handler(request))
      .then((result) => sendResponse(result && typeof result.ok === 'boolean' ? result : {
        ok: true,
        action: request.action,
        status: 'completed',
        data: {},
      }))
      .catch((error) => sendResponse({
        ok: false,
        action: request.action,
        status: 'failed',
        error: { code: 'ACTION_FAILED', message: error && error.message ? error.message : String(error) },
      }));
    return true;
  });

  function startPick() {
    if (pickMode) { cancelPick(); return; }
    pickMode = true;
    hlBox = document.createElement('div');
    hlBox.id = 'wo-dm-hl';
    hlBox.style.cssText = 'position:fixed;z-index:2147483647;border:2px solid #f97316;background:rgba(249,115,22,0.08);pointer-events:none;transition:all 0.1s;display:none;border-radius:4px;';
    document.body.appendChild(hlBox);
    var bar = document.createElement('div');
    bar.id = 'wo-dm-bar';
    bar.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#161b22;border:1px solid #30363d;border-radius:6px;padding:8px 16px;font-family:-apple-system,sans-serif;font-size:12px;color:#c9d1d9;box-shadow:0 4px 16px rgba(0,0,0,0.3);';
    bar.textContent = '点击要监控的元素 (数字/价格/状态) · ESC 取消';
    document.body.appendChild(bar);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    publishMonitorState().catch(() => {});
  }

  function cancelPick() {
    pickMode = false; hoverTarget = null;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    var h = document.getElementById('wo-dm-hl'); if(h) h.remove();
    var b = document.getElementById('wo-dm-bar'); if(b) b.remove();
    hlBox = null;
    publishMonitorState().catch(() => {});
  }

  function onMove(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === hlBox || el.closest('[id^="wo-"], [id^="web-omni"]')) {
      hoverTarget = null;
      if (hlBox) hlBox.style.display = 'none';
      return;
    }
    hoverTarget = el;
    var r = el.getBoundingClientRect();
    hlBox.style.display = 'block';
    hlBox.style.left = r.left+'px'; hlBox.style.top = r.top+'px';
    hlBox.style.width = r.width+'px'; hlBox.style.height = r.height+'px';
  }

  function onClick(e) {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (!hoverTarget) return;
    var el = hoverTarget;
    cancelPick();
    addMonitor(el);
  }

  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); cancelPick(); } }

  function getCssSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    while (el && el !== document.body) {
      var tag = el.tagName.toLowerCase();
      var idx = Array.from(el.parentElement ? el.parentElement.children : []).indexOf(el);
      parts.unshift(tag + ':nth-child(' + (idx+1) + ')');
      el = el.parentElement;
    }
    return 'body > ' + parts.join(' > ');
  }

  async function addMonitor(el) {
    var selector = getCssSelector(el);
    var text = (el.innerText || el.textContent || '').trim().substring(0, 200);
    var label = prompt('给这个监控项起个名字:', text.substring(0, 30) || '监控项');
    if (!label) return;

    var all = await loadMonitors();
    all.push({
      id: Date.now().toString(36),
      url: location.href,
      domain: location.hostname,
      selector: selector,
      label: label,
      currentValue: text,
      history: [{ value: text, time: Date.now() }],
      threshold: null,
      created: Date.now(),
      lastCheckedAt: Date.now(),
      status: 'active'
    });
    await saveMonitors(all);
    await publishMonitorState();
    // 通知后台开始轮询
    chrome.runtime.sendMessage({ type: 'DOM_MONITOR_START' });
    if (window.webOmniShowToast) window.webOmniShowToast('监控项已添加: ' + label, 'success');
  }

  async function loadMonitors() {
    var d = await chrome.storage.local.get([STORAGE_KEY]);
    return d[STORAGE_KEY] || [];
  }
  async function saveMonitors(arr) {
    await chrome.storage.local.set({ [STORAGE_KEY]: arr });
  }

  // 当前页面：检查并更新监控值
  async function checkCurrentPage() {
    var all = await loadMonitors();
    var changed = false;
    var changedCount = 0;
    var missingCount = 0;
    var matchedIds = [];
    var now = Date.now();
    all.forEach(function(m) {
      if (m.url !== location.href && m.domain !== location.hostname) return;
      matchedIds.push(m.id);
      var el = null;
      try { el = document.querySelector(m.selector); }
      catch (error) { m.status = 'invalid-selector'; }
      m.lastCheckedAt = now;
      m.lastCheckedUrl = location.href;
      changed = true;
      if (!el) {
        if (m.status !== 'invalid-selector') m.status = 'missing';
        missingCount++;
        changed = true;
        return;
      }
      m.status = 'active';
      var val = (el.innerText || el.textContent || '').trim().substring(0, 200);
      if (val !== m.currentValue) {
        m.currentValue = val;
        m.history.push({ value: val, time: Date.now() });
        if (m.history.length > 100) m.history = m.history.slice(-100);
        changed = true;
        changedCount++;
      }
    });
    if (changed) await saveMonitors(all);
    return {
      ok: true,
      action: 'DOM_MONITOR_CHECK',
      status: 'completed',
      data: {
        url: location.href,
        matched: matchedIds.length,
        monitorIds: matchedIds,
        changed: changedCount,
        missing: missingCount,
        checkedAt: now,
      },
    };
  }

  // Keep an open matching tab fresh so closed tabs can be shown as paused.
  setInterval(checkCurrentPage, 60000);
  setTimeout(checkCurrentPage, 3000);

  // 仪表盘
  async function showDashboard() {
    var all = await loadMonitors();
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(1,4,9,0.6);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:-apple-system,sans-serif;';
    var html = '<div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:20px;width:520px;max-height:70vh;overflow-y:auto;color:#e6edf3;">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">'
      + '<h3 style="font-size:15px;font-weight:600;">DOM 监控仪表盘</h3>'
      + '<span style="font-size:11px;color:#8b949e;">' + all.length + ' 个监控项</span></div>';

    if (all.length === 0) {
      html += '<p style="text-align:center;color:#8b949e;padding:20px;font-size:13px;">暂无监控项<br><span style="font-size:11px;">使用 Command Hub 的「添加监控」来创建</span></p>';
    } else {
      all.forEach(function(m, i) {
        var prev = m.history.length > 1 ? m.history[m.history.length - 2].value : m.currentValue;
        var changed = prev !== m.currentValue;
        var paused = !m.lastCheckedAt || Date.now() - m.lastCheckedAt > STALE_AFTER_MS;
        var missing = !paused && m.status === 'missing';
        var invalid = !paused && m.status === 'invalid-selector';
        var statusText = paused ? '已暂停' : invalid ? '选择器无效' : missing ? '元素缺失' : '监控中';
        var statusColor = paused ? '#8b949e' : (missing || invalid) ? '#d29922' : '#3fb950';
        var color = paused ? '#8b949e' : changed ? '#f97316' : '#3fb950';
        html += '<div style="background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:10px 12px;margin-bottom:6px;">'
          + '<div style="display:flex;justify-content:space-between;align-items:center;">'
          + '<span style="font-size:13px;font-weight:500;">' + escapeHtml(m.label) + '</span>'
          + '<span style="font-size:10px;color:' + statusColor + ';margin-left:auto;margin-right:8px;">' + statusText + '</span>'
          + '<button class="wo-dm-del" data-idx="'+i+'" style="background:none;border:none;color:#f85149;cursor:pointer;font-size:11px;">删除</button></div>'
          + '<div style="font-size:11px;color:#8b949e;margin:2px 0;">' + escapeHtml(m.domain) + '</div>'
          + '<div style="font-size:16px;font-weight:600;color:'+color+';margin:4px 0;">' + escapeHtml((m.currentValue||'(空)').substring(0,60)) + '</div>'
          + '<div style="font-size:10px;color:#484f58;">更新 ' + m.history.length + ' 次 · 创建于 ' + new Date(m.created).toLocaleDateString() + '</div></div>';
      });
    }
    html += '<button id="wo-dm-close" style="width:100%;padding:8px;background:#21262d;border:1px solid #30363d;color:#c9d1d9;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit;margin-top:8px;">关闭</button></div>';
    ov.innerHTML = html;
    document.body.appendChild(ov);
    ov.addEventListener('click', function(e) { if (e.target === ov) ov.remove(); });
    ov.querySelector('#wo-dm-close').onclick = function() { ov.remove(); };
    ov.querySelectorAll('.wo-dm-del').forEach(function(b) {
      b.onclick = async function() {
        var idx = parseInt(b.dataset.idx);
        all.splice(idx, 1);
        await saveMonitors(all);
        await publishMonitorState();
        ov.remove();
        showDashboard();
      };
    });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();
