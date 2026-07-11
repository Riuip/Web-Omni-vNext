// 神经末梢：YouTube 增强引擎 (YouTube Enhancer)
// 跳过广告、倍速、截图、循环、影院模式、信息提取

(function() {
  if (window.webOmniYouTubeEnhancerInjected) return;
  window.webOmniYouTubeEnhancerInjected = true;

  // ========== 1. 自动跳过广告 ==========
  let adObserver = null;
  let isAdSkipperEnabled = true;
  let adSkipInterval = null;
  let adScanFrame = 0;
  let acceleratedAdVideo = null;

  function restoreAdVideo() {
    if (!acceleratedAdVideo) return;
    const { video, playbackRate, muted } = acceleratedAdVideo;
    try {
      if (video.playbackRate === 16) video.playbackRate = playbackRate;
      if (video.muted === true) video.muted = muted;
    } catch (_) {}
    acceleratedAdVideo = null;
  }

  function accelerateAdVideo(video) {
    if (!video) return;
    if (!acceleratedAdVideo || acceleratedAdVideo.video !== video) {
      restoreAdVideo();
      acceleratedAdVideo = {
        video,
        playbackRate: video.playbackRate,
        muted: video.muted,
      };
    }
    if (!video.paused) video.playbackRate = 16;
    video.muted = true;
  }

  function scheduleAdScan() {
    if (adScanFrame) return;
    adScanFrame = requestAnimationFrame(() => {
      adScanFrame = 0;
      clickAdSkip();
    });
  }

  function initAdSkipper() {
    if (adObserver) adObserver.disconnect();

    clickAdSkip = () => {
      if (!isAdSkipperEnabled) return;

      // 跳过按钮 — 覆盖多个版本的选择器
      const skipSelectors = [
        '.ytp-skip-ad-button',
        '.ytp-ad-skip-button',
        '.ytp-ad-skip-button-modern',
        'button.ytp-ad-skip-button',
        '.ytp-ad-skip-button-slot button',
        '[class*="skip"] button',
        '.videoAdUiSkipButton'
      ];
      document.querySelectorAll(skipSelectors.join(',')).forEach(btn => {
        if (btn && (btn.offsetParent !== null || btn.style.display !== 'none')) {
          try { btn.click(); } catch(e) {}
        }
      });

      // 关闭底部banner广告
      document.querySelectorAll('.ytp-ad-overlay-close-button, .ytp-ad-overlay-close-container').forEach(btn => {
        if (btn && btn.offsetParent !== null) {
          try { btn.click(); } catch(e) {}
        }
      });

      // 加速不可跳过广告
      const video = document.querySelector('video');
      const adShowing = document.querySelector('.ad-showing');
      if (video && adShowing) {
        accelerateAdVideo(video);
      } else restoreAdVideo();
    };

    clickAdSkip();

    const target = document.querySelector('#movie_player') || document.querySelector('ytd-player') || document.body;
    adObserver = new MutationObserver(scheduleAdScan);
    adObserver.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });

    if (adSkipInterval) clearInterval(adSkipInterval);
    adSkipInterval = setInterval(() => {
      if (document.querySelector('.ad-showing')) scheduleAdScan();
    }, 2500);
  }

  let clickAdSkip = () => {};

  // 页面加载完毕后启动
  if (document.readyState === 'complete') {
    initAdSkipper();
  } else {
    window.addEventListener('load', initAdSkipper);
  }
  document.addEventListener('yt-navigate-start', () => {
    if (loopA !== -1 || loopB !== -1) setAbLoop({ mode: 'disable', silent: true });
    if (isCinema) setCinemaMode({ mode: 'disable', silent: true });
    restoreAdVideo();
  });
  document.addEventListener('yt-navigate-finish', () => {
    if (isAdSkipperEnabled) initAdSkipper();
    setAdSkip({ mode: 'status' });
  });
  setTimeout(() => setAdSkip({ mode: 'status' }), 0);

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
      case "YT_EXTRACT_AUDIO": showAudioUrl(); break;
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

  // ========== 开关跳过广告 ==========
  function setAdSkip(payload) {
    const mode = payload && payload.mode;
    const wasEnabled = isAdSkipperEnabled;
    if (mode === 'enable') isAdSkipperEnabled = true;
    else if (mode === 'disable') isAdSkipperEnabled = false;
    else if (mode !== 'status') isAdSkipperEnabled = !isAdSkipperEnabled;
    if (isAdSkipperEnabled && !wasEnabled) initAdSkipper();
    if (!isAdSkipperEnabled) {
      if (adObserver) adObserver.disconnect();
      adObserver = null;
      if (adSkipInterval) clearInterval(adSkipInterval);
      adSkipInterval = null;
      if (adScanFrame) cancelAnimationFrame(adScanFrame);
      adScanFrame = 0;
      restoreAdVideo();
    }
    if (mode !== 'status') showToast(`自动跳过广告: ${isAdSkipperEnabled ? '已开启' : '已关闭'}`, isAdSkipperEnabled ? "success" : "warn");
    const state = publishYouTubeState('YT_TOGGLE_AD_SKIP', {
      active: isAdSkipperEnabled,
      phase: isAdSkipperEnabled ? 'active' : 'inactive',
      count: isAdSkipperEnabled ? 1 : 0,
      reversibleCount: isAdSkipperEnabled ? 1 : 0,
      passive: true,
    });
    return { ok: true, action: 'YT_TOGGLE_AD_SKIP', status: isAdSkipperEnabled ? 'active' : 'inactive', data: state };
  }

  function toggleAdSkip() {
    return setAdSkip({});
  }

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

  // ========== 6. 音频流嗅探 → 显示在面板中 ==========
  function showAudioUrl() {
    let playerData = null;
    try {
      playerData = window.ytInitialPlayerResponse;
      if (!playerData) {
        const scripts = document.querySelectorAll('script');
        for (let s of scripts) {
          const txt = s.textContent || "";
          if (txt.includes('ytInitialPlayerResponse')) {
            const m = txt.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
            if (m) { playerData = JSON.parse(m[1]); break; }
          }
        }
      }
      if (playerData?.streamingData?.adaptiveFormats) {
        const audioFmts = playerData.streamingData.adaptiveFormats.filter(f => f.mimeType && f.mimeType.includes('audio'));
        if (audioFmts.length > 0) {
          audioFmts.sort((a,b) => (b.averageBitrate||0) - (a.averageBitrate||0));
          const best = audioFmts[0];
          if (best.url) {
            showResultPanel("音频流地址", `<b>格式</b>: ${best.mimeType}<br><b>码率</b>: ${Math.round((best.averageBitrate||0)/1000)}kbps<br><br><textarea style="width:100%;height:60px;background:#111;color:#ccc;border:1px solid #333;border-radius:4px;padding:6px;font-size:11px;resize:none;" readonly>${best.url}</textarea><br><small>可复制到下载器使用</small>`);
            return;
          }
        }
      }
      showToast("未解析到音频流地址 (可能已加密)", "warn");
    } catch(e) {
      showToast("解析失败", "error");
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
        <button class="wo-yb" data-fn="toggleAdSkip">🚫 跳广告</button>
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
