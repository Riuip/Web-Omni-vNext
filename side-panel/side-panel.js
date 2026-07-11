/* ================================================================
 * Web-Omni Side Panel — Command Surface
 * 当前页快照 / 翻译 / 专业天气（实况+24h+7d+日出日落+UV/湿度/气压/能见度）
 * ================================================================ */
(function () {
  "use strict";

  const actionClient = globalThis.WebOmniActionClient;
  const sharedRegistry = globalThis.WebOmniActionRegistry;
  const fetchJson = globalThis.WebOmniNetwork.fetchJson;

  /* ---------- 常量 ---------- */
  const INPUT_TM_STORAGE_KEY = "woInputTMEnabled";
  const HUB_PINS_STORAGE_KEY = "woCommandHubPins";
  const HUB_PERSONAL_ORDER_STORAGE_KEY = "woCommandHubPersonalOrder";
  const GLOBAL_PRIVACY_STORAGE_KEY = "woGlobalPrivacySettings";
  const WEATHER_QUERY_STORAGE_KEY = "woPopupWeatherQuery";
  const TRANSLATE_PREFS_STORAGE_KEY = "woPopupTranslatePrefs";
  const QUICK_FAVORITE_LIMIT = 8;
  const QUICK_DRAG_DISTANCE = 7;
  const QUICK_DROP_CONFIRM_MS = 220;
  const QUICK_PERSONAL_ORDER_LIMIT = 24;
  const PRIVACY_SELECTOR_LIMIT = 32;
  const PRIVACY_SELECTOR_LENGTH_LIMIT = 240;
  const GLOBAL_PRIVACY_DEFAULTS = Object.freeze({
    blockTrackers: true,
    fingerprintProtection: true,
    webrtcProtection: false,
    stripReferrer: true,
    pageShield: false,
    adBlocking: true,
    youtubeCompatibility: true,
    customAdSelectors: Object.freeze([]),
  });
  const QUICK_CATEGORY_LABELS = Object.freeze({
    visual: "视觉掌控",
    data: "数据收割",
    commerce: "比价工具",
    vault: "密码管理",
    privacy: "隐私保护",
    security: "安全工具",
    youtube: "YouTube",
    automation: "自动化",
    reading: "沉浸阅读",
    utility: "实用工具",
    efficiency: "效率神器",
    transfer: "文件传输",
  });
  const QUICK_CATEGORY_ICONS = Object.freeze({
    visual: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    data: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 18h16v3H4z"/></svg>',
    commerce: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h2l2 10h9l2-7H7"/><circle cx="10" cy="19" r="1"/><circle cx="17" cy="19" r="1"/></svg>',
    vault: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
    privacy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4 6v6c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V6l-8-3z"/></svg>',
    security: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 7 4 5-4 5M12 17h8"/></svg>',
    youtube: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="3"/><path d="m10 9 5 3-5 3z"/></svg>',
    automation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 3 4 14h7l-1 7 9-11h-7z"/></svg>',
    reading: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h7a2 2 0 0 1 2 2v13a3 3 0 0 0-3-3H3zM21 5h-7a2 2 0 0 0-2 2v13a3 3 0 0 1 3-3h6z"/></svg>',
    utility: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 6.5a4 4 0 0 0-5 5L4 17v3h3l5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-3-3z"/></svg>',
    efficiency: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6zM18 15l1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/></svg>',
    transfer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3"/></svg>',
  });
  const TRANSLATE_MAX_BYTES = 450;
  const PAGE_TRANSLATE_CHUNK_BYTES = 380;
  const PAGE_TRANSLATE_CONCURRENCY = 3;
  const VIEW_TRANSITION_MS = 420;
  const VIEW_TRANSITION_EASING = "cubic-bezier(.32, 0, .18, 1)";
  const WEATHER_GEOCODE_ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search";
  const WEATHER_FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
  const TRANSLATE_ENDPOINT = "https://api.mymemory.translated.net/get";
  const PAGE_TRANSLATE_ACTIONS = {
    COLLECT: "WO_PAGE_TRANSLATE_COLLECT",
    APPLY: "WO_PAGE_TRANSLATE_APPLY",
    RESTORE: "WO_PAGE_TRANSLATE_RESTORE",
  };
  const RESTRICTED_PREFIXES = [
    "chrome://",
    "edge://",
    "about:",
    "chrome-extension://",
    "devtools://",
    "view-source:",
  ];
  const LANGUAGE_OPTIONS = [
    { value: "auto", label: "自动识别" },
    { value: "zh-CN", label: "中文" },
    { value: "en", label: "英语" },
    { value: "ja", label: "日语" },
    { value: "ko", label: "韩语" },
    { value: "fr", label: "法语" },
    { value: "de", label: "德语" },
    { value: "es", label: "西班牙语" },
    { value: "ru", label: "俄语" },
  ];
  const SUPPORTED_LANGUAGE_VALUES = new Set(LANGUAGE_OPTIONS.map((i) => i.value));

  const TOGGLE_LABELS = {
    commandHub: "Command Hub",
    darkMode: "暗黑",
    readerMode: "阅读模式",
    audioNormalize: "音频均衡",
    inputTM: "输入保护",
    pageTranslated: "已整页翻译",
  };

  const TOGGLE_ACTION_STATE_KEYS = Object.freeze({
    TOGGLE_DARK_MODE: "darkMode",
    TOGGLE_READER_MODE: "readerMode",
    AUDIO_NORMALIZE_TOGGLE: "audioNormalize",
    INPUT_TM_TOGGLE: "inputTM",
  });

  const ACTIVE_ACTION_LABELS = Object.freeze({
    ACTIVATE_VISUAL_DICTATOR: "元素消除",
    ACTIVATE_DATA_HARVESTER: "框选提取",
    VAULT_AUTO_SAVE: "密码保存监听",
    PRIVACY_BLOCK_TRACKERS: "追踪器拦截",
    PRIVACY_FINGERPRINT_PROTECT: "指纹保护",
    PRIVACY_WEBRTC_PROTECT: "WebRTC 保护",
    PRIVACY_STRIP_REFERRER: "来源信息保护",
    REVEAL_PASSWORDS: "显示密码",
    HIJACK_EVENTS: "事件监听",
    INTERCEPT_REQUESTS: "请求监听",
    WEBSOCKET_MONITOR: "WebSocket 监听",
    CANVAS_SPOOF: "Canvas 保护",
    YT_SHORTCUTS: "YouTube 快捷键",
    YT_TOGGLE_AD_SKIP: "YouTube 跳过广告",
    YT_TOGGLE_LOOP: "YouTube 循环播放",
    YT_CINEMA_MODE: "YouTube 影院模式",
    TOGGLE_DARK_MODE: "暗黑模式",
    TOGGLE_READER_MODE: "阅读模式",
    BREAK_SEALS: "解除页面限制",
    PAGE_ANNOTATE: "页面标注",
    STICKY_KILL: "膏药清理",
    INPUT_TM_TOGGLE: "输入框保护",
    AUDIO_NORMALIZE_TOGGLE: "音频均衡",
    ELEMENT_PIP: "元素画中画",
    DOM_MONITOR_ADD: "DOM 监控",
    WO_PAGE_TRANSLATE_STATE: "整页翻译",
    OPEN_SCREEN_RECORDER: "屏幕录制",
  });

  const ACTIVE_CONTROL_LABELS = Object.freeze({
    disable: "关闭",
    stop: "停止",
    undo: "撤销",
    restoreAll: "全部恢复",
    manage: "管理",
  });

  const ACTIVE_MANAGE_ACTIONS = Object.freeze({
    ACTIVATE_VISUAL_DICTATOR: "OPEN_DICTATOR_DB",
    VAULT_AUTO_SAVE: "OPEN_VAULT",
    INPUT_TM_TOGGLE: "INPUT_TM_SHOW_HISTORY",
    AUDIO_NORMALIZE_TOGGLE: "AUDIO_NORMALIZE_PANEL",
    DOM_MONITOR_ADD: "DOM_MONITOR_PANEL",
  });

  /* ---------- 状态 ---------- */
  let activeTab = null;
  let pageContext = createEmptyContext();
  let lastWeatherRequest = null;
  let refreshInFlight = null;
  let pendingRefresh = false;
  let commandHubToggleInFlight = false;
  let activeActions = [];
  let activeActionsRevision = 0;
  let activeActionsUpdatedAt = 0;
  let activeActionsRenderKey = "";
  let activeActionsEverShown = false;
  let activePanelVisibilityAnimation = null;
  let activePanelVisibilityGeneration = 0;
  let viewTransitionGeneration = 0;
  let viewTransitionAnimations = [];
  let quickPins = [];
  let quickPersonalOrder = [];
  let quickEditMode = false;
  let quickEditorAnimation = null;
  let quickEditorTransitionGeneration = 0;
  let quickStoreBusy = false;
  let quickDrag = null;
  let quickSuppressClick = false;
  let globalPrivacyState = {
    enabled: false,
    options: cloneDefaultPrivacyOptions(),
    ready: false,
    busy: false,
  };
  let globalPrivacyRequestGeneration = 0;
  let privacyRuleSaveTimer = 0;
  let privacyStatusClearTimer = 0;
  let privacyRulesDirty = false;
  let privacyOptionsAnimation = null;
  let privacyOptionsTransitionGeneration = 0;
  const quickActionBusy = new Set();
  const sideUpdateAnimations = new WeakMap();
  const pageTranslateCache = new Map();

  function createEmptyContext() {
    return {
      selection: "",
      title: "",
      url: "",
      host: "",
      lang: "",
      favIconUrl: "",
      supported: false,
      pageTranslated: false,
      pageTranslateCount: 0,
      pageTranslateSource: "",
      pageTranslateTarget: "",
      toggles: {
        commandHub: false,
        darkMode: false,
        readerMode: false,
        audioNormalize: false,
        inputTM: false,
      },
    };
  }

  /* ---------- 启动 ---------- */
  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    initLanguageSelectors();
    initTabs();
    bindEvents();
    bindChromeEvents();
    loadLocalPrefs();
    await loadGlobalPrivacySettings();
    await loadQuickFavorites();
    await scheduleRefresh();
    updateTranslateCounter();
    maybePrefillSelection();
    maybeAutoLoadWeather();
  }

  function initTabs() {
    const tabs = Array.from(document.querySelectorAll(".wo-tab"));
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => {
        switchSideTab(tab.getAttribute("data-tab"));
      });
      tab.addEventListener("keydown", (event) => {
        let nextIndex = null;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
        if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = tabs.length - 1;
        if (nextIndex == null) return;
        event.preventDefault();
        const nextTab = tabs[nextIndex];
        nextTab.focus();
        switchSideTab(nextTab.getAttribute("data-tab"));
      });
    });
  }

  function switchSideTab(name) {
    const targetName = String(name || "");
    const targetView = document.querySelector(`.wo-view[data-view="${targetName}"]`);
    if (!targetView) return;

    const tabs = Array.from(document.querySelectorAll(".wo-tab"));
    const views = Array.from(document.querySelectorAll(".wo-view"));
    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const visibleViews = captureVisibleViews(views);
    const sourceViews = visibleViews.filter((view) => view !== targetView);

    tabs.forEach((tab) => {
      const selected = tab.getAttribute("data-tab") === targetName;
      tab.classList.toggle("is-active", selected);
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.tabIndex = selected ? 0 : -1;
    });
    views.forEach((view) => {
      const selected = view === targetView;
      view.setAttribute("aria-hidden", selected ? "false" : "true");
      view.inert = !selected;
    });

    viewTransitionGeneration += 1;
    const generation = viewTransitionGeneration;

    if (reduceMotion || (!sourceViews.length && !targetView.hidden)) {
      finishViewTransition(views, targetView);
      return;
    }

    targetView.hidden = false;
    targetView.classList.add("is-active");
    document.querySelector(".wo-side-main").scrollTop = 0;

    const targetStyle = getComputedStyle(targetView);
    const targetWasVisible = visibleViews.includes(targetView);
    const targetFrom = targetWasVisible
      ? {
          opacity: targetStyle.opacity,
          transform: targetStyle.transform === "none" ? "none" : targetStyle.transform,
          filter: targetStyle.filter === "none" ? "blur(0px)" : targetStyle.filter,
        }
      : { opacity: 0, transform: "translate3d(10px, 0, 0)", filter: "blur(.8px)" };

    const animations = [];
    [...sourceViews, targetView].forEach((view) => {
      view.style.willChange = "opacity, transform, filter";
    });

    sourceViews.forEach((sourceView) => {
      const sourceStyle = getComputedStyle(sourceView);
      animations.push(
        sourceView.animate(
          [
            {
              opacity: sourceStyle.opacity,
              transform: sourceStyle.transform === "none" ? "none" : sourceStyle.transform,
              filter: sourceStyle.filter === "none" ? "blur(0px)" : sourceStyle.filter,
            },
            { opacity: 0, transform: "translate3d(-8px, 0, 0)", filter: "blur(.8px)" },
          ],
          { duration: VIEW_TRANSITION_MS, easing: VIEW_TRANSITION_EASING, fill: "both" }
        )
      );
    });

    animations.push(
      targetView.animate(
        [targetFrom, { opacity: 1, transform: "none", filter: "blur(0px)" }],
        { duration: VIEW_TRANSITION_MS, easing: VIEW_TRANSITION_EASING, fill: "both" }
      )
    );
    viewTransitionAnimations = animations;

    Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (generation !== viewTransitionGeneration) return;
      finishViewTransition(views, targetView);
    });
  }

  function captureVisibleViews(views) {
    viewTransitionAnimations.forEach((animation) => {
      try {
        if (typeof animation.commitStyles === "function") animation.commitStyles();
      } catch (_) {}
      animation.cancel();
    });
    viewTransitionAnimations = [];

    const visible = views.filter((view) => !view.hidden);
    visible.forEach((view) => {
      const style = getComputedStyle(view);
      view.style.opacity = style.opacity;
      view.style.transform = style.transform === "none" ? "none" : style.transform;
      view.style.filter = style.filter === "none" ? "blur(0px)" : style.filter;
      view.style.removeProperty("will-change");
    });
    return visible;
  }

  function finishViewTransition(views, targetView) {
    viewTransitionAnimations.forEach((animation) => animation.cancel());
    viewTransitionAnimations = [];
    views.forEach((view) => {
      const selected = view === targetView;
      view.hidden = !selected;
      view.classList.toggle("is-active", selected);
      view.setAttribute("aria-hidden", selected ? "false" : "true");
      view.inert = !selected;
      view.style.removeProperty("opacity");
      view.style.removeProperty("transform");
      view.style.removeProperty("filter");
      view.style.removeProperty("will-change");
    });
  }

  function bindEvents() {
    document.addEventListener("click", async (event) => {
      const activeControl = event.target.closest(".wo-active-control[data-action][data-mode]");
      if (activeControl) {
        event.preventDefault();
        await runActiveActionControl(activeControl);
        return;
      }

      const pageButton = event.target.closest("[data-page]");
      if (pageButton) {
        const page = pageButton.getAttribute("data-page");
        if (!page) return;
        const action = actionClient.findActionByInternalPage(page);
        if (!action) return;
        try {
          await actionClient.executeAction(action, null, { tabId: activeTab && activeTab.id });
        } catch (error) {
          console.warn("[WO Side] Failed to open tool page:", error);
        }
        return;
      }

      const quickRemove = event.target.closest(".wo-quick-remove[data-quick-remove]");
      if (quickRemove) {
        event.preventDefault();
        await removeQuickFavorite(quickRemove.getAttribute("data-quick-remove"));
        return;
      }

      const quickHandle = event.target.closest(".wo-quick-drag-handle");
      if (quickHandle) {
        event.preventDefault();
        return;
      }

      const quickTrigger = event.target.closest(".wo-toggle-chip[data-quick-action]");
      if (quickTrigger) {
        event.preventDefault();
        if (!quickSuppressClick) await runQuickFavorite(quickTrigger);
        return;
      }

      const toggleChip = event.target.closest(".wo-toggle-chip[data-toggle-action]");
      if (toggleChip && !toggleChip.disabled && !toggleChip.classList.contains("is-disabled")) {
        event.preventDefault();
        await togglePageFeature(toggleChip.getAttribute("data-toggle-action"));
        return;
      }
    });

    document.getElementById("woActiveToggle").addEventListener("click", toggleActivePanel);

    document.getElementById("woPrivacyMaster").addEventListener("click", toggleGlobalPrivacy);
    document.getElementById("woPrivacyConfigBtn").addEventListener("click", togglePrivacyOptions);
    document.getElementById("woPrivacyOptions").addEventListener("change", (event) => {
      if (event.target.matches("[data-privacy-option]")) updatePrivacyOption(event.target);
    });
    const privacyRules = document.getElementById("woPrivacyCustomRules");
    privacyRules.addEventListener("input", handlePrivacyRulesInput);
    privacyRules.addEventListener("blur", flushPrivacyCustomRules);

    document.getElementById("woQuickEditBtn").addEventListener("click", toggleQuickEditor);
    document.getElementById("woQuickAddBtn").addEventListener("click", addSelectedQuickFavorite);
    document.getElementById("woQuickAddSelect").addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      addSelectedQuickFavorite();
    });
    document.getElementById("woQuickAddSelect").addEventListener("change", syncQuickAddButton);
    const quickList = document.getElementById("woToggleList");
    quickList.addEventListener("pointerdown", handleQuickDragPointerDown);
    quickList.addEventListener("pointermove", handleQuickDragPointerMove);
    quickList.addEventListener("pointerup", handleQuickDragPointerUp);
    quickList.addEventListener("pointercancel", handleQuickDragPointerCancel);
    quickList.addEventListener("keydown", handleQuickFavoriteKeydown);

    document.getElementById("woHubBtn").addEventListener("click", () =>
      togglePageFeature("TOGGLE_COMMAND_HUB")
    );
    document.getElementById("woHubToolRow").addEventListener("click", () =>
      togglePageFeature("TOGGLE_COMMAND_HUB")
    );

    /* 天气 */
    document.getElementById("weatherSearchBtn").addEventListener("click", () =>
      runWeatherSearch(document.getElementById("weatherQuery").value)
    );
    document.getElementById("weatherRefreshBtn").addEventListener("click", refreshWeather);
    document.getElementById("weatherLocateBtn").addEventListener("click", locateWeather);
    document.getElementById("weatherQuery").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        runWeatherSearch(event.target.value);
      }
    });
    document.getElementById("woSuggestWeather").addEventListener("click", async () => {
      activateTab("weather");
      const q = document.getElementById("weatherQuery").value.trim();
      if (q) await runWeatherSearch(q);
      else await locateWeather();
    });

    /* 翻译 */
    document.getElementById("translateInput").addEventListener("input", () => {
      updateTranslateCounter();
      saveTranslatePrefs();
    });
    document.getElementById("translateSource").addEventListener("change", saveTranslatePrefs);
    document.getElementById("translateTarget").addEventListener("change", saveTranslatePrefs);
    document.getElementById("translateRunBtn").addEventListener("click", runTranslate);
    document.getElementById("translateCopyBtn").addEventListener("click", copyTranslation);
    document.getElementById("translatePageBtn").addEventListener("click", runFullPageTranslate);
    document.getElementById("translateRestoreBtn").addEventListener("click", () =>
      restoreFullPageTranslation()
    );
    document.getElementById("useSelectionBtn").addEventListener("click", fillSelectionIntoTranslator);
    document.getElementById("woSuggestTranslate").addEventListener("click", async () => {
      activateTab("translate");
      if (pageContext.selection.trim()) {
        fillSelectionIntoTranslator();
        await runTranslate();
        return;
      }
      await runFullPageTranslate();
    });
    document.getElementById("swapLanguagesBtn").addEventListener("click", swapTranslateLanguages);
  }

  function bindChromeEvents() {
    chrome.tabs.onActivated.addListener(scheduleRefresh);
    chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
      if (!tab.active) return;
      if (changeInfo.status === "complete" || changeInfo.url) scheduleRefresh();
    });
    if (chrome.windows && chrome.windows.onFocusChanged) {
      chrome.windows.onFocusChanged.addListener((winId) => {
        if (winId !== chrome.windows.WINDOW_ID_NONE) scheduleRefresh();
      });
    }
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== "WO_ACTIVE_ACTIONS_UPDATED") return;
      const messageTabId = Number(message.tabId != null ? message.tabId : message.data && message.data.tabId);
      if (!activeTab || (Number.isInteger(messageTabId) && messageTabId !== activeTab.id)) return;
      const nextActions = extractActiveActions(message.snapshot || message.data || message);
      if (nextActions) applyActiveActions(nextActions, message.snapshot || message.data || message);
    });
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      const pinsChange = changes[HUB_PINS_STORAGE_KEY];
      const orderChange = changes[HUB_PERSONAL_ORDER_STORAGE_KEY];
      const privacyChange = changes[GLOBAL_PRIVACY_STORAGE_KEY];
      if (privacyChange && !globalPrivacyState.busy) {
        applyStoredGlobalPrivacySettings(privacyChange.newValue);
      }
      if (!pinsChange && !orderChange) return;

      const nextPins = pinsChange ? sanitizeQuickPins(pinsChange.newValue) : quickPins.slice();
      const nextOrder = orderChange
        ? sanitizeQuickPersonalOrder(orderChange.newValue)
        : quickPersonalOrder.slice();
      applyQuickFavoriteStore(nextPins, nextOrder, {
        preserveFocus: true,
        render: !quickStoreBusy,
      });
    });
  }

  function activateTab(name) {
    switchSideTab(name);
  }

  function initLanguageSelectors() {
    const sourceSelect = document.getElementById("translateSource");
    const targetSelect = document.getElementById("translateTarget");
    sourceSelect.innerHTML = LANGUAGE_OPTIONS.map(
      (i) => `<option value="${escapeHtml(i.value)}">${escapeHtml(i.label)}</option>`
    ).join("");
    targetSelect.innerHTML = LANGUAGE_OPTIONS
      .filter((i) => i.value !== "auto")
      .map((i) => `<option value="${escapeHtml(i.value)}">${escapeHtml(i.label)}</option>`)
      .join("");
  }

  function loadLocalPrefs() {
    try {
      const w = localStorage.getItem(WEATHER_QUERY_STORAGE_KEY);
      if (w) document.getElementById("weatherQuery").value = w;
    } catch (_) {}

    try {
      const raw = localStorage.getItem(TRANSLATE_PREFS_STORAGE_KEY);
      if (!raw) {
        document.getElementById("translateSource").value = "auto";
        document.getElementById("translateTarget").value = "zh-CN";
        return;
      }
      const prefs = JSON.parse(raw);
      const source = SUPPORTED_LANGUAGE_VALUES.has(prefs.source) ? prefs.source : "auto";
      const target =
        SUPPORTED_LANGUAGE_VALUES.has(prefs.target) && prefs.target !== "auto"
          ? prefs.target
          : "zh-CN";
      document.getElementById("translateSource").value = source;
      document.getElementById("translateTarget").value = target;
      if (typeof prefs.input === "string") {
        document.getElementById("translateInput").value = prefs.input;
      }
    } catch (_) {
      document.getElementById("translateSource").value = "auto";
      document.getElementById("translateTarget").value = "zh-CN";
    }
  }

  function saveTranslatePrefs() {
    const payload = {
      source: document.getElementById("translateSource").value,
      target: document.getElementById("translateTarget").value,
      input: document.getElementById("translateInput").value.slice(0, 500),
    };
    try {
      localStorage.setItem(TRANSLATE_PREFS_STORAGE_KEY, JSON.stringify(payload));
    } catch (_) {}
  }

  /* ---------- 全局一键隐私 ---------- */
  function cloneDefaultPrivacyOptions() {
    return {
      blockTrackers: GLOBAL_PRIVACY_DEFAULTS.blockTrackers,
      fingerprintProtection: GLOBAL_PRIVACY_DEFAULTS.fingerprintProtection,
      webrtcProtection: GLOBAL_PRIVACY_DEFAULTS.webrtcProtection,
      stripReferrer: GLOBAL_PRIVACY_DEFAULTS.stripReferrer,
      pageShield: GLOBAL_PRIVACY_DEFAULTS.pageShield,
      adBlocking: GLOBAL_PRIVACY_DEFAULTS.adBlocking,
      youtubeCompatibility: GLOBAL_PRIVACY_DEFAULTS.youtubeCompatibility,
      customAdSelectors: [],
    };
  }

  function isValidPrivacySelector(selector) {
    if (!selector || selector.length > PRIVACY_SELECTOR_LENGTH_LIMIT) return false;
    if (/[\u0000-\u001f\u007f]/.test(selector)
      || /javascript\s*:/i.test(selector)
      || /^\/.+\/[dgimsuvy]*$/.test(selector)
      || selector.includes(",")
      || selector.includes(":")
      || selector.includes("*")
      || !/[.#\[]/.test(selector)
      || /(?:^|[\s>+~])(?:html|body)(?:$|[\s>+~.#\[])/i.test(selector)
      || /(?:web-omni|#wo-|\.wo-|data-wo-)/i.test(selector)) return false;
    const combinators = selector.match(/[>+~]|\s+/g);
    if (combinators && combinators.length > 8) return false;
    try {
      document.createDocumentFragment().querySelector(selector);
      return true;
    } catch (_) {
      return false;
    }
  }

  function normalizePrivacyRuleDomain(value) {
    const domain = String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (domain === "*") return domain;
    if (!domain || domain.length > 253 || /[:/\\\s]/.test(domain) || domain.includes("..")) return null;
    const base = domain.startsWith("*.") ? domain.slice(2) : domain;
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(base)) return null;
    return base.split(".").every((label) => (
      label && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-")
    )) ? domain : null;
  }

  function normalizePrivacyRule(value) {
    if (value && typeof value === "object" && typeof value.selector === "string") {
      const domain = normalizePrivacyRuleDomain(value.domain || value.hostname || "*");
      const selector = value.selector.trim();
      return domain && isValidPrivacySelector(selector) ? { domain, selector } : null;
    }
    const line = String(value || "").trim();
    if (!line) return null;
    const separator = line.indexOf("::");
    if (separator < 0) return isValidPrivacySelector(line) ? line : null;
    const domain = normalizePrivacyRuleDomain(line.slice(0, separator));
    const selector = line.slice(separator + 2).trim();
    return domain && isValidPrivacySelector(selector) ? { domain, selector } : null;
  }

  function formatPrivacyRule(rule) {
    return rule && typeof rule === "object"
      ? `${rule.domain || "*"} :: ${rule.selector || ""}`
      : String(rule || "");
  }

  function parsePrivacySelectors(raw) {
    const source = Array.isArray(raw) ? raw : String(raw || "").split(/\r?\n/);
    const selectors = [];
    const seen = new Set();
    let invalidCount = 0;
    let overflowCount = 0;

    source.forEach((value) => {
      if (typeof value === "string" && !value.trim()) return;
      const rule = normalizePrivacyRule(value);
      if (!rule) {
        invalidCount += 1;
        return;
      }
      const key = formatPrivacyRule(rule);
      if (seen.has(key)) return;
      if (selectors.length >= PRIVACY_SELECTOR_LIMIT) {
        overflowCount += 1;
        return;
      }
      seen.add(key);
      selectors.push(rule);
    });

    return { selectors, invalidCount, overflowCount };
  }

  function sanitizePrivacyOptions(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const options = cloneDefaultPrivacyOptions();
    Object.keys(options).forEach((key) => {
      if (key === "customAdSelectors") return;
      if (typeof source[key] === "boolean") options[key] = source[key];
    });
    options.customAdSelectors = parsePrivacySelectors(source.customAdSelectors).selectors;
    return options;
  }

  function sanitizeGlobalPrivacySettings(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    return {
      enabled: Boolean(source.enabled != null ? source.enabled : source.active),
      options: sanitizePrivacyOptions(source.options || source),
    };
  }

  async function loadGlobalPrivacySettings() {
    try {
      const stored = await chrome.storage.local.get([GLOBAL_PRIVACY_STORAGE_KEY]);
      applyStoredGlobalPrivacySettings(stored[GLOBAL_PRIVACY_STORAGE_KEY]);
    } catch (error) {
      globalPrivacyState.ready = true;
      renderGlobalPrivacyPanel();
      setPrivacyStatus("隐私设置读取失败，本次仍可手动配置。", "error");
      console.warn("[WO Side] Failed to load privacy settings:", error);
    }
  }

  function applyStoredGlobalPrivacySettings(raw) {
    const settings = sanitizeGlobalPrivacySettings(raw);
    globalPrivacyRequestGeneration += 1;
    globalPrivacyState.enabled = settings.enabled;
    globalPrivacyState.options = settings.options;
    globalPrivacyState.ready = true;
    renderGlobalPrivacyPanel();
  }

  function countEnabledPrivacyOptions(options) {
    return Object.entries(options || {}).filter(
      ([key, value]) => !["customAdSelectors", "youtubeCompatibility"].includes(key) && value === true
    ).length;
  }

  function renderGlobalPrivacyPanel() {
    const card = document.getElementById("woPrivacyCard");
    const master = document.getElementById("woPrivacyMaster");
    const config = document.getElementById("woPrivacyConfigBtn");
    const summary = document.getElementById("woPrivacySummary");
    const rulesInput = document.getElementById("woPrivacyCustomRules");
    const optionCount = countEnabledPrivacyOptions(globalPrivacyState.options);
    const ruleCount = globalPrivacyState.options.customAdSelectors.length;

    card.classList.toggle("is-enabled", globalPrivacyState.enabled);
    card.setAttribute("aria-busy", globalPrivacyState.busy ? "true" : "false");
    master.setAttribute("aria-checked", globalPrivacyState.enabled ? "true" : "false");
    master.classList.toggle("is-busy", globalPrivacyState.busy);
    master.disabled = !globalPrivacyState.ready || globalPrivacyState.busy;
    config.disabled = !globalPrivacyState.ready;
    summary.textContent = globalPrivacyState.busy
      ? "正在更新隐私设置…"
      : (globalPrivacyState.enabled
          ? `已开启 · ${optionCount} 项保护`
          : `已关闭 · 已选择 ${optionCount} 项`);

    document.querySelectorAll("[data-privacy-option]").forEach((input) => {
      const key = input.getAttribute("data-privacy-option");
      input.checked = Boolean(globalPrivacyState.options[key]);
      input.disabled = !globalPrivacyState.ready || globalPrivacyState.busy;
    });

    if (!privacyRulesDirty && document.activeElement !== rulesInput) {
      rulesInput.value = globalPrivacyState.options.customAdSelectors.map(formatPrivacyRule).join("\n");
    }
    rulesInput.disabled = !globalPrivacyState.ready || globalPrivacyState.busy;
    document.getElementById("woPrivacyRuleCount").textContent = `${ruleCount} 条`;
  }

  function setPrivacyStatus(message, tone) {
    const status = document.getElementById("woPrivacyStatus");
    const optionsExpanded = !document.getElementById("woPrivacyOptions").hidden;
    if (privacyStatusClearTimer) {
      clearTimeout(privacyStatusClearTimer);
      privacyStatusClearTimer = 0;
    }
    status.textContent = tone === "error" || optionsExpanded ? String(message || "") : "";
    status.classList.toggle("is-error", tone === "error");
    if (status.textContent) {
      privacyStatusClearTimer = setTimeout(() => {
        status.textContent = "";
        status.classList.remove("is-error");
        privacyStatusClearTimer = 0;
      }, tone === "error" ? 5200 : 3200);
    }
  }

  function togglePrivacyOptions() {
    const button = document.getElementById("woPrivacyConfigBtn");
    const options = document.getElementById("woPrivacyOptions");
    const expanded = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", expanded ? "true" : "false");
    privacyOptionsTransitionGeneration += 1;
    const generation = privacyOptionsTransitionGeneration;
    const reduceMotion = Boolean(
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );

    const currentFrame = options.hidden
      ? {
          height: 0,
          opacity: 0,
          transform: "translate3d(0, -4px, 0)",
          filter: "blur(.6px)",
        }
      : capturePrivacyOptionsFrame(options);

    if (privacyOptionsAnimation) {
      privacyOptionsAnimation.cancel();
      privacyOptionsAnimation = null;
    }

    options.hidden = false;
    options.inert = !expanded;
    options.setAttribute("aria-hidden", expanded ? "false" : "true");
    clearPrivacyOptionsAnimationStyles(options);

    if (reduceMotion || typeof options.animate !== "function") {
      finishPrivacyOptionsTransition(options, expanded, generation);
      return;
    }

    const expandedHeight = options.getBoundingClientRect().height;
    const targetFrame = expanded
      ? {
          height: `${expandedHeight}px`,
          opacity: 1,
          transform: "translate3d(0, 0, 0)",
          filter: "blur(0px)",
        }
      : {
          height: "0px",
          opacity: 0,
          transform: "translate3d(0, -4px, 0)",
          filter: "blur(.6px)",
        };
    const startFrame = {
      height: `${Math.max(0, currentFrame.height)}px`,
      opacity: currentFrame.opacity,
      transform: currentFrame.transform,
      filter: currentFrame.filter,
    };

    Object.assign(options.style, {
      height: startFrame.height,
      opacity: String(startFrame.opacity),
      transform: startFrame.transform,
      filter: startFrame.filter,
      overflow: "hidden",
      willChange: "height, opacity, transform, filter",
    });

    const animation = options.animate(
      [startFrame, targetFrame],
      { duration: VIEW_TRANSITION_MS, easing: VIEW_TRANSITION_EASING, fill: "both" }
    );
    privacyOptionsAnimation = animation;
    animation.finished.then(() => {
      if (generation !== privacyOptionsTransitionGeneration || privacyOptionsAnimation !== animation) return;
      privacyOptionsAnimation = null;
      animation.cancel();
      finishPrivacyOptionsTransition(options, expanded, generation);
    }).catch(() => {});
  }

  function capturePrivacyOptionsFrame(options) {
    const style = getComputedStyle(options);
    return {
      height: options.getBoundingClientRect().height,
      opacity: Number.parseFloat(style.opacity) || 0,
      transform: style.transform === "none" ? "translate3d(0, 0, 0)" : style.transform,
      filter: style.filter === "none" ? "blur(0px)" : style.filter,
    };
  }

  function finishPrivacyOptionsTransition(options, expanded, generation) {
    if (generation !== privacyOptionsTransitionGeneration) return;
    options.hidden = !expanded;
    options.inert = !expanded;
    options.setAttribute("aria-hidden", expanded ? "false" : "true");
    clearPrivacyOptionsAnimationStyles(options);
  }

  function clearPrivacyOptionsAnimationStyles(options) {
    ["height", "opacity", "transform", "filter", "overflow", "will-change"]
      .forEach((name) => options.style.removeProperty(name));
  }

  function consumePrivacyRulesInput() {
    const input = document.getElementById("woPrivacyCustomRules");
    const parsed = parsePrivacySelectors(input.value);
    if (privacyRuleSaveTimer) {
      clearTimeout(privacyRuleSaveTimer);
      privacyRuleSaveTimer = 0;
    }
    privacyRulesDirty = false;
    globalPrivacyState.options = {
      ...globalPrivacyState.options,
      customAdSelectors: parsed.selectors,
    };
    renderGlobalPrivacyPanel();
    return parsed;
  }

  function handlePrivacyRulesInput() {
    privacyRulesDirty = true;
    const parsed = parsePrivacySelectors(document.getElementById("woPrivacyCustomRules").value);
    document.getElementById("woPrivacyRuleCount").textContent = `${parsed.selectors.length} 条`;
    if (privacyRuleSaveTimer) clearTimeout(privacyRuleSaveTimer);
    privacyRuleSaveTimer = setTimeout(flushPrivacyCustomRules, 600);
  }

  async function flushPrivacyCustomRules() {
    if (!privacyRulesDirty) return;
    const parsed = consumePrivacyRulesInput();
    const dropped = parsed.invalidCount + parsed.overflowCount;
    const message = dropped
      ? `已保留 ${parsed.selectors.length} 条有效规则，忽略 ${dropped} 条无效或超限规则。`
      : `已保存 ${parsed.selectors.length} 条自定义广告规则。`;

    if (globalPrivacyState.enabled) {
      await runGlobalPrivacyAction("enable", globalPrivacyState.options, message);
      return;
    }
    const saved = await persistGlobalPrivacySettings();
    setPrivacyStatus(saved ? `${message} 开启总开关后生效。` : "自定义规则保存失败。", saved ? "" : "error");
  }

  async function updatePrivacyOption(input) {
    if (globalPrivacyState.busy) {
      renderGlobalPrivacyPanel();
      return;
    }
    if (privacyRulesDirty) consumePrivacyRulesInput();
    const key = input.getAttribute("data-privacy-option");
    if (!Object.prototype.hasOwnProperty.call(GLOBAL_PRIVACY_DEFAULTS, key)) return;
    globalPrivacyState.options = {
      ...globalPrivacyState.options,
      [key]: Boolean(input.checked),
    };
    renderGlobalPrivacyPanel();

    const compatibilityMessage = key === "youtubeCompatibility"
      ? (input.checked
          ? "YouTube 兼容模式已开启，通用追踪拦截与广告 DOM 清理不会作用于 YouTube。"
          : "YouTube 兼容模式已关闭；通用拦截可能触发网站提示或影响播放。")
      : null;

    if (globalPrivacyState.enabled) {
      const applied = await runGlobalPrivacyAction(
        "enable",
        globalPrivacyState.options,
        compatibilityMessage || "隐私项目已更新并应用。"
      );
      if (applied && key === "youtubeCompatibility" && !input.checked) {
        setPrivacyStatus(compatibilityMessage, "error");
      }
      return;
    }
    const saved = await persistGlobalPrivacySettings();
    setPrivacyStatus(
      saved
        ? `${compatibilityMessage || "配置已保存。"} 开启总开关后生效。`
        : "隐私配置保存失败。",
      !saved || (key === "youtubeCompatibility" && !input.checked) ? "error" : ""
    );
  }

  async function toggleGlobalPrivacy() {
    if (!globalPrivacyState.ready || globalPrivacyState.busy) return;
    if (privacyRulesDirty) consumePrivacyRulesInput();
    const mode = globalPrivacyState.enabled ? "disable" : "enable";
    await runGlobalPrivacyAction(
      mode,
      globalPrivacyState.options,
      mode === "enable" ? "一键隐私已在普通网页启用。" : "一键隐私已关闭。"
    );
  }

  function extractGlobalPrivacyResult(response, fallbackEnabled, fallbackOptions) {
    const responseData = response && response.data && typeof response.data === "object"
      ? response.data
      : {};
    const source = responseData.settings || responseData.state || responseData.globalPrivacy || responseData;
    const enabledValue = source.enabled != null ? source.enabled : source.active;
    return {
      enabled: typeof enabledValue === "boolean" ? enabledValue : Boolean(fallbackEnabled),
      options: source.options
        ? sanitizePrivacyOptions(source.options)
        : sanitizePrivacyOptions(fallbackOptions),
    };
  }

  async function runGlobalPrivacyAction(mode, options, successMessage) {
    if (!activeTab || !Number.isInteger(activeTab.id)) {
      setPrivacyStatus("当前没有可用标签页。", "error");
      return false;
    }

    const targetEnabled = mode === "enable";
    const safeOptions = sanitizePrivacyOptions(options);
    const requestGeneration = ++globalPrivacyRequestGeneration;
    globalPrivacyState.busy = true;
    renderGlobalPrivacyPanel();
    setPrivacyStatus(mode === "enable" ? "正在应用隐私设置…" : "正在关闭隐私设置…");

    try {
      const response = await actionClient.executeAction(
        "GLOBAL_PRIVACY_MODE",
        { mode, options: safeOptions },
        { tabId: activeTab.id }
      );
      if (requestGeneration !== globalPrivacyRequestGeneration) return false;
      const next = extractGlobalPrivacyResult(response, targetEnabled, safeOptions);
      globalPrivacyState.enabled = next.enabled;
      globalPrivacyState.options = next.options;
      const saved = await persistGlobalPrivacySettings();
      const failedCount = response && response.data && Array.isArray(response.data.failedTabs)
        ? response.data.failedTabs.length
        : 0;
      const resultMessage = failedCount
        ? `设置已保存，${failedCount} 个标签页应用失败。`
        : (saved ? successMessage : "设置已应用，本地配置保存失败。");
      setPrivacyStatus(resultMessage, failedCount || !saved ? "error" : "");
      return true;
    } catch (error) {
      if (requestGeneration !== globalPrivacyRequestGeneration) return false;
      console.warn("[WO Side] Global privacy action failed:", error);
      setPrivacyStatus(error && error.message ? error.message : "隐私设置应用失败，请重试。", "error");
      return false;
    } finally {
      if (requestGeneration === globalPrivacyRequestGeneration) {
        globalPrivacyState.busy = false;
        renderGlobalPrivacyPanel();
      }
    }
  }

  async function refreshGlobalPrivacyStatus() {
    if (
      !globalPrivacyState.ready ||
      globalPrivacyState.busy ||
      !activeTab ||
      !Number.isInteger(activeTab.id)
    ) {
      return;
    }
    const requestGeneration = ++globalPrivacyRequestGeneration;
    try {
      const response = await actionClient.sendAction(
        "GLOBAL_PRIVACY_MODE",
        { mode: "status", options: globalPrivacyState.options },
        { tabId: activeTab.id }
      );
      if (requestGeneration !== globalPrivacyRequestGeneration) return;
      if (!response || !response.ok) {
        const code = response && response.error && response.error.code;
        if (code === "RESTRICTED_URL" || code === "UNSUPPORTED_CONTEXT") {
          setPrivacyStatus("当前页面受限，设置仍会用于普通网页。");
        }
        return;
      }
      const next = extractGlobalPrivacyResult(
        response,
        globalPrivacyState.enabled,
        globalPrivacyState.options
      );
      globalPrivacyState.enabled = next.enabled;
      globalPrivacyState.options = next.options;
      renderGlobalPrivacyPanel();
    } catch (error) {
      console.warn("[WO Side] Failed to read global privacy status:", error);
    }
  }

  async function persistGlobalPrivacySettings() {
    try {
      const stored = await chrome.storage.local.get([GLOBAL_PRIVACY_STORAGE_KEY]);
      const previous = stored[GLOBAL_PRIVACY_STORAGE_KEY];
      await chrome.storage.local.set({
        [GLOBAL_PRIVACY_STORAGE_KEY]: {
          ...(previous && typeof previous === "object" ? previous : {}),
          version: 2,
          enabled: globalPrivacyState.enabled,
          options: sanitizePrivacyOptions(globalPrivacyState.options),
          updatedAt: Date.now(),
        },
      });
      return true;
    } catch (error) {
      console.warn("[WO Side] Failed to save privacy settings:", error);
      return false;
    }
  }

  /* ---------- 当前页状态 ---------- */
  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }

  function isRestrictedTab(tab) {
    if (!tab || typeof tab.id !== "number") return true;
    if (sharedRegistry && typeof sharedRegistry.isRestrictedUrl === "function") {
      return sharedRegistry.isRestrictedUrl(tab.url);
    }
    const url = String(tab.url || "");
    return RESTRICTED_PREFIXES.some((p) => url.startsWith(p));
  }

  function scheduleRefresh() {
    if (refreshInFlight) {
      pendingRefresh = true;
      return refreshInFlight;
    }
    refreshInFlight = (async () => {
      try {
        const nextTab = await getActiveTab();
        if (!activeTab || !nextTab || activeTab.id !== nextTab.id) {
          activeActions = [];
          activeActionsRevision = 0;
          activeActionsUpdatedAt = 0;
          activeActionsRenderKey = "";
          renderActiveActions();
        }
        activeTab = nextTab;
        await refreshPageState();
        await refreshActiveActions();
        await refreshGlobalPrivacyStatus();
      } finally {
        refreshInFlight = null;
        if (pendingRefresh) {
          pendingRefresh = false;
          scheduleRefresh();
        }
      }
    })();
    return refreshInFlight;
  }

  async function refreshPageState() {
    const status = document.getElementById("woPageStatus");

    if (isRestrictedTab(activeTab)) {
      pageContext = createEmptyContext();
      pageContext.url = activeTab ? String(activeTab.url || "") : "";
      pageContext.title = activeTab ? String(activeTab.title || "受限页面") : "受限页面";
      pageContext.host = extractHost(pageContext.url) || "—";
      if (status) {
        status.textContent = "受限";
        status.className = "wo-pill is-block";
      }
      syncQuickFavoriteStates();
      renderPageSnapshot();
      syncTranslatePanelState();
      renderSuggestions();
      return;
    }

    let state = {
      commandHub: false,
      darkMode: false,
      readerMode: false,
      audioNormalize: false,
      inputTM: false,
      selection: "",
      title: activeTab.title || "",
      url: activeTab.url || "",
      lang: "",
      supported: true,
      pageTranslated: false,
      pageTranslateCount: 0,
      pageTranslateSource: "",
      pageTranslateTarget: "",
    };

    try {
      const storage = await chrome.storage.local.get([INPUT_TM_STORAGE_KEY]);
      state.inputTM = Boolean(storage[INPUT_TM_STORAGE_KEY]);

      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: () => {
          const overlay = document.getElementById("web-omni-command-hub-overlay");
          const selection = (() => {
            try {
              return String(window.getSelection ? window.getSelection() : "")
                .trim()
                .slice(0, 320);
            } catch (e) {
              return "";
            }
          })();
          const commandHubState = overlay ? String(overlay.dataset.woHubState || "") : "";
          return {
            commandHub: Boolean(
              overlay &&
                (
                  commandHubState === "open" ||
                  commandHubState === "opening" ||
                  (
                    !commandHubState &&
                    window.getComputedStyle(overlay).display !== "none" &&
                    overlay.style.display !== "none"
                  )
                )
            ),
            commandHubState,
            darkMode: document.documentElement.classList.contains("web-omni-force-dark"),
            readerMode: document.body.classList.contains("web-omni-reader-mode"),
            audioNormalize: Boolean(
              window.webOmniAudioNormState && window.webOmniAudioNormState.active
            ),
            selection,
            title: document.title || "",
            url: location.href,
            lang: document.documentElement.lang || navigator.language || "",
            pageTranslated: Boolean(
              window.webOmniPageTranslatorState && window.webOmniPageTranslatorState.active
            ),
            pageTranslateCount:
              Number(
                window.webOmniPageTranslatorState && window.webOmniPageTranslatorState.translatedCount
              ) || 0,
            pageTranslateSource: String(
              (window.webOmniPageTranslatorState && window.webOmniPageTranslatorState.sourceLang) ||
                ""
            ),
            pageTranslateTarget: String(
              (window.webOmniPageTranslatorState && window.webOmniPageTranslatorState.targetLang) ||
                ""
            ),
          };
        },
      });
      state = { ...state, ...((results[0] && results[0].result) || {}) };
    } catch (error) {
      console.warn("[WO Side] Failed to read page state:", error);
      state.supported = false;
    }

    pageContext = {
      selection: String(state.selection || ""),
      title: String(state.title || activeTab.title || ""),
      url: String(state.url || activeTab.url || ""),
      host: extractHost(state.url || activeTab.url || ""),
      lang: String(state.lang || ""),
      favIconUrl: String(activeTab.favIconUrl || ""),
      supported: Boolean(state.supported),
      pageTranslated: Boolean(state.pageTranslated),
      pageTranslateCount: Number(state.pageTranslateCount) || 0,
      pageTranslateSource: String(state.pageTranslateSource || ""),
      pageTranslateTarget: String(state.pageTranslateTarget || ""),
      toggles: {
        commandHub: Boolean(state.commandHub),
        darkMode: Boolean(state.darkMode),
        readerMode: Boolean(state.readerMode),
        audioNormalize: Boolean(state.audioNormalize),
        inputTM: Boolean(state.inputTM),
      },
    };

    if (status) {
      if (state.supported) {
        status.textContent = "已连接";
        status.className = "wo-pill is-ok";
      } else {
        status.textContent = "读取失败";
        status.className = "wo-pill is-block";
      }
    }

    syncQuickFavoriteStates();
    renderPageSnapshot();
    adaptTranslateTargetFromContext();
    syncTranslatePanelState();
    renderSuggestions();
  }

  async function refreshActiveActions() {
    if (!activeTab || !Number.isInteger(activeTab.id)) {
      applyActiveActions([], { revision: activeActionsRevision + 1 });
      return;
    }

    const requestedTabId = activeTab.id;
    try {
      const response = await actionClient.sendAction("WO_ACTIVE_ACTIONS_GET", null, {
        tabId: requestedTabId,
      });
      if (!activeTab || activeTab.id !== requestedTabId) return;
      if (!response || !response.ok) {
        applyActiveActions([], { revision: activeActionsRevision + 1 });
        return;
      }
      applyActiveActions(extractActiveActions(response.data) || [], response.data || response);
    } catch (error) {
      console.warn("[WO Side] Failed to read active actions:", error);
      if (activeTab && activeTab.id === requestedTabId) {
        applyActiveActions([], { revision: activeActionsRevision + 1 });
      }
    }
  }

  function extractActiveActions(source) {
    if (Array.isArray(source)) return source;
    if (!source || typeof source !== "object") return null;
    if (Array.isArray(source.actions)) return source.actions;
    if (Array.isArray(source.activeActions)) return source.activeActions;
    if (source.snapshot) return extractActiveActions(source.snapshot);
    if (source.actions && typeof source.actions === "object") {
      return Object.entries(source.actions).map(([action, state]) => ({
        action,
        ...(state && typeof state === "object" ? state : { active: Boolean(state) }),
      }));
    }
    if (source.data) return extractActiveActions(source.data);
    return null;
  }

  function applyActiveActions(items, source) {
    const list = Array.isArray(items) ? items : [];
    const sourceRevision = Number(source && source.revision) || 0;
    const sourceUpdatedAt = Math.max(
      Number(source && source.updatedAt) || 0,
      ...list.map((item) => Number(item && item.updatedAt) || 0)
    );
    if (
      sourceUpdatedAt < activeActionsUpdatedAt ||
      (sourceUpdatedAt === activeActionsUpdatedAt && sourceRevision && sourceRevision < activeActionsRevision)
    ) return;
    const revision = sourceRevision || activeActionsRevision + 1;
    activeActionsRevision = Math.max(activeActionsRevision, revision);
    activeActionsUpdatedAt = Math.max(activeActionsUpdatedAt, sourceUpdatedAt);
    const normalizedItems = list
      .filter((item) => item && typeof item.action === "string")
      .map((item) => ({ ...item }));
    const nextActiveActions = normalizedItems
      .filter(
        (item) =>
          item.active !== false ||
          Number(item.reversibleCount) > 0 ||
          ["recoverable", "monitoring", "recording", "paused", "selecting", "starting", "stopping"].includes(
            item.phase
          )
      );
    const nextRenderKey = nextActiveActions.map((item) => [
      item.action,
      item.active !== false ? 1 : 0,
      item.phase || "",
      Number(item.count) || 0,
      Number(item.reversibleCount) || 0,
      item.scope || "",
      item.error || "",
    ].join(":")).join("|");
    const activeSurfaceChanged = nextRenderKey !== activeActionsRenderKey;
    activeActions = nextActiveActions;
    activeActionsRenderKey = nextRenderKey;

    syncToggleStateFromActiveActions(normalizedItems);
    if (activeSurfaceChanged) {
      renderActiveActions();
      renderPageSnapshot();
    }
  }

  function syncToggleStateFromActiveActions(states) {
    Object.entries(TOGGLE_ACTION_STATE_KEYS).forEach(([action, stateKey]) => {
      const state = states.find((item) => item.action === action);
      pageContext.toggles[stateKey] = state ? state.active !== false : false;
    });
    syncQuickFavoriteStates();
  }

  function renderActiveActions() {
    const panel = document.getElementById("woActivePanel");
    const toggle = document.getElementById("woActiveToggle");
    const count = document.getElementById("woActiveCount");
    const list = document.getElementById("woActiveList");
    if (!panel || !toggle || !count || !list) return;

    count.textContent = String(activeActions.length);
    if (!activeActions.length) {
      document.getElementById("woActiveStatus").textContent = "";
      transitionActivePanelVisibility(panel, false);
      return;
    }

    if (!activeActionsEverShown) {
      activeActionsEverShown = true;
      panel.classList.remove("is-collapsed");
      toggle.setAttribute("aria-expanded", "true");
    }

    list.innerHTML = activeActions.map(renderActiveActionRow).join("");
    transitionActivePanelVisibility(panel, true);
  }

  function transitionActivePanelVisibility(panel, visible) {
    if (!panel) return;
    if (!activePanelVisibilityAnimation && panel.hidden === !visible) {
      panel.inert = !visible;
      panel.setAttribute("aria-hidden", visible ? "false" : "true");
      if (!visible) document.getElementById("woActiveList").innerHTML = "";
      return;
    }

    activePanelVisibilityGeneration += 1;
    const generation = activePanelVisibilityGeneration;
    const reduceMotion = Boolean(
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
    const current = panel.hidden
      ? { height: 0, marginTop: -8, opacity: 0, transform: "translate3d(0, -5px, 0)", filter: "blur(.7px)" }
      : captureActivePanelFrame(panel);

    if (activePanelVisibilityAnimation) {
      activePanelVisibilityAnimation.cancel();
      activePanelVisibilityAnimation = null;
    }
    panel.hidden = false;
    panel.inert = !visible;
    panel.setAttribute("aria-hidden", visible ? "false" : "true");
    clearActivePanelAnimationStyles(panel);

    if (reduceMotion || typeof panel.animate !== "function") {
      settleActivePanelVisibility(panel, visible, generation);
      return;
    }

    const naturalHeight = panel.getBoundingClientRect().height;
    const target = visible
      ? { height: `${naturalHeight}px`, marginTop: "0px", opacity: 1, transform: "translate3d(0, 0, 0)", filter: "blur(0px)" }
      : { height: "0px", marginTop: "-8px", opacity: 0, transform: "translate3d(0, -5px, 0)", filter: "blur(.7px)" };
    const start = {
      height: `${Math.max(0, current.height)}px`,
      marginTop: `${current.marginTop}px`,
      opacity: current.opacity,
      transform: current.transform,
      filter: current.filter,
    };

    Object.assign(panel.style, {
      height: start.height,
      marginTop: start.marginTop,
      opacity: String(start.opacity),
      transform: start.transform,
      filter: start.filter,
      overflow: "hidden",
      willChange: "height, margin, opacity, transform, filter",
    });
    const animation = panel.animate(
      [start, target],
      { duration: VIEW_TRANSITION_MS, easing: VIEW_TRANSITION_EASING, fill: "both" }
    );
    activePanelVisibilityAnimation = animation;
    animation.finished.then(() => {
      if (
        generation !== activePanelVisibilityGeneration ||
        activePanelVisibilityAnimation !== animation
      ) return;
      activePanelVisibilityAnimation = null;
      animation.cancel();
      settleActivePanelVisibility(panel, visible, generation);
    }).catch(() => {});
  }

  function captureActivePanelFrame(panel) {
    const style = getComputedStyle(panel);
    const opacity = Number.parseFloat(style.opacity);
    const marginTop = Number.parseFloat(style.marginTop);
    return {
      height: panel.getBoundingClientRect().height,
      marginTop: Number.isFinite(marginTop) ? marginTop : 0,
      opacity: Number.isFinite(opacity) ? opacity : 1,
      transform: style.transform === "none" ? "translate3d(0, 0, 0)" : style.transform,
      filter: style.filter === "none" ? "blur(0px)" : style.filter,
    };
  }

  function settleActivePanelVisibility(panel, visible, generation) {
    if (generation !== activePanelVisibilityGeneration) return;
    panel.hidden = !visible;
    panel.inert = !visible;
    panel.setAttribute("aria-hidden", visible ? "false" : "true");
    clearActivePanelAnimationStyles(panel);
    if (!visible) document.getElementById("woActiveList").innerHTML = "";
  }

  function clearActivePanelAnimationStyles(panel) {
    ["height", "margin-top", "opacity", "transform", "filter", "overflow", "will-change"]
      .forEach((name) => panel.style.removeProperty(name));
  }

  function renderActiveActionRow(item) {
    const action = String(item.action || "");
    const title = getActiveActionLabel(item);
    const details = getActiveActionDetails(item);
    const controls = normalizeActiveControls(item);
    const controlsHtml = controls
      .map(
        (control) =>
          `<button class="wo-active-control" type="button" data-action="${escapeHtml(action)}" data-mode="${escapeHtml(
            control.mode
          )}">${escapeHtml(control.label)}</button>`
      )
      .join("");

    return `<div class="wo-active-row" data-active-action="${escapeHtml(action)}">
      <span class="wo-active-copy">
        <strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong>
        <small title="${escapeHtml(details)}">${escapeHtml(details)}</small>
      </span>
      <span class="wo-active-controls">${controlsHtml}</span>
    </div>`;
  }

  function normalizeActiveControls(item) {
    const entry = sharedRegistry && typeof sharedRegistry.getAction === "function"
      ? sharedRegistry.getAction(item.action)
      : null;
    const raw = item.controls != null ? item.controls : entry && entry.controls;
    let controls = [];

    if (Array.isArray(raw)) controls = [...raw];
    else if (typeof raw === "string") controls = [raw];
    else if (raw && typeof raw === "object") {
      controls = Object.entries(raw)
        .filter(([, enabled]) => Boolean(enabled))
        .map(([mode]) => mode);
    }

    if (!controls.length) controls.push("disable");

    const seen = new Set();
    return controls
      .map((control) => {
        const mode = typeof control === "string" ? control : control && control.mode;
        if (!["disable", "stop", "undo", "restoreAll", "manage"].includes(mode) || seen.has(mode)) return null;
        if (item.action === "DOM_MONITOR_ADD" && item.phase === "monitoring" && mode === "disable") {
          return null;
        }
        if ((mode === "disable" || mode === "stop") && item.active === false) return null;
        if (mode === "undo" && Number(item.reversibleCount) < 1) return null;
        if (mode === "restoreAll" && Number(item.reversibleCount) < 1 && item.active === false) return null;
        seen.add(mode);
        const label = item.action === "PRIVACY_BLOCK_TRACKERS" && mode === "disable"
          ? "停止拦截"
          : (typeof control === "object" && control.label) || ACTIVE_CONTROL_LABELS[mode] || mode;
        return {
          mode,
          label,
        };
      })
      .filter(Boolean);
  }

  function getActiveActionLabel(item) {
    const entry = sharedRegistry && typeof sharedRegistry.getAction === "function"
      ? sharedRegistry.getAction(item.action)
      : null;
    return String(
      item.label ||
        item.title ||
        item.name ||
        (entry && entry.label) ||
        ACTIVE_ACTION_LABELS[item.action] ||
        String(item.action || "活动功能").toLowerCase().replace(/_/g, " ")
    );
  }

  function getActiveActionDetails(item) {
    const parts = [];
    const phaseLabels = {
      active: "运行中",
      enabled: "已开启",
      monitoring: "监控中",
      picking: "等待选择",
      selecting: "等待选择",
      recording: "录制中",
      paused: "已暂停",
      recoverable: "可恢复",
      starting: "正在开启",
      stopping: "正在关闭",
      error: "操作失败",
    };
    const scopeLabels = {
      tab: "当前标签页",
      page: "当前页面",
      session: "本次会话",
      global: "全部页面",
      durable: "持久监控",
      extension: "扩展页面",
      system: "浏览器",
    };
    parts.push(phaseLabels[item.phase] || (item.active === false ? "可恢复" : "运行中"));
    parts.push(scopeLabels[item.scope] || "当前页面");
    if (Number(item.count) > 0) parts.push(`${Number(item.count)} 项`);
    if (Number(item.reversibleCount) > 0) parts.push(`${Number(item.reversibleCount)} 项可恢复`);
    return parts.join(" · ");
  }

  function toggleActivePanel() {
    const panel = document.getElementById("woActivePanel");
    const toggle = document.getElementById("woActiveToggle");
    const collapsed = !panel.classList.contains("is-collapsed");
    panel.classList.toggle("is-collapsed", collapsed);
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }

  async function runActiveActionControl(button) {
    if (!activeTab || !Number.isInteger(activeTab.id) || button.classList.contains("is-busy")) return;
    const action = button.getAttribute("data-action");
    const mode = button.getAttribute("data-mode");
    const status = document.getElementById("woActiveStatus");
    button.classList.add("is-busy");
    button.disabled = true;
    status.textContent = `${button.textContent.trim()}处理中…`;

    try {
      let response;
      if (action === "OPEN_SCREEN_RECORDER" && mode === "stop") {
        response = await chrome.runtime.sendMessage({ type: "WO_RECORDER_COMMAND", command: "STOP" });
        if (!response || response.ok === false) throw new Error("录屏停止失败，请重试。");
      } else {
        const targetAction = mode === "manage" ? ACTIVE_MANAGE_ACTIONS[action] || action : action;
        const payload = mode === "manage" ? null : { mode };
        response = await actionClient.executeAction(targetAction, payload, { tabId: activeTab.id });
      }
      const restored = Number(response && response.data && response.data.restored);
      status.textContent = ["undo", "restoreAll"].includes(mode) && Number.isFinite(restored) && restored < 1
        ? "没有可恢复的操作"
        : `${button.textContent.trim()}成功`;
      await sleep(80);
      await scheduleRefresh();
    } catch (error) {
      console.warn("[WO Side] Active action control failed:", error);
      status.textContent = error && error.message ? error.message : "操作失败，请重试。";
      button.classList.remove("is-busy");
      button.disabled = false;
    }
  }

  function renderPageSnapshot() {
    const titleEl = document.getElementById("woPageTitle");
    const hostEl = document.getElementById("woPageHost");
    const favEl = document.getElementById("woFavicon");
    const badgesEl = document.getElementById("woActiveBadges");

    titleEl.textContent = pageContext.title || "未命名页面";
    hostEl.textContent = pageContext.host || "—";
    titleEl.title = pageContext.title || "";
    hostEl.title = pageContext.url || "";

    if (pageContext.favIconUrl && /^https?:/.test(pageContext.favIconUrl)) {
      favEl.innerHTML = `<img alt="" src="${escapeHtml(pageContext.favIconUrl)}" />`;
    } else {
      favEl.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`;
    }

    const badgeSet = new Set();
    Object.entries(pageContext.toggles || {}).forEach(([key, enabled]) => {
      if (enabled && TOGGLE_LABELS[key]) badgeSet.add(TOGGLE_LABELS[key]);
    });
    if (pageContext.pageTranslated) badgeSet.add(TOGGLE_LABELS.pageTranslated);
    activeActions.forEach((item) => badgeSet.add(getActiveActionLabel(item)));
    const allBadges = Array.from(badgeSet);
    const badges = allBadges.slice(0, 4);
    if (allBadges.length > badges.length) badges.push(`+${allBadges.length - badges.length}`);

    if (!badges.length) {
      badgesEl.hidden = true;
      badgesEl.innerHTML = "";
    } else {
      badgesEl.hidden = false;
      badgesEl.innerHTML = badges
        .map(
          (label) =>
            `<span class="wo-active-badge"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>${escapeHtml(
              label
            )}</span>`
        )
        .join("");
    }
  }

  function extractHost(url) {
    try {
      const u = new URL(url);
      return u.host || u.protocol.replace(":", "");
    } catch (_) {
      return "";
    }
  }

  /* ---------- 翻译面板同步 ---------- */
  function syncTranslatePanelState() {
    const pageButton = document.getElementById("translatePageBtn");
    const restoreButton = document.getElementById("translateRestoreBtn");
    const meta = document.getElementById("translatePageMeta");
    if (!pageButton || !restoreButton || !meta) return;

    const enabled = Boolean(pageContext.supported);
    pageButton.disabled = !enabled;
    restoreButton.disabled = !enabled || !pageContext.pageTranslated;

    if (!enabled) {
      meta.textContent = "当前页受限，整页翻译只在普通网页里可用。";
      return;
    }
    if (pageContext.pageTranslated) {
      const target = pageContext.pageTranslateTarget
        ? humanizeLanguage(pageContext.pageTranslateTarget)
        : "当前目标语言";
      meta.textContent = `当前页已翻译 ${pageContext.pageTranslateCount || 0} 段正文，目标语言：${target}。`;
      return;
    }
    const lang = pageContext.lang ? humanizeLanguage(pageContext.lang) : "自动识别";
    meta.textContent = `当前页正文尚未翻译，页面语言：${lang}。`;
  }

  function renderSuggestions() {
    const selection = pageContext.selection.trim();
    const hint = document.getElementById("woSuggestionHint");
    const tT = document.getElementById("woSuggestTranslateTitle");
    const tC = document.getElementById("woSuggestTranslateCopy");
    const wT = document.getElementById("woSuggestWeatherTitle");
    const wC = document.getElementById("woSuggestWeatherCopy");

    if (!pageContext.supported) {
      hint.textContent = "当前页面受限";
      tT.textContent = "切到普通网页再翻译";
      tC.textContent = "chrome:// 等页面无法读取选区。";
    } else if (selection) {
      hint.textContent = "已识别选区";
      tT.textContent = "翻译当前选中的内容";
      tC.textContent = shorten(selection, 56);
    } else if (pageContext.pageTranslated) {
      hint.textContent = "当前页已整页翻译";
      tT.textContent = "继续补翻新加载的正文";
      tC.textContent = "页面滚动加载新内容后可再补一次。";
    } else {
      hint.textContent = "根据当前页内容";
      tT.textContent = "翻译当前页面正文";
      tC.textContent = pageContext.lang
        ? `页面语言：${humanizeLanguage(pageContext.lang)}。`
        : "整页翻译会优先尝试主体正文。";
    }

    const q = document.getElementById("weatherQuery").value.trim();
    if (q) {
      wT.textContent = `刷新 ${shorten(q, 14)} 的天气`;
      wC.textContent = "在侧边栏直接查询，不必另开新页。";
    } else {
      wT.textContent = "查看今天的天气";
      wC.textContent = "输入城市，或尝试定位。";
    }
  }

  function maybePrefillSelection() {
    const input = document.getElementById("translateInput");
    if (!input.value.trim() && pageContext.selection.trim()) {
      input.value = pageContext.selection.trim();
      saveTranslatePrefs();
      updateTranslateCounter();
    }
  }

  function adaptTranslateTargetFromContext() {
    const target = document.getElementById("translateTarget");
    const source = document.getElementById("translateSource");
    if (document.getElementById("translateInput").value.trim()) return;
    if (source.value !== "auto") return;
    const normalized = normalizeLanguageCode(pageContext.lang);
    target.value = normalized && normalized.startsWith("zh") ? "en" : "zh-CN";
    saveTranslatePrefs();
  }

  /* ---------- 翻译 ---------- */
  function updateTranslateCounter() {
    const input = document.getElementById("translateInput");
    const counter = document.getElementById("translateCount");
    const button = document.getElementById("translateRunBtn");
    const bytes = new TextEncoder().encode(input.value || "").byteLength;
    counter.textContent = `${bytes} / ${TRANSLATE_MAX_BYTES} bytes`;
    button.disabled = !input.value.trim() || bytes > TRANSLATE_MAX_BYTES;
    counter.style.color = bytes > TRANSLATE_MAX_BYTES ? "var(--wo-danger)" : "";
  }

  async function runTranslate() {
    const input = document.getElementById("translateInput");
    const output = document.getElementById("translateOutput");
    const status = document.getElementById("translateStatus");
    const sourceValue = document.getElementById("translateSource").value;
    const targetValue = document.getElementById("translateTarget").value;
    const text = input.value.trim();
    const bytes = new TextEncoder().encode(text).byteLength;
    if (!text) return;
    if (bytes > TRANSLATE_MAX_BYTES) {
      status.textContent = "当前文本超过 450 bytes，公共翻译接口更适合短句。";
      return;
    }
    output.textContent = "翻译中…";
    output.classList.remove("is-placeholder");
    status.textContent = "正在连接翻译接口…";
    try {
      const { sourceLang, targetLang, translatedText } = await translateTextCompat(
        text,
        sourceValue,
        targetValue
      );
      const ns = normalizeLanguageCode(sourceLang) || "en";
      const nt = normalizeLanguageCode(targetLang) || "zh-CN";
      if (ns === nt) {
        output.textContent = text;
        animateSideUpdate(output);
        status.textContent = "源语言和目标语言相同，已直接保留原文。";
        return;
      }
      if (!translatedText) throw new Error("未拿到翻译结果");
      output.textContent = translatedText;
      output.classList.remove("is-placeholder");
      animateSideUpdate(output);
      status.textContent = `翻译完成，${humanizeLanguage(ns)} → ${humanizeLanguage(nt)}。`;
    } catch (e) {
      console.warn("[WO Side] Translate failed:", e);
      output.textContent = "翻译失败，请稍后重试。";
      animateSideUpdate(output);
      status.textContent = "公共翻译接口偶尔会限流或波动。";
    }
  }

  async function runFullPageTranslate() {
    const status = document.getElementById("translateStatus");
    const pageButton = document.getElementById("translatePageBtn");
    const restoreButton = document.getElementById("translateRestoreBtn");
    const sourceValue = document.getElementById("translateSource").value;
    const targetValue = document.getElementById("translateTarget").value;

    if (isRestrictedTab(activeTab)) {
      status.textContent = "当前页面受限，整页翻译只在普通网页里可用。";
      return;
    }

    pageButton.disabled = true;
    restoreButton.disabled = true;
    status.textContent = "正在提取当前页面的正文节点…";

    try {
      if (pageContext.pageTranslated) {
        const activeT = normalizeLanguageCode(pageContext.pageTranslateTarget);
        const nextT = normalizeLanguageCode(targetValue) || "zh-CN";
        if (activeT && activeT !== nextT) {
          status.textContent = "当前页已是另一目标语言，先恢复原文…";
          await restoreFullPageTranslation({ silent: true });
        }
      }

      const collectResult = await actionClient.executeData(
        PAGE_TRANSLATE_ACTIONS.COLLECT,
        { onlyUntranslated: true },
        { tabId: activeTab.id }
      );
      const segments = Array.isArray(collectResult && collectResult.segments)
        ? collectResult.segments.filter((s) => s && s.id && String(s.text || "").trim())
        : [];
      if (!segments.length) {
        status.textContent = pageContext.pageTranslated
          ? "暂时没有新的正文需要补翻。"
          : "没找到适合整页翻译的正文文本。";
        await scheduleRefresh();
        return;
      }

      const sourceLang = await detectPageSourceLanguage(segments, sourceValue, targetValue);
      const ns = normalizeLanguageCode(sourceLang) || "en";
      const nt = normalizeLanguageCode(targetValue) || "zh-CN";
      if (ns === nt) {
        status.textContent = "页面语言和目标语言相同，无需整页翻译。";
        return;
      }

      const translatedMap = await translatePageSegments(segments, ns, nt, (done, total) => {
        status.textContent = `正在整页翻译 ${done} / ${total} 段…`;
      });
      const translations = segments.map((s) => ({
        id: s.id,
        text: translatedMap.get(s.text) || s.text,
      }));
      const applyResult = await actionClient.executeData(
        PAGE_TRANSLATE_ACTIONS.APPLY,
        { translations, meta: { sourceLang: ns, targetLang: nt } },
        { tabId: activeTab.id }
      );
      const applied = Number(applyResult && applyResult.applied) || 0;
      status.textContent =
        applied > 0
          ? `整页翻译完成，共替换 ${applied} 段，目标语言：${humanizeLanguage(nt)}。`
          : "这次没有替换新的正文节点。";
    } catch (e) {
      console.warn("[WO Side] Full-page translate failed:", e);
      status.textContent = "整页翻译失败，请稍后再试。";
    } finally {
      await scheduleRefresh();
    }
  }

  async function restoreFullPageTranslation(options = {}) {
    const status = document.getElementById("translateStatus");
    if (isRestrictedTab(activeTab)) {
      status.textContent = "当前页面受限，无法恢复整页翻译。";
      return;
    }
    try {
      const result = await actionClient.executeData(
        PAGE_TRANSLATE_ACTIONS.RESTORE,
        null,
        { tabId: activeTab.id }
      );
      const restored = Number(result && result.restored) || 0;
      if (!options.silent) {
        status.textContent = restored > 0 ? `已恢复 ${restored} 段正文。` : "没有需要恢复的内容。";
      }
    } catch (e) {
      console.warn("[WO Side] Restore failed:", e);
      if (!options.silent) status.textContent = "恢复原文失败，请刷新页面后重试。";
    } finally {
      await scheduleRefresh();
    }
  }

  async function detectPageSourceLanguage(segments, sourceValue, targetValue) {
    if (sourceValue !== "auto") return sourceValue;
    const pageLang = normalizeLanguageCode(pageContext.lang);
    if (pageLang) return pageLang;

    const sampleParts = [];
    let bytes = 0;
    for (const segment of segments) {
      const text = String(segment.text || "").trim();
      if (!text) continue;
      const sb = new TextEncoder().encode(text).byteLength;
      if (bytes + sb > PAGE_TRANSLATE_CHUNK_BYTES && sampleParts.length) break;
      sampleParts.push(text);
      bytes += sb;
      if (bytes >= 220) break;
    }
    return detectSourceLanguage(sampleParts.join("\n"), targetValue);
  }

  async function translatePageSegments(segments, sourceLang, targetLang, onProgress) {
    const unique = [];
    const seen = new Set();
    for (const s of segments) {
      const t = String(s.text || "").trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      unique.push(t);
    }
    const map = new Map();
    let done = 0;
    await runTaskPool(unique, PAGE_TRANSLATE_CONCURRENCY, async (text) => {
      const r = await translateTextCompat(text, sourceLang, targetLang);
      map.set(text, r.translatedText || text);
      done += 1;
      if (typeof onProgress === "function") onProgress(done, unique.length);
    });
    return map;
  }

  async function translateTextCompat(text, sourceValue, targetValue) {
    const nt = normalizeLanguageCode(targetValue) || "zh-CN";
    const resolvedSource =
      sourceValue === "auto" ? await detectSourceLanguage(text, nt) : sourceValue;
    const ns = normalizeLanguageCode(resolvedSource) || "en";
    if (ns === nt) {
      return { sourceLang: ns, targetLang: nt, translatedText: String(text || "") };
    }
    const chunks = splitTextForTranslation(text, PAGE_TRANSLATE_CHUNK_BYTES);
    const translated = [];
    for (const c of chunks) translated.push(await requestTranslationChunk(c, ns, nt));
    return { sourceLang: ns, targetLang: nt, translatedText: joinTranslatedChunks(translated) };
  }

  async function requestTranslationChunk(text, sourceLang, targetLang) {
    const normalized = String(text || "").trim();
    const cacheKey = `${sourceLang}::${targetLang}::${normalized}`;
    if (pageTranslateCache.has(cacheKey)) return pageTranslateCache.get(cacheKey);

    let result = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const url = new URL(TRANSLATE_ENDPOINT);
        url.searchParams.set("q", normalized);
        url.searchParams.set("langpair", `${sourceLang}|${targetLang}`);
        url.searchParams.set("mt", "1");
        const payload = await fetchJson(url.toString(), { timeout: 12000 });
        result =
          payload && payload.responseData && payload.responseData.translatedText
            ? String(payload.responseData.translatedText).trim()
            : "";
        if (result) break;
      } catch (e) {
        if (attempt >= 1) throw e;
      }
      await sleep(450 * (attempt + 1));
    }
    if (!result) throw new Error("未拿到翻译结果");
    pageTranslateCache.set(cacheKey, result);
    return result;
  }

  function splitTextForTranslation(text, maxBytes) {
    const normalized = String(text || "").replace(/\r/g, "").trim();
    if (!normalized) return [""];
    if (new TextEncoder().encode(normalized).byteLength <= maxBytes) return [normalized];

    const seeds = normalized
      .split(/(?<=[。！？!?；;：:])\s+|(?:\n+)/u)
      .map((i) => i.trim())
      .filter(Boolean);
    const pieces = [];
    const queue = seeds.length ? seeds.slice() : [normalized];
    while (queue.length) {
      const cur = queue.shift();
      if (!cur) continue;
      if (new TextEncoder().encode(cur).byteLength <= maxBytes) {
        pieces.push(cur);
        continue;
      }
      const split = splitLargeSegment(cur);
      if (split.length === 1) pieces.push(cur);
      else queue.unshift(...split);
    }
    return mergeChunksBySize(pieces, maxBytes);
  }

  function splitLargeSegment(text) {
    const patterns = [/[^，,]+[，,]?/g, /[^、]+[、]?/g, /\S+\s*/g];
    for (const p of patterns) {
      const fr = (text.match(p) || []).map((i) => i.trim()).filter(Boolean);
      if (fr.length > 1) return fr;
    }
    const mid = Math.max(1, Math.floor(text.length / 2));
    return [text.slice(0, mid).trim(), text.slice(mid).trim()].filter(Boolean);
  }

  function mergeChunksBySize(chunks, maxBytes) {
    const merged = [];
    let buf = "";
    for (const c of chunks) {
      const cand = buf ? `${buf}\n${c}` : c;
      if (new TextEncoder().encode(cand).byteLength <= maxBytes) {
        buf = cand;
        continue;
      }
      if (buf) merged.push(buf);
      buf = c;
    }
    if (buf) merged.push(buf);
    return merged.length ? merged : chunks;
  }

  function joinTranslatedChunks(chunks) {
    return chunks
      .map((c) => String(c || "").trim())
      .filter(Boolean)
      .join(" ");
  }

  async function runTaskPool(items, concurrency, worker) {
    const queue = Array.isArray(items) ? items.slice() : [];
    const limit = Math.max(1, Number(concurrency) || 1);
    await Promise.all(
      Array.from({ length: Math.min(limit, queue.length || 1) }, async () => {
        while (queue.length) {
          const item = queue.shift();
          await worker(item);
        }
      })
    );
  }

  async function detectSourceLanguage(text, targetValue) {
    try {
      const r = await new Promise((resolve, reject) => {
        chrome.i18n.detectLanguage(text, (info) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message));
            return;
          }
          resolve(info);
        });
      });
      const langs = Array.isArray(r && r.languages) ? r.languages : [];
      const first = langs.find((i) => normalizeLanguageCode(i.language));
      const n = normalizeLanguageCode(first && first.language);
      if (n) return n;
    } catch (e) {
      console.warn("[WO Side] detect failed:", e);
    }
    return normalizeLanguageCode(targetValue) === "zh-CN" ? "en" : "zh-CN";
  }

  function fillSelectionIntoTranslator() {
    if (!pageContext.selection.trim()) {
      document.getElementById("translateStatus").textContent = "当前页面没有可用的选中文本。";
      return;
    }
    const input = document.getElementById("translateInput");
    input.value = pageContext.selection.trim();
    saveTranslatePrefs();
    updateTranslateCounter();
  }

  function swapTranslateLanguages() {
    const source = document.getElementById("translateSource");
    const target = document.getElementById("translateTarget");
    if (source.value === "auto") {
      source.value = target.value;
      target.value = source.value === "zh-CN" ? "en" : "zh-CN";
    } else {
      const prev = source.value;
      source.value = target.value;
      target.value = prev === "auto" ? "zh-CN" : prev;
    }
    saveTranslatePrefs();
  }

  async function copyTranslation() {
    const output = document.getElementById("translateOutput");
    const text = output.textContent.trim();
    if (!text || output.classList.contains("is-placeholder")) return;
    try {
      await navigator.clipboard.writeText(text);
      document.getElementById("translateStatus").textContent = "翻译结果已复制。";
    } catch (_) {
      document.getElementById("translateStatus").textContent = "复制失败，请重试。";
    }
  }

  /* ============================================================
   * 天气 — 专业级
   * ============================================================ */
  async function maybeAutoLoadWeather() {
    const q = document.getElementById("weatherQuery").value.trim();
    if (!q) return;
    await runWeatherSearch(q, { silentStatus: true });
  }

  async function runWeatherSearch(rawQuery, options = {}) {
    const query = String(rawQuery || "").trim();
    const status = document.getElementById("weatherStatus");
    if (!query) {
      status.textContent = "先输入城市，再查询天气。";
      return;
    }
    document.getElementById("weatherQuery").value = query;
    try {
      localStorage.setItem(WEATHER_QUERY_STORAGE_KEY, query);
    } catch (_) {}
    if (!options.silentStatus) status.textContent = "正在搜索城市并获取天气…";

    try {
      const url = new URL(WEATHER_GEOCODE_ENDPOINT);
      url.searchParams.set("name", query);
      url.searchParams.set("count", "1");
      url.searchParams.set("language", "zh");
      url.searchParams.set("format", "json");
      const payload = await fetchJson(url.toString(), { timeout: 12000 });
      const match = payload && Array.isArray(payload.results) ? payload.results[0] : null;
      if (!match) throw new Error("未找到对应城市");

      lastWeatherRequest = {
        mode: "city",
        query,
        label: buildWeatherLabel(match),
        latitude: match.latitude,
        longitude: match.longitude,
      };
      await fetchWeatherByCoordinates(match.latitude, match.longitude, buildWeatherLabel(match));
    } catch (e) {
      console.warn("[WO Side] Weather lookup failed:", e);
      setWeatherError("没找到这个城市，换一个名字再试。");
    }
  }

  async function locateWeather() {
    const status = document.getElementById("weatherStatus");
    status.textContent = "正在尝试定位…";
    try {
      const coords = await new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(new Error("geolocation unavailable"));
          return;
        }
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: false,
          timeout: 10000,
          maximumAge: 300000,
        });
      });
      lastWeatherRequest = {
        mode: "coords",
        latitude: coords.coords.latitude,
        longitude: coords.coords.longitude,
        label: "当前位置",
      };
      await fetchWeatherByCoordinates(coords.coords.latitude, coords.coords.longitude, "当前位置");
    } catch (e) {
      console.warn("[WO Side] Geo failed:", e);
      setWeatherError("定位失败，可直接输入城市名称查询。");
    }
  }

  async function refreshWeather() {
    if (!lastWeatherRequest) {
      const q = document.getElementById("weatherQuery").value.trim();
      if (q) await runWeatherSearch(q);
      else document.getElementById("weatherStatus").textContent = "还没有天气请求，先输入城市。";
      return;
    }
    if (lastWeatherRequest.mode === "coords") {
      await fetchWeatherByCoordinates(
        lastWeatherRequest.latitude,
        lastWeatherRequest.longitude,
        lastWeatherRequest.label
      );
      return;
    }
    await runWeatherSearch(lastWeatherRequest.query);
  }

  async function fetchWeatherByCoordinates(latitude, longitude, label) {
    const status = document.getElementById("weatherStatus");
    status.textContent = "正在刷新天气…";
    try {
      const url = new URL(WEATHER_FORECAST_ENDPOINT);
      url.searchParams.set("latitude", String(latitude));
      url.searchParams.set("longitude", String(longitude));
      url.searchParams.set(
        "current",
        [
          "temperature_2m",
          "apparent_temperature",
          "relative_humidity_2m",
          "weather_code",
          "wind_speed_10m",
          "wind_direction_10m",
          "surface_pressure",
          "is_day",
        ].join(",")
      );
      url.searchParams.set(
        "hourly",
        [
          "temperature_2m",
          "weather_code",
          "precipitation_probability",
          "is_day",
          "visibility",
          "uv_index",
        ].join(",")
      );
      url.searchParams.set(
        "daily",
        [
          "weather_code",
          "temperature_2m_max",
          "temperature_2m_min",
          "precipitation_probability_max",
          "uv_index_max",
          "sunrise",
          "sunset",
        ].join(",")
      );
      url.searchParams.set("forecast_days", "7");
      url.searchParams.set("timezone", "auto");
      const payload = await fetchJson(url.toString(), { timeout: 12000 });
      renderWeatherFull(payload, label);
      status.textContent = "天气已更新。";
    } catch (e) {
      console.warn("[WO Side] Weather fetch failed:", e);
      setWeatherError("天气接口暂不可用，请稍后重试。");
    }
  }

  function renderWeatherFull(payload, label) {
    const cur = payload && payload.current;
    if (!cur) throw new Error("missing current weather");

    const daily = payload.daily || {};
    const hourly = payload.hourly || {};
    const isDay = Boolean(cur.is_day);
    const code = Number(cur.weather_code);

    /* —— Hero 当前 —— */
    document.getElementById("weatherLocation").textContent = label || "天气结果";
    document.getElementById("weatherUpdated").textContent = formatWeatherUpdateTime(cur.time);
    document.getElementById("weatherTemp").textContent = `${formatNumber(cur.temperature_2m)}°`;
    document.getElementById("weatherDesc").textContent = weatherCodeLabel(code, isDay);

    const dMax = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[0] : null;
    const dMin = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[0] : null;
    document.getElementById("weatherRange").textContent =
      dMax == null || dMin == null
        ? "最高 -- · 最低 --"
        : `最高 ${formatNumber(dMax)}° · 最低 ${formatNumber(dMin)}°`;

    document.getElementById("weatherIcon").innerHTML = svgWeatherIcon(code, isDay);

    /* —— 详细指标 —— */
    document.getElementById("weatherFeels").textContent = `${formatNumber(cur.apparent_temperature)}°`;
    document.getElementById("weatherWind").textContent = `${formatNumber(cur.wind_speed_10m)} km/h ${windDirLabel(cur.wind_direction_10m)}`;
    document.getElementById("weatherHumidity").textContent =
      cur.relative_humidity_2m != null ? `${formatNumber(cur.relative_humidity_2m)}%` : "--";

    const todayUv = Array.isArray(daily.uv_index_max) ? daily.uv_index_max[0] : null;
    const uvEl = document.getElementById("weatherUv");
    if (todayUv == null) uvEl.textContent = "--";
    else uvEl.textContent = `${formatNumber(todayUv)} · ${uvLevel(todayUv)}`;

    document.getElementById("weatherPressure").textContent =
      cur.surface_pressure != null ? `${formatNumber(cur.surface_pressure)} hPa` : "--";

    /* visibility 取下一小时（current 没有） */
    const vis = pickHourValue(hourly, "visibility", cur.time);
    document.getElementById("weatherVisibility").textContent =
      vis != null ? `${formatNumber(vis / 1000)} km` : "--";

    /* —— 日出日落 —— */
    const sunrise = Array.isArray(daily.sunrise) ? daily.sunrise[0] : null;
    const sunset = Array.isArray(daily.sunset) ? daily.sunset[0] : null;
    document.getElementById("weatherSunrise").textContent = formatHm(sunrise);
    document.getElementById("weatherSunset").textContent = formatHm(sunset);

    /* —— 24h 逐小时 —— */
    renderHourly(hourly, cur.time);

    /* —— 7d 每日 —— */
    renderDaily(daily);
    animateSideUpdate(document.querySelector(".wo-weather-hero"));
  }

  function renderHourly(hourly, currentTime) {
    const card = document.getElementById("weatherHourlyCard");
    const list = document.getElementById("weatherHourly");
    const times = Array.isArray(hourly.time) ? hourly.time : [];
    const temps = Array.isArray(hourly.temperature_2m) ? hourly.temperature_2m : [];
    const codes = Array.isArray(hourly.weather_code) ? hourly.weather_code : [];
    const days = Array.isArray(hourly.is_day) ? hourly.is_day : [];
    const precs = Array.isArray(hourly.precipitation_probability)
      ? hourly.precipitation_probability
      : [];
    if (!times.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;

    const startIdx = findHourIndex(times, currentTime);
    const endIdx = Math.min(times.length, startIdx + 24);

    list.innerHTML = times
      .slice(startIdx, endIdx)
      .map((t, idx) => {
        const i = startIdx + idx;
        const isNow = idx === 0;
        const hourLabel = isNow ? "现在" : formatHourShort(t);
        const temp = formatNumber(temps[i]);
        const prec = precs[i] != null && precs[i] > 5 ? `${formatNumber(precs[i])}%` : "";
        const icon = svgHourIcon(Number(codes[i]), Boolean(days[i]));
        return `
        <div class="wo-hour-cell ${isNow ? "is-now" : ""}">
          <div class="wo-hour-time">${escapeHtml(hourLabel)}</div>
          <div class="wo-hour-icon">${icon}</div>
          <div class="wo-hour-temp">${temp}°</div>
          <div class="wo-hour-prec">${escapeHtml(prec)}</div>
        </div>`;
      })
      .join("");
    animateSideUpdate(card);
  }

  function renderDaily(daily) {
    const card = document.getElementById("weatherDailyCard");
    const list = document.getElementById("weatherDaily");
    const times = Array.isArray(daily.time) ? daily.time : [];
    const codes = Array.isArray(daily.weather_code) ? daily.weather_code : [];
    const maxes = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : [];
    const mins = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min : [];
    const precs = Array.isArray(daily.precipitation_probability_max)
      ? daily.precipitation_probability_max
      : [];

    if (!times.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;

    /* 计算整周温度区间，用来画温度条 */
    const validMax = maxes.filter((v) => v != null);
    const validMin = mins.filter((v) => v != null);
    const weekHigh = Math.max(...validMax);
    const weekLow = Math.min(...validMin);
    const span = Math.max(1, weekHigh - weekLow);

    list.innerHTML = times
      .map((t, i) => {
        const isToday = i === 0;
        const dayLabel = isToday ? "今天" : formatWeekday(t);
        const max = maxes[i];
        const min = mins[i];
        const code = Number(codes[i]);
        const prec = precs[i];
        const icon = svgHourIcon(code, true);
        const left = max == null || min == null ? 0 : ((min - weekLow) / span) * 100;
        const width = max == null || min == null ? 0 : ((max - min) / span) * 100;

        return `
        <div class="wo-day-row ${isToday ? "is-today" : ""}">
          <div class="wo-day-name">${escapeHtml(dayLabel)}</div>
          <div class="wo-day-icon">${icon}</div>
          <div class="wo-day-prec">${prec != null && prec > 0 ? formatNumber(prec) + "%" : ""}</div>
          <div class="wo-day-range">
            <span class="wo-range-low">${formatNumber(min)}°</span>
            <span class="wo-range-bar"><span class="wo-range-fill" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></span></span>
            <span class="wo-range-high">${formatNumber(max)}°</span>
          </div>
        </div>`;
      })
      .join("");
    animateSideUpdate(card);
  }

  function animateSideUpdate(element) {
    if (!element || typeof element.animate !== "function") return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const previous = sideUpdateAnimations.get(element);
    if (previous) {
      previous.cancel();
      if (sideUpdateAnimations.get(element) === previous) sideUpdateAnimations.delete(element);
    }
    const animation = element.animate(
      [
        { opacity: .62, transform: "translate3d(0, 4px, 0)", filter: "blur(.6px)" },
        { opacity: 1, transform: "translate3d(0, 0, 0)", filter: "blur(0px)" },
      ],
      { duration: 260, easing: VIEW_TRANSITION_EASING }
    );
    sideUpdateAnimations.set(element, animation);
    animation.finished.then(() => {
      if (sideUpdateAnimations.get(element) === animation) sideUpdateAnimations.delete(element);
    }).catch(() => {});
  }

  function pickHourValue(hourly, field, anchorTime) {
    const times = Array.isArray(hourly.time) ? hourly.time : [];
    const values = Array.isArray(hourly[field]) ? hourly[field] : [];
    if (!times.length || !values.length) return null;
    const idx = findHourIndex(times, anchorTime);
    return values[idx] != null ? values[idx] : values[0];
  }

  function findHourIndex(times, anchor) {
    if (!anchor) return 0;
    const target = new Date(anchor).getTime();
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < times.length; i += 1) {
      const diff = Math.abs(new Date(times[i]).getTime() - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    return best;
  }

  function setWeatherError(text) {
    document.getElementById("weatherStatus").textContent = text;
    document.getElementById("weatherLocation").textContent = "天气请求失败";
    document.getElementById("weatherUpdated").textContent = "请稍后重试";
    document.getElementById("weatherTemp").textContent = "--°";
    document.getElementById("weatherDesc").textContent = text;
    document.getElementById("weatherRange").textContent = "最高 -- · 最低 --";
    document.getElementById("weatherFeels").textContent = "--°";
    document.getElementById("weatherWind").textContent = "-- km/h";
    document.getElementById("weatherHumidity").textContent = "--%";
    document.getElementById("weatherUv").textContent = "--";
    document.getElementById("weatherPressure").textContent = "-- hPa";
    document.getElementById("weatherVisibility").textContent = "-- km";
    document.getElementById("weatherSunrise").textContent = "--:--";
    document.getElementById("weatherSunset").textContent = "--:--";
    document.getElementById("weatherIcon").innerHTML = "";
    document.getElementById("weatherHourlyCard").hidden = true;
    document.getElementById("weatherDailyCard").hidden = true;
  }

  /* ---------- 收藏快捷操作 ---------- */
  function getQuickEntry(action) {
    return sharedRegistry && typeof sharedRegistry.getAction === "function"
      ? sharedRegistry.getAction(action)
      : null;
  }

  function equalStringLists(left, right) {
    if (left === right) return true;
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => item === right[index]);
  }

  function sanitizeQuickPins(raw) {
    const values = Array.isArray(raw) ? raw : [];
    return Array.from(new Set(values.filter((action) => {
      const entry = getQuickEntry(action);
      return Boolean(entry && entry.command);
    }))).slice(0, QUICK_FAVORITE_LIMIT);
  }

  function sanitizeQuickPersonalOrder(raw) {
    const values = Array.isArray(raw) ? raw : [];
    return Array.from(new Set(values.filter((action) => {
      const entry = getQuickEntry(action);
      return Boolean(entry && entry.command);
    }))).slice(0, QUICK_PERSONAL_ORDER_LIMIT);
  }

  function orderedQuickPins(pins, personalOrder) {
    const safePins = sanitizeQuickPins(pins === undefined ? quickPins : pins);
    const safeOrder = sanitizeQuickPersonalOrder(
      personalOrder === undefined ? quickPersonalOrder : personalOrder
    );
    const pinSet = new Set(safePins);
    const ordered = safeOrder.filter((action) => pinSet.has(action));
    safePins.forEach((action) => {
      if (!ordered.includes(action)) ordered.push(action);
    });
    return ordered;
  }

  async function loadQuickFavorites() {
    try {
      const stored = await chrome.storage.local.get([
        HUB_PINS_STORAGE_KEY,
        HUB_PERSONAL_ORDER_STORAGE_KEY,
      ]);
      applyQuickFavoriteStore(
        sanitizeQuickPins(stored[HUB_PINS_STORAGE_KEY]),
        sanitizeQuickPersonalOrder(stored[HUB_PERSONAL_ORDER_STORAGE_KEY]),
        { render: true, force: true }
      );
    } catch (error) {
      console.warn("[WO Side] Failed to load favorites:", error);
      applyQuickFavoriteStore([], [], { render: true, force: true });
      announceQuick("收藏读取失败，请稍后重试。", "error");
    }
  }

  function applyQuickFavoriteStore(nextPins, nextOrder, options) {
    const config = options || {};
    const pins = sanitizeQuickPins(nextPins);
    const order = sanitizeQuickPersonalOrder(nextOrder);
    const changed = !equalStringLists(quickPins, pins) || !equalStringLists(quickPersonalOrder, order);
    quickPins = pins;
    quickPersonalOrder = order;
    if (config.render && (changed || config.force)) {
      renderQuickFavorites({
        preserveFocus: Boolean(config.preserveFocus),
        focusAction: config.focusAction,
        focusKind: config.focusKind,
      });
    }
    return changed;
  }

  function quickAvailability(entry) {
    if (!entry) return { available: false, reason: "命令不存在" };
    if (entry.disabled) {
      return { available: false, reason: entry.disabledReason || "当前版本暂不支持" };
    }
    if (!activeTab || !Number.isInteger(activeTab.id)) {
      return { available: false, reason: "没有可用的活动标签页" };
    }
    if (entry.internalPage) return { available: true, reason: "" };
    if (isRestrictedTab(activeTab)) {
      return { available: false, reason: "当前页面不允许扩展执行网页命令" };
    }
    if (
      sharedRegistry &&
      typeof sharedRegistry.matchesContext === "function" &&
      !sharedRegistry.matchesContext(entry, activeTab.url)
    ) {
      return {
        available: false,
        reason: entry.contexts && entry.contexts.includes("youtube")
          ? "仅支持 YouTube 页面"
          : "当前页面不适用",
      };
    }
    return { available: true, reason: "" };
  }

  function getQuickActiveState(action) {
    const runtimeState = activeActions.find((item) => item.action === action);
    if (runtimeState) return runtimeState.active !== false;
    const stateKey = TOGGLE_ACTION_STATE_KEYS[action];
    return stateKey ? Boolean(pageContext.toggles[stateKey]) : false;
  }

  function quickStatusText(entry, availability, active, busy) {
    if (!availability.available) return availability.reason;
    if (busy) return "正在执行…";
    if (entry.stateful) return active ? "已开启" : (entry.description || "点击开启");
    if (entry.internalPage) return entry.description || "点击打开";
    return entry.description || "点击执行";
  }

  function quickIcon(entry) {
    return QUICK_CATEGORY_ICONS[entry && entry.category] || QUICK_CATEGORY_ICONS.utility;
  }

  function quickTrailingHtml(entry, active, busy) {
    if (busy) return '<span class="wo-quick-spinner" aria-hidden="true"></span>';
    if (entry.stateful) return '<span class="wo-chip-dot" aria-hidden="true"></span>';
    return '<svg class="wo-quick-caret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
  }

  function renderQuickFavoriteRow(action, canReorder) {
    const entry = getQuickEntry(action);
    if (!entry) return "";
    const availability = quickAvailability(entry);
    const active = getQuickActiveState(action);
    const busy = quickActionBusy.has(action);
    const disabled = !availability.available || busy;
    const stateAttributes = entry.stateful
      ? ` role="switch" aria-checked="${active ? "true" : "false"}"`
      : "";
    const rowClasses = [
      "wo-quick-row",
      active ? "is-on" : "",
      disabled ? "is-disabled" : "",
      busy ? "is-busy" : "",
    ].filter(Boolean).join(" ");
    const triggerClasses = [
      "wo-toggle-chip",
      "wo-quick-trigger",
      active ? "is-on" : "",
      disabled ? "is-disabled" : "",
      busy ? "is-busy" : "",
    ].filter(Boolean).join(" ");
    const statusText = quickStatusText(entry, availability, active, busy);
    const removeButton = quickEditMode
      ? `<button class="wo-quick-remove" type="button" data-quick-remove="${escapeHtml(action)}" aria-label="取消收藏 ${escapeHtml(entry.label)}" title="取消收藏">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.8 1-6.1-4.4-4.3 6.1-.9z"/><path d="M8 12h8"/></svg>
        </button>`
      : "";
    return `<div class="${rowClasses}" data-quick-row="${escapeHtml(action)}" role="listitem" aria-grabbed="false">
      <button class="wo-quick-drag-handle" type="button" data-quick-drag-action="${escapeHtml(action)}" aria-label="拖动排序 ${escapeHtml(entry.label)}" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+Home Alt+End" title="拖动排序"${canReorder ? "" : " disabled"}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="8" cy="7" r="1.4"/><circle cx="16" cy="7" r="1.4"/><circle cx="8" cy="12" r="1.4"/><circle cx="16" cy="12" r="1.4"/><circle cx="8" cy="17" r="1.4"/><circle cx="16" cy="17" r="1.4"/></svg>
      </button>
      <button class="${triggerClasses}" type="button" data-quick-action="${escapeHtml(action)}" aria-label="${escapeHtml(entry.label + "，" + statusText)}" title="${escapeHtml(disabled ? statusText : entry.label)}"${stateAttributes}${disabled ? " disabled" : ""}>
        <span class="wo-chip-icon">${quickIcon(entry)}</span>
        <span class="wo-chip-text"><strong>${escapeHtml(entry.label)}</strong><small>${escapeHtml(statusText)}</small></span>
        <span class="wo-quick-trailing">${quickTrailingHtml(entry, active, busy)}</span>
      </button>
      ${removeButton}
    </div>`;
  }

  function captureQuickFocus() {
    const focused = document.activeElement;
    if (!(focused instanceof Element)) return null;
    const action = focused.getAttribute("data-quick-action")
      || focused.getAttribute("data-quick-remove")
      || focused.getAttribute("data-quick-drag-action");
    if (!action) return null;
    const kind = focused.hasAttribute("data-quick-remove")
      ? "remove"
      : (focused.hasAttribute("data-quick-drag-action") ? "drag" : "run");
    return { action, kind };
  }

  function restoreQuickFocus(target) {
    if (!target || !target.action) return;
    const attribute = target.kind === "remove"
      ? "data-quick-remove"
      : (target.kind === "drag" ? "data-quick-drag-action" : "data-quick-action");
    const element = document.querySelector(`[${attribute}="${target.action}"]`);
    if (element) {
      try { element.focus({ preventScroll: true }); } catch (_) { element.focus(); }
    }
  }

  function renderQuickFavorites(options) {
    const config = options || {};
    if (quickDrag) cancelQuickDrag({ render: false });
    const previousFocus = config.preserveFocus ? captureQuickFocus() : null;
    const focusTarget = config.focusAction
      ? { action: config.focusAction, kind: config.focusKind || "run" }
      : previousFocus;
    const list = document.getElementById("woToggleList");
    const editor = document.getElementById("woQuickEditor");
    const editButton = document.getElementById("woQuickEditBtn");
    const scope = document.getElementById("woToggleScope");
    const ordered = orderedQuickPins();
    if (!list || !editor || !editButton || !scope) return;

    scope.textContent = `同步收藏 · ${ordered.length}/${QUICK_FAVORITE_LIMIT}`;
    if (!config.deferEditorVisibility && !quickEditorAnimation) {
      settleQuickEditorVisibility(editor, quickEditMode);
    }
    editButton.classList.toggle("is-active", quickEditMode);
    editButton.setAttribute("aria-pressed", quickEditMode ? "true" : "false");
    editButton.title = quickEditMode ? "完成编辑" : "编辑收藏";
    list.setAttribute("role", "list");
    list.classList.toggle("is-editing", quickEditMode);
    list.innerHTML = ordered.length
      ? ordered.map((action) => renderQuickFavoriteRow(action, ordered.length > 1)).join("")
      : '<div class="wo-quick-empty"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.8 1-6.1-4.4-4.3 6.1-.9z"/></svg><span>暂无收藏，使用右上角编辑按钮添加。</span></div>';
    populateQuickAddOptions();
    restoreQuickFocus(focusTarget);
  }

  function populateQuickAddOptions() {
    const select = document.getElementById("woQuickAddSelect");
    if (!select) return;
    const previousValue = select.value;
    const pinned = new Set(quickPins);
    const entries = sharedRegistry && typeof sharedRegistry.listCommandActions === "function"
      ? sharedRegistry.listCommandActions().filter((entry) => !entry.disabled && !pinned.has(entry.action))
      : [];
    const groups = new Map();
    entries.forEach((entry) => {
      const group = QUICK_CATEGORY_LABELS[entry.category] || "其他";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(entry);
    });
    const groupHtml = Array.from(groups, ([label, items]) => {
      const options = items
        .sort((left, right) => left.label.localeCompare(right.label, "zh-CN"))
        .map((entry) => `<option value="${escapeHtml(entry.action)}">${escapeHtml(entry.label)}</option>`)
        .join("");
      return `<optgroup label="${escapeHtml(label)}">${options}</optgroup>`;
    }).join("");
    select.innerHTML = `<option value="">选择功能…</option>${groupHtml}`;
    if (entries.some((entry) => entry.action === previousValue)) select.value = previousValue;
    select.disabled = quickPins.length >= QUICK_FAVORITE_LIMIT || !entries.length || quickStoreBusy;
    syncQuickAddButton();
  }

  function syncQuickAddButton() {
    const select = document.getElementById("woQuickAddSelect");
    const button = document.getElementById("woQuickAddBtn");
    if (!select || !button) return;
    button.disabled = select.disabled || !select.value || quickPins.length >= QUICK_FAVORITE_LIMIT || quickStoreBusy;
  }

  function announceQuick(message, tone) {
    const note = document.getElementById("woToggleNote");
    if (!note) return;
    note.textContent = message || "收藏与 Command Hub 同步。";
    note.dataset.tone = tone || "info";
  }

  async function persistQuickFavorites(nextPins, message, options) {
    if (quickStoreBusy) return false;
    const config = options || {};
    const pins = sanitizeQuickPins(nextPins);
    const pinSet = new Set(pins);
    const nextOrder = sanitizeQuickPersonalOrder(
      pins.concat(quickPersonalOrder.filter((action) => !pinSet.has(action)))
    );
    const previousPins = quickPins.slice();
    const previousOrder = quickPersonalOrder.slice();
    quickStoreBusy = true;
    applyQuickFavoriteStore(pins, nextOrder, {
      render: config.render !== false,
      force: config.render !== false,
      preserveFocus: Boolean(config.preserveFocus),
      focusAction: config.focusAction,
      focusKind: config.focusKind,
    });
    populateQuickAddOptions();
    try {
      await chrome.storage.local.set({
        [HUB_PINS_STORAGE_KEY]: pins,
        [HUB_PERSONAL_ORDER_STORAGE_KEY]: nextOrder,
      });
      announceQuick(message || "收藏顺序已同步。", "success");
      return true;
    } catch (error) {
      console.warn("[WO Side] Failed to save favorites:", error);
      applyQuickFavoriteStore(previousPins, previousOrder, { render: true, force: true });
      announceQuick("收藏保存失败，请重试。", "error");
      return false;
    } finally {
      quickStoreBusy = false;
      populateQuickAddOptions();
    }
  }

  function toggleQuickEditor() {
    quickEditMode = !quickEditMode;
    renderQuickFavorites({ preserveFocus: true, deferEditorVisibility: true });
    transitionQuickEditor(quickEditMode);
    if (quickEditMode) {
      const select = document.getElementById("woQuickAddSelect");
      if (select && !select.disabled) select.focus();
    }
  }

  function transitionQuickEditor(expanded) {
    const editor = document.getElementById("woQuickEditor");
    if (!editor) return;
    quickEditorTransitionGeneration += 1;
    const generation = quickEditorTransitionGeneration;
    const reduceMotion = Boolean(
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );

    editor.hidden = false;
    editor.inert = !expanded;
    editor.setAttribute("aria-hidden", expanded ? "false" : "true");

    if (reduceMotion || typeof editor.animate !== "function") {
      cancelQuickEditorAnimation(editor);
      settleQuickEditorVisibility(editor, expanded);
      return;
    }

    if (quickEditorAnimation) {
      const direction = Math.sign(quickEditorAnimation.playbackRate || 1);
      const targetDirection = expanded ? 1 : -1;
      if (direction !== targetDirection) quickEditorAnimation.reverse();
      else quickEditorAnimation.play();
      watchQuickEditorAnimation(editor, quickEditorAnimation, generation);
      return;
    }

    clearQuickEditorAnimationStyles(editor);
    const naturalStyle = getComputedStyle(editor);
    const naturalHeight = editor.getBoundingClientRect().height;
    const naturalMarginTop = Number.parseFloat(naturalStyle.marginTop) || 0;
    const naturalMarginBottom = Number.parseFloat(naturalStyle.marginBottom) || 0;
    const closedFrame = {
      height: "0px",
      marginTop: "0px",
      marginBottom: "0px",
      opacity: 0,
      transform: "translate3d(0, -5px, 0)",
      filter: "blur(.7px)",
    };
    const openFrame = {
      height: `${Math.max(0, naturalHeight)}px`,
      marginTop: `${Math.max(0, naturalMarginTop)}px`,
      marginBottom: `${Math.max(0, naturalMarginBottom)}px`,
      opacity: 1,
      transform: "translate3d(0, 0, 0)",
      filter: "blur(0px)",
    };

    editor.style.overflow = "hidden";
    editor.style.willChange = "height, margin, opacity, transform, filter";
    const animation = editor.animate(
      [closedFrame, openFrame],
      { duration: VIEW_TRANSITION_MS, easing: VIEW_TRANSITION_EASING, fill: "both" }
    );
    animation.pause();
    animation.currentTime = expanded ? 0 : VIEW_TRANSITION_MS;
    animation.playbackRate = expanded ? 1 : -1;
    animation.play();
    quickEditorAnimation = animation;
    watchQuickEditorAnimation(editor, animation, generation);
  }

  function watchQuickEditorAnimation(editor, animation, generation) {
    animation.finished.then(() => {
      if (
        generation !== quickEditorTransitionGeneration ||
        quickEditorAnimation !== animation
      ) {
        return;
      }
      quickEditorAnimation = null;
      animation.cancel();
      settleQuickEditorVisibility(editor, quickEditMode);
    }).catch(() => {});
  }

  function cancelQuickEditorAnimation(editor) {
    if (quickEditorAnimation) {
      quickEditorAnimation.cancel();
      quickEditorAnimation = null;
    }
    clearQuickEditorAnimationStyles(editor);
  }

  function settleQuickEditorVisibility(editor, expanded) {
    editor.hidden = !expanded;
    editor.inert = !expanded;
    editor.setAttribute("aria-hidden", expanded ? "false" : "true");
    clearQuickEditorAnimationStyles(editor);
  }

  function clearQuickEditorAnimationStyles(editor) {
    ["height", "margin-top", "margin-bottom", "opacity", "transform", "filter", "overflow", "will-change"]
      .forEach((name) => editor.style.removeProperty(name));
  }

  async function addSelectedQuickFavorite() {
    const select = document.getElementById("woQuickAddSelect");
    if (!select || !select.value || quickPins.length >= QUICK_FAVORITE_LIMIT) return;
    const action = select.value;
    const entry = getQuickEntry(action);
    if (!entry || entry.disabled || quickPins.includes(action)) return;
    const nextPins = orderedQuickPins().concat(action);
    await persistQuickFavorites(nextPins, `${entry.label} 已加入收藏。`, {
      focusAction: action,
      focusKind: "run",
    });
  }

  async function removeQuickFavorite(action) {
    const entry = getQuickEntry(action);
    if (!entry || !quickPins.includes(action)) return;
    const ordered = orderedQuickPins().filter((item) => item !== action);
    await persistQuickFavorites(ordered, `${entry.label} 已取消收藏。`, {
      preserveFocus: true,
    });
  }

  function syncQuickFavoriteStates() {
    document.querySelectorAll(".wo-quick-trigger[data-quick-action]").forEach((trigger) => {
      const action = trigger.getAttribute("data-quick-action");
      const entry = getQuickEntry(action);
      if (!entry) return;
      const availability = quickAvailability(entry);
      const active = getQuickActiveState(action);
      const busy = quickActionBusy.has(action);
      const disabled = !availability.available || busy;
      const statusText = quickStatusText(entry, availability, active, busy);
      const row = trigger.closest(".wo-quick-row");
      trigger.classList.toggle("is-on", active);
      trigger.classList.toggle("is-disabled", disabled);
      trigger.classList.toggle("is-busy", busy);
      trigger.disabled = disabled;
      trigger.title = disabled ? statusText : entry.label;
      trigger.setAttribute("aria-label", `${entry.label}，${statusText}`);
      if (entry.stateful) {
        trigger.setAttribute("role", "switch");
        trigger.setAttribute("aria-checked", active ? "true" : "false");
      } else {
        trigger.removeAttribute("role");
        trigger.removeAttribute("aria-checked");
      }
      if (row) {
        row.classList.toggle("is-on", active);
        row.classList.toggle("is-disabled", disabled);
        row.classList.toggle("is-busy", busy);
      }
      const status = trigger.querySelector(".wo-chip-text small");
      if (status) status.textContent = statusText;
      const trailing = trigger.querySelector(".wo-quick-trailing");
      if (trailing) trailing.innerHTML = quickTrailingHtml(entry, active, busy);
    });
  }

  async function runQuickFavorite(trigger) {
    if (!trigger || trigger.disabled) return;
    const action = trigger.getAttribute("data-quick-action");
    const entry = getQuickEntry(action);
    const availability = quickAvailability(entry);
    if (!entry || !availability.available || quickActionBusy.has(action)) {
      if (availability.reason) announceQuick(availability.reason, "warning");
      return;
    }

    const active = getQuickActiveState(action);
    const payload = entry.stateful ? { mode: active ? "disable" : "enable" } : null;
    quickActionBusy.add(action);
    syncQuickFavoriteStates();
    try {
      await actionClient.executeAction(action, payload, { tabId: activeTab.id });
      announceQuick(
        entry.stateful ? `${entry.label}${active ? "已关闭" : "已开启"}。` : `${entry.label} 已执行。`,
        "success"
      );
      await sleep(140);
      await scheduleRefresh();
    } catch (error) {
      console.warn("[WO Side] Favorite action failed:", error);
      announceQuick(error && error.message ? error.message : "操作未完成。", "error");
    } finally {
      quickActionBusy.delete(action);
      syncQuickFavoriteStates();
    }
  }

  function getQuickRows(list) {
    return list
      ? Array.from(list.querySelectorAll(":scope > .wo-quick-row[data-quick-row]"))
      : [];
  }

  function getQuickPointerPoint(event) {
    if (event && typeof event.getCoalescedEvents === "function") {
      const points = event.getCoalescedEvents();
      if (points && points.length) return points[points.length - 1];
    }
    return event;
  }

  function getQuickDropBefore(drag, clientY) {
    let closestOffset = Number.NEGATIVE_INFINITY;
    let before = null;
    getQuickRows(drag.list).forEach((row) => {
      if (row === drag.row) return;
      const rect = row.getBoundingClientRect();
      const offset = clientY - rect.top - rect.height / 2;
      if (offset < 0 && offset > closestOffset) {
        closestOffset = offset;
        before = row;
      }
    });
    return before;
  }

  function getNextQuickRow(node, skippedRow) {
    let next = node ? node.nextElementSibling : null;
    while (next) {
      if (next !== skippedRow && next.matches && next.matches(".wo-quick-row[data-quick-row]")) {
        return next;
      }
      next = next.nextElementSibling;
    }
    return null;
  }

  function animateQuickListChange(drag, mutate) {
    const items = Array.from(drag.list.children).filter((item) =>
      item !== drag.row &&
      (item.matches(".wo-quick-row[data-quick-row]") || item.classList.contains("wo-quick-drag-placeholder"))
    );
    const firstRects = new Map(items.map((item) => [item, item.getBoundingClientRect()]));
    mutate();
    requestAnimationFrame(() => {
      items.forEach((item) => {
        if (!item.isConnected) return;
        const first = firstRects.get(item);
        const last = item.getBoundingClientRect();
        const deltaX = first.left - last.left;
        const deltaY = first.top - last.top;
        if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;
        item.classList.add("wo-quick-settling");
        item.style.transition = "none";
        item.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0) scale(.994)`;
        requestAnimationFrame(() => {
          if (!item.isConnected) return;
          item.style.transition = "transform 240ms cubic-bezier(.32, 0, .18, 1)";
          item.style.transform = "";
          setTimeout(() => {
            if (!item.isConnected) return;
            item.classList.remove("wo-quick-settling");
            item.style.removeProperty("transition");
            item.style.removeProperty("transform");
          }, 300);
        });
      });
    });
  }

  function moveQuickPlaceholder(drag, clientY) {
    if (!drag || !drag.placeholder || !drag.placeholder.isConnected) return;
    const before = getQuickDropBefore(drag, clientY);
    const currentNext = getNextQuickRow(drag.placeholder, drag.row);
    if (before) {
      if (before === currentNext) return;
      animateQuickListChange(drag, () => drag.list.insertBefore(drag.placeholder, before));
      return;
    }
    if (!currentNext) return;
    animateQuickListChange(drag, () => drag.list.appendChild(drag.placeholder));
  }

  function applyQuickDragFrame(drag) {
    if (!drag || !drag.proxy) return;
    drag.frameId = 0;
    const x = drag.latestX - drag.pointerOffsetX - drag.originLeft;
    const y = drag.latestY - drag.pointerOffsetY - drag.originTop;
    drag.proxy.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
  }

  function scheduleQuickDragFrame(drag, clientX, clientY) {
    if (!drag || !drag.proxy) return;
    drag.latestX = clientX;
    drag.latestY = clientY;
    if (drag.frameId) return;
    drag.frameId = requestAnimationFrame(() => applyQuickDragFrame(drag));
  }

  function startQuickDrag(drag, point) {
    const rect = drag.row.getBoundingClientRect();
    const placeholder = document.createElement("div");
    placeholder.className = "wo-quick-drag-placeholder";
    placeholder.style.height = `${rect.height}px`;
    const proxy = drag.row.cloneNode(true);
    proxy.classList.add("wo-quick-drag-proxy");
    proxy.classList.remove("wo-quick-drag-source");
    proxy.setAttribute("aria-hidden", "true");
    proxy.querySelectorAll("button, input, select, [tabindex]").forEach((item) => {
      item.setAttribute("tabindex", "-1");
    });

    drag.row.after(placeholder);
    document.body.appendChild(proxy);
    drag.dragging = true;
    drag.placeholder = placeholder;
    drag.proxy = proxy;
    drag.originLeft = rect.left;
    drag.originTop = rect.top;
    drag.pointerOffsetX = Math.min(Math.max(drag.startX - rect.left, 0), rect.width);
    drag.pointerOffsetY = Math.min(Math.max(drag.startY - rect.top, 0), rect.height);
    drag.latestX = point.clientX;
    drag.latestY = point.clientY;
    drag.row.classList.add("wo-quick-drag-source");
    drag.row.setAttribute("aria-grabbed", "true");
    Object.assign(drag.row.style, {
      position: "fixed",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      zIndex: "1000",
      pointerEvents: "none",
      margin: "0",
    });
    Object.assign(proxy.style, {
      position: "fixed",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      zIndex: "1001",
      pointerEvents: "none",
      margin: "0",
      willChange: "transform",
    });
    drag.list.classList.add("wo-quick-list-dragging");
    quickSuppressClick = true;
    scheduleQuickDragFrame(drag, point.clientX, point.clientY);
  }

  function resetQuickDragRow(row) {
    if (!row) return;
    ["position", "left", "top", "width", "height", "z-index", "pointer-events", "margin", "transform", "transition", "will-change"]
      .forEach((name) => row.style.removeProperty(name));
    row.classList.remove("wo-quick-drag-source");
    row.setAttribute("aria-grabbed", "false");
  }

  function cleanupQuickDrag(drag) {
    if (!drag) return;
    if (drag.frameId) cancelAnimationFrame(drag.frameId);
    drag.frameId = 0;
    try {
      if (drag.handle && drag.handle.hasPointerCapture(drag.pointerId)) {
        drag.handle.releasePointerCapture(drag.pointerId);
      }
    } catch (_) {}
    resetQuickDragRow(drag.row);
    if (drag.proxy && drag.proxy.isConnected) drag.proxy.remove();
    if (drag.placeholder && drag.placeholder.isConnected) drag.placeholder.remove();
    if (drag.list) drag.list.classList.remove("wo-quick-list-dragging");
  }

  function cancelQuickDrag(options) {
    const drag = quickDrag;
    if (!drag) return;
    quickDrag = null;
    cleanupQuickDrag(drag);
    quickSuppressClick = false;
    if (options && options.render) renderQuickFavorites({ preserveFocus: true });
  }

  function prefersReducedQuickMotion() {
    return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function animateQuickDrop(drag) {
    if (!drag || !drag.proxy || !drag.placeholder || !drag.placeholder.isConnected || prefersReducedQuickMotion()) {
      return Promise.resolve();
    }
    if (drag.frameId) cancelAnimationFrame(drag.frameId);
    drag.frameId = 0;
    applyQuickDragFrame(drag);
    const proxyRect = drag.proxy.getBoundingClientRect();
    const slotRect = drag.placeholder.getBoundingClientRect();
    Object.assign(drag.proxy.style, {
      left: `${proxyRect.left}px`,
      top: `${proxyRect.top}px`,
      width: `${proxyRect.width}px`,
      height: `${proxyRect.height}px`,
      transform: "translate3d(0, 0, 0) scale(1.012)",
      transition: "left 160ms cubic-bezier(.32, 0, .18, 1), top 160ms cubic-bezier(.32, 0, .18, 1), width 160ms cubic-bezier(.32, 0, .18, 1), height 160ms cubic-bezier(.32, 0, .18, 1), transform 180ms cubic-bezier(.32, 0, .18, 1)",
    });
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        if (!drag.proxy || !drag.proxy.isConnected) return resolve();
        drag.proxy.style.left = `${slotRect.left}px`;
        drag.proxy.style.top = `${slotRect.top}px`;
        drag.proxy.style.width = `${slotRect.width}px`;
        drag.proxy.style.height = `${slotRect.height}px`;
        drag.proxy.style.transform = "translate3d(0, 0, 0) scale(1)";
        setTimeout(resolve, 190);
      });
    });
  }

  function triggerQuickDropConfirm(row) {
    if (!row || !row.isConnected) return;
    row.classList.remove("wo-quick-drop-confirm");
    void row.offsetWidth;
    row.classList.add("wo-quick-drop-confirm");
    setTimeout(() => row.isConnected && row.classList.remove("wo-quick-drop-confirm"), QUICK_DROP_CONFIRM_MS);
  }

  async function finishQuickDrag() {
    const drag = quickDrag;
    if (!drag) return;
    quickDrag = null;
    if (!drag.dragging) {
      cleanupQuickDrag(drag);
      return;
    }
    await animateQuickDrop(drag);
    if (drag.placeholder && drag.placeholder.isConnected) {
      drag.list.insertBefore(drag.row, drag.placeholder);
    }
    const order = getQuickRows(drag.list).map((row) => row.getAttribute("data-quick-row"));
    const droppedRow = drag.row;
    cleanupQuickDrag(drag);
    triggerQuickDropConfirm(droppedRow);
    await persistQuickFavorites(order, "收藏顺序已同步。", { render: false });
    setTimeout(() => { quickSuppressClick = false; }, 0);
  }

  function handleQuickDragPointerDown(event) {
    if (event.button !== 0 || event.isPrimary === false || quickStoreBusy) return;
    const handle = event.target.closest(".wo-quick-drag-handle[data-quick-drag-action]");
    if (!handle || handle.disabled) return;
    const row = handle.closest(".wo-quick-row[data-quick-row]");
    const list = row && row.closest("#woToggleList");
    if (!row || !list || getQuickRows(list).length < 2) return;
    quickDrag = {
      handle,
      row,
      list,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      latestX: event.clientX,
      latestY: event.clientY,
      dragging: false,
      frameId: 0,
    };
    try { handle.setPointerCapture(event.pointerId); } catch (_) {}
  }

  function handleQuickDragPointerMove(event) {
    const drag = quickDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = getQuickPointerPoint(event);
    const distance = Math.hypot(point.clientX - drag.startX, point.clientY - drag.startY);
    if (!drag.dragging) {
      if (distance < QUICK_DRAG_DISTANCE) return;
      startQuickDrag(drag, point);
    }
    if (event.cancelable) event.preventDefault();
    scheduleQuickDragFrame(drag, point.clientX, point.clientY);
    moveQuickPlaceholder(drag, point.clientY);
  }

  function handleQuickDragPointerUp(event) {
    if (!quickDrag || quickDrag.pointerId !== event.pointerId) return;
    finishQuickDrag().catch((error) => {
      console.warn("[WO Side] Failed to reorder favorites:", error);
      cancelQuickDrag({ render: true });
    });
  }

  function handleQuickDragPointerCancel(event) {
    if (!quickDrag || quickDrag.pointerId !== event.pointerId) return;
    cancelQuickDrag({ render: true });
  }

  function handleQuickFavoriteKeydown(event) {
    if (!event.altKey || quickStoreBusy) return;
    const handle = event.target.closest(".wo-quick-drag-handle[data-quick-drag-action]");
    if (!handle) return;
    const action = handle.getAttribute("data-quick-drag-action");
    const ordered = orderedQuickPins();
    const currentIndex = ordered.indexOf(action);
    if (currentIndex < 0) return;
    let targetIndex = currentIndex;
    if (event.key === "ArrowUp") targetIndex = Math.max(0, currentIndex - 1);
    else if (event.key === "ArrowDown") targetIndex = Math.min(ordered.length - 1, currentIndex + 1);
    else if (event.key === "Home") targetIndex = 0;
    else if (event.key === "End") targetIndex = ordered.length - 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    if (targetIndex === currentIndex) return;
    ordered.splice(currentIndex, 1);
    ordered.splice(targetIndex, 0, action);
    persistQuickFavorites(ordered, "收藏顺序已同步。", {
      focusAction: action,
      focusKind: "drag",
    });
  }

  /* ---------- 一键开关 ---------- */
  async function togglePageFeature(action) {
    if (isRestrictedTab(activeTab)) return;

    const stateKey = TOGGLE_ACTION_STATE_KEYS[action];
    const mode = stateKey && pageContext.toggles[stateKey] ? "disable" : "enable";

    if (action === "TOGGLE_COMMAND_HUB") {
      await toggleCommandHubFromSidePanel(pageContext.toggles.commandHub ? "disable" : "enable");
      return;
    }

    try {
      await actionClient.executeAction(action, { mode }, { tabId: activeTab.id });
    } catch (error) {
      console.warn("[WO Side] Page action failed:", error);
    }
    await sleep(180);
    await scheduleRefresh();
  }

  async function toggleCommandHubFromSidePanel(mode) {
    if (commandHubToggleInFlight) return;
    commandHubToggleInFlight = true;

    try {
      const result = await actionClient.executeAction(
        "TOGGLE_COMMAND_HUB",
        { mode: mode || "enable" },
        { tabId: activeTab.id }
      );
      if (!result || !result.ok) {
        console.warn("[WO Side] Command Hub toggle failed:", result);
      }
    } catch (e) {
      console.warn("[WO Side] Command Hub toggle failed:", e);
    } finally {
      commandHubToggleInFlight = false;
    }

    await sleep(180);
    await scheduleRefresh();
  }

  /* ============================================================
   * 工具函数
   * ============================================================ */
  function weatherCodeLabel(code, isDay) {
    const map = {
      0: isDay ? "晴" : "晴夜",
      1: isDay ? "大致晴朗" : "夜间晴朗",
      2: "局部多云",
      3: "阴",
      45: "雾",
      48: "冻雾",
      51: "毛毛雨 · 弱",
      53: "毛毛雨",
      55: "毛毛雨 · 强",
      56: "冻毛毛雨 · 弱",
      57: "冻毛毛雨",
      61: "小雨",
      63: "中雨",
      65: "大雨",
      66: "冻雨 · 弱",
      67: "冻雨",
      71: "小雪",
      73: "中雪",
      75: "大雪",
      77: "雪粒",
      80: "阵雨",
      81: "强阵雨",
      82: "暴阵雨",
      85: "阵雪",
      86: "强阵雪",
      95: "雷暴",
      96: "雷暴 · 弱冰雹",
      99: "雷暴 · 冰雹",
    };
    return map[code] || "天气更新中";
  }

  /* —— SVG 天气图标 —— */
  function svgWeatherIcon(code, isDay) {
    const stroke = "rgba(255,255,255,0.95)";
    const accent = isDay ? "#FCD34D" : "#C4B5FD";
    if (code === 0 || code === 1) {
      return svgSun(accent, isDay);
    }
    if (code === 2) return svgSunCloud(accent);
    if (code === 3 || code === 45 || code === 48) return svgCloud(stroke);
    if (code >= 51 && code <= 67) return svgRain(stroke, "#60A5FA");
    if (code >= 71 && code <= 77) return svgSnow(stroke);
    if (code >= 80 && code <= 82) return svgRain(stroke, "#3B82F6");
    if (code === 85 || code === 86) return svgSnow(stroke);
    if (code >= 95) return svgThunder(stroke, "#FCD34D");
    return svgCloud(stroke);
  }

  function svgHourIcon(code, isDay) {
    /* 行内小图标，使用 currentColor */
    if (code === 0 || code === 1) {
      return isDay
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 0 1 11.2 3a7 7 0 1 0 9.8 9.8z"/></svg>`;
    }
    if (code === 2) return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="9" r="3"/><path d="M8 4v1M3 9h1M5 6l.7.7M11 6l-.7.7M7 18a4 4 0 0 1 .4-7.98 6 6 0 0 1 11.6 2.18A3.5 3.5 0 0 1 17.5 18z"/></svg>`;
    if (code === 3 || code === 45 || code === 48)
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18a4 4 0 0 1 .4-7.98 6 6 0 0 1 11.6 2.18A3.5 3.5 0 0 1 17.5 18z"/></svg>`;
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82))
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 14a4 4 0 0 1 .4-7.98 6 6 0 0 1 11.6 2.18A3.5 3.5 0 0 1 17.5 14z"/><path d="M9 18l-1 3M13 18l-1 3M17 18l-1 3"/></svg>`;
    if ((code >= 71 && code <= 77) || code === 85 || code === 86)
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 14a4 4 0 0 1 .4-7.98 6 6 0 0 1 11.6 2.18A3.5 3.5 0 0 1 17.5 14z"/><path d="M9 19l.01.01M13 19l.01.01M17 19l.01.01M11 21l.01.01M15 21l.01.01"/></svg>`;
    if (code >= 95)
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 14a4 4 0 0 1 .4-7.98 6 6 0 0 1 11.6 2.18A3.5 3.5 0 0 1 17.5 14z"/><path d="m11 14-2 5h3l-1 4"/></svg>`;
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18a4 4 0 0 1 .4-7.98 6 6 0 0 1 11.6 2.18A3.5 3.5 0 0 1 17.5 18z"/></svg>`;
  }

  function svgSun(color, isDay) {
    if (!isDay) {
      return `<svg viewBox="0 0 64 64" width="100%" height="100%" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M52 36a18 18 0 1 1-22-22 14 14 0 0 0 22 22z" fill="rgba(196,181,253,0.18)"/></svg>`;
    }
    return `<svg viewBox="0 0 64 64" width="100%" height="100%" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="32" cy="32" r="11" fill="rgba(252,211,77,0.32)"/><path d="M32 6v6M32 52v6M6 32h6M52 32h6M14 14l4 4M46 46l4 4M14 50l4-4M46 18l4-4"/></svg>`;
  }

  function svgSunCloud(accent) {
    return `<svg viewBox="0 0 64 64" width="100%" height="100%" fill="none" stroke="rgba(255,255,255,0.95)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="22" cy="22" r="7" fill="${accent}" stroke="${accent}"/>
      <path d="M22 9v3M9 22h3M14 14l2 2M30 14l-2 2"/>
      <path d="M19 46a8 8 0 0 1 .8-15.96 12 12 0 0 1 23.2 4.36A7 7 0 0 1 41 46z" fill="rgba(199,210,254,0.32)"/>
    </svg>`;
  }

  function svgCloud(stroke) {
    return `<svg viewBox="0 0 64 64" width="100%" height="100%" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 46a8 8 0 0 1 .8-15.96 12 12 0 0 1 23.2 4.36A7 7 0 0 1 41 46z" fill="rgba(199,210,254,0.28)"/></svg>`;
  }

  function svgRain(stroke, drop) {
    return `<svg viewBox="0 0 64 64" width="100%" height="100%" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 38a8 8 0 0 1 .8-15.96 12 12 0 0 1 23.2 4.36A7 7 0 0 1 41 38z" fill="rgba(199,210,254,0.32)"/>
      <path d="M22 46l-2 6M32 46l-2 6M42 46l-2 6" stroke="${drop}"/>
    </svg>`;
  }

  function svgSnow(stroke) {
    return `<svg viewBox="0 0 64 64" width="100%" height="100%" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 38a8 8 0 0 1 .8-15.96 12 12 0 0 1 23.2 4.36A7 7 0 0 1 41 38z" fill="rgba(199,210,254,0.34)"/>
      <path d="M22 48l.01.01M30 50l.01.01M38 48l.01.01M26 54l.01.01M34 54l.01.01"/>
    </svg>`;
  }

  function svgThunder(stroke, bolt) {
    return `<svg viewBox="0 0 64 64" width="100%" height="100%" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 38a8 8 0 0 1 .8-15.96 12 12 0 0 1 23.2 4.36A7 7 0 0 1 41 38z" fill="rgba(199,210,254,0.30)"/>
      <path d="M30 38l-4 10h6l-2 8" stroke="${bolt}" stroke-width="2.4"/>
    </svg>`;
  }

  function buildWeatherLabel(match) {
    return [match.name, match.admin1, match.country].filter(Boolean).join(" · ");
  }

  function formatWeatherUpdateTime(value) {
    if (!value) return "刚刚更新";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "刚刚更新";
    return `更新于 ${d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  }

  function formatHourShort(value) {
    if (!value) return "";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return `${String(d.getHours()).padStart(2, "0")}时`;
  }

  function formatHm(value) {
    if (!value) return "--:--";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "--:--";
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }

  function formatWeekday(value) {
    if (!value) return "--";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "--";
    const map = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    return map[d.getDay()];
  }

  function formatNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "--";
    return Math.round(n);
  }

  function uvLevel(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "";
    if (n < 3) return "弱";
    if (n < 6) return "中等";
    if (n < 8) return "强";
    if (n < 11) return "很强";
    return "极强";
  }

  function windDirLabel(deg) {
    const n = Number(deg);
    if (!Number.isFinite(n)) return "";
    const arr = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
    return arr[Math.round(((n % 360) / 45)) % 8];
  }

  function normalizeLanguageCode(value) {
    const lang = String(value || "").toLowerCase();
    if (!lang) return "";
    if (lang.startsWith("zh")) return "zh-CN";
    if (lang.startsWith("en")) return "en";
    if (lang.startsWith("ja")) return "ja";
    if (lang.startsWith("ko")) return "ko";
    if (lang.startsWith("fr")) return "fr";
    if (lang.startsWith("de")) return "de";
    if (lang.startsWith("es")) return "es";
    if (lang.startsWith("ru")) return "ru";
    return "";
  }

  function humanizeLanguage(value) {
    const n = normalizeLanguageCode(value) || value;
    const found = LANGUAGE_OPTIONS.find((i) => i.value === n);
    return found ? found.label : String(value || "未知语言");
  }

  function shorten(text, maxLength) {
    const v = String(text || "").trim();
    if (v.length <= maxLength) return v;
    return `${v.slice(0, maxLength - 1)}…`;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
