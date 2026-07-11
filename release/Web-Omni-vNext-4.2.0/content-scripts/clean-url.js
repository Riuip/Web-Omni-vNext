// Web-Omni: 智能链接脱水机 (Clean URL Copier)
// 一键去除 URL 中的追踪/归因参数，只保留核心链接
(function() {
  if (window.webOmniCleanUrlInjected) return;
  window.webOmniCleanUrlInjected = true;

  // 通用追踪参数黑名单 (80+)
  const TRACKING_PARAMS = [
    // Google Analytics / Ads
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'utm_id', 'utm_cid', '_ga', '_gl', '_gac', 'gclid', 'gclsrc', 'dclid',
    // Facebook
    'fbclid', 'fb_action_ids', 'fb_action_types', 'fb_source', 'fb_ref',
    // 字节系
    'tt_from', 'tt_medium', 'isappinstalled', 'enter_from', 'launch_from',
    // 淘宝/天猫
    'spm', 'scm', 'pvid', 'algo_pvid', 'algo_expid', 'bxsign', 'search_radio',
    'aff_platform', 'aff_trace_key', 'sk', 'unid', 'sourceType',
    // 京东
    'cu', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term',
    // 拼多多
    'share_uin', 'refer_share_id', 'refer_share_uin', 'refer_share_channel',
    // 小红书
    'share_source', 'app_platform', 'app_version', 'share_from_user_hidden',
    'xhsshare', 'appuid', 'apptime', 'share_id',
    // B站
    'vd_source', 'seid', 'spm_id_from', 'from_source', 'from_spmid',
    'share_source', 'share_medium', 'share_plat', 'share_session_id', 'share_tag',
    'unique_k', 'bsource', 'is_story_h5',
    // 知乎
    'utm_psn', 'utm_oi',
    // 微博
    'from', 'wfr', 'sudaref', 'display', 'retcode',
    // 通用
    'ref', 'ref_', 'referrer', 'source', 'origin_source',
    'click_id', 'track_id', 'trace_id', 'request_id', 'req_id',
    'abtest', 'ab_sr', 'seo_rcmd', 'plan_no',
    'wechatShareId', 'isappinstalled', 'from_scene',
    'channel', 'subchannel', 'chn',
    'callback', 'jsonp', '_', 'timestamp', 'nonce',
    'pos', 'srcid', 'biz_id', 'pgc_id',
  ];

  // 用前缀匹配的模式
  const TRACKING_PREFIXES = [
    'utm_', 'spm', 'scm', 'algo_', 'share_', 'ref_', 'track_', 'trace_',
    'aff_', 'fb_', 'tt_', 'from_', 'refer_',
  ];

  // 平台特化清理规则
  const PLATFORM_RULES = {
    // 淘宝: 只保留 id
    'item.taobao.com': (url) => {
      const id = url.searchParams.get('id');
      if (id) return url.origin + url.pathname + '?id=' + id;
      return null;
    },
    'detail.tmall.com': (url) => {
      const id = url.searchParams.get('id');
      if (id) return url.origin + url.pathname + '?id=' + id;
      return null;
    },
    // B站: 只保留 /video/BVxxx
    'www.bilibili.com': (url) => {
      const match = url.pathname.match(/^\/video\/(BV[a-zA-Z0-9]+)/);
      if (match) return 'https://www.bilibili.com/video/' + match[1];
      return null;
    },
    // 知乎
    'www.zhihu.com': (url) => {
      return url.origin + url.pathname;
    },
    'zhuanlan.zhihu.com': (url) => {
      return url.origin + url.pathname;
    },
    // 小红书
    'www.xiaohongshu.com': (url) => {
      const match = url.pathname.match(/^\/explore\/([a-f0-9]+)/);
      if (match) return 'https://www.xiaohongshu.com/explore/' + match[1];
      return null;
    },
    // 京东: 只保留商品路径
    'item.jd.com': (url) => {
      return url.origin + url.pathname;
    },
    // 微博
    'weibo.com': (url) => {
      return url.origin + url.pathname;
    },
    'm.weibo.cn': (url) => {
      return url.origin + url.pathname;
    },
  };

  function cleanUrl(rawUrl) {
    let url;
    try { url = new URL(rawUrl); } catch(e) { return rawUrl; }

    // 1. 平台特化规则
    const host = url.hostname;
    for (const [domain, handler] of Object.entries(PLATFORM_RULES)) {
      if (host === domain || host.endsWith('.' + domain)) {
        const result = handler(url);
        if (result) return result;
      }
    }

    // 2. 通用清理：遍历所有参数
    const keysToRemove = [];
    url.searchParams.forEach((_, key) => {
      const k = key.toLowerCase();
      // 精确匹配
      if (TRACKING_PARAMS.includes(k)) { keysToRemove.push(key); return; }
      // 前缀匹配
      for (const prefix of TRACKING_PREFIXES) {
        if (k.startsWith(prefix)) { keysToRemove.push(key); return; }
      }
    });
    keysToRemove.forEach(k => url.searchParams.delete(k));

    // 3. 清理 hash 中的追踪参数
    if (url.hash && url.hash.includes('?')) {
      const hashParts = url.hash.split('?');
      url.hash = hashParts[0]; // 保留 hash 锚点，去掉后面的参数
    }

    let result = url.toString();
    // 去掉末尾多余的 ? 或 &
    result = result.replace(/[?&]$/, '');
    return result;
  }

  chrome.runtime.onMessage.addListener((req) => {
    if (req.action === 'CLEAN_URL_COPY') {
      const original = location.href;
      const cleaned = cleanUrl(original);
      navigator.clipboard.writeText(cleaned).then(() => {
        const saved = original.length - cleaned.length;
        if (window.webOmniShowToast) {
          if (saved > 0) {
            window.webOmniShowToast('链接已净化并复制 (' + original.length + ' -> ' + cleaned.length + ' 字符，精简 ' + Math.round(saved / original.length * 100) + '%)', 'success', 3000);
          } else {
            window.webOmniShowToast('链接已复制 (无追踪参数)', 'info');
          }
        }
      });
    }

    if (req.action === 'CLEAN_URL_ALL_LINKS') {
      cleanAllPageLinks();
    }
  });

  // 清理页面所有超链接
  function cleanAllPageLinks() {
    let count = 0;
    document.querySelectorAll('a[href]').forEach(a => {
      if (!a.href || a.href.startsWith('javascript:') || a.href.startsWith('#')) return;
      const original = a.href;
      const cleaned = cleanUrl(original);
      if (cleaned !== original) {
        a.href = cleaned;
        count++;
      }
    });
    if (window.webOmniShowToast) {
      window.webOmniShowToast('已净化 ' + count + ' 个链接', 'success');
    }
  }
})();
