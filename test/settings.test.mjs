// lib/settings.js 单测 (V1.7.39): 归一 / 迁移(幂等, 旧字段优先补齐) / 就绪总览
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptySettings, normalizeSettings, migrateSettings, settingsSummary, toLegacyPatch, saveSettingsToStorage, COSYVOICE_TTS_PRESET, TTS_VOICE_OPTIONS, TTS_VOICE_LABELS, BAIDU_TTS_VOICE_OPTIONS, BAIDU_TTS_VOICE_LABELS, BAIDU_TTS_SPEED } from '../lib/settings.js';

test('normalizeSettings: 空/非法输入返回完整默认结构', () => {
  const a = normalizeSettings(null);
  const b = normalizeSettings(undefined);
  const c = normalizeSettings('bad');
  assert.deepEqual(a, emptySettings());
  assert.deepEqual(b, emptySettings());
  assert.deepEqual(c, emptySettings());
  assert.equal(a.translate.custom.models.length, 1);  // 默认 1 个槽位, 最多 3 个
  assert.equal(a.ai.models.length, 1);
  assert.equal(a.tts.baiduVoice, '0');
});

test('normalizeSettings: 类型收敛 (非法 backend/mode/active 回退, 数字字段收敛)', () => {
  const s = normalizeSettings({
    translate: { backend: 'nope', custom: { active: 9, models: [{ baseUrl: ' u ', maxBytes: -3 }, {}, { model: 'm3' }] } },
    ai: { engine: 'weird', deepThink: 'yes', maxBytes: 'abc' },
    tts: { mode: 'nope' }
  });
  assert.equal(s.translate.backend, 'baidu');       // 非法 → 默认
  assert.equal(s.translate.custom.active, 0);       // 越界 → 0
  assert.equal(s.translate.custom.models[0].baseUrl, 'u'); // trim
  assert.equal(s.translate.custom.models[0].maxBytes, 0);  // 负数 → 0
  assert.equal(s.translate.custom.models[2].model, 'm3');
  assert.equal(s.ai.engine, 'cloud');
  assert.equal(s.ai.models.length, 1);
  assert.equal(s.ai.models[0].maxBytes, 0);
  assert.equal(s.tts.mode, 'server');
});

test('normalizeSettings: AI 旧单槽位字段归一为槽位 1', () => {
  const s = normalizeSettings({ ai: { engine: 'custom', baseUrl: ' http://a/v1 ', apiKey: 'k', model: 'm', maxBytes: 8000 } });
  assert.equal(s.ai.models[0].baseUrl, 'http://a/v1');
  assert.equal(s.ai.models[0].apiKey, 'k');
  assert.equal(s.ai.models[0].model, 'm');
  assert.equal(s.ai.models[0].maxBytes, 8000);
});

test('normalizeSettings: 槽位数量收敛到 1~3 (支持动态增删)', () => {
  const one = normalizeSettings({ translate: { custom: { models: [] } }, ai: { models: [] } });
  assert.equal(one.translate.custom.models.length, 1);
  assert.equal(one.ai.models.length, 1);

  const two = normalizeSettings({ translate: { custom: { models: [{}, {}] } }, ai: { models: [{}, {}] } });
  assert.equal(two.translate.custom.models.length, 2);
  assert.equal(two.ai.models.length, 2);

  const five = normalizeSettings({
    translate: { custom: { models: [{}, {}, {}, {}, {}] } },
    ai: { models: [{}, {}, {}, {}, {}] }
  });
  assert.equal(five.translate.custom.models.length, 3); // 超出上限截断
  assert.equal(five.ai.models.length, 3);
});

test('migrateSettings: 旧扁平字段迁移到新结构, 并标记 changed', () => {
  const r = migrateSettings({
    backend: 'volcengine',
    baiduAppId: 'app1', baiduKey: 'key1',
    volcAccessKeyId: 'ak1', volcSecretAccessKey: 'sk1',
    tencentSecretId: 'sid1', tencentSecretKey: 'skey1',
    customModels: [{ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', maxBytes: 4000 }, {}, {}],
    customActive: 1,
    aiModel: { baseUrl: 'http://ai/v1', apiKey: 'aik', model: 'mm', maxBytes: 8000 },
    tts: { mode: 'baidu', baiduAk: 'bak', baiduSk: 'bsk', baiduVoice: '3', baiduSpeed: '7' }
  });
  assert.equal(r.changed, true);
  const s = r.settings;
  assert.equal(s.translate.backend, 'volcengine');
  assert.equal(s.translate.baidu.appId, 'app1');
  assert.equal(s.translate.volcengine.accessKeyId, 'ak1');
  assert.equal(s.translate.tencent.secretId, 'sid1');
  assert.equal(s.translate.custom.models[0].model, 'm');
  assert.equal(s.translate.custom.active, 1);
  assert.equal(s.ai.models[0].baseUrl, 'http://ai/v1');
  assert.equal(s.ai.models[0].model, 'mm');
  assert.equal(s.ai.models[0].maxBytes, 8000);
  assert.equal(s.tts.mode, 'baidu');
  assert.equal(s.tts.baiduAk, 'bak');
  assert.equal(s.tts.baiduSlow, undefined);
  assert.equal(s.tts.baiduSpeed, '7');
});

test('migrateSettings: AI 三槽位数组迁移 (aiModels)', () => {
  const r = migrateSettings({
    aiModels: [
      { baseUrl: 'http://a1/v1', model: 'm1' },
      {},
      { baseUrl: 'http://a3/v1', model: 'm3', maxBytes: 6000 }
    ]
  });
  assert.equal(r.settings.ai.models[0].model, 'm1');
  assert.equal(r.settings.ai.models[1].baseUrl, '');
  assert.equal(r.settings.ai.models[2].model, 'm3');
  assert.equal(r.settings.ai.models[2].maxBytes, 6000);
});

test('migrateSettings: 旧单槽位扁平字段搬入槽位 1 (设置页保存后 custom 不丢配置)', () => {
  const r = migrateSettings({
    customBaseUrl: 'http://localhost:11434/v1',
    customApiKey: 'k',
    customModel: 'qwen',
    customMaxBytes: 8000
  });
  assert.equal(r.settings.translate.custom.models[0].baseUrl, 'http://localhost:11434/v1');
  assert.equal(r.settings.translate.custom.models[0].apiKey, 'k');
  assert.equal(r.settings.translate.custom.models[0].model, 'qwen');
  assert.equal(r.settings.translate.custom.models[0].maxBytes, 8000);
});

test('migrateSettings: 幂等 (已有 settings 时不重复标记 changed, 且优先新结构)', () => {
  const first = migrateSettings({ baiduAppId: 'app1', baiduKey: 'key1' });
  assert.equal(first.changed, true);
  const second = migrateSettings({ settings: first.settings, baiduAppId: 'app1', baiduKey: 'key1' });
  assert.equal(second.changed, false);
  assert.deepEqual(second.settings, first.settings);
  // 新结构有值 → 不被旧字段覆盖
  const s = normalizeSettings(first.settings);
  s.translate.baidu.appId = 'new-app';
  const third = migrateSettings({ settings: s, baiduAppId: 'old-app' });
  assert.equal(third.settings.translate.baidu.appId, 'new-app');
});

test('settingsSummary: 各引擎就绪状态与缺失描述', () => {
  const empty = settingsSummary(emptySettings());
  assert.equal(empty.length, 3);
  assert.equal(empty[0].ready, false);                 // 默认百度未填 → 未就绪
  assert.match(empty[0].detail, /缺少/);
  assert.equal(empty[1].ready, true);                  // 云端 AI 免配置
  assert.equal(empty[2].ready, true);                  // 官方 TTS 免配置

  const s = emptySettings();
  s.translate.backend = 'baidu';
  s.translate.baidu.appId = 'a';
  s.translate.baidu.key = 'k';
  s.ai.engine = 'custom';
  s.ai.baseUrl = 'http://localhost:11434/v1';
  s.ai.model = 'qwen';
  s.tts.mode = 'custom';
  const list = settingsSummary(s);
  assert.equal(list[0].ready, true);
  assert.match(list[0].detail, /已配置/);
  assert.equal(list[1].ready, true);
  assert.match(list[1].current, /自定义模型/);
  assert.equal(list[2].ready, false);                  // 自定义 TTS 缺 endpoint
  assert.match(list[2].detail, /缺少接口地址/);
});

test('toLegacyPatch: 新结构映射回旧扁平字段 (只含模型配置, 不含运行期选择)', () => {
  const s = emptySettings();
  s.translate.backend = 'custom';
  s.translate.baidu.appId = 'a';
  s.translate.volcengine.accessKeyId = 'vak';
  s.translate.custom.active = 2;
  s.translate.custom.models = [
    { baseUrl: '', apiKey: '', model: '', maxBytes: 0 },
    { baseUrl: '', apiKey: '', model: '', maxBytes: 0 },
    { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', maxBytes: 8000 }
  ];
  s.ai.engine = 'custom';
  s.ai.models[0] = { baseUrl: 'http://ai/v1', apiKey: '', model: '', maxBytes: 0 };
  s.tts.mode = 'baidu';
  s.tts.baiduAk = 'bak';
  const p = toLegacyPatch(s);
  assert.equal(p.backend, undefined);              // 翻译引擎选择不写回
  assert.equal(p.customActive, undefined);
  assert.equal(p.tts.mode, 'baidu');               // V1.7.62: 语音合成来源随设置页同步
  assert.equal(p.baiduAppId, 'a');
  assert.equal(p.volcAccessKeyId, 'vak');
  assert.equal(p.customModels.length, 3);
  assert.equal(p.customModels[2].model, 'm');
  assert.equal(p.aiModel.baseUrl, 'http://ai/v1');  // 旧单槽位别名
  assert.equal(p.aiModels.length, 1);
  assert.equal(p.aiModels[0].baseUrl, 'http://ai/v1');
  assert.equal(p.tts.baiduAk, 'bak');
});

test('saveSettingsToStorage: 写配置字段 + 同步语音合成来源, 但不覆盖翻译引擎/槽位', async () => {
  const mem = {
    vtConfig: {
      backend: 'baidu', customActive: 2, someOther: 1,
      tts: { mode: 'server', baiduAk: 'old-ak' }
    }
  };
  const orig = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach(k => { out[k] = mem[k]; });
          return out;
        },
        set: async (obj) => { Object.keys(obj).forEach(k => { mem[k] = obj[k]; }); }
      }
    }
  };
  try {
    const s = emptySettings();
    s.translate.backend = 'tencent';
    s.translate.tencent.secretId = 'sid';
    s.translate.tencent.secretKey = 'skey';
    s.translate.custom.active = 0;
    s.ai.models[0].baseUrl = 'http://ai/v1';
    s.ai.models.push({ baseUrl: 'http://ai2/v1', apiKey: '', model: 'm2', maxBytes: 0 });
    s.tts.mode = 'baidu';
    s.tts.baiduAk = 'bak';
    await saveSettingsToStorage(s);
    assert.equal(mem.vtConfig.settings.translate.backend, 'tencent'); // 设置页视图状态
    assert.equal(mem.vtConfig.backend, 'baidu');                     // 运行期引擎不被覆盖
    assert.equal(mem.vtConfig.customActive, 2);                      // 运行期槽位不被覆盖
    assert.equal(mem.vtConfig.tts.mode, 'baidu');                    // V1.7.62: 来源随设置页同步
    assert.equal(mem.vtConfig.tencentSecretId, 'sid');               // 配置字段已同步
    assert.equal(mem.vtConfig.aiModel.baseUrl, 'http://ai/v1');
    assert.equal(mem.vtConfig.aiModels[1].model, 'm2');
    assert.equal(mem.vtConfig.tts.baiduAk, 'bak');
    assert.equal(mem.vtConfig.someOther, 1);                         // 其他字段不丢
  } finally {
    globalThis.chrome = orig;
  }
});

test('COSYVOICE_TTS_PRESET: 本地 CosyVoice2 预设字段齐备且为本机免 Key 服务 (V1.7.56)', () => {
  assert.equal(COSYVOICE_TTS_PRESET.mode, 'custom');
  assert.equal(COSYVOICE_TTS_PRESET.endpoint, 'http://127.0.0.1:9885/v1/audio/speech');
  assert.equal(COSYVOICE_TTS_PRESET.model, 'CosyVoice2-0.5B');
  assert.ok(COSYVOICE_TTS_PRESET.voice, '音色不应为空');
  assert.equal(COSYVOICE_TTS_PRESET.apiKey, '', '本地服务无需 Key');
  // 本机地址: doc-translate 自定义 TTS 对 localhost/127.0.0.1 免 Key 校验
  assert.match(COSYVOICE_TTS_PRESET.endpoint, /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//, '必须是本机地址');
  assert.ok(COSYVOICE_TTS_PRESET.endpoint.endsWith('/v1/audio/speech'), 'OpenAI 兼容路径');
  // 预设可整体写入 settings.tts 且通过归一 (字段名与 tts 结构一致)
  const s = normalizeSettings({ tts: Object.assign({}, emptySettings().tts, COSYVOICE_TTS_PRESET) });
  assert.equal(s.tts.mode, 'custom');
  assert.equal(s.tts.endpoint, COSYVOICE_TTS_PRESET.endpoint);
  assert.equal(s.tts.model, 'CosyVoice2-0.5B');
});

test('TTS_VOICE_OPTIONS: 标准音色下拉列表齐备且含预设音色 (V1.7.57)', () => {
  assert.ok(Array.isArray(TTS_VOICE_OPTIONS) && TTS_VOICE_OPTIONS.length >= 6, '至少含 OpenAI 六个标准音色');
  for (const v of ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']) {
    assert.ok(TTS_VOICE_OPTIONS.includes(v), `缺少标准音色 ${v}`);
  }
  assert.ok(TTS_VOICE_OPTIONS.includes(COSYVOICE_TTS_PRESET.voice), '预设音色必须在下拉列表中');
  assert.equal(new Set(TTS_VOICE_OPTIONS).size, TTS_VOICE_OPTIONS.length, '音色不应重复');
});

test('TTS_VOICE_LABELS: 标准音色均有中文注释 (V1.7.58)', () => {
  for (const v of TTS_VOICE_OPTIONS) {
    assert.ok(TTS_VOICE_LABELS[v], `音色 ${v} 缺少中文注释`);
  }
});

test('BAIDU_TTS: 音色下拉与中文注释齐备, 语速范围 0~15 默认 5 (V1.7.58)', () => {
  assert.deepEqual(BAIDU_TTS_VOICE_OPTIONS, ['0', '1', '3', '4'], '免费标准音色编号');
  for (const v of BAIDU_TTS_VOICE_OPTIONS) {
    assert.ok(BAIDU_TTS_VOICE_LABELS[v], `百度音色 ${v} 缺少中文注释`);
  }
  assert.equal(BAIDU_TTS_SPEED.min, 0);
  assert.equal(BAIDU_TTS_SPEED.max, 15);
  assert.equal(BAIDU_TTS_SPEED.def, 5);
  // 默认值与归一化结构一致
  const s = normalizeSettings(null);
  assert.ok(BAIDU_TTS_VOICE_OPTIONS.includes(s.tts.baiduVoice), '默认百度音色必须在下拉列表中');
  assert.ok(Number(s.tts.baiduSpeed) >= BAIDU_TTS_SPEED.min && Number(s.tts.baiduSpeed) <= BAIDU_TTS_SPEED.max, '默认语速必须在范围内');
});