/**
 * Background Service Worker (ES Module)
 * - 初始化默认配置
 * - 划词翻译消息通道: content.js → translate → 缓存只读复用 → 各翻译引擎
 */
import { translateText, validateBackendConfig, cacheBackendId } from './lib/translator.js';
import { cacheGet } from './lib/cache.js';
import { mergeHardWraps } from './lib/text-utils.js';
import { recordLocalUsage } from './lib/usage.js';
import { hasSession, LOGIN_REQUIRED_MSG } from './lib/auth-gate.js';

const DEFAULT = {
  backend: 'baidu',
  baiduAppId: '',
  baiduKey: '',
  volcAccessKeyId: '',
  volcSecretAccessKey: '',
  tencentSecretId: '',
  tencentSecretKey: '',
  customBaseUrl: '',
  customApiKey: '',
  customModel: '',
  autoOpenPdf: false
};

// 引擎已合并: 旧「本地翻译(v2)」配置自动迁移为自定义模型 (Ollama OpenAI 兼容接口)
function migrateLocalConfig(cfg) {
  if (!cfg || cfg.backend !== 'local') return cfg;
  const out = Object.assign({}, cfg, { backend: 'custom' });
  if (!out.customBaseUrl || !out.customBaseUrl.trim()) {
    out.customBaseUrl = String(out.localBaseUrl || 'http://localhost:11434').trim().replace(/\/+$/, '') + '/v1';
  }
  if (!out.customModel || !out.customModel.trim()) {
    const m = String(out.localModel || 'v2').trim();
    out.customModel = m === 'v2' ? 'zh-en-mt-v2' : m === 'v1' ? 'zh-en-mt' : m === 'hy-mt2' ? 'hy-mt2' : m;
  }
  delete out.localBaseUrl;
  delete out.localModel;
  return out;
}

function loadConfig() {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(['vtConfig'], r => {
        const cfg = r && r.vtConfig ? Object.assign({}, DEFAULT, r.vtConfig) : DEFAULT;
        resolve(migrateLocalConfig(cfg));
      });
    } catch (e) {
      resolve(DEFAULT);
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['vtConfig'], r => {
    if (!r.vtConfig) {
      chrome.storage.local.set({ vtConfig: DEFAULT });
    } else {
      // 合并新增字段 (如 custom 引擎配置)
      const merged = Object.assign({}, DEFAULT, r.vtConfig);
      chrome.storage.local.set({ vtConfig: merged });
    }
  });
});

// ===== 自动接管 PDF (开关开启时, 打开 PDF 链接自动跳转到可划词的翻译阅读页) =====
let autoOpenPdf = false;

function refreshAutoOpenPdf(cfg) {
  autoOpenPdf = !!(cfg && cfg.autoOpenPdf);
}

chrome.storage.local.get(['vtConfig'], r => refreshAutoOpenPdf(r && r.vtConfig));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.vtConfig) {
    refreshAutoOpenPdf(changes.vtConfig.newValue);
  }
});

// ===== PDF 页面检测 (供 content script 在原生阅读器页显示快捷入口) =====
const pdfTabs = new Map(); // tabId -> PDF 响应 URL
const PDF_TABS_KEY = 'vtPdfTabs';

// MV3 SW 空闲 30s 即被杀, 内存 Map 会丢 (V1.5.55 修复):
// 持久化到 storage.session (浏览器会话内存活, SW 重启时恢复)
chrome.storage.session.get([PDF_TABS_KEY], r => {
  const saved = r && r[PDF_TABS_KEY];
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(saved)) pdfTabs.set(Number(k), saved[k]);
  }
});

function persistPdfTabs() {
  const obj = {};
  for (const entry of pdfTabs.entries()) obj[String(entry[0])] = entry[1];
  try {
    chrome.storage.session.set({ [PDF_TABS_KEY]: obj }, () => { void chrome.runtime.lastError; });
  } catch (e) {}
}

// 标签页关闭时清理记录 (V1.5.55: 此前无清理, 截断按插入序删可能误删仍打开的标签页)
chrome.tabs.onRemoved.addListener(tabId => {
  if (pdfTabs.delete(tabId)) persistPdfTabs();
});

function recordPdfTab(details) {
  if (details.tabId < 0) return;
  pdfTabs.set(details.tabId, details.url || '');
  if (pdfTabs.size > 100) {
    // 防止无限增长: 简单清理 (保留最近 50 条)
    const keys = Array.from(pdfTabs.keys());
    for (const k of keys.slice(0, keys.length - 50)) pdfTabs.delete(k);
  }
  persistPdfTabs();
  // 主动通知页面 (content script 通常在响应头之后才注入, 该推送常失败; 注入时还会经 vtIsPdfTab 拉取)
  try {
    chrome.tabs.sendMessage(details.tabId, { type: 'vtPdfDetected' }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) {}
}

chrome.webRequest.onHeadersReceived.addListener(
  details => {
    if (details.type !== 'main_frame' || details.tabId < 0) return;
    const headers = details.responseHeaders || [];
    for (const h of headers) {
      if (h.name && h.name.toLowerCase() === 'content-type' && /pdf/i.test(h.value || '')) {
        if (autoOpenPdf) {
          // MV3 下无回调的 tabs API 返回 Promise, 需捕获避免未处理拒绝 (标签页可能已被关闭)
          chrome.tabs.update(details.tabId, {
            url: chrome.runtime.getURL('doc-translate.html?url=' + encodeURIComponent(details.url))
          }).catch(() => {});
        } else {
          recordPdfTab(details);
        }
        return;
      }
    }
  },
  { urls: ['http://*/*', 'https://*/*'] },
  ['responseHeaders']
);

// mergeHardWraps 已抽出至 lib/text-utils.js (V1.5.47, 供单元测试复用)

// 划词翻译消息通道
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  // content script 询问: 本标签页是否为 background 通过响应头检测到的 PDF
  if (msg.type === 'vtIsPdfTab') {
    const tabId = sender.tab && sender.tab.id;
    const norm = u => String(u || '').split('#')[0];
    const isPdf = typeof tabId === 'number' &&
      pdfTabs.has(tabId) &&
      norm(pdfTabs.get(tabId)) === norm(sender.tab && sender.tab.url);
    sendResponse({ isPdf: !!isPdf });
    return;
  }
  // content script 请求打开文档翻译阅读页 (原生 PDF 快捷入口; file:// 为本地文件直接打开的 PDF)
  if (msg.type === 'vtOpenDocTranslate') {
    const url = String(msg.url || '');
    if (/^(https?|file):\/\//i.test(url)) {
      chrome.tabs.create({
        url: chrome.runtime.getURL('doc-translate.html?url=' + encodeURIComponent(url))
      }).catch(() => {});
    }
    sendResponse({ ok: true });
    return;
  }
  // Alt+T 选区上报 (V1.5.55): 各 frame 收到 vtGetSelection 后经此通道上报非空选区,
  // background 从 sender 获知来源 tab/frame, 展示时定向投递 (不再广播)
  if (msg.type === 'vtSelectionFound') {
    const tabId = sender.tab && sender.tab.id;
    const text = String(msg.text || '').trim();
    if (typeof tabId === 'number' && tabId === selectionExpectedTab && text && selectionResolve) {
      selectionReports.push({ tabId: tabId, frameId: sender.frameId || 0, text: text });
    }
    sendResponse({ ok: true });
    return;
  }
  if (msg.type !== 'vtTranslate') return;
  (async () => {
    try {
      // 逐行硬换行合并为连续段落: 否则引擎按行逐句翻译, 译文行长短不一, 两端对齐失效
      const text = mergeHardWraps(String(msg.text || '').trim());
      if (!text) {
        sendResponse({ ok: false, error: '没有可翻译的文本' });
        return;
      }
      // 强制登录门禁 (V1.7.81): 划词翻译也属于受限功能, 未登录直接引导注册
      if (!(await hasSession())) {
        sendResponse({ ok: false, error: LOGIN_REQUIRED_MSG, needLogin: true });
        return;
      }
      const config = await loadConfig();
      const backend = config.backend || 'baidu';
      const invalid = validateBackendConfig(backend, config);
      if (invalid) {
        sendResponse({ ok: false, error: invalid });
        return;
      }
      // 缓存只读复用 (V1.5.39): 命中说明该文本被文档翻译缓存过, 直接复用 (划词零成本秒出);
      // 未命中则直调引擎, 结果不再写缓存 —— 划词文本多为一次性、命中率低,
      // 写入只会让本地与云端公共池积累低价值条目
      // custom 引擎的缓存键含端点+模型 (V1.5.50), 与文档翻译同键互通
      try {
        const cached = await cacheGet(cacheBackendId(backend, config), msg.from || 'auto', msg.to || 'zh', text);
        if (cached) {
          sendResponse({ ok: true, translated: cached, cached: true, backend: backend });
          return;
        }
      } catch (e) {
        console.warn('[BG] 缓存读取失败:', e);
      }

      const translated = await translateText(text, msg.from || 'auto', msg.to || 'zh', backend, config);
      // BYOK 划词用量按天记 chrome.storage (V1.7.14「历史用量」页数据源; 划词不产生历史记录)。
      // proxy 划词不计本地——官方引擎以服务端 translate_usage 为准, 避免与历史记录双计。
      if (backend && backend !== 'proxy') {
        recordLocalUsage({ byok: { [backend]: Array.from(text).length } });
      }
      sendResponse({ ok: true, translated: translated, cached: false, backend: backend });
    } catch (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  })();
  return true; // 异步 sendResponse
});

// ===== 快捷键划词翻译 (原生 PDF 阅读器内: 选中文本 → Ctrl+C → Alt+T) =====
// Chrome 原生 PDF 插件内的选区无法被 content script 直接读取, 通过剪贴板中转

// offscreen 文档创建去重 (V1.5.55): 并发触发 Alt+T 时两次 createDocument,
// 后者抛 "Only a single offscreen document may be created" 被误当读取失败返回空串
let offscreenCreating = null;

async function readClipboardText() {
  try {
    if (!(await chrome.offscreen.hasDocument())) {
      if (!offscreenCreating) {
        offscreenCreating = chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['CLIPBOARD'],
          justification: '读取用户复制的选中文本用于划词翻译'
        });
        offscreenCreating.then(() => { offscreenCreating = null; }, () => { offscreenCreating = null; });
      }
      try {
        await offscreenCreating;
      } catch (e) {
        // 并发创建冲突: 文档可能已被并发调用建成, 再查一次确认存在则继续读取
        if (!(await chrome.offscreen.hasDocument())) throw e;
      }
    }
    return await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'vtReadClipboard' }, res => {
        if (chrome.runtime.lastError || !res || !res.ok) resolve('');
        else resolve(String(res.text || ''));
      });
    });
  } catch (e) {
    console.warn('[BG] 剪贴板读取失败:', e);
    return '';
  }
}

// Alt+T 选区收集 (V1.5.55 修复): 此前 vtGetSelection/vtShowSelectionTranslation 广播到
// 标签页所有 frame——① 每个 iframe 各弹一个浮窗; ② 多 frame 响应只有第一个生效, 选区在
// iframe 内时顶层空选区先到, 误判"无选区"后译到无关的剪贴板旧内容。
// 现改为: 各 frame 收到 vtGetSelection 后经 runtime.sendMessage 上报选区 (background 从
// sender.frameId 得知来源), 短窗口内收集取最长者, 展示用 frameId 精确投递。
let selectionReports = [];
let selectionResolve = null;
let selectionExpectedTab = null;

function collectSelectionReports(tabId, waitMs) {
  selectionReports = [];
  selectionExpectedTab = tabId;
  return new Promise(resolve => {
    selectionResolve = resolve;
    chrome.tabs.sendMessage(tabId, { type: 'vtGetSelection' }, () => {
      void chrome.runtime.lastError; // 无 content script 的页面 (chrome:// 等)
    });
    setTimeout(() => {
      if (!selectionResolve) return;
      selectionResolve = null;
      selectionExpectedTab = null;
      resolve(selectionReports.splice(0));
    }, waitMs);
  });
}

chrome.commands.onCommand.addListener(async command => {
  if (command !== 'translate-clipboard-selection') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || typeof tab.id !== 'number' || tab.id < 0) return;
    // 优先取页面内可直接访问的选区 (普通网页): 各 frame 上报, 取最长者
    let selInfo = null;
    try {
      const reports = await collectSelectionReports(tab.id, 180);
      if (reports.length) {
        reports.sort((a, b) => b.text.length - a.text.length);
        selInfo = reports[0];
      }
    } catch (e) { selInfo = null; }
    let text = selInfo ? selInfo.text : '';
    // 取不到再读剪贴板 (原生 PDF 阅读器)
    if (!text) text = (await readClipboardText()).trim();
    if (text.length > 3000) text = text.slice(0, 3000);
    const frameId = selInfo ? selInfo.frameId : 0; // 无选区走剪贴板时提示发顶层 frame
    if (!text || text.length < 2) {
      // 无回调的 sendMessage 在接收方不存在时会抛未捕获异常, 必须带回调消费 lastError
      chrome.tabs.sendMessage(tab.id, {
        type: 'vtShowSelectionTranslation',
        error: '没有找到选中文本。请在 PDF 中选中文字后按 Ctrl+C 复制，再按 Alt+T 翻译。'
      }, { frameId: frameId }, () => { void chrome.runtime.lastError; });
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'vtShowSelectionTranslation', text: text }, { frameId: frameId }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) {
    console.warn('[BG] 快捷键翻译失败:', e);
  }
});
