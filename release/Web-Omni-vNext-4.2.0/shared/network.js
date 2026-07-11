(function (root) {
  "use strict";

  async function fetchJson(url, options) {
    const config = options && typeof options === "object" ? options : {};
    const timeout = Math.max(0, Number(config.timeout) || 0);
    const externalSignal = config.signal || null;
    const controller = new AbortController();
    let timedOut = false;
    let timer = null;

    const abortFromExternalSignal = () => {
      try { controller.abort(externalSignal.reason); }
      catch (_) { controller.abort(); }
    };
    if (externalSignal) {
      if (externalSignal.aborted) abortFromExternalSignal();
      else externalSignal.addEventListener("abort", abortFromExternalSignal, { once: true });
    }
    if (timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeout);
    }

    const requestInit = { ...config };
    delete requestInit.timeout;
    delete requestInit.signal;
    requestInit.signal = controller.signal;
    if (!Object.prototype.hasOwnProperty.call(requestInit, "credentials")) requestInit.credentials = "omit";
    if (!Object.prototype.hasOwnProperty.call(requestInit, "referrerPolicy")) requestInit.referrerPolicy = "no-referrer";

    try {
      const response = await fetch(String(url), requestInit);
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (error) {
      if (timedOut) throw new Error(`请求超时（${timeout}ms）`);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener("abort", abortFromExternalSignal);
    }
  }

  root.WebOmniNetwork = Object.freeze({ fetchJson });
})(typeof globalThis !== "undefined" ? globalThis : self);
