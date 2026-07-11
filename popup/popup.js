(function() {
  "use strict";

  const actionClient = globalThis.WebOmniActionClient;
  const sharedRegistry = globalThis.WebOmniActionRegistry;
  const fetchJson = globalThis.WebOmniNetwork.fetchJson;

  const INPUT_TM_STORAGE_KEY = "woInputTMEnabled";
  const WEATHER_QUERY_STORAGE_KEY = "woPopupWeatherQuery";
  const TRANSLATE_PREFS_STORAGE_KEY = "woPopupTranslatePrefs";
  const TRANSLATE_MAX_BYTES = 450;
  const PAGE_TRANSLATE_CHUNK_BYTES = 380;
  const PAGE_TRANSLATE_CONCURRENCY = 3;
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
  const SUPPORTED_LANGUAGE_VALUES = new Set(LANGUAGE_OPTIONS.map((item) => item.value));

  let activeTab = null;
  let pageContext = {
    selection: "",
    title: "",
    url: "",
    lang: "",
    supported: false,
    pageTranslated: false,
    pageTranslateCount: 0,
    pageTranslateSource: "",
    pageTranslateTarget: "",
  };
  let lastWeatherRequest = null;
  let commandHubToggleInFlight = false;
  const popupUpdateAnimations = new WeakMap();
  const pageTranslateCache = new Map();

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    applyPopupTheme();
    initLanguageSelectors();
    bindEvents();
    loadLocalPrefs();
    activeTab = await getActiveTab();
    await refreshPageState();
    updateTranslateCounter();
    maybePrefillSelection();
    maybeAutoLoadWeather();
  }

  function bindEvents() {
    document.addEventListener("click", async (event) => {
      const pageButton = event.target.closest("[data-page]");
      if (pageButton) {
        const page = pageButton.getAttribute("data-page");
        if (!page) return;
        const action = actionClient.findActionByInternalPage(page);
        if (!action) return;
        try {
          await actionClient.executeAction(action, null, { tabId: activeTab && activeTab.id });
          window.close();
        } catch (error) {
          console.warn("[WO Popup] Failed to open tool page:", error);
        }
        return;
      }

      const jumpButton = event.target.closest("[data-jump-target]");
      if (jumpButton) {
        const targetId = jumpButton.getAttribute("data-jump-target");
        const target = targetId ? document.getElementById(targetId) : null;
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        return;
      }

      const toggleRow = event.target.closest(".wo-toggle-chip[data-toggle-action], .toggle-row[data-toggle-action]");
      if (toggleRow) {
        event.preventDefault();
        await togglePageFeature(toggleRow.getAttribute("data-toggle-action"));
        return;
      }

      const hubButton = event.target.closest("[data-command-hub]");
      if (hubButton) {
        await togglePageFeature("TOGGLE_COMMAND_HUB", true);
      }
    });

    document.getElementById("weatherSearchBtn").addEventListener("click", () => {
      runWeatherSearch(document.getElementById("weatherQuery").value);
    });
    document.getElementById("weatherRefreshBtn").addEventListener("click", refreshWeather);
    document.getElementById("weatherLocateBtn").addEventListener("click", locateWeather);
    document.getElementById("weatherQuery").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        runWeatherSearch(event.target.value);
      }
    });
    document.getElementById("suggestWeatherAction").addEventListener("click", async () => {
      const weatherQuery = document.getElementById("weatherQuery").value.trim();
      if (weatherQuery) {
        await runWeatherSearch(weatherQuery);
        return;
      }
      await locateWeather();
    });

    document.getElementById("translateInput").addEventListener("input", () => {
      updateTranslateCounter();
      saveTranslatePrefs();
    });
    document.getElementById("translateSource").addEventListener("change", saveTranslatePrefs);
    document.getElementById("translateTarget").addEventListener("change", saveTranslatePrefs);
    document.getElementById("translateRunBtn").addEventListener("click", runTranslate);
    document.getElementById("translateCopyBtn").addEventListener("click", copyTranslation);
    document.getElementById("translatePageBtn").addEventListener("click", runFullPageTranslate);
    document.getElementById("translateRestoreBtn").addEventListener("click", restoreFullPageTranslation);
    document.getElementById("useSelectionBtn").addEventListener("click", fillSelectionIntoTranslator);
    document.getElementById("suggestTranslateSelected").addEventListener("click", async () => {
      if (pageContext.selection.trim()) {
        fillSelectionIntoTranslator();
        await runTranslate();
        return;
      }

      await runFullPageTranslate();
    });
    document.getElementById("swapLanguagesBtn").addEventListener("click", swapTranslateLanguages);
  }

  function applyPopupTheme() {
    document.documentElement.dataset.woTheme = "dark";
  }

  function initLanguageSelectors() {
    const sourceSelect = document.getElementById("translateSource");
    const targetSelect = document.getElementById("translateTarget");

    sourceSelect.innerHTML = LANGUAGE_OPTIONS.map((item) =>
      `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`
    ).join("");

    targetSelect.innerHTML = LANGUAGE_OPTIONS
      .filter((item) => item.value !== "auto")
      .map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`)
      .join("");
  }

  function loadLocalPrefs() {
    try {
      const weatherQuery = localStorage.getItem(WEATHER_QUERY_STORAGE_KEY);
      if (weatherQuery) {
        document.getElementById("weatherQuery").value = weatherQuery;
      }
    } catch (error) {}

    try {
      const raw = localStorage.getItem(TRANSLATE_PREFS_STORAGE_KEY);
      if (!raw) {
        document.getElementById("translateSource").value = "auto";
        document.getElementById("translateTarget").value = "zh-CN";
        return;
      }

      const prefs = JSON.parse(raw);
      const source = SUPPORTED_LANGUAGE_VALUES.has(prefs.source) ? prefs.source : "auto";
      const target = SUPPORTED_LANGUAGE_VALUES.has(prefs.target) && prefs.target !== "auto" ? prefs.target : "zh-CN";
      document.getElementById("translateSource").value = source;
      document.getElementById("translateTarget").value = target;
      if (typeof prefs.input === "string") {
        document.getElementById("translateInput").value = prefs.input;
      }
    } catch (error) {
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
    } catch (error) {}
  }

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
    return RESTRICTED_PREFIXES.some((prefix) => url.startsWith(prefix));
  }

  async function refreshPageState() {
    const rows = Array.from(document.querySelectorAll(".wo-toggle-chip[data-state-key], .toggle-row[data-state-key]"));
    const scope = document.getElementById("toggleScope");

    if (isRestrictedTab(activeTab)) {
      pageContext = {
        selection: "",
        title: "",
        url: "",
        lang: "",
        supported: false,
        pageTranslated: false,
        pageTranslateCount: 0,
        pageTranslateSource: "",
        pageTranslateTarget: "",
      };
      if (scope) scope.textContent = "受限页面";
      rows.forEach((row) => applyRowState(row, false, true));
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
      title: "",
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
              return String(window.getSelection ? window.getSelection() : "").trim().slice(0, 320);
            } catch (error) {
              return "";
            }
          })();

          return {
            commandHubState: overlay ? String(overlay.dataset.woHubState || "") : "",
            commandHub: Boolean(
              overlay &&
              (
                overlay.dataset.woHubState === "open" ||
                overlay.dataset.woHubState === "opening" ||
                (
                  !overlay.dataset.woHubState &&
                  window.getComputedStyle(overlay).display !== "none" &&
                  overlay.style.display !== "none"
                )
              )
            ),
            darkMode: document.documentElement.classList.contains("web-omni-force-dark"),
            readerMode: document.body.classList.contains("web-omni-reader-mode"),
            audioNormalize: Boolean(window.webOmniAudioNormState && window.webOmniAudioNormState.active),
            selection,
            title: document.title || "",
            url: location.href,
            lang: document.documentElement.lang || navigator.language || "",
            pageTranslated: Boolean(window.webOmniPageTranslatorState && window.webOmniPageTranslatorState.active),
            pageTranslateCount: Number(window.webOmniPageTranslatorState && window.webOmniPageTranslatorState.translatedCount) || 0,
            pageTranslateSource: String(window.webOmniPageTranslatorState && window.webOmniPageTranslatorState.sourceLang || ""),
            pageTranslateTarget: String(window.webOmniPageTranslatorState && window.webOmniPageTranslatorState.targetLang || ""),
          };
        },
      });

      state = { ...state, ...(results[0] && results[0].result ? results[0].result : {}) };
    } catch (error) {
      console.warn("[WO Popup] Failed to read page state:", error);
      state.supported = false;
    }

    pageContext = {
      selection: String(state.selection || ""),
      title: String(state.title || ""),
      url: String(state.url || ""),
      lang: String(state.lang || ""),
      supported: Boolean(state.supported),
      pageTranslated: Boolean(state.pageTranslated),
      pageTranslateCount: Number(state.pageTranslateCount) || 0,
      pageTranslateSource: String(state.pageTranslateSource || ""),
      pageTranslateTarget: String(state.pageTranslateTarget || ""),
    };

    if (scope) {
      scope.textContent = state.supported ? "可控制" : "读取失败";
    }

    rows.forEach((row) => {
      const key = row.getAttribute("data-state-key");
      applyRowState(row, Boolean(state[key]), !state.supported);
    });

    adaptTranslateTargetFromContext();
    syncTranslatePanelState();
    renderSuggestions();
  }

  function applyRowState(row, enabled, disabled) {
    row.classList.toggle("is-on", enabled);
    row.classList.toggle("is-disabled", disabled);
    if (row.matches("button")) {
      row.disabled = Boolean(disabled);
      row.setAttribute("role", "switch");
      row.setAttribute("aria-checked", enabled ? "true" : "false");
    }

    const button = row.querySelector(".toggle-switch");
    const text = row.querySelector(".toggle-switch-text");
    if (button) {
      button.disabled = Boolean(disabled);
      button.setAttribute("aria-pressed", enabled ? "true" : "false");
    }
    if (text) {
      text.textContent = disabled ? "不可用" : (enabled ? "已开" : "已关");
    }
  }

  function syncTranslatePanelState() {
    const pageButton = document.getElementById("translatePageBtn");
    const restoreButton = document.getElementById("translateRestoreBtn");
    const meta = document.getElementById("translatePageMeta");

    if (!pageButton || !restoreButton || !meta) return;

    const pageEnabled = Boolean(pageContext.supported);
    pageButton.disabled = !pageEnabled;
    restoreButton.disabled = !pageEnabled || !pageContext.pageTranslated;

    if (!pageEnabled) {
      meta.textContent = "当前页受限，整页翻译只在普通网页里可用。";
      return;
    }

    if (pageContext.pageTranslated) {
      const count = pageContext.pageTranslateCount || 0;
      const target = pageContext.pageTranslateTarget
        ? humanizeLanguage(pageContext.pageTranslateTarget)
        : "当前目标语言";
      meta.textContent = "当前页已翻译 " + count + " 段正文，目标语言：" + target + "。";
      return;
    }

    const currentLang = pageContext.lang ? humanizeLanguage(pageContext.lang) : "自动识别";
    meta.textContent = "当前页正文尚未翻译，页面语言：" + currentLang + "。";
  }

  function renderSuggestions() {
    const selection = pageContext.selection.trim();
    const suggestionHint = document.getElementById("suggestionHint");
    const suggestionCount = document.getElementById("suggestionCount");
    const translateTitle = document.getElementById("suggestTranslateTitle");
    const translateCopy = document.getElementById("suggestTranslateCopy");
    const weatherTitle = document.getElementById("suggestWeatherTitle");
    const weatherCopy = document.getElementById("suggestWeatherCopy");

    suggestionCount.textContent = selection ? "2+" : "2";

    if (!pageContext.supported) {
      suggestionHint.textContent = "当前页面受限";
      translateTitle.textContent = "先打开普通网页再翻译选中文本";
      translateCopy.textContent = "像 chrome:// 这类页面不能读取选区，但天气仍可用。";
    } else if (selection) {
      suggestionHint.textContent = "已识别当前选区";
      translateTitle.textContent = "翻译当前选中的内容";
      translateCopy.textContent = shorten(selection, 54);
    } else if (pageContext.pageTranslated) {
      suggestionHint.textContent = "当前页已整页翻译";
      translateTitle.textContent = "继续补翻新加载的正文";
      translateCopy.textContent = "如果页面刚刚滚动加载了新内容，可以再点一次补齐。";
    } else {
      suggestionHint.textContent = "根据当前页面内容";
      translateTitle.textContent = "翻译当前页面正文";
      translateCopy.textContent = pageContext.lang
        ? "检测到页面语言：" + humanizeLanguage(pageContext.lang) + "，可直接整页翻译。"
        : "如果你不先选中文本，这里会优先尝试整页正文翻译。";
    }

    const query = document.getElementById("weatherQuery").value.trim();
    if (query) {
      weatherTitle.textContent = "刷新 " + query + " 的天气";
      weatherCopy.textContent = "直接在主页查询，不用再打开新页面。";
    } else {
      weatherTitle.textContent = "查看今天的天气";
      weatherCopy.textContent = "输入城市，或尝试定位。";
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
    const hasSavedInput = document.getElementById("translateInput").value.trim();
    if (hasSavedInput) return;

    if (source.value !== "auto") return;
    const normalized = normalizeLanguageCode(pageContext.lang);
    if (normalized && normalized.startsWith("zh")) {
      target.value = "en";
    } else {
      target.value = "zh-CN";
    }
    saveTranslatePrefs();
  }

  function updateTranslateCounter() {
    const input = document.getElementById("translateInput");
    const counter = document.getElementById("translateCount");
    const button = document.getElementById("translateRunBtn");
    const bytes = new TextEncoder().encode(input.value || "").byteLength;
    counter.textContent = bytes + " / " + TRANSLATE_MAX_BYTES + " bytes";
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
      status.textContent = "当前文本超过 450 bytes，公共翻译接口更适合短句和临时说明。";
      return;
    }

    output.textContent = "翻译中...";
    output.classList.remove("is-placeholder");
    status.textContent = "正在连接翻译接口...";

    try {
      const { sourceLang, targetLang, translatedText } = await translateTextCompat(text, sourceValue, targetValue);
      const normalizedSource = normalizeLanguageCode(sourceLang) || "en";
      const normalizedTarget = normalizeLanguageCode(targetLang) || "zh-CN";

      if (normalizedSource === normalizedTarget) {
        output.textContent = text;
        animatePopupUpdate(output);
        status.textContent = "源语言和目标语言相同，已直接保留原文。";
        return;
      }

      if (!translatedText) {
        throw new Error("未拿到翻译结果");
      }

      output.textContent = translatedText;
      output.classList.remove("is-placeholder");
      animatePopupUpdate(output);
      status.textContent = "翻译完成，源语言：" + humanizeLanguage(normalizedSource) + "，目标语言：" + humanizeLanguage(normalizedTarget) + "。";
    } catch (error) {
      console.warn("[WO Popup] Translate failed:", error);
      output.textContent = "翻译失败，请稍后重试，或换一段更短的文字。";
      output.classList.remove("is-placeholder");
      animatePopupUpdate(output);
      status.textContent = "当前使用公共翻译接口，网络波动或频率限制时可能会失败。";
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
    status.textContent = "正在提取当前页面的正文节点...";

    try {
      if (pageContext.pageTranslated) {
        const activeTarget = normalizeLanguageCode(pageContext.pageTranslateTarget);
        const nextTarget = normalizeLanguageCode(targetValue) || "zh-CN";
        if (activeTarget && activeTarget !== nextTarget) {
          status.textContent = "检测到当前页已是另一种目标语言，先恢复原文再重新翻译...";
          await restoreFullPageTranslation({ silent: true });
        }
      }

      const collectResult = await actionClient.executeData(
        PAGE_TRANSLATE_ACTIONS.COLLECT,
        { onlyUntranslated: true },
        { tabId: activeTab.id }
      );

      const segments = Array.isArray(collectResult && collectResult.segments)
        ? collectResult.segments.filter((item) => item && item.id && String(item.text || "").trim())
        : [];

      if (!segments.length) {
        status.textContent = pageContext.pageTranslated
          ? "当前页面暂时没有新的正文需要补翻。"
          : "没找到适合整页翻译的正文文本。";
        await refreshPageState();
        return;
      }

      const sourceLang = await detectPageSourceLanguage(segments, sourceValue, targetValue);
      const normalizedSource = normalizeLanguageCode(sourceLang) || "en";
      const normalizedTarget = normalizeLanguageCode(targetValue) || "zh-CN";

      if (normalizedSource === normalizedTarget) {
        status.textContent = "页面语言和目标语言相同，暂时不需要整页翻译。";
        return;
      }

      const translatedMap = await translatePageSegments(segments, normalizedSource, normalizedTarget, (done, total) => {
        status.textContent = "正在整页翻译 " + done + " / " + total + " 段正文...";
      });

      const translations = segments.map((segment) => ({
        id: segment.id,
        text: translatedMap.get(segment.text) || segment.text,
      }));

      const applyResult = await actionClient.executeData(
        PAGE_TRANSLATE_ACTIONS.APPLY,
        { translations, meta: { sourceLang: normalizedSource, targetLang: normalizedTarget } },
        { tabId: activeTab.id }
      );

      const applied = Number(applyResult && applyResult.applied) || 0;
      status.textContent = applied > 0
        ? "整页翻译完成，共替换 " + applied + " 段正文，目标语言：" + humanizeLanguage(normalizedTarget) + "。"
        : "这次没有替换新的正文节点。";
    } catch (error) {
      console.warn("[WO Popup] Full-page translate failed:", error);
      status.textContent = "整页翻译失败，请稍后重试，或换一个内容更简单的页面。";
    } finally {
      await refreshPageState();
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
        status.textContent = restored > 0
          ? "已恢复原文，共还原 " + restored + " 段正文。"
          : "当前页面没有需要恢复的整页翻译。";
      }
    } catch (error) {
      console.warn("[WO Popup] Restore full-page translate failed:", error);
      if (!options.silent) {
        status.textContent = "恢复原文失败，请刷新页面后重试。";
      }
    } finally {
      await refreshPageState();
    }
  }

  async function detectPageSourceLanguage(segments, sourceValue, targetValue) {
    if (sourceValue !== "auto") {
      return sourceValue;
    }

    const pageLang = normalizeLanguageCode(pageContext.lang);
    if (pageLang) {
      return pageLang;
    }

    const sampleParts = [];
    let currentBytes = 0;
    for (const segment of segments) {
      const text = String(segment.text || "").trim();
      if (!text) continue;
      const segmentBytes = new TextEncoder().encode(text).byteLength;
      if (currentBytes + segmentBytes > PAGE_TRANSLATE_CHUNK_BYTES && sampleParts.length) {
        break;
      }
      sampleParts.push(text);
      currentBytes += segmentBytes;
      if (currentBytes >= 220) break;
    }

    const sample = sampleParts.join("\n");
    return detectSourceLanguage(sample, targetValue);
  }

  async function translatePageSegments(segments, sourceLang, targetLang, onProgress) {
    const uniqueTexts = [];
    const seen = new Set();
    for (const segment of segments) {
      const text = String(segment.text || "").trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      uniqueTexts.push(text);
    }

    const translatedMap = new Map();
    let done = 0;

    await runTaskPool(uniqueTexts, PAGE_TRANSLATE_CONCURRENCY, async (text) => {
      const translated = await translateTextCompat(text, sourceLang, targetLang);
      translatedMap.set(text, translated.translatedText || text);
      done += 1;
      if (typeof onProgress === "function") {
        onProgress(done, uniqueTexts.length);
      }
    });

    return translatedMap;
  }

  async function translateTextCompat(text, sourceValue, targetValue) {
    const normalizedTarget = normalizeLanguageCode(targetValue) || "zh-CN";
    const resolvedSource = sourceValue === "auto"
      ? await detectSourceLanguage(text, normalizedTarget)
      : sourceValue;
    const normalizedSource = normalizeLanguageCode(resolvedSource) || "en";

    if (normalizedSource === normalizedTarget) {
      return {
        sourceLang: normalizedSource,
        targetLang: normalizedTarget,
        translatedText: String(text || ""),
      };
    }

    const chunks = splitTextForTranslation(text, PAGE_TRANSLATE_CHUNK_BYTES);
    const translatedChunks = [];
    for (const chunk of chunks) {
      translatedChunks.push(await requestTranslationChunk(chunk, normalizedSource, normalizedTarget));
    }

    return {
      sourceLang: normalizedSource,
      targetLang: normalizedTarget,
      translatedText: joinTranslatedChunks(translatedChunks),
    };
  }

  async function requestTranslationChunk(text, sourceLang, targetLang) {
    const normalizedText = String(text || "").trim();
    const cacheKey = sourceLang + "::" + targetLang + "::" + normalizedText;
    if (pageTranslateCache.has(cacheKey)) {
      return pageTranslateCache.get(cacheKey);
    }

    let translatedText = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const url = new URL(TRANSLATE_ENDPOINT);
        url.searchParams.set("q", normalizedText);
        url.searchParams.set("langpair", sourceLang + "|" + targetLang);
        url.searchParams.set("mt", "1");
        const payload = await fetchJson(url.toString(), { timeout: 12000 });
        translatedText = payload && payload.responseData && payload.responseData.translatedText
          ? String(payload.responseData.translatedText).trim()
          : "";
        if (translatedText) break;
      } catch (error) {
        if (attempt >= 1) throw error;
      }
      await sleep(450 * (attempt + 1));
    }

    if (!translatedText) {
      throw new Error("未拿到翻译结果");
    }

    pageTranslateCache.set(cacheKey, translatedText);
    return translatedText;
  }

  function splitTextForTranslation(text, maxBytes) {
    const normalized = String(text || "").replace(/\r/g, "").trim();
    if (!normalized) return [""];

    if (new TextEncoder().encode(normalized).byteLength <= maxBytes) {
      return [normalized];
    }

    const seeds = normalized
      .split(/(?<=[。！？!?；;：:])\s+|(?:\n+)/u)
      .map((item) => item.trim())
      .filter(Boolean);

    const pieces = [];
    const queue = seeds.length ? seeds.slice() : [normalized];
    while (queue.length) {
      const current = queue.shift();
      if (!current) continue;

      if (new TextEncoder().encode(current).byteLength <= maxBytes) {
        pieces.push(current);
        continue;
      }

      const split = splitLargeSegment(current);
      if (split.length === 1) {
        pieces.push(current);
      } else {
        queue.unshift(...split);
      }
    }

    return mergeChunksBySize(pieces, maxBytes);
  }

  function splitLargeSegment(text) {
    const patterns = [
      /[^，,]+[，,]?/g,
      /[^、]+[、]?/g,
      /\S+\s*/g,
    ];

    for (const pattern of patterns) {
      const fragments = (text.match(pattern) || [])
        .map((item) => item.trim())
        .filter(Boolean);
      if (fragments.length > 1) {
        return fragments;
      }
    }

    const midpoint = Math.max(1, Math.floor(text.length / 2));
    return [text.slice(0, midpoint).trim(), text.slice(midpoint).trim()].filter(Boolean);
  }

  function mergeChunksBySize(chunks, maxBytes) {
    const merged = [];
    let buffer = "";

    for (const chunk of chunks) {
      const candidate = buffer ? buffer + "\n" + chunk : chunk;
      if (new TextEncoder().encode(candidate).byteLength <= maxBytes) {
        buffer = candidate;
        continue;
      }

      if (buffer) {
        merged.push(buffer);
      }
      buffer = chunk;
    }

    if (buffer) {
      merged.push(buffer);
    }

    return merged.length ? merged : chunks;
  }

  function joinTranslatedChunks(chunks) {
    return chunks
      .map((item) => String(item || "").trim())
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
      const result = await new Promise((resolve, reject) => {
        chrome.i18n.detectLanguage(text, (info) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message));
            return;
          }
          resolve(info);
        });
      });

      const languages = Array.isArray(result && result.languages) ? result.languages : [];
      const first = languages.find((item) => normalizeLanguageCode(item.language));
      const normalized = normalizeLanguageCode(first && first.language);
      if (normalized) return normalized;
    } catch (error) {
      console.warn("[WO Popup] Language detection failed:", error);
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
      const previousSource = source.value;
      source.value = target.value;
      target.value = previousSource === "auto" ? "zh-CN" : previousSource;
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
    } catch (error) {
      document.getElementById("translateStatus").textContent = "复制失败，请重试。";
    }
  }

  async function maybeAutoLoadWeather() {
    const query = document.getElementById("weatherQuery").value.trim();
    if (!query) return;
    await runWeatherSearch(query, { silentStatus: true });
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
    } catch (error) {}

    if (!options.silentStatus) {
      status.textContent = "正在搜索城市并获取天气...";
    }

    try {
      const geocodeUrl = new URL(WEATHER_GEOCODE_ENDPOINT);
      geocodeUrl.searchParams.set("name", query);
      geocodeUrl.searchParams.set("count", "1");
      geocodeUrl.searchParams.set("language", "zh");
      geocodeUrl.searchParams.set("format", "json");
      const geocodePayload = await fetchJson(geocodeUrl.toString(), { timeout: 12000 });
      const match = geocodePayload && Array.isArray(geocodePayload.results) ? geocodePayload.results[0] : null;

      if (!match) {
        throw new Error("未找到对应城市");
      }

      lastWeatherRequest = {
        mode: "city",
        query,
        label: buildWeatherLabel(match),
        latitude: match.latitude,
        longitude: match.longitude,
      };

      await fetchWeatherByCoordinates(match.latitude, match.longitude, buildWeatherLabel(match));
    } catch (error) {
      console.warn("[WO Popup] Weather lookup failed:", error);
      setWeatherError("没有找到这个城市的天气，请换一个城市名再试。");
    }
  }

  async function locateWeather() {
    const status = document.getElementById("weatherStatus");
    status.textContent = "正在尝试定位...";

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
    } catch (error) {
      console.warn("[WO Popup] Weather geolocation failed:", error);
      setWeatherError("定位失败。你可以直接输入城市名称查询天气。");
    }
  }

  async function refreshWeather() {
    if (!lastWeatherRequest) {
      const query = document.getElementById("weatherQuery").value.trim();
      if (query) {
        await runWeatherSearch(query);
      } else {
        document.getElementById("weatherStatus").textContent = "还没有天气请求，先输入城市或尝试定位。";
      }
      return;
    }

    if (lastWeatherRequest.mode === "coords") {
      await fetchWeatherByCoordinates(lastWeatherRequest.latitude, lastWeatherRequest.longitude, lastWeatherRequest.label);
      return;
    }

    await runWeatherSearch(lastWeatherRequest.query);
  }

  async function fetchWeatherByCoordinates(latitude, longitude, label) {
    const status = document.getElementById("weatherStatus");
    status.textContent = "正在刷新天气...";

    try {
      const weatherUrl = new URL(WEATHER_FORECAST_ENDPOINT);
      weatherUrl.searchParams.set("latitude", String(latitude));
      weatherUrl.searchParams.set("longitude", String(longitude));
      weatherUrl.searchParams.set("current", "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day");
      weatherUrl.searchParams.set("daily", "temperature_2m_max,temperature_2m_min");
      weatherUrl.searchParams.set("forecast_days", "1");
      weatherUrl.searchParams.set("timezone", "auto");
      const payload = await fetchJson(weatherUrl.toString(), { timeout: 12000 });
      renderWeather(payload, label);
      status.textContent = "天气已更新。";
    } catch (error) {
      console.warn("[WO Popup] Weather fetch failed:", error);
      setWeatherError("天气接口暂时不可用，请稍后重试。");
    }
  }

  function renderWeather(payload, label) {
    const current = payload && payload.current ? payload.current : null;
    const daily = payload && payload.daily ? payload.daily : null;
    if (!current) {
      throw new Error("missing current weather");
    }

    const max = daily && Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[0] : null;
    const min = daily && Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[0] : null;
    const description = weatherCodeLabel(Number(current.weather_code), Boolean(current.is_day));

    document.getElementById("weatherLocation").textContent = label || "天气结果";
    document.getElementById("weatherUpdated").textContent = formatWeatherUpdateTime(current.time);
    document.getElementById("weatherTemp").textContent = formatNumber(current.temperature_2m) + "°";
    document.getElementById("weatherDesc").textContent = description;
    document.getElementById("weatherRange").textContent = (max == null || min == null)
      ? "最高 -- / 最低 --"
      : "最高 " + formatNumber(max) + "° / 最低 " + formatNumber(min) + "°";
    document.getElementById("weatherFeels").textContent = formatNumber(current.apparent_temperature) + "°";
    document.getElementById("weatherWind").textContent = formatNumber(current.wind_speed_10m) + " km/h";
    animatePopupUpdate(document.getElementById("weatherCard"));
  }

  function setWeatherError(text) {
    document.getElementById("weatherStatus").textContent = text;
    document.getElementById("weatherLocation").textContent = "天气请求失败";
    document.getElementById("weatherUpdated").textContent = "请稍后重试";
    document.getElementById("weatherTemp").textContent = "--";
    document.getElementById("weatherDesc").textContent = text;
    document.getElementById("weatherRange").textContent = "-- / --";
    document.getElementById("weatherFeels").textContent = "--";
    document.getElementById("weatherWind").textContent = "--";
    animatePopupUpdate(document.getElementById("weatherCard"));
  }

  function animatePopupUpdate(element) {
    if (!element || typeof element.animate !== "function") return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const previous = popupUpdateAnimations.get(element);
    if (previous) {
      previous.cancel();
      if (popupUpdateAnimations.get(element) === previous) popupUpdateAnimations.delete(element);
    }
    const animation = element.animate(
      [
        { opacity: .58, transform: "translate3d(0, 4px, 0)", filter: "blur(.6px)" },
        { opacity: 1, transform: "translate3d(0, 0, 0)", filter: "blur(0px)" },
      ],
      { duration: 260, easing: "cubic-bezier(.32, 0, .18, 1)" }
    );
    popupUpdateAnimations.set(element, animation);
    animation.finished.then(() => {
      if (popupUpdateAnimations.get(element) === animation) popupUpdateAnimations.delete(element);
    }).catch(() => {});
  }

  async function togglePageFeature(action, closeAfter) {
    if (isRestrictedTab(activeTab)) {
      window.close();
      return;
    }

    if (action === "TOGGLE_COMMAND_HUB") {
      await toggleCommandHubFromPopup(closeAfter);
      return;
    }

    try {
      await actionClient.executeAction(action, null, { tabId: activeTab.id });
    } catch (error) {
      console.warn("[WO Popup] Page action failed:", error);
    }

    if (closeAfter) {
      window.close();
      return;
    }

    await sleep(180);
    await refreshPageState();
  }

  async function toggleCommandHubFromPopup(closeAfter) {
    if (commandHubToggleInFlight) return;
    commandHubToggleInFlight = true;

    try {
      const result = await actionClient.executeAction(
        "TOGGLE_COMMAND_HUB",
        null,
        { tabId: activeTab.id }
      );
      if (!result || !result.ok) {
        console.warn("[WO Popup] Failed to toggle Command Hub:", result);
      }
    } catch (error) {
      console.warn("[WO Popup] Failed to toggle Command Hub:", error);
    } finally {
      commandHubToggleInFlight = false;
    }

    if (closeAfter) {
      window.close();
      return;
    }

    await sleep(180);
    await refreshPageState();
  }

  function weatherCodeLabel(code, isDay) {
    const map = {
      0: isDay ? "晴" : "晴夜",
      1: isDay ? "大致晴朗" : "大致晴夜",
      2: "局部多云",
      3: "阴天",
      45: "雾",
      48: "冻雾",
      51: "小毛毛雨",
      53: "毛毛雨",
      55: "强毛毛雨",
      56: "小冻毛毛雨",
      57: "冻毛毛雨",
      61: "小雨",
      63: "中雨",
      65: "大雨",
      66: "小冻雨",
      67: "冻雨",
      71: "小雪",
      73: "中雪",
      75: "大雪",
      77: "雪粒",
      80: "阵雨",
      81: "较强阵雨",
      82: "强阵雨",
      85: "阵雪",
      86: "强阵雪",
      95: "雷暴",
      96: "雷暴伴小冰雹",
      99: "雷暴伴冰雹",
    };
    return map[code] || "天气更新中";
  }

  function buildWeatherLabel(match) {
    const parts = [match.name, match.admin1, match.country].filter(Boolean);
    return parts.join(" · ");
  }

  function formatWeatherUpdateTime(value) {
    if (!value) return "刚刚更新";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "刚刚更新";
    return "更新于 " + date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatNumber(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "--";
    return Math.round(num);
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
    const normalized = normalizeLanguageCode(value) || value;
    const found = LANGUAGE_OPTIONS.find((item) => item.value === normalized);
    return found ? found.label : String(value || "未知语言");
  }

  function shorten(text, maxLength) {
    const value = String(text || "").trim();
    if (value.length <= maxLength) return value;
    return value.slice(0, maxLength - 1) + "…";
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
