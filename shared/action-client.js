(function (root) {
  "use strict";

  const registry = root.WebOmniActionRegistry;

  class WebOmniActionError extends Error {
    constructor(response) {
      const error = response && response.error;
      super((error && error.message) || "Web-Omni action failed.");
      this.name = "WebOmniActionError";
      this.code = (error && error.code) || "ACTION_FAILED";
      this.response = response || null;
    }
  }

  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }

  async function resolveTabId(tabId) {
    if (Number.isInteger(tabId)) return tabId;
    const tab = await getActiveTab();
    if (!tab || !Number.isInteger(tab.id)) {
      throw new WebOmniActionError({
        error: { code: "INVALID_REQUEST", message: "No active tab is available." },
      });
    }
    return tab.id;
  }

  async function sendAction(action, payload, options) {
    const config = options || {};
    const tabId = await resolveTabId(config.tabId);
    const response = await chrome.runtime.sendMessage({
      type: "WO_EXECUTE_ACTION",
      action,
      tabId,
      payload: payload && typeof payload === "object" ? payload : undefined,
    });

    if (!response || typeof response.ok !== "boolean") {
      return {
        ok: false,
        action,
        tabId,
        status: "failed",
        error: { code: "ACTION_FAILED", message: "The background worker returned no action result." },
      };
    }
    return response;
  }

  async function executeAction(action, payload, options) {
    const response = await sendAction(action, payload, options);
    if (!response.ok) throw new WebOmniActionError(response);
    return response;
  }

  async function executeData(action, payload, options) {
    const response = await executeAction(action, payload, options);
    return response.data;
  }

  function findActionByInternalPage(page) {
    return registry && typeof registry.findActionByInternalPage === "function"
      ? registry.findActionByInternalPage(page)
      : null;
  }

  root.WebOmniActionClient = Object.freeze({
    WebOmniActionError,
    executeAction,
    executeData,
    findActionByInternalPage,
    getActiveTab,
    sendAction,
  });
})(typeof globalThis !== "undefined" ? globalThis : self);
