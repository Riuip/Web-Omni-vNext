// 神经末梢：局域网文件传输入口 (LAN Transfer)
// 点击后打开独立网页版传输界面
(function() {
  if (window.webOmniLanTransferInjected) return;
  window.webOmniLanTransferInjected = true;

  chrome.runtime.onMessage.addListener((req) => {
    if (req.action === "LAN_TRANSFER") {
      const url = chrome.runtime.getURL("lan-transfer/index.html");
      window.open(url, "_blank");
      if (window.webOmniShowToast) window.webOmniShowToast("正在打开局域网文件传输...", "info");
    }
  });
})();
