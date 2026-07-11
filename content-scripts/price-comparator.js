// 神经末梢：多平台比价引擎 (Price Comparator)
// 淘宝/京东/拼多多/1688 跨平台商品比价 + 本地价格历史图表
(function() {
  if (window.webOmniPriceComparatorInjected) return;
  window.webOmniPriceComparatorInjected = true;

  chrome.runtime.onMessage.addListener((req) => {
    if (req.action === 'PRICE_COMPARE') activatePriceCompare();
  });

  // ===== 平台配置 =====
  const PLATFORMS = [
    { key:'taobao', name:'淘宝/天猫', color:'#FF6A00', url:q=>`https://s.taobao.com/search?q=${encodeURIComponent(q)}` },
    { key:'jd', name:'京东', color:'#E2231A', url:q=>`https://search.jd.com/Search?keyword=${encodeURIComponent(q)}` },
    { key:'pdd', name:'拼多多', color:'#E02E24', url:q=>`https://mobile.yangkeduo.com/search_result.html?search_key=${encodeURIComponent(q)}` },
    { key:'1688', name:'1688', color:'#FF7900', url:q=>`https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(q)}` },
    { key:'amazon', name:'Amazon', color:'#FF9900', url:q=>`https://www.amazon.cn/s?k=${encodeURIComponent(q)}` },
  ];

  // ===== 检测商品标题 =====
  function detectTitle() {
    const host = location.hostname;
    let t = '';
    if (host.includes('taobao.com') || host.includes('tmall.com'))
      t = document.querySelector("[class*='mainTitle'], .tb-main-title, h1")?.innerText?.trim();
    else if (host.includes('jd.com'))
      t = document.querySelector('.sku-name, .itemInfo-wrap .item-name')?.innerText?.trim();
    else if (host.includes('1688.com'))
      t = document.querySelector('.title-text, h1')?.innerText?.trim();
    if (!t) t = document.querySelector('h1')?.innerText?.trim() || document.title;
    return t.replace(/[-–—|【】\[\]（）(){}]+/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 40);
  }

  // ===== 检测当前价格 =====
  function detectPrice() {
    const host = location.hostname;
    let p = '';
    if (host.includes('taobao.com') || host.includes('tmall.com'))
      p = document.querySelector("[class*='Price'] span, .tb-rmb-num, .tm-price")?.innerText?.trim();
    else if (host.includes('jd.com'))
      p = document.querySelector('.price .p-price span, .summary-price-wrap .price, .p-price span')?.innerText?.trim();
    else if (host.includes('1688.com'))
      p = document.querySelector("[class*='price'] span")?.innerText?.trim();
    if (p) p = p.replace(/[^0-9.]/g, '');
    return p ? parseFloat(p) : null;
  }

  // ===== 检测当前平台 =====
  function detectPlatform() {
    const host = location.hostname;
    if (host.includes('taobao.com') || host.includes('tmall.com')) return 'taobao';
    if (host.includes('jd.com')) return 'jd';
    if (host.includes('1688.com')) return '1688';
    if (host.includes('pinduoduo') || host.includes('yangkeduo')) return 'pdd';
    if (host.includes('amazon')) return 'amazon';
    return null;
  }

  // ===== 价格历史存储 =====
  const STORAGE_KEY = 'woPrice_history';
  const MAX_RECORDS = 500;

  async function savePriceRecord(title, price, platform) {
    if (!title || !price || !platform) return;
    const data = await new Promise(r => chrome.storage.local.get([STORAGE_KEY], r));
    const history = data[STORAGE_KEY] || [];
    const key = title.substring(0, 30).toLowerCase().replace(/\s+/g, '');

    history.push({
      key, title: title.substring(0, 40),
      price, platform,
      url: location.href,
      time: Date.now()
    });

    // 限制记录数量
    if (history.length > MAX_RECORDS) history.splice(0, history.length - MAX_RECORDS);
    chrome.storage.local.set({ [STORAGE_KEY]: history });
  }

  async function loadPriceHistory(title) {
    const data = await new Promise(r => chrome.storage.local.get([STORAGE_KEY], r));
    const history = data[STORAGE_KEY] || [];
    const key = title.substring(0, 30).toLowerCase().replace(/\s+/g, '');
    return history.filter(r => r.key === key).sort((a, b) => a.time - b.time);
  }

  // ===== 自动记录价格 =====
  function autoRecordPrice() {
    const platform = detectPlatform();
    if (!platform) return;
    setTimeout(() => {
      const title = detectTitle();
      const price = detectPrice();
      if (title && price) savePriceRecord(title, price, platform);
    }, 3000); // 等页面加载完
  }
  autoRecordPrice();

  // ===== 交互式 SVG 图表 =====
  function buildChart(records, curPrice) {
    if (records.length < 1 && !curPrice) return '';

    // 如果记录太少，补充当前价格
    const points = records.map(r => ({ price: r.price, time: r.time, platform: r.platform }));
    if (curPrice && (points.length === 0 || points[points.length - 1].price !== curPrice)) {
      points.push({ price: curPrice, time: Date.now(), platform: detectPlatform() || '?' });
    }

    if (points.length < 2) {
      // 只有1个点，显示简单卡片
      const p = points[0];
      return `<div style="padding:12px;background:#0d1117;border:1px solid #21262d;border-radius:6px;margin:0 16px 12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:12px;color:#8b949e;">当前价格</span>
          <span style="font-size:18px;font-weight:700;color:#e6edf3;">¥${p.price.toFixed(2)}</span>
        </div>
        <div style="font-size:11px;color:#484f58;margin-top:4px;">继续浏览商品页积累价格数据，将生成趋势图表</div>
      </div>`;
    }

    const prices = points.map(p => p.price);
    const min = Math.min(...prices), max = Math.max(...prices);
    const avg = prices.reduce((s, p) => s + p, 0) / prices.length;
    const range = max - min || 1;
    const W = 340, H = 90;

    // 生成路径
    const pathD = points.map((p, i) => {
      const x = (i / (points.length - 1)) * W;
      const y = H - ((p.price - min) / range) * (H - 16) - 8;
      return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');

    // 填充路径
    const fillD = pathD + ` L${W},${H} L0,${H} Z`;

    // 最低最高点位置
    const minI = prices.indexOf(min), maxI = prices.indexOf(max);
    const minX = (minI / (points.length - 1)) * W;
    const minY = H - ((min - min) / range) * (H - 16) - 8;
    const maxX = (maxI / (points.length - 1)) * W;
    const maxY = H - ((max - min) / range) * (H - 16) - 8;
    const curX = W;
    const curY = H - ((prices[prices.length - 1] - min) / range) * (H - 16) - 8;

    // 互动: 每个点生成透明触控区域
    let dotsHtml = '';
    const hoverRects = [];
    points.forEach((p, i) => {
      const x = (i / (points.length - 1)) * W;
      const y = H - ((p.price - min) / range) * (H - 16) - 8;
      const date = new Date(p.time);
      const dateStr = `${date.getMonth() + 1}/${date.getDate()}`;
      const segW = W / points.length;
      dotsHtml += `<rect x="${Math.max(0, x - segW / 2)}" y="0" width="${segW}" height="${H}"
        fill="transparent" class="wo-chart-hover"
        data-i="${i}" data-x="${x}" data-y="${y}" data-price="${p.price.toFixed(2)}" data-date="${dateStr}" data-platform="${p.platform}" />`;
    });

    // 降价/涨价幅度
    const first = prices[0], last = prices[prices.length - 1];
    const diff = last - first;
    const diffPct = (diff / first * 100).toFixed(1);
    const diffColor = diff <= 0 ? '#3fb950' : '#f85149';
    const diffSign = diff <= 0 ? '↓' : '↑';
    const diffLabel = diff === 0 ? '持平' : `${diffSign} ${Math.abs(diff).toFixed(2)} (${Math.abs(diffPct)}%)`;

    // 时间范围
    const firstDate = new Date(points[0].time);
    const lastDate = new Date(points[points.length - 1].time);
    const daySpan = Math.max(1, Math.round((lastDate - firstDate) / 86400000));

    return `<div style="padding:12px 16px;background:#0d1117;border:1px solid #21262d;border-radius:6px;margin:0 16px 12px;" id="wo-chart-container">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="font-size:12px;color:#8b949e;">${daySpan}天价格趋势 (${points.length}条记录)</span>
        <span style="font-size:14px;font-weight:600;color:${diffColor};">${diffLabel}</span>
      </div>
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;cursor:crosshair;" id="wo-chart-svg">
        <defs>
          <linearGradient id="wo-cg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#58a6ff" stop-opacity="0.2"/>
            <stop offset="100%" stop-color="#58a6ff" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path d="${fillD}" fill="url(#wo-cg)" stroke="none"/>
        <path d="${pathD}" fill="none" stroke="#58a6ff" stroke-width="1.5" stroke-linejoin="round"/>
        <circle cx="${minX}" cy="${minY}" r="3" fill="#3fb950" stroke="#0d1117" stroke-width="1"/>
        <circle cx="${maxX}" cy="${maxY}" r="3" fill="#f85149" stroke="#0d1117" stroke-width="1"/>
        <circle cx="${curX}" cy="${curY}" r="3" fill="#58a6ff" stroke="#0d1117" stroke-width="1"/>
        <line x1="0" y1="0" x2="0" y2="${H}" stroke="#58a6ff" stroke-width="1" opacity="0" id="wo-chart-line"/>
        <circle cx="0" cy="0" r="4" fill="#58a6ff" opacity="0" id="wo-chart-dot"/>
        ${dotsHtml}
      </svg>
      <div id="wo-chart-tooltip" style="display:none;position:absolute;background:#21262d;border:1px solid #30363d;border-radius:4px;padding:4px 8px;font-size:11px;color:#e6edf3;pointer-events:none;z-index:10;"></div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:#484f58;margin-top:6px;">
        <span style="color:#3fb950;">最低 ¥${min.toFixed(2)}</span>
        <span>均价 ¥${avg.toFixed(2)}</span>
        <span style="color:#f85149;">最高 ¥${max.toFixed(2)}</span>
      </div>
    </div>`;
  }

  // ===== 主面板 =====
  async function activatePriceCompare() {
    const existing = document.getElementById('wo-price-panel');
    if (existing) { existing.remove(); return; }

    const title = detectTitle();
    const curPrice = detectPrice();
    const host = location.hostname;

    // 加载历史数据
    const records = await loadPriceHistory(title);

    // 如果在商品页且有新价格，立即记录
    const platform = detectPlatform();
    if (curPrice && platform) savePriceRecord(title, curPrice, platform);

    const panel = document.createElement('div');
    panel.id = 'wo-price-panel';
    panel.style.cssText = `position:fixed;top:0;right:0;width:400px;height:100vh;z-index:2147483646;
      background:#161b22;border-left:1px solid #30363d;overflow-y:auto;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#c9d1d9;
      transform:translateX(100%);transition:transform 0.25s ease;`;

    // 图表
    const chartHTML = buildChart(records, curPrice);

    // 平台列表
    let platformHTML = PLATFORMS.map(p => {
      const isCur = host.includes(p.key) || (p.key === 'taobao' && host.includes('tmall.com'));
      return `<div class="wo-pc" data-key="${p.key}" style="display:flex;align-items:center;gap:10px;padding:8px 12px;
        background:#0d1117;border:1px solid ${isCur ? p.color + '44' : '#21262d'};border-radius:6px;
        cursor:pointer;transition:all 0.15s;${isCur ? 'border-left:3px solid ' + p.color + ';' : ''}">
        <div style="width:8px;height:8px;border-radius:50%;background:${p.color};flex-shrink:0;"></div>
        <div style="flex:1;"><div style="font-size:13px;font-weight:500;color:#e6edf3;">${p.name}</div>
        <div style="font-size:11px;color:#8b949e;">${isCur ? '当前平台' : '点击搜索'}</div></div>
        <span style="color:#484f58;font-size:12px;">→</span>
      </div>`;
    }).join('');

    panel.innerHTML = `
      <div style="position:sticky;top:0;background:#161b22;z-index:2;border-bottom:1px solid #21262d;padding:12px 16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <span style="font-size:14px;font-weight:600;color:#e6edf3;">跨平台比价</span>
          <button id="wo-pc-close" style="background:#21262d;border:1px solid #30363d;color:#8b949e;padding:3px 8px;border-radius:6px;cursor:pointer;font-size:12px;">✕</button>
        </div>
        <input id="wo-pc-input" type="text" value="${esc(title)}" placeholder="输入商品名称..."
          style="width:100%;padding:8px 10px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#e6edf3;font-size:13px;outline:none;box-sizing:border-box;">
      </div>
      ${chartHTML}
      <div style="padding:0 16px 8px;display:flex;flex-direction:column;gap:4px;">
        <span style="font-size:11px;color:#484f58;padding:0 2px;">选择平台</span>
        ${platformHTML}
      </div>
      <div style="padding:8px 16px 16px;">
        <button id="wo-pc-all" style="width:100%;padding:8px;background:#238636;border:1px solid #2ea043;color:#fff;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;">全平台搜索</button>
      </div>`;

    // 样式
    const style = document.createElement('style');
    style.textContent = `.wo-pc:hover{background:#161b22!important;border-color:#58a6ff!important;}`;
    panel.appendChild(style);
    document.body.appendChild(panel);
    requestAnimationFrame(() => requestAnimationFrame(() => panel.style.transform = 'translateX(0)'));

    // 图表互动
    setTimeout(() => {
      panel.querySelectorAll('.wo-chart-hover').forEach(rect => {
        rect.addEventListener('mouseenter', (e) => {
          const d = rect.dataset;
          const line = document.getElementById('wo-chart-line');
          const dot = document.getElementById('wo-chart-dot');
          const tip = document.getElementById('wo-chart-tooltip');
          if (line) { line.setAttribute('x1', d.x); line.setAttribute('x2', d.x); line.setAttribute('opacity', '0.3'); }
          if (dot) { dot.setAttribute('cx', d.x); dot.setAttribute('cy', d.y); dot.setAttribute('opacity', '1'); }
          if (tip) {
            tip.style.display = 'block';
            tip.textContent = `${d.date} · ¥${d.price}`;
            const container = document.getElementById('wo-chart-container');
            if (container) {
              const cr = container.getBoundingClientRect();
              tip.style.left = (parseFloat(d.x) / 340 * cr.width + cr.left + 8) + 'px';
              tip.style.top = (cr.top + parseFloat(d.y) - 24) + 'px';
            }
          }
        });
        rect.addEventListener('mouseleave', () => {
          const line = document.getElementById('wo-chart-line');
          const dot = document.getElementById('wo-chart-dot');
          const tip = document.getElementById('wo-chart-tooltip');
          if (line) line.setAttribute('opacity', '0');
          if (dot) dot.setAttribute('opacity', '0');
          if (tip) tip.style.display = 'none';
        });
      });
    }, 100);

    // 关闭
    panel.querySelector('#wo-pc-close').onclick = () => {
      panel.style.transform = 'translateX(100%)';
      setTimeout(() => panel.remove(), 250);
    };

    // 平台点击
    panel.querySelectorAll('.wo-pc').forEach(card => {
      card.addEventListener('click', () => {
        const q = panel.querySelector('#wo-pc-input').value.trim();
        if (!q) return;
        const p = PLATFORMS.find(x => x.key === card.dataset.key);
        window.open(p.url(q), '_blank');
      });
    });

    // 全平台搜索
    panel.querySelector('#wo-pc-all').addEventListener('click', () => {
      const q = panel.querySelector('#wo-pc-input').value.trim();
      if (!q) return;
      PLATFORMS.forEach((p, i) => setTimeout(() => window.open(p.url(q), '_blank'), i * 300));
      if (window.webOmniShowToast) window.webOmniShowToast(`已打开 ${PLATFORMS.length} 个平台`, 'success');
    });

    setTimeout(() => { const inp = panel.querySelector('#wo-pc-input'); inp.focus(); inp.select(); }, 300);
  }

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
})();
