// 神经末梢：自动化极客 (Automation Geek)
// 闪电身份填表 和 宏指令录制

(function() {
  if (window.webOmniAutomationGeekInjected) return;
  window.webOmniAutomationGeekInjected = true;

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "AUTO_FILL") {
      autoFillForm(request.profile);
    }
  });

  function autoFillForm(profile = "default") {
    chrome.storage.local.get(['fillProfiles'], (result) => {
      let profiles = result.fillProfiles || {
        default: {
          name: "张三", email: "zhangsan@example.com",
          phone: "13800138000", address: "北京市朝阳区科学院路100号"
        }
      };
      let data = profiles[profile] || profiles.default;
      let filledCount = 0;

      document.querySelectorAll('input, textarea').forEach(input => {
        const ft = input.type || "text";
        if (["hidden","submit","button","image","file","reset","checkbox","radio"].includes(ft)) return;

        const id = ((input.name||"")+" "+(input.id||"")+" "+(input.placeholder||"")+" "+getLabel(input)).toLowerCase();
        let value = null;

        if (matchField(id, ['name','姓名','用户名','username'])) value = data.name;
        else if (matchField(id, ['mail','邮箱','email'])) value = data.email;
        else if (matchField(id, ['phone','mobile','tel','手机','电话'])) value = data.phone;
        else if (matchField(id, ['address','地址'])) value = data.address;

        if (value) { setNativeValue(input, value); filledCount++; }
      });

      if (filledCount > 0) {
        if (window.webOmniShowToast) window.webOmniShowToast(`⚡ 已填写 ${filledCount} 个字段`, "success");
      } else {
        if (window.webOmniShowToast) window.webOmniShowToast("未找到可匹配的表单字段", "warn");
      }
    });
  }

  function matchField(id, kws) { return kws.some(k => id.includes(k)); }

  function getLabel(input) {
    if (input.id) { const l = document.querySelector(`label[for="${input.id}"]`); if (l) return l.innerText; }
    const p = input.closest("label"); return p ? p.innerText : "";
  }

  function setNativeValue(element, value) {
    try {
      const proto = Object.getPrototypeOf(element);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) { desc.set.call(element, value); }
      else { element.value = value; }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      // 视觉反馈
      const origBg = element.style.backgroundColor;
      element.style.transition = "background-color 0.3s";
      element.style.backgroundColor = "rgba(34,197,94,0.2)";
      setTimeout(() => { element.style.backgroundColor = origBg; }, 800);
    } catch(e) {
      try { element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); } catch(e2) {}
    }
  }
})();
