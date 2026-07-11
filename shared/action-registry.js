(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.WebOmniActionRegistry = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function (root) {
  "use strict";

  const ERROR_CODES = Object.freeze({
    INVALID_REQUEST: "INVALID_REQUEST",
    UNKNOWN_ACTION: "UNKNOWN_ACTION",
    RESTRICTED_URL: "RESTRICTED_URL",
    MODULE_LOAD_FAILED: "MODULE_LOAD_FAILED",
    UNSUPPORTED_CONTEXT: "UNSUPPORTED_CONTEXT",
    USER_GESTURE_REQUIRED: "USER_GESTURE_REQUIRED",
    REMOTE_CONSENT_REQUIRED: "REMOTE_CONSENT_REQUIRED",
    ACTION_FAILED: "ACTION_FAILED",
    UNSUPPORTED_MV3_CSP: "UNSUPPORTED_MV3_CSP",
    VAULT_LOCKED: "VAULT_LOCKED",
  });

  const RESTRICTED_PROTOCOLS = Object.freeze([
    "about:",
    "chrome:",
    "chrome-extension:",
    "data:",
    "devtools:",
    "edge:",
    "file:",
    "view-source:",
  ]);

  const MODULES = Object.freeze({
    visualDictator: {
      scripts: ["content-scripts/visual-dictator.js"],
      marker: "webOmniVisualDictatorInjected",
    },
    dataHarvester: {
      scripts: ["content-scripts/data-harvester.js"],
      styles: ["styles/media-sniffer.css"],
      marker: "webOmniDataHarvesterInjected",
    },
    ecommerce: {
      scripts: ["content-scripts/ecommerce-scraper.js"],
      marker: "webOmniEcommerceScraperInjected",
    },
    priceComparator: {
      scripts: ["content-scripts/price-comparator.js"],
      marker: "webOmniPriceComparatorInjected",
    },
    passwordVault: {
      scripts: ["content-scripts/password-vault.js"],
      marker: "webOmniPasswordVaultInjected",
    },
    privacyShield: {
      scripts: ["content-scripts/privacy-shield.js"],
      marker: "webOmniPrivacyShieldInjected",
    },
    globalPrivacy: {
      scripts: ["content-scripts/global-privacy-mode.js"],
      marker: "webOmniGlobalPrivacyInjected",
    },
    youtube: {
      scripts: ["content-scripts/youtube-enhancer.js"],
      marker: "webOmniYouTubeEnhancerInjected",
    },
    automation: {
      scripts: ["content-scripts/automation-geek.js"],
      marker: "webOmniAutomationGeekInjected",
    },
    immersive: {
      scripts: ["content-scripts/immersive-modding.js"],
      styles: ["styles/immersive.css"],
      marker: "webOmniImmersiveModdingInjected",
    },
    pageTools: {
      scripts: ["content-scripts/page-tools.js"],
      marker: "webOmniPageToolsInjected",
    },
    pageQrCode: {
      scripts: ["lan-transfer/qrcode.min.js", "content-scripts/page-tools.js"],
      marker: "webOmniPageToolsInjected",
    },
    stickyKiller: {
      scripts: ["content-scripts/sticky-killer.js"],
      marker: "webOmniStickyKillerInjected",
    },
    cleanUrl: {
      scripts: ["content-scripts/clean-url.js"],
      marker: "webOmniCleanUrlInjected",
    },
    inputTimeMachine: {
      scripts: ["content-scripts/input-timemachine.js"],
      marker: "webOmniInputTMInjected",
    },
    audioNormalizer: {
      scripts: ["content-scripts/audio-normalizer.js"],
      marker: "webOmniAudioNormInjected",
    },
    elementPip: {
      scripts: ["content-scripts/element-pip.js"],
      marker: "webOmniElementPipInjected",
    },
    domMonitor: {
      scripts: ["content-scripts/dom-monitor.js"],
      marker: "webOmniDomMonitorInjected",
    },
    pageTranslator: {
      scripts: ["content-scripts/page-translator.js"],
      marker: "webOmniPageTranslatorInjected",
    },
    commandHub: {
      scripts: ["shared/action-registry.js", "content-scripts/command-hub.js"],
      styles: ["styles/command-hub.css"],
      marker: "webOmniCommandHubInjected",
    },
    mainWorld: {
      scripts: ["content-scripts/main-world-bridge.js"],
      world: "MAIN",
    },
  });

  const MAIN_WORLD_ACTIONS = new Set([
    "BREAK_SEALS",
    "PRIVACY_BLOCK_TRACKERS",
    "PRIVACY_FINGERPRINT_PROTECT",
    "PRIVACY_WEBRTC_PROTECT",
    "DUMP_JS_GLOBALS",
    "HIJACK_EVENTS",
    "INTERCEPT_REQUESTS",
    "BROWSER_FINGERPRINT",
    "WEBSOCKET_MONITOR",
    "CANVAS_SPOOF",
    "YT_EXTRACT_AUDIO",
    "WO_MEDIA_SNIFFER",
  ]);

  const SENSITIVE_ACTIONS = new Set([
    "VAULT_AUTO_FILL",
    "VAULT_AUTO_SAVE",
    "PRIVACY_CLEAR_COOKIES",
    "PRIVACY_CLEAN_TRACES",
    "EXTRACT_COOKIES",
    "DUMP_STORAGE",
    "REVEAL_PASSWORDS",
    "DUMP_JS_GLOBALS",
    "HIJACK_EVENTS",
    "INTERCEPT_REQUESTS",
    "WEBSOCKET_MONITOR",
    "CANVAS_SPOOF",
  ]);

  const LIFECYCLES = Object.freeze({
    INSTANT: "instant",
    TOGGLE: "toggle",
    INTERACTIVE: "interactive",
    REVERSIBLE: "reversible",
    INTERNAL: "internal",
    UNSUPPORTED: "unsupported",
    SYSTEM: "system",
  });

  const SCOPES = Object.freeze({
    PAGE: "page",
    TAB: "tab",
    GLOBAL: "global",
    DURABLE: "durable",
    EXTENSION: "extension",
    SYSTEM: "system",
  });

  const CONTROL_TYPES = Object.freeze(["disable", "undo", "restoreAll", "manage", "stop"]);

  // Stateful commands are intentionally explicit. This keeps transient extract/download
  // commands out of the activity UI and gives every persistent command a recovery path.
  const STATEFUL_ACTION_METADATA = Object.freeze({
    EXTRACT_MEDIA: {
      label: "媒体嗅探",
      lifecycle: LIFECYCLES.INTERACTIVE,
      scope: SCOPES.TAB,
      controls: ["disable", "manage"],
      pageDock: true,
    },
    ACTIVATE_VISUAL_DICTATOR: {
      label: "元素消除",
      lifecycle: LIFECYCLES.REVERSIBLE,
      scope: SCOPES.PAGE,
      controls: ["disable", "undo", "restoreAll", "manage"],
      pageDock: true,
    },
    ACTIVATE_DATA_HARVESTER: {
      label: "框选提取",
      lifecycle: LIFECYCLES.INTERACTIVE,
      scope: SCOPES.PAGE,
      controls: ["disable"],
      pageDock: true,
    },
    VAULT_AUTO_SAVE: {
      label: "密码保存监听",
      lifecycle: LIFECYCLES.TOGGLE,
      scope: SCOPES.TAB,
      controls: ["disable", "manage"],
      pageDock: false,
    },
    PRIVACY_BLOCK_TRACKERS: {
      label: "追踪器拦截",
      lifecycle: LIFECYCLES.TOGGLE,
      scope: SCOPES.PAGE,
      controls: ["disable"],
      pageDock: true,
    },
    PRIVACY_FINGERPRINT_PROTECT: {
      label: "指纹保护",
      lifecycle: LIFECYCLES.TOGGLE,
      scope: SCOPES.PAGE,
      controls: ["disable"],
      pageDock: true,
    },
    PRIVACY_WEBRTC_PROTECT: {
      label: "WebRTC 防护",
      lifecycle: LIFECYCLES.TOGGLE,
      scope: SCOPES.PAGE,
      controls: ["disable"],
      pageDock: true,
    },
    PRIVACY_ANTI_SCREENSHOT: {
      label: "页面遮挡保护",
      lifecycle: LIFECYCLES.TOGGLE,
      scope: SCOPES.PAGE,
      controls: ["disable"],
      pageDock: true,
    },
    REVEAL_PASSWORDS: {
      label: "密码明文显示",
      lifecycle: LIFECYCLES.TOGGLE,
      scope: SCOPES.PAGE,
      controls: ["disable"],
      pageDock: true,
    },
    HIJACK_EVENTS: {
      label: "事件监听",
      lifecycle: LIFECYCLES.TOGGLE,
      scope: SCOPES.PAGE,
      controls: ["disable"],
      pageDock: true,
    },
    INTERCEPT_REQUESTS: {
      label: "请求监听",
      lifecycle: LIFECYCLES.TOGGLE,
      scope: SCOPES.PAGE,
      controls: ["disable"],
      pageDock: true,
    },
    WEBSOCKET_MONITOR: {
      label: "WebSocket 监听",
      lifecycle: LIFECYCLES.TOGGLE,
      scope: SCOPES.PAGE,
      controls: ["disable"],
      pageDock: true,
    },
    CANVAS_SPOOF: {
      label: "Canvas 伪装",
      lifecycle: LIFECYCLES.TOGGLE,
      scope: SCOPES.PAGE,
      controls: ["disable"],
      pageDock: true,
    },
    YT_TOGGLE_AD_SKIP: {
      label: "YouTube 跳过广告",
      lifecycle: LIFECYCLES.TOGGLE,
      scope: SCOPES.TAB,
      controls: ["disable"],
      pageDock: false,
    },
    YT_TOGGLE_LOOP: {
      label: "YouTube 循环播放",
      lifecycle: LIFECYCLES.TOGGLE,
      scope: SCOPES.PAGE,
      controls: ["disable"],
      pageDock: true,
    },
    YT_CINEMA_MODE: {
      label: "YouTube 影院模式",
      lifecycle: LIFECYCLES.TOGGLE,
      scope: SCOPES.PAGE,
      controls: ["disable"],
      pageDock: true,
    },
    TOGGLE_DARK_MODE: {
      label: "暗黑模式",
      lifecycle: LIFECYCLES.TOGGLE,
      scope: SCOPES.PAGE,
      controls: ["disable"],
      pageDock: true,
    },
    TOGGLE_READER_MODE: {
      label: "阅读器模式",
      lifecycle: LIFECYCLES.TOGGLE,
      scope: SCOPES.PAGE,
      controls: ["disable"],
      pageDock: true,
    },
    BREAK_SEALS: {
      label: "解除页面限制",
      lifecycle: LIFECYCLES.TOGGLE,
      scope: SCOPES.PAGE,
      controls: ["disable"],
      pageDock: true,
    },
    PAGE_ANNOTATE: {
      label: "页面标注",
      lifecycle: LIFECYCLES.INTERACTIVE,
      scope: SCOPES.PAGE,
      controls: ["disable"],
      pageDock: true,
    },
    STICKY_KILL: {
      label: "膏药清理",
      lifecycle: LIFECYCLES.REVERSIBLE,
      scope: SCOPES.PAGE,
      controls: ["disable", "restoreAll"],
      pageDock: true,
    },
    INPUT_TM_TOGGLE: {
      label: "输入框保护",
      lifecycle: LIFECYCLES.TOGGLE,
      scope: SCOPES.GLOBAL,
      controls: ["disable", "manage"],
      pageDock: false,
    },
    AUDIO_NORMALIZE_TOGGLE: {
      label: "音频均衡",
      lifecycle: LIFECYCLES.TOGGLE,
      scope: SCOPES.PAGE,
      controls: ["disable", "manage"],
      pageDock: true,
    },
    ELEMENT_PIP: {
      label: "元素画中画",
      lifecycle: LIFECYCLES.INTERACTIVE,
      scope: SCOPES.PAGE,
      controls: ["disable"],
      pageDock: true,
    },
    DOM_MONITOR_ADD: {
      label: "DOM 监控",
      lifecycle: LIFECYCLES.INTERACTIVE,
      scope: SCOPES.DURABLE,
      controls: ["disable", "manage"],
      pageDock: true,
    },
  });

  const COMMAND_PRESENTATION = Object.freeze(Object.fromEntries([
    ["ACTIVATE_VISUAL_DICTATOR", "元素消除", "点击消除页面元素"],
    ["OPEN_DICTATOR_DB", "规则管理", "查看或恢复已消除元素"],
    ["EXTRACT_MEDIA", "提取图片/视频", "嗅探页面媒体资源"],
    ["ECOMMERCE_SCRAPE", "电商图片爬取", "淘宝、京东、1688 批量取图"],
    ["EXTRACT_MARKDOWN", "剪藏Markdown", "正文转 Markdown"],
    ["ACTIVATE_DATA_HARVESTER", "框选提取", "框选文本或表格"],
    ["PRICE_COMPARE", "多平台比价", "淘宝、京东、拼多多、1688 比价"],
    ["OPEN_VAULT", "密码金库", "AES-256 加密保险箱"],
    ["PASSWORD_GENERATOR", "密码生成器", "生成强随机密码"],
    ["VAULT_AUTO_FILL", "一键填充", "自动填充登录信息"],
    ["VAULT_AUTO_SAVE", "自动保存", "检测并保存新密码"],
    ["PRIVACY_SCAN", "隐私评分", "扫描页面隐私风险"],
    ["PRIVACY_BLOCK_TRACKERS", "追踪器拦截", "检测并移除追踪脚本"],
    ["PRIVACY_FINGERPRINT_PROTECT", "指纹保护", "Canvas、WebGL、Audio 伪装"],
    ["PRIVACY_WEBRTC_PROTECT", "WebRTC 防护", "防止 IP 泄露"],
    ["PRIVACY_STRIP_REFERRER", "清除 Referrer", "阻止来源追踪"],
    ["PRIVACY_CLEAR_COOKIES", "清除 Cookie", "删除当前页 Cookie"],
    ["PRIVACY_CLEAN_TRACES", "一键清痕", "清除所有本地存储"],
    ["PRIVACY_ANTI_SCREENSHOT", "防截图模式", "防止截图或录制"],
    ["EXTRACT_LINKS", "链接批量提取", "按域名分组提取超链接"],
    ["EXTRACT_STRUCTURED_DATA", "结构化数据", "JSON-LD、OG、Meta"],
    ["EXTRACT_CSS_SELECTOR", "CSS选择器爬取", "自定义选择器批量提取"],
    ["EXTRACT_EMAIL_PHONE", "邮箱电话嗅探", "正则扫描联系方式"],
    ["EXTRACT_PAGE_SNAPSHOT", "页面快照", "页面基础信息统计"],
    ["EXTRACT_PAGE_SOURCE", "页面源码", "查看完整 HTML 源码"],
    ["EXTRACT_AJAX_URLS", "API端点嗅探", "从脚本中提取接口地址"],
    ["EXTRACT_COOKIES", "Cookie提取", "提取当前页 Cookie"],
    ["EXTRACT_HIDDEN_FIELDS", "隐藏字段/Token", "提取 hidden input 和 CSRF"],
    ["DUMP_STORAGE", "Storage转储", "localStorage 与 sessionStorage"],
    ["REVEAL_PASSWORDS", "密码明文显示", "切换密码框明文或隐藏"],
    ["DUMP_JS_GLOBALS", "全局变量转储", "提取页面自定义 JS 变量"],
    ["HIJACK_EVENTS", "事件劫持监听", "劫持 EventListener 记录"],
    ["INTERCEPT_REQUESTS", "网络请求拦截", "劫持 XHR 与 Fetch 记录请求"],
    ["BROWSER_FINGERPRINT", "浏览器指纹", "Canvas、WebGL、Audio 指纹"],
    ["WEBSOCKET_MONITOR", "WebSocket监听", "劫持 WS 收发消息"],
    ["JS_INJECTOR", "JS代码注入", "执行自定义 JavaScript"],
    ["CANVAS_SPOOF", "Canvas伪装", "随机化 Canvas 指纹"],
    ["YT_SHORTCUTS", "快捷工具面板", "截图、倍速、循环、影院"],
    ["YT_TOGGLE_AD_SKIP", "跳过广告", "自动点击跳过按钮"],
    ["YT_TOGGLE_LOOP", "A-B循环播放", "片段循环"],
    ["YT_CINEMA_MODE", "影院模式", "暗化背景聚焦视频"],
    ["YT_SCREENSHOT", "视频截图", "截取当前帧 PNG"],
    ["YT_EXTRACT_INFO", "视频信息", "标题、频道、标签"],
    ["YT_EXTRACT_AUDIO", "音频流嗅探", "解析底层音频地址"],
    ["AUTO_FILL", "闪电填表", "自动填写表单"],
    ["TOGGLE_DARK_MODE", "暗黑模式", "反色滤镜"],
    ["TOGGLE_READER_MODE", "阅读器模式", "聚焦正文"],
    ["BREAK_SEALS", "解除复制限制", "恢复右键和选择"],
    ["OPEN_SCREEN_RECORDER", "屏幕录制", "打开录制器，录制全屏、窗口或标签页"],
    ["PAGE_QR_CODE", "页面二维码", "生成当前页面二维码"],
    ["PAGE_PERFORMANCE", "性能速查", "加载时间与资源分析"],
    ["PAGE_ANNOTATE", "页面标注", "在网页上画画标注"],
    ["STICKY_KILL", "膏药清理", "一键清除所有悬浮元素"],
    ["CLEAN_URL_COPY", "链接净化", "去除追踪参数并复制"],
    ["CLEAN_URL_ALL_LINKS", "全页链接净化", "清理页面所有超链接"],
    ["INPUT_TM_TOGGLE", "输入框保护", "自动保存输入内容开关"],
    ["INPUT_TM_SHOW_HISTORY", "输入框历史", "查看已保存的输入记录"],
    ["AUDIO_NORMALIZE_TOGGLE", "音频均衡", "自动均衡化页面音量"],
    ["AUDIO_NORMALIZE_PANEL", "均衡器面板", "调节压缩参数和增益"],
    ["ELEMENT_PIP", "元素画中画", "提取任意元素为悬浮窗"],
    ["DOM_MONITOR_ADD", "添加监控", "框选元素加入监控"],
    ["DOM_MONITOR_PANEL", "监控仪表盘", "查看所有监控数据"],
    ["LAN_TRANSFER", "局域网传输", "WebRTC P2P 文件传输"],
  ].map(([action, label, description]) => [action, Object.freeze({ label, description })])));

  const COMMAND_DEFINITIONS = [
    ["ACTIVATE_VISUAL_DICTATOR", "visual", "visualDictator"],
    ["OPEN_DICTATOR_DB", "visual", "visualDictator"],
    ["EXTRACT_MEDIA", "data", "dataHarvester"],
    ["ECOMMERCE_SCRAPE", "data", "ecommerce"],
    ["EXTRACT_MARKDOWN", "data", "dataHarvester"],
    ["ACTIVATE_DATA_HARVESTER", "data", "dataHarvester"],
    ["PRICE_COMPARE", "commerce", "priceComparator"],
    ["OPEN_VAULT", "vault", null, { internalPage: "vault/index.html" }],
    ["PASSWORD_GENERATOR", "vault", null, { internalPage: "vault/index.html#generator" }],
    ["VAULT_AUTO_FILL", "vault", "passwordVault"],
    ["VAULT_AUTO_SAVE", "vault", "passwordVault"],
    ["PRIVACY_SCAN", "privacy", "privacyShield"],
    ["PRIVACY_BLOCK_TRACKERS", "privacy", "privacyShield"],
    ["PRIVACY_FINGERPRINT_PROTECT", "privacy", "privacyShield"],
    ["PRIVACY_WEBRTC_PROTECT", "privacy", "privacyShield"],
    ["PRIVACY_STRIP_REFERRER", "privacy", "privacyShield"],
    ["PRIVACY_CLEAR_COOKIES", "privacy", "privacyShield"],
    ["PRIVACY_CLEAN_TRACES", "privacy", "privacyShield"],
    ["PRIVACY_ANTI_SCREENSHOT", "privacy", "privacyShield"],
    ["EXTRACT_LINKS", "data", "dataHarvester"],
    ["EXTRACT_STRUCTURED_DATA", "data", "dataHarvester"],
    ["EXTRACT_CSS_SELECTOR", "data", "dataHarvester"],
    ["EXTRACT_EMAIL_PHONE", "data", "dataHarvester"],
    ["EXTRACT_PAGE_SNAPSHOT", "data", "dataHarvester"],
    ["EXTRACT_PAGE_SOURCE", "data", "dataHarvester"],
    ["EXTRACT_AJAX_URLS", "data", "dataHarvester"],
    ["EXTRACT_COOKIES", "security", "dataHarvester"],
    ["EXTRACT_HIDDEN_FIELDS", "security", "dataHarvester"],
    ["DUMP_STORAGE", "security", "dataHarvester"],
    ["REVEAL_PASSWORDS", "security", "dataHarvester"],
    ["DUMP_JS_GLOBALS", "security", "dataHarvester"],
    ["HIJACK_EVENTS", "security", "dataHarvester"],
    ["INTERCEPT_REQUESTS", "security", "dataHarvester"],
    ["BROWSER_FINGERPRINT", "security", "dataHarvester"],
    ["WEBSOCKET_MONITOR", "security", "dataHarvester"],
    ["JS_INJECTOR", "security", null, {
      disabled: true,
      errorCode: ERROR_CODES.UNSUPPORTED_MV3_CSP,
      disabledReason: "Manifest V3 does not allow arbitrary remote or inline JavaScript execution.",
    }],
    ["CANVAS_SPOOF", "security", "dataHarvester"],
    ["YT_SHORTCUTS", "youtube", "youtube", { contexts: ["youtube"] }],
    ["YT_TOGGLE_AD_SKIP", "youtube", "youtube", { contexts: ["youtube"] }],
    ["YT_TOGGLE_LOOP", "youtube", "youtube", { contexts: ["youtube"] }],
    ["YT_CINEMA_MODE", "youtube", "youtube", { contexts: ["youtube"] }],
    ["YT_SCREENSHOT", "youtube", "youtube", { contexts: ["youtube"] }],
    ["YT_EXTRACT_INFO", "youtube", "youtube", { contexts: ["youtube"] }],
    ["YT_EXTRACT_AUDIO", "youtube", "youtube", { contexts: ["youtube"] }],
    ["AUTO_FILL", "automation", "automation"],
    ["TOGGLE_DARK_MODE", "reading", "immersive"],
    ["TOGGLE_READER_MODE", "reading", "immersive"],
    ["BREAK_SEALS", "reading", "immersive"],
    ["OPEN_SCREEN_RECORDER", "utility", null, {
      internalPage: "screen-recorder/index.html",
      label: "屏幕录制",
      scope: SCOPES.SYSTEM,
      controls: ["stop", "manage"],
    }],
    ["PAGE_QR_CODE", "utility", "pageQrCode"],
    ["PAGE_PERFORMANCE", "utility", "pageTools"],
    ["PAGE_ANNOTATE", "utility", "pageTools", { requiresUserGesture: true }],
    ["STICKY_KILL", "efficiency", "stickyKiller"],
    ["CLEAN_URL_COPY", "efficiency", "cleanUrl"],
    ["CLEAN_URL_ALL_LINKS", "efficiency", "cleanUrl"],
    ["INPUT_TM_TOGGLE", "efficiency", "inputTimeMachine"],
    ["INPUT_TM_SHOW_HISTORY", "efficiency", "inputTimeMachine"],
    ["AUDIO_NORMALIZE_TOGGLE", "efficiency", "audioNormalizer"],
    ["AUDIO_NORMALIZE_PANEL", "efficiency", "audioNormalizer"],
    ["ELEMENT_PIP", "efficiency", "elementPip", { requiresUserGesture: true }],
    ["DOM_MONITOR_ADD", "efficiency", "domMonitor"],
    ["DOM_MONITOR_PANEL", "efficiency", "domMonitor", { label: "DOM 监控", scope: SCOPES.DURABLE, controls: ["manage"] }],
    ["LAN_TRANSFER", "transfer", null, { internalPage: "lan-transfer/index.html" }],
  ];

  function createEntry(action, category, moduleName, options) {
    const extra = options || {};
    const stateMetadata = STATEFUL_ACTION_METADATA[action] || null;
    const presentation = COMMAND_PRESENTATION[action] || null;
    const mainWorld = MAIN_WORLD_ACTIONS.has(action);
    const module = mainWorld ? MODULES.mainWorld : (moduleName ? MODULES[moduleName] : null);
    const lifecycle = extra.lifecycle
      || (stateMetadata && stateMetadata.lifecycle)
      || (extra.disabled ? LIFECYCLES.UNSUPPORTED : (extra.internalPage ? LIFECYCLES.INTERNAL : LIFECYCLES.INSTANT));
    const scope = extra.scope
      || (stateMetadata && stateMetadata.scope)
      || (extra.internalPage ? SCOPES.EXTENSION : SCOPES.PAGE);
    const controls = extra.controls || (stateMetadata && stateMetadata.controls) || (extra.internalPage ? ["manage"] : []);
    return Object.freeze({
      action,
      command: true,
      category,
      label: (presentation && presentation.label) || extra.label || (stateMetadata && stateMetadata.label) || action,
      description: extra.description || (presentation && presentation.description) || "",
      lifecycle,
      scope,
      controls: Object.freeze([...controls]),
      pageDock: Boolean(extra.pageDock ?? (stateMetadata && stateMetadata.pageDock)),
      stateful: Boolean(extra.stateful ?? stateMetadata),
      contexts: Object.freeze([...(extra.contexts || (extra.internalPage ? ["internal"] : ["page"]))]),
      scripts: Object.freeze([...(module && module.scripts ? module.scripts : [])]),
      styles: Object.freeze([...(module && module.styles ? module.styles : [])]),
      marker: module && module.marker ? module.marker : null,
      world: module && module.world ? module.world : "ISOLATED",
      mainWorld,
      sensitive: SENSITIVE_ACTIONS.has(action),
      sensitivity: SENSITIVE_ACTIONS.has(action) ? "high" : (mainWorld ? "elevated" : "normal"),
      requiresUserGesture: Boolean(extra.requiresUserGesture),
      internalPage: extra.internalPage || null,
      disabled: Boolean(extra.disabled),
      errorCode: extra.errorCode || null,
      disabledReason: extra.disabledReason || null,
    });
  }

  const commandEntries = COMMAND_DEFINITIONS.map((definition) => createEntry(...definition));
  if (commandEntries.length !== 63) {
    throw new Error(`Web-Omni action registry expected 63 commands, received ${commandEntries.length}.`);
  }

  const systemEntries = [
    createEntry("TOGGLE_COMMAND_HUB", "system", "commandHub", { lifecycle: LIFECYCLES.SYSTEM, scope: SCOPES.TAB }),
    createEntry("PING_COMMAND_HUB", "system", "commandHub", { lifecycle: LIFECYCLES.SYSTEM, scope: SCOPES.TAB }),
    createEntry("WO_ACTIVE_ACTIONS_GET", "system", null, { lifecycle: LIFECYCLES.SYSTEM, scope: SCOPES.SYSTEM }),
    createEntry("WO_MEDIA_SNIFFER", "system", null, { lifecycle: LIFECYCLES.SYSTEM, scope: SCOPES.TAB }),
    createEntry("GLOBAL_PRIVACY_MODE", "privacy", "globalPrivacy", {
      label: "全局隐私",
      description: "按自定义配置保护所有普通网页",
      lifecycle: LIFECYCLES.TOGGLE,
      scope: SCOPES.GLOBAL,
      controls: ["disable"],
      pageDock: false,
      stateful: true,
    }),
    createEntry("WO_PAGE_TRANSLATE_COLLECT", "translation", "pageTranslator", { lifecycle: LIFECYCLES.SYSTEM }),
    createEntry("WO_PAGE_TRANSLATE_APPLY", "translation", "pageTranslator", { lifecycle: LIFECYCLES.SYSTEM }),
    createEntry("WO_PAGE_TRANSLATE_RESTORE", "translation", "pageTranslator", {
      label: "整页翻译",
      lifecycle: LIFECYCLES.SYSTEM,
      scope: SCOPES.PAGE,
      controls: ["restoreAll"],
      pageDock: true,
      stateful: true,
    }),
    createEntry("WO_PAGE_TRANSLATE_STATE", "translation", "pageTranslator", { lifecycle: LIFECYCLES.SYSTEM }),
    createEntry("DOM_MONITOR_CHECK", "system", "domMonitor", { lifecycle: LIFECYCLES.SYSTEM, scope: SCOPES.GLOBAL }),
  ].map((entry) => Object.freeze({ ...entry, command: false }));

  const entries = [...commandEntries, ...systemEntries];
  const ACTIONS = Object.freeze(Object.fromEntries(entries.map((entry) => [entry.action, entry])));

  function getAction(action) {
    return typeof action === "string" ? ACTIONS[action] || null : null;
  }

  function listCommandActions() {
    return commandEntries.slice();
  }

  function listStatefulActions() {
    return commandEntries.filter((entry) => entry.stateful);
  }

  function isRestrictedUrl(url) {
    let parsed;
    try {
      parsed = new URL(String(url || ""));
    } catch (_) {
      return true;
    }
    return RESTRICTED_PROTOCOLS.includes(parsed.protocol) || !["http:", "https:"].includes(parsed.protocol);
  }

  function matchesContext(entry, url) {
    if (!entry) return false;
    if (entry.internalPage) return true;
    if (isRestrictedUrl(url)) return false;
    if (!entry.contexts.includes("youtube")) return true;
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be";
    } catch (_) {
      return false;
    }
  }

  function findActionByInternalPage(page) {
    const value = String(page || "").replace(/^\/+/, "");
    const entry = entries.find((item) => item.internalPage === value);
    return entry ? entry.action : null;
  }

  function createRequest(action, tabId, payload) {
    const resolvedTabId = Number.isInteger(tabId)
      ? tabId
      : (Number.isInteger(root.__webOmniTabId) ? root.__webOmniTabId : null);
    return {
      type: "WO_EXECUTE_ACTION",
      action,
      tabId: resolvedTabId,
      payload: payload && typeof payload === "object" ? payload : undefined,
    };
  }

  return Object.freeze({
    ACTIONS,
    actions: ACTIONS,
    ERROR_CODES,
    LIFECYCLES,
    SCOPES,
    CONTROL_TYPES,
    COMMAND_PRESENTATION,
    RESTRICTED_PROTOCOLS,
    getAction,
    get: getAction,
    listCommandActions,
    listStatefulActions,
    isRestrictedUrl,
    matchesContext,
    findActionByInternalPage,
    createRequest,
  });
});
