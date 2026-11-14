/**
 * Offscreen Document: 供 background 读取系统剪贴板文本
 * (MV3 service worker 无法直接访问剪贴板, 借助本页面 + clipboardRead 权限中转)
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'vtReadClipboard') return;
  try {
    const ta = document.getElementById('vt-clipboard-ta');
    ta.value = '';
    ta.focus();
    document.execCommand('paste');
    sendResponse({ ok: true, text: ta.value });
  } catch (e) {
    sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});
