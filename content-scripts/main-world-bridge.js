// Web-Omni controlled MAIN world bridge.
// This file contains a fixed action table. It never evaluates caller-provided code.
(function installWebOmniMainWorldBridge() {
  "use strict";

  const BRIDGE_KEY = "__webOmniMainWorld";
  const REQUEST_EVENT = "web-omni-main-world-request";
  const RESPONSE_EVENT = "web-omni-main-world-response";
  const VERSION = "1.1.0";
  const MAX_LOG_ITEMS = 200;
  const MAX_MEDIA_ITEMS = 320;
  const MAX_MEDIA_PERFORMANCE_KEYS = 2000;

  const previousBridge = globalThis[BRIDGE_KEY];
  if (previousBridge && previousBridge.version === VERSION) return;
  if (previousBridge && typeof previousBridge.dispose === "function") {
    try { previousBridge.dispose(); } catch (_) {}
  }

  const state = {
    events: { enabled: false, original: null, wrapper: null, log: [] },
    network: {
      installed: false,
      monitorEnabled: false,
      trackerEnabled: false,
      trackerConsumers: new Set(),
      originals: {},
      wrappers: {},
      log: [],
      blockedCount: 0,
      removedScripts: 0,
      removedPixels: 0,
      observer: null,
    },
    websocket: {
      enabled: false,
      original: null,
      wrapper: null,
      log: [],
      sockets: new Set(),
    },
    canvas: {
      installed: false,
      consumers: new Set(),
      originals: {},
      wrappers: {},
      seed: createSeed(),
    },
    fingerprint: {
      enabled: false,
      consumers: new Set(),
      methodPatches: [],
      propertyPatches: [],
      protectedItems: [],
    },
    webrtc: { enabled: false, consumers: new Set(), properties: [] },
    seals: {
      enabled: false,
      blocker: null,
      observer: null,
      style: null,
      handlerRecords: [],
      seen: new WeakMap(),
    },
    media: {
      enabled: false,
      sessionId: "",
      pageUrl: "",
      revision: 0,
      candidates: new Map(),
      performanceSeen: new Set(),
      observer: null,
      originals: {},
      wrappers: {},
      sourceBufferTypes: new WeakMap(),
    },
  };

  const TRACKER_HOSTS = Object.freeze([
    "google-analytics.com",
    "googletagmanager.com",
    "doubleclick.net",
    "connect.facebook.net",
    "facebook.net",
    "hotjar.com",
    "mixpanel.com",
    "segment.io",
    "amplitude.com",
    "clarity.ms",
    "newrelic.com",
    "sentry.io",
    "cnzz.com",
    "51.la",
    "umeng.com",
  ]);

  const TRACKER_URL_MARKERS = Object.freeze([
    "/hm.js",
    "/analytics.js",
    "/gtag/js",
    "/collect?",
    "/beacon",
    "/pixel",
    "/track",
  ]);

  function createSeed() {
    try {
      const values = new Uint32Array(1);
      crypto.getRandomValues(values);
      return values[0] || 0x5f3759df;
    } catch (_) {
      return (Date.now() ^ 0x5f3759df) >>> 0;
    }
  }

  function pushLimited(list, item) {
    list.push(item);
    if (list.length > MAX_LOG_ITEMS) list.splice(0, list.length - MAX_LOG_ITEMS);
  }

  function success(action, status, data, limitations) {
    const result = { ok: true, action, status, data: data || {} };
    if (limitations && limitations.length) result.limitations = limitations;
    return result;
  }

  function failure(action, code, message, details) {
    const error = { code, message };
    if (details !== undefined) error.details = details;
    return { ok: false, action, status: "failed", error };
  }

  function requestedMode(payload, fallback) {
    const mode = payload && typeof payload.mode === "string" ? payload.mode : fallback;
    return mode === "enable" || mode === "disable" || mode === "status" ? mode : fallback;
  }

  function requestedConsumer(payload, fallback) {
    const raw = payload && typeof payload.consumer === "string" ? payload.consumer.trim() : "";
    return raw && raw.length <= 80 && /^[A-Z0-9_:-]+$/i.test(raw) ? raw : fallback;
  }

  function safeString(value, maxLength) {
    let output;
    try {
      output = String(value);
    } catch (_) {
      output = "[unreadable]";
    }
    return output.length > maxLength ? output.slice(0, maxLength) + "..." : output;
  }

  function safeValuePreview(value) {
    const type = typeof value;
    if (value === null) return { type: "object", preview: "null" };
    if (type === "string") return { type, preview: safeString(value, 160) };
    if (type === "number" || type === "boolean" || type === "bigint") {
      return { type, preview: safeString(value, 160) };
    }
    if (type === "undefined") return { type, preview: "undefined" };
    if (type === "symbol") return { type, preview: safeString(value, 160) };
    if (type === "function") return { type, preview: `[function ${value.name || "anonymous"}]` };
    try {
      if (Array.isArray(value)) return { type: "object", preview: `[Array(${value.length})]` };
      const tag = Object.prototype.toString.call(value);
      return { type: "object", preview: tag };
    } catch (_) {
      return { type: "object", preview: "[unreadable object]" };
    }
  }

  function dumpJsGlobals() {
    const baseline = new Set();
    let frame = null;
    try {
      frame = document.createElement("iframe");
      frame.hidden = true;
      frame.setAttribute("aria-hidden", "true");
      (document.documentElement || document).appendChild(frame);
      Object.getOwnPropertyNames(frame.contentWindow).forEach((key) => baseline.add(key));
    } catch (_) {
      // A page policy can prevent access to the temporary same-origin frame.
    } finally {
      if (frame) frame.remove();
    }

    baseline.add(BRIDGE_KEY);
    const globals = [];
    for (const key of Object.getOwnPropertyNames(globalThis)) {
      if (baseline.has(key) || key.startsWith("webOmni") || key.startsWith("__webOmni")) continue;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
        if (!descriptor) continue;
        const valueInfo = Object.prototype.hasOwnProperty.call(descriptor, "value")
          ? safeValuePreview(descriptor.value)
          : { type: "accessor", preview: "[getter/setter]" };
        globals.push({ name: key, type: valueInfo.type, preview: valueInfo.preview });
      } catch (_) {
        globals.push({ name: key, type: "unknown", preview: "[unreadable]" });
      }
      if (globals.length >= 500) break;
    }
    globals.sort((a, b) => a.name.localeCompare(b.name));
    return success("DUMP_JS_GLOBALS", "completed", {
      globals,
      count: globals.length,
      truncated: globals.length >= 500,
    }, ["Only own globals visible in the top frame are listed; accessor values are not invoked."]);
  }

  function describeEventTarget(target) {
    if (target === globalThis) return "window";
    if (target === document) return "document";
    if (target && target.nodeType === 1) {
      const id = target.id ? `#${safeString(target.id, 60)}` : "";
      const classes = target.classList && target.classList.length
        ? "." + Array.from(target.classList).slice(0, 3).map((item) => safeString(item, 30)).join(".")
        : "";
      return `${String(target.tagName || "element").toLowerCase()}${id}${classes}`;
    }
    return target && target.constructor ? safeString(target.constructor.name, 80) : "unknown";
  }

  function eventOptionsSummary(options) {
    if (typeof options === "boolean") return { capture: options, once: false, passive: false };
    if (!options || typeof options !== "object") return { capture: false, once: false, passive: false };
    return {
      capture: Boolean(options.capture),
      once: Boolean(options.once),
      passive: Boolean(options.passive),
    };
  }

  function eventMonitor(payload) {
    const mode = requestedMode(payload, state.events.enabled ? "disable" : "enable");
    if (mode === "enable" && !state.events.enabled) {
      const original = EventTarget.prototype.addEventListener;
      const wrapper = function webOmniAddEventListener(type, listener, options) {
        const optionInfo = eventOptionsSummary(options);
        pushLimited(state.events.log, {
          target: describeEventTarget(this),
          type: safeString(type, 80),
          capture: optionInfo.capture,
          once: optionInfo.once,
          passive: optionInfo.passive,
          time: Date.now(),
        });
        return original.apply(this, arguments);
      };
      state.events.original = original;
      state.events.wrapper = wrapper;
      EventTarget.prototype.addEventListener = wrapper;
      state.events.enabled = true;
    } else if (mode === "disable" && state.events.enabled) {
      if (EventTarget.prototype.addEventListener !== state.events.wrapper) {
        return failure("HIJACK_EVENTS", "ACTION_FAILED", "EventTarget.addEventListener was changed by another script; automatic restore was skipped.");
      }
      EventTarget.prototype.addEventListener = state.events.original;
      state.events.enabled = false;
      state.events.original = null;
      state.events.wrapper = null;
    }

    return success("HIJACK_EVENTS", mode === "disable" ? "disabled" : (state.events.enabled ? "active" : "inactive"), {
      enabled: state.events.enabled,
      count: state.events.log.length,
      recent: state.events.log.slice(-100),
      restore: { action: "HIJACK_EVENTS", payload: { mode: "disable" } },
    }, ["Only listeners registered after activation are observed; existing listeners cannot be enumerated by the web platform."]);
  }

  function normalizeRequestUrl(input) {
    try {
      if (typeof input === "string") return new URL(input, location.href).href;
      if (input && typeof input.url === "string") return new URL(input.url, location.href).href;
      return safeString(input, 1000);
    } catch (_) {
      return safeString(input, 1000);
    }
  }

  function isTrackerUrl(value) {
    const raw = safeString(value, 4096).toLowerCase();
    if (!raw) return false;
    try {
      const url = new URL(raw, location.href);
      const hostname = url.hostname.toLowerCase();
      if (TRACKER_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return true;
      const full = `${url.pathname}${url.search}`;
      return TRACKER_URL_MARKERS.some((marker) => full.includes(marker));
    } catch (_) {
      return TRACKER_HOSTS.some((host) => raw.includes(host)) || TRACKER_URL_MARKERS.some((marker) => raw.includes(marker));
    }
  }

  function recordNetwork(transport, method, url, blocked) {
    if (!state.network.monitorEnabled && !blocked) return;
    pushLimited(state.network.log, {
      transport,
      method: safeString(method || "GET", 20).toUpperCase(),
      url: safeString(url, 1000),
      blocked: Boolean(blocked),
      time: Date.now(),
    });
  }

  function installNetworkHooks() {
    if (state.network.installed) return;
    const originals = state.network.originals;
    const wrappers = state.network.wrappers;
    originals.fetch = globalThis.fetch;
    originals.xhrOpen = XMLHttpRequest.prototype.open;
    originals.xhrSend = XMLHttpRequest.prototype.send;
    originals.sendBeacon = navigator.sendBeacon;

    wrappers.fetch = function webOmniFetch(input, init) {
      const url = normalizeRequestUrl(input);
      const method = (init && init.method) || (input && input.method) || "GET";
      const blocked = state.network.trackerEnabled && isTrackerUrl(url);
      recordNetwork("fetch", method, url, blocked);
      if (blocked) {
        state.network.blockedCount += 1;
        return Promise.resolve(new Response(null, { status: 204, statusText: "Blocked by Web-Omni" }));
      }
      return originals.fetch.apply(this, arguments);
    };

    wrappers.xhrOpen = function webOmniXhrOpen(method, url) {
      const normalizedUrl = normalizeRequestUrl(url);
      const blocked = state.network.trackerEnabled && isTrackerUrl(normalizedUrl);
      try {
        Object.defineProperty(this, "__webOmniRequestMeta", {
          configurable: true,
          value: { method: safeString(method || "GET", 20).toUpperCase(), url: normalizedUrl, blocked },
        });
      } catch (_) {
        this.__webOmniRequestMeta = { method: safeString(method || "GET", 20).toUpperCase(), url: normalizedUrl, blocked };
      }
      recordNetwork("xhr", method, normalizedUrl, blocked);
      if (blocked) {
        state.network.blockedCount += 1;
        const args = Array.from(arguments);
        args[1] = "data:text/plain,";
        return originals.xhrOpen.apply(this, args);
      }
      return originals.xhrOpen.apply(this, arguments);
    };

    wrappers.xhrSend = function webOmniXhrSend() {
      const meta = this.__webOmniRequestMeta;
      if (meta && !meta.blocked && state.network.trackerEnabled && isTrackerUrl(meta.url)) {
        meta.blocked = true;
        state.network.blockedCount += 1;
        try { this.abort(); } catch (_) {}
        return undefined;
      }
      return originals.xhrSend.apply(this, arguments);
    };

    wrappers.sendBeacon = function webOmniSendBeacon(url, data) {
      const normalizedUrl = normalizeRequestUrl(url);
      const blocked = state.network.trackerEnabled && isTrackerUrl(normalizedUrl);
      recordNetwork("beacon", "POST", normalizedUrl, blocked);
      if (blocked) {
        state.network.blockedCount += 1;
        return true;
      }
      return originals.sendBeacon.call(this, url, data);
    };

    if (typeof originals.fetch === "function") globalThis.fetch = wrappers.fetch;
    XMLHttpRequest.prototype.open = wrappers.xhrOpen;
    XMLHttpRequest.prototype.send = wrappers.xhrSend;
    if (typeof originals.sendBeacon === "function") navigator.sendBeacon = wrappers.sendBeacon;
    state.network.installed = true;
  }

  function restoreNetworkHooksIfUnused() {
    if (!state.network.installed || state.network.monitorEnabled || state.network.trackerEnabled) return true;
    const originals = state.network.originals;
    const wrappers = state.network.wrappers;
    let restored = true;
    if (globalThis.fetch === wrappers.fetch) globalThis.fetch = originals.fetch;
    else restored = false;
    if (XMLHttpRequest.prototype.open === wrappers.xhrOpen) XMLHttpRequest.prototype.open = originals.xhrOpen;
    else restored = false;
    if (XMLHttpRequest.prototype.send === wrappers.xhrSend) XMLHttpRequest.prototype.send = originals.xhrSend;
    else restored = false;
    if (typeof originals.sendBeacon === "function") {
      if (navigator.sendBeacon === wrappers.sendBeacon) navigator.sendBeacon = originals.sendBeacon;
      else restored = false;
    }
    if (restored) {
      state.network.installed = false;
      state.network.originals = {};
      state.network.wrappers = {};
    }
    return restored;
  }

  function requestMonitor(payload) {
    const mode = requestedMode(payload, state.network.monitorEnabled ? "disable" : "enable");
    if (mode === "enable") {
      installNetworkHooks();
      state.network.monitorEnabled = true;
    } else if (mode === "disable") {
      state.network.monitorEnabled = false;
      if (!restoreNetworkHooksIfUnused()) {
        return failure("INTERCEPT_REQUESTS", "ACTION_FAILED", "One or more network APIs were changed by another script; automatic restore was incomplete.");
      }
    }
    return success("INTERCEPT_REQUESTS", state.network.monitorEnabled ? "active" : "disabled", {
      enabled: state.network.monitorEnabled,
      count: state.network.log.length,
      recent: state.network.log.slice(-100),
      restore: { action: "INTERCEPT_REQUESTS", payload: { mode: "disable" } },
    }, ["Only fetch, XMLHttpRequest, and sendBeacon calls made after activation are observed."]);
  }

  function trackerNodes(root) {
    const nodes = [];
    if (root && root.nodeType === 1) nodes.push(root);
    if (root && typeof root.querySelectorAll === "function") {
      nodes.push(...root.querySelectorAll("script[src],img[src],iframe[src]"));
    }
    return nodes;
  }

  function removeTrackerNodes(root) {
    let scripts = 0;
    let pixels = 0;
    for (const node of trackerNodes(root)) {
      const src = node.src || node.getAttribute && node.getAttribute("src") || "";
      const knownTracker = isTrackerUrl(src);
      const hasWidth = node.tagName === "IMG" && node.hasAttribute("width");
      const hasHeight = node.tagName === "IMG" && node.hasAttribute("height");
      const tinyImage = node.tagName === "IMG" && (
        (hasWidth && Number(node.getAttribute("width")) <= 1) ||
        (hasHeight && Number(node.getAttribute("height")) <= 1) ||
        (node.naturalWidth > 0 && node.naturalWidth <= 1) ||
        (node.naturalHeight > 0 && node.naturalHeight <= 1)
      );
      if (!knownTracker && !tinyImage) continue;
      if (node.tagName === "SCRIPT" || node.tagName === "IFRAME") scripts += 1;
      else pixels += 1;
      node.remove();
    }
    state.network.removedScripts += scripts;
    state.network.removedPixels += pixels;
    return { scripts, pixels };
  }

  function startTrackerObserver() {
    if (state.network.observer || !document.documentElement) return;
    state.network.observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1) removeTrackerNodes(node);
        }
      }
    });
    state.network.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function trackerBlock(payload) {
    const action = "PRIVACY_BLOCK_TRACKERS";
    const consumer = requestedConsumer(payload, action);
    const consumerEnabled = state.network.trackerConsumers.has(consumer);
    const mode = requestedMode(payload, consumerEnabled ? "disable" : "enable");
    let removedNow = { scripts: 0, pixels: 0 };
    if (mode === "enable") {
      installNetworkHooks();
      state.network.trackerConsumers.add(consumer);
      state.network.trackerEnabled = state.network.trackerConsumers.size > 0;
      removedNow = removeTrackerNodes(document);
      startTrackerObserver();
    } else if (mode === "disable") {
      state.network.trackerConsumers.delete(consumer);
      state.network.trackerEnabled = state.network.trackerConsumers.size > 0;
      if (!state.network.trackerEnabled) {
        if (state.network.observer) state.network.observer.disconnect();
        state.network.observer = null;
        if (!restoreNetworkHooksIfUnused()) {
          return failure(action, "ACTION_FAILED", "One or more network APIs were changed by another script; automatic restore was incomplete.");
        }
      }
    }

    return success(action, state.network.trackerEnabled ? "active" : "disabled", {
      enabled: state.network.trackerEnabled,
      consumer,
      consumerEnabled: state.network.trackerConsumers.has(consumer),
      consumers: Array.from(state.network.trackerConsumers),
      removedNow,
      removedScripts: state.network.removedScripts,
      removedPixels: state.network.removedPixels,
      blockedRequests: state.network.blockedCount,
      restore: { action, payload: { mode: "disable", consumer } },
    }, [
      "Scripts and pixels that already executed cannot be undone.",
      "This page-level guard does not cover service workers, browser extensions, or requests made before activation.",
    ]);
  }

  function websocketDataPreview(value) {
    if (typeof value === "string") return safeString(value, 500);
    if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`;
    if (ArrayBuffer.isView(value)) return `[${value.constructor.name} ${value.byteLength} bytes]`;
    if (typeof Blob !== "undefined" && value instanceof Blob) return `[Blob ${value.size} bytes ${value.type || "unknown"}]`;
    return safeString(value, 500);
  }

  function instrumentSocket(socket, url) {
    const record = {
      socket,
      hadOwnSend: Object.prototype.hasOwnProperty.call(socket, "send"),
      ownSendDescriptor: Object.getOwnPropertyDescriptor(socket, "send"),
      wrappedSend: null,
      messageListener: null,
      closeListener: null,
    };
    const originalSend = socket.send;
    record.wrappedSend = function webOmniWebSocketSend(data) {
      pushLimited(state.websocket.log, {
        direction: "send",
        url: safeString(url, 1000),
        data: websocketDataPreview(data),
        time: Date.now(),
      });
      return originalSend.apply(this, arguments);
    };
    try {
      Object.defineProperty(socket, "send", { configurable: true, writable: true, value: record.wrappedSend });
    } catch (_) {
      socket.send = record.wrappedSend;
    }
    record.messageListener = (event) => {
      if (!state.websocket.enabled) return;
      pushLimited(state.websocket.log, {
        direction: "receive",
        url: safeString(url, 1000),
        data: websocketDataPreview(event.data),
        time: Date.now(),
      });
    };
    record.closeListener = () => state.websocket.sockets.delete(record);
    socket.addEventListener("message", record.messageListener);
    socket.addEventListener("close", record.closeListener, { once: true });
    state.websocket.sockets.add(record);
    return socket;
  }

  function restoreInstrumentedSockets() {
    for (const record of state.websocket.sockets) {
      try {
        record.socket.removeEventListener("message", record.messageListener);
        record.socket.removeEventListener("close", record.closeListener);
        if (record.socket.send !== record.wrappedSend) continue;
        if (record.hadOwnSend && record.ownSendDescriptor) {
          Object.defineProperty(record.socket, "send", record.ownSendDescriptor);
        } else {
          delete record.socket.send;
        }
      } catch (_) {}
    }
    state.websocket.sockets.clear();
  }

  function websocketMonitor(payload) {
    const action = "WEBSOCKET_MONITOR";
    const mode = requestedMode(payload, state.websocket.enabled ? "disable" : "enable");
    if (mode === "enable" && !state.websocket.enabled) {
      const OriginalWebSocket = globalThis.WebSocket;
      if (typeof OriginalWebSocket !== "function") {
        return failure(action, "UNSUPPORTED_CONTEXT", "WebSocket is not available in this page.");
      }
      function WebOmniWebSocket() {
        if (!new.target) throw new TypeError("Failed to construct 'WebSocket': use the 'new' operator.");
        const newTarget = new.target === WebOmniWebSocket ? OriginalWebSocket : new.target;
        const socket = Reflect.construct(OriginalWebSocket, Array.from(arguments), newTarget);
        return instrumentSocket(socket, arguments[0]);
      }
      Object.setPrototypeOf(WebOmniWebSocket, OriginalWebSocket);
      WebOmniWebSocket.prototype = OriginalWebSocket.prototype;
      state.websocket.original = OriginalWebSocket;
      state.websocket.wrapper = WebOmniWebSocket;
      globalThis.WebSocket = WebOmniWebSocket;
      state.websocket.enabled = true;
    } else if (mode === "disable" && state.websocket.enabled) {
      if (globalThis.WebSocket !== state.websocket.wrapper) {
        return failure(action, "ACTION_FAILED", "window.WebSocket was changed by another script; automatic restore was skipped.");
      }
      globalThis.WebSocket = state.websocket.original;
      state.websocket.enabled = false;
      restoreInstrumentedSockets();
      state.websocket.original = null;
      state.websocket.wrapper = null;
    }
    return success(action, state.websocket.enabled ? "active" : "disabled", {
      enabled: state.websocket.enabled,
      count: state.websocket.log.length,
      recent: state.websocket.log.slice(-100),
      restore: { action, payload: { mode: "disable" } },
    }, ["Only WebSocket instances created after activation are observed; binary payloads are reported by type and size."]);
  }

  function applyCanvasNoise(data, seed) {
    const pixelCount = Math.floor(data.length / 4);
    if (!pixelCount) return data;
    const stride = Math.max(1, Math.floor(pixelCount / 64));
    for (let pixel = seed % stride; pixel < pixelCount; pixel += stride) {
      const index = pixel * 4;
      const delta = ((seed + pixel * 1103515245) >>> 30) & 1 ? 1 : -1;
      data[index] = Math.max(0, Math.min(255, data[index] + delta));
      data[index + 1] = Math.max(0, Math.min(255, data[index + 1] - delta));
    }
    return data;
  }

  function createNoisyCanvas(source) {
    const width = Number(source.width) || 0;
    const height = Number(source.height) || 0;
    if (!width || !height || width * height > 16777216) return null;
    const clone = document.createElement("canvas");
    clone.width = width;
    clone.height = height;
    const context = clone.getContext("2d");
    if (!context) return null;
    context.drawImage(source, 0, 0);
    const tileWidth = Math.min(width, 32);
    const tileHeight = Math.min(height, 32);
    const x = width > tileWidth ? state.canvas.seed % (width - tileWidth + 1) : 0;
    const y = height > tileHeight ? (state.canvas.seed >>> 8) % (height - tileHeight + 1) : 0;
    const imageData = state.canvas.originals.getImageData.call(context, x, y, tileWidth, tileHeight);
    applyCanvasNoise(imageData.data, state.canvas.seed);
    context.putImageData(imageData, x, y);
    return clone;
  }

  function installCanvasHooks() {
    if (state.canvas.installed) return true;
    if (typeof HTMLCanvasElement === "undefined" || typeof CanvasRenderingContext2D === "undefined") return false;
    const originals = state.canvas.originals;
    const wrappers = state.canvas.wrappers;
    originals.toDataURL = HTMLCanvasElement.prototype.toDataURL;
    originals.toBlob = HTMLCanvasElement.prototype.toBlob;
    originals.getImageData = CanvasRenderingContext2D.prototype.getImageData;

    wrappers.toDataURL = function webOmniCanvasToDataURL() {
      try {
        const clone = createNoisyCanvas(this);
        if (clone) return originals.toDataURL.apply(clone, arguments);
      } catch (_) {}
      return originals.toDataURL.apply(this, arguments);
    };
    wrappers.toBlob = function webOmniCanvasToBlob() {
      try {
        const clone = createNoisyCanvas(this);
        if (clone) return originals.toBlob.apply(clone, arguments);
      } catch (_) {}
      return originals.toBlob.apply(this, arguments);
    };
    wrappers.getImageData = function webOmniGetImageData() {
      const imageData = originals.getImageData.apply(this, arguments);
      applyCanvasNoise(imageData.data, state.canvas.seed);
      return imageData;
    };
    HTMLCanvasElement.prototype.toDataURL = wrappers.toDataURL;
    HTMLCanvasElement.prototype.toBlob = wrappers.toBlob;
    CanvasRenderingContext2D.prototype.getImageData = wrappers.getImageData;
    state.canvas.installed = true;
    return true;
  }

  function enableCanvasConsumer(name) {
    if (!installCanvasHooks()) return false;
    state.canvas.consumers.add(name);
    return true;
  }

  function disableCanvasConsumer(name) {
    state.canvas.consumers.delete(name);
    if (!state.canvas.installed || state.canvas.consumers.size) return true;
    const originals = state.canvas.originals;
    const wrappers = state.canvas.wrappers;
    let restored = true;
    if (HTMLCanvasElement.prototype.toDataURL === wrappers.toDataURL) HTMLCanvasElement.prototype.toDataURL = originals.toDataURL;
    else restored = false;
    if (HTMLCanvasElement.prototype.toBlob === wrappers.toBlob) HTMLCanvasElement.prototype.toBlob = originals.toBlob;
    else restored = false;
    if (CanvasRenderingContext2D.prototype.getImageData === wrappers.getImageData) CanvasRenderingContext2D.prototype.getImageData = originals.getImageData;
    else restored = false;
    if (restored) {
      state.canvas.installed = false;
      state.canvas.originals = {};
      state.canvas.wrappers = {};
    }
    return restored;
  }

  function canvasSpoof(payload) {
    const action = "CANVAS_SPOOF";
    const enabled = state.canvas.consumers.has(action);
    const mode = requestedMode(payload, enabled ? "disable" : "enable");
    if (mode === "enable" && !enableCanvasConsumer(action)) {
      return failure(action, "UNSUPPORTED_CONTEXT", "Canvas 2D APIs are not available in this page.");
    }
    if (mode === "disable" && !disableCanvasConsumer(action)) {
      return failure(action, "ACTION_FAILED", "One or more Canvas APIs were changed by another script; automatic restore was incomplete.");
    }
    return success(action, state.canvas.consumers.has(action) ? "active" : "disabled", {
      enabled: state.canvas.consumers.has(action),
      deterministicPerPageSession: true,
      restore: { action, payload: { mode: "disable" } },
    }, ["Tainted canvases and canvases larger than 16,777,216 pixels may retain their original output."]);
  }

  function patchMethod(proto, key, createWrapper) {
    if (!proto || typeof proto[key] !== "function") return false;
    const original = proto[key];
    const wrapper = createWrapper(original);
    proto[key] = wrapper;
    state.fingerprint.methodPatches.push({ proto, key, original, wrapper });
    return true;
  }

  function patchProperty(target, key, descriptor) {
    if (!target) return false;
    const hadOwn = Object.prototype.hasOwnProperty.call(target, key);
    const original = Object.getOwnPropertyDescriptor(target, key);
    try {
      Object.defineProperty(target, key, { configurable: true, ...descriptor });
      state.fingerprint.propertyPatches.push({
        target,
        key,
        hadOwn,
        original,
        applied: Object.getOwnPropertyDescriptor(target, key),
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  function restoreFingerprintPatches() {
    let restored = true;
    const remainingMethods = [];
    for (const patch of state.fingerprint.methodPatches.slice().reverse()) {
      if (patch.proto[patch.key] === patch.wrapper) patch.proto[patch.key] = patch.original;
      else {
        restored = false;
        remainingMethods.push(patch);
      }
    }
    const remainingProperties = [];
    for (const patch of state.fingerprint.propertyPatches.slice().reverse()) {
      try {
        if (!samePropertyDescriptor(Object.getOwnPropertyDescriptor(patch.target, patch.key), patch.applied)) {
          restored = false;
          remainingProperties.push(patch);
          continue;
        }
        if (patch.hadOwn && patch.original) Object.defineProperty(patch.target, patch.key, patch.original);
        else delete patch.target[patch.key];
      } catch (_) {
        restored = false;
        remainingProperties.push(patch);
      }
    }
    state.fingerprint.methodPatches = remainingMethods.reverse();
    state.fingerprint.propertyPatches = remainingProperties.reverse();
    if (restored) state.fingerprint.protectedItems = [];
    return restored;
  }

  function samePropertyDescriptor(left, right) {
    if (!left || !right) return left === right;
    return left.configurable === right.configurable
      && left.enumerable === right.enumerable
      && left.writable === right.writable
      && left.value === right.value
      && left.get === right.get
      && left.set === right.set;
  }

  function fingerprintProtect(payload) {
    const action = "PRIVACY_FINGERPRINT_PROTECT";
    const consumer = requestedConsumer(payload, action);
    const consumerEnabled = state.fingerprint.consumers.has(consumer);
    const mode = requestedMode(payload, consumerEnabled ? "disable" : "enable");
    if (mode === "enable" && !state.fingerprint.enabled) {
      const items = [];
      if (enableCanvasConsumer(action)) items.push("Canvas");
      if (typeof WebGLRenderingContext !== "undefined" && patchMethod(WebGLRenderingContext.prototype, "getParameter", (original) => function webOmniWebGlGetParameter(param) {
        if (param === 0x9245) return "Google Inc. (Web-Omni Protected)";
        if (param === 0x9246) return "ANGLE (Web-Omni Protected)";
        return original.apply(this, arguments);
      })) items.push("WebGL");
      if (typeof WebGL2RenderingContext !== "undefined") {
        patchMethod(WebGL2RenderingContext.prototype, "getParameter", (original) => function webOmniWebGl2GetParameter(param) {
          if (param === 0x9245) return "Google Inc. (Web-Omni Protected)";
          if (param === 0x9246) return "ANGLE (Web-Omni Protected)";
          return original.apply(this, arguments);
        });
      }
      if (typeof AnalyserNode !== "undefined" && patchMethod(AnalyserNode.prototype, "getFloatFrequencyData", (original) => function webOmniAudioFingerprint(array) {
        const result = original.apply(this, arguments);
        if (array && typeof array.length === "number") {
          for (let index = 0; index < array.length; index += 1) {
            array[index] += (((state.canvas.seed + index * 17) % 7) - 3) * 0.0000001;
          }
        }
        return result;
      })) items.push("Audio");
      const concurrencyPatched = patchProperty(navigator, "hardwareConcurrency", { get: () => 4 });
      const memoryPatched = patchProperty(navigator, "deviceMemory", { get: () => 8 });
      const hardwarePatched = concurrencyPatched || memoryPatched;
      if (hardwarePatched) items.push("Navigator hardware");
      if (patchProperty(screen, "colorDepth", { get: () => 24 })) items.push("Screen color depth");
      state.fingerprint.protectedItems = items;
      state.fingerprint.enabled = true;
    }
    if (mode === "enable") {
      state.fingerprint.consumers.add(consumer);
    } else if (mode === "disable") {
      state.fingerprint.consumers.delete(consumer);
    }
    if (mode === "disable" && state.fingerprint.enabled && state.fingerprint.consumers.size === 0) {
      const methodsRestored = restoreFingerprintPatches();
      const canvasRestored = disableCanvasConsumer(action);
      if (!methodsRestored || !canvasRestored) {
        state.fingerprint.consumers.add(consumer);
        return failure(action, "ACTION_FAILED", "One or more fingerprint APIs were changed by another script; automatic restore was incomplete.");
      }
      state.fingerprint.enabled = false;
    }
    return success(action, state.fingerprint.enabled ? "active" : "disabled", {
      enabled: state.fingerprint.enabled,
      consumer,
      consumerEnabled: state.fingerprint.consumers.has(consumer),
      consumers: Array.from(state.fingerprint.consumers),
      protectedItems: state.fingerprint.protectedItems.slice(),
      restore: { action, payload: { mode: "disable", consumer } },
    }, [
      "Page-level overrides reduce consistency of common fingerprint surfaces but cannot provide browser-level anti-fingerprinting guarantees.",
      "Existing values cached by the page before activation remain available to that page.",
    ]);
  }

  function webrtcProtect(payload) {
    const action = "PRIVACY_WEBRTC_PROTECT";
    const consumer = requestedConsumer(payload, action);
    const consumerEnabled = state.webrtc.consumers.has(consumer);
    const mode = requestedMode(payload, consumerEnabled ? "disable" : "enable");
    if (mode === "enable" && !state.webrtc.enabled) {
      const names = ["RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection"];
      function BlockedRTCPeerConnection() {
        throw new DOMException("WebRTC is disabled by Web-Omni for this page.", "NotAllowedError");
      }
      for (const name of names) {
        if (!(name in globalThis)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
        try {
          Object.defineProperty(globalThis, name, {
            configurable: true,
            writable: true,
            value: BlockedRTCPeerConnection,
          });
          state.webrtc.properties.push({ name, descriptor, replacement: BlockedRTCPeerConnection });
        } catch (_) {}
      }
      if (!state.webrtc.properties.length) {
        return failure(action, "UNSUPPORTED_CONTEXT", "RTCPeerConnection is not available or cannot be overridden in this page.");
      }
      state.webrtc.enabled = true;
    }
    if (mode === "enable") {
      state.webrtc.consumers.add(consumer);
    } else if (mode === "disable") {
      state.webrtc.consumers.delete(consumer);
    }
    if (mode === "disable" && state.webrtc.enabled && state.webrtc.consumers.size === 0) {
      let restored = true;
      const remaining = [];
      for (const record of state.webrtc.properties) {
        try {
          const current = Object.getOwnPropertyDescriptor(globalThis, record.name);
          if (!current || current.value !== record.replacement) {
            restored = false;
            remaining.push(record);
            continue;
          }
          if (record.descriptor) Object.defineProperty(globalThis, record.name, record.descriptor);
          else delete globalThis[record.name];
        } catch (_) {
          restored = false;
          remaining.push(record);
        }
      }
      state.webrtc.properties = remaining;
      if (!restored) {
        state.webrtc.consumers.add(consumer);
        return failure(action, "ACTION_FAILED", "WebRTC protection could not be fully restored.");
      }
      state.webrtc.enabled = false;
    }
    return success(action, state.webrtc.enabled ? "active" : "disabled", {
      enabled: state.webrtc.enabled,
      consumer,
      consumerEnabled: state.webrtc.consumers.has(consumer),
      consumers: Array.from(state.webrtc.consumers),
      restore: { action, payload: { mode: "disable", consumer } },
    }, [
      "This page-level override affects new RTCPeerConnection instances only and can disrupt calls or peer-to-peer features.",
      "Browser policy, existing connections, and native applications are outside its scope.",
    ]);
  }

  const SEAL_EVENTS = Object.freeze(["contextmenu", "copy", "paste", "cut", "selectstart", "dragstart"]);
  const SEAL_PROPERTIES = Object.freeze(["oncontextmenu", "oncopy", "onpaste", "oncut", "onselectstart", "ondragstart"]);

  function rememberAndClearHandler(target, property) {
    if (!target) return;
    let seenProperties = state.seals.seen.get(target);
    if (!seenProperties) {
      seenProperties = new Set();
      state.seals.seen.set(target, seenProperties);
    }
    if (seenProperties.has(property)) return;
    const attribute = property;
    const hasAttribute = target.nodeType === 1 && target.hasAttribute(attribute);
    const attributeValue = hasAttribute ? target.getAttribute(attribute) : null;
    let propertyValue = null;
    try { propertyValue = target[property]; } catch (_) {}
    if (!hasAttribute && typeof propertyValue !== "function") return;
    seenProperties.add(property);
    state.seals.handlerRecords.push({ target, property, attribute, hasAttribute, attributeValue, propertyValue });
    try { target[property] = null; } catch (_) {}
    if (hasAttribute) target.removeAttribute(attribute);
  }

  function clearSealHandlers(root) {
    const targets = [];
    if (root === document) targets.push(document, document.documentElement, document.body);
    else if (root && root.nodeType === 1) targets.push(root);
    const selector = SEAL_PROPERTIES.map((property) => `[${property}]`).join(",");
    if (root && typeof root.querySelectorAll === "function") targets.push(...root.querySelectorAll(selector));
    for (const target of targets) {
      for (const property of SEAL_PROPERTIES) rememberAndClearHandler(target, property);
    }
  }

  function breakSeals(payload) {
    const action = "BREAK_SEALS";
    const mode = requestedMode(payload, state.seals.enabled ? "disable" : "enable");
    if (mode === "enable" && !state.seals.enabled) {
      state.seals.blocker = function webOmniSealBlocker(event) {
        if (!state.seals.enabled || !SEAL_EVENTS.includes(event.type)) return;
        event.stopImmediatePropagation();
      };
      for (const eventName of SEAL_EVENTS) globalThis.addEventListener(eventName, state.seals.blocker, true);
      clearSealHandlers(document);
      const style = document.createElement("style");
      style.id = "web-omni-break-seals-css";
      style.textContent = "*:not(input):not(textarea){user-select:text!important;-webkit-user-select:text!important;-webkit-touch-callout:default!important;}";
      (document.head || document.documentElement).appendChild(style);
      state.seals.style = style;
      state.seals.observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === "attributes") clearSealHandlers(record.target);
          for (const node of record.addedNodes || []) {
            if (node.nodeType === 1) clearSealHandlers(node);
          }
        }
      });
      state.seals.observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: SEAL_PROPERTIES.slice(),
        childList: true,
        subtree: true,
      });
      state.seals.enabled = true;
    } else if (mode === "disable" && state.seals.enabled) {
      for (const eventName of SEAL_EVENTS) globalThis.removeEventListener(eventName, state.seals.blocker, true);
      if (state.seals.observer) state.seals.observer.disconnect();
      if (state.seals.style) state.seals.style.remove();
      for (const record of state.seals.handlerRecords) {
        try {
          if (record.target.nodeType === 1 && record.hasAttribute && !record.target.hasAttribute(record.attribute)) {
            record.target.setAttribute(record.attribute, record.attributeValue || "");
          } else if (!record.hasAttribute && record.target[record.property] == null && typeof record.propertyValue === "function") {
            record.target[record.property] = record.propertyValue;
          }
        } catch (_) {}
      }
      state.seals.enabled = false;
      state.seals.blocker = null;
      state.seals.observer = null;
      state.seals.style = null;
      state.seals.handlerRecords = [];
      state.seals.seen = new WeakMap();
    }
    return success(action, state.seals.enabled ? "active" : "disabled", {
      enabled: state.seals.enabled,
      clearedInlineHandlers: state.seals.handlerRecords.length,
      restore: { action, payload: { mode: "disable" } },
    }, [
      "Earlier window-level capture listeners and handlers inside closed shadow roots may still prevent interaction.",
      "Restoring re-applies inline handlers only when the page has not replaced them after activation.",
    ]);
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function browserFingerprint() {
    const data = {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      languages: Array.from(navigator.languages || []),
      hardwareConcurrency: navigator.hardwareConcurrency || null,
      deviceMemory: navigator.deviceMemory || null,
      screen: `${screen.width}x${screen.height}x${screen.colorDepth}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      touchPoints: navigator.maxTouchPoints || 0,
      plugins: navigator.plugins ? navigator.plugins.length : 0,
      canvasHash: null,
      webgl: null,
    };
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 220;
      canvas.height = 40;
      const context = canvas.getContext("2d");
      context.textBaseline = "top";
      context.font = "14px Arial";
      context.fillStyle = "#f60";
      context.fillRect(125, 1, 62, 20);
      context.fillStyle = "#069";
      context.fillText("Web-Omni fingerprint", 2, 15);
      data.canvasHash = hashString(canvas.toDataURL());
    } catch (_) {}
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      if (gl) {
        const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
        data.webgl = {
          vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
          renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        };
      }
    } catch (_) {}
    return success("BROWSER_FINGERPRINT", "completed", data, ["The snapshot reflects values available to the current top-frame page at the time of collection."]);
  }

  function mediaMimeParts(value) {
    const raw = safeString(value || "", 240);
    const match = raw.match(/^\s*([^;]+)(?:;\s*codecs=["']?([^"']+))?/i);
    return {
      mimeType: match ? match[1].trim().toLowerCase() : raw.toLowerCase(),
      codecs: match && match[2] ? match[2].trim() : "",
    };
  }

  function mediaKind(url, mimeType, hint) {
    const rawUrl = safeString(url || "", 4096).toLowerCase();
    const mime = safeString(mimeType || "", 160).toLowerCase();
    if (hint) return hint;
    if (rawUrl.startsWith("blob:")) return "blob";
    if (/\.m3u8(?:$|[?#])|application\/(?:vnd\.apple\.mpegurl|x-mpegurl)/i.test(`${rawUrl} ${mime}`)) return "manifest";
    if (/\.mpd(?:$|[?#])|application\/dash\+xml/i.test(`${rawUrl} ${mime}`)) return "manifest";
    if (mime.startsWith("audio/")) return "audio";
    if (mime.startsWith("video/")) return "video";
    if (/\.(?:m4s|ts|cmfv|cmfa)(?:$|[?#])/i.test(rawUrl)) return "segment";
    if (/\.(?:mp3|m4a|aac|ogg|opus|flac|wav)(?:$|[?#])/i.test(rawUrl)) return "audio";
    if (/\.(?:mp4|webm|mov|mkv|flv)(?:$|[?#])/i.test(rawUrl)) return "video";
    return "media";
  }

  function mediaSegmentTrackPath(pathname) {
    const value = safeString(pathname || "", 1000);
    if (!/\.(?:m4s|ts|cmfv|cmfa)$/i.test(value)) return value;
    return value
      .replace(/(^|\/)\d+(?=\.(?:m4s|ts|cmfv|cmfa)$)/i, "$1*")
      .replace(/((?:segment|seg|fragment|frag|chunk|part)[-_.]?)\d+(?=\.(?:m4s|ts|cmfv|cmfa)$)/i, "$1*");
  }

  function mediaUrlMime(url) {
    try {
      const value = new URL(url, location.href).searchParams.get("mime");
      return value ? decodeURIComponent(value) : "";
    } catch (_) {
      return "";
    }
  }

  function hasMediaDrmMetadata() {
    const hasValue = (value) => {
      if (Array.isArray(value)) return value.length > 0;
      if (value && typeof value === "object") return Object.keys(value).length > 0;
      if (typeof value === "string") return value.trim().length > 0;
      return value === true;
    };
    return Array.from(arguments).some((source) => source && typeof source === "object" && (
      source.encrypted === true
      || hasValue(source.drmFamilies)
      || hasValue(source.licenseInfos)
      || hasValue(source.contentProtection)
      || hasValue(source.content_protection)
    ));
  }

  function mediaExpiry(url) {
    try {
      const parsed = new URL(url, location.href);
      const raw = parsed.searchParams.get("expire") || parsed.searchParams.get("deadline");
      const seconds = Number(raw);
      return Number.isFinite(seconds) && seconds > 1e9 ? seconds * 1000 : null;
    } catch (_) {
      return null;
    }
  }

  function mediaGroupId(value) {
    if (value.groupId) return safeString(value.groupId, 800);
    const rawUrl = safeString(value.url || "", 4096);
    if (!rawUrl) return `media:${safeString(value.kind || "unknown", 30)}:${safeString(value.mimeType || value.codecs || "unknown", 160)}`;
    if (rawUrl.startsWith("blob:")) return `blob:${rawUrl}`;
    try {
      const url = new URL(rawUrl, location.href);
      const host = url.hostname.toLowerCase();
      if (host.includes("googlevideo.com") || url.pathname.includes("videoplayback")) {
        return `youtube:${url.searchParams.get("itag") || url.pathname}`;
      }
      if (host.includes("bilivideo.com")) return `bilibili:${url.pathname}`;
      ["range", "rn", "rbuf", "sq", "bytestart", "byteend"].forEach((name) => url.searchParams.delete(name));
      if (/\.(?:m4s|ts|cmfv|cmfa)$/i.test(url.pathname)) {
        url.pathname = mediaSegmentTrackPath(url.pathname);
        ["segment", "seg", "fragment", "frag", "chunk", "part", "start", "end"].forEach((name) => url.searchParams.delete(name));
      }
      return `${url.origin}${url.pathname}?${url.searchParams.toString()}`.slice(0, 800);
    } catch (_) {
      return rawUrl.slice(0, 800);
    }
  }

  function mediaPrimarySource(sources) {
    return ["player", "dom", "performance", "mse", "page"].find((source) => sources.includes(source)) || sources[0] || "page";
  }

  function mediaCandidateFingerprint(candidate) {
    const stable = { ...candidate };
    delete stable.observations;
    delete stable.bytesObserved;
    delete stable.updatedAt;
    return JSON.stringify(stable);
  }

  function addMediaCandidate(raw) {
    if (!state.media.enabled || !raw) return null;
    const url = typeof raw.url === "string" ? safeString(raw.url, 4096) : null;
    const mimeParts = mediaMimeParts(raw.mimeType || mediaUrlMime(url));
    const detectedKind = mediaKind(url, mimeParts.mimeType, raw.kind);
    const groupId = mediaGroupId({ ...raw, url, kind: detectedKind, mimeType: mimeParts.mimeType });
    const previous = state.media.candidates.get(groupId);
    const source = safeString(raw.source || "page", 40);
    const sources = previous && Array.isArray(previous.sources) ? previous.sources.slice() : [];
    if (!sources.includes(source)) sources.push(source);
    const primarySource = mediaPrimarySource(sources);
    const preferRaw = !previous || source === primarySource;
    let kind = detectedKind;
    if (detectedKind === "segment") {
      if (mimeParts.mimeType.startsWith("audio/") || (previous && previous.kind === "audio")) kind = "audio";
      else kind = "video";
    } else if (previous && !preferRaw) {
      kind = previous.kind;
    }
    const httpUrl = Boolean(url && /^https?:/i.test(url));
    const fragmented = Boolean(
      raw.fragmented
      || detectedKind === "segment"
      || /\.(?:m4s|ts|cmfv|cmfa)(?:$|[?#])/i.test(url || "")
      || /[?&]range=/i.test(url || "")
      || (previous && previous.fragmented)
    );
    const separateTrack = Boolean(raw.separateTrack || (previous && previous.separateTrack));
    const ciphered = Boolean(raw.ciphered || (previous && previous.ciphered));
    const encrypted = Boolean(hasMediaDrmMetadata(raw) || (previous && previous.encrypted));
    const observation = raw.observation === true || source === "performance" || source === "mse";
    const chooseText = (rawValue, previousValue, limit) => safeString(
      preferRaw ? (rawValue || previousValue || "") : (previousValue || rawValue || ""),
      limit
    );
    const chooseNumber = (rawValue, previousValue) => Math.max(0, Number(
      preferRaw ? (rawValue || previousValue) : (previousValue || rawValue)
    ) || 0);
    const downloadable = httpUrl
      && ["video", "audio"].includes(kind)
      && !separateTrack
      && !fragmented
      && !ciphered
      && !encrypted
      && raw.downloadable !== false;
    const candidate = {
      id: groupId,
      groupId,
      url: preferRaw ? (url || (previous && previous.url) || null) : ((previous && previous.url) || url || null),
      kind,
      source: primarySource,
      sources,
      site: chooseText(raw.site, previous && previous.site, 40) || "generic",
      mimeType: chooseText(mimeParts.mimeType, previous && previous.mimeType, 180),
      codecs: chooseText(raw.codecs || mimeParts.codecs, previous && previous.codecs, 180),
      width: chooseNumber(raw.width, previous && previous.width),
      height: chooseNumber(raw.height, previous && previous.height),
      fps: chooseText(raw.fps, previous && previous.fps, 40),
      bitrate: chooseNumber(raw.bitrate, previous && previous.bitrate),
      contentLength: chooseText(raw.contentLength, previous && previous.contentLength, 40),
      quality: chooseText(raw.quality, previous && previous.quality, 100),
      title: chooseText(raw.title, previous && previous.title, 180),
      fragmented,
      separateTrack,
      ciphered,
      encrypted,
      downloadable,
      reason: encrypted
        ? "检测到 DRM 或内容保护标记；仅展示元数据，不解析或绕过。"
        : chooseText(raw.reason, previous && previous.reason, 220),
      expiresAt: raw.expiresAt || (url ? mediaExpiry(url) : null) || (previous && previous.expiresAt) || null,
      observations: previous
        ? Math.max(1, Number(previous.observations) || 1) + (observation ? 1 : 0)
        : 1,
      bytesObserved: Math.max(0, Number(previous && previous.bytesObserved) || 0)
        + (observation ? Math.max(0, Number(raw.bytesObserved) || 0) : 0),
      updatedAt: previous ? previous.updatedAt : Date.now(),
    };
    const metadataChanged = !previous || mediaCandidateFingerprint(previous) !== mediaCandidateFingerprint(candidate);
    if (previous && !metadataChanged && !observation) return previous;
    if (previous) candidate.updatedAt = Date.now();
    state.media.candidates.set(groupId, candidate);
    while (state.media.candidates.size > MAX_MEDIA_ITEMS) {
      state.media.candidates.delete(state.media.candidates.keys().next().value);
    }
    state.media.revision += 1;
    return candidate;
  }

  function isLikelyMediaResource(url, initiatorType) {
    const raw = safeString(url || "", 4096).toLowerCase();
    return ["video", "audio"].includes(String(initiatorType || "").toLowerCase())
      || /googlevideo\.com|bilivideo\.com|videoplayback|\.(?:m3u8|mpd|mp4|m4s|webm|flv|ts|m4a|aac|mp3|opus)(?:$|[?#])/i.test(raw);
  }

  function rememberMediaPerformanceKey(key) {
    if (state.media.performanceSeen.has(key)) return false;
    state.media.performanceSeen.add(key);
    while (state.media.performanceSeen.size > MAX_MEDIA_PERFORMANCE_KEYS) {
      state.media.performanceSeen.delete(state.media.performanceSeen.values().next().value);
    }
    return true;
  }

  function collectPerformanceMedia() {
    let entries = [];
    try { entries = performance.getEntriesByType("resource"); } catch (_) {}
    for (const entry of entries) {
      const key = `${entry.name}\n${entry.startTime}`;
      if (!isLikelyMediaResource(entry.name, entry.initiatorType) || !rememberMediaPerformanceKey(key)) continue;
      const mime = mediaUrlMime(entry.name);
      const kind = mediaKind(entry.name, mime);
      addMediaCandidate({
        url: entry.name,
        kind,
        source: "performance",
        mimeType: mime,
        fragmented: kind === "segment" || /[?&]range=/i.test(entry.name),
        bytesObserved: Number(entry.transferSize || entry.encodedBodySize || 0),
        reason: kind === "segment" ? "分片请求已按轨道聚合。" : "来自页面 Resource Timing。",
      });
    }
  }

  function collectMediaElements() {
    document.querySelectorAll("video,audio").forEach((element) => {
      const url = element.currentSrc || element.src || "";
      const kind = element.tagName === "AUDIO" ? "audio" : mediaKind(url, element.getAttribute("type"), "video");
      if (url) {
        addMediaCandidate({
          url,
          kind: url.startsWith("blob:") ? "blob" : kind,
          source: "dom",
          width: element.videoWidth || 0,
          height: element.videoHeight || 0,
          downloadable: !url.startsWith("blob:") && /^https?:/i.test(url),
          reason: url.startsWith("blob:") ? "MSE/blob 播放句柄不可直接下载，请查看对应网络轨道。" : "媒体元素当前资源。",
        });
      } else if (element.srcObject) {
        addMediaCandidate({
          groupId: `stream:${element.tagName.toLowerCase()}`,
          kind: "stream",
          source: "dom",
          downloadable: false,
          reason: "MediaStream 没有可下载 URL。",
        });
      }
    });
  }

  function collectYouTubeMedia() {
    if (!/(^|\.)youtube\.com$/i.test(location.hostname)) return;
    let response = globalThis.ytInitialPlayerResponse || null;
    try {
      const player = document.querySelector("#movie_player");
      if (player && typeof player.getPlayerResponse === "function") response = player.getPlayerResponse() || response;
    } catch (_) {}
    const streaming = response && response.streamingData;
    if (!streaming) return;
    const streamEncrypted = hasMediaDrmMetadata(response, streaming);
    const lists = [
      { values: streaming.formats, separateTrack: false },
      { values: streaming.adaptiveFormats, separateTrack: true },
    ];
    for (const list of lists) {
      if (!Array.isArray(list.values)) continue;
      for (const format of list.values) {
        const parts = mediaMimeParts(format.mimeType);
        const kind = parts.mimeType.startsWith("audio/") ? "audio" : "video";
        const url = typeof format.url === "string" ? format.url : null;
        const ciphered = !url && Boolean(format.signatureCipher || format.cipher);
        const encrypted = streamEncrypted || hasMediaDrmMetadata(format);
        addMediaCandidate({
          groupId: `youtube:${format.itag || kind}:${list.separateTrack ? "adaptive" : "progressive"}`,
          url,
          kind,
          site: "youtube",
          source: "player",
          mimeType: parts.mimeType,
          codecs: parts.codecs,
          width: format.width,
          height: format.height,
          fps: format.fps,
          bitrate: format.averageBitrate || format.bitrate,
          contentLength: format.contentLength,
          quality: format.qualityLabel || format.audioQuality || format.quality,
          title: `itag ${format.itag || "?"}`,
          separateTrack: list.separateTrack,
          ciphered,
          encrypted,
          downloadable: Boolean(url) && !encrypted,
          reason: encrypted
            ? "检测到 DRM 或内容保护标记；仅展示元数据，不解析或绕过。"
            : (ciphered
            ? "该格式使用签名密文；等待实际 signed 网络请求，不尝试破解签名。"
            : (list.separateTrack ? "独立音频或视频轨道，下载后可能需要外部合并。" : "YouTube 播放器直连格式。")),
        });
      }
    }
    if (typeof streaming.hlsManifestUrl === "string") {
      addMediaCandidate({ url: streaming.hlsManifestUrl, kind: "manifest", source: "player", site: "youtube", encrypted: streamEncrypted, downloadable: false, reason: streamEncrypted ? "HLS 清单带有 DRM 或内容保护标记；仅展示地址。" : "HLS 清单可复制到兼容工具。" });
    }
    if (typeof streaming.dashManifestUrl === "string") {
      addMediaCandidate({ url: streaming.dashManifestUrl, kind: "manifest", source: "player", site: "youtube", encrypted: streamEncrypted, downloadable: false, reason: streamEncrypted ? "DASH 清单带有 DRM 或内容保护标记；仅展示地址。" : "DASH 清单可复制到兼容工具。" });
    }
  }

  function collectBilibiliMedia() {
    if (!/(^|\.)bilibili\.com$/i.test(location.hostname)) return;
    const root = globalThis.__playinfo__;
    const data = root && (root.data || root.result || root);
    if (!data || typeof data !== "object") return;
    const dash = data.dash;
    const streamEncrypted = hasMediaDrmMetadata(root, data, dash);
    if (dash && typeof dash === "object") {
      for (const [kind, formats] of [["video", dash.video], ["audio", dash.audio]]) {
        if (!Array.isArray(formats)) continue;
        for (const format of formats) {
          const url = format.baseUrl || format.base_url || (Array.isArray(format.backupUrl) ? format.backupUrl[0] : null) || (Array.isArray(format.backup_url) ? format.backup_url[0] : null);
          const parts = mediaMimeParts(format.mimeType || format.mime_type);
          const encrypted = streamEncrypted || hasMediaDrmMetadata(format);
          addMediaCandidate({
            groupId: `bilibili:${kind}:${format.id || url || formats.indexOf(format)}`,
            url,
            kind,
            site: "bilibili",
            source: "player",
            mimeType: parts.mimeType,
            codecs: format.codecs || parts.codecs,
            width: format.width,
            height: format.height,
            fps: format.frameRate || format.frame_rate,
            bitrate: format.bandwidth,
            quality: safeString(format.id || "", 40),
            separateTrack: true,
            encrypted,
            downloadable: Boolean(url) && !encrypted,
            reason: encrypted
              ? "检测到 DRM 或内容保护标记；仅展示元数据，不解析或绕过。"
              : "Bilibili DASH 独立轨道，音视频可能需要外部合并。",
          });
        }
      }
    }
    if (Array.isArray(data.durl)) {
      data.durl.forEach((item, index) => {
        const url = item && (item.url || (Array.isArray(item.backup_url) ? item.backup_url[0] : null));
        if (!url) return;
        const encrypted = streamEncrypted || hasMediaDrmMetadata(item);
        addMediaCandidate({
          groupId: `bilibili:durl:${index}:${url}`,
          url,
          kind: "video",
          site: "bilibili",
          source: "player",
          contentLength: item.size,
          encrypted,
          downloadable: !encrypted,
          reason: encrypted
            ? "检测到 DRM 或内容保护标记；仅展示元数据，不解析或绕过。"
            : (data.durl.length > 1 ? "分段直连视频，需要按顺序处理。" : "Bilibili 直连视频。"),
          fragmented: data.durl.length > 1,
        });
      });
    }
  }

  function installMediaObserver() {
    if (state.media.observer || typeof PerformanceObserver !== "function") return;
    try {
      state.media.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const key = `${entry.name}\n${entry.startTime}`;
          if (!isLikelyMediaResource(entry.name, entry.initiatorType) || !rememberMediaPerformanceKey(key)) continue;
          const kind = mediaKind(entry.name, mediaUrlMime(entry.name));
          addMediaCandidate({
            url: entry.name,
            kind,
            source: "performance",
            mimeType: mediaUrlMime(entry.name),
            fragmented: kind === "segment" || /[?&]range=/i.test(entry.name),
            bytesObserved: Number(entry.transferSize || entry.encodedBodySize || 0),
            reason: kind === "segment" ? "分片请求已按轨道聚合。" : "实时 Resource Timing 记录。",
          });
        }
      });
      state.media.observer.observe({ type: "resource", buffered: true });
    } catch (_) {
      state.media.observer = null;
    }
  }

  function installMseHooks() {
    const media = state.media;
    if (Object.keys(media.wrappers).length) return;
    try {
      if (globalThis.URL && typeof URL.createObjectURL === "function") {
        media.originals.createObjectURL = URL.createObjectURL;
        media.wrappers.createObjectURL = function webOmniMediaObjectUrl(object) {
          const url = media.originals.createObjectURL.apply(this, arguments);
          if (media.enabled && typeof MediaSource !== "undefined" && object instanceof MediaSource) {
            addMediaCandidate({ url, kind: "blob", source: "mse", downloadable: false, reason: "MediaSource blob 仅是播放句柄。" });
          }
          return url;
        };
        URL.createObjectURL = media.wrappers.createObjectURL;
      }
      if (typeof MediaSource !== "undefined" && MediaSource.prototype && typeof MediaSource.prototype.addSourceBuffer === "function") {
        media.originals.addSourceBuffer = MediaSource.prototype.addSourceBuffer;
        media.wrappers.addSourceBuffer = function webOmniAddSourceBuffer(type) {
          const buffer = media.originals.addSourceBuffer.apply(this, arguments);
          const mime = safeString(type || "", 180);
          media.sourceBufferTypes.set(buffer, mime);
          if (media.enabled) addMediaCandidate({ groupId: `mse:${mime}`, kind: mediaKind("", mime), source: "mse", mimeType: mime, downloadable: false, reason: "MSE SourceBuffer；真实 URL 来自对应网络轨道。" });
          return buffer;
        };
        MediaSource.prototype.addSourceBuffer = media.wrappers.addSourceBuffer;
      }
      if (typeof SourceBuffer !== "undefined" && SourceBuffer.prototype && typeof SourceBuffer.prototype.appendBuffer === "function") {
        media.originals.appendBuffer = SourceBuffer.prototype.appendBuffer;
        media.wrappers.appendBuffer = function webOmniAppendBuffer(data) {
          if (media.enabled) {
            const mime = media.sourceBufferTypes.get(this) || "application/octet-stream";
            addMediaCandidate({ groupId: `mse:${mime}`, kind: mediaKind("", mime), source: "mse", mimeType: mime, bytesObserved: data && data.byteLength, downloadable: false, reason: "MSE 已追加分片；扩展不会保存原始媒体字节。" });
          }
          return media.originals.appendBuffer.apply(this, arguments);
        };
        SourceBuffer.prototype.appendBuffer = media.wrappers.appendBuffer;
      }
    } catch (_) {
      restoreMseHooks();
    }
  }

  function restoreMseHooks() {
    const media = state.media;
    try {
      if (globalThis.URL && media.wrappers.createObjectURL && URL.createObjectURL === media.wrappers.createObjectURL) URL.createObjectURL = media.originals.createObjectURL;
    } catch (_) {}
    try {
      if (typeof MediaSource !== "undefined" && MediaSource.prototype && media.wrappers.addSourceBuffer && MediaSource.prototype.addSourceBuffer === media.wrappers.addSourceBuffer) MediaSource.prototype.addSourceBuffer = media.originals.addSourceBuffer;
    } catch (_) {}
    try {
      if (typeof SourceBuffer !== "undefined" && SourceBuffer.prototype && media.wrappers.appendBuffer && SourceBuffer.prototype.appendBuffer === media.wrappers.appendBuffer) SourceBuffer.prototype.appendBuffer = media.originals.appendBuffer;
    } catch (_) {}
    media.originals = {};
    media.wrappers = {};
    media.sourceBufferTypes = new WeakMap();
  }

  function resetMediaSession(sessionId) {
    state.media.sessionId = safeString(sessionId || `${Date.now()}`, 120);
    state.media.pageUrl = location.href;
    state.media.revision += 1;
    state.media.candidates.clear();
    state.media.performanceSeen.clear();
  }

  function collectMainMedia() {
    collectMediaElements();
    collectPerformanceMedia();
    collectYouTubeMedia();
    collectBilibiliMedia();
  }

  function mediaSnapshot() {
    const candidates = Array.from(state.media.candidates.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    const counts = candidates.reduce((result, item) => {
      result[item.kind] = (result[item.kind] || 0) + 1;
      return result;
    }, {});
    return {
      active: state.media.enabled,
      phase: state.media.enabled ? "monitoring" : "inactive",
      scope: "tab",
      sessionId: state.media.sessionId,
      pageUrl: state.media.pageUrl,
      revision: state.media.revision,
      count: candidates.length,
      reversibleCount: state.media.enabled ? 1 : 0,
      counts,
      candidates,
      updatedAt: Date.now(),
    };
  }

  function mediaSniffer(payload) {
    const action = "WO_MEDIA_SNIFFER";
    const mode = requestedMode(payload, state.media.enabled ? "status" : "enable");
    if (mode === "disable") {
      state.media.enabled = false;
      if (state.media.observer) state.media.observer.disconnect();
      state.media.observer = null;
      restoreMseHooks();
      return success(action, "inactive", mediaSnapshot());
    }
    const nextSessionId = safeString(payload && payload.sessionId || "", 120);
    if (!state.media.enabled || (nextSessionId && nextSessionId !== state.media.sessionId) || state.media.pageUrl !== location.href) {
      resetMediaSession(nextSessionId);
    }
    state.media.enabled = true;
    installMediaObserver();
    installMseHooks();
    collectMainMedia();
    return success(action, "monitoring", mediaSnapshot(), [
      "MSE blob URLs are playback handles and cannot be downloaded directly.",
      "Ciphered or encrypted media is reported without bypassing access controls.",
    ]);
  }

  function youtubeAudio() {
    const action = "YT_EXTRACT_AUDIO";
    if (!/(^|\.)youtube\.com$/i.test(location.hostname)) {
      return failure(action, "UNSUPPORTED_CONTEXT", "This action is available only on youtube.com video pages.");
    }
    const result = mediaSniffer({ mode: "enable", sessionId: `yt-audio:${location.href}` });
    const audio = result.data.candidates
      .filter((item) => item.site === "youtube" && item.kind === "audio")
      .sort((a, b) => b.bitrate - a.bitrate);
    mediaSniffer({ mode: "disable" });
    if (!audio.length) return failure(action, "UNSUPPORTED_CONTEXT", "YouTube audio data is not available yet. Start the video and try again.");
    return success(action, "completed", {
      count: audio.length,
      directCount: audio.filter((item) => item.downloadable).length,
      formats: audio.slice(0, 20),
      best: audio.find((item) => item.downloadable) || audio[0],
    }, [
      "Ciphered formats are reported without attempting signature deciphering.",
      "Returned media URLs are temporary and are subject to YouTube access controls and terms.",
    ]);
  }

  const ACTIONS = Object.freeze({
    DUMP_JS_GLOBALS: dumpJsGlobals,
    HIJACK_EVENTS: eventMonitor,
    INTERCEPT_REQUESTS: requestMonitor,
    BROWSER_FINGERPRINT: browserFingerprint,
    WEBSOCKET_MONITOR: websocketMonitor,
    CANVAS_SPOOF: canvasSpoof,
    PRIVACY_BLOCK_TRACKERS: trackerBlock,
    PRIVACY_FINGERPRINT_PROTECT: fingerprintProtect,
    PRIVACY_WEBRTC_PROTECT: webrtcProtect,
    BREAK_SEALS: breakSeals,
    YT_EXTRACT_AUDIO: youtubeAudio,
    WO_MEDIA_SNIFFER: mediaSniffer,
  });

  async function run(action, payload) {
    if (typeof action !== "string" || !Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
      return failure(safeString(action, 80), "UNSUPPORTED_CONTEXT", "The requested MAIN world action is not registered.");
    }
    try {
      return await ACTIONS[action](payload && typeof payload === "object" ? payload : {});
    } catch (error) {
      return failure(action, "ACTION_FAILED", error && error.message ? error.message : safeString(error, 300));
    }
  }

  function dispose() {
    state.media.enabled = false;
    if (state.media.observer) state.media.observer.disconnect();
    state.media.observer = null;
    restoreMseHooks();
    state.media.candidates.clear();
    state.media.performanceSeen.clear();
    return true;
  }

  const api = Object.freeze({
    version: VERSION,
    actions: Object.freeze(Object.keys(ACTIONS)),
    run,
    dispose,
  });
  Object.defineProperty(globalThis, BRIDGE_KEY, {
    configurable: true,
    enumerable: false,
    value: api,
  });

  globalThis.addEventListener(REQUEST_EVENT, async (event) => {
    let request;
    try {
      request = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail;
    } catch (_) {
      return;
    }
    if (!request || typeof request.id !== "string") return;
    const result = await run(request.action, request.payload);
    globalThis.dispatchEvent(new CustomEvent(RESPONSE_EVENT, {
      detail: JSON.stringify({ id: request.id, result }),
    }));
  });
})();
