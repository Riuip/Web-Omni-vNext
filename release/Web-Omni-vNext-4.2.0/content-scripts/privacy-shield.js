// 神经末梢：隐私保护工具 (Privacy Shield)
// 追踪器拦截 · Referrer清除 · WebRTC防护 · 指纹保护 · 隐私评分
(function() {
  if (window.webOmniPrivacyShieldInjected) return;
  window.webOmniPrivacyShieldInjected = true;

  const actionHandlers = {
    PRIVACY_CLEAN_TRACES: (request) => cleanTraces(request.payload || request),
    PRIVACY_BLOCK_TRACKERS: (request) => blockTrackers(request.payload),
    PRIVACY_STRIP_REFERRER: (request) => stripReferrer(request.payload || request),
    PRIVACY_WEBRTC_PROTECT: (request) => webrtcProtect(request.payload),
    PRIVACY_CLEAR_COOKIES: (request) => clearPageCookies(request.payload || request),
    PRIVACY_ANTI_SCREENSHOT: (request) => antiScreenshot(request.payload || request),
    PRIVACY_FINGERPRINT_PROTECT: (request) => fingerprintProtect(request.payload),
    PRIVACY_SCAN: () => privacyScan(),
  };

  const PRIVACY_SCORE_VIEW = 'privacy-score';
  const PRIVACY_FIX_DEFINITIONS = Object.freeze({
    PRIVACY_BLOCK_TRACKERS: {
      label: '启用拦截',
      running: '正在启用…',
      mode: 'enable',
      success: '追踪拦截已启用；已经运行或移除的页面资源无法恢复。',
    },
    PRIVACY_CLEAR_COOKIES: {
      label: '清除 Cookie',
      running: '正在清除…',
      confirmation: '将尝试删除当前页面 JavaScript 可访问的 Cookie。此操作无法撤销，HttpOnly Cookie 不受影响。继续吗？',
    },
    PRIVACY_CLEAN_TRACES: {
      label: '清除站点数据',
      running: '正在清除…',
      confirmation: '将清除当前站点的 localStorage、sessionStorage、页面可访问 Cookie、IndexedDB 和 CacheStorage。此操作无法撤销。继续吗？',
    },
    PRIVACY_STRIP_REFERRER: {
      label: '设置策略',
      running: '正在设置…',
      success: '当前文档和现有链接已设置为不发送 Referrer。',
    },
    PRIVACY_WEBRTC_PROTECT: {
      label: '启用防护',
      running: '正在启用…',
      mode: 'enable',
      success: '当前页面后续创建的 WebRTC 连接已受保护。',
    },
    PRIVACY_FINGERPRINT_PROTECT: {
      label: '启用防护',
      running: '正在启用…',
      mode: 'enable',
      success: '当前页面后续调用的指纹相关 API 已受保护。',
    },
  });

  let privacyScanPromise = null;
  let privacyFixInFlight = false;
  let pendingPrivacyFixFeedback = null;

  function publishState(action, state) {
    const next = { scope: 'page', updatedAt: Date.now(), ...state };
    if (window.webOmniActionState && typeof window.webOmniActionState.set === 'function') {
      window.webOmniActionState.set(action, next);
    } else {
      chrome.runtime.sendMessage({ type: 'WO_ACTION_STATE_CHANGED', action, state: next }).catch(() => {});
    }
    return next;
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.type === 'WO_ACTION_STATE_SYNC') return false;
    const handler = request && actionHandlers[request.action];
    if (!handler) return false;
    Promise.resolve()
      .then(() => handler(request))
      .then((result) => sendResponse(result && typeof result.ok === 'boolean' ? result : {
        ok: true,
        action: request.action,
        status: 'completed',
        data: {},
      }))
      .catch((error) => sendResponse({
        ok: false,
        action: request.action,
        status: 'failed',
        error: { code: 'ACTION_FAILED', message: error && error.message ? error.message : String(error) },
      }));
    return true;
  });

  function runMainWorldAction(action, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'WO_RUN_MAIN_WORLD', action, payload: payload || {} }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          resolve({ ok: false, action, status: 'failed', error: { code: 'MODULE_LOAD_FAILED', message: runtimeError.message } });
          return;
        }
        const result = response && response.result ? response.result : response;
        resolve(result && typeof result.ok === 'boolean' ? result : {
          ok: false,
          action,
          status: 'failed',
          error: { code: 'MODULE_LOAD_FAILED', message: 'MAIN world bridge returned no result.' },
        });
      });
    });
  }

  function showMainWorldError(title, result) {
    const error = result && result.error ? result.error : {};
    showPrivacyPanel(title, `<div style="padding:8px 0;color:#f85149;font-size:12px;"><b>${esc(error.code || 'ACTION_FAILED')}</b><br>${esc(error.message || 'Action failed.')}</div>`);
  }

  function limitationHtml(result) {
    if (!result || !Array.isArray(result.limitations) || result.limitations.length === 0) return '';
    return `<div style="font-size:11px;color:#8b949e;margin-top:12px;">${result.limitations.map(esc).join('<br>')}</div>`;
  }

  // ===== 1. 一键清除痕迹 =====
  async function cleanTraces(payload) {
    const data = {
      localStorage: { found: 0, remaining: 0 },
      sessionStorage: { found: 0, remaining: 0 },
      cookies: { attempted: 0, remaining: 0 },
      indexedDB: { found: 0, deleted: 0 },
      cacheStorage: { found: 0, deleted: 0 },
    };
    const limitations = [];

    try {
      data.localStorage.found = localStorage.length;
      localStorage.clear();
      data.localStorage.remaining = localStorage.length;
    } catch (error) {
      limitations.push('localStorage 无法访问或未能清除。');
    }
    try {
      data.sessionStorage.found = sessionStorage.length;
      sessionStorage.clear();
      data.sessionStorage.remaining = sessionStorage.length;
    } catch (error) {
      limitations.push('sessionStorage 无法访问或未能清除。');
    }

    try {
      data.cookies = expireAccessibleCookies();
      if (data.cookies.remaining > 0) {
        limitations.push(`仍有 ${data.cookies.remaining} 个页面可访问 Cookie；其 Path 或 Domain 可能与当前页面不同。`);
      }
    } catch (error) {
      limitations.push('页面可访问 Cookie 未能完成删除尝试。');
    }

    try {
      if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
        const databases = (await indexedDB.databases()).filter(database => database && database.name);
        data.indexedDB.found = databases.length;
        const deleted = await Promise.all(databases.map(database => deleteIndexedDatabase(database.name)));
        data.indexedDB.deleted = deleted.filter(Boolean).length;
        if (data.indexedDB.deleted < data.indexedDB.found) {
          limitations.push('部分 IndexedDB 数据库正在使用或阻止删除。');
        }
      } else {
        limitations.push('当前浏览器未提供 IndexedDB 数据库枚举能力。');
      }
    } catch (error) {
      limitations.push('IndexedDB 未能完成删除。');
    }

    try {
      if (typeof caches !== 'undefined') {
        const names = await caches.keys();
        data.cacheStorage.found = names.length;
        const deleted = await Promise.all(names.map(name => caches.delete(name)));
        data.cacheStorage.deleted = deleted.filter(Boolean).length;
        if (data.cacheStorage.deleted < data.cacheStorage.found) {
          limitations.push('部分 CacheStorage 缓存未能删除。');
        }
      }
    } catch (error) {
      limitations.push('CacheStorage 无法访问或未能清除。');
    }

    limitations.push('HttpOnly Cookie 和浏览器历史记录不在页面脚本权限范围内。');
    const result = {
      ok: true,
      action: 'PRIVACY_CLEAN_TRACES',
      status: 'completed',
      data,
      limitations,
    };

    if (!payload || payload.source !== PRIVACY_SCORE_VIEW) {
      const rows = [
        `localStorage：发现 ${data.localStorage.found} 项，当前剩余 ${data.localStorage.remaining} 项`,
        `sessionStorage：发现 ${data.sessionStorage.found} 项，当前剩余 ${data.sessionStorage.remaining} 项`,
        `Cookie：尝试删除 ${data.cookies.attempted} 个，当前仍可见 ${data.cookies.remaining} 个`,
        `IndexedDB：发现 ${data.indexedDB.found} 个，确认删除 ${data.indexedDB.deleted} 个`,
        `CacheStorage：发现 ${data.cacheStorage.found} 个，确认删除 ${data.cacheStorage.deleted} 个`,
      ];
      showPrivacyPanel('站点数据清理', `<div style="padding:8px 0;">
        <p style="color:#3fb950;font-size:13px;margin-bottom:12px;">清理操作已完成；以下统计以页面可访问范围为准。</p>
        ${rows.map(row => `<div style="padding:5px 0;font-size:12px;border-bottom:1px solid #21262d;">${esc(row)}</div>`).join('')}
        <p style="color:#d29922;font-size:11px;margin-top:12px;">此操作无法撤销。HttpOnly Cookie 和浏览器历史记录不会被清除。</p>
      </div>`);
    }
    return result;
  }

  function deleteIndexedDatabase(name) {
    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), 1500);
      try {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => finish(true);
        request.onerror = () => finish(false);
        request.onblocked = () => finish(false);
      } catch (error) {
        finish(false);
      }
    });
  }

  function expireAccessibleCookies() {
    const names = Array.from(new Set(
      document.cookie.split(';')
        .map(cookie => cookie.split('=')[0].trim())
        .filter(Boolean)
    ));
    const paths = Array.from(new Set(['/', '', location.pathname]));
    const domain = location.hostname;
    names.forEach(name => {
      paths.forEach(path => {
        document.cookie = `${name}=;expires=Thu,01 Jan 1970 00:00:00 GMT;path=${path}`;
        document.cookie = `${name}=;expires=Thu,01 Jan 1970 00:00:00 GMT;path=${path};domain=${domain}`;
        document.cookie = `${name}=;expires=Thu,01 Jan 1970 00:00:00 GMT;path=${path};domain=.${domain}`;
      });
    });
    const remaining = document.cookie.split(';').filter(cookie => cookie.trim()).length;
    return { attempted: names.length, remaining };
  }

  // ===== 2. 追踪器检测与拦截 =====
  async function blockTrackers(payload) {
    const result = await runMainWorldAction('PRIVACY_BLOCK_TRACKERS', payload);
    const fromScore = payload && payload.source === PRIVACY_SCORE_VIEW;
    if (!result.ok) {
      if (!fromScore) showMainWorldError('追踪器拦截', result);
      return result;
    }
    const data = result.data || {};
    if (!fromScore) showPrivacyPanel('追踪器拦截', `<div style="padding:8px 0;">
      <div style="display:flex;gap:8px;margin-bottom:12px;">
        <div style="flex:1;background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:10px;text-align:center;">
          <div style="font-size:20px;font-weight:700;color:#f85149;">${Number(data.removedScripts || 0)}</div>
          <div style="font-size:11px;color:#8b949e;">已移除脚本/框架</div>
        </div>
        <div style="flex:1;background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:10px;text-align:center;">
          <div style="font-size:20px;font-weight:700;color:#d29922;">${Number(data.removedPixels || 0)}</div>
          <div style="font-size:11px;color:#8b949e;">已移除像素</div>
        </div>
        <div style="flex:1;background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:10px;text-align:center;">
          <div style="font-size:20px;font-weight:700;color:#3fb950;">${Number(data.blockedRequests || 0)}</div>
          <div style="font-size:11px;color:#8b949e;">已阻止请求</div>
        </div>
      </div>
      <p style="color:${data.enabled ? '#3fb950' : '#8b949e'};font-size:12px;">${data.enabled ? '页面级追踪拦截已启用' : '页面级追踪拦截已恢复'}</p>
      ${limitationHtml(result)}
    </div>`);
    return result;
  }

  // ===== 3. Referrer 清除 =====
  function stripReferrer(payload) {
    let meta = document.querySelector('meta[name="referrer"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'referrer'; document.head.appendChild(meta); }
    meta.content = 'no-referrer';

    let count = 0;
    document.querySelectorAll('a[href]').forEach(a => {
      if (!a.rel.includes('noreferrer')) {
        a.rel = (a.rel ? a.rel + ' ' : '') + 'noreferrer';
        count++;
      }
    });
    if ((!payload || payload.source !== PRIVACY_SCORE_VIEW) && window.webOmniShowToast) {
      window.webOmniShowToast(`Referrer 已清除，${count} 个链接已设为 no-referrer`, 'success');
    }
    return {
      ok: true,
      action: 'PRIVACY_STRIP_REFERRER',
      status: 'completed',
      data: { updatedLinks: count, policy: 'no-referrer' },
    };
  }

  // ===== 4. WebRTC 泄露防护 =====
  async function webrtcProtect(payload) {
    const result = await runMainWorldAction('PRIVACY_WEBRTC_PROTECT', payload);
    const fromScore = payload && payload.source === PRIVACY_SCORE_VIEW;
    if (!result.ok) {
      if (!fromScore) showMainWorldError('WebRTC 防护', result);
      return result;
    }
    if (!fromScore) showPrivacyPanel('WebRTC 防护', `<div style="padding:8px 0;">
      <p style="color:${result.data.enabled ? '#3fb950' : '#8b949e'};font-size:13px;margin-bottom:8px;">${result.data.enabled ? '新建 RTCPeerConnection 已在当前页面禁用' : 'WebRTC 页面覆盖已恢复'}</p>
      ${limitationHtml(result)}
    </div>`);
    return result;
  }

  // ===== 5. 清除 Cookie =====
  function clearPageCookies(payload) {
    const data = expireAccessibleCookies();
    if ((!payload || payload.source !== PRIVACY_SCORE_VIEW) && window.webOmniShowToast) {
      window.webOmniShowToast(
        `已尝试删除 ${data.attempted} 个页面可访问 Cookie，当前仍可见 ${data.remaining} 个；HttpOnly Cookie 不在页面权限范围内`,
        data.remaining ? 'warn' : 'success'
      );
    }
    return {
      ok: true,
      action: 'PRIVACY_CLEAR_COOKIES',
      status: 'completed',
      data,
      limitations: [
        'Cookie 删除无法撤销。',
        'HttpOnly Cookie 以及其他 Path 或 Domain 下不可访问的 Cookie 不在页面脚本权限范围内。',
      ],
    };
  }

  // ===== 6. 防截图 =====
  let antiScreenshotEnabled = false;
  let antiKeyHandler = null;
  let antiVisibilityHandler = null;
  let antiBlurTimer = null;
  let originalBodyFilter = null;

  function restoreBodyFilter() {
    if (!document.body || !originalBodyFilter) return;
    const current = document.body.style.getPropertyValue('filter');
    if (current !== 'blur(20px)' && current !== 'blur(30px)') return;
    if (originalBodyFilter.value) {
      document.body.style.setProperty('filter', originalBodyFilter.value, originalBodyFilter.priority || '');
    } else {
      document.body.style.removeProperty('filter');
    }
  }

  function antiScreenshotResult(status) {
    return {
      ok: true,
      action: 'PRIVACY_ANTI_SCREENSHOT',
      status,
      data: publishState('PRIVACY_ANTI_SCREENSHOT', {
        active: antiScreenshotEnabled,
        phase: antiScreenshotEnabled ? 'active' : 'inactive',
        count: antiScreenshotEnabled ? 1 : 0,
        reversibleCount: antiScreenshotEnabled ? 1 : 0,
      }),
    };
  }

  function antiScreenshot(payload) {
    const mode = payload && payload.mode;
    if (mode === 'status') return antiScreenshotResult(antiScreenshotEnabled ? 'active' : 'inactive');
    const enable = mode === 'enable' || (mode !== 'disable' && !antiScreenshotEnabled);
    if (!enable) {
      if (antiKeyHandler) document.removeEventListener('keydown', antiKeyHandler, true);
      if (antiVisibilityHandler) document.removeEventListener('visibilitychange', antiVisibilityHandler);
      if (antiBlurTimer) clearTimeout(antiBlurTimer);
      document.getElementById('wo-anti-ss')?.remove();
      restoreBodyFilter();
      antiScreenshotEnabled = false;
      window._woAntiSS = false;
      antiKeyHandler = null;
      antiVisibilityHandler = null;
      antiBlurTimer = null;
      originalBodyFilter = null;
      if (window.webOmniShowToast) window.webOmniShowToast('页面遮挡已关闭', 'info');
      return antiScreenshotResult('inactive');
    }
    if (antiScreenshotEnabled) return antiScreenshotResult('active');
    antiScreenshotEnabled = true;
    window._woAntiSS = true;
    originalBodyFilter = {
      value: document.body.style.getPropertyValue('filter'),
      priority: document.body.style.getPropertyPriority('filter'),
    };

    const style = document.createElement('style');
    style.id = 'wo-anti-ss';
    style.textContent = `@media print { body { display: none !important; } } body { -webkit-user-select: none; user-select: none; }`;
    document.head.appendChild(style);

    antiKeyHandler = function woAntiKey(e) {
      if (e.key === 'PrintScreen' || (e.ctrlKey && e.key === 'p')) {
        e.preventDefault();
        document.body.style.setProperty('filter', 'blur(30px)', 'important');
        if (antiBlurTimer) clearTimeout(antiBlurTimer);
        antiBlurTimer = setTimeout(() => {
          if (antiScreenshotEnabled) restoreBodyFilter();
        }, 2000);
      }
    };
    document.addEventListener('keydown', antiKeyHandler, true);

    antiVisibilityHandler = function woAntiVisibility() {
      if (document.hidden && antiScreenshotEnabled) {
        document.body.style.setProperty('filter', 'blur(20px)', 'important');
      } else {
        restoreBodyFilter();
      }
    };
    document.addEventListener('visibilitychange', antiVisibilityHandler);

    if (window.webOmniShowToast) window.webOmniShowToast('页面遮挡已开启；无法阻止操作系统或外部设备截图', 'success');
    return antiScreenshotResult('active');
  }

  // ===== 7. 指纹保护 (Canvas + WebGL + AudioContext) =====
  async function fingerprintProtect(payload) {
    const result = await runMainWorldAction('PRIVACY_FINGERPRINT_PROTECT', payload);
    const fromScore = payload && payload.source === PRIVACY_SCORE_VIEW;
    if (!result.ok) {
      if (!fromScore) showMainWorldError('指纹保护', result);
      return result;
    }
    const items = result.data.protectedItems || [];
    if (!fromScore) showPrivacyPanel('指纹保护', `<div style="padding:8px 0;">
      <p style="color:${result.data.enabled ? '#3fb950' : '#8b949e'};font-size:13px;margin-bottom:12px;">${result.data.enabled ? '页面级指纹覆盖已启用' : '页面级指纹覆盖已恢复'}</p>
      ${items.map(item => `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:12px;border-bottom:1px solid #21262d;"><span style="color:#3fb950;">●</span> ${esc(item)}</div>`).join('')}
      ${limitationHtml(result)}
    </div>`);
    return result;
  }

  // ===== 8. 隐私评分扫描 =====
  function privacyScan() {
    if (privacyScanPromise) return privacyScanPromise;
    privacyScanPromise = performPrivacyScan().finally(() => {
      privacyScanPromise = null;
    });
    return privacyScanPromise;
  }

  async function performPrivacyScan() {
    const fixFeedback = pendingPrivacyFixFeedback;
    pendingPrivacyFixFeedback = null;
    let score = 100;
    const risks = [];
    const [webrtcState, fingerprintState] = await Promise.all([
      runMainWorldAction('PRIVACY_WEBRTC_PROTECT', { mode: 'status' }),
      runMainWorldAction('PRIVACY_FINGERPRINT_PROTECT', { mode: 'status' }),
    ]);

    // 检测追踪脚本
    const trackerDomains = ['google-analytics.com','googletagmanager.com','doubleclick.net','facebook.net','hotjar.com','mixpanel.com','clarity.ms','cnzz.com','51.la','umeng.com','baidu.com/hm.js'];
    const scripts = document.querySelectorAll('script[src]');
    let trackerCount = 0;
    scripts.forEach(s => {
      if (trackerDomains.some(d => (s.src || '').includes(d))) trackerCount++;
    });
    if (trackerCount > 0) { score -= trackerCount * 8; risks.push({ level: 'high', text: `检测到 ${trackerCount} 个追踪脚本`, fix: 'PRIVACY_BLOCK_TRACKERS' }); }

    // 检查 Cookie 数量
    const cookieCount = document.cookie.split(';').filter(c => c.trim()).length;
    if (cookieCount > 10) {
      score -= 10;
      risks.push({
        level: 'medium',
        text: `${cookieCount} 个页面可访问 Cookie；删除无法撤销，HttpOnly Cookie 不在检测范围内`,
        fix: 'PRIVACY_CLEAR_COOKIES',
      });
    } else if (cookieCount > 0) {
      score -= 3;
      risks.push({
        level: 'low',
        text: `${cookieCount} 个页面可访问 Cookie；删除无法撤销`,
        fix: 'PRIVACY_CLEAR_COOKIES',
      });
    }

    // 检查 localStorage
    const storageCount = localStorage.length;
    if (storageCount > 20) {
      score -= 8;
      risks.push({
        level: 'medium',
        text: `localStorage 存储 ${storageCount} 项；清理会同时删除其他当前站点数据且无法撤销`,
        fix: 'PRIVACY_CLEAN_TRACES',
      });
    } else if (storageCount > 0) {
      score -= 2;
      risks.push({
        level: 'low',
        text: `localStorage 存储 ${storageCount} 项；站点数据清理无法撤销`,
        fix: 'PRIVACY_CLEAN_TRACES',
      });
    }

    // 检查 Referrer
    const referrerMeta = document.querySelector('meta[name="referrer"]');
    if (!referrerMeta || referrerMeta.content !== 'no-referrer') {
      score -= 5; risks.push({ level: 'low', text: 'Referrer 策略未设置为 no-referrer', fix: 'PRIVACY_STRIP_REFERRER' });
    }

    // 追踪像素
    const pixels = document.querySelectorAll('img[width="1"],img[height="1"]');
    if (pixels.length > 0) { score -= pixels.length * 5; risks.push({ level: 'medium', text: `${pixels.length} 个追踪像素`, fix: 'PRIVACY_BLOCK_TRACKERS' }); }

    // WebRTC
    if (!(webrtcState.ok && webrtcState.data && webrtcState.data.enabled)) {
      score -= 5; risks.push({ level: 'low', text: 'WebRTC 未禁用 (可能泄露真实 IP)', fix: 'PRIVACY_WEBRTC_PROTECT' });
    }

    // 指纹保护
    if (!(fingerprintState.ok && fingerprintState.data && fingerprintState.data.enabled)) {
      score -= 5; risks.push({ level: 'low', text: '浏览器指纹未保护', fix: 'PRIVACY_FINGERPRINT_PROTECT' });
    }

    score = Math.max(0, Math.min(100, score));

    // 评分颜色
    let scoreColor = '#3fb950';
    let scoreLabel = '优秀';
    if (score < 80) { scoreColor = '#58a6ff'; scoreLabel = '良好'; }
    if (score < 60) { scoreColor = '#d29922'; scoreLabel = '一般'; }
    if (score < 40) { scoreColor = '#f85149'; scoreLabel = '较差'; }

    renderPrivacyScorePanel({ score, scoreColor, scoreLabel, risks }, fixFeedback);
    return { ok: true, action: 'PRIVACY_SCAN', status: 'completed', data: { score, riskCount: risks.length, risks } };
  }

  function renderPrivacyScorePanel(model, fixFeedback) {
    const riskHTML = model.risks.map(risk => {
      const levelColor = risk.level === 'high' ? '#f85149' : risk.level === 'medium' ? '#d29922' : '#8b949e';
      const levelLabel = risk.level === 'high' ? '高危' : risk.level === 'medium' ? '中危' : '低危';
      const definition = PRIVACY_FIX_DEFINITIONS[risk.fix] || { label: '处理', running: '处理中…' };
      const title = definition.confirmation || definition.success || `执行 ${definition.label}`;
      return `<div style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px solid #21262d;">
        <span style="flex:0 0 auto;font-size:10px;padding:1px 6px;border-radius:10px;background:${levelColor}22;color:${levelColor};border:1px solid ${levelColor}44;">${levelLabel}</span>
        <span style="flex:1;min-width:0;font-size:12px;line-height:1.5;color:#c9d1d9;">${esc(risk.text)}</span>
        <button class="wo-fix-btn" type="button" data-action="${esc(risk.fix)}" data-state="idle" title="${esc(title)}"
          style="flex:0 0 auto;min-width:70px;font-size:11px;padding:4px 8px;background:#21262d;border:1px solid #30363d;color:#58a6ff;border-radius:4px;cursor:pointer;">${esc(definition.label)}</button>
      </div>`;
    }).join('');

    const relatedRiskRemains = Boolean(
      fixFeedback && model.risks.some(risk => risk.fix === fixFeedback.action)
    );
    const feedbackText = fixFeedback
      ? (relatedRiskRemains
        ? `${fixFeedback.message} 重新扫描后仍检测到相关风险；可能有已执行内容无法撤销，或部分数据超出页面权限。`
        : `${fixFeedback.message} 评分、风险数量和列表已更新。`)
      : '';
    const feedbackColor = relatedRiskRemains ? '#d29922' : '#3fb950';

    const panel = showPrivacyPanel('隐私评分', `<div style="padding:8px 0;">
      <div style="text-align:center;margin-bottom:16px;">
        <div style="font-size:48px;font-weight:700;color:${model.scoreColor};">${model.score}</div>
        <div style="font-size:13px;color:${model.scoreColor};">${model.scoreLabel}</div>
      </div>
      <div style="font-size:12px;color:#8b949e;margin-bottom:8px;">检测到 ${model.risks.length} 个风险项：</div>
      ${model.risks.length > 0 ? riskHTML : '<p style="color:#3fb950;font-size:12px;">未检测到当前页面可识别的隐私风险。</p>'}
      <div class="wo-privacy-fix-status" role="status" aria-live="polite" style="min-height:18px;margin-top:10px;font-size:11px;color:${fixFeedback ? feedbackColor : '#8b949e'};">${esc(feedbackText)}</div>
    </div>`, null, { view: PRIVACY_SCORE_VIEW, reuse: true });
    bindPrivacyScorePanel(panel);
  }

  function bindPrivacyScorePanel(panel) {
    if (!panel || panel.__webOmniPrivacyScoreBound) return;
    panel.__webOmniPrivacyScoreBound = true;
    panel.addEventListener('click', event => {
      const button = event.target.closest('.wo-fix-btn');
      if (!button || !panel.contains(button)) return;
      handlePrivacyFix(panel, button).catch(error => {
        console.warn('[WO Privacy] Fix action failed:', error);
      });
    });
  }

  async function handlePrivacyFix(panel, button) {
    if (privacyFixInFlight || !panel.isConnected) return;
    const action = button.dataset.action;
    const definition = PRIVACY_FIX_DEFINITIONS[action];
    if (!definition) return;
    if (definition.confirmation && !window.confirm(definition.confirmation)) return;

    privacyFixInFlight = true;
    const status = panel.querySelector('.wo-privacy-fix-status');
    const buttons = Array.from(panel.querySelectorAll('.wo-fix-btn'));
    buttons.forEach(item => { item.disabled = true; });
    setPrivacyFixButtonState(button, 'running', definition.running);
    if (status) {
      status.style.color = '#8b949e';
      status.textContent = definition.running.replace('…', '') + '，请稍候。';
    }

    try {
      const message = { action, source: PRIVACY_SCORE_VIEW };
      if (definition.mode) message.mode = definition.mode;
      const response = await chrome.runtime.sendMessage(message);
      if (!response || response.ok !== true) {
        const error = response && response.error;
        throw new Error(
          typeof error === 'string'
            ? error
            : (error && error.message ? error.message : '后台未返回成功结果。')
        );
      }

      const successMessage = privacyFixSuccessMessage(action, definition, response);
      setPrivacyFixButtonState(button, 'success', '已处理');
      if (status) {
        status.style.color = '#3fb950';
        status.textContent = successMessage + ' 正在重新扫描…';
      }
      await new Promise(resolve => setTimeout(resolve, 500));
      if (panel.isConnected) {
        pendingPrivacyFixFeedback = { action, message: successMessage };
        await privacyScan();
      }
    } catch (error) {
      setPrivacyFixButtonState(button, 'error', '重试');
      buttons.forEach(item => { item.disabled = false; });
      if (status && panel.isConnected) {
        status.style.color = '#f85149';
        status.textContent = error && error.message ? error.message : '处理失败，请重试。';
      }
    } finally {
      privacyFixInFlight = false;
    }
  }

  function setPrivacyFixButtonState(button, state, label) {
    button.dataset.state = state;
    button.textContent = label;
    button.setAttribute('aria-busy', state === 'running' ? 'true' : 'false');
    if (state === 'running') {
      button.style.color = '#d29922';
      button.style.borderColor = '#6e5420';
      button.style.cursor = 'wait';
    } else if (state === 'success') {
      button.style.color = '#3fb950';
      button.style.borderColor = '#246b3b';
      button.style.cursor = 'default';
    } else if (state === 'error') {
      button.style.color = '#f85149';
      button.style.borderColor = '#7a2f33';
      button.style.cursor = 'pointer';
      button.disabled = false;
    }
  }

  function privacyFixSuccessMessage(action, definition, response) {
    const data = response && response.data && typeof response.data === 'object' ? response.data : {};
    if (action === 'PRIVACY_CLEAR_COOKIES') {
      return `已尝试删除 ${Number(data.attempted) || 0} 个页面可访问 Cookie，当前仍可见 ${Number(data.remaining) || 0} 个；操作无法撤销，HttpOnly Cookie 不受影响。`;
    }
    if (action === 'PRIVACY_CLEAN_TRACES') {
      return '当前站点可访问数据已执行清理；操作无法撤销，未能删除的项目会继续显示在扫描结果中。';
    }
    return definition.success || '处理已完成。';
  }

  // ===== 通用面板 =====
  function showPrivacyPanel(title, html, onMount, options) {
    const config = options && typeof options === 'object' ? options : {};
    let existing = document.getElementById('wo-privacy-panel');
    if (
      existing &&
      config.reuse &&
      existing.dataset.view === String(config.view || '') &&
      existing.dataset.closing !== 'true'
    ) {
      const titleElement = existing.querySelector('.wo-privacy-panel-title');
      const bodyElement = existing.querySelector('.wo-privacy-panel-body');
      if (titleElement) titleElement.textContent = title;
      if (bodyElement) bodyElement.innerHTML = html;
      if (onMount) onMount(existing);
      return existing;
    }
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'wo-privacy-panel';
    panel.dataset.view = String(config.view || '');
    panel.style.cssText = `position:fixed;top:0;right:0;width:380px;height:100vh;z-index:2147483646;
      background:#161b22;border-left:1px solid #30363d;overflow-y:auto;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#c9d1d9;
      transform:translateX(100%);transition:transform 0.25s ease;`;
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #21262d;position:sticky;top:0;background:#161b22;z-index:2;">
        <span class="wo-privacy-panel-title" style="font-size:14px;font-weight:600;color:#e6edf3;">${esc(title)}</span>
        <button id="wo-pp-close" style="background:#21262d;border:1px solid #30363d;color:#8b949e;padding:3px 8px;border-radius:6px;cursor:pointer;font-size:12px;">✕</button>
      </div>
      <div class="wo-privacy-panel-body" style="padding:12px 16px;">${html}</div>
    `;
    document.body.appendChild(panel);
    requestAnimationFrame(() => requestAnimationFrame(() => panel.style.transform = 'translateX(0)'));
    panel.querySelector('#wo-pp-close').onclick = () => {
      panel.dataset.closing = 'true';
      panel.style.transform = 'translateX(100%)';
      setTimeout(() => panel.remove(), 250);
    };
    if (onMount) {
      setTimeout(() => {
        if (panel.isConnected) onMount(panel);
      }, 50);
    }
    return panel;
  }

  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
})();
