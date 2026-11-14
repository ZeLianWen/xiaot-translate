/**
 * 文档翻译 - PDF 解析 + 翻译 + 双语对照显示
 * 左侧: pdf.js canvas + TextLayer (原文可选择)
 * 右侧: 空白页 + 段落级译文层 (译文按段落自然换行, 锚定原文段落位置, 字号自适应)
 *
 * 基础版新增:
 * - 段落级本地缓存复用 (lib/cache.js, 命中缓存零成本秒翻)
 * - 导出双语对照 HTML (替代云端分享链接, 无需后端)
 * - 自定义模型引擎 (OpenAI 兼容接口 / Ollama 本地部署)
 */
import { translateText, validateBackendConfig, maxRequestBytes, utf8Len, cacheBackendId, PRO_UPSELL_TIP, PRO_PURCHASE_ENABLED, PRO_PURCHASE_COMING_SOON_TIP, cloudChat, customChat, cloudTts, baiduTts, groupParagraphBatches, splitBatchTranslation, concurrencyForEngine, runWithConcurrency } from './lib/translator.js';
import { buildChatMessages } from './lib/ai-summary.js';
import { historyPut, historyAll, historyGet, historyDelete, historyClear, HISTORY_LIMIT, cacheGetEx, cacheSet, cacheAll, cacheDelete, cacheClear, CACHE_LIMIT } from './lib/cache.js';
import { cloudUploadRecord, cloudListRecords, cloudDownloadRecord, cloudDeleteRecord, cloudPushAll, cloudPullMissing, cloudClearAll } from './lib/cloud-sync.js';
import { getEntitlement } from './lib/entitlement.js';
import { maskInlineMath, restoreInlineMath } from './lib/text-utils.js';
import { buildTableRows, detectTableParagraphs, TABLE_CELL_GAP, TABLE_MAX_CELL_CHARS, TABLE_MIN_ROWS } from './lib/table-detect.js';
import { getValidSession } from './lib/supabase-auth.js';
import { hasSession, mountAuthGate } from './lib/auth-gate.js';
import { recordLocalUsage, readLocalUsage, rangeInfo, fetchCloudAiUsage, dayKeyLocal } from './lib/usage.js';

(async function() {
  'use strict';

  // 强制登录门禁 (V1.7.81): 未登录只显示注册/登录浮层, 登录成功后重载页面继续原流程
  if (!(await hasSession())) {
    mountAuthGate({ onSuccess: () => location.reload() });
    return;
  }

  const uploadBox = document.getElementById('uploadBox');
  const fileInput = document.getElementById('fileInput');
  const uploadArea = document.getElementById('uploadArea');
  const historyBtn = document.getElementById('historyBtn');
  const historyPanel = document.getElementById('historyPanel');
  const historyList = document.getElementById('historyList');
  const cachePanel = document.getElementById('cachePanel');
  const cacheList = document.getElementById('cacheList');
  const historyPager = document.getElementById('historyPager');
  const cachePager = document.getElementById('cachePager');
  const usagePanel = document.getElementById('usagePanel');
  const planPanel = document.getElementById('planPanel');
  const planCurrent = document.getElementById('planCurrent');
  const usageTitle = document.getElementById('usageTitle');
  const usageStatsBox = document.getElementById('usageStats');
  const historyCloudBtn = document.getElementById('historyCloudBtn');
  const topProgress = document.getElementById('topProgress');
  const topProgressFill = document.getElementById('topProgressFill');
  const translateTimeEl = document.getElementById('translateTime');
  const topProgressText = document.getElementById('topProgressText');
  const topProgressPct = document.getElementById('topProgressPct');
  const docView = document.getElementById('docView');
  const translateBtn = document.getElementById('translateBtn');
  const backBtn = document.getElementById('backBtn');
  const shareBtn = document.getElementById('shareBtn');
  const ttsBtn = document.getElementById('ttsBtn');
  const aiSummaryBtn = document.getElementById('aiSummaryBtn');
  const srcLang = document.getElementById('srcLang');
  const tgtLang = document.getElementById('tgtLang');
  const selAutoToggle = document.getElementById('selAutoToggle');
  const selAutoTranslateEl = document.getElementById('selAutoTranslate');

  // 选中即译 (V1.7.80): 原文中选中文字后直接弹出译文, 无需再点「译」浮标;
  // 译文区选中仍用于添加批注。开关存 chrome.storage.local, 默认关闭 (防误触)。
  let selAutoTranslate = false;
  try {
    chrome.storage.local.get(['vtSelAutoTranslate'], r => {
      selAutoTranslate = !!(r && r.vtSelAutoTranslate);
      selAutoTranslateEl.checked = selAutoTranslate;
    });
  } catch (e) {}
  selAutoTranslateEl.addEventListener('change', () => {
    selAutoTranslate = !!selAutoTranslateEl.checked;
    try { chrome.storage.local.set({ vtSelAutoTranslate: selAutoTranslate }); } catch (e) {}
    if (!selAutoTranslate) hideSelBtn();
  });

  let pages = [];
  let translatedPages = [];
  let pdfArrayBuffer = null;
  let pdfDoc = null;
  let config = {};
  let isTranslating = false;
  // V1.7.2: 翻译中请求取消 (点击「取消翻译」置位; 主循环段落间/分块间检查点消费,
  // 已译段落/整页保留并照常渲染落历史, 延迟最多一个网络请求)
  let cancelTranslateRequested = false;
  let fileName = '';
  let currentHistoryId = null;
  // 本次翻译的缓存统计: 本地缓存命中/云端缓存命中/非缓存(实际调用引擎)的原文符数, 随历史记录保存
  let translateStats = null;
  // V1.7.9: AI 全文分析总结结果: {content, engine, model, mode, chunks, time} 或 null, 随历史记录持久化
  let aiChat = null;
  // AI 总结进行中 (防重入: 按钮点击/重新生成并发触发)
  let aiRunning = false;

  // 译文侧标题的缓存统计文案: 区分本地/云端命中 (V1.5.16); 旧记录 stats 为 {cachedChars, freshChars} 兼容展示
  function statsHintText(stats) {
    if (!stats) return '';
    if (typeof stats.localChars === 'number') {
      return '· 本地缓存 ' + stats.localChars + ' 字 / 云端缓存 ' + (stats.cloudChars || 0) + ' 字 / 非缓存 ' + stats.freshChars + ' 字';
    }
    return '· 缓存命中 ' + stats.cachedChars + ' 字 / 非缓存 ' + stats.freshChars + ' 字';
  }
  // canvas 位图按设备像素比渲染 (上限 2 防止大文档内存过大), CSS 尺寸恒为 1 倍 PDF 点
  // V1.7.83: 改为函数动态取值——浏览器缩放 (Ctrl+±) 会改变 devicePixelRatio, 缩放后需按新倍率重绘位图
  function realDpr() { return window.devicePixelRatio || 1; }
  function deviceDpr() { return Math.min(realDpr(), 2); }
  // 高清渲染 (V1.7.64): 在设备像素之上再超采样 1.5 倍, 再按全文档像素预算收敛;
  // 旧公式 renderScale 绝对封顶 2.6, 宽栏 (fitScale ≈ 1.9) 下像素比被压到 ~1.3, 原文明显发糊
  const SUPERSAMPLE = 1.5;          // 超采样倍率 (相对设备像素)
  const MAX_RENDER_RATIO = 3;       // 单页像素比硬上限
  const PAGE_PIXEL_BUDGET = 120e6;  // 左右栏所有 canvas 位图像素总量 (RGBA ≈ 480MB), 200+ 页时自动回落
  // 缩放增强 (V1.7.83): 放大查看时可视页允许突破预算限制 (仅当前可见的 1~3 页, 内存可控),
  // 否则长文档的像素预算会把放大后的像素比仍压在 ~2.5, 放大依旧发虚
  const MAX_BOOST_RATIO = 4;

  // 单页像素比: 旧公式下限 (保证不降级) + 超采样/硬上限/全文档像素预算三约束。
  // 抽成函数供初始渲染与缩放重渲染共用 (V1.7.83), 两条路径倍率计算完全一致。
  function computePixelRatio(fitScale, cssW, cssH, pageTotal) {
    const dpr = deviceDpr();
    const legacyRatio = Math.min(dpr, 2.6 / fitScale);
    const budgetPerPage = PAGE_PIXEL_BUDGET / Math.max(pageTotal * 2, 2); // 左右栏各一张 canvas
    const ratioByBudget = Math.sqrt(budgetPerPage / Math.max(cssW * cssH, 1));
    return Math.max(legacyRatio, Math.min(dpr * SUPERSAMPLE, MAX_RENDER_RATIO, ratioByBudget));
  }

  // 放大增强倍率: 只给「当前可视页」用 (突破像素预算与常规上限), 页面滚出可视区后回落常规倍率。
  // 用真实设备像素比 (不做 2 倍截断), 浏览器放大到 200% 时倍率正好等于物理像素密度。
  function computeBoostRatio() {
    return Math.min(realDpr() * SUPERSAMPLE, MAX_BOOST_RATIO);
  }
  // 是否需要放大增强: 浏览器缩放 > 100% (2x 屏 dpr=2) 时才有意义, 常规 100% 不额外重绘
  function boostActive() {
    return realDpr() > 2.05;
  }
  // 页面整体字号小一号 (V1.7.53): 栏宽适配结果再 ×0.9, 原文与译文同步缩小
  const PAGE_FONT_SCALE = 0.9;
  // 参考文献条目标记: [1]/[23]/［2］ (半角/全角中括号 + 1~3 位数字, 允许空白)
  const REF_ENTRY_RE = /^\s*[\[［]\s*\d{1,3}\s*[\]］]/;

  // ===== 译文批注: 选中译文文字 → "批注"浮标 → 编辑器输入 → 黄色高亮 + 批注侧栏卡片 =====
  const ANNO_BTN_ID = 'vt-anno-btn';
  const ANNO_EDITOR_ID = 'vt-anno-editor';
  // 批注侧栏: 译文窗口之外的右侧固定栏, 卡片纵向对齐各自高亮行, 不遮挡译文
  const annoRail = document.getElementById('vtAnnoRail');
  // 批注列表: {id, page, paraIdx, text, note}, 随历史记录持久化
  let annotations = [];
  // 待保存批注: 批注编辑器打开期间持有选区信息 (页码/段落索引/选中文本/段落元素/编辑器期望坐标)
  let pendingAnno = null;
  // 渲染期间的批注还原标记集合: 渲染开始时全部批注置入, 随段落还原成功逐个移出,
  // 渲染结束仍滞留的即失效批注 (所在段落已删除或译文内容变化), 予以剔除
  let staleAnnoIds = null;
  // 渲染后的右栏页元素索引: 页码 → {wrapper, cssViewport}, 逐页翻译完成时增量叠加译文层
  let rightPageEls = new Map();
  // 本次渲染的每页位图记录 (V1.7.83): 浏览器缩放后按新设备像素比重绘 canvas 用
  let pageRenderRecords = [];
  // 左栏滚动容器 (V1.7.83): 判断某页是否在可视区内, 供放大增强只作用于可见页
  let leftPaneEl = null;
  // 译文侧标题的缓存统计提示元素, 逐页翻译过程中实时刷新数值
  let statsHintEl = null;
  // 渲染代次: 每次 renderPdfPages 自增; 渲染过程中若代次被更新 (新一轮渲染 / 返回上传),
  // 旧渲染立即放弃, 避免两轮异步渲染交错改写 docView (V1.5.24 修复首次渲染与「开始翻译」并发)
  let renderToken = 0;

  function loadConfig() {
    return new Promise(resolve => {
      try {
        chrome.storage?.local?.get(['vtConfig'], r => {
          if (r?.vtConfig) config = r.vtConfig;
          resolve();
        });
      } catch(e) { resolve(); }
    });
  }

  function updateProgress(pct, text) {
    topProgressFill.style.width = pct + '%';
    topProgressPct.textContent = Math.round(pct) + '%';
    if (text) topProgressText.textContent = text;
  }

  function showProgress() {
    topProgress.style.display = 'block';
  }

  function hideProgress() {
    topProgress.style.display = 'none';
  }

  uploadBox.addEventListener('click', () => fileInput.click());

  uploadBox.addEventListener('dragover', e => {
    e.preventDefault();
    uploadBox.classList.add('dragover');
  });
  uploadBox.addEventListener('dragleave', () => uploadBox.classList.remove('dragover'));
  uploadBox.addEventListener('drop', e => {
    e.preventDefault();
    uploadBox.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') handleFile(file);
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) handleFile(file);
  });

  async function handleFile(file) {
    showProgress();
    updateProgress(0, '正在读取文件...');
    try {
      const buffer = await file.arrayBuffer();
      await loadPdfBuffer(buffer, file.name);
    } catch (e) {
      // arrayBuffer 读取失败此前未捕获: 进度条悬置、无任何提示 (V1.5.55)
      console.error('[DocTranslate] 文件读取失败:', e);
      alert('文件读取失败: ' + e.message);
      hideProgress();
    }
  }

  // 从 ArrayBuffer 解析 PDF (本地上传与在线下载共用)
  async function loadPdfBuffer(buffer, name) {
    // 翻译进行中禁止换文档: 翻译循环异步遍历 pages/translatedPages,
    // 中途换档会并发改写状态、污染双方记录 (V1.5.55)
    if (isTranslating) {
      alert('正在翻译中，请点击「取消翻译」停止后再打开其他文档');
      hideProgress();
      return;
    }
    // 释放旧文档 worker 资源: pdf.js 文档不 destroy 会随会话累积泄漏 (V1.5.55)
    if (pdfDoc) {
      try { const d = pdfDoc; pdfDoc = null; d.destroy().catch(() => {}); } catch (e) {}
    }
    fileName = name;
    currentHistoryId = null;
    pdfArrayBuffer = buffer;
    // 换新文档: 上一份的 AI 对话不带入 (V1.7.12)
    aiChat = null;
    updateProgress(10, '正在解析 PDF...');

    try {
      if (!pdfjsLib) {
        alert('PDF 解析库加载失败，请刷新页面重试');
        return;
      }
      pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');
      pdfDoc = await pdfjsLib.getDocument({ data: pdfArrayBuffer.slice(0) }).promise;
      const totalPages = pdfDoc.numPages;
      pages = [];

      for (let i = 1; i <= totalPages; i++) {
        const page = await pdfDoc.getPage(i);
        const viewport = page.getViewport({ scale: 1 });
        const textContent = await page.getTextContent();
        const items = textContent.items.filter(it => it.str && it.str.trim());
        const lines = extractLines(items, viewport.transform);
        const paragraphs = linesToParagraphs(lines);
        // 图形区域检测 (图片/图表): 区域内文字保持原文, 渲染时位图原图透出
        const graphicRegions = await detectGraphicRegions(page, viewport);
        pages.push({ pageNum: i, paragraphs: paragraphs, lines: lines, graphicRegions: graphicRegions, pageHeight: viewport.height, pageWidth: viewport.width, pageTransform: viewport.transform });
        updateProgress(10 + (i / totalPages) * 80, `正在解析第 ${i}/${totalPages} 页...`);
      }

      updateProgress(100, `解析完成，共 ${totalPages} 页`);
      translateBtn.disabled = false;
      await showDocView();
    } catch(e) {
      console.error('[DocTranslate] PDF解析失败:', e);
      alert('PDF 解析失败: ' + e.message);
      // 失败时清空解析态: pages = [] 在 getDocument 之后才执行, 若不重置会残留上一份
      // 文档的段落而 pdfArrayBuffer 已换新文件, 造成内存态不一致 (V1.5.28 修复)
      pages = [];
      translatedPages = [];
      pdfDoc = null;
      pdfArrayBuffer = null;
      fileName = '';
      translateBtn.disabled = true;
      translateBtn.textContent = '开始翻译';
      hideProgress();
    }
  }

  // 从 URL 下载 PDF (「翻译当前PDF」入口, ?url= 参数; file:// 为本地文件直接打开的 PDF)
  async function loadPdfFromUrl(url) {
    showProgress();
    updateProgress(0, '正在下载 PDF...');
    const isFile = /^file:\/\//i.test(url);
    try {
      // file:// 无 cookie 语义, 不带 credentials (扩展页 fetch file:// 需开启"允许访问文件网址")
      const resp = await fetch(url, isFile ? {} : { credentials: 'include' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const buffer = await resp.arrayBuffer();
      if (buffer.byteLength < 1024) throw new Error('文件内容异常（可能需要登录访问）');
      await loadPdfBuffer(buffer, pdfNameFromUrl(url));
    } catch (e) {
      console.error('[DocTranslate] 下载PDF失败:', e);
      alert(isFile
        ? '读取本地 PDF 失败: ' + e.message + '\n\n请在 chrome://extensions → 小T翻译 → 详情，开启「允许访问文件网址」后重试；\n或直接通过「文档翻译」上传该文件。'
        : '下载 PDF 失败: ' + e.message + '\n\n若该 PDF 需要登录才能访问，请先下载到本地，再通过「文档翻译」上传。');
      hideProgress();
    }
  }

  function pdfNameFromUrl(url) {
    try {
      const u = new URL(url);
      let name = decodeURIComponent(u.pathname.split('/').pop() || '');
      name = name.replace(/[\\/:*?"<>|]/g, '_');
      if (!name) name = 'document';
      if (!/\.pdf$/i.test(name)) name += '.pdf';
      return name;
    } catch (e) {
      return 'document.pdf';
    }
  }

  function extractLines(items, m) {
    // m = 页面视口 transform: 将 item 用户空间坐标归一为 CSS 像素后再分组/排序,
    // 未旋转页与原用户空间数值等价, /Rotate 90/180/270 旋转页按显示坐标正确分行 (V1.5.55)
    const tf = it => (m ? pdfjsLib.Util.transform(m, it.transform) : it.transform);
    const rows = [];
    let currentRow = null;
    for (const item of items) {
      const y = Math.round(tf(item)[5]);
      if (!currentRow || Math.abs(y - currentRow.y) > 5) {
        currentRow = { y: y, items: [] };
        rows.push(currentRow);
      }
      currentRow.items.push(item);
    }
    const lines = [];
    for (const row of rows) {
      const sorted = row.items.slice().sort((a, b) => tf(a)[4] - tf(b)[4]);
      let text = '';
      for (const it of sorted) text += it.str;
      const fontSize = Math.abs(tf(sorted[0])[0]) || 12;
      lines.push({ text: text, items: sorted, y: row.y, fontSize: fontSize });
    }
    return lines;
  }

  function linesToParagraphs(lines) {
    const paragraphs = [];
    let start = 0;
    for (let i = 1; i <= lines.length; i++) {
      let breakHere = i === lines.length;
      if (!breakHere) {
        const prev = lines[i - 1];
        const cur = lines[i];
        const fsMin = Math.min(prev.fontSize, cur.fontSize) || 12;
        const fsMax = Math.max(prev.fontSize, cur.fontSize) || 12;
        // 参考文献条目行 ([1]/[23]/［2］ 开头) 强制分段: 参考文献区各行字号行距一致, 常规启发式切不开条目, 译文会连成一片
        if (REF_ENTRY_RE.test(cur.text)) {
          breakHere = true;
        }
        // 相邻行字号明显变化 → 分段 (标题/作者/单位等字号各不相同)
        else if (fsMax / fsMin > 1.15 && Math.abs(prev.fontSize - cur.fontSize) > 1) {
          breakHere = true;
        }
        // 行间距明显大于正常行距(>1.8倍较小字号) → 分段
        else if (Math.abs(prev.y - cur.y) > fsMin * 1.8) {
          breakHere = true;
        }
      }
      if (breakHere) {
        const text = lines.slice(start, i).map(l => l.text.trim()).filter(Boolean).join(' ');
        if (text) {
          paragraphs.push({
            original: text,
            translated: '',
            lineStart: start,
            lineEnd: i
          });
        }
        start = i;
      }
    }
    return paragraphs;
  }

  // 进入文档视图并渲染: 渲染完成前保持「开始翻译」禁用, 渲染结束后再启用
  // (此前渲染不 await、按钮立即启用, 用户可在渲染途中再次触发 renderPdfPages; V1.5.24 修复)
  async function showDocView(isTranslated) {
    uploadArea.style.display = 'none';
    docView.style.display = 'block';
    backBtn.style.display = 'inline-flex';
    translateBtn.disabled = true;
    translateBtn.textContent = isTranslated ? '重新翻译' : '开始翻译';
    selAutoToggle.style.display = 'inline-flex';
    shareBtn.style.display = isTranslated ? 'inline-flex' : 'none';
    ttsBtn.style.display = isTranslated ? 'inline-flex' : 'none';
    ttsExportBtn.style.display = isTranslated ? 'inline-flex' : 'none';
    // AI 对话基于原文段落, 翻译前即可用 (V1.7.12 微信式对话; 云端引擎 Pro 预检, 自定义模型免费开放)
    aiSummaryBtn.style.display = 'inline-flex';
    hideProgress();
    try {
      const completed = await renderPdfPages(!!isTranslated);
      // 渲染被新一轮渲染/返回上传取代时 (completed=false) 不启用按钮: 已不在本视图
      if (completed) translateBtn.disabled = false;
    } catch (e) {
      console.warn('[DocTranslate] 文档视图渲染失败:', e);
      translateBtn.disabled = false;
    }
  }

  function showUpload() {
    // 翻译进行中禁止返回: pages/translatedPages 清空会与翻译循环并发交错 (V1.5.55)
    if (isTranslating) {
      alert('正在翻译中，请点击「取消翻译」停止后再返回');
      return;
    }
    // 使进行中的 renderPdfPages 立即失效: 返回上传后旧渲染不应再继续改写 docView
    renderToken++;
    pageRenderRecords = []; // 释放位图记录, 避免缩放监听继续重绘已离开的文档
    leftPaneEl = null;
    uploadArea.style.display = 'flex';
    docView.style.display = 'none';
    backBtn.style.display = 'none';
    selAutoToggle.style.display = 'none';
  shareBtn.style.display = 'none';
  ttsBtn.style.display = 'none';
  ttsExportBtn.style.display = 'none';
  stopTts(); // V1.7.33: 返回上传时停止朗读, 避免继续念别的内容
  closeTtsDialog(); // V1.7.35: 同时中止导出合成
  aiSummaryBtn.style.display = 'none';
  translateTimeEl.textContent = ''; // V1.7.26: 返回上传清空上次耗时统计
    setSidebarActive('pdfTypeItem');
    translateBtn.disabled = true;
    hideProgress();
    updateProgress(0, '正在解析...');
    pages = [];
    translatedPages = [];
    if (pdfDoc) {
      try { const d = pdfDoc; d.destroy().catch(() => {}); } catch (e) {}
    }
    pdfDoc = null;
    pdfArrayBuffer = null;
    fileName = '';
    currentHistoryId = null;
    translateStats = null;
    // 新文档无 AI 对话 (V1.7.12)
    aiChat = null;
    annotations = [];
    updateAnnoRail();
    fileInput.value = '';
    historyPanel.style.display = 'none';
    cachePanel.style.display = 'none';
    usagePanel.style.display = 'none';
    uploadBox.style.display = 'block';
  }

  // ===== 分页 (历史翻译/历史缓存面板共用, 每页 PAGE_SIZE 条, V1.5.18) =====
  const PAGE_SIZE = 10;

  // 构建分页条: 共 N 条 · x/y 页 + ‹ 页码(窗口化) ›; 点击页码回调 onPage(目标页)
  function buildPager(container, totalItems, page, onPage) {
    const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
    const pager = document.createElement('div');
    pager.className = 'history-pager';
    const info = document.createElement('span');
    info.textContent = `共 ${totalItems} 条 · ${page}/${totalPages} 页`;
    pager.appendChild(info);
    const mkBtn = (label, target, disabled, current) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (current) b.className = 'pg-cur';
      if (disabled) { b.disabled = true; }
      else { b.addEventListener('click', () => { onPage(target); }); }
      pager.appendChild(b);
    };
    mkBtn('‹', page - 1, page <= 1, false);
    // 页码窗口: 总页数<=7 全显, 否则 1 … p-1 p p+1 … 末页
    const nums = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) nums.push(i);
    } else {
      nums.push(1);
      if (page > 3) nums.push('…');
      for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) nums.push(i);
      if (page < totalPages - 2) nums.push('…');
      nums.push(totalPages);
    }
    for (const n of nums) {
      if (n === '…') {
        const s = document.createElement('span');
        s.textContent = '…';
        pager.appendChild(s);
      } else {
        mkBtn(String(n), n, false, n === page);
      }
    }
    mkBtn('›', page + 1, page >= totalPages, false);
    container.appendChild(pager);
  }

  // ===== 面板搜索 (历史翻译按文件名, 历史缓存按原文/译文, V1.5.22) =====
  function debounce(fn, ms) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  const historySearchInput = document.getElementById('historySearchInput');
  const cacheSearchInput = document.getElementById('cacheSearchInput');
  let historyKeyword = '';
  let cacheKeyword = '';

  historySearchInput.addEventListener('input', debounce(() => {
    historyKeyword = historySearchInput.value;
    if (historyView === 'cloud') { cloudPage = 1; renderCloudHistoryList(); }
    else { historyPage = 1; renderHistoryList(); }
  }, 250));

  cacheSearchInput.addEventListener('input', debounce(() => {
    cacheKeyword = cacheSearchInput.value;
    cachePage = 1;
    renderCacheList();
  }, 250));

  // 侧栏入口高亮: 当前展示的页面突出显示, 默认文档翻译 (V1.5.23)
  function setSidebarActive(id) {
    for (const el of [document.getElementById('pdfTypeItem'), historyBtn, document.getElementById('cacheHistoryBtn'), document.getElementById('usageBtn')]) {
      el.classList.toggle('active', el.id === id);
    }
  }

  // ===== 历史翻译 (开关式: 再次点击关闭回上传页, 面板内已无退出按钮) =====
  historyBtn.addEventListener('click', async () => {
    if (historyPanel.style.display === 'block') {
      historyPanel.style.display = 'none';
      uploadBox.style.display = 'block';
      setSidebarActive('pdfTypeItem');
      return;
    }
    uploadBox.style.display = 'none';
    historyPanel.style.display = 'block';
    cachePanel.style.display = 'none';
    usagePanel.style.display = 'none';
    planPanel.style.display = 'none';
    setSidebarActive('historyBtn');
    // 每次打开面板回到本地视图, 避免上次停在云端时标题/按钮与列表错位
    if (historyView === 'cloud') {
      historyView = 'local';
      historyCloudBtn.textContent = '☁ 云端';
    }
    historyTitle.textContent = '本地历史';
    historyPage = 1;
    historySearchInput.value = '';
    historyKeyword = '';
    await renderHistoryList();
  });

  // ===== 云端历史 (登录后可用) =====
  const historyTitle = document.getElementById('historyTitle');
  let historyView = 'local'; // 'local' | 'cloud'
  let historyPage = 1;       // 本地历史当前页
  let cloudPage = 1;         // 云端历史当前页

  historyCloudBtn.addEventListener('click', async () => {
    if (historyView === 'local') {
      const s = await getValidSession().catch(() => null);
      if (!s) {
        alert('云端同步需要登录：请点击浏览器右上角的插件图标 → 底部「账户」卡片登录后重试');
        return;
      }
      historyView = 'cloud';
      cloudPage = 1;
      historyCloudBtn.textContent = '📁 本地';
      historyTitle.textContent = '云端历史（' + (s.email || '已登录') + '）';
      await renderCloudHistoryList();
    } else {
      historyView = 'local';
      historyPage = 1;
      historyCloudBtn.textContent = '☁ 云端';
      historyTitle.textContent = '本地历史';
      await renderHistoryList();
    }
  });

  // ===== 清除全部历史 (由首页迁移至此, 功能内聚) =====
  // 按当前视图单侧清除: 本地视图仅清本地, 云端视图仅清云端 (V1.5.10)
  document.getElementById('historyClearBtn').addEventListener('click', async () => {
    if (historyView === 'cloud') {
      const cl = await cloudListRecords().catch(() => null);
      if (!cl || !cl.ok) { alert('云端记录数获取失败：' + ((cl && cl.error) || '网络异常')); return; }
      if (!cl.list.length) { alert('云端暂无历史记录'); return; }
      if (!confirm(`清除全部云端历史记录（${cl.list.length} 条）？\n不影响本地记录，此操作不可恢复。`)) return;
      const cr = await cloudClearAll();
      if (!cr.ok) { alert('云端清除失败：' + cr.error); return; }
      cloudPage = 1;
      alert('已清除云端 ' + cr.deleted + ' 条历史记录');
      await renderCloudHistoryList();
      return;
    }
    const items = await historyAll().catch(() => null);
    if (!items) { alert('本地记录读取失败'); return; }
    if (!items.length) { alert('本地暂无历史记录'); return; }
    if (!confirm(`清除全部本地历史记录（${items.length} 条）？\n不影响云端记录，此操作不可恢复。`)) return;
    try {
      const n = await historyClear();
      historyPage = 1;
      alert('已清除 ' + n + ' 条本地历史记录');
    } catch (e) {
      alert('清除失败: ' + e.message);
    }
    await renderHistoryList();
  });

  // ===== 历史缓存 (段落级翻译缓存, 与历史翻译并列, V1.5.13) =====
  const cacheHistoryBtn = document.getElementById('cacheHistoryBtn');
  const cacheTitle = document.getElementById('cacheTitle');
  let cacheExpandedKey = null; // 当前展开全文的缓存 key (null = 全部收起)
  let cachePage = 1;           // 历史缓存当前页

  cacheHistoryBtn.addEventListener('click', async () => {
    // 开关式: 面板已打开时再次点击关闭, 回到上传页
    if (cachePanel.style.display === 'block') {
      cachePanel.style.display = 'none';
      uploadBox.style.display = 'block';
      setSidebarActive('pdfTypeItem');
      return;
    }
    uploadBox.style.display = 'none';
    historyPanel.style.display = 'none';
    usagePanel.style.display = 'none';
    planPanel.style.display = 'none';
    cachePanel.style.display = 'block';
    setSidebarActive('cacheHistoryBtn');
    cachePage = 1;
    cacheSearchInput.value = '';
    cacheKeyword = '';
    await renderCacheList();
  });

  document.getElementById('cacheClearBtn').addEventListener('click', async () => {
    const items = await cacheAll().catch(() => null);
    if (!items) { alert('缓存读取失败'); return; }
    if (!items.length) { alert('暂无段落缓存'); return; }
    if (!confirm(`清除全部本地段落缓存（${items.length} 条）？\n不影响云端缓存；再次遇到相同段落将从云端回填或重新翻译。`)) return;
    try {
      const n = await cacheClear();
      cacheExpandedKey = null;
      cachePage = 1;
      alert('已清除 ' + n + ' 条段落缓存');
    } catch (e) {
      alert('清除失败: ' + e.message);
    }
    await renderCacheList();
  });

  async function renderCacheList() {
    cacheList.innerHTML = '<div class="history-empty">加载中...</div>';
    cachePager.innerHTML = '';
    try {
      const all = await cacheAll();
      const kw = cacheKeyword.trim().toLowerCase();
      const items = kw ? all.filter(it => ((it.source || '') + '\n' + (it.translated || '')).toLowerCase().includes(kw)) : all;
      cacheTitle.textContent = '本地历史缓存 ' + (kw ? items.length + '/' + all.length + ' 条' : items.length + ' 条') + '（上限 ' + CACHE_LIMIT + ' 条，超出自动淘汰最旧）';
      if (!items.length) {
        // 用 textContent 而非 innerHTML 拼接: 关键字来自搜索框, 避免被当作 HTML 解析
        const empty = document.createElement('div');
        empty.className = 'history-empty';
        empty.textContent = kw ? `未找到匹配「${cacheKeyword.trim()}」的缓存` : '暂无段落缓存——翻译过的段落自动留存，再次遇到零成本秒出';
        cacheList.innerHTML = '';
        cacheList.appendChild(empty);
        return;
      }
      cacheList.innerHTML = '';
      const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
      if (cachePage > totalPages) cachePage = totalPages;
      const backendNames = { proxy: '官方', baidu: '百度', volcengine: '火山', tencent: '腾讯', custom: '自定义', local: '本地v2' };
      // custom 缓存键引擎段含端点+模型 (V1.5.50), 显示为 "自定义·模型名"
      const cacheBackendLabel = b => (b && b.startsWith('custom:')) ? '自定义·' + (b.split('|').pop() || '?') : (backendNames[b] || b || '?');
      const langNames = { 'en': '英语', 'zh-CN': '中文', 'auto': '自动检测', 'zh': '中文' };
      for (const it of items.slice((cachePage - 1) * PAGE_SIZE, cachePage * PAGE_SIZE)) {
        const row = document.createElement('div');
        row.className = 'history-item';

        const info = document.createElement('div');
        info.className = 'h-info';
        const name = document.createElement('div');
        name.className = 'h-name';
        name.textContent = (it.source || '').replace(/\s+/g, ' ').trim().slice(0, 80) || '(空段落)';
        name.title = it.source || '';
        const meta = document.createElement('div');
        meta.className = 'h-meta';
        meta.textContent = `${cacheBackendLabel(it.backend)} · ${langNames[it.from] || it.from} → ${langNames[it.to] || it.to} · ${new Date(it.time).toLocaleString()} · 原文 ${(it.source || '').length} 字 / 译文 ${(it.translated || '').length} 字`;
        info.appendChild(name);
        info.appendChild(meta);

        const del = document.createElement('button');
        del.className = 'history-del';
        del.textContent = '删除';
        del.addEventListener('click', async e => {
          e.stopPropagation();
          if (!confirm('删除该条本地段落缓存？\n不影响云端缓存；再次遇到该段落将从云端回填或重新翻译。')) return;
          await cacheDelete(it.key).catch(() => {});
          if (cacheExpandedKey === it.key) cacheExpandedKey = null;
          await renderCacheList();
        });

        // 点击行: 展开/收起原文与译文全文
        row.addEventListener('click', () => {
          cacheExpandedKey = cacheExpandedKey === it.key ? null : it.key;
          renderCacheList();
        });

        row.appendChild(info);
        row.appendChild(del);

        if (cacheExpandedKey === it.key) {
          const detail = document.createElement('div');
          detail.className = 'h-detail';
          const src = document.createElement('div');
          src.className = 'h-src';
          src.textContent = it.source || '';
          const dst = document.createElement('div');
          dst.className = 'h-dst';
          dst.textContent = it.translated || '';
          detail.appendChild(src);
          detail.appendChild(dst);
          row.appendChild(detail);
        }

        cacheList.appendChild(row);
      }
      buildPager(cachePager, items.length, cachePage, p => { cachePage = p; renderCacheList(); });
    } catch (e) {
      console.error('[DocTranslate] 历史缓存加载失败:', e);
      cacheList.innerHTML = '<div class="history-empty">历史缓存加载失败</div>';
    }
  }

  async function renderCloudHistoryList() {
    historyList.innerHTML = '<div class="history-empty">正在从云端加载...</div>';
    historyPager.innerHTML = '';
    renderHistoryStats([]); // 先隐藏, 加载成功后按云端记录重新聚合
    const r = await cloudListRecords();
    if (!r.ok) {
      // 错误文案走 textContent: 经 innerHTML 拼接存在被服务端返回内容注入标记的风险 (V1.5.55)
      historyList.innerHTML = '';
      const errDiv = document.createElement('div');
      errDiv.className = 'history-empty';
      errDiv.textContent = r.error || '云端加载失败';
      historyList.appendChild(errDiv);
      return;
    }
    renderHistoryStats(r.list, '全部云端记录'); // 云端列表项经 data->stats 带出统计 (V1.5.44)
    // 配额用量: 标题栏显示, 上限按账户套餐 (免费 30 条/50MB, Pro 300 条/200MB, 阶段1)
    let usedBytes = 0;
    for (const it of r.list) usedBytes += it.totalBytes || 0;
    const mb = n => (n / 1048576).toFixed(1);
    const ent = await getEntitlement();
    historyTitle.textContent = '云端历史 ' + r.list.length + '/' + ent.maxRecords + ' 条 · ' + mb(usedBytes) + '/' + Math.round(ent.maxBytes / 1048576) + ' MB';
    historyList.innerHTML = '';
    // 同步工具条: 一键上传全部本地记录
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;margin-bottom:10px;';
    const pushBtn = document.createElement('button');
    pushBtn.className = 'btn btn-outline';
    pushBtn.style.fontSize = '12px';
    pushBtn.textContent = '⇧ 上传全部本地记录';
    pushBtn.addEventListener('click', async () => {
      pushBtn.disabled = true;
      pushBtn.textContent = '上传中...';
      const pr = await cloudPushAll();
      pushBtn.disabled = false;
      pushBtn.textContent = '⇧ 上传全部本地记录';
      if (!pr.ok) { alert(pr.error || '上传失败'); return; }
      const msg = '上传完成：新上传 ' + pr.uploaded + ' 条' + (pr.errors.length ? '\n失败：\n' + pr.errors.join('\n') : '');
      alert(msg);
      await renderCloudHistoryList();
    });
    bar.appendChild(pushBtn);
    historyList.appendChild(bar);

    // 关键字过滤 (按文件名, 与本地历史共用一个搜索框)
    const kw = historyKeyword.trim().toLowerCase();
    const list = kw ? r.list.filter(it => (it.fileName || '').toLowerCase().includes(kw)) : r.list;
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = kw ? `未找到匹配「${historyKeyword.trim()}」的云端记录` : '云端暂无记录——翻译完成后自动上传，或点上方按钮上传本地记录';
      historyList.appendChild(empty);
      return;
    }
    const backendNames = { proxy: '官方', baidu: '百度', volcengine: '火山', tencent: '腾讯', custom: '自定义', local: '本地v2' };
    const localIds = new Set((await historyAll()).map(x => x.id));
    const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (cloudPage > totalPages) cloudPage = totalPages;
    for (const it of list.slice((cloudPage - 1) * PAGE_SIZE, cloudPage * PAGE_SIZE)) {
      const row = document.createElement('div');
      row.className = 'history-item';

      const info = document.createElement('div');
      info.className = 'h-info';
      const name = document.createElement('div');
      name.className = 'h-name';
      name.textContent = it.fileName || '未命名文档';
      name.title = name.textContent;
      const meta = document.createElement('div');
      meta.className = 'h-meta';
      meta.textContent = `${new Date(it.time).toLocaleString()} · ${it.srcLabel || ''} → ${it.tgtLabel || ''} · ${it.pageCount || '?'} 页 · ${( (it.totalBytes || 0) / 1048576).toFixed(1)}MB · ${backendNames[it.backend] || it.backend || ''}${localIds.has(it.id) ? ' · 已在本地' : ''}`;
      info.appendChild(name);
      info.appendChild(meta);

      const del = document.createElement('button');
      del.className = 'history-del';
      del.textContent = '删除';
      del.addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm(`删除云端记录「${it.fileName}」？（不影响本地）`)) return;
        del.disabled = true;
        const dr = await cloudDeleteRecord(it.id);
        if (!dr.ok) { alert(dr.error || '删除失败'); del.disabled = false; return; }
        await renderCloudHistoryList();
      });

      row.addEventListener('click', async () => {
        if (!localIds.has(it.id)) {
          row.style.opacity = '.5';
          const pr = await cloudDownloadRecord(it.id);
          if (!pr.ok) { row.style.opacity = ''; alert('拉取失败：' + pr.error); return; }
        }
        openHistory(it.id);
      });
      row.appendChild(info);
      row.appendChild(del);
      historyList.appendChild(row);
    }
    buildPager(historyPager, list.length, cloudPage, p => { cloudPage = p; renderCloudHistoryList(); });
  }

  // ===== 历史用量 (V1.7.6 / V1.7.14): 翻译引擎 + AI 分析, 范围 今天/昨天/本周/本月 =====
  // 翻译数据源 = 本地历史记录 (文档翻译, 含缓存命中, V1.7.6 口径) + BYOK 划词按天本地记录
  // (background 记 vtLocalUsage; proxy 划词以服务端 translate_usage 为准不计本地, 防双计)。
  // AI 分析: 云端 DeepSeek = 服务端 ai_usage (chars/out_chars, PostgREST RLS own-select 按天查);
  // 本地模型 (自定义引擎) = vtLocalUsage 按天 { aiIn, aiOut }。
  const USAGE_ENGINES = [
    { key: 'proxy', name: '官方引擎', color: '#07c160' },
    { key: 'baidu', name: '百度', color: '#2932e1' },
    { key: 'volcengine', name: '火山', color: '#fa541c' },
    { key: 'tencent', name: '腾讯', color: '#13c2c2' },
    { key: 'custom', name: '自定义模型', color: '#9254de' }
  ];
  const USAGE_RANGE_LABELS = { today: '今天', yesterday: '昨天', week: '本周', month: '本月' };
  let usageRange = 'today'; // 默认今天 (V1.7.27 由本月改为今天); 本周 = 周一起 (中国习惯)

  function usageRecordChars(rec) {
    const st = rec && rec.stats;
    if (!st) return 0;
    const v = (st.localChars || 0) + (st.cloudChars || 0) + (st.freshChars || 0);
    return v || ((st.cachedChars || 0) + (st.freshChars || 0));
  }

  function fmtUsageChars(n) {
    return n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n);
  }

  // 直方图渲染 (V1.7.15, 纯 CSS 零依赖): x=日期 y=用量, 柱内堆叠 series 配色段;
  // dayKeys 按天取值 getValue(dayKey) → { [seriesKey]: n } (null/空 = 无用量);
  // 柱高按范围内峰值等比缩放, x 轴标签 ≤7 天显示 MM/DD、更多显示日号; title 原生悬停提示
  function buildUsageChart(dayKeys, series, getValue, fmtTip) {
    const vals = dayKeys.map(dk => getValue(dk) || {});
    const totals = vals.map(v => {
      let t = 0;
      for (const s of series) t += Number(v[s.key]) || 0;
      return t;
    });
    const peak = Math.max.apply(null, totals.concat([0]));
    const label = dk => dayKeys.length > 7 ? String(Number(dk.slice(8))) : dk.slice(5).replace('-', '/');
    const bars = [];
    const xlabels = [];
    for (let i = 0; i < dayKeys.length; i++) {
      const dk = dayKeys[i];
      const v = vals[i];
      const t = totals[i];
      xlabels.push(`<span>${label(dk)}</span>`);
      if (!t) {
        bars.push(`<div class="usage-bar-col"><div class="usage-bar empty" title="${dk}：0"></div></div>`);
        continue;
      }
      let segs = '';
      for (const s of series) {
        const n = Number(v[s.key]) || 0;
        if (n > 0) segs += `<i style="height:${(n / t * 100).toFixed(2)}%;background:${s.color}"></i>`;
      }
      bars.push(`<div class="usage-bar-col"><div class="usage-bar" style="height:${(t / peak * 100).toFixed(2)}%" title="${fmtTip(dk, v, t)}">${segs}</div></div>`);
    }
    return `<div class="usage-chart-head">峰值 ${fmtUsageChars(peak)} 字</div>` +
      `<div class="usage-chart">${bars.join('')}</div>` +
      `<div class="usage-chart-x">${xlabels.join('')}</div>`;
  }

  async function renderUsage() {
    const ri = rangeInfo(usageRange, Date.now());
    const label = USAGE_RANGE_LABELS[usageRange] || usageRange;
    usageTitle.textContent = '用量信息 · ' + label;
    for (const b of usagePanel.querySelectorAll('.usage-range-btn')) {
      b.classList.toggle('active', b.dataset.range === usageRange);
    }
    // ① 翻译引擎: 按天直方图 (堆叠引擎配色段) — 历史记录 (文档翻译) + BYOK 划词 (本地按天) 并入
    let records = [];
    try { records = await historyAll(); } catch (e) { records = []; }
    const rangeRecs = records.filter(r => r && r.time >= ri.from && r.time <= ri.to);
    const localData = await readLocalUsage();
    const knownEngines = new Set(USAGE_ENGINES.map(e => e.key));
    const byKey = {};   // 范围合计 (图例)
    const byDay = {};   // 按天: { [dayKey]: { [engineKey|'_other']: n } }
    let total = 0;
    for (const r of rangeRecs) {
      const n = usageRecordChars(r);
      if (!n) continue;
      const ek = knownEngines.has(r.backend) ? r.backend : '_other';
      const dk = dayKeyLocal(r.time);
      (byDay[dk] = byDay[dk] || {})[ek] = (byDay[dk][ek] || 0) + n;
      byKey[ek] = (byKey[ek] || 0) + n;
      total += n;
    }
    for (const dk of ri.days) {
      const day = localData.days[dk];
      if (!day || !day.byok) continue;
      for (const bk of Object.keys(day.byok)) {
        const ek = knownEngines.has(bk) ? bk : '_other';
        const n = day.byok[bk];
        (byDay[dk] = byDay[dk] || {})[ek] = (byDay[dk][ek] || 0) + n;
        byKey[ek] = (byKey[ek] || 0) + n;
        total += n;
      }
    }
    let transHtml;
    if (!total) {
      // 引导文案仅"今天"适用 (现在去翻译即可看到); 昨天/本周/本月为历史区间, 只陈述无用量
      const hint = usageRange === 'today' ? '——完成一次文档翻译或划词翻译后即可看到用量' : '';
      transHtml = `<div class="history-empty">${label}暂无翻译用量${hint}</div>`;
    } else {
      // 柱状段配色 = 五引擎 + "其他"兜底 (未知/旧版 backend)
      const series = USAGE_ENGINES.map(e => ({ key: e.key, name: e.name, color: e.color }));
      if (byKey._other) series.push({ key: '_other', name: '其他', color: '#8c8c8c' });
      const chart = buildUsageChart(ri.days, series, dk => byDay[dk] || null, (dk, v, t) => {
        const parts = series.filter(s => (v[s.key] || 0) > 0).map(s => `${s.name} ${fmtUsageChars(v[s.key])}`);
        return `${dk}：共 ${fmtUsageChars(t)} 字` + (parts.length ? `（${parts.join(' · ')}）` : '');
      });
      const legend = series.filter(s => (byKey[s.key] || 0) > 0).map(s =>
        `<div class="hs-row"><i style="background:${s.color}"></i>${s.name}<b>${(byKey[s.key] * 100 / total).toFixed(1)}% · ${fmtUsageChars(byKey[s.key])}字</b></div>`
      ).join('');
      transHtml = chart + `<div class="hs-legend">${legend}</div>`;
    }
    // ② AI 分析: 按天直方图 (云端模型 + 本地模型两段) + 输入/输出明细行
    // 云端按天明细: 服务端 day 为北京日期 (V1.7.19 统一), 与本地日键同串对齐零偏差
    const cloud = await fetchCloudAiUsage(ri.days[0], ri.days[ri.days.length - 1]);
    const cloudByDay = {};
    for (const row of (cloud.rows || [])) {
      if (row.day) cloudByDay[row.day] = (cloudByDay[row.day] || 0) + row.inChars + row.outChars;
    }
    let aiLocalIn = 0;
    let aiLocalOut = 0;
    for (const dk of ri.days) {
      const day = localData.days[dk];
      if (day) { aiLocalIn += day.aiIn; aiLocalOut += day.aiOut; }
    }
    const aiSeries = [
      { key: 'cloud', name: '云端模型', color: '#4d6bfe' },
      { key: 'local', name: '本地模型', color: '#9254de' }
    ];
    const aiGetValue = dk => {
      const c = cloudByDay[dk] || 0;
      const day = localData.days[dk];
      const l = day ? (day.aiIn + day.aiOut) : 0;
      return (c || l) ? { cloud: c, local: l } : null;
    };
    const aiTotalAll = (cloud.ok ? cloud.inChars + cloud.outChars : 0) + aiLocalIn + aiLocalOut;
    const cloudText = cloud.needLogin
      ? '登录后可查'
      : (cloud.ok ? `输入 ${fmtUsageChars(cloud.inChars)} · 输出 ${fmtUsageChars(cloud.outChars)} 字` : '查询失败，稍后重试');
    const localText = `输入 ${fmtUsageChars(aiLocalIn)} · 输出 ${fmtUsageChars(aiLocalOut)} 字`;
    let aiHtml;
    if (!aiTotalAll) {
      aiHtml = `<div class="history-empty">${label}暂无 AI 分析用量${cloud.needLogin ? '（云端用量登录后可查）' : ''}</div>`;
    } else {
      aiHtml = buildUsageChart(ri.days, aiSeries, aiGetValue, (dk, v, t) =>
        `${dk}：共 ${fmtUsageChars(t)} 字（云端 ${fmtUsageChars(v.cloud || 0)} · 本地 ${fmtUsageChars(v.local || 0)}）`);
    }
    const docCount = rangeRecs.length ? `文档 ${rangeRecs.length} 篇 · ` : '';
    usageStatsBox.innerHTML =
      `<div class="hs-title">翻译引擎字符用量（${docCount}含划词与缓存命中）</div>` + transHtml +
      `<div class="hs-title" style="margin-top:16px">AI 分析字符用量</div>` + aiHtml +
      `<div class="hs-row"><i style="background:#4d6bfe"></i>云端模型<b>${cloudText}</b></div>` +
      `<div class="hs-row"><i style="background:#9254de"></i>本地模型<b>${localText}</b></div>`;
  }

  document.getElementById('usageBtn').addEventListener('click', async () => {
    if (usagePanel.style.display === 'block') {
  usagePanel.style.display = 'none';
  planPanel.style.display = 'none';
  uploadBox.style.display = 'block';
      setSidebarActive('pdfTypeItem');
      return;
    }
    uploadBox.style.display = 'none';
    historyPanel.style.display = 'none';
    cachePanel.style.display = 'none';
    planPanel.style.display = 'none';
    usagePanel.style.display = 'block';
    setSidebarActive('usageBtn');
    usageRange = 'today'; // 每次打开回到今天 (V1.7.27)
    await renderUsage();
  });

  // ===== 权益对比 (V1.7.28): 免费 / Pro 功能一览, 打开时标注当前套餐 =====
  async function renderPlanCurrent() {
    try {
      const ent = await getEntitlement();
      if (ent && ent.plan === 'pro') {
        const exp = ent.expiresAt ? String(ent.expiresAt).slice(0, 10) : '';
        planCurrent.textContent = exp ? `当前：Pro（${exp} 到期）` : '当前：Pro';
      } else {
        planCurrent.textContent = '当前：免费版';
      }
    } catch (e) {
      planCurrent.textContent = '';
    }
  }

  // V1.7.39: 统一设置入口 (options.html 只读总览; 新标签页打开)
  document.getElementById('openSettingsBtn').addEventListener('click', () => {
    try {
      chrome.runtime.openOptionsPage();
    } catch (e) {
      window.open(chrome.runtime.getURL('options.html'), '_blank');
    }
  });

  // 升级 Pro (V1.7.79): 购买入口未开放时只提示; 开放后打开扩展内支付页
  // (扫码 → 回调发权益 → 轮询开通)
  const planBuyBtn = document.getElementById('planBuyBtn');
  if (planBuyBtn) {
    if (!PRO_PURCHASE_ENABLED) planBuyBtn.textContent = '升级 Pro（即将开放）';
    planBuyBtn.addEventListener('click', () => {
      if (!PRO_PURCHASE_ENABLED) {
        alert(PRO_PURCHASE_COMING_SOON_TIP);
        return;
      }
      try {
        window.open(chrome.runtime.getURL('pay.html'), '_blank', 'noopener');
      } catch (e) {
        window.location.href = 'pay.html';
      }
    });
  }

  document.getElementById('planBtn').addEventListener('click', async () => {
    if (planPanel.style.display === 'block') {
      planPanel.style.display = 'none';
      uploadBox.style.display = 'block';
      setSidebarActive('pdfTypeItem');
      return;
    }
    uploadBox.style.display = 'none';
    historyPanel.style.display = 'none';
    cachePanel.style.display = 'none';
    usagePanel.style.display = 'none';
    planPanel.style.display = 'block';
    setSidebarActive('planBtn');
    await renderPlanCurrent();
  });

  // 范围切换 (V1.7.14): 今天/昨天/本周/本月
  for (const b of usagePanel.querySelectorAll('.usage-range-btn')) {
    b.addEventListener('click', async () => {
      if (usageRange === b.dataset.range) return;
      usageRange = b.dataset.range;
      await renderUsage();
    });
  }

  document.getElementById('pdfTypeItem').addEventListener('click', () => {
    historyPanel.style.display = 'none';
    cachePanel.style.display = 'none';
    usagePanel.style.display = 'none';
    uploadBox.style.display = 'block';
    setSidebarActive('pdfTypeItem');
  });

  // ===== 命中来源统计图: 本地缓存/云端缓存/引擎直译 字数占比环形饼图 (V1.5.43) =====
  // 聚合范围 = 全部本地记录 (不受搜索过滤影响, 展示"总比例"); 记录清空后 total=0 自动隐藏
  const historyStatsBox = document.getElementById('historyStats');
  function renderHistoryStats(records, scopeLabel) {
    // scopeLabel: 本地/云端视图各聚合各自一侧的全部记录 (V1.5.44)
    let local = 0, cloud = 0, fresh = 0;
    for (const r of records) {
      const st = r && r.stats;
      if (!st) continue;
      local += st.localChars || 0;
      cloud += st.cloudChars || 0;
      fresh += st.freshChars || 0;
      // 旧版记录 stats 为 {cachedChars, freshChars} 不区分来源, 计入本地命中
      if (!st.localChars && !st.cloudChars && st.cachedChars) local += st.cachedChars;
    }
    const total = local + cloud + fresh;
    if (!total) {
      historyStatsBox.style.display = 'none';
      historyStatsBox.innerHTML = '';
      return;
    }
    const segs = [
      { name: '本地缓存', n: local, color: '#52c41a' },
      { name: '云端缓存', n: cloud, color: '#1677ff' },
      { name: '引擎直译', n: fresh, color: '#faad14' }
    ];
    // conic-gradient 按字数占比切环: 累计角度逐段衔接, 0 值段跳过
    const stops = [];
    let acc = 0;
    for (const s of segs) {
      if (!s.n) continue;
      const from = acc / total * 360;
      acc += s.n;
      stops.push(`${s.color} ${from.toFixed(2)}deg ${(acc / total * 360).toFixed(2)}deg`);
    }
    const fmt = n => n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n);
    const legend = segs.filter(s => s.n).map(s =>
      `<div class="hs-row"><i style="background:${s.color}"></i>${s.name}<b>${(s.n * 100 / total).toFixed(1)}% · ${fmt(s.n)}字</b></div>`
    ).join('');
    historyStatsBox.innerHTML =
      `<div class="hs-title">命中来源总览（${scopeLabel || '全部本地记录'}）</div>` +
      `<div class="hs-body"><div class="hs-donut" style="background:conic-gradient(${stops.join(',')})">` +
      `<div class="hs-hole"><b>${fmt(total)}</b><span>字</span></div></div>` +
      `<div class="hs-legend">${legend}</div></div>`;
    historyStatsBox.style.display = 'block';
  }

  async function renderHistoryList() {
    historyList.innerHTML = '<div class="history-empty">加载中...</div>';
    historyPager.innerHTML = '';
    try {
      const all = await historyAll();
      renderHistoryStats(all);
      // 标题与云端历史同格式: 条数/上限 · 体积 (V1.5.46); 体积口径与云端一致只计 PDF, 本地无字节配额故不带 /50
      let localBytes = 0;
      for (const it of all) localBytes += (it.pdfBlob && it.pdfBlob.size) || 0;
      historyTitle.textContent = '本地历史 ' + all.length + '/' + HISTORY_LIMIT + ' 条 · ' + (localBytes / 1048576).toFixed(1) + ' MB';
      historyList.innerHTML = '';
      // 同步工具条: 一键下载云端缺失记录 (V1.5.45, 与云端视图"上传全部本地记录"镜像; 空列表也显示, 支撑换设备全量恢复)
      const bar = document.createElement('div');
      bar.style.cssText = 'display:flex;gap:8px;margin-bottom:10px;';
      const pullBtn = document.createElement('button');
      pullBtn.className = 'btn btn-outline';
      pullBtn.style.fontSize = '12px';
      pullBtn.textContent = '⇩ 下载全部云端记录';
      pullBtn.addEventListener('click', async () => {
        const s = await getValidSession().catch(() => null);
        if (!s) { alert('下载云端记录需要登录：请点击浏览器右上角的插件图标 → 底部「账户」卡片登录后重试'); return; }
        pullBtn.disabled = true;
        pullBtn.textContent = '下载中...';
        const pr = await cloudPullMissing();
        pullBtn.disabled = false;
        pullBtn.textContent = '⇩ 下载全部云端记录';
        if (!pr.ok) { alert(pr.error || '下载失败'); return; }
        const msg = '下载完成：新下载 ' + pr.downloaded + ' 条（本地已有自动跳过）' + (pr.errors.length ? '\n失败：\n' + pr.errors.join('\n') : '');
        alert(msg);
        await renderHistoryList();
      });
      bar.appendChild(pullBtn);
      historyList.appendChild(bar);
      const kw = historyKeyword.trim().toLowerCase();
      const items = kw ? all.filter(it => (it.fileName || '').toLowerCase().includes(kw)) : all;
      if (!items.length) {
        // 用 textContent 而非 innerHTML 拼接: 关键字来自搜索框, 避免被当作 HTML 解析
        const empty = document.createElement('div');
        empty.className = 'history-empty';
        empty.textContent = kw ? `未找到匹配「${historyKeyword.trim()}」的历史记录` : '暂无历史翻译记录';
        historyList.appendChild(empty);
        return;
      }
      const backendNames = { proxy: '官方', baidu: '百度', volcengine: '火山', tencent: '腾讯', custom: '自定义', local: '本地v2' };
      const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
      if (historyPage > totalPages) historyPage = totalPages;
      for (const it of items.slice((historyPage - 1) * PAGE_SIZE, historyPage * PAGE_SIZE)) {
        const row = document.createElement('div');
        row.className = 'history-item';

        const info = document.createElement('div');
        info.className = 'h-info';
        const name = document.createElement('div');
        name.className = 'h-name';
        name.textContent = it.fileName || '未命名文档';
        name.title = name.textContent;
        const meta = document.createElement('div');
        meta.className = 'h-meta';
        meta.textContent = `${new Date(it.time).toLocaleString()} · ${it.srcLabel || ''} → ${it.tgtLabel || ''} · ${it.pageCount} 页 · ${backendNames[it.backend] || it.backend || ''}`;
        info.appendChild(name);
        info.appendChild(meta);

        const del = document.createElement('button');
        del.className = 'history-del';
        del.textContent = '删除';
        del.addEventListener('click', async e => {
          e.stopPropagation();
          // 已登录: 本地删除联动删云端
          const s = await getValidSession().catch(() => null);
          const msg = s ? `删除「${it.fileName}」的翻译记录？\n\n已登录，云端副本将一并删除` : `删除「${it.fileName}」的翻译记录？`;
          if (!confirm(msg)) return;
          await historyDelete(it.id);
          if (s) {
            del.disabled = true;
            const cr = await cloudDeleteRecord(it.id);
            if (!cr.ok) console.warn('[DocTranslate] 云端副本删除失败:', it.fileName, cr.error);
          }
          await renderHistoryList();
        });

        row.addEventListener('click', () => openHistory(it.id));
        row.appendChild(info);
        row.appendChild(del);
        historyList.appendChild(row);
      }
      buildPager(historyPager, items.length, historyPage, p => { historyPage = p; renderHistoryList(); });
    } catch (e) {
      console.error('[DocTranslate] 历史记录加载失败:', e);
      historyList.innerHTML = '<div class="history-empty">历史记录加载失败</div>';
    }
  }

  async function openHistory(id) {
    // 翻译进行中禁止切换历史: 同 loadPdfBuffer, 防并发改写状态 (V1.5.55)
    if (isTranslating) {
      alert('正在翻译中，请点击「取消翻译」停止后再打开历史记录');
      return;
    }
    const rec = await historyGet(id);
    if (!rec) {
      alert('记录不存在，可能已被删除');
      await renderHistoryList();
      return;
    }
    showProgress();
    updateProgress(10, '正在打开历史翻译...');
    try {
      if (!rec.pdfBlob) throw new Error('记录缺少 PDF 原文件');
      // 解析成功后才提交共享状态 (V1.5.55): 此前 pdfArrayBuffer 先行覆写, 解析失败时
      // 旧文档随后的 saveHistoryRecord() 会拿新记录的字节覆写旧记录的 PDF, 历史永久损坏
      const buf = await rec.pdfBlob.arrayBuffer();
      updateProgress(40, '正在解析 PDF...');
      pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');
      const doc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
      if (pdfDoc) {
        try { const d = pdfDoc; d.destroy().catch(() => {}); } catch (e) {}
      }
      pdfDoc = doc;
      pdfArrayBuffer = buf;
      pages = rec.pages || [];
      translatedPages = rec.translatedPages || [];
      // 旧历史记录无图形区域数据: 重新检测补齐 (新记录已随 pages 保存)
      for (const p of pages) {
        if (p && (!p.graphicRegions || !p.pageHeight || !p.pageTransform)) {
          try {
            const pg = await pdfDoc.getPage(p.pageNum);
            const vp = pg.getViewport({ scale: 1 });
            p.graphicRegions = p.graphicRegions || await detectGraphicRegions(pg, vp);
            p.pageHeight = vp.height;
            p.pageWidth = vp.width;
            p.pageTransform = vp.transform; // V1.7.67: 表格识别需要页面变换 (旧记录补)
          } catch (e) {
            console.warn('[DocTranslate] 历史记录图形区域补检失败:', e);
            p.graphicRegions = p.graphicRegions || [];
          }
        }
      }
      fileName = rec.fileName || '';
      currentHistoryId = rec.id;
      translateStats = rec.stats || null;
      // 旧历史记录无批注数据, 空数组兜底
      annotations = rec.annotations || [];
      // 旧历史记录无 AI 对话数据, null 兜底 (V1.7.12); V1.7.9~7.11 的一次性总结迁移为首条机器人消息
      aiChat = normalizeAiChat(rec.aiChat, rec.aiSummary);
      updateProgress(100, '打开成功');
      await showDocView(true);
    } catch (e) {
      console.error('[DocTranslate] 打开历史记录失败:', e);
      alert('打开历史记录失败: ' + e.message);
      hideProgress();
    }
  }

  async function saveHistoryRecord() {
    if (!pages.length || !translatedPages.length || !pdfArrayBuffer) return;
    try {
      // 已有记录沿用原翻译时间: 批注增删/失效剔除不该改写"翻译时间", 否则历史列表
      // 与云端 rec_time 会被刷新导致旧记录跳到最前 (V1.5.28 修复)
      const now = Date.now();
      let recTime = now;
      if (currentHistoryId) {
        const prev = await historyGet(currentHistoryId).catch(() => null);
        if (prev && prev.time) recTime = prev.time;
      }
      const rec = {
        id: currentHistoryId || String(now),
        fileName: fileName || '未命名.pdf',
        time: recTime,
        backend: config.backend || 'baidu',
        srcLabel: (srcLang.options[srcLang.selectedIndex] || {}).text || srcLang.value,
        tgtLabel: (tgtLang.options[tgtLang.selectedIndex] || {}).text || tgtLang.value,
        pageCount: pages.length,
        pdfBlob: new Blob([pdfArrayBuffer], { type: 'application/pdf' }),
        pages: pages,
        translatedPages: translatedPages,
        stats: translateStats,
        annotations: annotations,
        aiChat: aiChat
      };
      await historyPut(rec);
      currentHistoryId = rec.id;
      // 只保留最近 HISTORY_LIMIT 条 (与云端配额对齐), 淘汰的记录云端一并删除 (两边保持一致)
      const all = await historyAll();
      if (all.length > HISTORY_LIMIT) {
        for (const old of all.slice(HISTORY_LIMIT)) {
          await historyDelete(old.id);
          cloudDeleteRecord(old.id).then(cr => {
            if (!cr.ok && cr.error !== '未登录') console.warn('[DocTranslate] 淘汰记录的云端副本删除失败:', old.fileName, cr.error);
          });
        }
      }
      console.log('[DocTranslate] 已保存历史记录:', rec.fileName);
      // 已登录则静默上传云端: 防抖 3 秒 (批注连续编辑/删除时合并为一次上传, 避免整份 PDF 反复重传)
      scheduleCloudSync(rec);
    } catch (e) {
      console.warn('[DocTranslate] 保存历史记录失败:', e);
    }
  }

  // 云端同步防抖: 持有最新记录, 3 秒内无新变更才真正上传 (失败只记日志)
  let cloudSyncTimer = null;
  let cloudSyncPendingRec = null;
  function scheduleCloudSync(rec) {
    cloudSyncPendingRec = rec;
    if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(async () => {
      cloudSyncTimer = null;
      const pendingRec = cloudSyncPendingRec;
      cloudSyncPendingRec = null;
      if (!pendingRec) return;
      const r = await cloudUploadRecord(pendingRec);
      if (r.ok) console.log('[DocTranslate] 历史记录已同步到云端:', pendingRec.fileName);
      else console.warn('[DocTranslate] 云端同步跳过/失败:', pendingRec.fileName, r.error);
    }, 3000);
  }

  // 页面关闭时尽力把待同步的记录立即冲掉 (兜底, 3 秒窗口内关页的场景)
  window.addEventListener('pagehide', () => {
    if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
    if (cloudSyncPendingRec) {
      const rec = cloudSyncPendingRec;
      cloudSyncPendingRec = null;
      cloudUploadRecord(rec);
    }
  });

  async function renderPageCanvas(page, renderViewport, cssViewport, container) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page-container';
    wrapper.style.width = cssViewport.width + 'px';
    wrapper.style.height = cssViewport.height + 'px';

    const canvas = document.createElement('canvas');
    // 位图分辨率 = 设备像素比, 显示尺寸 = 1 倍 PDF 点: 物理像素 1:1, 与原生查看器同等清晰
    canvas.width = renderViewport.width;
    canvas.height = renderViewport.height;
    canvas.className = 'pdf-canvas';
    canvas.style.width = cssViewport.width + 'px';
    canvas.style.height = cssViewport.height + 'px';

    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
    wrapper.appendChild(canvas);
    container.appendChild(wrapper);
    return wrapper;
  }

  function renderBlankPage(cssViewport, container) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page-container';
    wrapper.style.width = cssViewport.width + 'px';
    wrapper.style.height = cssViewport.height + 'px';
    container.appendChild(wrapper);
    return wrapper;
  }

  // 右栏带图页面: 复制左栏 canvas 位图 (图片/图表/公式等非文本元素透出), 文本区域由译文层盖白遮盖
  function renderImagePage(cssViewport, renderViewport, container, srcCanvas) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page-container';
    wrapper.style.width = cssViewport.width + 'px';
    wrapper.style.height = cssViewport.height + 'px';
    const canvas = document.createElement('canvas');
    canvas.width = renderViewport.width;
    canvas.height = renderViewport.height;
    canvas.className = 'pdf-canvas';
    canvas.style.width = cssViewport.width + 'px';
    canvas.style.height = cssViewport.height + 'px';
    canvas.getContext('2d').drawImage(srcCanvas, 0, 0);
    wrapper.appendChild(canvas);
    container.appendChild(wrapper);
    return wrapper;
  }

  async function renderLeftTextLayer(page, cssViewport, wrapper) {
    const textContent = await page.getTextContent();
    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    // textLayer 与 canvas 显示尺寸同为一个视口缩放: --scale-factor 必须等于 viewport.scale,
    // 否则 pdf.js 会把选区文字按错误倍率缩放, 与画面错位导致鼠标难以选中 (V1.7.50 自适应宽度)
    textLayerDiv.style.width = cssViewport.width + 'px';
    textLayerDiv.style.height = cssViewport.height + 'px';
    textLayerDiv.style.setProperty('--scale-factor', String(cssViewport.scale));

    if (pdfjsLib.renderTextLayer) {
      await pdfjsLib.renderTextLayer({
        textContentSource: textContent,
        container: textLayerDiv,
        viewport: cssViewport,
        textDivs: []
      }).promise;
    } else {
      await renderTextLayerLegacy(textContent, cssViewport, textLayerDiv);
    }

    // 官方 TextLayerBuilder 会在层底追加 endOfContent, 改善空白区域的选择体验
    const eoc = document.createElement('div');
    eoc.className = 'endOfContent';
    textLayerDiv.appendChild(eoc);

    wrapper.appendChild(textLayerDiv);
  }

  async function renderTextLayerLegacy(textContent, viewport, container) {
    const items = textContent.items;
    for (const item of items) {
      if (!item.str || !item.str.trim()) continue;
      // item.transform 经视口 transform 归一为 CSS 像素 (未旋转页与原"用户空间即 CSS 像素"
      // + pageHeight 翻转"等价; /Rotate 旋转页同样正确, V1.5.55)
      const t = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const tx = t[4];
      const ty = t[5];
      const fontSize = Math.abs(t[0]) || 12;
      const span = document.createElement('span');
      span.textContent = item.str;
      span.style.position = 'absolute';
      span.style.left = tx + 'px';
      span.style.top = (ty - fontSize * 0.9) + 'px';
      span.style.fontSize = fontSize + 'px';
      span.style.color = 'transparent';
      span.style.whiteSpace = 'pre';
      container.appendChild(span);
    }
  }

  function getLineBounds(lineItems, m) {
    const tf = it => (m ? pdfjsLib.Util.transform(m, it.transform) : it.transform);
    // item.width 是 PDF 用户空间宽度 (不含视口缩放); 显示视口放大后必须同倍缩放,
    // 否则段落包围盒右边界偏窄, 盖白矩形盖不住行尾原文, 会出现中英混排 (V1.7.51 修复)
    const wScale = m ? (Math.hypot(m[0], m[1]) || 1) : 1;
    const sorted = lineItems.slice().sort((a, b) => tf(a)[4] - tf(b)[4]);
    const firstItem = sorted[0];
    const minX = tf(firstItem)[4];
    const maxX = sorted.reduce((mx, it) => Math.max(mx, tf(it)[4] + (it.width || 0) * wScale), 0);
    const y = tf(firstItem)[5];
    const fontSize = Math.abs(tf(firstItem)[0]) || 12;
    return { minX, maxX, y, fontSize };
  }

  function isCenteredParagraph(lines, lineStart, lineEnd, m) {
    const centers = [];
    const lefts = [];
    const rights = [];
    for (let i = lineStart; i < lineEnd; i++) {
      const line = lines[i];
      if (!line || !line.items || !line.items.length) continue;
      const b = getLineBounds(line.items, m);
      centers.push((b.minX + b.maxX) / 2);
      lefts.push(b.minX);
      rights.push(b.maxX);
    }
    if (centers.length < 2) return false;
    const cSpread = Math.max(...centers) - Math.min(...centers);
    const lSpread = Math.max(...lefts) - Math.min(...lefts);
    const boxWidth = Math.max(...rights) - Math.min(...lefts);
    const tol = Math.max(6, boxWidth * 0.05);
    // 各行中心点对齐且左边缘参差 → 原文为居中排版
    return cSpread < tol && lSpread > tol;
  }

  // 段落包围盒 (CSS 像素, y 向下): item.transform 经 m (视口 transform) 归一,
  // 未旋转页与原"用户空间即 CSS 像素 + pageHeight 翻转"等价, /Rotate 旋转页同样正确 (V1.5.55)
  function getParagraphBox(lines, lineStart, lineEnd, m) {
    let minX = Infinity, maxX = -Infinity, top = Infinity, bottom = -Infinity;
    for (let i = lineStart; i < lineEnd; i++) {
      const line = lines[i];
      if (!line || !line.items || !line.items.length) continue;
      const b = getLineBounds(line.items, m);
      minX = Math.min(minX, b.minX);
      maxX = Math.max(maxX, b.maxX);
      top = Math.min(top, b.y - b.fontSize * 0.9);
      bottom = Math.max(bottom, b.y + b.fontSize * 0.3);
    }
    if (minX === Infinity) return null;
    return { left: minX, right: maxX, top: top, height: bottom - top };
  }

  // ===== 图形区域检测 (区域检测 + 原图保留) =====
  // 扫描 pdf.js OperatorList: 文本绘制指令之外的位图与矢量路径, 其包围盒标记为图形区域;
  // 落在区域内的文字 (图表轴标签/图例/示意图标注) 不送翻译, 渲染时位图原图透出
  async function detectGraphicRegions(page, viewport) {
    const boxes = [];
    try {
      const opList = await page.getOperatorList();
      const OPS = pdfjsLib.OPS;
      const fns = opList.fnArray;
      const argsArr = opList.argsArray;
      let ctm = [1, 0, 0, 1, 0, 0];
      const stack = [];
      let pending = null; // { pts: [x0,y0,...], ctm }: 待绘制的路径点 (用户空间)
      let fillWhite = false;

      const pushUserBox = (x1, y1, x2, y2) => {
        // 用户空间 (y 向上) → CSS 像素 (y 向下), convertToViewportPoint 处理旋转/裁剪偏移
        const p1 = viewport.convertToViewportPoint(x1, y1);
        const p2 = viewport.convertToViewportPoint(x2, y2);
        boxes.push({
          left: Math.min(p1[0], p2[0]),
          right: Math.max(p1[0], p2[0]),
          top: Math.min(p1[1], p2[1]),
          bottom: Math.max(p1[1], p2[1])
        });
      };
      const flushPath = p => {
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (let j = 0; j < p.pts.length; j += 2) {
          const q = pdfjsLib.Util.applyTransform([p.pts[j], p.pts[j + 1]], p.ctm);
          x1 = Math.min(x1, q[0]);
          y1 = Math.min(y1, q[1]);
          x2 = Math.max(x2, q[0]);
          y2 = Math.max(y2, q[1]);
        }
        if (x1 !== Infinity) pushUserBox(x1, y1, x2, y2);
      };

      for (let i = 0; i < fns.length; i++) {
        const fn = fns[i];
        const args = argsArr[i];
        if (fn === OPS.save) {
          stack.push(ctm);
        } else if (fn === OPS.restore) {
          ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
        } else if (fn === OPS.transform) {
          ctm = pdfjsLib.Util.transform(ctm, args);
        } else if (fn === OPS.constructPath) {
          const pathOps = args[0];
          const coords = args[1];
          const pts = [];
          let k = 0;
          for (const op of pathOps) {
            if (op === OPS.moveTo || op === OPS.lineTo) {
              pts.push(coords[k], coords[k + 1]);
              k += 2;
            } else if (op === OPS.curveTo) {
              pts.push(coords[k], coords[k + 1], coords[k + 2], coords[k + 3], coords[k + 4], coords[k + 5]);
              k += 6;
            } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
              pts.push(coords[k], coords[k + 1], coords[k + 2], coords[k + 3]);
              k += 4;
            } else if (op === OPS.rectangle) {
              const x = coords[k], y = coords[k + 1], w = coords[k + 2], h = coords[k + 3];
              pts.push(x, y, x + w, y, x, y + h, x + w, y + h);
              k += 4;
            }
          }
          // PDF 语义: 路径坐标按构造时刻的 CTM 变换
          pending = { pts: pts, ctm: ctm.slice() };
        } else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat ||
          fn === OPS.paintInlineImageXObject || fn === OPS.paintInlineImageXObjectRepeat ||
          fn === OPS.paintImageMaskXObject || fn === OPS.paintImageMaskXObjectGroup ||
          fn === OPS.paintImageMaskXObjectRepeat) {
          // 位图以单位正方形 [0,0]-[1,1] 经当前 CTM 绘制
          let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
          for (const px of [0, 1]) {
            for (const py of [0, 1]) {
              const q = pdfjsLib.Util.applyTransform([px, py], ctm);
              x1 = Math.min(x1, q[0]);
              y1 = Math.min(y1, q[1]);
              x2 = Math.max(x2, q[0]);
              y2 = Math.max(y2, q[1]);
            }
          }
          pushUserBox(x1, y1, x2, y2);
        } else if (fn === OPS.fill || fn === OPS.eoFill) {
          // 白色填充多为背景矩形/高亮底色, 不算图形
          if (pending && !fillWhite) flushPath(pending);
          pending = null;
        } else if (fn === OPS.stroke || fn === OPS.closeStroke || fn === OPS.fillStroke ||
          fn === OPS.eoFillStroke || fn === OPS.closeFillStroke || fn === OPS.closeEOFillStroke) {
          if (pending) flushPath(pending);
          pending = null;
        } else if (fn === OPS.endPath) {
          pending = null;
        } else if (fn === OPS.setFillRGBColor) {
          fillWhite = args[0] >= 246 && args[1] >= 246 && args[2] >= 246;
        } else if (fn === OPS.setFillGray) {
          fillWhite = args[0] >= 0.965;
        } else if (fn === OPS.setFillCMYKColor) {
          fillWhite = args[0] <= 0.04 && args[1] <= 0.04 && args[2] <= 0.04 && args[3] <= 0.04;
        } else if (fn === OPS.setFillColorN) {
          fillWhite = false; // 图案/特殊色彩空间, 视为非白
        }
      }
    } catch (e) {
      console.warn('[DocTranslate] 图形区域检测失败:', e);
      return [];
    }
    // 过滤装饰性细线 (下划线/表格框线): 任一维 < 2pt 的包围盒丢弃
    const thick = boxes.filter(b => (b.right - b.left) >= 2 && (b.bottom - b.top) >= 2);
    // 合并重叠/邻近包围盒为整体图形区域
    const merged = mergeGraphicBoxes(thick, 4);
    // 丢弃杂散小区域 (< 6x6pt) 与整页背景区域 (≥ 70% 页面积)
    const pageArea = viewport.width * viewport.height;
    return merged.filter(b =>
      (b.right - b.left) >= 6 && (b.bottom - b.top) >= 6 &&
      (b.right - b.left) * (b.bottom - b.top) < pageArea * 0.7
    );
  }

  function mergeGraphicBoxes(boxes, gap) {
    const list = boxes.slice();
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < list.length && !merged; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if (a.left - gap <= b.right && b.left - gap <= a.right &&
            a.top - gap <= b.bottom && b.top - gap <= a.bottom) {
            list[i] = {
              left: Math.min(a.left, b.left),
              top: Math.min(a.top, b.top),
              right: Math.max(a.right, b.right),
              bottom: Math.max(a.bottom, b.bottom)
            };
            list.splice(j, 1);
            merged = true;
            break;
          }
        }
      }
    }
    return list;
  }

  // 段落包围盒被图形区域覆盖 ≥ 60% → 视为图内文字 (轴标签/图例/标注)
  function isCoveredByGraphicRegion(regions, box, scale) {
    if (!regions || !regions.length || !box) return false;
    const width = box.right - box.left;
    const area = width * box.height;
    if (width <= 0 || box.height <= 0) return false;
    const boxBottom = box.top + box.height;
    const s = Number(scale) > 0 ? Number(scale) : 1;
    let covered = 0;
    for (const r of regions) {
      const rl = r.left * s;
      const rr = r.right * s;
      const rt = r.top * s;
      const rb = r.bottom * s;
      const ix = Math.max(0, Math.min(box.right, rr) - Math.max(box.left, rl));
      const iy = Math.max(0, Math.min(boxBottom, rb) - Math.max(box.top, rt));
      covered += ix * iy;
    }
    return covered / area >= 0.6;
  }

  // 表格排版识别 (V1.7.67): 按版面几何判断, 不依赖图形区域——
  // 表格边框多为 0.5~1pt 细线, 会在 detectGraphicRegions 的"装饰性细线"过滤里被丢弃,
  // 因此旧方案下大多数表格没被识别, 单元格文字被当正文翻译, 列结构被压乱。
  // 判据见 lib/table-detect.js: 列间隙切单元格 → 连续 ≥3 行 + 列起点跨行对齐 + 单元格文字短。
  // 表格识别结果按 pageInfo 缓存 (WeakMap): 盖白 helper 与译文层循环、缩放重绘都会调用,
  // 重复计算 (逐行 transform + 几何判定) 没有意义; pageInfo 随文档解析重建, 不存在陈旧问题
  const tableIdxCache = new WeakMap();
  function detectTableParagraphIdx(pageInfo) {
    if (!pageInfo) return new Set();
    const hit = tableIdxCache.get(pageInfo);
    if (hit) return hit;
    const out = new Set();
    const lines = (pageInfo && pageInfo.lines) || [];
    const paras = (pageInfo && pageInfo.paragraphs) || [];
    const m = pageInfo && pageInfo.pageTransform;
    if (!m || lines.length < TABLE_MIN_ROWS || !paras.length) {
      tableIdxCache.set(pageInfo, out);
      return out;
    }
    // 坐标归一到 1x 页面空间 (与渲染缩放无关), 供纯函数识别
    const norm = lines.map(ln => ({
      y: ln.y,
      fontSize: ln.fontSize,
      items: (ln.items || []).map(it => {
        const t = pdfjsLib.Util.transform(m, it.transform);
        return { str: it.str, x: t[4], width: it.width || 0 };
      })
    }));
    const rows = buildTableRows(norm, TABLE_CELL_GAP, TABLE_MAX_CELL_CHARS);
    const result = detectTableParagraphs(norm, rows, paras, TABLE_MIN_ROWS);
    tableIdxCache.set(pageInfo, result);
    return result;
  }

  // 右栏位图盖白 (V1.7.83 抽出): 逐段把原文文本区域涂白 (露出图片/图表/公式),
  // 位图坐标 = CSS 坐标 × pixelRatio。初始渲染与缩放重渲染共用同一套判定, 重绘后不会漏盖/错位。
  function paintTranslatedCoverRects(pageInfo, translatedPage, ctx, cssViewport, pixelRatio) {
    if (!pageInfo || !translatedPage || !ctx) return;
    const pr = pixelRatio > 0 ? pixelRatio : deviceDpr();
    const pageScale = cssViewport.scale || 1;
    const tableSet = detectTableParagraphIdx(pageInfo);
    for (let pIdx = 0; pIdx < translatedPage.paragraphs.length; pIdx++) {
      const para = translatedPage.paragraphs[pIdx];
      if (!(para.translated || '').trim()) continue;
      const box = getParagraphBox(pageInfo.lines, para.lineStart, para.lineEnd, cssViewport.transform);
      if (!box) continue;
      if (looksLikeFormula(para.original)) continue;
      if (tableSet.has(pIdx)) continue;
      if (isCoveredByGraphicRegion(pageInfo.graphicRegions, box, pageScale)) continue;
      // 位图分辨率是 CSS 尺寸的 pr 倍, 盖白矩形需同倍缩放; 外扩随缩放同步增大, 防残余字形边缘
      const pad = 1.5 * pageScale;
      ctx.fillStyle = '#fff';
      ctx.fillRect(
        (box.left - pad) * pr,
        (box.top - pad) * pr,
        (box.right - box.left + pad * 2) * pr,
        (box.height + pad * 2) * pr
      );
    }
  }

  function renderTranslatedTextLayer(cssViewport, wrapper, pageNum, pixelRatio) {
    const pageInfo = pages.find(p => p.pageNum === pageNum);
    const translatedPage = translatedPages.find(p => p.pageNum === pageNum);
    if (!pageInfo || !translatedPage) return;

    const pageWidth = cssViewport.width;
    const pageHeight = cssViewport.height;
    const pageScale = cssViewport.scale || 1;
    // 位图分辨率 / 显示尺寸: 盖白矩形按该比例换算 (可能因分辨率封顶而非设备像素比)
    const pr = pixelRatio > 0 ? pixelRatio : deviceDpr();
    // 右栏位图上下文: 逐段盖白遮住原文文本, 露出图片/图表/公式
    const canvas = wrapper.querySelector('canvas');
    const ctx = canvas ? canvas.getContext('2d') : null;

    const overlayDiv = document.createElement('div');
    overlayDiv.className = 'translated-overlay';
    overlayDiv.style.width = pageWidth + 'px';
    overlayDiv.style.height = pageHeight + 'px';
    wrapper.appendChild(overlayDiv);

    // V1.7.66/67: 表格段落集合 (按版面几何识别, 与开关状态无关)
    const tableSet = pageInfo ? detectTableParagraphIdx(pageInfo) : new Set();

    // 盖白统一交给 helper (与缩放重渲染共用判定), 本循环只负责叠译文 DOM 层
    paintTranslatedCoverRects(pageInfo, translatedPage, ctx, cssViewport, pr);

    for (let pIdx = 0; pIdx < translatedPage.paragraphs.length; pIdx++) {
      const para = translatedPage.paragraphs[pIdx];
      const translated = (para.translated || '').trim();
      if (!translated) continue;

      // 段落原文包围盒: item.transform 经视口 transform 归一为 CSS 像素 (V1.5.55:
      // 未旋转页与原"用户空间数值即 CSS 像素"等价, /Rotate 旋转页同样正确)
      const box = getParagraphBox(pageInfo.lines, para.lineStart, para.lineEnd, cssViewport.transform);
      if (!box) continue;

      // 数学公式: 不盖白也不叠文字层, 位图中的原始渲染 (上下标/分数排版/数学字体) 直接透出, 格式零修改
      if (looksLikeFormula(para.original)) continue;
      // 表格段落: 整格保持原图 (V1.7.70 起固定不翻译表格内文本, 保证列结构不变)
      if (tableSet.has(pIdx)) continue;
      // 图形区域内的文字 (图表标签/图例/示意图标注): 原图透出, 避免译文破坏图文对应
      if (isCoveredByGraphicRegion(pageInfo.graphicRegions, box, pageScale)) continue;

      const isFailed = translated.startsWith('[翻译失败]');
      const firstLine = pageInfo.lines[para.lineStart];
      // 行字号来自 1 倍解析, 需乘显示缩放才能与当前视口包围盒一致
      const fs0 = (firstLine ? firstLine.fontSize : 12) * pageScale;

      const div = document.createElement('div');
      div.className = isFailed ? 'translated-para translated-error' : 'translated-para';
      div.textContent = translated;
      // 段落定位信息: 译文批注按 (页码, 段落索引) 关联到具体段落
      div.dataset.page = String(pageNum);
      div.dataset.paraIdx = String(pIdx);
      div.style.position = 'absolute';
      div.style.left = box.left + 'px';
      div.style.top = box.top + 'px';
      div.style.width = Math.max(40, Math.min(box.right - box.left, pageWidth - box.left - 8)) + 'px';
      div.style.fontSize = fs0 + 'px';
      // 参考文献条目排除居中检测: 悬挂缩进的续行与首行"中心接近、左缘参差", 会被误判为居中排版,
      // 条目序号被推到中间无法与其他条目左对齐
      if (!REF_ENTRY_RE.test(para.original) && isCenteredParagraph(pageInfo.lines, para.lineStart, para.lineEnd, cssViewport.transform)) {
        div.style.textAlign = 'center';
      }
      overlayDiv.appendChild(div);

      // 字号自适应: 译文高度超过原文段落区域时按比例缩小字号, 避免段落间重叠
      const maxH = Math.max(box.height, fs0 * 1.4);
      let fs = fs0;
      for (let k = 0; k < 12 && fs > 7; k++) {
        const h = div.offsetHeight;
        if (h <= maxH) break;
        fs = Math.max(7, fs * Math.max(0.8, maxH / h));
        div.style.fontSize = fs.toFixed(2) + 'px';
      }

      // 还原本段译文上的历史批注: 重新包裹高亮 + 重建批注侧栏卡片 (在字号自适应之后, 保证卡片定位基于最终排版)
      for (const anno of annotations) {
        if (anno.page !== pageNum || anno.paraIdx !== pIdx) continue;
        const mark = wrapAnnotationText(div, anno.text, anno.id);
        if (mark) {
          addAnnoNoteCard(mark, anno);
          if (staleAnnoIds) staleAnnoIds.delete(anno.id);
        }
      }
    }
  }

  async function ensurePdfDoc() {
    if (!pdfDoc && pdfArrayBuffer) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');
      pdfDoc = await pdfjsLib.getDocument({ data: pdfArrayBuffer.slice(0) }).promise;
    }
    return pdfDoc;
  }

  // 某页翻译完成后, 在已渲染的右栏位图页上立即叠加该页译文层 (无需等全文翻译完)
  function updateTranslatedPage(pageNum) {
    const el = rightPageEls.get(pageNum);
    if (!el) return;
    renderTranslatedTextLayer(el.cssViewport, el.wrapper, pageNum, el.pixelRatio);
    if (statsHintEl && translateStats) {
      statsHintEl.textContent = statsHintText(translateStats);
    }
  }

  // ===== 缩放动态重渲染 (V1.7.83) =====
  // 原生 PDF 查看器是矢量渲染, 任意缩放都锐利; 插件是一次性位图, 浏览器缩放 (Ctrl+±) 只改变
  // 设备像素比而不重绘 canvas, 放大后位图被插值放大而发糊。这里监听 devicePixelRatio 变化
  // (Ctrl+± 会改变它), 防抖后按新倍率重绘当前文档各页位图。页面布局 (cssViewport/fitScale) 不变,
  // 所以左侧文字层、译文 DOM 层、批注坐标都无需重排, 只需按新倍率重涂右栏盖白。
  let dprQuery = null;
  let dprRerenderTimer = null;
  let dprRerenderRunning = false;
  let dprRerenderPending = false; // 重绘期间又发生倍率/滚动变化 → 结束后补跑一次

  // matchMedia('(resolution: Ndppx)') 只对当前倍率触发一次 change, 触发后需按新倍率重新注册
  function listenDprChange() {
    const dpr = window.devicePixelRatio || 1;
    try {
      dprQuery = window.matchMedia('(resolution: ' + dpr + 'dppx)');
    } catch (e) {
      dprQuery = null;
    }
    if (!dprQuery) return;
    const onChange = () => {
      try { dprQuery.removeEventListener('change', onChange); } catch (e) { /* 旧浏览器无 removeEventListener */ }
      listenDprChange();
      scheduleBitmapRerender();
    };
    dprQuery.addEventListener('change', onChange);
  }

  function scheduleBitmapRerender() {
    if (dprRerenderTimer) clearTimeout(dprRerenderTimer);
    // 防抖: Ctrl+± 连按会连续改变倍率, 只在停下来后按最终倍率重绘一次
    dprRerenderTimer = setTimeout(() => {
      dprRerenderTimer = null;
      rerenderBitmapsForDpr().catch(e => console.warn('[DocTranslate] 缩放重渲染失败:', e));
    }, 350);
  }

  // 当前可视区内的页 (放大查看优先保障这些页的清晰度, 滚出后回落常规倍率释放内存)
  function isRecordVisible(rec) {
    const wrapper = rec.leftCanvas && rec.leftCanvas.parentElement;
    if (!wrapper || !leftPaneEl) return false;
    const r = wrapper.getBoundingClientRect();
    const pane = leftPaneEl.getBoundingClientRect();
    return r.bottom > pane.top && r.top < pane.bottom;
  }

  async function rerenderBitmapsForDpr() {
    if (dprRerenderRunning) { dprRerenderPending = true; return; }
    if (!pageRenderRecords.length) return;
    dprRerenderRunning = true;
    const token = renderToken;
    const pageTotal = pageRenderRecords.length;
    try {
      for (const rec of pageRenderRecords) {
        if (token !== renderToken) return; // 已被新一轮渲染/返回上传取代
        const baseRatio = computePixelRatio(rec.fitScale, rec.cssViewport.width, rec.cssViewport.height, pageTotal);
        // 可视页: 放大查看时用增强倍率 (可能高于预算); 非可视页: 常规倍率 (释放内存)
        const newRatio = (boostActive() && isRecordVisible(rec))
          ? Math.max(baseRatio, computeBoostRatio())
          : baseRatio;
        // 倍率未变 (如尺寸变化但像素比不变) → 无需重绘
        if (Math.abs(newRatio - rec.pixelRatio) < 0.01) continue;
        if (!rec.leftCanvas) continue;
        const renderViewport = rec.page.getViewport({ scale: rec.fitScale * newRatio });
        rec.leftCanvas.width = Math.round(renderViewport.width);
        rec.leftCanvas.height = Math.round(renderViewport.height);
        // 重设 width/height 会清空画布, 随后整页重绘 (CSS 显示尺寸不变)
        await rec.page.render({ canvasContext: rec.leftCanvas.getContext('2d'), viewport: renderViewport }).promise;
        if (token !== renderToken) return;
        if (rec.rightCanvas) {
          rec.rightCanvas.width = Math.round(renderViewport.width);
          rec.rightCanvas.height = Math.round(renderViewport.height);
          const rctx = rec.rightCanvas.getContext('2d');
          rctx.drawImage(rec.leftCanvas, 0, 0);
          // 右栏是左栏位图拷贝 + 盖白: 拷贝会抹掉原盖白, 需按新倍率重涂 (译文 DOM 层不受影响)
          if (rec.isTranslated) {
            const pageInfo = pages.find(p => p.pageNum === rec.pageNum);
            const translatedPage = translatedPages.find(p => p.pageNum === rec.pageNum);
            paintTranslatedCoverRects(pageInfo, translatedPage, rctx, rec.cssViewport, newRatio);
          }
        }
        rec.pixelRatio = newRatio;
        // 后续 updateTranslatedPage 重涂盖白时用新倍率 (文字层本身按 CSS 定位, 不受位图倍率影响)
        const rel = rightPageEls.get(rec.pageNum);
        if (rel) rel.pixelRatio = newRatio;
      }
    } finally {
      dprRerenderRunning = false;
      if (dprRerenderPending) {
        dprRerenderPending = false;
        scheduleBitmapRerender();
      }
    }
  }

  async function renderPdfPages(isTranslated) {
    // 本次渲染代次: 渲染过程中若被新一轮渲染/返回上传取代 (token 变化), 立即放弃, 不再改写 docView
    const token = ++renderToken;
    hideSelBtn();
    hideSelPopup();
    hideAnnoBtn();
    hideAnnoEditor();
    docView.innerHTML = '';
    // 重渲染销毁全部高亮, 侧栏旧卡片一并清空; 是否显示侧栏由批注列表决定 (还原过程中逐张重建)
    annoRail.innerHTML = '';
    updateAnnoRail();
    const doc = await ensurePdfDoc();
    if (!doc || token !== renderToken) return false;
    // 译文重渲染前将全部批注标记为"待还原": 每条批注随所在段落成功还原后移出集合,
    // 渲染结束仍滞留的即失效批注 (段落已删除/译文已变化), 统一剔除
    staleAnnoIds = isTranslated ? new Set(annotations.map(a => a.id)) : null;
    // 重建右栏页元素索引, 供逐页翻译完成后的增量译文层更新使用
    rightPageEls = new Map();
    pageRenderRecords = [];

    const container = document.createElement('div');
    container.className = 'split-container';

    const leftPane = document.createElement('div');
    leftPane.className = 'split-pane split-pane-left';
    leftPaneEl = leftPane;
    const leftHeader = document.createElement('div');
    leftHeader.className = 'pane-header';
    leftHeader.textContent = '原文';
    const leftHint = document.createElement('span');
    leftHint.className = 'pane-header-hint';
    leftHint.textContent = '· 选中文字即可翻译';
    leftHeader.appendChild(leftHint);
    leftPane.appendChild(leftHeader);

    const rightPane = document.createElement('div');
    rightPane.className = 'split-pane split-pane-right';
    const rightHeader = document.createElement('div');
    rightHeader.className = 'pane-header';
    rightHeader.textContent = '译文';
    statsHintEl = null;
    if (isTranslated && translateStats) {
      // 译文侧标题展示本次翻译的缓存命中(本地/云端)/非缓存原文符数 (随历史记录保存, 逐页翻译时实时刷新)
      const statsHint = document.createElement('span');
      statsHint.className = 'pane-header-hint';
      statsHint.textContent = statsHintText(translateStats);
      rightHeader.appendChild(statsHint);
      statsHintEl = statsHint;
    }
    rightPane.appendChild(rightHeader);

    const leftScroll = document.createElement('div');
    leftScroll.className = 'pane-scroll-content';
    const rightScroll = document.createElement('div');
    rightScroll.className = 'pane-scroll-content';

    // 先挂载到 DOM, 保证译文层字号自适应时能测量实际高度
    leftPane.appendChild(leftScroll);
    rightPane.appendChild(rightScroll);
    container.appendChild(leftPane);
    container.appendChild(rightPane);
    docView.appendChild(container);

    for (const pageInfo of pages) {
      // 逐页渲染耗时长, 每页开始前检查代次: 若已被新渲染取代则立即中止
      if (token !== renderToken) return false;
      const page = await doc.getPage(pageInfo.pageNum);
      // 宽度自适应 (V1.7.50): 按栏宽铺满页面, 减少左右大片留白 (上下留白属于 PDF 原版面)
      // fitScale 决定显示尺寸, pixelRatio 决定位图分辨率 (V1.7.64: 超采样 + 全文档像素预算)
      const baseViewport = page.getViewport({ scale: 1 });
      const paneWidth = leftPane.getBoundingClientRect().width || leftPane.clientWidth;
      const availWidth = Math.max(240, paneWidth - 12 - 10);
      const fitScale = Math.min(2.4, Math.max(0.2, availWidth / baseViewport.width)) * PAGE_FONT_SCALE;
      const cssViewport = page.getViewport({ scale: fitScale });
      // 旧公式 (min(fitScale×DPR, 2.6)) 作为下限, 保证任何文档清晰度不降级;
      // 新公式在预算允许时按 1.5× 设备像素超采样, 大幅提升原文笔画锐度
      const pixelRatio = computePixelRatio(fitScale, cssViewport.width, cssViewport.height, pages.length);
      const renderScale = fitScale * pixelRatio;
      const renderViewport = page.getViewport({ scale: renderScale });

      const leftLabel = document.createElement('div');
      leftLabel.className = 'canvas-page-label';
      leftLabel.textContent = `第 ${pageInfo.pageNum} 页`;
      leftScroll.appendChild(leftLabel);
      const leftWrapper = await renderPageCanvas(page, renderViewport, cssViewport, leftScroll);
      // 单页文本层失败不影响后续页面渲染
      try {
        await renderLeftTextLayer(page, cssViewport, leftWrapper);
      } catch (e) {
        console.warn('[DocTranslate] 第 ' + pageInfo.pageNum + ' 页文本层渲染失败:', e);
      }

      const rightLabel = document.createElement('div');
      rightLabel.className = 'canvas-page-label';
      rightLabel.textContent = `第 ${pageInfo.pageNum} 页`;
      rightScroll.appendChild(rightLabel);
      const rightWrapper = isTranslated
        ? renderImagePage(cssViewport, renderViewport, rightScroll, leftWrapper.querySelector('canvas'))
        : renderBlankPage(cssViewport, rightScroll);
      if (isTranslated) {
        rightPageEls.set(pageInfo.pageNum, { wrapper: rightWrapper, cssViewport: cssViewport, pixelRatio: pixelRatio });
      }

      if (isTranslated) {
        renderTranslatedTextLayer(cssViewport, rightWrapper, pageInfo.pageNum, pixelRatio);
      }

      // 位图记录 (V1.7.83): 浏览器缩放改变 devicePixelRatio 后按新倍率重绘这几张 canvas
      pageRenderRecords.push({
        pageNum: pageInfo.pageNum,
        page: page,
        fitScale: fitScale,
        cssViewport: cssViewport,
        pixelRatio: pixelRatio,
        isTranslated: isTranslated,
        leftCanvas: leftWrapper.querySelector('canvas'),
        rightCanvas: rightWrapper.querySelector('canvas')
      });
    }

    // 渲染结束: 剔除未能还原的失效批注 (段落不存在或译文文字已变化)
    // 仅当本渲染仍是最新代次才清理 (V1.5.55): 循环末页的 await 期间可能已被新一轮渲染
    // 取代, 旧代次若在此过滤, 会按新代次的 staleAnnoIds 误删其尚未还原的批注并持久化
    if (token === renderToken && staleAnnoIds) {
      const before = annotations.length;
      annotations = annotations.filter(a => !staleAnnoIds.has(a.id));
      staleAnnoIds = null;
      // 有批注被剔除 → 持久化到本地并同步云端 (否则下次打开/其他设备还会还原出失效批注)
      if (annotations.length !== before) saveHistoryRecord();
    }

    let syncing = false;
    leftPane.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      const ratio = leftPane.scrollTop / (leftPane.scrollHeight - leftPane.clientHeight || 1);
      rightPane.scrollTop = ratio * (rightPane.scrollHeight - rightPane.clientHeight);
      // 横向同步 (V1.7.84): 浏览器缩放后页面比栏宽, 两栏横向滚动条位置保持一致
      const hRatio = leftPane.scrollLeft / (leftPane.scrollWidth - leftPane.clientWidth || 1);
      rightPane.scrollLeft = hRatio * (rightPane.scrollWidth - rightPane.clientWidth);
      syncing = false;
      maybeBoostVisiblePages();
    });
    rightPane.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      const ratio = rightPane.scrollTop / (rightPane.scrollHeight - rightPane.clientHeight || 1);
      leftPane.scrollTop = ratio * (leftPane.scrollHeight - leftPane.clientHeight);
      // 横向同步 (V1.7.84): 同上
      const hRatio = rightPane.scrollLeft / (rightPane.scrollWidth - rightPane.clientWidth || 1);
      leftPane.scrollLeft = hRatio * (leftPane.scrollWidth - leftPane.clientWidth);
      syncing = false;
      maybeBoostVisiblePages();
    });
    // 右栏滚动 (含左右同步触发的程序化滚动) 时重排批注侧栏卡片, 保持与高亮行对齐
    rightPane.addEventListener('scroll', scheduleAnnoLayout);
    // 全部页面渲染完成后按最终排版对齐侧栏卡片
    layoutAnnoCards();
    // 已处于放大状态时, 让可视页按增强倍率补绘一次 (100% 缩放不重绘, 避免加载时白做一次)
    maybeBoostVisiblePages();
    return true;
  }

  // 放大状态 (浏览器缩放 > 100%) 下滚动时, 让新进入可视区的页升到增强倍率、滚出的页回落常规倍率
  function maybeBoostVisiblePages() {
    if (!boostActive() || !pageRenderRecords.length) return;
    scheduleBitmapRerender();
  }

  backBtn.addEventListener('click', showUpload);

  // ===== 译文语音朗读 (V1.7.33): 浏览器内置 speechSynthesis, 免费无依赖, 不联网上传文本 =====
  // 长文按句子切成 ≤200 字符的片段顺序播报 (部分浏览器对超长 utterance 会截断)
  const ttsState = { playing: false, cancelled: false };

  function ttsLangCode() {
    const v = String(tgtLang.value || 'zh').toLowerCase();
    const map = {
      zh: 'zh-CN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR',
      fr: 'fr-FR', de: 'de-DE', es: 'es-ES', ru: 'ru-RU'
    };
    return map[v.split('-')[0]] || 'zh-CN';
  }

  // 分段: 返回 [{ text, start, end }] —— start/end 为相对整段译文的字符区间,
  // 供朗读时精确高亮"正在朗读的句子"(而非整段)
  function ttsSegments(text) {
    const src = String(text || '');
    const out = [];
    if (!src.trim()) return out;
    let start = 0;
    let i = 0;
    while (i < src.length) {
      const ch = src.charAt(i);
      i += 1;
      const len = i - start;
      if (('。！？；!?;'.indexOf(ch) >= 0 && len >= 60) || len >= 200) {
        out.push({ text: src.slice(start, i), start: start, end: i });
        start = i;
      }
    }
    if (start < src.length && src.slice(start).trim()) {
      out.push({ text: src.slice(start), start: start, end: src.length });
    }
    return out;
  }

  // ===== 朗读位置高亮 (V1.7.34) =====
  // 段落 = div.translated-para[data-page][data-para-idx]; 句子级高亮用 Range 切分文本节点包 <mark>,
  // 不重建 innerHTML, 因此不会破坏已有批注 <mark.vt-anno-mark> 的引用。
  function clearTtsHighlight() {
    const marks = docView.querySelectorAll('mark.tts-mark');
    for (const m of marks) {
      const parent = m.parentNode;
      if (!parent) continue;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    }
    const actives = docView.querySelectorAll('.translated-para.tts-active');
    for (const el of actives) el.classList.remove('tts-active');
  }

  function findParaEl(pageNum, paraIdx) {
    return docView.querySelector(
      '.translated-para[data-page="' + String(pageNum) + '"][data-para-idx="' + String(paraIdx) + '"]'
    );
  }

  // 在段落内按字符区间包 mark; 区间非法/节点异常返回 false (调用方退回整段高亮)
  function markTextRange(root, start, end) {
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      const items = [];
      let acc = 0;
      let node = walker.nextNode();
      while (node) {
        const val = node.nodeValue || '';
        items.push({ node: node, start: acc, end: acc + val.length });
        acc += val.length;
        node = walker.nextNode();
      }
      let wrapped = false;
      for (const it of items) {
        const s = Math.max(start, it.start);
        const e = Math.min(end, it.end);
        if (e <= s) continue;
        let target = it.node;
        const localEnd = e - it.start;
        const localStart = s - it.start;
        if (localEnd < (target.nodeValue || '').length) {
          target.splitText(localEnd);
        }
        if (localStart > 0) {
          target = target.splitText(localStart);
        }
        const mark = document.createElement('mark');
        mark.className = 'tts-mark';
        if (!target.parentNode) continue;
        target.parentNode.insertBefore(mark, target);
        mark.appendChild(target);
        wrapped = true;
      }
      return wrapped;
    } catch (e) {
      return false;
    }
  }

  // 高亮正在朗读的片段并滚动到可视区
  function highlightTtsItem(item) {
    clearTtsHighlight();
    if (!item) return;
    const el = findParaEl(item.page, item.paraIdx);
    if (!el) return;
    el.classList.add('tts-active');
    markTextRange(el, item.start, item.end);
    try {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (e) { /* 不支持参数时忽略 */ }
  }

  function updateTtsBtn() {
    ttsBtn.textContent = ttsState.playing ? '⏹ 停止朗读' : '🔊 朗读译文';
    ttsBtn.classList.toggle('btn-primary', ttsState.playing);
    ttsBtn.classList.toggle('btn-outline', !ttsState.playing);
  }

  function stopTts() {
    ttsState.cancelled = true;
    ttsState.playing = false;
    try {
      window.speechSynthesis.cancel();
    } catch (e) { /* 浏览器不支持时忽略 */ }
    clearTtsHighlight();
    updateTtsBtn();
  }

  function startTts() {
    if (!('speechSynthesis' in window)) {
      alert('当前浏览器不支持语音朗读');
      return;
    }
    const chunks = [];
    for (const page of translatedPages) {
      for (let pi = 0; pi < page.paragraphs.length; pi++) {
        const t = String(page.paragraphs[pi].translated || '');
        if (!t || t.startsWith('[翻译失败]')) continue;
        for (const seg of ttsSegments(t)) {
          chunks.push({ text: seg.text, page: page.pageNum, paraIdx: pi, start: seg.start, end: seg.end });
        }
      }
    }
    if (!chunks.length) {
      alert('还没有可朗读的译文');
      return;
    }
    try {
      window.speechSynthesis.cancel(); // 清掉可能残留的队列
    } catch (e) { /* 忽略 */ }
    clearTtsHighlight();
    ttsState.cancelled = false;
    ttsState.playing = true;
    updateTtsBtn();
    const lang = ttsLangCode();
    let voice = null;
    try {
      const voices = window.speechSynthesis.getVoices() || [];
      voice = voices.find(v => String(v.lang || '').toLowerCase().indexOf(lang.slice(0, 2).toLowerCase()) === 0) || null;
    } catch (e) { /* 无 voice 列表时用默认 */ }
    let i = 0;
    const next = () => {
      if (ttsState.cancelled) return;
      if (i >= chunks.length) {
        ttsState.playing = false;
        clearTtsHighlight();
        updateTtsBtn();
        return;
      }
      const item = chunks[i];
      i += 1;
      highlightTtsItem(item); // V1.7.34: 朗读到哪句高亮哪句 + 自动滚动
      const u = new SpeechSynthesisUtterance(item.text);
      u.lang = lang;
      if (voice) u.voice = voice;
      u.rate = 1;
      u.onend = next;
      u.onerror = next; // 单段失败跳过, 不中断整篇
      window.speechSynthesis.speak(u);
    };
    next();
  }

  ttsBtn.addEventListener('click', () => {
    if (ttsState.playing) stopTts();
    else startTts();
  });
  window.addEventListener('beforeunload', () => {
    try {
      window.speechSynthesis.cancel();
    } catch (e) { /* 忽略 */ }
  });

  // ===== 云端 TTS 导出 mp3 (V1.7.35): 配置统一在设置页, 这里只做来源切换与合成 =====
  const ttsDialog = document.getElementById('ttsDialog');
  const ttsTip = document.getElementById('ttsTip');
  const ttsGenBtn = document.getElementById('ttsGenBtn');
  const ttsCancelBtn = document.getElementById('ttsCancelBtn');
  const ttsCloseBtn = document.getElementById('ttsCloseBtn');
  const ttsExportBtn = document.getElementById('ttsExportBtn');
  const ttsModeServerBtn = document.getElementById('ttsModeServer');
  const ttsModeCustomBtn = document.getElementById('ttsModeCustom');
  const ttsOpenSettingsBtn = document.getElementById('ttsOpenSettingsBtn');
  let ttsExportAbort = null;
  // 三档来源 —— 官方引擎 (服务端 Pro) / 百度 (BYOK) / 自定义接口 (BYOK OpenAI 兼容)
  const ttsModeBaiduBtn = document.getElementById('ttsModeBaidu');
  let ttsMode = 'server'; // 默认走服务端 Pro 代理 (免 Key)
  // V1.7.63: 最近一次与存储对齐的来源。用于区分「弹窗内刚切换(写入可能尚未落盘)」与「外部改过设置」,
  // 避免生成前重读存储时把用户刚点的选择覆盖回旧值 (setTtsMode 异步写入的竞态)
  let ttsModeSynced = 'server';

  if (ttsOpenSettingsBtn) {
    ttsOpenSettingsBtn.addEventListener('click', () => {
      try {
        chrome.runtime.openOptionsPage();
      } catch (e) {
        window.open(chrome.runtime.getURL('options.html'), '_blank');
      }
    });
  }

  function updateTtsMode() {
    ttsModeServerBtn.classList.toggle('active', ttsMode === 'server');
    ttsModeBaiduBtn.classList.toggle('active', ttsMode === 'baidu');
    ttsModeCustomBtn.classList.toggle('active', ttsMode === 'custom');
    if (ttsMode === 'server') {
      ttsTip.textContent = '官方引擎（Pro 专享）：免填 Key，按字符计入每日语音合成额度（北京时间 0 点重置），合成后拼接为一个 mp3。';
    } else if (ttsMode === 'baidu') {
      ttsTip.textContent = '百度语音合成（自带密钥，免费用户可用）：AK/SK、音色、语速在「⚙️ 统一设置」中配置。';
    } else {
      ttsTip.textContent = '自定义接口（自带 Key）：OpenAI 兼容 /audio/speech，配置在「⚙️ 统一设置」中维护。';
    }
  }

  function readTtsConfig() {
    const c = (config && config.tts) || {};
    // V1.7.62: 来源(mode)以统一设置为准——设置页写 vtConfig.settings.tts.mode;
    // 旧字段 vtConfig.tts.mode 兼容回退。V1.7.42~V1.7.61 期间设置页不写旧字段,
    // 导致「设置成百度」后导出音频恒走官方引擎(固定女声), 换任何音色都不生效。
    const st = (config && config.settings && config.settings.tts) || {};
    const modes = ['server', 'baidu', 'custom'];
    const mode = modes.indexOf(st.mode) >= 0 ? st.mode : (modes.indexOf(c.mode) >= 0 ? c.mode : 'server');
    return {
      mode,
      endpoint: String(c.endpoint || 'https://api.openai.com/v1/audio/speech').trim(),
      apiKey: String(c.apiKey || '').trim(),
      model: String(c.model || 'tts-1').trim(),
      voice: String(c.voice || 'alloy').trim(),
      baiduAk: String(c.baiduAk || '').trim(),
      baiduSk: String(c.baiduSk || '').trim(),
      baiduVoice: String(c.baiduVoice || '0').trim(),
      baiduSpeed: String(c.baiduSpeed || '5').trim()
    };
  }

  // V1.7.62: 弹窗内切换来源立即持久化(旧字段 + settings 双写), 设置页/导出音频始终一致
  function setTtsMode(mode) {
    ttsMode = mode;
    updateTtsMode();
    try {
      chrome.storage.local.get(['vtConfig'], r => {
        const c = (r && r.vtConfig) || {};
        c.tts = Object.assign({}, c.tts || {}, { mode });
        if (c.settings && typeof c.settings === 'object' && c.settings.tts) {
          c.settings.tts = Object.assign({}, c.settings.tts, { mode });
        }
        try { chrome.storage.local.set({ vtConfig: c }); } catch (e2) { /* 仅本次生效 */ }
      });
    } catch (e) { /* chrome 不可用时仅本次生效 */ }
  }

  function saveTtsConfig(cfg) {
    // V1.7.62: 合并而非整体替换, 避免误删 mode/未来新增字段
    config.tts = Object.assign({}, config.tts || {}, cfg);
    try {
      chrome.storage.local.get(['vtConfig'], r => {
        const c = (r && r.vtConfig) || {};
        c.tts = Object.assign({}, c.tts || {}, cfg);
        try { chrome.storage.local.set({ vtConfig: c }); } catch (e2) { /* 持久化失败仅影响下次会话 */ }
      });
    } catch (e) { /* chrome 不可用时仅本次生效 */ }
  }

  async function openTtsDialog() {
    // V1.7.60: 打开前重读存储——设置页改过音色/语速/密钥后, 已打开的文档翻译页读到新配置
    // (此前读页面加载时的旧 config, 表现为“改了音色不生效”; AI 弹窗 V1.7.12 起即有此重读)
    await loadConfig();
    const cfg = readTtsConfig();
    ttsMode = cfg.mode;
    ttsModeSynced = cfg.mode;
    updateTtsMode();
    ttsDialog.classList.add('vt-visible');
  }

  function closeTtsDialog() {
    if (ttsExportAbort) {
      try { ttsExportAbort.abort(); } catch (e) { /* 忽略 */ }
      ttsExportAbort = null;
    }
    ttsGenBtn.disabled = false;
    ttsGenBtn.textContent = '生成并下载';
    ttsDialog.classList.remove('vt-visible');
  }

  // V1.7.59: 导出音频弹窗非模态浮窗化——标题行可拖动, 拖到一边可滚动查看底部主页面
  makeDialogDraggable(ttsDialog.querySelector('.share-dialog'), ttsDialog.querySelector('.dialog-title-row'));

  // 收集译文并按 ≤maxChars 合并为 TTS 请求片段
  // (服务端百度 TTS 单次上限较紧, 用 280; 自定义接口多为 2k~4k, 用 1200)
  function ttsExportChunks(maxChars) {
    const limit = Math.max(Number(maxChars) || 1200, 60);
    const segs = [];
    for (const page of translatedPages) {
      for (const para of page.paragraphs) {
        const t = String(para.translated || '');
        if (!t || t.startsWith('[翻译失败]')) continue;
        for (const s of ttsSegments(t)) segs.push(s.text);
      }
    }
    const out = [];
    let buf = '';
    for (const s of segs) {
      if (buf.length > 0 && (buf + s).length > limit) {
        out.push(buf);
        buf = s;
      } else {
        buf += s;
      }
    }
    if (buf.trim()) out.push(buf);
    return out;
  }

  async function synthTtsMp3() {
    // V1.7.61: 生成前重读存储——弹窗打开期间去设置页改过配置 (官方/百度/自定义 任一来源),
    // 点「生成并下载」也要用新配置, 不停留在页面/弹窗加载时的旧 config
    await loadConfig();
    // V1.7.62/63: 只有存储来源相对「上次对齐值」发生了变化(设置页/其他标签页改过)才跟随;
    // 弹窗内刚点的切换不能被尚未落盘的旧存储值覆盖
    const storedMode = readTtsConfig().mode;
    if (storedMode !== ttsModeSynced) { ttsMode = storedMode; updateTtsMode(); }
    ttsModeSynced = ttsMode;
    const isServer = ttsMode === 'server';
    const isBaidu = ttsMode === 'baidu';
    // V1.7.41: 配置来自统一设置页 (vtConfig.tts), 弹窗内不再有输入框
    const cfg = readTtsConfig();
    cfg.mode = ttsMode;
    if (isBaidu) {
      if (!cfg.baiduAk || !cfg.baiduSk) {
        ttsTip.textContent = '未配置百度语音合成：请到「⚙️ 配置语音引擎」填写 API Key 与 Secret Key';
        return;
      }
    } else if (!isServer) {
      if (!cfg.endpoint) {
        ttsTip.textContent = '未配置语音接口地址：请到「⚙️ 配置语音引擎」维护';
        return;
      }
      if (!cfg.apiKey && !/localhost|127\.0\.0\.1/.test(cfg.endpoint)) {
        ttsTip.textContent = '未配置 API Key（本地服务可留空）：请到「⚙️ 配置语音引擎」维护';
        return;
      }
    }
    const chunks = ttsExportChunks((isServer || isBaidu) ? 280 : 1200);
    if (!chunks.length) {
      ttsTip.textContent = '还没有可导出的译文';
      return;
    }
    saveTtsConfig(cfg);
    ttsExportAbort = new AbortController();
    const signal = ttsExportAbort.signal;
    ttsGenBtn.disabled = true;
    const parts = [];
    try {
      for (let i = 0; i < chunks.length; i++) {
        ttsGenBtn.textContent = '合成中 ' + (i + 1) + '/' + chunks.length;
        ttsTip.textContent = '正在合成第 ' + (i + 1) + '/' + chunks.length + ' 段…';
        let buf;
        if (isServer) {
          // 服务端代理 (Pro 专享, 免 Key); 百度短文本接口单次上限约 1KB, 已按 280 字切分
          buf = await cloudTts(chunks[i], { lang: ttsLangCode().slice(0, 2), speed: 5 });
        } else if (isBaidu) {
          // 百度 BYOK: 客户端直连, 免费额度 QPS 较低 → 段间稍作间隔
          if (i > 0) await new Promise(r => setTimeout(r, 500));
          if (signal.aborted) throw new Error('已取消');
          buf = await baiduTts(chunks[i], {
            ak: cfg.baiduAk,
            sk: cfg.baiduSk,
            lang: ttsLangCode().slice(0, 2),
            speed: Number(cfg.baiduSpeed) || 5,
            voice: cfg.baiduVoice || '0'
          });
        } else {
          const resp = await fetch(cfg.endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + cfg.apiKey
            },
            body: JSON.stringify({
              model: cfg.model || 'tts-1',
              input: chunks[i],
              voice: cfg.voice || 'alloy',
              response_format: 'mp3'
            }),
            signal: signal
          });
          if (!resp.ok) {
            const txt = await resp.text().catch(() => '');
            throw new Error('接口返回 ' + resp.status + (txt ? '：' + txt.slice(0, 120) : ''));
          }
          buf = await resp.arrayBuffer();
        }
        if (!buf || buf.byteLength < 512) {
          throw new Error('返回音频为空或过短');
        }
        parts.push(new Uint8Array(buf));
      }
      // mp3 帧直接拼接: 主流播放器与微信均可直接播放
      let total = 0;
      for (const p of parts) total += p.length;
      const merged = new Uint8Array(total);
      let off = 0;
      for (const p of parts) {
        merged.set(p, off);
        off += p.length;
      }
      const blob = new Blob([merged], { type: 'audio/mpeg' });
      const base = String(fileName || '译文朗读').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_');
      const mp3Name = base + '_朗读.mp3';
      // V1.7.36: 优先唤起系统分享面板 (Windows 会列出微信等应用, 仍需在微信里选好友);
      // 不支持/用户取消时回退为直接下载
      let shared = false;
      let shareAttempted = false;
      try {
        if (typeof File === 'function' && navigator.canShare) {
          const file = new File([blob], mp3Name, { type: 'audio/mpeg' });
          if (navigator.canShare({ files: [file] })) {
            shareAttempted = true;
            await navigator.share({ files: [file], title: mp3Name });
            shared = true;
          }
        }
      } catch (se) {
        if (se && se.name === 'AbortError') shareAttempted = true; // 用户取消分享 → 回退下载
      }
      if (!shared) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = mp3Name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
      ttsTip.textContent = shared
        ? '已生成 ' + (total / 1048576).toFixed(1) + 'MB mp3，已打开系统分享面板（选择微信 → 好友）。'
        : (shareAttempted ? '已取消分享，已改为下载 ' + (total / 1048576).toFixed(1) + 'MB mp3。'
          : '已生成 ' + (total / 1048576).toFixed(1) + 'MB mp3，请在下载栏查看。');
      ttsGenBtn.textContent = '再次生成';
      ttsGenBtn.disabled = false;
    } catch (e) {
      const cancelled = e && e.name === 'AbortError';
      ttsTip.textContent = cancelled ? '已取消' : ('生成失败：' + (e && e.message ? e.message : String(e)));
      ttsGenBtn.textContent = '生成并下载';
      ttsGenBtn.disabled = false;
    } finally {
      ttsExportAbort = null;
    }
  }

  ttsExportBtn.addEventListener('click', openTtsDialog);
  ttsModeServerBtn.addEventListener('click', () => setTtsMode('server'));
  ttsModeBaiduBtn.addEventListener('click', () => setTtsMode('baidu'));
  ttsModeCustomBtn.addEventListener('click', () => setTtsMode('custom'));
  ttsCancelBtn.addEventListener('click', closeTtsDialog);
  if (ttsCloseBtn) ttsCloseBtn.addEventListener('click', closeTtsDialog);
  ttsGenBtn.addEventListener('click', () => { synthTtsMp3(); });


  // ===== 分享译文: 自包含 HTML 文件 / PNG 长图 (双语对照 / 仅译文, 可附带批注), 离线发送给对方 =====
  const shareDialog = document.getElementById('shareDialog');
  const shareAnnoRow = document.getElementById('shareAnnoRow');
  const shareAnno = document.getElementById('shareAnno');
  const shareAnnoCount = document.getElementById('shareAnnoCount');
  const shareGenBtn = document.getElementById('shareGenBtn');
  const shareCancelBtn = document.getElementById('shareCancelBtn');
  const shareTip = document.getElementById('shareTip');

  const SHARE_WAY_TIPS = {
    'html': '生成自包含 HTML 文件，发给对方即可在浏览器直接阅读，无需服务器。',
    'image': '按页导出 PNG 长图（译文文字已烘焙进图片），保存后可直接发微信；内容过多时自动拆成多张。'
  };

  function currentShareWay() {
    const el = document.querySelector('input[name="shareWay"]:checked');
    return el ? el.value : 'html';
  }

  // 切换分享方式: 更新说明文案与按钮文字
  function updateShareWay() {
    const way = currentShareWay();
    shareTip.textContent = SHARE_WAY_TIPS[way] || SHARE_WAY_TIPS.html;
    shareGenBtn.textContent = way === 'image' ? '生成图片' : '生成并下载';
  }

  function hideShareDialog() {
    shareDialog.classList.remove('vt-visible');
  }

  // V1.7.59: 分享弹窗非模态浮窗化——标题行可拖动, 拖到一边可滚动查看底部主页面
  makeDialogDraggable(shareDialog.querySelector('.share-dialog'), shareDialog.querySelector('.dialog-title-row'));

  shareBtn.addEventListener('click', () => {
    if (!translatedPages.length) {
      alert('请先完成翻译再分享');
      return;
    }
    // 批注选项: 无批注时隐藏整行
    const n = annotations.length;
    shareAnnoRow.style.display = n ? 'flex' : 'none';
    shareAnnoCount.textContent = String(n);
    if (n) shareAnno.checked = true;
    updateShareWay();
    shareDialog.classList.add('vt-visible');
  });

  for (const el of document.querySelectorAll('input[name="shareWay"]')) {
    el.addEventListener('change', updateShareWay);
  }

  shareCancelBtn.addEventListener('click', hideShareDialog);
  const shareCloseBtn = document.getElementById('shareCloseBtn');
  if (shareCloseBtn) shareCloseBtn.addEventListener('click', hideShareDialog);

  shareGenBtn.addEventListener('click', async () => {
    const checked = document.querySelector('input[name="shareMode"]:checked');
    const mode = checked ? checked.value : 'bilingual';
    const way = currentShareWay();
    const oldText = shareGenBtn.textContent;
    // 页面图片对照/长图需逐页编码位图, 大文档耗时较长
    shareGenBtn.disabled = true;
    shareGenBtn.textContent = '生成中...';
    try {
      if (way === 'image') {
        await downloadShareImages(mode, shareAnno.checked);
      } else {
        await downloadShareHtml(mode, shareAnno.checked);
      }
      hideShareDialog();
    } catch (e) {
      console.error('[DocTranslate] 分享生成失败:', e);
      alert('分享生成失败: ' + (e && e.message ? e.message : e));
    } finally {
      shareGenBtn.disabled = false;
      shareGenBtn.textContent = oldText;
    }
  });

  // ===== AI 文档对话 (V1.7.12, 微信式): 感知文档内容的多轮聊天; 云端 DeepSeek (Pro 服务端托管) / 自定义模型 (OpenAI 兼容/Ollama, 独立配置免费用) =====
  // 左=机器人(品牌头像+模型名) 右=小T(插件头像); 文档上下文每轮注入 system (HTTP 无状态, lib/ai-summary.js buildChatMessages 统一裁剪);
  // 对话随历史记录/云端同步持久化 (rec.aiChat 含 engine/model/messages), 公式段跳过, 翻译前即可用 (基于原文段落)
  const aiDialog = document.getElementById('aiDialog');
  const aiChatList = document.getElementById('aiChatList');
  const aiChatError = document.getElementById('aiChatError');
  const aiChips = document.getElementById('aiChips');
  const aiInput = document.getElementById('aiInput');
  const aiSendBtn = document.getElementById('aiSendBtn');
  const aiClearBtn = document.getElementById('aiClearBtn');
  const aiCloseBtn = document.getElementById('aiCloseBtn2');
  const aiEngineCloudBtn = document.getElementById('aiEngineCloud');
  const aiEngineCustomBtn = document.getElementById('aiEngineCustom');
  const aiThinkBtn = document.getElementById('aiThinkBtn');
  // 独立 AI 模型配置 (V1.7.11 / 三槽位 V1.7.45): config.aiModels[3] 与翻译引擎槽位分离, 免费/未登录可用
  const aiConfigBox = document.getElementById('aiConfig');
  const aiSlotRow = document.getElementById('aiSlotRow');
  const aiOpenSettingsBtn = document.getElementById('aiOpenSettingsBtn');
  // V1.7.41: 内联配置表单已移除, 配置统一在 options.html 维护
  if (aiOpenSettingsBtn) {
    aiOpenSettingsBtn.addEventListener('click', () => {
      try {
        chrome.runtime.openOptionsPage();
      } catch (e) {
        window.open(chrome.runtime.getURL('options.html'), '_blank');
      }
    });
  }

  // 分析引擎选择: 'cloud' (云端 DeepSeek, Pro 专享服务端计费) | 'custom' (自定义模型 BYOK, 免费)
  let aiEngine = 'cloud';
  // 自定义模型槽位 (V1.7.45): 配置在统一设置页, 实际使用哪个槽位在弹窗内选择
  let aiSlot = 0;
  // V1.7.29: 深度思考开关 (仅云端模型生效), 默认关闭 —— 省 token 且首字更快;
  // 复杂论文/公式/逻辑类问题可手动开启 (请求体带 thinking enabled)
  let aiDeepThink = false;

  function updateAiEngineBtns() {
    aiEngineCloudBtn.classList.toggle('active', aiEngine === 'cloud');
    aiEngineCustomBtn.classList.toggle('active', aiEngine === 'custom');
    // 深度思考是 DeepSeek 参数, 自定义模型不适用 → 隐藏
    aiThinkBtn.style.display = aiEngine === 'cloud' ? '' : 'none';
    aiThinkBtn.classList.toggle('active', aiDeepThink);
  }

  function normalizeAiSlot(m) {
    const s = m || {};
    return {
      baseUrl: String(s.baseUrl || '').trim().replace(/\/+$/, ''),
      apiKey: String(s.apiKey || '').trim(),
      model: String(s.model || '').trim(),
      maxBytes: Number(s.maxBytes) || 0
    };
  }

  // 读取槽位配置 (1~3 个): 新结构 aiModels 优先; 旧单字段 aiModel 回退到槽位 1
  function readAiModels() {
    const arr = (config && Array.isArray(config.aiModels)) ? config.aiModels.slice(0, 3) : [];
    const legacy = normalizeAiSlot(config && config.aiModel);
    const out = arr.length ? arr.map(normalizeAiSlot) : [normalizeAiSlot(null)];
    const hasAny = out.some(m => m.baseUrl || m.apiKey || m.model || m.maxBytes);
    const hasLegacy = legacy.baseUrl || legacy.apiKey || legacy.model || legacy.maxBytes;
    // 旧单槽位别名只在没有任何新槽位配置时回填, 避免与已配置槽位重复 (V1.7.45)
    if (hasLegacy && !hasAny) out[0] = legacy;
    return out;
  }

  // 当前槽位无地址时自动落到第一个已配置槽位 (设置页允许只填槽位 2/3)
  function resolveAiSlot() {
    const models = readAiModels();
    let idx = aiSlot;
    if (!(idx >= 0 && idx < models.length)) idx = 0;
    if (models[idx] && models[idx].baseUrl) return idx;
    for (let i = 0; i < models.length; i++) {
      if (models[i].baseUrl) return i;
    }
    return idx;
  }

  // 当前使用的 AI 槽位配置 (设置页维护 aiModels, 这里只读)
  function readAiModelForm() {
    return readAiModels()[aiSlot] || normalizeAiSlot(null);
  }

  function renderAiSlots() {
    if (!aiSlotRow) return;
    const models = readAiModels();
    aiSlotRow.innerHTML = models.map((m, i) => {
      const label = '槽位 ' + (i + 1) + (m.model ? ' · ' + m.model : '');
      return '<button type="button" class="ai-slot-btn' + (i === aiSlot ? ' active' : '') + '" data-ai-slot="' + i + '">'
        + escapeHtml(label) + '</button>';
    }).join('');
    aiSlotRow.querySelectorAll('[data-ai-slot]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (aiRunning) return;
        aiSlot = Number(btn.dataset.aiSlot) || 0;
        try { chrome.storage.local.set({ vtAiActive: aiSlot }); } catch (e) { /* 持久化失败仅影响下次默认 */ }
        renderAiSlots();
      });
    });
  }

  function updateAiConfigVisible() {
    aiConfigBox.style.display = aiEngine === 'custom' ? '' : 'none';
    if (aiEngine === 'custom') renderAiSlots();
  }

  // 引擎按套餐区分 (V1.7.11): Pro → 云端按钮可见 (默认云端); 免费/未登录 → 云端按钮屏蔽,
  // 强制本地模型 (不持久化强制结果——升级 Pro 后回到云端默认; 用户点选仍正常持久化)
  function applyAiEngineAccess(isPro) {
    aiEngineCloudBtn.style.display = isPro ? '' : 'none';
    if (!isPro && aiEngine !== 'custom') {
      aiEngine = 'custom';
      aiSlot = resolveAiSlot();
      updateAiEngineBtns();
      updateAiConfigVisible();
    }
  }

  function setAiEngine(engine) {
    if (aiRunning || aiEngine === engine) return;
    aiEngine = engine;
    if (engine === 'custom') aiSlot = resolveAiSlot();
    updateAiEngineBtns();
    updateAiConfigVisible();
    try { chrome.storage.local.set({ vtAiEngine: engine }); } catch (e) { /* 持久化失败仅影响下次默认 */ }
  }

  // 启动时恢复上次选择 (缺失/非法回落云端默认; 槽位缺失回落第一个已配置槽位)
  (async () => {
    try {
      const items = await chrome.storage.local.get(['vtAiEngine', 'vtAiActive']);
      if (items && items.vtAiEngine === 'custom') aiEngine = 'custom';
      const n = Number(items && items.vtAiActive);
      if (Number.isFinite(n) && n >= 0 && n <= 2) aiSlot = Math.floor(n);
    } catch (e) { /* chrome 不可用时保持默认 */ }
    aiSlot = resolveAiSlot();
    updateAiEngineBtns();
    updateAiConfigVisible();
  })();
  aiEngineCloudBtn.addEventListener('click', () => setAiEngine('cloud'));
  aiEngineCustomBtn.addEventListener('click', () => setAiEngine('custom'));
  aiThinkBtn.addEventListener('click', () => {
    aiDeepThink = !aiDeepThink;
    updateAiEngineBtns();
  });

  function hideAiDialog() {
    aiDialog.classList.remove('vt-visible');
  }

  // 历史记录里的 AI 对话还原 (V1.7.12): 形态校验 + 旧版一次性总结 (V1.7.9~7.11 rec.aiSummary) 迁移为首条机器人消息
  function normalizeAiChat(chat, legacySummary) {
    if (chat && Array.isArray(chat.messages) && chat.messages.length) {
      const messages = chat.messages.filter(m =>
        m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content);
      if (messages.length) {
        return { engine: chat.engine === 'custom' ? 'custom' : 'cloud', model: String(chat.model || ''), messages: messages };
      }
    }
    if (legacySummary && legacySummary.content) {
      return {
        engine: legacySummary.engine === 'cloud' ? 'cloud' : 'custom',
        model: legacySummary.engine === 'cloud' ? 'DeepSeek' : String(legacySummary.model || ''),
        messages: [{ role: 'assistant', content: String(legacySummary.content), time: legacySummary.time || 0 }]
      };
    }
    return null;
  }

  // ===== 微信式对话渲染: 左=机器人(品牌头像+模型名) 右=小T(插件头像) =====
  const AI_USER_NAME = '小T';
  const AI_USER_AVATAR = chrome.runtime.getURL('icons/icon48.png');
  const AI_DEEPSEEK_AVATAR = chrome.runtime.getURL('icons/ai-deepseek.ico'); // DeepSeek 官方商标 (官网 favicon)
  const AI_ROBOT_AVATAR = chrome.runtime.getURL('icons/ai-robot.svg');       // 未知模型兜底头像

  // 品牌头像映射: 云端引擎/DeepSeek 系模型用官方商标, 其余模型兜底机器人
  function botAvatarOf(m) {
    if (m.engine === 'cloud' || String(m.model || '').toLowerCase().includes('deepseek')) return AI_DEEPSEEK_AVATAR;
    return AI_ROBOT_AVATAR;
  }

  function botNameOf(m) {
    if (m.engine === 'cloud') return 'DeepSeek';
    return String(m.model || '').trim() || 'AI 助手';
  }

  function buildMsgRow(m) {
    const row = document.createElement('div');
    row.className = 'ai-msg' + (m.role === 'user' ? ' me' : '');
    const img = document.createElement('img');
    img.className = 'ai-avatar';
    img.alt = '';
    img.src = m.role === 'user' ? AI_USER_AVATAR : botAvatarOf(m);
    const col = document.createElement('div');
    col.className = 'ai-msg-col';
    const name = document.createElement('div');
    name.className = 'ai-msg-name';
    name.textContent = m.role === 'user' ? AI_USER_NAME : botNameOf(m);
    const bubble = document.createElement('div');
    bubble.className = 'ai-bubble';
    bubble.textContent = m.content;
    col.appendChild(name);
    col.appendChild(bubble);
    row.appendChild(img);
    row.appendChild(col);
    return row;
  }

  // 打字中占位 (当前引擎的品牌头像 + 三点动画)
  function buildTypingRow() {
    const fake = {
      role: 'assistant',
      engine: aiEngine,
      model: aiEngine === 'cloud' ? 'DeepSeek' : (readAiModelForm().model || '')
    };
    const row = document.createElement('div');
    row.className = 'ai-msg';
    const img = document.createElement('img');
    img.className = 'ai-avatar';
    img.alt = '';
    img.src = botAvatarOf(fake);
    const col = document.createElement('div');
    col.className = 'ai-msg-col';
    const name = document.createElement('div');
    name.className = 'ai-msg-name';
    name.textContent = botNameOf(fake);
    const bubble = document.createElement('div');
    bubble.className = 'ai-bubble';
    const typing = document.createElement('div');
    typing.className = 'ai-typing';
    for (let i = 0; i < 3; i++) typing.appendChild(document.createElement('i'));
    bubble.appendChild(typing);
    col.appendChild(name);
    col.appendChild(bubble);
    row.appendChild(img);
    row.appendChild(col);
    return row;
  }

  // 空对话快捷指令: 一键总结/要点 (发送后自动隐藏)
  const AI_CHAT_PRESETS = [
    ['总结这篇文档', '请总结这篇文档的核心内容，包含主要观点与结论。'],
    ['列出关键要点', '请用列表列出这篇文档的关键要点。']
  ];

  function renderChat() {
    aiChatList.innerHTML = '';
    const msgs = aiChat ? aiChat.messages : [];
    if (!msgs.length && !aiRunning) {
      const empty = document.createElement('div');
      empty.className = 'ai-chat-empty';
      empty.textContent = '与 AI 对话分析这篇文档（打开不发送、不消耗额度；提问后才带文档内容）';
      aiChatList.appendChild(empty);
    }
    for (const m of msgs) aiChatList.appendChild(buildMsgRow(m));
    if (aiRunning) aiChatList.appendChild(buildTypingRow());
    aiChips.innerHTML = '';
    if (!msgs.length && !aiRunning) {
      for (const pair of AI_CHAT_PRESETS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ai-chip';
        b.textContent = pair[0];
        b.addEventListener('click', () => sendChatMessage(pair[1]));
        aiChips.appendChild(b);
      }
    }
  }

  function scrollChatBottom() {
    aiChatList.scrollTop = aiChatList.scrollHeight;
  }

  function showChatError(msg) {
    aiChatError.textContent = String(msg || '请求失败');
    aiChatError.style.display = 'block';
  }

  function hideChatError() {
    aiChatError.style.display = 'none';
  }

  // 收集全文分析文本: 逐页段落原文, 跳过公式段 (对总结无意义且浪费 token)
  function collectAnalysisText() {
    const parts = [];
    for (const p of pages) {
      for (const para of p.paragraphs) {
        const t = (para.original || '').trim();
        if (t && !looksLikeFormula(t)) parts.push(t);
      }
    }
    return parts.join('\n\n');
  }

  // 发送一轮对话: 消息入列 → buildChatMessages 注入文档上下文并裁剪历史 → 双引擎分发
  // 失败保留已发消息 (可重新提问), 错误红字提示在输入区上方; 成功且已有翻译历史时随记录持久化
  async function sendChatMessage(text) {
    const t = String(text != null ? text : aiInput.value).trim();
    if (!t || aiRunning) return;
    // V1.7.61: 发送前重读存储——弹窗打开期间在设置页改过 AI 模型槽位/密钥, 发送时用新配置
    await loadConfig();
    const useCloud = aiEngine === 'cloud';
    let slot = null;
    if (!useCloud) {
      slot = readAiModelForm();
      if (!slot.baseUrl) {
        showChatError('自定义模型未配置：请在「⚙️ 统一设置」配置 AI 模型槽位（OpenAI 兼容，支持本地 Ollama），并在本窗口选择槽位');
        return;
      }
    }
    hideChatError();
    aiInput.value = '';
    if (!aiChat) aiChat = { engine: useCloud ? 'cloud' : 'custom', model: '', messages: [] };
    aiChat.messages.push({ role: 'user', content: t, time: Date.now() });
    aiRunning = true;
    renderChat();
    scrollChatBottom();
    try {
      const docText = collectAnalysisText();
      // 云端: 服输预算 3.8 万码点 (服务端 4 万上限); 自定义: 跟随 AI 模型字节上限配置放宽
      const limits = useCloud ? {} : {
        maxDocChars: Math.min(slot.maxBytes || 40000, 60000),
        maxTotalChars: Math.min(slot.maxBytes || 40000, 60000) + 12000
      };
      const msgs = buildChatMessages(docText, aiChat.messages, limits);
      const content = useCloud
        ? await cloudChat(msgs, config, { temperature: 0.5, deepThink: aiDeepThink })
        : await customChat(msgs, config, { slot: slot, temperature: 0.5 });
      // 本地模型 (自定义引擎) 用量按天记 chrome.storage (V1.7.14「历史用量」页);
      // 云端 DeepSeek 由服务端 ai_usage 记账 (chars/out_chars), 不在本地重复统计
      if (!useCloud) {
        let aiIn = 0;
        for (const m of msgs) aiIn += Array.from(m.content).length;
        recordLocalUsage({ aiIn: aiIn, aiOut: Array.from(content).length });
      }
      aiChat.engine = useCloud ? 'cloud' : 'custom';
      aiChat.model = useCloud ? 'DeepSeek' : (slot.model || '');
      aiChat.messages.push({ role: 'assistant', content: content, engine: aiChat.engine, model: aiChat.model, time: Date.now() });
      if (translatedPages.length) saveHistoryRecord();
    } catch (e) {
      console.warn('[DocTranslate] AI 对话失败:', e);
      // 发送失败: 回退本轮用户消息并还原输入框 (可直接重发), 错误红字提示在输入区上方
      if (aiChat && aiChat.messages.length && aiChat.messages[aiChat.messages.length - 1].role === 'user') {
        aiChat.messages.pop();
      }
      aiInput.value = t;
      showChatError(e.message);
    } finally {
      aiRunning = false;
      renderChat();
      scrollChatBottom();
    }
  }

  aiSummaryBtn.addEventListener('click', async () => {
    if (aiRunning) return;
    await loadConfig();
    // 引擎按套餐区分 (V1.7.11): Pro → 双引擎默认云端 DeepSeek; 免费/未登录 → 云端按钮屏蔽,
    // 强制本地模型 (强制不持久化——升级 Pro 后恢复云端默认); 服务端仍二次强制 (cloudChat 403)
    const ent = await getEntitlement();
    applyAiEngineAccess(!!(ent && ent.plan === 'pro'));
    if (aiEngine === 'custom') aiSlot = resolveAiSlot();
    aiDialog.classList.add('vt-visible');
    applyAiSize();
    aiDrag.clampOffset();
    aiDrag.applyOffset();
    updateAiConfigVisible();
    renderChat();
    scrollChatBottom();
    aiInput.focus();
  });
  aiSendBtn.addEventListener('click', () => sendChatMessage());
  // Enter 发送 / Shift+Enter 换行 (isComposing: 中文输入法选词回车不误发)
  aiInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChatMessage();
    }
  });
  aiClearBtn.addEventListener('click', () => {
    if (aiRunning) return;
    aiChat = null;
    hideChatError();
    renderChat();
    scrollChatBottom();
    if (translatedPages.length) saveHistoryRecord();
  });
  aiCloseBtn.addEventListener('click', hideAiDialog);

  // ===== 弹窗拖拽 (V1.7.12 → V1.7.59 通用化): 按住标题行拖动移动弹窗 (分享/导出音频/AI 对话共用) =====
  // 位移存内存 (页面会话内保持, 不持久化); 基准 = flex 居中位置, transform 平移; 视口内钳制 (留 8px 边距)
  function makeDialogDraggable(box, handle) {
    const offset = { x: 0, y: 0 };

    function applyOffset() {
      box.style.transform = 'translate(' + offset.x + 'px,' + offset.y + 'px)';
    }

    // 弹窗可见时把位移钳回视口内 (窗口 resize / 重新打开时基准变化后重新钳制)
    function clampOffset() {
      const r = box.getBoundingClientRect();
      if (!r.width && !r.height) return;
      const m = 8;
      const baseLeft = r.left - offset.x;
      const baseTop = r.top - offset.y;
      const baseRight = r.right - offset.x;
      const baseBottom = r.bottom - offset.y;
      offset.x = Math.round(Math.max(m - baseLeft, Math.min(window.innerWidth - m - baseRight, offset.x)));
      offset.y = Math.round(Math.max(m - baseTop, Math.min(window.innerHeight - m - baseBottom, offset.y)));
    }

    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button')) return; // 左键且非按钮区域才拖拽
      const startX = e.clientX;
      const startY = e.clientY;
      const origX = offset.x;
      const origY = offset.y;
      document.body.classList.add('dialog-dragging'); // 拖动中禁文本选区
      const onMove = ev => {
        offset.x = origX + (ev.clientX - startX);
        offset.y = origY + (ev.clientY - startY);
        clampOffset();
        applyOffset();
      };
      const onUp = () => {
        document.body.classList.remove('dialog-dragging');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      e.preventDefault(); // 防拖动触发文本选区/兼容鼠标事件
    });
    window.addEventListener('resize', () => {
      clampOffset();
      applyOffset();
    });
    return { clampOffset, applyOffset };
  }

  const aiTitleRow = document.getElementById('aiTitleRow');
  const aiDlgBox = aiDialog.querySelector('.ai-dialog');
  const aiDrag = makeDialogDraggable(aiDlgBox, aiTitleRow);

  // ===== 弹窗尺寸拖拽 (V1.7.30): 右下角手柄, 宽高存内存 (会话内保持) =====
  const aiResizeHandle = document.getElementById('aiResizeHandle');
  const aiSize = { w: 560, h: 0 }; // h=0 → 高度跟随内容自适应
  const AI_MIN_W = 360;
  const AI_MIN_H = 420;

  function applyAiSize() {
    aiDlgBox.style.width = aiSize.w + 'px';
    aiDlgBox.style.height = aiSize.h > 0 ? aiSize.h + 'px' : '';
  }

  aiResizeHandle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // 不触发标题行拖拽/遮罩关闭
    const r = aiDlgBox.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = r.width;
    const startH = r.height;
    document.body.classList.add('dialog-dragging');
    const onMove = ev => {
      const maxW = Math.max(window.innerWidth - 16, AI_MIN_W);
      const maxH = Math.max(window.innerHeight - 16, AI_MIN_H);
      aiSize.w = Math.round(Math.min(Math.max(startW + (ev.clientX - startX), AI_MIN_W), maxW));
      aiSize.h = Math.round(Math.min(Math.max(startH + (ev.clientY - startY), AI_MIN_H), maxH));
      applyAiSize();
      aiDrag.clampOffset();
      aiDrag.applyOffset();
    };
    const onUp = () => {
      document.body.classList.remove('dialog-dragging');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 在已转义的译文中包裹批注: 命中处包 <mark> + 序号上标, 返回段后注释列表
  // 转义是逐字符替换, 批注原文是译文子串时 escapeHtml(批注原文) 必然是 escapeHtml(译文) 的子串;
  // 多条批注互切重叠时, 与已包裹区间重叠的出现位置跳过, 找不到独立位置的批注放弃
  // counter: {n} 由调用方持有并在整份文件内递增, 保证批注序号全文档唯一且与列表一一对应
  // (此前按"每段内 ranges.length + 1"编号, 多个段落的 sup 都从 1 重数; V1.5.28 修复)
  function annotateEscapedText(escaped, annos, counter) {
    const ranges = [];
    for (const anno of annos) {
      const needle = escapeHtml(anno.text || '');
      if (!needle) continue;
      let from = 0;
      let idx = escaped.indexOf(needle, from);
      while (idx !== -1) {
        const overlap = ranges.some(r => idx < r.end && r.start < idx + needle.length);
        if (!overlap) break;
        from = idx + 1;
        idx = escaped.indexOf(needle, from);
      }
      if (idx === -1) continue;
      ranges.push({ start: idx, end: idx + needle.length, note: anno.note });
    }
    if (!ranges.length) return { html: escaped, notes: [] };
    // 按出现位置排序后再编号, 使序号沿文档顺序递增
    ranges.sort((a, b) => a.start - b.start);
    const notes = [];
    let out = '';
    let pos = 0;
    for (const r of ranges) {
      counter.n += 1;
      out += escaped.slice(pos, r.start)
        + '<mark class="anno" title="' + escapeHtml(r.note) + '">'
        + escaped.slice(r.start, r.end) + '<sup>' + counter.n + '</sup></mark>';
      pos = r.end;
      notes.push({ num: counter.n, note: r.note });
    }
    out += escaped.slice(pos);
    return { html: out, notes: notes };
  }

  // canvas → JPEG dataURL (限宽防超大文件; JPEG 无透明通道, 先铺白底)
  function canvasToJpegDataUrl(canvas, maxW) {
    const scale = Math.min(1, maxW / canvas.width);
    const w = Math.max(1, Math.round(canvas.width * scale));
    const h = Math.max(1, Math.round(canvas.height * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(canvas, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.85);
  }

  // 序列化译文段落: 克隆后处理批注 mark (改类名/挂序号/收集注释), innerHTML 文本由浏览器转义
  function serializeShareParaHtml(para, includeAnnos, pageNotes, counter) {
    const clone = para.cloneNode(true);
    const marks = Array.from(clone.querySelectorAll('mark.vt-anno-mark'));
    for (const m of marks) {
      const anno = annotations.find(a => a.id === m.dataset.annoId);
      if (includeAnnos && anno) {
        counter.n += 1;
        m.className = 'anno';
        m.setAttribute('title', anno.note);
        const sup = document.createElement('sup');
        sup.textContent = String(counter.n);
        m.appendChild(sup);
        pageNotes.push({ num: counter.n, note: anno.note, text: anno.text });
      } else {
        // 不分享批注 (或批注已失效): 解包 mark 只保留文字
        const parent = m.parentNode;
        while (m.firstChild) parent.insertBefore(m.firstChild, m);
        parent.removeChild(m);
        parent.normalize();
      }
    }
    return clone.innerHTML;
  }

  // 从文档翻译页已渲染的左右栏提取页面数据 (与页面显示完全一致):
  // 左=原文位图, 右=译文位图(含盖白)+段落译文定位; 视图未处于已翻译状态时返回 null (调用方回退文本流)
  async function extractSharePages(includeAnnos, raw) {
    const leftPaneEl = docView.querySelector('.split-pane-left');
    const rightPaneEl = docView.querySelector('.split-pane-right');
    if (!leftPaneEl || !rightPaneEl) return null;
    const leftContainers = leftPaneEl.querySelectorAll('.pane-scroll-content .pdf-page-container');
    const rightContainers = rightPaneEl.querySelectorAll('.pane-scroll-content .pdf-page-container');
    if (!leftContainers.length || leftContainers.length !== rightContainers.length) return null;
    const counter = { n: 0 };
    const result = [];
    for (let i = 0; i < rightContainers.length; i++) {
      const leftCanvas = leftContainers[i].querySelector('canvas');
      const rightCanvas = rightContainers[i].querySelector('canvas');
      const overlay = rightContainers[i].querySelector('.translated-overlay');
      if (!leftCanvas || !rightCanvas || !overlay) return null;
      const pageNotes = [];
      const paras = [];
      for (const para of Array.from(overlay.querySelectorAll('.translated-para'))) {
        const cs = getComputedStyle(para);
        const notesBefore = pageNotes.length;
        const paraTop = para.offsetTop;
        const paraHtml = serializeShareParaHtml(para, includeAnnos, pageNotes, counter);
        // 本段命中的批注 (图片模式据此在 canvas 上画高亮与序号)
        const matched = pageNotes.slice(notesBefore);
        // 记下本段落在页面中的纵向位置: 供批注列把卡片对齐到高亮所在行
        for (let k = notesBefore; k < pageNotes.length; k++) pageNotes[k].top = paraTop;
        paras.push({
          left: para.offsetLeft,
          top: paraTop,
          width: para.offsetWidth,
          fontSize: cs.fontSize,
          fontSizePx: parseFloat(cs.fontSize) || 12,
          center: cs.textAlign === 'center',
          err: para.classList.contains('translated-error'),
          html: paraHtml,
          text: plainParaText(para),
          annos: matched
        });
      }
      result.push({
        pageNum: pages[i] ? pages[i].pageNum : i + 1,
        width: overlay.offsetWidth,
        height: overlay.offsetHeight,
        // raw: 图片模式需要原始 canvas (高质量); 文本模式内联 JPEG dataURL 进 HTML
        leftImg: raw ? null : canvasToJpegDataUrl(leftCanvas, 1400),
        rightImg: raw ? null : canvasToJpegDataUrl(rightCanvas, 1400),
        leftCanvas: raw ? leftCanvas : null,
        rightCanvas: raw ? rightCanvas : null,
        paras: paras,
        notes: pageNotes
      });
      // 逐页让出主线程, 避免大文档生成时长时间卡顿
      await new Promise(r => setTimeout(r, 0));
    }
    return result;
  }

  // 段落纯文本 (剔除批注序号上标 <sup>): 供图片模式在 canvas 上绘制
  function plainParaText(el) {
    const clone = el.cloneNode(true);
    for (const sup of clone.querySelectorAll('sup')) sup.remove();
    return clone.textContent || '';
  }

  async function buildShareHtml(mode, includeAnnos) {
    const backendNames = { proxy: '官方引擎', baidu: '百度翻译', volcengine: '火山翻译', tencent: '腾讯翻译', custom: '自定义模型', local: '本地翻译v2' };
    const srcLabel = (srcLang.options[srcLang.selectedIndex] || {}).text || srcLang.value;
    const tgtLabel = (tgtLang.options[tgtLang.selectedIndex] || {}).text || tgtLang.value;
    const bilingual = mode !== 'translated';
    const modeLabel = bilingual ? '双语对照' : '仅译文';
    const annoCount = includeAnnos ? annotations.length : 0;
    // 文本流模式 (兜底分栏 / 仅译文) 的批注序号计数器: 整份文件递增, 避免每段从 1 重数
    const textAnnoCounter = { n: 0 };

    const renderNotes = notes => notes.length
      ? '<div class="anno-notes">' + notes.map(nt =>
          '<div class="anno-note"><span class="anno-num">' + nt.num + '</span>' + escapeHtml(nt.note) + '</div>').join('') + '</div>'
      : '';

    let body = '';
    let useWideMain = false;
    if (bilingual) {
      // 双布局同时输出, 用媒体查询切换 (V1.5.32):
      //   宽屏 → 与文档翻译页一致的"页面图片对照"; 窄屏/手机 → 单栏文字流
      // 分享链接多在手机/微信里打开, 双页并排会被压成一条看不清, 故窄屏自动降级为单栏
      const pageData = await extractSharePages(includeAnnos);
      let wide = '';
      let narrow = '';
      if (pageData) {
        useWideMain = true;
        for (const pg of pageData) {
          // 单页目标宽 ≤ 560px (双页并排 ~1180px, 常见桌面分辨率不换行), 超宽 PDF 等比缩放; A4 (595pt) 轻微缩放
          const scale = Math.min(1, 560 / pg.width);
          const colW = Math.round(pg.width * scale);
          const colH = Math.round(pg.height * scale);
          // pp-col 占缩放后的布局尺寸, 内层 pp-scale 以 transform 缩放原始尺寸页面,
          // 保证译文层的绝对定位坐标/字号在缩放后依然与位图精确对齐
          wide += '<section class="page"><h2>第 ' + pg.pageNum + ' 页</h2><div class="pp-pair">'
            + '<div class="pp-col" style="width:' + colW + 'px;height:' + colH + 'px">'
            + '<div class="pp-scale" style="width:' + pg.width + 'px;height:' + pg.height + 'px;transform:scale(' + scale + ')">'
            + '<div class="pp-page" style="width:' + pg.width + 'px;height:' + pg.height + 'px">'
            + '<img class="pp-img" alt="原文 第' + pg.pageNum + '页" src="' + pg.leftImg + '"></div></div></div>'
            + '<div class="pp-col" style="width:' + colW + 'px;height:' + colH + 'px">'
            + '<div class="pp-scale" style="width:' + pg.width + 'px;height:' + pg.height + 'px;transform:scale(' + scale + ')">'
            + '<div class="pp-page" style="width:' + pg.width + 'px;height:' + pg.height + 'px">'
            + '<img class="pp-img" alt="译文 第' + pg.pageNum + '页" src="' + pg.rightImg + '">'
            + '<div class="pp-overlay" style="width:' + pg.width + 'px;height:' + pg.height + 'px">';
          for (const p of pg.paras) {
            wide += '<div class="tpara' + (p.err ? ' err' : '') + '" style="left:' + p.left + 'px;top:' + p.top + 'px;width:' + p.width + 'px;font-size:' + p.fontSize + (p.center ? ';text-align:center' : '') + '">' + p.html + '</div>';
          }
          // 批注列: 与译文页同排的右列, 每张卡片纵向对齐其高亮所在段落 (段落 top × 缩放);
          // 相邻批注垂直重叠时依次下移 (自包含 HTML 无 JS, 卡片高度按批注文字长度估算)
          let notesCol = '';
          if (pg.notes.length) {
            let lastBottom = -Infinity;
            notesCol = '<div class="pp-notes" style="height:' + colH + 'px">';
            for (const nt of pg.notes) {
              const estH = 16 + Math.ceil(String(nt.note || '').length / 20) * 18;
              const top = Math.max(Math.round((nt.top || 0) * scale), Math.round(lastBottom + 6));
              lastBottom = top + estH;
              notesCol += '<div class="pp-note" style="top:' + top + 'px">'
                + '<span class="anno-num">' + nt.num + '</span>' + escapeHtml(nt.note) + '</div>';
            }
            notesCol += '</div>';
          }
          wide += '</div></div></div></div>' + notesCol + '</div></section>';
        }
      }
      // 单栏文字流: 窄屏布局 (也是视图不可提取时的唯一内容)
      for (const tp of translatedPages) {
        narrow += '<section class="page"><h2>第 ' + tp.pageNum + ' 页</h2>';
        for (let pIdx = 0; pIdx < tp.paragraphs.length; pIdx++) {
          const para = tp.paragraphs[pIdx];
          if (!para.original || !para.original.trim()) continue;
          const translated = para.translated || '';
          const isFailed = translated.startsWith('[翻译失败]');
          const annos = includeAnnos ? annotations.filter(a => a.page === tp.pageNum && a.paraIdx === pIdx) : [];
          const res = annotateEscapedText(escapeHtml(translated), annos, textAnnoCounter);
          narrow += '<div class="para">'
            + '<div class="col"><p class="orig">' + escapeHtml(para.original) + '</p></div>'
            + '<div class="col"><p class="trans' + (isFailed ? ' err' : '') + '">' + res.html + '</p>' + renderNotes(res.notes) + '</div>'
            + '</div>';
        }
        narrow += '</section>';
      }
      body = wide
        ? '<div class="only-wide">' + wide + '</div><div class="only-narrow">' + narrow + '</div>'
        : narrow;
    } else {
      // 仅译文: 连续阅读流, 无分页卡片; 翻译失败段回退原文 (灰色标识), 页间以浅色分隔标注
      body += '<section class="page">';
      let first = true;
      for (const tp of translatedPages) {
        if (!first) body += '<div class="pbreak">第 ' + tp.pageNum + ' 页</div>';
        first = false;
        for (let pIdx = 0; pIdx < tp.paragraphs.length; pIdx++) {
          const para = tp.paragraphs[pIdx];
          if (!para.original || !para.original.trim()) continue;
          const translated = para.translated || '';
          const isFailed = translated.startsWith('[翻译失败]');
          // 失败段回退原文, 其上的批注 (针对失败占位文本) 不再匹配
          const mainText = isFailed ? para.original : translated;
          const annos = includeAnnos && !isFailed ? annotations.filter(a => a.page === tp.pageNum && a.paraIdx === pIdx) : [];
          const res = annotateEscapedText(escapeHtml(mainText), annos, textAnnoCounter);
          body += '<p class="trans-only' + (isFailed ? ' fallback' : '') + '">' + res.html + '</p>';
          body += renderNotes(res.notes);
        }
      }
      body += '</section>';
    }

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(fileName || '文档')} - ${modeLabel}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif; background: #f6f6f6; color: #181818; padding: 24px 16px 48px; }
.main { max-width: 860px; margin: 0 auto; }
.main-wide { max-width: 1520px; }
/* 双布局: 宽屏用页面图片对照, 窄屏/手机用单栏文字 (分享链接多在手机/微信中打开) */
.only-narrow { display: none; max-width: 860px; margin: 0 auto; }
@media (max-width: 900px) {
  .only-wide { display: none; }
  .only-narrow { display: block; }
}
header.doc-header { background: #fff; border-radius: 12px; padding: 20px 24px; margin-bottom: 16px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
header.doc-header h1 { font-size: 18px; margin-bottom: 6px; word-break: break-all; }
header.doc-header .meta { font-size: 12px; color: #999; }
.page { background: #fff; border-radius: 12px; padding: 20px 24px; margin-bottom: 16px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
.page h2 { font-size: 13px; color: #07c160; margin-bottom: 14px; font-weight: 500; }
.para { display: flex; align-items: flex-start; margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px dashed #f0f0f0; }
.para:last-child { border-bottom: none; }
.para .col { flex: 1; min-width: 0; }
.para .col:first-child { padding-right: 14px; border-right: 1px dashed #ececec; }
.para .col:last-child { padding-left: 14px; }
/* 页面图片对照 (与文档翻译页一致): 左原文位图 / 右译文位图+定位译文层;
   pp-col 占缩放后布局尺寸, 内层 pp-scale transform 缩放原始尺寸页面; 始终左右并排, 窄窗口横向滚动 */
.pp-pair { display: flex; gap: 14px; overflow-x: auto; align-items: flex-start; }
.pp-col { flex: none; margin: 0 auto; }
.pp-notes { position: relative; flex: none; width: 260px; }
.pp-note { position: absolute; left: 0; right: 0; background: #fffbe6; border-left: 3px solid #faad14; border-radius: 0 6px 6px 0; padding: 6px 10px; font-size: 12px; line-height: 1.5; color: #614700; word-break: break-word; }
.pp-note .anno-num { display: inline-block; min-width: 16px; font-weight: 600; color: #d48806; }
.pp-scale { transform-origin: top left; }
.pp-page { position: relative; background: #fff; border: 1px solid #ececec; }
.pp-img { display: block; width: 100%; height: 100%; }
.pp-overlay { position: absolute; top: 0; left: 0; overflow: hidden; }
.tpara { position: absolute; color: #181818; word-break: break-word; text-align: justify; line-height: 1.25; cursor: text; }
.tpara.err { color: #e11d48; font-style: italic; }
.orig { font-size: 13px; color: #888; line-height: 1.55; }
.trans { font-size: 15px; color: #181818; line-height: 1.65; }
.trans.err { color: #e11d48; font-style: italic; }
@media (max-width: 640px) {
  .para { flex-direction: column; }
  .para .col:first-child { padding-right: 0; border-right: none; padding-bottom: 4px; }
  .para .col:last-child { padding-left: 0; }
}
.trans-only { font-size: 16px; line-height: 1.9; margin-bottom: 14px; text-align: justify; }
.trans-only.fallback { color: #999; }
.pbreak { text-align: center; font-size: 11px; color: #c8c8c8; margin: 24px 0 16px; }
mark.anno { background: rgba(250, 173, 20, 0.35); color: inherit; padding: 0 1px; border-radius: 2px; }
mark.anno sup { font-size: 10px; color: #d48806; margin-left: 1px; }
.anno-notes { margin: -6px 0 14px; padding: 8px 12px; background: #fffbe6; border-left: 3px solid #faad14; border-radius: 0 6px 6px 0; }
.anno-note { font-size: 13px; color: #614700; line-height: 1.6; }
.anno-num { display: inline-block; min-width: 16px; font-weight: 600; color: #d48806; }
footer.doc-footer { text-align: center; font-size: 11px; color: #b2b2b2; margin-top: 8px; }
</style>
</head>
<body>
<div class="main${useWideMain ? ' main-wide' : ''}">
<header class="doc-header">
<h1>${escapeHtml(fileName || '未命名文档')}</h1>
<div class="meta">${modeLabel} · ${escapeHtml(srcLabel)} → ${escapeHtml(tgtLabel)} · ${escapeHtml(backendNames[config.backend || 'baidu'] || '')}${annoCount ? ' · 含批注 ' + annoCount + ' 条' : ''} · 由小T翻译生成</div>
</header>
${body}
<footer class="doc-footer">本文件由小T翻译生成，仅供个人学习使用，请勿公开传播</footer>
</div>
</body>
</html>`;
  }

  // 触发浏览器下载 (blob/dataURL 通用)
  function triggerDownload(url, name) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function downloadShareHtml(mode, includeAnnos) {
    const bilingual = mode !== 'translated';
    const html = await buildShareHtml(mode, includeAnnos);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, (fileName ? fileName.replace(/\.pdf$/i, '') : 'document') + (bilingual ? '-双语对照.html' : '-译文.html'));
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  // ===== 分享图片 (长图): 把译文文字烘焙进位图, 可直接发微信 (V1.5.29) =====
  const SHARE_FONT = "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  const IMG_MAX_WIDTH = 1600;    // 单张图片最大宽度 (按布局尺寸衡量, 超宽等比缩放)
  const IMG_EXPORT_SCALE = 2;    // 图片导出超采样倍数: 合成画布按 2 倍光栅化, 文字锐利、位图 1:1 拷贝, 高分屏/手机查看不糊
  const IMG_MAX_HEIGHT = 20000;  // 单张图片最大高度 (超出按页拆成多张)
  const IMG_GAP = 16;            // 页间距
  const IMG_NOTES_W = 260;       // 批注列宽度

  // 分词: 连续拉丁字母/数字视作一个词(不拆词), 空白合并, 其余(含 CJK/标点)逐字
  function tokenizeForCanvas(text) {
    const tokens = [];
    const re = /[A-Za-z0-9]+(?:[.'’\-][A-Za-z0-9]+)*|\s+|[^\sA-Za-z0-9]/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      tokens.push({ str: m[0], start: m.index, end: m.index + m[0].length });
    }
    return tokens;
  }

  // 在给定宽度内逐行排版 token (行尾空白裁掉), 返回 [{items:[{str,w,start,end}], width}]
  function layoutCanvasLines(ctx, text, maxWidth) {
    const tokens = tokenizeForCanvas(text);
    const spaceW = ctx.measureText(' ').width;
    const lines = [];
    let items = [];
    let w = 0;
    const flush = () => {
      while (items.length && /^\s+$/.test(items[items.length - 1].str)) {
        w -= items[items.length - 1].w;
        items.pop();
      }
      if (items.length) lines.push({ items: items, width: w });
      items = [];
      w = 0;
    };
    for (const tk of tokens) {
      const isSpace = /^\s+$/.test(tk.str);
      if (!items.length && isSpace) continue; // 行首空白丢弃
      const tw = isSpace ? spaceW : ctx.measureText(tk.str).width;
      if (items.length && w + tw > maxWidth) {
        flush();
        if (isSpace) continue;
      }
      items.push({ str: tk.str, w: tw, start: tk.start, end: tk.end });
      w += tw;
    }
    flush();
    return lines;
  }

  // 段落内批注高亮区间: 在纯文本上定位每条批注的文本 (跳过与已选区间的重叠)
  function annotationRanges(para) {
    const ranges = [];
    for (const a of (para.annos || [])) {
      const needle = a.text || '';
      if (!needle) continue;
      let from = 0;
      let idx = para.text.indexOf(needle, from);
      while (idx !== -1) {
        if (!ranges.some(r => idx < r.end && r.start < idx + needle.length)) break;
        from = idx + 1;
        idx = para.text.indexOf(needle, from);
      }
      if (idx === -1) continue;
      ranges.push({ start: idx, end: idx + needle.length, num: a.num });
    }
    return ranges.sort((x, y) => x.start - y.start);
  }

  // 绘制单个段落: 逐 token 绘制, 支持左对齐/居中/两端对齐; 批注 token 先铺黄底, 区间末尾补序号上标
  function drawParagraph(ctx, para, hlRanges) {
    const fs = para.fontSizePx || 12;
    const lh = fs * 1.25;
    ctx.font = fs + 'px ' + SHARE_FONT;
    ctx.textBaseline = 'top';
    const lines = layoutCanvasLines(ctx, para.text, para.width);
    const centered = !!para.center;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const isLast = li === lines.length - 1;
      // 两端对齐: 末行不拉伸; 居中使用 center
      const extra = (!centered && !isLast && line.items.length > 1)
        ? Math.max(0, (para.width - line.width) / (line.items.length - 1))
        : 0;
      let cx = para.left + (centered ? Math.max(0, (para.width - line.width) / 2) : 0);
      const cy = para.top + li * lh;
      for (const it of line.items) {
        for (const r of hlRanges) {
          if (r.start < it.end && r.end > it.start) {
            ctx.fillStyle = 'rgba(250, 173, 20, 0.35)';
            ctx.fillRect(cx - 1, cy, it.w + extra + 2, lh);
          }
        }
        ctx.fillStyle = para.err ? '#e11d48' : '#181818';
        ctx.fillText(it.str, cx, cy);
        for (const r of hlRanges) {
          if (r.end > it.start && r.end <= it.end) {
            ctx.font = Math.max(8, Math.round(fs * 0.62)) + 'px ' + SHARE_FONT;
            ctx.fillStyle = '#d48806';
            ctx.fillText(String(r.num), cx + it.w + extra + 1, cy - 1);
            ctx.font = fs + 'px ' + SHARE_FONT;
          }
        }
        cx += it.w + extra;
      }
    }
  }

  // 绘制批注列 (译文页右侧): 卡片顶边对齐其高亮段落, 相邻重叠依次下移
  function drawNoteCards(ctx, notes, x, y0, width) {
    ctx.textBaseline = 'top';
    let lastBottom = 0;
    for (const nt of notes) {
      ctx.font = '12px ' + SHARE_FONT;
      const lines = layoutCanvasLines(ctx, nt.num + '. ' + String(nt.note || ''), width - 22);
      const h = Math.max(30, lines.length * 18 + 14);
      const top = Math.max(Math.round(nt.top || 0), Math.round(lastBottom + 6));
      ctx.fillStyle = '#fffbe6';
      ctx.fillRect(x, y0 + top, width, h);
      ctx.fillStyle = '#faad14';
      ctx.fillRect(x, y0 + top, 3, h);
      ctx.fillStyle = '#614700';
      let cy = y0 + top + 7;
      for (const line of lines) {
        let lx = x + 10;
        for (const it of line.items) { ctx.fillText(it.str, lx, cy); lx += it.w; }
        cy += 18;
      }
      lastBottom = top + h;
    }
  }

  // 逐页合成图片 canvas: 双语对照 = 原文页 + 译文页并排; 仅译文 = 仅译文页; 可选批注列
  // 返回 [{canvas, pageNum}] (原始像素尺寸, 未缩放)
  async function buildShareImages(mode, includeAnnos) {
    const bilingual = mode !== 'translated';
    const pageData = await extractSharePages(includeAnnos, true);
    if (!pageData) return null;
    const PAD = 20;
    const LABEL_H = 26;
    const canvases = [];
    for (const pg of pageData) {
      const pw = pg.width;
      const ph = pg.height;
      const hasNotes = includeAnnos && pg.notes.length > 0;
      const innerW = (bilingual ? pw * 2 + IMG_GAP : pw) + (hasNotes ? IMG_GAP + IMG_NOTES_W : 0);
      const w = innerW + PAD * 2;
      const h = ph + LABEL_H + PAD * 2;
      const c = document.createElement('canvas');
      // 物理尺寸 = 布局尺寸 × IMG_EXPORT_SCALE, ctx 统一缩放后绘制代码全部保持 CSS 坐标;
        // 文字按超采样倍数光栅化 (锐利), 源页位图 (设备像素比/像素预算倍) 在 2x 下可 1:1 拷贝不再被压到 1x
      c.width = w * IMG_EXPORT_SCALE;
      c.height = h * IMG_EXPORT_SCALE;
      const ctx = c.getContext('2d');
      ctx.scale(IMG_EXPORT_SCALE, IMG_EXPORT_SCALE);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      // 页标签
      ctx.fillStyle = '#8a8a8a';
      ctx.font = '13px ' + SHARE_FONT;
      ctx.textBaseline = 'top';
      ctx.fillText('第 ' + pg.pageNum + ' 页' + (bilingual ? '（左：原文 / 右：译文）' : ''), PAD, PAD);
      const pageY = PAD + LABEL_H;
      let x = PAD;
      if (bilingual) {
        ctx.drawImage(pg.leftCanvas, x, pageY, pw, ph);
        ctx.strokeStyle = '#e6e6e6';
        ctx.strokeRect(x + 0.5, pageY + 0.5, pw, ph);
        x += pw + IMG_GAP;
      }
      // 译文页位图 + 文字烘焙 (裁剪在页面内, 防止个别段落溢出)
      ctx.drawImage(pg.rightCanvas, x, pageY, pw, ph);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, pageY, pw, ph);
      ctx.clip();
      ctx.translate(x, pageY);
      for (const para of pg.paras) {
        if (!para.text) continue;
        drawParagraph(ctx, para, annotationRanges(para));
      }
      ctx.restore();
      ctx.strokeStyle = '#e6e6e6';
      ctx.strokeRect(x + 0.5, pageY + 0.5, pw, ph);
      x += pw;
      if (hasNotes) drawNoteCards(ctx, pg.notes, x + IMG_GAP, pageY, IMG_NOTES_W);
      canvases.push({ canvas: c, pageNum: pg.pageNum });
      // 逐页让出主线程
      await new Promise(r => setTimeout(r, 0));
    }
    return canvases;
  }

  function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(b => { if (b) resolve(b); else reject(new Error('导出图片失败')); }, 'image/png');
    });
  }

  async function downloadShareImages(mode, includeAnnos) {
    const canvases = await buildShareImages(mode, includeAnnos);
    if (!canvases || !canvases.length) {
      throw new Error('无法生成图片：请先完成翻译并保持在译文视图（可点「重新翻译」后再生成）');
    }
    const bilingual = mode !== 'translated';
    const maxW = canvases.reduce((m, c) => Math.max(m, c.canvas.width), 0);
    // 宽度上限按布局(CSS)尺寸衡量: 页面 canvas 已按 IMG_EXPORT_SCALE 超采样, 输出物理宽度为其 2 倍
    const scale = Math.min(1, IMG_MAX_WIDTH / (maxW / IMG_EXPORT_SCALE));
    const HEADER = 66;
    // 高度分组: 单张图片布局高度不超过 IMG_MAX_HEIGHT (与超采样前行为一致)
    const groups = [];
    let cur = [];
    let curH = 0;
    for (const c of canvases) {
      const h = Math.round(c.canvas.height * scale / IMG_EXPORT_SCALE) + IMG_GAP;
      if (cur.length && curH + h + HEADER > IMG_MAX_HEIGHT) {
        groups.push(cur);
        cur = [];
        curH = 0;
      }
      cur.push(c);
      curH += h;
    }
    if (cur.length) groups.push(cur);

    const srcLabel = (srcLang.options[srcLang.selectedIndex] || {}).text || srcLang.value;
    const tgtLabel = (tgtLang.options[tgtLang.selectedIndex] || {}).text || tgtLang.value;
    const baseName = (fileName ? fileName.replace(/\.pdf$/i, '') : 'document') + (bilingual ? '-双语对照' : '-译文');

    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const W = Math.round(g.reduce((m, c) => Math.max(m, c.canvas.width), 0) * scale / IMG_EXPORT_SCALE);
      const contentH = g.reduce((s, c) => s + Math.round(c.canvas.height * scale / IMG_EXPORT_SCALE) + IMG_GAP, 0);
      const H = HEADER + contentH;
      const out = document.createElement('canvas');
      // 输出画布同样超采样: 头部文字锐利, 页面 canvas 经缩放变换 1:1 拷贝 (目标设备像素 = 源物理尺寸)
      out.width = W * IMG_EXPORT_SCALE;
      out.height = H * IMG_EXPORT_SCALE;
      const ctx = out.getContext('2d');
      ctx.scale(IMG_EXPORT_SCALE, IMG_EXPORT_SCALE);
      ctx.fillStyle = '#f6f6f6';
      ctx.fillRect(0, 0, W, H);
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#181818';
      ctx.font = '600 16px ' + SHARE_FONT;
      ctx.fillText(fileName || '未命名文档', 20, 16);
      ctx.fillStyle = '#999999';
      ctx.font = '12px ' + SHARE_FONT;
      ctx.fillText(
        (bilingual ? '双语对照' : '仅译文') + ' · ' + srcLabel + ' → ' + tgtLabel + ' · 由小T翻译生成'
        + (includeAnnos && annotations.length ? ' · 含批注 ' + annotations.length + ' 条' : '')
        + (groups.length > 1 ? ' · (' + (gi + 1) + '/' + groups.length + ')' : ''),
        20, 38
      );
      let y = HEADER;
      for (const c of g) {
        const w = Math.round(c.canvas.width * scale / IMG_EXPORT_SCALE);
        const h = Math.round(c.canvas.height * scale / IMG_EXPORT_SCALE);
        ctx.drawImage(c.canvas, 0, 0, c.canvas.width, c.canvas.height, Math.round((W - w) / 2), y, w, h);
        y += h + IMG_GAP;
      }
      const blob = await canvasToPngBlob(out);
      const url = URL.createObjectURL(blob);
      triggerDownload(url, baseName + (groups.length > 1 ? '-第' + (gi + 1) + '张' : '') + '.png');
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      await new Promise(r => setTimeout(r, 0));
    }
    // 多张图片时给出提示 (Chrome 首次会询问是否允许下载多个文件)
    if (groups.length > 1) console.log('[DocTranslate] 分享图片已拆分为 ' + groups.length + ' 张 (单张高度上限 ' + IMG_MAX_HEIGHT + 'px)');
  }

  // ===== 翻译 =====
  // V1.7.2: 按钮复用——空闲时点击开始翻译; 翻译中点击 = 请求随时取消
  translateBtn.addEventListener('click', () => {
    if (isTranslating) {
      cancelTranslateRequested = true;
      translateBtn.textContent = '正在取消...';
      return;
    }
    startTranslate();
  });

  async function startTranslate() {
    if (isTranslating || !pages.length) return;
    isTranslating = true;
    cancelTranslateRequested = false;
    // V1.7.2: 翻译中按钮保持可点, 复用为「取消翻译」入口 (随时取消, 已译部分保留)
    translateBtn.disabled = false;
    translateBtn.textContent = '取消翻译';
    showProgress();
    updateProgress(0, '正在翻译（可点击「取消翻译」随时停止）...');

    await loadConfig();

    const sourceLang = srcLang.value;
    const targetLang = tgtLang.value;
    const backend = config.backend || 'baidu';

    const invalid = validateBackendConfig(backend, config);
    if (invalid) {
      alert(invalid + '。\n\n点击插件图标 → 选择引擎 → 填写配置');
      isTranslating = false;
      translateBtn.disabled = false;
      // 已有译文时保留「重新翻译」文案, 不因校验失败退回「开始翻译」
      translateBtn.textContent = translatedPages.length ? '重新翻译' : '开始翻译';
      hideProgress();
      return;
    }

    // V1.7.1: 官方引擎 Pro 预检——非 Pro 不进入翻译流程 (此前每段完整走一次服务端 403,
    // 数百段文档 × 每段约 1s, 失败等待数分钟且页面锁死在"翻译中"无法返回)。
    // getEntitlement 带 10 分钟缓存, 判定滞后可接受; 服务端仍是最终强制者。
    if (backend === 'proxy') {
      const ent = await getEntitlement();
      if (!ent || ent.plan !== 'pro') {
        alert('官方引擎为 Pro 专享功能：当前账户未登录或未开通 Pro。\n\n可改用其他引擎（百度/火山/腾讯/自定义模型），或点击插件图标在底部「账户」中登录并开通 Pro 后使用。');
        isTranslating = false;
        translateBtn.disabled = false;
        translateBtn.textContent = translatedPages.length ? '重新翻译' : '开始翻译';
        hideProgress();
        return;
      }
    }

    console.log('[DocTranslate] 翻译配置:', { backend, sourceLang, targetLang });

    translatedPages = [];
    // 重新翻译后译文文字全部更新, 旧批注引用的译文片段失效, 一并清空
    annotations = [];
    updateAnnoRail();
    translateStats = { localChars: 0, cloudChars: 0, freshChars: 0 };
    // V1.7.26: 统计本次翻译耗时 (从点击开始到全部段落处理完, 含缓存命中与请求等待)
    const translateStartAt = Date.now();
    translateTimeEl.textContent = '';
    stopTts(); // V1.7.33: 开始新翻译前停止朗读旧译文
    const total = pages.length;
    let failCount = 0;
    let successCount = 0;
    let localHitCount = 0;
    let cloudHitCount = 0;
    let bodyStarted = false;

    // 翻译一个文本单元: 先查缓存链(custom 只查本地), 未命中调用引擎, 成功后写入缓存
    // 缓存键的引擎段对 custom 含端点+模型名 (V1.5.50): 槽位间互不串, 切换模型即全新翻译
    // V1.7.65: 行内公式保护——送译前把行内数学片段替换为 [[n]] 占位符, 返回后原位还原。
    // 整段公式已在上面按 looksLikeFormula 整段跳过; 这里覆盖「正文里夹公式」的段落。
    async function translateRaw(text) {
      const { masked, items } = maskInlineMath(text);
      if (!items.length) return translateText(text, sourceLang, targetLang, backend, config);
      const out = await translateText(masked, sourceLang, targetLang, backend, config);
      return restoreInlineMath(out, items);
    }

    async function translateUnit(text) {
      const cacheBackend = cacheBackendId(backend, config);
      const cr = await cacheGetEx(cacheBackend, sourceLang, targetLang, text).catch(e => {
        console.warn('[DocTranslate] 缓存读取失败:', e);
        return { translated: null, hit: null };
      });
      if (cr.translated !== null && cr.translated !== '') {
        if (cr.hit === 'cloud') translateStats.cloudChars += text.length;
        else translateStats.localChars += text.length;
        return { text: cr.translated, cached: true, hit: cr.hit };
      }
      const result = await translateRaw(text);
      await cacheSet(cacheBackend, sourceLang, targetLang, text, result).catch(e => {
        console.warn('[DocTranslate] 缓存写入失败:', e);
      });
      translateStats.freshChars += text.length;
      return { text: result, cached: false, hit: null };
    }

    try {
      // 先以译文模式重建视图 (右栏位图页就位但尚无译文层), 之后每译完一页增量叠加, 逐页可见
      // (V1.5.55: 与主循环同入 try —— 此前在 try 外, renderPdfPages 抛错会让 isTranslating
      //  永远为 true, 「开始翻译」按钮锁死在"翻译中...")
      updateProgress(0, '正在准备译文视图...');
      await renderPdfPages(true);
      updateProgress(0, '正在翻译...');

      // V1.7.76: 跨页全局批次池——不再按页分批 (页数少时"首页单独 + N 页一波"浪费并行),
      // 整篇未命中段落统一排队, 由 concurrencyForEngine 喂满并发; 每页待译段清零即渲染该页。
      // ① 逐页判定 + 查缓存 (顺序遍历: 首页作者名判定依赖 bodyStarted 的先后语义)
      const prepared = [];
      const reqBytes = maxRequestBytes(backend, config);
      const cacheBackend = cacheBackendId(backend, config);
      let pagesDone = 0;

      const flushPage = (p) => {
        if (p.flushed) return;
        p.flushed = true;
        translatedPages.push({ pageNum: p.page.pageNum, paragraphs: p.slotOut.filter(x => x) });
        updateTranslatedPage(p.page.pageNum);
        pagesDone++;
        updateProgress((pagesDone / total) * 100, `正在翻译 ${Math.min(pagesDone, total)}/${total} 页...`);
      };

      for (const page of pages) {
        if (cancelTranslateRequested) break;
        const slotOut = new Array(page.paragraphs.length);
        const pendingIdx = []; // 缓存未命中、待批量翻译的段落下标
        // 表格段落集合 (V1.7.67): 表格内文字固定不翻译, 保持原图渲染
        const tableSet = detectTableParagraphIdx(page);

        // 逐段判定: 保留原文的直接回填; 可译段落先查缓存, 未命中进入待批队列
        for (let pi = 0; pi < page.paragraphs.length; pi++) {
          const para = page.paragraphs[pi];
          if (cancelTranslateRequested) break;
          if (!para.original.trim()) {
            slotOut[pi] = { original: para.original, translated: '', lineStart: para.lineStart, lineEnd: para.lineEnd };
            continue;
          }

          // 首页正文开始前的作者姓名保持原文不翻译(音译可能不准)
          if (page.pageNum === 1 && !bodyStarted && looksLikeAuthorNames(para.original)) {
            console.log('[DocTranslate] 保留作者姓名原文:', para.original.substring(0, 60));
            slotOut[pi] = { original: para.original, translated: para.original, lineStart: para.lineStart, lineEnd: para.lineEnd };
            continue;
          }
          if (para.original.length > 200) bodyStarted = true;

          // 公式段落保持原文不翻译 (翻译引擎会破坏数学表达结构)
          if (looksLikeFormula(para.original)) {
            console.log('[DocTranslate] 保留公式原文:', para.original.substring(0, 60));
            slotOut[pi] = { original: para.original, translated: para.original, lineStart: para.lineStart, lineEnd: para.lineEnd };
            continue;
          }

          // 表格段落: 固定不翻译, 整表保持原样渲染 (V1.7.70)
          if (tableSet.has(pi)) {
            slotOut[pi] = { original: para.original, translated: para.original, lineStart: para.lineStart, lineEnd: para.lineEnd };
            continue;
          }

          // 图形区域 (图片/图表/示意图) 内的文字保持原文: 轴标签/图例等译文会破坏图文对应
          const rpe = rightPageEls.get(page.pageNum);
          const gbox = rpe ? getParagraphBox(page.lines, para.lineStart, para.lineEnd, rpe.cssViewport.transform) : null;
          if (isCoveredByGraphicRegion(page.graphicRegions, gbox, rpe ? rpe.cssViewport.scale : 1)) {
            slotOut[pi] = { original: para.original, translated: para.original, lineStart: para.lineStart, lineEnd: para.lineEnd };
            continue;
          }

          // 缓存命中直接回填; 未命中 → 待批
          const cr = await cacheGetEx(cacheBackend, sourceLang, targetLang, para.original).catch(e => {
            console.warn('[DocTranslate] 缓存读取失败:', e);
            return { translated: null, hit: null };
          });
          if (cr.translated !== null && cr.translated !== '') {
            if (cr.hit === 'cloud') {
              cloudHitCount++;
              translateStats.cloudChars += para.original.length;
            } else {
              localHitCount++;
              translateStats.localChars += para.original.length;
            }
            slotOut[pi] = { original: para.original, translated: cr.translated, lineStart: para.lineStart, lineEnd: para.lineEnd };
            continue;
          }
          pendingIdx.push(pi);
        }

        const p = { page, slotOut, pendingIdx, remaining: pendingIdx.length, flushed: false };
        prepared.push(p);
        if (!p.remaining) flushPage(p); // 全部命中缓存/保留原文 → 该页立即可见
      }

      // ② 全局任务池: 超长段落单独成 job (内部再切块), 其余按字节合批
      const jobs = [];
      prepared.forEach((p, pageIdx) => {
        const normals = [];
        for (const pi of p.pendingIdx) {
          if (utf8Len(p.page.paragraphs[pi].original) > reqBytes) jobs.push({ pageIdx, idxs: [pi], long: true });
          else normals.push(pi);
        }
        if (normals.length) {
          const groups = groupParagraphBatches(normals.map(pi => p.page.paragraphs[pi].original), reqBytes);
          for (const g of groups) jobs.push({ pageIdx, idxs: g.map(k => normals[k]), long: false });
        }
      });

      // ③ 并发执行: 批次失败回退逐段; 每段完成时递减页面计数, 清零即渲染
      await runWithConcurrency(jobs, concurrencyForEngine(backend), async (job) => {
        if (cancelTranslateRequested) return;
        const p = prepared[job.pageIdx];
        const page = p.page;
        const idxs = job.idxs;
        let batchDone = false;

        if (!job.long && idxs.length > 1) {
          try {
            const joined = idxs.map(pi => page.paragraphs[pi].original).join('\n\n');
            const res = await translateRaw(joined);
            const parts = splitBatchTranslation(res, idxs.length);
            if (parts) {
              for (let k = 0; k < idxs.length; k++) {
                const pi = idxs[k];
                const para = page.paragraphs[pi];
                p.slotOut[pi] = { original: para.original, translated: parts[k], lineStart: para.lineStart, lineEnd: para.lineEnd };
                await cacheSet(cacheBackend, sourceLang, targetLang, para.original, parts[k]).catch(e => {
                  console.warn('[DocTranslate] 缓存写入失败:', e);
                });
                translateStats.freshChars += para.original.length;
                successCount++;
              }
              batchDone = true;
            }
          } catch (e) {
            console.warn('[DocTranslate] 批量翻译失败, 回退逐段:', e.message);
          }
        }

        if (!batchDone) {
          for (const pi of idxs) {
            if (cancelTranslateRequested) break;
            const para = page.paragraphs[pi];
            if (utf8Len(para.original) > reqBytes) {
              // 超长段落分块翻译, 每块独立走缓存
              const chunks = splitText(para.original, reqBytes);
              let result = '';
              for (const chunk of chunks) {
                if (cancelTranslateRequested) break;
                try {
                  const r = await translateUnit(chunk);
                  result += (result ? ' ' : '') + r.text;
                  if (r.hit === 'cloud') cloudHitCount++;
                  else if (r.cached) localHitCount++;
                  else successCount++;
                } catch (e) {
                  console.warn('[DocTranslate] 翻译失败:', e.message);
                  result += (result ? ' ' : '') + chunk;
                  failCount++;
                }
              }
              p.slotOut[pi] = { original: para.original, translated: result || para.original, lineStart: para.lineStart, lineEnd: para.lineEnd };
            } else {
              try {
                const r = await translateUnit(para.original);
                if (r.hit === 'cloud') {
                  cloudHitCount++;
                } else if (r.cached) {
                  localHitCount++;
                } else {
                  successCount++;
                }
                p.slotOut[pi] = { original: para.original, translated: r.text || para.original, lineStart: para.lineStart, lineEnd: para.lineEnd };
              } catch (e) {
                console.warn('[DocTranslate] 翻译失败:', e.message, '| 原文:', para.original.substring(0, 60));
                p.slotOut[pi] = { original: para.original, translated: '[翻译失败] ' + e.message, lineStart: para.lineStart, lineEnd: para.lineEnd };
                failCount++;
              }
            }
          }
        }

        p.remaining -= idxs.length;
        if (p.remaining <= 0 && !cancelTranslateRequested) flushPage(p);
      });

      // 取消或残留: 已译部分照常渲染
      for (const p of prepared) flushPage(p);
      translatedPages.sort((a, b) => a.pageNum - b.pageNum);


      // 译文层已随每页翻译完成增量渲染, 无需整体重渲染
      // 直接翻译路径不经过 showDocView, 需单独显示分享按钮
      shareBtn.style.display = 'inline-flex';
      ttsBtn.style.display = 'inline-flex';
      ttsExportBtn.style.display = 'inline-flex';
      layoutAnnoCards();
      await saveHistoryRecord();

      // V1.7.26: 耗时与平均吞吐 (字符 = 本次处理的所有段落字符数, 含缓存命中; 单位 s 与 字/秒)
      const elapsedSec = Math.max((Date.now() - translateStartAt) / 1000, 0.1);
      const doneChars = translateStats.freshChars + translateStats.localChars + translateStats.cloudChars;
      const charsPerSec = Math.round(doneChars / elapsedSec);
      const timeText = `用时 ${elapsedSec.toFixed(1)}s · 平均 ${charsPerSec.toLocaleString('zh-CN')} 字/秒`;
      translateTimeEl.textContent = timeText;

      if (cancelTranslateRequested) {
        // V1.7.2: 已取消——已译页面/段落保留且已落历史, 提示完成进度
        const donePages = translatedPages.filter(p => p.paragraphs.length).length;
        alert(`已取消翻译：完成 ${donePages}/${total} 页（成功 ${successCount} 段，失败 ${failCount} 段）。\n${timeText}。\n已译内容已保留并保存到历史记录，点击「重新翻译」可重新完整翻译。`);
      } else if (failCount > 0) {
        // V1.7.4: BYOK 引擎有失败段且非 Pro → 弹窗尾部附官方引擎轻推荐 (getEntitlement 永不抛错, 防御仍留)
        let proTip = '';
        if (backend !== 'proxy') {
          try {
            const ent = await getEntitlement();
            if (!ent || ent.plan !== 'pro') proTip = PRO_UPSELL_TIP;
          } catch(_) {}
        }
        alert(`翻译完成，成功 ${successCount} 段（本地缓存 ${localHitCount} 段、云端缓存 ${cloudHitCount} 段），失败 ${failCount} 段。\n${timeText}。\n失败段落会显示红色提示，请检查网络或翻译配置。` + proTip);
      } else if (localHitCount > 0 || cloudHitCount > 0) {
        console.log(`[DocTranslate] 翻译完成, 成功 ${successCount} 段, 本地缓存 ${localHitCount} 段, 云端缓存 ${cloudHitCount} 段, ${timeText}`);
      }
    } catch(e) {
      console.error('[DocTranslate] 翻译出错:', e);
      alert('翻译出错: ' + e.message);
      // 中途出错但已有整页译文: 保留分享入口并落历史, 不让已完成页面作废 (V1.5.55)
      if (translatedPages.length) {
      shareBtn.style.display = 'inline-flex';
      ttsBtn.style.display = 'inline-flex';
      ttsExportBtn.style.display = 'inline-flex';
        await saveHistoryRecord().catch(() => {});
      }
    }

    isTranslating = false;
    translateBtn.disabled = false;
    translateBtn.textContent = '重新翻译';
    hideProgress();
  }

  const AFFILIATION_KEYWORDS = [
    'university', 'institute', 'department', 'school', 'college', 'laboratory',
    'academy', 'center', 'centre', 'research', 'abstract', 'keyword', 'introduction',
    'corresponding'
  ];

  // 识别作者姓名行: 首页正文前, 由逗号/·等分隔的短词条组成
  function looksLikeAuthorNames(text) {
    const t = text.trim();
    if (t.length < 3 || t.length > 200) return false;
    const lower = t.toLowerCase();
    for (const kw of AFFILIATION_KEYWORDS) {
      if (lower.includes(kw)) return false;
    }
    // 去掉邮箱/上标标记后按分隔符拆出候选姓名
    const cleaned = t.replace(/[\w.+-]+@[\w.-]+/g, ' ');
    const tokens = cleaned.split(/[,;·•&]|\band\b/gi)
      .map(s => s.replace(/[†*✉()（）\[\]\d]/g, ' ').trim())
      .filter(Boolean);
    if (!tokens.length) return false;
    for (const tok of tokens) {
      if (/^[\u4e00-\u9fff]{2,4}$/.test(tok)) continue; // 中文姓名
      const words = tok.split(/\s+/).filter(Boolean);
      if (words.length === 0 || words.length > 4) return false;
      for (const w of words) {
        if (!/^[A-Z][A-Za-z'’.\-]*$/.test(w)) return false;
      }
    }
    // 无分隔符时要求带数字/符号上标才认定, 避免误判标题
    return tokens.length > 1 || /[†✉*]|\d/.test(t);
  }

  // 识别公式段落: 数学符号密度高、或关系运算符连接且几乎无自然语言单词的表达式
  // 此类文本送翻译引擎会被破坏结构 (变量音译/符号丢失), 保持原文
  function looksLikeFormula(text) {
    const t = String(text).trim();
    const compact = t.replace(/\s+/g, '');
    if (compact.length < 2 || compact.length > 400) return false;
    // 中文段落不可能是公式 (公式是语言无关的符号序列)
    const cjk = compact.match(/[\u4e00-\u9fff]/g);
    if (cjk && cjk.length / compact.length > 0.2) return false;
    const symbols = compact.match(/[α-ωΑ-Ω∑∫√∞±∓×÷⋅≈≤≥≠∝∈∉⊂⊃⊆⊇∪∩∇∂⊕⊗⊥∥≡≅∀∃→↔]/g);
    // 希腊字母/数学符号密度高 → 公式 (如 "∇·E=ρ/ε0")
    if (symbols && symbols.length / compact.length >= 0.1) return true;
    // 单词必须在原始文本上数: 压缩空白后相邻单词会粘连成一个大词, 导致正常句子误判;
    // 全大写短 token (QKT/CNN 等) 多为变量缩写, 不计为单词
    const words = (t.match(/[A-Za-z]{3,}/g) || []).filter(w => !/^[A-Z]{2,4}$/.test(w));
    // 关系运算符连接且几乎没有自然语言单词 (如 "F(x) = 3x2 + 2x + 1" / "y→∞")
    if (/[=≈≤≥≠→↔]/.test(compact) && words.length <= 2) return true;
    // 公式残片: 完全没有自然语言单词, 但含结构性字符 (运算符/数字/括号/数学符号),
    // 如分数排版被切段后的 ")V" / "Q, K, V" / "(1)" 编号
    const structural = /[\d+\-*/^(),;\[\]{}]/.test(compact) || !!(symbols && symbols.length);
    if (!words.length && structural) return true;
    // 无字母且由运算符连接数字 (如 "(a+b)2=a2+2ab+b2" 提取后残留的纯符号式)
    const letters = compact.replace(/[^A-Za-z]/g, '').length;
    const operators = (compact.match(/[+\-*/^()]/g) || []).length;
    if (!letters && operators >= 2) return true;
    return false;
  }

  // 按字节上限切分: 先按行边界, 单行超限再按句子边界, 超长单句按字符(码点)硬切
  // maxBytes 来自 maxRequestBytes(backend) —— 分块长度与引擎绑定
  function splitText(text, maxBytes) {
    const chunks = [];
    const lines = text.split('\n');
    let current = '';

    for (const line of lines) {
      if (current && utf8Len(current + '\n' + line) > maxBytes) {
        chunks.push(current);
        current = line;
      } else {
        current = current ? current + '\n' + line : line;
      }
    }
    if (current) chunks.push(current);

    const final = [];
    for (const chunk of chunks) {
      if (utf8Len(chunk) <= maxBytes) { final.push(chunk); continue; }
      // 单行超长: 按句子边界二次切分
      const sentences = chunk.split(/(?<=[.!?;。！？；])\s+/);
      let cur = '';
      for (const s of sentences) {
        if (utf8Len(s) > maxBytes) {
          // 超长单句按码点硬切 (不拆代理对), 逐字累加字节数
          if (cur) { final.push(cur); cur = ''; }
          let piece = '';
          let pieceBytes = 0;
          for (const ch of Array.from(s)) {
            const b = utf8Len(ch);
            if (pieceBytes + b > maxBytes) { final.push(piece); piece = ch; pieceBytes = b; }
            else { piece += ch; pieceBytes += b; }
          }
          if (piece) final.push(piece);
          continue;
        }
        if (cur && utf8Len(cur + ' ' + s) > maxBytes) { final.push(cur); cur = s; }
        else { cur = cur ? cur + ' ' + s : s; }
      }
      if (cur) final.push(cur);
    }
    return final;
  }

  // ===== 划词翻译: 原文面板选中文本 → "译"浮标 → 点击弹窗翻译 =====
  // 不需要先点"开始翻译", 原文渲染完成后即可选中即译
  const SEL_BTN_ID = 'vt-sel-btn';
  const SEL_POPUP_ID = 'vt-sel-popup';
  let selPendingText = '';
  // Alt+T 快捷键翻译弹窗为固定定位模式: 固定在视口右上角, 不随滚动关闭
  let selPopupPinned = false;

  function createSelBtn() {
    let btn = document.getElementById(SEL_BTN_ID);
    if (btn) return btn;
    btn = document.createElement('div');
    btn.id = SEL_BTN_ID;
    btn.className = 'vt-sel-btn';
    btn.textContent = '译';
    btn.title = '翻译选中文字';
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (selPendingText) showSelPopup(selPendingText);
    });
    document.body.appendChild(btn);
    return btn;
  }

  function hideSelBtn() {
    const btn = document.getElementById(SEL_BTN_ID);
    if (btn) btn.classList.remove('vt-visible');
  }

  function createSelPopup() {
    let popup = document.getElementById(SEL_POPUP_ID);
    if (popup) return popup;
    popup = document.createElement('div');
    popup.id = SEL_POPUP_ID;
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
        hideSelPopup();
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
    document.body.appendChild(popup);
    return popup;
  }

  function hideSelPopup() {
    const popup = document.getElementById(SEL_POPUP_ID);
    if (popup) popup.classList.remove('vt-visible');
  }

  // selTopY: 选区顶边坐标, 上方换向时弹窗底边贴其上方 10px, 避免遮挡选中文本
  function positionSelPopup(x, y, selTopY) {
    const popup = createSelPopup();
    // 固定模式: fixed 定位贴住视口; 选区模式: absolute 定位跟随文档坐标
    popup.style.position = selPopupPinned ? 'fixed' : 'absolute';
    popup.style.left = '0px';
    popup.style.top = '0px';
    popup.classList.add('vt-visible');
    const rect = popup.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y + 10;
    if (left + rect.width > vw - 12) left = vw - rect.width - 12;
    if (left < 12) left = 12;
    if (top + rect.height > vh - 12) {
      // 下方放不下 → 尝试选区上方: 弹窗底边贴选区顶边上方 10px, 不遮挡选中文本
      const topAbove = (typeof selTopY === 'number' ? selTopY : y) - 10 - rect.height;
      if (topAbove >= 12) {
        top = topAbove;
      } else {
        // 上下都放不下: 夹在视口内
        top = Math.max(12, Math.min(top, vh - rect.height - 12));
      }
    }
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
  }

  function showSelPopup(text, fixedX, fixedY) {
    hideSelBtn();
    // Alt+T 剪贴板翻译 (固定坐标) → 固定模式, 弹窗不随滚动关闭
    selPopupPinned = typeof fixedX === 'number';
    const popup = createSelPopup();
    const engineEl = popup.querySelector('.vt-popup-engine');
    const body = popup.querySelector('.vt-popup-body');
    body.innerHTML = '<div class="vt-popup-loading">正在翻译...</div>';
    engineEl.textContent = '小T翻译';

    let x = typeof fixedX === 'number' ? fixedX : 0;
    let y = typeof fixedY === 'number' ? fixedY : 0;
    let selTop = typeof fixedY === 'number' ? fixedY : 0;
    if (typeof fixedX !== 'number') {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        if (rect && (rect.width || rect.height)) {
          x = rect.left;
          y = rect.bottom;
          selTop = rect.top;
        } else {
          x = 80;
          y = 80;
          selTop = 80;
        }
      }
    }
    positionSelPopup(x, y, selTop);

    // 跟随页面顶栏的语言选择器
    chrome.runtime.sendMessage(
      { type: 'vtTranslate', text: text, from: srcLang.value, to: tgtLang.value },
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
        // 内容变化后重新校正位置, 避免超出视口
        const sel = window.getSelection();
        if (sel && sel.rangeCount && String(sel.toString()).trim()) {
          const rect = sel.getRangeAt(0).getBoundingClientRect();
          if (rect && (rect.width || rect.height)) positionSelPopup(rect.left, rect.bottom, rect.top);
        }
      }
    );
  }

  function showSelErrorPopup(message) {
    selPopupPinned = true;
    hideSelBtn();
    const popup = createSelPopup();
    popup.querySelector('.vt-popup-engine').textContent = '小T翻译';
    const body = popup.querySelector('.vt-popup-body');
    body.innerHTML = '<div class="vt-popup-error">' + escapeHtml(message) + '</div>';
    positionSelPopup(Math.max(12, window.innerWidth - 392), 16);
  }

  // ===== 译文批注 =====
  // 流程: 译文面板选中段落文字 → mouseup 显示"批注"浮标 → 点击弹出编辑器 →
  //       保存时包裹 <mark> 高亮 + 在高亮下方挂批注卡片; 批注随历史记录持久化, 重渲染后自动还原
  function isAnnoEditorOpen() {
    const ed = document.getElementById(ANNO_EDITOR_ID);
    return !!(ed && ed.classList.contains('vt-visible'));
  }

  function createAnnoBtn() {
    let btn = document.getElementById(ANNO_BTN_ID);
    if (btn) return btn;
    btn = document.createElement('div');
    btn.id = ANNO_BTN_ID;
    btn.className = 'vt-anno-btn';
    btn.textContent = '批注';
    btn.title = '给选中译文添加批注';
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (!pendingAnno) return;
      hideAnnoBtn();
      showAnnoEditor(pendingAnno.x, pendingAnno.y);
    });
    document.body.appendChild(btn);
    return btn;
  }

  function hideAnnoBtn() {
    const btn = document.getElementById(ANNO_BTN_ID);
    if (btn) btn.classList.remove('vt-visible');
  }

  function createAnnoEditor() {
    let editor = document.getElementById(ANNO_EDITOR_ID);
    if (editor) return editor;
    editor = document.createElement('div');
    editor.id = ANNO_EDITOR_ID;
    editor.className = 'vt-anno-editor';
    editor.innerHTML =
      '<textarea class="vt-anno-textarea" placeholder="输入批注内容..."></textarea>' +
      '<div class="vt-anno-editor-actions">' +
        '<button class="vt-anno-save" data-act="save">保存</button>' +
        '<button class="vt-anno-cancel" data-act="cancel">取消</button>' +
      '</div>';
    // 阻止 mousedown 冒泡, 防止点击编辑器触发"外部点击关闭"与选区重置
    editor.addEventListener('mousedown', e => e.stopPropagation());
    editor.addEventListener('click', e => {
      const act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'save') savePendingAnnotation();
      else if (act === 'cancel') hideAnnoEditor();
    });
    document.body.appendChild(editor);
    return editor;
  }

  // 固定定位编辑器: 出现在批注浮标正下方, 不随面板滚动关闭
  function showAnnoEditor(x, y) {
    const editor = createAnnoEditor();
    editor.classList.add('vt-visible');
    const rect = editor.getBoundingClientRect();
    let left = x;
    let top = y + 10;
    if (left + rect.width > window.innerWidth - 12) left = window.innerWidth - rect.width - 12;
    if (left < 12) left = 12;
    if (top + rect.height > window.innerHeight - 12) top = Math.max(12, window.innerHeight - rect.height - 12);
    editor.style.left = left + 'px';
    editor.style.top = top + 'px';
    const ta = editor.querySelector('.vt-anno-textarea');
    ta.value = '';
    setTimeout(() => ta.focus(), 0);
  }

  // 关闭编辑器并清空待保存批注 (Esc/取消/外部点击/重渲染时调用; 滚动不触发)
  function hideAnnoEditor() {
    const editor = document.getElementById(ANNO_EDITOR_ID);
    if (editor) editor.classList.remove('vt-visible');
    pendingAnno = null;
  }

  // 在容器内查找批注文本并包裹为 <mark class="vt-anno-mark">
  // TreeWalker 遍历所有文本节点: 段落内已有其他批注高亮时文本被 mark 切分, 单看首节点会漏找
  // 命中范围完整落在单个文本节点内, surroundContents 不会抛错
  function wrapAnnotationText(container, text, annoId) {
    if (!container || !text) return null;
    // 跳过已有批注高亮内的文本节点 (V1.5.55): 同段多条批注时, 后一条的文本若包含在
    // 前一条的 mark 里会被嵌套包裹; 命中范围跨 mark 边界时 surroundContents 抛错,
    // 批注被误判失效剔除。此处跳过后由后续文本节点兜底查找
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.parentElement && n.parentElement.closest('mark.vt-anno-mark'))
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT
    });
    let node;
    while ((node = walker.nextNode())) {
      const idx = node.nodeValue.indexOf(text);
      if (idx === -1) continue;
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + text.length);
      const mark = document.createElement('mark');
      mark.className = 'vt-anno-mark';
      mark.dataset.annoId = annoId;
      try {
        range.surroundContents(mark);
      } catch (e) {
        return null;
      }
      return mark;
    }
    return null;
  }

  // 批注卡片: 挂到译文窗口外的批注侧栏 (vt-anno-rail), 纵向对齐高亮行, 不遮挡译文
  function addAnnoNoteCard(markEl, anno) {
    // 同一批注重复挂载时先移除旧卡片
    const old = annoRail.querySelector('.vt-anno-note[data-anno-id="' + anno.id + '"]');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    const card = document.createElement('div');
    card.className = 'vt-anno-note';
    card.dataset.annoId = anno.id;
    const del = document.createElement('span');
    del.className = 'vt-anno-note-del';
    del.title = '删除批注';
    del.textContent = '✕';
    del.addEventListener('click', () => removeAnnotation(anno.id));
    const label = document.createElement('div');
    label.className = 'vt-anno-note-text';
    label.textContent = anno.note;
    card.appendChild(del);
    card.appendChild(label);
    annoRail.appendChild(card);
    updateAnnoRail();
    scheduleAnnoLayout();
    return card;
  }

  // 批注侧栏显示/隐藏: 有批注才出现; 隐藏时清空卡片并让译文窗口复位
  function updateAnnoRail() {
    const has = annotations.length > 0;
    annoRail.classList.toggle('vt-visible', has);
    document.body.classList.toggle('vt-anno-rail-open', has);
    if (!has) annoRail.innerHTML = '';
  }

  // 重排侧栏卡片: 每张卡片纵向对齐其高亮行 (视口坐标换算到侧栏), 垂直重叠时向下错开;
  // 高亮滚出视口时卡片随之滑出侧栏 (overflow: hidden), 滚回来自动归位
  function layoutAnnoCards() {
    if (!annoRail.classList.contains('vt-visible')) return;
    const railRect = annoRail.getBoundingClientRect();
    const items = [];
    for (const card of Array.from(annoRail.querySelectorAll('.vt-anno-note'))) {
      const mark = document.querySelector('mark.vt-anno-mark[data-anno-id="' + card.dataset.annoId + '"]');
      if (!mark) {
        // 高亮已不存在 (段落被重渲染剔除), 卡片一并移除
        if (card.parentNode) card.parentNode.removeChild(card);
        continue;
      }
      items.push({ card: card, top: mark.getBoundingClientRect().top - railRect.top });
    }
    items.sort((a, b) => a.top - b.top);
    let lastBottom = -Infinity;
    for (const it of items) {
      const h = it.card.offsetHeight || 0;
      const top = Math.max(it.top, lastBottom + 6);
      it.card.style.top = top + 'px';
      lastBottom = top + h;
    }
  }

  // rAF 节流重排: 右栏滚动/窗口缩放/新增批注时调用
  let annoLayoutScheduled = false;
  function scheduleAnnoLayout() {
    if (annoLayoutScheduled) return;
    annoLayoutScheduled = true;
    requestAnimationFrame(() => {
      annoLayoutScheduled = false;
      layoutAnnoCards();
    });
  }
  window.addEventListener('resize', scheduleAnnoLayout);

  // 删除批注: 解包 mark (保留批注文字本身) + 移除卡片 + 从列表剔除 + 同步历史记录
  function removeAnnotation(id) {
    const mark = document.querySelector('mark.vt-anno-mark[data-anno-id="' + id + '"]');
    if (mark && mark.parentNode) {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    }
    const card = document.querySelector('.vt-anno-note[data-anno-id="' + id + '"]');
    if (card && card.parentNode) card.parentNode.removeChild(card);
    annotations = annotations.filter(a => a.id !== id);
    // 最后一条批注删除后侧栏整体隐藏; 剩余卡片向上收拢重新对齐
    updateAnnoRail();
    scheduleAnnoLayout();
    saveHistoryRecord();
  }

  // 保存待保存批注: 包裹高亮 → 入列 → 挂卡片 → 同步历史记录
  function savePendingAnnotation() {
    const pending = pendingAnno;
    pendingAnno = null;
    const editor = document.getElementById(ANNO_EDITOR_ID);
    if (editor) editor.classList.remove('vt-visible');
    if (!pending) return;
    const ta = editor ? editor.querySelector('.vt-anno-textarea') : null;
    const note = ta ? ta.value.trim() : '';
    if (!note) return; // 空批注视为放弃

    const anno = {
      id: 'anno-' + Date.now() + '-' + Math.floor(Math.random() * 1e4),
      page: pending.page,
      paraIdx: pending.paraIdx,
      text: pending.text,
      note: note
    };
    // 优先用仍然存活的选区精确包裹 (选区即用户所选的那一次出现);
    // 选区已丢失 (如点击编辑器输入框后) 则在段落内按文本查找首次出现
    let mark = null;
    const sel = window.getSelection();
    if (sel && sel.rangeCount && String(sel.toString()) === pending.text) {
      const range = sel.getRangeAt(0);
      // 先确认选区完整落在本段落内再包裹: surroundContents 一旦执行即改动 DOM,
      // 若事后才发现不在段内, 兜底 wrapAnnotationText 会再包一次 → 重复高亮
      if (pending.paraDiv.contains(range.startContainer) && pending.paraDiv.contains(range.endContainer)) {
        const m = document.createElement('mark');
        m.className = 'vt-anno-mark';
        m.dataset.annoId = anno.id;
        try {
          range.surroundContents(m);
          mark = m;
        } catch (e) {
          mark = null; // 选区跨节点(非纯文本)时 surroundContents 抛错且不改动 DOM, 交兜底
        }
      }
    }
    if (!mark) mark = wrapAnnotationText(pending.paraDiv, pending.text, anno.id);
    if (!mark) return; // 段落译文文字已变化, 找不到批注原文, 放弃本条

    annotations.push(anno);
    addAnnoNoteCard(mark, anno);
    // 新增批注后同步历史记录, 避免仅靠重新翻译时才持久化
    saveHistoryRecord();
  }

  document.addEventListener('mouseup', e => {
    const t = e.target;
    if (t && t.closest && t.closest('#' + SEL_BTN_ID + ', #' + SEL_POPUP_ID + ', #' + ANNO_BTN_ID + ', #' + ANNO_EDITOR_ID)) return;
    const sel = window.getSelection();
    const text = sel ? String(sel.toString()).trim() : '';
    if (!text || text.length < 2 || text.length > 3000) {
      hideSelBtn();
      // 批注编辑器打开期间保留待保存批注 (编辑器仅由 Esc/取消/外部点击/重渲染关闭)
      if (!isAnnoEditorOpen()) hideAnnoBtn();
      return;
    }
    if (!sel || !sel.rangeCount) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    selPendingText = text;
    // 用选区锚点 (而非 mouseup 落点) 定位段落: 拖选结束点落在段落边缘外时依然有效
    const anchor = sel.anchorNode;
    const anchorEl = anchor ? (anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement) : null;
    const paraDiv = anchorEl && anchorEl.closest ? anchorEl.closest('.translated-para') : null;
    const range = sel.getRangeAt(0);
    const inTranslatedPara = !!(paraDiv && paraDiv.contains(range.startContainer) && paraDiv.contains(range.endContainer));

    // 选中即译 (V1.7.80): 原文选区直接出译文; 译文区选区仍走批注流程
    if (selAutoTranslate && !inTranslatedPara) {
      selPendingText = '';
      showSelPopup(text);
      return;
    }

    const btn = createSelBtn();
    btn.classList.add('vt-visible');
    const btnRect = btn.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - btnRect.width / 2;
    let top = rect.bottom + 6;
    left = Math.max(8, Math.min(left, window.innerWidth - btnRect.width - 8));
    top = Math.min(top, window.innerHeight - btnRect.height - 8);
    btn.style.left = left + 'px';
    btn.style.top = top + 'px';

    // 批注浮标: 选区完整落在某个"译文"段落内时, 显示在"译"浮标右侧
    // (编辑器打开期间不响应新选区, 避免覆盖正在编辑的待保存批注)
    if (isAnnoEditorOpen()) return;
    if (inTranslatedPara) {
      pendingAnno = {
        page: parseInt(paraDiv.dataset.page, 10),
        paraIdx: parseInt(paraDiv.dataset.paraIdx, 10),
        text: text,
        paraDiv: paraDiv,
        x: 0,
        y: 0
      };
      const annoBtn = createAnnoBtn();
      annoBtn.classList.add('vt-visible');
      const annoRect = annoBtn.getBoundingClientRect();
      let aLeft = left + btnRect.width + 6;
      let aTop = top;
      aLeft = Math.max(8, Math.min(aLeft, window.innerWidth - annoRect.width - 8));
      aTop = Math.min(aTop, window.innerHeight - annoRect.height - 8);
      annoBtn.style.left = aLeft + 'px';
      annoBtn.style.top = aTop + 'px';
      // 编辑器期望出现位置: 批注浮标正下方
      pendingAnno.x = aLeft;
      pendingAnno.y = aTop + annoRect.height;
    } else {
      hideAnnoBtn();
    }
  });
  document.addEventListener('keydown', e => {
    // 分享/导出音频/AI 分析弹窗不再响应 Esc, 只有右上角 X 或「取消」才关闭 (V1.7.54)
    if (e.key === 'Escape') { hideSelPopup(); hideSelBtn(); hideAnnoBtn(); hideAnnoEditor(); }
  });
  // 捕获阶段监听: 左右面板内部滚动时同步隐藏浮标/浮窗
  // (Alt+T 固定弹窗与批注编辑器除外, 不随滚动关闭)
  document.addEventListener('scroll', () => {
    hideSelBtn();
    hideAnnoBtn();
    if (!selPopupPinned) hideSelPopup();
  }, true);
  // 捕获阶段监听: 点击批注编辑器外部时关闭编辑器并丢弃待保存批注
  // (捕获先于目标阶段, 编辑器内部的点击靠 closest 守卫放行)
  document.addEventListener('mousedown', e => {
    if (!isAnnoEditorOpen()) return;
    const t = e.target;
    if (t && t.closest && t.closest('#' + ANNO_EDITOR_ID)) return;
    hideAnnoEditor();
  }, true);

  // ===== Alt+T 快捷键翻译支持 (background 经 tabs.sendMessage 转发) =====
  // 文档翻译页是扩展页面, 无 content script, 需自行响应选区查询与译文展示
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'vtGetSelection') {
      const sel = window.getSelection();
      sendResponse({ text: sel ? String(sel.toString()).trim() : '' });
      return;
    }
    if (msg.type === 'vtShowSelectionTranslation') {
      if (msg.error) {
        showSelErrorPopup(msg.error);
      } else if (msg.text) {
        showSelPopup(msg.text, Math.max(12, window.innerWidth - 392), 16);
      }
      return;
    }
  });

  loadConfig();
  // 缩放清晰度 (V1.7.83): 监听设备像素比变化 (浏览器 Ctrl+± 缩放), 按新倍率重绘位图
  listenDprChange();

  // 支持 ?url= 参数加载在线 PDF (「翻译当前PDF」入口) 或本地直接打开的 PDF (file://)
  const pdfUrlParam = new URLSearchParams(location.search).get('url');
  if (pdfUrlParam && /^(https?|file):\/\//i.test(pdfUrlParam)) {
    loadPdfFromUrl(pdfUrlParam);
  }
})();
