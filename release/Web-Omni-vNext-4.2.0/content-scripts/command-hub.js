// Web-Omni 快捷指令中枢 (Command Hub)
// 搜索优先 + 智能首页

(function() {
  "use strict";

  if (window.webOmniCommandHubInjected && window.webOmniCommandHubController) {
    window.webOmniCommandHubController.ensureReady().catch(() => {});
    return;
  }
  window.webOmniCommandHubInjected = true;
  const recentToasts = new Map();
  const MAX_VISIBLE_TOASTS = 4;
  const TOAST_DEDUPE_MS = 1200;

  function injectToastSystem() {
    if (document.getElementById("web-omni-toast-container")) return;

    const style = document.createElement("style");
    style.textContent = `
      #web-omni-toast-container{position:fixed;top:20px;right:20px;z-index:2147483646;display:flex;flex-direction:column;gap:8px;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
      .web-omni-toast{padding:10px 16px;border-radius:10px;color:#f5f5f5;font-size:13px;background:rgba(17,17,17,.94);border:1px solid rgba(255,255,255,.08);transform:translateX(120%);transition:transform .28s ease,opacity .28s ease;opacity:0;pointer-events:auto;max-width:320px;line-height:1.5;box-shadow:0 18px 38px rgba(0,0,0,.28);}
      .web-omni-toast.show{transform:translateX(0);opacity:1;}
      .web-omni-toast.hide{transform:translateX(120%);opacity:0;}
      .web-omni-toast.success{border-color:rgba(80,200,120,.32);}
      .web-omni-toast.warn{border-color:rgba(255,190,50,.34);}
      .web-omni-toast.error{border-color:rgba(255,96,96,.34);}
    `;
    document.head.appendChild(style);

    const container = document.createElement("div");
    container.id = "web-omni-toast-container";
    document.body.appendChild(container);
  }

  window.webOmniShowToast = function(message, type, duration) {
    type = type || "info";
    duration = duration || 2500;
    injectToastSystem();

    const container = document.getElementById("web-omni-toast-container");
    const now = Date.now();
    const signature = type + "\n" + String(message);
    if (now - (recentToasts.get(signature) || 0) < TOAST_DEDUPE_MS) return;
    recentToasts.set(signature, now);
    recentToasts.forEach((shownAt, key) => {
      if (now - shownAt > duration + TOAST_DEDUPE_MS) recentToasts.delete(key);
    });
    while (container.children.length >= MAX_VISIBLE_TOASTS) {
      container.firstElementChild?.remove();
    }
    const toast = document.createElement("div");
    toast.className = "web-omni-toast " + type;
    toast.setAttribute("role", type === "error" ? "alert" : "status");
    toast.textContent = message;
    container.appendChild(toast);

    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add("show")));
    setTimeout(() => {
      toast.classList.remove("show");
      toast.classList.add("hide");
      setTimeout(() => toast.remove(), 300);
    }, duration);
  };

  const STORAGE_KEYS = {
    agreed: "woAgreed",
    firstRun: "woFirstRun",
    pins: "woCommandHubPins",
    recent: "woCommandHubRecent",
    usage: "woCommandHubUsage",
    personalOrder: "woCommandHubPersonalOrder",
    performanceMode: "woPerformanceMode",
  };

  const RECENT_LIMIT = 6;
  const PIN_LIMIT = 8;
  const HOME_PERSONAL_LIMIT = 8;
  const SEARCH_RESULT_LIMIT = 12;
  const DEFAULT_BROWSE_CATEGORY = "效率神器";
  const CONTEXT_LABELS = {
    youtube: "YouTube",
    ecommerce: "电商",
    form: "表单/登录",
    article: "文章/资讯",
    media: "媒体/视频",
    generic: "通用",
  };

  const HOME_FIXED_ACTIONS = [
    { action: "LAN_TRANSFER", title: "局域网传输", desc: "把文件、图片、链接和文本放进同一条会话。" },
    { action: "OPEN_SCREEN_RECORDER", title: "录屏", desc: "录整个屏幕、窗口或当前标签页。" },
    { action: "OPEN_VAULT", title: "密码库", desc: "本地加密保存临时账号和常用密码。" },
    { action: "STICKY_KILL", title: "清膏药", desc: "一键清掉悬浮层、贴边条和弹窗。" },
    { action: "CLEAN_URL_COPY", title: "链接净化", desc: "去掉追踪参数并复制更干净的链接。" },
    { action: "__OPEN_BROWSE__", title: "全部工具", desc: "按分类浏览全部功能，翻到不常用的工具。" },
  ];

  function command(action, label, desc, keywords) {
    return { action, label, desc, keywords };
  }

  // ---- Icon registry ----
  // 优先级：fixed-action 图标 > 命令分类图标 > 兜底
  const HUB_SVG = {
    eye:        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`,
    download:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>`,
    tag:        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13.5 13.5 20a2 2 0 0 1-2.83 0L4 13.34V4h9.34L20 10.66a2 2 0 0 1 0 2.84z"/><circle cx="9" cy="9" r="1.6"/></svg>`,
    lock:       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/></svg>`,
    shield:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v6c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V6l-8-3z"/></svg>`,
    braces:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4H6a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-2"/></svg>`,
    terminal:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4 7 4 5-4 5M12 17h8"/></svg>`,
    play:       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="3"/><path d="m11 10 4 2-4 2v-4z" fill="currentColor"/></svg>`,
    zap:        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3 4 14h7l-1 7 9-11h-7l1-7z"/></svg>`,
    book:       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5a2 2 0 0 1 2-2h6v17H4a2 2 0 0 1-2-2V5zM22 5a2 2 0 0 0-2-2h-6v17h6a2 2 0 0 0 2-2V5z"/></svg>`,
    wrench:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-1-1-2.5z"/></svg>`,
    star:       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.8 1-6.1-4.4-4.3 6.1-.9L12 3z"/></svg>`,
    sparkles:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3zM18 14l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2zM5 15l.7 1.5L7 17l-1.3.5L5 19l-.7-1.5L3 17l1.3-.5L5 15z"/></svg>`,
    radio:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/></svg>`,
    grid:       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/></svg>`,
    rec:        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/></svg>`,
    eraser:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20H8.5L4 15.5a2 2 0 0 1 0-2.83l8.7-8.67a2 2 0 0 1 2.83 0L21 9.5a2 2 0 0 1 0 2.83L13.5 20"/><path d="M9 13l5 5"/></svg>`,
    link:       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>`,
    arrows:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3"/></svg>`,
  };

  const HUB_CATEGORY_ICONS = {
    "视觉掌控": HUB_SVG.eye,
    "数据收割": HUB_SVG.download,
    "比价工具": HUB_SVG.tag,
    "密码管理": HUB_SVG.lock,
    "隐私保护": HUB_SVG.shield,
    "高级爬虫": HUB_SVG.braces,
    "渗透工具": HUB_SVG.terminal,
    "YouTube":  HUB_SVG.play,
    "自动化":   HUB_SVG.zap,
    "沉浸阅读": HUB_SVG.book,
    "实用工具": HUB_SVG.wrench,
    "效率神器": HUB_SVG.sparkles,
    "文件传输": HUB_SVG.radio,
    "快捷入口": HUB_SVG.grid,
  };

  const HUB_FIXED_ICONS = {
    LAN_TRANSFER:        HUB_SVG.arrows,
    OPEN_SCREEN_RECORDER: HUB_SVG.rec,
    OPEN_VAULT:          HUB_SVG.lock,
    STICKY_KILL:         HUB_SVG.eraser,
    CLEAN_URL_COPY:      HUB_SVG.link,
    "__OPEN_BROWSE__":   HUB_SVG.grid,
  };

  function getActionIcon(action, categoryName) {
    if (action && HUB_FIXED_ICONS[action]) return HUB_FIXED_ICONS[action];
    if (categoryName && HUB_CATEGORY_ICONS[categoryName]) return HUB_CATEGORY_ICONS[categoryName];
    return HUB_SVG.wrench;
  }

  const CATEGORIES = [
    {
      name: "视觉掌控", tab: "视觉", color: "#f59e0b", commands: [
        command("ACTIVATE_VISUAL_DICTATOR", "元素消除", "点击消除页面元素", ["去广告", "广告", "删除", "消除"]),
        command("OPEN_DICTATOR_DB", "规则管理", "查看或恢复已消除元素", ["规则", "恢复", "管理"]),
      ],
    },
    {
      name: "数据收割", tab: "数据", color: "#3b82f6", commands: [
        command("EXTRACT_MEDIA", "提取图片/视频", "嗅探页面媒体资源", ["图片", "视频", "media", "image"]),
        command("ECOMMERCE_SCRAPE", "电商图片爬取", "淘宝、京东、1688 批量取图", ["淘宝", "京东", "sku", "电商"]),
        command("EXTRACT_MARKDOWN", "剪藏Markdown", "正文转 Markdown", ["剪藏", "markdown", "笔记"]),
        command("ACTIVATE_DATA_HARVESTER", "框选提取", "框选文本或表格", ["框选", "表格", "csv"]),
      ],
    },
    {
      name: "比价工具", tab: "比价", color: "#f97316", commands: [
        command("PRICE_COMPARE", "多平台比价", "淘宝、京东、拼多多、1688 比价", ["比价", "价格", "淘宝", "京东", "拼多多", "对比"]),
      ],
    },
    {
      name: "密码管理", tab: "密码", color: "#8b5cf6", commands: [
        command("OPEN_VAULT", "密码金库", "AES-256 加密保险箱", ["密码", "金库", "vault", "安全"]),
        command("PASSWORD_GENERATOR", "密码生成器", "生成强随机密码", ["生成", "随机", "密码"]),
        command("VAULT_AUTO_FILL", "一键填充", "自动填充登录信息", ["填充", "登录", "autofill"]),
        command("VAULT_AUTO_SAVE", "自动保存", "检测并保存新密码", ["保存", "检测", "save"]),
      ],
    },
    {
      name: "隐私保护", tab: "隐私", color: "#10b981", commands: [
        command("PRIVACY_SCAN", "隐私评分", "扫描页面隐私风险", ["隐私", "评分", "扫描", "scan", "privacy"]),
        command("PRIVACY_BLOCK_TRACKERS", "追踪器拦截", "检测并移除追踪脚本", ["追踪", "拦截", "tracker", "block"]),
        command("PRIVACY_FINGERPRINT_PROTECT", "指纹保护", "Canvas、WebGL、Audio 伪装", ["指纹", "canvas", "webgl", "fingerprint"]),
        command("PRIVACY_WEBRTC_PROTECT", "WebRTC 防护", "防止 IP 泄露", ["webrtc", "ip", "泄露", "防护"]),
        command("PRIVACY_STRIP_REFERRER", "清除 Referrer", "阻止来源追踪", ["referrer", "来源"]),
        command("PRIVACY_CLEAR_COOKIES", "清除 Cookie", "删除当前页 Cookie", ["cookie", "清除"]),
        command("PRIVACY_CLEAN_TRACES", "一键清痕", "清除所有本地存储", ["清除", "痕迹", "storage", "clean"]),
        command("PRIVACY_ANTI_SCREENSHOT", "防截图模式", "防止截图或录制", ["防截图", "截图"]),
      ],
    },
    {
      name: "高级爬虫", tab: "爬虫", color: "#06b6d4", commands: [
        command("EXTRACT_LINKS", "链接批量提取", "按域名分组提取超链接", ["链接", "url", "导出"]),
        command("EXTRACT_STRUCTURED_DATA", "结构化数据", "JSON-LD、OG、Meta", ["json-ld", "seo", "meta"]),
        command("EXTRACT_CSS_SELECTOR", "CSS选择器爬取", "自定义选择器批量提取", ["css", "选择器"]),
        command("EXTRACT_EMAIL_PHONE", "邮箱电话嗅探", "正则扫描联系方式", ["邮箱", "电话", "email"]),
        command("EXTRACT_PAGE_SNAPSHOT", "页面快照", "页面基础信息统计", ["快照", "统计"]),
        command("EXTRACT_PAGE_SOURCE", "页面源码", "查看完整 HTML 源码", ["源码", "html", "source"]),
        command("EXTRACT_AJAX_URLS", "API端点嗅探", "从脚本中提取接口地址", ["api", "ajax", "fetch", "接口"]),
      ],
    },
    {
      name: "渗透工具", tab: "渗透", color: "#ef4444", commands: [
        command("EXTRACT_COOKIES", "Cookie提取", "提取当前页 Cookie", ["cookie", "会话", "session"]),
        command("EXTRACT_HIDDEN_FIELDS", "隐藏字段/Token", "提取 hidden input 和 CSRF", ["hidden", "csrf", "token"]),
        command("DUMP_STORAGE", "Storage转储", "localStorage 与 sessionStorage", ["storage", "存储", "本地"]),
        command("REVEAL_PASSWORDS", "密码明文显示", "切换密码框明文或隐藏", ["密码", "password", "明文"]),
        command("DUMP_JS_GLOBALS", "全局变量转储", "提取页面自定义 JS 变量", ["js", "变量", "global", "window"]),
        command("HIJACK_EVENTS", "事件劫持监听", "劫持 EventListener 记录", ["事件", "劫持", "event", "hook"]),
        command("INTERCEPT_REQUESTS", "网络请求拦截", "劫持 XHR 与 Fetch 记录请求", ["网络", "请求", "xhr", "fetch", "拦截"]),
        command("BROWSER_FINGERPRINT", "浏览器指纹", "Canvas、WebGL、Audio 指纹", ["指纹", "fingerprint", "canvas", "webgl"]),
        command("WEBSOCKET_MONITOR", "WebSocket监听", "劫持 WS 收发消息", ["websocket", "ws", "实时"]),
        command("JS_INJECTOR", "JS代码注入", "执行自定义 JavaScript", ["注入", "执行", "inject", "js", "代码"]),
        command("CANVAS_SPOOF", "Canvas伪装", "随机化 Canvas 指纹", ["伪装", "反追踪", "canvas", "spoof"]),
      ],
    },
    {
      name: "YouTube", tab: "YT", color: "#dc2626", commands: [
        command("YT_SHORTCUTS", "快捷工具面板", "截图、倍速、循环、影院", ["youtube", "面板", "加速"]),
        command("YT_TOGGLE_AD_SKIP", "跳过广告", "自动点击跳过按钮", ["youtube", "广告", "跳过"]),
        command("YT_TOGGLE_LOOP", "A-B循环播放", "片段循环", ["youtube", "循环", "loop"]),
        command("YT_CINEMA_MODE", "影院模式", "暗化背景聚焦视频", ["youtube", "影院", "关灯"]),
        command("YT_SCREENSHOT", "视频截图", "截取当前帧 PNG", ["youtube", "截图"]),
        command("YT_EXTRACT_INFO", "视频信息", "标题、频道、标签", ["youtube", "信息"]),
        command("YT_EXTRACT_AUDIO", "音频流嗅探", "解析底层音频地址", ["youtube", "音频", "下载"]),
      ],
    },
    {
      name: "自动化", tab: "自动", color: "#22c55e", commands: [
        command("AUTO_FILL", "闪电填表", "自动填写表单", ["填表", "form", "autofill"]),
      ],
    },
    {
      name: "沉浸阅读", tab: "阅读", color: "#a78bfa", commands: [
        command("TOGGLE_DARK_MODE", "暗黑模式", "反色滤镜", ["暗黑", "夜间", "dark"]),
        command("TOGGLE_READER_MODE", "阅读器模式", "聚焦正文", ["阅读", "reader"]),
        command("BREAK_SEALS", "解除复制限制", "恢复右键和选择", ["复制", "右键", "限制"]),
      ],
    },
    {
      name: "实用工具", tab: "工具", color: "#64748b", commands: [
        command("OPEN_SCREEN_RECORDER", "屏幕录制", "打开录制器，录制全屏、窗口或标签页", ["录屏", "录制", "screen", "record", "capture"]),
        command("PAGE_QR_CODE", "页面二维码", "生成当前页面二维码", ["二维码", "qr"]),
        command("PAGE_PERFORMANCE", "性能速查", "加载时间与资源分析", ["性能", "performance"]),
        command("PAGE_ANNOTATE", "页面标注", "在网页上画画标注", ["标注", "涂鸦", "draw"]),
      ],
    },
    {
      name: "效率神器", tab: "效率", color: "#eab308", commands: [
        command("STICKY_KILL", "膏药清理", "一键清除所有悬浮元素", ["悬浮", "fixed", "sticky", "膏药", "清理", "清除"]),
        command("CLEAN_URL_COPY", "链接净化", "去除追踪参数并复制", ["链接", "url", "追踪", "净化", "clean", "脱水"]),
        command("CLEAN_URL_ALL_LINKS", "全页链接净化", "清理页面所有超链接", ["链接", "全部", "净化"]),
        command("INPUT_TM_TOGGLE", "输入框保护", "自动保存输入内容开关", ["输入", "保护", "时光机", "恢复", "保存", "input"]),
        command("INPUT_TM_SHOW_HISTORY", "输入框历史", "查看已保存的输入记录", ["历史", "输入", "恢复", "history"]),
        command("AUDIO_NORMALIZE_TOGGLE", "音频均衡", "自动均衡化页面音量", ["音频", "均衡", "音量", "护耳", "compressor"]),
        command("AUDIO_NORMALIZE_PANEL", "均衡器面板", "调节压缩参数和增益", ["均衡器", "面板", "调节", "audio"]),
        command("ELEMENT_PIP", "元素画中画", "提取任意元素为悬浮窗", ["画中画", "pip", "悬浮", "提取", "浮窗"]),
        command("DOM_MONITOR_ADD", "添加监控", "框选元素加入监控", ["监控", "watch", "monitor", "盯盘"]),
        command("DOM_MONITOR_PANEL", "监控仪表盘", "查看所有监控数据", ["仪表盘", "监控", "dashboard"]),
      ],
    },
    {
      name: "文件传输", tab: "传输", color: "#6366f1", commands: [
        command("LAN_TRANSFER", "局域网传输", "WebRTC P2P 文件传输", ["传文件", "局域网", "lan", "transfer", "p2p"]),
      ],
    },
  ];

  const COMMAND_METADATA = {
    ACTIVATE_VISUAL_DICTATOR: { aliases: ["去广告", "清元素", "删元素", "删广告"], contexts: ["article", "generic"] },
    OPEN_DICTATOR_DB: { aliases: ["规则库", "恢复已删", "恢复元素"], contexts: ["generic"] },
    EXTRACT_MEDIA: { aliases: ["提取视频", "提图", "抓媒体"], contexts: ["media", "youtube", "ecommerce"], featured: true },
    ECOMMERCE_SCRAPE: { aliases: ["电商取图", "商品取图", "淘宝取图"], contexts: ["ecommerce"], featured: true },
    EXTRACT_MARKDOWN: { aliases: ["剪藏", "保存文章", "转markdown"], contexts: ["article"], featured: true },
    ACTIVATE_DATA_HARVESTER: { aliases: ["表格提取", "框选工具"], contexts: ["article", "ecommerce"] },
    PRICE_COMPARE: { aliases: ["商品比价", "比价", "淘宝比价"], contexts: ["ecommerce"], featured: true },
    OPEN_VAULT: { aliases: ["密码库", "保险箱", "密码管理器"], contexts: ["form", "generic"], featured: true },
    PASSWORD_GENERATOR: { aliases: ["生成密码", "随机密码"], contexts: ["form"] },
    VAULT_AUTO_FILL: { aliases: ["自动填充", "填账号", "自动登录"], contexts: ["form"], featured: true },
    VAULT_AUTO_SAVE: { aliases: ["保存密码", "检测密码"], contexts: ["form"] },
    PRIVACY_SCAN: { aliases: ["隐私检测", "追踪扫描"], contexts: ["generic"] },
    PRIVACY_BLOCK_TRACKERS: { aliases: ["拦截追踪器", "追踪拦截"], contexts: ["generic"] },
    EXTRACT_LINKS: { aliases: ["提取链接", "导出链接"], contexts: ["article", "generic"] },
    YT_SHORTCUTS: { aliases: ["youtube工具", "油管工具", "视频快捷工具"], contexts: ["youtube"], featured: true },
    YT_SCREENSHOT: { aliases: ["youtube截图", "视频截图"], contexts: ["youtube"] },
    AUTO_FILL: { aliases: ["自动填表", "表单填写"], contexts: ["form"], featured: true },
    TOGGLE_DARK_MODE: { aliases: ["夜间模式", "深色模式"], contexts: ["article"] },
    TOGGLE_READER_MODE: { aliases: ["阅读模式", "正文模式", "简洁阅读"], contexts: ["article"], featured: true },
    BREAK_SEALS: { aliases: ["解除复制", "解除限制", "恢复复制"], contexts: ["article"] },
    OPEN_SCREEN_RECORDER: { aliases: ["录屏", "录桌面", "录窗口", "录标签页"], contexts: ["media", "youtube", "generic"], featured: true },
    PAGE_QR_CODE: { aliases: ["网页二维码", "分享二维码", "二维码"], contexts: ["article", "generic"] },
    PAGE_PERFORMANCE: { aliases: ["性能", "测速", "网页性能"], contexts: ["generic"] },
    PAGE_ANNOTATE: { aliases: ["标注", "涂鸦", "批注"], contexts: ["article", "generic"] },
    STICKY_KILL: { aliases: ["清悬浮", "去悬浮", "去弹窗", "清浮层"], contexts: ["generic"], featured: true },
    CLEAN_URL_COPY: { aliases: ["净链", "清理链接", "脱水链接"], contexts: ["generic"], featured: true },
    CLEAN_URL_ALL_LINKS: { aliases: ["全链净化", "全页净链"], contexts: ["generic"] },
    INPUT_TM_TOGGLE: { aliases: ["输入保护", "防丢字", "输入时光机"], contexts: ["form"], featured: true },
    INPUT_TM_SHOW_HISTORY: { aliases: ["输入历史", "恢复输入"], contexts: ["form"] },
    AUDIO_NORMALIZE_TOGGLE: { aliases: ["护耳", "音量均衡", "音量压缩"], contexts: ["media", "youtube"] },
    AUDIO_NORMALIZE_PANEL: { aliases: ["均衡设置", "音量面板"], contexts: ["media", "youtube"] },
    ELEMENT_PIP: { aliases: ["画中画", "网页浮窗", "视频浮窗"], contexts: ["media", "youtube"], featured: true },
    DOM_MONITOR_ADD: { aliases: ["添加盯盘", "添加监控"], contexts: ["generic"] },
    DOM_MONITOR_PANEL: { aliases: ["盯盘面板", "监控盘"], contexts: ["generic"] },
    LAN_TRANSFER: { aliases: ["传文件", "电脑传手机", "局域网传文件"], contexts: ["generic"], featured: true },
  };

  const INTERNAL_ACTIONS = {
    "__OPEN_BROWSE__": {
      action: "__OPEN_BROWSE__",
      label: "全部工具",
      desc: "按分类浏览全部工具",
      aliases: ["按分类浏览", "全部工具", "工具列表"],
      keywords: ["分类", "浏览", "全部", "工具"],
      contexts: ["generic"],
      featured: true,
      pinnable: false,
      internal: true,
      categoryName: "快捷入口",
      categoryTab: "首页",
      categoryColor: "#71717a",
    },
  };

  const COMMANDS = CATEGORIES.flatMap((category) => {
    return category.commands.map((item) => {
      const meta = COMMAND_METADATA[item.action] || {};
      return {
        ...item,
        aliases: Array.isArray(meta.aliases) ? meta.aliases : [],
        contexts: Array.isArray(meta.contexts) && meta.contexts.length ? meta.contexts : ["generic"],
        featured: Boolean(meta.featured),
        pinnable: meta.pinnable !== false,
        categoryName: category.name,
        categoryTab: category.tab,
        categoryColor: category.color,
        internal: false,
      };
    });
  });

  const COMMAND_BY_ACTION = new Map(
    COMMANDS.concat(Object.values(INTERNAL_ACTIONS)).map((item) => [item.action, item])
  );
  const COMMAND_SEARCH_INDEX = new Map(
    COMMANDS.map((item) => [item.action, {
      label: normalizeText(item.label),
      desc: normalizeText(item.desc),
      category: normalizeText(item.categoryName),
      action: normalizeText(item.action),
      aliases: item.aliases.map(normalizeText),
      keywords: item.keywords.map(normalizeText),
    }])
  );
  const PINNABLE_ACTIONS = new Set(COMMANDS.filter((item) => item.pinnable).map((item) => item.action));
  const FIXED_ACTION_SET = new Set(HOME_FIXED_ACTIONS.map((item) => item.action));
  const LOCAL_ACTION_RESTRICTIONS = {
    JS_INJECTOR: {
      status: "UNSUPPORTED_MV3_CSP",
      reason: "Manifest V3 不允许在页面中执行任意代码",
    },
  };
  const ACTIVE_ACTION_TITLES = Object.freeze({
    WO_PAGE_TRANSLATE_RESTORE: "整页翻译",
    DOM_MONITOR_CHECK: "DOM 监控",
  });
  const ACTIVE_MANAGE_ACTIONS = Object.freeze({
    ACTIVATE_VISUAL_DICTATOR: "OPEN_DICTATOR_DB",
    VAULT_AUTO_SAVE: "OPEN_VAULT",
    INPUT_TM_TOGGLE: "INPUT_TM_SHOW_HISTORY",
    AUDIO_NORMALIZE_TOGGLE: "AUDIO_NORMALIZE_PANEL",
    DOM_MONITOR_ADD: "DOM_MONITOR_PANEL",
  });

  const hubState = {
    viewMode: "home",
    activeCategory: "",
    query: "",
    selectedIndex: -1,
    storeLoaded: false,
    currentContexts: new Set(["generic"]),
    performanceMode: "auto",
    resolvedPerformanceMode: "quality",
    activeActions: new Map(),
    activeActionsRevision: 0,
    activeActionsUpdatedAt: 0,
    store: {
      pins: [],
      recent: [],
      usage: {},
      personalOrder: [],
    },
  };

  let hubContainer = null;
  let hubPanel = null;
  let hubInput = null;
  let hubBody = null;
  let hubBrowseButton = null;
  let hubVisibilityState = "closed";
  let hubCloseTimer = null;
  let hubTransitionId = 0;
  let hubPersonalDrag = null;
  let hubSuppressNextClick = false;
  let hubSuppressClickTimer = null;
  let hubInitPromise = null;
  let hubSearchFrame = 0;
  let hubPendingQuery = "";
  let hubStoreSyncFrame = 0;
  let hubViewTransition = null;
  let hubCategoryTransition = null;
  let hubVisibilityAnimation = null;
  let hubIndicatorAnimation = null;
  let hubIndicatorScrollFrame = 0;
  let hubIndicatorGeneration = 0;
  let hubActionStateRuntime = null;
  let hubActionStateUnsubscribe = null;
  let hubHostScrollLocked = false;
  const PERSONAL_PIN_DRAG_DISTANCE = 7;
  const PERSONAL_DROP_CONFIRM_MS = 260;
  const HUB_MOTION = Object.freeze({
    open: 520,
    close: 420,
    view: 960,
    category: 720,
    indicator: 420,
    easing: "cubic-bezier(.32, 0, .18, 1)",
  });

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function getLatestPointerPoint(event) {
    if (event && typeof event.getCoalescedEvents === "function") {
      const points = event.getCoalescedEvents();
      if (points && points.length) return points[points.length - 1];
    }
    return event;
  }

  function prefersReducedHubMotion() {
    return hubState.resolvedPerformanceMode === "performance" || Boolean(
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function clearLayerStyles(layer) {
    if (!layer) return;
    layer.style.removeProperty("opacity");
    layer.style.removeProperty("transform");
    layer.style.removeProperty("filter");
    layer.style.removeProperty("will-change");
  }

  function cancelLayerTransition(record, winner) {
    if (!record) return null;
    record.cancelled = true;
    record.animations.forEach((animation) => {
      animation.onfinish = null;
      animation.oncancel = null;
      animation.cancel();
    });

    const keep = winner && winner.isConnected
      ? winner
      : (record.winner && record.winner.isConnected ? record.winner : record.toLayer);
    Array.from(record.stage.children).forEach((layer) => {
      if (layer !== keep) layer.remove();
    });
    if (keep) {
      clearLayerStyles(keep);
      keep.classList.add("is-current");
      keep.inert = false;
      keep.removeAttribute("aria-hidden");
      record.stage.dataset.currentKey = keep.dataset.layerKey || "";
    }
    return keep;
  }

  function cancelIndicatorMotion() {
    hubIndicatorGeneration += 1;
    if (hubIndicatorAnimation) {
      const target = hubIndicatorAnimation.effect && hubIndicatorAnimation.effect.target;
      hubIndicatorAnimation.onfinish = null;
      hubIndicatorAnimation.cancel();
      if (target && target.style) target.style.removeProperty("will-change");
      hubIndicatorAnimation = null;
    }
    if (hubIndicatorScrollFrame) {
      cancelAnimationFrame(hubIndicatorScrollFrame);
      hubIndicatorScrollFrame = 0;
    }
  }

  function cancelHubContentAnimations() {
    if (hubViewTransition) {
      cancelLayerTransition(hubViewTransition, hubViewTransition.winner);
      hubViewTransition = null;
    }
    if (hubCategoryTransition) {
      cancelLayerTransition(hubCategoryTransition, hubCategoryTransition.winner);
      hubCategoryTransition = null;
    }
    cancelIndicatorMotion();
  }

  function getLayerFrame(layer) {
    const style = getComputedStyle(layer);
    return {
      opacity: style.opacity || "1",
      transform: style.transform === "none" ? "translate3d(0, 0, 0) scale(1)" : style.transform,
      filter: style.filter === "none" ? "blur(0px)" : style.filter,
    };
  }

  function settleLayerTransition(record) {
    if (!record || record.cancelled) return;
    const winner = record.winner;
    cancelLayerTransition(record, winner);
    if (record.scope === "view" && hubViewTransition === record) hubViewTransition = null;
    if (record.scope === "category" && hubCategoryTransition === record) hubCategoryTransition = null;
    if (record.scope === "view") {
      requestAnimationFrame(() => syncCategoryIndicator(false));
    }
  }

  function reverseLayerTransition(record, winner, winnerKey) {
    if (!record || record.cancelled) return;
    record.winner = winner;
    record.stage.dataset.currentKey = winnerKey;
    record.fromLayer.inert = winner !== record.fromLayer;
    record.toLayer.inert = winner !== record.toLayer;
    record.fromLayer.toggleAttribute("aria-hidden", winner !== record.fromLayer);
    record.toLayer.toggleAttribute("aria-hidden", winner !== record.toLayer);
    record.animations.forEach((animation) => {
      if (animation.playState === "finished") animation.currentTime = animation.effect.getTiming().duration;
      animation.reverse();
    });
  }

  function createTransitionLayer(stage, key, html, className) {
    const layer = document.createElement("div");
    layer.className = className;
    layer.dataset.layerKey = key;
    layer.innerHTML = html;
    layer.inert = true;
    layer.setAttribute("aria-hidden", "true");
    stage.appendChild(layer);
    return layer;
  }

  function runLayerTransition(stage, key, html, direction, scope) {
    if (!stage) return null;
    const isCategory = scope === "category";
    let record = isCategory ? hubCategoryTransition : hubViewTransition;

    if (record && !record.cancelled) {
      if (key === record.toKey) {
        record.toLayer.innerHTML = html;
        if (record.winner === record.toLayer) return record.toLayer;
        if (record.animations.some((animation) => animation.playbackRate < 0)) {
          reverseLayerTransition(record, record.toLayer, record.toKey);
        } else record.winner = record.toLayer;
        return record.toLayer;
      }
      if (key === record.fromKey) {
        record.fromLayer.innerHTML = html;
        if (record.winner === record.fromLayer) return record.fromLayer;
        reverseLayerTransition(record, record.fromLayer, record.fromKey);
        return record.fromLayer;
      }

      const progress = Number(record.animations[1] && record.animations[1].currentTime) /
        Number(record.animations[1] && record.animations[1].effect.getTiming().duration || 1);
      const dominant = progress >= 0.5 ? record.toLayer : record.fromLayer;
      const dominantFrame = getLayerFrame(dominant);
      cancelLayerTransition(record, dominant);
      dominant.style.opacity = dominantFrame.opacity;
      dominant.style.transform = dominantFrame.transform;
      dominant.style.filter = dominantFrame.filter;
      if (isCategory) hubCategoryTransition = null;
      else hubViewTransition = null;
    }

    let fromLayer = stage.querySelector(":scope > .is-current") || stage.firstElementChild;
    if (!fromLayer) {
      const initial = createTransitionLayer(stage, key, html, isCategory ? "wo-category-layer is-current" : "wo-hub-view-layer is-current");
      initial.inert = false;
      initial.removeAttribute("aria-hidden");
      stage.dataset.currentKey = key;
      return initial;
    }

    if (fromLayer.dataset.layerKey === key || prefersReducedHubMotion() || typeof fromLayer.animate !== "function") {
      fromLayer.innerHTML = html;
      fromLayer.dataset.layerKey = key;
      stage.dataset.currentKey = key;
      clearLayerStyles(fromLayer);
      return fromLayer;
    }

    const toLayer = createTransitionLayer(
      stage,
      key,
      html,
      isCategory ? "wo-category-layer" : "wo-hub-view-layer"
    );
    toLayer.inert = false;
    toLayer.removeAttribute("aria-hidden");
    fromLayer.classList.remove("is-current");
    fromLayer.inert = true;
    fromLayer.setAttribute("aria-hidden", "true");
    const sign = direction === "backward" ? -1 : 1;
    const distance = isCategory ? 8 : 14;
    const blur = isCategory ? 0.8 : 1.4;
    const duration = isCategory ? HUB_MOTION.category : HUB_MOTION.view;
    const fromFrame = getLayerFrame(fromLayer);

    fromLayer.style.willChange = "transform, opacity, filter";
    toLayer.style.willChange = "transform, opacity, filter";
    const outgoing = fromLayer.animate([
      fromFrame,
      {
        opacity: 0.72,
        transform: `translate3d(${-sign * distance * 0.3}px, 0, 0) scale(.998)`,
        filter: `blur(${blur}px)`,
        offset: 0.22,
      },
      {
        opacity: 0.44,
        transform: `translate3d(${-sign * distance * 0.68}px, 0, 0) scale(.996)`,
        filter: "blur(0px)",
        offset: 0.55,
      },
      {
        opacity: 0,
        transform: `translate3d(${-sign * distance}px, 0, 0) scale(.994)`,
        filter: "blur(0px)",
      },
    ], { duration, easing: HUB_MOTION.easing, fill: "both" });
    const incoming = toLayer.animate([
      {
        opacity: 0,
        transform: `translate3d(${sign * distance}px, 0, 0) scale(.994)`,
        filter: `blur(${blur}px)`,
      },
      {
        opacity: 0.88,
        transform: `translate3d(${sign * distance * 0.14}px, 0, 0) scale(.999)`,
        filter: "blur(0px)",
        offset: 0.55,
      },
      {
        opacity: 1,
        transform: "translate3d(0, 0, 0) scale(1)",
        filter: "blur(0px)",
      },
    ], { duration, easing: HUB_MOTION.easing, fill: "both" });

    record = {
      scope,
      stage,
      fromKey: fromLayer.dataset.layerKey || "",
      toKey: key,
      fromLayer,
      toLayer,
      winner: toLayer,
      animations: [outgoing, incoming],
      cancelled: false,
    };
    if (isCategory) hubCategoryTransition = record;
    else hubViewTransition = record;
    stage.dataset.currentKey = key;

    const checkFinished = () => {
      setTimeout(() => {
        if (!record.cancelled && record.animations.every((animation) => animation.playState === "finished")) {
          settleLayerTransition(record);
        }
      }, 0);
    };
    outgoing.onfinish = checkFinished;
    incoming.onfinish = checkFinished;
    return toLayer;
  }

  function hubEaseProgress(progress) {
    const x = clamp(progress, 0, 1);
    let t = x;
    for (let index = 0; index < 5; index += 1) {
      const inverse = 1 - t;
      const estimate = 3 * inverse * inverse * t * 0.32 + 3 * inverse * t * t * 0.18 + t * t * t;
      const slope = 3 * inverse * inverse * 0.32 + 6 * inverse * t * (0.18 - 0.32) + 3 * t * t * (1 - 0.18);
      if (Math.abs(slope) < 0.0001) break;
      t -= (estimate - x) / slope;
      t = clamp(t, 0, 1);
    }
    const inverse = 1 - t;
    return 3 * inverse * t * t + t * t * t;
  }

  function getInteractiveViewLayer() {
    if (hubViewTransition && hubViewTransition.winner && hubViewTransition.winner.isConnected) {
      return hubViewTransition.winner;
    }
    return hubBody && hubBody.querySelector(".wo-hub-view-stage > .wo-hub-view-layer.is-current");
  }

  function getCategoryScrollTarget(tabs, activeButton) {
    const vertical = tabs.scrollHeight > tabs.clientHeight + 2;
    if (vertical) {
      const start = tabs.scrollTop;
      const top = activeButton.offsetTop;
      const bottom = top + activeButton.offsetHeight;
      if (top < start) return { axis: "top", start, end: top };
      if (bottom > start + tabs.clientHeight) {
        return { axis: "top", start, end: bottom - tabs.clientHeight };
      }
      return { axis: "top", start, end: start };
    }

    const start = tabs.scrollLeft;
    const left = activeButton.offsetLeft;
    const right = left + activeButton.offsetWidth;
    if (left < start) return { axis: "left", start, end: left };
    if (right > start + tabs.clientWidth) {
      return { axis: "left", start, end: right - tabs.clientWidth };
    }
    return { axis: "left", start, end: start };
  }

  function syncCategoryIndicator(animate = true) {
    const viewLayer = getInteractiveViewLayer();
    const tabs = viewLayer && viewLayer.querySelector("#wo-category-tabs");
    const activeButton = tabs && tabs.querySelector(".wo-category-tab.active");
    const indicator = tabs && tabs.querySelector(":scope > .wo-category-indicator");
    if (!tabs || !activeButton || !indicator) return;

    const oldRect = indicator.getBoundingClientRect();
    cancelIndicatorMotion();
    const generation = hubIndicatorGeneration;
    const scroll = getCategoryScrollTarget(tabs, activeButton);

    indicator.style.left = `${activeButton.offsetLeft}px`;
    indicator.style.top = `${activeButton.offsetTop}px`;
    indicator.style.width = `${activeButton.offsetWidth}px`;
    indicator.style.height = `${activeButton.offsetHeight}px`;
    const newRect = indicator.getBoundingClientRect();

    if (!animate || prefersReducedHubMotion() || !oldRect.width || typeof indicator.animate !== "function") {
      if (scroll.axis === "top") tabs.scrollTop = scroll.end;
      else tabs.scrollLeft = scroll.end;
      return;
    }

    const deltaX = oldRect.left - newRect.left;
    const deltaY = oldRect.top - newRect.top;
    const scaleX = oldRect.width / Math.max(1, newRect.width);
    const scaleY = oldRect.height / Math.max(1, newRect.height);
    indicator.style.willChange = "transform";
    hubIndicatorAnimation = indicator.animate([
      { transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scale(${scaleX}, ${scaleY})` },
      { transform: "translate3d(0, 0, 0) scale(1, 1)" },
    ], {
      duration: HUB_MOTION.indicator,
      easing: HUB_MOTION.easing,
    });
    hubIndicatorAnimation.onfinish = () => {
      if (generation !== hubIndicatorGeneration) return;
      indicator.style.removeProperty("will-change");
      hubIndicatorAnimation = null;
    };

    if (scroll.start !== scroll.end) {
      const startedAt = performance.now();
      const step = (now) => {
        if (generation !== hubIndicatorGeneration) return;
        const progress = clamp((now - startedAt) / HUB_MOTION.indicator, 0, 1);
        const value = scroll.start + (scroll.end - scroll.start) * hubEaseProgress(progress);
        if (scroll.axis === "top") tabs.scrollTop = value;
        else tabs.scrollLeft = value;
        if (progress < 1) hubIndicatorScrollFrame = requestAnimationFrame(step);
        else hubIndicatorScrollFrame = 0;
      };
      hubIndicatorScrollFrame = requestAnimationFrame(step);
    }
  }

  function configureSolidSurface() {
    if (!hubContainer) return;
    hubContainer.dataset.woSurface = "solid";
    hubContainer.dataset.woPerformanceMode = hubState.performanceMode;
    hubContainer.dataset.woPerformanceResolved = hubState.resolvedPerformanceMode;
  }

  function normalizePerformanceMode(value) {
    return ["auto", "quality", "performance"].includes(value) ? value : "auto";
  }

  function resolvePerformanceMode(mode) {
    if (mode !== "auto") return mode;
    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const memory = Number(navigator.deviceMemory) || 8;
    const cores = Number(navigator.hardwareConcurrency) || 8;
    return reduceMotion || memory <= 4 || cores <= 4 ? "performance" : "quality";
  }

  function applyPerformanceMode(value) {
    hubState.performanceMode = normalizePerformanceMode(value);
    hubState.resolvedPerformanceMode = resolvePerformanceMode(hubState.performanceMode);
    configureSolidSurface();
  }

  function getRegistryAction(action) {
    const registry = window.WebOmniActionRegistry;
    if (!registry) return null;
    try {
      if (typeof registry.getAction === "function") return registry.getAction(action) || null;
      if (typeof registry.get === "function") return registry.get(action) || null;
      if (registry.actions instanceof Map) return registry.actions.get(action) || null;
      if (registry.actions && typeof registry.actions === "object") return registry.actions[action] || null;
    } catch (error) {
      console.warn("[WO Hub] Action registry lookup failed:", error);
    }
    return null;
  }

  function getActionRestriction(action) {
    if (LOCAL_ACTION_RESTRICTIONS[action]) return LOCAL_ACTION_RESTRICTIONS[action];
    const registered = getRegistryAction(action);
    if (!registered) return null;
    if (registered.disabled === true || registered.enabled === false || registered.supported === false || registered.disabledReason) {
      return {
        status: registered.status || registered.errorCode || "UNSUPPORTED_CONTEXT",
        reason: registered.disabledReason || registered.reason || "当前环境暂不支持此命令",
      };
    }
    return null;
  }

  function createActionRequest(action, payload) {
    const registry = window.WebOmniActionRegistry;
    let request = null;
    if (registry && typeof registry.createRequest === "function") {
      try {
        request = registry.createRequest(action, null, payload);
      } catch (error) {
        console.warn("[WO Hub] Action registry request creation failed:", error);
      }
    }
    const normalizedRequest = {
      ...(request && typeof request === "object" ? request : {}),
      type: "WO_EXECUTE_ACTION",
      action,
      tabId: Number.isInteger(request && request.tabId)
        ? request.tabId
        : (Number.isInteger(window.__webOmniTabId) ? window.__webOmniTabId : null),
    };
    if (payload === undefined) delete normalizedRequest.payload;
    else normalizedRequest.payload = payload;
    return normalizedRequest;
  }

  function isActivePhase(state) {
    if (!state) return false;
    const phase = normalizeText(state.phase);
    if (Number(state.reversibleCount) > 0) return true;
    if (["recoverable", "monitoring", "recording", "paused"].includes(phase)) return true;
    return state.active === true;
  }

  function isRecoverableActionState(state) {
    return Boolean(state && (Number(state.reversibleCount) > 0 || normalizeText(state.phase) === "recoverable"));
  }

  function getActiveStatusLabel(state) {
    const phase = normalizeText(state && state.phase);
    if (!state) return "";
    if (isRecoverableActionState(state) && state.active === false) return "可恢复";
    if (phase === "starting") return "正在开启";
    if (phase === "stopping") return "正在关闭";
    if (["picking", "selecting"].includes(phase)) return "等待选择";
    if (phase === "error" || state.error) return "操作失败";
    if (phase === "paused") return "已暂停";
    if (phase === "recording") return "录制中";
    if (phase === "monitoring") return "监控中";
    return "已开启";
  }

  function normalizeActiveAction(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.action !== "string") return null;
    const command = getCommand(raw.action);
    const registered = getRegistryAction(raw.action);
    return {
      action: raw.action,
      title: String(raw.title || (command && command.label) || ACTIVE_ACTION_TITLES[raw.action] || (registered && registered.label) || raw.action),
      active: raw.active !== false,
      phase: String(raw.phase || (raw.active === false ? "inactive" : "running")),
      scope: String(raw.scope || "tab"),
      count: Math.max(0, Number(raw.count) || 0),
      reversibleCount: Math.max(0, Number(raw.reversibleCount) || 0),
      revision: Math.max(0, Number(raw.revision) || 0),
      updatedAt: Math.max(0, Number(raw.updatedAt) || Date.now()),
      error: raw.error ? String(raw.error) : null,
      controls: raw.controls,
    };
  }

  function extractActiveActionList(payload) {
    let envelope = payload;
    if (envelope && envelope.data && envelope.data.actions !== undefined) envelope = envelope.data;
    else if (envelope && envelope.result && envelope.result.data && envelope.result.data.actions !== undefined) {
      envelope = envelope.result.data;
    }
    let source = envelope;
    if (envelope && envelope.actions !== undefined) source = envelope.actions;
    const revision = Math.max(0, Number(envelope && envelope.revision) || 0);
    const envelopeUpdatedAt = Math.max(0, Number(envelope && envelope.updatedAt) || 0);

    if (source instanceof Map) source = Array.from(source.values());
    if (Array.isArray(source)) {
      return {
        items: source,
        complete: true,
        revision,
        updatedAt: Math.max(envelopeUpdatedAt, ...source.map((item) => Math.max(0, Number(item && item.updatedAt) || 0))),
      };
    }
    if (source && typeof source === "object" && typeof source.action === "string") {
      return {
        items: [source],
        complete: false,
        revision: Math.max(revision, Number(source.revision) || 0),
        updatedAt: Math.max(envelopeUpdatedAt, Number(source.updatedAt) || 0),
      };
    }
    if (source && typeof source === "object") {
      const values = Object.entries(source).map(([action, value]) => (
        value && typeof value === "object" ? { action, ...value } : null
      )).filter(Boolean);
      return {
        items: values,
        complete: true,
        revision,
        updatedAt: Math.max(envelopeUpdatedAt, ...values.map((item) => Math.max(0, Number(item.updatedAt) || 0))),
      };
    }
    return null;
  }

  function applyActiveActionSnapshot(payload, options = {}) {
    const extracted = extractActiveActionList(payload);
    if (!extracted) return false;
    const replace = options.replace === true || extracted.complete;
    if (
      extracted.updatedAt < hubState.activeActionsUpdatedAt ||
      (
        extracted.updatedAt === hubState.activeActionsUpdatedAt &&
        extracted.revision && extracted.revision < hubState.activeActionsRevision
      )
    ) return false;
    const next = replace ? new Map() : new Map(hubState.activeActions);
    extracted.items.forEach((item) => {
      const state = normalizeActiveAction(item);
      if (!state) return;
      const previous = hubState.activeActions.get(state.action);
      if (
        previous && (
          state.updatedAt < previous.updatedAt ||
          (state.updatedAt === previous.updatedAt && state.revision && state.revision < previous.revision)
        )
      ) {
        if (replace) next.set(previous.action, previous);
        return;
      }
      if (isActivePhase(state)) next.set(state.action, state);
      else next.delete(state.action);
    });
    if (replace) {
      hubState.activeActions.forEach((previous, action) => {
        if (!next.has(action) && previous.updatedAt > extracted.updatedAt) next.set(action, previous);
      });
    }
    hubState.activeActions = next;
    hubState.activeActionsRevision = Math.max(hubState.activeActionsRevision, extracted.revision);
    hubState.activeActionsUpdatedAt = Math.max(hubState.activeActionsUpdatedAt, extracted.updatedAt);
    renderActiveStateSurfaces();
    return true;
  }

  function getActiveActions() {
    return Array.from(hubState.activeActions.values())
      .filter(isActivePhase)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.title.localeCompare(right.title, "zh-CN"));
  }

  function getActiveAction(action) {
    const state = hubState.activeActions.get(action);
    return isActivePhase(state) ? state : null;
  }

  function attachActionStateRuntime() {
    const runtime = window.webOmniActionState;
    if (!runtime || typeof runtime !== "object") return false;
    if (hubActionStateRuntime === runtime) return true;
    if (typeof hubActionStateUnsubscribe === "function") {
      try { hubActionStateUnsubscribe(); } catch (_) { /* Runtime disposal is best effort. */ }
    }
    hubActionStateRuntime = runtime;
    hubActionStateUnsubscribe = null;

    if (typeof runtime.subscribe === "function") {
      try {
        const unsubscribe = runtime.subscribe((value) => applyActiveActionSnapshot(value));
        if (typeof unsubscribe === "function") hubActionStateUnsubscribe = unsubscribe;
      } catch (error) {
        console.warn("[WO Hub] Action-state subscription failed:", error);
      }
    }
    if (typeof runtime.snapshot === "function") {
      try {
        Promise.resolve(runtime.snapshot())
          .then((value) => applyActiveActionSnapshot(value, { replace: true }))
          .catch((error) => console.warn("[WO Hub] Action-state snapshot failed:", error));
      } catch (error) {
        console.warn("[WO Hub] Action-state snapshot failed:", error);
      }
    }
    return true;
  }

  async function requestActiveActions() {
    attachActionStateRuntime();
    try {
      const response = await chrome.runtime.sendMessage(createActionRequest("WO_ACTIVE_ACTIONS_GET"));
      if (response && response.ok !== false) applyActiveActionSnapshot(response, { replace: true });
      return response;
    } catch (error) {
      console.warn("[WO Hub] Active action query failed:", error);
      return null;
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request) return;

    if (["WO_ACTIVE_ACTIONS_CHANGED", "WO_ACTIVE_ACTIONS_SNAPSHOT", "WO_ACTIVE_ACTIONS_UPDATED"].includes(request.type)) {
      applyActiveActionSnapshot(request.snapshot || request.data || request.payload || request);
      if (typeof sendResponse === "function") sendResponse({ ok: true });
      return true;
    }

    const syncedAction = request.type === "WO_ACTION_STATE_SYNC"
      ? (request.stateAction || request.action)
      : request.action;
    if (["WO_ACTION_STATE_SYNC", "WO_ACTION_STATE_CHANGED"].includes(request.type) && typeof syncedAction === "string") {
      applyActiveActionSnapshot(request.state ? { action: syncedAction, ...request.state } : {
        action: syncedAction,
        active: false,
        phase: "inactive",
        revision: request.revision,
        updatedAt: request.updatedAt,
      });
      if (typeof sendResponse === "function") sendResponse({ ok: true });
      return true;
    }

    if (request.action === "PING_COMMAND_HUB") {
      if (typeof sendResponse === "function") sendResponse(getCommandHubStatus());
      return true;
    }

    if (request.action === "TOGGLE_COMMAND_HUB") {
      Promise.resolve(toggleCommandHub())
        .then((status) => {
          if (typeof sendResponse === "function") sendResponse(status);
        })
        .catch((error) => {
          if (typeof sendResponse === "function") {
            sendResponse({
              ok: false,
              open: false,
              state: "closed",
              status: "MODULE_LOAD_FAILED",
              error: error && error.message ? error.message : String(error),
            });
          }
        });
      return true;
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    let storeChanged = false;
    const readChange = (key) => Object.prototype.hasOwnProperty.call(changes, key)
      ? changes[key].newValue
      : undefined;

    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.pins)) {
      const nextPins = sanitizePins(readChange(STORAGE_KEYS.pins));
      if (!equalStringLists(hubState.store.pins, nextPins)) {
        hubState.store.pins = nextPins;
        storeChanged = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.recent)) {
      const nextRecent = sanitizeRecent(readChange(STORAGE_KEYS.recent));
      if (!equalStringLists(hubState.store.recent, nextRecent)) {
        hubState.store.recent = nextRecent;
        storeChanged = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.usage)) {
      const nextUsage = sanitizeUsage(readChange(STORAGE_KEYS.usage));
      if (!equalUsageStores(hubState.store.usage, nextUsage)) {
        hubState.store.usage = nextUsage;
        storeChanged = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.personalOrder)) {
      const nextOrder = sanitizePersonalOrder(readChange(STORAGE_KEYS.personalOrder));
      if (!equalStringLists(hubState.store.personalOrder, nextOrder)) {
        hubState.store.personalOrder = nextOrder;
        storeChanged = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.performanceMode)) {
      const nextMode = normalizePerformanceMode(readChange(STORAGE_KEYS.performanceMode));
      if (nextMode !== hubState.performanceMode) {
        applyPerformanceMode(nextMode);
        storeChanged = true;
      }
    }

    if (storeChanged) scheduleHubStoreSyncRender();
  });

  function normalizeText(value) {
    return String(value || "").toLowerCase().trim();
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function tokenizeQuery(query) {
    return normalizeText(query).split(/[\s/|,，]+/).filter(Boolean);
  }

  function dedupeCommands(items) {
    const seen = new Set();
    return items.filter((item) => {
      if (!item || seen.has(item.action)) return false;
      seen.add(item.action);
      return true;
    });
  }

  function getCommand(action) {
    return COMMAND_BY_ACTION.get(action) || null;
  }

  function getUsageMeta(action) {
    const raw = hubState.store.usage[action];
    if (!raw) return { count: 0, lastUsed: 0 };
    return {
      count: Number(raw.count) || 0,
      lastUsed: Number(raw.lastUsed) || 0,
    };
  }

  function getPinnedSet() {
    return new Set(hubState.store.pins);
  }

  function getRecentSet() {
    return new Set(hubState.store.recent);
  }

  function freshnessBoost(lastUsed) {
    if (!lastUsed) return 0;
    const ageHours = (Date.now() - lastUsed) / 36e5;
    if (ageHours <= 6) return 8;
    if (ageHours <= 24) return 6;
    if (ageHours <= 72) return 4;
    if (ageHours <= 168) return 2;
    return 0;
  }

  function sanitizePins(raw) {
    const list = Array.isArray(raw) ? raw : [];
    return Array.from(new Set(
      list.filter((item) => PINNABLE_ACTIONS.has(item))
    )).slice(0, PIN_LIMIT);
  }

  function sanitizeRecent(raw) {
    const list = Array.isArray(raw) ? raw : [];
    return Array.from(new Set(
      list.filter((item) => COMMAND_BY_ACTION.has(item) && !getCommand(item).internal)
    )).slice(0, RECENT_LIMIT);
  }

  function sanitizeUsage(raw) {
    const next = {};
    if (!raw || typeof raw !== "object") return next;
    Object.entries(raw).forEach(([action, value]) => {
      if (!COMMAND_BY_ACTION.has(action)) return;
      if (getCommand(action).internal) return;
      const count = Math.max(0, Number(value && value.count) || 0);
      const lastUsed = Math.max(0, Number(value && value.lastUsed) || 0);
      if (count > 0 || lastUsed > 0) {
        next[action] = { count, lastUsed };
      }
    });
    return next;
  }

  function sanitizePersonalOrder(raw) {
    const list = Array.isArray(raw) ? raw : [];
    return Array.from(new Set(
      list.filter((item) => COMMAND_BY_ACTION.has(item) && !getCommand(item).internal)
    )).slice(0, HOME_PERSONAL_LIMIT * 3);
  }

  function equalStringLists(current, next) {
    if (current === next) return true;
    if (!Array.isArray(current) || current.length !== next.length) return false;
    return current.every((item, index) => item === next[index]);
  }

  function equalUsageStores(current, next) {
    if (current === next) return true;
    const currentKeys = Object.keys(current || {});
    const nextKeys = Object.keys(next);
    if (currentKeys.length !== nextKeys.length) return false;
    return nextKeys.every((action) => {
      const currentValue = current && current[action];
      const nextValue = next[action];
      return Boolean(currentValue)
        && currentValue.count === nextValue.count
        && currentValue.lastUsed === nextValue.lastUsed;
    });
  }

  function scheduleHubStoreSyncRender() {
    if (!["open", "opening"].includes(hubVisibilityState)) return;
    cancelPersonalPinDrag({ render: false });
    if (hubStoreSyncFrame) return;
    hubStoreSyncFrame = requestAnimationFrame(() => {
      hubStoreSyncFrame = 0;
      if (["open", "opening"].includes(hubVisibilityState)) renderHub();
    });
  }

  async function loadHubStore() {
    try {
      const raw = await chrome.storage.local.get([
        STORAGE_KEYS.pins,
        STORAGE_KEYS.recent,
        STORAGE_KEYS.usage,
        STORAGE_KEYS.personalOrder,
        STORAGE_KEYS.performanceMode,
      ]);
      hubState.store = {
        pins: sanitizePins(raw[STORAGE_KEYS.pins]),
        recent: sanitizeRecent(raw[STORAGE_KEYS.recent]),
        usage: sanitizeUsage(raw[STORAGE_KEYS.usage]),
        personalOrder: sanitizePersonalOrder(raw[STORAGE_KEYS.personalOrder]),
      };
      applyPerformanceMode(raw[STORAGE_KEYS.performanceMode]);
      hubState.storeLoaded = true;
    } catch (error) {
      console.warn("[WO Hub] Failed to load personalization:", error);
      hubState.storeLoaded = true;
    }
  }

  async function saveHubStore() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.pins]: hubState.store.pins.slice(0, PIN_LIMIT),
        [STORAGE_KEYS.recent]: hubState.store.recent.slice(0, RECENT_LIMIT),
        [STORAGE_KEYS.usage]: hubState.store.usage,
        [STORAGE_KEYS.personalOrder]: hubState.store.personalOrder.slice(0, HOME_PERSONAL_LIMIT * 3),
      });
    } catch (error) {
      console.warn("[WO Hub] Failed to save personalization:", error);
    }
  }

  async function togglePin(action) {
    const command = getCommand(action);
    if (!command || !command.pinnable) return;

    const pins = hubState.store.pins.slice();
    const index = pins.indexOf(action);
    if (index >= 0) {
      pins.splice(index, 1);
      hubState.store.pins = pins;
      window.webOmniShowToast("已取消收藏", "warn", 1800);
    } else {
      pins.unshift(action);
      hubState.store.pins = Array.from(new Set(pins)).slice(0, PIN_LIMIT);
      window.webOmniShowToast("已加入收藏", "success", 1800);
    }

    await saveHubStore();
    renderHub();
    hubInput.focus();
  }

  async function rememberUsage(action) {
    const command = getCommand(action);
    if (!command || command.internal) return;

    const recent = hubState.store.recent.filter((item) => item !== action);
    recent.unshift(action);
    hubState.store.recent = recent.slice(0, RECENT_LIMIT);

    const current = getUsageMeta(action);
    hubState.store.usage[action] = {
      count: current.count + 1,
      lastUsed: Date.now(),
    };

    await saveHubStore();
  }

  function isProbablyArticlePage() {
    const container = document.querySelector("article, main") || document.body;
    if (!container) return false;

    const paragraphs = Array.from(container.querySelectorAll("p"));
    const richParagraphs = paragraphs.filter((node) => String(node.innerText || "").replace(/\s+/g, "").length >= 40);
    const textLength = String(container.innerText || "").replace(/\s+/g, "").length;
    return richParagraphs.length >= 4 || textLength >= 1100;
  }

  function detectPageContexts() {
    const contexts = new Set();
    const host = String(location.hostname || "").toLowerCase();
    const urlText = (location.pathname + " " + location.search + " " + document.title).toLowerCase();

    if (/youtube\.com|youtu\.be/.test(host)) {
      contexts.add("youtube");
      contexts.add("media");
    }

    if (/taobao|tmall|jd\.com|1688|pinduoduo|amazon/.test(host)) {
      contexts.add("ecommerce");
    }

    if (document.querySelector("video, audio")) {
      contexts.add("media");
    }

    if (
      document.querySelector('input[type="password"], form input[autocomplete*="username"], form input[autocomplete*="email"], form input[name*="user" i], form input[name*="login" i]') ||
      /login|signin|signup|register|account|checkout|password/.test(urlText)
    ) {
      contexts.add("form");
    }

    if (isProbablyArticlePage()) {
      contexts.add("article");
    }

    if (contexts.size === 0) {
      contexts.add("generic");
    }

    return contexts;
  }

  function getContextSummaryText() {
    const labels = Array.from(hubState.currentContexts)
      .map((key) => CONTEXT_LABELS[key])
      .filter(Boolean)
      .filter((item) => item !== CONTEXT_LABELS.generic);
    if (!labels.length) {
      return "先搜功能，也可以直接点下面的大入口。";
    }
    return "已识别当前页面：" + labels.join(" / ") + "。";
  }

  function getPreferredBrowseCategory() {
    if (hubState.currentContexts.has("youtube")) return "YouTube";
    if (hubState.currentContexts.has("ecommerce")) return "比价工具";
    if (hubState.currentContexts.has("form")) return "密码管理";
    if (hubState.currentContexts.has("article")) return "沉浸阅读";
    if (hubState.currentContexts.has("media")) return "实用工具";
    return DEFAULT_BROWSE_CATEGORY;
  }

  function contextScore(command) {
    let score = 0;
    command.contexts.forEach((item) => {
      if (hubState.currentContexts.has(item)) {
        score += item === "generic" ? 2 : 22;
      }
    });
    if (command.featured) score += 8;
    const usage = getUsageMeta(command.action);
    score += Math.min(12, usage.count * 1.4) + freshnessBoost(usage.lastUsed);
    return score;
  }

  function getRecommendedCommands(limit, excludeSet) {
    const excluded = excludeSet || new Set();
    const base = COMMANDS
      .filter((item) => !excluded.has(item.action))
      .map((item) => ({ command: item, score: contextScore(item) }))
      .filter((item) => item.score > 0 || item.command.featured)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return left.command.label.localeCompare(right.command.label, "zh-CN");
      })
      .map((item) => item.command);

    return dedupeCommands(base).slice(0, limit);
  }

  function getPersonalReason(action) {
    if (hubState.store.pins.includes(action)) return "收藏";
    if (hubState.store.recent.includes(action)) return "最近";
    if (getUsageMeta(action).count >= 3) return "常用";
    const command = getCommand(action);
    return command && command.featured ? "推荐" : "常用";
  }

  function getPersonalCommands(limit, excludeSet) {
    const excluded = excludeSet || new Set();
    const collected = [];
    const reasons = new Map();

    const pushPersonalCommand = (action, reason) => {
      if (collected.length >= limit || excluded.has(action)) return;
      const command = getCommand(action);
      if (!command || command.internal) return;
      collected.push(command);
      reasons.set(action, reason || getPersonalReason(action));
      excluded.add(action);
    };

    hubState.store.personalOrder.forEach((action) => {
      pushPersonalCommand(action, getPersonalReason(action));
    });

    hubState.store.pins.forEach((action) => {
      pushPersonalCommand(action, "收藏");
    });

    hubState.store.recent.forEach((action) => {
      pushPersonalCommand(action, "最近");
    });

    const frequent = Object.entries(hubState.store.usage)
      .filter(([action]) => !excluded.has(action))
      .sort((left, right) => {
        const countDiff = (right[1].count || 0) - (left[1].count || 0);
        if (countDiff !== 0) return countDiff;
        return (right[1].lastUsed || 0) - (left[1].lastUsed || 0);
      })
      .map(([action]) => getCommand(action))
      .filter(Boolean);

    frequent.forEach((command) => {
      pushPersonalCommand(command.action, "常用");
    });

    if (collected.length < limit) {
      COMMANDS.filter((item) => item.featured && !excluded.has(item.action)).forEach((item) => {
        pushPersonalCommand(item.action, "推荐");
      });
    }

    return collected.slice(0, limit).map((command) => ({
      command,
      reason: reasons.get(command.action) || "常用",
    }));
  }

  function scoreSearch(command, rawQuery, tokens, recommendedSet) {
    const searchIndex = COMMAND_SEARCH_INDEX.get(command.action);
    if (!searchIndex) return 0;
    const { label, desc, category, action, aliases, keywords } = searchIndex;
    const haystack = [label, desc, category, action].concat(aliases, keywords).join(" ");

    let score = 0;
    let matched = false;

    if (label === rawQuery) {
      score += 320;
      matched = true;
    }
    if (label.startsWith(rawQuery)) {
      score += 250;
      matched = true;
    }
    if (aliases.some((item) => item === rawQuery || item.startsWith(rawQuery))) {
      score += 230;
      matched = true;
    }
    if (keywords.some((item) => item === rawQuery || item.startsWith(rawQuery))) {
      score += 220;
      matched = true;
    }
    if (label.includes(rawQuery)) {
      score += 180;
      matched = true;
    }
    if (aliases.some((item) => item.includes(rawQuery))) {
      score += 160;
      matched = true;
    }
    if (keywords.some((item) => item.includes(rawQuery))) {
      score += 150;
      matched = true;
    }
    if (desc.includes(rawQuery)) {
      score += 88;
      matched = true;
    }
    if (category.includes(rawQuery) || action.includes(rawQuery)) {
      score += 72;
      matched = true;
    }

    const allTokensMatched = tokens.length > 1 && tokens.every((item) => haystack.includes(item));
    if (allTokensMatched) {
      score += 68;
      matched = true;
    }

    if (!matched) {
      return 0;
    }

    if (recommendedSet.has(command.action)) score += 18;
    if (hubState.store.pins.includes(command.action)) score += 16;

    const recentIndex = hubState.store.recent.indexOf(command.action);
    if (recentIndex >= 0) {
      score += Math.max(4, 14 - recentIndex * 2);
    }

    const usage = getUsageMeta(command.action);
    score += Math.min(18, usage.count * 1.5);
    score += freshnessBoost(usage.lastUsed);

    return score;
  }

  function getSearchResults(query) {
    const rawQuery = normalizeText(query);
    const tokens = tokenizeQuery(query);
    const recommendedSet = new Set(getRecommendedCommands(8, new Set()).map((item) => item.action));

    return COMMANDS
      .map((command) => ({
        command,
        score: scoreSearch(command, rawQuery, tokens, recommendedSet),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return left.command.label.localeCompare(right.command.label, "zh-CN");
      })
      .slice(0, SEARCH_RESULT_LIMIT)
      .map((item) => item.command);
  }

  function getCommandBadges(command, options) {
    const badges = [];
    const opts = options || {};
    const restriction = getActionRestriction(command.action);
    const activeState = getActiveAction(command.action);

    if (activeState) {
      badges.push({
        label: activeState.count > 1 ? `${getActiveStatusLabel(activeState)} ${activeState.count}` : getActiveStatusLabel(activeState),
        tone: activeState.error
          ? "error"
          : (isRecoverableActionState(activeState) && activeState.active === false ? "recoverable" : "active"),
      });
    }

    if (restriction) {
      badges.push({ label: "受限", tone: "disabled" });
    }

    if (opts.reason) {
      badges.push({ label: opts.reason, tone: "status" });
    } else {
      if (opts.recommendedSet && opts.recommendedSet.has(command.action)) {
        badges.push({ label: "推荐", tone: "status" });
      }
      if (hubState.store.pins.includes(command.action)) {
        badges.push({ label: "收藏", tone: "status" });
      } else if (hubState.store.recent.includes(command.action)) {
        badges.push({ label: "最近", tone: "status" });
      } else if (getUsageMeta(command.action).count >= 3) {
        badges.push({ label: "常用", tone: "status" });
      }
    }

    badges.push({ label: command.categoryTab, tone: "category" });
    return badges.slice(0, 3);
  }

  function renderBadgeList(badges) {
    if (!badges || !badges.length) return "";
    return `<span class="wo-card-badges">${badges.map((badge) =>
      `<span class="wo-badge wo-badge-${badge.tone}">${escapeHtml(badge.label)}</span>`
    ).join("")}</span>`;
  }

  function mergeRanges(ranges) {
    if (!ranges.length) return [];
    return ranges
      .slice()
      .sort((left, right) => left[0] - right[0] || left[1] - right[1])
      .reduce((merged, range) => {
        const last = merged[merged.length - 1];
        if (!last || range[0] > last[1]) {
          merged.push(range.slice());
        } else if (range[1] > last[1]) {
          last[1] = range[1];
        }
        return merged;
      }, []);
  }

  function highlightText(value, query) {
    const text = String(value || "");
    const normalizedText = normalizeText(text);
    const tokens = Array.from(new Set(tokenizeQuery(query))).sort((left, right) => right.length - left.length);
    const ranges = [];

    tokens.forEach((token) => {
      let index = normalizedText.indexOf(token);
      let matchedExact = false;
      while (index >= 0) {
        matchedExact = true;
        ranges.push([index, index + token.length]);
        index = normalizedText.indexOf(token, index + token.length);
      }

      if (matchedExact || !/[\u4e00-\u9fff]/.test(token) || token.length < 2) return;
      Array.from(new Set(token.match(/[\u4e00-\u9fff]/g) || [])).forEach((char) => {
        let charIndex = normalizedText.indexOf(char);
        while (charIndex >= 0) {
          ranges.push([charIndex, charIndex + char.length]);
          charIndex = normalizedText.indexOf(char, charIndex + char.length);
        }
      });
    });

    const merged = mergeRanges(ranges);
    if (!merged.length) return escapeHtml(text);

    let cursor = 0;
    return merged.map((range) => {
      const before = escapeHtml(text.slice(cursor, range[0]));
      const hit = escapeHtml(text.slice(range[0], range[1]));
      cursor = range[1];
      return `${before}<mark class="wo-search-hit">${hit}</mark>`;
    }).join("") + escapeHtml(text.slice(cursor));
  }

  function renderPinButton(command) {
    if (!command.pinnable) return "";
    const pinned = hubState.store.pins.includes(command.action);
    const label = pinned ? "取消收藏" : "加入收藏";
    return `<button class="wo-pin-btn${pinned ? " is-pinned" : ""}" type="button" data-pin-action="${escapeHtml(command.action)}" aria-label="${label}" title="${label}"><span class="wo-pin-icon">${HUB_SVG.star}</span><span class="wo-pin-label">${pinned ? "已藏" : "收藏"}</span></button>`;
  }

  function renderFixedCard(item) {
    const icon = getActionIcon(item.action, "快捷入口");
    const active = getActiveAction(item.action);
    return `
      <button class="wo-feature-card wo-nav-item${active ? " is-active" : ""}${isRecoverableActionState(active) && active.active === false ? " is-recoverable" : ""}" type="button" data-action-trigger="${escapeHtml(item.action)}" title="${escapeHtml(item.desc)}">
        <span class="wo-feature-head">
          <span class="wo-feature-icon">${icon}</span>
          <strong>${escapeHtml(item.title)}</strong>
          <span class="wo-feature-state${isRecoverableActionState(active) && active.active === false ? " is-recoverable" : ""}"${active ? "" : ' hidden=""'}>${active ? escapeHtml(getActiveStatusLabel(active)) : "已开启"}</span>
        </span>
        <span class="wo-feature-desc">${escapeHtml(item.desc)}</span>
      </button>
    `;
  }

  function renderCommandCard(command, options) {
    const opts = options || {};
    const restriction = getActionRestriction(command.action);
    const activeState = getActiveAction(command.action);
    const badges = renderBadgeList(getCommandBadges(command, opts));
    const icon = getActionIcon(command.action, command.categoryName);
    const titleHtml = opts.highlightQuery ? highlightText(command.label, opts.highlightQuery) : escapeHtml(command.label);
    const descText = restriction ? restriction.reason : command.desc;
    const descHtml = opts.highlightQuery && !restriction ? highlightText(descText, opts.highlightQuery) : escapeHtml(descText);
    const cardClass = [
      "wo-command-card",
      opts.compact ? "is-compact" : "",
      opts.dense ? "is-dense" : "",
      opts.personalPinned ? "is-personal-pinned" : "",
      activeState ? "is-active" : "",
      isRecoverableActionState(activeState) && activeState.active === false ? "is-recoverable" : "",
      activeState && activeState.error ? "is-error" : "",
      restriction ? "is-disabled" : "",
    ].filter(Boolean).join(" ");
    const cardAttrs = [
      `class="${cardClass} wo-nav-item"`,
      `data-action-trigger="${escapeHtml(command.action)}"`,
      `data-command-action="${escapeHtml(command.action)}"`,
      opts.personalAction ? `data-personal-action="${escapeHtml(command.action)}"` : "",
      opts.personalPinned ? 'data-personal-pinned="true" aria-grabbed="false"' : "",
      restriction ? `aria-disabled="true" data-disabled-status="${escapeHtml(restriction.status)}" title="${escapeHtml(restriction.reason)}"` : "",
    ].filter(Boolean).join(" ");
    return `
      <article ${cardAttrs}>
        <span class="wo-command-icon">${icon}</span>
        <span class="wo-command-copy">
          <span class="wo-command-head">
            <strong class="wo-command-title">${titleHtml}</strong>
            ${badges}
          </span>
          <span class="wo-command-desc">${descHtml}</span>
        </span>
        ${restriction ? "" : renderPinButton(command)}
      </article>
    `;
  }

  function renderEmptyState(title, desc) {
    return `
      <div class="wo-empty-state">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(desc)}</span>
      </div>
    `;
  }

  function buildHomeView() {
    const fixedCards = HOME_FIXED_ACTIONS.map(renderFixedCard).join("");
    const recommended = getRecommendedCommands(6, new Set(FIXED_ACTION_SET));
    const personal = getPersonalCommands(HOME_PERSONAL_LIMIT, new Set(FIXED_ACTION_SET).add("__OPEN_BROWSE__"));
    const recommendedSet = new Set(recommended.map((cmd) => cmd.action));
    const contextNote = getContextSummaryText();

    return `
      <section class="wo-section wo-section-quick">
        <div class="wo-section-head">
          <h3>固定入口</h3>
          <button class="wo-inline-link" type="button" data-browse-toggle="true">全部分类 →</button>
        </div>
        <div class="wo-feature-grid">${fixedCards}</div>
      </section>

      <div class="wo-home-columns">
        <section class="wo-section">
          <div class="wo-section-head">
            <span class="wo-section-title">
              <h3>当前页推荐</h3>
              <span class="wo-section-meta">${escapeHtml(contextNote)}</span>
            </span>
          </div>
          <div class="wo-card-list">
            ${recommended.length
              ? recommended.map((item) => renderCommandCard(item, { recommendedSet, compact: true, dense: true })).join("")
              : renderEmptyState("暂无强推荐", "没识别出明显的页面场景，先用搜索吧。")}
          </div>
        </section>

        <section class="wo-section">
          <div class="wo-section-head">
            <span class="wo-section-title">
              <h3>收藏 · 最近 · 常用</h3>
              <span class="wo-section-meta">按你的使用记录排序。</span>
            </span>
          </div>
          <div class="wo-card-list" data-personal-list="true">
            ${personal.length
              ? personal.map((item) => renderCommandCard(item.command, {
                  reason: item.reason,
                  compact: true,
                  dense: true,
                  personalAction: item.command.action,
                  personalPinned: item.reason === "收藏",
                })).join("")
              : renderEmptyState("暂无记录", "执行或收藏几次后会自动出现在这里。")}
          </div>
        </section>
      </div>
    `;
  }

  function buildBrowseTabs() {
    return `<span class="wo-category-indicator" aria-hidden="true"></span>` + CATEGORIES.map((category) => `
      <button class="wo-category-tab${hubState.activeCategory === category.name ? " active" : ""}" type="button" role="tab" data-category-name="${escapeHtml(category.name)}" aria-selected="${hubState.activeCategory === category.name ? "true" : "false"}"${hubState.activeCategory === category.name ? ' aria-current="true"' : ""}>
        <span class="wo-category-name">${escapeHtml(category.name)}</span>
        <span class="wo-category-mini">${escapeHtml(category.commands.length)}</span>
      </button>
    `).join("");
  }

  function getBrowseCategory(name) {
    return CATEGORIES.find((item) => item.name === name) || CATEGORIES[0];
  }

  function getBrowseCommands(category) {
    return category ? category.commands.map((item) => getCommand(item.action)).filter(Boolean) : [];
  }

  function renderBrowseCommandList(commands) {
    return commands.length
      ? commands.map((item) => renderCommandCard(item, { compact: true })).join("")
      : renderEmptyState("空分类", "这里暂时没有命令。");
  }

  function buildBrowseView() {
    if (!hubState.activeCategory) {
      hubState.activeCategory = getPreferredBrowseCategory();
    }

    const category = getBrowseCategory(hubState.activeCategory);
    const commands = getBrowseCommands(category);

    return `
      <section class="wo-section wo-section-tight">
        <div class="wo-section-head">
          <h3>分类浏览</h3>
          <span class="wo-section-meta" data-browse-meta="true">${escapeHtml(category.name)} · ${commands.length} 个工具</span>
          <button class="wo-inline-link" type="button" data-home-toggle="true">← 返回首页</button>
        </div>
        <div class="wo-browse-layout">
          <aside class="wo-browse-sidebar">
            <div id="wo-category-tabs" role="tablist" aria-label="工具分类">${buildBrowseTabs()}</div>
          </aside>
          <div class="wo-browse-results">
            <div class="wo-category-stage" data-current-key="${escapeHtml(category.name)}">
              <div class="wo-category-layer is-current" data-layer-key="${escapeHtml(category.name)}">
                <div class="wo-card-list">${renderBrowseCommandList(commands)}</div>
              </div>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  function buildSearchView() {
    const results = getSearchResults(hubState.query);
    const recommendedSet = new Set(getRecommendedCommands(8, new Set()).map((item) => item.action));

    return `
      <section class="wo-section wo-section-tight">
        <div class="wo-section-head">
          <h3>搜索结果</h3>
          <span class="wo-section-meta" data-search-meta="true">${results.length} / ${COMMANDS.length}</span>
        </div>
        <div class="wo-card-list" data-search-results="true">
          ${results.length
            ? results.map((item) => renderCommandCard(item, { recommendedSet, highlightQuery: hubState.query })).join("")
            : renderEmptyState("没找到", "试试更口语的关键词：录屏 / 传文件 / 清悬浮")}
        </div>
      </section>
    `;
  }

  function getActiveControlDefinitions(action, state) {
    const registered = getRegistryAction(action);
    const raw = (registered && registered.controls) || (state && state.controls) || [];
    const allowed = new Set(["enable", "disable", "status", "undo", "restoreAll", "stop", "manage", "pause", "resume"]);
    const controls = [];
    const append = (value, key) => {
      if (Array.isArray(value)) {
        value.forEach((item) => append(item));
        return;
      }
      let mode = "";
      let label = "";
      if (typeof value === "string") mode = value;
      else if (value === true && key) mode = key;
      else if (value && typeof value === "object") {
        mode = value.mode || value.control || value.action || key || "";
        label = value.label || value.title || "";
      }
      if (mode === "restore") mode = "restoreAll";
      if (!allowed.has(mode) || controls.some((item) => item.mode === mode)) return;
      const defaultLabels = {
        enable: "开启",
        disable: action === "PRIVACY_BLOCK_TRACKERS"
          ? "停止拦截"
          : (state && /record|monitor|intercept|listening/i.test(state.phase) ? "停止" : "关闭"),
        status: "刷新",
        undo: "撤销",
        restoreAll: "全部恢复",
        stop: "停止",
        manage: "管理",
        pause: "暂停",
        resume: "继续",
      };
      controls.push({ mode, label: label || defaultLabels[mode] });
    };
    if (Array.isArray(raw)) raw.forEach((item) => append(item));
    else if (raw && typeof raw === "object") Object.entries(raw).forEach(([key, value]) => append(value, key));
    else append(raw);
    if (action === "OPEN_SCREEN_RECORDER" && state) {
      append("manage");
      append("stop");
      const phase = normalizeText(state.phase);
      if (phase === "paused") append("resume");
      else if (phase === "recording") append("pause");
    }
    return controls.filter((control) => {
      if (action === "DOM_MONITOR_ADD" && state) {
        const phase = normalizeText(state.phase);
        if (phase === "monitoring") return control.mode === "manage";
        if (["selecting", "picking"].includes(phase)) return control.mode === "disable";
      }
      if (state && state.active === false && isRecoverableActionState(state) && ["disable", "stop"].includes(control.mode)) return false;
      if (state && state.reversibleCount <= 0 && normalizeText(state.phase) !== "recoverable" && ["undo", "restoreAll"].includes(control.mode)) return false;
      return true;
    });
  }

  function getActiveScopeLabel(scope) {
    return {
      tab: "当前标签页",
      page: "当前页面",
      origin: "当前站点",
      global: "全部页面",
      durable: "持久设置",
      extension: "扩展",
      system: "系统",
      browser: "浏览器",
      session: "本次会话",
    }[scope] || "当前页面";
  }

  function renderActiveActionItem(state) {
    const command = getCommand(state.action);
    const icon = getActionIcon(state.action, command && command.categoryName);
    const controls = getActiveControlDefinitions(state.action, state);
    const countText = state.error || (state.reversibleCount > 0
      ? `${state.reversibleCount} 项可恢复`
      : (state.count > 0 ? `${state.count} 项` : getActiveStatusLabel(state)));
    return `
      <article class="wo-active-item${isRecoverableActionState(state) && state.active === false ? " is-recoverable" : ""}${state.error ? " is-error" : ""}" data-active-action="${escapeHtml(state.action)}">
        <span class="wo-command-icon">${icon}</span>
        <span class="wo-active-copy">
          <span class="wo-active-title"><strong>${escapeHtml(state.title)}</strong><span>${escapeHtml(getActiveStatusLabel(state))}</span></span>
          <span class="wo-active-meta">${escapeHtml(getActiveScopeLabel(state.scope))} · ${escapeHtml(countText)}</span>
        </span>
        <span class="wo-active-controls">
          ${controls.map((control) => `<button type="button" data-active-control="${escapeHtml(control.mode)}" data-active-action="${escapeHtml(state.action)}">${escapeHtml(control.label)}</button>`).join("")}
        </span>
      </article>
    `;
  }

  function renderActiveActionList() {
    const actions = getActiveActions();
    return actions.length
      ? actions.map(renderActiveActionItem).join("")
      : renderEmptyState("当前没有活动功能", "开启持续功能后，可在这里关闭、撤销或恢复。");
  }

  function getActiveSummaryText(actions = getActiveActions()) {
    const recoverable = actions.filter((state) => isRecoverableActionState(state) && state.active === false).length;
    const running = actions.length - recoverable;
    if (running && recoverable) return `${running} 个活动中 · ${recoverable} 个可恢复`;
    if (recoverable) return `${recoverable} 个操作可恢复`;
    return `${running} 个功能处于活动状态`;
  }

  function getActiveRenderKey(actions = getActiveActions()) {
    return actions.map((state) => [
      state.action,
      state.active ? 1 : 0,
      state.phase,
      state.count,
      state.reversibleCount,
      state.revision,
      state.error || "",
    ].join(":")).join("|");
  }

  function buildActivityView() {
    const actions = getActiveActions();
    return `
      <section class="wo-section wo-section-tight wo-activity-view">
        <div class="wo-section-head">
          <h3>当前活动</h3>
          <span class="wo-section-meta" data-active-summary="true">${escapeHtml(getActiveSummaryText(actions))}</span>
          <button class="wo-inline-link" type="button" data-home-toggle="true">← 返回首页</button>
        </div>
        <div class="wo-active-list" data-active-list="true">${renderActiveActionList()}</div>
      </section>
    `;
  }

  function renderActiveStateSurfaces() {
    if (!hubContainer) return;
    const actions = getActiveActions();
    const activeToggle = hubContainer.querySelector("#wo-active-toggle");
    if (activeToggle) {
      const count = activeToggle.querySelector("[data-active-count]");
      if (count) count.textContent = String(actions.length);
      activeToggle.classList.toggle("has-active", actions.length > 0);
      activeToggle.setAttribute("aria-pressed", String(hubState.viewMode === "activity" && !hubState.query));
      activeToggle.title = actions.length ? getActiveSummaryText(actions) : "当前没有活动功能";
    }

    hubContainer.querySelectorAll("[data-command-action]").forEach((card) => {
      const state = getActiveAction(card.getAttribute("data-command-action"));
      const recoverable = isRecoverableActionState(state) && state.active === false;
      card.classList.toggle("is-active", Boolean(state));
      card.classList.toggle("is-recoverable", recoverable);
      card.classList.toggle("is-error", Boolean(state && state.error));
      let badge = card.querySelector(".wo-badge-active, .wo-badge-recoverable, .wo-badge-error");
      if (state && !badge) {
        let badges = card.querySelector(".wo-card-badges");
        if (!badges) {
          badges = document.createElement("span");
          badges.className = "wo-card-badges";
          const head = card.querySelector(".wo-command-head");
          if (head) head.appendChild(badges);
        }
        badge = document.createElement("span");
        badge.className = "wo-badge";
        badges.prepend(badge);
      }
      if (badge) {
        if (state) {
          badge.classList.toggle("wo-badge-active", !recoverable && !state.error);
          badge.classList.toggle("wo-badge-recoverable", recoverable);
          badge.classList.toggle("wo-badge-error", Boolean(state.error));
          badge.textContent = state.count > 1 ? `${getActiveStatusLabel(state)} ${state.count}` : getActiveStatusLabel(state);
        }
        else badge.remove();
      }
    });

    hubContainer.querySelectorAll(".wo-feature-card[data-action-trigger]").forEach((card) => {
      const active = Boolean(getActiveAction(card.getAttribute("data-action-trigger")));
      const state = getActiveAction(card.getAttribute("data-action-trigger"));
      card.classList.toggle("is-active", active);
      const recoverable = isRecoverableActionState(state) && state.active === false;
      card.classList.toggle("is-recoverable", recoverable);
      card.classList.toggle("is-error", Boolean(state && state.error));
      const label = card.querySelector(".wo-feature-state");
      if (label) {
        label.hidden = !active;
        label.classList.toggle("is-recoverable", recoverable);
        if (state) label.textContent = getActiveStatusLabel(state);
      }
    });

    const layer = getInteractiveViewLayer();
    const activeList = layer && layer.querySelector("[data-active-list]");
    if (activeList) {
      const renderKey = getActiveRenderKey(actions);
      if (activeList.dataset.renderKey !== renderKey) {
        activeList.innerHTML = renderActiveActionList();
        activeList.dataset.renderKey = renderKey;
      }
    }
    const summary = layer && layer.querySelector("[data-active-summary]");
    if (summary) summary.textContent = getActiveSummaryText(actions);
  }

  async function handleActiveActionControl(button) {
    const action = button && button.getAttribute("data-active-action");
    const mode = button && button.getAttribute("data-active-control");
    if (!action || !mode) return null;

    const registeredControls = getActiveControlDefinitions(action, getActiveAction(action));
    if (!registeredControls.some((control) => control.mode === mode)) return null;
    const related = Array.from(hubContainer.querySelectorAll(`[data-active-control][data-active-action="${CSS.escape(action)}"]`));
    related.forEach((control) => {
      control.disabled = true;
      control.setAttribute("aria-busy", "true");
    });
    try {
      let response;
      if (action === "OPEN_SCREEN_RECORDER" && ["pause", "resume"].includes(mode)) {
        response = await chrome.runtime.sendMessage({ type: "WO_RECORDER_COMMAND", command: "TOGGLE_PAUSE" });
      } else if (action === "OPEN_SCREEN_RECORDER" && mode === "stop") {
        response = await chrome.runtime.sendMessage({ type: "WO_RECORDER_COMMAND", command: "STOP" });
      } else if (action === "OPEN_SCREEN_RECORDER" && mode === "manage") {
        response = await chrome.runtime.sendMessage(createActionRequest(action));
      } else if (hubActionStateRuntime && typeof hubActionStateRuntime.control === "function") {
        response = await hubActionStateRuntime.control(action, mode);
      } else if (mode === "manage" && ACTIVE_MANAGE_ACTIONS[action]) {
        response = await chrome.runtime.sendMessage(createActionRequest(ACTIVE_MANAGE_ACTIONS[action]));
      } else {
        response = await chrome.runtime.sendMessage(createActionRequest(action, { mode }));
      }
      if (!response || response.ok === false) {
        const message = response && response.error && response.error.message
          ? response.error.message
          : (response && (response.error || response.status)) || "操作失败";
        window.webOmniShowToast(String(message), "error", 3600);
        return response;
      }
      const candidate = response && response.data && (response.data.state || response.data);
      if (candidate && (candidate.action || candidate.active !== undefined || candidate.reversibleCount !== undefined)) {
        applyActiveActionSnapshot({ action, ...candidate });
      }
      await requestActiveActions();
      const restored = Number(response && response.data && response.data.restored);
      if (["undo", "restoreAll"].includes(mode) && Number.isFinite(restored) && restored < 1) {
        window.webOmniShowToast("没有可恢复的操作", "info", 2200);
      } else {
        window.webOmniShowToast(mode === "undo" ? "已撤销最近操作" : (mode === "restoreAll" ? "已全部恢复" : "状态已更新"), "success", 2200);
      }
      return response;
    } catch (error) {
      console.warn("[WO Hub] Active action control failed:", error);
      window.webOmniShowToast(error && error.message ? error.message : "操作失败", "error", 3600);
      return null;
    } finally {
      related.forEach((control) => {
        if (!control.isConnected) return;
        control.disabled = false;
        control.removeAttribute("aria-busy");
      });
    }
  }

  function renderSummary() {
    if (!hubBrowseButton) return;
    if (hubState.query) {
      hubBrowseButton.textContent = "返回当前视图";
      return;
    }
    if (["browse", "activity"].includes(hubState.viewMode)) {
      hubBrowseButton.textContent = "返回首页";
      return;
    }
    hubBrowseButton.textContent = "按分类浏览";
  }

  function getHubViewKey() {
    return hubState.query ? "search" : hubState.viewMode;
  }

  function buildHubView() {
    if (hubState.query) return buildSearchView();
    if (hubState.viewMode === "browse") return buildBrowseView();
    if (hubState.viewMode === "activity") return buildActivityView();
    return buildHomeView();
  }

  function ensureHubViewStage() {
    if (!hubBody) return null;
    let stage = hubBody.querySelector(":scope > .wo-hub-view-stage");
    if (!stage) {
      hubBody.replaceChildren();
      stage = document.createElement("div");
      stage.className = "wo-hub-view-stage";
      stage.setAttribute("aria-live", "polite");
      hubBody.appendChild(stage);
    }
    return stage;
  }

  function renderHub(options = {}) {
    if (!hubBody) return;
    const stage = ensureHubViewStage();
    if (!stage) return;
    const key = getHubViewKey();
    const html = buildHubView();

    if (options.immediate) {
      cancelHubContentAnimations();
      stage.replaceChildren();
      const layer = createTransitionLayer(stage, key, html, "wo-hub-view-layer is-current");
      layer.inert = false;
      layer.removeAttribute("aria-hidden");
      stage.dataset.currentKey = key;
    } else if (options.transition || stage.dataset.currentKey !== key || hubViewTransition) {
      if (hubCategoryTransition) {
        cancelLayerTransition(hubCategoryTransition, hubCategoryTransition.winner);
        hubCategoryTransition = null;
      }
      runLayerTransition(stage, key, html, options.transition || "forward", "view");
    } else {
      const layer = getInteractiveViewLayer();
      if (layer) layer.innerHTML = html;
    }
    renderSummary();
    renderActiveStateSurfaces();
    resetSelection();
    requestAnimationFrame(() => syncCategoryIndicator(false));
  }

  function updateBrowseCategory(nextName, options = {}) {
    const nextCategory = getBrowseCategory(nextName);
    const sameCategory = nextCategory.name === hubState.activeCategory;
    const previousIndex = Math.max(0, CATEGORIES.findIndex((item) => item.name === hubState.activeCategory));
    const nextIndex = Math.max(0, CATEGORIES.findIndex((item) => item.name === nextCategory.name));
    const direction = options.direction || (nextIndex < previousIndex ? "backward" : "forward");
    const viewLayer = getInteractiveViewLayer();
    const tabs = viewLayer && viewLayer.querySelector("#wo-category-tabs");
    const results = viewLayer && viewLayer.querySelector(".wo-browse-results");
    const stage = results && results.querySelector(".wo-category-stage");
    const meta = viewLayer && viewLayer.querySelector("[data-browse-meta]");

    hubState.viewMode = "browse";
    hubState.activeCategory = nextCategory.name;

    if (!tabs || !results || !stage) {
      renderHub({ transition: direction });
      return;
    }
    if (sameCategory) return;

    let activeButton = null;
    tabs.querySelectorAll(".wo-category-tab[data-category-name]").forEach((button) => {
      const active = button.getAttribute("data-category-name") === nextCategory.name;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
      if (active) {
        button.setAttribute("aria-current", "true");
        activeButton = button;
      }
      else button.removeAttribute("aria-current");
    });

    const commands = getBrowseCommands(nextCategory);
    const html = `<div class="wo-card-list">${renderBrowseCommandList(commands)}</div>`;
    if (meta) meta.textContent = `${nextCategory.name} · ${commands.length} 个工具`;
    renderSummary();
    resetSelection();
    runLayerTransition(stage, nextCategory.name, html, direction, "category");
    renderActiveStateSurfaces();
    if (activeButton) requestAnimationFrame(() => syncCategoryIndicator(true));
  }

  function scheduleSearchRender(value) {
    hubPendingQuery = String(value || "").trim();
    if (hubSearchFrame) return;
    hubSearchFrame = requestAnimationFrame(flushSearchRender);
  }

  function flushSearchRender() {
    if (hubSearchFrame) cancelAnimationFrame(hubSearchFrame);
    hubSearchFrame = 0;
    const hadQuery = Boolean(hubState.query);
    hubState.query = hubPendingQuery;
    const hasQuery = Boolean(hubState.query);
    if (hadQuery !== hasQuery) {
      renderHub({ transition: hasQuery ? "forward" : "backward" });
      return;
    }
    if (!hasQuery) return;

    const layer = getInteractiveViewLayer();
    const list = layer && layer.querySelector("[data-search-results]");
    const meta = layer && layer.querySelector("[data-search-meta]");
    if (!list) {
      renderHub();
      return;
    }
    const results = getSearchResults(hubState.query);
    const recommendedSet = new Set(getRecommendedCommands(8, new Set()).map((item) => item.action));
    list.innerHTML = results.length
      ? results.map((item) => renderCommandCard(item, { recommendedSet, highlightQuery: hubState.query })).join("")
      : renderEmptyState("没找到", "试试更口语的关键词：录屏 / 传文件 / 清悬浮");
    if (meta) meta.textContent = `${results.length} / ${COMMANDS.length}`;
    renderActiveStateSurfaces();
    resetSelection();
  }

  function cancelSearchRender() {
    if (!hubSearchFrame) return;
    cancelAnimationFrame(hubSearchFrame);
    hubSearchFrame = 0;
  }

  function getVisibleNavItems() {
    if (!hubBody) return [];
    return Array.from(hubBody.querySelectorAll(".wo-nav-item")).filter((node) => (
      node.offsetParent !== null && !node.closest('[aria-hidden="true"]') && !node.closest("[inert]")
    ));
  }

  function resetSelection() {
    hubState.selectedIndex = -1;
    syncSelection();
  }

  function syncSelection() {
    const items = getVisibleNavItems();
    items.forEach((item, index) => {
      item.classList.toggle("selected", index === hubState.selectedIndex);
    });
  }

  function moveSelection(direction) {
    const items = getVisibleNavItems();
    if (!items.length) return;

    if (hubState.selectedIndex < 0) {
      hubState.selectedIndex = direction > 0 ? 0 : items.length - 1;
    } else {
      hubState.selectedIndex = (hubState.selectedIndex + direction + items.length) % items.length;
    }

    syncSelection();
    const target = items[hubState.selectedIndex];
    if (target) {
      target.scrollIntoView({ block: "nearest" });
    }
  }

  function openBrowseMode() {
    cancelSearchRender();
    const transition = hubState.query ? "backward" : "forward";
    hubState.viewMode = "browse";
    if (!hubState.activeCategory) {
      hubState.activeCategory = getPreferredBrowseCategory();
    }
    hubState.query = "";
    hubPendingQuery = "";
    if (hubInput) hubInput.value = "";
    renderHub({ transition });
    hubInput.focus();
  }

  function openHomeMode() {
    cancelSearchRender();
    hubState.viewMode = "home";
    hubState.query = "";
    hubPendingQuery = "";
    if (hubInput) hubInput.value = "";
    renderHub({ transition: "backward" });
    hubInput.focus();
  }

  function openActivityMode() {
    cancelSearchRender();
    const hadQuery = Boolean(hubState.query);
    const returning = hubState.viewMode === "activity" && !hadQuery;
    const direction = returning || (hadQuery && hubState.viewMode === "activity") ? "backward" : "forward";
    hubState.viewMode = returning ? "home" : "activity";
    hubState.query = "";
    hubPendingQuery = "";
    if (hubInput) hubInput.value = "";
    renderHub({ transition: direction });
    if (hubInput) hubInput.focus();
  }

  async function handleAction(actionName) {
    if (actionName === "__OPEN_BROWSE__") {
      openBrowseMode();
      return;
    }

    const command = getCommand(actionName);
    if (!command || command.internal) return;

    const restriction = getActionRestriction(actionName);
    if (restriction) {
      window.webOmniShowToast(restriction.reason, "warn", 3200);
      return;
    }

    closeCommandHub();
    rememberUsage(actionName).catch((error) => {
      console.warn("[WO Hub] Failed to persist usage:", error);
    });
    try {
      const response = await chrome.runtime.sendMessage(createActionRequest(actionName));
      if (response && response.ok === false) {
        const message = response.error && response.error.message
          ? response.error.message
          : response.error || response.status || "命令执行失败";
        window.webOmniShowToast(String(message), "error", 3600);
      } else if (response) {
        const candidate = response.data && (response.data.state || response.data);
        if (candidate && (candidate.action || candidate.active !== undefined || candidate.reversibleCount !== undefined)) {
          applyActiveActionSnapshot({ action: actionName, ...candidate });
        }
        requestActiveActions().catch(() => {});
      }
      return response;
    } catch (error) {
      console.warn("[WO Hub] Action failed:", error);
      window.webOmniShowToast(error && error.message ? error.message : "命令执行失败", "error", 3600);
      return null;
    }
  }

  function handleTabShortcut() {
    if (hubState.query) return;
    if (hubState.viewMode !== "browse") {
      openBrowseMode();
      return;
    }

    const index = CATEGORIES.findIndex((item) => item.name === hubState.activeCategory);
    const nextCategory = CATEGORIES[(index + 1 + CATEGORIES.length) % CATEGORIES.length];
    updateBrowseCategory(nextCategory.name, { direction: "forward" });
    hubInput.focus();
  }

  function getPersonalCards(list) {
    if (!list) return [];
    return Array.from(list.querySelectorAll(".wo-command-card[data-personal-action]"))
      .filter((card) => card.offsetParent !== null);
  }

  function getPersonalActions(list) {
    return getPersonalCards(list)
      .map((card) => card.dataset.personalAction)
      .filter(Boolean);
  }

  function getPersonalDropBefore(list, draggingCard, clientY) {
    let closestOffset = Number.NEGATIVE_INFINITY;
    let beforeCard = null;

    getPersonalCards(list).forEach((card) => {
      if (card === draggingCard) return;
      const rect = card.getBoundingClientRect();
      const offset = clientY - rect.top - rect.height / 2;
      if (offset < 0 && offset > closestOffset) {
        closestOffset = offset;
        beforeCard = card;
      }
    });

    return beforeCard;
  }

  function getNextPersonalCardAfter(node, draggingCard) {
    let next = node ? node.nextElementSibling : null;
    while (next) {
      if (next !== draggingCard && next.matches && next.matches(".wo-command-card[data-personal-action]")) {
        return next;
      }
      next = next.nextElementSibling;
    }
    return null;
  }

  function animatePersonalListChange(list, draggingCard, mutate) {
    const items = Array.from(list.children).filter((item) =>
      item !== draggingCard &&
      item.offsetParent !== null &&
      (item.matches(".wo-command-card[data-personal-action]") || item.classList.contains("wo-personal-drag-placeholder"))
    );
    const firstRects = new Map(items.map((item) => [item, item.getBoundingClientRect()]));

    mutate();

    requestAnimationFrame(() => {
      items.forEach((item) => {
        if (!item.isConnected) return;
        const first = firstRects.get(item);
        if (!first) return;
        const last = item.getBoundingClientRect();
        const deltaX = first.left - last.left;
        const deltaY = first.top - last.top;
        if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;

        const isPlaceholder = item.classList.contains("wo-personal-drag-placeholder");
        item.classList.add("wo-personal-settling");
        item.style.transition = "none";
        item.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0) scale(${isPlaceholder ? "0.982" : "0.994"})`;
        requestAnimationFrame(() => {
          if (!item.isConnected) return;
          item.style.transition = "transform 0.24s var(--wo-hub-ease), border-color 0.18s ease, box-shadow 0.18s ease";
          item.style.transform = "";
          setTimeout(() => {
            if (!item.isConnected) return;
            item.classList.remove("wo-personal-settling");
            item.style.removeProperty("transition");
            item.style.removeProperty("transform");
          }, 320);
        });
      });
    });
  }

  function movePersonalPlaceholder(drag, clientY) {
    if (!drag || !drag.placeholder || !drag.placeholder.isConnected) return;

    const beforeCard = getPersonalDropBefore(drag.list, drag.card, clientY);
    const currentNext = getNextPersonalCardAfter(drag.placeholder, drag.card);

    if (beforeCard) {
      if (beforeCard === currentNext) return;
      animatePersonalListChange(drag.list, drag.card, () => {
        drag.list.insertBefore(drag.placeholder, beforeCard);
      });
      return;
    }

    if (!currentNext) return;
    animatePersonalListChange(drag.list, drag.card, () => {
      drag.list.appendChild(drag.placeholder);
    });
  }

  function persistPersonalOrder(list) {
    const visibleOrder = getPersonalActions(list);
    if (visibleOrder.length < 2) return Promise.resolve();

    const visibleSet = new Set(visibleOrder);
    const nextOrder = sanitizePersonalOrder(visibleOrder.concat(
      hubState.store.personalOrder.filter((action) => !visibleSet.has(action))
    ));
    if (nextOrder.join("\n") === hubState.store.personalOrder.join("\n")) {
      return Promise.resolve();
    }

    hubState.store.personalOrder = nextOrder;
    return saveHubStore();
  }

  function resetPersonalDragCardStyle(card) {
    if (!card) return;
    [
      "position",
      "left",
      "top",
      "width",
      "height",
      "z-index",
      "pointer-events",
      "margin",
      "transition",
      "transform",
      "transform-origin",
      "will-change",
    ].forEach((name) => card.style.removeProperty(name));
  }

  function getPersonalDragVisual(drag) {
    return drag && (drag.proxy || drag.card);
  }

  function createPersonalDragProxy(card) {
    const proxy = card.cloneNode(true);
    proxy.classList.add("wo-personal-drag-proxy", "wo-personal-dragging");
    proxy.classList.remove("wo-personal-drag-source");
    proxy.setAttribute("aria-hidden", "true");
    proxy.querySelectorAll("button, a, input, textarea, select, [tabindex]").forEach((item) => {
      item.setAttribute("tabindex", "-1");
    });
    return proxy;
  }

  function cancelPersonalDragFrame(drag) {
    if (!drag || !drag.frameId) return;
    cancelAnimationFrame(drag.frameId);
    drag.frameId = 0;
  }

  function applyPersonalDragPosition(drag) {
    const visual = getPersonalDragVisual(drag);
    if (!drag || !visual) return;
    drag.frameId = 0;
    const clientX = Number.isFinite(drag.latestX) ? drag.latestX : drag.startX;
    const clientY = Number.isFinite(drag.latestY) ? drag.latestY : drag.startY;
    const x = clientX - drag.pointerOffsetX - drag.originLeft;
    const y = clientY - drag.pointerOffsetY - drag.originTop;
    visual.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
  }

  function updatePersonalDragPosition(drag, clientX, clientY) {
    if (!drag || !getPersonalDragVisual(drag)) return;
    drag.latestX = clientX;
    drag.latestY = clientY;
    if (drag.frameId) return;
    drag.frameId = requestAnimationFrame(() => applyPersonalDragPosition(drag));
  }

  function triggerPersonalDropConfirm(card) {
    if (!card || !card.isConnected) return;
    card.classList.remove("wo-personal-drop-confirm");
    void card.offsetWidth;
    card.classList.add("wo-personal-drop-confirm");
    setTimeout(() => {
      if (card.isConnected) card.classList.remove("wo-personal-drop-confirm");
    }, PERSONAL_DROP_CONFIRM_MS);
  }

  function cleanupPersonalPinDrag(drag) {
    if (!drag) return;
    cancelPersonalDragFrame(drag);
    if (drag.card) {
      drag.card.classList.remove("wo-personal-dragging");
      drag.card.classList.remove("wo-personal-drag-source");
      drag.card.classList.remove("wo-personal-dropping");
      drag.card.setAttribute("aria-grabbed", "false");
      resetPersonalDragCardStyle(drag.card);
      try {
        if (drag.card.hasPointerCapture && drag.card.hasPointerCapture(drag.pointerId)) {
          drag.card.releasePointerCapture(drag.pointerId);
        }
      } catch (error) {
        // Pointer capture may already be released by the browser.
      }
    }
    if (drag.proxy && drag.proxy.isConnected) {
      drag.proxy.remove();
    }
    if (drag.list) {
      drag.list.classList.remove("wo-personal-list-dragging");
    }
    if (drag.placeholder && drag.placeholder.isConnected) {
      drag.placeholder.remove();
    }
  }

  function suppressNextHubClick() {
    hubSuppressNextClick = true;
    if (hubSuppressClickTimer) clearTimeout(hubSuppressClickTimer);
    hubSuppressClickTimer = setTimeout(() => {
      hubSuppressNextClick = false;
      hubSuppressClickTimer = null;
    }, 450);
  }

  function cancelPersonalPinDrag(options = {}) {
    const drag = hubPersonalDrag;
    if (!drag) return;
    hubPersonalDrag = null;
    cleanupPersonalPinDrag(drag);
    if (options.render && drag.dragging && hubVisibilityState === "open") {
      renderHub();
    }
  }

  function startPersonalDrag(drag, event) {
    const rect = drag.card.getBoundingClientRect();
    const placeholder = document.createElement("div");
    const proxy = createPersonalDragProxy(drag.card);
    placeholder.className = "wo-personal-drag-placeholder";
    placeholder.style.height = `${rect.height}px`;
    placeholder.style.width = `${rect.width}px`;
    drag.card.after(placeholder);
    hubContainer.appendChild(proxy);

    drag.dragging = true;
    drag.placeholder = placeholder;
    drag.proxy = proxy;
    drag.originLeft = rect.left;
    drag.originTop = rect.top;
    drag.originWidth = rect.width;
    drag.originHeight = rect.height;
    drag.pointerOffsetX = clamp(drag.startX - rect.left, 0, rect.width);
    drag.pointerOffsetY = clamp(drag.startY - rect.top, 0, rect.height);
    drag.latestX = event.clientX;
    drag.latestY = event.clientY;

    drag.card.classList.add("wo-personal-dragging", "wo-personal-drag-source");
    drag.card.setAttribute("aria-grabbed", "true");
    drag.card.style.position = "fixed";
    drag.card.style.left = `${rect.left}px`;
    drag.card.style.top = `${rect.top}px`;
    drag.card.style.width = `${rect.width}px`;
    drag.card.style.height = `${rect.height}px`;
    drag.card.style.zIndex = "2147483647";
    drag.card.style.pointerEvents = "none";
    drag.card.style.margin = "0";
    drag.card.style.transition = "none";
    drag.card.style.transformOrigin = `${drag.pointerOffsetX}px ${drag.pointerOffsetY}px`;
    drag.card.style.willChange = "transform";
    proxy.style.position = "fixed";
    proxy.style.left = `${rect.left}px`;
    proxy.style.top = `${rect.top}px`;
    proxy.style.width = `${rect.width}px`;
    proxy.style.height = `${rect.height}px`;
    proxy.style.zIndex = "2147483647";
    proxy.style.pointerEvents = "none";
    proxy.style.margin = "0";
    proxy.style.transition = "none";
    proxy.style.transformOrigin = `${drag.pointerOffsetX}px ${drag.pointerOffsetY}px`;
    proxy.style.willChange = "transform";
    drag.list.classList.add("wo-personal-list-dragging");
    suppressNextHubClick();
    updatePersonalDragPosition(drag, event.clientX, event.clientY);
  }

  function animatePersonalDrop(drag) {
    return new Promise((resolve) => {
      if (!drag || !drag.card || !drag.placeholder || !drag.placeholder.isConnected) {
        resolve();
        return;
      }

      const visual = getPersonalDragVisual(drag);
      if (!visual) {
        resolve();
        return;
      }
      cancelPersonalDragFrame(drag);
      applyPersonalDragPosition(drag);
      const cardRect = visual.getBoundingClientRect();
      const slotRect = drag.placeholder.getBoundingClientRect();
      visual.classList.add("wo-personal-dropping");
      visual.style.left = `${cardRect.left}px`;
      visual.style.top = `${cardRect.top}px`;
      visual.style.width = `${cardRect.width}px`;
      visual.style.height = `${cardRect.height}px`;
      visual.style.transform = "translate3d(0, 0, 0) scale(1.012)";
      visual.style.transition = "left 0.16s var(--wo-hub-ease), top 0.16s var(--wo-hub-ease), width 0.16s var(--wo-hub-ease), height 0.16s var(--wo-hub-ease), transform 0.18s var(--wo-hub-ease)";

      requestAnimationFrame(() => {
        if (!visual.isConnected || !drag.placeholder || !drag.placeholder.isConnected) {
          resolve();
          return;
        }
        visual.style.left = `${slotRect.left}px`;
        visual.style.top = `${slotRect.top}px`;
        visual.style.width = `${slotRect.width}px`;
        visual.style.height = `${slotRect.height}px`;
        visual.style.transform = "translate3d(0, 0, 0) scale(1)";
        setTimeout(resolve, 190);
      });
    });
  }

  async function finishPersonalPinDrag() {
    const drag = hubPersonalDrag;
    if (!drag) return;
    hubPersonalDrag = null;
    if (!drag.dragging) {
      cleanupPersonalPinDrag(drag);
      return;
    }

    suppressNextHubClick();
    await animatePersonalDrop(drag);
    const droppedCard = drag.card;
    if (drag.placeholder && drag.placeholder.isConnected) {
      drag.list.insertBefore(drag.card, drag.placeholder);
    }
    cleanupPersonalPinDrag(drag);
    triggerPersonalDropConfirm(droppedCard);
    await persistPersonalOrder(drag.list);
    resetSelection();
  }

  function handlePersonalPinPointerDown(event) {
    if (!hubContainer || event.button !== 0) return;
    if (event.target.closest("[data-pin-action], input, textarea, select, a")) return;

    const card = event.target.closest(".wo-command-card[data-personal-action]");
    if (!card || !hubContainer.contains(card)) return;

    const list = card.closest('[data-personal-list="true"]');
    if (!list || getPersonalCards(list).length < 2) return;

    hubPersonalDrag = {
      card,
      list,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };

    try {
      card.setPointerCapture(event.pointerId);
    } catch (error) {
      // Pointer capture is a quality-of-life improvement; dragging still works without it.
    }
  }

  function handlePersonalPinPointerMove(event) {
    const drag = hubPersonalDrag;
    if (!drag) {
      if (hubState.selectedIndex >= 0) {
        hubState.selectedIndex = -1;
        syncSelection();
      }
      return;
    }
    if (drag.pointerId !== event.pointerId) return;

    const point = getLatestPointerPoint(event);
    const distance = Math.hypot(point.clientX - drag.startX, point.clientY - drag.startY);
    if (!drag.dragging) {
      if (distance < PERSONAL_PIN_DRAG_DISTANCE) return;
      startPersonalDrag(drag, point);
    }

    if (event.cancelable) event.preventDefault();
    updatePersonalDragPosition(drag, point.clientX, point.clientY);
    movePersonalPlaceholder(drag, point.clientY);
  }

  function handlePersonalPinPointerUp(event) {
    const drag = hubPersonalDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    finishPersonalPinDrag().catch((error) => {
      console.warn("[WO Hub] Failed to save personal command order:", error);
    });
  }

  function handlePersonalPinPointerCancel(event) {
    const drag = hubPersonalDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    cancelPersonalPinDrag({ render: true });
  }

  function setHubVisibilityState(nextState) {
    hubVisibilityState = nextState;
    if (hubContainer) {
      hubContainer.dataset.woHubState = nextState;
    }
  }

  function setHostScrollLocked(locked) {
    const next = Boolean(locked);
    if (hubHostScrollLocked === next) return;
    hubHostScrollLocked = next;
    const method = next ? "add" : "remove";
    document.documentElement?.classList[method]("web-omni-command-hub-scroll-lock");
    document.body?.classList[method]("web-omni-command-hub-scroll-lock");
  }

  function clearHubCloseTimer() {
    if (!hubCloseTimer) return;
    clearTimeout(hubCloseTimer);
    hubCloseTimer = null;
  }

  function runHubVisibilityAnimation(show) {
    if (!hubContainer || !hubPanel) return;
    const duration = show ? HUB_MOTION.open : HUB_MOTION.close;
    const transitionId = ++hubTransitionId;

    if (hubContainer.style.display === "none" || !hubContainer.style.display) {
      hubContainer.style.display = "flex";
    }
    if (show) setHostScrollLocked(true);
    const overlayStyle = getComputedStyle(hubContainer);
    const panelStyle = getComputedStyle(hubPanel);
    const overlayStart = overlayStyle.opacity || (show ? "0" : "1");
    const startsClosed = hubVisibilityState === "closed";
    const panelStart = {
      opacity: panelStyle.opacity || (show ? "0" : "1"),
      transform: panelStyle.transform === "none" ? "translate3d(0, 0, 0) scale(1)" : panelStyle.transform,
      filter: panelStyle.filter === "none"
        ? (show && startsClosed ? "blur(1.2px)" : "blur(0px)")
        : panelStyle.filter,
    };

    if (hubVisibilityAnimation) {
      hubVisibilityAnimation.animations.forEach((animation) => {
        animation.onfinish = null;
        animation.cancel();
      });
      hubVisibilityAnimation = null;
    }

    if (prefersReducedHubMotion() || typeof hubPanel.animate !== "function") {
      setHubVisibilityState(show ? "open" : "closed");
      hubContainer.style.removeProperty("opacity");
      hubPanel.style.removeProperty("opacity");
      hubPanel.style.removeProperty("transform");
      hubPanel.style.removeProperty("filter");
      if (!show) {
        hubContainer.style.display = "none";
        setHostScrollLocked(false);
      }
      return;
    }

    setHubVisibilityState(show ? "opening" : "closing");
    hubContainer.style.willChange = "opacity";
    hubPanel.style.willChange = "transform, opacity, filter";
    const overlay = hubContainer.animate([
      { opacity: overlayStart },
      { opacity: show ? 1 : 0 },
    ], { duration, easing: HUB_MOTION.easing, fill: "both" });
    const panel = hubPanel.animate([
      panelStart,
      show
        ? { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)", filter: "blur(0px)" }
        : { opacity: 0, transform: "translate3d(0, 8px, 0) scale(.988)", filter: "blur(1.2px)" },
    ], { duration, easing: HUB_MOTION.easing, fill: "both" });
    const record = { target: show ? "open" : "closed", animations: [overlay, panel], transitionId };
    hubVisibilityAnimation = record;

    const finish = () => {
      setTimeout(() => {
        if (hubVisibilityAnimation !== record || transitionId !== hubTransitionId) return;
        if (!record.animations.every((animation) => animation.playState === "finished")) return;
        setHubVisibilityState(show ? "open" : "closed");
        record.animations.forEach((animation) => {
          animation.onfinish = null;
          animation.cancel();
        });
        hubContainer.style.removeProperty("will-change");
        hubPanel.style.removeProperty("will-change");
        hubContainer.style.removeProperty("opacity");
        hubPanel.style.removeProperty("opacity");
        hubPanel.style.removeProperty("transform");
        hubPanel.style.removeProperty("filter");
        if (!show) {
          hubContainer.style.display = "none";
          setHostScrollLocked(false);
        }
        hubVisibilityAnimation = null;
      }, 0);
    };
    overlay.onfinish = finish;
    panel.onfinish = finish;
  }

  function getCommandHubStatus() {
    return {
      ok: true,
      open: hubVisibilityState === "opening" || hubVisibilityState === "open",
      state: hubVisibilityState,
      ready: Boolean(hubContainer && hubContainer.isConnected),
    };
  }

  function waitForDocumentBody(timeoutMs = 10000) {
    if (document.body) return Promise.resolve(document.body);
    return new Promise((resolve, reject) => {
      let observer = null;
      let timer = null;
      const finish = (body, error) => {
        if (observer) observer.disconnect();
        if (timer) clearTimeout(timer);
        document.removeEventListener("DOMContentLoaded", check);
        if (body) resolve(body);
        else reject(error || new Error("Document body is unavailable"));
      };
      const check = () => {
        if (document.body) finish(document.body);
      };
      document.addEventListener("DOMContentLoaded", check, { once: true });
      if (document.documentElement) {
        observer = new MutationObserver(check);
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
      timer = setTimeout(() => finish(null, new Error("Timed out waiting for document.body")), timeoutMs);
    });
  }

  function resetHubDomReferences() {
    cancelSearchRender();
    cancelHubContentAnimations();
    if (hubVisibilityAnimation) {
      hubVisibilityAnimation.animations.forEach((animation) => {
        animation.onfinish = null;
        animation.cancel();
      });
      hubVisibilityAnimation = null;
    }
    if (hubContainer) hubContainer.style.removeProperty("will-change");
    if (hubPanel) hubPanel.style.removeProperty("will-change");
    setHostScrollLocked(false);
    hubContainer = null;
    hubPanel = null;
    hubInput = null;
    hubBody = null;
    hubBrowseButton = null;
    hubVisibilityState = "closed";
  }

  function ensureCommandHubReady() {
    if (
      hubContainer && hubContainer.isConnected &&
      hubPanel && hubPanel.isConnected &&
      hubBody && hubBody.isConnected &&
      hubInput && hubInput.isConnected
    ) {
      return Promise.resolve(true);
    }
    if (hubInitPromise) return hubInitPromise;

    hubInitPromise = waitForDocumentBody()
      .then(() => {
        const stale = document.getElementById("web-omni-command-hub-overlay");
        if (stale) stale.remove();
        resetHubDomReferences();
        if (!initCommandHub()) throw new Error("Command Hub initialization failed");
        return true;
      })
      .finally(() => {
        hubInitPromise = null;
      });
    return hubInitPromise;
  }

  function initCommandHub() {
    if (!document.body) return false;
    if (hubContainer && hubContainer.isConnected) return true;
    hubContainer = document.createElement("div");
    hubContainer.id = "web-omni-command-hub-overlay";
    hubContainer.dataset.woHubState = "closed";
    hubContainer.dataset.woSurface = "solid";
    hubContainer.innerHTML = `
      <div id="web-omni-command-hub">
        <div id="wo-command-header">
          <div class="wo-hub-brand" aria-label="Web-Omni Command Hub">
            <span class="wo-hub-mark" aria-hidden="true">WO</span>
            <span class="wo-hub-brand-copy"><strong>Command Hub</strong><small>Web-Omni</small></span>
          </div>
          <div id="wo-command-toolbar">
            <span class="wo-search-prompt" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
            </span>
            <input type="text" id="web-omni-command-input" placeholder="搜索功能、场景或关键词" autocomplete="off" spellcheck="false">
            <span class="wo-kbd-row"><kbd>Esc</kbd></span>
          </div>
          <button type="button" id="wo-active-toggle" class="wo-active-toggle" aria-pressed="false" title="当前没有活动功能">
            <span class="wo-active-dot" aria-hidden="true"></span><span>活动</span><strong data-active-count="true">0</strong>
          </button>
          <button type="button" class="wo-hub-close" data-hub-close="true" aria-label="关闭 Command Hub" title="关闭">×</button>
        </div>

        <div id="wo-command-body"><div class="wo-hub-view-stage" aria-live="polite"></div></div>

        <div id="web-omni-hub-footer">
          <span class="wo-foot-cell"><kbd>↑</kbd><kbd>↓</kbd><em>导航</em></span>
          <span class="wo-foot-cell"><kbd>↵</kbd><em>执行</em></span>
          <span class="wo-foot-cell"><kbd>Tab</kbd><em>切分类</em></span>
          <span class="wo-foot-cell wo-foot-cell-right">
            <button type="button" id="wo-browse-toggle" class="wo-foot-link">按分类浏览</button>
          </span>
        </div>
      </div>
    `;
    configureSolidSurface();

    document.body.appendChild(hubContainer);

    hubInput = document.getElementById("web-omni-command-input");
    hubPanel = document.getElementById("web-omni-command-hub");
    hubBody = document.getElementById("wo-command-body");
    hubBrowseButton = document.getElementById("wo-browse-toggle");

    hubContainer.addEventListener("pointerdown", () => {
      hubContainer.dataset.woFocusModality = "pointer";
    }, true);
    hubContainer.addEventListener("pointerdown", handlePersonalPinPointerDown);
    hubContainer.addEventListener("pointermove", handlePersonalPinPointerMove);
    hubContainer.addEventListener("pointerup", (event) => {
      handlePersonalPinPointerUp(event);
    });
    hubContainer.addEventListener("pointercancel", (event) => {
      handlePersonalPinPointerCancel(event);
    });

    hubContainer.addEventListener("click", async (event) => {
      if (hubSuppressNextClick) {
        hubSuppressNextClick = false;
        if (hubSuppressClickTimer) {
          clearTimeout(hubSuppressClickTimer);
          hubSuppressClickTimer = null;
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (event.target === hubContainer) {
        closeCommandHub();
        return;
      }

      if (event.target.closest("[data-hub-close]")) {
        closeCommandHub();
        return;
      }

      if (event.target.closest("#wo-active-toggle")) {
        openActivityMode();
        return;
      }

      const activeControl = event.target.closest("[data-active-control][data-active-action]");
      if (activeControl) {
        event.preventDefault();
        event.stopPropagation();
        await handleActiveActionControl(activeControl);
        return;
      }

      const pinButton = event.target.closest("[data-pin-action]");
      if (pinButton) {
        event.preventDefault();
        event.stopPropagation();
        await togglePin(pinButton.getAttribute("data-pin-action"));
        return;
      }

      const categoryButton = event.target.closest("[data-category-name]");
      if (categoryButton) {
        updateBrowseCategory(categoryButton.getAttribute("data-category-name"));
        return;
      }

      const browseToggle = event.target.closest("[data-browse-toggle]");
      if (browseToggle) {
        openBrowseMode();
        return;
      }

      const homeToggle = event.target.closest("[data-home-toggle]");
      if (homeToggle) {
        openHomeMode();
        return;
      }

      const actionCard = event.target.closest("[data-action-trigger]");
      if (actionCard) {
        await handleAction(actionCard.getAttribute("data-action-trigger"));
      }
    });

    hubContainer.addEventListener("keydown", (event) => {
      hubContainer.dataset.woFocusModality = "keyboard";
      const categoryButton = event.target.closest && event.target.closest(".wo-category-tab[data-category-name]");
      if (!categoryButton) return;
      const buttons = Array.from(categoryButton.parentElement.querySelectorAll(".wo-category-tab[data-category-name]"));
      const currentIndex = buttons.indexOf(categoryButton);
      let nextIndex = currentIndex;
      if (["ArrowRight", "ArrowDown"].includes(event.key)) nextIndex = (currentIndex + 1) % buttons.length;
      else if (["ArrowLeft", "ArrowUp"].includes(event.key)) nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = buttons.length - 1;
      else return;
      event.preventDefault();
      const target = buttons[nextIndex];
      updateBrowseCategory(target.getAttribute("data-category-name"));
      target.focus({ preventScroll: true });
    });

    hubBrowseButton.addEventListener("click", () => {
      if (hubState.query) {
        if (hubState.viewMode === "home") openHomeMode();
        else if (hubState.viewMode === "activity") openActivityMode();
        else openBrowseMode();
        return;
      }

      if (["browse", "activity"].includes(hubState.viewMode)) {
        openHomeMode();
      } else {
        openBrowseMode();
      }
    });

    hubInput.addEventListener("input", (event) => {
      scheduleSearchRender(event.target.value);
    });

    hubInput.addEventListener("keydown", async (event) => {
      if (hubSearchFrame && ["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key)) {
        flushSearchRender();
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveSelection(1);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveSelection(-1);
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        const items = getVisibleNavItems();
        const target = hubState.selectedIndex >= 0 ? items[hubState.selectedIndex] : items[0];
        if (target) {
          await handleAction(target.getAttribute("data-action-trigger"));
        }
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        closeCommandHub();
        return;
      }

      if (event.key === "Tab") {
        event.preventDefault();
        handleTabShortcut();
      }
    });

    const storeReady = hubState.storeLoaded ? Promise.resolve() : loadHubStore();
    storeReady.then(() => {
      if (hubContainer && hubContainer.style.display === "flex") {
        renderHub();
      }
    });
    attachActionStateRuntime();
    return true;
  }

  async function openCommandHub() {
    await ensureCommandHubReady();
    if (["open", "opening"].includes(hubVisibilityState)) return getCommandHubStatus();
    clearHubCloseTimer();
    cancelSearchRender();
    cancelHubContentAnimations();
    cancelPersonalPinDrag({ render: false });
    hubState.currentContexts = detectPageContexts();
    hubState.viewMode = "home";
    hubState.activeCategory = getPreferredBrowseCategory();
    hubState.query = "";
    hubPendingQuery = "";

    if (hubInput) {
      hubInput.value = "";
    }

    renderHub({ immediate: true });
    runHubVisibilityAnimation(true);
    requestActiveActions().catch(() => {});

    if (hubInput) {
      hubContainer.dataset.woFocusModality = "programmatic";
      hubInput.focus({ preventScroll: true });
    }
    return getCommandHubStatus();
  }

  function closeCommandHub() {
    if (!hubContainer || hubVisibilityState === "closed" || hubVisibilityState === "closing") {
      return getCommandHubStatus();
    }
    clearHubCloseTimer();
    cancelSearchRender();
    cancelHubContentAnimations();
    cancelPersonalPinDrag({ render: false });
    runHubVisibilityAnimation(false);
    return getCommandHubStatus();
  }

  async function toggleCommandHub() {
    if (!hubContainer || !hubContainer.isConnected || hubVisibilityState === "closed" || hubVisibilityState === "closing") {
      return openCommandHub();
    }
    return closeCommandHub();
  }

  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      toggleCommandHub().catch((error) => {
        console.warn("[WO Hub] Keyboard toggle failed:", error);
      });
    }
  });

  async function checkFirstRun() {
    const data = await chrome.storage.local.get([STORAGE_KEYS.firstRun, STORAGE_KEYS.agreed]);
    if (data[STORAGE_KEYS.firstRun] && !data[STORAGE_KEYS.agreed]) {
      showWelcomePopup();
    }
  }

  function showWelcomePopup() {
    const overlay = document.createElement("div");
    overlay.id = "wo-welcome-overlay";
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(1,4,9,0.88);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

    overlay.innerHTML = '<div style="background:#161b22;border:1px solid #30363d;border-radius:10px;width:520px;max-height:85vh;overflow-y:auto;color:#e6edf3;box-shadow:0 16px 48px rgba(0,0,0,0.5);">'
      + '<div style="padding:24px 24px 16px;border-bottom:1px solid #21262d;">'
      + '<h2 style="font-size:20px;font-weight:700;margin:0 0 4px;">Web-Omni vNext</h2>'
      + '<p style="font-size:13px;color:#8b949e;margin:0;">统一风格的网页效率中枢</p></div>'
      + '<div style="padding:20px 24px;">'
      + '<h3 style="font-size:14px;font-weight:600;margin:0 0 10px;color:#f0f6fc;">快速入门</h3>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:18px;">'
      + '<div style="background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:10px;"><div style="font-size:12px;font-weight:600;margin-bottom:3px;">Ctrl+Shift+K</div><div style="font-size:11px;color:#8b949e;">打开指令中枢</div></div>'
      + '<div style="background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:10px;"><div style="font-size:12px;font-weight:600;margin-bottom:3px;">Alt+S</div><div style="font-size:11px;color:#8b949e;">一键清除悬浮膏药</div></div>'
      + '<div style="background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:10px;"><div style="font-size:12px;font-weight:600;margin-bottom:3px;">右键菜单</div><div style="font-size:11px;color:#8b949e;">右键打开 Web-Omni 子菜单</div></div>'
      + '<div style="background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:10px;"><div style="font-size:12px;font-weight:600;margin-bottom:3px;">工具栏图标</div><div style="font-size:11px;color:#8b949e;">点击图标打开主页</div></div>'
      + '</div>'
      + '<h3 style="font-size:14px;font-weight:600;margin:0 0 8px;color:#f0f6fc;">核心功能</h3>'
      + '<div style="font-size:12px;color:#c9d1d9;line-height:1.8;margin-bottom:16px;">'
      + '<div style="display:flex;gap:6px;margin-bottom:3px;"><span style="color:#58a6ff;min-width:60px;">视觉掌控</span><span>元素消除、暗黑模式、膏药清理、阅读器模式</span></div>'
      + '<div style="display:flex;gap:6px;margin-bottom:3px;"><span style="color:#3fb950;min-width:60px;">数据收割</span><span>图片视频嗅探、电商批量取图、框选提取</span></div>'
      + '<div style="display:flex;gap:6px;margin-bottom:3px;"><span style="color:#f97316;min-width:60px;">效率工具</span><span>输入框保护、音频均衡、画中画、链接净化</span></div>'
      + '<div style="display:flex;gap:6px;margin-bottom:3px;"><span style="color:#a78bfa;min-width:60px;">安全隐私</span><span>密码管理、隐私评分、指纹防护、DOM监控</span></div>'
      + '<div style="display:flex;gap:6px;"><span style="color:#6366f1;min-width:60px;">文件传输</span><span>局域网扫码传文件、桌面与手机互传</span></div>'
      + '</div>'
      + '<h3 style="font-size:14px;font-weight:600;margin:0 0 8px;color:#f0f6fc;">隐私协议</h3>'
      + '<div style="background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:12px;font-size:11px;color:#8b949e;line-height:1.7;max-height:140px;overflow-y:auto;margin-bottom:16px;">'
      + '<p style="margin:0 0 6px;"><strong style="color:#c9d1d9;">数据存储</strong>：所有数据仅存储在本地浏览器的 chrome.storage.local 中，不会上传到任何服务器。</p>'
      + '<p style="margin:0 0 6px;"><strong style="color:#c9d1d9;">网络通信</strong>：局域网传输使用 WebRTC P2P 直连，PeerJS 信令仅用于建连，不传输文件内容。</p>'
      + '<p style="margin:0 0 6px;"><strong style="color:#c9d1d9;">密码安全</strong>：密码管理器使用 AES-256-GCM 加密与 PBKDF2 派生密钥，主密码永不存储。</p>'
      + '<p style="margin:0 0 6px;"><strong style="color:#c9d1d9;">权限说明</strong>：本扩展申请 &lt;all_urls&gt;、storage、downloads、alarms、notifications 等权限，以完成网页增强、下载和本地提醒。</p>'
      + '<p style="margin:0;"><strong style="color:#c9d1d9;">开源透明</strong>：所有代码逻辑均可在扩展源文件中直接查看审计，不包含混淆或远程执行代码。</p>'
      + '</div>'
      + '</div>'
      + '<div style="padding:16px 24px;border-top:1px solid #21262d;display:flex;justify-content:space-between;align-items:center;">'
      + '<span style="font-size:11px;color:#484f58;">继续即表示你已阅读并同意以上隐私协议</span>'
      + '<button id="wo-agree-btn" style="padding:8px 24px;background:#238636;border:1px solid #2ea043;color:#fff;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">同意并开始使用</button>'
      + '</div></div>';

    document.body.appendChild(overlay);

    document.getElementById("wo-agree-btn").addEventListener("click", async () => {
      await chrome.storage.local.set({
        [STORAGE_KEYS.agreed]: true,
        [STORAGE_KEYS.firstRun]: false,
      });
      overlay.style.opacity = "0";
      overlay.style.transition = "opacity 0.3s";
      setTimeout(() => overlay.remove(), 300);
    });
  }

  window.webOmniCommandHubController = {
    ensureReady: ensureCommandHubReady,
    open: openCommandHub,
    close: closeCommandHub,
    toggle: toggleCommandHub,
    getStatus: getCommandHubStatus,
  };

  setTimeout(checkFirstRun, 1500);
})();
