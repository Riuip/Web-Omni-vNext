(function () {
  "use strict";

  if (window.webOmniActionState) return;
  window.webOmniActionStateInjected = true;

  const registry = window.WebOmniActionRegistry || null;
  const states = new Map();
  const subscribers = new Set();
  const CONTROL_ACTIONS = Object.freeze({
    ACTIVATE_VISUAL_DICTATOR: "OPEN_DICTATOR_DB",
    VAULT_AUTO_SAVE: "OPEN_VAULT",
    INPUT_TM_TOGGLE: "INPUT_TM_SHOW_HISTORY",
    AUDIO_NORMALIZE_TOGGLE: "AUDIO_NORMALIZE_PANEL",
    DOM_MONITOR_ADD: "DOM_MONITOR_PANEL",
  });
  const CONTROL_COPY = Object.freeze({
    disable: { symbol: "\u00d7", label: "关闭" },
    stop: { symbol: "\u25a0", label: "停止" },
    undo: { symbol: "\u21b6", label: "撤销" },
    restoreAll: { symbol: "\u27f2", label: "全部恢复" },
    manage: { symbol: "\u22ef", label: "管理" },
  });
  const PHASE_COPY = Object.freeze({
    active: "运行中",
    enabled: "已开启",
    monitoring: "监控中",
    picking: "等待选择",
    selecting: "等待选择",
    recoverable: "可恢复",
    starting: "正在开启",
    stopping: "正在关闭",
    error: "操作失败",
  });
  const SCOPE_COPY = Object.freeze({
    page: "当前页面",
    tab: "当前标签页",
    global: "全局",
    durable: "持久",
    extension: "扩展",
    system: "系统",
  });
  const DOCK_LAYOUT_STORAGE_KEY = "webOmni.actionDock.layout.v1";
  const DOCK_EDGE_GAP = 8;
  const DOCK_KEYBOARD_STEP = 32;

  function readDockLayout() {
    try {
      const value = JSON.parse(sessionStorage.getItem(DOCK_LAYOUT_STORAGE_KEY) || "null");
      if (!value || typeof value !== "object") return {};
      return {
        side: value.side === "left" ? "left" : "right",
        top: Number.isFinite(Number(value.top)) ? Number(value.top) : null,
        collapsed: Boolean(value.collapsed),
      };
    } catch (_) {
      return {};
    }
  }

  const initialDockLayout = readDockLayout();

  let revision = 0;
  let updatedAt = 0;
  let collapsed = Boolean(initialDockLayout.collapsed);
  let dockSide = initialDockLayout.side || "right";
  let dockTop = initialDockLayout.top;
  let dock = null;
  let header = null;
  let list = null;
  let title = null;
  let toggle = null;
  let toggleIcon = null;
  let toggleCount = null;
  let renderFrame = 0;
  let placementFrame = 0;
  let resizeFrame = 0;
  let dragFrame = 0;
  let dragState = null;
  let suppressToggleClick = false;
  let suppressToggleUntil = 0;

  function entryFor(action) {
    return registry && typeof registry.getAction === "function" ? registry.getAction(action) : null;
  }

  function numeric(value, fallback) {
    return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : fallback;
  }

  function normalizeState(action, patch, previous) {
    const entry = entryFor(action);
    const source = patch && typeof patch === "object" ? patch : {};
    const prior = previous || {};
    const active = source.active === undefined ? Boolean(prior.active) : Boolean(source.active);
    const reversibleCount = numeric(source.reversibleCount, numeric(prior.reversibleCount, 0));
    return {
      action,
      active,
      phase: String(source.phase || prior.phase || (active ? "active" : "inactive")),
      scope: String(source.scope || prior.scope || (entry && entry.scope) || "page"),
      count: numeric(source.count, numeric(prior.count, 0)),
      reversibleCount,
      revision: numeric(source.revision, numeric(prior.revision, revision + 1)),
      updatedAt: numeric(source.updatedAt, Date.now()),
      error: source.error ? String(source.error) : (source.error === null ? null : (prior.error || null)),
    };
  }

  function cloneState(state) {
    return { ...state };
  }

  function snapshot() {
    return {
      tabId: Number.isInteger(window.__webOmniTabId) ? window.__webOmniTabId : null,
      revision,
      updatedAt,
      actions: Array.from(states.values(), cloneState),
    };
  }

  function notify() {
    const value = snapshot();
    for (const listener of subscribers) {
      try {
        listener(value);
      } catch (error) {
        console.warn("[Web-Omni] Action state subscriber failed:", error);
      }
    }
  }

  function publish(action, state) {
    if (!globalThis.chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") return;
    chrome.runtime.sendMessage({
      type: "WO_ACTION_STATE_CHANGED",
      action,
      tabId: Number.isInteger(window.__webOmniTabId) ? window.__webOmniTabId : null,
      state: state ? cloneState(state) : null,
    }).catch(() => {});
  }

  function scheduleRender() {
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      renderDock();
    });
  }

  function set(action, patch) {
    if (typeof action !== "string" || !action) return null;
    const entry = entryFor(action);
    if (!entry || !entry.stateful) return null;
    const previous = states.get(action);
    const next = normalizeState(action, patch, previous);
    revision = Math.max(revision + 1, next.revision);
    updatedAt = Math.max(updatedAt, next.updatedAt);
    next.revision = revision;
    states.set(action, next);
    if (!previous || previous.active !== next.active) collapsed = false;
    scheduleRender();
    notify();
    publish(action, next);
    return cloneState(next);
  }

  function remove(action) {
    if (!states.delete(action)) return false;
    revision += 1;
    updatedAt = Date.now();
    scheduleRender();
    notify();
    publish(action, null);
    return true;
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return function () {};
    subscribers.add(listener);
    try {
      listener(snapshot());
    } catch (_) {}
    return function unsubscribe() {
      subscribers.delete(listener);
    };
  }

  function responseError(response) {
    return response && response.error && response.error.message
      ? response.error.message
      : "操作未完成";
  }

  async function control(action, mode) {
    const current = states.get(action);
    if (!current) return null;
    const manageAction = mode === "manage" ? CONTROL_ACTIONS[action] : null;
    const targetAction = manageAction || action;
    const payload = manageAction ? undefined : { mode };
    states.set(action, normalizeState(action, {
      ...current,
      phase: mode === "disable" || mode === "stop" || mode === "restoreAll" ? "stopping" : current.phase,
      error: null,
    }, current));
    scheduleRender();
    notify();

    try {
      const response = action === "OPEN_SCREEN_RECORDER" && mode === "stop"
        ? await chrome.runtime.sendMessage({ type: "WO_RECORDER_COMMAND", command: "STOP" })
        : await chrome.runtime.sendMessage({
          type: "WO_EXECUTE_ACTION",
          action: targetAction,
          tabId: Number.isInteger(window.__webOmniTabId) ? window.__webOmniTabId : null,
          payload,
        });
      if (!response || response.ok !== true) {
        const failed = normalizeState(action, {
          ...current,
          phase: "error",
          error: responseError(response),
        }, current);
        states.set(action, failed);
        scheduleRender();
        notify();
      }
      return response || null;
    } catch (error) {
      const failed = normalizeState(action, {
        ...current,
        phase: "error",
        error: error && error.message ? error.message : String(error),
      }, current);
      states.set(action, failed);
      scheduleRender();
      notify();
      return null;
    }
  }

  function visibleStates() {
    return Array.from(states.values()).filter((state) => {
      const entry = entryFor(state.action);
      if (!entry || !entry.pageDock) return false;
      if ((state.scope === "durable" || state.scope === "global") && state.phase !== "selecting") {
        return false;
      }
      return state.active
        || state.reversibleCount > 0
        || state.phase === "recoverable"
        || state.phase === "starting"
        || state.phase === "stopping";
    });
  }

  function persistDockLayout() {
    try {
      sessionStorage.setItem(DOCK_LAYOUT_STORAGE_KEY, JSON.stringify({
        side: dockSide,
        top: Number.isFinite(dockTop) ? Math.round(dockTop) : null,
        collapsed,
      }));
    } catch (_) {}
  }

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
  }

  function dockTopLimit(cachedHeight) {
    if (!dock) return DOCK_EDGE_GAP;
    const height = Number.isFinite(cachedHeight)
      ? Math.max(44, cachedHeight)
      : Math.max(44, dock.getBoundingClientRect().height || dock.offsetHeight || 44);
    return Math.max(DOCK_EDGE_GAP, window.innerHeight - height - DOCK_EDGE_GAP);
  }

  function updateDockAccessibility(count) {
    if (!dock || !toggle || !title) return;
    const safeCount = Math.max(0, Number(count) || 0);
    dock.setAttribute("aria-label", "Web-Omni 当前活动，共 " + safeCount + " 项");
    title.textContent = "当前活动 " + safeCount;
    if (toggleCount) toggleCount.textContent = safeCount > 99 ? "99+" : String(safeCount);
    if (toggleIcon) toggleIcon.textContent = dockSide === "left" ? "\u2039" : "\u203a";
    toggle.title = collapsed ? "展开当前活动" : "折叠当前活动";
    toggle.setAttribute("aria-label", toggle.title + "，共 " + safeCount + " 项");
    toggle.setAttribute("aria-expanded", String(!collapsed));
    if (list) {
      list.inert = collapsed;
      list.setAttribute("aria-hidden", String(collapsed));
    }
    if (header) {
      header.tabIndex = collapsed ? -1 : 0;
      header.setAttribute("aria-label", "当前活动标题栏，可拖动，使用 Alt 加方向键移动");
    }
  }

  function applyDockPlacement(shouldPersist) {
    if (!dock || !dock.isConnected) return;
    dock.dataset.side = dockSide;
    dock.dataset.collapsed = String(collapsed);
    if (!Number.isFinite(dockTop)) {
      const height = Math.max(44, dock.getBoundingClientRect().height || dock.offsetHeight || 44);
      dockTop = Math.max(DOCK_EDGE_GAP, window.innerHeight - height - DOCK_EDGE_GAP);
    }
    dockTop = clamp(dockTop, DOCK_EDGE_GAP, dockTopLimit());
    dock.style.setProperty("--wo-action-dock-top", Math.round(dockTop) + "px");
    dock.dataset.positioned = "true";
    updateDockAccessibility(visibleStates().length);
    if (shouldPersist) persistDockLayout();
  }

  function queueDockPlacement(shouldPersist) {
    if (placementFrame) cancelAnimationFrame(placementFrame);
    placementFrame = requestAnimationFrame(() => {
      placementFrame = 0;
      if (dragState && dragState.started) return;
      applyDockPlacement(shouldPersist);
    });
  }

  function setDockCollapsed(nextCollapsed) {
    collapsed = Boolean(nextCollapsed);
    if (dock) {
      dock.dataset.collapsed = String(collapsed);
      updateDockAccessibility(visibleStates().length);
      queueDockPlacement(true);
    } else {
      persistDockLayout();
    }
  }

  function handleDockToggle(event) {
    if (suppressToggleClick || performance.now() < suppressToggleUntil) {
      event.preventDefault();
      event.stopPropagation();
      suppressToggleClick = false;
      suppressToggleUntil = 0;
      return;
    }
    setDockCollapsed(!collapsed);
  }

  function handleDockKeydown(event) {
    if (event.key === "Escape" && dragState) {
      event.preventDefault();
      event.stopPropagation();
      finishDockDrag(null, true);
      return;
    }
    if (!event.altKey || !dock) return;
    let handled = true;
    if (event.key === "ArrowLeft") {
      dockSide = "left";
    } else if (event.key === "ArrowRight") {
      dockSide = "right";
    } else if (event.key === "ArrowUp") {
      dockTop = clamp((Number.isFinite(dockTop) ? dockTop : DOCK_EDGE_GAP) - DOCK_KEYBOARD_STEP, DOCK_EDGE_GAP, dockTopLimit());
    } else if (event.key === "ArrowDown") {
      dockTop = clamp((Number.isFinite(dockTop) ? dockTop : DOCK_EDGE_GAP) + DOCK_KEYBOARD_STEP, DOCK_EDGE_GAP, dockTopLimit());
    } else if (event.key === "Home") {
      dockTop = DOCK_EDGE_GAP;
    } else if (event.key === "End") {
      dockTop = dockTopLimit();
    } else {
      handled = false;
    }
    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
    applyDockPlacement(true);
  }

  function beginDockDrag(event) {
    if (!dock || !header || event.button !== 0 || event.isPrimary === false) return;
    const targetButton = event.target instanceof Element ? event.target.closest("button") : null;
    if (targetButton && (!collapsed || targetButton !== toggle)) return;
    const rect = dock.getBoundingClientRect();
    if (!targetButton) {
      try {
        header.focus({ preventScroll: true });
      } catch (_) {}
    }
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      width: Math.max(44, rect.width || 44),
      height: Math.max(44, rect.height || 44),
      collapsed,
      startSide: dockSide,
      storedTop: dockTop,
      captureTarget: targetButton === toggle ? toggle : header,
      started: false,
    };
    try {
      dragState.captureTarget.setPointerCapture(event.pointerId);
    } catch (_) {}
  }

  function continueDockDrag(event) {
    if (!dragState || dragState.pointerId !== event.pointerId || !dock) return;
    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;
    dragState.lastX = event.clientX;
    dragState.lastY = event.clientY;
    if (!dragState.started) {
      if (Math.hypot(deltaX, deltaY) < 4) return;
      dragState.started = true;
      suppressToggleClick = Boolean(collapsed);
      dock.dataset.dragging = "true";
      dock.classList.add("wo-action-dock-dragging");
    }

    event.preventDefault();
    if (dragFrame) return;
    dragFrame = requestAnimationFrame(() => {
      dragFrame = 0;
      applyDockDragFrame(dragState);
    });
  }

  function applyDockDragFrame(current) {
    if (!current || !current.started || !dock) return;
    const deltaX = current.lastX - current.startX;
    const deltaY = current.lastY - current.startY;
    const overhang = current.collapsed ? 20 : 0;
    const nextLeft = clamp(
      current.startLeft + deltaX,
      -overhang,
      window.innerWidth - current.width + overhang
    );
    dockTop = clamp(current.startTop + deltaY, DOCK_EDGE_GAP, dockTopLimit(current.height));
    dock.style.setProperty("--wo-action-dock-drag-left", Math.round(nextLeft) + "px");
    dock.style.setProperty("--wo-action-dock-top", Math.round(dockTop) + "px");
    dock.dataset.positioned = "true";
  }

  function finishDockDrag(event, cancelled) {
    if (!dragState || (event && event.pointerId != null && dragState.pointerId !== event.pointerId)) return;
    const finished = dragState;
    if (dragFrame) cancelAnimationFrame(dragFrame);
    dragFrame = 0;
    if (finished.started && !cancelled) applyDockDragFrame(finished);
    dragState = null;
    try {
      if (finished.captureTarget && finished.captureTarget.hasPointerCapture(finished.pointerId)) {
        finished.captureTarget.releasePointerCapture(finished.pointerId);
      }
    } catch (_) {}

    if (!dock) return;
    dock.classList.remove("wo-action-dock-dragging");
    delete dock.dataset.dragging;
    dock.style.removeProperty("--wo-action-dock-drag-left");
    if (cancelled) {
      dockSide = finished.startSide;
      dockTop = finished.storedTop;
      suppressToggleClick = false;
      suppressToggleUntil = 0;
      applyDockPlacement(false);
      return;
    }
    if (!finished.started) return;
    dockSide = finished.lastX < window.innerWidth / 2 ? "left" : "right";
    if (finished.collapsed) {
      suppressToggleClick = true;
      suppressToggleUntil = performance.now() + 360;
    }
    applyDockPlacement(true);
    setTimeout(() => {
      if (performance.now() >= suppressToggleUntil) {
        suppressToggleClick = false;
        suppressToggleUntil = 0;
      }
    }, 380);
  }

  function handleDockResize() {
    if (resizeFrame || (dragState && dragState.started)) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      applyDockPlacement(true);
    });
  }

  function ensureDock() {
    if (dock && dock.isConnected) return;
    dock = document.createElement("section");
    dock.id = "web-omni-action-dock";
    dock.className = "wo-command-surface wo-action-dock-entering";
    dock.hidden = true;
    dock.dataset.collapsed = String(collapsed);
    dock.dataset.side = dockSide;
    dock.dataset.positioned = "false";
    dock.setAttribute("role", "region");

    header = document.createElement("header");
    header.className = "wo-action-dock-header";
    header.setAttribute("role", "group");
    header.setAttribute("aria-keyshortcuts", "Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown Alt+Home Alt+End");
    header.addEventListener("keydown", handleDockKeydown);
    header.addEventListener("pointerdown", beginDockDrag);
    header.addEventListener("pointermove", continueDockDrag);
    header.addEventListener("pointerup", (event) => finishDockDrag(event, false));
    header.addEventListener("pointercancel", (event) => finishDockDrag(event, true));
    header.addEventListener("lostpointercapture", (event) => finishDockDrag(event, true));
    const status = document.createElement("span");
    status.className = "wo-action-dock-status";
    status.setAttribute("aria-hidden", "true");
    title = document.createElement("h2");
    title.className = "wo-action-dock-title";
    title.setAttribute("aria-live", "polite");
    toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "wo-action-dock-toggle";
    toggle.setAttribute("aria-controls", "web-omni-action-dock-list");
    toggleIcon = document.createElement("span");
    toggleIcon.className = "wo-action-dock-toggle-icon";
    toggleIcon.setAttribute("aria-hidden", "true");
    const toggleStatus = document.createElement("span");
    toggleStatus.className = "wo-action-dock-toggle-status";
    toggleStatus.setAttribute("aria-hidden", "true");
    toggleCount = document.createElement("span");
    toggleCount.className = "wo-action-dock-toggle-count";
    toggleCount.setAttribute("aria-hidden", "true");
    toggle.append(toggleIcon, toggleStatus, toggleCount);
    toggle.addEventListener("click", handleDockToggle);
    header.append(status, title, toggle);

    list = document.createElement("div");
    list.id = "web-omni-action-dock-list";
    list.className = "wo-action-dock-list";
    list.setAttribute("role", "list");
    dock.append(header, list);
    (document.body || document.documentElement).appendChild(dock);
    const createdDock = dock;
    requestAnimationFrame(() => {
      if (!createdDock.isConnected) return;
      createdDock.classList.remove("wo-action-dock-entering");
      applyDockPlacement(false);
    });
  }

  function actionMeta(state) {
    if (state.error) return state.error;
    const phase = PHASE_COPY[state.phase] || (state.active ? "运行中" : "已停止");
    const parts = [phase, SCOPE_COPY[state.scope] || state.scope];
    if (state.reversibleCount > 0) parts.push(state.reversibleCount + " 项可恢复");
    else if (state.count > 0) parts.push(state.count + " 项");
    return parts.filter(Boolean).join(" · ");
  }

  function createControl(action, mode, state) {
    const copy = CONTROL_COPY[mode];
    if (!copy) return null;
    if (mode === "disable" && !state.active) return null;
    if (mode === "undo" && state.reversibleCount < 1) return null;
    if (mode === "restoreAll" && state.reversibleCount < 1 && !state.active) return null;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wo-action-dock-control";
    button.dataset.action = action;
    button.dataset.control = mode;
    button.textContent = copy.symbol;
    const controlLabel = action === "PRIVACY_BLOCK_TRACKERS" && mode === "disable"
      ? "停止拦截"
      : copy.label;
    button.title = controlLabel;
    const entry = entryFor(action);
    button.setAttribute("aria-label", controlLabel + (entry ? entry.label : action));
    button.disabled = state.phase === "starting" || state.phase === "stopping";
    button.addEventListener("click", () => control(action, mode));
    return button;
  }

  function renderDock() {
    if (!document.documentElement) return;
    const visible = visibleStates();
    if (!visible.length) {
      if (placementFrame) cancelAnimationFrame(placementFrame);
      if (dragFrame) cancelAnimationFrame(dragFrame);
      placementFrame = 0;
      dragFrame = 0;
      dragState = null;
      suppressToggleClick = false;
      suppressToggleUntil = 0;
      if (dock) dock.remove();
      dock = null;
      header = null;
      list = null;
      title = null;
      toggle = null;
      toggleIcon = null;
      toggleCount = null;
      return;
    }

    ensureDock();
    dock.hidden = false;
    dock.dataset.collapsed = String(collapsed);
    updateDockAccessibility(visible.length);
    const fragment = document.createDocumentFragment();

    for (const state of visible) {
      const entry = entryFor(state.action);
      const item = document.createElement("div");
      item.className = "wo-action-dock-item";
      item.setAttribute("role", "listitem");
      const copy = document.createElement("div");
      copy.className = "wo-action-dock-copy";
      const name = document.createElement("span");
      name.className = "wo-action-dock-name";
      name.textContent = entry.label || state.action;
      const meta = document.createElement("span");
      meta.className = "wo-action-dock-meta" + (state.error ? " wo-action-dock-error" : "");
      meta.textContent = actionMeta(state);
      copy.append(name, meta);

      const controls = document.createElement("div");
      controls.className = "wo-action-dock-controls";
      for (const mode of entry.controls || []) {
        const button = createControl(state.action, mode, state);
        if (button) controls.appendChild(button);
      }
      item.append(copy, controls);
      fragment.appendChild(item);
    }
    list.replaceChildren(fragment);
    queueDockPlacement(true);
  }

  function applySnapshot(nextSnapshot) {
    if (!nextSnapshot || !Array.isArray(nextSnapshot.actions)) return;
    const nextUpdatedAt = Math.max(
      numeric(nextSnapshot.updatedAt, 0),
      ...nextSnapshot.actions.map((item) => numeric(item && item.updatedAt, 0))
    );
    const nextRevision = numeric(nextSnapshot.revision, 0);
    if (
      nextUpdatedAt < updatedAt ||
      (nextUpdatedAt === updatedAt && nextRevision && nextRevision < revision)
    ) return;
    const previousVisible = new Set(visibleStates().map((state) => state.action));
    states.clear();
    for (const item of nextSnapshot.actions) {
      if (!item || typeof item.action !== "string") continue;
      states.set(item.action, normalizeState(item.action, item));
    }
    revision = Math.max(revision, nextRevision);
    updatedAt = Math.max(updatedAt, nextUpdatedAt);
    const nextVisible = visibleStates();
    if (nextVisible.some((state) => !previousVisible.has(state.action))) collapsed = false;
    scheduleRender();
    notify();
  }

  async function loadInitialState() {
    if (!globalThis.chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") return;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "WO_EXECUTE_ACTION",
        action: "WO_ACTIVE_ACTIONS_GET",
        tabId: Number.isInteger(window.__webOmniTabId) ? window.__webOmniTabId : null,
      });
      if (response && response.ok && response.data) applySnapshot(response.data);
    } catch (_) {}
  }

  if (globalThis.chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message !== "object") return false;
      if (message.type === "WO_ACTIVE_ACTIONS_UPDATED") {
        if (!Number.isInteger(message.tabId) || !Number.isInteger(window.__webOmniTabId) || message.tabId === window.__webOmniTabId) {
          applySnapshot(message.snapshot);
        }
        return false;
      }
      const syncedAction = message.type === "WO_ACTION_STATE_SYNC"
        ? (message.stateAction || message.action)
        : null;
      if (message.type === "WO_ACTION_STATE_SYNC" && typeof syncedAction === "string") {
        if (message.state) {
          const previous = states.get(syncedAction);
          const incomingUpdatedAt = numeric(message.state.updatedAt, 0);
          const incomingRevision = numeric(message.state.revision, 0);
          if (
            previous && (
              incomingUpdatedAt < previous.updatedAt ||
              (incomingUpdatedAt === previous.updatedAt && incomingRevision && incomingRevision < previous.revision)
            )
          ) return false;
          states.set(syncedAction, normalizeState(syncedAction, message.state, previous));
        } else {
          const previous = states.get(syncedAction);
          const incomingUpdatedAt = numeric(message.updatedAt, 0);
          const incomingRevision = numeric(message.revision, 0);
          if (
            previous && (
              incomingUpdatedAt < previous.updatedAt ||
              (incomingUpdatedAt === previous.updatedAt && incomingRevision && incomingRevision < previous.revision)
            )
          ) return false;
          states.delete(syncedAction);
        }
        revision = Math.max(revision, numeric(message.revision, revision));
        updatedAt = Math.max(updatedAt, numeric(message.updatedAt, updatedAt));
        scheduleRender();
        notify();
        return false;
      }
      if (message.type === "WO_ACTION_STATE_QUERY") {
        sendResponse({ ok: true, data: snapshot() });
        return false;
      }
      return false;
    });
  }

  window.addEventListener("resize", handleDockResize, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", handleDockResize, { passive: true });
  }

  window.webOmniActionState = Object.freeze({
    set,
    remove,
    snapshot,
    subscribe,
    control,
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      loadInitialState();
      scheduleRender();
    }, { once: true });
  } else {
    loadInitialState();
    scheduleRender();
  }
})();
