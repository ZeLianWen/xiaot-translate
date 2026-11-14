// 统一设置页 (V1.7.42): 只维护模型配置 —— 翻译 / AI 分析 / 语音合成三组。
// 实际使用哪个引擎/来源在对应功能界面选择: popup 翻译引擎下拉 + 自定义槽位、AI 分析窗口、导出音频窗口。
// 保存时写 vtConfig.settings 与旧字段的配置类字段, 不覆盖 backend / customActive / tts.mode 等运行期选择。
import {
  loadSettingsFromStorage, saveSettingsToStorage, normalizeSettings, settingsSummary, toLegacyPatch, COSYVOICE_TTS_PRESET, TTS_VOICE_OPTIONS, TTS_VOICE_LABELS, BAIDU_TTS_VOICE_OPTIONS, BAIDU_TTS_VOICE_LABELS, BAIDU_TTS_SPEED
} from './lib/settings.js';
import { translateText, customChat, cloudChat, baiduTts, cloudTts } from './lib/translator.js';
import { hasSession, mountAuthGate } from './lib/auth-gate.js';

const $ = id => document.getElementById(id);
let settings = normalizeSettings(null);

// 实际使用中的引擎/来源 (由各功能界面维护): 仅用于设置页默认显示哪一组配置
async function loadRuntimeSelection() {
  try {
    const r = await chrome.storage.local.get(['vtConfig', 'vtAiEngine']);
    const cfg = (r && r.vtConfig) || {};
    const backends = ['proxy', 'baidu', 'volcengine', 'tencent', 'custom'];
    const modes = ['server', 'baidu', 'custom'];
    const ttsMode = cfg.tts && modes.indexOf(String(cfg.tts.mode)) >= 0 ? cfg.tts.mode : '';
    return {
      translate: backends.indexOf(String(cfg.backend)) >= 0 ? cfg.backend : '',
      ai: (r && r.vtAiEngine === 'custom') ? 'custom' : ((r && r.vtAiEngine === 'cloud') ? 'cloud' : ''),
      tts: ttsMode
    };
  } catch (e) {
    return null;
  }
}

function applyRuntimeSelection(sel) {
  if (!sel) return;
  if (sel.translate) settings.translate.backend = sel.translate;
  if (sel.ai) settings.ai.engine = sel.ai;
  if (sel.tts) settings.tts.mode = sel.tts;
}

// 第一个已配置的自定义槽位 (设置页不再维护运行期槽位, 测试取第一个可用槽位)
function firstConfiguredSlot() {
  const models = settings.translate.custom.models;
  for (let i = 0; i < models.length; i++) {
    if (models[i].baseUrl && models[i].model) return i;
  }
  return -1;
}

function firstConfiguredAiSlot() {
  const models = settings.ai.models;
  for (let i = 0; i < models.length; i++) {
    if (models[i].baseUrl && models[i].model) return i;
  }
  return -1;
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===== 自定义槽位 (1~3 个, 可增删; 实际使用哪个槽位由各功能界面选择; 每个槽位可单独测试) =====
function renderSlotGrid(box, models, onChange, onTest, onDelete, onAdd) {
  const addTile = models.length < 3
    ? '<button type="button" class="slot slot-add-tile" data-add="1">＋ 添加槽位</button>'
    : '';
  box.innerHTML = models.map((m, i) => {
    const title = '槽位 ' + (i + 1)
      + (m.model ? ' <span style="color:#8c8c8c;font-weight:400">' + esc(m.model) + '</span>' : '');
    const ops = '<span class="slot-ops">'
      + '<button type="button" class="slot-test" data-test="' + i + '">测试</button>'
      + (models.length > 1 ? '<button type="button" class="slot-del" data-del="' + i + '">删除</button>' : '')
      + '</span>';
    return '<div class="slot">'
      + '<h3><span>' + title + '</span>' + ops + '</h3>'
      + '<input type="text" data-slot="' + i + '" data-k="baseUrl" placeholder="接口地址" value="' + esc(m.baseUrl) + '">'
      + '<input type="password" data-slot="' + i + '" data-k="apiKey" placeholder="API Key（本地可空）" value="' + esc(m.apiKey) + '">'
      + '<input type="text" data-slot="' + i + '" data-k="model" placeholder="模型名" value="' + esc(m.model) + '">'
      + '<input type="number" data-slot="' + i + '" data-k="maxBytes" min="500" max="200000" step="100" placeholder="字节上限" value="' + (m.maxBytes || '') + '">'
      + '<div class="slot-status" data-status="' + i + '"></div>'
      + '</div>';
  }).join('') + addTile;
  box.querySelectorAll('input[data-slot]').forEach(inp => {
    inp.addEventListener('input', () => {
      const i = Number(inp.dataset.slot);
      const k = inp.dataset.k;
      onChange(i, k, k === 'maxBytes' ? Number(inp.value) || 0 : inp.value);
      refreshBadges();
      scheduleSave();
    });
  });
  box.querySelectorAll('[data-test]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.test);
      onTest(i, box.querySelector('[data-status="' + i + '"]'), btn);
    });
  });
  box.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.del);
      if (!confirm('删除槽位 ' + (i + 1) + '？该槽位的配置会一并删除。')) return;
      onDelete(i);
    });
  });
  const addBtn = box.querySelector('[data-add]');
  if (addBtn) addBtn.addEventListener('click', onAdd);
}

function emptySlot() {
  return { baseUrl: '', apiKey: '', model: '', maxBytes: 0 };
}

function addSlot(kind) {
  const arr = kind === 'translate' ? settings.translate.custom.models : settings.ai.models;
  if (arr.length >= 3) return;
  arr.push(emptySlot());
  if (kind === 'translate') renderSlots(); else renderAiSlots();
  refreshBadges();
  scheduleSave();
}

function deleteSlot(kind, i) {
  const arr = kind === 'translate' ? settings.translate.custom.models : settings.ai.models;
  if (arr.length <= 1) return;
  arr.splice(i, 1);
  if (kind === 'translate') renderSlots(); else renderAiSlots();
  refreshBadges();
  scheduleSave();
}

function renderSlots() {
  const models = settings.translate.custom.models;
  renderSlotGrid($('trSlots'), models, (i, k, v) => {
    settings.translate.custom.models[i][k] = v;
  }, testTranslateSlot, i => deleteSlot('translate', i), () => addSlot('translate'));
}

function renderAiSlots() {
  const models = settings.ai.models;
  renderSlotGrid($('aiSlots'), models, (i, k, v) => {
    settings.ai.models[i][k] = v;
  }, testAiSlot, i => deleteSlot('ai', i), () => addSlot('ai'));
}

function setSlotStatus(el, text, kind) {
  if (!el) return;
  el.textContent = text;
  el.className = 'slot-status' + (kind ? ' ' + kind : '');
}

// ===== 显隐 =====
function updateVisibility() {
  const tb = $('trBackend').value;
  $('trBaiduBox').classList.toggle('hidden', tb !== 'baidu');
  $('trVolcBox').classList.toggle('hidden', tb !== 'volcengine');
  $('trTencentBox').classList.toggle('hidden', tb !== 'tencent');
  $('trCustomBox').classList.toggle('hidden', tb !== 'custom');
  $('aiCustomBox').classList.toggle('hidden', $('aiEngine').value !== 'custom');
  const tm = $('ttsMode').value;
  $('ttsBaiduBox').classList.toggle('hidden', tm !== 'baidu');
  $('ttsCustomBox').classList.toggle('hidden', tm !== 'custom');
}

function refreshBadges() {
  const list = settingsSummary(settings);
  const map = { translate: 'trBadge', ai: 'aiBadge', tts: 'ttsBadge' };
  list.forEach(it => {
    const el = $(map[it.id]);
    if (!el) return;
    el.textContent = it.ready ? '已就绪' : '待配置';
    el.className = 'badge ' + (it.ready ? 'ok' : 'missing');
    el.title = it.detail;
  });
}

// ===== 表单 ⇄ 模型 =====
function fillForm() {
  $('trBackend').value = settings.translate.backend;
  $('trBaiduAppId').value = settings.translate.baidu.appId;
  $('trBaiduKey').value = settings.translate.baidu.key;
  $('trVolcAk').value = settings.translate.volcengine.accessKeyId;
  $('trVolcSk').value = settings.translate.volcengine.secretAccessKey;
  $('trTencentSid').value = settings.translate.tencent.secretId;
  $('trTencentSkey').value = settings.translate.tencent.secretKey;
  renderSlots();

  $('aiEngine').value = settings.ai.engine;
  renderAiSlots();

  $('ttsMode').value = settings.tts.mode;
  $('ttsBaiduAk').value = settings.tts.baiduAk;
  $('ttsBaiduSk').value = settings.tts.baiduSk;
  setBaiduTtsVoice(settings.tts.baiduVoice);
  setBaiduTtsSpeed(settings.tts.baiduSpeed);
  $('ttsEndpoint').value = settings.tts.endpoint;
  $('ttsApiKey').value = settings.tts.apiKey;
  $('ttsModel').value = settings.tts.model;
  setTtsVoice(settings.tts.voice);

  updateVisibility();
  refreshBadges();
}

function collectTranslate() {
  settings.translate.backend = $('trBackend').value;
  settings.translate.baidu.appId = $('trBaiduAppId').value.trim();
  settings.translate.baidu.key = $('trBaiduKey').value.trim();
  settings.translate.volcengine.accessKeyId = $('trVolcAk').value.trim();
  settings.translate.volcengine.secretAccessKey = $('trVolcSk').value.trim();
  settings.translate.tencent.secretId = $('trTencentSid').value.trim();
  settings.translate.tencent.secretKey = $('trTencentSkey').value.trim();
}

function collectAi() {
  settings.ai.engine = $('aiEngine').value;
}

function collectTts() {
  settings.tts.mode = $('ttsMode').value;
  settings.tts.baiduAk = $('ttsBaiduAk').value.trim();
  settings.tts.baiduSk = $('ttsBaiduSk').value.trim();
  settings.tts.baiduVoice = $('ttsBaiduVoice').value === TTS_VOICE_CUSTOM
    ? ($('ttsBaiduVoiceCustom').value.trim() || '0') : $('ttsBaiduVoice').value;
  settings.tts.baiduSpeed = $('ttsBaiduSpeed').value || String(BAIDU_TTS_SPEED.def);
  settings.tts.endpoint = $('ttsEndpoint').value.trim();
  settings.tts.apiKey = $('ttsApiKey').value.trim();
  settings.tts.model = $('ttsModel').value.trim();
  settings.tts.voice = $('ttsVoice').value === TTS_VOICE_CUSTOM ? $('ttsVoiceCustom').value.trim() : $('ttsVoice').value;
}

// ===== 自定义 TTS 音色下拉 (V1.7.57): 标准音色选择 + 「自定义…」自由输入 =====
const TTS_VOICE_CUSTOM = '__custom__';

function initTtsVoiceSelect() {
  const sel = $('ttsVoice');
  for (const v of TTS_VOICE_OPTIONS) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = TTS_VOICE_LABELS[v] ? `${v}（${TTS_VOICE_LABELS[v]}）` : v;
    sel.appendChild(o);
  }
  const c = document.createElement('option');
  c.value = TTS_VOICE_CUSTOM;
  c.textContent = '自定义…';
  sel.appendChild(c);
}

// 回显存储的音色: 标准音色直接选中; 其他值切到「自定义…」并填入输入框; 空值默认第一个标准音色
function setTtsVoice(voice) {
  const v = (voice || '').trim();
  const sel = $('ttsVoice');
  if (v && !TTS_VOICE_OPTIONS.includes(v)) {
    sel.value = TTS_VOICE_CUSTOM;
    $('ttsVoiceCustom').value = v;
  } else {
    sel.value = v || TTS_VOICE_OPTIONS[0];
    $('ttsVoiceCustom').value = '';
  }
  $('ttsVoiceCustomField').classList.toggle('hidden', sel.value !== TTS_VOICE_CUSTOM);
}

// ===== 百度 TTS 音色/语速下拉 (V1.7.58): 标准音色中文注释 + 语速 0~15 档位 =====
function initBaiduTtsSelects() {
  const vsel = $('ttsBaiduVoice');
  for (const v of BAIDU_TTS_VOICE_OPTIONS) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = BAIDU_TTS_VOICE_LABELS[v] || v;
    vsel.appendChild(o);
  }
  const c = document.createElement('option');
  c.value = TTS_VOICE_CUSTOM;
  c.textContent = '自定义…';
  vsel.appendChild(c);
  const ssel = $('ttsBaiduSpeed');
  for (let i = BAIDU_TTS_SPEED.min; i <= BAIDU_TTS_SPEED.max; i++) {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = i === BAIDU_TTS_SPEED.def ? `${i}（正常）` : String(i);
    ssel.appendChild(o);
  }
}

// 回显存储的百度音色: 标准编号直接选中; 其他编号切到「自定义…」; 空值默认第一个
function setBaiduTtsVoice(voice) {
  const v = (voice || '').trim();
  const sel = $('ttsBaiduVoice');
  if (v && !BAIDU_TTS_VOICE_OPTIONS.includes(v)) {
    sel.value = TTS_VOICE_CUSTOM;
    $('ttsBaiduVoiceCustom').value = v;
  } else {
    sel.value = v || BAIDU_TTS_VOICE_OPTIONS[0];
    $('ttsBaiduVoiceCustom').value = '';
  }
  $('ttsBaiduVoiceCustomField').classList.toggle('hidden', sel.value !== TTS_VOICE_CUSTOM);
}

// 回显语速: 非法/越界值回退默认档
function setBaiduTtsSpeed(speed) {
  const n = parseInt(speed, 10);
  $('ttsBaiduSpeed').value = String(n >= BAIDU_TTS_SPEED.min && n <= BAIDU_TTS_SPEED.max ? n : BAIDU_TTS_SPEED.def);
}

function collectAll() {
  collectTranslate();
  collectAi();
  collectTts();
}

// ===== 持久化: 输入后自动保存 (防刷新/关页丢失) + 手动保存按钮 =====
let saveTimer = null;
let saveChain = Promise.resolve();

function setSaveState(text, kind) {
  const el = $('saveState');
  if (!el) return;
  el.textContent = text;
  el.className = 'foot' + (kind ? ' ' + kind : '');
}

function persist() {
  saveChain = saveChain.then(async () => {
    collectAll();
    try {
      settings = await saveSettingsToStorage(settings);
      refreshBadges();
      setSaveState('已自动保存 ' + new Date().toLocaleTimeString() + '（仅本机）', 'ok');
      return true;
    } catch (e) {
      setSaveState('自动保存失败：' + (e && e.message ? e.message : String(e)), 'err');
      return false;
    }
  });
  return saveChain;
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; persist(); }, 400);
}

async function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  return persist();
}

async function save(kind) {
  const ok = await flushSave();
  const st = $((kind === 'translate' ? 'tr' : kind) + 'Status');
  if (ok) setStatus(st, '已保存', 'ok');
}

// ===== 测试连接 =====
function legacyConfigFromSettings() {
  const p = toLegacyPatch(settings);
  return p;
}

async function testTranslate() {
  collectTranslate();
  await flushSave();
  const st = $('trStatus');
  setStatus(st, '测试中…');
  const cfg = legacyConfigFromSettings();
  if (settings.translate.backend === 'custom') {
    const idx = firstConfiguredSlot();
    if (idx < 0) return setStatus(st, '失败：自定义模型未配置（缺少接口地址或模型名）', 'err');
    cfg.customActive = idx; // 槽位由 popup 选择, 设置页测试取第一个已配置槽位
  }
  try {
    // 用具体源语言 en: 火山不支持 auto 自动检测源语言, 其余引擎同样支持 en→zh
    const r = await translateText('Hello, this is a connection test.', 'en', 'zh', settings.translate.backend, cfg);
    setStatus(st, '成功：' + String(r || '').slice(0, 40), 'ok');
  } catch (e) {
    setStatus(st, '失败：' + (e && e.message ? e.message : String(e)), 'err');
  }
}

async function testAi() {
  collectAi();
  await flushSave();
  const st = $('aiStatus');
  setStatus(st, '测试中…');
  try {
    if (settings.ai.engine === 'cloud') {
      const r = await cloudChat([{ role: 'user', content: '只回复两个字：正常' }], {}, { temperature: 0 });
      setStatus(st, '成功：' + String(r).slice(0, 40), 'ok');
    } else {
      const idx = firstConfiguredAiSlot();
      if (idx < 0) return setStatus(st, '失败：自定义模型槽位均未配置（缺少接口地址或模型名）', 'err');
      const m = settings.ai.models[idx];
      // AI 模型配置在独立的 aiModels 槽位, 必须显式传 slot; 否则 customChat 会回退去解析
      // 翻译引擎的自定义槽位, 误报“请先配置自定义模型接口地址”(V1.7.44)
      const r = await customChat([{ role: 'user', content: '只回复两个字：正常' }], {}, {
        temperature: 0,
        slot: { baseUrl: m.baseUrl, apiKey: m.apiKey, model: m.model }
      });
      setStatus(st, '成功：' + String(r).slice(0, 40), 'ok');
    }
  } catch (e) {
    setStatus(st, '失败：' + (e && e.message ? e.message : String(e)), 'err');
  }
}

// 每个自定义槽位单独测试 (V1.7.45): 翻译槽位与 AI 槽位各自就地显示结果
async function testTranslateSlot(i, statusEl, btn) {
  await flushSave();
  const m = settings.translate.custom.models[i] || {};
  if (!m.baseUrl || !m.model) {
    setSlotStatus(statusEl, '请先填写接口地址和模型名', 'err');
    return;
  }
  const cfg = legacyConfigFromSettings();
  cfg.customActive = i;
  setSlotStatus(statusEl, '测试中…');
  btn.disabled = true;
  try {
    const r = await translateText('Hello, this is a connection test.', 'en', 'zh', 'custom', cfg);
    setSlotStatus(statusEl, '成功：' + String(r || '').slice(0, 40), 'ok');
  } catch (e) {
    setSlotStatus(statusEl, '失败：' + (e && e.message ? e.message : String(e)), 'err');
  } finally {
    btn.disabled = false;
  }
}

async function testAiSlot(i, statusEl, btn) {
  await flushSave();
  const m = settings.ai.models[i] || {};
  if (!m.baseUrl || !m.model) {
    setSlotStatus(statusEl, '请先填写接口地址和模型名', 'err');
    return;
  }
  setSlotStatus(statusEl, '测试中…');
  btn.disabled = true;
  try {
    const r = await customChat([{ role: 'user', content: '只回复两个字：正常' }], {}, {
      temperature: 0,
      slot: { baseUrl: m.baseUrl, apiKey: m.apiKey, model: m.model }
    });
    setSlotStatus(statusEl, '成功：' + String(r || '').slice(0, 40), 'ok');
  } catch (e) {
    setSlotStatus(statusEl, '失败：' + (e && e.message ? e.message : String(e)), 'err');
  } finally {
    btn.disabled = false;
  }
}

async function testTts() {
  collectTts();
  await flushSave();
  const st = $('ttsStatus');
  setStatus(st, '测试中…');
  try {
    if (settings.tts.mode === 'server') {
      const buf = await cloudTts('语音合成测试', { lang: 'zh', speed: 5 });
      setStatus(st, '成功：收到 ' + Math.round(buf.byteLength / 1024) + 'KB 音频', 'ok');
    } else if (settings.tts.mode === 'baidu') {
      const buf = await baiduTts('语音合成测试', {
        ak: settings.tts.baiduAk, sk: settings.tts.baiduSk, lang: 'zh',
        speed: Number(settings.tts.baiduSpeed) || 5, voice: settings.tts.baiduVoice || '0'
      });
      setStatus(st, '成功：收到 ' + Math.round(buf.byteLength / 1024) + 'KB 音频', 'ok');
    } else {
      const resp = await fetch(settings.tts.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + settings.tts.apiKey },
        body: JSON.stringify({ model: settings.tts.model || 'tts-1', input: '语音合成测试', voice: settings.tts.voice || 'alloy', response_format: 'mp3' })
      });
      if (!resp.ok) throw new Error('接口返回 ' + resp.status);
      const buf = await resp.arrayBuffer();
      setStatus(st, '成功：收到 ' + Math.round(buf.byteLength / 1024) + 'KB 音频', 'ok');
    }
  } catch (e) {
    setStatus(st, '失败：' + (e && e.message ? e.message : String(e)), 'err');
  }
}

// ===== 事件绑定 =====
$('trBackend').addEventListener('change', () => { updateVisibility(); refreshBadges(); scheduleSave(); });
$('aiEngine').addEventListener('change', () => { updateVisibility(); refreshBadges(); scheduleSave(); });
$('ttsMode').addEventListener('change', () => { updateVisibility(); refreshBadges(); scheduleSave(); });
$('ttsVoice').addEventListener('change', () => {
  $('ttsVoiceCustomField').classList.toggle('hidden', $('ttsVoice').value !== TTS_VOICE_CUSTOM);
  refreshBadges();
  scheduleSave();
});

$('ttsBaiduVoice').addEventListener('change', () => {
  $('ttsBaiduVoiceCustomField').classList.toggle('hidden', $('ttsBaiduVoice').value !== TTS_VOICE_CUSTOM);
  refreshBadges();
  scheduleSave();
});
$('ttsBaiduSpeed').addEventListener('change', () => { refreshBadges(); scheduleSave(); });

['trBaiduAppId', 'trBaiduKey', 'trVolcAk', 'trVolcSk', 'trTencentSid', 'trTencentSkey',
  'ttsBaiduAk', 'ttsBaiduSk', 'ttsEndpoint', 'ttsApiKey', 'ttsModel', 'ttsVoiceCustom', 'ttsBaiduVoiceCustom'
].forEach(id => {
  $(id).addEventListener('input', () => {
    collectTranslate();
    collectAi();
    collectTts();
    refreshBadges();
    scheduleSave();
  });
});

$('trSave').addEventListener('click', () => save('translate'));
$('aiSave').addEventListener('click', () => save('ai'));
$('ttsSave').addEventListener('click', () => save('tts'));
$('trTest').addEventListener('click', testTranslate);
$('aiTest').addEventListener('click', testAi);
$('ttsTest').addEventListener('click', testTts);

// 一键填入本地 CosyVoice2-0.5B 预设 (V1.7.56): 原生 Windows 本地服务, 免 Key, OpenAI 兼容 /v1/audio/speech
$('ttsFillCosy').addEventListener('click', () => {
  const p = COSYVOICE_TTS_PRESET;
  $('ttsMode').value = p.mode;
  $('ttsEndpoint').value = p.endpoint;
  $('ttsApiKey').value = p.apiKey;
  $('ttsModel').value = p.model;
  setTtsVoice(p.voice);
  updateVisibility();
  collectTts();
  refreshBadges();
  scheduleSave();
  setStatus($('ttsStatus'), '已填入本地 CosyVoice2 预设（127.0.0.1:9885，无需 Key）。请先启动本地 CosyVoice2 服务，再点「测试合成」。', 'ok');
});

// 关页/切后台时冲刷未落盘的自动保存 (防刷新丢失)
document.addEventListener('visibilitychange', () => {
  if (document.hidden && saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    persist();
  }
});
window.addEventListener('pagehide', () => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    persist();
  }
});

// ===== 初始化 =====
async function init() {
  // 强制登录门禁 (V1.7.81): 设置页同样属于注册用户功能
  if (!(await hasSession())) {
    mountAuthGate({
      title: '注册 / 登录后使用',
      desc: '统一设置需邮箱注册后使用。登录后可维护翻译引擎、AI 分析与语音合成的配置。',
      onSuccess: () => location.reload()
    });
    return;
  }
  initTtsVoiceSelect();
  initBaiduTtsSelects();
  try {
    settings = await loadSettingsFromStorage();
  } catch (e) {
    settings = normalizeSettings(null);
  }
  // 默认展示实际正在使用的引擎/来源, 但保存不影响该选择
  applyRuntimeSelection(await loadRuntimeSelection());
  fillForm();
}
init();
