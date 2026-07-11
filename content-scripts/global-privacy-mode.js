(function () {
  "use strict";

  if (globalThis.webOmniGlobalPrivacyModeInjected || globalThis.webOmniGlobalPrivacyInjected) return;
  globalThis.webOmniGlobalPrivacyModeInjected = true;
  globalThis.webOmniGlobalPrivacyInjected = true;

  const ACTION = "GLOBAL_PRIVACY_MODE";
  const HIDDEN_CLASS = "web-omni-global-privacy-ad-hidden-v1";
  const STYLE_ID = "web-omni-global-privacy-style";
  const SHIELD_ID = "web-omni-global-privacy-shield";
  const REFERRER_META_ID = "web-omni-global-privacy-referrer";
  const CUSTOM_RULE_LIMIT = 32;
  const CUSTOM_SELECTOR_LIMIT = 240;
  const MAIN_FEATURES = Object.freeze([
    Object.freeze({ key: "blockTrackers", action: "PRIVACY_BLOCK_TRACKERS" }),
    Object.freeze({ key: "fingerprintProtection", action: "PRIVACY_FINGERPRINT_PROTECT" }),
    Object.freeze({ key: "webrtcProtection", action: "PRIVACY_WEBRTC_PROTECT" }),
  ]);
  const BOOLEAN_OPTIONS = Object.freeze([
    "blockTrackers",
    "fingerprintProtection",
    "webrtcProtection",
    "stripReferrer",
    "pageShield",
    "adBlocking",
    "youtubeCompatibility",
  ]);
  const PROTECTION_OPTIONS = Object.freeze([
    "blockTrackers",
    "fingerprintProtection",
    "webrtcProtection",
    "stripReferrer",
    "pageShield",
    "adBlocking",
  ]);
  const DEFAULT_OPTIONS = Object.freeze({
    blockTrackers: true,
    fingerprintProtection: true,
    webrtcProtection: false,
    stripReferrer: true,
    pageShield: false,
    adBlocking: true,
    youtubeCompatibility: true,
    customAdSelectors: Object.freeze([]),
  });
  const BUILTIN_AD_SELECTORS = Object.freeze([
    "ins.adsbygoogle",
    "amp-ad",
    "iframe[src*='doubleclick.net' i]",
    "iframe[src*='googlesyndication.com' i]",
    "iframe[src*='googleadservices.com' i]",
    "iframe[src*='amazon-adsystem.com' i]",
    "iframe[title='3rd party ad content' i]",
    "[id^='google_ads_']",
    "[id^='div-gpt-ad-']",
    "[data-ad-slot]:not([data-ad-slot=''])",
    "[data-ad-unit]",
    "[data-ad-container='true']",
    "[data-advertisement]",
    "[aria-label='Advertisement' i]",
    "[aria-label='广告']",
    "[data-testid='ad-container']",
  ]);
  const BUILTIN_DOMAIN_AD_RULES = Object.freeze([
    Object.freeze({
      domain: "*.youtube.com",
      selectors: Object.freeze([
        "#player-ads",
        "ytd-ad-slot-renderer",
        "ytd-display-ad-renderer",
        "ytd-promoted-video-renderer",
        "ytd-in-feed-ad-layout-renderer",
      ]),
    }),
    Object.freeze({
      domain: "*.google.com",
      selectors: Object.freeze([
        "#tads",
        "#bottomads",
        "[data-text-ad]",
      ]),
    }),
    Object.freeze({
      domain: "*.bing.com",
      selectors: Object.freeze([
        "#b_results > li.b_ad",
        "#b_context > li.b_ad",
      ]),
    }),
    Object.freeze({
      domain: "*.reddit.com",
      selectors: Object.freeze([
        "shreddit-ad-post",
        "[data-testid='promoted-post']",
        "[data-promoted='true']",
      ]),
    }),
    Object.freeze({
      domain: "*.amazon.com",
      selectors: Object.freeze([
        "[data-component-type='s-sponsored-result']",
        "[data-ad-marker]",
      ]),
    }),
    Object.freeze({
      domain: "*.baidu.com",
      selectors: Object.freeze([
        "[data-tuiguang]",
      ]),
    }),
    Object.freeze({
      domain: "*.duckduckgo.com",
      selectors: Object.freeze([
        ".results--ads",
        ".result--ad",
      ]),
    }),
  ]);
  const EXTENSION_SELECTOR = [
    "#web-omni-command-hub-overlay",
    "#web-omni-action-dock",
    "#web-omni-toast-container",
    "#web-omni-global-privacy-shield",
    "[data-wo-command-surface]",
    "[data-wo-surface]",
    "[data-web-omni-extension-ui]",
    "[id^='web-omni-']",
    "[id^='wo-']",
    "[class^='wo-']",
    "[class*=' wo-']",
  ].join(",");

  let active = false;
  let options = cloneOptions(DEFAULT_OPTIONS);
  let revision = 0;
  let lastRequestRevision = -1;
  let updatedAt = Date.now();
  let lastErrors = [];
  let operationQueue = Promise.resolve();
  let observer = null;
  let scanFrame = 0;
  let pendingRoots = new Set();
  let adStyle = null;
  let activeAdSelector = "";
  let shield = null;
  let shieldListenersInstalled = false;
  let referrerMetaRecord = null;

  const hiddenAdNodes = new Set();
  const changedLinks = new Map();
  const mainOwnership = new Map(MAIN_FEATURES.map((feature) => [feature.key, false]));
  const mainEnabled = new Map(MAIN_FEATURES.map((feature) => [feature.key, false]));

  function isPlainObject(value) {
    if (!value || typeof value !== "object") return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function cloneRule(rule) {
    return { domain: rule.domain, selector: rule.selector };
  }

  function cloneOptions(value) {
    const source = value && typeof value === "object" ? value : DEFAULT_OPTIONS;
    return {
      blockTrackers: Boolean(source.blockTrackers),
      fingerprintProtection: Boolean(source.fingerprintProtection),
      webrtcProtection: Boolean(source.webrtcProtection),
      stripReferrer: Boolean(source.stripReferrer),
      pageShield: Boolean(source.pageShield),
      adBlocking: Boolean(source.adBlocking),
      youtubeCompatibility: source.youtubeCompatibility === undefined
        ? true
        : Boolean(source.youtubeCompatibility),
      customAdSelectors: Array.isArray(source.customAdSelectors)
        ? source.customAdSelectors.map(cloneRule)
        : [],
    };
  }

  function currentHostname() {
    return String(location.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  }

  function isYouTubePage() {
    const hostname = currentHostname();
    return hostname === "youtube.com"
      || hostname.endsWith(".youtube.com")
      || hostname === "youtu.be"
      || hostname === "youtube-nocookie.com"
      || hostname.endsWith(".youtube-nocookie.com");
  }

  function isCompatibilitySuppressed(key) {
    return Boolean(options.youtubeCompatibility)
      && isYouTubePage()
      && (key === "blockTrackers" || key === "adBlocking");
  }

  function isEffectiveOptionEnabled(key) {
    return Boolean(options[key]) && !isCompatibilitySuppressed(key);
  }

  function normalizeDomain(value) {
    const fallback = currentHostname();
    const domain = String(value || fallback).trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!domain || domain.length > 253) {
      throw new TypeError("Custom ad rules require a valid domain.");
    }
    if (domain === "*") return domain;
    if (domain.includes(":") && /^[0-9a-f:]+$/.test(domain)) return domain;
    if (/[:/\\\s]/.test(domain) || domain.includes("..")) {
      throw new TypeError(`Invalid custom ad rule domain: ${domain}`);
    }
    const base = domain.startsWith("*.") ? domain.slice(2) : domain;
    if (!base || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(base)) {
      throw new TypeError(`Invalid custom ad rule domain: ${domain}`);
    }
    for (const label of base.split(".")) {
      if (!label || label.length > 63 || label.startsWith("-") || label.endsWith("-")) {
        throw new TypeError(`Invalid custom ad rule domain: ${domain}`);
      }
    }
    return domain;
  }

  function validateCustomSelector(value) {
    if (value instanceof RegExp || typeof value !== "string") {
      throw new TypeError("Custom ad selectors must be CSS selector strings.");
    }
    const selector = value.trim();
    if (!selector || selector.length > CUSTOM_SELECTOR_LIMIT) {
      throw new TypeError(`Custom ad selectors must contain 1-${CUSTOM_SELECTOR_LIMIT} characters.`);
    }
    if (/[\u0000-\u001f\u007f]/.test(selector)
      || /javascript\s*:/i.test(selector)
      || /^\/.+\/[dgimsuvy]*$/.test(selector)
      || selector.includes(",")
      || selector.includes(":")
      || selector.includes("*")) {
      throw new TypeError(`Unsupported custom ad selector: ${selector}`);
    }
    if (!/[.#\[]/.test(selector)
      || /(?:^|[\s>+~])(?:html|body)(?:$|[\s>+~.#\[])/i.test(selector)
      || /(?:web-omni|#wo-|\.wo-|data-wo-)/i.test(selector)) {
      throw new TypeError(`Custom ad selector is too broad or targets extension UI: ${selector}`);
    }
    const combinators = selector.match(/[>+~]|\s+/g);
    if (combinators && combinators.length > 8) {
      throw new TypeError(`Custom ad selector is too complex: ${selector}`);
    }
    try {
      document.querySelector(selector);
    } catch (_) {
      throw new TypeError(`Invalid CSS selector: ${selector}`);
    }
    return selector;
  }

  function normalizeCustomRules(value) {
    if (value === undefined) return null;
    if (!Array.isArray(value)) {
      throw new TypeError("customAdSelectors must be an array.");
    }
    if (value.length > CUSTOM_RULE_LIMIT) {
      throw new TypeError(`customAdSelectors accepts at most ${CUSTOM_RULE_LIMIT} rules.`);
    }
    const rules = [];
    const seen = new Set();
    for (const item of value) {
      if (typeof item === "string") {
        const rule = { domain: "*", selector: validateCustomSelector(item) };
        const key = `${rule.domain}\n${rule.selector}`;
        if (!seen.has(key)) {
          seen.add(key);
          rules.push(rule);
        }
        continue;
      }
      if (isPlainObject(item) && item.enabled === false) continue;
      if (!isPlainObject(item)) {
        throw new TypeError("Each custom ad rule must be a selector string or a domain rule object.");
      }
      if (typeof item.selector !== "string") {
        throw new TypeError("Each custom ad rule requires a CSS selector string.");
      }
      const domainValues = Array.isArray(item.domains)
        ? item.domains
        : [item.domain || item.hostname || currentHostname()];
      if (!domainValues.length) {
        throw new TypeError("Each custom ad rule requires at least one domain.");
      }
      for (const domainValue of domainValues) {
        const rule = {
          domain: normalizeDomain(domainValue),
          selector: validateCustomSelector(item.selector),
        };
        const key = `${rule.domain}\n${rule.selector}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rules.push(rule);
        if (rules.length > CUSTOM_RULE_LIMIT) {
          throw new TypeError(`customAdSelectors accepts at most ${CUSTOM_RULE_LIMIT} rules.`);
        }
      }
    }
    return rules;
  }

  function normalizeOptions(value, base) {
    const source = isPlainObject(value) ? value : {};
    const fallback = base || DEFAULT_OPTIONS;
    const customRules = normalizeCustomRules(source.customAdSelectors);
    const next = {
      customAdSelectors: customRules === null
        ? (Array.isArray(fallback.customAdSelectors) ? fallback.customAdSelectors.map(cloneRule) : [])
        : customRules,
    };
    for (const key of BOOLEAN_OPTIONS) {
      next[key] = source[key] === undefined ? Boolean(fallback[key]) : source[key] === true;
    }
    return next;
  }

  function matchesDomain(hostname, pattern) {
    if (!hostname || !pattern) return false;
    if (pattern === "*") return true;
    if (pattern.startsWith("*.")) {
      const base = pattern.slice(2);
      return hostname === base || hostname.endsWith(`.${base}`);
    }
    return hostname === pattern;
  }

  function customSelectorsForPage(value) {
    const hostname = currentHostname();
    return value.customAdSelectors
      .filter((rule) => matchesDomain(hostname, rule.domain))
      .map((rule) => rule.selector);
  }

  function builtinSelectorsForPage() {
    const hostname = currentHostname();
    const selectors = [...BUILTIN_AD_SELECTORS];
    for (const rule of BUILTIN_DOMAIN_AD_RULES) {
      if (matchesDomain(hostname, rule.domain)) selectors.push(...rule.selectors);
    }
    return selectors;
  }

  function hasWebOmniDataAttribute(element) {
    if (!(element instanceof Element)) return false;
    for (const attribute of element.attributes) {
      if (attribute.name.startsWith("data-wo-") || attribute.name.startsWith("data-web-omni-")) {
        return true;
      }
    }
    return false;
  }

  function isInsideExtensionUi(element) {
    let current = element instanceof Element ? element : null;
    while (current) {
      if (current.matches(EXTENSION_SELECTOR) || hasWebOmniDataAttribute(current)) return true;
      current = current.parentElement;
    }
    return false;
  }

  function containsExtensionUi(element) {
    if (!(element instanceof Element)) return false;
    if (element.querySelector(EXTENSION_SELECTOR)) return true;
    const knownRoots = [
      document.getElementById("web-omni-command-hub-overlay"),
      document.getElementById("web-omni-action-dock"),
      document.getElementById("web-omni-toast-container"),
    ];
    return knownRoots.some((root) => root && root !== element && element.contains(root));
  }

  function runMainWorldAction(action, payload) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const timeout = setTimeout(() => finish({
        ok: false,
        action,
        status: "failed",
        error: { code: "ACTION_FAILED", message: `${action} timed out.` },
      }), 6000);
      try {
        chrome.runtime.sendMessage({
          type: "WO_RUN_MAIN_WORLD",
          action,
          payload: payload || {},
          suppressActivity: true,
        }, (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            finish({
              ok: false,
              action,
              status: "failed",
              error: { code: "MODULE_LOAD_FAILED", message: runtimeError.message },
            });
            return;
          }
          const result = response && response.result ? response.result : response;
          finish(result && typeof result.ok === "boolean" ? result : {
            ok: false,
            action,
            status: "failed",
            error: { code: "MODULE_LOAD_FAILED", message: "MAIN world bridge returned no result." },
          });
        });
      } catch (error) {
        finish({
          ok: false,
          action,
          status: "failed",
          error: { code: "MODULE_LOAD_FAILED", message: error && error.message ? error.message : String(error) },
        });
      }
    });
  }

  function resultEnabled(result) {
    if (!(result && result.ok && result.data)) return false;
    return typeof result.data.consumerEnabled === "boolean"
      ? result.data.consumerEnabled
      : Boolean(result.data.enabled);
  }

  function resultError(feature, result) {
    const error = result && result.error ? result.error : {};
    return {
      feature: feature.key,
      code: String(error.code || "ACTION_FAILED"),
      message: String(error.message || `${feature.action} failed.`),
    };
  }

  async function enableMainFeature(feature) {
    const status = await runMainWorldAction(feature.action, { mode: "status", consumer: ACTION });
    if (resultEnabled(status)) {
      mainEnabled.set(feature.key, true);
      mainOwnership.set(feature.key, true);
      return null;
    }
    if (!status.ok) {
      mainEnabled.set(feature.key, false);
      return resultError(feature, status);
    }
    const result = await runMainWorldAction(feature.action, { mode: "enable", consumer: ACTION });
    const enabled = resultEnabled(result);
    mainEnabled.set(feature.key, enabled);
    if (enabled) mainOwnership.set(feature.key, true);
    return result.ok && enabled ? null : resultError(feature, result);
  }

  async function disableMainFeature(feature) {
    if (!mainOwnership.get(feature.key)) {
      mainEnabled.set(feature.key, false);
      return null;
    }
    const result = await runMainWorldAction(feature.action, { mode: "disable", consumer: ACTION });
    if (result.ok && !resultEnabled(result)) {
      mainOwnership.set(feature.key, false);
      mainEnabled.set(feature.key, false);
      return null;
    }
    const status = await runMainWorldAction(feature.action, { mode: "status", consumer: ACTION });
    const enabled = resultEnabled(status);
    mainEnabled.set(feature.key, enabled);
    if (!enabled && status.ok) mainOwnership.set(feature.key, false);
    return enabled || !status.ok ? resultError(feature, result.ok ? status : result) : null;
  }

  function ensureAdStyle() {
    if (adStyle && adStyle.isConnected) return adStyle;
    const existing = document.getElementById(STYLE_ID);
    if (existing) {
      adStyle = existing;
      return adStyle;
    }
    adStyle = document.createElement("style");
    adStyle.id = STYLE_ID;
    adStyle.textContent = `.${HIDDEN_CLASS}{display:none!important;visibility:hidden!important;}`;
    (document.head || document.documentElement).appendChild(adStyle);
    return adStyle;
  }

  function canHideAdNode(node) {
    return node instanceof Element
      && !isInsideExtensionUi(node)
      && !containsExtensionUi(node)
      && node !== document.documentElement
      && node !== document.body;
  }

  function hideAdNode(node) {
    if (!canHideAdNode(node) || node.classList.contains(HIDDEN_CLASS)) return;
    node.classList.add(HIDDEN_CLASS);
    hiddenAdNodes.add(node);
  }

  function scanAds(root) {
    if (!active || !isEffectiveOptionEnabled("adBlocking") || !activeAdSelector || !root) return;
    ensureAdStyle();
    if (root instanceof Element && root.matches(activeAdSelector)) hideAdNode(root);
    if (typeof root.querySelectorAll === "function") {
      for (const node of root.querySelectorAll(activeAdSelector)) hideAdNode(node);
    }
  }

  function restoreAds() {
    for (const node of hiddenAdNodes) {
      try {
        node.classList.remove(HIDDEN_CLASS);
      } catch (_) {}
    }
    hiddenAdNodes.clear();
    if (adStyle && adStyle.isConnected) adStyle.remove();
    adStyle = null;
    activeAdSelector = "";
  }

  function addNoReferrer(link) {
    if (!(link instanceof HTMLAnchorElement) || isInsideExtensionUi(link)) return;
    const tokens = String(link.getAttribute("rel") || "").split(/\s+/).filter(Boolean);
    if (tokens.some((token) => token.toLowerCase() === "noreferrer")) return;
    changedLinks.set(link, { hadAttribute: link.hasAttribute("rel") });
    try {
      link.relList.add("noreferrer");
    } catch (_) {
      link.setAttribute("rel", [...tokens, "noreferrer"].join(" "));
    }
  }

  function scanReferrerLinks(root) {
    if (!active || !options.stripReferrer || !root) return;
    if (root instanceof HTMLAnchorElement) addNoReferrer(root);
    if (typeof root.querySelectorAll === "function") {
      for (const link of root.querySelectorAll("a[href]")) addNoReferrer(link);
    }
  }

  function enableReferrerProtection() {
    if (!referrerMetaRecord) {
      let meta = document.querySelector("meta[name='referrer' i]");
      const created = !meta;
      if (!meta) {
        meta = document.createElement("meta");
        meta.id = REFERRER_META_ID;
        meta.setAttribute("name", "referrer");
        (document.head || document.documentElement).appendChild(meta);
      }
      referrerMetaRecord = {
        node: meta,
        created,
        hadContent: meta.hasAttribute("content"),
        content: meta.getAttribute("content"),
      };
    }
    referrerMetaRecord.node.setAttribute("content", "no-referrer");
    scanReferrerLinks(document);
  }

  function restoreReferrerProtection() {
    for (const [link, record] of changedLinks) {
      try {
        const tokens = String(link.getAttribute("rel") || "")
          .split(/\s+/)
          .filter((token) => token && token.toLowerCase() !== "noreferrer");
        if (tokens.length) link.setAttribute("rel", tokens.join(" "));
        else if (record.hadAttribute) link.setAttribute("rel", "");
        else link.removeAttribute("rel");
      } catch (_) {}
    }
    changedLinks.clear();
    if (referrerMetaRecord) {
      const record = referrerMetaRecord;
      try {
        if (record.created) {
          record.node.remove();
        } else if (record.node.getAttribute("content") === "no-referrer") {
          if (record.hadContent) record.node.setAttribute("content", record.content || "");
          else record.node.removeAttribute("content");
        }
      } catch (_) {}
    }
    referrerMetaRecord = null;
  }

  function ensureShield() {
    if (shield && shield.isConnected) return shield;
    shield = document.getElementById(SHIELD_ID);
    if (shield) return shield;
    shield = document.createElement("div");
    shield.id = SHIELD_ID;
    shield.setAttribute("aria-hidden", "true");
    Object.assign(shield.style, {
      position: "fixed",
      inset: "0",
      display: "none",
      background: "#0f1012",
      zIndex: "2147483000",
      pointerEvents: "none",
    });
    document.documentElement.appendChild(shield);
    return shield;
  }

  function updateShieldVisibility() {
    if (!active || !options.pageShield) {
      if (shield) shield.style.display = "none";
      return;
    }
    const element = ensureShield();
    element.style.display = document.hidden || !document.hasFocus() ? "block" : "none";
  }

  function installShieldListeners() {
    if (shieldListenersInstalled) return;
    shieldListenersInstalled = true;
    document.addEventListener("visibilitychange", updateShieldVisibility, true);
    globalThis.addEventListener("blur", updateShieldVisibility, true);
    globalThis.addEventListener("focus", updateShieldVisibility, true);
    globalThis.addEventListener("pageshow", updateShieldVisibility, true);
    updateShieldVisibility();
  }

  function removeShield() {
    if (shieldListenersInstalled) {
      document.removeEventListener("visibilitychange", updateShieldVisibility, true);
      globalThis.removeEventListener("blur", updateShieldVisibility, true);
      globalThis.removeEventListener("focus", updateShieldVisibility, true);
      globalThis.removeEventListener("pageshow", updateShieldVisibility, true);
      shieldListenersInstalled = false;
    }
    if (shield && shield.isConnected) shield.remove();
    shield = null;
  }

  function processPendingRoots() {
    scanFrame = 0;
    const roots = pendingRoots;
    pendingRoots = new Set();
    for (const root of roots) {
      if (!(root instanceof Element) || !root.isConnected || isInsideExtensionUi(root)) continue;
      if (options.stripReferrer) scanReferrerLinks(root);
      if (isEffectiveOptionEnabled("adBlocking")) scanAds(root);
    }
  }

  function scheduleRoot(root) {
    if (!(root instanceof Element) || isInsideExtensionUi(root)) return;
    pendingRoots.add(root);
    if (pendingRoots.size > 120) {
      pendingRoots.clear();
      if (document.documentElement) pendingRoots.add(document.documentElement);
    }
    if (!scanFrame) scanFrame = requestAnimationFrame(processPendingRoots);
  }

  function startObserver() {
    if (observer || (!isEffectiveOptionEnabled("adBlocking") && !options.stripReferrer) || !document.documentElement) return;
    observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) scheduleRoot(node);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) observer.disconnect();
    observer = null;
    if (scanFrame) cancelAnimationFrame(scanFrame);
    scanFrame = 0;
    pendingRoots.clear();
  }

  function configureObserver() {
    stopObserver();
    if (active && (isEffectiveOptionEnabled("adBlocking") || options.stripReferrer)) startObserver();
  }

  function configureLocalFeatures() {
    if (options.stripReferrer) enableReferrerProtection();
    else restoreReferrerProtection();

    if (isEffectiveOptionEnabled("adBlocking")) {
      activeAdSelector = Array.from(new Set([
        ...builtinSelectorsForPage(),
        ...customSelectorsForPage(options),
      ])).join(",");
      scanAds(document);
    } else {
      restoreAds();
    }

    if (options.pageShield) installShieldListeners();
    else removeShield();
    configureObserver();
  }

  function restoreLocalFeatures() {
    stopObserver();
    restoreReferrerProtection();
    restoreAds();
    removeShield();
  }

  function cleanupDisconnectedNodes() {
    for (const node of hiddenAdNodes) {
      if (!node.isConnected) hiddenAdNodes.delete(node);
    }
    for (const link of changedLinks.keys()) {
      if (!link.isConnected) changedLinks.delete(link);
    }
  }

  function featureCount() {
    if (!active) return 0;
    return PROTECTION_OPTIONS.reduce(
      (count, key) => count + (isEffectiveOptionEnabled(key) ? 1 : 0),
      0
    );
  }

  function stateData() {
    cleanupDisconnectedNodes();
    const main = {};
    for (const feature of MAIN_FEATURES) {
      main[feature.key] = {
        enabled: Boolean(mainEnabled.get(feature.key)),
        owned: Boolean(mainOwnership.get(feature.key)),
      };
    }
    return {
      active,
      phase: active ? (lastErrors.length ? "error" : "active") : "inactive",
      scope: "global",
      options: cloneOptions(options),
      count: featureCount(),
      hiddenAds: hiddenAdNodes.size,
      changedLinks: changedLinks.size,
      reversibleCount: hiddenAdNodes.size + changedLinks.size + (shield ? 1 : 0),
      revision,
      lastRevision: lastRequestRevision,
      updatedAt,
      main,
      compatibility: {
        site: isYouTubePage() ? "youtube" : null,
        enabled: Boolean(options.youtubeCompatibility),
        active: active && Boolean(options.youtubeCompatibility) && isYouTubePage(),
        suppressed: active && Boolean(options.youtubeCompatibility) && isYouTubePage()
          ? ["blockTrackers", "adBlocking"].filter((key) => Boolean(options[key]))
          : [],
      },
      errors: lastErrors.map((error) => ({ ...error })),
    };
  }

  function publishState() {
    const state = stateData();
    try {
      chrome.runtime.sendMessage({
        type: "WO_ACTION_STATE_CHANGED",
        action: ACTION,
        tabId: Number.isInteger(globalThis.__webOmniTabId) ? globalThis.__webOmniTabId : null,
        state,
      }).catch(() => {});
    } catch (_) {}
    return state;
  }

  function response(status, ok) {
    const data = stateData();
    const result = { ok, action: ACTION, status, data };
    if (!ok) {
      result.error = {
        code: "ACTION_FAILED",
        message: lastErrors.map((error) => error.message).join("; ") || "Global privacy mode failed.",
      };
    }
    return result;
  }

  function bumpRevision(requestRevision) {
    revision = Math.max(revision + 1, Number.isSafeInteger(requestRevision) ? requestRevision : 0);
    updatedAt = Date.now();
  }

  async function enableMode(nextOptions, requestRevision) {
    const errors = [];
    options = nextOptions;
    active = true;

    for (const feature of MAIN_FEATURES) {
      const error = isEffectiveOptionEnabled(feature.key)
        ? await enableMainFeature(feature)
        : await disableMainFeature(feature);
      if (error) errors.push(error);
    }

    try {
      configureLocalFeatures();
    } catch (error) {
      errors.push({
        feature: "localProtection",
        code: "ACTION_FAILED",
        message: error && error.message ? error.message : String(error),
      });
    }

    lastErrors = errors;
    bumpRevision(requestRevision);
    publishState();
    return response(errors.length ? "partial" : "active", true);
  }

  async function disableMode(requestRevision) {
    const errors = [];
    restoreLocalFeatures();
    for (const feature of [...MAIN_FEATURES].reverse()) {
      const error = await disableMainFeature(feature);
      if (error) errors.push(error);
    }
    const hasOwnedMainFeature = MAIN_FEATURES.some((feature) => mainOwnership.get(feature.key));
    active = hasOwnedMainFeature;
    lastErrors = errors;
    bumpRevision(requestRevision);
    publishState();
    return response(errors.length ? "failed" : "disabled", errors.length === 0);
  }

  function requestRevisionFrom(payload) {
    const value = payload && payload.revision;
    if (value === undefined || value === null || value === "") return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  }

  async function handle(request) {
    const payload = isPlainObject(request.payload) ? request.payload : request;
    const requestRevision = requestRevisionFrom(payload);
    if (requestRevision !== null && requestRevision < lastRequestRevision) {
      return response("stale", true);
    }
    if (requestRevision !== null) lastRequestRevision = requestRevision;

    const requestedMode = payload && payload.mode;
    const mode = requestedMode === undefined ? (active ? "disable" : "enable") : requestedMode;
    if (!["enable", "disable", "status"].includes(mode)) {
      return {
        ok: false,
        action: ACTION,
        status: "failed",
        data: stateData(),
        error: { code: "INVALID_REQUEST", message: `Unsupported privacy mode: ${String(mode)}` },
      };
    }
    if (mode === "status") return response(active ? "active" : "inactive", true);

    try {
      if (mode === "disable") return await disableMode(requestRevision);
      const nextOptions = normalizeOptions(payload.options, active ? options : DEFAULT_OPTIONS);
      return await enableMode(nextOptions, requestRevision);
    } catch (error) {
      return {
        ok: false,
        action: ACTION,
        status: "failed",
        data: stateData(),
        error: {
          code: error instanceof TypeError ? "INVALID_REQUEST" : "ACTION_FAILED",
          message: error && error.message ? error.message : String(error),
        },
      };
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || request.action !== ACTION) return false;
    operationQueue = operationQueue.then(() => handle(request), () => handle(request));
    operationQueue.then(sendResponse, (error) => sendResponse({
      ok: false,
      action: ACTION,
      status: "failed",
      data: stateData(),
      error: { code: "ACTION_FAILED", message: error && error.message ? error.message : String(error) },
    }));
    return true;
  });

  globalThis.addEventListener("pagehide", (event) => {
    if (event.persisted || !active) return;
    restoreLocalFeatures();
    for (const feature of MAIN_FEATURES) {
      if (mainOwnership.get(feature.key)) {
        runMainWorldAction(feature.action, { mode: "disable", consumer: ACTION });
        mainOwnership.set(feature.key, false);
        mainEnabled.set(feature.key, false);
      }
    }
    active = false;
    lastErrors = [];
    bumpRevision(null);
    publishState();
  }, true);

  globalThis.webOmniGlobalPrivacyMode = Object.freeze({
    version: 1,
    getState: () => stateData(),
  });
})();
