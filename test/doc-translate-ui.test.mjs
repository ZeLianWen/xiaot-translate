/**
 * doc-translate 弹窗非模态浮窗化静态守护 (V1.7.59)
 * 运行: node --test test/
 * 验证: 分享译文 / 导出音频 / AI 分析三个弹窗——遮罩不拦截页面滚动, 三者均接入标题行拖拽。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../doc-translate.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../doc-translate.js', import.meta.url), 'utf8');

test('share-dialog-mask: 非模态浮窗——遮罩不拦截事件, 弹窗本体可交互 (V1.7.59)', () => {
  const mask = html.match(/\.share-dialog-mask \{[^}]+\}/)[0];
  assert.ok(mask.includes('pointer-events: none'), '遮罩必须放行底部主页面的滚动/交互');
  assert.ok(!mask.includes('rgba(0,0,0'), '遮罩不再压暗底部主页面');
  const dlg = html.match(/\.share-dialog \{[^}]+\}/)[0];
  assert.ok(dlg.includes('pointer-events: auto'), '弹窗本体表单必须可交互');
});

test('makeDialogDraggable: 分享译文/导出音频/AI 分析三个弹窗均接入拖拽 (V1.7.59)', () => {
  assert.ok(js.includes('function makeDialogDraggable('), '通用拖拽 helper 存在');
  const uses = js.match(/makeDialogDraggable\(/g) || [];
  assert.equal(uses.length, 4, '1 处定义 + 3 处调用 (share/tts/ai)');
  assert.ok(html.includes('cursor: move'), '标题行有可拖动光标提示');
  assert.ok(!js.includes('ai-dragging') && !html.includes('ai-dragging'), '旧 ai-dragging 类名已通用化');
});

test('openTtsDialog: 打开前重读存储, 设置页改音色后已打开的翻译页立即生效 (V1.7.60)', () => {
  const m = js.match(/async function openTtsDialog\(\) \{[\s\S]*?\n  \}/);
  assert.ok(m, 'openTtsDialog 存在');
  assert.ok(m[0].includes('await loadConfig()'), '打开弹窗前必须重读 vtConfig (否则读旧 config, 改音色不生效)');
});

test('配置重读全覆盖: 弹窗打开期间改设置, 生成/发送时也用新配置 (V1.7.61)', () => {
  const synth = js.match(/async function synthTtsMp3\(\) \{[\s\S]*?\n  \}/);
  assert.ok(synth, 'synthTtsMp3 存在');
  assert.ok(synth[0].includes('await loadConfig()'), '生成音频前必须重读 (官方引擎/百度/自定义三来源通用)');
  const send = js.match(/async function sendChatMessage\(text\) \{[\s\S]*?\n  \}/);
  assert.ok(send, 'sendChatMessage 存在');
  assert.ok(send[0].includes('await loadConfig()'), 'AI 发送前必须重读 (自定义模型槽位/密钥)');
});

test('PDF 渲染清晰度: 设备像素 1.5x 超采样 + 全文档像素预算, 不再受 2.6 绝对封顶 (V1.7.64)', () => {
  assert.ok(/const SUPERSAMPLE = 1\.5/.test(js), '缺少超采样倍率常量');
  assert.ok(/const PAGE_PIXEL_BUDGET = \d/.test(js), '缺少全文档像素预算');
  const fn = js.match(/function computePixelRatio\(fitScale, cssW, cssH, pageTotal\) \{[\s\S]*?\n  \}/);
  assert.ok(fn, '缺少像素比计算函数');
  assert.ok(fn[0].includes('legacyRatio'), '必须保留旧公式作为清晰度下限');
  assert.ok(fn[0].includes('deviceDpr()'), '像素比必须来自动态设备像素比');
  assert.ok(/dpr \* SUPERSAMPLE/.test(fn[0]), '必须按超采样倍率计算目标像素比');
  assert.ok(fn[0].includes('ratioByBudget'), '必须按全文档像素预算收敛');
  assert.ok(js.includes('const renderScale = fitScale * pixelRatio'), '渲染缩放 = 显示缩放 × 像素比');
  assert.ok(!/const renderScale = Math\.min\(fitScale \* RENDER_DPR, 2\.6\)/.test(js), '旧的绝对封顶公式必须移除');
});

test('缩放清晰度: 设备像素比变化后按新倍率重绘位图 (V1.7.83)', () => {
  // 浏览器缩放 (Ctrl+±) 改的是 devicePixelRatio, 位图必须重绘否则放大即插值发糊
  assert.ok(/function deviceDpr\(\)/.test(js), '设备像素比必须动态取函数值, 不能用启动时快照');
  assert.ok(/matchMedia\('\(resolution: ' \+ dpr \+ 'dppx\)'\)/.test(js), '必须监听当前设备像素比');
  assert.ok(/function rerenderBitmapsForDpr\([\s\S]*?canvasContext: rec\.leftCanvas\.getContext\('2d'\)/.test(js), '必须按新倍率重绘左栏位图');
  assert.ok(/rec\.leftCanvas\.width = Math\.round\(renderViewport\.width\)/.test(js), '重绘前必须按新视口重设 canvas 尺寸');
  // 右栏是左栏位图拷贝, 拷贝会抹掉盖白 → 必须重涂
  assert.ok(/function paintTranslatedCoverRects\(pageInfo, translatedPage, ctx, cssViewport, pixelRatio\)/.test(js), '盖白需抽成独立函数供重绘复用');
  assert.ok(/paintTranslatedCoverRects\(pageInfo, translatedPage, rctx, rec\.cssViewport, newRatio\)/.test(js), '重绘右栏后必须按新倍率重涂盖白');
  assert.ok(/function listenDprChange\(\)/.test(js) && /listenDprChange\(\);/.test(js), '启动时需注册像素比监听');
  assert.ok(/pageRenderRecords = \[\];/.test(js), '返回上传/新渲染需清空位图记录');
  // 长文档像素预算会把倍率压在 ~2.5: 放大时可视页需突破预算, 滚出后回落 (内存可控)
  assert.ok(/const MAX_BOOST_RATIO = 4/.test(js), '缺少放大增强倍率上限');
  assert.ok(/function boostActive\(\)/.test(js), '增强需有开关判定 (仅放大状态生效)');
  assert.ok(/boostActive\(\) && isRecordVisible\(rec\)/.test(js), '仅可视页使用增强倍率');
  assert.ok(/maybeBoostVisiblePages/.test(js), '滚动时需重算可视页倍率');
  // 布局不变 → 不应重建文字层/批注
  const re = js.match(/async function rerenderBitmapsForDpr\(\) \{[\s\S]*?\n  \}/);
  assert.ok(re && !re[0].includes('renderTranslatedTextLayer('), '重绘只动位图, 不重建译文 DOM 层 (避免丢批注/朗读高亮)');
});

test('表格识别: 按版面几何 (列间隙+跨行对齐), 表格内容固定不翻译 (V1.7.70)', () => {
  const fn = js.match(/function detectTableParagraphIdx\(pageInfo\) \{[\s\S]*?\n  \}/);
  assert.ok(fn, '缺少表格段落识别函数');
  assert.ok(fn[0].includes('buildTableRows(') && fn[0].includes('detectTableParagraphs('), '应委托 lib/table-detect.js 纯函数识别');
  assert.ok(fn[0].includes('pageTransform'), '需用页面变换把坐标归一到 1x 空间');
  const lib = fs.readFileSync(new URL('../lib/table-detect.js', import.meta.url), 'utf8');
  assert.ok(lib.includes('export function buildTableRows'), '纯函数 buildTableRows 必须存在');
  assert.ok(lib.includes('function tableColumnsAligned'), '必须校验列起点跨行对齐');
  assert.ok(/TABLE_MAX_CELL_CHARS = 30/.test(lib), '必须以单元格文字长度排除双栏正文');
  assert.ok(/TABLE_MIN_ROWS = 3/.test(lib), '至少 3 行才算表格');
  assert.ok(js.includes('pageTransform: viewport.transform'), '解析页需保存 pageTransform');
  // 表格段落固定跳过翻译与叠字 (无开关)
  assert.ok(/if \(tableSet\.has\(pi\)\) \{/.test(js), '翻译路径必须无条件跳过表格段落');
  assert.ok(!js.includes('tableTextEnabled'), '表格翻译开关必须移除');
  assert.ok(/if \(tableSet\.has\(pIdx\)\) continue;/.test(js), '渲染路径必须无条件保持表格原图');
});

test('缩放后横向滚动条: 左栏保留横向细条 (仅隐藏纵向), 两栏横向滚动同步 (V1.7.84)', () => {
  const leftBar = html.match(/\.split-pane-left::-webkit-scrollbar \{[^}]+\}/);
  assert.ok(leftBar, '缺少左栏滚动条规则');
  assert.ok(/width:\s*0/.test(leftBar[0]), '纵向滚动条仍需隐藏 (避免夹在两页中间)');
  assert.ok(/height:\s*10px/.test(leftBar[0]), '横向滚动条必须保留 (浏览器缩放后页面比栏宽)');
  // scrollbar-width 会覆盖 webkit 伪元素, 会把横向条一起隐藏掉
  assert.ok(!/\.split-pane-left\s*\{[^}]*scrollbar-width:\s*none/.test(html), '左栏不能再用 scrollbar-width: none');
  // 右对齐 + 溢出 = 起始侧溢出不可滚动: 必须用 auto 外边距, 溢出时自动左对齐
  assert.ok(/\.split-pane-left \.pane-scroll-content > \.pdf-page-container \{ margin-left: auto; \}/.test(html), '原文页溢出时必须能回到左边缘 (auto 外边距)');
  // 两栏横向滚动位置同步 (纵向已有同步, 横向此前缺失)
  const left = js.match(/leftPane\.addEventListener\('scroll'[\s\S]*?\n    \}\);/)[0];
  const right = js.match(/rightPane\.addEventListener\('scroll'[\s\S]*?\n    \}\);/)[0];
  assert.ok(/rightPane\.scrollLeft = hRatio/.test(left), '左栏滚动需同步右栏横向位置');
  assert.ok(/leftPane\.scrollLeft = hRatio/.test(right), '右栏滚动需同步左栏横向位置');
});

test('readTtsConfig: 语音合成来源以统一设置为准, 设置成百度后不再恒走官方引擎 (V1.7.62)', () => {
  const m = js.match(/function readTtsConfig\(\) \{[\s\S]*?\n  \}/);
  assert.ok(m, 'readTtsConfig 存在');
  assert.ok(m[0].includes('config.settings'), '必须优先读取 settings.tts.mode (设置页写入处)');
  assert.ok(m[0].includes('config.tts') || m[0].includes('c.mode'), '保留旧字段回退兼容');
  // 弹窗内切换来源立即持久化, 设置页/导出音频保持一致
  assert.ok(js.includes('function setTtsMode('), 'setTtsMode 持久化 helper 存在');
  for (const mode of ['server', 'baidu', 'custom']) {
    assert.ok(js.includes("setTtsMode('" + mode + "')"), `来源按钮 ${mode} 必须走 setTtsMode 持久化`);
  }
  // V1.7.63: 生成前跟随存储来源时必须与「上次对齐值」比较, 否则会覆盖刚点的选择(异步写入竞态)
  assert.ok(js.includes('ttsModeSynced'), '必须用 ttsModeSynced 区分外部改动与未落盘的旧值');
  const synth = js.match(/async function synthTtsMp3\(\) \{[\s\S]*?\n  \}/)[0];
  assert.ok(/storedMode !== ttsModeSynced/.test(synth), '生成前仅当存储相对上次同步变化时才跟随');
});

test('选中即译开关 (V1.7.80): 默认关闭, 开启后原文选区直接出译文, 译文区仍走批注', () => {
  assert.ok(html.includes('id="selAutoToggle"') && html.includes('id="selAutoTranslate"'), '缺少选中即译开关');
  assert.ok(/let selAutoTranslate = false/.test(js), '默认必须关闭, 避免误触');
  assert.ok(js.includes('vtSelAutoTranslate'), '开关需持久化到 storage');
  const m = js.match(/if \(selAutoTranslate && !inTranslatedPara\) \{[\s\S]*?\n    \}/);
  assert.ok(m && m[0].includes('showSelPopup(text)'), '开启后原文选区应直接弹译文');
  assert.ok(js.includes('inTranslatedPara'), '译文区选区需排除在自动翻译之外 (供批注使用)');
});

