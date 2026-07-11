// Web-Omni: 音频动态均衡器 (Audio Normalizer)
// 使用 Web Audio API DynamicsCompressorNode 自动均衡化网页音频
(function() {
  if (window.webOmniAudioNormInjected) return;
  window.webOmniAudioNormInjected = true;

  let ctx = null;
  let compressor = null;
  let gainNode = null;
  let isActive = false;
  const sources = new WeakMap();
  let panelEl = null;
  let lastActivePreset = 'protect';

  function syncAudioNormState() {
    window.webOmniAudioNormState = {
      active: isActive,
      preset: currentPreset
    };
  }

  // 预设
  const PRESETS = {
    protect: { threshold: -50, knee: 40, ratio: 20, attack: 0.003, release: 0.25, gain: 1.3, name: '护耳模式' },
    balance: { threshold: -30, knee: 30, ratio: 12, attack: 0.003, release: 0.25, gain: 1.1, name: '均衡模式' },
    bypass:  { threshold: 0, knee: 0, ratio: 1, attack: 0, release: 0, gain: 1.0, name: '直通模式' }
  };
  let currentPreset = 'protect';
  syncAudioNormState();

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req && req.type === 'WO_ACTION_STATE_SYNC') return false;
    if (req.action === 'AUDIO_NORMALIZE_TOGGLE') {
      sendResponse?.(setNormalize(req.payload || req));
      return true;
    }
    if (req.action === 'AUDIO_NORMALIZE_PANEL') {
      showPanel();
      sendResponse?.({ ok: true, open: Boolean(panelEl) });
      return true;
    }
  });

  function initAudioContext() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    compressor = ctx.createDynamicsCompressor();
    gainNode = ctx.createGain();

    applyPreset(currentPreset);

    compressor.connect(gainNode);
    gainNode.connect(ctx.destination);
  }

  function publishAudioState() {
    const state = {
      active: isActive,
      phase: isActive ? 'active' : 'inactive',
      scope: 'page',
      count: document.querySelectorAll('video, audio').length,
      reversibleCount: isActive ? 1 : 0,
      preset: currentPreset,
      updatedAt: Date.now(),
    };
    if (window.webOmniActionState && typeof window.webOmniActionState.set === 'function') {
      window.webOmniActionState.set('AUDIO_NORMALIZE_TOGGLE', state);
    } else {
      chrome.runtime.sendMessage({ type: 'WO_ACTION_STATE_CHANGED', action: 'AUDIO_NORMALIZE_TOGGLE', state }).catch(() => {});
    }
    return state;
  }

  function applyPreset(name) {
    const p = PRESETS[name];
    if (!p || !compressor) return;
    currentPreset = name;
    if (name !== 'bypass') lastActivePreset = name;
    compressor.threshold.setValueAtTime(p.threshold, ctx.currentTime);
    compressor.knee.setValueAtTime(p.knee, ctx.currentTime);
    compressor.ratio.setValueAtTime(p.ratio, ctx.currentTime);
    compressor.attack.setValueAtTime(p.attack, ctx.currentTime);
    compressor.release.setValueAtTime(p.release, ctx.currentTime);
    gainNode.gain.setValueAtTime(p.gain, ctx.currentTime);
    syncAudioNormState();
  }

  function attachMedia(el) {
    if (sources.has(el) || !ctx) return;
    try {
      const source = ctx.createMediaElementSource(el);
      source.connect(compressor);
      sources.set(el, source);
    } catch(e) {
      // 已经被其他 AudioContext 接管
      console.warn('[WO Audio] Cannot attach to element:', e.message);
    }
  }

  function scanAndAttach(root = document) {
    if (root instanceof HTMLMediaElement) attachMedia(root);
    if (typeof root.querySelectorAll === 'function') {
      root.querySelectorAll('video, audio').forEach(el => attachMedia(el));
    }
  }

  let observer = null;
  function startObserving() {
    scanAndAttach();
    if (observer) return;
    let pending = [];
    let frameId = 0;
    observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) pending.push(node);
        });
      });
      if (frameId || !pending.length) return;
      frameId = requestAnimationFrame(() => {
        const nodes = pending;
        pending = [];
        frameId = 0;
        nodes.forEach(scanAndAttach);
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserving() {
    if (observer) { observer.disconnect(); observer = null; }
  }

  function setNormalize(payload) {
    const mode = payload && payload.mode;
    if (mode !== 'status') {
      if (mode === 'enable') isActive = true;
      else if (mode === 'disable') isActive = false;
      else isActive = !isActive;
    }
    if (isActive) {
      initAudioContext();
      if (ctx.state === 'suspended') ctx.resume();
      applyPreset(lastActivePreset);
      startObserving();
      if (mode !== 'status' && window.webOmniShowToast) window.webOmniShowToast('音频均衡已开启 (' + PRESETS[currentPreset].name + ')', 'success');
    } else {
      stopObserving();
      // 不能轻易断开 source（会导致音频中断），改为设置直通
      if (compressor) {
        const preset = PRESETS.bypass;
        compressor.threshold.setValueAtTime(preset.threshold, ctx.currentTime);
        compressor.knee.setValueAtTime(preset.knee, ctx.currentTime);
        compressor.ratio.setValueAtTime(preset.ratio, ctx.currentTime);
        compressor.attack.setValueAtTime(preset.attack, ctx.currentTime);
        compressor.release.setValueAtTime(preset.release, ctx.currentTime);
        gainNode.gain.setValueAtTime(preset.gain, ctx.currentTime);
      }
      if (mode !== 'status' && window.webOmniShowToast) window.webOmniShowToast('音频均衡已关闭', 'info');
    }
    syncAudioNormState();
    updatePanel();
    return {
      ok: true,
      action: 'AUDIO_NORMALIZE_TOGGLE',
      status: isActive ? 'active' : 'inactive',
      data: publishAudioState(),
    };
  }

  function toggleNormalize() {
    return setNormalize({});
  }

  // ===== 控制面板 =====
  function showPanel() {
    if (panelEl) { panelEl.remove(); panelEl = null; return; }

    panelEl = document.createElement('div');
    panelEl.id = 'wo-audio-panel';
    panelEl.style.cssText = 'position:fixed;bottom:60px;right:12px;z-index:2147483647;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;width:260px;font-family:-apple-system,sans-serif;color:#e6edf3;box-shadow:0 8px 24px rgba(0,0,0,0.4);';

    updatePanel();
    document.body.appendChild(panelEl);
  }

  function updatePanel() {
    if (!panelEl) return;

    const mediaCount = document.querySelectorAll('video, audio').length;
    panelEl.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">'
      + '<span style="font-size:13px;font-weight:600;">音频均衡器</span>'
      + '<button id="wo-audio-close" style="background:none;border:none;color:#8b949e;cursor:pointer;font-size:14px;">X</button></div>'
      + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">'
      + '<span style="font-size:12px;color:#8b949e;">状态</span>'
      + '<button id="wo-audio-toggle" style="padding:4px 12px;border-radius:4px;border:1px solid;font-size:11px;cursor:pointer;font-family:inherit;'
      + (isActive ? 'background:#238636;border-color:#2ea043;color:#fff;' : 'background:#21262d;border-color:#30363d;color:#8b949e;')
      + '">' + (isActive ? '运行中' : '已关闭') + '</button>'
      + '<span style="font-size:11px;color:#484f58;">(' + mediaCount + ' 个媒体)</span></div>'
      + '<div style="font-size:11px;color:#8b949e;margin-bottom:6px;">模式</div>'
      + '<div style="display:flex;gap:4px;margin-bottom:12px;">'
      + Object.entries(PRESETS).map(([k, v]) =>
        '<button class="wo-audio-preset" data-preset="' + k + '" style="flex:1;padding:5px 4px;border-radius:4px;border:1px solid;font-size:11px;cursor:pointer;font-family:inherit;'
        + (currentPreset === k ? 'background:#21262d;border-color:#58a6ff;color:#58a6ff;' : 'background:transparent;border-color:#30363d;color:#8b949e;')
        + '">' + v.name + '</button>'
      ).join('') + '</div>'
      + '<div style="font-size:11px;color:#8b949e;margin-bottom:4px;">增益 <span id="wo-gain-val">' + (gainNode ? gainNode.gain.value.toFixed(1) : '1.0') + 'x</span></div>'
      + '<input id="wo-gain-slider" type="range" min="0.5" max="3.0" step="0.1" value="' + (gainNode ? gainNode.gain.value : 1.0) + '" style="width:100%;accent-color:#58a6ff;">'
      + '<div style="display:flex;justify-content:space-between;font-size:10px;color:#484f58;margin-top:2px;"><span>0.5x</span><span>3.0x</span></div>';

    panelEl.querySelector('#wo-audio-close').onclick = () => { panelEl.remove(); panelEl = null; };
    panelEl.querySelector('#wo-audio-toggle').onclick = toggleNormalize;
    panelEl.querySelectorAll('.wo-audio-preset').forEach(btn => {
      btn.onclick = () => {
        applyPreset(btn.dataset.preset);
        updatePanel();
      };
    });
    const slider = panelEl.querySelector('#wo-gain-slider');
    if (slider) {
      slider.oninput = (e) => {
        if (gainNode) gainNode.gain.setValueAtTime(parseFloat(e.target.value), ctx.currentTime);
        const val = panelEl.querySelector('#wo-gain-val');
        if (val) val.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
      };
    }
  }
})();
