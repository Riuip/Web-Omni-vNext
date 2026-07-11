// 神经末梢：电商图片收割机 (E-Commerce Scraper)
// 智能识别淘宝/天猫/京东/拼多多等平台，批量提取商品主图、SKU图、详情图

(function() {
  if (window.webOmniEcommerceScraperInjected) return;
  window.webOmniEcommerceScraperInjected = true;

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "ECOMMERCE_SCRAPE") scrapeEcommerce();
  });

  // 平台检测
  function detectPlatform() {
    const host = location.hostname;
    if (host.includes("taobao.com") || host.includes("tmall.com")) return "taobao";
    if (host.includes("jd.com")) return "jd";
    if (host.includes("pinduoduo.com") || host.includes("yangkeduo.com")) return "pdd";
    if (host.includes("1688.com")) return "alibaba";
    if (host.includes("amazon")) return "amazon";
    return "generic";
  }

  function scrapeEcommerce() {
    const platform = detectPlatform();
    const result = { mainImages: [], skuImages: [], detailImages: [], platform };
    const seen = new Set();

    function addImg(url, category) {
      if (!url || seen.has(url) || url.startsWith("data:")) return;

      let cleanUrl = url;

      // ★ 修复: 更精准的URL清洗，不再暴力砍掉所有query参数
      if (platform === "taobao" || platform === "alibaba") {
        // 淘宝/天猫：只去掉缩略图尺寸后缀，保留 CDN 必要路径
        cleanUrl = cleanUrl
          .replace(/_\d+x\d+\.[a-z]+$/i, '')        // _100x100.jpg
          .replace(/_\d+x\d+q\d+\.[a-z]+$/i, '')    // _100x100q90.jpg
          .replace(/\.search\.[^/]*$/i, '')           // .search.xxx
          .replace(/_!![\d]+[-!].*$/i, '')            // _!!xxxxx-x-xxx.jpg 缩略格式
          .replace(/\?x-oss-process=.*$/i, '')        // 阿里云 OSS 图片处理参数（缩略）
          .replace(/\.jpg_\d+x\d+.*$/i, '.jpg')      // .jpg_100x100.jpg._
          .replace(/\.png_\d+x\d+.*$/i, '.png');
      } else if (platform === "jd") {
        // 京东：获取大图
        cleanUrl = cleanUrl
          .replace(/s\d+x\d+_jfs/, 'jfs')
          .replace(/\/n\d+\//, '/n0/');
      } else {
        // 通用：仅移除明确的缩略图参数
        cleanUrl = cleanUrl.replace(/!.*$/, '');
      }

      // 补全协议
      if (cleanUrl.startsWith("//")) cleanUrl = "https:" + cleanUrl;
      if (!cleanUrl.startsWith("http")) return;
      // 去掉可能的尾部空格
      cleanUrl = cleanUrl.trim();

      if (seen.has(cleanUrl)) return;
      seen.add(url);
      seen.add(cleanUrl);
      result[category].push(cleanUrl);
    }

    // ===== 后备方案：从页面JS数据中提取图片 =====
    function extractFromScriptData() {
      try {
        const scripts = document.querySelectorAll("script:not([src])");
        scripts.forEach(s => {
          const text = s.textContent || "";
          // 匹配 alicdn/taobaocdn 图片URL
          const imgReg = /https?:\/\/[^"'\s]+(?:alicdn|taobaocdn|tbcdn)[^"'\s]*\.(?:jpg|jpeg|png|webp)/gi;
          const matches = text.match(imgReg);
          if (matches) {
            matches.forEach(m => {
              const clean = m.replace(/\\u002F/g, '/').replace(/\\/g, '');
              if (clean.length < 300) addImg(clean, "mainImages");
            });
          }

          // ★ 新增：匹配SKU相关数据结构中的图片
          const skuImgReg = /"(?:skuImg|skuPic|valuePic|imageUrl|smallImage|skuImage|propImage)":\s*"(https?:\/\/[^"]+)"/gi;
          let skuMatch;
          while ((skuMatch = skuImgReg.exec(text)) !== null) {
            if (skuMatch[1]) addImg(skuMatch[1], "skuImages");
          }
        });
      } catch(e) { /* silent */ }

      // 尝试从全局变量提取
      try {
        const initData = window.__INITIAL_DATA__ || window.g_config || window.__MDATA__ || window.__NEXT_DATA__;
        if (initData) {
          const jsonStr = JSON.stringify(initData);
          const imgReg = /https?:\/\/[^"'\s\\]+\.(?:jpg|jpeg|png|webp)/gi;
          const matches = jsonStr.match(imgReg);
          if (matches) {
            matches.forEach(m => {
              if (m.includes("alicdn") || m.includes("tbcdn") || m.includes("taobaocdn")) {
                addImg(m, "mainImages");
              }
            });
          }

          // ★ 新增：深度搜索SKU图片
          extractSkuFromObject(initData);
        }
      } catch(e) { /* silent */ }
    }

    // ★ 新增：递归从JS对象中找SKU图片
    function extractSkuFromObject(obj, depth = 0) {
      if (depth > 8 || !obj || typeof obj !== "object") return;
      try {
        for (const key of Object.keys(obj)) {
          const val = obj[key];
          if (typeof val === "string" && val.match(/^https?:\/\/.*\.(jpg|jpeg|png|webp)/i)) {
            const lk = key.toLowerCase();
            if (lk.includes("sku") || lk.includes("prop") || lk.includes("value") || lk.includes("smallimage")) {
              addImg(val, "skuImages");
            }
          } else if (typeof val === "object" && val !== null) {
            extractSkuFromObject(val, depth + 1);
          }
        }
      } catch(e) { /* silent */ }
    }

    if (platform === "taobao") {
      // ★ 修复+增强：淘宝/天猫主图 — 大幅扩展选择器覆盖新旧版本
      const mainSelectors = [
        // 经典版
        "#J_UlThumb img", ".tb-thumb img", ".PicGallery img",
        ".thumbnails img", ".thumb-list img", "[class*='mainPic'] img",
        // 新版 React SSR
        "[class*='SliderImage'] img", "[class*='sliderImage'] img",
        "[class*='thumbnailPic'] img", "[class*='gallery'] img",
        "[class*='ItemImage'] img", "[class*='itemImage'] img",
        "[class*='mainImage'] img", "[class*='MainImage'] img",
        // CDN直接匹配
        "img[src*='img.alicdn.com']", "img[src*='gw.alicdn.com']",
        // 新版无明确class
        "[class*='PicSlider'] img", "[class*='picSlider'] img",
        "[class*='detail-gallery'] img", "[class*='main-image'] img",
        "[class*='swiper'] img", "[class*='Swiper'] img"
      ];
      document.querySelectorAll(mainSelectors.join(",")).forEach(img => {
        let src = img.src || img.dataset.src || img.getAttribute("data-lazy") ||
                  img.dataset.lazyload || img.getAttribute("data-lazy-src") ||
                  img.getAttribute("data-ks-lazyload");
        if (src) {
          const rect = img.getBoundingClientRect();
          if (rect.width > 40 || rect.height > 40 || !rect.width) addImg(src, "mainImages");
        }
      });

      // ★ 修复+增强：SKU 图 — 大量新选择器
      const skuSelectors = [
        // 经典版
        ".tb-sku img", ".J_TSaleProp img", ".skuList img",
        // 通用class模糊匹配
        "[class*='sku'] img", "[class*='Sku'] img",
        "[class*='prop'] img", "[class*='Prop'] img",
        "[class*='valueName'] img", "[class*='skuItem'] img",
        "[class*='SkuContent'] img", "[class*='sku-content'] img",
        // ★ 新增：data属性匹配
        "[data-sku-id] img", "img[data-sku-id]",
        "[class*='skuPic'] img", "[class*='SkuPic'] img",
        "[class*='propImg'] img", "[class*='PropImg'] img",
        "[class*='valueImg'] img", "[class*='ValueImg'] img",
        // 颜色/尺码选择区
        "[class*='color'] img", "[class*='Color'] img",
        "[class*='size'] img", "[class*='sale-prop'] img",
        // 新版React结构
        "[class*='skuInfo'] img", "[class*='SkuInfo'] img",
        "[class*='valueItem'] img", "[class*='ValueItem'] img"
      ];
      document.querySelectorAll(skuSelectors.join(",")).forEach(img => {
        let src = img.src || img.dataset.src || img.dataset.lazyload ||
                  img.getAttribute("data-lazy-src") || img.getAttribute("data-ks-lazyload") ||
                  img.getAttribute("data-lazy");
        if (src) addImg(src, "skuImages");
      });

      // ★ 新增：从SKU区域的背景图中提取
      document.querySelectorAll("[class*='sku'] [style*='background'], [class*='Sku'] [style*='background'], [class*='prop'] [style*='background'], [class*='color'] [style*='background']").forEach(el => {
        const bg = el.style.backgroundImage || getComputedStyle(el).backgroundImage;
        const m = bg.match(/url\(["']?(.*?)["']?\)/);
        if (m && m[1]) addImg(m[1], "skuImages");
      });

      // ★ 修复：详情图 — 精确定位商品描述区域，排除评论区/用户头像
      // 先收集需要排除的评论区容器
      const commentContainers = document.querySelectorAll(
        "[class*='rate'], [class*='Rate'], [class*='review'], [class*='Review'], " +
        "[class*='comment'], [class*='Comment'], [class*='feedback'], [class*='Feedback'], " +
        "[class*='userAvatar'], [class*='avatar'], [class*='Avatar'], " +
        "[class*='buyer'], [class*='Buyer'], [class*='评价'], [class*='评论']"
      );
      const commentSet = new Set();
      commentContainers.forEach(el => commentSet.add(el));

      function isInsideComment(el) {
        let p = el;
        while (p) {
          if (commentSet.has(p)) return true;
          p = p.parentElement;
        }
        return false;
      }

      const detailSelectors = [
        // 经典版描述区域
        "#description img", "#J_DivItemDesc img",
        ".desc-inside img", ".tb-detail-content img",
        // 精确的描述模块（不使用[class*='detail'] 避免匹配评论）
        "[class*='descContent'] img", "[class*='DescContent'] img",
        "[class*='descriptionModule'] img", "[class*='desc-module'] img",
        "[class*='ItemDetail'] img", "[class*='itemDetail'] img",
        "[class*='detailContent'] img", "[class*='DetailContent'] img",
        // 商品描述特定容器
        ".content-detail img",
        "[class*='desc-wrap'] img", "[class*='descWrap'] img",
        // 商品详情的 iframe 内区域无法直接读，但尽量覆盖
        "[id*='desc'] img", "[id*='Desc'] img",
        "[id*='detail-content'] img",
      ];
      document.querySelectorAll(detailSelectors.join(",")).forEach(img => {
        // ★ 排除评论区内的图片（用户头像等）
        if (isInsideComment(img)) return;
        const src = img.src || img.dataset.src || img.dataset.lazyload;
        if (!src) return;
        // ★ 排除小图（头像通常 < 100px）
        const rect = img.getBoundingClientRect();
        const w = img.naturalWidth || rect.width || 0;
        const h = img.naturalHeight || rect.height || 0;
        if (w > 0 && w < 100 && h > 0 && h < 100) return;
        addImg(src, "detailImages");
      });

      // 后备：从页面数据提取
      extractFromScriptData();

    } else if (platform === "jd") {
      document.querySelectorAll("#spec-list img, .lh-lazy-img img, #J-img-thumb img, .J-img-thumb img").forEach(img => {
        let src = img.src || img.dataset.src || img.dataset.url;
        if (src) { src = src.replace(/s\d+x\d+_jfs/, 'jfs').replace(/\/n\d+\//, '/n0/'); }
        addImg(src, "mainImages");
      });
      document.querySelectorAll(".btn-choose img, [class*='sku'] img").forEach(img => {
        addImg(img.src, "skuImages");
      });
      document.querySelectorAll("#J-detail-content img, .ssd-module-wrap img, .detail-content img").forEach(img => {
        addImg(img.src || img.dataset.lazyload, "detailImages");
      });

    } else if (platform === "alibaba") {
      document.querySelectorAll("[class*='thumb'] img, [class*='gallery'] img, [class*='main'] img").forEach(img => {
        addImg(img.src || img.dataset.src, "mainImages");
      });
      document.querySelectorAll("[class*='sku'] img, [class*='Sku'] img").forEach(img => {
        addImg(img.src, "skuImages");
      });
      document.querySelectorAll("[class*='detail'] img, [class*='Detail'] img, [class*='offer-description'] img").forEach(img => {
        addImg(img.src || img.dataset.src, "detailImages");
      });
      extractFromScriptData();

    } else {
      // 通用模式：按尺寸筛选
      document.querySelectorAll("img").forEach(img => {
        const src = img.src || img.dataset.src;
        if (!src || src.startsWith("data:")) return;
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        if (w > 300 || h > 300) addImg(src, "mainImages");
        else if (w > 50) addImg(src, "detailImages");
      });
    }

    // 额外检测：CSS背景图中的大图
    document.querySelectorAll("[style*='background']").forEach(el => {
      const bg = el.style.backgroundImage || getComputedStyle(el).backgroundImage;
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (m && m[1]) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 150 || rect.height > 150) addImg(m[1], "mainImages");
      }
    });

    const total = result.mainImages.length + result.skuImages.length + result.detailImages.length;
    if (total === 0) {
      if (window.webOmniShowToast) window.webOmniShowToast("未找到商品图片，请确认页面已完全加载", "warn");
      return;
    }

    showEcommercePanel(result);
  }

  // ===== 通过 background proxy 下载图片（解决防盗链） =====
  function proxyDownload(url, filename) {
    chrome.runtime.sendMessage({
      type: "PROXY_DOWNLOAD",
      url: url,
      filename: filename || url.split('/').pop().split('?')[0],
      referer: location.href  // ★ 新增：传递当前页面URL作为referer
    });
  }

  function showEcommercePanel(data) {
    const existing = document.getElementById("web-omni-ecom-panel");
    if (existing) existing.remove();

    const panel = document.createElement("div");
    panel.id = "web-omni-ecom-panel";
    const platformNames = { taobao: "淘宝/天猫", jd: "京东", pdd: "拼多多", alibaba: "1688", amazon: "Amazon", generic: "通用" };
    const total = data.mainImages.length + data.skuImages.length + data.detailImages.length;

    panel.style.cssText = `
      position:fixed;top:0;right:0;width:440px;height:100vh;z-index:2147483646;
      background:rgba(18,18,18,0.96);backdrop-filter:blur(24px);
      border-left:1px solid rgba(255,255,255,0.08);box-shadow:-10px 0 40px rgba(0,0,0,0.4);
      overflow-y:auto;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      color:#fff;transform:translateX(100%);transition:transform 0.35s cubic-bezier(0.2,0,0,1);
    `;

    let html = `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:20px;border-bottom:1px solid rgba(255,255,255,0.06);position:sticky;top:0;background:rgba(18,18,18,0.98);z-index:2;">
        <div>
          <h3 style="margin:0;font-size:17px;font-weight:700;">🛒 电商图片收割</h3>
          <p style="margin:4px 0 0;font-size:12px;color:#888;">平台: ${platformNames[data.platform]} · 共 ${total} 张</p>
        </div>
        <div style="display:flex;gap:8px;">
          <button id="wo-ecom-dl-all" style="background:linear-gradient(135deg,#f59e0b,#ef4444);border:none;color:#fff;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;">⬇ 全部下载</button>
          <button id="wo-ecom-close" style="background:rgba(255,255,255,0.08);border:none;color:#fff;width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:16px;">✕</button>
        </div>
      </div>
    `;

    function renderSection(title, icon, images, categoryId) {
      if (images.length === 0) return "";
      let s = `<div style="padding:12px 16px 4px;"><p style="font-size:12px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:1px;display:flex;align-items:center;gap:6px;">
        ${icon} ${title} <span style="background:rgba(255,255,255,0.08);padding:1px 6px;border-radius:8px;font-size:11px;">${images.length}</span>
        <button class="wo-ecom-dl-cat" data-cat="${categoryId}" style="margin-left:auto;background:rgba(255,255,255,0.06);border:none;color:#aaa;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:11px;">⬇ 下载该组</button>
      </p></div>`;
      s += `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;padding:0 12px 8px;">`;
      images.forEach(src => {
        // ★ 关键修复：添加 referrerpolicy="no-referrer" 解决防盗链
        s += `<div style="position:relative;border-radius:6px;overflow:hidden;background:rgba(255,255,255,0.04);aspect-ratio:1;cursor:pointer;" class="wo-ecom-thumb" data-src="${src}">
          <img src="${src}" referrerpolicy="no-referrer" crossorigin="anonymous" style="width:100%;height:100%;object-fit:cover;" loading="lazy" onerror="this.onerror=null;this.style.opacity='0.3';this.parentElement.insertAdjacentHTML('afterbegin','<div style=\\'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:10px;color:#666;text-align:center\\'>⚠️<br>加载失败<br>点击查看</div>');">
          <button class="wo-ecom-dl-one" data-url="${src}" style="position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.6);border:none;color:#fff;width:24px;height:24px;border-radius:5px;cursor:pointer;font-size:11px;opacity:0;transition:opacity 0.15s;">⬇</button>
        </div>`;
      });
      s += `</div>`;
      return s;
    }

    html += renderSection("主图 / 轮播图", "📸", data.mainImages, "mainImages");
    html += renderSection("SKU 属性图", "🎨", data.skuImages, "skuImages");
    html += renderSection("详情描述图", "📄", data.detailImages, "detailImages");

    const hoverCSS = document.createElement("style");
    hoverCSS.textContent = `.wo-ecom-thumb:hover .wo-ecom-dl-one{opacity:1!important}`;

    panel.innerHTML = html;
    panel.appendChild(hoverCSS);
    document.body.appendChild(panel);

    requestAnimationFrame(() => requestAnimationFrame(() => panel.style.transform = "translateX(0)"));

    // 事件绑定
    panel.querySelector("#wo-ecom-close").addEventListener("click", () => {
      panel.style.transform = "translateX(100%)";
      setTimeout(() => panel.remove(), 350);
    });

    panel.querySelector("#wo-ecom-dl-all").addEventListener("click", () => {
      const all = [...data.mainImages, ...data.skuImages, ...data.detailImages];
      all.forEach((url, i) => {
        setTimeout(() => {
          proxyDownload(url, `ecom_${i+1}_${url.split('/').pop().split('?')[0]}`);
        }, i * 200);
      });
      if (window.webOmniShowToast) window.webOmniShowToast(`⬇️ 正在下载 ${all.length} 张图片...`, "success");
    });

    panel.querySelectorAll(".wo-ecom-dl-cat").forEach(btn => {
      btn.addEventListener("click", () => {
        const cat = btn.dataset.cat;
        const imgs = data[cat] || [];
        imgs.forEach((url, i) => {
          setTimeout(() => {
            proxyDownload(url, `${cat}_${i+1}_${url.split('/').pop().split('?')[0]}`);
          }, i * 200);
        });
        if (window.webOmniShowToast) window.webOmniShowToast(`⬇️ 正在下载 ${imgs.length} 张...`, "info");
      });
    });

    panel.querySelectorAll(".wo-ecom-dl-one").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        proxyDownload(btn.dataset.url);
        if (window.webOmniShowToast) window.webOmniShowToast("⬇️ 开始下载", "info");
      });
    });

    // 点击缩略图查看大图
    panel.querySelectorAll(".wo-ecom-thumb").forEach(thumb => {
      thumb.addEventListener("click", (e) => {
        if (e.target.closest(".wo-ecom-dl-one")) return;
        window.open(thumb.dataset.src, "_blank");
      });
    });

    if (window.webOmniShowToast) window.webOmniShowToast(`🛒 ${platformNames[data.platform]}: 主图${data.mainImages.length} · SKU${data.skuImages.length} · 详情${data.detailImages.length}`, "success");
  }

})();
