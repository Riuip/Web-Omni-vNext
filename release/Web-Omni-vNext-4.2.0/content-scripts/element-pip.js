// Web-Omni: 万物皆可画中画 (Element-level PiP)
(function() {
  if (window.webOmniElementPipInjected) return;
  window.webOmniElementPipInjected = true;

  let pickMode = false, hoverTarget = null, highlightBox = null;
  let pipWindow = null;
  let syncTimer = null;

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req && req.type === 'WO_ACTION_STATE_SYNC') return false;
    if (req.action === 'ELEMENT_PIP') {
      const payload = req.payload || req;
      const mode = payload.mode;
      if (mode === 'disable') closeElementPip();
      else if (mode === 'enable') { if (!pickMode && !isPipOpen()) startPicking(); }
      else if (mode !== 'status') {
        if (pickMode || isPipOpen()) closeElementPip();
        else startPicking();
      }
      sendResponse?.(pipResult());
      return true;
    }
  });

  function isPipOpen() {
    try { return Boolean(pipWindow && !pipWindow.closed); } catch (_) { return Boolean(pipWindow); }
  }

  function pipResult() {
    const active = pickMode || isPipOpen();
    const state = {
      active,
      phase: pickMode ? 'selecting' : (active ? 'active' : 'inactive'),
      scope: 'page',
      count: active ? 1 : 0,
      reversibleCount: active ? 1 : 0,
      updatedAt: Date.now(),
    };
    if (window.webOmniActionState && typeof window.webOmniActionState.set === 'function') {
      window.webOmniActionState.set('ELEMENT_PIP', state);
    } else {
      chrome.runtime.sendMessage({ type: 'WO_ACTION_STATE_CHANGED', action: 'ELEMENT_PIP', state }).catch(() => {});
    }
    return { ok: true, action: 'ELEMENT_PIP', status: active ? 'active' : 'inactive', data: state };
  }

  function startPicking() {
    if (pickMode) { cancelPicking(); return; }
    pickMode = true;
    highlightBox = document.createElement('div');
    highlightBox.id = 'wo-pip-highlight';
    highlightBox.style.cssText = 'position:fixed;z-index:2147483647;border:2px solid #58a6ff;background:rgba(88,166,255,0.08);pointer-events:none;transition:all 0.1s;display:none;border-radius:4px;';
    document.body.appendChild(highlightBox);
    const bar = document.createElement('div');
    bar.id = 'wo-pip-bar';
    bar.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#161b22;border:1px solid #30363d;border-radius:6px;padding:8px 16px;font-family:-apple-system,sans-serif;font-size:12px;color:#c9d1d9;box-shadow:0 4px 16px rgba(0,0,0,0.3);';
    bar.innerHTML = '点击选择要提取的元素 · <span style="color:#8b949e;">ESC 取消</span>';
    document.body.appendChild(bar);
    document.addEventListener('mousemove', onPickMove, true);
    document.addEventListener('click', onPickClick, true);
    document.addEventListener('keydown', onPickKey, true);
    pipResult();
  }

  function cancelPicking() {
    pickMode = false; hoverTarget = null;
    document.removeEventListener('mousemove', onPickMove, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('keydown', onPickKey, true);
    var h = document.getElementById('wo-pip-highlight'); if (h) h.remove();
    var b = document.getElementById('wo-pip-bar'); if (b) b.remove();
    highlightBox = null;
    pipResult();
  }

  function closeElementPip() {
    if (pickMode) cancelPicking();
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = null;
    if (pipWindow) {
      try { pipWindow.close(); } catch (_) {}
    }
    pipWindow = null;
    pipResult();
  }

  function onPickMove(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === highlightBox || el.id === 'wo-pip-bar') return;
    if (el.closest('[id^="wo-"]') || el.closest('[id^="web-omni"]')) return;
    hoverTarget = el;
    var r = el.getBoundingClientRect();
    highlightBox.style.display = 'block';
    highlightBox.style.left = r.left + 'px';
    highlightBox.style.top = r.top + 'px';
    highlightBox.style.width = r.width + 'px';
    highlightBox.style.height = r.height + 'px';
  }

  function onPickClick(e) {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (!hoverTarget) return;
    var el = hoverTarget; cancelPicking(); extractToPip(el);
  }

  function onPickKey(e) { if (e.key === 'Escape') { e.preventDefault(); cancelPicking(); } }

  async function extractToPip(el) {
    var rect = el.getBoundingClientRect();
    var w = Math.max(300, Math.min(rect.width + 32, 800));
    var h = Math.max(200, Math.min(rect.height + 32, 600));

    // Document PiP API (Chrome 116+)
    if ('documentPictureInPicture' in window) {
      try {
        var pip = await documentPictureInPicture.requestWindow({ width: Math.round(w), height: Math.round(h) });
        pipWindow = pip;
        var bs = pip.document.createElement('style');
        bs.textContent = 'body{margin:0;padding:16px;background:#0d1117;color:#e6edf3;overflow:auto;font-family:-apple-system,sans-serif;}*{max-width:100%!important;}';
        pip.document.head.appendChild(bs);
        document.querySelectorAll('style,link[rel="stylesheet"]').forEach(function(s) { pip.document.head.appendChild(s.cloneNode(true)); });
        pip.document.body.appendChild(el.cloneNode(true));
        syncTimer = setInterval(function() { try { if (pip.document) { pip.document.body.innerHTML=''; pip.document.body.appendChild(el.cloneNode(true)); } else closeElementPip(); } catch(e) { closeElementPip(); } }, 3000);
        pip.addEventListener('pagehide', closeElementPip, { once: true });
        pipResult();
        if (window.webOmniShowToast) window.webOmniShowToast('元素已提取为画中画', 'success');
        return;
      } catch(e) { /* fallback */ }
    }

    // 降级: window.open
    var pw = window.open('', '_blank', 'width='+Math.round(w)+',height='+Math.round(h)+',top=100,left='+(screen.width-Math.round(w)-50)+',menubar=no,toolbar=no,location=no');
    if (!pw) { if (window.webOmniShowToast) window.webOmniShowToast('弹窗被拦截，请允许弹窗', 'error'); pipResult(); return; }
    pipWindow = pw;
    pw.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>PiP</title><style>body{margin:0;padding:16px;background:#0d1117;color:#e6edf3;overflow:auto;font-family:-apple-system,sans-serif;}*{max-width:100%!important;}</style></head><body></body></html>');
    pw.document.close();
    pw.document.body.appendChild(el.cloneNode(true));
    syncTimer = setInterval(function() { try { if (!pw.closed) { pw.document.body.innerHTML=''; pw.document.body.appendChild(el.cloneNode(true)); } else closeElementPip(); } catch(e) { closeElementPip(); } }, 3000);
    pipResult();
    if (window.webOmniShowToast) window.webOmniShowToast('元素已提取为悬浮窗', 'success');
  }
})();
