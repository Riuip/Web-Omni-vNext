// 神经末梢：YouTube 增强引擎 (YouTube Enhancer)
// 跳过广告、倍速、截图、循环、影院模式、信息提取

(function() {
  if (window.webOmniYouTubeEnhancerInjected) return;
  window.webOmniYouTubeEnhancerInjected = true;

  // ========== 1. YouTube 兼容跳过 ==========
  const AD_SKIP_SETTINGS_KEY = 'woYouTubeAdSkipSettingsV1';
  const DEFAULT_AD_SKIP_ENABLED = true;
  const PLAYER_SELECTOR = '#movie_player';
  const SKIP_BUTTON_SELECTOR = [
    'button.ytp-skip-ad-button',
    'button.ytp-ad-skip-button',
    'button.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button-slot button',
    'button.videoAdUiSkipButton'
  ].join(',');
  const ENFORCEMENT_SELECTOR = [
    'ytd-enforcement-message-view-model',
    '#enforcement-message-view-model',
    '[data-enforcement-message-view-model]'
  ].join(',');
  const ENFORCEMENT_TEXT_MARKERS = [
    'ad blocker',
    'ad blockers',
    '广告拦截',
    '廣告攔截',
    '停用广告拦截',
    '停用廣告攔截'
  ];

  let isAdSkipperEnabled = false;
  let adSkipSettingsReady = false;
  let adSkipSettingsGeneration = 0;
  let antiAdblockPaused = false;
  let playerObserver = null;
  let pageObserver = null;
  let enforcementObserver = null;
  let observedEnforcementTargets = new WeakSet();
  let boundPlayer = null;
  let adScanFrame = 0;
  let adEpisodeActive = false;
  let adEpisodeIdentity = '';
  let clickedSkipButtons = new WeakSet();
  let skippedButtonCount = 0;
  let lastSkipClickedAt = 0;

  function isVisibleControl(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;
    if (element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0;
  }

  function enforcementPrompt() {
    for (const candidate of document.querySelectorAll(ENFORCEMENT_SELECTOR)) {
      if (!isVisibleControl(candidate)) continue;
      const text = String(candidate.textContent || '').toLowerCase();
      if (ENFORCEMENT_TEXT_MARKERS.some(marker => text.includes(marker))) return candidate;
    }
    return null;
  }

  function resetAdEpisode() {
    adEpisodeActive = false;
    adEpisodeIdentity = '';
    clickedSkipButtons = new WeakSet();
  }

  function cancelAdScan() {
    if (!adScanFrame) return;
    cancelAnimationFrame(adScanFrame);
    adScanFrame = 0;
  }

  function stopAdSkipperRuntime() {
    cancelAdScan();
    if (playerObserver) playerObserver.disconnect();
    if (pageObserver) pageObserver.disconnect();
    if (enforcementObserver) enforcementObserver.disconnect();
    playerObserver = null;
    pageObserver = null;
    enforcementObserver = null;
    observedEnforcementTargets = new WeakSet();
    boundPlayer = null;
    resetAdEpisode();
  }

  function adSkipState() {
    const phase = !isAdSkipperEnabled
      ? 'inactive'
      : (antiAdblockPaused ? 'paused' : (adSkipSettingsReady ? 'active' : 'starting'));
    return {
      active: isAdSkipperEnabled,
      phase,
      scope: 'tab',
      count: skippedButtonCount,
      clickedCount: skippedButtonCount,
      reversibleCount: 0,
      passive: true,
      mode: 'official-skip',
      paused: antiAdblockPaused,
      pauseReason: antiAdblockPaused ? 'YOUTUBE_ANTI_ADBLOCK_NOTICE' : null,
      lastClickedAt: lastSkipClickedAt || null,
      settingsReady: adSkipSettingsReady,
    };
  }

  function publishAdSkipState() {
    return publishYouTubeState('YT_TOGGLE_AD_SKIP', adSkipState());
  }

  function pauseForEnforcementNotice() {
    if (antiAdblockPaused) return;
    antiAdblockPaused = true;
    stopAdSkipperRuntime();
    publishAdSkipState();
    showToast('检测到 YouTube 的广告拦截提示，兼容跳过已暂停', 'warn');
  }

  function scanAdControls() {
    if (!isAdSkipperEnabled || !adSkipSettingsReady || antiAdblockPaused) return;
    if (enforcementPrompt()) {
      pauseForEnforcementNotice();
      return;
    }

    const player = document.querySelector(PLAYER_SELECTOR);
    if (!player) {
      bindPlayer(null);
      return;
    }
    if (player !== boundPlayer) bindPlayer(player);

    const skipButton = Array.from(player.querySelectorAll(SKIP_BUTTON_SELECTOR)).find(isVisibleControl) || null;
    const adShowing = player.classList.contains('ad-showing') || Boolean(skipButton);

    if (!adShowing) {
      if (adEpisodeActive) resetAdEpisode();
      return;
    }
    const nextIdentity = getAdEpisodeIdentity(player);
    if (!adEpisodeActive) {
      adEpisodeActive = true;
      adEpisodeIdentity = nextIdentity;
    } else if (
      nextIdentity
      && adEpisodeIdentity
      && nextIdentity !== adEpisodeIdentity
      && Date.now() - lastSkipClickedAt > 750
    ) {
      clickedSkipButtons = new WeakSet();
      adEpisodeIdentity = nextIdentity;
    } else if (!adEpisodeIdentity && nextIdentity) {
      adEpisodeIdentity = nextIdentity;
    }

    if (skipButton && !clickedSkipButtons.has(skipButton)) {
      clickedSkipButtons.add(skipButton);
      try {
        skipButton.click();
        skippedButtonCount += 1;
        lastSkipClickedAt = Date.now();
        publishAdSkipState();
      } catch (_) {}
    }
  }

  function getAdEpisodeIdentity(player) {
    const video = player.querySelector('video.html5-main-video, video');
    const source = video ? String(video.currentSrc || video.src || '') : '';
    const pod = player.querySelector('.ytp-ad-pod-index');
    const podIndex = pod ? String(pod.textContent || '').trim().replace(/\s+/g, ' ') : '';
    const identityNode = player.querySelector('[data-ad-id], [data-creative-id]');
    const identity = identityNode
      ? String(identityNode.getAttribute('data-ad-id') || identityNode.getAttribute('data-creative-id') || '')
      : '';
    return `${source}\n${podIndex}\n${identity}`.trim();
  }

  function scheduleAdScan() {
    if (adScanFrame || !isAdSkipperEnabled || antiAdblockPaused) return;
    adScanFrame = requestAnimationFrame(() => {
      adScanFrame = 0;
      scanAdControls();
    });
  }

  function bindPlayer(player) {
    if (player === boundPlayer && playerObserver) return;
    if (playerObserver) playerObserver.disconnect();
    playerObserver = null;
    boundPlayer = player || null;
    resetAdEpisode();
    if (!boundPlayer || !isAdSkipperEnabled || antiAdblockPaused) return;
    playerObserver = new MutationObserver(records => {
      if (records.some(playerMutationHasSignal)) scheduleAdScan();
    });
    playerObserver.observe(boundPlayer, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'disabled', 'hidden', 'aria-disabled', 'aria-hidden']
    });
  }

  function nodeHasAdRuntimeSignal(node) {
    const element = node instanceof Element
      ? node
      : (node && node.parentElement instanceof Element ? node.parentElement : null);
    if (!element) return false;
    const selectors = `${PLAYER_SELECTOR},${SKIP_BUTTON_SELECTOR},${ENFORCEMENT_SELECTOR}`;
    return element.matches(selectors) || Boolean(element.querySelector(selectors));
  }

  function playerMutationHasSignal(record) {
    if (record.type === 'attributes') {
      const target = record.target instanceof Element ? record.target : null;
      return Boolean(target && (
        target === boundPlayer
        || target.matches(SKIP_BUTTON_SELECTOR)
        || target.closest('.ytp-ad-skip-button-slot')
      ));
    }
    return [...(record.addedNodes || []), ...(record.removedNodes || [])]
      .some(nodeHasAdRuntimeSignal);
  }

  function ensurePageObserver() {
    if (pageObserver || !document.documentElement) return;
    ensureEnforcementObserver();
    observeEnforcementTree(document);
    pageObserver = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes || []) observeEnforcementTree(node);
        if ([...(record.addedNodes || []), ...(record.removedNodes || [])].some(nodeHasAdRuntimeSignal)) {
          scheduleAdScan();
          return;
        }
      }
    });
    pageObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function ensureEnforcementObserver() {
    if (enforcementObserver) return;
    enforcementObserver = new MutationObserver(scheduleAdScan);
  }

  function observeEnforcementTree(root) {
    const element = root instanceof Element ? root : null;
    const candidates = [];
    if (element && element.matches(ENFORCEMENT_SELECTOR)) candidates.push(element);
    if (root && typeof root.querySelectorAll === 'function') {
      candidates.push(...root.querySelectorAll(ENFORCEMENT_SELECTOR));
    }
    for (const candidate of candidates) {
      let target = candidate;
      let depth = 0;
      while (target && target !== document.documentElement && depth < 4) {
        if (!observedEnforcementTargets.has(target)) {
          observedEnforcementTargets.add(target);
          enforcementObserver.observe(target, {
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']
          });
        }
        target = target.parentElement;
        depth += 1;
      }
    }
  }

  function initAdSkipper() {
    if (!isAdSkipperEnabled || !adSkipSettingsReady || antiAdblockPaused) return;
    ensurePageObserver();
    bindPlayer(document.querySelector(PLAYER_SELECTOR));
    scheduleAdScan();
  }

  function persistAdSkipSetting(enabled) {
    try {
      return chrome.storage.local.set({
        [AD_SKIP_SETTINGS_KEY]: { version: 1, enabled: Boolean(enabled), updatedAt: Date.now() }
      });
    } catch (_) {
      return Promise.resolve();
    }
  }

  function readAdSkipSetting() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get([AD_SKIP_SETTINGS_KEY], result => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            resolve({ ok: false, exists: false, enabled: DEFAULT_AD_SKIP_ENABLED });
            return;
          }
          const raw = result && result[AD_SKIP_SETTINGS_KEY];
          resolve({
            ok: true,
            exists: Boolean(raw && typeof raw === 'object'),
            enabled: raw && typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_AD_SKIP_ENABLED,
          });
        });
      } catch (_) {
        resolve({ ok: false, exists: false, enabled: DEFAULT_AD_SKIP_ENABLED });
      }
    });
  }

  async function bootstrapAdSkipper() {
    const generation = adSkipSettingsGeneration;
    const stored = await readAdSkipSetting();
    if (generation !== adSkipSettingsGeneration) return;
    adSkipSettingsReady = true;
    isAdSkipperEnabled = stored.enabled;
    antiAdblockPaused = false;
    if (isAdSkipperEnabled) initAdSkipper();
    else stopAdSkipperRuntime();
    publishAdSkipState();
    if (stored.ok && !stored.exists) persistAdSkipSetting(isAdSkipperEnabled).catch(() => {});
  }

  // ========== 消息监听 ==========
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.type === 'WO_ACTION_STATE_SYNC') return false;
    let handled = true;
    let result = null;
    switch (request.action) {
      case "YT_TOGGLE_AD_SKIP": result = setAdSkip(request.payload || request); break;
      case "YT_SET_SPEED": setVideoSpeed(request.speed); break;
      case "YT_SCREENSHOT": captureScreenshot(); break;
      case "YT_TOGGLE_LOOP": result = setAbLoop(request.payload || request); break;
      case "YT_EXTRACT_INFO": extractVideoInfo(); break;
      case "YT_EXTRACT_AUDIO":
        showAudioUrl();
        result = { ok: true, action: 'YT_EXTRACT_AUDIO', status: 'opening', data: {} };
        break;
      case "YT_CINEMA_MODE": result = setCinemaMode(request.payload || request); break;
      case "YT_SHORTCUTS": showShortcutsPanel(); break;
      default: handled = false;
    }
    if (handled && typeof sendResponse === 'function') {
      sendResponse(result || { ok: true, action: request.action, status: 'completed', data: {} });
      return true;
    }
  });

  function publishYouTubeState(action, state) {
    const next = { scope: 'tab', updatedAt: Date.now(), ...state };
    if (window.webOmniActionState && typeof window.webOmniActionState.set === 'function') {
      window.webOmniActionState.set(action, next);
    } else {
      chrome.runtime.sendMessage({ type: 'WO_ACTION_STATE_CHANGED', action, state: next }).catch(() => {});
    }
    return next;
  }

  // ========== 开关兼容跳过 ==========
  function setAdSkip(payload) {
    const mode = payload && payload.mode;
    if (mode !== 'status') {
      adSkipSettingsGeneration += 1;
      adSkipSettingsReady = true;
      isAdSkipperEnabled = mode === 'enable'
        ? true
        : (mode === 'disable' ? false : !isAdSkipperEnabled);
      antiAdblockPaused = false;
      if (isAdSkipperEnabled) initAdSkipper();
      else stopAdSkipperRuntime();
      if (!(payload && payload.persist === false)) persistAdSkipSetting(isAdSkipperEnabled).catch(() => {});
      if (!(payload && payload.silent)) {
        showToast(`YouTube 兼容跳过: ${isAdSkipperEnabled ? '已开启' : '已关闭'}`, isAdSkipperEnabled ? 'success' : 'warn');
      }
    }
    const state = publishAdSkipState();
    return {
      ok: true,
      action: 'YT_TOGGLE_AD_SKIP',
      status: state.phase,
      data: state,
    };
  }

  function toggleAdSkip() {
    return setAdSkip({});
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[AD_SKIP_SETTINGS_KEY]) return;
    const raw = changes[AD_SKIP_SETTINGS_KEY].newValue;
    if (!raw || typeof raw.enabled !== 'boolean' || raw.enabled === isAdSkipperEnabled) return;
    setAdSkip({ mode: raw.enabled ? 'enable' : 'disable', persist: false, silent: true });
  });

  document.addEventListener('yt-navigate-start', () => {
    stopAdSkipperRuntime();
    antiAdblockPaused = false;
    if (loopA !== -1 || loopB !== -1) setAbLoop({ mode: 'disable', silent: true });
    if (isCinema) setCinemaMode({ mode: 'disable', silent: true });
  });
  document.addEventListener('yt-navigate-finish', () => {
    antiAdblockPaused = false;
    if (isAdSkipperEnabled && adSkipSettingsReady) initAdSkipper();
    publishAdSkipState();
  });
  globalThis.addEventListener('pagehide', stopAdSkipperRuntime);
  globalThis.addEventListener('pageshow', event => {
    if (!event.persisted || !isAdSkipperEnabled || !adSkipSettingsReady) return;
    antiAdblockPaused = false;
    initAdSkipper();
    publishAdSkipState();
  });
  bootstrapAdSkipper().catch(() => {
    adSkipSettingsReady = true;
    isAdSkipperEnabled = DEFAULT_AD_SKIP_ENABLED;
    if (isAdSkipperEnabled) initAdSkipper();
    publishAdSkipState();
  });

  // ========== 2. 倍速控制 ==========
  let storedSpeed = 1;

  function setVideoSpeed(speed) {
    const video = document.querySelector('video');
    if (!video) { showToast("未找到视频", "warn"); return; }
    storedSpeed = parseFloat(speed);
    video.playbackRate = storedSpeed;
    showToast(`倍速: ${storedSpeed}x`, "success");
    try { chrome.storage.local.set({ ytLastSpeed: storedSpeed }); } catch(e) {}
  }

  // ========== 3. 视频截图 ==========
  function captureScreenshot() {
    const video = document.querySelector('video');
    if (!video) { showToast("未找到视频", "warn"); return; }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      const t = formatTime(video.currentTime);
      a.download = `yt_${t}.png`;
      a.click();
      showToast(`截图已保存 (${canvas.width}×${canvas.height})`, "success");
    } catch(e) {
      showToast("截图失败: " + e.message, "error");
    }
  }

  // ========== 4. A-B 循环 ==========
  let loopA = -1, loopB = -1, loopTimer = null;

  function setAbLoop(payload) {
    const mode = payload && payload.mode;

    if (mode === 'disable' || (mode !== 'enable' && mode !== 'status' && loopA !== -1 && loopB !== -1)) {
      clearInterval(loopTimer);
      loopTimer = null;
      loopA = -1; loopB = -1;
      if (mode !== 'status' && !(payload && payload.silent)) showToast("A-B 循环已取消", "info");
    } else {
      const video = document.querySelector('video');
      if (!video) return { ok: false, action: 'YT_TOGGLE_LOOP', status: 'failed', error: { code: 'UNSUPPORTED_CONTEXT', message: '未找到视频。' } };
      if (mode !== 'status' && loopA === -1) {
      loopA = video.currentTime;
      showToast(`A点: ${formatTime(loopA)}，再次点击设置B点`, "info");
      } else if (mode !== 'status' && loopB === -1) {
        loopB = video.currentTime;
        if (loopB <= loopA) { showToast("B点必须在A点之后", "warn"); loopB = -1; }
        else {
          showToast(`循环: ${formatTime(loopA)} → ${formatTime(loopB)}`, "success");
          loopTimer = setInterval(() => { if (video.currentTime >= loopB) video.currentTime = loopA; }, 300);
        }
      }
    }
    const active = loopA !== -1;
    const state = publishYouTubeState('YT_TOGGLE_LOOP', {
      scope: 'page',
      active,
      phase: !active ? 'inactive' : (loopB === -1 ? 'selecting' : 'active'),
      count: active ? 1 : 0,
      reversibleCount: active ? 1 : 0,
      loopA: active ? loopA : null,
      loopB: loopB === -1 ? null : loopB,
    });
    return { ok: true, action: 'YT_TOGGLE_LOOP', status: active ? 'active' : 'inactive', data: state };
  }

  function toggleAbLoop() {
    return setAbLoop({});
  }

  function formatTime(s) {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  }

  // ========== 5. 视频信息提取 → 显示在面板中 ==========
  function extractVideoInfo() {
    const title = document.title.replace(/^\(\d+\)\s/, '').replace(" - YouTube", "");
    const vid = new URLSearchParams(location.search).get("v") || "";
    const channel = document.querySelector('#owner-name a, ytd-channel-name a')?.innerText || "未知";
    const viewsEl = document.querySelector('#info-container .yt-formatted-string, ytd-video-primary-info-renderer .view-count');
    const views = viewsEl?.innerText || "";
    const dateEl = document.querySelector('#info-strings yt-formatted-string');
    const date = dateEl?.innerText || "";
    const tags = Array.from(document.querySelectorAll('meta[property="og:video:tag"]')).map(m => m.content);

    const items = [
      { k: "标题", v: title },
      { k: "频道", v: channel },
      { k: "观看", v: views },
      { k: "日期", v: date },
      { k: "链接", v: vid ? `https://youtu.be/${vid}` : location.href },
      { k: "标签", v: tags.slice(0, 8).join(', ') || "无" },
    ];
    showResultPanel("视频信息", items.map(i => `<b>${i.k}</b>: ${i.v}`).join('<br>'));
  }

  // ========== 6. 音频流嗅探 → 统一媒体面板 ==========
  async function showAudioUrl() {
    try {
      const tabId = Number.isInteger(globalThis.__webOmniTabId) ? globalThis.__webOmniTabId : null;
      if (!Number.isInteger(tabId)) {
        showToast("媒体面板尚未初始化，请从 Command Hub 再试一次", "warn");
        return null;
      }
      const response = await chrome.runtime.sendMessage({
        type: 'WO_EXECUTE_ACTION',
        action: 'YT_EXTRACT_AUDIO',
        tabId,
        payload: { mode: 'enable', filter: 'audio' },
      });
      if (!response || !response.ok) {
        const message = response && response.error && response.error.message;
        showToast(message || "音频媒体面板打开失败", "error");
        return response || null;
      }
      showToast("音频媒体面板已打开", "success");
      return response;
    } catch (_) {
      showToast("音频媒体面板打开失败", "error");
      return null;
    }
  }

  // ========== 7. 影院模式 ==========
  let isCinema = false;
  let cinemaOverlay = null;
  let cinemaPlayer = null;
  let cinemaPlayerStyle = null;
  let cinemaTimer = null;

  function setCinemaMode(payload) {
    const mode = payload && payload.mode;
    const nextCinema = mode === 'enable'
      ? true
      : (mode === 'disable' ? false : (mode === 'status' ? isCinema : !isCinema));
    if (nextCinema) {
      const nextPlayer = cinemaPlayer && cinemaPlayer.isConnected
        ? cinemaPlayer
        : document.querySelector('#player, #ytd-player, #movie_player');
      if (!nextPlayer) {
        isCinema = false;
        return {
          ok: false,
          action: 'YT_CINEMA_MODE',
          status: 'failed',
          error: { code: 'UNSUPPORTED_CONTEXT', message: '未找到 YouTube 播放器。' },
        };
      }
      isCinema = true;
      if (cinemaTimer) clearTimeout(cinemaTimer);
      if (!cinemaOverlay) {
        cinemaOverlay = document.createElement('div');
        cinemaOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.88);z-index:2000;pointer-events:none;transition:opacity 0.4s;opacity:0;';
        document.body.appendChild(cinemaOverlay);
      }
      cinemaPlayer = nextPlayer;
      if (cinemaPlayer && !cinemaPlayerStyle) {
        cinemaPlayerStyle = {
          position: { value: cinemaPlayer.style.getPropertyValue('position'), priority: cinemaPlayer.style.getPropertyPriority('position') },
          zIndex: { value: cinemaPlayer.style.getPropertyValue('z-index'), priority: cinemaPlayer.style.getPropertyPriority('z-index') },
        };
        cinemaPlayer.style.setProperty('position', 'relative');
        cinemaPlayer.style.setProperty('z-index', '2001');
      }
      cinemaOverlay.style.display = 'block';
      requestAnimationFrame(() => cinemaOverlay.style.opacity = '1');
      if (mode !== 'status' && !(payload && payload.silent)) showToast("影院模式已开启", "success");
    } else {
      isCinema = false;
      if (cinemaOverlay) {
        cinemaOverlay.style.opacity = '0';
        cinemaTimer = setTimeout(() => { if (cinemaOverlay && !isCinema) cinemaOverlay.style.display = 'none'; }, 400);
      }
      if (cinemaPlayer && cinemaPlayerStyle) {
        restorePlayerStyle(cinemaPlayer, 'position', cinemaPlayerStyle.position, 'relative');
        restorePlayerStyle(cinemaPlayer, 'z-index', cinemaPlayerStyle.zIndex, '2001');
        cinemaPlayer = null;
        cinemaPlayerStyle = null;
      }
      if (mode !== 'status' && !(payload && payload.silent)) showToast("影院模式已关闭", "info");
    }
    const state = publishYouTubeState('YT_CINEMA_MODE', {
      scope: 'page',
      active: isCinema,
      phase: isCinema ? 'active' : 'inactive',
      count: isCinema ? 1 : 0,
      reversibleCount: isCinema ? 1 : 0,
    });
    return { ok: true, action: 'YT_CINEMA_MODE', status: isCinema ? 'active' : 'inactive', data: state };
  }

  function restorePlayerStyle(element, name, record, appliedValue) {
    if (element.style.getPropertyValue(name) !== appliedValue) return;
    if (record.value) element.style.setProperty(name, record.value, record.priority || '');
    else element.style.removeProperty(name);
  }

  function toggleCinemaMode() {
    return setCinemaMode({});
  }

  // ========== 8. 浮动快捷面板 (直接调用本地函数，不走消息) ==========
  function showShortcutsPanel() {
    let panel = document.getElementById('wo-yt-panel');
    if (panel) { panel.remove(); return; }

    panel = document.createElement('div');
    panel.id = 'wo-yt-panel';
    panel.style.cssText = 'position:fixed;bottom:80px;right:20px;width:260px;background:#1a1a1a;border:1px solid #333;border-radius:10px;color:#ddd;padding:14px;z-index:2147483646;font-family:system-ui,sans-serif;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,0.6);';

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;margin-bottom:10px;">
        <b>YouTube 工具</b><span id="wo-yt-close" style="cursor:pointer;color:#888;">✕</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
        <button class="wo-yb" data-fn="captureScreenshot">📸 截图</button>
        <button class="wo-yb" data-fn="toggleAdSkip">🚫 兼容跳过</button>
        <button class="wo-yb" data-fn="toggleAbLoop">🔁 A-B循环</button>
        <button class="wo-yb" data-fn="toggleCinemaMode">🌙 影院</button>
        <button class="wo-yb" data-fn="extractVideoInfo">📝 视频信息</button>
        <button class="wo-yb" data-fn="showAudioUrl">🎵 音频流</button>
      </div>
      <div style="margin-top:10px;display:flex;align-items:center;gap:8px;">
        <span style="font-size:12px;color:#888;">倍速</span>
        <input type="range" id="wo-yt-spd" min="0.5" max="3" step="0.25" value="${storedSpeed}" style="flex:1;accent-color:#666;">
        <span id="wo-yt-sv" style="font-size:12px;min-width:30px;">${storedSpeed.toFixed(1)}x</span>
      </div>
    `;

    // 注入简洁样式
    const style = document.createElement('style');
    style.textContent = '.wo-yb{background:#252525;border:1px solid #3a3a3a;color:#ccc;padding:7px 4px;border-radius:6px;cursor:pointer;font-size:12px;transition:background 0.15s;}.wo-yb:hover{background:#333;}';
    panel.appendChild(style);
    document.body.appendChild(panel);

    panel.querySelector('#wo-yt-close').onclick = () => panel.remove();

    // ★ 关键修复：直接调用本地函数，不走chrome.runtime.sendMessage
    const fnMap = { captureScreenshot, toggleAdSkip, toggleAbLoop, toggleCinemaMode, extractVideoInfo, showAudioUrl };
    panel.querySelectorAll('.wo-yb').forEach(btn => {
      btn.onclick = () => { const fn = fnMap[btn.dataset.fn]; if (fn) fn(); };
    });

    const slider = panel.querySelector('#wo-yt-spd');
    const sv = panel.querySelector('#wo-yt-sv');
    try {
      chrome.storage.local.get(['ytLastSpeed'], r => {
        if (r.ytLastSpeed) { slider.value = r.ytLastSpeed; sv.innerText = Number(r.ytLastSpeed).toFixed(1) + 'x'; }
      });
    } catch(e) {}
    slider.oninput = e => { sv.innerText = Number(e.target.value).toFixed(1) + 'x'; };
    slider.onchange = e => setVideoSpeed(e.target.value);
  }

  // ========== 通用：结果浮动面板 ==========
  function showResultPanel(title, htmlContent) {
    let rp = document.getElementById('wo-yt-result');
    if (rp) rp.remove();
    rp = document.createElement('div');
    rp.id = 'wo-yt-result';
    rp.style.cssText = 'position:fixed;top:80px;right:20px;width:320px;background:#1a1a1a;border:1px solid #333;border-radius:10px;color:#ccc;padding:16px;z-index:2147483646;font-family:system-ui,sans-serif;font-size:13px;line-height:1.6;box-shadow:0 8px 24px rgba(0,0,0,0.6);max-height:60vh;overflow-y:auto;';
    rp.innerHTML = `<div style="display:flex;justify-content:space-between;margin-bottom:10px;"><b>${title}</b><span id="wo-ytr-close" style="cursor:pointer;color:#888;">✕</span></div><div>${htmlContent}</div>`;
    document.body.appendChild(rp);
    rp.querySelector('#wo-ytr-close').onclick = () => rp.remove();
  }

  // ========== 简洁 Toast ==========
  function showToast(msg, type) {
    if (window.webOmniShowToast) { window.webOmniShowToast(msg, type); return; }
    // 后备简洁toast
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `position:fixed;top:20px;right:20px;padding:10px 16px;background:#222;color:#ddd;border:1px solid #444;border-radius:8px;z-index:2147483647;font-size:13px;font-family:system-ui;transition:opacity 0.3s;`;
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 2500);
  }

})();
