// 统一设置模型 (V1.7.39, V1.7.42 收敛为“只存模型配置”)
// 背景: 翻译/AI 分析/语音合成三套配置原本分散在 vtConfig 的扁平字段里, 入口分散且字段易混淆。
// 本模块把三者归一为 { translate, ai, tts } 结构, 并提供:
//   ① normalizeSettings: 容错归一 (缺字段补默认, 类型收敛)
//   ② migrateSettings:   从旧 vtConfig 一次性迁移 (纯函数, 不写存储, 旧字段保留)
//   ③ settingsSummary:   各引擎配置就绪状态总览 (供设置页只读展示)
// 注意: 实际使用哪个引擎/来源由各功能界面选择 (popup backend/customActive、vtAiEngine、tts.mode),
// 本结构中的 backend/active/engine/mode 仅作为设置页“正在编辑哪一组配置”的视图状态, 保存时不写回旧字段。

export const SETTINGS_VERSION = 1;

// 本地 CosyVoice2-0.5B 语音合成预设 (V1.7.56)
// 部署: 本机运行 CosyVoice2-0.5B 推理服务, 暴露 OpenAI 兼容 /v1/audio/speech 端点 (端口 9885, 无需 Key)。
export const COSYVOICE_TTS_PRESET = {
  mode: 'custom',
  endpoint: 'http://127.0.0.1:9885/v1/audio/speech',
  apiKey: '',
  model: 'CosyVoice2-0.5B',
  voice: 'alloy'
};

// 自定义 TTS 音色下拉选项 (V1.7.57): OpenAI 标准音色; 其他音色经设置页「自定义…」输入
export const TTS_VOICE_OPTIONS = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

// 标准音色中文注释 (V1.7.58): 下拉框展示为「音色名（中文注释）」, 发送时仍用音色名
export const TTS_VOICE_LABELS = {
  alloy: '中性均衡',
  echo: '男声沉稳',
  fable: '英式生动',
  onyx: '男声低沉',
  nova: '女声清亮',
  shimmer: '女声柔和'
};

// 百度 TTS 音色下拉 (V1.7.58): 免费标准音色 (per 参数); 精品音色编号经「自定义…」输入
export const BAIDU_TTS_VOICE_OPTIONS = ['0', '1', '3', '4'];
export const BAIDU_TTS_VOICE_LABELS = {
  '0': '度小美（标准女声）',
  '1': '度小宇（标准男声）',
  '3': '度逍遥（情感男声）',
  '4': '度丫丫（情感女声）'
};

// 百度 TTS 语速范围 (V1.7.58): spd 参数 0~15, 默认 5 (正常语速)
export const BAIDU_TTS_SPEED = { min: 0, max: 15, def: 5 };

export function emptySettings() {
  return {
    version: SETTINGS_VERSION,
    translate: {
      backend: 'baidu',
      baidu: { appId: '', key: '' },
      volcengine: { accessKeyId: '', secretAccessKey: '' },
      tencent: { secretId: '', secretKey: '' },
      custom: {
        active: 0,
        models: [
          { baseUrl: '', apiKey: '', model: '', maxBytes: 0 }
        ]
      }
    },
    ai: {
      engine: 'cloud',
      models: [
        { baseUrl: '', apiKey: '', model: '', maxBytes: 0 }
      ]
    },
    tts: {
      mode: 'server',
      endpoint: '',
      apiKey: '',
      model: '',
      voice: '',
      baiduAk: '',
      baiduSk: '',
      baiduVoice: '0',
      baiduSpeed: '5'
    }
  };
}

function str(v) {
  return v === null || v === undefined ? '' : String(v);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function slot(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return { baseUrl: str(s.baseUrl).trim(), apiKey: str(s.apiKey).trim(), model: str(s.model).trim(), maxBytes: num(s.maxBytes) };
}

// 槽位列表归一: 最多 3 个, 至少 1 个 (V1.7.46 支持添加/删除)
function slotList(rawList) {
  const list = Array.isArray(rawList) ? rawList.slice(0, 3) : [];
  if (!list.length) list.push({});
  return list.map(slot);
}

// 容错归一: 任意输入 → 完整设置对象 (不抛错)
export function normalizeSettings(raw) {
  const out = emptySettings();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw;

  // translate
  if (r.translate && typeof r.translate === 'object') {
    const t = r.translate;
    const backends = ['proxy', 'baidu', 'volcengine', 'tencent', 'custom'];
    out.translate.backend = backends.indexOf(str(t.backend)) >= 0 ? str(t.backend) : out.translate.backend;
    if (t.baidu && typeof t.baidu === 'object') {
      out.translate.baidu.appId = str(t.baidu.appId).trim();
      out.translate.baidu.key = str(t.baidu.key).trim();
    }
    if (t.volcengine && typeof t.volcengine === 'object') {
      out.translate.volcengine.accessKeyId = str(t.volcengine.accessKeyId).trim();
      out.translate.volcengine.secretAccessKey = str(t.volcengine.secretAccessKey).trim();
    }
    if (t.tencent && typeof t.tencent === 'object') {
      out.translate.tencent.secretId = str(t.tencent.secretId).trim();
      out.translate.tencent.secretKey = str(t.tencent.secretKey).trim();
    }
    if (t.custom && typeof t.custom === 'object') {
      const models = slotList(t.custom.models);
      out.translate.custom.models = models;
      const act = Number(t.custom.active);
      out.translate.custom.active = (act >= 0 && act < models.length) ? Math.floor(act) : 0;
    }
  }

  // ai
  if (r.ai && typeof r.ai === 'object') {
    const a = r.ai;
    out.ai.engine = str(a.engine) === 'custom' ? 'custom' : 'cloud';
    const models = slotList(a.models);
    out.ai.models = models;
    // 旧单槽位字段 (V1.7.44 及以前: ai.baseUrl/apiKey/model/maxBytes) → 槽位 1
    const legacy = slot({ baseUrl: a.baseUrl, apiKey: a.apiKey, model: a.model, maxBytes: a.maxBytes });
    const hasModels = models.some(m => !!(m.baseUrl || m.apiKey || m.model || m.maxBytes));
    if (!hasModels && (legacy.baseUrl || legacy.apiKey || legacy.model)) out.ai.models[0] = legacy;
  }

  // tts
  if (r.tts && typeof r.tts === 'object') {
    const s = r.tts;
    const modes = ['server', 'baidu', 'custom'];
    out.tts.mode = modes.indexOf(str(s.mode)) >= 0 ? str(s.mode) : out.tts.mode;
    out.tts.endpoint = str(s.endpoint).trim();
    out.tts.apiKey = str(s.apiKey).trim();
    out.tts.model = str(s.model).trim();
    out.tts.voice = str(s.voice).trim();
    out.tts.baiduAk = str(s.baiduAk).trim();
    out.tts.baiduSk = str(s.baiduSk).trim();
    out.tts.baiduVoice = str(s.baiduVoice || '0').trim();
    out.tts.baiduSpeed = str(s.baiduSpeed || '5').trim();
  }
  return out;
}

// 旧 vtConfig → 新结构 (纯函数)。调用方负责写入 chrome.storage; 旧字段保持不动。
export function migrateSettings(vtConfig) {
  const cfg = vtConfig && typeof vtConfig === 'object' ? vtConfig : {};
  const base = normalizeSettings(cfg.settings);
  const out = emptySettings();
  // 已存在新结构 → 以新结构为准, 再用旧字段补空缺 (幂等)
  out.translate.backend = base.translate.backend;
  out.translate.baidu.appId = base.translate.baidu.appId || str(cfg.baiduAppId).trim();
  out.translate.baidu.key = base.translate.baidu.key || str(cfg.baiduKey).trim();
  out.translate.volcengine.accessKeyId = base.translate.volcengine.accessKeyId || str(cfg.volcAccessKeyId).trim();
  out.translate.volcengine.secretAccessKey = base.translate.volcengine.secretAccessKey || str(cfg.volcSecretAccessKey).trim();
  out.translate.tencent.secretId = base.translate.tencent.secretId || str(cfg.tencentSecretId).trim();
  out.translate.tencent.secretKey = base.translate.tencent.secretKey || str(cfg.tencentSecretKey).trim();
  out.translate.custom.active = base.translate.custom.active;
  const legacyModels = Array.isArray(cfg.customModels) ? cfg.customModels : [];
  const legacyActive = Number(cfg.customActive);
  // 更旧的单槽位扁平字段 (customBaseUrl/customApiKey/customModel/customMaxBytes):
  // 设置页保存会写入 customModels 数组, 若这里不搬进槽位 1, 保存后 resolveCustomSlot
  // 会从“扁平字段回退”切到“空数组槽位”, 自定义引擎会突然变成未配置。
  const legacyFlat = slot({
    baseUrl: cfg.customBaseUrl, apiKey: cfg.customApiKey,
    model: cfg.customModel, maxBytes: cfg.customMaxBytes
  });
  const hasLegacyFlat = !legacyModels.length && !!(legacyFlat.baseUrl || legacyFlat.apiKey || legacyFlat.model || legacyFlat.maxBytes);
  // 槽位数量 1~3: 保留新结构/旧数组里已有的数量, 不强制补满 3 个 (V1.7.46)
  const trLen = Math.min(3, Math.max(base.translate.custom.models.length, legacyModels.length, 1));
  out.translate.custom.models = [];
  for (let i = 0; i < trLen; i++) {
    const cur = base.translate.custom.models[i] || slot(null);
    const hasCur = cur.baseUrl || cur.model || cur.apiKey || cur.maxBytes;
    const fallback = (i === 0 && hasLegacyFlat) ? legacyFlat : slot(legacyModels[i]);
    out.translate.custom.models.push(hasCur ? cur : fallback);
  }
  out.translate.custom.active = Math.min(base.translate.custom.active, trLen - 1);
  if (!cfg.settings && legacyActive >= 0 && legacyActive <= 2) {
    out.translate.custom.active = Math.min(Math.floor(legacyActive), trLen - 1);
  }
  // 旧 backend 字段 (translate 顶层的 backend) 优先于默认值
  if (!cfg.settings && ['proxy', 'baidu', 'volcengine', 'tencent', 'custom'].indexOf(str(cfg.backend)) >= 0) {
    out.translate.backend = str(cfg.backend);
  }

  // ai: 三槽位 (V1.7.45); 旧单槽位 vtConfig.aiModel → 槽位 1
  const legacyAi = cfg.aiModel && typeof cfg.aiModel === 'object' ? cfg.aiModel : {};
  const legacyAiModels = Array.isArray(cfg.aiModels) ? cfg.aiModels : [];
  // 旧单槽位别名只在“没有任何新槽位配置”时才回填, 避免与已配置槽位重复 (V1.7.45)
  const hasLegacyModels = legacyAiModels.some(m => {
    const s = slot(m);
    return !!(s.baseUrl || s.apiKey || s.model || s.maxBytes);
  });
  out.ai.engine = base.ai.engine;
  const aiLen = Math.min(3, Math.max(base.ai.models.length, legacyAiModels.length, 1));
  out.ai.models = [];
  for (let i = 0; i < aiLen; i++) {
    const cur = base.ai.models[i] || slot(null);
    const hasCur = !!(cur.baseUrl || cur.apiKey || cur.model || cur.maxBytes);
    let fallback = slot(legacyAiModels[i]);
    if (!(fallback.baseUrl || fallback.apiKey || fallback.model) && i === 0 && !hasLegacyModels) {
      // 更旧配置: 单槽位 aiModel
      fallback = slot(legacyAi);
    }
    out.ai.models.push(hasCur ? cur : fallback);
  }

  // tts: 旧字段 vtConfig.tts 与新结构同名; 有 settings 时以新结构为准, 否则用旧对象归一
  const legacyTts = normalizeSettings({ tts: (cfg.tts && typeof cfg.tts === 'object') ? cfg.tts : {} }).tts;
  out.tts = cfg.settings ? base.tts : legacyTts;

  const changed = !cfg.settings || JSON.stringify(normalizeSettings(cfg.settings)) !== JSON.stringify(out);
  return { settings: out, changed: changed };
}

// 各引擎就绪总览: ready=关键字段已填; detail=缺什么/说明
export function settingsSummary(settings) {
  const s = normalizeSettings(settings);
  const list = [];

  // 翻译
  const bt = s.translate.backend;
  const names = { proxy: '官方引擎（Pro）', baidu: '百度', volcengine: '火山', tencent: '腾讯', custom: '自定义模型' };
  let tReady = false;
  let tDetail = '';
  if (bt === 'proxy') {
    tReady = true;
    tDetail = '免配置，需登录且 Pro 生效（5 万字/日）';
  } else if (bt === 'baidu') {
    tReady = !!(s.translate.baidu.appId && s.translate.baidu.key);
    tDetail = tReady ? '已配置 APPID / 密钥' : '缺少 APPID 或密钥';
  } else if (bt === 'volcengine') {
    tReady = !!(s.translate.volcengine.accessKeyId && s.translate.volcengine.secretAccessKey);
    tDetail = tReady ? '已配置 AK / SK' : '缺少 Access Key 或 Secret Key';
  } else if (bt === 'tencent') {
    tReady = !!(s.translate.tencent.secretId && s.translate.tencent.secretKey);
    tDetail = tReady ? '已配置 SecretId / SecretKey' : '缺少 SecretId 或 SecretKey';
  } else {
    const readySlots = [];
    s.translate.custom.models.forEach((m, i) => {
      if (m.baseUrl && m.model) readySlots.push('槽位 ' + (i + 1) + '：' + m.model);
    });
    tReady = readySlots.length > 0;
    tDetail = tReady ? '已配置 ' + readySlots.join('；') : '自定义槽位均缺少接口地址或模型名';
  }
  list.push({ id: 'translate', title: '翻译引擎', current: names[bt] || bt, ready: tReady, detail: tDetail });

  // AI 分析 (三槽位, V1.7.45)
  const aiSlots = [];
  s.ai.models.forEach((m, i) => {
    if (m.baseUrl && m.model) aiSlots.push('槽位 ' + (i + 1) + '：' + m.model);
  });
  let aReady = false;
  let aDetail = '';
  if (s.ai.engine === 'cloud') {
    aReady = true;
    aDetail = '云端模型（Pro）免配置；' + (aiSlots.length ? '自定义已配置 ' + aiSlots.join('；') : '自定义槽位均未配置');
  } else {
    aReady = aiSlots.length > 0;
    aDetail = aReady ? '已配置 ' + aiSlots.join('；') : '自定义槽位均缺少接口地址或模型名';
  }
  list.push({ id: 'ai', title: 'AI 分析', current: '云端模型 / 自定义模型', ready: aReady, detail: aDetail });

  // 语音合成
  let vReady = false;
  let vDetail = '';
  if (s.tts.mode === 'server') {
    vReady = true;
    vDetail = '官方引擎（Pro），免配置，2000 字符/日';
  } else if (s.tts.mode === 'baidu') {
    vReady = !!(s.tts.baiduAk && s.tts.baiduSk);
    vDetail = vReady ? '已配置百度 AK / SK' : '缺少百度 API Key 或 Secret Key';
  } else {
    vReady = !!s.tts.endpoint;
    vDetail = vReady ? '自定义接口：' + s.tts.endpoint : '缺少接口地址';
  }
  list.push({ id: 'tts', title: '语音合成', current: s.tts.mode === 'server' ? '官方引擎' : (s.tts.mode === 'baidu' ? '百度（自带密钥）' : '自定义接口'), ready: vReady, detail: vDetail });

  return list;
}

// 新结构 → 旧 vtConfig 扁平字段 (V1.7.40 / V1.7.42)
// 引擎/槽位选择 (translate.backend / customActive) 不写回, 由各功能界面维护;
// tts.mode 自 V1.7.62 起写回——设置页「语音合成来源」与导出音频弹窗共用同一字段, 保存即对合成生效。
export function toLegacyPatch(settings) {
  const s = normalizeSettings(settings);
  // 旧单槽位别名: 取第一个已配置的 AI 槽位 (老版本回退时仍可用)
  const aiFirst = s.ai.models.filter(m => m.baseUrl || m.apiKey || m.model)[0] || s.ai.models[0];
  return {
    baiduAppId: s.translate.baidu.appId,
    baiduKey: s.translate.baidu.key,
    volcAccessKeyId: s.translate.volcengine.accessKeyId,
    volcSecretAccessKey: s.translate.volcengine.secretAccessKey,
    tencentSecretId: s.translate.tencent.secretId,
    tencentSecretKey: s.translate.tencent.secretKey,
    customModels: s.translate.custom.models.map(m => ({
      baseUrl: m.baseUrl, apiKey: m.apiKey, model: m.model, maxBytes: m.maxBytes
    })),
    aiModels: s.ai.models.map(m => ({
      baseUrl: m.baseUrl, apiKey: m.apiKey, model: m.model, maxBytes: m.maxBytes
    })),
    aiModel: {
      baseUrl: aiFirst.baseUrl, apiKey: aiFirst.apiKey, model: aiFirst.model, maxBytes: aiFirst.maxBytes
    },
    tts: {
      mode: s.tts.mode,
      endpoint: s.tts.endpoint, apiKey: s.tts.apiKey, model: s.tts.model,
      voice: s.tts.voice, baiduAk: s.tts.baiduAk, baiduSk: s.tts.baiduSk,
      baiduVoice: s.tts.baiduVoice, baiduSpeed: s.tts.baiduSpeed
    }
  };
}

// ===== 存储封装 (浏览器环境; 测试环境不调用) =====
export async function loadSettingsFromStorage() {
  const r = await chrome.storage.local.get(['vtConfig']);
  const cfg = (r && r.vtConfig) || {};
  const m = migrateSettings(cfg);
  if (m.changed) {
    cfg.settings = m.settings;
    await chrome.storage.local.set({ vtConfig: cfg }); // 旧字段保留, 不删除
  }
  return m.settings;
}

export async function saveSettingsToStorage(settings) {
  const normalized = normalizeSettings(settings);
  const r = await chrome.storage.local.get(['vtConfig']);
  const cfg = (r && r.vtConfig) || {};
  cfg.settings = normalized;
  // 同步旧字段的配置部分, 让已有功能立即读到新配置 (V1.7.40)
  // 运行期选择 (backend / customActive / tts.mode) 不在此写入, 由各功能界面维护 (V1.7.42)
  const patch = toLegacyPatch(normalized);
  Object.keys(patch).forEach(k => {
    if (k === 'tts') {
      // 合并而非替换: 保留导出音频窗口写入的 mode (及未来新增字段)
      cfg.tts = Object.assign({}, cfg.tts || {}, patch.tts);
    } else {
      cfg[k] = patch[k];
    }
  });
  await chrome.storage.local.set({ vtConfig: cfg });
  return normalized;
}
