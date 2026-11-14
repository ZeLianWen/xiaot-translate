/**
 * 划词翻译 Content Script (设计说明书 2.2.1)
 * 用户在网页中选中文本 → 出现"译"浮标 → 点击浮窗显示译文
 * 翻译请求经 background.js 代理 (绕过 CORS, 共用统一引擎与本地缓存)
 */
(function() {
  'use strict';

  const BTN_ID = 'vt-sel-btn';
  const POPUP_ID = 'vt-sel-popup';
  const Z_INDEX = 2147483646;
  let pendingText = '';
  // Alt+T 剪贴板翻译弹窗为固定定位模式: 固定在视口右上角, 不随页面滚动关闭
  let selPopupPinned = false;

  // 注入标记: F12 控制台执行 document.documentElement.getAttribute('data-vt-injected')
  // 返回 '1' 表示 content script 已注入, null 表示未注入
  document.documentElement.setAttribute('data-vt-injected', '1');

  function createBtn() {
    let btn = document.getElementById(BTN_ID);
    if (btn) return btn;
    btn = document.createElement('div');
    btn.id = BTN_ID;
    btn.className = 'vt-sel-btn';
    btn.textContent = '译';
    btn.title = '小T翻译';
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (pendingText) showPopup(pendingText);
    });
    document.documentElement.appendChild(btn);
    return btn;
  }

  function hideBtn() {
    const btn = document.getElementById(BTN_ID);
    if (btn) btn.classList.remove('vt-visible');
  }

  function createPopup() {
    let popup = document.getElementById(POPUP_ID);
    if (popup) return popup;
    popup = document.createElement('div');
    popup.id = POPUP_ID;
    popup.className = 'vt-sel-popup';
    popup.innerHTML =
      '<div class="vt-popup-header">' +
        '<span class="vt-popup-engine">小T翻译</span>' +
        '<span class="vt-popup-actions">' +
          '<button class="vt-popup-btn" data-act="copy" title="复制译文">复制</button>' +
          '<button class="vt-popup-btn" data-act="close" title="关闭">✕</button>' +
        '</span>' +
      '</div>' +
      '<div class="vt-popup-body"><div class="vt-popup-loading">正在翻译...</div></div>';
    popup.addEventListener('mousedown', e => e.stopPropagation());
    popup.addEventListener('click', e => {
      const act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'close') {
        hidePopup();
      } else if (act === 'copy') {
        const body = popup.querySelector('.vt-popup-body');
        const text = body ? body.textContent : '';
        navigator.clipboard.writeText(text).then(() => {
          const btnCopy = popup.querySelector('[data-act="copy"]');
          if (btnCopy) {
            btnCopy.textContent = '已复制';
            setTimeout(() => { btnCopy.textContent = '复制'; }, 1200);
          }
        }).catch(() => {});
      }
    });
    document.documentElement.appendChild(popup);
    return popup;
  }

  function hidePopup() {
    const popup = document.getElementById(POPUP_ID);
    if (popup) popup.classList.remove('vt-visible');
  }

  // selTopY: 选区顶边坐标 (选区模式为文档坐标, 固定模式为视口坐标), 用于上方换向时避开选区
  function positionPopup(x, y, selTopY) {
    const popup = createPopup();
    // 固定模式: fixed 定位贴住视口; 选区模式: absolute 定位跟随文档坐标
    popup.style.position = selPopupPinned ? 'fixed' : 'absolute';
    popup.style.left = '0px';
    popup.style.top = '0px';
    popup.classList.add('vt-visible');
    const rect = popup.getBoundingClientRect();
    // 边界判断统一在视口坐标进行: 选区模式下 x/y 是文档坐标, 需减去滚动量
    const sx = selPopupPinned ? 0 : window.scrollX;
    const sy = selPopupPinned ? 0 : window.scrollY;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const selBottomVp = y - sy;
    const selTopVp = (typeof selTopY === 'number' ? selTopY : y) - sy;
    let left = x;
    let top = y + 10; // 默认: 选区下方 10px
    if (selBottomVp + 10 + rect.height > vh - 12) {
      // 下方放不下 → 尝试选区上方: 弹窗底边贴选区顶边上方 10px, 不遮挡选中文本
      const topAboveVp = selTopVp - 10 - rect.height;
      if (topAboveVp >= 12) {
        top = topAboveVp + sy;
      } else {
        // 上下都放不下: 夹在视口内
        top = Math.max(sy + 12, Math.min(top, sy + vh - rect.height - 12));
      }
    }
    if (left + rect.width > sx + vw - 12) left = sx + vw - rect.width - 12;
    if (left < sx + 12) left = sx + 12;
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
  }

  // 检测扩展 context 是否失效 (扩展重载/更新后旧页面的 content script 会失效)
  function runtimeAlive() {
    try { chrome.runtime.getURL(''); return true; } catch (e) { return false; }
  }

  function showPopup(text, posX, posY) {
    hideBtn();
    const hasFixedPos = typeof posX === 'number' && typeof posY === 'number';
    // Alt+T 剪贴板翻译 (固定坐标) → 固定模式, 弹窗不随滚动关闭
    selPopupPinned = hasFixedPos;
    if (!runtimeAlive()) {
      const sel = window.getSelection();
      let x = 0, y = 0, selTop = 0;
      if (sel && sel.rangeCount) {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        x = rect.left + window.scrollX;
        y = rect.bottom + window.scrollY;
        selTop = rect.top + window.scrollY;
      }
      const popup = createPopup();
      const body = popup.querySelector('.vt-popup-body');
      popup.querySelector('.vt-popup-engine').textContent = '小T翻译';
      body.innerHTML = '<div class="vt-popup-error">插件已更新，请刷新本页面后重试</div>';
      positionPopup(x, y, selTop);
      return;
    }
    let x = 0, y = 0, selTop = 0;
    if (hasFixedPos) {
      x = posX;
      y = posY;
      selTop = posY;
    } else {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        x = rect.left + window.scrollX;
        y = rect.bottom + window.scrollY;
        selTop = rect.top + window.scrollY;
      }
    }
    const sel = window.getSelection();
    const popup = createPopup();
    const engineEl = popup.querySelector('.vt-popup-engine');
    const body = popup.querySelector('.vt-popup-body');
    body.innerHTML = '<div class="vt-popup-loading">正在翻译...</div>';
    engineEl.textContent = '小T翻译';
    positionPopup(x, y, selTop);

    // 普通网页: auto→zh; 文档翻译页: 跟随页面语言选择器
    const srcSel = document.getElementById('srcLang');
    const tgtSel = document.getElementById('tgtLang');
    const from = srcSel ? srcSel.value : 'auto';
    const to = tgtSel ? tgtSel.value : 'zh';
    chrome.runtime.sendMessage(
      { type: 'vtTranslate', text: text, from: from, to: to },
      res => {
        if (chrome.runtime.lastError) {
          body.innerHTML = '<div class="vt-popup-error">翻译失败: ' + escapeHtml(chrome.runtime.lastError.message) + '</div>';
          return;
        }
        if (!res || !res.ok) {
          body.innerHTML = '<div class="vt-popup-error">' + escapeHtml(res && res.error ? res.error : '未知错误') + '</div>';
          return;
        }
        const names = { baidu: '百度翻译', volcengine: '火山翻译', tencent: '腾讯翻译', custom: '自定义模型' };
        engineEl.textContent = (names[res.backend] || '小T翻译') + (res.cached ? ' · 缓存' : '');
        body.innerHTML = '';
        const p = document.createElement('div');
        p.className = 'vt-popup-result';
        p.textContent = res.translated;
        body.appendChild(p);
        // 浮窗定位可能因内容变化需要重新校正 (固定坐标模式下选区不可用, 保持原位)。
        // 仅在浮窗仍可见时重定位: 翻译期间用户可能已滚动/Esc/✕ 关闭, 慢引擎响应可迟至
        // 数十秒后, 无条件 positionPopup 会给已关闭的浮窗重新加上 vt-visible "复活" (V1.5.55)
        if (popup.classList.contains('vt-visible') && !hasFixedPos && sel && sel.rangeCount && String(sel.toString()).trim()) {
          const rect = sel.getRangeAt(0).getBoundingClientRect();
          positionPopup(rect.left + window.scrollX, rect.bottom + window.scrollY, rect.top + window.scrollY);
        }
      }
    );
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 获取选中文本及选区位置 (兼容 input/textarea 内的选择)
  function getSelectionInfo(e) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
      try {
        const s = t.selectionStart;
        const en = t.selectionEnd;
        if (typeof s === 'number' && typeof en === 'number' && en > s) {
          return { text: t.value.substring(s, en), rect: t.getBoundingClientRect(), source: 'input' };
        }
      } catch (err) {}
      return { text: '', rect: null, source: 'input-empty' };
    }
    const sel = window.getSelection();
    const text = sel ? String(sel.toString()).trim() : '';
    if (!sel || !sel.rangeCount || !text) return { text: text, rect: null, source: 'selection' };
    return { text: text, rect: sel.getRangeAt(0).getBoundingClientRect(), source: 'selection' };
  }

  function onMouseUp(e) {
    const t = e.target;
    if (t && t.closest && t.closest('#' + BTN_ID + ', #' + POPUP_ID)) return;
    const info = getSelectionInfo(e);
    if (!info.text || info.text.length < 2 || info.text.length > 3000) {
      hideBtn();
      return;
    }
    if (!info.rect || (info.rect.width === 0 && info.rect.height === 0)) {
      return;
    }
    pendingText = info.text;
    const btn = createBtn();
    const btnRect = btn.getBoundingClientRect();
    let left = info.rect.left + window.scrollX + info.rect.width / 2 - btnRect.width / 2;
    let top = info.rect.bottom + window.scrollY + 6;
    left = Math.max(8, Math.min(left, window.scrollX + window.innerWidth - btnRect.width - 8));
    btn.style.left = left + 'px';
    btn.style.top = top + 'px';
    btn.style.zIndex = Z_INDEX;
    btn.classList.add('vt-visible');
  }

  function onSelectionChanged() {
    const sel = window.getSelection();
    const text = sel ? String(sel.toString()).trim() : '';
    if (!text) {
      hideBtn();
    }
  }

  function showErrorPopup(message) {
    selPopupPinned = true;
    hideBtn();
    const popup = createPopup();
    popup.querySelector('.vt-popup-engine').textContent = '小T翻译';
    const body = popup.querySelector('.vt-popup-body');
    body.innerHTML = '<div class="vt-popup-error">' + escapeHtml(message) + '</div>';
    const x = Math.max(12, window.innerWidth - 392);
    const y = 16;
    positionPopup(x, y);
  }

  // ===== 快捷键划词翻译 (原生 PDF 阅读器内: 选中文本 → Ctrl+C → Alt+T) =====
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'vtGetSelection') {
      const sel = window.getSelection();
      const text = sel ? String(sel.toString()).trim() : '';
      sendResponse({ text: text });
      // 非空选区同时经 runtime 通道上报 (V1.5.55): background 从 sender.frameId 得知来源,
      // 展示定向到该 frame——修复广播方案在多 frame 页面误判"无选区"/每个 iframe 各弹一窗
      if (text) {
        try {
          chrome.runtime.sendMessage({ type: 'vtSelectionFound', text: text }, () => {
            void chrome.runtime.lastError;
          });
        } catch (e) {}
      }
      return;
    }
    if (msg.type === 'vtShowSelectionTranslation') {
      if (msg.error) {
        showErrorPopup(msg.error);
      } else if (msg.text) {
        // 视口坐标 (固定模式): 弹窗固定在右上角, 不随滚动关闭
        const x = Math.max(12, window.innerWidth - 392);
        const y = 16;
        showPopup(msg.text, x, y);
      }
      return;
    }
    if (msg.type === 'vtPdfDetected') {
      createPdfLauncher();
    }
  });

  // ===== 原生 PDF 阅读器页面: 显示快捷入口 =====
  // Chrome 原生 PDF 是插件进程, 页面内选区事件无法被监听, 提供一键进入可划词阅读页
  // 新版 Chrome 的 embed 在闭合 shadow root 内, querySelector 探测不到,
  // 优先用 document.contentType (Chrome 提交 PDF 导航后为 'application/pdf'),
  // 再由 background 通过响应头检测结果主动通知 (vtPdfDetected)
  function isNativePdfPage() {
    try {
      if (document.contentType && /pdf/i.test(document.contentType)) return true;
    } catch (e) {}
    // 本地文件直接打开 (file://): 无 HTTP 响应头可供 background 检测,
    // 按协议 + 文件名后缀判断 (拖拽/双击打开的本地 PDF, URL 即文件路径)
    try {
      if (location.protocol === 'file:' && /\.pdf$/i.test(decodeURIComponent(location.pathname))) return true;
    } catch (e) {}
    try {
      if (document.querySelector('embed[type="application/pdf"], embed[type="application/x-google-chrome-pdf"]')) return true;
    } catch (e) {}
    return false;
  }

  function createPdfLauncher() {
    if (document.getElementById('vt-pdf-launcher')) return;
    const el = document.createElement('div');
    el.id = 'vt-pdf-launcher';
    el.className = 'vt-pdf-launcher';
    el.innerHTML = '<span class="vt-pdf-launcher-icon">译</span><span>划词翻译原文</span>';
    el.title = '在小T翻译阅读页打开此 PDF，选中原文即可翻译\n也可以：选中文本 → Ctrl+C → 按 Alt+T 直接在本页翻译';
    el.addEventListener('click', () => {
      if (!runtimeAlive()) {
        alert('插件已更新，请刷新本页面后重试');
        return;
      }
      // 经 background 打开 (chrome.tabs.create 属扩展上下文,
      // 若直接 window.open(chrome-extension://...) 会因资源非 web-accessible 被 Chrome 拦截)
      chrome.runtime.sendMessage({ type: 'vtOpenDocTranslate', url: location.href }, () => {
        void chrome.runtime.lastError;
      });
    });
    document.documentElement.appendChild(el);
    console.log('[VT] 原生 PDF 快捷入口已显示:', location.href);
  }

  let pdfDetectTries = 0;
  function detectNativePdf() {
    if (runtimeAlive() && isNativePdfPage()) {
      createPdfLauncher();
      return;
    }
    if (++pdfDetectTries < 30) setTimeout(detectNativePdf, 500);
  }
  detectNativePdf();

  // background 通过响应头检测到本标签页是 PDF 时主动通知 (covers contentType 不可用的场景)
  chrome.runtime.sendMessage({ type: 'vtIsPdfTab' }, res => {
    void chrome.runtime.lastError;
    if (res && res.isPdf) createPdfLauncher();
  });

  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('selectionchange', onSelectionChanged);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { hidePopup(); hideBtn(); }
  });
  window.addEventListener('scroll', e => {
    // 浮窗/浮标内部滚动不关闭 (捕获监听会收到所有滚动容器的 scroll, 浮窗正文有
    // max-height 滚动区, 不排除则滚轮查看长译文时浮窗立即消失, V1.5.55 修复)
    if (e.target && e.target.closest && e.target.closest('#' + BTN_ID + ', #' + POPUP_ID)) return;
    hideBtn();
    // Alt+T 固定弹窗不随滚动关闭; 选区弹窗保持原有随滚动关闭行为
    if (!selPopupPinned) hidePopup();
  }, true);
})();
