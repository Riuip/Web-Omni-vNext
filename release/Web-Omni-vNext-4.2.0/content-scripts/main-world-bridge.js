// Web-Omni controlled MAIN world bridge.
// This file contains a fixed action table. It never evaluates caller-provided code.
(function installWebOmniMainWorldBridge() {
  "use strict";

  const BRIDGE_KEY = "__webOmniMainWorld";
  const REQUEST_EVENT = "web-omni-main-world-request";
  const RESPONSE_EVENT = "web-omni-main-world-response";
  const VERSION = "1.0.0";
  const MAX_LOG_ITEMS = 200;

  if (globalThis[BRIDGE_KEY] && globalThis[BRIDGE_KEY].version === VERSION) return;

  const state = {
    events: { enabled: false, original: null, wrapper: null, log: [] },
    network: {
      installed: false,
      monitorEnabled: false,
      trackerEnabled: false,
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
      methodPatches: [],
      propertyPatches: [],
      protectedItems: [],
    },
    webrtc: { enabled: false, properties: [] },
    seals: {
      enabled: false,
      blocker: null,
      observer: null,
      style: null,
      handlerRecords: [],
      seen: new WeakMap(),
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
    const mode = requestedMode(payload, state.network.trackerEnabled ? "disable" : "enable");
    let removedNow = { scripts: 0, pixels: 0 };
    if (mode === "enable") {
      installNetworkHooks();
      state.network.trackerEnabled = true;
      removedNow = removeTrackerNodes(document);
      startTrackerObserver();
    } else if (mode === "status" && state.network.trackerEnabled) {
      removedNow = removeTrackerNodes(document);
    } else if (mode === "disable") {
      state.network.trackerEnabled = false;
      if (state.network.observer) state.network.observer.disconnect();
      state.network.observer = null;
      if (!restoreNetworkHooksIfUnused()) {
        return failure("PRIVACY_BLOCK_TRACKERS", "ACTION_FAILED", "One or more network APIs were changed by another script; automatic restore was incomplete.");
      }
    }

    return success("PRIVACY_BLOCK_TRACKERS", state.network.trackerEnabled ? "active" : "disabled", {
      enabled: state.network.trackerEnabled,
      removedNow,
      removedScripts: state.network.removedScripts,
      removedPixels: state.network.removedPixels,
      blockedRequests: state.network.blockedCount,
      restore: { action: "PRIVACY_BLOCK_TRACKERS", payload: { mode: "disable" } },
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
    const mode = requestedMode(payload, state.fingerprint.enabled ? "disable" : "enable");
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
    } else if (mode === "disable" && state.fingerprint.enabled) {
      const methodsRestored = restoreFingerprintPatches();
      const canvasRestored = disableCanvasConsumer(action);
      if (!methodsRestored || !canvasRestored) {
        return failure(action, "ACTION_FAILED", "One or more fingerprint APIs were changed by another script; automatic restore was incomplete.");
      }
      state.fingerprint.enabled = false;
    }
    return success(action, state.fingerprint.enabled ? "active" : "disabled", {
      enabled: state.fingerprint.enabled,
      protectedItems: state.fingerprint.protectedItems.slice(),
      restore: { action, payload: { mode: "disable" } },
    }, [
      "Page-level overrides reduce consistency of common fingerprint surfaces but cannot provide browser-level anti-fingerprinting guarantees.",
      "Existing values cached by the page before activation remain available to that page.",
    ]);
  }

  function webrtcProtect(payload) {
    const action = "PRIVACY_WEBRTC_PROTECT";
    const mode = requestedMode(payload, state.webrtc.enabled ? "disable" : "enable");
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
    } else if (mode === "disable" && state.webrtc.enabled) {
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
      if (!restored) return failure(action, "ACTION_FAILED", "WebRTC protection could not be fully restored.");
      state.webrtc.enabled = false;
    }
    return success(action, state.webrtc.enabled ? "active" : "disabled", {
      enabled: state.webrtc.enabled,
      restore: { action, payload: { mode: "disable" } },
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

  function youtubeAudio() {
    const action = "YT_EXTRACT_AUDIO";
    if (!/(^|\.)youtube\.com$/i.test(location.hostname)) {
      return failure(action, "UNSUPPORTED_CONTEXT", "This action is available only on youtube.com video pages.");
    }
    let playerResponse = globalThis.ytInitialPlayerResponse || null;
    try {
      const player = document.querySelector("#movie_player");
      if (!playerResponse && player && typeof player.getPlayerResponse === "function") {
        playerResponse = player.getPlayerResponse();
      }
    } catch (_) {}
    const formats = playerResponse && playerResponse.streamingData && playerResponse.streamingData.adaptiveFormats;
    if (!Array.isArray(formats)) {
      return failure(action, "UNSUPPORTED_CONTEXT", "YouTube player data is not available yet. Start the video and try again.");
    }
    const audio = formats
      .filter((format) => typeof format.mimeType === "string" && format.mimeType.includes("audio"))
      .map((format) => ({
        mimeType: safeString(format.mimeType, 160),
        bitrate: Number(format.averageBitrate || format.bitrate || 0),
        contentLength: format.contentLength ? safeString(format.contentLength, 40) : null,
        audioQuality: format.audioQuality ? safeString(format.audioQuality, 80) : null,
        url: typeof format.url === "string" ? format.url : null,
        ciphered: !format.url && Boolean(format.signatureCipher || format.cipher),
      }))
      .sort((a, b) => b.bitrate - a.bitrate);
    if (!audio.length) return failure(action, "UNSUPPORTED_CONTEXT", "No audio formats were found in the current player response.");
    return success(action, "completed", {
      count: audio.length,
      directCount: audio.filter((item) => item.url).length,
      formats: audio.slice(0, 20),
      best: audio.find((item) => item.url) || audio[0],
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

  const api = Object.freeze({
    version: VERSION,
    actions: Object.freeze(Object.keys(ACTIONS)),
    run,
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
