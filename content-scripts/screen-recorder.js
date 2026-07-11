// Web-Omni: 屏幕录制入口与悬浮状态条
(function() {
  if (window.webOmniScreenRecorderInjected) return;
  window.webOmniScreenRecorderInjected = true;

  const OPEN_ACTION = "OPEN_SCREEN_RECORDER";
  const GET_STATE = "WO_RECORDER_GET_STATE";
  const COMMAND = "WO_RECORDER_COMMAND";
  const STATE_EVENT = "WO_RECORDER_STATE";
  const STYLE_ID = "wo-screen-recorder-style";
  const BAR_ID = "wo-screen-recorder-bar";

  let sessionState = createIdleState();
  let ticker = null;

  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === OPEN_ACTION) {
      openRecorderPage();
      return;
    }

    if (request.type === STATE_EVENT) {
      applyState(request.state);
    }
  });

  requestRecorderState();

  function createIdleState() {
    return {
      status: "idle",
      startedAt: null,
      pauseStartedAt: null,
      pausedDurationMs: 0,
    };
  }

  function normalizeState(nextState) {
    const state = {
      ...createIdleState(),
      ...(nextState || {}),
    };

    if (state.status !== "recording" && state.status !== "paused") {
      return createIdleState();
    }

    return state;
  }

  function requestRecorderState() {
    chrome.runtime.sendMessage({ type: GET_STATE }, (response) => {
      if (chrome.runtime.lastError) return;
      applyState(response && response.state);
    });
  }

  function openRecorderPage() {
    chrome.runtime.sendMessage({ type: COMMAND, command: "OPEN_RECORDER" }, () => {});
    if (window.webOmniShowToast) {
      window.webOmniShowToast("正在打开录屏器...", "info");
    }
  }

  function sendRecorderCommand(command) {
    chrome.runtime.sendMessage({ type: COMMAND, command }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response && response.state) applyState(response.state);
    });
  }

  function applyState(nextState) {
    sessionState = normalizeState(nextState);
    if (sessionState.status === "idle") {
      removeFloatingBar();
      return;
    }
    ensureFloatingBar();
    updateFloatingBar();
    ensureTicker();
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BAR_ID}{
        position:fixed;right:16px;bottom:16px;z-index:2147483647;
        display:flex;align-items:center;gap:12px;padding:12px 14px;
        border-radius:14px;background:rgba(13,17,23,0.94);color:#e6edf3;
        border:1px solid rgba(88,166,255,0.18);box-shadow:0 18px 38px rgba(0,0,0,0.34);
        backdrop-filter:blur(18px);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        max-width:min(92vw,520px);
      }
      #${BAR_ID}.wo-paused{border-color:rgba(242,201,76,0.34);}
      #${BAR_ID} .wo-recorder-indicator{display:flex;align-items:center;gap:10px;min-width:0;}
      #${BAR_ID} .wo-recorder-dot{
        width:10px;height:10px;border-radius:50%;background:#ff4d4f;flex-shrink:0;
        box-shadow:0 0 0 0 rgba(255,77,79,0.45);animation:wo-recorder-pulse 1.8s infinite;
      }
      #${BAR_ID}.wo-paused .wo-recorder-dot{
        background:#f2c94c;box-shadow:none;animation:none;
      }
      #${BAR_ID} .wo-recorder-copy{display:flex;flex-direction:column;gap:2px;min-width:0;}
      #${BAR_ID} .wo-recorder-title{font-size:12px;font-weight:700;line-height:1.1;}
      #${BAR_ID} .wo-recorder-meta{font-size:12px;color:#9da7b3;white-space:nowrap;}
      #${BAR_ID} .wo-recorder-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;}
      #${BAR_ID} .wo-recorder-btn{
        appearance:none;border:1px solid #30363d;background:#161b22;color:#e6edf3;
        border-radius:999px;padding:7px 12px;font-size:12px;cursor:pointer;
        transition:background 0.15s ease,border-color 0.15s ease,transform 0.15s ease;
      }
      #${BAR_ID} .wo-recorder-btn:hover{background:#21262d;border-color:#58a6ff;transform:translateY(-1px);}
      #${BAR_ID} .wo-recorder-btn.danger{border-color:rgba(248,81,73,0.4);color:#ffb3b3;}
      @keyframes wo-recorder-pulse{
        0%{box-shadow:0 0 0 0 rgba(255,77,79,0.45);}
        70%{box-shadow:0 0 0 8px rgba(255,77,79,0);}
        100%{box-shadow:0 0 0 0 rgba(255,77,79,0);}
      }
      @media (max-width: 640px) {
        #${BAR_ID}{
          left:12px;right:12px;bottom:12px;flex-direction:column;align-items:stretch;gap:10px;
        }
        #${BAR_ID} .wo-recorder-actions{justify-content:stretch;}
        #${BAR_ID} .wo-recorder-btn{flex:1;text-align:center;}
      }
    `;
    document.documentElement.appendChild(style);
  }

  function ensureFloatingBar() {
    ensureStyle();
    if (document.getElementById(BAR_ID)) return;

    const bar = document.createElement("div");
    bar.id = BAR_ID;
    bar.innerHTML = `
      <div class="wo-recorder-indicator">
        <span class="wo-recorder-dot"></span>
        <div class="wo-recorder-copy">
          <div class="wo-recorder-title" data-role="status">正在录屏</div>
          <div class="wo-recorder-meta" data-role="timer">00:00</div>
        </div>
      </div>
      <div class="wo-recorder-actions">
        <button class="wo-recorder-btn" data-command="TOGGLE_PAUSE">暂停</button>
        <button class="wo-recorder-btn danger" data-command="STOP">停止</button>
        <button class="wo-recorder-btn" data-command="OPEN_RECORDER">打开录制器</button>
      </div>
    `;

    bar.addEventListener("click", (event) => {
      const button = event.target.closest("[data-command]");
      if (!button) return;
      sendRecorderCommand(button.dataset.command);
    });

    document.body.appendChild(bar);
  }

  function updateFloatingBar() {
    const bar = document.getElementById(BAR_ID);
    if (!bar) return;

    const statusEl = bar.querySelector('[data-role="status"]');
    const timerEl = bar.querySelector('[data-role="timer"]');
    const pauseBtn = bar.querySelector('[data-command="TOGGLE_PAUSE"]');

    const paused = sessionState.status === "paused";
    bar.classList.toggle("wo-paused", paused);
    statusEl.textContent = paused ? "录屏已暂停" : "正在录屏";
    timerEl.textContent = formatDuration(getElapsedMs());
    pauseBtn.textContent = paused ? "继续" : "暂停";
  }

  function ensureTicker() {
    if (ticker) return;
    ticker = setInterval(() => {
      if (sessionState.status === "idle") {
        clearInterval(ticker);
        ticker = null;
        return;
      }
      updateFloatingBar();
    }, 1000);
  }

  function removeFloatingBar() {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    const bar = document.getElementById(BAR_ID);
    if (bar) bar.remove();
  }

  function getElapsedMs() {
    if (!sessionState.startedAt) return 0;
    const endAt =
      sessionState.status === "paused" && sessionState.pauseStartedAt
        ? sessionState.pauseStartedAt
        : Date.now();
    return Math.max(
      0,
      endAt - sessionState.startedAt - (sessionState.pausedDurationMs || 0)
    );
  }

  function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return [hours, minutes, seconds].map(pad2).join(":");
    }
    return [minutes, seconds].map(pad2).join(":");
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }
})();
